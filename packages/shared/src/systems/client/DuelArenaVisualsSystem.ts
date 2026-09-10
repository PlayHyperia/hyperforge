/**
 * DuelArenaVisualsSystem - Procedural Duel Arena Rendering (Instanced)
 *
 * Creates visual geometry for the duel arena without requiring external models.
 * Uses procedural Three.js geometry, InstancedMesh, and TSL shader materials:
 * - 6 arena floors with TSL stone tile textures and border trim
 * - Stone pillar architecture at corners with TSL-animated brazier glow
 * - Continuous stone fences (fully enclosed, TSL procedural sandstone material)
 * - Colored banners mounted on east/west arena fences
 * - Lobby with textured floor and corner braziers (TSL glow)
 * - Hospital with 3D cross and healing particle glow
 * - Decorative border pillars at lobby/hospital corners
 *
 * Performance: ~22 draw calls via InstancedMesh (down from ~846 individual meshes).
 * All 28 PointLights replaced with GPU-animated TSL emissive brazier materials.
 *
 * Arena Layout (classic MMORPG-style):
 * - 6 rectangular arenas in a 2x3 grid
 * - Each arena is 20m wide x 24m long
 * - 4m gap between arenas
 * - Base coordinates: see arena-layout.ts (single source of truth)
 */

import THREE, {
  MeshStandardNodeMaterial,
  uniform,
} from "../../extras/three/three";
import {
  Fn,
  positionWorld,
  normalWorld,
  vec2,
  vec3,
  vec4,
  float,
  floor as tslFloor,
  fract,
  sin,
  dot,
  mix,
  smoothstep,
  min as tslMin,
  mod,
} from "three/tsl";
import { System } from "../shared/infrastructure/System";
import type { World } from "../../core/World";
import type { WorldOptions } from "../../types/index";
import { getPhysX } from "../../physics/PhysXManager";
import { Layers } from "../../physics/Layers";
import type { Physics } from "../shared/interaction/Physics";
import type { PxRigidStatic } from "../../types/systems/physics";
import type { ParticleSystem } from "../shared/presentation/ParticleSystem";
import type { FlatZone } from "../../types/world/terrain";
import { isStreamingLikeViewport } from "../../runtime/clientViewportMode";
import {
  getDuelArenaConfig,
  type DuelArenaConfig,
} from "../../data/duel-manifest";
import {
  LOBBY_CENTER_X,
  LOBBY_CENTER_Z,
  LOBBY_WIDTH,
  LOBBY_LENGTH,
  HOSPITAL_CENTER_X,
  HOSPITAL_CENTER_Z,
  HOSPITAL_WIDTH,
  HOSPITAL_LENGTH,
  ARENA_FORFEIT_PILLAR_INSET,
} from "../../data/arena-layout";

// Arena grid size/position: getDuelArenaConfig() at runtime (see duel-manifest / ArenaPoolManager).

const FENCE_HEIGHT = 1.5;
/** PhysX wall boxes — must match fence footprint or agents slip through visuals. */
const ARENA_WALL_THICKNESS = 0.55;
const ARENA_WALL_HEIGHT = FENCE_HEIGHT + 0.75;
const FENCE_POST_SPACING = 2.0;
const FENCE_POST_SIZE = 0.2;
const FENCE_RAIL_HEIGHT = 0.08;
const FENCE_RAIL_DEPTH = 0.08;
const FENCE_RAIL_HEIGHTS = [0.3, 0.75, 1.2];
const FLOOR_THICKNESS = 0.3;
const FLOOR_HEIGHT_OFFSET = 0.27;

const LOBBY_FLOOR_COLOR = 0xc9b896;
const HOSPITAL_FLOOR_COLOR = 0xffffff;

const TILE_TEXTURE_SIZE = 512;
const TILE_TEXTURE_WORLD_SIZE = 8;
const LOBBY_TILE_GRID = 3;
const LOBBY_TILE_GROUT_WIDTH = 6;

const TORCH_BRAZIER_RADIUS = 0.12;

const FORFEIT_PILLAR_RADIUS = 0.4;
const FORFEIT_PILLAR_HEIGHT = 1.2;
const FORFEIT_PILLAR_COLOR = 0x8b4513;
const FORFEIT_PILLAR_EMISSIVE = 0x4a2510;

const PILLAR_BASE_SIZE = 0.5;
const PILLAR_BASE_HEIGHT = 0.1;
const PILLAR_SHAFT_SIZE = 0.35;
const PILLAR_SHAFT_HEIGHT = 2.0;
const PILLAR_CAPITAL_SIZE = 0.45;
const PILLAR_CAPITAL_HEIGHT = 0.12;
const PILLAR_STONE_COLOR = 0x908878;
const PILLAR_TOTAL_HEIGHT =
  PILLAR_BASE_HEIGHT + PILLAR_SHAFT_HEIGHT + PILLAR_CAPITAL_HEIGHT;

const BORDER_HEIGHT = 0.08;
const BORDER_WIDTH = 0.25;
const BORDER_COLOR = 0xa08060;

const LOBBY_BRAZIER_HEIGHT = 1.8;

const BANNER_POLE_HEIGHT = 3.0;
const BANNER_POLE_RADIUS = 0.03;
const BANNER_CLOTH_WIDTH = 0.6;
const BANNER_CLOTH_HEIGHT = 1.2;
const BANNER_COLORS: number[] = [
  0xcc3333, 0xcc3333, 0x3366cc, 0x3366cc, 0x33aa44, 0x33aa44,
];

/**
 * Interaction markers and fence banners are useful in the playable client,
 * but their tall geometry can cross the orbiting broadcast camera and obscure
 * the scoreboard. Stream views keep the arena architecture while omitting
 * these nonessential foreground props.
 */
export function shouldRenderInteractiveArenaProps(win?: Window): boolean {
  return !isStreamingLikeViewport(win);
}

/**
 * The playable center marker is useful for spatial judgment, but a cinematic
 * camera can place it between the viewer and the contestants. Stream and
 * embedded spectator views omit it so the floor never becomes foreground UI.
 */
export function shouldRenderArenaCenterMarker(win?: Window): boolean {
  return !isStreamingLikeViewport(win);
}

// Instanced mesh counts (fence posts, rails, pillars) are derived from DuelArenaConfig at runtime.

// ============================================================================
// TSL Procedural Stone Functions
// ============================================================================

const tslHash = Fn(([p]: [ReturnType<typeof vec2>]) => {
  return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453123));
});

const tslNoise2D = Fn(([p]: [ReturnType<typeof vec2>]) => {
  const i = tslFloor(p);
  const f = fract(p);
  const smoothF = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));

  const a = tslHash(i);
  const b = tslHash(i.add(vec2(1.0, 0.0)));
  const c = tslHash(i.add(vec2(0.0, 1.0)));
  const d = tslHash(i.add(vec2(1.0, 1.0)));

  return mix(mix(a, b, smoothF.x), mix(c, d, smoothF.x), smoothF.y);
});

/**
 * Running-bond stone block pattern for sandstone fences.
 * Returns vec4(isStone, blockId.x, blockId.y, bevel).
 */
const sandstoneBlockPattern = Fn(([uvIn]: [ReturnType<typeof vec2>]) => {
  const blockWidth = float(0.6);
  const blockHeight = float(0.3);
  const mortarWidth = float(0.015);

  const scaled = uvIn.div(vec2(blockWidth, blockHeight));
  const row = tslFloor(scaled.y);
  const rowOffset = mod(row, float(2.0)).mul(0.5);
  const offsetUV = vec2(scaled.x.add(rowOffset), scaled.y);

  const blockId = tslFloor(offsetUV);
  const localUV = fract(offsetUV);

  const mortarU = mortarWidth.div(blockWidth);
  const mortarV = mortarWidth.div(blockHeight);

  const edgeDistX = tslMin(localUV.x, float(1.0).sub(localUV.x));
  const edgeDistY = tslMin(localUV.y, float(1.0).sub(localUV.y));
  const bevel = smoothstep(
    float(0.0),
    float(0.06),
    tslMin(edgeDistX, edgeDistY),
  );

  const isStone = smoothstep(mortarU, mortarU.add(float(0.01)), localUV.x)
    .mul(
      smoothstep(mortarU, mortarU.add(float(0.01)), float(1.0).sub(localUV.x)),
    )
    .mul(smoothstep(mortarV, mortarV.add(float(0.01)), localUV.y))
    .mul(
      smoothstep(mortarV, mortarV.add(float(0.01)), float(1.0).sub(localUV.y)),
    );

  return vec4(isStone, blockId.x, blockId.y, bevel);
});

/**
 * Square grid tile pattern for arena floors (large flagstones).
 * Returns vec4(isStone, tileId.x, tileId.y, bevel).
 * Uses positionWorld.xz for seamless world-space tiling.
 */
