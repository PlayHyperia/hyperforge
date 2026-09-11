/**
 * TreeGLBVisualStrategy — Unified tree visual strategy.
 *
 * Delegates to one of two instancers based on the manifest config:
 * - **BatchedMesh** (GLBTreeBatchedInstancer) for trees with `modelVariants`
 *   — fewer draw calls when many variants share the same material.
 * - **InstancedMesh** (GLBTreeInstancer) for trees with a single `model` path.
 *
 * All other lifecycle methods (depleted, highlight, respawn, destroy)
 * dispatch to whichever instancer owns the entity.
 */

import THREE from "../../../extras/three/three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { GPU_VEG_CONFIG } from "../../../systems/shared/world/GPUMaterials";
import {
  addInstance as addInstancedTree,
  removeInstance as removeInstancedTree,
  setHighlight as setInstancedHighlight,
  getModelDimensions as getInstancedDimensions,
  getProxyGeometry as getInstancedProxyGeometry,
  hasInstance as isInInstancedPool,
  updateGLBTreeInstancer,
  startDissolve as startInstancedDissolve,
  type TreeInstanceLifetime,
} from "../../../systems/shared/world/GLBTreeInstancer";
import {
  addInstance as addBatchedTree,
  removeInstance as removeBatchedTree,
  setHighlight as setBatchedHighlight,
  getModelDimensions as getBatchedDimensions,
  getProxyGeometry as getBatchedProxyGeometry,
  hasInstance as isInBatchedPool,
  updateGLBTreeBatchedInstancer,
  startDissolve as startBatchedDissolve,
} from "../../../systems/shared/world/GLBTreeBatchedInstancer";
import type {
  ResourceVisualContext,
  ResourceVisualStrategy,
} from "./ResourceVisualStrategy";

/**
 * Merge multiple BufferGeometry parts into one for the collision proxy.
 * Only copies position + index — normals/UVs are unnecessary for raycasting.
 */
function mergeGeometries(
  parts: THREE.BufferGeometry[],
): THREE.BufferGeometry | null {
  // Filter out any parts missing position data (malformed GLBs)
  const valid = parts.filter((g) => g.getAttribute("position"));
  if (valid.length === 0) return null;
  // Single-part: return the shared geometry directly — caller must clone before mutating.
  if (valid.length === 1) return valid[0];

  let totalVerts = 0;
  let totalIndices = 0;
  for (const g of valid) {
    const pos = g.getAttribute("position");
    totalVerts += pos.count;
    totalIndices += g.index ? g.index.count : pos.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIndices);
  let vertOffset = 0;
  let idxOffset = 0;

  for (const g of valid) {
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    // Bulk copy when the backing array is a contiguous Float32Array (common for loaded GLBs)
    if (pos.array instanceof Float32Array && pos.itemSize === 3) {
      positions.set(
        new Float32Array(pos.array.buffer, pos.array.byteOffset, pos.count * 3),
        vertOffset * 3,
      );
    } else {
      for (let i = 0; i < pos.count; i++) {
        positions[(vertOffset + i) * 3] = pos.getX(i);
        positions[(vertOffset + i) * 3 + 1] = pos.getY(i);
        positions[(vertOffset + i) * 3 + 2] = pos.getZ(i);
      }
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) {
        indices[idxOffset + i] = g.index.getX(i) + vertOffset;
      }
      idxOffset += g.index.count;
    } else {
      for (let i = 0; i < pos.count; i++) {
        indices[idxOffset + i] = vertOffset + i;
      }
      idxOffset += pos.count;
    }
    vertOffset += pos.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.computeBoundingSphere();
  return merged;
}

// Cache merged+scaled proxy geometry per (sourceGeometries identity, scale) to avoid
// redundant merge/clone/scale work for trees sharing the same model variant and scale.
// NOTE: This cache only grows; it is cleared on world teardown via clearProxyGeometryCache().
// This is fine as long as tree scales are discrete (e.g. from manifest modelScale values).
const _proxyGeometryCache = new Map<
  THREE.BufferGeometry[],
  Map<number, THREE.BufferGeometry>
>();

/**
 * Dispose all cached proxy geometries and clear the cache.
 * Must be called during world teardown to prevent GPU buffer leaks.
 */
export function clearProxyGeometryCache(): void {
  for (const scaleMap of _proxyGeometryCache.values()) {
    for (const geo of scaleMap.values()) geo.dispose();
  }
  _proxyGeometryCache.clear();
}

