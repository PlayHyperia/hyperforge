import THREE, {
  Fn,
  If,
  float,
  max,
  texture,
  uniform,
  uv,
  vec2,
  vec4,
} from "../../../extras/three/three";
import type { Node, WebGPURenderer } from "three/webgpu";
import type {
  CompactTerrainTextureSet,
  CompactTerrainDirtSurfaceResolver,
} from "./CompactTerrainMaterial";

export type CompactTerrainDirtSurfaceCache = "dirt-page-v1";
export const COMPACT_TERRAIN_DIRT_SURFACE_PAGE = Object.freeze({
  id: "dirt-page-v1",
  size: 1024,
  widthMeters: 25,
  baseBytes: 8_388_608,
  mipBytes: 11_184_808,
} as const);
type RawAppearance = (
  worldXZ: Node<"vec2">,
  dx: Node<"vec2">,
  dy: Node<"vec2">,
) => Node<"vec4">;
type State = "idle" | "baking" | "ready" | "invalid" | "failed" | "disposed";
type SourcePin = {
  texture: THREE.Texture;
  source: THREE.Texture["source"];
  data: unknown;
  stamp: string;
};
// r186 documents this public callback, but the installed declarations lag it.
type BakeBuilder = { material: THREE.Material | null; fragmentShader?: string };
type BuilderOwner = { object?: THREE.Object3D; material?: THREE.Material };
type BuilderCallback = (builder: BakeBuilder, owner: BuilderOwner) => void;
type BakeDebug = { onNodeBuilderCreated: BuilderCallback | null };

