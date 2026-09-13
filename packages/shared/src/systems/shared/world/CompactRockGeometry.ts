import THREE from "../../../extras/three/three";
import type { CompactRockVariant } from "./CompactRockOutcropVisuals";

export const COMPACT_ROCK_SOURCE_SHA256 =
  "62c8c753c57b7108f79c98ee0f1bbb2497c27e3fe55a15979765fa02da184c55";

/** Lazy, geometry-only exact near-mesh derivative. No server image decoding or
 * extra texture copy; three caller-owned geometries are shared across colliders.
 */
export async function createCompactRockCollisionGeometry(): Promise<
  ReadonlyMap<CompactRockVariant, THREE.BufferGeometry>
> {
  const { default: data } =
    await import("../../../data/compact-rock-collision-v1.json");
  if (
    data.schemaVersion !== 1 ||
    data.sourceSha256 !== COMPACT_ROCK_SOURCE_SHA256 ||
    data.format !== "float32-position-uint16-index-le-base64" ||
    data.meshes.length !== 3
  )
    throw new Error("Invalid compact rock collision library");
  const owned = new Map<CompactRockVariant, THREE.BufferGeometry>();
  try {
    for (const [i, variant] of (
      ["rock10", "rock11", "rock13"] as const
    ).entries()) {
      const row = data.meshes[i];
      if (
        row.variant !== variant ||
        row.positions.count < 3 ||
        row.positions.count > 20000 ||
        row.indices.count !== (variant === "rock13" ? 7928 : 8000) * 3 ||
        row.translation.length !== 3 ||
        !row.translation.every(Number.isFinite)
      )
        throw new Error("Invalid compact rock collision counts or transform");
      const decode = (value: string, bytes: number) => {
        if (value.length > 500000)
          throw new Error("Rock collision byte budget exceeded");
        const result = Uint8Array.from(atob(value), (char) =>
          char.charCodeAt(0),
        );
        if (result.byteLength !== bytes)
          throw new Error("Rock collision byte length mismatch");
        return result.buffer;
      };
      const positions = new Float32Array(
        decode(row.positions.data, row.positions.count * 12),
      );
      const indices = new Uint16Array(
        decode(row.indices.data, row.indices.count * 2),
      );
      if (
        !positions.every(Number.isFinite) ||
        indices.some((index) => index >= row.positions.count)
      )
        throw new Error("Invalid compact rock collision vertices or indices");
      const geometry = new THREE.BufferGeometry();
      owned.set(variant, geometry);
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(positions, 3),
      );
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      geometry.translate(
        row.translation[0],
        row.translation[1],
        row.translation[2],
      );
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
    return owned;
  } catch (error) {
    for (const geometry of owned.values()) geometry.dispose();
    throw error;
  }
}
