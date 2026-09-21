import {
  GRASS_BLADE_GROUNDING_JOB_LIMITS as jobLimits,
  validateGrassGroundingConsumedWork,
  type GrassGroundingConsumedWork,
} from "../../systems/shared/world/GrassBladeGrounding";
import { getGrassBladeLayout } from "../../systems/shared/world/GrassBladeLayout";
import {
  GRASS_GROUNDING_WORKER_LIMITS as limits,
  grassGroundingWorkerInputTransfers,
  type GrassGroundingWorkerRequest,
  type GrassGroundingWorkerCachedRequest,
  type GrassGroundingWorkerPrepareSurface,
  type GrassGroundingWorkerReleaseSurfaces,
  type GrassGroundingWorkerResponse,
  type GrassGroundingWorkerCacheReceipt,
} from "./GrassGroundingWorkerWire";

/** A supplied real browser Worker or a real-worker transport adapter. No factory,
 * URL, rendering state or fallback execution is owned by this supervisor. */
export type GrassGroundingWorkerPort = {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  addEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "error",
    listener: (event: ErrorEvent) => void,
  ): void;
  removeEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  terminate(): void;
};

type Request =
  | GrassGroundingWorkerRequest
  | GrassGroundingWorkerCachedRequest
  | GrassGroundingWorkerPrepareSurface
  | GrassGroundingWorkerReleaseSurfaces;
type WithoutId<T> = T extends Request ? Omit<T, "jobId"> : never;
export type GrassGroundingClientRequest = WithoutId<Request>;
type TerminalResponse = Exclude<
  GrassGroundingWorkerResponse,
  { type: "accepted" }
>;
export type GrassGroundingClientFailure = {
  reason: "protocol" | "post_message" | "error" | "messageerror" | "timeout";
  error: string;
};
type Outcome =
  | { status: "response"; response: TerminalResponse }
  | ({ status: "failed_transport" } & GrassGroundingClientFailure);
export type GrassGroundingClientSettled = Outcome & {
  jobId: number;
  generation: number;
  requestType: Request["type"];
  /** Preflight plus submit/cancel postMessage calls; not remote fitting time. */
  dispatchCpuMs: number;
  postMessageCpuMs: number;
  receiveCpuMs: number;
};

type Owner = {
  inputBytes: number;
  derivedBytesReserved: number;
  sourceRevision: string;
};
type Admission = {
  inputBytes: number;
  derivedBytesReserved: number;
  consumed: Readonly<GrassGroundingConsumedWork>;
  tokens: number[];
  dependencies: Map<number, string>;
  preparedOwner: Owner | null;
  inputClumps: number;
  bladesPerClump: number;
  perBladeRoads: boolean;
  geometryLayout: string | undefined;
};
type Slot = Admission & {
  jobId: number;
  generation: number;
  requestType: Request["type"];
  accepted: boolean;
  cancelled: boolean;
  settled: Outcome | null;
  dispatchCpuMs: number;
  postMessageCpuMs: number;
  receiveCpuMs: number;
  deadline: number;
};

