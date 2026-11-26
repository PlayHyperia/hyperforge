import THREE from "../../../extras/three/three";
import type { WorldTerrainProfile } from "./WorldTerrainProfile";

// Optional browser scheduling API; no polyfill or browser-version assumption.
declare const scheduler: { yield?: () => Promise<void> } | undefined;

export type CoastalBounds = Readonly<{
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}>;

/** Captured canonical terrain authority, independent of resident meshes/decks. */
export interface CanonicalGroundLease {
  readonly profile: WorldTerrainProfile;
  readonly revision: number;
  readonly supportBounds: readonly CoastalBounds[];
  isCurrent(): boolean;
  sampleHeight(x: number, z: number): number;
}

export const COASTAL_BATHYMETRY = Object.freeze({
  id: "canonical-coastal-bathymetry-v1",
  spacing: 0.5,
  gutter: 1,
  maxTexels: 1_100_000,
  maxDimension: 2048,
  deepDepth: 8,
  sliceBudgetMs: 2,
  maxSamplesPerSlice: 512,
});

export type CoastalBathymetryDomain = Readonly<{
  bounds: CoastalBounds;
  spacing: number;
  width: number;
  height: number;
  firstX: number;
  firstZ: number;
}>;

function validateBounds(bounds: CoastalBounds): void {
  if (
    ![bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].every(
      Number.isFinite,
    ) ||
    bounds.maxX <= bounds.minX ||
    bounds.maxZ <= bounds.minZ
  )
    throw new RangeError("Coastal field requires finite positive bounds");
}

/** One signed sample at each core lattice point, plus a full deep-water gutter. */
export function createCoastalBathymetryDomain(
  bounds: CoastalBounds,
): CoastalBathymetryDomain {
  validateBounds(bounds);
  const spacing = COASTAL_BATHYMETRY.spacing;
  const nx = (bounds.maxX - bounds.minX) / spacing;
  const nz = (bounds.maxZ - bounds.minZ) / spacing;
  const width = nx + 1 + 2 * COASTAL_BATHYMETRY.gutter;
  const height = nz + 1 + 2 * COASTAL_BATHYMETRY.gutter;
  if (
    !Number.isSafeInteger(nx) ||
    !Number.isSafeInteger(nz) ||
    nx < 1 ||
    nz < 1 ||
    width * height > COASTAL_BATHYMETRY.maxTexels
  )
    throw new RangeError(
      "Coastal field lattice exceeds its bounded half-metre domain",
    );
  if (
    width > COASTAL_BATHYMETRY.maxDimension ||
    height > COASTAL_BATHYMETRY.maxDimension
  )
    throw new RangeError(
      "Coastal field texture dimensions exceed the bounded limit",
    );
  const firstX = bounds.minX - spacing;
  const firstZ = bounds.minZ - spacing;
  const lastX = bounds.maxX + spacing;
  const lastZ = bounds.maxZ + spacing;
  // GPU grid uniforms and world coordinates are Float32. Finite doubles alone
  // can admit duplicated half-metre centers at large origins. Check both ends
  // and their inward neighbors: the largest-magnitude end bounds the precision
  // of this fixed-step lattice, including domains that cross zero.
  if (
    [
      firstX,
      firstX + spacing,
      bounds.minX,
      bounds.maxX,
      lastX - spacing,
      lastX,
      firstZ,
      firstZ + spacing,
      bounds.minZ,
      bounds.maxZ,
      lastZ - spacing,
      lastZ,
    ].some(
      (value) => !Number.isFinite(value) || Math.fround(value) !== value,
    ) ||
    firstX + (width - 1) * spacing !== lastX ||
    firstZ + (height - 1) * spacing !== lastZ
  )
    throw new RangeError(
      "Coastal field requires an exact Float32 half-metre lattice",
    );
  return Object.freeze({
    bounds: Object.freeze({ ...bounds }),
    spacing,
    width,
    height,
    firstX,
    firstZ,
  });
}

export interface CoastalBathymetryStatistics {
  samples: number;
  texelBytes: number;
  signedMin: number;
  signedMax: number;
  maxQuantizationError: number;
  gutterSamples: number;
  gutterMin: number;
  slices: number;
  synchronousMs: number;
  maxSliceMs: number;
  elapsedMs: number;
  yieldMethod: "scheduler.yield" | "setTimeout";
  yieldCount: number;
}

/** The array is exclusively owned by its eventual texture, never a shared cache. */
export interface CoastalBathymetryBake {
  readonly domain: CoastalBathymetryDomain;
  readonly data: Uint16Array;
  readonly seaLevel: number;
  readonly sourceRevision: number;
  readonly statistics: Readonly<CoastalBathymetryStatistics>;
}

/**
 * Cooperative CPU construction; the time limit is checked after every sample.
 * A single canonical sample and scheduler delay can exceed the requested slice;
 * actual durations are reported rather than claiming a hard frame-time bound.
 * Null means cancelled/stale; malformed or insufficiently deep fields reject.
 */
