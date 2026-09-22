import THREE, {
  texture,
  positionWorld,
  normalWorldGeometry,
  cameraViewMatrix,
  float,
  uint,
  vec2,
  vec3,
  vec4,
  mix,
  min,
  max,
  normalize,
  smoothstep,
  atan,
} from "../../../extras/three/three";
import type { Node, TextureNode } from "three/webgpu";
import {
  COMPACT_TERRAIN_COMPOSITION,
  createCompactTerrainColorOperations,
  type CompactGrassColorGrade,
  type CompactTerrainMacroField,
  type CompactTerrainPlantingLobe,
  type CompactTerrainGroundRibbon,
  type CompactTerrainBankVerge,
  type CompactTerrainHavenGround,
  type CompactCoastDistribution,
  type CompactCoastDistributionInput,
  type CompactCoastDistributionMath,
  type CompactPondDistributionDescriptor,
  type CompactPondMarginInput,
  type CompactPondMargin,
  type CompactPondBankMath,
  type CompactPondBankComposition,
  type CompactPondBankCompositionInput,
} from "./CompactTerrainPalette";
export type {
  CompactCoastBlend,
  CompactPondBlend,
} from "./CompactTerrainPalette";
import compactTerrainTextureDigests from "../../../data/compact-terrain-textures.json";
import compactTerrainHeightDigests from "../../../data/compact-terrain-heights.json";
import {
  evaluateCompactHabitatSoil,
  type CompactHabitatField,
} from "./CompactHabitatComposition";

/** Same admitted half-plane field used by terrain and existing grass roots. */
export function createCompactHabitatSoilNode(
  x: Node<"float">,
  z: Node<"float">,
  field: CompactHabitatField,
): Node<"float"> {
  return evaluateCompactHabitatSoil(x, z, field, {
    constant: (value) => float(value),
    add: (a, b) => a.add(b),
    mul: (a, b) => a.mul(b),
    min: (a, b) => a.min(b),
    max: (a, b) => a.max(b),
    smoothstep: (a, b, value) => smoothstep(a, b, value),
  });
}

export const COMPACT_TERRAIN_MATERIAL = {
  id: "compact-pbr-v1",
  textureSize: 1024,
  anisotropy: 16,
  // Rock Face 03's published physical width; grass/dirt have separate scales.
  repeatsPerMeter: 1 / 2.7,
  textureCount: 6,
  // Ground: two projections × two layers × two maps = 8 reads. Rock now
  // uses two projections per triplanar axis × two maps = 12, not the old 6.
  // Twenty surface reads is a candidate budget, not a performance approval.
  surfaceSampleCount: 20,
  // Explicit candidate only: three paired dirt patches replace two (22 total).
  stochasticSurfaceSampleCount: 22,
  // Only grass/dirt consume height: two grass + two/three dirt projections.
  // The retained rock channel is not sampled until a cliff trial needs it.
  heightSurfaceSampleCount: 24,
  stochasticHeightSurfaceSampleCount: 27,
  // Three patches instead of two on each rock axis: +3 axes ×2 packed maps.
  // Static shader-read count only; actual GPU cost requires a native comparison.
  stochasticRockAdditionalSampleCount: 6,
  // Positive relief modulation preserves authored coverage when the two
  // heights agree. It does not apply a second threshold to a worn shoulder.
  heightInfluence: 4,
  dirtPatchEdgeMeters: 1,
  rockPatchEdgeMeters: 1.35,
  // Grass004 source covers approximately 1.4m; projection variation stays ±18%.
  grassRepeatsPerMeter: 1 / 1.4,
  // Poly Haven Dirt's published 2m width; preserve the existing UV variation.
  dirtRepeatsPerMeter: 1 / 2,
  groundPatternBands: 32,
  groundPatternBlendStart: 0.18,
  groundPatternBlendEnd: 0.82,
  groundPatternScaleVariation: 0.18,
  normalFadeNear: 45,
  normalFadeFar: 120,
  minimumRoughness: 0.65,
  dryGrassRoughnessLow: 0.85,
  dryGrassRoughnessHigh: 0.98,
  aoStrength: 0.35,
  loadTimeoutMs: 20_000,
  dirtNormalStrength: 0.25,
  rockNormalStrength: 0.4,
} as const;
export const COMPACT_TERRAIN_BITMAP_OPTIONS = {
  imageOrientation: "flipY",
  premultiplyAlpha: "none",
  colorSpaceConversion: "none",
} as const;

// Paired with the lossless packing manifest: stale CDN maps fail admission.
export const COMPACT_TERRAIN_TEXTURE_SHA256 = Object.freeze({
  ...compactTerrainTextureDigests,
});
export const COMPACT_TERRAIN_HEIGHT_SHA256 = Object.freeze({
  ...compactTerrainHeightDigests,
});

const LAYERS = ["grass", "dirt", "rock"] as const;
const CHANNELS = ["albedo-roughness", "normal-ao"] as const;
type Layer = (typeof LAYERS)[number];
type Channel = (typeof CHANNELS)[number];
type Key = `${Layer}-${Channel}` | "ground-height";
export type CompactDirtProjection = "stochastic-v1";
export type CompactRockProjection = "stochastic-v1";
export type CompactSurfaceBlend = "height-v1";
/**
 * Candidate material microrelief, not world-space displacement. Means are from
 * the pinned RGBA8 height pack, before filtering/projection blending; retaining
 * its DC level makes coarse source means neutral rather than a hard contour.
 */
export const COMPACT_TERRAIN_POND_RELIEF = Object.freeze({
  heightSha256:
    "f83da0f031244f046d72adf229723da5857d36a6cd5fc542d11db019a60bc06c",
  grassHeightMean: 0.34206187678318395,
  soilHeightMean: 0.41093718958835973,
  heightLog2Gain: 12,
});
/** Existing filtered turf relief is a coverage detail mask, NOT rock height.
 * The admitted source mean stays neutral; gain 2 maps mean +/- .25 to 0/1.
 * This is an art-directed mask contrast, not new physical scan metadata. */
export const COMPACT_TERRAIN_COAST_DETAIL = Object.freeze({
  heightSha256: COMPACT_TERRAIN_POND_RELIEF.heightSha256,
  grassHeightMean: COMPACT_TERRAIN_POND_RELIEF.grassHeightMean,
  detailGain: 2,
});
/** Art-directed dry-bank candidate; slope is 1 - abs(geometric normal.y). */
export const COMPACT_TERRAIN_POND_SEDIMENT = Object.freeze({
  riseStart: 0.1,
  riseEnd: 0.22,
  fallStart: 0.42,
  fallEnd: 0.78,
  slopeFadeStart: 0.2,
  slopeFadeEnd: 0.4,
});
export type CompactTerrainPondDomain = Readonly<{
  region: Node<"float">;
  height: Node<"float">;
  noiseHeight: Node<"float">;
}>;
export type CompactTerrainDiagnosticSources = Readonly<{
  weights: Node<"vec4">;
  pondSoil: Node<"float">;
  pondWetness: Node<"float">;
  geometricCliff: Node<"float">;
  effectiveCliff: Node<"float">;
  coastSoil: Node<"float">;
}>;
export type CompactTerrainDiagnosticOutputs = Readonly<{
  schemaVersion: 1;
  /** RGB: rock, grass, total soil, including soil inside the coastal rock mix. */
  layerWeights: Node<"vec4">;
  /** RGB: pond soil, pond wetness, raw geometric cliff ramp. */
  causes: Node<"vec4">;
  sources: CompactTerrainDiagnosticSources;
}>;
type Entry = {
  key: Key;
  url: string;
  node: TextureNode<"vec4">;
  status: "idle" | "loading" | "loaded" | "error" | "disposed";
  error: string | null;
  width: number;
  height: number;
  sha256: string | null;
};

/** Per-material textures, never global or shared between world lifetimes. */
export class CompactTerrainTextureSet {
  readonly id = COMPACT_TERRAIN_MATERIAL.id;
  private readonly entries = new Map<Key, Entry>();
  private readonly pending = new Map<Key, { cancel(): void }>();
  private promise: Promise<void> | null = null;
  private disposed = false;

  constructor(
    cdnUrl: string,
    readonly dirtProjection?: CompactDirtProjection,
    readonly surfaceBlend?: CompactSurfaceBlend,
    readonly rockProjection?: CompactRockProjection,
  ) {
    if (dirtProjection !== undefined && dirtProjection !== "stochastic-v1")
      throw new Error("Unknown compact dirt projection");
    if (surfaceBlend !== undefined && surfaceBlend !== "height-v1")
      throw new Error("Unknown compact surface blend");
    if (rockProjection !== undefined && rockProjection !== "stochastic-v1")
      throw new Error("Unknown compact rock projection");
    for (const layer of LAYERS) {
      for (const channel of CHANNELS) {
        const key: Key = `${layer}-${channel}`;
        const fallback =
          channel === "normal-ao"
            ? [128, 128, 255, 255]
            : layer === "grass"
              ? [100, 112, 52, 235]
              : [110, 95, 74, 230];
        const image = new THREE.DataTexture(
          new Uint8Array(fallback),
          1,
          1,
          THREE.RGBAFormat,
        );
        this.configureTexture(image, channel);
        this.entries.set(key, {
          key,
          url: `${cdnUrl.replace(/\/$/, "")}/terrain/textures/compact-pbr/${key}.png`,
          node: texture(image),
          status: "idle",
          error: null,
          width: 1,
          height: 1,
          sha256: null,
        });
      }
    }
    if (surfaceBlend) {
      const image = new THREE.DataTexture(
        new Uint8Array([128, 128, 128, 255]),
        1,
        1,
        THREE.RGBAFormat,
      );
      this.configureTexture(image, "ground-height");
      this.entries.set("ground-height", {
        key: "ground-height",
        url: `${cdnUrl.replace(/\/$/, "")}/terrain/textures/compact-pbr/ground-height.png`,
        node: texture(image),
        status: "idle",
        error: null,
        width: 1,
        height: 1,
        sha256: null,
      });
    }
  }

  getReceipt() {
    const textures = [...this.entries.values()].map((entry) => ({
      key: entry.key,
      url: entry.url,
      status: entry.status,
      error: entry.error,
      width: entry.width,
      height: entry.height,
      sha256: entry.sha256,
      textureUuid: entry.node.value.uuid,
      colorSpace: entry.node.value.colorSpace,
      flipY: entry.node.value.flipY,
      premultiplyAlpha: entry.node.value.premultiplyAlpha,
      anisotropy: entry.node.value.anisotropy,
    }));
    return {
      id: this.id,
      status: this.disposed
        ? "disposed"
        : textures.some((entry) => entry.status === "error")
          ? "error"
          : textures.every((entry) => entry.status === "loaded")
            ? "ready"
            : this.promise
              ? "loading"
              : "idle",
      textures,
      dirtProjection: this.dirtProjection ?? "dual-v1",
      rockProjection: this.rockProjection ?? "dual-v1",
      surfaceBlend: this.surfaceBlend ?? "linear-v1",
      surfaceSampleCount:
        (this.surfaceBlend
          ? this.dirtProjection
            ? COMPACT_TERRAIN_MATERIAL.stochasticHeightSurfaceSampleCount
            : COMPACT_TERRAIN_MATERIAL.heightSurfaceSampleCount
          : this.dirtProjection
            ? COMPACT_TERRAIN_MATERIAL.stochasticSurfaceSampleCount
            : COMPACT_TERRAIN_MATERIAL.surfaceSampleCount) +
        (this.rockProjection
          ? COMPACT_TERRAIN_MATERIAL.stochasticRockAdditionalSampleCount
          : 0),
      bitmapOptions: { ...COMPACT_TERRAIN_BITMAP_OPTIONS },
    };
  }

  getNode(layer: Layer, channel: Channel): TextureNode<"vec4"> {
    return this.entries.get(`${layer}-${channel}`)!.node;
  }

  getHeightNode(): TextureNode<"vec4"> | undefined {
    return this.entries.get("ground-height")?.node;
  }

  private expectedDigest(key: Key): string {
    return key === "ground-height"
      ? COMPACT_TERRAIN_HEIGHT_SHA256[key]
      : COMPACT_TERRAIN_TEXTURE_SHA256[key];
  }

