import {
  GrassGroundingWorkerClient,
  type GrassGroundingClientRequest,
  type GrassGroundingClientSettled,
  type GrassGroundingWorkerPort,
} from "../../../utils/workers/GrassGroundingWorkerClient";
import {
  GRASS_GROUNDING_WORKER_LIMITS as payloadLimits,
  type GrassGroundingWorkerResponse,
} from "../../../utils/workers/GrassGroundingWorkerWire";
import {
  GRASS_BLADE_GROUNDING_JOB_LIMITS as limits,
  GRASS_BLADE_GROUNDING_LIMITS,
  GrassGroundingContinuation,
  type GrassBladeGroundingJobState,
  type GrassGroundingConsumedWork,
} from "./GrassBladeGrounding";
import {
  GrassGroundingPreparationContinuation,
  prepareGrassGroundingHandoffSteps,
  type GrassGroundingHandoffRequest,
  type GrassGroundingPreparedInput,
} from "./GrassGroundingHandoff";
import {
  finishGroundedGrassWorkerSteps,
  type GrassGroundingInputLease,
} from "./GrassGroundingPipeline";
import {
  RetainedTerrainSurface,
  type RetainedTerrainSurfaceSnapshot,
} from "./TerrainGridSurface";

export type GrassGroundingWorkerJobPhase =
  "cache" | "preparing" | "waiting_worker" | "remapping" | "terminal";

type AdmissionResponse = Readonly<{
  status: string;
  reason: string | null;
  phase: string | null;
  work: Readonly<GrassGroundingConsumedWork> | null;
  workBeforeMerge: Readonly<GrassGroundingConsumedWork>;
  jobId: number;
  generation: number;
  dispatchCpuMs: number;
  chargedDispatchMs: number;
  postMessageCpuMs: number;
  receiveCpuMs: number;
}>;

/** One terminal admission diagnostic, not a retained geometry/job history.
 * Work measures synchronous elapsed slices (including GC/preemption), not
 * exclusive CPU time. No error graphs, input buffers or terrain owners escape. */
export type GrassGroundingAdmissionFailure = Readonly<{
  schemaVersion: 1;
  generation: number;
  mainPhase: string | null;
  status: "failed_budget" | "failed_input";
  reason:
    | Extract<
        GrassBladeGroundingJobState,
        { status: "failed_budget" }
      >["reason"]
    | null;
  owner: Readonly<{
    token: number;
    nodeId: number;
    sourceRevision: string;
    centerX: number;
    centerZ: number;
    size: number;
    resolution: number;
    inputBytes: number;
    derivedBytesReserved: number;
  }>;
  submittedWork: Readonly<GrassGroundingConsumedWork> | null;
  response: AdmissionResponse | null;
  mergedWork: Readonly<GrassGroundingConsumedWork>;
}>;

/** Last failed fitting settlement, not all possible job failures. The merge
 * excludes the enclosing main-thread advance's still-running supervision tail.
 * No snapshots are allocated for successful or cancelled result settlements.
 * Timings are elapsed synchronous spans, not exclusive CPU measurements. */
export type GrassGroundingFittingFailure = Readonly<{
  schemaVersion: 1;
  scope: "settlement_before_main_supervision_tail";
  generation: number;
  status: "failed_budget" | "failed_input";
  reason: GrassGroundingAdmissionFailure["reason"];
  submittedWork: Readonly<GrassGroundingConsumedWork>;
  response: AdmissionResponse;
  mergedWork: Readonly<GrassGroundingConsumedWork>;
}>;

/** Numerical payload and retained query-index reservations, NOT total JS/GPU
 * heap. Only bounded scalars and the last admission/fitting failures survive. */
export type GrassGroundingWorkerCoordinatorReceipt = Readonly<{
  cacheOwners: number;
  cacheInputBytes: number;
  cacheDerivedBytesReserved: number;
  reservedOwners: number;
  reservedInputBytes: number;
  reservedDerivedBytes: number;
  admissionOperations: number;
  admissionActiveMs: number;
  admissionMaximumSliceMs: number;
  preparedOwners: number;
  cacheHits: number;
  releasedOwners: number;
  activeGeneration: number | null;
  transportJobId: number | null;
  phase: GrassGroundingWorkerJobPhase | "idle" | "release";
  terminated: boolean;
  lastAdmissionFailure: GrassGroundingAdmissionFailure | null;
  /** Absent until an actual fitting settlement fails; not a current-job join. */
  lastFittingFailure?: GrassGroundingFittingFailure;
}>;

type Owner = {
  surface: RetainedTerrainSurface;
  token: number;
  inputBytes: number;
  derivedBytes: number;
  used: number;
  usable: boolean;
};
type Admission = {
  owner: Owner;
  iterator: Generator<string, RetainedTerrainSurfaceSnapshot, void> | null;
  snapshot: RetainedTerrainSurfaceSnapshot | null;
  work: GrassGroundingConsumedWork;
  submittedWork: Readonly<GrassGroundingConsumedWork> | null;
  response: AdmissionResponse | null;
};
type Context = {
  job: GrassGroundingWorkerJob | null;
  generation: number;
  request: GrassGroundingHandoffRequest;
  inputs: GrassGroundingInputLease;
  getWater: (x: number, z: number) => number;
  isExcluded: (x: number, z: number) => boolean;
  isCurrent: () => boolean;
  sourceCurrent: (() => boolean) | null;
  surfaces: readonly RetainedTerrainSurface[];
  owners: Owner[];
  planned: boolean;
  fitBytes: number;
  state: GrassBladeGroundingJobState;
  phase: GrassGroundingWorkerJobPhase;
  lastPhase: string | null;
  fit: GrassGroundingConsumedWork;
  lastSliceOperations: number;
  lastSliceMs: number;
  maximumSliceMs: number;
  admission: Admission | null;
  handoff: GrassGroundingPreparationContinuation | null;
  prepared: GrassGroundingPreparedInput | null;
  publication: GrassGroundingContinuation | null;
};
type Pending = {
  id: number;
  context: Context | null;
  kind: "prepare_surface" | "start_cached" | "release_surfaces";
  owner: Owner | null;
  releases: Owner[];
  seed: GrassGroundingConsumedWork;
  /** submit/cancel wall time already included in a main-thread work ledger. */
  chargedDispatchMs: number;
};