const WATCHDOG_MS = 10_000;
const ZERO_WORK = Object.freeze({
  operations: 0,
  activeMs: 0,
  maximumSliceMs: 0,
});

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  ensure(
    value !== null &&
      typeof value === "object" &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    "Invalid grounding transport object",
  );
  const keys = Reflect.ownKeys(value);
  ensure(
    keys.length >= required.length &&
      keys.length <= required.length + optional.length &&
      keys.every(
        (key) =>
          typeof key === "string" &&
          (required.includes(key) || optional.includes(key)),
      ),
    "Invalid grounding transport fields",
  );
  for (const key of [...required, ...optional]) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property && optional.includes(key)) continue;
    ensure(
      property && "value" in property && property.enumerable,
      "Invalid grounding transport property",
    );
  }
  return value as Record<string, unknown>;
}
function integer(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
  minimum = 0,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function text(value: unknown, maximum = 1024): value is string {
  return typeof value === "string" && value.length <= maximum;
}
function list(value: unknown, maximum: number): unknown[] {
  ensure(
    Array.isArray(value) &&
      Object.getPrototypeOf(value) === Array.prototype &&
      value.length <= maximum,
    "Invalid grounding transport list",
  );
  ensure(
    Reflect.ownKeys(value).length === value.length + 1,
    "Invalid grounding transport list fields",
  );
  for (let i = 0; i < value.length; i++) {
    const property = Object.getOwnPropertyDescriptor(value, String(i));
    ensure(
      property && "value" in property && property.enumerable,
      "Invalid grounding transport list item",
    );
  }
  return value as unknown[];
}
function tokens(value: unknown, allowEmpty = false): number[] {
  const values = list(value, limits.maximumCachedSurfaces);
  ensure(allowEmpty || values.length > 0, "Empty grounding surface set");
  const result: number[] = [];
  for (const token of values) {
    ensure(
      integer(token, Number.MAX_SAFE_INTEGER, 1) && !result.includes(token),
      "Invalid grounding owner token",
    );
    result.push(token);
  }
  return result;
}
function view(
  value: unknown,
): asserts value is Float32Array | Uint16Array | Uint32Array {
  ensure(
    (value instanceof Float32Array ||
      value instanceof Uint16Array ||
      value instanceof Uint32Array) &&
      value.buffer instanceof ArrayBuffer &&
      value.byteOffset === 0 &&
      value.byteLength === value.buffer.byteLength,
    "Grounding transport requires complete owned views",
  );
}
function floats(value: unknown, length: number): Float32Array {
  view(value);
  ensure(
    value instanceof Float32Array && value.length === length,
    "Invalid grounding float buffer length",
  );
  return value;
}
function snapshot(value: unknown): Owner {
  const s = record(value, [
    "schemaVersion",
    "nodeId",
    "terrainProfileIdentity",
    "revision",
    "centerX",
    "centerZ",
    "size",
    "resolution",
    "positions",
    "indices",
    "topology",
    "positionVersion",
    "indexVersion",
    "positionCount",
    "indexCount",
    "payloadBytes",
  ]);
  ensure(
    s.schemaVersion === 1 &&
      integer(s.nodeId) &&
      integer(s.resolution, 256, 2) &&
      text(s.revision, 128) &&
      s.revision.length > 0 &&
      text(s.terrainProfileIdentity, 65536) &&
      s.terrainProfileIdentity.length > 0 &&
      integer(s.positionVersion) &&
      integer(s.indexVersion) &&
      integer(s.positionCount) &&
      integer(s.indexCount) &&
      integer(s.payloadBytes, limits.maximumInputBytes),
    "Invalid grounding surface header",
  );
  for (const key of ["centerX", "centerZ", "size"])
    ensure(
      typeof s[key] === "number" && Number.isFinite(s[key]),
      "Invalid grounding surface bounds",
    );
  ensure((s.size as number) > 0, "Invalid grounding surface size");
  const positions = floats(s.positions, s.positionCount * 3);
  view(s.indices);
  ensure(
    (s.indices instanceof Uint16Array || s.indices instanceof Uint32Array) &&
      s.indices.length === s.indexCount,
    "Invalid grounding surface indices",
  );
  let inputBytes = positions.byteLength + s.indices.byteLength,
    derivedBytesReserved = 0;
  if (s.topology !== null) {
    const t = record(s.topology, [
      "schemaVersion",
      "resolution",
      "surfaceVertexCount",
      "cellIndexOffsets",
    ]);
    ensure(
      t.schemaVersion === 1 &&
        t.resolution === s.resolution &&
        integer(t.surfaceVertexCount, 131072, s.resolution ** 2),
      "Invalid grounding topology header",
    );
    view(t.cellIndexOffsets);
    ensure(
      t.cellIndexOffsets instanceof Uint32Array &&
        t.cellIndexOffsets.length === (s.resolution - 1) ** 2 + 1,
      "Invalid grounding topology offsets",
    );
    inputBytes += t.cellIndexOffsets.byteLength;
    // Same conservative retained-index reservation as receiver admission,
    // including one qualification byte for every topology cell. This excludes
    // validation/fitting scratch and is not a complete JS/GPU heap cap.
    derivedBytesReserved =
      (Math.ceil(s.indices.length / 24) + (s.resolution - 1) ** 2) * 96 +
      t.cellIndexOffsets.length * 12 +
      (s.resolution - 1) ** 2;
  }
  ensure(
    inputBytes === s.payloadBytes,
    "Grounding surface byte receipt mismatch",
  );
  return { inputBytes, derivedBytesReserved, sourceRevision: s.revision };
}
function cacheTotals(
  owners: ReadonlyMap<number, Owner>,
): GrassGroundingWorkerCacheReceipt {
  let inputBytes = 0,
    derivedBytesReserved = 0;
  for (const owner of owners.values()) {
    inputBytes += owner.inputBytes;
    derivedBytesReserved += owner.derivedBytesReserved;
  }
  return { owners: owners.size, inputBytes, derivedBytesReserved };
}
function assertCache(
  value: unknown,
  expected: GrassGroundingWorkerCacheReceipt,
): void {
  const r = record(value, ["owners", "inputBytes", "derivedBytesReserved"]);
  ensure(
    r.owners === expected.owners &&
      r.inputBytes === expected.inputBytes &&
      r.derivedBytesReserved === expected.derivedBytesReserved,
    "Grounding cache receipt mismatch",
  );
}
function work(
  value: unknown,
  seed: Readonly<GrassGroundingConsumedWork>,
): GrassGroundingConsumedWork {
  const r = record(value, ["operations", "activeMs", "maximumSliceMs"]);
  ensure(
    integer(r.operations, jobLimits.maximumOperations, seed.operations) &&
      finite(r.activeMs) &&
      r.activeMs >= seed.activeMs &&
      finite(r.maximumSliceMs) &&
      r.maximumSliceMs >= seed.maximumSliceMs &&
      r.maximumSliceMs <= r.activeMs,
    "Invalid grounding cumulative work receipt",
  );
  // Terminal failures may retain real non-preemptible active-time overshoot.
  return {
    operations: r.operations,
    activeMs: r.activeMs,
    maximumSliceMs: r.maximumSliceMs,
  };
}
function boundedError(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 1024);
}

