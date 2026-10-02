import THREE from "../../../extras/three/three";
import type Node from "three/src/nodes/core/Node.js";
import type NodeBuilder from "three/src/nodes/core/NodeBuilder.js";
import type { LightingModelDirectInput } from "three/src/nodes/core/LightingModel.js";
import type { LightingContext } from "three/src/nodes/lighting/LightingContextNode.js";
import {
  DFGLUT,
  EPSILON,
  F_Schlick,
  diffuseColor,
  diffuseContribution,
  float,
  ior,
  metalness,
  normalView,
  positionViewDirection,
  roughness,
  specularColor,
  specularColorBlended,
  specularF90,
  vec3,
} from "three/tsl";

const ConvertNode = THREE.ConvertNode;

const unsupportedScalars = [
  "anisotropy",
  "clearcoat",
  "retroreflectivity",
  "transmission",
  "sheen",
  "iridescence",
  "dispersion",
] as const;
const unsupportedFlags = [
  "useAnisotropy",
  "useClearcoat",
  "useRetroreflection",
  "useTransmission",
  "useSheen",
  "useIridescence",
  "useDispersion",
] as const;
const unsupportedNodesAndMaps = [
  "roughnessNode",
  "roughnessMap",
  "metalnessNode",
  "metalnessMap",
  "envMap",
  "anisotropyNode",
  "anisotropyMap",
  "clearcoatNode",
  "clearcoatRoughnessNode",
  "clearcoatNormalNode",
  "clearcoatMap",
  "clearcoatNormalMap",
  "clearcoatRoughnessMap",
  "retroreflectivityNode",
  "transmissionNode",
  "transmissionMap",
  "sheenNode",
  "sheenRoughnessNode",
  "sheenColorMap",
  "sheenRoughnessMap",
  "iridescenceNode",
  "iridescenceIORNode",
  "iridescenceThicknessNode",
  "iridescenceMap",
  "iridescenceThicknessMap",
  "dispersionNode",
  "iorNode",
  "specularIntensityNode",
  "specularColorNode",
  "specularIntensityMap",
  "specularColorMap",
  "lightsNode",
  "fragmentNode",
  "backdropNode",
  "contextNode",
] as const;

/** Only the existing matte dielectric recipe has the following algebra. */
export function supportsRoughLeafRecipe(material: THREE.Material): boolean {
  if (
    !(material instanceof THREE.MeshSSSNodeMaterial) ||
    material.lights !== true ||
    material.roughness !== 1 ||
    material.metalness !== 0 ||
    material.ior !== 1.5 ||
    material.specularIntensity !== 1 ||
    material.specularColor.r !== 1 ||
    material.specularColor.g !== 1 ||
    material.specularColor.b !== 1 ||
    !material.thicknessColorNode ||
    !material.thicknessDistortionNode ||
    !material.thicknessAmbientNode ||
    !material.thicknessAttenuationNode ||
    !material.thicknessPowerNode ||
    !material.thicknessScaleNode
  )
    return false;
  // Reflect reads real r186 fields absent from the older installed declarations.
  for (const name of unsupportedScalars)
    if (Reflect.get(material, name) !== 0) return false;
  for (const name of unsupportedFlags)
    if (Reflect.get(material, name) !== false) return false;
  for (const name of unsupportedNodesAndMaps)
    if (Reflect.get(material, name) != null) return false;
  return true;
}

/** r186 dielectric multiscattering, shared across all indirect terms. This
 * retains the original DFG lookup, not a fitted or prefiltered BRDF table. */
export function createRoughLeafDielectricResponse(
  dfg: Node<"vec2">,
  f0: Node<"float">,
) {
  const single = f0.mul(dfg.x).add(dfg.y).toVar("roughLeafSingleScatter");
  const energy = dfg.x.add(dfg.y).toVar("roughLeafSingleEnergy");
  const missing = energy.oneMinus().toVar("roughLeafMissingEnergy");
  // Preserve r186's 0.047619 coefficient, rather than substituting exact 1/21.
  const average = f0.add(f0.oneMinus().mul(0.047619));
  const multi = single
    .mul(average)
    .div(missing.mul(average).oneMinus())
    .mul(missing)
    .toVar("roughLeafMultiScatter");
  const compensation = f0
    .mul(energy.reciprocal().sub(1))
    .add(1)
    .toVar("roughLeafDirectCompensation");
  return { single, multi, compensation };
}