  private configureTexture(
    image: THREE.Texture,
    channel: Channel | "ground-height",
  ): void {
    image.colorSpace =
      channel === "albedo-roughness"
        ? THREE.SRGBColorSpace
        : THREE.NoColorSpace;
    image.wrapS = image.wrapT = THREE.RepeatWrapping;
    image.magFilter = THREE.LinearFilter;
    image.minFilter = THREE.LinearMipmapLinearFilter;
    // Match the WebGPU terrain quality policy even when image decoding finishes
    // before ClientGraphics sets Three's constructor default. Existing textures
    // do not inherit later changes to that global default.
    image.anisotropy = COMPACT_TERRAIN_MATERIAL.anisotropy;
    image.generateMipmaps = true;
    // Bitmap decode performs the single Y flip. Explicitly disable a second
    // WebGPU copy flip, and never premultiply packed roughness/AO into RGB.
    image.flipY = false;
    image.premultiplyAlpha = false;
    image.needsUpdate = true;
  }

  private installTexture(
    entry: Entry,
    image: THREE.Texture,
    sha256: string,
  ): boolean {
    if (this.disposed || entry.status !== "loading") {
      this.disposeTexture(image);
      return false;
    }
    if (sha256 !== this.expectedDigest(entry.key)) {
      this.disposeTexture(image);
      throw new Error(`Compact terrain texture digest mismatch: ${entry.key}`);
    }
    const source = image.image as
      { width?: number; height?: number } | undefined;
    if (
      source?.width !== COMPACT_TERRAIN_MATERIAL.textureSize ||
      source.height !== COMPACT_TERRAIN_MATERIAL.textureSize
    ) {
      this.disposeTexture(image);
      throw new Error(
        `Invalid compact terrain texture dimensions: ${entry.key}`,
      );
    }
    this.configureTexture(
      image,
      entry.key === "ground-height"
        ? "ground-height"
        : entry.key.endsWith("normal-ao")
          ? "normal-ao"
          : "albedo-roughness",
    );
    const previous = entry.node.value;
    // TextureNode.sample() retains a reference to this base node, so every
    // projection follows the new real texture; never stuff an HTML image into
    // a DataTexture or leave a sampled clone pointing at the placeholder.
    entry.node.value = image;
    entry.width = source.width;
    entry.height = source.height;
    entry.sha256 = sha256;
    entry.status = "loaded";
    this.disposeTexture(previous);
    return true;
  }

  load(): Promise<void> {
    if (this.disposed)
      return Promise.reject(new Error("Compact terrain textures disposed"));
    if (this.promise) return this.promise;
    const jobs = [...this.entries.values()].map(
      (entry) =>
        new Promise<void>((resolve, reject) => {
          entry.status = "loading";
          const abort = new AbortController();
          const fail = (error: Error) => {
            if (entry.status !== "loading") return;
            entry.status = "error";
            entry.error = error.message;
            abort.abort();
            clearTimeout(timeout);
            this.pending.delete(entry.key);
            reject(error);
          };
          const timeout = setTimeout(
            () =>
              fail(
                new Error(`Compact terrain texture timed out: ${entry.key}`),
              ),
            COMPACT_TERRAIN_MATERIAL.loadTimeoutMs,
          );
          this.pending.set(entry.key, {
            cancel: () =>
              fail(
                new Error(
                  `Compact terrain texture loading cancelled: ${entry.key}`,
                ),
              ),
          });
          const decode = async () => {
            const response = await fetch(entry.url, {
              signal: abort.signal,
              credentials: "omit",
            });
            if (!response.ok)
              throw new Error(
                `Compact terrain texture HTTP ${response.status}: ${entry.key}`,
              );
            const blob = await response.blob();
            if (blob.size > 16 * 1024 * 1024)
              throw new Error(
                `Compact terrain texture exceeds size budget: ${entry.key}`,
              );
            const bytes = await blob.arrayBuffer();
            const digest = await globalThis.crypto.subtle.digest(
              "SHA-256",
              bytes,
            );
            const sha256 = Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("");
            if (sha256 !== this.expectedDigest(entry.key)) {
              throw new Error(
                `Compact terrain texture digest mismatch: ${entry.key}`,
              );
            }
            const bitmap = await globalThis.createImageBitmap(
              blob,
              COMPACT_TERRAIN_BITMAP_OPTIONS,
            );
            return { image: new THREE.Texture(bitmap), sha256 };
          };
          decode().then(
            ({ image, sha256 }) => {
              try {
                if (!this.installTexture(entry, image, sha256)) return;
                clearTimeout(timeout);
                this.pending.delete(entry.key);
                resolve();
              } catch (error) {
                fail(
                  error instanceof Error
                    ? error
                    : new Error(
                        `Invalid compact terrain texture: ${entry.key}`,
                      ),
                );
              }
            },
            (error: unknown) =>
              fail(
                error instanceof Error
                  ? error
                  : new Error(
                      `Compact terrain texture failed to load: ${entry.key}`,
                    ),
              ),
          );
        }),
    );
    this.promise = Promise.allSettled(jobs).then((results) => {
      if (this.disposed)
        throw new Error("Compact terrain textures disposed while loading");
      if (results.some((result) => result.status === "rejected")) {
        throw new Error(
          "Compact terrain PBR texture admission failed; inspect compactTerrainSurface.getReceipt()",
        );
      }
    });
    return this.promise;
  }

  private disposeTexture(image: THREE.Texture): void {
    image.dispose();
    const source = image.image as { close?: () => void } | undefined;
    source?.close?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pending.values()) pending.cancel();
    this.pending.clear();
    for (const entry of this.entries.values()) {
      this.disposeTexture(entry.node.value);
      entry.status = "disposed";
    }
  }
}

export type CompactTerrainLayer = {
  albedo: Node<"vec3">;
  roughness: Node<"float">;
  ao: Node<"float">;
  worldNormal: Node<"vec3">;
  /** Normalized material microrelief, never terrain displacement or AO. */
  height?: Node<"float">;
  /** Unattenuated scan AO, aligned with rock samples. Cavity mask, NOT height. */
  rawRockAo?: Node<"float">;
};

/**
 * Fine-meadow substrate art trial: compress sampled LINEAR grass reflectance
 * around its unchanged source mean, before meadow tint and colour grading.
 * The CPU palette mean is a fixed point; this does not change grass placement,
 * texture resolution/filtering or any non-albedo material channel.
 */
export function applyCompactFineGrassSubstrateContrast(
  grass: CompactTerrainLayer,
  grade: CompactGrassColorGrade | undefined,
  surfaceBlend?: CompactSurfaceBlend,
): CompactTerrainLayer {
  const operations = createCompactTerrainColorOperations();
  if (operations.grassColorGrade(grade) === undefined) return grass;
  const rawMean = operations.getPalette().grass;
  const mean = vec3(rawMean[0], rawMean[1], rawMean[2]);
  const contrast = float(surfaceBlend ? 0.7 : 0.35).toVar(
    "fineGrassSubstrateContrast",
  );
  return {
    ...grass,
    albedo: mean
      .add(grass.albedo.sub(mean).mul(contrast))
      .toVar("fineGrassSubstrateAlbedo"),
  };
}

/** Grade grass reflectance before soil/rock/path blending; no extra samples. */
export function applyCompactGrassColorGrade(
  grass: CompactTerrainLayer,
  grade: CompactGrassColorGrade | undefined,
): CompactTerrainLayer {
  const operations = createCompactTerrainColorOperations();
  if (operations.grassColorGrade(grade) === undefined) return grass;
  return {
    ...grass,
    albedo: grass.albedo
      .mul(vec3(...operations.getGrassColorGrade().linearMultipliers))
      .toVar("compactGrassGradedAlbedo"),
  };
}

/** Shared authored locality; no new texture, geometry or placement mask. */
function createCompactGroundVergeLocality(
  world: Node<"vec3">,
  verge: CompactTerrainBankVerge | undefined,
  role: "Bank" | "PondService" = "Bank",
): Node<"float"> {
  if (!verge) return float(0);
  return smoothstep(
    float(verge.minX),
    float(verge.minX + verge.feather),
    world.x,
  )
    .mul(
      float(1).sub(
        smoothstep(
          float(verge.maxX - verge.feather),
          float(verge.maxX),
          world.x,
        ),
      ),
    )
    .mul(
      smoothstep(float(verge.minZ), float(verge.minZ + verge.feather), world.z),
    )
    .mul(
      float(1).sub(
        smoothstep(
          float(verge.maxZ - verge.feather),
          float(verge.maxZ),
          world.z,
        ),
      ),
    )
    .toVar(`compact${role}VergeLocality`);
}

export function createCompactBankVergeLocality(
  world: Node<"vec3">,
  field: CompactTerrainMacroField | null,
): Node<"float"> {
  return createCompactGroundVergeLocality(
    world,
    field?.coastalMeadow ? field.bankVerge : undefined,
  );
}

/** Authored wear is shared by ground and blades, never road/root admission. */
function createCompactGroundVergeWear(
  world: Node<"vec3">,
  verge: CompactTerrainBankVerge | undefined,
  locality?: Node<"float">,
  role: "Bank" | "PondService" = "Bank",
): Node<"float"> {
  if (!verge) return float(0);
  let wear: Node<"float"> = float(0);
  for (const ribbon of verge.wear)
    wear = max(wear, createCompactGroundRibbonWeight(world.xz, ribbon));
  return wear
    .mul(locality ?? createCompactGroundVergeLocality(world, verge, role))
    .toVar(`compact${role}VergeWear`);
}

export function createCompactBankVergeWear(
  world: Node<"vec3">,
  field: CompactTerrainMacroField | null,
  locality?: Node<"float">,
): Node<"float"> {
  if (!field?.coastalMeadow) return float(0);
  const primary = createCompactGroundVergeWear(
    world,
    field.bankVerge,
    locality,
  );
  return field.pondServiceGround
    ? max(
        primary,
        createCompactGroundVergeWear(
          world,
          field.pondServiceGround,
          undefined,
          "PondService",
        ),
      )
    : primary;
}

/** Same clump-constant vertical/wind scale as the CPU grounding envelope. */
function createCompactGroundVergeHeightScale(
  world: Node<"vec3">,
  verge: CompactTerrainBankVerge | undefined,
  locality?: Node<"float">,
  role: "Bank" | "PondService" = "Bank",
): Node<"float"> {
  if (!verge) return float(1);
  const local =
    locality ?? createCompactGroundVergeLocality(world, verge, role);
  return mix(float(1), float(verge.heightScale), local)
    .add(
      createCompactGroundVergeWear(world, verge, local, role).mul(
        verge.wornHeightScale - verge.heightScale,
      ),
    )
    .toVar(`naturalGrass${role}HeightScale`);
}

/** One deformation path for each of the two bounded, independently bound verges. */
export function createCompactBankVergeHeightScale(
  world: Node<"vec3">,
  field: CompactTerrainMacroField | null,
  locality?: Node<"float">,
): Node<"float"> {
  if (!field?.coastalMeadow) return float(1);
  const primary = createCompactGroundVergeHeightScale(
    world,
    field.bankVerge,
    locality,
  );
  return field.pondServiceGround
    ? min(
        primary,
        createCompactGroundVergeHeightScale(
          world,
          field.pondServiceGround,
          undefined,
          "PondService",
        ),
      ).toVar("naturalGrassAuthoredHeightScale")
    : primary;
}

/** Local grass reflectance, mirrored by the CPU root palette before layering. */
export function applyCompactBankVergeGrassTint(
  grass: CompactTerrainLayer,
  grade: CompactGrassColorGrade | undefined,
  world: Node<"vec3">,
  field: CompactTerrainMacroField | null,
  locality?: Node<"float">,
): CompactTerrainLayer {
  if (!grade || !field?.coastalMeadow || !field.bankVerge) return grass;
  return {
    ...grass,
    albedo: grass.albedo.mul(
      mix(
        vec3(1),
        vec3(...field.bankVerge.grassTint),
        locality ?? createCompactBankVergeLocality(world, field),
      ),
    ),
  };
}

/**
 * Broad dry-meadow reflectance variation using the already sampled world noise.
 * This is an art-directed linear-albedo tint, not a lighting bake or a new PBR
 * scan. Normals, roughness and AO retain the original grass layer references.
 */