/** Single-flight transport only. Owner identity, terrain leases, scheduling and
 * numerical/visual qualification remain the caller's responsibility. */
export class GrassGroundingWorkerClient {
  private slot: Slot | null = null;
  private readonly owners = new Map<number, Owner>();
  private nextId = 1;
  private completedId = 0;
  private lastPreparedToken = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failure: Readonly<GrassGroundingClientFailure> | null = null;

  constructor(private readonly port: GrassGroundingWorkerPort) {
    try {
      port.addEventListener("message", this.onMessage);
      port.addEventListener("error", this.onError);
      port.addEventListener("messageerror", this.onMessageError);
    } catch (error) {
      this.teardown();
      throw error;
    }
  }

  get busy(): boolean {
    return this.slot !== null;
  }
  get terminated(): boolean {
    return this.stopped;
  }
  get cacheReceipt(): Readonly<GrassGroundingWorkerCacheReceipt> {
    return Object.freeze(cacheTotals(this.owners));
  }
  get transportFailure(): Readonly<GrassGroundingClientFailure> | null {
    return this.failure;
  }

  submit(request: GrassGroundingClientRequest): number {
    ensure(!this.stopped, "Grounding worker client is terminated");
    ensure(!this.slot, "Grounding worker client is busy");
    ensure(
      Number.isSafeInteger(this.nextId),
      "Grounding worker job ID exhausted",
    );
    const started = performance.now();
    const admitted = this.admit(request);
    const jobId = this.nextId++;
    const packet = { ...request, jobId } as Request;
    const transfers =
      packet.type === "release_surfaces"
        ? []
        : grassGroundingWorkerInputTransfers(packet);
    const slot: Slot = {
      ...admitted,
      jobId,
      generation: request.generation,
      requestType: request.type,
      accepted: false,
      cancelled: false,
      settled: null,
      dispatchCpuMs: 0,
      postMessageCpuMs: 0,
      receiveCpuMs: 0,
      deadline: performance.now() + WATCHDOG_MS,
    };
    this.slot = slot;
    this.timer = setTimeout(() => {
      if (this.slot === slot && !slot.settled)
        this.fail(
          "timeout",
          "Grounding worker exceeded 10-second transport deadline",
        );
    }, WATCHDOG_MS);
    const postStarted = performance.now();
    let failed = false,
      error: unknown;
    try {
      this.port.postMessage(packet, transfers);
    } catch (reason) {
      failed = true;
      error = reason;
    } finally {
      slot.postMessageCpuMs += performance.now() - postStarted;
      slot.dispatchCpuMs += performance.now() - started;
    }
    if (failed) this.fail("post_message", boundedError(error));
    return jobId;
  }

  cancel(): boolean {
    const slot = this.slot;
    if (
      this.stopped ||
      !slot ||
      slot.settled ||
      slot.cancelled ||
      slot.requestType === "release_surfaces"
    )
      return false;
    slot.cancelled = true;
    const started = performance.now();
    let failed = false,
      error: unknown;
    try {
      this.port.postMessage(
        {
          type: "cancel",
          schemaVersion: 1,
          jobId: slot.jobId,
          generation: slot.generation,
        },
        [],
      );
    } catch (reason) {
      failed = true;
      error = reason;
    } finally {
      const elapsed = performance.now() - started;
      slot.dispatchCpuMs += elapsed;
      slot.postMessageCpuMs += elapsed;
    }
    if (failed) this.fail("post_message", boundedError(error));
    return true;
  }

