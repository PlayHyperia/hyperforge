/**
 * Unintegrated r186 contact-AO experiment. Construction allocates CPU-side Three
 * owners only; it never initializes a renderer or changes a direct-render profile.
 * Native color/alpha/MSAA, skin/wind/cutout and performance remain unqualified.
 */
import {
  BlendMode,
  Color,
  HalfFloatType,
  NoBlending,
  NormalBlending,
  PassNode,
  RedFormat,
  RenderPipeline,
  RendererUtils,
  REVISION,
  RTTNode,
  UnsignedByteType,
  Vector2,
  Vector4,
  type Material,
  type NodeMaterial,
  type NodeFrame,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
  type WebGPURenderer,
} from "three/webgpu";
import {
  builtinAOContext,
  diffuseColor,
  float,
  mix,
  mrt,
  normalView,
  screenUV,
  uniform,
  vec4,
} from "three/tsl";
import GTAONode from "three/examples/jsm/tsl/display/GTAONode.js";
import DenoiseNode, {
  denoise,
} from "three/examples/jsm/tsl/display/DenoiseNode.js";

export type CompactContactAOOptions = Readonly<{
  /** Zero is the neutral control, not a direct-render bypass. */
  strength: number;
  resolutionScale: 0.5 | 1;
  denoise: boolean;
}>;

export const COMPACT_CONTACT_AO_CONTRACT = Object.freeze({
  id: "compact-contact-ao-experiment-v1",
  radius: 0.25,
  thickness: 1,
  scale: 1,
  nominalSamples: 16,
  temporalFiltering: false,
  prepassSamples: 0,
  beautySamples: 4,
  maximumPixels: 3840 * 2160,
  maximumDimension: 8192,
  maximumGroupsPerFrame: 100_000,
  maximumSkinDiagnosticRows: 32,
} as const);

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`CompactContactAO: ${message}`);
}

export function validateCompactContactAOOptions(
  value: CompactContactAOOptions,
) {
  requireCondition(
    value && Object.getPrototypeOf(value) === Object.prototype,
    "plain options required",
  );
  requireCondition(
    Object.keys(value).sort().join(",") === "denoise,resolutionScale,strength",
    "exact strength/resolutionScale/denoise options required",
  );
  requireCondition(
    Number.isFinite(value.strength) &&
      value.strength >= 0 &&
      value.strength <= 1,
    "strength must be 0..1",
  );
  requireCondition(
    value.resolutionScale === 0.5 || value.resolutionScale === 1,
    "AO scale must be 0.5 or 1",
  );
  requireCondition(
    typeof value.denoise === "boolean",
    "denoise must be boolean",
  );
  return Object.freeze({ ...value });
}

type SurfaceMaterial = Material &
  Partial<
    Pick<
      NodeMaterial,
      | "fragmentNode"
      | "mrtNode"
      | "alphaTestNode"
      | "opacityNode"
      | "backdropNode"
    >
  > & {
    transmission?: number;
    transmissionNode?: unknown;
    isNodeMaterial?: boolean;
  };

export type CompactContactSurfaceDecision = Readonly<{
  include: boolean;
  reason:
    | "opaque"
    | "cutout"
    | "non-mesh"
    | "invisible"
    | "no-depth-color"
    | "transmissive"
    | "blended";
}>;