export function applyCompactMeadowTint(
  grass: CompactTerrainLayer,
  noise: Node<"float">,
  macroDry: Node<"float"> = float(0),
  strength = 1,
): CompactTerrainLayer {
  const c = COMPACT_TERRAIN_COMPOSITION;
  const dryness = mix(
    float(c.meadowDryLow),
    float(c.meadowDryHigh),
    smoothstep(float(c.meadowDryStart), float(c.meadowDryEnd), noise),
  );
  const tint = mix(
    mix(
      vec3(c.meadowFreshRed, c.meadowFreshGreen, c.meadowFreshBlue),
      vec3(c.meadowDryRed, c.meadowDryGreen, c.meadowDryBlue),
      dryness,
    ),
    vec3(c.macroDryRed, c.macroDryGreen, c.macroDryBlue),
    macroDry,
  );
  return {
    ...grass,
    albedo: grass.albedo.mul(
      strength === 1
        ? tint
        : mix(vec3(1), tint, float(strength)).toVar("coastalMeadowTint"),
    ),
  };
}

/**
 * Colour-only ridge field in admitted profile coordinates. One sine and four
 * smoothsteps here, one slope transition in layer weights, no new texture fetch.
 * Noise only perturbs the soft shoulder;
 * there are no height contours, discrete cells or camera-dependent regions.
 */
export function createCompactTerrainMacroWeights(
  worldXZ: Node<"vec2">,
  noise: Node<"float">,
  field: CompactTerrainMacroField | null,
) {
  if (!field) return { dry: float(0), westRock: float(0) };
  const c = COMPACT_TERRAIN_COMPOSITION;
  const ax = worldXZ.x.sub(field.centerX).mul(field.scale);
  const az = worldXZ.y.sub(field.centerZ).mul(field.scale);
  const progress = az
    .sub(field.ridgeStartZ)
    .mul(1 / (field.ridgeEndZ - field.ridgeStartZ))
    .clamp(0, 1);
  const cross = ax.sub(
    float(field.ridgeBaseX).sub(
      progress.mul(Math.PI).sin().mul(field.ridgeBend),
    ),
  );
  const ends = smoothstep(
    float(field.ridgeStartZ),
    float(field.ridgeStartZ + field.ridgeEndFade),
    az,
  ).mul(
    float(1).sub(
      smoothstep(
        float(field.ridgeEndZ - field.ridgeEndFade),
        float(field.ridgeEndZ),
        az,
      ),
    ),
  );
  const west = cross.mul(-1 / field.ridgeWestWidth);
  const across = max(cross.mul(1 / field.ridgeEastWidth), west);
  const shoulder = ends.mul(
    float(1).sub(
      smoothstep(
        float(c.macroShoulderStart),
        float(c.macroShoulderEnd),
        across.add(noise.sub(0.5).mul(c.macroBoundaryNoise)),
      ),
    ),
  );
  return {
    dry: shoulder,
    westRock: shoulder.mul(
      smoothstep(float(c.macroWestStart), float(c.macroWestEnd), west),
    ),
  };
}

/** Bounded reflectance-only soil field, sharing CPU constants and arithmetic. */
export function createCompactPlantingSoil(
  world: Node<"vec3">,
  distortNoise: Node<"float">,
  lobes?: readonly CompactTerrainPlantingLobe[] | null,
): Node<"float"> {
  if (!lobes?.length) return float(0);
  const c = COMPACT_TERRAIN_COMPOSITION;
  const edgeWidth = distortNoise
    .clamp(0, 1)
    .mul(2)
    .sub(1)
    .mul(c.plantingEdgeNoiseWidth)
    .add(c.plantingEdgeWidth);
  let soil: Node<"float"> = float(0);
  for (const lobe of lobes) {
    const dx = world.x.sub(lobe.centerX).div(lobe.radiusX);
    const dz = world.z.sub(lobe.centerZ).div(lobe.radiusZ);
    const inner = float(1).sub(
      edgeWidth.div(Math.min(lobe.radiusX, lobe.radiusZ)),
    );
    soil = max(
      soil,
      float(1)
        .sub(smoothstep(inner.mul(inner), float(1), dx.mul(dx).add(dz.mul(dz))))
        .mul(c.plantingSoilStrength),
    );
  }
  return soil;
}

/** Shared capsule kernel; material authoring does not alter route eligibility. */
function createCompactGroundRibbonWeight(
  worldXZ: Node<"vec2">,
  ribbon: CompactTerrainGroundRibbon,
): Node<"float"> {
  const dx = ribbon.endX - ribbon.startX;
  const dz = ribbon.endZ - ribbon.startZ;
  const px = worldXZ.x.sub(ribbon.startX);
  const pz = worldXZ.y.sub(ribbon.startZ);
  const t = px
    .mul(dx)
    .add(pz.mul(dz))
    .div(dx * dx + dz * dz)
    .clamp(0, 1);
  const crossX = px.sub(t.mul(dx));
  const crossZ = pz.sub(t.mul(dz));
  return float(1)
    .sub(
      smoothstep(
        float(ribbon.coreRadius * ribbon.coreRadius),
        float(ribbon.outerRadius * ribbon.outerRadius),
        crossX.mul(crossX).add(crossZ.mul(crossZ)),
      ),
    )
    .mul(ribbon.strength);
}

/** Same bounded world-space kernels as the serializable CPU palette factory. */
export function createCompactHavenGroundWeights(
  worldXZ: Node<"vec2">,
  field?: CompactTerrainHavenGround | null,
  pondSoil: Node<"float"> = float(0),
  geometricSlope: Node<"float"> = float(0),
) {
  let talus: Node<"float"> = float(0);
  let wear: Node<"float"> = float(0);
  if (!field) return { talus, wear };
  for (const ribbon of field.talus)
    talus = max(talus, createCompactGroundRibbonWeight(worldXZ, ribbon));
  for (const ribbon of field.wear)
    wear = max(wear, createCompactGroundRibbonWeight(worldXZ, ribbon));
  // Shared by albedo, roughness, AO and the normal frame. Explicit temporaries
  // keep the seven spatial kernels out of each channel's separate expression.
  return {
    talus: talus
      .mul(
        smoothstep(
          float(COMPACT_TERRAIN_COMPOSITION.havenTalusSlopeStart),
          float(COMPACT_TERRAIN_COMPOSITION.havenTalusSlopeEnd),
          geometricSlope.clamp(0, 1),
        ),
      )
      .mul(float(1).sub(pondSoil))
      .toVar("compactHavenTalusWeight"),
    wear: wear.toVar("compactHavenWearWeight"),
  };
}

/** Same constants/arithmetic as the serializable CPU grass palette factory. */
export function createCompactTerrainLayerWeights(
  noise: Node<"float">,
  geometricSlope: Node<"float">,
  rawRoadInfluence: Node<"float">,
  edgeNoise: Node<"float"> = float(0.5),
  pondSurface: {
    soil: Node<"float">;
    wetness: Node<"float">;
    /** Narrowing the soil transition must not expose previously hidden cliff. */
    cliffSoil?: Node<"float">;
  } = {
    soil: float(0),
    wetness: float(0),
  },
  macroSurface: { dry: Node<"float">; westRock: Node<"float"> } = {
    dry: float(0),
    westRock: float(0),
  },
  plantingSoil: Node<"float"> = float(0),
) {
  const c = COMPACT_TERRAIN_COMPOSITION;
  const slope = geometricSlope.clamp(0, 1);
  const patch = smoothstep(float(c.patchStart), float(c.patchEnd), noise)
    .mul(smoothstep(float(c.flatStart), float(c.flatEnd), slope))
    .mul(c.patchStrength);
  const slopeDirt = smoothstep(
    float(c.slopeDirtStart),
    float(c.slopeDirtPeak),
    slope,
  )
    .mul(smoothstep(float(c.slopeDirtEnd), float(c.slopeDirtFall), slope))
    .mul(c.slopeDirtStrength);
  const wornEdge = edgeNoise
    .sub(0.5)
    .mul(c.pathEdgeNoiseContrast)
    .add(0.5)
    .clamp(0, 1);
  const geometricCliff = smoothstep(
    float(c.cliffStart),
    float(c.cliffEnd),
    slope,
  );
  return {
    dirt: float(1).sub(
      float(1)
        .sub(patch)
        .mul(float(1).sub(slopeDirt))
        .mul(float(1).sub(macroSurface.dry.mul(c.macroSoilStrength)))
        .mul(float(1).sub(pondSurface.soil))
        .mul(float(1).sub(plantingSoil)),
    ),
    geometricCliff,
    cliff: max(
      geometricCliff,
      macroSurface.westRock.mul(
        smoothstep(
          float(c.macroRockSlopeStart),
          float(c.macroRockSlopeEnd),
          slope,
        ),
      ),
    ).mul(float(1).sub(pondSurface.cliffSoil ?? pondSurface.soil)),
    road: smoothstep(
      mix(float(c.pathEdgeStartLow), float(c.pathEdgeStartHigh), wornEdge),
      mix(float(c.pathEdgeEndLow), float(c.pathEdgeEndHigh), wornEdge),
      rawRoadInfluence,
    ),
    variation: mix(float(c.variationLow), float(c.variationHigh), noise),
  };
}

/**
 * Candidate-only material transition, using the existing world-anchored noise.
 * The CPU grass color factory uses the same weights, but physical grass
 * eligibility and the authoritative path mask remain completely separate.
 */
export function createCompactPondContactSoil(
  world: Node<"vec3"> | undefined,
  distortNoise: Node<"float">,
  field: CompactTerrainMacroField | null,
): Node<"float"> {
  if (!world || !field?.coastalMeadow || !field.pondContactGround)
    return float(0);
  let contact: Node<"float"> = float(0);
  for (const ribbon of field.pondContactGround)
    contact = max(contact, createCompactGroundRibbonWeight(world.xz, ribbon));
  return contact
    .mul(distortNoise.clamp(0, 1).mul(0.2).add(0.8))
    .toVar("compactPondContactSoil");
}

/**
 * Explicit contact candidate, not a replacement for the shared pond/grass
 * masks. The existing unequal ribbons join the current western/eastern rock
 * groups. Reuse their .75/.55 maximum strengths and .8..1 noise modulation;
 * expose rock only where original pond soil conceals actual geometric cliff.
 * Full roads remain unchanged. No material height, extra texture lookup,
 * invented normal or altered CPU ecological rule enters this exposure.
 */
export function createCompactPondRockContact(input: {
  world: Node<"vec3"> | undefined;
  distortNoise: Node<"float">;
  field: CompactTerrainMacroField | null;
  pondSoil: Node<"float">;
  geometricCliff: Node<"float">;
  road: Node<"float">;
  /** The actual shared ribbon node, also used by the existing worn-turf path. */
  pondContactSoil?: Node<"float">;
}): Node<"float"> {
  if (
    !input.world ||
    !input.field?.coastalMeadow ||
    !input.field.pondContactGround
  )
    return float(0);
  const contact =
    input.pondContactSoil ??
    createCompactPondContactSoil(input.world, input.distortNoise, input.field);
  return contact
    .mul(input.geometricCliff.clamp(0, 1))
    .mul(input.pondSoil.clamp(0, 1))
    .mul(float(1).sub(input.road.clamp(0, 1)))
    .toVar("compactPondRockContactExposure");
}

/** Transfer only final dry soil, after relief and sediment. Existing grass,
 * coastal soil, wetness and CPU anchor colors retain their original owners.
 * Unchanged grass weight does NOT prove root-color agreement beside altered
 * soil: actual accepted anchors/contact views remain a native visual gate. */
export function applyCompactPondRockContactWeights(
  weights: Node<"vec4">,
  exposure: Node<"float">,
): Node<"vec4"> {
  const transfer = weights.y
    .mul(exposure.clamp(0, 1))
    .toVar("compactPondRockContactTransfer");
  return vec4(
    weights.x,
    weights.y.sub(transfer),
    weights.z.add(transfer),
    weights.w,
  ).toVar("compactPondRockContactSurfaceWeights");
}