export async function bakeCoastalBathymetry(
  source: CanonicalGroundLease,
  signal: AbortSignal,
  onProgress?: (samples: number) => void,
): Promise<CoastalBathymetryBake | null> {
  const current = () => !signal.aborted && source.isCurrent();
  if (!current()) return null;
  if (source.profile.kind !== "compact-candidate")
    throw new Error(
      "Coastal bathymetry requires an explicit compact terrain profile",
    );
  const domain = createCoastalBathymetryDomain(source.profile.bounds);
  for (const bounds of source.supportBounds) {
    validateBounds(bounds);
    if (
      bounds.minX < domain.bounds.minX ||
      bounds.maxX > domain.bounds.maxX ||
      bounds.minZ < domain.bounds.minZ ||
      bounds.maxZ > domain.bounds.maxZ
    )
      throw new RangeError(
        "Authored grading extends beyond the coastal field domain",
      );
  }
  const seaLevel = source.profile.water.threshold;
  if (!Number.isFinite(seaLevel))
    throw new Error("Coastal sea level must be finite");
  const data = new Uint16Array(domain.width * domain.height);
  const platformScheduler =
    typeof scheduler !== "undefined" ? scheduler : undefined;
  const prioritizedYield = platformScheduler?.yield?.bind(platformScheduler);
  // Keep the same small work slices, but avoid placing every continuation
  // behind all newly queued page work. Both paths yield an actual event-loop
  // task; a resolved Promise/microtask would not let rendering/input progress.
  const yieldTask =
    prioritizedYield ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const stats: CoastalBathymetryStatistics = {
    samples: 0,
    texelBytes: data.byteLength,
    signedMin: Infinity,
    signedMax: -Infinity,
    maxQuantizationError: 0,
    gutterSamples: 0,
    gutterMin: Infinity,
    slices: 0,
    synchronousMs: 0,
    maxSliceMs: 0,
    elapsedMs: 0,
    yieldMethod: prioritizedYield ? "scheduler.yield" : "setTimeout",
    yieldCount: 0,
  };
  const started = performance.now();
  while (stats.samples < data.length) {
    if (!current()) return null;
    const sliceStart = performance.now();
    const sliceLimit = Math.min(
      data.length,
      stats.samples + COASTAL_BATHYMETRY.maxSamplesPerSlice,
    );
    do {
      const i = stats.samples;
      const x = i % domain.width;
      const z = Math.floor(i / domain.width);
      const depth =
        seaLevel -
        source.sampleHeight(
          domain.firstX + x * domain.spacing,
          domain.firstZ + z * domain.spacing,
        );
      // DataUtils clamps overflow; rejecting here must precede that conversion.
      if (!Number.isFinite(depth) || Math.abs(depth) > 65504)
        throw new RangeError("Canonical coastal depth is not finite R16F data");
      const encoded = THREE.DataUtils.toHalfFloat(depth);
      const decoded = THREE.DataUtils.fromHalfFloat(encoded);
      data[i] = encoded;
      stats.signedMin = Math.min(stats.signedMin, depth);
      stats.signedMax = Math.max(stats.signedMax, depth);
      stats.maxQuantizationError = Math.max(
        stats.maxQuantizationError,
        Math.abs(decoded - depth),
      );
      if (
        x === 0 ||
        z === 0 ||
        x === domain.width - 1 ||
        z === domain.height - 1
      ) {
        stats.gutterSamples++;
        stats.gutterMin = Math.min(stats.gutterMin, decoded);
        if (decoded < COASTAL_BATHYMETRY.deepDepth)
          throw new RangeError(
            "Coastal field gutter must retain opaque deep-water calibration",
          );
      }
      stats.samples++;
    } while (
      stats.samples < sliceLimit &&
      performance.now() - sliceStart < COASTAL_BATHYMETRY.sliceBudgetMs
    );
    const duration = performance.now() - sliceStart;
    stats.slices++;
    stats.synchronousMs += duration;
    stats.maxSliceMs = Math.max(stats.maxSliceMs, duration);
    if (!current()) return null;
    onProgress?.(stats.samples);
    if (stats.samples < data.length) {
      stats.yieldCount++;
      await yieldTask();
    }
  }
  if (!current()) return null;
  stats.elapsedMs = performance.now() - started;
  return Object.freeze({
    domain,
    data,
    seaLevel,
    sourceRevision: source.revision,
    statistics: Object.freeze(stats),
  });
}

/** CPU reference for explicit native bilinear parity checks; not a frame sampler. */
export function sampleCoastalBathymetry(
  field: CoastalBathymetryBake,
  worldX: number,
  worldZ: number,
): number {
  if (![worldX, worldZ].every(Number.isFinite))
    throw new RangeError("Coastal sample coordinates must be finite");
  const d = field.domain;
  if (field.data.length !== d.width * d.height)
    throw new Error("Coastal sample data differs from its domain");
  const x = Math.max(0, Math.min(d.width - 1, (worldX - d.firstX) / d.spacing));
  const z = Math.max(
    0,
    Math.min(d.height - 1, (worldZ - d.firstZ) / d.spacing),
  );
  const x0 = Math.floor(x),
    z0 = Math.floor(z);
  const x1 = Math.min(x0 + 1, d.width - 1),
    z1 = Math.min(z0 + 1, d.height - 1);
  const fx = x - x0,
    fz = z - z0;
  const read = (ix: number, iz: number) =>
    THREE.DataUtils.fromHalfFloat(field.data[iz * d.width + ix]);
  return (
    (read(x0, z0) * (1 - fx) + read(x1, z0) * fx) * (1 - fz) +
    (read(x0, z1) * (1 - fx) + read(x1, z1) * fx) * fz
  );
}