/** Inspect the actual per-group material, never object.material[0]. No mutation. */
export function classifyCompactContactSurface(
  object: Object3D,
  input: Material,
  library: WebGPURenderer["library"],
): CompactContactSurfaceDecision {
  const material = input as SurfaceMaterial;
  if (!(object as Object3D & { isMesh?: boolean }).isMesh)
    return { include: false, reason: "non-mesh" };
  if (!object.visible || !material.visible)
    return { include: false, reason: "invisible" };
  if (!material.depthWrite || !material.depthTest || !material.colorWrite)
    return { include: false, reason: "no-depth-color" };
  if (
    (material.transmission ?? 0) > 0 ||
    material.transmissionNode != null ||
    material.backdropNode != null
  )
    return { include: false, reason: "transmissive" };
  const cutout =
    material.alphaTest > 0 ||
    material.alphaTestNode != null ||
    material.alphaHash;
  if (
    material.transparent &&
    (!cutout ||
      material.opacity !== 1 ||
      (material.blending !== NormalBlending &&
        material.blending !== NoBlending))
  )
    return { include: false, reason: "blended" };
  // These bypass/override the MRT output in installed NodeMaterial.setup.
  // An excluded water/sky material need not support the normal prepass.
  requireCondition(
    material.fragmentNode == null && material.mrtNode == null,
    `unsupported custom fragment/MRT on material ${material.uuid}`,
  );
  requireCondition(
    material.isNodeMaterial ||
      library.getMaterialNodeClass(material.type) !== null,
    `unsupported material pipeline ${material.type}/${material.uuid}`,
  );
  return { include: true, reason: cutout ? "cutout" : "opaque" };
}

/**
 * Public-state guard only. Installed native draw paths may also strand PRIVATE
 * renderer state. Any draw failure must end this owner's session, never fallback.
 * Exported for actual uninitialized-Three CPU state tests (not a GPU exception test).
 */
