/**
 * DynamicBuildingImpostorAtlas - Slot-Based Dynamic Impostor Atlas System
 *
 * Manages a fixed-size atlas (2048x2048) with 16 slots (4x4 grid, 512x512 each)
 * for rendering building impostors efficiently with a single draw call.
 *
 * **Architecture:**
 * - Fixed 16-slot atlas eliminates per-town complexity
 * - Dynamically assigns buildings to slots based on distance/visibility
 * - Blits individual building impostor textures into slots on assignment
 * - Uses InstancedMesh with per-instance slot IDs for efficient rendering
 *
 * **Slot Management:**
 * - Buildings scored by: distance to camera + frustum visibility
 * - Top 16 buildings assigned to slots
 * - LRU eviction when buildings leave impostor range
 * - Hysteresis prevents slot thrashing at boundaries
 *
 * **Performance:**
 * - 1 draw call for all building impostors (vs N draw calls)
 * - 2 texture binds (color + normal atlas)
 * - Only blits textures when slot assignments change
 *
 * @module DynamicBuildingImpostorAtlas
 */

import THREE, {
  Fn,
  attribute,
  cameraPosition,
  float,
  floor,
  modelWorldMatrix,
  normalize,
  positionLocal,
  sub,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  mul,
  add,
  div,
  mod,
  abs,
  clamp,
  pow,
  If,
} from "../../../extras/three/three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { varying } from "three/tsl";
import type { ImpostorBakeResult } from "@hyperforge/impostor";
import type { World } from "../../../types";

// ============================================================================
// CONFIGURATION
// ============================================================================

export const DYNAMIC_ATLAS_CONFIG = {
  /** Maximum buildings in atlas (4x4 grid = 16 slots) */
  maxBuildings: 16,
  /** Size of combined atlas texture */
  atlasSize: 2048,
  /** Size per building slot (must match individual bake size) */
  slotSize: 512,
  /** Grid arrangement (sqrt of maxBuildings) */
  slotsPerRow: 4,
  /** Prioritize buildings in front of camera (frustum bias) */
  frustumBias: 1000,
  /** Minimum frames before evicting a slot (prevents thrashing) */
  minSlotLifetime: 30,
  /** Hysteresis distance for slot assignment (meters) */
  hysteresisDistance: 5,
  /** Default octahedral grid size (must match bake config) */
  defaultGridSizeX: 16,
  defaultGridSizeY: 8,
} as const;

// ============================================================================
// TYPES
// ============================================================================

/**
 * Building data required for atlas management
 */
export interface AtlasBuildingData {
  buildingId: string;
  position: THREE.Vector3;
  dimensions: THREE.Vector3;
  impostorBakeResult?: ImpostorBakeResult;
  lodLevel: 0 | 1 | 2 | 3;
}

/**
 * Slot assignment data
 */
interface SlotAssignment {
  buildingId: string;
  building: AtlasBuildingData;
  assignedFrame: number;
  lastUsedFrame: number;
  needsBlit: boolean;
}

/**
 * Scored building candidate for slot assignment
 */
interface ScoredBuilding {
  building: AtlasBuildingData;
  score: number;
  distanceSq: number;
  inFrustum: boolean;
}

// ============================================================================
// DYNAMIC BUILDING IMPOSTOR ATLAS
// ============================================================================

export class DynamicBuildingImpostorAtlas {
  private world: World;

  // GPU Resources - use generic RenderTarget (works with WebGPU)
  private colorAtlas: THREE.RenderTarget;
  private normalAtlas: THREE.RenderTarget;
  private instancedMesh: THREE.InstancedMesh;
  private material: THREE.Material;

  // Slot Management
  private slots: (SlotAssignment | null)[];
  private buildingToSlot: Map<string, number>;
  private frameCount: number = 0;

  // Per-Instance Attributes
  private instanceSlotIds: THREE.InstancedBufferAttribute;
  private instanceGridSizes: THREE.InstancedBufferAttribute;
  private instanceScales: THREE.InstancedBufferAttribute;

