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
  Fn,
  normalLocal,
} from "three/tsl";
import { MeshStandardNodeMaterial, StorageBufferAttribute } from "three/webgpu";
import type Node from "three/src/nodes/core/Node.js";
import type { GrassBladeGroundingResult } from "./GrassBladeGrounding";
import {
  getGrassBladeLayout,
  GRASS_MEADOW_REFINEMENT,
  type FineGrassGeometryLayout,
} from "./GrassBladeLayout";
import {
  assertGrassMeadowAuthoredEndpoint,
  GRASS_MEADOW_AUTHORED_SHAPE,
} from "./GrassMeadowAuthoredShape";
import {
  assertGrassMeadowFootprintArchEndpoint,
  GRASS_MEADOW_FOOTPRINT_ARCH,
} from "./GrassMeadowFootprintArch";
import {
  assertGrassMeadowSweptBladeEndpoint,
  GRASS_MEADOW_SWEPT_BLADE,
} from "./GrassMeadowSweptBlade";

export const GRASS_ROOT_STORAGE_ATTRIBUTE = "grassRootDeltas";
export const GRASS_BLADE_VISIBILITY_ATTRIBUTE = "grassBladeVisibility";

/** Both chunk paths keep the same count, culling and disposal surface. The
 * matrix-free path uses r186's ordinary Object3D disposal event. */
export type GrassChunkRenderMesh = THREE.Mesh & {
  boundingBox: THREE.Box3 | null;
  boundingSphere: THREE.Sphere | null;
};

const matrixFreeGeometryCounts = new WeakMap<
  THREE.InstancedBufferGeometry,
  number
>();
const groundedMaterialOwners = new WeakMap<
  MeshStandardNodeMaterial,
  Readonly<{
    base: MeshStandardNodeMaterial;
    geometry: THREE.BufferGeometry;
    count: number;
    position: Node;
    roots: THREE.BufferAttribute;
    visibility: ReturnType<THREE.BufferGeometry["getAttribute"]> | undefined;
  }>
>();

/** Copy the unbound template before attaching any per-instance or storage
 * inputs. Copying after grounding would separate the material's storage owner
 * from the attribute registered for geometry disposal. */
export function createMatrixFreeGrassGeometry(
  template: THREE.BufferGeometry,
  count: number,
): THREE.InstancedBufferGeometry {
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 4096 ||
    template instanceof THREE.InstancedBufferGeometry ||
    !template.index ||
    !template.hasAttribute("position") ||
    !template.hasAttribute("normal") ||
    !template.hasAttribute("uv") ||
    Object.keys(template.morphAttributes).length !== 0 ||
    Object.values(template.attributes).some(
      (value) =>
        value instanceof THREE.InstancedBufferAttribute ||
        value instanceof StorageBufferAttribute ||
        value instanceof THREE.InterleavedBufferAttribute,
    )
  )
    throw new Error("Invalid matrix-free grass template or count");
  const geometry = new THREE.InstancedBufferGeometry();
  // Call the base copy explicitly: InstancedBufferGeometry.copy expects an
  // instanced source and would otherwise copy its absent instanceCount.
  THREE.BufferGeometry.prototype.copy.call(geometry, template);
  geometry.instanceCount = count;
  matrixFreeGeometryCounts.set(geometry, count);
  return geometry;
}

/** Opt-in publication of an already grounded, exclusively owned clone. No
 * additional material or matrix allocation; no replacement of terrain fit,
 * analytic grass normals, wind, visibility or per-instance attributes. */