function getOrCreateProxyGeometry(
  sourceGeometries: THREE.BufferGeometry[],
  scale: number,
): THREE.BufferGeometry | null {
  // Round scale to 3 decimal places to avoid floating-point cache misses
  const key = Math.round(scale * 1000) / 1000;
  let scaleMap = _proxyGeometryCache.get(sourceGeometries);
  if (scaleMap) {
    const cached = scaleMap.get(key);
    if (cached) return cached;
  }

  const merged = mergeGeometries(sourceGeometries);
  if (!merged) return null;

  // Always clone — mergeGeometries may return the pool's shared geometry directly
  // (single-part case) or a freshly created merge. Cloning unconditionally ensures
  // the cached entry is always an independent copy safe for Three.js raycaster use.
  const scaled = merged.clone();
  scaled.scale(scale, scale, scale);
  // Pre-compute both bounds so Three.js raycaster never lazily mutates this geometry
  scaled.computeBoundingBox();
  scaled.computeBoundingSphere();

  if (!scaleMap) {
    scaleMap = new Map();
    _proxyGeometryCache.set(sourceGeometries, scaleMap);
  }
  scaleMap.set(key, scaled);
  return scaled;
}

interface OwnedTreeProxy {
  mesh: THREE.Mesh<THREE.BufferGeometry, MeshBasicNodeMaterial>;
  ownsGeometry: boolean;
}

function createCollisionProxy(
  ctx: ResourceVisualContext,
  scale: number,
  batched: boolean,
): OwnedTreeProxy {
  // Try to use the actual LOD2 model geometry for a pixel-accurate collision proxy.
  // This matches the visible tree silhouette so clicks only register on the model itself.
  const proxyData = batched
    ? getBatchedProxyGeometry(ctx.id)
    : getInstancedProxyGeometry(ctx.id);
  const cachedGeometry = proxyData
    ? getOrCreateProxyGeometry(proxyData.geometries, scale)
    : null;

  let geometry: THREE.BufferGeometry;
  let yPos: number;

  if (cachedGeometry && proxyData) {
    // NOTE: This geometry is shared across all proxies with the same model+scale.
    // It must not be mutated — the proxy mesh is invisible and used only for
    // raycasting, so Three.js internals won't modify it in normal operation.
    geometry = cachedGeometry;
    // Align with visual: instancer shifts instances up by yOffset * scale
    yPos = proxyData.yOffset * scale;
  } else {
    // Fallback: tighter trunk-only cylinder (only if LOD geometry unavailable).
    // Reduced from 0.4 to 0.25 since the LOD proxy now handles canopy clicks;
    // this path should rarely trigger — LOD data is typically available by the
    // time createCollisionProxy is called after a successful addInstance.
    console.warn(
      `[TreeProxy] LOD geometry unavailable for ${ctx.id}, using cylinder fallback`,
    );
    const dims = batched
      ? getBatchedDimensions(ctx.id)
      : getInstancedDimensions(ctx.id);
    const height = (dims?.height ?? 8) * scale;
    const fullRadius = (dims?.radius ?? 1) * scale;
    const radius = Math.max(fullRadius * 0.25, 0.3);
    geometry = new THREE.CylinderGeometry(radius, radius, height, 6);
    yPos = height / 2;
  }

  const material = new MeshBasicNodeMaterial();
  material.visible = false;

  const proxy = new THREE.Mesh(geometry, material);
  proxy.position.y = yPos;
  proxy.name = `TreeProxy_${ctx.id}`;
  proxy.userData = {
    type: "resource",
    entityId: ctx.id,
    name: ctx.config.name,
    interactable: true,
    resourceType: ctx.config.resourceType,
  };
  proxy.layers.set(1);

  ctx.node.add(proxy);
  ctx.setMesh(proxy);
  return { mesh: proxy, ownsGeometry: !cachedGeometry };
}

export class TreeGLBVisualStrategy implements ResourceVisualStrategy {
  private destroyed = false;
  private lifetime: TreeInstanceLifetime | undefined;
  private proxy: OwnedTreeProxy | undefined;

  private removeProxy(ctx: ResourceVisualContext): void {
    const proxy = this.proxy;
    if (!proxy) return;
    this.proxy = undefined;
    proxy.mesh.removeFromParent();
    if (ctx.getMesh() === proxy.mesh) ctx.setMesh(null);
    proxy.mesh.material.dispose();
    if (proxy.ownsGeometry) proxy.mesh.geometry.dispose();
  }

