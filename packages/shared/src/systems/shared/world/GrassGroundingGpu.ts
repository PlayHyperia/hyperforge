import THREE from "../../../extras/three/three";
import {
  instanceIndex,
  vertexIndex,
  storage,
  uint,
  mix,
  uv,
  vec3,
  attribute,
} from "three/tsl";
import { MeshStandardNodeMaterial, StorageBufferAttribute } from "three/webgpu";
import type Node from "three/src/nodes/core/Node.js";
import type { GrassBladeGroundingResult } from "./GrassBladeGrounding";
import {
  getGrassBladeLayout,
  type FineGrassGeometryLayout,
} from "./GrassBladeLayout";

export const GRASS_ROOT_STORAGE_ATTRIBUTE = "grassRootDeltas";
export const GRASS_BLADE_VISIBILITY_ATTRIBUTE = "grassBladeVisibility";

/** One chunk's correction binding. Shared material nodes/uniforms/maps stay
 * borrowed. Geometry owns the storage buffer's native lifetime, not material. */
export function createGroundedGrassMaterial(
  base: MeshStandardNodeMaterial,
  geometry: THREE.BufferGeometry,
  rootDeltas: Float32Array,
  count: number,
  lod: number,
  geometryLayout?: FineGrassGeometryLayout,
  bladeVisibility?: Uint32Array,
): MeshStandardNodeMaterial {
  const tier = getGrassBladeLayout(lod, geometryLayout);
  if (
    !base.positionNode ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 4096 ||
    !(rootDeltas instanceof Float32Array) ||
    rootDeltas.length !== count * tier.bladesPerClump * tier.rootComponents ||
    geometry.getAttribute("position")?.count !== tier.verticesPerClump ||
    geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)
  )
    throw new Error("Invalid grounded grass binding");
  if (bladeVisibility !== undefined) {
    const offset = geometry.getAttribute("instanceOffset");
    const validBits = 2 ** tier.bladesPerClump - 1;
    if (
      !(bladeVisibility instanceof Uint32Array) ||
      bladeVisibility.length !== count ||
      bladeVisibility.some((mask) => mask === 0 || mask > validBits) ||
      geometry.hasAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE) ||
      !(offset instanceof THREE.InstancedBufferAttribute) ||
      !(offset.array instanceof Float32Array) ||
      offset.itemSize !== 3 ||
      offset.count !== count ||
      offset.normalized ||
      offset.meshPerAttribute !== 1 ||
      offset.array.some((value) => !Number.isFinite(value))
    )
      throw new Error("Invalid grounded grass blade visibility binding");
  }
  // The complete pipeline validates these before this bounded GPU publication.
  // Explicit vec2 and zero count keep one runtime-array shader for every chunk.
  const buffer = new StorageBufferAttribute(rootDeltas, 2);
  const roots = storage(buffer, "vec2", 0).toReadOnly();
  const address = instanceIndex
    .mul(uint(tier.bladesPerClump))
    .add(vertexIndex.div(uint(tier.verticesPerBlade)));
  const delta = roots.element(address);
  const material = base.clone();
  if (geometryLayout !== undefined)
    Object.defineProperty(material.userData, "grassBladeLayout", {
      enumerable: true,
      configurable: false,
      writable: false,
      value: tier,
    });
  // NodeMaterial's public declaration erases the position slot's vector type.
  const basePosition = base.positionNode as Node<"vec3">;
  const correctedPosition = vec3(basePosition).add(
    vec3(0, mix(delta.x, delta.y, uv().x), 0),
  );
  material.positionNode = correctedPosition;
  if (bladeVisibility !== undefined) {
    const visibility = new StorageBufferAttribute(bladeVisibility, 1);
    // As with roots, explicit uint + runtime length avoids count-specific
    // shader variants while preserving the compact Uint32 CPU allocation.
    const visible = storage(visibility, "uint", 0)
      .toReadOnly()
      .element(instanceIndex)
      .shiftRight(vertexIndex.div(uint(tier.verticesPerBlade)))
      .bitAnd(uint(1))
      .notEqual(uint(0));
    // Select after the borrowed deformation and root correction. Every hidden
    // vertex uses one common local anchor, including tips and both root sides;
    // its triangles are degenerate without discards or distant coordinates.
    material.positionNode = visible.select(
      correctedPosition,
      attribute("instanceOffset", "vec3"),
    );
    // Geometry owns the storage allocation, but it is not a vertex input:
    // the existing instanced grass layout already uses eight vertex buffers.
    geometry.setAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE, visibility);
  }
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