function zeroWork(): GrassGroundingConsumedWork {
  return { operations: 0, activeMs: 0, maximumSliceMs: 0 };
}
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function addBounded(a: number, b: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, a + b);
}
function budget(
  work: GrassGroundingConsumedWork,
): GrassBladeGroundingJobState | null {
  if (work.operations >= limits.maximumOperations)
    return { status: "failed_budget", reason: "operations" };
  if (work.activeMs >= limits.maximumActiveMs)
    return { status: "failed_budget", reason: "active_cpu" };
  return null;
}
function validateSlice(maxOperations: number, sharedDeadlineMs?: number): void {
  ensure(
    Number.isSafeInteger(maxOperations) &&
      maxOperations >= 1 &&
      maxOperations <= limits.maximumSliceOperations,
    "Invalid coordinator slice operation bound",
  );
  ensure(
    sharedDeadlineMs === undefined ||
      (Number.isFinite(sharedDeadlineMs) && sharedDeadlineMs >= 0),
    "Invalid coordinator shared deadline",
  );
}

/** The adapter owns no worker URL, mesh or scheduler. A dormant job holds only
 * borrowed caller inputs: only the coordinator's single active job can copy. */
export class GrassGroundingWorkerJob {
  constructor(
    private readonly context: Context,
    private readonly coordinator: GrassGroundingWorkerCoordinator,
  ) {}

  get state(): GrassBladeGroundingJobState {
    return this.context.state;
  }
  get operations(): number {
    return this.context.fit.operations;
  }
  get activeMs(): number {
    return this.context.fit.activeMs;
  }
  get lastSliceOperations(): number {
    return this.context.lastSliceOperations;
  }
  get lastSliceMs(): number {
    return this.context.lastSliceMs;
  }
  get maximumSliceMs(): number {
    return this.context.maximumSliceMs;
  }
  /** Fitting-ledger maximum across main preparation/publication and merged
   * worker/transport slices; excludes separately budgeted terrain admission.
   * Like activeMs, elapsed slices include GC/preemption, not exclusive CPU. */
  get cumulativeMaximumSliceMs(): number {
    return this.context.fit.maximumSliceMs;
  }
  get lastPhase(): string | null {
    return this.context.lastPhase;
  }
  get phase(): GrassGroundingWorkerJobPhase {
    return this.context.phase;
  }
  get transportJobId(): number | null {
    return this.coordinator.transportIdFor(this.context);
  }
  advance(
    maxOperations: number = limits.maximumSliceOperations,
    sharedDeadlineMs?: number,
  ): GrassBladeGroundingJobState {
    return this.coordinator.advanceJob(
      this.context,
      maxOperations,
      sharedDeadlineMs,
    );
  }
  cancel(): GrassBladeGroundingJobState {
    return this.coordinator.cancelJob(this.context, "caller");
  }
  rejectPublication(error: unknown): GrassBladeGroundingJobState {
    ensure(
      this.context.state.status === "ready",
      "Only completed grounding can fail publication",
    );
    this.context.state = { status: "failed_input", error };
    return this.context.state;
  }
}

/** One transport slot, no FIFO and no fallback after detached-buffer failure.
 * Preparation is independently bounded per immutable owner, and its measured
 * copy + rebuild cost is retained separately from cumulative fitting work. */
export class GrassGroundingWorkerCoordinator {
  private readonly client: GrassGroundingWorkerClient;
  private readonly cache = new Map<RetainedTerrainSurface, Owner>();
  private readonly failedOwners = new WeakMap<
    RetainedTerrainSurface,
    GrassBladeGroundingJobState
  >();
  private active: Context | null = null;
  private pending: Pending | null = null;
  private generation = 0;
  private nextToken = 1;
  private useSequence = 0;
  private stopped = false;
  private advancing: Context | null = null;
  private admissionOperations = 0;
  private admissionActiveMs = 0;
  private admissionMaximumSliceMs = 0;
  private preparedOwners = 0;
  private cacheHits = 0;
  private releasedOwners = 0;
  private lastAdmissionFailure: GrassGroundingAdmissionFailure | null = null;
  private lastFittingFailure: GrassGroundingFittingFailure | null = null;

  constructor(
    port: GrassGroundingWorkerPort,
    private readonly isSurfaceCurrent: (
      surface: RetainedTerrainSurface,
    ) => boolean,
  ) {
    this.client = new GrassGroundingWorkerClient(port);
  }

  get activeJob(): GrassGroundingWorkerJob | null {
    return this.active?.job ?? null;
  }