const floorTilePattern = Fn(([uvIn]: [ReturnType<typeof vec2>]) => {
  const tileSize = float(1.2);
  const mortarWidth = float(0.02);

  const scaled = uvIn.div(tileSize);
  const tileId = tslFloor(scaled);
  const localUV = fract(scaled);

  const mortarFrac = mortarWidth.div(tileSize);

  const edgeDistX = tslMin(localUV.x, float(1.0).sub(localUV.x));
  const edgeDistY = tslMin(localUV.y, float(1.0).sub(localUV.y));
  const bevel = smoothstep(
    float(0.0),
    float(0.05),
    tslMin(edgeDistX, edgeDistY),
  );

  const isStone = smoothstep(mortarFrac, mortarFrac.add(float(0.01)), localUV.x)
    .mul(
      smoothstep(
        mortarFrac,
        mortarFrac.add(float(0.01)),
        float(1.0).sub(localUV.x),
      ),
    )
    .mul(smoothstep(mortarFrac, mortarFrac.add(float(0.01)), localUV.y))
    .mul(
      smoothstep(
        mortarFrac,
        mortarFrac.add(float(0.01)),
        float(1.0).sub(localUV.y),
      ),
    );

  return vec4(isStone, tileId.x, tileId.y, bevel);
});

// ============================================================================
// DuelArenaVisualsSystem
// ============================================================================

export class DuelArenaVisualsSystem extends System {
  name = "duel-arena-visuals";

  private arenaGroup: THREE.Group | null = null;
  private materials: THREE.Material[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private textures: THREE.Texture[] = [];
  private visualsCreated = false;

  private terrainSystem: {
    getHeightAt?: (x: number, z: number) => number;
    getProceduralHeightAt?: (x: number, z: number) => number;
    registerFlatZone?: (zone: FlatZone) => void;
    unregisterFlatZone?: (id: string) => void;
  } | null = null;

  private flatZoneIds: string[] = [];
  private physicsSystem: Physics | null = null;
  private physicsBodies: PxRigidStatic[] = [];
  private particleEmitterIds: string[] = [];

  // Shared cached materials
  private stoneFenceMat: MeshStandardNodeMaterial | null = null;
  private arenaFloorMat: MeshStandardNodeMaterial | null = null;
  private borderMat: MeshStandardNodeMaterial | null = null;
  private pillarStoneMat: MeshStandardNodeMaterial | null = null;
  private brazierGlowMat: MeshStandardNodeMaterial | null = null;
  private forfeitPillarMat: MeshStandardNodeMaterial | null = null;
  private bannerPoleMat: MeshStandardNodeMaterial | null = null;
  private lobbyStandMat: MeshStandardNodeMaterial | null = null;

  // TSL time uniform for brazier glow animation (GPU-driven flicker)
  private timeUniform: any = null;

  /** Matches server DuelSystem / getDuelArenaConfig() — do not hardcode arena grid separately. */
  private arenaCfg!: DuelArenaConfig;

  constructor(world: World) {
    super(world);
  }

  /** Arena grid cell from linear index (same layout as ArenaPoolManager). */
  private arenaCell(arenaIndex: number): {
    row: number;
    col: number;
    cx: number;
    cz: number;
  } {
    const cfg = this.arenaCfg;
    const col = arenaIndex % cfg.columns;
    const row = Math.floor(arenaIndex / cfg.columns);
    const cx =
      cfg.baseX + col * (cfg.arenaWidth + cfg.arenaGap) + cfg.arenaWidth / 2;
    const cz =
      cfg.baseZ + row * (cfg.arenaLength + cfg.arenaGap) + cfg.arenaLength / 2;
    return { row, col, cx, cz };
  }

  isReady(): boolean {
    return this.visualsCreated;
  }

  private getTerrainHeight(x: number, z: number): number {
    if (this.terrainSystem?.getHeightAt) {
      try {
        const height = this.terrainSystem.getHeightAt(x, z);
        return height ?? 0;
      } catch {
        return 0;
      }
    }
    return 0;
  }

  private getProceduralTerrainHeight(x: number, z: number): number {
    if (this.terrainSystem?.getProceduralHeightAt) {
      try {
        const height = this.terrainSystem.getProceduralHeightAt(x, z);
        return height ?? 0;
      } catch {
        return 0;
      }
    }
    return this.getTerrainHeight(x, z);
  }

  async init(options?: WorldOptions): Promise<void> {
    await super.init(options as WorldOptions);
    console.log(
      "[DuelArenaVisualsSystem] init() called, isClient:",
      this.world.isClient,
    );
  }

  start(): void {
    this.arenaCfg = getDuelArenaConfig();

    this.terrainSystem = this.world.getSystem("terrain") as {
      getHeightAt?: (x: number, z: number) => number;
      getProceduralHeightAt?: (x: number, z: number) => number;
      registerFlatZone?: (zone: FlatZone) => void;
      unregisterFlatZone?: (id: string) => void;
    } | null;

    if (!this.terrainSystem?.getHeightAt) {
      console.warn(
        "[DuelArenaVisualsSystem] TerrainSystem not available, using fallback heights",
      );
    }

    this.physicsSystem = this.world.getSystem("physics") as Physics | null;
    if (!this.physicsSystem) {
      if (this.world.isClient && isStreamingLikeViewport()) {
        console.info(
          "[DuelArenaVisualsSystem] Local collision intentionally omitted for the non-interactive stream viewport; movement remains server-authoritative",
        );
      } else {
        console.warn(
          "[DuelArenaVisualsSystem] Physics system not available, floors will have no collision",
        );
      }
    }

    this.registerArenaFlatZones();

    console.log(
      "[DuelArenaVisualsSystem] start() called, creating arena visuals...",
    );
    this.createArenaVisuals();
  }

  // ============================================================================
  // Flat Zone Registration
  // ============================================================================

  private registerArenaFlatZones(): void {
    if (!this.terrainSystem?.registerFlatZone) {
      console.warn(
        "[DuelArenaVisualsSystem] TerrainSystem.registerFlatZone not available, skipping flat zone registration",
      );
      return;
    }

    const FLAT_ZONE_HEIGHT_OFFSET = 0.4;
    const BLEND_RADIUS = 1.0;
    const CARVE_INSET = 1.0;

    const cfg = this.arenaCfg;
    for (let i = 0; i < cfg.arenaCount; i++) {
      const { cx: centerX, cz: centerZ } = this.arenaCell(i);

      const proceduralHeight = this.getProceduralTerrainHeight(
        centerX,
        centerZ,
      );
      const zoneId = `duel_arena_floor_${i + 1}`;

      const zone: FlatZone = {
        id: zoneId,
        centerX,
        centerZ,
        width: cfg.arenaWidth,
        depth: cfg.arenaLength,
        height: proceduralHeight + FLAT_ZONE_HEIGHT_OFFSET,
        blendRadius: BLEND_RADIUS,
        carveInset: CARVE_INSET,
      };

      this.terrainSystem.registerFlatZone(zone);
      this.flatZoneIds.push(zoneId);
    }

    // Lobby flat zone
    {
      const proceduralHeight = this.getProceduralTerrainHeight(
        LOBBY_CENTER_X,
        LOBBY_CENTER_Z,
      );
      const zoneId = "duel_lobby_floor";
      const zone: FlatZone = {
        id: zoneId,
        centerX: LOBBY_CENTER_X,
        centerZ: LOBBY_CENTER_Z,
        width: LOBBY_WIDTH,
        depth: LOBBY_LENGTH,
        height: proceduralHeight + FLAT_ZONE_HEIGHT_OFFSET,
        blendRadius: BLEND_RADIUS,
        carveInset: CARVE_INSET,
      };
      this.terrainSystem.registerFlatZone(zone);
      this.flatZoneIds.push(zoneId);
    }

    // Hospital flat zone
    {
      const proceduralHeight = this.getProceduralTerrainHeight(
        HOSPITAL_CENTER_X,
        HOSPITAL_CENTER_Z,
      );
      const zoneId = "duel_hospital_floor";
      const zone: FlatZone = {
        id: zoneId,
        centerX: HOSPITAL_CENTER_X,
        centerZ: HOSPITAL_CENTER_Z,
        width: HOSPITAL_WIDTH,
        depth: HOSPITAL_LENGTH,
        height: proceduralHeight + FLAT_ZONE_HEIGHT_OFFSET,
        blendRadius: BLEND_RADIUS,
        carveInset: CARVE_INSET,
      };
      this.terrainSystem.registerFlatZone(zone);
      this.flatZoneIds.push(zoneId);
    }

    console.log(
      `[DuelArenaVisualsSystem] Registered ${this.flatZoneIds.length} flat zones (${this.arenaCfg.arenaCount} arenas + lobby + hospital)`,
    );
  }

  // ============================================================================
  // Main Visual Builder
  // ============================================================================

  private createArenaVisuals(): void {
    if (this.visualsCreated) {
      console.log("[DuelArenaVisualsSystem] Visuals already created, skipping");
      return;
    }

    if (this.world.isClient) {
      this.arenaGroup = new THREE.Group();
      this.arenaGroup.name = "DuelArenaVisuals";
      const renderInteractiveArenaProps = shouldRenderInteractiveArenaProps();

      // Create all shared materials first
      this.createSharedMaterials();

      // Build instanced meshes (bulk geometry — biggest perf wins)
      this.buildFenceInstances();
      this.buildPillarInstances();
      this.buildBrazierInstances();
      this.buildBorderInstances();
      if (renderInteractiveArenaProps) {
        this.buildBannerPoleInstances();
      }
    }

    // Individual meshes (need unique userData/layers for raycasting)
    this.createArenaFloors();
    this.createArenaWallCollisions();
    this.createLobbyFloor();
    this.createHospitalFloor();
    if (this.world.isClient) {
      if (shouldRenderArenaCenterMarker()) {
        this.createArenaCenterRings();
      }
      if (shouldRenderInteractiveArenaProps()) {
        this.createForfeitPillars();
        this.createBannerCloths();
      }
    }

    // Register fire/torch particles
    this.registerTorchParticles();
    this.registerLobbyFireParticles();

    if (this.world.isClient) {
      if (this.world.stage?.scene) {
        this.world.stage.scene.add(this.arenaGroup!);
        this.visualsCreated = true;
        console.log(
          `[DuelArenaVisualsSystem] Added instanced arena visuals to scene`,
        );
        console.log(
          `[DuelArenaVisualsSystem] Geometries: ${this.geometries.length}, Materials: ${this.materials.length}`,
        );
        this.registerGrassExclusions();
      } else {
        console.warn(
          "[DuelArenaVisualsSystem] No stage/scene available, cannot add arena visuals",
        );
      }
    } else {
      this.visualsCreated = true;
    }
  }

  // ============================================================================
  // Shared Material Creation
  // ============================================================================

  private createSharedMaterials(): void {
    this.timeUniform = uniform(float(0));

    this.stoneFenceMat = this.createStoneFenceMaterial();
    this.materials.push(this.stoneFenceMat);

    this.arenaFloorMat = this.createArenaFloorMaterial();
    this.materials.push(this.arenaFloorMat);

    this.borderMat = new MeshStandardNodeMaterial({
      color: BORDER_COLOR,
      roughness: 0.85,
    });
    this.materials.push(this.borderMat);

    this.pillarStoneMat = new MeshStandardNodeMaterial({
      color: PILLAR_STONE_COLOR,
      roughness: 0.85,
    });
    this.materials.push(this.pillarStoneMat);

    this.brazierGlowMat = this.createBrazierGlowMaterial();
    this.materials.push(this.brazierGlowMat);

    this.forfeitPillarMat = new MeshStandardNodeMaterial({
      color: FORFEIT_PILLAR_COLOR,
      emissive: FORFEIT_PILLAR_EMISSIVE,
      emissiveIntensity: 0.2,
      roughness: 0.8,
    });
    this.materials.push(this.forfeitPillarMat);

    this.bannerPoleMat = new MeshStandardNodeMaterial({
      color: 0x444444,
      roughness: 0.6,
      metalness: 0.4,
    });
    this.materials.push(this.bannerPoleMat);

    this.lobbyStandMat = new MeshStandardNodeMaterial({
      color: 0x555555,
      roughness: 0.7,
    });
    this.materials.push(this.lobbyStandMat);
  }

  /**
   * TSL procedural sandstone block material for stone fences.
   * GPU-computed block pattern with per-block color variation, mortar grooves,
   * and normal-mapped raised blocks. Uses world-space UVs for seamless tiling.
   */
  private createStoneFenceMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();

    material.colorNode = Fn(() => {
      const worldPos = positionWorld;
      const uvCoord = vec2(worldPos.x.add(worldPos.z), worldPos.y).mul(2.0);

      const pattern = sandstoneBlockPattern(uvCoord);
      const isStone = pattern.x;
      const blockId = vec2(pattern.y, pattern.z);
      const bevel = pattern.w;

      const hashVal = tslHash(blockId);
      const r = float(0.62).add(hashVal.mul(0.1));
      const g = float(0.52).add(hashVal.mul(0.08));
      const b = float(0.38).add(hashVal.mul(0.08));
      const stoneColor = vec3(r, g, b);

      const grain = tslNoise2D(uvCoord.mul(15.0)).mul(0.08);
      const grainedStone = stoneColor.add(vec3(grain, grain, grain));

      const mortarColor = vec3(0.35, 0.28, 0.2);
      const baseColor = mix(mortarColor, grainedStone.mul(bevel), isStone);

      return vec4(baseColor, 1.0);
    })();

    material.roughnessNode = Fn(() => {
      const worldPos = positionWorld;
      const uvCoord = vec2(worldPos.x.add(worldPos.z), worldPos.y).mul(2.0);

      const pattern = sandstoneBlockPattern(uvCoord);
      const isStone = pattern.x;
      const blockId = vec2(pattern.y, pattern.z);

      const stoneRough = float(0.72).add(
        tslHash(blockId.add(vec2(5.0, 3.0))).mul(0.1),
      );
      const mortarRough = float(0.92);

      return mix(mortarRough, stoneRough, isStone);
    })();

    return material;
  }