/** At alpha=roughness²=1, r186 D_GGX=1/π and Smith visibility simplifies
 * without removing dielectric reflection or changing its grazing clamp. */
export function createRoughLeafGGXVisibility(
  dotNL: Node<"float">,
  dotNV: Node<"float">,
): Node<"float"> {
  return float(0.5).div(dotNL.add(dotNV).max(EPSILON));
}

class RoughLeafLightingModel extends THREE.PhysicalLightingModel {
  // This is the actual extra public member of r186's non-exported SSS model;
  // extending PhysicalLightingModel preserves its typed material contract.
  readonly useSSS = true;
  private response: ReturnType<
    typeof createRoughLeafDielectricResponse
  > | null = null;
  private dotNV: Node<"float"> | null = null;

  override start(builder: NodeBuilder): void {
    this.dotNV = normalView
      .dot(positionViewDirection)
      .clamp()
      .toVar("roughLeafDotNV");
    const dfg = new ConvertNode<"vec2">(
      DFGLUT({ roughness: float(1), dotNV: this.dotNV }),
      "vec2",
    ).toVar("roughLeafDfg");
    this.response = createRoughLeafDielectricResponse(dfg, specularColor.r);
    // Dispatch ordinary light nodes (including their original shadow nodes)
    // without also running PhysicalLightingModel's general initialization.
    THREE.LightingModel.prototype.start.call(this, builder);
  }

  override direct(
    { lightDirection, lightColor, reflectedLight }: LightingModelDirectInput,
    builder: NodeBuilder,
  ): void {
    if (!this.response || !this.dotNV)
      throw new Error("Rough leaf lighting was not initialized");
    const material = builder.material;
    if (!(material instanceof GrassRoughLeafMaterial))
      throw new Error("Rough leaf lighting requires its owned material");
    // r186's public declarations erase these known light/context dimensions.
    // Real ConvertNodes preserve staging and compile to the original vec3
    // variables (including assignment targets), without eager type queries.
    const direction = new ConvertNode<"vec3">(lightDirection, "vec3");
    const color = new ConvertNode<"vec3">(lightColor, "vec3");
    const directDiffuse = new ConvertNode<"vec3">(
      reflectedLight.directDiffuse,
      "vec3",
    );
    const directSpecular = new ConvertNode<"vec3">(
      reflectedLight.directSpecular,
      "vec3",
    );
    const thicknessAmbient = new ConvertNode<"float">(
      material.thicknessAmbientNode,
      "float",
    );
    const thicknessAttenuation = new ConvertNode<"float">(
      material.thicknessAttenuationNode,
      "float",
    );

    // Same operations and order as MeshSSSNodeMaterial.direct in r186. The
    // incoming lightColor already contains the stock receiver shadow factor.
    const scatteringHalf = direction
      .add(normalView.mul(material.thicknessDistortionNode))
      .normalize();
    const scatteringDot = positionViewDirection
      .dot(scatteringHalf.negate())
      .saturate()
      .pow(material.thicknessPowerNode)
      .mul(material.thicknessScaleNode);
    const scatteringIllu = new ConvertNode<"vec3">(
      scatteringDot
        .add(thicknessAmbient)
        .mul(new ConvertNode<"vec3">(material.thicknessColorNode!, "vec3")),
      "vec3",
    );
    directDiffuse.addAssign(
      scatteringIllu.mul(thicknessAttenuation.mul(color)),
    );

    const dotNL = normalView.dot(direction).clamp();
    const irradiance = dotNL.mul(color).toVar();
    const halfDirection = direction.add(positionViewDirection).normalize();
    const dotVH = positionViewDirection.dot(halfDirection).clamp();
    const fresnel = new ConvertNode<"vec3">(
      F_Schlick({ f0: specularColor, f90: specularF90, dotVH }),
      "vec3",
    ).toVar("roughLeafFresnel");
    directDiffuse.addAssign(
      irradiance
        .mul(diffuseContribution.mul(1 / Math.PI))
        .mul(fresnel.oneMinus()),
    );
    const specular = fresnel
      .mul(createRoughLeafGGXVisibility(dotNL, this.dotNV))
      .mul(1 / Math.PI);
    directSpecular.addAssign(
      irradiance.mul(specular).mul(this.response.compensation),
    );
  }