  get receipt(): GrassGroundingWorkerCoordinatorReceipt {
    let inputBytes = 0,
      derivedBytes = 0;
    for (const owner of this.cache.values()) {
      inputBytes += owner.inputBytes;
      derivedBytes += owner.derivedBytes;
    }
    let reservedOwners = this.cache.size;
    let reservedInputBytes = inputBytes + (this.active?.fitBytes ?? 0);
    let reservedDerivedBytes = derivedBytes;
    for (const owner of this.active?.owners ?? []) {
      if (this.cache.get(owner.surface) === owner) continue;
      reservedOwners++;
      reservedInputBytes += owner.inputBytes;
      reservedDerivedBytes += owner.derivedBytes;
    }
    return Object.freeze({
      cacheOwners: this.cache.size,
      cacheInputBytes: inputBytes,
      cacheDerivedBytesReserved: derivedBytes,
      reservedOwners,
      reservedInputBytes,
      reservedDerivedBytes,
      admissionOperations: addBounded(
        this.admissionOperations,
        this.active?.admission?.work.operations ?? 0,
      ),
      admissionActiveMs: addBounded(
        this.admissionActiveMs,
        this.active?.admission?.work.activeMs ?? 0,
      ),
      admissionMaximumSliceMs: Math.max(
        this.admissionMaximumSliceMs,
        this.active?.admission?.work.maximumSliceMs ?? 0,
      ),
      preparedOwners: this.preparedOwners,
      cacheHits: this.cacheHits,
      releasedOwners: this.releasedOwners,
      activeGeneration: this.active?.generation ?? null,
      transportJobId: this.pending?.id ?? null,
      phase:
        this.pending?.kind === "release_surfaces"
          ? "release"
          : (this.active?.phase ?? "idle"),
      terminated: this.stopped || this.client.terminated,
      lastAdmissionFailure: this.lastAdmissionFailure,
      ...(this.lastFittingFailure
        ? { lastFittingFailure: this.lastFittingFailure }
        : {}),
    });
  }

  createJob(
    request: GrassGroundingHandoffRequest,
    inputs: GrassGroundingInputLease,
    getWater: (x: number, z: number) => number,
    isExcluded: (x: number, z: number) => boolean,
    isCurrent: () => boolean,
  ): GrassGroundingWorkerJob {
    ensure(
      Number.isSafeInteger(this.generation + 1),
      "Grounding generation exhausted",
    );
    const context: Context = {
      job: null,
      generation: ++this.generation,
      request,
      inputs,
      getWater,
      isExcluded,
      isCurrent,
      sourceCurrent: null,
      surfaces: Object.freeze([...request.surfaces]),
      owners: [],
      planned: false,
      fitBytes: 0,
      state: { status: "running" },
      phase: "cache",
      lastPhase: null,
      fit: zeroWork(),
      lastSliceOperations: 0,
      lastSliceMs: 0,
      maximumSliceMs: 0,
      admission: null,
      handoff: null,
      prepared: null,
      publication: null,
    };
    const job = new GrassGroundingWorkerJob(context, this);
    context.job = job;
    return job;
  }

  /** @internal The job adapter delegates without exposing its mutable context. */
  transportIdFor(context: Context): number | null {
    return this.pending?.context === context ? this.pending.id : null;
  }

  private surfaceCurrent(surface: RetainedTerrainSurface): boolean {
    try {
      if (!this.isSurfaceCurrent(surface)) return false;
      surface.snapshotLayout();
      return true;
    } catch {
      return false;
    }
  }

  private current(context: Context): boolean {
    try {
      return (
        context.isCurrent() &&
        context.inputs.isCurrent() &&
        context.request.surfaces.length === context.surfaces.length &&
        context.surfaces.every(
          (surface, i) =>
            context.request.surfaces[i] === surface &&
            this.surfaceCurrent(surface),
        ) &&
        (context.sourceCurrent?.() ?? true)
      );
    } catch {
      return false;
    }
  }

  private close(context: Context, state: GrassBladeGroundingJobState): void {
    context.state = state;
    context.phase = "terminal";
    context.handoff?.cancel();
    context.handoff = null;
    context.publication?.cancel();
    context.publication = null;
    context.admission?.iterator?.return(undefined as never);
    if (context.admission) {
      context.admission.iterator = null;
      context.admission.snapshot = null;
    }
    context.prepared = null;
    context.inputs.steps.return(undefined as never);
    // A cancelled/failed flight still owns its copied payload and pins until
    // the real terminal acknowledgement (or transport termination) is consumed.
    if (this.pending?.context !== context) this.releaseContext(context);
  }

  private stateOf(context: Context): GrassBladeGroundingJobState {
    return context.state;
  }

  private releaseContext(context: Context): void {
    if (context.admission) {
      if (this.advancing !== context)
        this.captureAdmissionFailure(context, context.admission);
      this.recordAdmission(context.admission.work);
      context.admission = null;
    }
    context.owners = [];
    context.fitBytes = 0;
    if (this.active === context) this.active = null;
  }

  private recordAdmission(work: GrassGroundingConsumedWork): void {
    this.admissionOperations = addBounded(
      this.admissionOperations,
      work.operations,
    );
    this.admissionActiveMs = addBounded(this.admissionActiveMs, work.activeMs);
    this.admissionMaximumSliceMs = Math.max(
      this.admissionMaximumSliceMs,
      work.maximumSliceMs,
    );
  }

  private captureAdmissionFailure(
    context: Context,
    admission: Admission,
  ): void {
    const state = context.state;
    if (state.status !== "failed_budget" && state.status !== "failed_input")
      return;
    const owner = admission.owner;
    const surface = owner.surface;
    this.lastAdmissionFailure = Object.freeze({
      schemaVersion: 1,
      generation: context.generation,
      mainPhase: context.lastPhase?.slice(0, 256) ?? null,
      status: state.status,
      reason: state.status === "failed_budget" ? state.reason : null,
      owner: Object.freeze({
        token: owner.token,
        nodeId: surface.nodeId,
        sourceRevision: surface.revision.slice(0, 256),
        centerX: surface.centerX,
        centerZ: surface.centerZ,
        size: surface.size,
        resolution: surface.resolution,
        inputBytes: owner.inputBytes,
        derivedBytesReserved: owner.derivedBytes,
      }),
      submittedWork: admission.submittedWork,
      response: admission.response,
      mergedWork: Object.freeze({ ...admission.work }),
    });
  }

