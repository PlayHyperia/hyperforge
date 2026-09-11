/**
 * AtlasedImpostorManager - Mega-Atlas Impostor System for Diverse Forests
 *
 * Optimizes draw calls by packing multiple tree impostor atlases into a single
 * mega-atlas. All impostors share ONE InstancedMesh, reducing draw calls from
 * N (one per tree type) to 1.
 *
 * @module AtlasedImpostorManager
 *
 * @deprecated NOT CURRENTLY USED - Tree impostors are handled by ProcgenTreeInstancer
 * using TSLImpostorMaterial directly. This class exists for potential future use
 * but is not integrated into the main rendering pipeline.
 * For rocks/plants, use AtlasedRockPlantImpostorManager instead.
 */

import type { Node } from "three/webgpu";
import THREE, {
  uniform,
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  add,
  sub,
  mul,
  div,
  floor,
  uv,
  attribute,
  texture,
  normalize,
  dot,
  clamp,
  pow,
  cameraPosition,
  positionWorld,
  MeshBasicNodeMaterial,
  DataArrayTexture,
} from "../../../extras/three/three";
import type { UniformNode } from "three/webgpu";
import type { World } from "../../../core/World";
import {
  ImpostorManager,
  BakePriority,
  ImpostorBakeMode,
} from "./ImpostorManager";
import type { ImpostorBakeResult } from "@hyperforge/impostor";

// ============================================================================
// CONFIGURATION
// ============================================================================

export const ATLASED_IMPOSTOR_CONFIG = {
  /** 32 slots for tree presets with LRU eviction */
  MAX_SLOTS: 32,
  ATLAS_SIZE: 1024,
  GRID_SIZE_X: 16,
  GRID_SIZE_Y: 8,
  MAX_INSTANCES: 8000,
  /** Eviction delay for slot recycling */
  SLOT_EVICTION_DELAY_MS: 5000,
} as const;

// ============================================================================
// TYPES
// ============================================================================

interface AtlasSlot {
  index: number;
  presetId: string | null;
  lastAccessTime: number;
  loaded: boolean;
}

interface PresetData {
  id: string;
  bakeResult: ImpostorBakeResult | null;
  slotIndex: number;
  width: number;
  height: number;
  bakePromise: Promise<void> | null;
}

interface TreeInstance {
  id: string;
  presetId: string;
  position: THREE.Vector3;
  rotation: number;
  scale: number;
  instanceIndex: number;
}

type SlotCallback = ((slotIndex: number, presetId: string) => void) | null;

// ============================================================================
// ATLASED IMPOSTOR MANAGER
// ============================================================================

export class AtlasedImpostorManager {
  private static instance: AtlasedImpostorManager | null = null;

  private world: World;
  private scene: THREE.Scene | null = null;
  private impostorManager: ImpostorManager;

  // Textures
  private atlasArray: THREE.DataArrayTexture | null = null;
  private normalAtlasArray: THREE.DataArrayTexture | null = null;

  // Data stores
  private slots: AtlasSlot[] = [];
  private presets = new Map<string, PresetData>();
  private instances = new Map<string, TreeInstance>();

  // Instanced rendering
  private instancedMesh: THREE.InstancedMesh | null = null;
  private slotAttr: THREE.InstancedBufferAttribute | null = null;
  private slotIndices: Float32Array;

  // Reusable objects (avoid per-frame allocations)
  private readonly dummy = new THREE.Object3D();
  private readonly zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly tempMatrix = new THREE.Matrix4();
  private readonly tempPosition = new THREE.Vector3();
  private readonly tempScale = new THREE.Vector3();
  private readonly tempQuat = new THREE.Quaternion();
  private readonly lookMatrix = new THREE.Matrix4();
  private readonly raycaster = new THREE.Raycaster();

  // State
  private freeIndices: number[] = [];
  private nextIndex = 0;
  private instanceCount = 0;
  private dirty = false;
  private octMeshData: ImpostorBakeResult["octMeshData"] | null = null;
  private raycastMesh: THREE.Mesh | null = null;

  // View uniforms (cached for shader updates)
  private uFaceIndices: UniformNode<"vec3", THREE.Vector3> | null = null;
  private uFaceWeights: UniformNode<"vec3", THREE.Vector3> | null = null;

  // Lighting uniforms (synced from Environment system)
  private uLightDir: UniformNode<"vec3", THREE.Vector3> | null = null;
  private uLightColor: UniformNode<"vec3", THREE.Vector3> | null = null;
  private uAmbientColor: UniformNode<"vec3", THREE.Vector3> | null = null;

  // Stats & callbacks
  private stats = {
    slotsUsed: 0,
    slotsTotal: ATLASED_IMPOSTOR_CONFIG.MAX_SLOTS,
    instancesVisible: 0,
    presetsRegistered: 0,
    evictions: 0,
    drawCalls: 1,
  };
  private onSlotLoaded: SlotCallback = null;
  private onSlotEvicted: SlotCallback = null;