  takeSettled(): GrassGroundingClientSettled | null {
    const slot = this.slot;
    if (!slot?.settled) return null;
    this.slot = null;
    return {
      ...slot.settled,
      jobId: slot.jobId,
      generation: slot.generation,
      requestType: slot.requestType,
      dispatchCpuMs: slot.dispatchCpuMs,
      postMessageCpuMs: slot.postMessageCpuMs,
      receiveCpuMs: slot.receiveCpuMs,
    };
  }

  destroy(): void {
    this.teardown();
    this.slot = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private teardown(): void {
    this.clearTimer();
    if (this.stopped) return;
    this.stopped = true;
    // Remove every listener even if a broken transport rejects one operation.
    try {
      this.port.removeEventListener("message", this.onMessage);
    } catch {
      /* Continue teardown. */
    }
    try {
      this.port.removeEventListener("error", this.onError);
    } catch {
      /* Continue teardown. */
    }
    try {
      this.port.removeEventListener("messageerror", this.onMessageError);
    } catch {
      /* Continue teardown. */
    }
    try {
      this.port.terminate();
    } catch {
      /* Client remains permanently closed. */
    }
    this.owners.clear();
  }

  private fail(
    reason: GrassGroundingClientFailure["reason"],
    error: string,
  ): void {
    if (this.stopped) return;
    this.failure = Object.freeze({ reason, error: error.slice(0, 1024) });
    if (this.slot) {
      this.slot.settled = { status: "failed_transport", ...this.failure };
      this.completedId = this.slot.jobId;
    }
    this.teardown();
  }

  private readonly onError = (event: ErrorEvent): void => {
    this.fail(
      "error",
      text(event.message) ? event.message : "Grounding worker error",
    );
  };
  private readonly onMessageError = (): void => {
    this.fail("messageerror", "Grounding worker message could not be decoded");
  };

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    if (this.stopped) return;
    const started = performance.now();
    let charged: Slot | null = this.slot;
    try {
      const value = event.data;
      ensure(
        value !== null && typeof value === "object",
        "Invalid grounding response envelope",
      );
      const identity = Object.getOwnPropertyDescriptor(value, "jobId");
      ensure(
        identity &&
          "value" in identity &&
          integer(identity.value, Number.MAX_SAFE_INTEGER, 1),
        "Invalid grounding response identity",
      );
      if (identity.value <= this.completedId) {
        charged = null;
        return;
      }
      const slot = this.slot;
      ensure(
        slot && !slot.settled && identity.value === slot.jobId,
        "Unexpected future grounding response",
      );
      charged = slot;
      if (performance.now() >= slot.deadline) {
        this.fail(
          "timeout",
          "Grounding worker exceeded 10-second transport deadline",
        );
        return;
      }
      const response = this.validateResponse(value, slot);
      if (response.type === "accepted") {
        slot.accepted = true;
        if (slot.requestType === "prepare_surface")
          this.lastPreparedToken = slot.tokens[0];
        return;
      }
      this.clearTimer();
      this.completedId = slot.jobId;
      slot.settled = { status: "response", response };
    } catch (error) {
      this.fail("protocol", boundedError(error));
    } finally {
      if (charged) charged.receiveCpuMs += performance.now() - started;
    }
  };