  private captureFittingFailure(
    context: Context,
    response: Extract<GrassGroundingWorkerResponse, { type: "result" }>,
    pending: Pending,
    settled: GrassGroundingClientSettled,
    beforeOperations: number,
    beforeActiveMs: number,
    beforeMaximumSliceMs: number,
  ): void {
    const state = context.state;
    if (state.status !== "failed_budget" && state.status !== "failed_input")
      return;
    this.lastFittingFailure = Object.freeze({
      schemaVersion: 1,
      scope: "settlement_before_main_supervision_tail",
      generation: context.generation,
      status: state.status,
      reason: state.status === "failed_budget" ? state.reason : null,
      submittedWork: Object.freeze({ ...pending.seed }),
      response: Object.freeze({
        status: response.state.status,
        reason:
          response.state.status === "failed_budget"
            ? response.state.reason
            : null,
        phase: response.lastPhase?.slice(0, 256) ?? null,
        work: Object.freeze({ ...response.work }),
        workBeforeMerge: Object.freeze({
          operations: beforeOperations,
          activeMs: beforeActiveMs,
          maximumSliceMs: beforeMaximumSliceMs,
        }),
        jobId: settled.jobId,
        generation: settled.generation,
        dispatchCpuMs: settled.dispatchCpuMs,
        chargedDispatchMs: pending.chargedDispatchMs,
        postMessageCpuMs: settled.postMessageCpuMs,
        receiveCpuMs: settled.receiveCpuMs,
      }),
      mergedWork: Object.freeze({ ...context.fit }),
    });
  }

  /** @internal */
  cancelJob(
    context: Context,
    reason: "caller" | "invalidated",
  ): GrassBladeGroundingJobState {
    if (context.state.status !== "running") return context.state;
    this.cancelFlight(context);
    this.close(context, { status: "cancelled", reason });
    return context.state;
  }

  private cancelFlight(context: Context): void {
    if (this.pending?.context === context) {
      const started = performance.now();
      this.client.cancel();
      const elapsed = performance.now() - started;
      this.pending.chargedDispatchMs += elapsed;
      const work =
        this.pending.kind === "prepare_surface"
          ? context.admission?.work
          : context.fit;
      if (work && this.advancing !== context) {
        work.activeMs += elapsed;
        work.maximumSliceMs = Math.max(work.maximumSliceMs, elapsed);
      }
    }
  }

  private failTransport(context: Context | null, error: unknown): void {
    const active = this.active;
    this.stopped = true;
    this.client.destroy();
    this.pending = null;
    this.cache.clear();
    // A dormant caller can observe transport death before the active owner or
    // maintenance does. Release the actual slot owner independently of caller.
    if (active?.state.status === "running")
      this.close(active, { status: "failed_input", error });
    else if (active) this.releaseContext(active);
    if (context && context !== active) {
      if (context.state.status === "running")
        this.close(context, { status: "failed_input", error });
      else this.releaseContext(context);
    }
  }

  private fitReservation(request: GrassGroundingHandoffRequest): number {
    ensure(
      Number.isSafeInteger(request.data.count) &&
        request.data.count >= 0 &&
        request.data.count <= GRASS_BLADE_GROUNDING_LIMITS.maxClumps,
      "Invalid coordinator clump count",
    );
    const attributes = [
      request.geometry.getAttribute("position"),
      request.geometry.getAttribute("normal"),
      request.geometry.getAttribute("uv"),
    ];
    const index = request.geometry.getIndex();
    ensure(
      index && attributes.every(Boolean),
      "Missing coordinator blade attributes",
    );
    // Projection can only discard clumps, so this is a pre-copy upper bound.
    const bytes =
      attributes.reduce(
        (sum, attribute) => sum + attribute.array.byteLength,
        0,
      ) +
      index.array.byteLength +
      request.data.count * (3 + 3 + 3 + 4 + 3) * 4;
    ensure(
      Number.isSafeInteger(bytes) && bytes <= payloadLimits.maximumInputBytes,
      "Grounding fitting payload exceeds reservation",
    );
    return bytes;
  }

  private captureSource(context: Context): () => boolean {
    const request = context.request,
      geometry = request.geometry,
      data = request.data;
    const uuid = geometry.uuid,
      ownSurface = request.ownSurface,
      count = data.count;
    const names = ["position", "normal", "uv"] as const;
    const attributes = names.map((name) => {
      const attribute = geometry.getAttribute(name);
      ensure(
        attribute && "version" in attribute,
        "Invalid coordinator blade attribute",
      );
      return {
        attribute,
        array: attribute.array,
        version: attribute.version,
        count: attribute.count,
        itemSize: attribute.itemSize,
        normalized: attribute.normalized,
      };
    });
    const index = geometry.getIndex();
    ensure(index, "Missing coordinator blade index");
    const indexArray = index.array,
      indexVersion = index.version,
      indexCount = index.count;
    const drawStart = geometry.drawRange.start,
      drawCount = geometry.drawRange.count;
    const fields = [
      "offsets",
      "rotScaleHash",
      "groundColors",
      "grassTints",
      "groundNormals",
    ] as const;
    const arrays = fields.map((key) => ({
      key,
      array: data[key],
      length: data[key].length,
    }));
    return () =>
      request.geometry === geometry &&
      geometry.uuid === uuid &&
      request.ownSurface === ownSurface &&
      request.data === data &&
      data.count === count &&
      attributes.every(
        (held, i) =>
          geometry.getAttribute(names[i]) === held.attribute &&
          held.attribute.array === held.array &&
          "version" in held.attribute &&
          held.attribute.version === held.version &&
          held.attribute.count === held.count &&
          held.attribute.itemSize === held.itemSize &&
          held.attribute.normalized === held.normalized,
      ) &&
      geometry.getIndex() === index &&
      index.array === indexArray &&
      index.version === indexVersion &&
      index.count === indexCount &&
      geometry.drawRange.start === drawStart &&
      geometry.drawRange.count === drawCount &&
      geometry.groups.length === 0 &&
      Object.keys(geometry.morphAttributes).length === 0 &&
      arrays.every(
        ({ key, array, length }) =>
          data[key] === array && array.length === length,
      );
  }

