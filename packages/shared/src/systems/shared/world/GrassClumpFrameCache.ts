import THREE from "../../../extras/three/three";
import {
  Fn,
  If,
  bool,
  clamp,
  dot,
  float,
  instanceIndex,
  int,
  ivec2,
  mat4,
  pow,
  sin,
  smoothstep,
  textureLoad,
  textureStore,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import type Node from "three/src/nodes/core/Node.js";
import type NodeFrame from "three/src/nodes/core/NodeFrame.js";
import type Renderer from "three/src/renderers/common/Renderer.js";
import type ComputeNode from "three/src/nodes/gpgpu/ComputeNode.js";
import type UniformNode from "three/src/nodes/core/UniformNode.js";

/** Fixed experiment budget. Overflow keeps the original vertex expression. */
export const GRASS_CLUMP_FRAME_LIMITS = Object.freeze({
  width: 1024,
  height: 256,
  owners: 128,
  ownerClumps: 4096,
});
const capacity =
  GRASS_CLUMP_FRAME_LIMITS.width * GRASS_CLUMP_FRAME_LIMITS.height;

/** Raw waves deliberately exclude amplitude/height/bend multiplications: the
 * retained vertex graph applies those in its original floating-point order. */
export function createGrassClumpFrameValues(
  world: Node<"vec3">,
  clock: Node<"float">,
  windSpeed: Node<"float">,
  player: Node<"vec3">,
  fadeStart: Node<"float">,
  fadeEnd: Node<"float">,
): Node<"vec4"> {
  const wt = clock.mul(windSpeed);
  const delta = vec3(world.x, 0, world.z).sub(vec3(player.x, 0, player.z));
  const fade = clamp(
    float(1).sub(smoothstep(fadeStart, fadeEnd, pow(dot(delta, delta), 0.5))),
    0,
    1,
  );
  return vec4(
    sin(wt.add(world.x.mul(0.35)).add(world.z.mul(0.12))),
    sin(wt.mul(0.67).add(world.x.mul(0.18)).add(world.z.mul(0.28)).add(2)),
    fade,
    0,
  );
}

type FrameMesh = THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material>;
class ClumpLease {
  readonly matrix = new THREE.Matrix4();
  readonly ready;
  readonly startUniform;
  readonly material: THREE.Material;
  readonly geometry: THREE.BufferGeometry;
  readonly offsetArray: Float32Array;
  readonly onDispose: () => void;
  readonly onMaterialDispose: () => void;
  readonly originalProgramKeyDescriptor: PropertyDescriptor | undefined;
  readonly programKey: THREE.Material["customProgramCacheKey"];
  submitted = -1;
  offsetVersion = -1;
  matrixInitialized = false;
  retired = false;
  materialDisposed = false;
  constructor(
    readonly cache: GrassClumpFrameCache,
    readonly mesh: FrameMesh,
    readonly offsets: THREE.InstancedBufferAttribute,
    readonly start: number,
    readonly count: number,
    readonly slot: number,
  ) {
    this.material = mesh.material;
    this.geometry = mesh.geometry;
    this.offsetArray = offsets.array as Float32Array;
    this.onDispose = () => cache.retire(mesh);
    this.onMaterialDispose = () => {
      this.materialDisposed = true;
      cache.retire(mesh);
    };
    this.ready = uniform(false).onObjectUpdate((frame) => this.current(frame));
    this.startUniform = uniform(start, "uint");
    Object.defineProperty(this.startUniform, "value", {
      value: start,
      writable: false,
      configurable: false,
    });
    this.originalProgramKeyDescriptor = Object.getOwnPropertyDescriptor(
      this.material,
      "customProgramCacheKey",
    );
    const originalProgramKey = this.material.customProgramCacheKey;
    const identity = this.ready.uuid;
    const lease = this;
    this.programKey = function () {
      const original = originalProgramKey.call(this);
      return lease.retired
        ? original
        : `${original}|grass-clump-frame:${identity}`;
    };
  }
  current(frame: NodeFrame): boolean {
    return (
      !this.retired &&
      frame.object === this.mesh &&
      frame.material === this.material &&
      this.mesh.material === this.material &&
      this.material.customProgramCacheKey === this.programKey &&
      this.mesh.geometry === this.geometry &&
      this.cache.current(frame) &&
      this.submitted === this.cache.submissions &&
      this.mesh.count === this.count &&
      this.mesh.geometry.getAttribute("instanceOffset") === this.offsets &&
      this.offsets.array === this.offsetArray &&
      this.offsets.itemSize === 3 &&
      this.offsets.meshPerAttribute === 1 &&
      !this.offsets.normalized &&
      this.offsets.count === this.count &&
      this.offsets.version === this.offsetVersion &&
      this.mesh.matrixWorld.equals(this.matrix)
    );
  }
}
const owners = new WeakMap<THREE.Material, ClumpLease>();

/** Resolve the actual grounded material, never its shared source or a foreign
 * clone. The original calculation exists only in the not-current branch. */
export function readGrassClumpFrame(
  fallback: () => Node<"vec4">,
): Node<"vec4"> {
  return Fn((builder) => {
    const owner = owners.get(builder.material);
    if (!owner) return fallback();
    const result = vec4(0).toVar("grassClumpFrameValues");
    const valid = bool(false).toVar("grassClumpFrameValid");
    If(owner.ready, () => {
      const address = instanceIndex.add(owner.startUniform);
      const cached = textureLoad(
        owner.cache.output,
        ivec2(
          int(address.mod(GRASS_CLUMP_FRAME_LIMITS.width)),
          int(address.div(GRASS_CLUMP_FRAME_LIMITS.width)),
        ),
      ).toVar("grassClumpFrameSample");
      If(cached.w.equal(owner.cache.generation), () => {
        result.assign(cached);
        valid.assign(true);
      });
    });
    If(valid.not(), () => result.assign(fallback()));
    return result;
  })();
}

/** Manager-owned textures avoid r186's geometry-owned storage-buffer teardown:
 * retiring one chunk must never destroy storage still used by another chunk.
 * All preparation is serialized by the existing ClientGraphics queue. */
export class GrassClumpFrameCache {
  private readonly inputData = new Float32Array(capacity * 4);
  private readonly matrixData = new Float32Array(
    GRASS_CLUMP_FRAME_LIMITS.owners * 16,
  );
  readonly output = new THREE.StorageTexture(
    GRASS_CLUMP_FRAME_LIMITS.width,
    GRASS_CLUMP_FRAME_LIMITS.height,
  );
  readonly input = new THREE.DataTexture(
    this.inputData,
    GRASS_CLUMP_FRAME_LIMITS.width,
    GRASS_CLUMP_FRAME_LIMITS.height,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  readonly matrices = new THREE.DataTexture(
    this.matrixData,
    4,
    GRASS_CLUMP_FRAME_LIMITS.owners,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  readonly compute: ComputeNode;
  readonly generation = uniform(0);
  private readonly leases = new Map<FrameMesh, ClumpLease>();
  private readonly retainedMaterials = new Map<THREE.Material, () => void>();
  private readonly ranges = [{ start: 0, count: capacity }];
  private readonly slots = new Set<number>();
  private readonly count = uniform(0, "uint");
  private readonly clock = uniform(0).onRenderUpdate((frame) => {
    this.observedTime = frame.time;
    return frame.time;
  });
  private renderer: Renderer | null = null;
  private prepared = false;
  private preparing = false;
  private retired = false;
  private disposed = false;
  private failed = false;
  private observedTime = NaN;
  private submittedTime = NaN;
  private lastError: string | null = null;
  private highWater = 0;
  private inputDirty = false;
  private readonly submittedPlayer = new THREE.Vector3();
  private submittedWindSpeed = NaN;
  private device: GPUDevice | null = null;
  submissions = 0;
  private readonly onGpuError = () => this.fail("Grass frame GPU error");

  constructor(
    private readonly player: UniformNode<"vec3", THREE.Vector3>,
    private readonly windSpeed: UniformNode<"float", number>,
    fadeStart: number,
    fadeEnd: number,
  ) {
    if (
      !Number.isFinite(fadeStart) ||
      !Number.isFinite(fadeEnd) ||
      fadeStart < 0 ||
      fadeEnd <= fadeStart
    )
      throw new Error("Invalid grass frame fade");
    for (const map of [this.output, this.input, this.matrices]) {
      map.type = THREE.FloatType;
      map.format = THREE.RGBAFormat;
      map.colorSpace = THREE.NoColorSpace;
      map.minFilter = map.magFilter = THREE.NearestFilter;
      map.generateMipmaps = false;
      map.flipY = false;
      map.matrixAutoUpdate = false;
      map.name = "GrassClumpFrame";
    }
    // Present in installed r186; older declarations omit this actual property.
    Reflect.set(this.output, "mipmapsAutoUpdate", false);
    this.compute = Fn(() => {
      If(instanceIndex.lessThan(this.count), () => {
        const address = ivec2(
          int(instanceIndex.mod(GRASS_CLUMP_FRAME_LIMITS.width)),
          int(instanceIndex.div(GRASS_CLUMP_FRAME_LIMITS.width)),
        );
        const input = textureLoad(this.input, address);
        If(input.w.equal(1), () => {
          const slot = int(input.z);
          const matrix = mat4(
            textureLoad(this.matrices, ivec2(0, slot)),
            textureLoad(this.matrices, ivec2(1, slot)),
            textureLoad(this.matrices, ivec2(2, slot)),
            textureLoad(this.matrices, ivec2(3, slot)),
          );
          const world = matrix.mul(vec4(input.x, 0, input.y, 1));
          const values = createGrassClumpFrameValues(
            world.xyz,
            this.clock,
            windSpeed,
            player,
            float(fadeStart),
            float(fadeEnd),
          );
          textureStore(
            this.output,
            address,
            vec4(values.xyz, this.generation),
          ).toWriteOnly();
        });
      });
    })().compute(capacity, [64]);
    this.compute.name = "GrassClumpFrameDynamics";
  }

  /** Registration does not submit GPU work or alter geometry. Full capacity,
   * unsupported owners and duplicate materials retain the original graph. */
  register(mesh: FrameMesh): boolean {
    if (
      this.retired ||
      this.failed ||
      this.leases.has(mesh) ||
      owners.has(mesh.material) ||
      this.retainedMaterials.has(mesh.material) ||
      this.leases.size + this.retainedMaterials.size >=
        GRASS_CLUMP_FRAME_LIMITS.owners
    )
      return false;
    const offsets = mesh.geometry.getAttribute("instanceOffset");
    const count = mesh.count;
    const keyDescriptor = Object.getOwnPropertyDescriptor(
      mesh.material,
      "customProgramCacheKey",
    );
    if (
      !(mesh instanceof THREE.InstancedMesh) ||
      Array.isArray(mesh.material) ||
      !Object.isExtensible(mesh.material) ||
      (keyDescriptor !== undefined && !keyDescriptor.configurable) ||
      !(offsets instanceof THREE.InstancedBufferAttribute) ||
      offsets.itemSize !== 3 ||
      offsets.meshPerAttribute !== 1 ||
      offsets.normalized ||
      !(offsets.array instanceof Float32Array) ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > GRASS_CLUMP_FRAME_LIMITS.ownerClumps ||
      offsets.count !== count ||
      offsets.array.some((v) => !Number.isFinite(v))
    )
      return false;
    const rangeIndex = this.ranges.findIndex((range) => range.count >= count);
    let slot = 0;
    while (this.slots.has(slot)) slot++;
    if (rangeIndex < 0 || slot >= GRASS_CLUMP_FRAME_LIMITS.owners) return false;
    const range = this.ranges[rangeIndex];
    const lease = new ClumpLease(this, mesh, offsets, range.start, count, slot);
    // A WeakMap selection is invisible to NodeMaterial's node graph key. r186
    // may ignore needsUpdate when that key is unchanged, so this lease needs a
    // stable identity that changes on registration and is removed on retirement.
    Object.defineProperty(lease.material, "customProgramCacheKey", {
      value: lease.programKey,
      configurable: true,
      writable: true,
      enumerable: keyDescriptor?.enumerable ?? false,
    });
    range.start += count;
    range.count -= count;
    if (!range.count) this.ranges.splice(rangeIndex, 1);
    this.slots.add(slot);
    this.leases.set(mesh, lease);
    owners.set(mesh.material, lease);
    mesh.material.needsUpdate = true;
    lease.material.addEventListener("dispose", lease.onMaterialDispose);
    lease.geometry.addEventListener("dispose", lease.onDispose);
    mesh.addEventListener("dispose", lease.onDispose);
    this.highWater = Math.max(this.highWater, lease.start + count);
    return true;
  }

  retire(mesh: FrameMesh): void {
    const lease = this.leases.get(mesh);
    if (!lease) return;
    lease.retired = true;
    lease.material.removeEventListener("dispose", lease.onMaterialDispose);
    lease.geometry.removeEventListener("dispose", lease.onDispose);
    mesh.removeEventListener("dispose", lease.onDispose);
    if (owners.get(lease.material) === lease) owners.delete(lease.material);
    const keyDescriptor = Object.getOwnPropertyDescriptor(
      lease.material,
      "customProgramCacheKey",
    );
    if (
      keyDescriptor?.value === lease.programKey &&
      keyDescriptor.configurable
    ) {
      if (lease.originalProgramKeyDescriptor) {
        Object.defineProperty(
          lease.material,
          "customProgramCacheKey",
          lease.originalProgramKeyDescriptor,
        );
      } else {
        Reflect.deleteProperty(lease.material, "customProgramCacheKey");
      }
    } else if (!lease.materialDisposed) {
      // A foreign key may hide our identity and keep an old compiled binding
      // alive. Do not dispose its borrowed material or overwrite its key; keep
      // these owned GPU resources until that material actually releases them.
      const release = () => {
        lease.material.removeEventListener("dispose", release);
        this.retainedMaterials.delete(lease.material);
        this.finishDisposal();
      };
      this.retainedMaterials.set(lease.material, release);
      lease.material.addEventListener("dispose", release);
    }
    // A caller may retire the cache while leaving this mesh alive. Rebuild its
    // original graph before the next draw, dropping retired texture bindings.
    lease.material.needsUpdate = true;
    this.leases.delete(mesh);
    this.slots.delete(lease.slot);
    this.inputData.fill(0, lease.start * 4, (lease.start + lease.count) * 4);
    this.inputDirty = true;
    this.ranges.push({ start: lease.start, count: lease.count });
    this.ranges.sort((a, b) => a.start - b.start);
    for (let i = this.ranges.length - 1; i > 0; i--) {
      const previous = this.ranges[i - 1],
        current = this.ranges[i];
      if (previous.start + previous.count === current.start) {
        previous.count += current.count;
        this.ranges.splice(i, 1);
      }
    }
    this.highWater = Math.max(
      0,
      ...Array.from(this.leases.values(), (entry) => entry.start + entry.count),
    );
  }

  /** Must execute INSIDE graphics.prepareRenderer, before any admitted frame. */
  async prepare(renderer: Renderer): Promise<void> {
    if (this.retired || this.failed || this.prepared) return;
    if (this.preparing || (this.renderer && this.renderer !== renderer))
      throw new Error("Concurrent or foreign grass frame preparation");
    const backend = renderer.backend as typeof renderer.backend & {
      device?: GPUDevice;
    };
    const device = backend.device;
    if (!device || !renderer.hasInitialized()) {
      this.fail("Grass frame requires initialized WebGPU");
      return;
    }
    this.renderer = renderer;
    this.device = device;
    device.addEventListener("uncapturederror", this.onGpuError);
    this.preparing = true;
    let pushed = false;
    try {
      device.pushErrorScope("validation");
      pushed = true;
      await renderer.compileComputeAsync(this.compute);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    } finally {
      try {
        if (pushed) {
          const error = await device.popErrorScope();
          if (error) this.fail(error.message);
        }
        if (!this.retired && !this.failed) this.prepared = true;
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error));
      } finally {
        this.preparing = false;
        this.finishDisposal();
      }
    }
  }

  /** Called only at the primary preparation boundary, before scene/composer
   * rendering, never from an object/shadow/reflection callback. */
  dispatch(renderer: Renderer): void {
    this.submittedTime = NaN;
    if (
      !this.prepared ||
      this.retired ||
      this.failed ||
      renderer !== this.renderer ||
      !this.leases.size
    )
      return;
    try {
      // Exactly representable float tokens never wrap within an owner lifetime.
      // A skipped/failed GPU write leaves an older token and uses live fallback.
      if (this.generation.value >= 16777215)
        throw new Error("Grass frame generation exhausted");
      this.generation.value++;
      let matricesDirty = false;
      for (const lease of this.leases.values()) {
        const { mesh, offsets } = lease;
        lease.submitted = -1;
        mesh.updateWorldMatrix(true, false);
        if (
          mesh.material !== lease.material ||
          mesh.geometry !== lease.geometry ||
          mesh.count !== lease.count ||
          mesh.geometry.getAttribute("instanceOffset") !== offsets ||
          offsets.array !== lease.offsetArray ||
          offsets.itemSize !== 3 ||
          offsets.meshPerAttribute !== 1 ||
          offsets.normalized ||
          offsets.count !== lease.count ||
          !mesh.matrixWorld.elements.every(Number.isFinite)
        )
          continue;
        if (offsets.version !== lease.offsetVersion) {
          if (offsets.array.some((value) => !Number.isFinite(value))) continue;
          for (let i = 0; i < lease.count; i++) {
            const base = (lease.start + i) * 4;
            this.inputData[base] = offsets.getX(i);
            this.inputData[base + 1] = offsets.getZ(i);
            this.inputData[base + 2] = lease.slot;
            this.inputData[base + 3] = 1;
          }
          lease.offsetVersion = offsets.version;
          this.inputDirty = true;
        }
        if (
          !lease.matrixInitialized ||
          !lease.matrix.equals(mesh.matrixWorld)
        ) {
          lease.matrix.copy(mesh.matrixWorld);
          this.matrixData.set(lease.matrix.elements, lease.slot * 16);
          lease.matrixInitialized = true;
          matricesDirty = true;
        }
        lease.submitted = this.submissions + 1;
      }
      if (this.inputDirty) {
        this.input.needsUpdate = true;
        this.inputDirty = false;
      }
      if (matricesDirty) this.matrices.needsUpdate = true;
      this.count.value = this.highWater;
      this.submittedPlayer.copy(this.player.value);
      this.submittedWindSpeed = this.windSpeed.value;
      this.observedTime = NaN;
      renderer.compute(this.compute, [Math.ceil(this.highWater / 64), 1, 1]);
      if (!Number.isFinite(this.observedTime))
        throw new Error("Grass compute did not observe current frame time");
      this.submissions++;
      this.submittedTime = this.observedTime;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  current(frame: NodeFrame): boolean {
    return (
      this.prepared &&
      !this.failed &&
      !this.retired &&
      frame.renderer === this.renderer &&
      frame.time === this.submittedTime &&
      this.player.value.equals(this.submittedPlayer) &&
      this.windSpeed.value === this.submittedWindSpeed
    );
  }
  finishFrame(): void {
    this.submittedTime = NaN;
  }
  fail(reason: string): void {
    this.failed = true;
    this.prepared = false;
    this.submittedTime = NaN;
    this.lastError = this.lastError ? `${this.lastError}; ${reason}` : reason;
  }
  getReceipt() {
    return {
      mode: "clump-frame-v1",
      prepared: this.prepared,
      preparing: this.preparing,
      retired: this.retired,
      disposed: this.disposed,
      failed: this.failed,
      owners: this.leases.size,
      retainedMaterialBindings: this.retainedMaterials.size,
      clumps: Array.from(this.leases.values()).reduce(
        (sum, lease) => sum + lease.count,
        0,
      ),
      highWater: this.highWater,
      capacity,
      submissions: this.submissions,
      generation: this.generation.value,
      completion: "ordered-submission-with-token-fallback-not-gpu-fence",
      lastError: this.lastError,
      submittedTime: Number.isFinite(this.submittedTime)
        ? this.submittedTime
        : null,
      outputUuid: this.output.uuid,
      outputBytes: capacity * 16,
      inputBytes: capacity * 16 + GRASS_CLUMP_FRAME_LIMITS.owners * 64,
      cpuBackingBytes: capacity * 16 + GRASS_CLUMP_FRAME_LIMITS.owners * 64,
      maximumGpuBytes: capacity * 32 + GRASS_CLUMP_FRAME_LIMITS.owners * 64,
    };
  }
  dispose(): void {
    if (this.retired) return;
    this.retired = true;
    this.prepared = false;
    for (const mesh of Array.from(this.leases.keys())) this.retire(mesh);
    this.finishDisposal();
  }
  private finishDisposal(): void {
    if (
      !this.retired ||
      this.preparing ||
      this.disposed ||
      this.retainedMaterials.size
    )
      return;
    this.disposed = true;
    this.device?.removeEventListener("uncapturederror", this.onGpuError);
    this.compute.dispose();
    this.output.dispose();
    this.input.dispose();
    this.matrices.dispose();
  }
}
