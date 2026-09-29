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
  float,
  vec4,
  cos,
  sin,
  uniform,
  If,
} from "three/tsl";
import {
  IndirectStorageBufferAttribute,
  MeshStandardNodeMaterial,
  StorageBufferAttribute,
} from "three/webgpu";
import type Node from "three/src/nodes/core/Node.js";
import type ComputeNode from "three/src/nodes/gpgpu/ComputeNode.js";
import type Renderer from "three/src/renderers/common/Renderer.js";
import type { GrassBladeGroundingResult } from "./GrassBladeGrounding";
import { validateGrassGroundingDiagnosticSubcells } from "../../../utils/workers/GrassGroundingWorkerWire";
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
export const GRASS_CLUMP_CACHE_INPUT_ATTRIBUTE = "grassClumpInvariantInputs";
export const GRASS_CLUMP_CACHE_ATTRIBUTE = "grassClumpInvariants";
export const GRASS_ADAPTIVE_INDIRECT_ATTRIBUTE = "grassAdaptiveIndirect";
const CLUMP_SOURCE_ATTRIBUTES = [
  "instanceOffset",
  "instanceRotScaleHash",
  "instanceGroundNormal",
] as const;

/** Two vec4 records per clump. No vertex input slots or CPU approximation of
 * the terrain's TSL fields: yaw/slope basis and height/locality/habitat soil. */
export type GrassClumpFieldFactory = (world: Node<"vec3">) => Node<"vec4">;
export type GrassClumpInvariantPreparation = (
  cache: GrassClumpInvariantCache,
) => Promise<void>;

const clumpInvariantOwners = new WeakMap<
  THREE.Material,
  GrassClumpInvariantCache
>();

/** Resolve the actual grounded clone at shader-build time. The base material
 * and callers without a cache retain the original expression. Each builder
 * owns its graph, while every chunk owns its storage and readiness uniform. */
export function readGrassClumpInvariant(
  record: 0 | 1,
  fallback: () => Node<"vec4">,
): Node<"vec4"> {
  return Fn((builder) => {
    const owner = clumpInvariantOwners.get(builder.material);
    if (!owner) return fallback();
    const result = vec4(0).toVar(`grassClumpInvariant${record}`);
    If(owner.readyUniform, () => {
      result.assign(
        owner.readStorage.element(instanceIndex.mul(2).add(record)),
      );
    }).Else(() => {
      result.assign(fallback());
    });
    return result;
  })();
}

/** Chunk-scoped cache with renderer-queue ownership. Retiring a queued chunk
 * cancels publication; retiring during an actual operation defers disposal
 * until that operation settles, even when the queue's caller timeout fired.
 * The owner never calls a submission promise a GPU fence. */
export class GrassClumpInvariantCache {
  readonly inputs: StorageBufferAttribute;
  readonly output: StorageBufferAttribute;
  readonly readStorage;
  readonly readyUniform = uniform(false).onObjectUpdate(() => this.isCurrent());
  readonly compute: ComputeNode;
  private readonly worldMatrix = uniform(new THREE.Matrix4());
  private readonly sourceAttributes: readonly THREE.InstancedBufferAttribute[];
  private readonly versions = [-1, -1, -1];
  private ready = false;
  private queued = false;
  private running = false;
  private retired = false;
  private disposed = false;
  private failed = false;
  private release: (() => void) | null = null;
  private preparations = 0;
  private preparationMs = 0;
  private lastError: string | null = null;