  private submit(
    context: Context | null,
    request: GrassGroundingClientRequest,
    owner: Owner | null = null,
    releases: Owner[] = [],
  ): void {
    ensure(
      !this.pending && !this.client.busy,
      "Grounding transport already owned",
    );
    ensure(
      request.type !== "start",
      "Coordinator requires explicit cached owners",
    );
    const started = performance.now();
    const id = this.client.submit(request);
    this.pending = {
      id,
      context,
      kind: request.type,
      owner,
      releases,
      seed: "consumed" in request ? { ...request.consumed } : zeroWork(),
      chargedDispatchMs: performance.now() - started,
    };
    if (request.type === "prepare_surface" && context?.admission)
      context.admission.submittedWork = Object.freeze({ ...request.consumed });
    if (context) context.phase = "waiting_worker";
  }

  private releaseOwners(owners: Owner[], context: Context | null): void {
    ensure(owners.length > 0, "Empty coordinator release");
    this.submit(
      context,
      {
        type: "release_surfaces",
        schemaVersion: 1,
        generation: context?.generation ?? this.generation,
        surfaceTokens: owners.map((owner) => owner.token),
      },
      null,
      owners,
    );
  }

  private plan(context: Context): void {
    const surfaces = context.surfaces;
    ensure(
      surfaces.length > 0 &&
        surfaces.length <= payloadLimits.maximumCachedSurfaces &&
        surfaces.includes(context.request.ownSurface) &&
        new Set(surfaces).size === surfaces.length &&
        surfaces.every(
          (surface) =>
            surface instanceof RetainedTerrainSurface &&
            surface.terrainProfileIdentity ===
              context.request.ownSurface.terrainProfileIdentity,
        ),
      "Invalid coordinator terrain region",
    );
    const unusable = [...this.cache.values()].filter((owner) => !owner.usable);
    if (unusable.length) {
      this.releaseOwners(unusable, context);
      return;
    }
    context.sourceCurrent ??= this.captureSource(context);
    const fitBytes = this.fitReservation(context.request);
    const planned: Owner[] = [];
    let requiredInput = fitBytes,
      requiredDerived = 0;
    for (const surface of surfaces) {
      const failed = this.failedOwners.get(surface);
      if (failed) {
        this.close(context, failed);
        return;
      }
      const cached = this.cache.get(surface);
      const layout = surface.snapshotLayout();
      const derivedBytes =
        layout.topologyOffsetCount > 0
          ? (Math.ceil(layout.indexCount / 24) + (layout.resolution - 1) ** 2) *
              96 +
            layout.topologyOffsetCount * 12 +
            (layout.resolution - 1) ** 2
          : 0;
      ensure(
        !cached ||
          (cached.usable &&
            cached.inputBytes === layout.payloadBytes &&
            cached.derivedBytes === derivedBytes),
        "Cached terrain owner is no longer usable",
      );
      planned.push(
        cached ?? {
          surface,
          token: 0,
          inputBytes: layout.payloadBytes,
          derivedBytes,
          used: 0,
          usable: true,
        },
      );
      requiredInput += layout.payloadBytes;
      requiredDerived += derivedBytes;
    }
    ensure(
      requiredInput <= payloadLimits.maximumInputBytes &&
        requiredDerived <= payloadLimits.maximumDerivedBytes,
      "Required grass region exceeds worker payload reservations",
    );
    const spare = [...this.cache.values()].filter(
      (owner) => !surfaces.includes(owner.surface),
    );
    // Invalid owners are retired first; then least-recently-used unpinned ones.
    spare.sort(
      (a, b) =>
        Number(a.usable && this.surfaceCurrent(a.surface)) -
          Number(b.usable && this.surfaceCurrent(b.surface)) || a.used - b.used,
    );
    let input =
      requiredInput + spare.reduce((sum, owner) => sum + owner.inputBytes, 0);
    let derived =
      requiredDerived +
      spare.reduce((sum, owner) => sum + owner.derivedBytes, 0);
    let owners = surfaces.length + spare.length;
    const releases: Owner[] = [];
    for (const owner of spare) {
      if (
        owner.usable &&
        this.surfaceCurrent(owner.surface) &&
        owners <= payloadLimits.maximumCachedSurfaces &&
        input <= payloadLimits.maximumInputBytes &&
        derived <= payloadLimits.maximumDerivedBytes
      )
        break;
      releases.push(owner);
      owners--;
      input -= owner.inputBytes;
      derived -= owner.derivedBytes;
    }
    if (releases.length) {
      this.releaseOwners(releases, context);
      return;
    }
    // Reservations are published only after acknowledged evictions, before a
    // single snapshot allocation. Missing owners are metadata, never a copy queue.
    context.owners = planned;
    context.fitBytes = fitBytes;
    context.planned = true;
    for (const owner of planned)
      if (this.cache.get(owner.surface) === owner) {
        this.cacheHits = addBounded(this.cacheHits, 1);
        owner.used = ++this.useSequence;
      }
  }

  private cacheStep(context: Context): void {
    context.lastPhase = "worker_cache_admission";
    context.lastSliceOperations++;
    if (!context.planned) this.plan(context);
    if (context.state.status !== "running" || this.pending || !context.planned)
      return;
    const owner = context.owners.find(
      (candidate) => this.cache.get(candidate.surface) !== candidate,
    );
    if (owner) {
      ensure(
        Number.isSafeInteger(this.nextToken),
        "Grounding owner token exhausted",
      );
      owner.token = this.nextToken++;
      context.admission = {
        owner,
        iterator: owner.surface.copySnapshotSteps(owner.inputBytes),
        snapshot: null,
        work: zeroWork(),
        submittedWork: null,
        response: null,
      };
      context.phase = "preparing";
    } else {
      context.handoff = new GrassGroundingPreparationContinuation(
        prepareGrassGroundingHandoffSteps(
          context.request,
          context.inputs,
          context.getWater,
          context.isExcluded,
          context.fitBytes,
        ),
        () => this.current(context),
        context.fit,
      );
      context.phase = "preparing";
    }
  }

