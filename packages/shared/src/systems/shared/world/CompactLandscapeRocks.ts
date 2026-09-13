import THREE from "../../../extras/three/three";
import { canonicalWorldJson } from "../../../data/WorldContentIdentity";
import type { CompactLandscapeRocksManifest } from "../../../types/world/world-types";
import type { WorldTerrainProfile } from "./WorldTerrainProfile";
import { COMPACT_ROCK_SOURCE_SHA256 } from "./CompactRockGeometry";
import type {
  CompactRockPlacement,
  CompactRockVariant,
} from "./CompactRockOutcropVisuals";

type Point = Readonly<{ x: number; z: number }>;
export type GroundedLandscapeRocks = Readonly<{
  descriptor: CompactLandscapeRocksManifest;
  placements: readonly CompactRockPlacement[];
  blockingTiles: readonly Point[];
  support: readonly Readonly<{
    id: string;
    samples: number;
    minimum: number;
    maximum: number;
    buriedBandTop: number;
    bounds: Readonly<{
      minX: number;
      maxX: number;
      minZ: number;
      maxZ: number;
    }>;
  }>[];
}>;

export function validateCompactLandscapeRocks(
  input: unknown,
  profile: WorldTerrainProfile,
): CompactLandscapeRocksManifest | undefined {
  if (input === undefined) return undefined;
  const value = JSON.parse(
    canonicalWorldJson(input),
  ) as CompactLandscapeRocksManifest;
  const keys = (object: object, expected: string[]) =>
    Object.keys(object).sort().join() === expected.sort().join();
  if (
    !value ||
    !keys(value, [
      "schemaVersion",
      "layoutId",
      "terrainProfileId",
      "sourceSha256",
      "rocks",
    ]) ||
    value.schemaVersion !== 1 ||
    value.layoutId !== "compact-preparation-rocks-v1" ||
    value.terrainProfileId !== "compact-duel-island-v6" ||
    profile.id !== value.terrainProfileId ||
    profile.algorithm !== "compact-island-sculpt-v5" ||
    value.sourceSha256 !== COMPACT_ROCK_SOURCE_SHA256 ||
    !Array.isArray(value.rocks) ||
    value.rocks.length < 1 ||
    value.rocks.length > 24
  )
    throw new Error("Invalid compact landscape rock manifest");
  const ids = new Set<string>();
  for (const p of value.rocks) {
    if (
      !p ||
      !keys(p, ["id", "variant", "x", "z", "yaw", "scale"]) ||
      typeof p.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,47}$/.test(p.id) ||
      ids.has(p.id) ||
      !["rock10", "rock11", "rock13"].includes(p.variant) ||
      ![p.x, p.z, p.yaw, p.scale].every(Number.isFinite) ||
      p.yaw < 0 ||
      p.yaw >= Math.PI * 2 ||
      p.scale < 0.5 ||
      p.scale > 1.5 ||
      !(
        (p.x >= 330 && p.x <= 355 && p.z >= 290 && p.z <= 303) ||
        (p.x >= 323 && p.x <= 330 && p.z >= 326 && p.z <= 333)
      )
    )
      throw new Error("Invalid compact landscape rock placement");
    ids.add(p.id);
    Object.freeze(p);
  }
  Object.freeze(value.rocks);
  return Object.freeze(value);
}

const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
/** Conservative projected silhouette, not a radius/bounding-box collider. */
function hull(points: Point[]): Point[] {
  points.sort((a, b) => a.x - b.x || a.z - b.z);
  const chain = (rows: Point[]) => {
    const result: Point[] = [];
    for (const p of rows) {
      while (
        result.length >= 2 &&
        cross(result.at(-2)!, result.at(-1)!, p) <= 0
      )
        result.pop();
      result.push(p);
    }
    result.pop();
    return result;
  };
  return [...chain(points), ...chain([...points].reverse())];
}
function clip(
  polygon: Point[],
  axis: "x" | "z",
  limit: number,
  sign: number,
): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length],
      da = (a[axis] - limit) * sign,
      db = (b[axis] - limit) * sign;
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      out.push({ x: a.x + t * (b.x - a.x), z: a.z + t * (b.z - a.z) });
    }
  }
  return out;
}

/** Shared startup datum and nav occupancy. The lower 20% band is embedded under
 * a bounded 20cm authoritative-height lattice with 8cm additional burial. This
 * is conservative sampled grounding, not a proof of all continuous terrain or
 * installed visual triangles; native full-footprint contact must qualify it.
 */