  constructor(
    readonly mesh: GrassChunkRenderMesh,
    fields: GrassClumpFieldFactory,
  ) {
    const { geometry, material } = mesh;
    const count =
      geometry instanceof THREE.InstancedBufferGeometry
        ? geometry.instanceCount
        : 0;
    const inputs = CLUMP_SOURCE_ATTRIBUTES.map((name) =>
      geometry.getAttribute(name),
    );
    if (
      !(material instanceof MeshStandardNodeMaterial) ||
      mesh instanceof THREE.InstancedMesh ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > 4096 ||
      clumpInvariantOwners.has(material) ||
      geometry.hasAttribute(GRASS_CLUMP_CACHE_ATTRIBUTE) ||
      geometry.hasAttribute(GRASS_CLUMP_CACHE_INPUT_ATTRIBUTE) ||
      inputs.some(
        (input) =>
          !(input instanceof THREE.InstancedBufferAttribute) ||
          input.itemSize !== 3 ||
          input.count !== count ||
          input.normalized ||
          input.meshPerAttribute !== 1 ||
          !(input.array instanceof Float32Array) ||
          input.array.some((value) => !Number.isFinite(value)),
      )
    )
      throw new Error("Invalid grass clump invariant cache owner");
    this.sourceAttributes = inputs as THREE.InstancedBufferAttribute[];
    // Dedicated vec4 input avoids r186's storage vec3 padding mutating the
    // published offset/normal attribute layout. Total extra storage is 64B/clump
    // (32 input + 32 output); only the 32B output is read by vertex programs.
    this.inputs = new StorageBufferAttribute(new Float32Array(count * 8), 4);
    this.output = new StorageBufferAttribute(new Float32Array(count * 8), 4);
    geometry.setAttribute(GRASS_CLUMP_CACHE_INPUT_ATTRIBUTE, this.inputs);
    geometry.setAttribute(GRASS_CLUMP_CACHE_ATTRIBUTE, this.output);
    const input = storage(this.inputs, "vec4", count * 2).toReadOnly();
    const output = storage(this.output, "vec4", count * 2);
    this.readStorage = storage(this.output, "vec4", count * 2).toReadOnly();
    this.compute = Fn(() => {
      const address = instanceIndex.mul(2);
      const placement = input.element(address);
      const normal = input.element(address.add(1));
      const inverse = float(1).div(normal.y.add(1));
      output
        .element(address)
        .assign(
          vec4(
            cos(placement.z),
            sin(placement.z),
            inverse,
            normal.x.mul(normal.z).mul(inverse).negate(),
          ),
        );
      const world = this.worldMatrix.mul(vec4(placement.x, 0, placement.y, 1));
      output.element(address.add(1)).assign(fields(world.xyz));
    })().compute(count, [64]);
    this.compute.name = "GrassClumpInvariants";
    clumpInvariantOwners.set(material, this);
  }

  isCurrent(): boolean {
    return (
      this.ready &&
      !this.retired &&
      !this.failed &&
      this.mesh.matrixWorld.equals(this.worldMatrix.value) &&
      this.sourceAttributes.every(
        (input, index) =>
          input.version === this.versions[index] &&
          this.mesh.geometry.getAttribute(CLUMP_SOURCE_ATTRIBUTES[index]) ===
            input,
      )
    );
  }

  needsPreparation(): boolean {
    return (
      !this.retired &&
      !this.failed &&
      !this.queued &&
      !this.running &&
      !this.isCurrent()
    );
  }

  request(prepare: GrassClumpInvariantPreparation): Promise<void> {
    if (!this.needsPreparation()) return Promise.resolve();
    this.queued = true;
    this.ready = false;
    return Promise.resolve()
      .then(() => prepare(this))
      .catch((error: unknown) => {
        this.failed = true;
        this.ready = false;
        this.lastError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.queued = false;
        this.finishRetirement();
      });
  }

  /** Called INSIDE the existing graphics preparation queue. The real geometry
   * is compiled first so r186 registers its storage-disposal owner before any
   * compute buffer allocation. Visibility/frustum changes are synchronous. */
  async prepare(
    renderer: Renderer,
    camera: THREE.Camera,
    scene: THREE.Scene,
  ): Promise<void> {
    await this.runPreparation(async () => {
      const visible = this.mesh.visible,
        culled = this.mesh.frustumCulled;
      let compilation: Promise<void>;
      try {
        this.mesh.visible = true;
        this.mesh.frustumCulled = false;
        compilation = renderer.compileAsync(this.mesh, camera, scene);
      } finally {
        this.mesh.visible = visible;
        this.mesh.frustumCulled = culled;
      }
      await compilation;
      if (this.retired || this.failed) return;
      await renderer.compileComputeAsync(this.compute);
      if (this.retired || this.failed) return;
      // Public compute() submits before later draws on the same renderer queue.
      // This is ordered submission, not physical GPU completion/presentation.
      renderer.compute(this.compute);
    });
  }