  private copyStep(
    context: Context,
    maxOperations: number,
    deadline: number,
  ): void {
    const admission = context.admission!;
    const failure = budget(admission.work);
    if (failure) {
      this.failedOwners.set(admission.owner.surface, failure);
      this.close(context, failure);
      return;
    }
    const started = performance.now();
    while (admission.iterator && context.lastSliceOperations < maxOperations) {
      if (
        admission.work.operations + context.lastSliceOperations >=
        limits.maximumOperations
      )
        break;
      if (
        context.lastSliceOperations % limits.clockInterval === 0 &&
        (performance.now() >= deadline ||
          admission.work.activeMs + performance.now() - started >=
            limits.maximumActiveMs)
      )
        break;
      const step = admission.iterator.next();
      context.lastSliceOperations++;
      if (step.done) {
        admission.snapshot = step.value;
        admission.iterator = null;
        break;
      }
      context.lastPhase = step.value;
    }
    // Dispatch happens in a later slice, after copy work has been charged to
    // the same admission allowance passed to the worker.
  }

  private prepareStep(
    context: Context,
    maxOperations: number,
    deadline: number,
  ): void {
    const admission = context.admission;
    if (admission) {
      if (!admission.snapshot) {
        this.copyStep(context, maxOperations, deadline);
        return;
      }
      const failure = budget(admission.work);
      if (failure) {
        this.failedOwners.set(admission.owner.surface, failure);
        this.close(context, failure);
        return;
      }
      context.lastPhase = "worker_surface_dispatch";
      this.submit(
        context,
        {
          type: "prepare_surface",
          schemaVersion: 1,
          generation: context.generation,
          token: admission.owner.token,
          snapshot: admission.snapshot,
          consumed: { ...admission.work },
        },
        admission.owner,
      );
      admission.snapshot = null;
      context.lastSliceOperations++;
      return;
    }
    const handoff = context.handoff!;
    handoff.activeMs = context.fit.activeMs;
    handoff.operations = context.fit.operations;
    handoff.maximumSliceMs = context.fit.maximumSliceMs;
    const state = handoff.advance(maxOperations, deadline);
    context.lastSliceOperations = handoff.lastSliceOperations;
    context.lastPhase = handoff.lastPhase;
    if (state.status === "prepared") {
      context.prepared = state.prepared;
      context.handoff = null;
      // Keep the pre-copy upper reservation until submission; shrinking is safe.
      context.fitBytes = state.prepared.inputBytes;
    } else if (state.status !== "running") this.close(context, state);
  }

  private dispatchFit(context: Context): void {
    const prepared = context.prepared!;
    const failure = budget(context.fit);
    if (failure) {
      this.close(context, failure);
      return;
    }
    const own = context.owners.find(
      (owner) => owner.surface === prepared.ownSurface,
    );
    ensure(own, "Own grounding surface is not pinned");
    context.lastPhase = "worker_fit_dispatch";
    this.submit(context, {
      type: "start_cached",
      schemaVersion: 1,
      generation: context.generation,
      ownSurfaceToken: own.token,
      surfaceTokens: context.owners.map((owner) => owner.token),
      geometry: prepared.geometry,
      data: prepared.data,
      constraints: prepared.constraints,
      settings: prepared.settings,
      consumed: { ...context.fit },
    });
    context.lastSliceOperations++;
  }

  private mergeWork(
    work: GrassGroundingConsumedWork,
    remote: GrassGroundingConsumedWork,
    pending: Pending,
    settled: GrassGroundingClientSettled,
  ): void {
    work.operations =
      remote.operations + (work.operations - pending.seed.operations);
    // Main submit/cancel execution was measured in the advancing owner. Credit
    // that charge against the client's dispatch receipt; never double count it.
    work.activeMs =
      remote.activeMs +
      (work.activeMs - pending.seed.activeMs) +
      Math.max(0, settled.dispatchCpuMs - pending.chargedDispatchMs) +
      settled.receiveCpuMs;
    work.maximumSliceMs = Math.max(
      work.maximumSliceMs,
      remote.maximumSliceMs,
      settled.dispatchCpuMs,
      settled.receiveCpuMs,
    );
  }

