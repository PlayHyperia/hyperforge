import { NoBlending, NormalBlending, type Material, type Mesh } from "three";
import { resolveExplicitStreamingRenderProfile } from "../../runtime/clientViewportMode";

/** Resolve the same startup-only candidate as the actual streaming viewport. */
export function isCharacterShadowCandidateActive(): boolean {
  return resolveExplicitStreamingRenderProfile()?.id === "shadows-720p60-v1";
}

function isSolidShadowSurface(material: Material): boolean {
  const surface = material as Material & {
    isMeshStandardMaterial?: boolean;
    isMeshStandardNodeMaterial?: boolean;
    transmission?: number;
  };
  return (
    (surface.isMeshStandardMaterial === true ||
      surface.isMeshStandardNodeMaterial === true) &&
    material.visible &&
    material.colorWrite &&
    material.depthTest &&
    material.depthWrite &&
    material.opacity === 1 &&
    // Alpha-cutout hair/cloth still has a physical silhouette. Blended effects,
    // corneas and non-depth-writing overlays must not become opaque occluders.
    (!material.transparent || material.alphaTest > 0) &&
    (material.blending === NormalBlending ||
      material.blending === NoBlending) &&
    (surface.transmission === undefined || surface.transmission === 0)
  );
}

/**
 * Preparation/attachment only: no traversal, material mutation or frame work.
 * Legacy owners retain their flags until the explicit candidate is selected.
 * Three shadow flags are mesh-wide, so mixed physical/effect material groups
 * stay excluded rather than turning a translucent group into an occluder.
 */
export function applyCharacterMeshShadowPolicy(
  mesh: Mesh,
  candidate: boolean,
): void {
  if (!candidate) return;
  const materials = Array.isArray(mesh.material)
    ? mesh.material
    : [mesh.material];
  const physical =
    materials.length > 0 && materials.every(isSolidShadowSurface);
  mesh.castShadow = physical;
  mesh.receiveShadow = physical;
}
