import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect } from "vitest";
import {
  GRASS_GROUNDING_WORKER_LIMITS,
  grassGroundingWorkerInputTransfers,
  type GrassGroundingWorkerRequest,
  type GrassGroundingWorkerCachedRequest,
  type GrassGroundingWorkerPrepareSurface,
  type GrassGroundingWorkerResponse,
  type GrassGroundingWorkerResult,
} from "../../../../../utils/workers/GrassGroundingWorkerWire";
import type {
  GrassBladeGroundingRequest,
  GrassBladeGroundingResult,
} from "../../GrassBladeGrounding";

const entry = fileURLToPath(
  new URL(
    "../../../../../utils/workers/GrassGroundingWorker.entry.ts",
    import.meta.url,
  ),
);

export async function bundleGrassGroundingWorker() {
  const bundled = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
    keepNames: true,
  });
  expect(bundled.outputFiles).toHaveLength(1);
  return {
    source: bundled.outputFiles[0].text,
    inputs: Object.keys(bundled.metafile.inputs),
  };
}

/** Execute the actual browser bundle in an isolated worker realm. Only the
 * browser transport is adapted; MessageChannel is Node's real task scheduler. */
export class ActualGroundingWorker {
  private readonly worker: Worker;
  private readonly messages: unknown[] = [];
  private readonly pending: {
    matches: (message: unknown) => boolean;
    resolve: (message: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }[] = [];
  private failure: Error | null = null;

  constructor(source: string) {
    this.worker = new Worker(
      `const {parentPort, MessageChannel} = require("node:worker_threads");
globalThis.MessageChannel = MessageChannel;
globalThis.self = {postMessage: (message, transfers) => {
  parentPort.postMessage(message, transfers);
  if (transfers?.length) parentPort.postMessage({testResultTransfer: true, jobId: message.jobId,
    buffers: transfers.length, detached: transfers.every(buffer => buffer.byteLength === 0)});
}};
${source}
parentPort.on("message", data => self.onmessage({data}));
parentPort.postMessage({testTransportReady: true});`,
      { eval: true, env: {} },
    );
    this.worker.on("message", (message: unknown) => {
      const index = this.pending.findIndex((waiter) => waiter.matches(message));
      if (index >= 0) {
        const [waiter] = this.pending.splice(index, 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      } else {
        if (this.messages.length >= 4096) {
          this.fail(new Error("Actual grounding worker reply limit exceeded"));
          return;
        }
        this.messages.push(message);
      }
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      if (this.pending.length)
        this.fail(
          new Error(`Actual grounding worker exited with code ${code}`),
        );
    });
  }

  private fail(error: Error) {
    this.failure = error;
    for (const waiter of this.pending.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }

  take(matches: (message: unknown) => boolean): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const index = this.messages.findIndex(matches);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        matches,
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = this.pending.indexOf(waiter);
          if (index >= 0) this.pending.splice(index, 1);
          reject(new Error("Actual grounding worker reply timed out"));
        }, 10_000),
      };
      this.pending.push(waiter);
    });
  }

  async ready() {
    await this.take(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "testTransportReady" in message &&
        message.testTransportReady === true,
    );
  }

  send(message: unknown, transfers: ArrayBuffer[] = []) {
    this.worker.postMessage(message, transfers);
  }

  async close() {
    this.fail(new Error("Actual grounding worker closed"));
    await this.worker.terminate();
  }
}

export async function createActualGroundingWorker(source: string) {
  const worker = new ActualGroundingWorker(source);
  try {
    await worker.ready();
    return worker;
  } catch (error) {
    await worker.close();
    throw error;
  }
}

function drain<T>(steps: Generator<string, T, void>): T {
  for (let operations = 0; operations < 1_000_000; operations++) {
    const step = steps.next();
    if (step.done) return step.value;
  }
  steps.return(undefined as never);
  throw new Error("Actual terrain snapshot exceeded fixture operation bound");
}