  /** Actual operation lifetime, intentionally distinct from its queue caller's
   * deadline. Also permits CPU tests of cancellation using real graph owners. */
  async runPreparation(operation: () => Promise<void>): Promise<void> {
    if (this.retired || this.failed) return;
    if (this.running) throw new Error("Concurrent grass invariant preparation");
    this.running = true;
    this.ready = false;
    const start = performance.now();
    try {
      this.mesh.updateWorldMatrix(true, false);
      if (
        this.sourceAttributes.some(
          (input, index) =>
            this.mesh.geometry.getAttribute(CLUMP_SOURCE_ATTRIBUTES[index]) !==
            input,
        )
      )
        throw new Error("Grass invariant source owner was replaced");
      this.worldMatrix.value.copy(this.mesh.matrixWorld);
      const [offset, rotation, normal] = this.sourceAttributes;
      const packed = this.inputs.array;
      for (let index = 0; index < offset.count; index++) {
        const base = index * 8;
        packed[base] = offset.getX(index);
        packed[base + 1] = offset.getZ(index);
        packed[base + 2] = rotation.getX(index);
        packed[base + 3] = 0;
        packed[base + 4] = normal.getX(index);
        packed[base + 5] = normal.getY(index);
        packed[base + 6] = normal.getZ(index);
        packed[base + 7] = 0;
      }
      this.sourceAttributes.forEach((input, index) => {
        this.versions[index] = input.version;
      });
      this.inputs.needsUpdate = true;
      await operation();
      if (!this.retired && !this.failed) {
        this.ready = true;
        this.preparations++;
      }
    } finally {
      this.preparationMs += performance.now() - start;
      this.running = false;
      this.finishRetirement();
    }
  }

  retire(release: () => void): void {
    if (this.retired) return;
    this.retired = true;
    this.ready = false;
    this.release = release;
    this.finishRetirement();
  }

  private finishRetirement(): void {
    if (!this.retired || this.running || this.disposed) return;
    this.disposed = true;
    clumpInvariantOwners.delete(this.mesh.material as THREE.Material);
    this.compute.dispose();
    this.release?.();
    this.release = null;
  }

  snapshot() {
    return {
      ready: this.isCurrent(),
      queued: this.queued,
      running: this.running,
      retired: this.retired,
      disposed: this.disposed,
      failed: this.failed,
      preparations: this.preparations,
      preparationMs: this.preparationMs,
      inputBytes: this.inputs.array.byteLength,
      outputBytes: this.output.array.byteLength,
      lastError: this.lastError,
      completion: "ordered-submission-not-gpu-fence" as const,
    };
  }
}

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
  return paddedGrassBounds(b);
}

type ReadyGrass = Extract<GrassBladeGroundingResult, { status: "ready" }>;
type GrassBounds = NonNullable<ReadyGrass["sweptBounds"]>;

function paddedGrassBounds(b: GrassBounds): THREE.Box3 {
  const padding = Math.max(
    0.001,
    ...Object.values(b).map((value) => Math.abs(value) * 2 ** -20),
  );
  return new THREE.Box3(
    new THREE.Vector3(b.minX, b.minY, b.minZ),
    new THREE.Vector3(b.maxX, b.maxY, b.maxZ),
  ).expandByScalar(padding);
}

export type AdaptiveGrassQuadrant = Readonly<{
  x: number;
  z: number;
  start: number;
  count: number;
  bounds: Readonly<GrassBounds>;
}>;

/** Render copies only. Original fitting evidence remains in accepted order;
 * renderOrder maps each new instance back to that order. */
export type AdaptiveGrassRenderData = Readonly<{
  data: ReadyGrass["data"];
  rootDeltas: Float32Array;
  bladeVisibility?: Uint32Array;
  renderOrder: Uint32Array;
  renderSourceIndices: Uint32Array;
  origin: Readonly<{ x: number; z: number }>;
  quadrants: readonly AdaptiveGrassQuadrant[];
}>;

/** One bounded publication-time permutation, never a grounding retry or a
 * per-camera upload. Stable within each occupied world-grid 12.5m quadrant. */