export function createCompactWornTurfWeights(input: {
  /** Omission keeps the historical non-local graph used by existing callers. */
  worldPosition?: Node<"vec3">;
  bankVergeLocality?: Node<"float">;
  meadowNoise: Node<"float">;
  distortNoise: Node<"float">;
  geometricSlope: Node<"float">;
  rawRoadInfluence: Node<"float">;
  road: Node<"float">;
  pondSoil: Node<"float">;
  coastalCoverage: Node<"float">;
  field: CompactTerrainMacroField | null;
  /** Candidate-only reuse; omission retains the original graph exactly. */
  pondContactSoil?: Node<"float">;
}): { soil: Node<"float">; road: Node<"float"> } {
  if (!input.field?.coastalMeadow) return { soil: float(0), road: input.road };
  const c = COMPACT_TERRAIN_COMPOSITION;
  const patch = smoothstep(
    float(c.turfPatchStart),
    float(c.turfPatchEnd),
    input.meadowNoise
      .clamp(0, 1)
      .mul(c.turfMeadowFraction)
      .add(input.distortNoise.clamp(0, 1).mul(1 - c.turfMeadowFraction)),
  ).toVar("compactWornTurfPatch");
  const land = float(1)
    .sub(input.pondSoil.clamp(0, 1))
    .mul(float(1).sub(input.coastalCoverage.clamp(0, 1)))
    .toVar("compactWornTurfLand");
  const patchSoil = patch
    .mul(
      float(1).sub(
        smoothstep(
          float(c.turfFlatStart),
          float(c.turfFlatEnd),
          input.geometricSlope.clamp(0, 1),
        ),
      ),
    )
    .mul(c.turfSoilStrength);
  const soil = max(
    patchSoil,
    input.pondContactSoil ??
      createCompactPondContactSoil(
        input.worldPosition,
        input.distortNoise,
        input.field,
      ),
  )
    .mul(land)
    .toVar("compactWornTurfSoil");
  const edge = smoothstep(
    mix(float(c.turfEdgeStartLow), float(c.turfEdgeStartHigh), patch),
    mix(float(c.turfEdgeEndLow), float(c.turfEdgeEndHigh), patch),
    input.road,
  );
  const locality =
    input.bankVergeLocality ??
    (input.worldPosition
      ? createCompactBankVergeLocality(input.worldPosition, input.field)
      : float(0));
  return {
    soil,
    road: mix(
      input.road,
      edge,
      float(1)
        .sub(
          smoothstep(
            float(c.turfCoreStart),
            float(c.turfCoreEnd),
            input.rawRoadInfluence,
          ),
        )
        .mul(land)
        // Keep the first continuous road blend through this bank verge. The
        // second artistic threshold otherwise pinches its shoulder into lobes.
        .mul(float(1).sub(locality)),
    ).toVar("compactWornTurfRoad"),
  };
}

/** Same candidate-only sea-relative cover as the emitted grass palette factory. */
export function createCompactCoastalGroundCover(
  height: Node<"float">,
  noiseValue: Node<"float">,
  edgeNoise: Node<"float">,
  field: CompactTerrainMacroField | null,
): Node<"float"> {
  if (!field?.coastalMeadow) return float(0);
  const c = COMPACT_TERRAIN_COMPOSITION;
  const patch = smoothstep(
    float(c.coastPatchStart),
    float(c.coastPatchEnd),
    noiseValue
      .clamp(0, 1)
      .add(edgeNoise.clamp(0, 1).sub(0.5).mul(c.coastEdgeNoise)),
  );
  return float(1).sub(
    smoothstep(
      mix(float(c.coastalGroundFullLow), float(c.coastalGroundFullHigh), patch),
      mix(float(c.coastalGroundEndLow), float(c.coastalGroundEndHigh), patch),
      height.sub(field.seaLevel),
    ),
  );
}

/** Existing coastal rock redistribution, independent of meadow ground cover. */
export function createCompactCoastWeights(
  world: Node<"vec3">,
  noiseValue: Node<"float">,
  edgeNoise: Node<"float">,
  westRock: Node<"float">,
  geometricSlope: Node<"float">,
  field: CompactTerrainMacroField | null,
) {
  if (!field) return { soil: float(0), wetness: float(0), coverage: float(0) };
  const c = COMPACT_TERRAIN_COMPOSITION;
  const noise = noiseValue.clamp(0, 1),
    edge = edgeNoise.clamp(0, 1);
  const relative = world.y
    .sub(field.seaLevel)
    .div(field.baseElevation - field.seaLevel);
  const coverage = float(1).sub(
    smoothstep(
      mix(float(c.coastFadeStartLow), float(c.coastFadeStartHigh), noise),
      mix(float(c.coastFadeEndLow), float(c.coastFadeEndHigh), noise),
      relative,
    ),
  );
  const delta = vec2(world.x.sub(field.centerX), world.z.sub(field.centerZ));
  const direction = delta.x
    .mul(field.headlandDirectionX)
    .add(delta.y.mul(field.headlandDirectionZ))
    .div(delta.length().max(1e-6));
  const headland = smoothstep(
    float(field.headlandOuterCos),
    float(field.headlandInnerCos),
    direction,
  );
  const patch = smoothstep(
    float(c.coastPatchStart),
    float(c.coastPatchEnd),
    noise.add(edge.sub(0.5).mul(c.coastEdgeNoise)),
  );
  return {
    // Expose this existing sea-relative owner without changing the default
    // graph, its soil/cliff multiplication, or coastal wetness.
    coverage,
    soil: coverage
      .mul(mix(float(c.coastSoilLow), float(c.coastSoilHigh), patch))
      .mul(float(1).sub(headland.mul(c.coastHeadlandRock)))
      .mul(float(1).sub(westRock.clamp(0, 1).mul(c.coastRidgeRock)))
      // Share the geometric cliff ramp with the CPU palette. Wetness remains
      // independent: exposed rock can still be wet without projected dirt.
      .mul(
        float(1).sub(
          smoothstep(float(c.cliffStart), float(c.cliffEnd), geometricSlope),
        ),
      ),
    wetness: float(1).sub(
      smoothstep(
        float(c.coastWetStart),
        mix(float(c.coastWetEndLow), float(c.coastWetEndHigh), edge),
        relative,
      ),
    ),
  };
}

/** The shared inland mask attenuates only nested soil, not coastal wetness. */
export function applyCompactPondRockSoil(
  soil: Node<"float">,
  field: CompactPondBankComposition<Node<"float">> | undefined,
): Node<"float"> {
  if (field?.substrateSoilToRock === undefined) return soil;
  return createCompactTerrainColorOperations()
    .bankRockSoil(soil, field, compactCoastDistributionMath)
    .toVar("compactPondRockNestedSoil");
}

/** Pond-local material art reuses the SAME sampled soil/rock layers. Coverage,
 * relief heights, raw source cavities and final water wetness retain ownership. */
export function applyCompactPondBankMaterials(
  soil: CompactTerrainLayer,
  rock: CompactTerrainLayer,
  field: CompactPondBankComposition<Node<"float">> | undefined,
): { soil: CompactTerrainLayer; rock: CompactTerrainLayer } {
  if (
    field?.mineralAppearance === undefined ||
    field.siltAppearance === undefined
  )
    return { soil, rock };
  const mineral = field.mineralAppearance.clamp(0, 1);
  const silt = field.siltAppearance.clamp(0, 1);
  const albedo = createCompactTerrainColorOperations().bankAppearanceAlbedo(
    [soil.albedo.x, soil.albedo.y, soil.albedo.z],
    [rock.albedo.x, rock.albedo.y, rock.albedo.z],
    field,
    compactCoastDistributionMath,
  );
  // Normalizing only the changed contribution keeps the original normal exact
  // outside the field, including source normals with finite rounding error.
  const mineralNormal = mineral
    .greaterThan(0)
    .select(
      normalize(mix(soil.worldNormal, rock.worldNormal, mineral)),
      soil.worldNormal,
    );
  const soilNormal = silt
    .greaterThan(0)
    .select(
      normalize(mix(mineralNormal, soil.worldNormal, silt)),
      mineralNormal,
    );
  return {
    soil: {
      ...soil,
      albedo: vec3(...albedo.soil).toVar("compactPondBankSoilAlbedo"),
      roughness: mix(
        mix(soil.roughness, rock.roughness, mineral),
        soil.roughness,
        silt,
      ),
      ao: mix(mix(soil.ao, rock.ao, mineral), soil.ao, silt),
      worldNormal: soilNormal,
    },
    rock: {
      ...rock,
      albedo: vec3(...albedo.rock).toVar("compactPondBankRockAlbedo"),
      roughness: mix(rock.roughness, soil.roughness, silt),
      ao: mix(rock.ao, soil.ao, silt),
      worldNormal: silt
        .greaterThan(0)
        .select(
          normalize(mix(rock.worldNormal, soil.worldNormal, silt)),
          rock.worldNormal,
        ),
    },
  };
}

/** Reuse soil/rock maps together; never tint grass or full path/pond overrides. */
export function applyCompactCoastRock(
  rock: CompactTerrainLayer,
  soil: CompactTerrainLayer,
  coast: { soil: Node<"float">; wetness: Node<"float"> },
): CompactTerrainLayer {
  const c = COMPACT_TERRAIN_COMPOSITION;
  const roughness = mix(rock.roughness, soil.roughness, coast.soil);
  return {
    // Keep original source cavities independent of the nested soil/wetness mix.
    ...(rock.rawRockAo ? { rawRockAo: rock.rawRockAo } : {}),
    albedo: mix(rock.albedo, soil.albedo, coast.soil).mul(
      mix(float(1), float(c.coastWetAlbedo), coast.wetness),
    ),
    roughness: mix(
      roughness,
      roughness.min(c.coastWetRoughness),
      coast.wetness,
    ),
    ao: mix(rock.ao, soil.ao, coast.soil),
    worldNormal: normalize(mix(rock.worldNormal, soil.worldNormal, coast.soil)),
  };
}

/** World-space localized soil/wetness; pond = centerX, centerZ, radius, waterY. */
export function createCompactPondSurfaceWeights(
  world: Node<"vec3">,
  noise: Node<"float">,
  pond: Node<"vec4">,
  distribution?: CompactPondDistributionDescriptor,
  margin?: CompactPondMargin<Node<"float">>,
) {
  const c = COMPACT_TERRAIN_COMPOSITION;
  const radial = vec2(world.x.sub(pond.x), world.z.sub(pond.y)).length();
  const end = pond.z.add(c.pondBankReach);
  const region = float(1).sub(
    smoothstep(end.sub(c.pondRadialFade), end, radial),
  );
  const height = world.y.sub(pond.w);
  const noiseHeight = noise.sub(0.5).mul(2 * c.pondBankNoiseHeight);
  const legacySoil = region.mul(
    float(1).sub(
      smoothstep(
        noiseHeight.add(c.pondSoilFullHeight),
        noiseHeight.add(c.pondSoilEndHeight),
        height,
      ),
    ),
  );
  const operations = distribution
    ? createCompactTerrainColorOperations()
    : null;
  const selected = operations?.validatePondDistribution(distribution);
  if (margin && !selected)
    throw new Error("Pond margin requires the admitted pond distribution");
  // The same center-preserving coverage drives CPU grass support/root colors.
  // Keep the old mask for cliff and prior relief/contact locality, and keep
  // water wetness independent. This adds arithmetic, not a texture lookup.
  let soil =
    selected && operations
      ? region
          .mul(
            operations.pondSoilCoverage<Node<"float">>(
              height,
              noise,
              selected,
              {
                constant: (value) => float(value),
                add: (a, b) => a.add(b),
                sub: (a, b) => a.sub(b),
                mul: (a, b) => a.mul(b),
                smoothstep: (low, high, value) => smoothstep(low, high, value),
              },
            ),
          )
          .toVar("compactPondShoreSoil")
      : legacySoil;
  if (margin && operations)
    soil = operations
      .applyPondMarginSoil(soil, margin, compactCoastDistributionMath)
      .toVar("compactPondMarginSoil");
  return {
    ...(selected
      ? { cliffSoil: legacySoil.toVar("compactPondLegacySoil") }
      : {}),
    // Existing dry-bank domain and wetness remain independent of distribution.
    domain: { region, height, noiseHeight },
    soil,
    wetness: region.mul(
      float(1).sub(
        smoothstep(
          float(c.pondWetFullHeight),
          float(c.pondWetEndHeight),
          height,
        ),
      ),
    ),
  };
}

/**
 * Local sediment at the wet-to-dry shoulder, using existing radial/noise nodes.
 * The shoulder includes +0.330895m lawn; review49 located the photographed rim
 * lower on the inner bank. A slope fade retains steep rock faces. These remain
 * visual candidate bounds, not a geological model or a measured rim elevation.
 * The rising edge can overlap wet soil; unchanged pond wetness still applies.
 * This mask never participates in grass support, wetness, or height competition.
 */