function requirePage(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Compact dirt surface page: ${message}`);
}

/** A bounded, unqualified raw dirt AR approximation. No automatic baking, pool,
 * world edits or renderer initialization. Normals/AO/heights stay in the live graph.
 * Cache eligibility requires minification along BOTH footprint axes, not merely
 * a large grazing major axis. Filtering still requires native visual acceptance.
 */
export class CompactTerrainDirtSurfacePage implements CompactTerrainDirtSurfaceResolver {
  private state: State = "idle";
  private reason: string | null = null;
  private generation = 0;
  private working = false;
  private renderer: WebGPURenderer | null = null;
  private source: SourcePin | null = null;
  private target: THREE.RenderTarget | null = null;
  private material: THREE.NodeMaterial | null = null;
  private readonly placeholder = new THREE.DataTexture(
    new Uint8Array([0, 0, 0, 255]),
    1,
    1,
    THREE.RGBAFormat,
  );
  private readonly page = texture(this.placeholder);
  private readonly origin = uniform(new THREE.Vector2());
  private readonly ready = uniform(false).onFrameUpdate((frame) => {
    if (
      this.state === "ready" &&
      (frame.renderer !== this.renderer || !this.sourceMatches())
    )
      this.invalidate("source or renderer changed");
    return this.state === "ready";
  });
  private completedBakes = 0;
  private preparationMs = 0;
  private issuedDraws = 0;
  private placeholderDisposed = false;
  private releaseSource: (() => void) | null = null;

  constructor(
    private readonly textures: CompactTerrainTextureSet,
    private readonly createRaw: RawAppearance,
  ) {
    requirePage(
      textures &&
        typeof textures.getNode === "function" &&
        typeof createRaw === "function",
      "source and raw appearance callback required",
    );
    this.placeholder.colorSpace = THREE.LinearSRGBColorSpace;
    this.placeholder.generateMipmaps = false;
    this.placeholder.minFilter = THREE.LinearFilter;
    this.placeholder.magFilter = THREE.LinearFilter;
    this.placeholder.needsUpdate = true;
  }

  resolve(
    worldXZ: Node<"vec2">,
    worldDx: Node<"vec2">,
    worldDy: Node<"vec2">,
    originalRaw: () => Node<"vec4">,
  ): Node<"vec4"> {
    requirePage(
      this.state !== "disposed" && typeof originalRaw === "function",
      "live page and fallback required",
    );
    const metersPerTexel =
      COMPACT_TERRAIN_DIRT_SURFACE_PAGE.widthMeters /
      COMPACT_TERRAIN_DIRT_SURFACE_PAGE.size;
    return Fn(() => {
      // These expressions may contain screen derivatives: build them before If.
      const p = worldXZ.toVar("compactDirtPageWorldXZ");
      const dx = worldDx.toVar("compactDirtPageWorldDx"),
        dy = worldDy.toVar("compactDirtPageWorldDy");
      const a = dx.dot(dx),
        b = dx.dot(dy),
        c = dy.dot(dy);
      const difference = a.sub(c);
      const majorSquared = a
        .add(c)
        .add(difference.mul(difference).add(b.mul(b).mul(4)).max(0).sqrt())
        .mul(0.5)
        .toVar("compactDirtPageMajorSquared");
      // det(J)^2 / lambda_max avoids subtractive cancellation in lambda_min.
      const determinant = dx.x.mul(dy.y).sub(dx.y.mul(dy.x));
      const minorSquared = determinant
        .mul(determinant)
        .div(max(majorSquared, float(1e-20)))
        .toVar("compactDirtPageMinorSquared");
      const margin = majorSquared
        .sqrt()
        .mul(2)
        .add(2 * metersPerTexel);
      const local = p.sub(this.origin).toVar("compactDirtPageLocal");
      const valid = this.ready
        .and(minorSquared.greaterThanEqual(metersPerTexel ** 2))
        .and(local.x.greaterThanEqual(margin))
        .and(local.y.greaterThanEqual(margin))
        .and(
          local.x.lessThanEqual(
            float(COMPACT_TERRAIN_DIRT_SURFACE_PAGE.widthMeters).sub(margin),
          ),
        )
        .and(
          local.y.lessThanEqual(
            float(COMPACT_TERRAIN_DIRT_SURFACE_PAGE.widthMeters).sub(margin),
          ),
        );
      const result = vec4(0).toVar("compactDirtPageRaw");
      If(valid, () => {
        result.assign(
          this.page
            .grad(
              dx.div(COMPACT_TERRAIN_DIRT_SURFACE_PAGE.widthMeters),
              dy.div(COMPACT_TERRAIN_DIRT_SURFACE_PAGE.widthMeters),
            )
            .sample(local.div(COMPACT_TERRAIN_DIRT_SURFACE_PAGE.widthMeters)),
        );
      }).Else(() => {
        result.assign(originalRaw());
      });
      return result;
    })().toVar("compactDirtPageResult");
  }

  private captureSource(): SourcePin {
    const receipt = this.textures.getReceipt(),
      entry = receipt.textures.find(
        (row) => row.key === "dirt-albedo-roughness",
      );
    const image = this.textures.getNode("dirt", "albedo-roughness").value;
    const data = image.image;
    requirePage(
      receipt.status === "ready" &&
        entry?.status === "loaded" &&
        entry.sha256 &&
        entry.textureUuid === image.uuid &&
        image.isTexture &&
        image.colorSpace === THREE.SRGBColorSpace &&
        !image.isRenderTargetTexture &&
        data !== null &&
        typeof data === "object" &&
        "width" in data &&
        "height" in data &&
        data.width === 1024 &&
        data.height === 1024,
      "admitted loaded dirt AR source required",
    );
    return {
      texture: image,
      source: image.source,
      data: image.source.data,
      stamp: this.sourceStamp(image),
    };
  }

  private sourceStamp(image: THREE.Texture): string {
    return JSON.stringify([
      image.version,
      image.source.version,
      image.colorSpace,
      image.type,
      image.format,
      image.internalFormat,
      image.wrapS,
      image.wrapT,
      image.minFilter,
      image.magFilter,
      image.anisotropy,
      image.flipY,
      image.premultiplyAlpha,
      image.generateMipmaps,
      image.mapping,
      image.channel,
      image.matrixAutoUpdate,
      image.offset.toArray(),
      image.repeat.toArray(),
      image.center.toArray(),
      image.rotation,
      image.matrix.elements,
      this.textures.dirtProjection,
    ]);
  }

  private sourceMatches(): boolean {
    if (!this.source) return false;
    try {
      const current = this.textures.getNode("dirt", "albedo-roughness").value;
      return (
        this.textures.getReceipt().status === "ready" &&
        current === this.source.texture &&
        current.source === this.source.source &&
        current.source.data === this.source.data &&
        this.sourceStamp(current) === this.source.stamp
      );
    } catch {
      return false;
    }
  }

  /** MUST be awaited inside graphics.prepareRenderer(() => page.bake(...)).
   * Never nest prepareRenderer here or race this with ordinary rendering.
   * Caller timeout does not cancel its queued GPU work: call invalidate/dispose
   * to prevent late publication; retirement waits for the active operation.
   */
  async bake(
    renderer: WebGPURenderer,
    originX: number,
    originZ: number,
  ): Promise<void> {
    requirePage(
      !this.working && this.state !== "disposed",
      "page busy or disposed",
    );
    requirePage(
      Number.isFinite(originX) &&
        Number.isFinite(originZ) &&
        Math.abs(originX) <= 1e6 &&
        Math.abs(originZ) <= 1e6,
      "finite bounded origin required",
    );
    const backend = renderer?.backend as unknown as {
      isWebGPUBackend?: boolean;
      device?: GPUDevice;
    };
    const device = backend?.device;
    requirePage(
      renderer?.hasInitialized() &&
        backend.isWebGPUBackend &&
        device &&
        !renderer.xr.isPresenting &&
        device.limits.maxTextureDimension2D >=
          COMPACT_TERRAIN_DIRT_SURFACE_PAGE.size,
      "initialized native WebGPU required",
    );
    requirePage(
      this.renderer === null || this.renderer === renderer,
      "page cannot change renderer owner",
    );
    const context = renderer.contextNode;
    const ordinaryContext = () =>
      renderer.contextNode === context &&
      context.value !== null &&
      typeof context.value === "object" &&
      Object.keys(context.value).length === 0 &&
      renderer.opaque &&
      renderer.transparent &&
      renderer.lighting;
    requirePage(
      ordinaryContext(),
      "ordinary empty renderer context/switches required",
    );
    const source = this.captureSource();
    this.invalidate("rebaking");
    this.releaseSource?.();
    this.releaseSource = null;
    this.retire();
    const generation = this.generation,
      start = performance.now();
    this.renderer = renderer;
    this.source = source;
    this.working = true;
    this.state = "baking";
    const onSourceDispose = () => this.invalidate("source texture disposed");
    source.texture.addEventListener("dispose", onSourceDispose);
    this.releaseSource = () =>
      source.texture.removeEventListener("dispose", onSourceDispose);
    const errors: unknown[] = [];
    const compilation: { pending?: Promise<void> } = {};
    let restoreBuilderCallback: (() => void) | null = null;
    let assertBakeBuilder: (() => void) | null = null;
    let scopes = 0,
      submitted = false;
    const current = () =>
      requirePage(
        this.generation === generation &&
          this.state === "baking" &&
          this.sourceMatches() &&
          ordinaryContext(),
        "bake cancelled or source changed",
      );
    try {
      const size = COMPACT_TERRAIN_DIRT_SURFACE_PAGE.size,
        width = COMPACT_TERRAIN_DIRT_SURFACE_PAGE.widthMeters;
      this.target = new THREE.RenderTarget(size, size, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.LinearSRGBColorSpace,
        depthBuffer: false,
        stencilBuffer: false,
        samples: 0,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
      });
      this.target.texture.name = "CompactDirtSurfacePage.raw-linear-AR";
      this.target.texture.anisotropy = source.texture.anisotropy;
      this.target.texture.wrapS = this.target.texture.wrapT =
        THREE.ClampToEdgeWrapping;
      this.target.texture.premultiplyAlpha = false;
      this.material = new THREE.NodeMaterial();
      this.material.name = "CompactDirtSurfacePage.bake";
      this.material.fragmentNode = this.createRaw(
        uv().mul(width).add(vec2(originX, originZ)),
        vec2(width / size, 0),
        vec2(0, width / size),
      );
      this.material.vertexNode = vec4(THREE.TSL.positionGeometry.xy, 0, 1);
      this.material.depthWrite = false;
      this.material.depthTest = false;
      this.material.fog = false;
      this.material.blending = THREE.NoBlending;
      this.material.premultipliedAlpha = false;
      this.material.toneMapped = false;
      const quad = new THREE.QuadMesh(this.material);
      quad.frustumCulled = false;
      const ownedMaterial = this.material,
        expectedFragment = ownedMaterial.fragmentNode;
      const debug = renderer.debug as unknown as BakeDebug;
      const descriptor = Object.getOwnPropertyDescriptor(
          debug,
          "onNodeBuilderCreated",
        ),
        prior = debug.onNodeBuilderCreated;
      requirePage(
        (prior === null || typeof prior === "function") &&
          (descriptor
            ? descriptor.configurable && "value" in descriptor
            : Object.isExtensible(debug)),
        "safe public builder callback required",
      );
      const builders: BakeBuilder[] = [];
      let overflow = false;
      const observe: BuilderCallback = (builder, owner) => {
        prior?.(builder, owner);
        if (owner.object === quad && owner.material === ownedMaterial) {
          if (builders.length < 4) builders.push(builder);
          else overflow = true;
        }
      };
      Object.defineProperty(debug, "onNodeBuilderCreated", {
        value: observe,
        configurable: true,
        writable: true,
        enumerable: descriptor?.enumerable ?? false,
      });
      restoreBuilderCallback = () => {
        requirePage(
          debug.onNodeBuilderCreated === observe,
          "foreign builder callback retained",
        );
        if (descriptor)
          Object.defineProperty(debug, "onNodeBuilderCreated", descriptor);
        else Reflect.deleteProperty(debug, "onNodeBuilderCreated");
        const after = Object.getOwnPropertyDescriptor(
          debug,
          "onNodeBuilderCreated",
        );
        requirePage(
          debug.onNodeBuilderCreated === prior &&
            (descriptor
              ? !!after &&
                Reflect.ownKeys(descriptor).every((k) =>
                  Object.is(
                    descriptor[k as keyof PropertyDescriptor],
                    after[k as keyof PropertyDescriptor],
                  ),
                )
              : !after),
          "builder callback restoration failed",
        );
      };
      assertBakeBuilder = () =>
        requirePage(
          debug.onNodeBuilderCreated === observe &&
            builders.length > 0 &&
            !overflow &&
            builders.every(
              (builder) =>
                builder.material === ownedMaterial &&
                typeof builder.fragmentShader === "string" &&
                builder.fragmentShader.length > 0,
            ) &&
            ownedMaterial.fragmentNode === expectedFragment,
          "owned raw dirt shader required; fallback material rejected",
        );
      for (const filter of [
        "out-of-memory",
        "internal",
        "validation",
      ] as const) {
        device.pushErrorScope(filter);
        scopes++;
      }
      // Initiate compilation with target state; restore synchronously BEFORE await.
      this.withTarget(renderer, this.target, () => {
        compilation.pending = renderer.compileAsync(quad, quad.camera);
      });
      await compilation.pending;
      current();
      assertBakeBuilder();
      submitted = true;
      this.issuedDraws = this.withTarget(renderer, this.target, () => {
        const before = renderer.info.render.drawCalls;
        // Do not use QuadMesh.render(): that method temporarily replaces vertexNode.
        // Our explicit fullscreen vertex is the same for compilation and drawing.
        renderer.render(quad, quad.camera);
        return renderer.info.render.drawCalls - before;
      });
      requirePage(this.issuedDraws === 1, "one actual page draw required");
      await device.queue.onSubmittedWorkDone();
      current();
      assertBakeBuilder();
    } catch (error) {
      errors.push(error);
    } finally {
      // Even if synchronous state restoration failed, await the already-started
      // compiler before retiring resources that its continuation still owns.
      await compilation.pending?.catch((error) => {
        if (!errors.includes(error)) errors.push(error);
      });
      // Compile/upload work can precede the draw too. Drain before retirement.
      await device.queue.onSubmittedWorkDone().catch((error) => {
        errors.push(error);
      });
      while (scopes > 0) {
        scopes--;
        try {
          const error = await device.popErrorScope();
          if (error) errors.push(new Error(error.message));
        } catch (error) {
          errors.push(error);
        }
      }
      for (const action of [assertBakeBuilder, restoreBuilderCallback]) {
        try {
          action?.();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        current();
        requirePage(
          submitted && this.target && errors.length === 0,
          "bake did not complete cleanly",
        );
        this.origin.value.set(originX, originZ);
        this.page.value = this.target.texture;
        this.ready.value = true;
        this.state = "ready";
        this.reason = null;
        this.completedBakes++;
      } catch (error) {
        if (!errors.length) errors.push(error);
      }
      this.working = false;
      this.preparationMs = performance.now() - start;
      try {
        this.material?.dispose();
      } catch (error) {
        errors.push(error);
      } finally {
        this.material = null;
      }
      if (errors.length && this.state === "ready")
        this.invalidate("cleanup failed");
      if (this.state !== "ready") {
        if (this.state === "baking") {
          this.state = "failed";
          this.reason = "bake failed";
        }
        try {
          this.retire();
        } catch (error) {
          errors.push(error);
        }
        this.releaseSource?.();
        this.releaseSource = null;
      }
      if (this.isDisposed()) {
        try {
          this.disposePlaceholder();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "Compact dirt surface page bake failed");
  }

  /** Saves public state without calling setPixelRatio/setSize on the game canvas. */
  private withTarget<T>(
    renderer: WebGPURenderer,
    target: THREE.RenderTarget,
    operation: () => T,
  ): T {
    const saved = {
      target: renderer.getRenderTarget(),
      face: renderer.getActiveCubeFace(),
      mip: renderer.getActiveMipmapLevel(),
      mrt: renderer.getMRT(),
      callback: renderer.getRenderObjectFunction(),
      viewport: renderer.getViewport(new THREE.Vector4()),
      scissor: renderer.getScissor(new THREE.Vector4()),
      scissorTest: renderer.getScissorTest(),
      clear: renderer.getClearColor(new THREE.Color()),
      alpha: renderer.getClearAlpha(),
      autoClear: renderer.autoClear,
      toneMapping: renderer.toneMapping,
      exposure: renderer.toneMappingExposure,
      colorSpace: renderer.outputColorSpace,
    };
    const errors: unknown[] = [];
    let value!: T;
    try {
      renderer.setMRT(null);
      renderer.setRenderObjectFunction(null);
      renderer.setRenderTarget(target);
      renderer.setScissorTest(false);
      renderer.setClearColor(0, 0);
      renderer.autoClear = true;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      value = operation();
    } catch (error) {
      errors.push(error);
    } finally {
      for (const restore of [
        () => renderer.setRenderTarget(saved.target, saved.face, saved.mip),
        () => renderer.setMRT(saved.mrt),
        () => renderer.setRenderObjectFunction(saved.callback),
        () => renderer.setViewport(saved.viewport),
        () => renderer.setScissor(saved.scissor),
        () => renderer.setScissorTest(saved.scissorTest),
        () => renderer.setClearColor(saved.clear, saved.alpha),
        () => {
          renderer.autoClear = saved.autoClear;
        },
        () => {
          renderer.toneMapping = saved.toneMapping;
        },
        () => {
          renderer.toneMappingExposure = saved.exposure;
        },
        () => {
          renderer.outputColorSpace = saved.colorSpace;
        },
      ]) {
        try {
          restore();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "Compact dirt page operation/state restoration failed",
      );
    return value;
  }

  invalidate(reason = "manual"): void {
    if (this.state === "disposed") return;
    this.generation++;
    this.ready.value = false;
    this.page.value = this.placeholder;
    this.state = "invalid";
    this.reason = reason;
  }

  getReceipt() {
    if (this.state === "ready" && !this.sourceMatches())
      this.invalidate("source changed");
    return {
      ...COMPACT_TERRAIN_DIRT_SURFACE_PAGE,
      state: this.state,
      reason: this.reason,
      ready: this.state === "ready",
      generation: this.generation,
      working: this.working,
      origin: this.origin.value.toArray(),
      allocatedBytes: this.target
        ? COMPACT_TERRAIN_DIRT_SURFACE_PAGE.mipBytes
        : 0,
      textureUuid: this.target?.texture.uuid ?? null,
      sourceTextureUuid: this.source?.texture.uuid ?? null,
      completedBakes: this.completedBakes,
      preparationMs: this.preparationMs,
      issuedDraws: this.issuedDraws,
      approximation:
        "fixed world-space raw dirt albedo/roughness page; native filtering/quality/performance unqualified",
    };
  }

  private retire(): void {
    const target = this.target;
    this.target = null;
    target?.dispose();
  }
  private disposePlaceholder(): void {
    if (!this.placeholderDisposed) {
      this.placeholderDisposed = true;
      this.placeholder.dispose();
    }
  }
  private isDisposed(): boolean {
    return this.state === "disposed";
  }
  dispose(): void {
    if (this.state === "disposed") return;
    this.invalidate("disposed");
    this.state = "disposed";
    this.releaseSource?.();
    this.releaseSource = null;
    if (!this.working) {
      this.retire();
      this.disposePlaceholder();
    }
  }
}
