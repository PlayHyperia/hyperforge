/**
 * HealthBars System
 *
 * Renders health bars for all entities (players and mobs) using a single
 * instanced mesh for optimal performance with TSL Node Materials.
 *
 * Names are shown in right-click context menus only (classic MMORPG pattern).
 *
 * @see HealthBarRenderer for the drawing logic
 */

import type { Node } from "three/webgpu";
import * as THREE from "../../extras/three/three";
import {
  MeshBasicNodeMaterial,
  texture,
  uv,
  positionLocal,
  uniform,
  float,
  vec2,
  vec3,
  vec4,
  add,
  sub,
  mul,
  div,
  cross,
  instancedBufferAttribute,
  Fn,
} from "../../extras/three/three";
import { toTHREEVector3 } from "../../extras/three/three";
import type { TSLNodeVec2 } from "../../extras/three/three";
import { SystemBase } from "../shared/infrastructure/SystemBase";
import type { World } from "../../types";
import {
  drawHealthBar,
  HEALTH_BAR_DIMENSIONS,
} from "../../utils/rendering/HealthBarRenderer";

const _v3_1 = new THREE.Vector3();

// Atlas configuration
const SLOT_WIDTH = HEALTH_BAR_DIMENSIONS.WIDTH; // 160px
const SLOT_HEIGHT = HEALTH_BAR_DIMENSIONS.HEIGHT; // 16px
const BORDER_WIDTH = HEALTH_BAR_DIMENSIONS.BORDER_WIDTH; // 2px

const PER_ROW = 16;
const PER_COLUMN = 16;
const MAX_INSTANCES = PER_ROW * PER_COLUMN; // 256 health bars

const defaultQuaternion = new THREE.Quaternion(0, 0, 0, 1);
const defaultScale = toTHREEVector3(new THREE.Vector3(1, 1, 1));

/**
 * Health bar entry for tracking
 */
interface HealthBarEntry {
  idx: number;
  entityId: string;
  health: number;
  maxHealth: number;
  visible: boolean;
  hideTimeout: ReturnType<typeof setTimeout> | null;
  matrix: THREE.Matrix4;
}

/**
 * Handle returned to entities for manipulating their health bar
 */
export interface HealthBarHandle {
  entityId: string;
  /** Update position in world space */
  move: (newMatrix: THREE.Matrix4) => void;
  /** Update health value */
  setHealth: (current: number, max: number) => void;
  /** Show health bar (optionally with auto-hide timeout) */
  show: (timeoutMs?: number) => void;
  /** Hide health bar immediately */
  hide: () => void;
  /** Remove health bar from system */
  destroy: () => void;
}

export class HealthBars extends SystemBase {
  healthBars: HealthBarEntry[];
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  material: THREE.Material;
  geometry: THREE.PlaneGeometry;
  mesh: THREE.InstancedMesh;
  coordsAttribute: THREE.InstancedBufferAttribute;
  private uOrientation: { value: THREE.Quaternion };
  /** Throttle stale-entry sweep to every ~500ms instead of every frame */
  private _lastStaleSweepTime = 0;
  private static readonly STALE_SWEEP_INTERVAL_MS = 500;