  private settle(): boolean {
    const pending = this.pending;
    if (!pending) return false;
    const settled = this.client.takeSettled();
    if (!settled) return false;
    this.pending = null;
    const context = pending.context;
    if (pending.kind === "prepare_surface" && context?.admission) {
      const response = settled.status === "response" ? settled.response : null;
      const prepared = response?.type === "surface_prepared" ? response : null;
      context.admission.response = Object.freeze({
        status: prepared?.state.status ?? response?.type ?? settled.status,
        reason:
          prepared && "reason" in prepared.state
            ? prepared.state.reason.slice(0, 256)
            : response && "reason" in response
              ? response.reason.slice(0, 256)
              : settled.status === "failed_transport"
                ? settled.reason
                : null,
        phase: prepared?.lastPhase?.slice(0, 256) ?? null,
        work: prepared ? Object.freeze({ ...prepared.work }) : null,
        workBeforeMerge: Object.freeze({ ...context.admission.work }),
        jobId: settled.jobId,
        generation: settled.generation,
        dispatchCpuMs: settled.dispatchCpuMs,
        chargedDispatchMs: pending.chargedDispatchMs,
        postMessageCpuMs: settled.postMessageCpuMs,
        receiveCpuMs: settled.receiveCpuMs,
      });
    }
    if (settled.status === "failed_transport") {
      this.failTransport(context, new Error(settled.error));
      return true;
    }
    const response = settled.response;
    if (response.type === "rejected") {
      if (pending.kind === "release_surfaces")
        this.failTransport(
          context,
          new Error(response.error ?? response.reason),
        );
      else if (context) {
        const failure: GrassBladeGroundingJobState = {
          status: "failed_input",
          error: new Error(response.error ?? response.reason),
        };
        if (pending.owner)
          this.failedOwners.set(pending.owner.surface, failure);
        if (context.state.status === "running") this.close(context, failure);
        else this.releaseContext(context);
      }
      return true;
    }
    if (response.type === "surfaces_released") {
      for (const owner of pending.releases) {
        if (this.cache.get(owner.surface) === owner)
          this.cache.delete(owner.surface);
      }
      this.releasedOwners = addBounded(
        this.releasedOwners,
        pending.releases.length,
      );
      this.recordAdmission({
        operations: 0,
        activeMs:
          Math.max(0, settled.dispatchCpuMs - pending.chargedDispatchMs) +
          settled.receiveCpuMs,
        maximumSliceMs: Math.max(settled.dispatchCpuMs, settled.receiveCpuMs),
      });
      if (context?.state.status === "running") context.phase = "cache";
      else if (context) this.releaseContext(context);
      return true;
    }
    ensure(context, "Grounding response has no owner");
    if (response.type === "surface_prepared") {
      const admission = context.admission;
      ensure(
        admission && pending.owner === admission.owner,
        "Grounding preparation custody mismatch",
      );
      this.mergeWork(admission.work, response.work, pending, settled);
      const state = response.state;
      if (state.status === "prepared") {
        const owner = admission.owner;
        owner.used = ++this.useSequence;
        owner.usable = false;
        // Even cancellation can race a successful prepare. Track that real cache
        // owner until an explicit release acknowledgement, but never reuse it.
        this.cache.set(owner.surface, owner);
        owner.usable =
          context.state.status === "running" &&
          this.current(context) &&
          !budget(admission.work);
        this.preparedOwners = addBounded(this.preparedOwners, 1);
      }
      const failure = budget(admission.work);
      this.recordAdmission(admission.work);
      context.admission = null;
      if (context.state.status !== "running") {
        this.captureAdmissionFailure(context, admission);
        this.releaseContext(context);
        return true;
      }
      if (!this.current(context)) {
        this.cancelJob(context, "invalidated");
        return true;
      }
      if (failure || state.status !== "prepared") {
        const terminal = failure ?? state;
        ensure(terminal.status !== "prepared", "Invalid admission terminal");
        this.failedOwners.set(admission.owner.surface, terminal);
        this.close(context, terminal);
        this.captureAdmissionFailure(context, admission);
      } else context.phase = "cache";
      return true;
    }
    ensure(response.type === "result", "Invalid coordinator terminal response");
    // Scalars only on the success path. Materialize a detached diagnostic only
    // if this actual result settlement fails; never retain its geometry/result.
    const beforeOperations = context.fit.operations,
      beforeActiveMs = context.fit.activeMs,
      beforeMaximumSliceMs = context.fit.maximumSliceMs;
    this.mergeWork(context.fit, response.work, pending, settled);
    context.lastPhase = response.lastPhase;
    if (context.state.status !== "running") {
      this.releaseContext(context);
      return true;
    }
    if (!this.current(context)) {
      this.cancelJob(context, "invalidated");
      return true;
    }
    const state = response.state;
    if (
      state.status === "failed_budget" ||
      state.status === "failed_input" ||
      state.status === "cancelled"
    ) {
      this.close(context, state);
      this.captureFittingFailure(
        context,
        response,
        pending,
        settled,
        beforeOperations,
        beforeActiveMs,
        beforeMaximumSliceMs,
      );
      return true;
    }
    const failure = budget(context.fit);
    if (failure) {
      this.close(context, failure);
      this.captureFittingFailure(
        context,
        response,
        pending,
        settled,
        beforeOperations,
        beforeActiveMs,
        beforeMaximumSliceMs,
      );
      return true;
    }
    const prepared = context.prepared;
    ensure(prepared, "Missing main grounding provenance");
    context.publication = new GrassGroundingContinuation(
      finishGroundedGrassWorkerSteps(state.result, {
        ownSurface: prepared.ownSurface,
        surfaces: context.owners.map(({ token, surface }) => ({
          token,
          surface,
        })),
        grounding: prepared.grounding,
        lod: prepared.settings.lod,
        geometryLayout: prepared.settings.geometryLayout,
        roadClearance: prepared.settings.roadClearance,
      }),
      () => this.current(context),
      context.fit,
    );
    context.prepared = null;
    context.phase = "remapping";
    return true;
  }

