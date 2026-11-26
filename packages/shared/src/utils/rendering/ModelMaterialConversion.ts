import THREE, {
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
} from "../../extras/three/three";

/**
 * Make an independent PBR material while borrowing its texture and shader graph
 * inputs. This is deliberately separate from cache ownership, image conversion,
 * scene lighting and the decision to retire the original material.
 *
 * Returns null for non-PBR materials: deciding whether an unlit asset should be
 * lit is an art policy, not a lossless material conversion.
 */
export function copyPbrToNodeMaterial(
  source: THREE.Material,
  hasVertexColors = false,
): MeshStandardNodeMaterial | null {
  let target: MeshStandardNodeMaterial;
  if (source instanceof MeshStandardNodeMaterial) {
    // Includes PhysicalNodeMaterial and preserves existing node inputs. Native
    // node copy keeps a fresh material identity and copies mutable color/vectors.
    target = source.clone();
  } else if (source instanceof THREE.MeshPhysicalMaterial) {
    target = new MeshPhysicalNodeMaterial().copy(source);
  } else if (source instanceof THREE.MeshStandardMaterial) {
    target = new MeshStandardNodeMaterial().copy(source);
  } else {
    return null;
  }

  // NodeMaterial.copy does not visit inherited Material accessors such as
  // alphaTest in r186. Use the base copier too, retaining alpha/depth/blend state
  // without replacing the fresh node-material identity or borrowing listeners.
  THREE.Material.prototype.copy.call(target, source);

  if (
    target instanceof MeshPhysicalNodeMaterial &&
    (source instanceof THREE.MeshPhysicalMaterial ||
      source instanceof MeshPhysicalNodeMaterial)
  ) {
    // r186 NodeMaterial.copy assigns arrays by reference. This authored mutable
    // range belongs to the material, unlike borrowed texture/node resources.
    target.iridescenceThicknessRange = [...source.iridescenceThicknessRange];
  }
  target.vertexColors = source.vertexColors || hasVertexColors;
  return target;
}