  /**
   * TSL procedural floor material with square flagstone pattern.
   * World-space UVs make each arena look unique despite sharing the material.
   */
  private createArenaFloorMaterial(): MeshStandardNodeMaterial {
    const material = new MeshStandardNodeMaterial();

    material.colorNode = Fn(() => {
      const worldPos = positionWorld;
      const uvCoord = vec2(worldPos.x, worldPos.z);

      const pattern = floorTilePattern(uvCoord);
      const isStone = pattern.x;
      const tileId = vec2(pattern.y, pattern.z);
      const bevel = pattern.w;

      const hashVal = tslHash(tileId);
      const r = float(0.68).add(hashVal.mul(0.12));
      const g = float(0.54).add(hashVal.mul(0.1));
      const b = float(0.36).add(hashVal.mul(0.08));
      const stoneColor = vec3(r, g, b);

      const grain = tslNoise2D(uvCoord.mul(12.0)).mul(0.06);
      const grainedStone = stoneColor.add(vec3(grain, grain, grain));

      const groutColor = vec3(0.4, 0.32, 0.22);
      const baseColor = mix(groutColor, grainedStone.mul(bevel), isStone);

      return vec4(baseColor, 1.0);
    })();

    material.roughnessNode = Fn(() => {
      const worldPos = positionWorld;
      const uvCoord = vec2(worldPos.x, worldPos.z);

      const pattern = floorTilePattern(uvCoord);
      const isStone = pattern.x;
      const tileId = vec2(pattern.y, pattern.z);

      const stoneRough = float(0.6).add(
        tslHash(tileId.add(vec2(7.0, 11.0))).mul(0.12),
      );
      const groutRough = float(0.9);

      return mix(groutRough, stoneRough, isStone);
    })();

    return material;
  }

  /**
   * TSL animated emissive material for brazier bowls.
   * GPU-driven flicker replaces 28 CPU-animated PointLights.
   * Each brazier gets a unique flicker phase derived from its world position.
   */
  private createBrazierGlowMaterial(): MeshStandardNodeMaterial {
    const mat = new MeshStandardNodeMaterial({
      color: 0xff4400,
      roughness: 0.7,
    });

    const t = this.timeUniform!;

    mat.emissiveNode = Fn(() => {
      const wp = positionWorld;
      // Quantize world position so all vertices of one brazier share the same phase
      const quantized = vec2(tslFloor(wp.x.add(0.5)), tslFloor(wp.z.add(0.5)));
      const phase = tslHash(quantized).mul(6.28);

      // Multi-frequency sine flicker + high-freq noise (matches old PointLight behavior)
      const flicker = sin(t.mul(10.0).add(phase))
        .mul(0.15)
        .add(sin(t.mul(7.3).add(phase.mul(1.7))).mul(0.08));
      const noise = fract(sin(t.mul(43.7).add(phase)).mul(9827.3)).mul(0.05);
      const intensity = float(0.6).add(flicker).add(noise);

      // Only the top face (fire opening) glows; outer shell stays dark.
      const topMask = smoothstep(float(0.7), float(0.95), normalWorld.y);

      return vec3(1.0, 0.4, 0.0).mul(intensity).mul(topMask);
    })();

    return mat;
  }

  // ============================================================================
  // Instanced Mesh Builders
  // ============================================================================