  // Active buildings this frame
  private activeBuildings: Map<string, AtlasBuildingData> = new Map();
  private visibleCount: number = 0;

  // Uniforms
  private lightDirUniform: THREE.Uniform<THREE.Vector3>;
  private lightColorUniform: THREE.Uniform<THREE.Vector3>;
  private ambientColorUniform: THREE.Uniform<THREE.Vector3>;

  // Temp objects (avoid allocations)
  private _tempMatrix = new THREE.Matrix4();
  private _tempVec = new THREE.Vector3();
  private _tempQuat = new THREE.Quaternion();
  private _tempScale = new THREE.Vector3();
  private _frustum = new THREE.Frustum();
  private _projScreenMatrix = new THREE.Matrix4();

  // Debug
  private debugEnabled = false;

  constructor(world: World) {
    this.world = world;

    // Initialize slot array
    this.slots = new Array(DYNAMIC_ATLAS_CONFIG.maxBuildings).fill(null);
    this.buildingToSlot = new Map();

    // Create atlas render targets (WebGPU-compatible)
    // CRITICAL: Mark color atlas as LINEAR to prevent WebGPU auto-decode
    // The shader handles gamma decode/encode manually for consistent results
    this.colorAtlas = new THREE.RenderTarget(
      DYNAMIC_ATLAS_CONFIG.atlasSize,
      DYNAMIC_ATLAS_CONFIG.atlasSize,
      {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: true,
      },
    );
    this.colorAtlas.texture.colorSpace = THREE.LinearSRGBColorSpace; // Manual gamma in shader
    this.colorAtlas.texture.name = "DynamicImpostorAtlas_Color";

    this.normalAtlas = new THREE.RenderTarget(
      DYNAMIC_ATLAS_CONFIG.atlasSize,
      DYNAMIC_ATLAS_CONFIG.atlasSize,
      {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
      },
    );
    this.normalAtlas.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.normalAtlas.texture.name = "DynamicImpostorAtlas_Normal";

    // Initialize uniforms
    this.lightDirUniform = new THREE.Uniform(
      new THREE.Vector3(0.5, 0.8, 0.3).normalize(),
    );
    this.lightColorUniform = new THREE.Uniform(
      new THREE.Vector3(1, 0.98, 0.95),
    );
    this.ambientColorUniform = new THREE.Uniform(
      new THREE.Vector3(0.5, 0.55, 0.65),
    );

    // Create material and instanced mesh
    this.material = this.createAtlasMaterial();
    this.world.setupMaterial?.(this.material);

    const geometry = this.createInstancedGeometry();
    this.instancedMesh = new THREE.InstancedMesh(
      geometry,
      this.material,
      DYNAMIC_ATLAS_CONFIG.maxBuildings,
    );
    this.instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.instancedMesh.frustumCulled = false;
    this.instancedMesh.visible = false;
    this.instancedMesh.count = 0;
    this.instancedMesh.name = "DynamicBuildingImpostorAtlas";

    // Get instanced attributes from geometry
    this.instanceSlotIds = geometry.getAttribute(
      "aSlotId",
    ) as THREE.InstancedBufferAttribute;
    this.instanceGridSizes = geometry.getAttribute(
      "aGridSize",
    ) as THREE.InstancedBufferAttribute;
    this.instanceScales = geometry.getAttribute(
      "aScale",
    ) as THREE.InstancedBufferAttribute;
  }