export function createCompactPondBankSediment(
  domain: CompactTerrainPondDomain,
  geometricSlope: Node<"float">,
): Node<"float"> {
  const c = COMPACT_TERRAIN_POND_SEDIMENT;
  const localHeight = domain.height.sub(domain.noiseHeight);
  return domain.region
    .mul(smoothstep(float(c.riseStart), float(c.riseEnd), localHeight))
    .mul(
      float(1).sub(
        smoothstep(float(c.fallStart), float(c.fallEnd), localHeight),
      ),
    )
    .mul(
      float(1).sub(
        smoothstep(
          float(c.slopeFadeStart),
          float(c.slopeFadeEnd),
          geometricSlope.clamp(0, 1),
        ),
      ),
    )
    .toVar("compactPondDrySediment");
}

export function applyCompactPondWetness(
  surface: ReturnType<typeof blendCompactTerrainLayers>,
  wetness: Node<"float">,
) {
  return {
    ...surface,
    albedo: surface.albedo.mul(
      mix(float(1), float(COMPACT_TERRAIN_COMPOSITION.pondWetAlbedo), wetness),
    ),
    roughness: mix(
      surface.roughness,
      surface.roughness.min(COMPACT_TERRAIN_COMPOSITION.pondWetRoughness),
      wetness,
    ),
  };
}

/**
 * Two noise-selected projections share one smooth transition. At every band
 * boundary the outgoing B projection is exactly the incoming A projection.
 * Gradients exclude the discrete selection/offset: implicit derivatives across
 * a band would select false coarse mip levels and corrupt the normal frame.
 * See NVIDIA GPU Gems, chapter 20, "Texture Bombing", filtering discussion.
 */
export function createCompactGroundProjections(
  worldXZ: Node<"vec2">,
  patternNoise: Node<"float">,
  repeatsPerMeter: number,
  worldDx: Node<"vec2"> = worldXZ.dFdx(),
  worldDy: Node<"vec2"> = worldXZ.dFdy(),
) {
  const c = COMPACT_TERRAIN_MATERIAL;
  const selector = patternNoise.mul(c.groundPatternBands);
  const index = selector.floor();
  const project = (id: Node<"float">) => {
    const angle = id.mul(2.399963229728653);
    const cosine = angle.cos(),
      sine = angle.sin();
    const scale = id
      .mul(1.61803398875)
      .sin()
      .mul(c.groundPatternScaleVariation)
      .add(1)
      .mul(repeatsPerMeter);
    const rotate = (value: Node<"vec2">) =>
      vec2(
        value.x.mul(cosine).sub(value.y.mul(sine)),
        value.x.mul(sine).add(value.y.mul(cosine)),
      ).mul(scale);
    const offset = vec2(id.mul(3.17).sin(), id.mul(7.13).sin()).mul(17);
    return {
      uv: rotate(worldXZ).add(offset),
      dx: rotate(worldDx),
      dy: rotate(worldDy),
    };
  };
  return {
    a: project(index),
    b: project(index.add(1)),
    weight: smoothstep(
      float(c.groundPatternBlendStart),
      float(c.groundPatternBlendEnd),
      selector.fract(),
    ),
  };
}

/**
 * Three world-anchored patches on an equilateral lattice. A vertex owns its
 * transform, so neighboring triangles share exactly the same edge samples.
 * The 1m patch edge is separate from the scan's unchanged 2m physical width:
 * no single affine projection dominates a broad multi-repeat bank anymore.
 * This uses the triangular construction of Heitz/Neyret, not their complete
 * histogram-preserving algorithm: https://eheitzresearch.wordpress.com/722-2/
 * Explicit gradients exclude the discrete vertex/hash selection for BOTH packed
 * maps and the cotangent normal frame. No terrain/placement noise is changed.
 */
export function createCompactDirtProjections(
  worldXZ: Node<"vec2">,
  worldDx: Node<"vec2"> = worldXZ.dFdx(),
  worldDy: Node<"vec2"> = worldXZ.dFdy(),
) {
  const c = COMPACT_TERRAIN_MATERIAL;
  return createCompactStochasticProjections(
    worldXZ,
    c.dirtRepeatsPerMeter,
    c.dirtPatchEdgeMeters,
    worldDx,
    worldDy,
  );
}

/** Shared equilateral patch construction; scale belongs to the source scan.
 * Each plane's original continuous derivatives precede the discrete lattice.
 * Its vertex transform is shared by both adjacent triangles and all PBR maps.
 * Barycentric values are continuous, not a claim of continuous derivatives.
 */
export function createCompactStochasticProjections(
  worldXZ: Node<"vec2">,
  repeatsPerMeter: number,
  patchEdgeMeters: number,
  worldDx: Node<"vec2"> = worldXZ.dFdx(),
  worldDy: Node<"vec2"> = worldXZ.dFdy(),
  seed = 0,
) {
  const skew = vec2(
    worldXZ.x.sub(worldXZ.y.mul(1 / Math.sqrt(3))),
    worldXZ.y.mul(2 / Math.sqrt(3)),
  ).div(patchEdgeMeters);
  const cell = skew.floor();
  const f = skew.fract();
  const sum = f.x.add(f.y);
  const upper = sum.step(1);
  const weights = vec3(
    mix(float(1).sub(sum), sum.sub(1), upper),
    mix(f.x, float(1).sub(f.y), upper),
    mix(f.y, float(1).sub(f.x), upper),
  );
  const project = (id: Node<"vec2">) => {
    const angle = createCompactDirtVertexHash(id, seed).mul(2 * Math.PI);
    const cosine = angle.cos(),
      sine = angle.sin();
    const rotate = (v: Node<"vec2">) =>
      vec2(
        v.x.mul(cosine).sub(v.y.mul(sine)),
        v.x.mul(sine).add(v.y.mul(cosine)),
      ).mul(repeatsPerMeter);
    const offset = vec2(
      createCompactDirtVertexHash(id, 0x68bc21eb ^ seed),
      createCompactDirtVertexHash(id, 0x02e5be93 ^ seed),
    );
    const center = vec2(
      id.x.add(id.y.mul(0.5)),
      id.y.mul(Math.sqrt(3) / 2),
    ).mul(patchEdgeMeters);
    return {
      id,
      uv: rotate(worldXZ.sub(center)).add(offset),
      dx: rotate(worldDx),
      dy: rotate(worldDy),
    };
  };
  return {
    a: project(cell.add(vec2(upper))),
    b: project(cell.add(vec2(1, 0))),
    c: project(cell.add(vec2(0, 1))),
    weights,
  };
}

/**
 * Signed lattice IDs convert through i32 before u32, preserving negative cells
 * instead of saturating a negative float-to-uint cast. PCG permutation matches
 * Three's Hash.js; explicit unsigned constants retain modulo-2^32 arithmetic.
 * Use the high 24 bits so f32 conversion cannot round the result up to 1.
 * Integer mixing avoids the large float error amplification of sin(dot(id))*N.
 */
export function createCompactDirtVertexHash(
  id: Node<"vec2">,
  salt: number,
): Node<"float"> {
  const seed = id.x
    .toInt()
    .toUint()
    .mul(uint(1597334677))
    .add(id.y.toInt().toUint().mul(uint(3812015801)))
    .bitXor(uint(salt));
  const state = seed.mul(uint(747796405)).add(uint(2891336453));
  const word = state
    .shiftRight(state.shiftRight(uint(28)).add(uint(4)))
    .bitXor(state)
    .mul(uint(277803737));
  return word
    .shiftRight(uint(22))
    .bitXor(word)
    .shiftRight(uint(8))
    .toFloat()
    .mul(1 / 16777216);
}

/**
 * Bounded mean/variance compensation, NOT exact histogram preservation. The
 * gain is 1..sqrt(3) for barycentric weights. It counters linear-blend washout;
 * correlated/non-Gaussian inputs, clipping and native mips still need visual QA.
 * Never apply this albedo correction to roughness, AO or encoded normal texels.
 */
export function blendCompactDirtAlbedo(
  a: Node<"vec3">,
  b: Node<"vec3">,
  c: Node<"vec3">,
  weights: Node<"vec3">,
): Node<"vec3"> {
  const palette = createCompactTerrainColorOperations().getPalette().dirt;
  return blendCompactStochasticAlbedo(a, b, c, weights, palette);
}

/** Same approximate linear-space compensation for each independently sampled
 * scan. Never use the dirt mean for stone or compensate encoded normal channels.
 * This does not perform the histogram transform/inverse of Heitz/Neyret.
 */
export function blendCompactStochasticAlbedo(
  a: Node<"vec3">,
  b: Node<"vec3">,
  c: Node<"vec3">,
  weights: Node<"vec3">,
  palette: readonly number[],
): Node<"vec3"> {
  const mean = vec3(palette[0], palette[1], palette[2]);
  const blended = a.mul(weights.x).add(b.mul(weights.y)).add(c.mul(weights.z));
  const gain = weights
    .dot(weights)
    .max(1 / 3)
    .inverseSqrt();
  return mean.add(blended.sub(mean).mul(gain)).clamp(0, 1);
}

/**
 * Contrast-compensated dual rock projection, not histogram-preserving noise.
 * For uncorrelated equal-variance samples, linear blending scales variance by
 * (1-w)^2+w^2. Recenter on the admitted LINEAR scan mean and undo that loss.
 * Correlation, non-Gaussian histograms and mip filtering limit this approximation;
 * the final reflectance clamp also breaks exact moments for out-of-gamut tails.
 * Heitz/Neyret explain why exact histogram preservation needs further transforms:
 * https://eheitzresearch.wordpress.com/722-2/
 * No compensation is applied to roughness, AO or the decoded normal frame.
 */
export function blendCompactRockAlbedo(
  a: Node<"vec3">,
  b: Node<"vec3">,
  weight: Node<"float">,
): Node<"vec3"> {
  const palette = createCompactTerrainColorOperations().getPalette().rock;
  const mean = vec3(palette[0], palette[1], palette[2]);
  const opposite = float(1).sub(weight);
  const gain = opposite.mul(opposite).add(weight.mul(weight)).inverseSqrt();
  return mean.add(mix(a, b, weight).sub(mean).mul(gain)).clamp(0, 1);
}

/**
 * Derivative cotangent frame from THIS projection's UVs, not geometry.uv.
 * Uses the geometric normal to avoid normalNode -> normalWorld recursion.
 * Neutral normal texels preserve that normal on all axes, including mirrored
 * projections; degenerate edge-on projections have a bounded zero tangent.
 */
export function createCompactProjectedNormal(
  encoded: Node<"vec3">,
  uv: Node<"vec2">,
  strength: Node<"float">,
): Node<"vec3"> {
  return createCompactCotangentNormal(
    encoded,
    normalWorldGeometry,
    positionWorld.dFdx(),
    positionWorld.dFdy(),
    uv.dFdx(),
    uv.dFdy(),
    strength,
  );
}

/** Explicit derivative inputs also permit real arithmetic-node regression tests. */
export function createCompactCotangentNormal(
  encoded: Node<"vec3">,
  n: Node<"vec3">,
  q0: Node<"vec3">,
  q1: Node<"vec3">,
  st0: Node<"vec2">,
  st1: Node<"vec2">,
  strength: Node<"float">,
): Node<"vec3"> {
  return createCompactCotangentNormalFromInputs(
    encoded,
    createCompactCotangentInputs(n, q0, q1),
    st0,
    st1,
    strength,
  );
}

function createCompactCotangentInputs(
  n: Node<"vec3">,
  q0: Node<"vec3">,
  q1: Node<"vec3">,
) {
  return { n, q1perp: q1.cross(n), q0perp: n.cross(q0) };
}

function createCompactCotangentNormalFromInputs(
  encoded: Node<"vec3">,
  inputs: ReturnType<typeof createCompactCotangentInputs>,
  st0: Node<"vec2">,
  st1: Node<"vec2">,
  strength: Node<"float">,
): Node<"vec3"> {
  const { n, q1perp, q0perp } = inputs;
  const tangent = q1perp.mul(st0.x).add(q0perp.mul(st1.x));
  const bitangent = q1perp.mul(st0.y).add(q0perp.mul(st1.y));
  const scale = max(tangent.dot(tangent), bitangent.dot(bitangent))
    .max(1e-12)
    .inverseSqrt();
  const unpacked = encoded.mul(2).sub(1);
  return normalize(
    tangent
      .mul(scale)
      .mul(unpacked.x)
      .mul(strength)
      .add(bitangent.mul(scale).mul(unpacked.y).mul(strength))
      .add(n.mul(unpacked.z.max(0.001))),
  );
}