  constructor(world: World) {
    super(world, {
      name: "healthbars",
      dependencies: { required: ["stage"], optional: [] },
      autoCleanup: true,
    });
    this.healthBars = [];
    this.canvas = document.createElement("canvas");
    this.canvas.width = SLOT_WIDTH * PER_ROW;
    this.canvas.height = SLOT_HEIGHT * PER_COLUMN;

    this.ctx = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = false;
    this.texture.needsUpdate = true;

    // Create uniforms
    this.uOrientation = { value: this.world.camera.quaternion };

    // Create coords attribute for atlas UV lookup
    this.coordsAttribute = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_INSTANCES * 2),
      2,
    );

    // Create TSL Node Material
    this.material = this.createHealthBarMaterial();

    // Health bar size must match player health bars
    const worldWidth = 0.5;
    const worldHeight = 0.05;
    this.geometry = new THREE.PlaneGeometry(worldWidth, worldHeight);
    this.geometry.setAttribute("coords", this.coordsAttribute);

    this.mesh = new THREE.InstancedMesh(
      this.geometry,
      this.material,
      MAX_INSTANCES,
    );
    this.mesh.renderOrder = 9998; // High render order for visibility
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  /**
   * Create TSL Node Material for billboard health bars
   */
  private createHealthBarMaterial(): THREE.Material {
    const uOrientationUniform = uniform(vec4(0, 0, 0, 1));
    const atlasTexture = this.texture;

    // Helper function to apply quaternion to position
    const applyQuaternion = Fn(([pos, quat]: [Node<"vec3">, Node<"vec4">]) => {
      const qv = vec3(quat.x, quat.y, quat.z);
      const t = mul(cross(qv, pos), float(2.0));
      return add(add(pos, mul(t, quat.w)), cross(qv, t));
    });

    // Position node with billboard orientation
    const positionNode = Fn(() => {
      const localPos = positionLocal;

      // Apply camera orientation for billboard effect
      const newPosition = applyQuaternion(localPos, uOrientationUniform);

      return newPosition;
    })();

    // Color node with atlas UV lookup
    const colorNode = Fn(() => {
      // Get coords from attribute (set per-instance)
      const coordsAttr = instancedBufferAttribute(
        this.coordsAttribute,
      ) as TSLNodeVec2;

      // Calculate atlas UV
      const baseUv = uv();
      const atlasUv = vec2(
        add(div(baseUv.x, float(PER_ROW)), coordsAttr.x),
        add(div(sub(float(1.0), baseUv.y), float(PER_COLUMN)), coordsAttr.y),
      );

      // Sample atlas texture
      const texColor = texture(atlasTexture, atlasUv);

      return texColor;
    })();

    // Create material
    const material = new MeshBasicNodeMaterial();
    material.positionNode = positionNode;
    material.colorNode = colorNode;
    material.transparent = true;
    material.depthWrite = false;
    material.depthTest = false;

    // Store uniforms for external updates
    (
      material as THREE.Material & {
        healthBarUniforms?: { uOrientation: typeof uOrientationUniform };
      }
    ).healthBarUniforms = {
      uOrientation: uOrientationUniform,
    };

    return material;
  }

  start() {
    this.world.stage.scene.add(this.mesh);
  }

  /**
   * Update orientation uniform each frame
   */
  update() {
    // Sweep for stale entries whose entities have been removed from the world.
    // Throttled to every ~500ms — stale bars are invisible (hidden after HP
    // reaches 0), so a brief delay before cleanup is imperceptible.
    const now = performance.now();
    if (now - this._lastStaleSweepTime >= HealthBars.STALE_SWEEP_INTERVAL_MS) {
      this._lastStaleSweepTime = now;
      // Iterating in reverse is required because remove() uses swap-with-last,
      // which modifies the array length — forward iteration would skip entries.
      for (let i = this.healthBars.length - 1; i >= 0; i--) {
        const entry = this.healthBars[i];
        if (!this.world.entities.get(entry.entityId)) {
          this.remove(entry);
        }
      }
    }

    // Update orientation uniform from camera
    const mat = this.material as THREE.Material & {
      healthBarUniforms?: {
        uOrientation: { value: THREE.Quaternion };
      };
    };
    if (mat.healthBarUniforms) {
      mat.healthBarUniforms.uOrientation.value.copy(
        this.world.camera.quaternion,
      );
    }
  }

  /**
   * Add a health bar for an entity
   */
  add(
    entityId: string,
    initialHealth = 100,
    maxHealth = 100,
  ): HealthBarHandle | null {
    const idx = this.healthBars.length;
    if (idx >= MAX_INSTANCES) {
      console.error("healthbars: reached max");
      return null;
    }

    // Increment instance count
    this.mesh.count++;
    this.mesh.instanceMatrix.needsUpdate = true;

    // Set atlas coordinates
    const row = Math.floor(idx / PER_ROW);
    const col = idx % PER_ROW;
    this.coordsAttribute.setXY(idx, col / PER_ROW, row / PER_COLUMN);
    this.coordsAttribute.needsUpdate = true;

    // Create entry
    const matrix = new THREE.Matrix4();
    const position = _v3_1.set(0, 0, 0);
    matrix.compose(position, defaultQuaternion, defaultScale);

    const entry: HealthBarEntry = {
      idx,
      entityId,
      health: initialHealth,
      maxHealth,
      visible: false, // Start hidden
      hideTimeout: null,
      matrix,
    };
    this.healthBars[idx] = entry;

    // Clear the slot initially (hidden)
    this.undraw(entry);

    // Create handle
    const handle: HealthBarHandle = {
      entityId,
      move: (newMatrix: THREE.Matrix4) => {
        matrix.elements[12] = newMatrix.elements[12];
        matrix.elements[13] = newMatrix.elements[13];
        matrix.elements[14] = newMatrix.elements[14];
        this.mesh.setMatrixAt(entry.idx, matrix);
        this.mesh.instanceMatrix.needsUpdate = true;
      },
      setHealth: (current: number, max: number) => {
        if (entry.health === current && entry.maxHealth === max) return;
        entry.health = current;
        entry.maxHealth = max;
        if (entry.visible) {
          this.draw(entry);
        }
      },
      show: (timeoutMs?: number) => {
        // Clear any existing timeout
        if (entry.hideTimeout) {
          clearTimeout(entry.hideTimeout);
          entry.hideTimeout = null;
        }
        entry.visible = true;
        this.draw(entry);

        // Set auto-hide timeout if specified
        if (timeoutMs !== undefined && timeoutMs > 0) {
          entry.hideTimeout = setTimeout(() => {
            entry.visible = false;
            this.undraw(entry);
            entry.hideTimeout = null;
          }, timeoutMs);
        }
      },
      hide: () => {
        if (entry.hideTimeout) {
          clearTimeout(entry.hideTimeout);
          entry.hideTimeout = null;
        }
        entry.visible = false;
        this.undraw(entry);
      },
      destroy: () => {
        this.remove(entry);
      },
    };

    return handle;
  }

  /**
   * Remove a health bar entry
   */
  private remove(entry: HealthBarEntry) {
    if (!this.healthBars.includes(entry)) {
      return console.warn("healthbars: attempted to remove non-existent entry");
    }

    // Clear timeout
    if (entry.hideTimeout) {
      clearTimeout(entry.hideTimeout);
    }

    const last = this.healthBars[this.healthBars.length - 1];
    const isLast = entry === last;

    if (isLast) {
      this.healthBars.pop();
      this.undraw(entry);
    } else {
      // Swap with last
      this.undraw(last); // Clear last's old slot
      this.undraw(entry); // Clear the removed entry's slot (prevents stale image)
      last.idx = entry.idx;
      if (last.visible) {
        this.draw(last);
      }
      // Update coords for swapped instance
      const row = Math.floor(entry.idx / PER_ROW);
      const col = entry.idx % PER_ROW;
      this.coordsAttribute.setXY(entry.idx, col / PER_ROW, row / PER_COLUMN);
      this.coordsAttribute.needsUpdate = true;
      // Update matrix and references
      this.mesh.setMatrixAt(last.idx, last.matrix);
      this.healthBars[last.idx] = last;
      this.healthBars.pop();
    }

    this.mesh.count--;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Draw health bar to atlas
   */
  private draw(entry: HealthBarEntry) {
    const idx = entry.idx;
    const row = Math.floor(idx / PER_ROW);
    const col = idx % PER_ROW;
    const x = col * SLOT_WIDTH;
    const y = row * SLOT_HEIGHT;

    // Clear slot
    this.ctx.clearRect(x, y, SLOT_WIDTH, SLOT_HEIGHT);

    // Draw health bar
    const healthPercent =
      entry.maxHealth > 0 ? entry.health / entry.maxHealth : 0;
    drawHealthBar(this.ctx, x, y, SLOT_WIDTH, SLOT_HEIGHT, healthPercent, {
      borderWidth: BORDER_WIDTH,
    });

    this.texture.needsUpdate = true;
  }

  /**
   * Clear health bar from atlas (hide)
   */
  private undraw(entry: HealthBarEntry) {
    const idx = entry.idx;
    const row = Math.floor(idx / PER_ROW);
    const col = idx % PER_ROW;
    const x = col * SLOT_WIDTH;
    const y = row * SLOT_HEIGHT;

    this.ctx.clearRect(x, y, SLOT_WIDTH, SLOT_HEIGHT);
    this.texture.needsUpdate = true;
  }

  /**
   * Find health bar by entity ID
   */
  getByEntityId(entityId: string): HealthBarEntry | undefined {
    return this.healthBars.find((e) => e.entityId === entityId);
  }

  /**
   * Tear down the system: cancel all pending hide-timers, remove the mesh
   * from the scene, and dispose GPU-allocated resources.
   *
   * Without an explicit destroy(), setTimeout callbacks set by show() can
   * fire after the world is torn down and call undraw() against a disposed
   * texture, causing WebGPU errors or silent data corruption.
   */
  destroy(): void {
    // Cancel every pending auto-hide timer before anything else
    for (const entry of this.healthBars) {
      if (entry.hideTimeout) {
        clearTimeout(entry.hideTimeout);
        entry.hideTimeout = null;
      }
    }
    this.healthBars = [];

    // Remove instanced mesh from scene
    if (this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }

    // Dispose GPU resources
    this.texture.dispose();
    this.material.dispose();
    this.geometry.dispose();
  }
}