  /**
   * Create geometry with per-instance attributes
   */
  private createInstancedGeometry(): THREE.BufferGeometry {
    // Unit plane geometry
    const geometry = new THREE.PlaneGeometry(1, 1);

    // Per-instance: slot ID (0-15)
    const slotIds = new Float32Array(DYNAMIC_ATLAS_CONFIG.maxBuildings);
    const slotIdAttr = new THREE.InstancedBufferAttribute(slotIds, 1);
    slotIdAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aSlotId", slotIdAttr);

    // Per-instance: grid size (gridSizeX, gridSizeY)
    const gridSizes = new Float32Array(DYNAMIC_ATLAS_CONFIG.maxBuildings * 2);
    const gridSizeAttr = new THREE.InstancedBufferAttribute(gridSizes, 2);
    gridSizeAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aGridSize", gridSizeAttr);

    // Per-instance: scale (width, height)
    const scales = new Float32Array(DYNAMIC_ATLAS_CONFIG.maxBuildings * 2);
    const scaleAttr = new THREE.InstancedBufferAttribute(scales, 2);
    scaleAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aScale", scaleAttr);

    return geometry;
  }

  /**
   * Create TSL material for atlased octahedral sampling with proper lit impostors.
   *
   * Features:
   * - 3-view octahedral blending for smooth view transitions
   * - Normal atlas sampling with world-space transformation
   * - Half-Lambert diffuse lighting for soft appearance
   * - Responds to light direction, color, and ambient from Environment system
   */
  private createAtlasMaterial(): THREE.Material {
    // Store references for texture sampling
    const colorAtlasTex = this.colorAtlas.texture;
    const normalAtlasTex = this.normalAtlas.texture;

    // Lighting uniforms
    const uLightDir = uniform(this.lightDirUniform.value);
    const uLightColor = uniform(this.lightColorUniform.value);
    const uAmbientColor = uniform(this.ambientColorUniform.value);

    // Per-instance attributes
    const slotId = attribute("aSlotId");
    const gridSize = attribute("aGridSize"); // vec2(gridSizeX, gridSizeY)

    // Varyings
    const vSlotId = varying(float(0), "vSlotId");
    const vGridSize = varying(vec2(16, 8), "vGridSize");
    const vViewDir = varying(vec3(0, 0, 1), "vViewDir");
    const vWorldPos = varying(vec3(0, 0, 0), "vWorldPos");

    // Vertex shader
    const vertexNode = Fn(() => {
      // Pass through slot ID and grid size
      vSlotId.assign(slotId);
      vGridSize.assign(gridSize);

      // Calculate view direction and world position
      const worldPos = modelWorldMatrix.mul(vec4(positionLocal, 1.0)).xyz;
      const viewDir = normalize(sub(cameraPosition, worldPos));
      vViewDir.assign(viewDir);
      vWorldPos.assign(worldPos);

      // Standard position output (matrix transform handles billboard rotation)
      return positionLocal;
    })();

    // Fragment shader: 3-view octahedral blending with proper lighting
    const fragmentNode = Fn(() => {
      // Hemisphere octahedral mapping: convert view direction to octahedron coordinates
      const viewDir = normalize(vViewDir);
      const gridSizeX = vGridSize.x;
      const gridSizeY = vGridSize.y;

      // Project to octahedron (hemisphere: y is always positive for top half)
      const t = add(abs(viewDir.x), add(abs(viewDir.y), abs(viewDir.z)));
      const octX = div(viewDir.x, t);
      const octZ = div(viewDir.z, t);

      // Map to 0-1 range for atlas sampling
      const octU = add(mul(octX, 0.5), 0.5);
      const octV = add(mul(octZ, 0.5), 0.5);

      // Convert to cell coordinates (continuous)
      const cellXf = mul(octU, gridSizeX);
      const cellYf = mul(octV, gridSizeY);

      // Get 3 nearest cells for blending (center and two neighbors)
      // Cell A: floor cell
      const cellAx = clamp(floor(cellXf), 0, sub(gridSizeX, 1));
      const cellAy = clamp(floor(cellYf), 0, sub(gridSizeY, 1));
      // Cell B: x+1
      const cellBx = clamp(add(cellAx, 1), 0, sub(gridSizeX, 1));
      const cellBy = cellAy;
      // Cell C: y+1
      const cellCx = cellAx;
      const cellCy = clamp(add(cellAy, 1), 0, sub(gridSizeY, 1));

      // Barycentric weights based on fractional position
      const fracX = sub(cellXf, floor(cellXf));
      const fracY = sub(cellYf, floor(cellYf));
      // Simple bilinear-ish weights for 3 cells
      const wA = mul(sub(1, fracX), sub(1, fracY));
      const wB = mul(fracX, sub(1, fracY));
      const wC = mul(sub(1, fracX), fracY);

      // Slot position in atlas (4x4 grid, each slot is 0.25 of atlas)
      const slotCol = mod(vSlotId, float(DYNAMIC_ATLAS_CONFIG.slotsPerRow));
      const slotRow = floor(
        div(vSlotId, float(DYNAMIC_ATLAS_CONFIG.slotsPerRow)),
      );
      const slotOffsetU = mul(slotCol, 0.25);
      const slotOffsetV = mul(slotRow, 0.25);

      // Cell size within slot
      const cellSizeU = div(0.25, gridSizeX);
      const cellSizeV = div(0.25, gridSizeY);

      // Local UV within cell (from geometry UVs)
      const localU = mul(uv().x, cellSizeU);
      const localV = mul(uv().y, cellSizeV);

      // Compute atlas UVs for each cell
      const atlasUV_A = vec2(
        add(slotOffsetU, add(mul(cellAx, cellSizeU), localU)),
        add(slotOffsetV, add(mul(cellAy, cellSizeV), localV)),
      );
      const atlasUV_B = vec2(
        add(slotOffsetU, add(mul(cellBx, cellSizeU), localU)),
        add(slotOffsetV, add(mul(cellBy, cellSizeV), localV)),
      );
      const atlasUV_C = vec2(
        add(slotOffsetU, add(mul(cellCx, cellSizeU), localU)),
        add(slotOffsetV, add(mul(cellCy, cellSizeV), localV)),
      );

      // Sample color atlas from 3 cells
      const colorA = texture(colorAtlasTex, atlasUV_A);
      const colorB = texture(colorAtlasTex, atlasUV_B);
      const colorC = texture(colorAtlasTex, atlasUV_C);

      // Sample normal atlas from 3 cells
      const normalA = texture(normalAtlasTex, atlasUV_A);
      const normalB = texture(normalAtlasTex, atlasUV_B);
      const normalC = texture(normalAtlasTex, atlasUV_C);

      // Alpha-weighted blending for smooth transitions
      const wA_alpha = mul(wA, colorA.a);
      const wB_alpha = mul(wB, colorB.a);
      const wC_alpha = mul(wC, colorC.a);
      const totalWeight = add(add(wA_alpha, wB_alpha), wC_alpha);

      // Normalize weights
      const nA = div(wA_alpha, totalWeight);
      const nB = div(wB_alpha, totalWeight);
      const nC = div(wC_alpha, totalWeight);

      // Blend colors (still in sRGB-encoded form)
      const blendedColorSRGB = add(
        add(mul(colorA.xyz, nA), mul(colorB.xyz, nB)),
        mul(colorC.xyz, nC),
      );

      // Decode sRGB to linear for lighting calculations
      const blendedColorLinear = blendedColorSRGB.pow(vec3(2.2, 2.2, 2.2));

      // Blend and decode normals (stored as 0-1, decode to -1 to 1)
      const blendedNormalEncoded = add(
        add(mul(normalA.xyz, nA), mul(normalB.xyz, nB)),
        mul(normalC.xyz, nC),
      );
      const viewNormal = normalize(
        sub(mul(blendedNormalEncoded, 2.0), vec3(1, 1, 1)),
      );

      // Transform normal from view-space to world-space using TBN matrix
      // N = view direction (from object toward camera)
      // T = tangent (right direction) = cross(worldUp, N)
      // B = bitangent (up direction) = cross(N, T)
      const N = normalize(vViewDir);
      const worldUp = vec3(0, 1, 0);
      // T = cross(worldUp, N)
      const T = normalize(
        vec3(
          sub(mul(worldUp.y, N.z), mul(worldUp.z, N.y)),
          sub(mul(worldUp.z, N.x), mul(worldUp.x, N.z)),
          sub(mul(worldUp.x, N.y), mul(worldUp.y, N.x)),
        ),
      );
      // B = cross(N, T)
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

      // Half-Lambert diffuse lighting for softer appearance
      // Maps N·L from [-1,1] to [0.25, 1.0] to avoid harsh shadows
      const L = normalize(uLightDir);
      const NdotL = worldNormal.dot(L);
      const halfLambert = add(mul(NdotL, float(0.5)), float(0.5));
      const diffuseFactor = add(mul(halfLambert, float(0.75)), float(0.25));

      // Final lighting = ambient + diffuse * lightColor (in linear space)
      const lighting = add(uAmbientColor, mul(uLightColor, diffuseFactor));

      // Apply lighting to linear color
      const litColorLinear = mul(blendedColorLinear, lighting);

      // Clamp to prevent HDR blowout
      const clampedLinear = clamp(litColorLinear, vec3(0, 0, 0), vec3(1, 1, 1));

      // Output LINEAR values - the renderer handles sRGB encoding automatically
      // (removing manual pow(0.4545) to avoid double gamma correction)
      const finalColor = vec4(
        clampedLinear.x,
        clampedLinear.y,
        clampedLinear.z,
        totalWeight,
      );

      // Alpha test
      If(totalWeight.lessThan(0.1), () => {
        return vec4(0, 0, 0, 0);
      });

      return finalColor;
    })();

    const material = new MeshStandardNodeMaterial();
    material.vertexNode = vertexNode;
    material.colorNode = fragmentNode;
    material.transparent = true;
    material.depthWrite = true;
    material.side = THREE.DoubleSide;
    material.alphaTest = 0.1;

    return material;
  }