/**
 * Dry turf art calibration from the original linear packed alpha. A monotone
 * range preserves texture variation that the old .65 floor almost eliminated.
 * These are art-directed perceptual roughness limits, not measured properties;
 * localized shore/pond wetness still applies after dry-layer construction.
 */
export function createCompactDryGrassRoughness(
  packedAlpha: Node<"float">,
  projection: "A" | "B" = "A",
): Node<"float"> {
  const c = COMPACT_TERRAIN_MATERIAL;
  return packedAlpha
    .mul(c.dryGrassRoughnessHigh - c.dryGrassRoughnessLow)
    .add(c.dryGrassRoughnessLow)
    .toVar(`compactDryGrassRoughness${projection}`);
}

export function createCompactTerrainLayers(
  textures: CompactTerrainTextureSet,
  distanceSquared: Node<"float">,
  patternNoise: Node<"float"> = float(0.5),
): Record<Layer, CompactTerrainLayer> {
  const controls = COMPACT_TERRAIN_MATERIAL;
  const nearDetail = float(1).sub(
    smoothstep(
      float(controls.normalFadeNear ** 2),
      float(controls.normalFadeFar ** 2),
      distanceSquared,
    ),
  );
  // Only identical geometric inputs are shared by the explicit rock candidate.
  // Rotated projections retain their own tangent lengths, scale and normal:
  // a common scan scale does not make oblique cotangent frames interchangeable.
  const sharedRockNormal = textures.rockProjection
    ? {
        inputs: createCompactCotangentInputs(
          normalWorldGeometry,
          positionWorld.dFdx(),
          positionWorld.dFdy(),
        ),
        strength: nearDetail.mul(controls.rockNormalStrength),
      }
    : null;
  const project = (
    layer: Layer,
    uv: Node<"vec2">,
    normalStrength: number,
    gradients?: { dx: Node<"vec2">; dy: Node<"vec2"> },
    projection: "A" | "B" = "A",
  ): CompactTerrainLayer => {
    const sample = (channel: Channel) => {
      const base = textures.getNode(layer, channel);
      return gradients
        ? base.grad(gradients.dx, gradients.dy).sample(uv)
        : base.sample(uv);
    };
    const ar = sample("albedo-roughness");
    const na = sample("normal-ao");
    const heightMap = textures.getHeightNode();
    // Each layer's height follows its own exact projection and gradients.
    // Sampling RGB once at a common UV would misalign the material relief.
    const heightSample =
      heightMap && layer !== "rock"
        ? gradients
          ? heightMap.grad(gradients.dx, gradients.dy).sample(uv)
          : heightMap.sample(uv)
        : undefined;
    return {
      ...(layer === "rock" ? { rawRockAo: na.a } : {}),
      ...(heightSample
        ? { height: layer === "grass" ? heightSample.r : heightSample.g }
        : {}),
      albedo: ar.rgb,
      roughness:
        layer === "grass"
          ? createCompactDryGrassRoughness(ar.a, projection)
          : ar.a.max(controls.minimumRoughness),
      ao: mix(float(1), na.a, float(controls.aoStrength)),
      worldNormal:
        layer === "rock" && sharedRockNormal
          ? createCompactCotangentNormalFromInputs(
              na.rgb,
              sharedRockNormal.inputs,
              gradients?.dx ?? uv.dFdx(),
              gradients?.dy ?? uv.dFdy(),
              sharedRockNormal.strength,
            )
          : createCompactCotangentNormal(
              na.rgb,
              normalWorldGeometry,
              positionWorld.dFdx(),
              positionWorld.dFdy(),
              gradients?.dx ?? uv.dFdx(),
              gradients?.dy ?? uv.dFdy(),
              nearDetail.mul(normalStrength),
            ),
    };
  };
  const ground = (
    layer: "grass" | "dirt",
    repeats: number,
    normalStrength: number,
  ): CompactTerrainLayer => {
    const p = createCompactGroundProjections(
      vec2(positionWorld.x, positionWorld.z),
      patternNoise,
      repeats,
    );
    const a = project(layer, p.a.uv, normalStrength, p.a, "A");
    const b = project(layer, p.b.uv, normalStrength, p.b, "B");
    return {
      ...(a.height && b.height
        ? { height: mix(a.height, b.height, p.weight) }
        : {}),
      albedo: mix(a.albedo, b.albedo, p.weight),
      roughness: mix(a.roughness, b.roughness, p.weight),
      ao: mix(a.ao, b.ao, p.weight),
      worldNormal: normalize(mix(a.worldNormal, b.worldNormal, p.weight)),
    };
  };
  const stochasticDirt = (): CompactTerrainLayer => {
    const p = createCompactDirtProjections(
      vec2(positionWorld.x, positionWorld.z),
    );
    const a = project("dirt", p.a.uv, controls.dirtNormalStrength, p.a);
    const b = project("dirt", p.b.uv, controls.dirtNormalStrength, p.b);
    const c = project("dirt", p.c.uv, controls.dirtNormalStrength, p.c);
    return {
      ...(a.height && b.height && c.height
        ? {
            height: a.height
              .mul(p.weights.x)
              .add(b.height.mul(p.weights.y))
              .add(c.height.mul(p.weights.z)),
          }
        : {}),
      albedo: blendCompactDirtAlbedo(
        a.albedo,
        b.albedo,
        c.albedo,
        p.weights,
      ).toVar("compactStochasticDirtAlbedo"),
      roughness: a.roughness
        .mul(p.weights.x)
        .add(b.roughness.mul(p.weights.y))
        .add(c.roughness.mul(p.weights.z)),
      ao: a.ao
        .mul(p.weights.x)
        .add(b.ao.mul(p.weights.y))
        .add(c.ao.mul(p.weights.z)),
      worldNormal: normalize(
        a.worldNormal
          .mul(p.weights.x)
          .add(b.worldNormal.mul(p.weights.y))
          .add(c.worldNormal.mul(p.weights.z)),
      ),
    };
  };
  const weights = normalWorldGeometry.abs().pow(vec3(4));
  const normalizedWeights = weights.div(
    weights.x.add(weights.y).add(weights.z).max(1e-12),
  );
  const rock = (worldPlane: Node<"vec2">, axis: "X" | "Y" | "Z") => {
    if (textures.rockProjection) {
      const p = createCompactStochasticProjections(
        worldPlane,
        controls.repeatsPerMeter,
        controls.rockPatchEdgeMeters,
        worldPlane.dFdx(),
        worldPlane.dFdy(),
        { X: 0x173ab129, Y: 0x375cd103, Z: 0x529a4d27 }[axis],
      );
      const a = project("rock", p.a.uv, controls.rockNormalStrength, p.a);
      const b = project("rock", p.b.uv, controls.rockNormalStrength, p.b);
      const c = project("rock", p.c.uv, controls.rockNormalStrength, p.c);
      return {
        rawRockAo: a
          .rawRockAo!.mul(p.weights.x)
          .add(b.rawRockAo!.mul(p.weights.y))
          .add(c.rawRockAo!.mul(p.weights.z)),
        albedo: blendCompactStochasticAlbedo(
          a.albedo,
          b.albedo,
          c.albedo,
          p.weights,
          createCompactTerrainColorOperations().getPalette().rock,
        ).toVar(`compactStochasticRockAlbedo${axis}`),
        roughness: a.roughness
          .mul(p.weights.x)
          .add(b.roughness.mul(p.weights.y))
          .add(c.roughness.mul(p.weights.z)),
        ao: a.ao
          .mul(p.weights.x)
          .add(b.ao.mul(p.weights.y))
          .add(c.ao.mul(p.weights.z)),
        worldNormal: normalize(
          a.worldNormal
            .mul(p.weights.x)
            .add(b.worldNormal.mul(p.weights.y))
            .add(c.worldNormal.mul(p.weights.z)),
        ),
      };
    }
    // Reuse the exact ground transition: outgoing B == incoming A at every
    // band boundary. Derive screen gradients BEFORE discrete phase selection;
    // both packed maps and the cotangent frame use the same rotated gradients.
    // World anchoring and geometric weights also preserve negative-facing axes.
    const p = createCompactGroundProjections(
      worldPlane,
      patternNoise,
      controls.repeatsPerMeter,
    );
    const a = project("rock", p.a.uv, controls.rockNormalStrength, p.a);
    const b = project("rock", p.b.uv, controls.rockNormalStrength, p.b);
    return {
      rawRockAo: mix(a.rawRockAo!, b.rawRockAo!, p.weight),
      albedo: blendCompactRockAlbedo(a.albedo, b.albedo, p.weight).toVar(
        `compactRockAlbedo${axis}`,
      ),
      roughness: mix(a.roughness, b.roughness, p.weight),
      ao: mix(a.ao, b.ao, p.weight),
      worldNormal: normalize(mix(a.worldNormal, b.worldNormal, p.weight)),
    };
  };
  const sides = [
    rock(vec2(positionWorld.z, positionWorld.y), "X"),
    rock(vec2(positionWorld.x, positionWorld.z), "Y"),
    rock(vec2(positionWorld.x, positionWorld.y), "Z"),
  ];
  const blendVector = (
    a: Node<"vec3">,
    b: Node<"vec3">,
    c: Node<"vec3">,
  ): Node<"vec3"> =>
    a
      .mul(normalizedWeights.x)
      .add(b.mul(normalizedWeights.y))
      .add(c.mul(normalizedWeights.z));
  const blendScalar = (
    a: Node<"float">,
    b: Node<"float">,
    c: Node<"float">,
  ): Node<"float"> =>
    a
      .mul(normalizedWeights.x)
      .add(b.mul(normalizedWeights.y))
      .add(c.mul(normalizedWeights.z));
  return {
    grass: ground("grass", controls.grassRepeatsPerMeter, 1),
    dirt: textures.dirtProjection
      ? stochasticDirt()
      : ground(
          "dirt",
          controls.dirtRepeatsPerMeter,
          controls.dirtNormalStrength,
        ),
    rock: {
      rawRockAo: blendScalar(
        sides[0].rawRockAo,
        sides[1].rawRockAo,
        sides[2].rawRockAo,
      ).toVar("compactRawRockAo"),
      albedo: blendVector(sides[0].albedo, sides[1].albedo, sides[2].albedo),
      roughness: blendScalar(
        sides[0].roughness,
        sides[1].roughness,
        sides[2].roughness,
      ),
      ao: blendScalar(sides[0].ao, sides[1].ao, sides[2].ao),
      worldNormal: normalize(
        blendVector(
          sides[0].worldNormal,
          sides[1].worldNormal,
          sides[2].worldNormal,
        ),
      ),
    },
  };
}

/**
 * Height-sensitive grass/soil competition within the authored coverage.
 * Positive weights keep every partial shoulder partial, and equal heights
 * preserve its original coverage exactly. A subtract/max competition would
 * sharpen the path mask even with identical heights, producing cutout edges.
 * Relief is normalized source detail, not comparable absolute elevations.
 */
export function createCompactHeightSoilCoverage(
  coverage: Node<"float">,
  grassHeight: Node<"float">,
  soilHeight: Node<"float">,
): Node<"float"> {
  const c = COMPACT_TERRAIN_MATERIAL;
  const soil = coverage.clamp(0, 1);
  const grass = float(1).sub(soil);
  const grassWeight = grass.mul(
    grassHeight.clamp(0, 1).mul(c.heightInfluence).add(1),
  );
  const soilWeight = soil.mul(
    soilHeight.clamp(0, 1).mul(c.heightInfluence).add(1),
  );
  // Their sum is at least one, including pure endpoints and zero-height maps.
  return soilWeight.div(grassWeight.add(soilWeight));
}

/**
 * Strengthen centered relief odds of the CURRENT normalized grass/dry-soil
 * share. Heights are the existing paired, filtered material samples, not raw
 * authored coverage, wetness, albedo, or comparable absolute elevations.
 * At the source means the odds multiplier is one, preserving current coverage.
 * Clamping both heights bounds the exponent; every denominator stays positive
 * and pure-material endpoints remain pure without a threshold or hard cutout.
 */
