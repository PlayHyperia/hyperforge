/**
 * Instanced Animated Impostor (WebGPU)
 *
 * GPU-instanced rendering of animated octahedral impostors.
 * Supports multiple mob variants in a single draw call using the global mob atlas.
 *
 * Features:
 * - Single draw call for all mob impostors
 * - Per-instance: position, yaw, animation offset, variant, scale
 * - GPU-side billboarding and sprite selection via TSL
 * - Support for mixed mob types via variant index
 */

import {
  InstancedMesh,
  PlaneGeometry,
  MeshStandardNodeMaterial,
  Vector3,
  Matrix4,
} from "three/webgpu";
import {
  texture as textureNode,
  uniform,
  Fn,
  positionLocal,
  uv,
  cameraPosition,
  vec3,
  vec2,
  vec4,
  float,
  dot,
  normalize,
  cross,
  mix,
  step,
  floor,
  abs,
  sign,
  min,
  round,
  clamp,
  Discard,
  If,
  select,
  varying,
  storage,
  instanceIndex,
  sin,
  cos,
} from "three/tsl";
import { StorageInstancedBufferAttribute } from "three/webgpu";
import type { StorageBufferNode } from "three/webgpu";
import type { GlobalMobAtlas, MobVariantConfig } from "./types";

/**
 * Per-instance data for the instanced renderer
 */
export interface MobInstanceData {
  /** World position */
  position: Vector3;
  /** Yaw rotation in radians */
  yaw: number;
  /** Animation phase offset (0 to frameCount, for desync) */
  animationOffset: number;
  /** Variant index (which mob type) */
  variantIndex: number;
  /** Scale multiplier */
  scale: number;
  /** Whether this instance is visible */
  visible: boolean;
}

/**
 * Configuration for InstancedAnimatedImpostor
 */
export interface InstancedAnimatedImpostorConfig {
  /** Maximum number of instances */
  maxInstances: number;
  /** Global mob atlas containing all variants */
  atlas: GlobalMobAtlas;
  /** Base billboard scale (default: 1.0) */
  scale?: number;
  /** Alpha clamp threshold (default: 0.05) */
  alphaClamp?: number;
  /**
   * Sprites per side in the atlas (backwards compatible)
   * @deprecated Use spritesX and spritesY from atlas
   */
  spritesPerSide?: number;
  /** Use hemi-octahedron mapping */
  useHemiOctahedron?: boolean;
}

/**
 * Uniforms exposed by the instanced material
 */
export interface InstancedAnimatedUniforms {
  frameIndex: { value: number };
  globalScale: { value: number };
  alphaClamp: { value: number };
  /** @deprecated Use spritesX and spritesY */
  spritesPerSide: { value: number };
  spritesX: { value: number };
  spritesY: { value: number };
}

const PLANE_GEOMETRY = new PlaneGeometry();

/**
 * InstancedAnimatedImpostor - GPU-instanced animated impostor rendering
 *
 * Uses WebGPU TSL with StorageInstancedBufferAttribute for efficient
 * crowd rendering with a single draw call.
 */
export class InstancedAnimatedImpostor extends InstancedMesh<
  PlaneGeometry,
  MeshStandardNodeMaterial