  /**
   * Get the instanced mesh (add to scene)
   */
  getMesh(): THREE.InstancedMesh {
    return this.instancedMesh;
  }

  /**
   * Update lighting uniforms to match scene
   */
  updateLighting(
    lightDir: THREE.Vector3,
    lightColor: THREE.Vector3,
    ambientColor: THREE.Vector3,
  ): void {
    this.lightDirUniform.value.copy(lightDir);
    this.lightColorUniform.value.copy(lightColor);
    this.ambientColorUniform.value.copy(ambientColor);
  }

  /**
   * Main update function - call each frame
   * @param buildings All buildings that could potentially be in impostor range
   * @param cameraPos Current camera position
   * @param camera Camera for frustum culling
   */
  update(
    buildings: AtlasBuildingData[],
    cameraPos: THREE.Vector3,
    camera: THREE.Camera,
  ): void {
    this.frameCount++;

    // Update frustum
    this._projScreenMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    this._frustum.setFromProjectionMatrix(this._projScreenMatrix);

    // 1. Score and filter buildings in impostor range (lodLevel === 2)
    const candidates = this.scoreBuildingCandidates(buildings, cameraPos);

    // 2. Assign top 16 to slots
    this.assignSlots(candidates);

    // 3. Blit any dirty slots
    this.blitDirtySlots();

    // 4. Update instance transforms
    this.updateInstanceTransforms(cameraPos);

    // 5. Update visibility
    this.instancedMesh.visible = this.visibleCount > 0;
    this.instancedMesh.count = this.visibleCount;
  }