export function prepareAdaptiveGrassRenderData(
  result: ReadyGrass,
  origin: Readonly<{ x: number; z: number }>,
): AdaptiveGrassRenderData {
  const { data, rootDeltas, sourceIndices, bladeVisibility } = result;
  const count = data.count,
    blades = result.receipt.bladesPerClump;
  validateGrassGroundingDiagnosticSubcells(
    result.diagnosticSubcells,
    "world-grid-6.25m-v1",
    count,
    result.sweptBounds,
  );
  if (
    !Number.isFinite(origin.x) ||
    !Number.isFinite(origin.z) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 4096 ||
    !Number.isSafeInteger(blades) ||
    blades < 1 ||
    blades > 32 ||
    rootDeltas.length !== count * blades * 2 ||
    sourceIndices.length !== count ||
    (bladeVisibility !== undefined && bladeVisibility.length !== count)
  )
    throw new Error("Invalid adaptive grass render data");
  const streams = [
    ["offsets", 3],
    ["rotScaleHash", 3],
    ["groundColors", 3],
    ["grassTints", 4],
    ["groundNormals", 3],
  ] as const;
  for (const [name, stride] of streams)
    if (
      !(data[name] instanceof Float32Array) ||
      data[name].length !== count * stride
    )
      throw new Error("Invalid adaptive grass instance stream");
  const cells = result.diagnosticSubcells!.cells;
  const fineCounts = new Map(cells.map((cell) => [`${cell.x},${cell.z}`, 0]));
  const bins = new Map<
    string,
    { x: number; z: number; indices: number[]; bounds: GrassBounds }
  >();
  for (const cell of cells) {
    const x = Math.floor(cell.x / 2) + 0,
      z = Math.floor(cell.z / 2) + 0;
    const key = `${x},${z}`,
      existing = bins.get(key);
    if (!existing)
      bins.set(key, { x, z, indices: [], bounds: { ...cell.bounds } });
    else {
      const a = existing.bounds,
        b = cell.bounds;
      a.minX = Math.min(a.minX, b.minX);
      a.maxX = Math.max(a.maxX, b.maxX);
      a.minY = Math.min(a.minY, b.minY);
      a.maxY = Math.max(a.maxY, b.maxY);
      a.minZ = Math.min(a.minZ, b.minZ);
      a.maxZ = Math.max(a.maxZ, b.maxZ);
    }
  }
  if (bins.size > 4)
    throw new Error("Adaptive grass requires at most four quadrants");
  for (let i = 0; i < count; i++) {
    const x = Math.floor((origin.x + data.offsets[i * 3]) / 6.25) + 0;
    const z = Math.floor((origin.z + data.offsets[i * 3 + 2]) / 6.25) + 0;
    const key = `${x},${z}`,
      previous = fineCounts.get(key);
    if (previous === undefined)
      throw new Error("Adaptive grass anchor/grid mismatch");
    fineCounts.set(key, previous + 1);
    bins
      .get(`${Math.floor(x / 2) + 0},${Math.floor(z / 2) + 0}`)!
      .indices.push(i);
  }
  if (
    cells.some((cell) => fineCounts.get(`${cell.x},${cell.z}`) !== cell.count)
  )
    throw new Error("Adaptive grass subcell count mismatch");
  const order = new Uint32Array(count),
    quadrants: AdaptiveGrassQuadrant[] = [];
  let start = 0;
  for (const bin of [...bins.values()].sort((a, b) => a.x - b.x || a.z - b.z)) {
    order.set(bin.indices, start);
    quadrants.push(
      Object.freeze({
        x: bin.x,
        z: bin.z,
        start,
        count: bin.indices.length,
        bounds: Object.freeze(bin.bounds),
      }),
    );
    start += bin.indices.length;
  }
  const permute = (input: Float32Array, stride: number) => {
    const output = new Float32Array(input.length);
    for (let i = 0; i < count; i++)
      output.set(
        input.subarray(order[i] * stride, (order[i] + 1) * stride),
        i * stride,
      );
    return output;
  };
  const renderData = { ...data };
  for (const [name, stride] of streams)
    renderData[name] = permute(data[name], stride);
  return Object.freeze({
    data: renderData,
    rootDeltas: permute(rootDeltas, blades * 2),
    ...(bladeVisibility
      ? { bladeVisibility: Uint32Array.from(order, (i) => bladeVisibility[i]) }
      : {}),
    renderOrder: order,
    renderSourceIndices: Uint32Array.from(order, (i) => sourceIndices[i]),
    origin: Object.freeze({ ...origin }),
    quadrants: Object.freeze(quadrants),
  });
}

/** Query only an initialized real renderer. Unsupported devices keep the
 * original direct chunk and original instance order, not zero firstInstance. */