export function withCompactContactPublicState<T>(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: PerspectiveCamera,
  operation: () => T,
): T {
  const base = RendererUtils.saveRendererState(renderer);
  const savedScene = RendererUtils.saveSceneState(scene);
  const extra = {
    contextNode: renderer.contextNode,
    transparent: renderer.transparent,
    opaque: renderer.opaque,
    lighting: renderer.lighting,
    autoClearColor: renderer.autoClearColor,
    autoClearDepth: renderer.autoClearDepth,
    autoClearStencil: renderer.autoClearStencil,
    xrEnabled: renderer.xr.enabled,
    viewport: renderer.getViewport(new Vector4()),
    scissor: renderer.getScissor(new Vector4()),
    renderObjectFunction: renderer.getRenderObjectFunction(),
    cameraMask: camera.layers.mask,
    sceneName: scene.name,
  };
  let result: T | undefined;
  const errors: unknown[] = [];
  try {
    result = operation();
  } catch (error) {
    errors.push(error);
  }
  // Separate restorers so one failure does not skip all remaining public fields.
  for (const restore of [
    () => {
      renderer.toneMapping = base.toneMapping;
      renderer.toneMappingExposure = base.toneMappingExposure;
      renderer.outputColorSpace = base.outputColorSpace;
      renderer.setRenderTarget(
        base.renderTarget,
        base.activeCubeFace,
        base.activeMipmapLevel,
      );
      renderer.setRenderObjectFunction(extra.renderObjectFunction);
      renderer.setMRT(base.mrt);
      renderer.setClearColor(base.clearColor, base.clearAlpha);
      renderer.autoClear = base.autoClear;
      renderer.setScissorTest(base.scissorTest);
      // RendererUtils.restoreRendererState always calls setPixelRatio/setSize;
      // avoid resizing/reconfiguring the borrowed canvas when DPR never changed.
      if (renderer.getPixelRatio() !== base.pixelRatio)
        renderer.setPixelRatio(base.pixelRatio);
    },
    () => RendererUtils.restoreSceneState(scene, savedScene),
    () => {
      renderer.contextNode = extra.contextNode;
      renderer.transparent = extra.transparent;
      renderer.opaque = extra.opaque;
      renderer.lighting = extra.lighting;
    },
    () => {
      renderer.autoClearColor = extra.autoClearColor;
      renderer.autoClearDepth = extra.autoClearDepth;
      renderer.autoClearStencil = extra.autoClearStencil;
      renderer.xr.enabled = extra.xrEnabled;
    },
    () => {
      renderer.setViewport(extra.viewport);
      renderer.setScissor(extra.scissor);
    },
    () => {
      camera.layers.mask = extra.cameraMask;
      scene.name = extra.sceneName;
    },
  ]) {
    try {
      restore();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(
      errors,
      "Compact contact operation/public restoration failed",
    );
  return result as T;
}

type GroupCensus = {
  included: number;
  excluded: number;
  cutouts: number;
  skinned: number;
  excludedSkinned: number;
  skinSurfaces: Array<{
    object: string;
    material: string;
    type: string;
    included: boolean;
    reason: CompactContactSurfaceDecision["reason"];
    transparent: boolean;
    opacity: number;
    alphaTest: number;
    depthWrite: boolean;
  }>;
  instanced: number;
  batched: number;
  reasons: Record<string, number>;
};
function emptyCensus(): GroupCensus {
  return {
    included: 0,
    excluded: 0,
    cutouts: 0,
    skinned: 0,
    excludedSkinned: 0,
    skinSurfaces: [],
    instanced: 0,
    batched: 0,
    reasons: {},
  };
}

/** Original PassNode render path, with a temporary exact-target per-group filter. */
class ContactScenePass extends PassNode {
  constructor(
    readonly sourceScene: Scene,
    readonly sourceCamera: PerspectiveCamera,
    readonly isNormalPrepass: boolean,
    private readonly observe: (
      object: Object3D,
      decision: CompactContactSurfaceDecision,
      material: Material,
    ) => void,
  ) {
    super(PassNode.COLOR, sourceScene, sourceCamera, {
      // GTAO gathers adjacent depths. WGSL textureGather cannot read an MSAA
      // depth attachment; keep this geometry buffer single-sample at full pixel
      // resolution while retaining the existing four-sample beauty pass.
      samples: isNormalPrepass
        ? COMPACT_CONTACT_AO_CONTRACT.prepassSamples
        : COMPACT_CONTACT_AO_CONTRACT.beautySamples,
      type: HalfFloatType,
    });
    this.name = isNormalPrepass
      ? "Compact contact normals/depth"
      : "Compact contact beauty";
  }

  override updateBefore(frame: NodeFrame) {
    const renderer = frame.renderer as WebGPURenderer | null;
    requireCondition(
      renderer?.isWebGPURenderer,
      "missing actual WebGPU renderer in pass",
    );
    return withCompactContactPublicState(
      renderer,
      this.sourceScene,
      this.sourceCamera,
      () => {
        const previous = renderer.getRenderObjectFunction();
        const priorOrNative = previous ?? renderer.renderObject;
        renderer.setRenderObjectFunction((...args) => {
          const [object, scene, camera, , material] = args;
          const ownScenePass =
            renderer.getRenderTarget() === this.renderTarget &&
            scene === this.sourceScene &&
            camera === this.sourceCamera;
          if (ownScenePass && this.isNormalPrepass) {
            const decision = classifyCompactContactSurface(
              object,
              material,
              renderer.library,
            );
            this.observe(object, decision, material);
            if (!decision.include) return;
          }
          const side = material.side;
          try {
            return priorOrNative.call(renderer, ...args);
          } catch (error) {
            // r186's double-sided transparent draw lacks finally. Do not leave
            // the shared source material in its temporary BackSide/FrontSide state.
            material.side = side;
            throw error;
          }
        });
        return super.updateBefore(frame);
      },
    );
  }
}

export class CompactContactAO {
  readonly options: CompactContactAOOptions;
  private readonly strength = uniform(0);
  private readonly prepass: ContactScenePass;
  private readonly beauty: ContactScenePass;
  private readonly gtao: GTAONode;
  private readonly denoiser: DenoiseNode | null;
  private readonly denoiseTarget: RTTNode | null;
  private readonly pipeline: RenderPipeline;
  private readonly disposers: Array<() => void> = [];
  private readonly size = new Vector2();
  private state: "constructed" | "rendered" | "failed" | "disposed" =
    "constructed";
  private failure: unknown = null;
  private inFrame = false;
  private renderedFrames = 0;
  private census = emptyCensus();

  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly scene: Scene,
    private readonly camera: PerspectiveCamera,
    options: CompactContactAOOptions,
    /** Live owner-supplied reflection setting; this module does not alter water. */
    private readonly reflectionsEnabled: () => boolean,
  ) {
    this.options = validateCompactContactAOOptions(options);
    requireCondition(
      REVISION === "186",
      "only installed r186 is qualified for this experiment",
    );
    requireCondition(
      typeof reflectionsEnabled === "function",
      "live reflection-state accessor required",
    );
    this.validateEnvironment(false);
    this.strength.value = options.strength;
    const own = <T extends { dispose(): void }>(resource: T): T => {
      this.disposers.push(() => resource.dispose());
      return resource;
    };
    try {
      this.prepass = own(
        new ContactScenePass(
          scene,
          camera,
          true,
          (object, decision, material) =>
            this.observeGroup(object, decision, material),
        ),
      );
      const outputs = mrt({ output: vec4(normalView, diffuseColor.a) });
      outputs.setBlendMode("output", new BlendMode(NoBlending));
      outputs.setClearColor("output", new Color(0, 0, 0), 0);
      this.prepass.setMRT(outputs);
      const normals = this.prepass.getTextureNode("output");
      const depth = this.prepass.getTextureNode("depth");
      this.gtao = own(new GTAONode(depth, normals, camera));
      this.gtao.radius.value = COMPACT_CONTACT_AO_CONTRACT.radius;
      this.gtao.thickness.value = COMPACT_CONTACT_AO_CONTRACT.thickness;
      this.gtao.scale.value = COMPACT_CONTACT_AO_CONTRACT.scale;
      this.gtao.samples.value = COMPACT_CONTACT_AO_CONTRACT.nominalSamples;
      this.gtao.useTemporalFiltering = false;
      this.gtao.resolutionScale = options.resolutionScale;
      this.denoiser = options.denoise
        ? own(denoise(this.gtao.getTextureNode(), depth, normals, camera))
        : null;
      // Explicit rounded AO dimensions avoid floor-vs-round mismatch at odd
      // drawing-buffer sizes. Auto-update FRAME still materializes once only.
      this.denoiseTarget = this.denoiser
        ? own(
            new RTTNode(this.denoiser, 1, 1, {
              depthBuffer: false,
              samples: 0,
              format: RedFormat,
              type: UnsignedByteType,
              autoUpdate: true,
              resolutionScale: 1,
            }),
          )
        : null;
      this.beauty = own(new ContactScenePass(scene, camera, false, () => {}));
      const aoTexture = this.denoiseTarget ?? this.gtao.getTextureNode();
      this.beauty.contextNode = builtinAOContext(
        mix(float(1), aoTexture.sample(screenUV).r, this.strength),
      );
      this.pipeline = own(new RenderPipeline(renderer, this.beauty));
      this.pipeline.outputColorTransform = true;
      this.resize();
    } catch (error) {
      const cleanup = this.releaseOwned();
      if (cleanup.length)
        throw new AggregateError(
          [error, ...cleanup],
          "Compact contact construction/rollback failed",
        );
      throw error;
    }
  }

  private validateEnvironment(requireInitialized: boolean) {
    const r = this.renderer;
    requireCondition(r.isWebGPURenderer, "actual WebGPURenderer required");
    requireCondition(
      (r.backend as unknown as { isWebGPUBackend?: boolean })
        .isWebGPUBackend === true,
      "WebGL fallback is unsupported",
    );
    requireCondition(
      this.camera.isPerspectiveCamera && !this.camera.reversedDepth,
      "ordinary perspective camera required",
    );
    requireCondition(
      Number.isFinite(this.camera.near) &&
        this.camera.near > 0 &&
        Number.isFinite(this.camera.far) &&
        this.camera.far > this.camera.near,
      "finite camera depth range required",
    );
    requireCondition(
      !r.reversedDepthBuffer && !r.logarithmicDepthBuffer,
      "reversed/logarithmic depth unsupported",
    );
    requireCondition(
      r.samples === 4,
      "preserve existing four-sample beauty MSAA",
    );
    // PassNode.setup replaces its texture type with this renderer setting.
    requireCondition(
      r.getOutputBufferType() === HalfFloatType,
      "HalfFloat output buffers required for signed normal attachment",
    );
    requireCondition(!r.xr.isPresenting, "XR unsupported");
    requireCondition(
      this.scene.overrideMaterial === null,
      "scene override material unsupported",
    );
    requireCondition(
      this.reflectionsEnabled() === false,
      "reflection-enabled views need separate qualification",
    );
    if (requireInitialized) {
      requireCondition(
        r.initialized,
        "initialize the actual renderer before rendering",
      );
      const backend = r.backend as unknown as {
        isWebGPUBackend?: boolean;
        compatibilityMode?: boolean | null;
      };
      requireCondition(
        backend.isWebGPUBackend === true && backend.compatibilityMode === false,
        "native non-compatibility WebGPU backend required",
      );
      requireCondition(
        r.getRenderTarget() === null && r.getOutputRenderTarget() === null,
        "screen-output owner required",
      );
    }
  }

  private observeGroup(
    object: Object3D,
    decision: CompactContactSurfaceDecision,
    material: Material,
  ) {
    const census = this.census;
    requireCondition(
      census.included + census.excluded <
        COMPACT_CONTACT_AO_CONTRACT.maximumGroupsPerFrame,
      "per-frame group observation bound exceeded",
    );
    census.reasons[decision.reason] =
      (census.reasons[decision.reason] ?? 0) + 1;
    const flags = object as Object3D & {
      isSkinnedMesh?: boolean;
      isInstancedMesh?: boolean;
      isBatchedMesh?: boolean;
    };
    if (flags.isSkinnedMesh) {
      if (!decision.include) census.excludedSkinned++;
      if (
        census.skinSurfaces.length <
        COMPACT_CONTACT_AO_CONTRACT.maximumSkinDiagnosticRows
      )
        census.skinSurfaces.push({
          object: object.uuid,
          material: material.uuid,
          type: material.type,
          included: decision.include,
          reason: decision.reason,
          transparent: material.transparent,
          opacity: material.opacity,
          alphaTest: material.alphaTest,
          depthWrite: material.depthWrite,
        });
    }
    if (!decision.include) {
      census.excluded++;
      return;
    }
    census.included++;
    if (decision.reason === "cutout") census.cutouts++;
    if (flags.isSkinnedMesh) census.skinned++;
    if (flags.isInstancedMesh) census.instanced++;
    if (flags.isBatchedMesh) census.batched++;
  }

  private requireLive() {
    requireCondition(
      this.state !== "disposed" && this.state !== "failed",
      `owner is ${this.state}; do not reuse a failed native session`,
    );
    requireCondition(!this.inFrame, "reentrant owner operation");
  }

  /** Never modifies the renderer's size, DPR, camera or sample count. */
  resize() {
    this.requireLive();
    this.renderer.getDrawingBufferSize(this.size);
    const { x: width, y: height } = this.size;
    requireCondition(
      Number.isInteger(width) &&
        Number.isInteger(height) &&
        width > 1 &&
        height > 1 &&
        width <= COMPACT_CONTACT_AO_CONTRACT.maximumDimension &&
        height <= COMPACT_CONTACT_AO_CONTRACT.maximumDimension &&
        width * height <= COMPACT_CONTACT_AO_CONTRACT.maximumPixels,
      "drawing-buffer dimensions exceed explicit experiment bounds",
    );
    this.prepass.setSize(width, height);
    this.beauty.setSize(width, height);
    this.gtao.setSize(width, height);
    if (this.denoiseTarget) {
      const w = Math.round(width * this.options.resolutionScale),
        h = Math.round(height * this.options.resolutionScale);
      this.denoiseTarget.width = w;
      this.denoiseTarget.height = h;
      this.denoiseTarget.setSize(w, h);
    }
  }

  setStrength(strength: number) {
    this.requireLive();
    requireCondition(
      Number.isFinite(strength) && strength >= 0 && strength <= 1,
      "strength must be 0..1",
    );
    this.strength.value = strength;
  }

  /** Synchronous, already-initialized renderer only; no async init/fallback. */
  render() {
    this.requireLive();
    try {
      this.validateEnvironment(true);
      this.resize();
      this.inFrame = true;
      this.census = emptyCensus();
      withCompactContactPublicState(
        this.renderer,
        this.scene,
        this.camera,
        () => this.pipeline.render(),
      );
      requireCondition(
        this.census.included > 0,
        "normal/depth prepass observed no admitted surface groups",
      );
      this.renderedFrames++;
      this.state = "rendered";
    } catch (error) {
      this.failure = error;
      this.state = "failed";
      throw error;
    } finally {
      this.inFrame = false;
    }
  }

  getReceipt() {
    const ao = this.gtao.getTextureNode().value;
    const aoImage = ao.image as { width?: unknown; height?: unknown } | null;
    requireCondition(
      aoImage &&
        typeof aoImage.width === "number" &&
        typeof aoImage.height === "number" &&
        Number.isInteger(aoImage.width) &&
        Number.isInteger(aoImage.height),
      "AO attachment has no integer dimensions",
    );
    return {
      schemaVersion: 1,
      id: COMPACT_CONTACT_AO_CONTRACT.id,
      state: this.state,
      renderSucceeded: this.state === "rendered",
      renderedFrames: this.renderedFrames,
      failure:
        this.failure instanceof Error
          ? this.failure.message
          : this.failure === null
            ? null
            : String(this.failure),
      nativeVisualQualified: false,
      privateRendererReuseAfterFailureApproved: false,
      reflectionStateEvidence:
        "live caller accessor; not a material-graph reflection census",
      options: { ...this.options, strength: this.strength.value },
      controls: { ...COMPACT_CONTACT_AO_CONTRACT },
      outputColorTransform: this.pipeline.outputColorTransform,
      prepass: {
        width: this.prepass.renderTarget.width,
        height: this.prepass.renderTarget.height,
        samples: this.prepass.renderTarget.samples,
        type: this.prepass.renderTarget.texture.type,
        texture: this.prepass.getTexture("output").uuid,
        depth: this.prepass.getTexture("depth").uuid,
      },
      beauty: {
        width: this.beauty.renderTarget.width,
        height: this.beauty.renderTarget.height,
        samples: this.beauty.renderTarget.samples,
        type: this.beauty.renderTarget.texture.type,
        texture: this.beauty.getTexture("output").uuid,
      },
      ao: {
        width: aoImage.width,
        height: aoImage.height,
        texture: ao.uuid,
        format: ao.format,
        type: ao.type,
      },
      denoise: this.denoiseTarget
        ? {
            width: this.denoiseTarget.renderTarget!.width,
            height: this.denoiseTarget.renderTarget!.height,
            samples: this.denoiseTarget.renderTarget!.samples,
            depthBuffer: this.denoiseTarget.renderTarget!.depthBuffer,
            texture: this.denoiseTarget.value.uuid,
          }
        : null,
      groups: {
        ...this.census,
        reasons: { ...this.census.reasons },
        skinSurfaces: this.census.skinSurfaces.map((row) => ({ ...row })),
      },
      scope:
        "Observed CPU-side owners/group calls; no GPU allocation byte total, timing, image parity, motion or art approval.",
    };
  }

  private releaseOwned() {
    const errors: unknown[] = [];
    while (this.disposers.length) {
      try {
        this.disposers.pop()!();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  destroy() {
    if (this.state === "disposed") return;
    requireCondition(!this.inFrame, "cannot destroy during an active frame");
    this.state = "disposed";
    const errors = this.releaseOwned();
    if (errors.length)
      throw new AggregateError(errors, "Compact contact owned disposal failed");
  }
}