  /**
   * Build all fence geometry as InstancedMesh.
   * 288 posts + 288 caps + 36 X-rails + 36 Z-rails → 4 draw calls.
   */
  private buildFenceInstances(): void {
    const cfg = this.arenaCfg;
    const postsPerX = Math.max(
      2,
      Math.floor(cfg.arenaWidth / FENCE_POST_SPACING) + 1,
    );
    const postsPerZ = Math.max(
      2,
      Math.floor(cfg.arenaLength / FENCE_POST_SPACING) + 1,
    );
    const totalFencePosts = cfg.arenaCount * (2 * postsPerX + 2 * postsPerZ);
    const totalXRails = cfg.arenaCount * 2 * FENCE_RAIL_HEIGHTS.length;
    const totalZRails = cfg.arenaCount * 2 * FENCE_RAIL_HEIGHTS.length;

    const postGeom = new THREE.BoxGeometry(
      FENCE_POST_SIZE,
      FENCE_HEIGHT,
      FENCE_POST_SIZE,
    );
    this.geometries.push(postGeom);

    const capSize = FENCE_POST_SIZE + 0.06;
    const capGeom = new THREE.BoxGeometry(capSize, 0.06, capSize);
    this.geometries.push(capGeom);

    const postsIM = new THREE.InstancedMesh(
      postGeom,
      this.stoneFenceMat!,
      totalFencePosts,
    );
    postsIM.castShadow = true;
    postsIM.receiveShadow = false;
    postsIM.layers.set(1);
    postsIM.userData = { type: "arena-fence", walkable: false };

    const capsIM = new THREE.InstancedMesh(
      capGeom,
      this.stoneFenceMat!,
      totalFencePosts,
    );
    capsIM.layers.set(1);

    const matrix = new THREE.Matrix4();
    let postIdx = 0;

    for (let a = 0; a < cfg.arenaCount; a++) {
      const { cx, cz } = this.arenaCell(a);
      const terrainY = this.getTerrainHeight(cx, cz);
      const halfW = cfg.arenaWidth / 2;
      const halfL = cfg.arenaLength / 2;

      const sides: [number, number, number, "x" | "z"][] = [
        [cx - halfW, cz - halfL, cfg.arenaWidth, "x"],
        [cx - halfW, cz + halfL, cfg.arenaWidth, "x"],
        [cx - halfW, cz - halfL, cfg.arenaLength, "z"],
        [cx + halfW, cz - halfL, cfg.arenaLength, "z"],
      ];

      for (const [startX, startZ, length, axis] of sides) {
        const postCount = Math.max(
          2,
          Math.floor(length / FENCE_POST_SPACING) + 1,
        );
        const spacing = length / (postCount - 1);

        for (let i = 0; i < postCount; i++) {
          const offset = i * spacing;
          const px = axis === "x" ? startX + offset : startX;
          const pz = axis === "z" ? startZ + offset : startZ;

          matrix.makeTranslation(px, terrainY + FENCE_HEIGHT / 2, pz);
          postsIM.setMatrixAt(postIdx, matrix);

          matrix.makeTranslation(px, terrainY + FENCE_HEIGHT + 0.03, pz);
          capsIM.setMatrixAt(postIdx, matrix);

          postIdx++;
        }
      }
    }

    postsIM.instanceMatrix.needsUpdate = true;
    capsIM.instanceMatrix.needsUpdate = true;
    this.arenaGroup!.add(postsIM, capsIM);

    // X-axis fence rails (north/south walls)
    const railXGeom = new THREE.BoxGeometry(
      cfg.arenaWidth,
      FENCE_RAIL_HEIGHT,
      FENCE_RAIL_DEPTH,
    );
    this.geometries.push(railXGeom);

    const railsXIM = new THREE.InstancedMesh(
      railXGeom,
      this.stoneFenceMat!,
      totalXRails,
    );
    railsXIM.castShadow = true;
    railsXIM.receiveShadow = false;
    railsXIM.layers.set(1);

    let railXIdx = 0;
    for (let a = 0; a < cfg.arenaCount; a++) {
      const { cx, cz } = this.arenaCell(a);
      const terrainY = this.getTerrainHeight(cx, cz);
      const halfL = cfg.arenaLength / 2;

      for (const railY of FENCE_RAIL_HEIGHTS) {
        matrix.makeTranslation(cx, terrainY + railY, cz - halfL);
        railsXIM.setMatrixAt(railXIdx++, matrix);

        matrix.makeTranslation(cx, terrainY + railY, cz + halfL);
        railsXIM.setMatrixAt(railXIdx++, matrix);
      }
    }
    railsXIM.instanceMatrix.needsUpdate = true;
    this.arenaGroup!.add(railsXIM);

    // Z-axis fence rails (west/east walls)
    const railZGeom = new THREE.BoxGeometry(
      FENCE_RAIL_DEPTH,
      FENCE_RAIL_HEIGHT,
      cfg.arenaLength,
    );
    this.geometries.push(railZGeom);

    const railsZIM = new THREE.InstancedMesh(
      railZGeom,
      this.stoneFenceMat!,
      totalZRails,
    );
    railsZIM.castShadow = true;
    railsZIM.receiveShadow = false;
    railsZIM.layers.set(1);

    let railZIdx = 0;
    for (let a = 0; a < cfg.arenaCount; a++) {
      const { cx, cz } = this.arenaCell(a);
      const terrainY = this.getTerrainHeight(cx, cz);
      const halfW = cfg.arenaWidth / 2;

      for (const railY of FENCE_RAIL_HEIGHTS) {
        matrix.makeTranslation(cx - halfW, terrainY + railY, cz);
        railsZIM.setMatrixAt(railZIdx++, matrix);

        matrix.makeTranslation(cx + halfW, terrainY + railY, cz);
        railsZIM.setMatrixAt(railZIdx++, matrix);
      }
    }
    railsZIM.instanceMatrix.needsUpdate = true;
    this.arenaGroup!.add(railsZIM);
  }

  /**
   * Build all stone pillar components as InstancedMesh.
   * 32 pillars (24 arena corners + 4 lobby + 4 hospital) × 3 parts → 3 draw calls.
   */
  private buildPillarInstances(): void {
    const cfg = this.arenaCfg;
    const totalPillars = cfg.arenaCount * 4 + 8; // arena corners + lobby + hospital

    const baseGeom = new THREE.BoxGeometry(
      PILLAR_BASE_SIZE,
      PILLAR_BASE_HEIGHT,
      PILLAR_BASE_SIZE,
    );
    const shaftGeom = new THREE.BoxGeometry(
      PILLAR_SHAFT_SIZE,
      PILLAR_SHAFT_HEIGHT,
      PILLAR_SHAFT_SIZE,
    );
    const capitalGeom = new THREE.BoxGeometry(
      PILLAR_CAPITAL_SIZE,
      PILLAR_CAPITAL_HEIGHT,
      PILLAR_CAPITAL_SIZE,
    );
    this.geometries.push(baseGeom, shaftGeom, capitalGeom);

    const basesIM = new THREE.InstancedMesh(
      baseGeom,
      this.pillarStoneMat!,
      totalPillars,
    );
    const shaftsIM = new THREE.InstancedMesh(
      shaftGeom,
      this.pillarStoneMat!,
      totalPillars,
    );
    const capitalsIM = new THREE.InstancedMesh(
      capitalGeom,
      this.pillarStoneMat!,
      totalPillars,
    );

    for (const im of [basesIM, shaftsIM, capitalsIM]) {
      im.castShadow = true;
      im.receiveShadow = false;
      im.layers.set(1);
    }

    const matrix = new THREE.Matrix4();
    let idx = 0;

    // Collect all pillar positions
    const positions: { x: number; z: number; terrainY: number }[] = [];

    // Arena corner pillars
    for (let a = 0; a < cfg.arenaCount; a++) {
      const { cx, cz } = this.arenaCell(a);
      const terrainY = this.getTerrainHeight(cx, cz);
      const halfW = cfg.arenaWidth / 2;
      const halfL = cfg.arenaLength / 2;

      positions.push(
        { x: cx - halfW, z: cz - halfL, terrainY },
        { x: cx + halfW, z: cz - halfL, terrainY },
        { x: cx - halfW, z: cz + halfL, terrainY },
        { x: cx + halfW, z: cz + halfL, terrainY },
      );
    }

    // Lobby corner pillars (4) — inset by half the pillar base so they sit exactly at the floor corner
    const lobbyHW = LOBBY_WIDTH / 2 - PILLAR_BASE_SIZE / 2;
    const lobbyHL = LOBBY_LENGTH / 2 - PILLAR_BASE_SIZE / 2;
    for (const c of [
      { x: LOBBY_CENTER_X - lobbyHW, z: LOBBY_CENTER_Z - lobbyHL },
      { x: LOBBY_CENTER_X + lobbyHW, z: LOBBY_CENTER_Z - lobbyHL },
      { x: LOBBY_CENTER_X - lobbyHW, z: LOBBY_CENTER_Z + lobbyHL },
      { x: LOBBY_CENTER_X + lobbyHW, z: LOBBY_CENTER_Z + lobbyHL },
    ]) {
      positions.push({
        ...c,
        terrainY: this.getTerrainHeight(c.x, c.z),
      });
    }

    // Hospital corner pillars (4) — same inset as lobby
    const hospHW = HOSPITAL_WIDTH / 2 - PILLAR_BASE_SIZE / 2;
    const hospHL = HOSPITAL_LENGTH / 2 - PILLAR_BASE_SIZE / 2;
    for (const c of [
      { x: HOSPITAL_CENTER_X - hospHW, z: HOSPITAL_CENTER_Z - hospHL },
      { x: HOSPITAL_CENTER_X + hospHW, z: HOSPITAL_CENTER_Z - hospHL },
      { x: HOSPITAL_CENTER_X - hospHW, z: HOSPITAL_CENTER_Z + hospHL },
      { x: HOSPITAL_CENTER_X + hospHW, z: HOSPITAL_CENTER_Z + hospHL },
    ]) {
      positions.push({
        ...c,
        terrainY: this.getTerrainHeight(c.x, c.z),
      });
    }

    for (const p of positions) {
      matrix.makeTranslation(p.x, p.terrainY + PILLAR_BASE_HEIGHT / 2, p.z);
      basesIM.setMatrixAt(idx, matrix);

      matrix.makeTranslation(
        p.x,
        p.terrainY + PILLAR_BASE_HEIGHT + PILLAR_SHAFT_HEIGHT / 2,
        p.z,
      );
      shaftsIM.setMatrixAt(idx, matrix);

      matrix.makeTranslation(
        p.x,
        p.terrainY +
          PILLAR_BASE_HEIGHT +
          PILLAR_SHAFT_HEIGHT +
          PILLAR_CAPITAL_HEIGHT / 2,
        p.z,
      );
      capitalsIM.setMatrixAt(idx, matrix);

      idx++;
    }

    basesIM.instanceMatrix.needsUpdate = true;
    shaftsIM.instanceMatrix.needsUpdate = true;
    capitalsIM.instanceMatrix.needsUpdate = true;
    this.arenaGroup!.add(basesIM, shaftsIM, capitalsIM);
  }

