import {
  ShadowNode,
  type DepthTexture,
  type DirectionalLight,
  type DirectionalLightShadow,
  type Node,
  type NodeBuilder,
} from "three/webgpu";

type FilterInputs = {
  depthTexture: DepthTexture;
  shadowCoord: Node<"vec3">;
  shadow: DirectionalLightShadow;
  depthLayer?: Node<"int"> | null;
};
type ShadowFilterInputs = FilterInputs & {
  filterFn: (inputs: FilterInputs) => Node<"float">;
};

// r186 implements this extension point, but its declaration omits it. Keep the
// typing local; dispatch to the real base method rather than copying its filter.
const shadowPrototype = ShadowNode.prototype as ShadowNode & {
  setupShadowFilter(
    builder: NodeBuilder,
    inputs: ShadowFilterInputs,
  ): Node<"float">;
};
const owners = new WeakMap<
  UniformDirectionalShadowNode,
  { light: DirectionalLight; shadow: DirectionalLightShadow }
>();

/** Explicit single-map candidate, never installed by construction.
 *
 * r186's frustum select otherwise emits a varying branch around implicit-LOD
 * depth comparisons. Uniform flow applies ONLY to that select: the original
 * filter, five-tap PCF, coordinates, and out-of-frustum value of one are kept.
 * This evaluates the filter outside the frustum too; it is not a free-cost claim.
 * Resource/render lifecycle stays on Three's ShadowNode (including disposal).
 */
export class UniformDirectionalShadowNode extends ShadowNode {
  declare readonly shadow: DirectionalLightShadow;

  constructor(light: DirectionalLight) {
    super(light, light.shadow);
    owners.set(this, { light, shadow: light.shadow });
  }

  setupShadowFilter(builder: NodeBuilder, inputs: ShadowFilterInputs) {
    return shadowPrototype.setupShadowFilter
      .call(this, builder, inputs)
      .uniformFlow();
  }
}

/** Only the exact, unchanged single-map owner can use single-view safeguards. */
export function isOwnedUniformDirectionalShadowNode(
  node: unknown,
  light: DirectionalLight,
): node is UniformDirectionalShadowNode {
  if (
    !(node instanceof UniformDirectionalShadowNode) ||
    Object.getPrototypeOf(node) !== UniformDirectionalShadowNode.prototype
  )
    return false;
  const owner = owners.get(node);
  return (
    owner?.light === light &&
    owner.shadow === light.shadow &&
    node.light === light &&
    node.shadow === light.shadow &&
    node.setupShadowFilter ===
      UniformDirectionalShadowNode.prototype.setupShadowFilter
  );
}