export function supportsAdaptiveGrassDraw(renderer: Renderer): boolean {
  return (
    renderer.initialized &&
    renderer.coordinateSystem === THREE.WebGPUCoordinateSystem &&
    renderer.hasFeature("indirect-first-instance")
  );
}

/** CPU-owned immutable command table and bounded camera selection. The public
 * factory feature-gates production installation; direct construction also lets
 * real Three CPU tests exercise lifecycle without fabricating a GPU device. */
export class AdaptiveGrassDrawOwner {
  readonly indirect: IndirectStorageBufferAttribute;
  private readonly offsets: number[][];
  private readonly localBounds: THREE.Box3[];
  private readonly matrix = new THREE.Matrix4();
  private readonly box = new THREE.Box3();
  private readonly frustum = new THREE.Frustum();
  private readonly stack: {
    indirect: IndirectStorageBufferAttribute | null;
    offset: number | number[];
  }[] = [];
  private readonly before: THREE.Mesh["onBeforeRender"];
  private readonly after: THREE.Mesh["onAfterRender"];
  private readonly oldBefore: THREE.Mesh["onBeforeRender"];
  private readonly oldAfter: THREE.Mesh["onAfterRender"];
  private readonly geometry: THREE.BufferGeometry;
  private readonly index: THREE.BufferAttribute;
  private readonly indexVersion: number;
  private readonly indexCount: number;
  private readonly material: MeshStandardNodeMaterial;
  private readonly materialVersion: number;
  private readonly positionNode: MeshStandardNodeMaterial["positionNode"];
  private readonly attributes: readonly {
    name: string;
    attribute: THREE.BufferAttribute;
    version: number;
  }[];
  private readonly color: THREE.InterleavedBufferAttribute;
  private readonly tint: THREE.InterleavedBufferAttribute;
  private readonly colorBuffer: THREE.InstancedInterleavedBuffer;
  private readonly colorArray: Float32Array;
  private readonly colorVersion: number;
  private disposed = false;