  /**
   * Score buildings by distance and visibility
   */
  private scoreBuildingCandidates(
    buildings: AtlasBuildingData[],
    cameraPos: THREE.Vector3,
  ): ScoredBuilding[] {
    const candidates: ScoredBuilding[] = [];

    for (const building of buildings) {
      // Only consider buildings in impostor range
      if (building.lodLevel !== 2) continue;

      // Must have baked impostor
      if (!building.impostorBakeResult) continue;

      const distanceSq = building.position.distanceToSquared(cameraPos);
      const inFrustum = this._frustum.containsPoint(building.position);

      // Score: higher = more important
      // - In frustum gets big bonus
      // - Closer is better (inverse distance)
      const frustumBonus = inFrustum ? DYNAMIC_ATLAS_CONFIG.frustumBias : 0;
      const distanceScore = 1000 / (distanceSq + 1);
      const score = frustumBonus + distanceScore;

      // Bonus for buildings already in a slot (stability)
      const existingSlot = this.buildingToSlot.get(building.buildingId);
      const stabilityBonus = existingSlot !== undefined ? 100 : 0;

      candidates.push({
        building,
        score: score + stabilityBonus,
        distanceSq,
        inFrustum,
      });
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    return candidates;
  }

  /**
   * Assign top candidates to slots
   */
  private assignSlots(candidates: ScoredBuilding[]): void {
    // Track which buildings we want active
    const wantedBuildings = new Set<string>();
    const topCandidates = candidates.slice(
      0,
      DYNAMIC_ATLAS_CONFIG.maxBuildings,
    );

    for (const candidate of topCandidates) {
      wantedBuildings.add(candidate.building.buildingId);
    }

    // Mark slots for eviction if their building is no longer wanted
    for (let slotIndex = 0; slotIndex < this.slots.length; slotIndex++) {
      const slot = this.slots[slotIndex];
      if (!slot) continue;

      if (!wantedBuildings.has(slot.buildingId)) {
        // Check minimum lifetime
        const age = this.frameCount - slot.assignedFrame;
        if (age >= DYNAMIC_ATLAS_CONFIG.minSlotLifetime) {
          // Evict
          this.buildingToSlot.delete(slot.buildingId);
          this.slots[slotIndex] = null;
        }
      } else {
        // Update last used frame
        slot.lastUsedFrame = this.frameCount;
      }
    }

    // Assign new buildings to available slots
    for (const candidate of topCandidates) {
      const buildingId = candidate.building.buildingId;

      // Skip if already has a slot
      if (this.buildingToSlot.has(buildingId)) continue;

      // Find empty slot
      const emptySlot = this.slots.findIndex((s) => s === null);
      if (emptySlot === -1) {
        // No empty slots - all 16 occupied by higher priority buildings
        break;
      }

      // Assign to slot
      this.slots[emptySlot] = {
        buildingId,
        building: candidate.building,
        assignedFrame: this.frameCount,
        lastUsedFrame: this.frameCount,
        needsBlit: true,
      };
      this.buildingToSlot.set(buildingId, emptySlot);

      if (this.debugEnabled) {
        console.log(
          `[DynamicAtlas] Assigned ${buildingId} to slot ${emptySlot}`,
        );
      }
    }

    // Update active buildings map
    this.activeBuildings.clear();
    for (const slot of this.slots) {
      if (slot) {
        this.activeBuildings.set(slot.buildingId, slot.building);
      }
    }
  }

  /**
   * Blit textures for dirty slots
   */
  private blitDirtySlots(): void {
    // Access renderer through graphics system
    const graphics = this.world.graphics as {
      renderer?: THREE.WebGPURenderer;
    } | null;
    const renderer = graphics?.renderer;
    if (!renderer?.copyTextureToTexture) {
      // Fallback for environments without this API
      return;
    }

    for (let slotIndex = 0; slotIndex < this.slots.length; slotIndex++) {
      const slot = this.slots[slotIndex];
      if (!slot || !slot.needsBlit) continue;

      const bakeResult = slot.building.impostorBakeResult;
      if (!bakeResult) continue;

      // Calculate destination position in atlas
      const slotCol = slotIndex % DYNAMIC_ATLAS_CONFIG.slotsPerRow;
      const slotRow = Math.floor(slotIndex / DYNAMIC_ATLAS_CONFIG.slotsPerRow);
      const destX = slotCol * DYNAMIC_ATLAS_CONFIG.slotSize;
      const destY = slotRow * DYNAMIC_ATLAS_CONFIG.slotSize;

      const destPos = new THREE.Vector2(destX, destY);

      // Blit color atlas
      try {
        renderer.copyTextureToTexture(
          bakeResult.atlasTexture,
          this.colorAtlas.texture,
          null, // full source
          destPos, // destination position
        );

        // Blit normal atlas if present
        if (bakeResult.normalAtlasTexture) {
          renderer.copyTextureToTexture(
            bakeResult.normalAtlasTexture,
            this.normalAtlas.texture,
            null,
            destPos,
          );
        }

        slot.needsBlit = false;

        if (this.debugEnabled) {
          console.log(
            `[DynamicAtlas] Blitted slot ${slotIndex} at (${destX}, ${destY})`,
          );
        }
      } catch (err) {
        console.warn(`[DynamicAtlas] Failed to blit slot ${slotIndex}:`, err);
      }
    }
  }

  /**
   * Update instance transforms to face camera
   */
  private updateInstanceTransforms(cameraPos: THREE.Vector3): void {
    this.visibleCount = 0;

    for (let slotIndex = 0; slotIndex < this.slots.length; slotIndex++) {
      const slot = this.slots[slotIndex];
      if (!slot) continue;

      const building = slot.building;
      const instanceIndex = this.visibleCount;

      // Calculate billboard rotation to face camera
      const dx = cameraPos.x - building.position.x;
      const dz = cameraPos.z - building.position.z;
      const angle = Math.atan2(dx, dz);

      // Get dimensions (doubled for impostor sizing)
      const width = Math.max(building.dimensions.x, building.dimensions.z) * 2;
      const height = building.dimensions.y * 2;

      // Set transform
      this._tempQuat.setFromAxisAngle(this._tempVec.set(0, 1, 0), angle);
      this._tempScale.set(width, height, 1);
      this._tempVec.copy(building.position);
      this._tempVec.y += height * 0.25; // Offset for doubled size

      this._tempMatrix.compose(this._tempVec, this._tempQuat, this._tempScale);
      this.instancedMesh.setMatrixAt(instanceIndex, this._tempMatrix);

      // Set per-instance attributes
      this.instanceSlotIds.setX(instanceIndex, slotIndex);
      this.instanceSlotIds.needsUpdate = true;

      const bakeResult = building.impostorBakeResult;
      const gridSizeX =
        bakeResult?.gridSizeX ?? DYNAMIC_ATLAS_CONFIG.defaultGridSizeX;
      const gridSizeY =
        bakeResult?.gridSizeY ?? DYNAMIC_ATLAS_CONFIG.defaultGridSizeY;
      this.instanceGridSizes.setXY(instanceIndex, gridSizeX, gridSizeY);
      this.instanceGridSizes.needsUpdate = true;

      this.instanceScales.setXY(instanceIndex, width, height);
      this.instanceScales.needsUpdate = true;

      this.visibleCount++;
    }

    this.instancedMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Check if a building is currently in the atlas
   */
  isInAtlas(buildingId: string): boolean {
    return this.buildingToSlot.has(buildingId);
  }

  /**
   * Get current atlas statistics
   */
  getStats(): {
    slotsUsed: number;
    totalSlots: number;
    visibleCount: number;
    occupancy: number;
  } {
    const slotsUsed = this.slots.filter((s) => s !== null).length;
    return {
      slotsUsed,
      totalSlots: DYNAMIC_ATLAS_CONFIG.maxBuildings,
      visibleCount: this.visibleCount,
      occupancy: slotsUsed / DYNAMIC_ATLAS_CONFIG.maxBuildings,
    };
  }

  /**
   * Enable/disable debug logging
   */
  setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.colorAtlas.dispose();
    this.normalAtlas.dispose();
    this.instancedMesh.geometry.dispose();
    (this.material as THREE.Material).dispose();
    this.slots.fill(null);
    this.buildingToSlot.clear();
    this.activeBuildings.clear();
  }
}
