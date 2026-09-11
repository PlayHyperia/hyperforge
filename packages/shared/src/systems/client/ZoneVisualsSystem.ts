/**
 * ZoneVisualsSystem
 *
 * Client-side system for zone visual indicators and warnings.
 * - Adds floating emoji markers for different zone types:
 *   - 💀 Skull for wilderness/PvP zones (with red border band)
 *   - 🏠 Home for safe town areas
 *   - ⚔️ Swords for duel arena
 * - Shows chat warnings when entering/leaving dangerous zones
 *
 * @see ZoneDetectionSystem for zone logic
 */

import THREE from "../../extras/three/three";
import {
  MeshBasicNodeMaterial,
  SpriteNodeMaterial,
  LineBasicNodeMaterial,
} from "three/webgpu";
import { SystemBase } from "../shared/infrastructure/SystemBase";
import type { World } from "../../types";
import { ZoneDetectionSystem } from "../shared/death/ZoneDetectionSystem";
import { Chat } from "../shared/presentation/Chat";
import { ALL_WORLD_AREAS } from "../../data/world-areas";
import type { WorldArea } from "../../types/core/core";
import { isStreamingLikeViewport } from "../../runtime/clientViewportMode";

// Zone visual colors
const ZONE_COLORS = {
  PVP_BORDER: 0xff0000, // Bright red for PvP zone borders
  WILDERNESS_BORDER: 0x8b0000, // Dark red for wilderness borders
} as const;

// Emoji types for different zones
type ZoneEmojiType = "skull" | "home" | "swords";

/**
 * Broadcast and embedded spectator cameras cover preparation as well as the
 * arena. Eight-metre floating navigation emojis obscure those scenes and can
 * be mistaken for buildings. Keep navigation markers for ordinary gameplay;
 * this presentation policy does not affect zone detection, borders or warnings.
 */
export function shouldRenderZoneMarker(_areaId: string, win?: Window): boolean {
  return !isStreamingLikeViewport(win);
}

// Visual configuration
const ZONE_VISUAL_CONFIG = {
  BORDER_HEIGHT: 3.0, // Height of the border band walls
  MARKER_HEIGHT: 15.0, // Height of floating marker above terrain
  MARKER_SIZE: 8.0, // Size of marker sprite
  BOB_AMPLITUDE: 1.5, // How much the marker bobs up and down
  BOB_SPEED: 1.2, // Speed of bobbing animation
  PULSE_SPEED: 0.3, // Speed of scale pulse
} as const;

// Glow colors for different emoji types
const EMOJI_GLOW_COLORS: Record<ZoneEmojiType, string> = {
  skull: "rgba(255, 0, 0, 0.8)", // Red glow
  home: "rgba(255, 215, 0, 0.8)", // Gold glow
  swords: "rgba(192, 192, 192, 0.8)", // Silver glow
};

/**
 * Zone visual handle with optional border and marker
 */
interface ZoneVisualHandle {
  borderGroup: THREE.Group | null;
  markerSprite: THREE.Sprite | null;
  area: WorldArea;
  baseMarkerY: number;
}

export class ZoneVisualsSystem extends SystemBase {
  private zoneVisuals: Map<string, ZoneVisualHandle> = new Map();
  private lastZoneType: "safe" | "pvp" | "wilderness" | null = null;
  private lastZoneName: string | null = null;
  private checkInterval = 0.5; // Check position every 0.5 seconds
  private timeSinceLastCheck = 0;
  private elapsedTime = 0;
  private emojiTextures: Map<ZoneEmojiType, THREE.CanvasTexture> = new Map();

  constructor(world: World) {
    super(world, {
      name: "zone-visuals",
      dependencies: {
        required: ["stage", "zone-detection"],
        optional: ["chat"],
      },
      autoCleanup: true,
    });
  }

  start(): void {
    console.log("[ZoneVisualsSystem] start() called, creating zone visuals...");
    // Create zone visual elements (moved from init to ensure scene is ready)
    this.createZoneVisuals();
    // Initialize player zone state
    this.updatePlayerZoneState();
  }

  /**
   * Create a canvas texture with an emoji and glow effect
   */
  private createEmojiTexture(
    emoji: string,
    type: ZoneEmojiType,
  ): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    const size = 256;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");

