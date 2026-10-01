import {
  PCFShadowMap,
  ShadowNode,
  Vector3,
  type ContextNode,
  type DepthTexture,
  type DirectionalLight,
  type DirectionalLightShadow,
  type Node,
  type NodeBuilder,
  type NodeMaterial,
  type RenderTarget,
} from "three/webgpu";
import {
  BasicShadowFilter,
  Fn,
  If,
  PCFShadowFilter,
  context,
  float,
  mix,
  positionWorld,
  smoothstep,
  uniform,
} from "three/tsl";

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
// r186 passes an input object; the installed declarations still describe the
// old positional filter signature. Do not reimplement either built-in filter.
const basicShadowFilter =
  BasicShadowFilter as unknown as ShadowFilterInputs["filterFn"];
const pcfShadowFilter =
  PCFShadowFilter as unknown as ShadowFilterInputs["filterFn"];
const grassFilterContexts = new WeakMap<
  ContextNode<unknown>,
  GrassShadowFilterContext
>();

/** Explicit, default-near grass-only sampling candidate.
 *
 * Assign contextNode to the grass material before its first compile. Its node
 * identity is part of NodeMaterial's program key; a hidden material registry
 * alone would permit incorrect shader-cache reuse. clone() preserves this
 * context and SHARES these uniforms. Use onObjectUpdate for per-draw modes, or
 * a separate context for independently controlled materials. Never replace the
 * context or rebuild materials merely to change a uniform value.
 *
 * Modes: 0 = original five-comparison PCF, 1 = one comparison, 2 = both filters
 * with a per-fragment distance blend (six comparisons). These are shader sample
 * counts, not a performance or appearance guarantee. The one-sample branch
 * keeps the same depth map and comparison sampler, including hardware filtering.
 */
export class GrassShadowFilterContext {
  readonly contextNode: ContextNode<unknown>;
  readonly drawMode = uniform(0, "int").setName("grassShadowDrawMode");
  readonly primaryCameraPosition = uniform(new Vector3());
  readonly transitionStart = uniform(0);
  readonly transitionEnd = uniform(1);

  constructor(parentContext: ContextNode<unknown> | null = null) {
    this.contextNode = parentContext ? context(parentContext) : context();
    grassFilterContexts.set(this.contextNode, this);
  }
}

function grassShadowFilter(
  owner: GrassShadowFilterContext,
  inputs: FilterInputs,
): Node<"float"> {
  return Fn(() => {
    const visibility = float(1).toVar("grassShadowVisibility");
    // Only draw-uniform mode controls implicit-LOD depth-comparison branches.
    // Classify full chunk bounds using the primary camera (also in mirrors).
    If(owner.drawMode.equal(1), () => {
      visibility.assign(basicShadowFilter(inputs));
    })
      .ElseIf(owner.drawMode.equal(2), () => {
        // Callers keep start < end. Only this blend weight varies per fragment;
        // transition chunks deliberately pay for both filters to avoid seams.
        const weight = smoothstep(
          owner.transitionStart,
          owner.transitionEnd,
          positionWorld.distance(owner.primaryCameraPosition),
        );
        visibility.assign(
          mix(pcfShadowFilter(inputs), basicShadowFilter(inputs), weight),
        );
      })
      .Else(() => {
        visibility.assign(pcfShadowFilter(inputs));
      });
    return visibility;
  })().context({ uniformFlow: false });
}

/** Explicit single-map candidate, never installed by construction.
 *
 * r186's frustum select otherwise emits a varying branch around implicit-LOD
 * depth comparisons. Uniform flow keeps that select unconditionally evaluated;
 * the original filter is unchanged unless a material explicitly opts into the
 * grass context above. Coordinates and out-of-frustum value of one are kept.
 * This evaluates the filter outside the frustum too; it is not a free-cost claim.
 * Resource/render lifecycle stays on Three's ShadowNode (including disposal).
 */
export class UniformDirectionalShadowNode extends ShadowNode {
  declare readonly shadow: DirectionalLightShadow;
  // Same r186 declaration gap; expose the actual allocated owner for teardown.
  declare readonly shadowMap: RenderTarget | null;

  constructor(light: DirectionalLight) {
    super(light, light.shadow);
    owners.set(this, { light, shadow: light.shadow });
  }

  setupShadowFilter(builder: NodeBuilder, inputs: ShadowFilterInputs) {
    // ShadowNode caches its graph across materials. Resolve the current material
    // only when this inline Fn builds, never from the first outer builder. Do
    // not add setLayout(): named Fn bodies are cached across builders in r186.
    const deferredFilter = (filterInputs: FilterInputs) =>
      Fn((activeBuilder) => {
        const material = activeBuilder.material as NodeMaterial;
        // LightShadow.filterNode is another r186 declaration gap.
        const shadow = inputs.shadow as DirectionalLightShadow & {
          filterNode?: unknown;
        };
        const owner = material.contextNode
          ? grassFilterContexts.get(material.contextNode)
          : undefined;
        if (
          !owner ||
          activeBuilder.renderer.shadowMap.type !== PCFShadowMap ||
          shadow.filterNode != null ||
          inputs.filterFn !== pcfShadowFilter
        ) {
          return inputs.filterFn(filterInputs);
        }
        // The outer uniformFlow must not turn the uniform mode branches into
        // eager selects. grassShadowFilter explicitly resets that context.
        return grassShadowFilter(owner, filterInputs);
      })();
    return shadowPrototype.setupShadowFilter
      .call(this, builder, { ...inputs, filterFn: deferredFilter })
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
