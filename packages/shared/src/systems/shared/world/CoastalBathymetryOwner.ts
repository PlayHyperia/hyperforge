import THREE, {
  float,
  positionWorld,
  texture,
  uniform,
} from "../../../extras/three/three";
import type { Node, TextureNode, UniformNode } from "three/webgpu";
import {
  bakeCoastalBathymetry,
  COASTAL_BATHYMETRY,
  type CanonicalGroundLease,
  type CoastalBathymetryBake,
} from "./CoastalBathymetry";

function createTexture(
  data: Uint16Array,
  width: number,
  height: number,
): THREE.DataTexture {
  const value = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RedFormat,
    THREE.HalfFloatType,
  );
  value.name = COASTAL_BATHYMETRY.id;
  value.colorSpace = THREE.NoColorSpace;
  value.minFilter = value.magFilter = THREE.LinearFilter;
  value.wrapS = value.wrapT = THREE.ClampToEdgeWrapping;
  value.generateMipmaps = false;
  value.flipY = false;
  value.premultiplyAlpha = false;
  value.unpackAlignment = 1;
  value.needsUpdate = true;
  return value;
}

type PendingBake = {
  controller: AbortController;
  source: CanonicalGroundLease;
  generation: number;
  promise: Promise<boolean>;
};

/**
 * One world-owned, fragment-only field. Complete texture/reference/uniform swaps
 * are synchronous between render calls; no partial upload is ever published.
 */
export class CoastalBathymetryOwner {
  readonly textureNode: TextureNode<"vec4">;
  readonly grid: UniformNode<"vec4", THREE.Vector4> = uniform(
    new THREE.Vector4(0, 0, 1, 1),
  );
  readonly seaLevel: UniformNode<"float", number> = uniform(0);
  readonly enabled: UniformNode<"float", number> = uniform(0);
  readonly signedDepth: Node<"float">;
  private ownedTexture: THREE.DataTexture;
  private sourceFactory: (() => CanonicalGroundLease) | null = null;
  private publishedSource: CanonicalGroundLease | null = null;
  private published: Omit<CoastalBathymetryBake, "data"> | null = null;
  private pending: PendingBake | null = null;
  private failedSource: CanonicalGroundLease | null = null;
  private factoryFailed = false;
  private failure: string | null = null;
  private generation = 0;
  private progressSamples = 0;
  private destroyed = false;

  constructor() {
    // Same R16F binding/filter contract as every later revision. Disabled optics
    // keep legacy shading; this is not an admitted or partially baked field.
    this.ownedTexture = createTexture(
      new Uint16Array([THREE.DataUtils.toHalfFloat(8)]),
      1,
      1,
    );
    this.textureNode = texture(this.ownedTexture);
    const sampleUV = positionWorld.xz
      .sub(this.grid.xy)
      .div(float(COASTAL_BATHYMETRY.spacing))
      .add(float(0.5))
      .div(this.grid.zw);
    this.signedDepth = this.textureNode
      .sample(sampleUV)
      .level(float(0))
      .r.toVar("coastalBathymetrySignedDepth");
  }

  async configure(sourceFactory: () => CanonicalGroundLease): Promise<boolean> {
    if (this.destroyed) throw new Error("Coastal field owner is destroyed");
    this.sourceFactory = sourceFactory;
    this.invalidate();
    const generation = this.generation;
    if (this.pending) {
      // The superseded caller still receives its own failure. This configure
      // waits only for retirement before allocating the new authority's array.
      try {
        await this.pending.promise;
      } catch {
        /* Superseded work retired. */
      }
    }
    if (this.destroyed || this.generation !== generation) return false;
    return this.beginBake();
  }

  /** Called synchronously by actual height mutations, never by grass-only edits. */
  invalidate(): void {
    if (this.destroyed) return;
    this.generation++;
    this.enabled.value = 0;
    this.pending?.controller.abort();
    this.failedSource = null;
    this.factoryFailed = false;
    this.failure = null;
  }