    if (ctx) {
      // Clear with transparency
      ctx.clearRect(0, 0, size, size);

      // Draw emoji
      ctx.font = `${size * 0.8}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(emoji, size / 2, size / 2);

      // Add subtle glow effect
      ctx.shadowColor = EMOJI_GLOW_COLORS[type];
      ctx.shadowBlur = 20;
      ctx.fillText(emoji, size / 2, size / 2);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  private getOrCreateEmojiTexture(type: ZoneEmojiType): THREE.CanvasTexture {
    const cachedTexture = this.emojiTextures.get(type);
    if (cachedTexture) {
      return cachedTexture;
    }

    const emoji = type === "skull" ? "💀" : type === "home" ? "🏠" : "⚔️";
    const texture = this.createEmojiTexture(emoji, type);
    this.emojiTextures.set(type, texture);
    return texture;
  }

  /**
   * Determine what emoji type a zone should have
   */
  private getZoneEmojiType(area: WorldArea): ZoneEmojiType | null {
    // Duel arena gets swords
    if (area.id === "duel_arena") {
      return "swords";
    }
    // Wilderness/PvP zones (not duel arena) — skull disabled for now
    // if (!area.safeZone || (area.pvpEnabled && area.id !== "duel_arena")) {
    //   return "skull";
    // }
    // Safe towns get home
    if (area.safeZone && !area.pvpEnabled) {
      return "home";
    }
    return null;
  }

  /**
   * Check if zone should have a red border band
   */
  private shouldHaveBorder(_area: WorldArea): boolean {
    // Borders disabled for now
    return false;
  }

  /**
   * Create border band geometry around a zone
   */
  private createBorderBand(
    width: number,
    depth: number,
    height: number,
    color: number,
  ): THREE.Group {
    const group = new THREE.Group();

    // Create vertical wall strips around the perimeter (very transparent to not block grass)
    const wallMaterial = new MeshBasicNodeMaterial();
    wallMaterial.color = new THREE.Color(color);
    wallMaterial.transparent = true;
    wallMaterial.opacity = 0.15;
    wallMaterial.side = THREE.DoubleSide;
    wallMaterial.depthWrite = false;

    // North wall (positive Z boundary)
    const northGeom = new THREE.PlaneGeometry(width, height);
    const northWall = new THREE.Mesh(northGeom, wallMaterial);
    northWall.position.set(0, height / 2, depth / 2);
    group.add(northWall);

    // South wall (negative Z boundary)
    const southGeom = new THREE.PlaneGeometry(width, height);
    const southWall = new THREE.Mesh(southGeom, wallMaterial);
    southWall.position.set(0, height / 2, -depth / 2);
    southWall.rotation.y = Math.PI;
    group.add(southWall);

    // East wall (positive X boundary)
    const eastGeom = new THREE.PlaneGeometry(depth, height);
    const eastWall = new THREE.Mesh(eastGeom, wallMaterial);
    eastWall.position.set(width / 2, height / 2, 0);
    eastWall.rotation.y = -Math.PI / 2;
    group.add(eastWall);

    // West wall (negative X boundary)
    const westGeom = new THREE.PlaneGeometry(depth, height);
    const westWall = new THREE.Mesh(westGeom, wallMaterial);
    westWall.position.set(-width / 2, height / 2, 0);
    westWall.rotation.y = Math.PI / 2;
    group.add(westWall);

    // Add glowing edge lines at the top
    const lineMaterial = new LineBasicNodeMaterial();
    lineMaterial.color = new THREE.Color(color);
    lineMaterial.transparent = true;
    lineMaterial.opacity = 1.0;

    // Create top edge outline
    const topEdgePoints = [
      new THREE.Vector3(-width / 2, height, -depth / 2),
      new THREE.Vector3(width / 2, height, -depth / 2),
      new THREE.Vector3(width / 2, height, depth / 2),
      new THREE.Vector3(-width / 2, height, depth / 2),
      new THREE.Vector3(-width / 2, height, -depth / 2),
    ];
    const topEdgeGeom = new THREE.BufferGeometry().setFromPoints(topEdgePoints);
    const topEdgeLine = new THREE.Line(topEdgeGeom, lineMaterial);
    group.add(topEdgeLine);

    // Create bottom edge outline
    const bottomEdgePoints = [
      new THREE.Vector3(-width / 2, 0, -depth / 2),
      new THREE.Vector3(width / 2, 0, -depth / 2),
      new THREE.Vector3(width / 2, 0, depth / 2),
      new THREE.Vector3(-width / 2, 0, depth / 2),
      new THREE.Vector3(-width / 2, 0, -depth / 2),
    ];
    const bottomEdgeGeom = new THREE.BufferGeometry().setFromPoints(
      bottomEdgePoints,
    );
    const bottomEdgeLine = new THREE.Line(bottomEdgeGeom, lineMaterial);
    group.add(bottomEdgeLine);

    // Mark all children to ignore click-to-move
    group.traverse((obj) => {
      obj.userData.ignoreClickMove = true;
    });

    return group;
  }

  /**
   * Create floating marker sprite with the given emoji type
   */
  private createMarkerSprite(emojiType: ZoneEmojiType): THREE.Sprite {
    const texture = this.getOrCreateEmojiTexture(emojiType);
    const material = new SpriteNodeMaterial();
    material.map = texture;
    material.transparent = true;
    material.depthWrite = false;

    const sprite = new THREE.Sprite(material);
    sprite.scale.set(
      ZONE_VISUAL_CONFIG.MARKER_SIZE,
      ZONE_VISUAL_CONFIG.MARKER_SIZE,
      1,
    );
    sprite.userData.ignoreClickMove = true;

    return sprite;
  }

  /**
   * Create visual elements for all zones (markers and optional border bands)
   */
  private createZoneVisuals(): void {
    const areas = Object.values(ALL_WORLD_AREAS) as WorldArea[];
    console.log(
      `[ZoneVisualsSystem] Creating zone visuals. Total areas: ${areas.length}`,
      areas.map((a) => ({
        id: a.id,
        safeZone: a.safeZone,
        pvpEnabled: a.pvpEnabled,
        bounds: a.bounds,
      })),
    );

    for (const area of areas) {
      const width = area.bounds.maxX - area.bounds.minX;
      const depth = area.bounds.maxZ - area.bounds.minZ;
      const centerX = (area.bounds.minX + area.bounds.maxX) / 2;
      const centerZ = (area.bounds.minZ + area.bounds.maxZ) / 2;

      // Get terrain height at center of zone
      let terrainY = 0;
      const terrain = this.world.getSystem("terrain") as {
        getHeightAt?: (x: number, z: number) => number;
      } | null;
      if (terrain?.getHeightAt) {
        terrainY = terrain.getHeightAt(centerX, centerZ);
      }

      // Create border band only for wilderness zones (not duel arena or safe zones)
      let borderGroup: THREE.Group | null = null;
      if (this.shouldHaveBorder(area)) {
        const borderColor = area.pvpEnabled
          ? ZONE_COLORS.PVP_BORDER
          : ZONE_COLORS.WILDERNESS_BORDER;

        borderGroup = this.createBorderBand(
          width,
          depth,
          ZONE_VISUAL_CONFIG.BORDER_HEIGHT,
          borderColor,
        );
        borderGroup.position.set(centerX, terrainY + 10, centerZ);
        borderGroup.name = `zone-border-${area.id}`;
      }

      // Create floating marker sprite based on zone type
      let markerSprite: THREE.Sprite | null = null;
      const baseMarkerY = terrainY + ZONE_VISUAL_CONFIG.MARKER_HEIGHT;
      const emojiType = shouldRenderZoneMarker(area.id)
        ? this.getZoneEmojiType(area)
        : null;

      if (emojiType) {
        markerSprite = this.createMarkerSprite(emojiType);
        markerSprite.position.set(centerX, baseMarkerY, centerZ);
        markerSprite.name = `zone-marker-${area.id}`;
      }

      // Add to scene
      if (this.world.stage?.scene) {
        if (borderGroup) {
          this.world.stage.scene.add(borderGroup);
          console.log(
            `[ZoneVisualsSystem] ✅ Added border band for "${area.name}" at (${centerX}, ${terrainY + 10}, ${centerZ}), size: ${width}x${depth}`,
          );
        }

        if (markerSprite) {
          this.world.stage.scene.add(markerSprite);
          console.log(
            `[ZoneVisualsSystem] ✅ Added floating ${emojiType} marker for "${area.name}" at height ${baseMarkerY}`,
          );
        }
      } else {
        console.warn(
          `[ZoneVisualsSystem] ⚠️ No stage/scene available for zone visuals`,
        );
      }

      this.zoneVisuals.set(area.id, {
        borderGroup,
        markerSprite,
        area,
        baseMarkerY,
      });
      this.logger.info(
        `Created zone visuals for ${area.name} (${borderGroup ? "border + " : ""}${emojiType ?? "no marker"})`,
      );
    }
  }

  /**
   * Check player position and update zone warnings, animate markers
   */
  update(dt: number): void {
    this.elapsedTime += dt;

    // Animate floating markers
    for (const [, handle] of this.zoneVisuals) {
      if (handle.markerSprite) {
        // Bob up and down
        const bobOffset =
          Math.sin(this.elapsedTime * ZONE_VISUAL_CONFIG.BOB_SPEED) *
          ZONE_VISUAL_CONFIG.BOB_AMPLITUDE;
        handle.markerSprite.position.y = handle.baseMarkerY + bobOffset;

        // Subtle scale pulse
        const scalePulse =
          1.0 +
          Math.sin(this.elapsedTime * ZONE_VISUAL_CONFIG.PULSE_SPEED) * 0.05;
        handle.markerSprite.scale.set(
          ZONE_VISUAL_CONFIG.MARKER_SIZE * scalePulse,
          ZONE_VISUAL_CONFIG.MARKER_SIZE * scalePulse,
          1,
        );
      }
    }

    // Check zone state periodically
    this.timeSinceLastCheck += dt;
    if (this.timeSinceLastCheck < this.checkInterval) return;
    this.timeSinceLastCheck = 0;

    this.updatePlayerZoneState();
  }

  /**
   * Update player's zone state and show warnings
   */
  private updatePlayerZoneState(): void {
    const player = this.world.entities?.player;
    if (!player) return;

    const position = player.position;
    if (!position) return;

    const zoneSystem =
      this.world.getSystem<ZoneDetectionSystem>("zone-detection");
    if (!zoneSystem) return;

    const zoneProps = zoneSystem.getZoneProperties({
      x: position.x,
      z: position.z,
    });

    // Determine current zone type
    let currentType: "safe" | "pvp" | "wilderness";
    if (zoneProps.isPvPEnabled) {
      currentType = "pvp";
    } else if (zoneProps.isSafe) {
      currentType = "safe";
    } else {
      currentType = "wilderness";
    }

    // Check for zone transition
    if (this.lastZoneType !== null && this.lastZoneType !== currentType) {
      this.showZoneTransitionWarning(
        this.lastZoneType,
        currentType,
        zoneProps.name,
      );
    }

    this.lastZoneType = currentType;
    this.lastZoneName = zoneProps.name;
  }

  /**
   * Show zone transition warning in chat
   */
  private showZoneTransitionWarning(
    from: "safe" | "pvp" | "wilderness",
    to: "safe" | "pvp" | "wilderness",
    zoneName: string,
  ): void {
    const chat = this.world.getSystem<Chat>("chat");
    if (!chat) return;

    let message = "";

    if (to === "pvp") {
      // Entering PvP zone - RED warning
      message = `[WARNING] Entering ${zoneName} - PvP enabled! Other players can attack you here.`;
    } else if (to === "wilderness") {
      // Entering wilderness - YELLOW warning
      message = `[CAUTION] Entering ${zoneName} - Dangerous area!`;
    } else if (from === "pvp" && to === "safe") {
      // Leaving PvP zone - GREEN message
      message = `[SAFE] You have left the PvP zone and entered a safe area.`;
    } else if (from === "wilderness" && to === "safe") {
      // Leaving wilderness - GREEN message
      message = `[SAFE] You have returned to a safe area.`;
    }

    if (message) {
      chat.add({
        id: `zone-warning-${Date.now()}`,
        from: "System",
        fromId: "system",
        body: message,
        text: message,
        timestamp: Date.now(),
        createdAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Cleanup zone visuals
   */
  destroy(): void {
    for (const [, handle] of this.zoneVisuals) {
      // Clean up border group
      if (handle.borderGroup) {
        handle.borderGroup.traverse((obj) => {
          if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
            obj.geometry.dispose();
            if (obj.material instanceof THREE.Material) {
              obj.material.dispose();
            }
          }
        });
        this.world.stage?.scene.remove(handle.borderGroup);
      }

      // Clean up marker sprite
      if (handle.markerSprite) {
        if (handle.markerSprite.material instanceof THREE.Material) {
          handle.markerSprite.material.dispose();
        }
        this.world.stage?.scene.remove(handle.markerSprite);
      }
    }
    this.zoneVisuals.clear();

    // Clean up shared textures
    for (const [, texture] of this.emojiTextures) {
      texture.dispose();
    }
    this.emojiTextures.clear();
  }
}