  private admit(value: GrassGroundingClientRequest): Admission {
    const typeField = Object.getOwnPropertyDescriptor(value, "type");
    ensure(typeField && "value" in typeField, "Invalid grounding request type");
    const type = typeField.value;
    ensure(
      ["start", "start_cached", "prepare_surface", "release_surfaces"].includes(
        type,
      ),
      "Invalid grounding request type",
    );
    const r = record(
      value,
      type === "prepare_surface"
        ? [
            "type",
            "schemaVersion",
            "generation",
            "token",
            "snapshot",
            "consumed",
          ]
        : type === "release_surfaces"
          ? ["type", "schemaVersion", "generation", "surfaceTokens"]
          : [
              "type",
              "schemaVersion",
              "generation",
              "ownSurfaceToken",
              type === "start" ? "surfaces" : "surfaceTokens",
              "geometry",
              "data",
              "constraints",
              "settings",
              "consumed",
            ],
    );
    ensure(
      r.schemaVersion === 1 &&
        integer(r.generation, Number.MAX_SAFE_INTEGER, 1),
      "Invalid grounding request generation",
    );
    const admission: Admission = {
      inputBytes: 0,
      derivedBytesReserved: 0,
      consumed: ZERO_WORK,
      tokens: [],
      dependencies: new Map(),
      preparedOwner: null,
      inputClumps: 0,
      bladesPerClump: 0,
      perBladeRoads: false,
      geometryLayout: undefined,
    };
    if (type === "release_surfaces") {
      admission.tokens = tokens(r.surfaceTokens, true);
      for (const token of admission.tokens)
        ensure(
          this.owners.has(token),
          "Cannot release unknown grounding owner",
        );
      return admission;
    }
    admission.consumed = validateGrassGroundingConsumedWork(r.consumed);
    if (type === "prepare_surface") {
      ensure(
        integer(r.token, Number.MAX_SAFE_INTEGER, this.lastPreparedToken + 1) &&
          this.owners.size < limits.maximumCachedSurfaces,
        "Invalid or exhausted grounding preparation token",
      );
      admission.tokens = [r.token];
      admission.preparedOwner = snapshot(r.snapshot);
      admission.derivedBytesReserved =
        admission.preparedOwner.derivedBytesReserved;
    } else {
      if (type === "start") {
        for (const value of list(r.surfaces, limits.maximumCachedSurfaces)) {
          const row = record(value, ["token", "snapshot"]);
          ensure(
            integer(row.token, Number.MAX_SAFE_INTEGER, 1) &&
              !admission.dependencies.has(row.token),
            "Invalid grounding surface token",
          );
          const owner = snapshot(row.snapshot);
          admission.dependencies.set(row.token, owner.sourceRevision);
          admission.derivedBytesReserved += owner.derivedBytesReserved;
        }
        admission.tokens = [...admission.dependencies.keys()];
      } else {
        admission.tokens = tokens(r.surfaceTokens);
        for (const token of admission.tokens) {
          const owner = this.owners.get(token);
          ensure(owner, "Missing cached grounding owner");
          admission.dependencies.set(token, owner.sourceRevision);
        }
      }
      ensure(
        admission.tokens.length > 0 &&
          integer(r.ownSurfaceToken, Number.MAX_SAFE_INTEGER, 1) &&
          admission.tokens.includes(r.ownSurfaceToken),
        "Missing own grounding surface",
      );
      const settings = record(
        r.settings,
        ["lod", "oceanLevel", "wind"],
        [
          "geometryLayout",
          "roadClearance",
          "bankVerge",
          "maximumBaseError",
          "workBudget",
        ],
      );
      const layout = getGrassBladeLayout(
        settings.lod as number,
        settings.geometryLayout as GrassGroundingWorkerRequest["settings"]["geometryLayout"],
      );
      record(settings.wind, ["x", "z"]);
      admission.bladesPerClump = layout.bladesPerClump;
      admission.geometryLayout = settings.geometryLayout as string | undefined;
      admission.perBladeRoads = settings.roadClearance === "per-blade-v1";
      const geometry = record(r.geometry, [
        "position",
        "normal",
        "uv",
        "index",
        "drawCount",
      ]);
      floats(geometry.position, layout.verticesPerClump * 3);
      floats(geometry.normal, layout.verticesPerClump * 3);
      floats(geometry.uv, layout.verticesPerClump * 2);
      view(geometry.index);
      ensure(
        (geometry.index instanceof Uint16Array ||
          geometry.index instanceof Uint32Array) &&
          geometry.index.length === layout.trianglesPerClump * 3 &&
          (geometry.drawCount === Infinity ||
            geometry.drawCount === geometry.index.length),
        "Invalid grounding blade indices",
      );
      const data = record(r.data, [
        "count",
        "offsets",
        "rotScaleHash",
        "groundColors",
        "grassTints",
        "groundNormals",
      ]);
      ensure(integer(data.count, 4096), "Invalid grounding clump count");
      admission.inputClumps = data.count;
      for (const key of [
        "offsets",
        "rotScaleHash",
        "groundColors",
        "groundNormals",
      ])
        floats(data[key], data.count * 3);
      floats(data.grassTints, data.count * 4);
      const constraints = record(r.constraints, [
        "terrainSurface",
        "roadSegments",
      ]);
      list(constraints.roadSegments, 4096);
      const terrain = record(
        constraints.terrainSurface,
        [
          "schemaVersion",
          "zones",
          "arenaFloorIds",
          "arenaGradeHeight",
          "waterBodies",
        ],
        ["exclusionPolygons"],
      );
      list(terrain.zones, 512);
      list(terrain.arenaFloorIds, 512);
      list(terrain.waterBodies, 128);
      if (terrain.exclusionPolygons !== undefined)
        list(terrain.exclusionPolygons, 64);
    }
    const request = { ...value, jobId: this.nextId } as Exclude<
      Request,
      GrassGroundingWorkerReleaseSurfaces
    >;
    const transfers = grassGroundingWorkerInputTransfers(request);
    admission.inputBytes = transfers.reduce(
      (sum, buffer) => sum + buffer.byteLength,
      0,
    );
    const cache = cacheTotals(this.owners);
    ensure(
      admission.inputBytes + cache.inputBytes <= limits.maximumInputBytes &&
        admission.derivedBytesReserved + cache.derivedBytesReserved <=
          limits.maximumDerivedBytes,
      "Grounding aggregate reservation exceeded",
    );
    return admission;
  }

