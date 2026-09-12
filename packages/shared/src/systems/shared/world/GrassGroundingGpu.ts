import THREE from "../../../extras/three/three";
import {
  instanceIndex,
  vertexIndex,
  storage,
  uint,
  mix,
  uv,
  vec3,
} from "three/tsl";
import { MeshStandardNodeMaterial, StorageBufferAttribute } from "three/webgpu";
import type Node from "three/src/nodes/core/Node.js";
import type { GrassBladeGroundingResult } from "./GrassBladeGrounding";

export const GRASS_ROOT_STORAGE_ATTRIBUTE = "grassRootDeltas";

const TIERS = [
  { blades: 24, vertices: 7 },
  { blades: 12, vertices: 5 },
  { blades: 4, vertices: 3 },
] as const;

/** One chunk's correction binding. Shared material nodes/uniforms/maps stay
 * borrowed. Geometry owns the storage buffer's native lifetime, not material. */
export function createGroundedGrassMaterial(
  base: MeshStandardNodeMaterial,
  geometry: THREE.BufferGeometry,
  rootDeltas: Float32Array,
  count: number,
  lod: number,
): MeshStandardNodeMaterial {
  const tier = TIERS[lod];
  if (
    !tier ||
    !base.positionNode ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 4096 ||
    !(rootDeltas instanceof Float32Array) ||
    rootDeltas.length !== count * tier.blades * 2 ||
    geometry.getAttribute("position")?.count !== tier.blades * tier.vertices ||
    geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)
  )
    throw new Error("Invalid grounded grass binding");
  // The complete pipeline validates these before this bounded GPU publication.
  // Explicit vec2 and zero count keep one runtime-array shader for every chunk.
  const buffer = new StorageBufferAttribute(rootDeltas, 2);
  const roots = storage(buffer, "vec2", 0).toReadOnly();
  const address = instanceIndex
    .mul(uint(tier.blades))
    .add(vertexIndex.div(uint(tier.vertices)));
  const delta = roots.element(address);
  const material = base.clone();
  // NodeMaterial's public declaration erases the position slot's vector type.
  const basePosition = base.positionNode as Node<"vec3">;
  material.positionNode = vec3(basePosition).add(
    vec3(0, mix(delta.x, delta.y, uv().x), 0),
  );
  // Not used as a vertex attribute in the shader. This registration lets
  // r186 Geometries dispose the actual storage allocation with the chunk.
  geometry.setAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE, buffer);
  return material;
}

/** Existing shader transforms are chunk-local XZ + world Y. Numeric padding
 * makes culling conservative; it is not evidence of GPU contact accuracy. */
export function groundedGrassWorldBox(
  result: Extract<GrassBladeGroundingResult, { status: "ready" }>,
): THREE.Box3 {
  const b = result.sweptBounds;
  if (!b || !result.data.count)
    throw new Error("Missing accepted grass bounds");
  if (
    !Object.values(b).every(Number.isFinite) ||
    b.minX > b.maxX ||
    b.minY > b.maxY ||
    b.minZ > b.maxZ
  )
    throw new Error("Invalid accepted grass bounds");
  const padding = Math.max(
    0.001,
    ...Object.values(b).map((value) => Math.abs(value) * 2 ** -20),
  );
  return new THREE.Box3(
    new THREE.Vector3(b.minX, b.minY, b.minZ),
    new THREE.Vector3(b.maxX, b.maxY, b.maxZ),
  ).expandByScalar(padding);
}