  /** @internal */
  advanceJob(
    context: Context,
    maxOperations: number,
    sharedDeadlineMs?: number,
  ): GrassBladeGroundingJobState {
    validateSlice(maxOperations, sharedDeadlineMs);
    context.lastSliceOperations = 0;
    context.lastSliceMs = 0;
    if (context.state.status !== "running") return context.state;
    const started = performance.now();
    const deadline = Math.min(
      sharedDeadlineMs ?? Infinity,
      started + limits.targetSliceMs,
    );
    if (started >= deadline) return context.state;
    const admissionBefore = context.admission;
    const fitting =
      context.phase === "remapping" ||
      (context.phase === "preparing" && !context.admission) ||
      (context.phase === "waiting_worker" &&
        this.pending?.kind === "start_cached");
    let innerMs = 0;
    this.advancing = context;
    try {
      if (this.stopped || this.client.terminated) {
        this.failTransport(
          context,
          new Error(
            this.client.transportFailure?.error ??
              "Grounding worker is terminated",
          ),
        );
        return context.state;
      }
      if (!this.current(context)) return this.cancelJob(context, "invalidated");
      if (this.active && this.active !== context) return context.state;
      if (!this.active) {
        if (this.pending || this.client.busy) return context.state;
        this.active = context;
      }
      if (fitting) {
        const failure = budget(context.fit);
        if (failure) {
          this.close(context, failure);
          return context.state;
        }
      }
      if (context.phase === "cache") this.cacheStep(context);
      else if (context.phase === "waiting_worker") {
        if (this.settle()) context.lastSliceOperations++;
      } else if (context.phase === "preparing") {
        if (context.prepared && !context.admission) this.dispatchFit(context);
        else {
          const handoff = context.handoff;
          this.prepareStep(context, maxOperations, deadline);
          if (handoff) innerMs = handoff.lastSliceMs;
        }
      } else if (context.phase === "remapping") {
        const publication = context.publication!;
        publication.activeMs = context.fit.activeMs;
        publication.operations = context.fit.operations;
        publication.maximumSliceMs = context.fit.maximumSliceMs;
        const state = publication.advance(maxOperations, deadline);
        context.lastSliceOperations = publication.lastSliceOperations;
        context.lastPhase = publication.lastPhase;
        innerMs = publication.lastSliceMs;
        if (state.status !== "running") this.close(context, state);
      }
      if (context.state.status === "running" && !this.current(context))
        this.cancelJob(context, "invalidated");
    } catch (error) {
      if (context.admission)
        this.failedOwners.set(context.admission.owner.surface, {
          status: "failed_input",
          error,
        });
      this.cancelFlight(context);
      this.close(context, { status: "failed_input", error });
    } finally {
      const elapsed = performance.now() - started;
      context.lastSliceMs = elapsed;
      context.maximumSliceMs = Math.max(context.maximumSliceMs, elapsed);
      if (this.active === context || context.phase === "terminal") {
        if (fitting) {
          // Inner continuations are seeded from this ledger but never copied
          // back: one outer measurement includes their work and all supervision.
          context.fit.operations += context.lastSliceOperations;
          context.fit.activeMs += elapsed;
          context.fit.maximumSliceMs = Math.max(
            context.fit.maximumSliceMs,
            elapsed,
            innerMs,
          );
          const finalState = this.stateOf(context);
          if (
            finalState.status === "ready" ||
            finalState.status === "waiting_support"
          )
            finalState.result.receipt.elapsedMs = context.fit.activeMs;
          if (
            (finalState.status === "running" ||
              finalState.status === "ready") &&
            budget(context.fit)
          ) {
            const failure = budget(context.fit)!;
            this.cancelFlight(context);
            this.close(context, failure);
          }
        } else {
          const admission = context.admission ?? admissionBefore;
          if (admission) {
            admission.work.operations += context.lastSliceOperations;
            admission.work.activeMs += elapsed;
            admission.work.maximumSliceMs = Math.max(
              admission.work.maximumSliceMs,
              elapsed,
            );
            // A terminal admission may already have been recorded while settling.
            if (context.admission !== admission) {
              this.recordAdmission({
                operations: context.lastSliceOperations,
                activeMs: elapsed,
                maximumSliceMs: elapsed,
              });
              if (
                budget(admission.work) &&
                context.state.status === "running"
              ) {
                const failure = budget(admission.work)!;
                admission.owner.usable = false;
                this.failedOwners.set(admission.owner.surface, failure);
                this.close(context, failure);
              }
            } else if (
              budget(admission.work) &&
              context.state.status === "running"
            ) {
              const failure = budget(admission.work)!;
              this.failedOwners.set(admission.owner.surface, failure);
              this.cancelFlight(context);
              this.close(context, failure);
            }
            // Failure-only diagnostics are retained after the original ledger
            // includes this supervision tail. Cached failures have no admission
            // and must not replace the original owner with zero fitting work.
            this.captureAdmissionFailure(context, admission);
          } else
            this.recordAdmission({
              operations: context.lastSliceOperations,
              activeMs: elapsed,
              maximumSliceMs: elapsed,
            });
        }
      }
      this.advancing = null;
    }
    return context.state;
  }

  advanceMaintenance(
    maxOperations: number = limits.maximumSliceOperations,
    sharedDeadlineMs?: number,
  ): { operations: number; activeMs: number } {
    validateSlice(maxOperations, sharedDeadlineMs);
    const started = performance.now();
    const deadline = Math.min(
      sharedDeadlineMs ?? Infinity,
      started + limits.targetSliceMs,
    );
    let operations = 0;
    if (this.stopped || started >= deadline) return { operations, activeMs: 0 };
    try {
      if (this.client.terminated) {
        this.failTransport(
          this.active,
          new Error(
            this.client.transportFailure?.error ??
              "Grounding worker is terminated",
          ),
        );
        operations++;
      } else if (
        this.pending &&
        (!this.pending.context ||
          this.pending.context.state.status !== "running")
      ) {
        if (this.settle()) operations++;
      } else if (!this.active && !this.pending && !this.client.busy) {
        const stale = [...this.cache.values()].filter(
          (owner) => !owner.usable || !this.surfaceCurrent(owner.surface),
        );
        operations++;
        if (stale.length) this.releaseOwners(stale, null);
      }
    } catch (error) {
      this.failTransport(this.active, error);
    }
    const activeMs = performance.now() - started;
    // Cache housekeeping is measured admission work, not fitting allowance.
    this.recordAdmission({ operations, activeMs, maximumSliceMs: activeMs });
    return { operations, activeMs };
  }

  destroy(): void {
    this.stopped = true;
    const active = this.active;
    this.client.destroy();
    this.pending = null;
    this.cache.clear();
    if (active) {
      if (active.state.status === "running")
        this.close(active, { status: "cancelled", reason: "caller" });
      else this.releaseContext(active);
    }
  }
}