  private constructor(world: World) {
    this.world = world;
    this.scene = (world.stage?.scene as THREE.Scene) ?? null;
    this.impostorManager = ImpostorManager.getInstance(world);
    this.slotIndices = new Float32Array(ATLASED_IMPOSTOR_CONFIG.MAX_INSTANCES);

    // Initialize slots
    const { MAX_SLOTS } = ATLASED_IMPOSTOR_CONFIG;
    this.slots = Array.from({ length: MAX_SLOTS }, (_, i) => ({
      index: i,
      presetId: null,
      lastAccessTime: 0,
      loaded: false,
    }));
  }

  static getInstance(world: World): AtlasedImpostorManager {
    if (!AtlasedImpostorManager.instance) {
      AtlasedImpostorManager.instance = new AtlasedImpostorManager(world);
    }
    return AtlasedImpostorManager.instance;
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  async init(): Promise<boolean> {
    if (this.atlasArray) return true;

    if (!this.impostorManager.initBaker()) {
      console.warn("[AtlasedImpostorManager] Cannot init: baker not ready");
      return false;
    }

    this.createAtlasArrays();
    this.createInstancedMesh();

    const { MAX_SLOTS, ATLAS_SIZE } = ATLASED_IMPOSTOR_CONFIG;
    console.log(
      `[AtlasedImpostorManager] Init: ${MAX_SLOTS} slots, ${ATLAS_SIZE}x${ATLAS_SIZE}`,
    );
    return true;
  }

  private createAtlasArrays(): void {
    const { MAX_SLOTS, ATLAS_SIZE } = ATLASED_IMPOSTOR_CONFIG;
    const pixelCount = ATLAS_SIZE * ATLAS_SIZE * 4 * MAX_SLOTS;

    // Shared texture config
    // CRITICAL: Mark all textures as LINEAR to prevent WebGPU auto-decode
    // The shader handles gamma decode/encode manually for consistent results
    const configureTexture = (tex: THREE.DataArrayTexture) => {
      tex.format = THREE.RGBAFormat;
      tex.type = THREE.UnsignedByteType;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.LinearSRGBColorSpace; // Prevent auto-decode
      tex.needsUpdate = true;
    };

    // Albedo
    this.atlasArray = new DataArrayTexture(
      new Uint8Array(pixelCount),
      ATLAS_SIZE,
      ATLAS_SIZE,
      MAX_SLOTS,
    );
    configureTexture(this.atlasArray);

    // Normals (initialized to neutral normal)
    const normalData = new Uint8Array(pixelCount);
    for (let i = 0; i < normalData.length; i += 4) {
      normalData[i] = 128;
      normalData[i + 1] = 128;
      normalData[i + 2] = 255;
      normalData[i + 3] = 255;
    }
    this.normalAtlasArray = new DataArrayTexture(
      normalData,
      ATLAS_SIZE,
      ATLAS_SIZE,
      MAX_SLOTS,
    );
    configureTexture(this.normalAtlasArray);
  }

  private createInstancedMesh(): void {
    const { MAX_INSTANCES, GRID_SIZE_X, GRID_SIZE_Y } = ATLASED_IMPOSTOR_CONFIG;

    const geometry = new THREE.PlaneGeometry(1, 1);
    this.slotAttr = new THREE.InstancedBufferAttribute(this.slotIndices, 1);
    this.slotAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("instanceSlot", this.slotAttr);

    const material = this.createMaterial(GRID_SIZE_X, GRID_SIZE_Y);

    this.instancedMesh = new THREE.InstancedMesh(
      geometry,
      material,
      MAX_INSTANCES,
    );
    this.instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.instancedMesh.count = 0;
    this.instancedMesh.frustumCulled = false;
    this.instancedMesh.name = "AtlasedImpostors";
    this.instancedMesh.layers.set(1);

    // Initialize all matrices to zero
    for (let i = 0; i < MAX_INSTANCES; i++) {
      this.instancedMesh.setMatrixAt(i, this.zeroMatrix);
    }

    this.scene?.add(this.instancedMesh);
  }

  private createMaterial(
    gridX: number,
    gridY: number,
  ): THREE.MeshBasicNodeMaterial {
    const material = new MeshBasicNodeMaterial();

    const uGridSize = uniform(new THREE.Vector2(gridX, gridY));
    this.uFaceIndices = uniform(new THREE.Vector3(0, 0, 0));
    this.uFaceWeights = uniform(new THREE.Vector3(0.33, 0.33, 0.34));
    const uAlphaThreshold = uniform(0.5);
    const instanceSlot = attribute<"float">("instanceSlot", "float");
    const atlasArrayTex = this.atlasArray!;
    const normalArrayTex = this.normalAtlasArray!;

    // Lighting uniforms - synced from world Environment system
    this.uLightDir = uniform(new THREE.Vector3(0.5, 0.8, 0.3));
    this.uLightColor = uniform(new THREE.Vector3(1, 1, 1));
    this.uAmbientColor = uniform(new THREE.Vector3(0.4, 0.45, 0.5));

    // Convert flat octahedral index to grid coords
    const flatToCoords = Fn(([idx]: [Node<"float">]) => {
      const row = floor(div(idx, uGridSize.x));
      const col = sub(idx, mul(row, uGridSize.x));
      return vec2(col, row);
    });

    material.colorNode = Fn(() => {
      const billboardUV = uv();
      const slotLayer = floor(instanceSlot);

      // Get the 3 octahedral face cells to blend
      const cellA = flatToCoords(this.uFaceIndices!.x);
      const cellB = flatToCoords(this.uFaceIndices!.y);
      const cellC = flatToCoords(this.uFaceIndices!.z);

      // Compute UVs within atlas grid
      const uvA = div(add(cellA, billboardUV), uGridSize);
      const uvB = div(add(cellB, billboardUV), uGridSize);
      const uvC = div(add(cellC, billboardUV), uGridSize);

      // Sample color atlas (DataArrayTexture - use .depth() for layer)
      const colorA = texture(atlasArrayTex, uvA).depth(slotLayer);
      const colorB = texture(atlasArrayTex, uvB).depth(slotLayer);
      const colorC = texture(atlasArrayTex, uvC).depth(slotLayer);

      // Sample normal atlas
      const normalA = texture(normalArrayTex, uvA).depth(slotLayer);
      const normalB = texture(normalArrayTex, uvB).depth(slotLayer);
      const normalC = texture(normalArrayTex, uvC).depth(slotLayer);

      // Alpha-weighted blending for smooth octahedral transitions
      const wA = mul(this.uFaceWeights!.x, colorA.a);
      const wB = mul(this.uFaceWeights!.y, colorB.a);
      const wC = mul(this.uFaceWeights!.z, colorC.a);
      const totalWeight = add(add(wA, wB), wC);

      // Normalize weights
      const nA = div(wA, totalWeight);
      const nB = div(wB, totalWeight);
      const nC = div(wC, totalWeight);

      // Blend albedo color (still in sRGB-encoded form)
      const albedoSRGB = add(
        add(mul(colorA.xyz, nA), mul(colorB.xyz, nB)),
        mul(colorC.xyz, nC),
      );

      // Decode sRGB to linear for lighting calculations
      const albedoLinear = albedoSRGB.pow(vec3(2.2, 2.2, 2.2));

      // Blend normals (stored as 0-1, decode to -1 to 1)
      const blendedNormalEncoded = add(
        add(mul(normalA.xyz, nA), mul(normalB.xyz, nB)),
        mul(normalC.xyz, nC),
      );
      // Decode: normal = encoded * 2 - 1
      const viewNormal = normalize(
        sub(mul(blendedNormalEncoded, float(2)), vec3(1, 1, 1)),
      );

      // Transform normal from view space to world space
      // N = view direction (from object toward camera)
      // T = tangent (right in view) = cross(worldUp, N)
      // B = bitangent (up in view) = cross(N, T)
      const N = normalize(sub(cameraPosition, positionWorld));
      const worldUp = vec3(0, 1, 0);
      // T = cross(worldUp, N) - right direction in world space
      const T = normalize(
        vec3(
          sub(mul(worldUp.y, N.z), mul(worldUp.z, N.y)),
          sub(mul(worldUp.z, N.x), mul(worldUp.x, N.z)),
          sub(mul(worldUp.x, N.y), mul(worldUp.y, N.x)),
        ),
      );
      // B = cross(N, T) - up direction in view space
      const B = normalize(
        vec3(
          sub(mul(N.y, T.z), mul(N.z, T.y)),
          sub(mul(N.z, T.x), mul(N.x, T.z)),
          sub(mul(N.x, T.y), mul(N.y, T.x)),
        ),
      );
      // Transform: worldNormal = T * viewNormal.x + B * viewNormal.y + N * viewNormal.z
      const worldNormal = normalize(
        add(
          add(mul(T, viewNormal.x), mul(B, viewNormal.y)),
          mul(N, viewNormal.z),
        ),
      );

      // Simple Lambert diffuse lighting (N dot L)
      const L = normalize(this.uLightDir!);
      const NdotL = dot(worldNormal, L);
      // Half-Lambert for softer look on trees
      const diffuseFactor = add(mul(NdotL, float(0.5)), float(0.5));

      // Final lighting = ambient + diffuse * lightColor (in linear space)
      const lighting = add(
        this.uAmbientColor!,
        mul(this.uLightColor!, diffuseFactor),
      );

      // Apply lighting to linear albedo
      const litColorLinear = mul(albedoLinear, lighting);

      // Clamp to prevent HDR blowout
      const clampedLinear = clamp(litColorLinear, vec3(0, 0, 0), vec3(1, 1, 1));

      // Output LINEAR values - the renderer handles sRGB encoding automatically
      // (removing manual pow(0.4545) to avoid double gamma correction)
      return vec4(clampedLinear, totalWeight);
    })();

    material.alphaTestNode = uAlphaThreshold;
    material.transparent = true;
    material.depthWrite = true;
    material.side = THREE.DoubleSide;
    material.alphaTest = 0.1;

    return material;
  }

  // ============================================================================
  // PRESET REGISTRATION
  // ============================================================================

  async registerPreset(
    presetId: string,
    sourceMesh: THREE.Object3D,
  ): Promise<void> {
    const existing = this.presets.get(presetId);
    if (existing) return existing.bakePromise ?? Promise.resolve();

    const box = new THREE.Box3().setFromObject(sourceMesh);
    const size = box.getSize(new THREE.Vector3());

    const preset: PresetData = {
      id: presetId,
      bakeResult: null,
      slotIndex: -1,
      width: Math.max(size.x, size.z),
      height: size.y,
      bakePromise: null,
    };

    this.presets.set(presetId, preset);
    this.stats.presetsRegistered++;

    preset.bakePromise = this.bakePreset(presetId, sourceMesh);
    return preset.bakePromise;
  }

  private async bakePreset(
    presetId: string,
    sourceMesh: THREE.Object3D,
  ): Promise<void> {
    const preset = this.presets.get(presetId);
    if (!preset) return;

    try {
      const { ATLAS_SIZE, GRID_SIZE_X, GRID_SIZE_Y } = ATLASED_IMPOSTOR_CONFIG;
      const result = await this.impostorManager.getOrCreate(
        `atlased_${presetId}_v1`,
        sourceMesh,
        {
          atlasSize: ATLAS_SIZE,
          hemisphere: true,
          priority: BakePriority.NORMAL,
          gridSizeX: GRID_SIZE_X,
          gridSizeY: GRID_SIZE_Y,
          bakeMode: ImpostorBakeMode.STANDARD,
        },
      );

      preset.bakeResult = result;

      if (!this.octMeshData && result.octMeshData) {
        this.octMeshData = result.octMeshData;
        this.setupRaycastMesh();
      }

      console.log(`[AtlasedImpostorManager] Baked: ${presetId}`);
    } catch (err) {
      console.error(
        `[AtlasedImpostorManager] Bake failed for ${presetId}:`,
        err,
      );
    }

    preset.bakePromise = null;
  }

  private setupRaycastMesh(): void {
    if (!this.octMeshData) return;
    const material = new MeshBasicNodeMaterial();
    material.visible = false;
    material.side = THREE.DoubleSide;
    this.raycastMesh = new THREE.Mesh(
      this.octMeshData.filledMesh.geometry,
      material,
    );
  }

  // ============================================================================
  // SLOT MANAGEMENT
  // ============================================================================

  private allocateSlot(presetId: string): number {
    const preset = this.presets.get(presetId);
    if (!preset?.bakeResult) return -1;

    // Already allocated?
    if (preset.slotIndex >= 0) {
      this.slots[preset.slotIndex].lastAccessTime = performance.now();
      return preset.slotIndex;
    }

    // Find empty or evict LRU
    let slotIndex = this.slots.findIndex((s) => s.presetId === null);
    if (slotIndex === -1) {
      slotIndex = this.evictLRUSlot();
      if (slotIndex === -1) {
        console.warn(
          `[AtlasedImpostorManager] No slot available for ${presetId}`,
        );
        return -1;
      }
    }

    // Assign
    const slot = this.slots[slotIndex];
    slot.presetId = presetId;
    slot.lastAccessTime = performance.now();
    slot.loaded = false;
    preset.slotIndex = slotIndex;

    this.uploadAtlasToSlot(presetId, slotIndex);
    this.stats.slotsUsed = this.slots.filter((s) => s.presetId !== null).length;

    console.log(`[AtlasedImpostorManager] Slot ${slotIndex} <- ${presetId}`);
    return slotIndex;
  }

  private evictLRUSlot(): number {
    const now = performance.now();
    const { SLOT_EVICTION_DELAY_MS } = ATLASED_IMPOSTOR_CONFIG;

    let oldest: AtlasSlot | null = null;
    for (const slot of this.slots) {
      if (!slot.presetId) continue;
      if (now - slot.lastAccessTime < SLOT_EVICTION_DELAY_MS) continue;
      if (!oldest || slot.lastAccessTime < oldest.lastAccessTime) {
        oldest = slot;
      }
    }

    if (!oldest) return -1;

    const evictedId = oldest.presetId!;
    const preset = this.presets.get(evictedId);
    if (preset) preset.slotIndex = -1;

    oldest.presetId = null;
    oldest.loaded = false;
    this.stats.evictions++;

    console.log(
      `[AtlasedImpostorManager] Evicted slot ${oldest.index} (${evictedId})`,
    );
    this.onSlotEvicted?.(oldest.index, evictedId);

    return oldest.index;
  }

  /**
   * Check if slots are available for a new preset.
   */
  hasAvailableSlot(): boolean {
    return this.slots.some((s) => s.presetId === null);
  }

  /**
   * Get count of used slots.
   */
  getUsedSlotCount(): number {
    return this.slots.filter((s) => s.presetId !== null).length;
  }

  private uploadAtlasToSlot(presetId: string, slotIndex: number): void {
    const preset = this.presets.get(presetId);
    if (!preset?.bakeResult) {
      console.warn(`[AtlasedImpostorManager] No bake result for ${presetId}`);
      return;
    }

    const {
      renderTarget,
      atlasTexture,
      normalRenderTarget,
      normalAtlasTexture,
    } = preset.bakeResult;

    // Diagnostic: log what we have
    console.log(
      `[AtlasedImpostorManager] Upload ${presetId} to slot ${slotIndex}: ` +
        `hasRT=${renderTarget !== null}, hasNormalRT=${normalRenderTarget !== undefined && normalRenderTarget !== null}, ` +
        `hasTex=${atlasTexture !== undefined}, hasNormalTex=${normalAtlasTexture !== undefined}`,
    );

    // When loaded from IndexedDB cache, renderTarget is null but atlasTexture exists
    // We need to handle both cases: fresh bake (renderTarget) and cached (atlasTexture)
    const hasRenderTarget = renderTarget !== null;

    if (hasRenderTarget) {
      // Fresh bake - read from render targets
      const graphics = this.world.graphics as
        { renderer?: THREE.WebGPURenderer } | undefined;
      const renderer = graphics?.renderer;
      if (!renderer) {
        console.warn(`[AtlasedImpostorManager] No renderer`);
        return;
      }

      this.readAndUploadAtlas(renderer, renderTarget, slotIndex, "albedo")
        .then(() =>
          normalRenderTarget
            ? this.readAndUploadAtlas(
                renderer,
                normalRenderTarget,
                slotIndex,
                "normal",
              )
            : null,
        )
        .then(() => {
          this.slots[slotIndex].loaded = true;
          console.log(
            `[AtlasedImpostorManager] Uploaded slot ${slotIndex} from render target (${presetId})`,
          );
          this.onSlotLoaded?.(slotIndex, presetId);
        })
        .catch((err) =>
          console.error(`[AtlasedImpostorManager] Upload failed:`, err),
        );
    } else if (atlasTexture) {
      // Loaded from cache - copy from textures
      this.uploadTextureToSlot(atlasTexture, slotIndex, "albedo")
        .then(() =>
          normalAtlasTexture
            ? this.uploadTextureToSlot(normalAtlasTexture, slotIndex, "normal")
            : null,
        )
        .then(() => {
          this.slots[slotIndex].loaded = true;
          console.log(
            `[AtlasedImpostorManager] Uploaded slot ${slotIndex} from cached texture (${presetId})`,
          );
          this.onSlotLoaded?.(slotIndex, presetId);
        })
        .catch((err) =>
          console.error(`[AtlasedImpostorManager] Texture upload failed:`, err),
        );
    } else {
      console.warn(
        `[AtlasedImpostorManager] No render target or texture for ${presetId}`,
      );
    }
  }

  /**
   * Upload a cached texture to the atlas array (when loaded from IndexedDB).
   */
  private async uploadTextureToSlot(
    texture: THREE.Texture,
    slotIndex: number,
    type: "albedo" | "normal",
  ): Promise<void> {
    const { ATLAS_SIZE } = ATLASED_IMPOSTOR_CONFIG;
    const targetArray =
      type === "albedo" ? this.atlasArray : this.normalAtlasArray;
    if (!targetArray) return;

    const data = targetArray.image.data as Uint8Array;
    const layerOffset = slotIndex * ATLAS_SIZE * ATLAS_SIZE * 4;

    // Get pixel data from texture
    const canvas = document.createElement("canvas");
    const textureImage = texture.image as
      { width?: number; height?: number } | undefined;
    const texWidth = textureImage?.width ?? ATLAS_SIZE;
    const texHeight = textureImage?.height ?? ATLAS_SIZE;
    canvas.width = texWidth;
    canvas.height = texHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      console.warn(`[AtlasedImpostorManager] Cannot get 2D context`);
      return;
    }

    // Draw texture to canvas
    if (
      texture.image instanceof HTMLImageElement ||
      texture.image instanceof HTMLCanvasElement ||
      texture.image instanceof ImageBitmap
    ) {
      ctx.drawImage(texture.image, 0, 0);
    } else {
      console.warn(`[AtlasedImpostorManager] Unsupported texture image type`);
      return;
    }

    const imageData = ctx.getImageData(0, 0, texWidth, texHeight);
    const pixels = imageData.data;

    // Copy with Y flip to match render target convention
    for (let y = 0; y < texHeight && y < ATLAS_SIZE; y++) {
      for (let x = 0; x < texWidth && x < ATLAS_SIZE; x++) {
        const srcIdx = ((texHeight - y - 1) * texWidth + x) * 4;
        const dstIdx = layerOffset + (y * ATLAS_SIZE + x) * 4;
        data[dstIdx] = pixels[srcIdx];
        data[dstIdx + 1] = pixels[srcIdx + 1];
        data[dstIdx + 2] = pixels[srcIdx + 2];
        data[dstIdx + 3] = pixels[srcIdx + 3];
      }
    }

    targetArray.needsUpdate = true;
  }