  /**
   * Build arena corner brazier bowls as InstancedMesh with TSL glow.
   * 24 instances → 1 draw call. Replaces 24 PointLights.
   */
  private buildBrazierInstances(): void {
    const cfg = this.arenaCfg;
    const totalArenaBraziers = cfg.arenaCount * 4;

    const brazierGeom = new THREE.CylinderGeometry(
      TORCH_BRAZIER_RADIUS * 0.6,
      TORCH_BRAZIER_RADIUS,
      0.1,
      6,
    );
    this.geometries.push(brazierGeom);

    const braziersIM = new THREE.InstancedMesh(
      brazierGeom,
      this.brazierGlowMat!,
      totalArenaBraziers,
    );
    braziersIM.layers.set(1);

    const matrix = new THREE.Matrix4();
    let idx = 0;

    for (let a = 0; a < cfg.arenaCount; a++) {
      const { cx, cz } = this.arenaCell(a);
      const terrainY = this.getTerrainHeight(cx, cz);
      const pillarTopY = terrainY + PILLAR_TOTAL_HEIGHT;
      const halfW = cfg.arenaWidth / 2;
      const halfL = cfg.arenaLength / 2;

      for (const corner of [
        { x: cx - halfW, z: cz - halfL },
        { x: cx + halfW, z: cz - halfL },
        { x: cx - halfW, z: cz + halfL },
        { x: cx + halfW, z: cz + halfL },
      ]) {
        matrix.makeTranslation(corner.x, pillarTopY + 0.05, corner.z);
        braziersIM.setMatrixAt(idx++, matrix);
      }
    }

    braziersIM.instanceMatrix.needsUpdate = true;
    this.arenaGroup!.add(braziersIM);
  }

  /**
   * Build floor border trim strips as InstancedMesh.
   * 12 N/S + 12 E/W → 2 draw calls.
   */
  private buildBorderInstances(): void {
    const cfg = this.arenaCfg;
    const floorWidth = cfg.arenaWidth - 1;
    const floorLength = cfg.arenaLength - 1;

    const nsGeom = new THREE.BoxGeometry(
      floorWidth,
      BORDER_HEIGHT,
      BORDER_WIDTH,
    );
    this.geometries.push(nsGeom);

    const nsIM = new THREE.InstancedMesh(
      nsGeom,
      this.borderMat!,
      cfg.arenaCount * 2,
    );
    nsIM.layers.set(1);

    const ewGeom = new THREE.BoxGeometry(
      BORDER_WIDTH,
      BORDER_HEIGHT,
      floorLength - 2 * BORDER_WIDTH,
    );
    this.geometries.push(ewGeom);

    const ewIM = new THREE.InstancedMesh(
      ewGeom,
      this.borderMat!,
      cfg.arenaCount * 2,
    );
    ewIM.layers.set(1);

    const matrix = new THREE.Matrix4();
    let nsIdx = 0;
    let ewIdx = 0;

    for (let a = 0; a < cfg.arenaCount; a++) {
      const { cx, cz } = this.arenaCell(a);
      const terrainY = this.getProceduralTerrainHeight(cx, cz);
      const floorY = terrainY + FLOOR_HEIGHT_OFFSET;
      const borderY = floorY + FLOOR_THICKNESS / 2 + BORDER_HEIGHT / 2;
      const halfW = floorWidth / 2;
      const halfL = floorLength / 2;

      matrix.makeTranslation(cx, borderY, cz - halfL + BORDER_WIDTH / 2);
      nsIM.setMatrixAt(nsIdx++, matrix);

      matrix.makeTranslation(cx, borderY, cz + halfL - BORDER_WIDTH / 2);
      nsIM.setMatrixAt(nsIdx++, matrix);

      matrix.makeTranslation(cx - halfW + BORDER_WIDTH / 2, borderY, cz);
      ewIM.setMatrixAt(ewIdx++, matrix);

      matrix.makeTranslation(cx + halfW - BORDER_WIDTH / 2, borderY, cz);
      ewIM.setMatrixAt(ewIdx++, matrix);
    }

    nsIM.instanceMatrix.needsUpdate = true;
    ewIM.instanceMatrix.needsUpdate = true;
    this.arenaGroup!.add(nsIM, ewIM);
  }

  /**
   * Build banner poles as InstancedMesh. 12 poles → 1 draw call.
   */
  private buildBannerPoleInstances(): void {
    const cfg = this.arenaCfg;
    const poleGeom = new THREE.CylinderGeometry(
      BANNER_POLE_RADIUS,
      BANNER_POLE_RADIUS,
      BANNER_POLE_HEIGHT,
      6,
    );
    this.geometries.push(poleGeom);

    const polesIM = new THREE.InstancedMesh(
      poleGeom,
      this.bannerPoleMat!,
      cfg.arenaCount * 2,
    );
    polesIM.castShadow = true;
    polesIM.layers.set(1);

    const matrix = new THREE.Matrix4();
    let idx = 0;

    for (let a = 0; a < cfg.arenaCount; a++) {
      const { cx, cz } = this.arenaCell(a);
      const terrainY = this.getTerrainHeight(cx, cz);
      const halfW = cfg.arenaWidth / 2;

      matrix.makeTranslation(
        cx - halfW + 0.2,
        terrainY + BANNER_POLE_HEIGHT / 2,
        cz,
      );
      polesIM.setMatrixAt(idx++, matrix);

      matrix.makeTranslation(
        cx + halfW - 0.2,
        terrainY + BANNER_POLE_HEIGHT / 2,
        cz,
      );
      polesIM.setMatrixAt(idx++, matrix);
    }

    polesIM.instanceMatrix.needsUpdate = true;
    this.arenaGroup!.add(polesIM);
  }

  // ============================================================================
  // Individual Meshes (need unique userData/layers for raycasting)
  // ============================================================================

  /**
   * Create 6 arena floors as individual meshes (need per-floor arenaId
   * and layer 0+2 for click-to-move raycasting). Shares one geometry + material.
   */
  private createArenaFloors(): void {
    const cfg = this.arenaCfg;
    const floorWidth = cfg.arenaWidth - 1;
    const floorLength = cfg.arenaLength - 1;

    let floorGeom: THREE.BoxGeometry | null = null;

    for (let i = 0; i < cfg.arenaCount; i++) {
      const { cx, cz } = this.arenaCell(i);
      const terrainY = this.getProceduralTerrainHeight(cx, cz);
      const floorY = terrainY + FLOOR_HEIGHT_OFFSET;

      if (this.world.isClient) {
        if (!floorGeom) {
          floorGeom = new THREE.BoxGeometry(
            floorWidth,
            FLOOR_THICKNESS,
            floorLength,
          );
          this.geometries.push(floorGeom);
        }

        const floor = new THREE.Mesh(floorGeom, this.arenaFloorMat!);
        // The opaque arena surface must receive contestant/prop shadows;
        // receiving on the terrain hidden beneath it cannot provide contact.
        floor.receiveShadow = true;
        floor.position.set(cx, floorY, cz);
        floor.name = `ArenaFloor_${i + 1}`;
        floor.layers.set(2);
        floor.layers.enable(0);
        floor.userData = {
          type: "arena-floor",
          walkable: true,
          arenaId: i + 1,
        };

        console.log(
          `[DuelArenaVisualsSystem] Created floor ${i + 1} at (${cx}, ${floorY.toFixed(1)}, ${cz}) - terrain=${terrainY.toFixed(1)}`,
        );

        this.arenaGroup!.add(floor);
      }

      this.createFloorCollision(
        cx,
        floorY,
        cz,
        floorWidth,
        floorLength,
        `arena_floor_${i + 1}`,
      );
    }
  }