  private validateResponse(
    value: unknown,
    slot: Slot,
  ): GrassGroundingWorkerResponse {
    const type = Object.getOwnPropertyDescriptor(value, "type");
    ensure(type && "value" in type, "Missing grounding response type");
    const fields =
      type.value === "accepted"
        ? [
            "type",
            "jobId",
            "generation",
            "inputBytes",
            "derivedBytesReserved",
            "cache",
          ]
        : type.value === "rejected"
          ? ["type", "jobId", "generation", "reason"]
          : type.value === "result"
            ? [
                "type",
                "jobId",
                "generation",
                "state",
                "work",
                "lastPhase",
                "terrainRebuildWork",
                "inputBytes",
                "derivedBytesReserved",
                "resultBytes",
                "cache",
              ]
            : type.value === "surface_prepared"
              ? [
                  "type",
                  "jobId",
                  "generation",
                  "state",
                  "work",
                  "lastPhase",
                  "inputBytes",
                  "derivedBytesReserved",
                  "cache",
                ]
              : type.value === "surfaces_released"
                ? ["type", "jobId", "generation", "surfaceTokens", "cache"]
                : null;
    ensure(fields, "Unknown grounding response type");
    const r = record(value, fields, type.value === "rejected" ? ["error"] : []);
    ensure(
      r.jobId === slot.jobId && r.generation === slot.generation,
      "Grounding response generation mismatch",
    );
    const cache = cacheTotals(this.owners);
    if (r.type === "rejected") {
      ensure(
        !slot.accepted &&
          ["busy", "invalid_message", "stale"].includes(r.reason as string) &&
          (r.error === undefined || text(r.error)),
        "Unexpected grounding rejection",
      );
      return value as GrassGroundingWorkerResponse;
    }
    if (r.type === "surfaces_released") {
      ensure(
        slot.requestType === "release_surfaces" && !slot.accepted,
        "Unexpected grounding release acknowledgement",
      );
      const released = tokens(r.surfaceTokens, true);
      ensure(
        released.length === slot.tokens.length &&
          released.every((token, i) => token === slot.tokens[i]),
        "Grounding release token mismatch",
      );
      const next = new Map(this.owners);
      for (const token of released) next.delete(token);
      assertCache(r.cache, cacheTotals(next));
      for (const token of released) this.owners.delete(token);
      return value as GrassGroundingWorkerResponse;
    }
    ensure(
      slot.requestType !== "release_surfaces",
      "Unexpected grounding release response",
    );
    ensure(
      r.inputBytes === slot.inputBytes &&
        r.derivedBytesReserved === slot.derivedBytesReserved,
      "Grounding operation byte receipt mismatch",
    );
    if (r.type === "accepted") {
      ensure(!slot.accepted, "Duplicate grounding acceptance");
      assertCache(r.cache, cache);
      return value as GrassGroundingWorkerResponse;
    }
    ensure(
      slot.accepted &&
        (slot.requestType === "prepare_surface") ===
          (r.type === "surface_prepared"),
      "Unexpected grounding terminal transition",
    );
    const consumed = work(r.work, slot.consumed);
    ensure(
      r.lastPhase === null || text(r.lastPhase, 128),
      "Invalid grounding phase receipt",
    );
    const stateType = Object.getOwnPropertyDescriptor(r.state, "status");
    ensure(
      stateType && "value" in stateType,
      "Invalid grounding terminal state",
    );
    const status: unknown = stateType.value;
    if (status === "prepared") {
      const state = record(r.state, ["status", "token", "sourceRevision"]);
      ensure(
        r.type === "surface_prepared" &&
          slot.preparedOwner &&
          state.token === slot.tokens[0] &&
          state.sourceRevision === slot.preparedOwner.sourceRevision &&
          consumed.activeMs < jobLimits.maximumActiveMs,
        "Invalid grounding prepared owner",
      );
      const next = new Map(this.owners);
      next.set(slot.tokens[0], slot.preparedOwner);
      assertCache(r.cache, cacheTotals(next));
      this.owners.set(slot.tokens[0], slot.preparedOwner);
    } else {
      assertCache(r.cache, cache);
      if (status === "ready" || status === "waiting_support") {
        const state = record(r.state, ["status", "result"]);
        ensure(
          r.type === "result" &&
            (status !== "ready" ||
              consumed.activeMs < jobLimits.maximumActiveMs),
          "Invalid grounding result state",
        );
        this.validateResult(
          state.result,
          status,
          slot,
          r.resultBytes,
          consumed.activeMs,
        );
      } else if (status === "failed_budget") {
        const state = record(r.state, ["status", "reason"]);
        ensure(
          [
            "operations",
            "active_cpu",
            ...(r.type === "result" ? ["grounding_work"] : []),
          ].includes(state.reason as string),
          "Invalid grounding budget failure",
        );
      } else if (status === "failed_input") {
        const state = record(r.state, ["status", "error"]);
        ensure(text(state.error), "Invalid grounding failure text");
      } else if (status === "cancelled") {
        const state = record(r.state, ["status", "reason"]);
        ensure(
          ["caller", "invalidated"].includes(state.reason as string),
          "Invalid grounding cancellation",
        );
      } else throw new Error("Unknown grounding terminal status");
    }
    if (r.type === "result") {
      ensure(
        integer(r.resultBytes, limits.maximumResultBytes),
        "Invalid grounding result bytes",
      );
      if (status !== "ready")
        ensure(r.resultBytes === 0, "Unexpected grounding failure buffers");
      if (r.terrainRebuildWork !== null) {
        ensure(
          slot.requestType === "start",
          "Cached grounding unexpectedly rebuilt terrain",
        );
        const rebuilt = work(r.terrainRebuildWork, slot.consumed);
        ensure(
          rebuilt.operations <= consumed.operations,
          "Invalid grounding rebuild work receipt",
        );
      }
    }
    return value as GrassGroundingWorkerResponse;
  }