  private async readAndUploadAtlas(
    renderer: THREE.WebGPURenderer,
    renderTarget: THREE.RenderTarget,
    slotIndex: number,
    type: "albedo" | "normal",
  ): Promise<void> {
    const { ATLAS_SIZE } = ATLASED_IMPOSTOR_CONFIG;
    const { width, height } = renderTarget;

    type AsyncRenderer = THREE.WebGPURenderer & {
      readRenderTargetPixelsAsync?: (
        rt: THREE.RenderTarget,
        x: number,
        y: number,
        w: number,
        h: number,
      ) => Promise<Uint8Array | Float32Array>;
    };

    const asyncRenderer = renderer as AsyncRenderer;
    if (!asyncRenderer.readRenderTargetPixelsAsync) {
      console.warn(`[AtlasedImpostorManager] Async read not available`);
      return;
    }

    const result = await asyncRenderer.readRenderTargetPixelsAsync(
      renderTarget,
      0,
      0,
      width,
      height,
    );
    let pixels: Uint8Array;

    if (result instanceof Uint8Array) {
      pixels = result;
    } else {
      // Convert any other typed array (Float32Array, etc.) to Uint8Array
      pixels = new Uint8Array(result.length);
      for (let i = 0; i < result.length; i++) {
        pixels[i] = Math.min(
          255,
          Math.max(0, Math.round(Number(result[i]) * 255)),
        );
      }
    }

    // Diagnostic: count non-zero and non-neutral pixels
    let nonZeroCount = 0;
    let nonNeutralNormalCount = 0;
    const totalPixels = width * height;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const a = pixels[i + 3];
      if (r > 0 || g > 0 || b > 0 || a > 0) nonZeroCount++;
      // For normals, check if not neutral (128,128,255)
      if (type === "normal" && (r !== 128 || g !== 128 || b !== 255)) {
        nonNeutralNormalCount++;
      }
    }
    const coverage = ((nonZeroCount / totalPixels) * 100).toFixed(1);
    if (type === "normal") {
      const normalVariation = (
        (nonNeutralNormalCount / totalPixels) *
        100
      ).toFixed(1);
      console.log(
        `[AtlasedImpostorManager] Read ${type} slot ${slotIndex}: ${coverage}% coverage, ${normalVariation}% normal variation`,
      );
    } else {
      console.log(
        `[AtlasedImpostorManager] Read ${type} slot ${slotIndex}: ${coverage}% coverage`,
      );
    }