  private ownsInstance(ctx: ResourceVisualContext): boolean {
    return (
      !!this.lifetime &&
      this.lifetime.isCurrent() &&
      (isInBatchedPool(ctx.id, this.lifetime) ||
        isInInstancedPool(ctx.id, this.lifetime))
    );
  }

  async createVisual(ctx: ResourceVisualContext): Promise<void> {
    if (this.destroyed) return;
    const { config, id, position } = ctx;
    const previous = this.lifetime;
    const lifetime: TreeInstanceLifetime = {
      isCurrent: () => !this.destroyed && this.lifetime === lifetime,
      getInitialDissolve: () =>
        config.depleted ? GPU_VEG_CONFIG.DISSOLVE_MAX : 0,
    };
    this.lifetime = lifetime;
    this.removeProxy(ctx);
    if (previous) {
      removeBatchedTree(id, previous);
      removeInstancedTree(id, previous);
    }

    const baseScale = config.modelScale ?? 3.0;
    const worldPos = new THREE.Vector3();
    ctx.node.getWorldPosition(worldPos);

    const rotHash = ctx.hashString(
      `${id}_${position.x.toFixed(1)}_${position.z.toFixed(1)}`,
    );
    const rotation = ((rotHash % 1000) / 1000) * Math.PI * 2;

    // The lifetime reads current depletion at pool insertion, after all loading.
    let success = false;

    if (config.modelVariants?.length) {
      const treeType = config.resourceId.replace(/^tree_/, "");
      const hash = ctx.hashString(id) >>> 0;
      const variantIndex = hash % config.modelVariants.length;

      success = await addBatchedTree(
        treeType,
        config.modelVariants,
        variantIndex,
        id,
        worldPos,
        rotation,
        baseScale,
        0,
        lifetime,
      );
    } else {
      let modelPath = config.model;
      if (!modelPath) return;

      success = await addInstancedTree(
        modelPath,
        id,
        worldPos,
        rotation,
        baseScale,
        null, // lod1ModelPath — auto-inferred by instancer
        null, // lod2ModelPath — auto-inferred by instancer
        0,
        lifetime,
      );
    }

    if (success && lifetime.isCurrent() && this.ownsInstance(ctx)) {
      this.proxy = createCollisionProxy(
        ctx,
        baseScale,
        !!config.modelVariants?.length,
      );

      if (config.depleted) {
        const proxy = ctx.getMesh();
        if (proxy) {
          proxy.userData.depleted = true;
          proxy.userData.interactable = false;
        }
      }
    }
  }

  async onDepleted(ctx: ResourceVisualContext): Promise<boolean> {
    // Always returns true — dissolve handles depletion for all trees.
    // Returning false would trigger ResourceEntity.loadDepletedModel() fallback,
    // which is only needed by non-tree strategies (e.g. InstancedModelVisualStrategy).
    if (!this.ownsInstance(ctx)) return true;
    if (isInBatchedPool(ctx.id, this.lifetime)) {
      startBatchedDissolve(ctx.id, 1, true);
    } else {
      startInstancedDissolve(ctx.id, 1, true);
    }
    const proxy = ctx.getMesh();
    if (proxy) {
      proxy.userData.depleted = true;
      proxy.userData.interactable = false;
    }
    return true;
  }

  setShaderHighlight(ctx: ResourceVisualContext, on: boolean): void {
    if (!this.ownsInstance(ctx)) return;
    if (isInBatchedPool(ctx.id, this.lifetime)) {
      setBatchedHighlight(ctx.id, on);
    } else {
      setInstancedHighlight(ctx.id, on);
    }
  }

  async onRespawn(ctx: ResourceVisualContext): Promise<void> {
    if (!this.ownsInstance(ctx)) return;
    // Start reverse dissolve animation (trunk → canopy)
    if (isInBatchedPool(ctx.id, this.lifetime)) {
      startBatchedDissolve(ctx.id, -1);
    } else {
      startInstancedDissolve(ctx.id, -1);
    }
    const proxy = ctx.getMesh();
    if (proxy) {
      proxy.userData.depleted = false;
      proxy.userData.interactable = true;
    }
  }

  update(_ctx: ResourceVisualContext, deltaTime: number): void {
    updateGLBTreeInstancer(deltaTime);
    updateGLBTreeBatchedInstancer(deltaTime);
  }

  destroy(ctx: ResourceVisualContext): void {
    this.destroyed = true;
    if (this.lifetime) {
      removeBatchedTree(ctx.id, this.lifetime);
      removeInstancedTree(ctx.id, this.lifetime);
    }
    this.removeProxy(ctx);
  }
}