export function groundCompactLandscapeRocks(
  descriptor: CompactLandscapeRocksManifest,
  geometry: ReadonlyMap<CompactRockVariant, THREE.BufferGeometry>,
  heightAt: (x: number, z: number) => number,
): GroundedLandscapeRocks {
  const silhouettes = new Map<CompactRockVariant, Point[]>();
  for (const [variant, g] of geometry) {
    const positions = g.getAttribute("position");
    silhouettes.set(
      variant,
      hull(
        Array.from({ length: positions.count }, (_, i) => ({
          x: positions.getX(i),
          z: positions.getZ(i),
        })),
      ),
    );
  }
  const tiles = new Map<string, Point>(),
    support: GroundedLandscapeRocks["support"][number][] = [];
  const placements = descriptor.rocks.map((p) => {
    const box = geometry.get(p.variant)?.boundingBox,
      outline = silhouettes.get(p.variant);
    if (!box || !outline?.length)
      throw new Error("Missing exact rock geometry support");
    const c = Math.cos(p.yaw) * p.scale,
      s = Math.sin(p.yaw) * p.scale;
    const polygon = outline.map((v) => ({
      x: p.x + c * v.x + s * v.z,
      z: p.z - s * v.x + c * v.z,
    }));
    const bounds = {
      minX: Math.min(...polygon.map((v) => v.x)),
      maxX: Math.max(...polygon.map((v) => v.x)),
      minZ: Math.min(...polygon.map((v) => v.z)),
      maxZ: Math.max(...polygon.map((v) => v.z)),
    };
    const nx = Math.ceil((bounds.maxX - bounds.minX) / 0.2),
      nz = Math.ceil((bounds.maxZ - bounds.minZ) / 0.2);
    if (nx < 1 || nz < 1 || (nx + 1) * (nz + 1) > 1024)
      throw new Error("Rock grounding work budget exceeded");
    let minimum = Infinity,
      maximum = -Infinity,
      samples = 0;
    for (let iz = 0; iz <= nz; iz++)
      for (let ix = 0; ix <= nx; ix++) {
        const h = heightAt(
          bounds.minX + ((bounds.maxX - bounds.minX) * ix) / nx,
          bounds.minZ + ((bounds.maxZ - bounds.minZ) * iz) / nz,
        );
        if (!Number.isFinite(h))
          throw new Error("Rock terrain support is not finite");
        minimum = Math.min(minimum, h);
        maximum = Math.max(maximum, h);
        samples++;
      }
    if (maximum - minimum > 1.5)
      throw new Error("Rock placement exceeds supported terrain relief");
    const bandTop = (box.min.y + (box.max.y - box.min.y) * 0.2) * p.scale;
    const y = minimum - bandTop - 0.08;
    if (y + box.max.y * p.scale < maximum + 0.15)
      throw new Error("Rock is excessively buried by its terrain placement");
    for (let z = Math.floor(bounds.minZ); z <= Math.floor(bounds.maxZ); z++)
      for (let x = Math.floor(bounds.minX); x <= Math.floor(bounds.maxX); x++) {
        let clipped = clip(polygon, "x", x, 1);
        clipped = clip(clipped, "x", x + 1, -1);
        clipped = clip(clipped, "z", z, 1);
        clipped = clip(clipped, "z", z + 1, -1);
        const area =
          Math.abs(
            clipped.reduce((a, v, i) => {
              const n = clipped[(i + 1) % clipped.length];
              return a + v.x * n.z - n.x * v.z;
            }, 0),
          ) / 2;
        if (area > 1e-6) tiles.set(`${x},${z}`, Object.freeze({ x, z }));
      }
    support.push(
      Object.freeze({
        id: p.id,
        samples,
        minimum,
        maximum,
        buriedBandTop: y + bandTop,
        bounds: Object.freeze(bounds),
      }),
    );
    return Object.freeze({ ...p, y });
  });
  if (tiles.size > 256)
    throw new Error("Rock navigation footprint budget exceeded");
  return Object.freeze({
    descriptor,
    placements: Object.freeze(placements),
    support: Object.freeze(support),
    blockingTiles: Object.freeze(
      [...tiles.values()].sort((a, b) => a.z - b.z || a.x - b.x),
    ),
  });
}