  /**
   * Subtle bronze floor ring at each arena center — helps players judge spacing and duels read better on stream.
   */
  private createArenaCenterRings(): void {
    if (!this.world.isClient || !this.arenaGroup) return;

    const cfg = this.arenaCfg;
    // This is a subtle center reference, not the combat boundary. Keep it
    // compact in every viewport so it never becomes foreground obstruction.
    const innerR = 2.0;
    const outerR = 2.45;
    const ringGeom = new THREE.RingGeometry(innerR, outerR, 64);
    ringGeom.rotateX(-Math.PI / 2);
    this.geometries.push(ringGeom);

    const ringMat = new MeshStandardNodeMaterial({
      color: 0xd4a574,
      emissive: 0x6b4420,
      emissiveIntensity: 0.22,
      roughness: 0.52,
      metalness: 0.22,
      side: THREE.DoubleSide,
    });
    this.materials.push(ringMat);

    for (let a = 0; a < cfg.arenaCount; a++) {
      const { cx, cz } = this.arenaCell(a);
      const terrainY = this.getProceduralTerrainHeight(cx, cz);
      const floorY =
        terrainY + FLOOR_HEIGHT_OFFSET + FLOOR_THICKNESS / 2 + 0.02;

      const mesh = new THREE.Mesh(ringGeom, ringMat);
      mesh.position.set(cx, floorY, cz);
      mesh.layers.set(1);
      mesh.name = `ArenaDuelRing_${a + 1}`;
      mesh.receiveShadow = true;
      this.arenaGroup.add(mesh);
    }
  }

  /**
   * Create 12 forfeit pillars as individual meshes (need unique entityId
   * userData for interaction raycasting). Shares one geometry + material.
   */
  private createForfeitPillars(): void {
    const geom = new THREE.CylinderGeometry(
      FORFEIT_PILLAR_RADIUS,
      FORFEIT_PILLAR_RADIUS,
      FORFEIT_PILLAR_HEIGHT,
      8,
    );
    this.geometries.push(geom);

    const cfg = this.arenaCfg;
    for (let a = 0; a < cfg.arenaCount; a++) {
      const { cx, cz } = this.arenaCell(a);
      const terrainY = this.getTerrainHeight(cx, cz);

      const cornerOffset = {
        x: cfg.arenaWidth / 2 - ARENA_FORFEIT_PILLAR_INSET,
        z: cfg.arenaLength / 2 - ARENA_FORFEIT_PILLAR_INSET,
      };

      for (const [label, sx, sz] of [
        ["sw", -1, 1],
        ["ne", 1, -1],
      ] as [string, number, number][]) {
        const x = cx + sx * cornerOffset.x;
        const z = cz + sz * cornerOffset.z;
        const entityId = `forfeit_pillar_${a + 1}_${label}`;

        const pillar = new THREE.Mesh(geom, this.forfeitPillarMat!);
        pillar.position.set(x, terrainY + FORFEIT_PILLAR_HEIGHT / 2, z);
        pillar.castShadow = true;
        pillar.receiveShadow = false;
        pillar.name = entityId;
        pillar.userData = {
          entityId,
          type: "forfeit_pillar",
          name: "Trapdoor",
        };
        pillar.layers.enable(1);
        this.arenaGroup!.add(pillar);

        console.log(
          `[DuelArenaVisualsSystem] Created forfeit pillar ${entityId} at (${x.toFixed(1)}, ${(terrainY + FORFEIT_PILLAR_HEIGHT / 2).toFixed(1)}, ${z.toFixed(1)})`,
        );
      }
    }
  }

  /**
   * Create 12 banner cloths as individual meshes (3 shared color materials).
   */
  private createBannerCloths(): void {
    const clothGeom = new THREE.PlaneGeometry(
      BANNER_CLOTH_WIDTH,
      BANNER_CLOTH_HEIGHT,
    );
    this.geometries.push(clothGeom);

    const uniqueColors = [0xcc3333, 0x3366cc, 0x33aa44];
    const clothMats = uniqueColors.map((c) => {
      const m = new MeshStandardNodeMaterial({
        color: c,
        side: THREE.DoubleSide,
      });
      this.materials.push(m);
      return m;
    });

    const cfg = this.arenaCfg;
    for (let a = 0; a < cfg.arenaCount; a++) {
      const { cx, cz } = this.arenaCell(a);
      const terrainY = this.getTerrainHeight(cx, cz);
      const halfW = cfg.arenaWidth / 2;
      const matIndex = Math.min(
        Math.floor(a / cfg.columns),
        clothMats.length - 1,
      );
      const mat = clothMats[matIndex];

      for (const pos of [
        { x: cx - halfW + 0.2, z: cz },
        { x: cx + halfW - 0.2, z: cz },
      ]) {
        const cloth = new THREE.Mesh(clothGeom, mat);
        cloth.position.set(
          pos.x,
          terrainY + BANNER_POLE_HEIGHT - BANNER_CLOTH_HEIGHT / 2 - 0.1,
          pos.z,
        );
        cloth.rotation.y = Math.PI / 2;
        cloth.layers.set(1);
        this.arenaGroup!.add(cloth);
      }
    }
  }

  // ============================================================================
  // Lobby Floor & Braziers
  // ============================================================================

  private createLobbyFloor(): void {
    const terrainY = this.getProceduralTerrainHeight(
      LOBBY_CENTER_X,
      LOBBY_CENTER_Z,
    );
    const floorY = terrainY + FLOOR_HEIGHT_OFFSET;

    if (this.world.isClient) {
      const geometry = new THREE.BoxGeometry(
        LOBBY_WIDTH,
        FLOOR_THICKNESS,
        LOBBY_LENGTH,
      );

      const tileTexture = this.generateLobbyTileTexture();
      tileTexture.repeat.set(
        LOBBY_WIDTH / TILE_TEXTURE_WORLD_SIZE,
        LOBBY_LENGTH / TILE_TEXTURE_WORLD_SIZE,
      );

      const material = new MeshStandardNodeMaterial({
        color: LOBBY_FLOOR_COLOR,
        map: tileTexture,
      });

      const floor = new THREE.Mesh(geometry, material);
      floor.position.set(LOBBY_CENTER_X, floorY, LOBBY_CENTER_Z);
      floor.name = "LobbyFloor";
      floor.layers.set(2);
      floor.layers.enable(0);
      floor.userData = { type: "lobby-floor", walkable: true };

      console.log(
        `[DuelArenaVisualsSystem] Created lobby floor at (${LOBBY_CENTER_X}, ${floorY.toFixed(1)}, ${LOBBY_CENTER_Z}) - terrain=${terrainY.toFixed(1)}`,
      );

      this.geometries.push(geometry);
      this.materials.push(material);
      this.arenaGroup!.add(floor);

      this.createLobbyBraziers(terrainY);
    }

    this.createFloorCollision(
      LOBBY_CENTER_X,
      floorY,
      LOBBY_CENTER_Z,
      LOBBY_WIDTH,
      LOBBY_LENGTH,
      "lobby_floor",
    );
  }

  /**
   * Create 4 tall brazier stands at lobby corners with TSL glow bowls + fire particles.
   * Replaces 4 PointLights with GPU-animated emissive material.
   */
  private createLobbyBraziers(terrainY: number): void {
    const standGeom = new THREE.CylinderGeometry(
      0.08,
      0.1,
      LOBBY_BRAZIER_HEIGHT,
      6,
    );
    this.geometries.push(standGeom);

    const bowlGeom = new THREE.CylinderGeometry(0.08, 0.15, 0.12, 6);
    this.geometries.push(bowlGeom);

    const inset = 2.5;
    const corners = [
      {
        x: LOBBY_CENTER_X - LOBBY_WIDTH / 2 + inset,
        z: LOBBY_CENTER_Z - LOBBY_LENGTH / 2 + inset,
      },
      {
        x: LOBBY_CENTER_X + LOBBY_WIDTH / 2 - inset,
        z: LOBBY_CENTER_Z - LOBBY_LENGTH / 2 + inset,
      },
      {
        x: LOBBY_CENTER_X - LOBBY_WIDTH / 2 + inset,
        z: LOBBY_CENTER_Z + LOBBY_LENGTH / 2 - inset,
      },
      {
        x: LOBBY_CENTER_X + LOBBY_WIDTH / 2 - inset,
        z: LOBBY_CENTER_Z + LOBBY_LENGTH / 2 - inset,
      },
    ];

    for (const corner of corners) {
      const topY = terrainY + LOBBY_BRAZIER_HEIGHT;

      const stand = new THREE.Mesh(standGeom, this.lobbyStandMat!);
      stand.position.set(
        corner.x,
        terrainY + LOBBY_BRAZIER_HEIGHT / 2,
        corner.z,
      );
      stand.castShadow = true;
      stand.layers.set(1);
      this.arenaGroup!.add(stand);

      // Bowl with TSL glow (same material as arena braziers — no PointLight needed)
      const bowl = new THREE.Mesh(bowlGeom, this.brazierGlowMat!);
      bowl.position.set(corner.x, topY, corner.z);
      bowl.layers.set(1);
      this.arenaGroup!.add(bowl);
    }
  }