export function createMatrixFreeGrassMesh(
  geometry: THREE.InstancedBufferGeometry,
  material: MeshStandardNodeMaterial,
): GrassChunkRenderMesh {
  const count = matrixFreeGeometryCounts.get(geometry);
  const owner = groundedMaterialOwners.get(material);
  if (
    count === undefined ||
    geometry.instanceCount !== count ||
    !owner ||
    owner.geometry !== geometry ||
    owner.count !== count ||
    owner.base === material ||
    material.positionNode !== owner.position ||
    geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE) !== owner.roots ||
    geometry.getAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE) !==
      owner.visibility ||
    geometry.hasAttribute("instanceMatrixStorage") ||
    geometry.hasAttribute("instanceMatrix")
  )
    throw new Error("Invalid matrix-free grass binding ownership");

  const position = owner.position as Node<"vec3">;
  material.positionNode = Fn(() => {
    // InstancedMesh applies inverse-transpose(identity), including normalize,
    // before the custom position graph. Preserve that normal operation for
    // geometric roughness while removing the identity storage matrix work.
    normalLocal.assign(normalLocal.normalize());
    return position;
  }, "vec3")();
  groundedMaterialOwners.delete(material);
  matrixFreeGeometryCounts.delete(geometry);
  Object.defineProperty(geometry, "instanceCount", {
    value: count,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  const mesh = Object.assign(new THREE.Mesh(geometry, material), {
    boundingBox: null as THREE.Box3 | null,
    boundingSphere: null as THREE.Sphere | null,
  });
  Object.defineProperty(mesh, "count", {
    value: count,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  // Grass placement happens in the shader. Template-space intersections are
  // neither gameplay targets nor ground; do not raycast the undeformed mesh.
  mesh.raycast = () => {};
  return mesh;
}

/** Separate addressing, never a replacement for the admitted seven-vertex LOD.
 * This binds an already-certified batch; it does not certify swept terrain
 * clearance or enforce the lifecycle owner's global 640-slot reservation. */
export const GRASS_MEADOW_AUTHORED_GROUNDING = Object.freeze({
  id: "meadow-authored-grounding-v1",
  endpointId: GRASS_MEADOW_AUTHORED_SHAPE.id,
  bladesPerClump: GRASS_MEADOW_REFINEMENT.bladesPerClump,
  verticesPerBlade: GRASS_MEADOW_REFINEMENT.verticesPerBlade,
  verticesPerClump:
    GRASS_MEADOW_REFINEMENT.bladesPerClump *
    GRASS_MEADOW_REFINEMENT.verticesPerBlade,
  rootComponents: 2,
  maximumBatchClumps: 128,
} as const);

export function createGroundedGrassMeadowAuthoredMaterial(
  base: MeshStandardNodeMaterial,
  geometry: THREE.BufferGeometry,
  coarseGeometry: THREE.BufferGeometry,
  rootDeltas: Float32Array,
  count: number,
  bladeVisibility?: Uint32Array,
): MeshStandardNodeMaterial {
  assertGrassMeadowAuthoredEndpoint(geometry, coarseGeometry);
  if (
    !(base.positionNode instanceof THREE.Node) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > GRASS_MEADOW_AUTHORED_GROUNDING.maximumBatchClumps ||
    !(rootDeltas instanceof Float32Array) ||
    rootDeltas.length !==
      count *
        GRASS_MEADOW_AUTHORED_GROUNDING.bladesPerClump *
        GRASS_MEADOW_AUTHORED_GROUNDING.rootComponents ||
    rootDeltas.some((value) => !Number.isFinite(value)) ||
    geometry.hasAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE)
  )
    throw new Error("Invalid authored meadow grounding batch");
  return bindGroundedGrassMaterial(
    base,
    geometry,
    rootDeltas,
    count,
    GRASS_MEADOW_AUTHORED_GROUNDING,
    "grassMeadowAuthoredGrounding",
    bladeVisibility,
  );
}

/** Separate opt-in endpoint; topology sharing does not authorize an authored
 * endpoint to use this arch's fit, response or provenance. */
export const GRASS_MEADOW_FOOTPRINT_ARCH_GROUNDING = Object.freeze({
  ...GRASS_MEADOW_AUTHORED_GROUNDING,
  id: "meadow-footprint-arch-grounding-v1",
  endpointId: GRASS_MEADOW_FOOTPRINT_ARCH.id,
} as const);

export function createGroundedGrassMeadowFootprintArchMaterial(
  base: MeshStandardNodeMaterial,
  geometry: THREE.BufferGeometry,
  coarseGeometry: THREE.BufferGeometry,
  rootDeltas: Float32Array,
  count: number,
  bladeVisibility?: Uint32Array,
): MeshStandardNodeMaterial {
  assertGrassMeadowFootprintArchEndpoint(geometry, coarseGeometry);
  if (
    !(base.positionNode instanceof THREE.Node) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > GRASS_MEADOW_FOOTPRINT_ARCH_GROUNDING.maximumBatchClumps ||
    !(rootDeltas instanceof Float32Array) ||
    rootDeltas.length !==
      count *
        GRASS_MEADOW_FOOTPRINT_ARCH_GROUNDING.bladesPerClump *
        GRASS_MEADOW_FOOTPRINT_ARCH_GROUNDING.rootComponents ||
    rootDeltas.some((value) => !Number.isFinite(value)) ||
    geometry.hasAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE)
  )
    throw new Error("Invalid footprint arch grounding batch");
  return bindGroundedGrassMaterial(
    base,
    geometry,
    rootDeltas,
    count,
    GRASS_MEADOW_FOOTPRINT_ARCH_GROUNDING,
    "grassMeadowFootprintArchGrounding",
    bladeVisibility,
  );
}

/** Independent endpoint identity and validation; the shared fifteen-vertex
 * addressing is not permission to reuse an authored or arch certificate. */
export const GRASS_MEADOW_SWEPT_BLADE_GROUNDING = Object.freeze({
  ...GRASS_MEADOW_AUTHORED_GROUNDING,
  id: "meadow-swept-blade-grounding-v1",
  endpointId: GRASS_MEADOW_SWEPT_BLADE.id,
} as const);

export function createGroundedGrassMeadowSweptBladeMaterial(
  base: MeshStandardNodeMaterial,
  geometry: THREE.BufferGeometry,
  coarseGeometry: THREE.BufferGeometry,
  rootDeltas: Float32Array,
  count: number,
  bladeVisibility?: Uint32Array,
): MeshStandardNodeMaterial {
  assertGrassMeadowSweptBladeEndpoint(geometry, coarseGeometry);
  if (
    !(base.positionNode instanceof THREE.Node) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > GRASS_MEADOW_SWEPT_BLADE_GROUNDING.maximumBatchClumps ||
    !(rootDeltas instanceof Float32Array) ||
    rootDeltas.length !==
      count *
        GRASS_MEADOW_SWEPT_BLADE_GROUNDING.bladesPerClump *
        GRASS_MEADOW_SWEPT_BLADE_GROUNDING.rootComponents ||
    rootDeltas.some((value) => !Number.isFinite(value)) ||
    geometry.hasAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE)
  )
    throw new Error("Invalid swept blade grounding batch");
  return bindGroundedGrassMaterial(
    base,
    geometry,
    rootDeltas,
    count,
    GRASS_MEADOW_SWEPT_BLADE_GROUNDING,
    "grassMeadowSweptBladeGrounding",
    bladeVisibility,
  );
}

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
  return bindGroundedGrassMaterial(
    base,
    geometry,
    rootDeltas,
    count,
    tier,
    geometryLayout === undefined ? undefined : "grassBladeLayout",
    bladeVisibility,
  );
}