  private validateResult(
    value: unknown,
    status: "ready" | "waiting_support",
    slot: Slot,
    resultBytes: unknown,
    activeMs: number,
  ): void {
    const result = record(
      value,
      status === "ready"
        ? [
            "status",
            "data",
            "rootDeltas",
            "sourceIndices",
            "sweptBounds",
            "dependencies",
            "receipt",
          ]
        : ["status", "reason", "dependencies", "receipt"],
      status === "ready" ? ["bladeVisibility"] : [],
    );
    ensure(
      result.status === (status === "ready" ? "ready" : "defer"),
      "Grounding result status mismatch",
    );
    const seen = new Set<number>();
    for (const item of list(
      result.dependencies,
      limits.maximumCachedSurfaces,
    )) {
      const dependency = record(item, ["token", "sourceRevision", "uses"]);
      ensure(
        integer(dependency.token, Number.MAX_SAFE_INTEGER, 1) &&
          !seen.has(dependency.token) &&
          slot.dependencies.get(dependency.token) === dependency.sourceRevision,
        "Foreign grounding result dependency",
      );
      seen.add(dependency.token);
      const uses = list(dependency.uses, 3);
      ensure(
        uses.length > 0 &&
          new Set(uses).size === uses.length &&
          uses.every((use) =>
            ["endpoint", "edge", "envelope"].includes(use as string),
          ),
        "Invalid grounding dependency usage",
      );
    }
    const receipt = record(
      result.receipt,
      [
        "elapsedMs",
        "inputClumps",
        "processedClumps",
        "retainedClumps",
        "bladesPerClump",
        "endpointQueries",
        "triangleVisits",
        "sameFaceEdges",
        "workUnits",
        "workBudget",
        "correctionBytes",
        "maxEndpointCorrection",
        "maxCorrectedBaseError",
        "maxAcceptedBaseError",
        "rejected",
      ],
      ["geometryLayout", "roadClearance"],
    );
    for (const key of [
      "elapsedMs",
      "inputClumps",
      "processedClumps",
      "retainedClumps",
      "bladesPerClump",
      "endpointQueries",
      "triangleVisits",
      "sameFaceEdges",
      "workUnits",
      "workBudget",
      "correctionBytes",
      "maxEndpointCorrection",
      "maxCorrectedBaseError",
      "maxAcceptedBaseError",
    ])
      ensure(finite(receipt[key]), "Invalid grounding result metric");
    ensure(
      receipt.inputClumps === slot.inputClumps &&
        receipt.bladesPerClump === slot.bladesPerClump &&
        receipt.geometryLayout === slot.geometryLayout &&
        receipt.elapsedMs === activeMs,
      "Grounding result input mismatch",
    );
    for (const key of ["processedClumps", "retainedClumps"])
      ensure(
        integer(receipt[key], slot.inputClumps),
        "Invalid grounding result clump metric",
      );
    ensure(
      integer(receipt.workBudget, jobLimits.maximumOperations, 1) &&
        integer(receipt.workUnits, receipt.workBudget),
      "Invalid grounding geometric-work receipt",
    );
    if (slot.perBladeRoads) {
      const roads = record(receipt.roadClearance, [
        "mode",
        "retainedBlades",
        "partialClumps",
        "maskedRetainedBlades",
        "visibilityBytes",
      ]);
      ensure(
        roads.mode === "per-blade-v1" &&
          integer(roads.partialClumps, slot.inputClumps) &&
          integer(
            roads.retainedBlades,
            slot.inputClumps * slot.bladesPerClump,
          ) &&
          integer(
            roads.maskedRetainedBlades,
            slot.inputClumps * slot.bladesPerClump,
          ) &&
          integer(roads.visibilityBytes, slot.inputClumps * 4),
        "Invalid grounding road-clearance receipt",
      );
    } else
      ensure(
        receipt.roadClearance === undefined,
        "Unexpected grounding road-clearance receipt",
      );
    const rejected = record(receipt.rejected, [
      "terrain_edge",
      "pad",
      "road",
      "water",
    ]);
    for (const count of Object.values(rejected))
      ensure(
        integer(count, slot.inputClumps),
        "Invalid grounding rejection count",
      );
    if (status !== "ready") {
      ensure(
        ["missing_surface", "overlapping_surface"].includes(
          result.reason as string,
        ),
        "Invalid deferred grounding reason",
      );
      return;
    }
    const data = record(result.data, [
      "count",
      "offsets",
      "rotScaleHash",
      "groundColors",
      "grassTints",
      "groundNormals",
    ]);
    ensure(
      integer(data.count, slot.inputClumps) &&
        receipt.retainedClumps === data.count,
      "Invalid grounding result count",
    );
    const arrays: Array<Float32Array | Uint32Array> = [];
    for (const key of [
      "offsets",
      "rotScaleHash",
      "groundColors",
      "groundNormals",
    ])
      arrays.push(floats(data[key], data.count * 3));
    arrays.push(
      floats(data.grassTints, data.count * 4),
      floats(result.rootDeltas, data.count * slot.bladesPerClump * 2),
    );
    ensure(
      receipt.correctionBytes ===
        (result.rootDeltas as Float32Array).byteLength,
      "Invalid grounding correction bytes",
    );
    view(result.sourceIndices);
    ensure(
      result.sourceIndices instanceof Uint32Array &&
        result.sourceIndices.length === data.count,
      "Invalid grounding source indices",
    );
    arrays.push(result.sourceIndices);
    if (slot.perBladeRoads) {
      view(result.bladeVisibility);
      ensure(
        result.bladeVisibility instanceof Uint32Array &&
          result.bladeVisibility.length === data.count,
        "Invalid grounding blade visibility",
      );
      arrays.push(result.bladeVisibility);
    } else
      ensure(
        result.bladeVisibility === undefined,
        "Unexpected grounding visibility buffer",
      );
    const buffers = arrays.map((array) => array.buffer);
    ensure(
      new Set(buffers).size === buffers.length &&
        buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0) ===
          resultBytes,
      "Grounding result buffer receipt mismatch",
    );
    if (data.count === 0)
      ensure(
        result.sweptBounds === null,
        "Nonempty bounds for empty grounding",
      );
    else {
      const bounds = record(result.sweptBounds, [
        "minX",
        "maxX",
        "minZ",
        "maxZ",
        "minY",
        "maxY",
      ]);
      for (const coordinate of Object.values(bounds))
        ensure(
          typeof coordinate === "number" && Number.isFinite(coordinate),
          "Invalid grounding swept bounds",
        );
      for (const axis of ["X", "Y", "Z"])
        ensure(
          (bounds[`min${axis}`] as number) <= (bounds[`max${axis}`] as number),
          "Inverted grounding swept bounds",
        );
    }
  }
}