export function createGrassGroundingWorkerRequest(
  request: GrassBladeGroundingRequest,
  jobId = 1,
  generation = 1,
): GrassGroundingWorkerRequest {
  const attribute = (name: string) => {
    const values = request.geometry.getAttribute(name).array;
    if (!(values instanceof Float32Array))
      throw new Error(`Unexpected real blade ${name} attribute`);
    return values.slice();
  };
  const index = request.geometry.getIndex()?.array;
  if (!(index instanceof Uint16Array || index instanceof Uint32Array))
    throw new Error("Unexpected real blade index attribute");
  const {
    lod,
    geometryLayout,
    roadClearance,
    bankVerge,
    oceanLevel,
    wind,
    maximumBaseError,
    workBudget,
  } = request;
  const surfaces = request.surfaces.map((surface, i) => ({
    token: i + 1,
    snapshot: drain(surface.copySnapshotSteps(surface.snapshotByteLength())),
  }));
  const ownIndex = request.surfaces.indexOf(request.ownSurface);
  if (ownIndex < 0) throw new Error("Fixture own surface is not in its region");
  return {
    type: "start",
    schemaVersion: 1,
    jobId,
    generation,
    ownSurfaceToken: ownIndex + 1,
    surfaces,
    geometry: {
      position: attribute("position"),
      normal: attribute("normal"),
      uv: attribute("uv"),
      index: index.slice(),
      drawCount: request.geometry.drawRange.count,
    },
    data: {
      count: request.data.count,
      offsets: request.data.offsets.slice(),
      rotScaleHash: request.data.rotScaleHash.slice(),
      groundColors: request.data.groundColors.slice(),
      grassTints: request.data.grassTints.slice(),
      groundNormals: request.data.groundNormals.slice(),
    },
    constraints: structuredClone({
      terrainSurface: request.terrainSurface,
      roadSegments: request.roadSegments,
    }),
    settings: structuredClone({
      lod,
      ...(geometryLayout === undefined ? {} : { geometryLayout }),
      ...(roadClearance === undefined ? {} : { roadClearance }),
      ...(bankVerge === undefined ? {} : { bankVerge }),
      oceanLevel,
      wind,
      ...(maximumBaseError === undefined ? {} : { maximumBaseError }),
      ...(workBudget === undefined ? {} : { workBudget }),
    }),
    consumed: { operations: 0, activeMs: 0, maximumSliceMs: 0 },
  };
}

export async function grassGroundingWorkerReply<
  K extends GrassGroundingWorkerResponse["type"],
>(
  worker: ActualGroundingWorker,
  type: K,
  jobId: number | null,
): Promise<Extract<GrassGroundingWorkerResponse, { type: K }>> {
  const message = await worker.take(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === type &&
      "jobId" in value &&
      value.jobId === jobId,
  );
  return message as Extract<GrassGroundingWorkerResponse, { type: K }>;
}

function bytes(array: ArrayBufferView) {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString(
    "hex",
  );
}

export function grassGroundingWorkerSemanticResult(
  result: GrassBladeGroundingResult | GrassGroundingWorkerResult,
  source: GrassBladeGroundingRequest,
) {
  return {
    keys: Object.keys(result).sort(),
    status: result.status,
    ...(result.status === "defer"
      ? { reason: result.reason }
      : {
          data: {
            count: result.data.count,
            offsets: bytes(result.data.offsets),
            rotScaleHash: bytes(result.data.rotScaleHash),
            groundColors: bytes(result.data.groundColors),
            grassTints: bytes(result.data.grassTints),
            groundNormals: bytes(result.data.groundNormals),
          },
          rootDeltas: bytes(result.rootDeltas),
          sourceIndices: bytes(result.sourceIndices),
          ...(result.bladeVisibility
            ? { bladeVisibility: bytes(result.bladeVisibility) }
            : {}),
          sweptBounds: result.sweptBounds,
        }),
    dependencies: result.dependencies.map((dependency) =>
      "token" in dependency
        ? dependency
        : {
            token: source.surfaces.indexOf(dependency.surface) + 1,
            sourceRevision: dependency.surface.revision,
            uses: dependency.uses,
          },
    ),
    receipt: Object.fromEntries(
      Object.entries(result.receipt).filter(([key]) => key !== "elapsedMs"),
    ),
  };
}