  // ============================================================================
  // Hospital Floor & Cross
  // ============================================================================

  private createHospitalFloor(): void {
    const terrainY = this.getProceduralTerrainHeight(
      HOSPITAL_CENTER_X,
      HOSPITAL_CENTER_Z,
    );
    const floorY = terrainY + FLOOR_HEIGHT_OFFSET;

    if (this.world.isClient) {
      const geometry = new THREE.BoxGeometry(
        HOSPITAL_WIDTH,
        FLOOR_THICKNESS,
        HOSPITAL_LENGTH,
      );

      const material = new MeshStandardNodeMaterial({
        color: HOSPITAL_FLOOR_COLOR,
      });

      const floor = new THREE.Mesh(geometry, material);
      floor.position.set(HOSPITAL_CENTER_X, floorY, HOSPITAL_CENTER_Z);
      floor.name = "HospitalFloor";
      floor.layers.set(2);
      floor.layers.enable(0);
      floor.userData = { type: "hospital-floor", walkable: true };

      console.log(
        `[DuelArenaVisualsSystem] Created hospital floor at (${HOSPITAL_CENTER_X}, ${floorY.toFixed(1)}, ${HOSPITAL_CENTER_Z}) - terrain=${terrainY.toFixed(1)}`,
      );

      this.createHospitalCross(HOSPITAL_CENTER_X, HOSPITAL_CENTER_Z, floorY);

      this.geometries.push(geometry);
      this.materials.push(material);
      this.arenaGroup!.add(floor);
    }

    this.createFloorCollision(
      HOSPITAL_CENTER_X,
      floorY,
      HOSPITAL_CENTER_Z,
      HOSPITAL_WIDTH,
      HOSPITAL_LENGTH,
      "hospital_floor",
    );
  }

  private createHospitalCross(x: number, z: number, floorY: number): void {
    const crossHeight = 0.08;
    const crossTopY = floorY + FLOOR_THICKNESS / 2 + crossHeight / 2 + 0.01;

    const crossMaterial = new MeshStandardNodeMaterial({
      color: 0xff0000,
    });
    this.materials.push(crossMaterial);

    const vertGeom = new THREE.BoxGeometry(2, crossHeight, 8);
    const vertBar = new THREE.Mesh(vertGeom, crossMaterial);
    vertBar.position.set(x, crossTopY, z);
    this.geometries.push(vertGeom);
    this.arenaGroup!.add(vertBar);

    const horizGeom = new THREE.BoxGeometry(8, crossHeight, 2);
    const horizBar = new THREE.Mesh(horizGeom, crossMaterial);
    horizBar.position.set(x, crossTopY, z);
    this.geometries.push(horizGeom);
    this.arenaGroup!.add(horizBar);

    const particleSystem = this.world.getSystem("particle") as
      ParticleSystem | undefined;
    if (particleSystem) {
      const emitterId = "healing_glow_hospital";
      particleSystem.register(emitterId, {
        type: "glow",
        preset: "altar",
        position: { x, y: crossTopY + 0.1, z },
        color: { core: 0xffffff, mid: 0x88ccff, outer: 0x44aaff },
      });
      this.particleEmitterIds.push(emitterId);
    }
  }

  // ============================================================================
  // Particle Registration
  // ============================================================================

  /**
   * Register torch fire particles on all 24 arena corner pillars.
   */
  private registerTorchParticles(): void {
    const particleSystem = this.world.getSystem("particle") as
      ParticleSystem | undefined;
    if (!particleSystem) return;

    const cfg = this.arenaCfg;
    for (let a = 0; a < cfg.arenaCount; a++) {
      const { cx, cz } = this.arenaCell(a);
      const terrainY = this.getTerrainHeight(cx, cz);
      const pillarTopY = terrainY + PILLAR_TOTAL_HEIGHT;
      const halfW = cfg.arenaWidth / 2;
      const halfL = cfg.arenaLength / 2;

      for (const corner of [
        { x: cx - halfW, z: cz - halfL, label: "nw" },
        { x: cx + halfW, z: cz - halfL, label: "ne" },
        { x: cx - halfW, z: cz + halfL, label: "sw" },
        { x: cx + halfW, z: cz + halfL, label: "se" },
      ]) {
        const emitterId = `torch_arena${a + 1}_${corner.label}`;
        particleSystem.register(emitterId, {
          type: "glow",
          preset: "fire",
          position: { x: corner.x, y: pillarTopY + 0.15, z: corner.z },
        });
        this.particleEmitterIds.push(emitterId);
      }
    }
  }

  /**
   * Register fire particles on the 4 lobby braziers.
   */
  private registerLobbyFireParticles(): void {
    const particleSystem = this.world.getSystem("particle") as
      ParticleSystem | undefined;
    if (!particleSystem) return;

    const terrainY = this.getProceduralTerrainHeight(
      LOBBY_CENTER_X,
      LOBBY_CENTER_Z,
    );
    const topY = terrainY + LOBBY_BRAZIER_HEIGHT;
    const inset = 2.5;

    for (const corner of [
      {
        x: LOBBY_CENTER_X - LOBBY_WIDTH / 2 + inset,
        z: LOBBY_CENTER_Z - LOBBY_LENGTH / 2 + inset,
        label: "nw",
      },
      {
        x: LOBBY_CENTER_X + LOBBY_WIDTH / 2 - inset,
        z: LOBBY_CENTER_Z - LOBBY_LENGTH / 2 + inset,
        label: "ne",
      },
      {
        x: LOBBY_CENTER_X - LOBBY_WIDTH / 2 + inset,
        z: LOBBY_CENTER_Z + LOBBY_LENGTH / 2 - inset,
        label: "sw",
      },
      {
        x: LOBBY_CENTER_X + LOBBY_WIDTH / 2 - inset,
        z: LOBBY_CENTER_Z + LOBBY_LENGTH / 2 - inset,
        label: "se",
      },
    ]) {
      const emitterId = `fire_lobby_${corner.label}`;
      particleSystem.register(emitterId, {
        type: "glow",
        preset: "fire",
        position: { x: corner.x, y: topY + 0.1, z: corner.z },
      });
      this.particleEmitterIds.push(emitterId);
    }
  }

  // ============================================================================
  // Lobby Tile Texture
  // ============================================================================

  private generateLobbyTileTexture(): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = TILE_TEXTURE_SIZE;
    canvas.height = TILE_TEXTURE_SIZE;
    const ctx = canvas.getContext("2d")!;

    const tileSize = TILE_TEXTURE_SIZE / LOBBY_TILE_GRID;

    ctx.fillStyle = "#8a7a5e";
    ctx.fillRect(0, 0, TILE_TEXTURE_SIZE, TILE_TEXTURE_SIZE);