  private beginBake(): Promise<boolean> {
    if (this.destroyed || !this.sourceFactory) return Promise.resolve(false);
    // Let a cancelled slice retire before allocating its successor: no growing
    // stack of superseded full-size arrays under repeated authoring edits.
    if (this.pending) return this.pending.promise;
    let source: CanonicalGroundLease;
    try {
      source = this.sourceFactory();
      if (!source.isCurrent())
        throw new Error("Canonical ground lease is already stale");
    } catch (error) {
      this.factoryFailed = true;
      this.failure = String(error);
      return Promise.reject(error);
    }
    this.progressSamples = 0;
    const work: PendingBake = {
      source,
      controller: new AbortController(),
      generation: this.generation,
      promise: Promise.resolve(false),
    };
    this.pending = work;
    work.promise = bakeCoastalBathymetry(
      source,
      work.controller.signal,
      (samples) => {
        if (this.pending === work) this.progressSamples = samples;
      },
    )
      .then((field) => {
        if (
          !field ||
          this.destroyed ||
          this.pending !== work ||
          this.generation !== work.generation ||
          !source.isCurrent()
        )
          return false;
        const next = createTexture(
          field.data,
          field.domain.width,
          field.domain.height,
        );
        const previous = this.ownedTexture;
        this.ownedTexture = next;
        // Sampled clones refer to the stable base TextureNode. r186 refreshes the
        // native binding when this base value changes; do not mutate a clone.
        this.textureNode.value = next;
        this.grid.value.set(
          field.domain.firstX,
          field.domain.firstZ,
          field.domain.width,
          field.domain.height,
        );
        this.seaLevel.value = field.seaLevel;
        this.publishedSource = source;
        this.published = {
          domain: field.domain,
          seaLevel: field.seaLevel,
          sourceRevision: field.sourceRevision,
          statistics: field.statistics,
        };
        this.enabled.value = 1;
        previous.dispose();
        // A synchronous Three disposal listener can retire/invalidate this owner.
        return (
          !this.destroyed &&
          this.generation === work.generation &&
          source.isCurrent()
        );
      })
      .catch((error) => {
        if (
          !this.destroyed &&
          this.pending === work &&
          this.generation === work.generation &&
          source.isCurrent()
        ) {
          this.enabled.value = 0;
          this.failure = String(error);
          this.failedSource = source;
        }
        throw error;
      })
      .finally(() => {
        if (this.pending === work) this.pending = null;
      });
    return work.promise;
  }

  /** No steady-state height sampling: just O(1) authority/lifecycle checks. */
  update(): void {
    if (this.destroyed || !this.sourceFactory) return;
    if (
      (this.enabled.value === 1 && !this.publishedSource?.isCurrent()) ||
      (this.pending &&
        !this.pending.controller.signal.aborted &&
        !this.pending.source.isCurrent())
    )
      this.invalidate();
    if (
      this.enabled.value === 1 ||
      this.pending ||
      this.factoryFailed ||
      this.failedSource?.isCurrent()
    )
      return;
    void this.beginBake().catch((error) => {
      // One error per failed authority; retry only on an actual new revision.
      if (!this.destroyed && this.failure !== null)
        console.error(
          "[WaterSystem] Coastal bathymetry generation failed",
          error,
        );
    });
  }

  getReadiness() {
    const required = this.sourceFactory !== null;
    const current = this.publishedSource?.isCurrent() === true;
    const ready =
      !this.destroyed && (!required || (this.enabled.value === 1 && current));
    return {
      required,
      ready,
      status: this.destroyed
        ? "destroyed"
        : !required
          ? "inactive"
          : this.pending
            ? "building"
            : this.failure
              ? "failed"
              : ready
                ? "ready"
                : "stale",
      sourceRevision: this.published?.sourceRevision ?? null,
      pendingRevision: this.pending?.source.revision ?? null,
      progressSamples: this.progressSamples,
      domain: this.published?.domain ?? null,
      statistics: this.published?.statistics ?? null,
      textureId: this.ownedTexture.uuid,
      error: this.failure,
      scope:
        "CPU field/readiness and nominal texel payload; not GPU allocation, timing or visual approval",
    };
  }

  /** Borrowed for bounded diagnostics only; this owner alone disposes it. */
  getTexture(): THREE.DataTexture {
    return this.ownedTexture;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation++;
    this.enabled.value = 0;
    this.pending?.controller.abort();
    this.sourceFactory = null;
    this.publishedSource = null;
    this.failedSource = null;
    this.published = null;
    this.ownedTexture.dispose();
  }
}