export async function runGrassGroundingWorker(
  worker: ActualGroundingWorker,
  request: GrassGroundingWorkerRequest | GrassGroundingWorkerCachedRequest,
) {
  const transfers = grassGroundingWorkerInputTransfers(request);
  const inputBytes = transfers.reduce(
    (total, buffer) => total + buffer.byteLength,
    0,
  );
  worker.send(request, transfers);
  expect(transfers.every((buffer) => buffer.byteLength === 0)).toBe(true);
  const accepted = await grassGroundingWorkerReply(
    worker,
    "accepted",
    request.jobId,
  );
  expect(accepted).toMatchObject({
    generation: request.generation,
    inputBytes,
  });
  expect(accepted.derivedBytesReserved).toBeLessThanOrEqual(
    GRASS_GROUNDING_WORKER_LIMITS.maximumDerivedBytes,
  );
  const result = await grassGroundingWorkerReply(
    worker,
    "result",
    request.jobId,
  );
  expect(result).toMatchObject({ generation: request.generation, inputBytes });
  expect(result.resultBytes).toBeLessThanOrEqual(
    GRASS_GROUNDING_WORKER_LIMITS.maximumResultBytes,
  );
  if (result.resultBytes > 0) {
    const transferred = await worker.take(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "testResultTransfer" in message &&
        message.testResultTransfer === true &&
        "jobId" in message &&
        message.jobId === request.jobId,
    );
    expect(transferred).toMatchObject({ detached: true, jobId: request.jobId });
  }
  return result;
}

/** Fresh-worker fixture protocol: each terrain admission is explicit and its
 * full work/byte receipt is returned. No fitting seed is spent or reset here.
 * The caller owns worker cleanup and cold capture/preparation/fitting wall time. */
export async function prepareCachedGrassGroundingWorkerRequest(
  worker: ActualGroundingWorker,
  coldPacket: GrassGroundingWorkerRequest,
) {
  expect(coldPacket.jobId).toBe(1);
  expect(coldPacket.surfaces.map(({ token }) => token)).toEqual(
    coldPacket.surfaces.map((_, index) => index + 1),
  );
  const admissions: Extract<
    GrassGroundingWorkerResponse,
    { type: "surface_prepared" }
  >[] = [];
  for (const [index, row] of coldPacket.surfaces.entries()) {
    const request: GrassGroundingWorkerPrepareSurface = {
      type: "prepare_surface",
      schemaVersion: 1,
      jobId: index + 1,
      generation: coldPacket.generation,
      token: row.token,
      snapshot: row.snapshot,
      consumed: { operations: 0, activeMs: 0, maximumSliceMs: 0 },
    };
    const sourceRevision = row.snapshot.revision;
    const transfers = grassGroundingWorkerInputTransfers(request);
    const inputBytes = transfers.reduce(
      (total, buffer) => total + buffer.byteLength,
      0,
    );
    worker.send(request, transfers);
    expect(transfers.every((buffer) => buffer.byteLength === 0)).toBe(true);
    const initial = await worker.take(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "jobId" in message &&
        message.jobId === request.jobId &&
        "type" in message &&
        (message.type === "accepted" || message.type === "rejected"),
    );
    if (
      !initial ||
      typeof initial !== "object" ||
      !("type" in initial) ||
      initial.type !== "accepted"
    )
      throw new Error(
        "Explicit surface preparation rejected: " + JSON.stringify(initial),
      );
    expect(initial).toMatchObject({
      generation: request.generation,
      inputBytes,
    });
    const admission = await grassGroundingWorkerReply(
      worker,
      "surface_prepared",
      request.jobId,
    );
    if (admission.state.status !== "prepared")
      throw new Error(
        "Explicit surface preparation failed: " + JSON.stringify(admission),
      );
    expect(admission.state).toEqual({
      status: "prepared",
      token: row.token,
      sourceRevision,
    });
    expect(admission.inputBytes).toBe(inputBytes);
    expect(admission.cache.owners).toBe(index + 1);
    expect(admission.cache.inputBytes).toBeLessThanOrEqual(
      GRASS_GROUNDING_WORKER_LIMITS.maximumInputBytes,
    );
    expect(admission.cache.derivedBytesReserved).toBeLessThanOrEqual(
      GRASS_GROUNDING_WORKER_LIMITS.maximumDerivedBytes,
    );
    admissions.push(admission);
  }
  const { type, surfaces, ...fit } = coldPacket;
  expect(type).toBe("start");
  const request: GrassGroundingWorkerCachedRequest = {
    ...fit,
    type: "start_cached",
    jobId: surfaces.length + 1,
    surfaceTokens: surfaces.map(({ token }) => token),
  };
  return { request, admissions };
}