    for (let row = 0; row < LOBBY_TILE_GRID; row++) {
      for (let col = 0; col < LOBBY_TILE_GRID; col++) {
        const x = col * tileSize + LOBBY_TILE_GROUT_WIDTH / 2;
        const y = row * tileSize + LOBBY_TILE_GROUT_WIDTH / 2;
        const w = tileSize - LOBBY_TILE_GROUT_WIDTH;
        const h = tileSize - LOBBY_TILE_GROUT_WIDTH;

        const rBase = 200 + Math.floor(Math.random() * 25);
        const gBase = 175 + Math.floor(Math.random() * 20);
        const bBase = 140 + Math.floor(Math.random() * 20);
        ctx.fillStyle = `rgb(${rBase},${gBase},${bBase})`;
        ctx.fillRect(x, y, w, h);

        for (let s = 0; s < 100; s++) {
          const sx = x + Math.random() * w;
          const sy = y + Math.random() * h;
          const brightness = Math.random() * 30 - 15;
          const r = Math.min(255, Math.max(0, rBase + brightness));
          const g = Math.min(255, Math.max(0, gBase + brightness));
          const b = Math.min(255, Math.max(0, bBase + brightness));
          ctx.fillStyle = `rgba(${Math.floor(r)},${Math.floor(g)},${Math.floor(b)},0.35)`;
          ctx.fillRect(sx, sy, 2 + Math.random() * 3, 2 + Math.random() * 3);
        }

        ctx.strokeStyle = "rgba(0,0,0,0.06)";
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    this.textures.push(texture);
    return texture;
  }

  // ============================================================================
  // Grass Exclusions
  // ============================================================================

  private async registerGrassExclusions(): Promise<void> {
    try {
      const { getGrassExclusionManager } =
        await import("../../systems/shared/world/GrassExclusionManager");
      const exclusionManager = getGrassExclusionManager();

      if (!exclusionManager) {
        console.warn(
          "[DuelArenaVisualsSystem] GrassExclusionManager not available",
        );
        return;
      }

      const margin = 1.0;

      const cfg = this.arenaCfg;
      for (let i = 0; i < cfg.arenaCount; i++) {
        const { cx: centerX, cz: centerZ } = this.arenaCell(i);

        exclusionManager.addRectangularBlocker(
          `duel_arena_${i + 1}`,
          centerX,
          centerZ,
          cfg.arenaWidth + margin * 2,
          cfg.arenaLength + margin * 2,
          0,
          0.5,
        );
      }

      exclusionManager.addRectangularBlocker(
        "duel_lobby",
        LOBBY_CENTER_X,
        LOBBY_CENTER_Z,
        LOBBY_WIDTH + margin * 2,
        LOBBY_LENGTH + margin * 2,
        0,
        0.5,
      );

      exclusionManager.addRectangularBlocker(
        "duel_hospital",
        HOSPITAL_CENTER_X,
        HOSPITAL_CENTER_Z,
        HOSPITAL_WIDTH + margin * 2,
        HOSPITAL_LENGTH + margin * 2,
        0,
        0.5,
      );

      console.log(
        `[DuelArenaVisualsSystem] Registered ${this.arenaCfg.arenaCount + 2} grass exclusion zones (arenas + lobby + hospital)`,
      );
    } catch (error) {
      console.warn(
        "[DuelArenaVisualsSystem] Failed to register grass exclusions:",
        error,
      );
    }
  }

  // ============================================================================
  // Physics Collision
  // ============================================================================

  /**
   * Solid perimeter walls so PhysX characters cannot pass through fence visuals.
   * (CollisionMatrix tiles alone do not block capsule controllers.)
   */
  private createArenaWallCollisions(): void {
    const cfg = this.arenaCfg;
    const wallT = ARENA_WALL_THICKNESS;
    const wallH = ARENA_WALL_HEIGHT;

    for (let a = 0; a < cfg.arenaCount; a++) {
      const { cx, cz } = this.arenaCell(a);
      const terrainY = this.getProceduralTerrainHeight(cx, cz);
      const floorCenterY = terrainY + FLOOR_HEIGHT_OFFSET;
      const wallCenterY = floorCenterY + FLOOR_THICKNESS / 2 + wallH / 2;
      const halfW = cfg.arenaWidth / 2;
      const halfL = cfg.arenaLength / 2;

      this.createBoxCollision(
        cx,
        wallCenterY,
        cz - halfL - wallT / 2,
        cfg.arenaWidth,
        wallH,
        wallT,
        `arena_wall_${a + 1}_n`,
      );
      this.createBoxCollision(
        cx,
        wallCenterY,
        cz + halfL + wallT / 2,
        cfg.arenaWidth,
        wallH,
        wallT,
        `arena_wall_${a + 1}_s`,
      );
      this.createBoxCollision(
        cx - halfW - wallT / 2,
        wallCenterY,
        cz,
        wallT,
        wallH,
        cfg.arenaLength,
        `arena_wall_${a + 1}_w`,
      );
      this.createBoxCollision(
        cx + halfW + wallT / 2,
        wallCenterY,
        cz,
        wallT,
        wallH,
        cfg.arenaLength,
        `arena_wall_${a + 1}_e`,
      );
    }
  }

  private createFloorCollision(
    centerX: number,
    centerY: number,
    centerZ: number,
    width: number,
    length: number,
    tag: string,
  ): void {
    this.createBoxCollision(
      centerX,
      centerY,
      centerZ,
      width,
      FLOOR_THICKNESS,
      length,
      tag,
    );
  }

  private createBoxCollision(
    centerX: number,
    centerY: number,
    centerZ: number,
    sizeX: number,
    sizeY: number,
    sizeZ: number,
    tag: string,
  ): void {
    const PHYSX = getPhysX();
    if (!PHYSX || !this.physicsSystem) {
      return;
    }

    const physicsInternal = this.physicsSystem as unknown as {
      physics?: unknown;
      scene?: unknown;
    };

    const physxCore = physicsInternal.physics as
      | {
          createMaterial: (sf: number, df: number, r: number) => unknown;
          createShape: (
            g: unknown,
            m: unknown,
            exclusive: boolean,
            flags: unknown,
          ) => unknown;
          createRigidStatic: (t: unknown) => PxRigidStatic;
        }
      | undefined;

    const physxScene = physicsInternal.scene as
      | {
          addActor: (a: unknown) => void;
          removeActor: (a: unknown) => void;
        }
      | undefined;

    if (!physxCore || !physxScene) {
      return;
    }

    try {
      const halfExtents = new PHYSX.PxVec3(sizeX / 2, sizeY / 2, sizeZ / 2);
      const geometry = new PHYSX.PxBoxGeometry(
        halfExtents.x,
        halfExtents.y,
        halfExtents.z,
      );

      const material = physxCore.createMaterial(0.6, 0.6, 0.1);

      const flags = new PHYSX.PxShapeFlags(
        PHYSX.PxShapeFlagEnum.eSCENE_QUERY_SHAPE |
          PHYSX.PxShapeFlagEnum.eSIMULATION_SHAPE,
      );

      const shape = physxCore.createShape(geometry, material, true, flags) as {
        setQueryFilterData: (f: unknown) => void;
        setSimulationFilterData: (f: unknown) => void;
      };

      const layer = Layers.environment || { group: 4, mask: 31 };
      const filterData = new PHYSX.PxFilterData(layer.group, layer.mask, 0, 0);
      shape.setQueryFilterData(filterData);
      shape.setSimulationFilterData(filterData);

      const transform = new PHYSX.PxTransform(
        new PHYSX.PxVec3(centerX, centerY, centerZ),
        new PHYSX.PxQuat(0, 0, 0, 1),
      );

      const body = physxCore.createRigidStatic(transform);
      body.attachShape(shape as any);

      physxScene.addActor(body);
      this.physicsBodies.push(body);

      console.log(
        `[DuelArenaVisualsSystem] Created physics collision for ${tag} at (${centerX}, ${centerY.toFixed(1)}, ${centerZ})`,
      );
    } catch (error) {
      console.warn(
        `[DuelArenaVisualsSystem] Failed to create physics collision for ${tag}:`,
        error,
      );
    }
  }

  // ============================================================================
  // Update & Destroy
  // ============================================================================

  /**
   * Update TSL time uniform for brazier glow animation.
   * All flicker is GPU-driven — no per-light JS calculations needed.
   */
  update(deltaTime: number): void {
    if (this.timeUniform) {
      this.timeUniform.value += deltaTime;
    }
  }

  destroy(): void {
    if (this.terrainSystem?.unregisterFlatZone) {
      for (const id of this.flatZoneIds) {
        this.terrainSystem.unregisterFlatZone(id);
      }
    }
    this.flatZoneIds = [];

    const particleSystem = this.world.getSystem("particle") as
      ParticleSystem | undefined;
    if (particleSystem) {
      for (const id of this.particleEmitterIds) {
        particleSystem.unregister(id);
      }
    }
    this.particleEmitterIds = [];

    if (this.physicsSystem && this.physicsBodies.length > 0) {
      const physicsInternal = this.physicsSystem as unknown as {
        scene?: unknown;
      };
      const physxScene = physicsInternal.scene as
        | {
            removeActor: (a: unknown) => void;
          }
        | undefined;

      if (physxScene) {
        for (const body of this.physicsBodies) {
          try {
            physxScene.removeActor(body);
            body.release();
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    }
    this.physicsBodies = [];

    if (this.arenaGroup && this.world.stage?.scene) {
      this.world.stage?.scene.remove(this.arenaGroup);
    }

    for (const geometry of this.geometries) {
      geometry.dispose();
    }
    this.geometries = [];

    for (const texture of this.textures) {
      texture.dispose();
    }
    this.textures = [];

    for (const material of this.materials) {
      material.dispose();
    }
    this.materials = [];

    this.arenaGroup = null;
    this.stoneFenceMat = null;
    this.arenaFloorMat = null;
    this.borderMat = null;
    this.pillarStoneMat = null;
    this.brazierGlowMat = null;
    this.forfeitPillarMat = null;
    this.bannerPoleMat = null;
    this.lobbyStandMat = null;
    this.timeUniform = null;
    this.visualsCreated = false;
    this.physicsSystem = null;
    super.destroy();
  }
}