  constructor(
    readonly mesh: GrassChunkRenderMesh,
    readonly prepared: AdaptiveGrassRenderData,
    private readonly renderer: Renderer,
    private readonly onTouched: (owner: AdaptiveGrassDrawOwner) => void,
  ) {
    const geometry = mesh.geometry,
      index = geometry.getIndex();
    if (
      !index ||
      geometry.indirect !== null ||
      geometry.groups.length ||
      geometry.drawRange.start !== 0 ||
      geometry.drawRange.count !== Infinity ||
      mesh.count !== prepared.data.count ||
      !(mesh.material instanceof MeshStandardNodeMaterial) ||
      geometry.hasAttribute(GRASS_ADAPTIVE_INDIRECT_ATTRIBUTE)
    )
      throw new Error("Invalid adaptive grass draw owner");
    const streams = [
      ["instanceOffset", prepared.data.offsets],
      ["instanceRotScaleHash", prepared.data.rotScaleHash],
      ["instanceGroundNormal", prepared.data.groundNormals],
      [GRASS_ROOT_STORAGE_ATTRIBUTE, prepared.rootDeltas],
      ...(prepared.bladeVisibility
        ? [
            [
              GRASS_BLADE_VISIBILITY_ATTRIBUTE,
              prepared.bladeVisibility,
            ] as const,
          ]
        : []),
    ] as const;
    this.attributes = streams.map(([name, array]) => {
      const attribute = geometry.getAttribute(name);
      if (
        !(attribute instanceof THREE.BufferAttribute) ||
        attribute.array !== array
      )
        throw new Error("Adaptive grass requires corresponding render streams");
      return { name, attribute, version: attribute.version };
    });
    const color = geometry.getAttribute("instanceGroundColor"),
      tint = geometry.getAttribute("instanceGrassTint");
    if (
      !(color instanceof THREE.InterleavedBufferAttribute) ||
      !(tint instanceof THREE.InterleavedBufferAttribute) ||
      color.data !== tint.data ||
      !(color.data instanceof THREE.InstancedInterleavedBuffer) ||
      !(color.data.array instanceof Float32Array) ||
      color.data.stride !== 7 ||
      color.data.meshPerAttribute !== 1 ||
      color.count !== prepared.data.count ||
      color.itemSize !== 3 ||
      color.offset !== 0 ||
      color.normalized ||
      tint.itemSize !== 4 ||
      tint.offset !== 3 ||
      tint.normalized
    )
      throw new Error(
        "Adaptive grass requires the production color/tint interleave",
      );
    for (let i = 0; i < prepared.data.count; i++) {
      for (let j = 0; j < 3; j++)
        if (
          !Object.is(
            color.data.array[i * 7 + j],
            prepared.data.groundColors[i * 3 + j],
          )
        )
          throw new Error("Adaptive grass color order mismatch");
      for (let j = 0; j < 4; j++)
        if (
          !Object.is(
            color.data.array[i * 7 + 3 + j],
            prepared.data.grassTints[i * 4 + j],
          )
        )
          throw new Error("Adaptive grass tint order mismatch");
    }
    this.color = color;
    this.tint = tint;
    this.colorBuffer = color.data;
    this.colorArray = color.data.array;
    this.colorVersion = color.data.version;
    // The production storage-instanced owner uses newly created identity
    // matrices. Reject a different matrix transform rather than omit it from
    // the bounds/permutation contract.
    if (mesh instanceof THREE.InstancedMesh) {
      const identity = new THREE.Matrix4(),
        matrix = new THREE.Matrix4();
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        if (!matrix.equals(identity))
          throw new Error("Adaptive grass requires identity instance matrices");
      }
      this.attributes = [
        ...this.attributes,
        {
          name: "instanceMatrixStorage",
          attribute: mesh.instanceMatrix,
          version: mesh.instanceMatrix.version,
        },
      ];
    }
    this.geometry = geometry;
    this.index = index;
    this.indexVersion = index.version;
    this.indexCount = index.count;
    this.material = mesh.material;
    this.materialVersion = mesh.material.version;
    this.positionNode = mesh.material.positionNode;
    const records = new Uint32Array((prepared.quadrants.length + 1) * 5);
    records.set([index.count, prepared.data.count, 0, 0, 0]);
    prepared.quadrants.forEach((quadrant, i) => {
      records.set(
        [index.count, quadrant.count, 0, 0, quadrant.start],
        (i + 1) * 5,
      );
    });
    this.indirect = new IndirectStorageBufferAttribute(records, 5);
    // r186 only releases indirect GPU storage via registered geometry attrs.
    geometry.setAttribute(GRASS_ADAPTIVE_INDIRECT_ATTRIBUTE, this.indirect);
    geometry.setIndirect(this.indirect, 0);
    const all = (1 << prepared.quadrants.length) - 1;
    this.offsets = Array.from({ length: all + 1 }, (_, mask) =>
      mask === all
        ? [0]
        : prepared.quadrants.flatMap((_, i) =>
            mask & (1 << i) ? [(i + 1) * 20] : [],
          ),
    );
    this.offsets.forEach(Object.freeze);
    this.localBounds = prepared.quadrants.map((q) =>
      paddedGrassBounds(q.bounds).translate(
        new THREE.Vector3(-prepared.origin.x, 0, -prepared.origin.z),
      ),
    );
    this.oldBefore = mesh.onBeforeRender;
    this.oldAfter = mesh.onAfterRender;
    this.before = (...args) => {
      this.stack.push({
        indirect: geometry.indirect,
        offset: geometry.indirectOffset,
      });
      try {
        this.onTouched(this);
        this.oldBefore.apply(mesh, args);
        const selection =
          Object.is(args[0], renderer) &&
          mesh.frustumCulled &&
          supportsAdaptiveGrassDraw(renderer)
            ? this.selectCamera(args[2])
            : this.hasCurrentDrawInputs()
              ? 0
              : null;
        geometry.setIndirect(
          selection === null ? null : this.indirect,
          selection ?? 0,
        );
      } catch (error) {
        this.resetAfterRender();
        throw error;
      }
    };
    this.after = (...args) => {
      try {
        this.oldAfter.apply(mesh, args);
      } finally {
        const previous = this.stack.pop();
        if (!this.hasCurrentDrawInputs()) geometry.setIndirect(null, 0);
        else if (previous)
          geometry.setIndirect(previous.indirect, previous.offset);
        else this.resetAfterRender();
      }
    };
    mesh.onBeforeRender = this.before;
    mesh.onAfterRender = this.after;
  }

  /** Uses the renderer's already-updated actual camera, including oblique and
   * reversed WebGPU projections. No cached primary-camera visibility. */
  private hasCurrentDrawInputs(): boolean {
    return !(
      this.disposed ||
      this.mesh.geometry !== this.geometry ||
      this.mesh.material !== this.material ||
      this.material.version !== this.materialVersion ||
      this.material.positionNode !== this.positionNode ||
      this.geometry.getIndex() !== this.index ||
      this.index.version !== this.indexVersion ||
      this.index.count !== this.indexCount ||
      this.mesh.count !== this.prepared.data.count ||
      this.geometry.drawRange.start !== 0 ||
      this.geometry.drawRange.count !== Infinity ||
      this.geometry.groups.length !== 0 ||
      this.geometry.getAttribute("instanceGroundColor") !== this.color ||
      this.geometry.getAttribute("instanceGrassTint") !== this.tint ||
      this.color.data !== this.colorBuffer ||
      this.tint.data !== this.colorBuffer ||
      this.colorBuffer.array !== this.colorArray ||
      this.colorBuffer.version !== this.colorVersion ||
      this.attributes.some(
        ({ name, attribute, version }) =>
          this.geometry.getAttribute(name) !== attribute ||
          attribute.version !== version,
      )
    );
  }

  selectCamera(camera: THREE.Camera): number | number[] | null {
    // An old immutable full record is NOT a fallback for changed index/count
    // streams. Null selects the renderer's ordinary current direct draw.
    if (!this.hasCurrentDrawInputs()) return null;
    if (
      camera.coordinateSystem !== THREE.WebGPUCoordinateSystem ||
      camera instanceof THREE.ArrayCamera ||
      !this.mesh.matrixWorld.elements.every(Number.isFinite) ||
      this.mesh.matrixWorld.determinant() === 0
    )
      return 0;
    this.matrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    if (!this.matrix.elements.every(Number.isFinite)) return 0;
    this.frustum.setFromProjectionMatrix(
      this.matrix,
      camera.coordinateSystem,
      camera.reversedDepth,
    );
    if (
      this.frustum.planes.some(
        (p) =>
          !Number.isFinite(p.constant) ||
          !Number.isFinite(p.normal.x) ||
          !Number.isFinite(p.normal.y) ||
          !Number.isFinite(p.normal.z),
      )
    )
      return 0;
    let mask = 0;
    for (let i = 0; i < this.localBounds.length; i++) {
      this.box.copy(this.localBounds[i]).applyMatrix4(this.mesh.matrixWorld);
      if (
        !Number.isFinite(this.box.min.x) ||
        !Number.isFinite(this.box.min.y) ||
        !Number.isFinite(this.box.min.z) ||
        !Number.isFinite(this.box.max.x) ||
        !Number.isFinite(this.box.max.y) ||
        !Number.isFinite(this.box.max.z) ||
        this.box.isEmpty()
      )
        return 0;
      if (this.frustum.intersectsBox(this.box)) mask |= 1 << i;
    }
    return this.offsets[mask];
  }

  /** r186 object.onAfterRender is not a finally. Called by the existing outer
   * render/precompile finally and before retiring a touched chunk. */
  resetAfterRender(): void {
    this.stack.length = 0;
    if (
      this.geometry.indirect === this.indirect ||
      this.geometry.indirect === null
    )
      this.geometry.setIndirect(
        this.hasCurrentDrawInputs() ? this.indirect : null,
        0,
      );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resetAfterRender();
    if (this.mesh.onBeforeRender === this.before)
      this.mesh.onBeforeRender = this.oldBefore;
    if (this.mesh.onAfterRender === this.after)
      this.mesh.onAfterRender = this.oldAfter;
    // Keep the attribute registered until the normal geometry.dispose event.
    // This owner does not dispose borrowed geometry/materials or GPU resources.
  }
}

export function createAdaptiveGrassDrawOwner(
  mesh: GrassChunkRenderMesh,
  prepared: AdaptiveGrassRenderData,
  renderer: Renderer,
  onTouched: (owner: AdaptiveGrassDrawOwner) => void,
): AdaptiveGrassDrawOwner | null {
  return supportsAdaptiveGrassDraw(renderer)
    ? new AdaptiveGrassDrawOwner(mesh, prepared, renderer, onTouched)
    : null;
}