  override indirect(builder: NodeBuilder): void {
    if (!this.response)
      throw new Error("Rough leaf lighting was not initialized");
    // This is r186's real LightingContextNode context, populated by the stock
    // ambient, hemisphere, environment and AO nodes before indirect dispatch.
    const context = builder.context as LightingContext;
    const { reflectedLight } = context;
    const irradiance = new ConvertNode<"vec3">(context.irradiance, "vec3");
    const radiance = new ConvertNode<"vec3">(context.radiance, "vec3");
    const iblIrradiance = new ConvertNode<"vec3">(
      context.iblIrradiance,
      "vec3",
    );
    const indirectDiffuse = new ConvertNode<"vec3">(
      reflectedLight.indirectDiffuse,
      "vec3",
    );
    const indirectSpecular = new ConvertNode<"vec3">(
      reflectedLight.indirectSpecular,
      "vec3",
    );
    const { single, multi } = this.response;
    const conservedDiffuse = single.add(multi).oneMinus();
    indirectDiffuse.addAssign(
      irradiance
        .mul(diffuseContribution.mul(1 / Math.PI))
        .mul(conservedDiffuse),
    );
    const cosineWeightedIrradiance = iblIrradiance.mul(1 / Math.PI);
    indirectSpecular.addAssign(
      radiance.mul(single).add(multi.mul(cosineWeightedIrradiance)),
    );
    indirectDiffuse.addAssign(
      diffuseContribution.mul(conservedDiffuse).mul(cosineWeightedIrradiance),
    );
    // Keep the stock distinct diffuse and specular occlusion responses.
    super.ambientOcclusion(builder);
  }
}

/** Default-off matte-leaf specialization. Borrowed graph nodes and environment
 * targets remain world-owned. Grounding/refinement clone this concrete class. */
export class GrassRoughLeafMaterial extends THREE.MeshSSSNodeMaterial {
  static get type(): string {
    return "GrassRoughLeafMaterial";
  }

  #environment: Node<"vec3"> | null = null;
  #retired = false;

  get roughLeafLightingActive(): boolean {
    return (
      !this.#retired &&
      this.#environment !== null &&
      this.envNode === this.#environment &&
      supportsRoughLeafRecipe(this)
    );
  }

  /** Called before pipeline selection by the existing world-owned object hook.
   * A foreign envNode writer is never overwritten, including during retirement. */
  setRoughLeafEnvironment(node: Node<"vec3"> | null): void {
    const previous = this.#environment;
    if (this.envNode !== previous) {
      this.#environment = null;
      if (previous !== null) this.needsUpdate = true;
      return;
    }
    const next = !this.#retired && supportsRoughLeafRecipe(this) ? node : null;
    if (previous !== next) {
      this.#environment = next;
      this.envNode = next;
      this.needsUpdate = true;
    }
  }

  override setupLightingModel(): ReturnType<
    THREE.MeshSSSNodeMaterial["setupLightingModel"]
  > {
    return this.roughLeafLightingActive
      ? new RoughLeafLightingModel()
      : super.setupLightingModel();
  }

  override setupVariants(builder: NodeBuilder): void {
    if (!this.roughLeafLightingActive) {
      super.setupVariants(builder);
      return;
    }
    // Stock getRoughness clamps 1 + nonnegative geometric roughness to 1.
    // Preserve the dielectric IOR expression instead of fitting its response.
    roughness.assign(1);
    metalness.assign(0);
    ior.assign(1.5);
    const interfaceRatio = ior.sub(1).div(ior.add(1));
    specularColor.assign(vec3(interfaceRatio.mul(interfaceRatio)));
    specularColorBlended.assign(specularColor);
    specularF90.assign(1);
    diffuseContribution.assign(diffuseColor.rgb);
  }

  override copy(source: THREE.Material): this {
    super.copy(source);
    this.#retired = false;
    this.#environment =
      source instanceof GrassRoughLeafMaterial &&
      !source.#retired &&
      source.envNode === source.#environment
        ? source.#environment
        : null;
    return this;
  }

  override dispose(): void {
    this.#retired = true;
    this.setRoughLeafEnvironment(null);
    super.dispose();
  }
}

/** The environment owner can safely receive ordinary materials here too. */
export function setRoughLeafEnvironment(
  material: THREE.Material,
  node: Node<"vec3"> | null,
): void {
  if (material instanceof GrassRoughLeafMaterial)
    material.setRoughLeafEnvironment(node);
}