    const targetArray =
      type === "albedo" ? this.atlasArray : this.normalAtlasArray;
    if (!targetArray) return;

    const data = targetArray.image.data as Uint8Array;
    const layerOffset = slotIndex * ATLAS_SIZE * ATLAS_SIZE * 4;

    // Copy with Y flip
    for (let y = 0; y < height && y < ATLAS_SIZE; y++) {
      for (let x = 0; x < width && x < ATLAS_SIZE; x++) {
        const srcIdx = ((height - y - 1) * width + x) * 4;
        const dstIdx = layerOffset + (y * ATLAS_SIZE + x) * 4;
        data[dstIdx] = pixels[srcIdx];
        data[dstIdx + 1] = pixels[srcIdx + 1];
        data[dstIdx + 2] = pixels[srcIdx + 2];
        data[dstIdx + 3] = pixels[srcIdx + 3];
      }
    }

    targetArray.needsUpdate = true;
  }

  // ============================================================================
  // INSTANCE MANAGEMENT
  // ============================================================================

  addInstance(
    presetId: string,
    instanceId: string,
    position: THREE.Vector3,
    rotation: number,
    scale: number,
  ): boolean {
    if (this.instances.has(instanceId)) return false;

    const preset = this.presets.get(presetId);
    if (!preset) {
      console.warn(`[AtlasedImpostorManager] Unknown preset: ${presetId}`);
      return false;
    }

    const instance: TreeInstance = {
      id: instanceId,
      presetId,
      position: position.clone(),
      rotation,
      scale,
      instanceIndex: -1,
    };

    this.instances.set(instanceId, instance);

    // Allocate slot if bake ready but not slotted
    if (preset.bakeResult && preset.slotIndex < 0) {
      this.allocateSlot(presetId);
    }

    // Show if slot loaded
    if (preset.slotIndex >= 0 && this.slots[preset.slotIndex].loaded) {
      this.showInstance(instance);
    }

    return true;
  }

  removeInstance(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    this.hideInstance(instance);
    this.instances.delete(instanceId);
  }

  private showInstance(instance: TreeInstance): void {
    if (!this.instancedMesh || instance.instanceIndex >= 0) return;

    const preset = this.presets.get(instance.presetId);
    if (!preset || preset.slotIndex < 0) return;

    const idx = this.freeIndices.pop() ?? this.nextIndex++;
    if (idx >= ATLASED_IMPOSTOR_CONFIG.MAX_INSTANCES) {
      console.warn(`[AtlasedImpostorManager] Max instances`);
      return;
    }

    instance.instanceIndex = idx;

    // Set transform
    this.dummy.position.copy(instance.position);
    this.dummy.position.y += preset.height * instance.scale * 0.5;
    this.dummy.rotation.set(0, 0, 0);
    this.dummy.scale.set(
      preset.width * instance.scale,
      preset.height * instance.scale,
      1,
    );
    this.dummy.updateMatrix();
    this.instancedMesh.setMatrixAt(idx, this.dummy.matrix);

    // Set slot attribute
    this.slotIndices[idx] = preset.slotIndex;
    if (this.slotAttr) {
      this.slotAttr.setX(idx, preset.slotIndex);
      this.slotAttr.needsUpdate = true;
    }

    this.instanceCount = Math.max(this.instanceCount, idx + 1);
    this.instancedMesh.count = this.instanceCount;
    this.dirty = true;
    this.slots[preset.slotIndex].lastAccessTime = performance.now();
  }

  private hideInstance(instance: TreeInstance): void {
    if (!this.instancedMesh || instance.instanceIndex < 0) return;

    this.instancedMesh.setMatrixAt(instance.instanceIndex, this.zeroMatrix);
    this.freeIndices.push(instance.instanceIndex);
    instance.instanceIndex = -1;
    this.dirty = true;
  }

  // ============================================================================
  // UPDATE LOOP
  // ============================================================================

  update(camera: THREE.Camera): void {
    if (!this.instancedMesh) return;

    this.updateViewSampling(camera);
    this.updateBillboarding(camera);
    this.checkPendingPresets();

    if (this.dirty) {
      this.instancedMesh.instanceMatrix.needsUpdate = true;
      this.dirty = false;
    }

    this.stats.instancesVisible = this.instanceCount;
  }

  /**
   * Update lighting from environment system.
   */
  updateLighting(
    lightDir: THREE.Vector3,
    lightColor: THREE.Vector3,
    ambientColor: THREE.Vector3,
  ): void {
    // Warn once if uniforms are missing (material not yet created)
    if (!this.uLightDir || !this.uLightColor || !this.uAmbientColor) {
      // Uniforms are created when material is created, which happens on init
      // This is expected early in startup before the instanced mesh exists
      return;
    }
    this.uLightDir.value.copy(lightDir);
    this.uLightColor.value.copy(lightColor);
    this.uAmbientColor.value.copy(ambientColor);
  }

  private updateViewSampling(camera: THREE.Camera): void {
    if (!this.raycastMesh || !this.uFaceIndices || !this.uFaceWeights) return;

    const viewDir = this.tempPosition
      .set(0, 0, 0)
      .sub(camera.position)
      .normalize();
    this.raycaster.ray.origin.copy(viewDir).multiplyScalar(2);
    this.raycaster.ray.direction.copy(viewDir).negate();

    const hits = this.raycaster.intersectObject(this.raycastMesh, false);
    if (hits.length > 0 && hits[0].face && hits[0].barycoord) {
      const { face, barycoord } = hits[0];
      this.uFaceIndices.value.set(face.a, face.b, face.c);
      this.uFaceWeights.value.copy(barycoord);
    }
  }

  private updateBillboarding(camera: THREE.Camera): void {
    if (!this.instancedMesh) return;

    // Calculate billboard quaternion once
    this.lookMatrix.lookAt(
      camera.position,
      this.tempPosition.set(0, 0, 0),
      THREE.Object3D.DEFAULT_UP,
    );
    this.tempQuat.setFromRotationMatrix(this.lookMatrix);

    for (const instance of this.instances.values()) {
      if (instance.instanceIndex < 0) continue;

      this.instancedMesh.getMatrixAt(instance.instanceIndex, this.tempMatrix);
      this.tempMatrix.decompose(
        this.tempPosition,
        new THREE.Quaternion(),
        this.tempScale,
      );
      this.tempMatrix.compose(this.tempPosition, this.tempQuat, this.tempScale);
      this.instancedMesh.setMatrixAt(instance.instanceIndex, this.tempMatrix);
    }

    this.dirty = true;
  }

  private checkPendingPresets(): void {
    for (const [presetId, preset] of this.presets) {
      // Allocate slot if bake ready but not slotted and has instances
      if (preset.bakeResult && preset.slotIndex < 0) {
        const hasInstances = [...this.instances.values()].some(
          (i) => i.presetId === presetId,
        );
        if (hasInstances) this.allocateSlot(presetId);
      }

      // Show hidden instances if slot is loaded
      if (preset.slotIndex >= 0 && this.slots[preset.slotIndex].loaded) {
        for (const instance of this.instances.values()) {
          if (instance.presetId === presetId && instance.instanceIndex < 0) {
            this.showInstance(instance);
          }
        }
      }
    }
  }

  // ============================================================================
  // PUBLIC API
  // ============================================================================

  getStats() {
    return { ...this.stats };
  }
  hasSlot(presetId: string) {
    return (this.presets.get(presetId)?.slotIndex ?? -1) >= 0;
  }
  getSlot(presetId: string) {
    return this.presets.get(presetId)?.slotIndex ?? -1;
  }
  setOnSlotLoaded(cb: SlotCallback) {
    this.onSlotLoaded = cb;
  }
  setOnSlotEvicted(cb: SlotCallback) {
    this.onSlotEvicted = cb;
  }

  areSlotsReady(): boolean {
    return this.slots.every((s) => s.presetId === null || s.loaded);
  }

  getSlotInfo() {
    const now = performance.now();
    return this.slots.map((s) => ({
      index: s.index,
      presetId: s.presetId,
      loaded: s.loaded,
      ageMs: Math.round(now - s.lastAccessTime),
    }));
  }

  /**
   * Print diagnostic info about atlas state for debugging.
   */
  printDiagnostics(): void {
    const { ATLAS_SIZE } = ATLASED_IMPOSTOR_CONFIG;
    console.log("=== AtlasedImpostorManager Diagnostics ===");
    console.log(
      `Instances: ${this.instanceCount}/${ATLASED_IMPOSTOR_CONFIG.MAX_INSTANCES}`,
    );
    console.log(`Presets registered: ${this.presets.size}`);
    console.log(`Slots used: ${this.stats.slotsUsed}/${this.stats.slotsTotal}`);
    console.log(
      `Lighting uniforms: lightDir=${!!this.uLightDir}, lightColor=${!!this.uLightColor}, ambient=${!!this.uAmbientColor}`,
    );

    // Check atlas array content
    if (this.atlasArray) {
      const data = this.atlasArray.image.data as Uint8Array;
      let nonZeroLayers = 0;
      for (let layer = 0; layer < ATLASED_IMPOSTOR_CONFIG.MAX_SLOTS; layer++) {
        const offset = layer * ATLAS_SIZE * ATLAS_SIZE * 4;
        let hasContent = false;
        for (
          let i = 0;
          i < ATLAS_SIZE * ATLAS_SIZE * 4 && !hasContent;
          i += 100
        ) {
          if (data[offset + i] > 0) hasContent = true;
        }
        if (hasContent) nonZeroLayers++;
      }
      console.log(`Color atlas: ${nonZeroLayers} layers with content`);
    }

    if (this.normalAtlasArray) {
      const data = this.normalAtlasArray.image.data as Uint8Array;
      let nonNeutralLayers = 0;
      for (let layer = 0; layer < ATLASED_IMPOSTOR_CONFIG.MAX_SLOTS; layer++) {
        const offset = layer * ATLAS_SIZE * ATLAS_SIZE * 4;
        let hasVariation = false;
        for (
          let i = 0;
          i < ATLAS_SIZE * ATLAS_SIZE * 4 && !hasVariation;
          i += 400
        ) {
          const r = data[offset + i];
          const g = data[offset + i + 1];
          const b = data[offset + i + 2];
          // Check if not neutral (128,128,255)
          if (r !== 128 || g !== 128 || b !== 255) hasVariation = true;
        }
        if (hasVariation) nonNeutralLayers++;
      }
      console.log(
        `Normal atlas: ${nonNeutralLayers} layers with normal variation`,
      );
    }

    // List loaded slots
    const loadedSlots = this.slots.filter((s) => s.loaded);
    console.log(
      `Loaded slots: ${loadedSlots.map((s) => `${s.index}:${s.presetId}`).join(", ") || "none"}`,
    );
    console.log("==========================================");
  }

  dispose(): void {
    if (this.instancedMesh) {
      this.instancedMesh.parent?.remove(this.instancedMesh);
      this.instancedMesh.geometry.dispose();
      this.instancedMesh.dispose();
    }
    this.atlasArray?.dispose();
    this.normalAtlasArray?.dispose();
    this.instances.clear();
    this.presets.clear();
    this.slots = [];
    AtlasedImpostorManager.instance = null;
    console.log("[AtlasedImpostorManager] Disposed");
  }
}

export default AtlasedImpostorManager;