function bindGroundedGrassMaterial(
  base: MeshStandardNodeMaterial,
  geometry: THREE.BufferGeometry,
  rootDeltas: Float32Array,
  count: number,
  tier: Readonly<{
    bladesPerClump: number;
    verticesPerBlade: number;
    verticesPerClump: number;
    rootComponents: number;
  }>,
  receiptName:
    | "grassBladeLayout"
    | "grassMeadowAuthoredGrounding"
    | "grassMeadowFootprintArchGrounding"
    | "grassMeadowSweptBladeGrounding"
    | undefined,
  bladeVisibility?: Uint32Array,
): MeshStandardNodeMaterial {
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
  if (receiptName !== undefined)
    Object.defineProperty(material.userData, receiptName, {
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
  let boundPosition: Node<"vec3"> = correctedPosition;
  material.positionNode = boundPosition;
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
    boundPosition = visible.select(
      correctedPosition,
      attribute("instanceOffset", "vec3"),
    );
    material.positionNode = boundPosition;
    // Geometry owns the storage allocation, but it is not a vertex input:
    // the existing instanced grass layout already uses eight vertex buffers.
    geometry.setAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE, visibility);
  }
  // Not used as a vertex attribute in the shader. This registration lets
  // r186 Geometries dispose the actual storage allocation with the chunk.
  geometry.setAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE, buffer);
  if (
    geometry instanceof THREE.InstancedBufferGeometry &&
    matrixFreeGeometryCounts.has(geometry)
  )
    groundedMaterialOwners.set(material, {
      base,
      geometry,
      count,
      position: boundPosition,
      roots: buffer,
      visibility: geometry.getAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE),
    });
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