export function createCompactPondReliefSoilCoverage(
  coverage: Node<"float">,
  grassHeight: Node<"float">,
  soilHeight: Node<"float">,
): Node<"float"> {
  const controls = COMPACT_TERRAIN_POND_RELIEF;
  const soil = coverage.clamp(0, 1);
  const delta = soilHeight
    .clamp(0, 1)
    .sub(controls.soilHeightMean)
    .sub(grassHeight.clamp(0, 1).sub(controls.grassHeightMean));
  const odds = delta
    .mul(controls.heightLog2Gain)
    .exp2()
    .toVar("compactPondReliefOdds");
  const weightedSoil = soil.mul(odds);
  return weightedSoil
    .div(float(1).sub(soil).add(weightedSoil))
    .toVar("compactPondReliefSoilCoverage");
}

/**
 * Appearance only: modify the grass/dry-soil budget AFTER generic height
 * blending and BEFORE the separate rock-to-soil sediment transfer. The actual
 * pond-soil mask defines contact locality but is never changed or fed back into
 * physical grass support. Rock/coastal weights and all texture lookups retain
 * their owners. The caller must reuse this final vector for every PBR channel.
 */
export function applyCompactPondReliefWeights(
  weights: Node<"vec4">,
  grassHeight: Node<"float">,
  soilHeight: Node<"float">,
  pondSoil: Node<"float">,
  road: Node<"float">,
  coastalCoverage: Node<"float">,
): Node<"vec4"> {
  const total = weights.x.add(weights.y).toVar("compactPondReliefGroundWeight");
  // Guard only an empty budget: epsilon flooring would distort tiny positive
  // budgets and could transfer more soil than the remaining grass can supply.
  const denominator = total.greaterThan(0).select(total, float(1));
  const coverage = weights.y
    .div(denominator)
    .clamp(0, 1)
    .toVar("compactPondReliefCurrentSoilCoverage");
  const adjusted = createCompactPondReliefSoilCoverage(
    coverage,
    grassHeight,
    soilHeight,
  );
  const pond = pondSoil.clamp(0, 1);
  const locality = pond
    .mul(float(1).sub(pond))
    .mul(4)
    .mul(float(1).sub(road.clamp(0, 1)))
    .mul(float(1).sub(coastalCoverage.clamp(0, 1)))
    .toVar("compactPondReliefLocality");
  // Equivalent to mixing coverage then multiplying by total, but zero locality
  // leaves the original channel values exact, avoiding a divide/multiply cycle.
  const transfer = adjusted
    .sub(coverage)
    .mul(locality)
    .mul(total)
    // Bound floating-point cancellation by the material actually available.
    .max(weights.y.negate())
    .min(weights.x)
    .toVar("compactPondReliefTransfer");
  return vec4(
    weights.x.sub(transfer),
    weights.y.add(transfer),
    weights.z,
    weights.w,
  ).toVar("compactPondReliefSurfaceWeights");
}

/** Frostbite-style material-mask detail, neutral at the admitted turf mean.
 * Uses the already sampled, aligned grass height; never inferred rock relief.
 * https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/chapter5-andersson-terrain-rendering-in-frostbite.pdf
 */
export function createCompactCoastDetailMask(
  grassHeight: Node<"float">,
): Node<"float"> {
  const controls = COMPACT_TERRAIN_COAST_DETAIL;
  return grassHeight
    .clamp(0, 1)
    .sub(controls.grassHeightMean)
    .mul(controls.detailGain)
    .add(0.5)
    .clamp(0, 1)
    .toVar("compactCoastDetailMask");
}

/**
 * Overlay detail only inside the current grass/rock-BRANCH budget. The
 * division-free transfer equals T * (overlay(grass/T, detail) - grass/T),
 * where T=grass+rock. It preserves pure endpoints and tiny/empty budgets.
 * Explicit dry/coastal soil weights stay unchanged, but the rock branch
 * already contains coast soil: its nested soil contribution changes too.
 * This appearance-only mask never changes grass roots, support or CPU colors;
 * unchanged ownership does NOT establish visual grass/ground agreement.
 */
export function applyCompactCoastDetailWeights(
  weights: Node<"vec4">,
  grassHeight: Node<"float">,
  coastalCoverage: Node<"float">,
  road: Node<"float">,
  pondRegion: Node<"float">,
): Node<"vec4"> {
  const detail = createCompactCoastDetailMask(grassHeight);
  const locality = coastalCoverage
    .clamp(0, 1)
    .mul(float(1).sub(road.clamp(0, 1)))
    .mul(float(1).sub(pondRegion.clamp(0, 1)))
    .toVar("compactCoastDetailLocality");
  const transfer = weights.x
    .min(weights.z)
    .mul(detail.mul(2).sub(1))
    .mul(locality)
    // Protect the available material budget from floating-point cancellation.
    .max(weights.x.negate())
    .min(weights.z)
    .toVar("compactCoastDetailTransfer");
  return vec4(
    weights.x.add(transfer),
    weights.y,
    weights.z.sub(transfer),
    weights.w,
  ).toVar("compactCoastDetailSurfaceWeights");
}

/** Source calibration from the admitted Rock Face03 packed alpha channel.
 * A cavity-guided material boundary, not height/displacement or new lighting.
 * Exact block mips tend to the mean; native quantization and stochastic mixing
 * still require moving-distance review. Endpoints bound the maximum bias.
 */
export const COMPACT_TERRAIN_COAST_CAVITY = Object.freeze({
  sourceSha256:
    "056c1754f2e2315a22480025ffe798497d6674fc76b05d8c7f42b3c928268aa4",
  rawAoMean: 0.9150973263908835,
  cavityGain: 2.4,
  maximumBias: 0.2,
  transitionStart: 0.22,
  transitionEnd: 0.78,
  coastCoverageFull: 0.25,
});

/** Exclude the COMPLETE existing pond footprint, including its radial fade. */
export function createCompactCoastCavityPondClearance(
  world: Node<"vec3">,
  pond: Node<"vec4"> | null,
): Node<"float"> {
  if (!pond) return float(1);
  const delta = vec2(world.x.sub(pond.x), world.z.sub(pond.y));
  const inner = pond.z.add(COMPACT_TERRAIN_COMPOSITION.pondBankReach);
  const outer = inner.add(COMPACT_TERRAIN_COMPOSITION.pondRadialFade);
  return smoothstep(inner.mul(inner), outer.mul(outer), delta.dot(delta));
}

/** Narrow the mixed turf/rock shoulder using source-aligned cavity detail.
 * Explicit soil weights are unchanged. The rock branch may already include
 * coastal soil; its nested contribution follows the same coherent transfer.
 * Pure materials, full roads, pond footprint and zero coastal locality remain
 * exact. This changes appearance, not CPU root placement or physical terrain.
 */
export function applyCompactCoastCavityWeights(
  weights: Node<"vec4">,
  rawRockAo: Node<"float">,
  coastalCoverage: Node<"float">,
  road: Node<"float">,
  pondClearance: Node<"float">,
): Node<"vec4"> {
  const c = COMPACT_TERRAIN_COAST_CAVITY;
  const total = weights.x.add(weights.z).toVar("compactCavityPairBudget");
  const denominator = total.greaterThan(0).select(total, float(1));
  const share = weights.x.div(denominator);
  const bias = float(c.rawAoMean)
    .sub(rawRockAo.clamp(0, 1))
    .mul(c.cavityGain)
    .clamp(-c.maximumBias, c.maximumBias);
  const adjusted = smoothstep(
    float(c.transitionStart),
    float(c.transitionEnd),
    share.add(bias),
  );
  const locality = coastalCoverage
    .div(c.coastCoverageFull)
    .clamp(0, 1)
    .mul(float(1).sub(road.clamp(0, 1)))
    .mul(pondClearance.clamp(0, 1));
  const transfer = adjusted
    .sub(share)
    .mul(total)
    .mul(locality)
    .max(weights.x.negate())
    .min(weights.z)
    .toVar("compactCoastCavityTransfer");
  return vec4(
    weights.x.add(transfer),
    weights.y,
    weights.z.sub(transfer),
    weights.w,
  ).toVar("compactCoastCavitySurfaceWeights");
}

/** Shared distribution changes material coverage, not texture values or ground.
 * Only existing grass is reassigned; steep banks retain their existing rock.
 * The caller reuses the resulting vector across every PBR channel. */
const compactCoastDistributionMath: CompactCoastDistributionMath<
  Node<"float">
> = {
  constant: (value) => float(value),
  add: (a, b) => a.add(b),
  sub: (a, b) => a.sub(b),
  mul: (a, b) => a.mul(b),
  div: (a, b) => a.div(b),
  min: (a, b) => a.min(b),
  max: (a, b) => a.max(b),
  clamp: (value, low, high) => value.clamp(low, high),
  smoothstep: (low, high, value) => smoothstep(low, high, value),
};

const compactPondBankMath: CompactPondBankMath<Node<"float">> = {
  ...compactCoastDistributionMath,
  sqrt: (value) => value.sqrt(),
  abs: (value) => value.abs(),
  sin: (value) => value.sin(),
  // atan2(0,0) has no portable shader accuracy guarantee. Its angle is irrelevant
  // inside the zero-support bed; give that exact point a finite direction.
  atan2: (y, x) =>
    atan(y, x.abs().add(y.abs()).greaterThan(0).select(x, float(1))),
};

/** Actual bank knots/overlap own both this graph and CPU root appearance. */
export function createCompactPondBankComposition(
  input: CompactPondBankCompositionInput<Node<"float">>,
): CompactPondBankComposition<Node<"float">> {
  const result = createCompactTerrainColorOperations().bankComposition(
    { ...input, includeAppearance: true },
    compactPondBankMath,
  );
  return {
    soilToGrass: result.soilToGrass.toVar("compactPondBankSoilToGrass"),
    soilToRock: result.soilToRock.toVar("compactPondBankSoilToRock"),
    ...(result.mineralSoilToRock !== undefined
      ? {
          mineralSoilToRock: result.mineralSoilToRock.toVar(
            "compactPondBankMineralSoilToRock",
          ),
        }
      : {}),
    ...(result.substrateSoilToRock !== undefined
      ? {
          substrateSoilToRock: result.substrateSoilToRock.toVar(
            "compactPondBankSubstrateSoilToRock",
          ),
        }
      : {}),
    ...(result.mineralAppearance !== undefined
      ? {
          mineralAppearance: result.mineralAppearance.toVar(
            "compactPondBankMineralAppearance",
          ),
        }
      : {}),
    ...(result.siltAppearance !== undefined
      ? {
          siltAppearance: result.siltAppearance.toVar(
            "compactPondBankSiltAppearance",
          ),
        }
      : {}),
    grassToSoil: result.grassToSoil.toVar("compactPondBankGrassToSoil"),
    grassToRock: result.grassToRock.toVar("compactPondBankGrassToRock"),
    grassShade: result.grassShade.toVar("compactPondBankGrassShade"),
    groundCoverWeight: result.groundCoverWeight.toVar(
      "compactPondBankGroundCoverWeight",
    ),
    groundCoverGrassShare: result.groundCoverGrassShare.toVar(
      "compactPondBankGroundCoverGrassShare",
    ),
  };
}

export function applyCompactPondBankCompositionWeights(
  weights: Node<"vec4">,
  composition: CompactPondBankComposition<Node<"float">>,
): Node<"vec4"> {
  return vec4(
    ...createCompactTerrainColorOperations().bankCompositionWeights(
      [weights.x, weights.y, weights.z, weights.w],
      composition,
      compactCoastDistributionMath,
    ),
  ).toVar("compactPondBankSurfaceWeights");
}

export function applyCompactPondBankGrass(
  grass: CompactTerrainLayer,
  composition: CompactPondBankComposition<Node<"float">>,
): CompactTerrainLayer {
  return { ...grass, albedo: grass.albedo.mul(composition.grassShade) };
}

/** One world-anchored bank recipe also used by CPU roots and the real worker.
 * Reuses existing noise samples; no camera input, extra map or terrain edit. */
export function createCompactPondMargin(
  input: CompactPondMarginInput<Node<"float">>,
): CompactPondMargin<Node<"float">> {
  const margin = createCompactTerrainColorOperations().pondMargin(
    input,
    compactCoastDistributionMath,
  );
  return {
    cover: margin.cover.toVar("compactPondMarginCover"),
    exposure: margin.exposure.toVar("compactPondMarginExposure"),
    shade: margin.shade.toVar("compactPondMarginShade"),
    clumpScale: margin.clumpScale.toVar("compactPondMarginClumpScale"),
  };
}