> {
  private _instanceStateStorage!: StorageBufferNode<"vec4">;
  private _instanceOffsetStorage!: StorageBufferNode<"float">;
  private _instanceVariantStorage!: StorageBufferNode<"float">;
  private _instanceFlagsStorage!: StorageBufferNode<"float">;
  private _variants: MobVariantConfig[];
  private _maxInstances: number;
  private _activeCount: number = 0;

  constructor(config: InstancedAnimatedImpostorConfig) {
    const material = new MeshStandardNodeMaterial();
    super(PLANE_GEOMETRY, material, config.maxInstances);

    this._maxInstances = config.maxInstances;
    // Convert Map to array for indexed access
    this._variants = Array.from(config.atlas.variants.values());
    if (this._variants.length === 0) {
      throw new Error(
        "[InstancedAnimatedImpostor] Atlas must have at least one variant",
      );
    }

    // Create the TSL material with storage buffers
    this._setupMaterial(config);
    this.frustumCulled = false;
  }

  private _setupMaterial(config: InstancedAnimatedImpostorConfig): void {
    const material = this.material;
    material.transparent = true;
    material.metalness = 0.0;
    material.roughness = 0.7;

    const arrayTexture = config.atlas.atlasArray;
    // Support asymmetric grids (more horizontal than vertical views)
    const spritesX = config.atlas.spritesX ?? config.spritesPerSide ?? 16;
    const spritesY = config.atlas.spritesY ?? config.spritesPerSide ?? 8;
    const useHemiOct = config.useHemiOctahedron ?? true;

    // Uniforms (separate X and Y for asymmetric grids)
    const spritesXUniform = uniform(spritesX);
    const spritesYUniform = uniform(spritesY);
    const alphaClamp = uniform(config.alphaClamp ?? 0.05);
    const useHemiOctahedron = uniform(useHemiOct ? 1 : 0);
    const frameIndex = uniform(0);
    const globalScale = uniform(config.scale ?? 1);
    const flipYFlag = uniform(0);
    const yawSpriteOffset = uniform(0.0);

    // Build variant lookup arrays (inline constants like Horde does)
    const variantCounts: number[] = [];
    const variantBases: number[] = [];
    let baseFrame = 0;
    for (const v of this._variants) {
      variantCounts.push(v.frameCount);
      variantBases.push(baseFrame);
      baseFrame += v.frameCount;
    }

    // Storage buffers for per-instance state
    // State: vec4(x, y, z, yaw)
    this._instanceStateStorage = storage(
      new StorageInstancedBufferAttribute(this._maxInstances, 4),
      "vec4",
      this._maxInstances,
    );
    // Animation offset: float
    this._instanceOffsetStorage = storage(
      new StorageInstancedBufferAttribute(
        new Float32Array(this._maxInstances),
        1,
      ),
      "float",
      this._maxInstances,
    );
    // Variant: float (index into variants array)
    this._instanceVariantStorage = storage(
      new StorageInstancedBufferAttribute(
        new Float32Array(this._maxInstances),
        1,
      ),
      "float",
      this._maxInstances,
    );
    // Flags: float (0 = visible, >=2 = hidden)
    this._instanceFlagsStorage = storage(
      new StorageInstancedBufferAttribute(
        new Float32Array(this._maxInstances),
        1,
      ),
      "float",
      this._maxInstances,
    );

    // Varyings
    const vSprite = varying(vec2(), "vSprite");
    const vSpriteUV = varying(vec2(), "vSpriteUV");
    const vVariantIdx = varying(float(), "vVariantIdx");

    // Vertex: billboarding + octahedral sprite selection per instance
    // Uses asymmetric grid (more horizontal than vertical views)
    material.positionNode = Fn(() => {
      const spritesMinusOneX = spritesXUniform.sub(1.0);
      const spritesMinusOneY = spritesYUniform.sub(1.0);

      // Read per-instance state
      const state = this._instanceStateStorage.element(instanceIndex);
      const instanceCenter = state.xyz;
      const yaw = state.w.add(yawSpriteOffset);
      const cameraPosWorldSpace = cameraPosition.sub(instanceCenter);

      // Transform camera to instance local space (inverse yaw)
      const cosYaw = cos(yaw);
      const sinYaw = sin(yaw);
      const camLocalX = cosYaw
        .mul(cameraPosWorldSpace.x)
        .add(sinYaw.mul(cameraPosWorldSpace.z));
      const camLocalZ = sinYaw
        .mul(-1.0)
        .mul(cameraPosWorldSpace.x)
        .add(cosYaw.mul(cameraPosWorldSpace.z));
      const cameraPosLocal = vec3(camLocalX, cameraPosWorldSpace.y, camLocalZ);

      const cameraDir = normalize(
        vec3(cameraPosLocal.x, cameraPosLocal.y, cameraPosLocal.z),
      );

      const up = vec3(0.0, 1.0, 0.0).toVar();
      If(useHemiOctahedron, () => {
        up.assign(mix(up, vec3(-1.0, 0.0, 0.0), step(0.999, cameraDir.y)));
      }).Else(() => {
        up.assign(mix(up, vec3(-1.0, 0.0, 0.0), step(0.999, cameraDir.y)));
        up.assign(mix(up, vec3(1.0, 0.0, 0.0), step(cameraDir.y, -0.999)));
      });

      // Billboard in world space
      const cameraDirWorld = normalize(
        vec3(
          cameraPosWorldSpace.x,
          cameraPosWorldSpace.y,
          cameraPosWorldSpace.z,
        ),
      );
      const tangent = normalize(cross(up, cameraDirWorld));
      const bitangent = cross(cameraDirWorld, tangent);

      // Get per-variant scale from variant storage (simplified: use globalScale)
      const varIdx = clamp(
        this._instanceVariantStorage.element(instanceIndex).x,
        float(0.0),
        float(this._variants.length - 1),
      );
      vVariantIdx.assign(varIdx);

      const finalScale = globalScale;
      const projectedVertex = tangent
        .mul(positionLocal.x.mul(finalScale))
        .add(bitangent.mul(positionLocal.y.mul(finalScale)))
        .add(instanceCenter);

      // Octahedral grid calculation
      const grid = vec2().toVar();
      If(useHemiOctahedron, () => {
        const octahedron = cameraDir.div(dot(cameraDir, sign(cameraDir)));
        grid.assign(
          vec2(octahedron.x.add(octahedron.z), octahedron.z.sub(octahedron.x))
            .add(1.0)
            .mul(0.5),
        );
      }).Else(() => {
        const dir = cameraDir.div(dot(abs(cameraDir), vec3(1.0))).toVar();
        If(dir.y.lessThan(0.0), () => {
          const signNotZero = vec2(
            select(dir.x.lessThan(0.0), float(-1.0), float(1.0)),
            select(dir.z.lessThan(0.0), float(-1.0), float(1.0)),
          );
          const oldX = dir.x;
          dir.x.assign(float(1.0).sub(abs(dir.z)).mul(signNotZero.x));
          dir.z.assign(float(1.0).sub(abs(oldX)).mul(signNotZero.y));
        });
        grid.assign(dir.xz.mul(0.5).add(0.5));
      });

      // Asymmetric grid: scale grid.x by spritesX, grid.y by spritesY
      const spriteGridX = grid.x.mul(spritesMinusOneX);
      const spriteGridY = grid.y.mul(spritesMinusOneY);
      const spriteX = min(round(spriteGridX), spritesMinusOneX);
      const spriteY = min(round(spriteGridY), spritesMinusOneY);
      vSprite.assign(vec2(spriteX, spriteY));
      vSpriteUV.assign(uv());

      return vec4(projectedVertex, 1.0);
    })();

    // Fragment: sample array layer based on variant and frame
    material.colorNode = Fn(() => {
      // Check if hidden
      const flagVal = this._instanceFlagsStorage.element(instanceIndex).x;
      If(flagVal.greaterThanEqual(2.0), () => {
        Discard();
      });

      // Asymmetric frame sizes for non-square grids
      const frameSizeX = float(1.0).div(spritesXUniform);
      const frameSizeY = float(1.0).div(spritesYUniform);
      const uvY = mix(vSpriteUV.y, float(1.0).sub(vSpriteUV.y), flipYFlag);
      const localUV = vec2(vSpriteUV.x, uvY);
      // Calculate UV with asymmetric cell sizes
      const spriteUV = vec2(
        frameSizeX.mul(vSprite.x.add(clamp(localUV.x, float(0), float(1)))),
        frameSizeY.mul(vSprite.y.add(clamp(localUV.y, float(0), float(1)))),
      );

      // Get animation offset and variant
      const instOff = this._instanceOffsetStorage.element(instanceIndex).x;
      const baseIdx = floor(frameIndex.add(instOff));
      const variantIdx = clamp(
        vVariantIdx,
        float(0.0),
        float(this._variants.length - 1),
      ).toInt();

      // Compute frame count and base for this variant (using conditional chains like Horde)
      const vCountSel = float(variantCounts[0] || 1).toVar();
      const vBaseSel = float(variantBases[0] || 0).toVar();

      for (let i = 1; i < this._variants.length; i++) {
        If(abs(float(i).sub(variantIdx)).lessThan(0.5), () => {
          vCountSel.assign(float(variantCounts[i] || 1));
          vBaseSel.assign(float(variantBases[i] || 0));
        });
      }

      // Wrap frame index within variant's frame count
      const divF = baseIdx.div(vCountSel);
      const fracF = divF.sub(floor(divF));
      const localIdx = floor(fracF.mul(vCountSel)).toInt();
      const finalIdx = vBaseSel.toInt().add(localIdx);

      // Sample texture array at computed layer
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sampleNode = (textureNode as any)(arrayTexture, spriteUV).depth(
        finalIdx,
      );
      const spriteColor = sampleNode;

      If(spriteColor.a.lessThanEqual(alphaClamp), () => {
        Discard();
      });

      return spriteColor;
    })();

    // Store uniforms for runtime updates
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (material as any).instancedAnimatedUniforms = {
      frameIndex,
      globalScale,
      alphaClamp,
      spritesPerSide: spritesXUniform, // Backwards compatible
      spritesX: spritesXUniform,
      spritesY: spritesYUniform,
      yawSpriteOffset,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (material as any).instanceStateStorage = this._instanceStateStorage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (material as any).instanceOffsetStorage = this._instanceOffsetStorage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (material as any).instanceVariantStorage = this._instanceVariantStorage;
  }

  /**
   * Set the current animation frame index
   */
  setFrame(value: number): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uniforms = (this.material as any).instancedAnimatedUniforms;
    if (uniforms) {
      uniforms.frameIndex.value = value | 0;
    }
  }

  /**
   * Set the global scale multiplier
   */
  setScale(value: number): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uniforms = (this.material as any).instancedAnimatedUniforms;
    if (uniforms) {
      uniforms.globalScale.value = value;
    }
  }

  /**
   * Set the alpha clamp threshold
   */
  setAlphaClamp(value: number): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uniforms = (this.material as any).instancedAnimatedUniforms;
    if (uniforms) {
      uniforms.alphaClamp.value = value;
    }
  }

  /**
   * Set all instance data at once
   */
  /** Pre-allocated identity matrix for setInstances (avoids allocation per call) */
  private static readonly _identity = new Matrix4();

  setInstances(instances: MobInstanceData[]): void {
    const stateArr = this._instanceStateStorage.value.array as Float32Array;
    const offsetArr = this._instanceOffsetStorage.value.array as Float32Array;
    const variantArr = this._instanceVariantStorage.value.array as Float32Array;
    const flagsArr = this._instanceFlagsStorage.value.array as Float32Array;

    const count = Math.min(instances.length, this._maxInstances);
    this._activeCount = count;

    for (let i = 0; i < count; i++) {
      const inst = instances[i];
      const idx = i * 4;

      stateArr[idx + 0] = inst.position.x;
      stateArr[idx + 1] = inst.position.y;
      stateArr[idx + 2] = inst.position.z;
      stateArr[idx + 3] = inst.yaw;

      offsetArr[i] = inst.animationOffset;
      variantArr[i] = inst.variantIndex;
      flagsArr[i] = inst.visible ? 0 : 2;

      // Identity matrix since GPU handles transforms
      this.setMatrixAt(i, InstancedAnimatedImpostor._identity);
    }

    // Mark remaining as hidden
    for (let i = count; i < this._maxInstances; i++) {
      flagsArr[i] = 2;
    }

    this._instanceStateStorage.value.needsUpdate = true;
    this._instanceOffsetStorage.value.needsUpdate = true;
    this._instanceVariantStorage.value.needsUpdate = true;
    this._instanceFlagsStorage.value.needsUpdate = true;
    this.instanceMatrix.needsUpdate = true;
  }

  /**
   * Update a single instance by index
   * @returns The index if successful, -1 if invalid
   */
  updateInstance(
    indexOrEntityId: number | string,
    data: Partial<MobInstanceData>,
  ): number {
    // Handle entityId (string) by looking up the index
    let index: number;
    if (typeof indexOrEntityId === "string") {
      const foundIndex = this._entityToIndex.get(indexOrEntityId);
      if (foundIndex === undefined) return -1;
      index = foundIndex;
    } else {
      index = indexOrEntityId;
    }

    if (index < 0 || index >= this._maxInstances) return -1;

    const idx = index * 4;
    if (data.position) {
      const stateArr = this._instanceStateStorage.value.array as Float32Array;
      stateArr[idx + 0] = data.position.x;
      stateArr[idx + 1] = data.position.y;
      stateArr[idx + 2] = data.position.z;
      this._instanceStateStorage.value.needsUpdate = true;
    }
    if (data.yaw !== undefined) {
      const stateArr = this._instanceStateStorage.value.array as Float32Array;
      stateArr[idx + 3] = data.yaw;
      this._instanceStateStorage.value.needsUpdate = true;
    }
    if (data.animationOffset !== undefined) {
      const offsetArr = this._instanceOffsetStorage.value.array as Float32Array;
      offsetArr[index] = data.animationOffset;
      this._instanceOffsetStorage.value.needsUpdate = true;
    }
    if (data.variantIndex !== undefined) {
      const variantArr = this._instanceVariantStorage.value
        .array as Float32Array;
      variantArr[index] = data.variantIndex;
      this._instanceVariantStorage.value.needsUpdate = true;
    }
    if (data.visible !== undefined) {
      const flagsArr = this._instanceFlagsStorage.value.array as Float32Array;
      flagsArr[index] = data.visible ? 0 : 2;
      this._instanceFlagsStorage.value.needsUpdate = true;
    }
    return index;
  }

  /**
   * Randomize animation offsets to desync instances
   */
  randomizeAnimationOffsets(): void {
    const offsetArr = this._instanceOffsetStorage.value.array as Float32Array;
    const variantArr = this._instanceVariantStorage.value.array as Float32Array;

    for (let i = 0; i < this._maxInstances; i++) {
      const varIdx = Math.floor(variantArr[i]);
      // _variants is guaranteed non-empty by constructor validation
      const variant = this._variants[varIdx] ?? this._variants[0];
      offsetArr[i] = Math.floor(Math.random() * variant.frameCount);
    }

    this._instanceOffsetStorage.value.needsUpdate = true;
  }

  /**
   * Get the number of active (visible) instances
   */
  get activeCount(): number {
    return this._activeCount;
  }

  /**
   * Alias for activeCount for API compatibility
   */
  get activeInstanceCount(): number {
    return this._activeCount;
  }

  /**
   * Get the maximum instance count
   */
  get maxInstances(): number {
    return this._maxInstances;
  }

  /**
   * Get the variants configuration
   */
  get variants(): MobVariantConfig[] {
    return this._variants;
  }

  // ============================================================================
  // INSTANCE MANAGEMENT API (for AnimatedImpostorManager compatibility)
  // ============================================================================

  /** Tracks entity ID to instance index mapping */
  private _entityToIndex: Map<string, number> = new Map();
  /** Next available instance index */
  private _nextFreeIndex: number = 0;

  /**
   * Add a new instance and return its slot index
   * @param entityId - Unique entity identifier
   * @param data - Instance data
   * @returns Slot index, or -1 if pool is full
   */
  addInstance(entityId: string, data: MobInstanceData): number {
    if (this._nextFreeIndex >= this._maxInstances) {
      return -1; // Pool full
    }

    const index = this._nextFreeIndex++;
    this._entityToIndex.set(entityId, index);
    this.updateInstance(index, data);
    this._activeCount++;
    return index;
  }

  /**
   * Remove an instance by entity ID
   * @param entityId - Entity identifier to remove
   * @returns true if removed, false if not found
   */
  removeInstance(entityId: string): boolean {
    const index = this._entityToIndex.get(entityId);
    if (index === undefined) return false;

    // Mark as hidden
    const flagsArr = this._instanceFlagsStorage.value.array as Float32Array;
    flagsArr[index] = 2;
    this._instanceFlagsStorage.value.needsUpdate = true;

    this._entityToIndex.delete(entityId);
    this._activeCount = Math.max(0, this._activeCount - 1);
    return true;
  }

  /**
   * Check if an instance exists for the given entity ID
   */
  hasInstance(entityId: string): boolean {
    return this._entityToIndex.has(entityId);
  }

  /**
   * Get instance index for an entity ID
   */
  getInstanceIndex(entityId: string): number | undefined {
    return this._entityToIndex.get(entityId);
  }
}
