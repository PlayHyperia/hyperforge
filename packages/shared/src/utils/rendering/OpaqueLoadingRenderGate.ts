export type OpaqueLoadingCoverLease = Readonly<{
  /** Permit rendering under the still-opaque cover. Repeated calls are inert. */
  beginWarmup(): void;
  /** Two successful primary submissions, not GPU completion or presentation. */
  isWarm(): boolean;
  release(): void;
}>;

export type OpaqueLoadingCoverStatus = Readonly<{
  state: "uncovered" | "opaque" | "warming" | "warm" | "destroyed";
  generation: number;
  successfulWarmFrames: number;
  lastWarmFrame: number | null;
  skippedSubmissions: number;
  successfulPrimarySubmissions: number;
}>;

type CoverOwner = {
  warming: boolean;
  afterFrame: number;
  lastWarmFrame: number | null;
  successfulWarmFrames: number;
};

/** CPU-only ownership. The UI must prove its cover is opaque before acquiring.
 * No timers, renderer work, world ticking or presentation state live here. */
export class OpaqueLoadingRenderGate {
  private owner: CoverOwner | null = null;
  private generation = 0;
  private destroyed = false;
  private skippedSubmissions = 0;
  private successfulPrimarySubmissions = 0;

  constructor(private readonly currentWorldFrame: () => number) {}

  acquire(): OpaqueLoadingCoverLease {
    if (this.destroyed) {
      throw new Error(
        "Cannot acquire an opaque loading cover after destruction",
      );
    }
    const owner: CoverOwner = {
      warming: false,
      afterFrame: this.currentWorldFrame(),
      lastWarmFrame: null,
      successfulWarmFrames: 0,
    };
    this.owner = owner;
    this.generation++;
    return Object.freeze({
      beginWarmup: () => {
        if (this.owner !== owner || owner.warming) return;
        owner.warming = true;
        this.invalidate();
      },
      isWarm: () => this.owner === owner && owner.successfulWarmFrames >= 2,
      release: () => {
        if (this.owner !== owner) return;
        this.owner = null;
        this.generation++;
      },
    });
  }

  /** Restart freshness without revoking a warming owner's render permission. */
  invalidate(): void {
    if (!this.owner) return;
    this.generation++;
    this.owner.afterFrame = this.currentWorldFrame();
    this.owner.lastWarmFrame = null;
    this.owner.successfulWarmFrames = 0;
  }

  /** Capture before the final main draw, after all essential preparation hooks.
   * The numeric ticket also protects against synchronous renderer callbacks
   * replacing a lease or invalidating the view during that draw. */
  beginSubmission(): number | null {
    if (this.destroyed) return null;
    if (this.owner && !this.owner.warming) {
      this.skippedSubmissions++;
      return null;
    }
    return this.generation;
  }

  /** Call only after the selected renderer/composer returned successfully.
   * null denotes a direct/resize render, never a primary world commit. */
  completeSubmission(ticket: number, primaryWorldFrame: number | null): void {
    if (primaryWorldFrame === null || this.destroyed) return;
    this.successfulPrimarySubmissions++;
    const owner = this.owner;
    if (
      ticket !== this.generation ||
      !owner?.warming ||
      !Number.isSafeInteger(primaryWorldFrame) ||
      primaryWorldFrame <= owner.afterFrame ||
      (owner.lastWarmFrame !== null && primaryWorldFrame <= owner.lastWarmFrame)
    ) {
      return;
    }
    owner.lastWarmFrame = primaryWorldFrame;
    owner.successfulWarmFrames = Math.min(2, owner.successfulWarmFrames + 1);
  }

  getStatus(): OpaqueLoadingCoverStatus {
    return {
      state: this.destroyed
        ? "destroyed"
        : !this.owner
          ? "uncovered"
          : !this.owner.warming
            ? "opaque"
            : this.owner.successfulWarmFrames >= 2
              ? "warm"
              : "warming",
      generation: this.generation,
      successfulWarmFrames: this.owner?.successfulWarmFrames ?? 0,
      lastWarmFrame: this.owner?.lastWarmFrame ?? null,
      skippedSubmissions: this.skippedSubmissions,
      successfulPrimarySubmissions: this.successfulPrimarySubmissions,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.owner = null;
    this.generation++;
  }
}