/** Local turf reflectance, not baked light or an alteration to soil/wetness. */
export function applyCompactPondMarginGrass(
  grass: CompactTerrainLayer,
  margin: CompactPondMargin<Node<"float">>,
): CompactTerrainLayer {
  return { ...grass, albedo: grass.albedo.mul(margin.shade) };
}

export function createCompactCoastDistribution(
  input: CompactCoastDistributionInput<Node<"float">>,
): CompactCoastDistribution<Node<"float">> {
  const result = createCompactTerrainColorOperations().coastalDistribution(
    input,
    compactCoastDistributionMath,
  );
  return {
    turfRetention: result.turfRetention.toVar("compactCoastTurfRetention"),
    bedrockShare: result.bedrockShare.toVar("compactCoastBedrockShare"),
  };
}

export function applyCompactCoastDistributionWeights(
  weights: Node<"vec4">,
  distribution: CompactCoastDistribution<Node<"float">>,
): Node<"vec4"> {
  const result =
    createCompactTerrainColorOperations().coastalDistributionWeights(
      [weights.x, weights.y, weights.z, weights.w],
      distribution,
      compactCoastDistributionMath,
    );
  return vec4(...result).toVar("compactCoastDistributionSurfaceWeights");
}

/** Resolve coverage once so albedo, roughness, AO and normals agree. */
function createCompactHeightSurfaceWeights(
  grassHeight: Node<"float">,
  soilHeight: Node<"float">,
  dirt: Node<"float">,
  cliff: Node<"float">,
  road: Node<"float">,
  havenGround?: { talus: Node<"float">; wear: Node<"float"> },
  habitatSoil?: Node<"float">,
  coastalCoverage?: Node<"float">,
  wornTurfSoil?: Node<"float">,
): Node<"vec4"> {
  // Components are grass, dry soil, rock, and coastal wet soil respectively.
  const soil = vec4(0, 1, 0, 0);
  let weights = mix(vec4(1, 0, 0, 0), soil, dirt);
  if (wornTurfSoil) weights = mix(weights, soil, wornTurfSoil);
  if (havenGround) {
    const rock = COMPACT_TERRAIN_COMPOSITION.havenTalusRockFraction;
    weights = mix(weights, vec4(0, 1 - rock, rock, 0), havenGround.talus);
    weights = mix(weights, soil, havenGround.wear);
  }
  if (habitatSoil) weights = mix(weights, soil, habitatSoil);
  if (coastalCoverage)
    weights = mix(weights, vec4(0, 0, 0, 1), coastalCoverage);
  weights = mix(mix(weights, vec4(0, 0, 1, 0), cliff), soil, road).toVar(
    "compactAuthoredSurfaceWeights",
  );
  const soilWeight = weights.y
    .add(weights.w)
    .toVar("compactAuthoredSoilWeight");
  const groundWeight = weights.x
    .add(soilWeight)
    .toVar("compactAuthoredGroundWeight");
  const adjustedSoil = createCompactHeightSoilCoverage(
    soilWeight.div(groundWeight.max(1e-12)),
    grassHeight,
    soilHeight,
  )
    .mul(groundWeight)
    .toVar("compactHeightSoilWeight");
  const coastalShare = weights.w
    .div(soilWeight.max(1e-12))
    .toVar("compactCoastalSoilShare");
  return vec4(
    groundWeight.sub(adjustedSoil),
    adjustedSoil.mul(float(1).sub(coastalShare)),
    weights.z,
    adjustedSoil.mul(coastalShare),
  ).toVar("compactHeightSurfaceWeights");
}

export function blendCompactTerrainLayers(
  layers: Record<Layer, CompactTerrainLayer>,
  dirt: Node<"float">,
  cliff: Node<"float">,
  road: Node<"float">,
  havenGround?: { talus: Node<"float">; wear: Node<"float"> },
  habitatSoil?: Node<"float">,
  coastalGround?: { coverage: Node<"float">; layer: CompactTerrainLayer },
  wornTurfSoil?: Node<"float">,
  pondSediment?: Node<"float">,
  pondReliefSoil?: Node<"float">,
  pondRockContact?: Node<"float">,
  coastDetail?: { coverage: Node<"float">; pondRegion: Node<"float"> },
  coastDistribution?: CompactCoastDistribution<Node<"float">>,
  coastCavity?: { coverage: Node<"float">; pondClearance: Node<"float"> },
  pondBankComposition?: CompactPondBankComposition<Node<"float">>,
): {
  albedo: Node<"vec3">;
  roughness: Node<"float">;
  ao: Node<"float">;
  normal: Node<"vec3">;
  weights?: Node<"vec4">;
} {
  if (pondBankComposition && (!layers.grass.height || !layers.dirt.height))
    throw new Error("Pond bank composition requires admitted height layers");
  if (layers.grass.height && layers.dirt.height) {
    let weights = createCompactHeightSurfaceWeights(
      layers.grass.height,
      layers.dirt.height,
      dirt,
      cliff,
      road,
      havenGround,
      habitatSoil,
      coastalGround?.coverage,
      wornTurfSoil,
    );
    if (pondReliefSoil) {
      weights = applyCompactPondReliefWeights(
        weights,
        layers.grass.height,
        layers.dirt.height,
        pondReliefSoil,
        road,
        coastalGround?.coverage ?? float(0),
      );
    }
    if (pondSediment) {
      // Resolve height competition first, then transfer only existing rock
      // weight to the existing dry soil. Grass and coastal-soil weights remain
      // bit-for-bit the same inputs; all four PBR channels share this result.
      const transfer = weights.z
        .mul(pondSediment.clamp(0, 1))
        .toVar("compactPondSedimentTransfer");
      weights = vec4(
        weights.x,
        weights.y.add(transfer),
        weights.z.sub(transfer),
        weights.w,
      ).toVar("compactPondSedimentSurfaceWeights");
    }
    if (pondRockContact)
      weights = applyCompactPondRockContactWeights(weights, pondRockContact);
    if (coastDetail)
      weights = applyCompactCoastDetailWeights(
        weights,
        layers.grass.height,
        coastDetail.coverage,
        road,
        coastDetail.pondRegion,
      );
    if (coastDistribution)
      weights = applyCompactCoastDistributionWeights(
        weights,
        coastDistribution,
      );
    if (coastCavity) {
      if (!layers.rock.rawRockAo)
        throw new Error("Coast cavity requires aligned raw rock AO");
      weights = applyCompactCoastCavityWeights(
        weights,
        layers.rock.rawRockAo,
        coastCavity.coverage,
        road,
        coastCavity.pondClearance,
      );
    }
    if (pondBankComposition)
      weights = applyCompactPondBankCompositionWeights(
        weights,
        pondBankComposition,
      );
    const blendVector = (
      grass: Node<"vec3">,
      soil: Node<"vec3">,
      rock: Node<"vec3">,
      coastal: Node<"vec3"> = soil,
    ) =>
      grass
        .mul(weights.x)
        .add(soil.mul(weights.y))
        .add(rock.mul(weights.z))
        .add(coastal.mul(weights.w));
    const blendScalar = (
      grass: Node<"float">,
      soil: Node<"float">,
      rock: Node<"float">,
      coastal: Node<"float"> = soil,
    ) =>
      grass
        .mul(weights.x)
        .add(soil.mul(weights.y))
        .add(rock.mul(weights.z))
        .add(coastal.mul(weights.w));
    return {
      weights,
      albedo: blendVector(
        layers.grass.albedo,
        layers.dirt.albedo,
        layers.rock.albedo,
        coastalGround?.layer.albedo,
      ),
      roughness: blendScalar(
        layers.grass.roughness,
        layers.dirt.roughness,
        layers.rock.roughness,
        coastalGround?.layer.roughness,
      ),
      ao: blendScalar(
        layers.grass.ao,
        layers.dirt.ao,
        layers.rock.ao,
        coastalGround?.layer.ao,
      ),
      normal: compactTerrainNormalToView(
        blendVector(
          layers.grass.worldNormal,
          layers.dirt.worldNormal,
          layers.rock.worldNormal,
          coastalGround?.layer.worldNormal,
        ),
      ),
    };
  }
  const blendVector = (
    grass: Node<"vec3">,
    ground: Node<"vec3">,
    rock: Node<"vec3">,
    coastal?: Node<"vec3">,
  ): Node<"vec3"> => {
    let meadow = mix(grass, ground, dirt);
    if (wornTurfSoil) meadow = mix(meadow, ground, wornTurfSoil);
    if (havenGround) {
      meadow = mix(
        meadow,
        mix(
          ground,
          rock,
          float(COMPACT_TERRAIN_COMPOSITION.havenTalusRockFraction),
        ),
        havenGround.talus,
      );
      meadow = mix(meadow, ground, havenGround.wear);
    }
    if (habitatSoil) meadow = mix(meadow, ground, habitatSoil);
    if (coastalGround && coastal)
      meadow = mix(meadow, coastal, coastalGround.coverage);
    return mix(mix(meadow, rock, cliff), ground, road);
  };
  const blendScalar = (
    grass: Node<"float">,
    ground: Node<"float">,
    rock: Node<"float">,
    coastal?: Node<"float">,
  ): Node<"float"> => {
    let meadow = mix(grass, ground, dirt);
    if (wornTurfSoil) meadow = mix(meadow, ground, wornTurfSoil);
    if (havenGround) {
      meadow = mix(
        meadow,
        mix(
          ground,
          rock,
          float(COMPACT_TERRAIN_COMPOSITION.havenTalusRockFraction),
        ),
        havenGround.talus,
      );
      meadow = mix(meadow, ground, havenGround.wear);
    }
    if (habitatSoil) meadow = mix(meadow, ground, habitatSoil);
    if (coastalGround && coastal)
      meadow = mix(meadow, coastal, coastalGround.coverage);
    return mix(mix(meadow, rock, cliff), ground, road);
  };
  return {
    albedo: blendVector(
      layers.grass.albedo,
      layers.dirt.albedo,
      layers.rock.albedo,
      coastalGround?.layer.albedo,
    ),
    roughness: blendScalar(
      layers.grass.roughness,
      layers.dirt.roughness,
      layers.rock.roughness,
      coastalGround?.layer.roughness,
    ),
    ao: blendScalar(
      layers.grass.ao,
      layers.dirt.ao,
      layers.rock.ao,
      coastalGround?.layer.ao,
    ),
    normal: compactTerrainNormalToView(
      blendVector(
        layers.grass.worldNormal,
        layers.dirt.worldNormal,
        layers.rock.worldNormal,
        coastalGround?.layer.worldNormal,
      ),
    ),
  };
}

/**
 * Called only by an explicit per-material diagnostic request. These outputs
 * reference the actual composition nodes; they never rebuild approximation
 * masks or enter the ordinary output graph. Diagnostic rendering retains the
 * material's PBR work and must not be used as a terrain performance measure.
 */
export function createCompactTerrainDiagnosticOutputs(
  sources: CompactTerrainDiagnosticSources,
): CompactTerrainDiagnosticOutputs {
  const { weights, coastSoil, pondSoil, pondWetness, geometricCliff } = sources;
  const rockSoil = weights.z.mul(coastSoil);
  return Object.freeze({
    schemaVersion: 1,
    layerWeights: vec4(
      weights.z.mul(float(1).sub(coastSoil)),
      weights.x,
      weights.y.add(weights.w).add(rockSoil),
      1,
    ).toVar("compactDiagnosticMaterialCoverage"),
    causes: vec4(pondSoil, pondWetness, geometricCliff, 1).toVar(
      "compactDiagnosticPondCauses",
    ),
    sources: Object.freeze({ ...sources }),
  });
}

/** Matrix-first TSL multiplication converts world normals into view space. */
export function compactTerrainNormalToView(
  worldNormal: Node<"vec3">,
  viewMatrix: Node<"mat4"> = cameraViewMatrix,
): Node<"vec3"> {
  // Vector-first transformDirection uses the inverse camera rotation; it can
  // turn upward terrain normals away from the light in a steep overhead view.
  return viewMatrix.mul(vec4(normalize(worldNormal), 0)).xyz.normalize();
}
