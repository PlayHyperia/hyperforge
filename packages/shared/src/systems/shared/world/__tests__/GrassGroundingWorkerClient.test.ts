import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BufferAttribute } from "three/src/core/BufferAttribute.js";
import {
  GrassGroundingWorkerClient,
  type GrassGroundingClientRequest,
} from "../../../../utils/workers/GrassGroundingWorkerClient";
import {
  grassGroundingWorkerInputTransfers,
  type GrassGroundingWorkerRequest,
  type GrassGroundingWorkerCachedRequest,
  type GrassGroundingWorkerPrepareSurface,
  type GrassGroundingWorkerResponse,
} from "../../../../utils/workers/GrassGroundingWorkerWire";
import {
  groundGrassBlades,
  GRASS_BLADE_GROUNDING_LIMITS,
  GRASS_BLADE_GROUNDING_JOB_LIMITS,
} from "../GrassBladeGrounding";
import { RetainedTerrainSurface } from "../TerrainGridSurface";
import { gridGeometry } from "./terrain-grid.fixture";
import {
  createSameFaceCase,
  sameFaceInputHash,
  type SameFaceCase,
} from "./fixtures/GrassBladeGroundingSameFaceCases";
import {
  bundleGrassGroundingWorker,
  createGrassGroundingWorkerRequest as workerRequest,
  grassGroundingWorkerSemanticResult as semanticResult,
} from "./fixtures/GrassGroundingWorkerHarness";
import { ActualGrassGroundingClientPort } from "./fixtures/ActualGrassGroundingClientPort";

let bundledSource = "";
const sessions: {
  client: GrassGroundingWorkerClient;
  port: ActualGrassGroundingClientPort;
}[] = [];

async function actualClient() {
  const port = new ActualGrassGroundingClientPort(bundledSource);
  const client = new GrassGroundingWorkerClient(port);
  sessions.push({ client, port });
  await port.ready();
  return { client, port };
}

function withoutId<T extends { jobId: number }>(packet: T): Omit<T, "jobId"> {
  const { jobId, ...request } = packet;
  expect(jobId).toBeGreaterThan(0);
  return request;
}

function cachedPacket(
  cold: GrassGroundingWorkerRequest,
  generation = cold.generation,
): Omit<GrassGroundingWorkerCachedRequest, "jobId"> {
  const { type, surfaces, ...request } = withoutId(cold);
  expect(type).toBe("start");
  return {
    ...request,
    type: "start_cached",
    generation,
    surfaceTokens: surfaces.map(({ token }) => token),
  };
}

function preparation(
  cold: GrassGroundingWorkerRequest,
  index = 0,
): Omit<GrassGroundingWorkerPrepareSurface, "jobId"> {
  const { token, snapshot } = cold.surfaces[index];
  return {
    type: "prepare_surface",
    schemaVersion: 1,
    generation: cold.generation,
    token,
    snapshot,
    consumed: { operations: 0, activeMs: 0, maximumSliceMs: 0 },
  };
}

function takeResponse(client: GrassGroundingWorkerClient) {
  const settled = client.takeSettled();
  expect(settled?.status, JSON.stringify(settled)).toBe("response");
  if (!settled || settled.status !== "response")
    throw new Error(`Actual client failed: ${JSON.stringify(settled)}`);
  expect(settled.dispatchCpuMs).toBeGreaterThanOrEqual(
    settled.postMessageCpuMs,
  );
  expect(settled.postMessageCpuMs).toBeGreaterThanOrEqual(0);
  expect(settled.receiveCpuMs).toBeGreaterThanOrEqual(0);
  expect(client.busy).toBe(false);
  expect(client.takeSettled()).toBeNull();
  return settled;
}

async function settledResponse<K extends GrassGroundingWorkerResponse["type"]>(
  client: GrassGroundingWorkerClient,
  port: ActualGrassGroundingClientPort,
  type: K,
  jobId: number,
) {
  const reply = await port.waitFor(type, jobId);
  expect(client.busy).toBe(true);
  const settled = takeResponse(client);
  expect(settled.jobId).toBe(jobId);
  expect(settled.generation).toBe(reply.generation);
  expect(settled.response).toBe(reply);
  return reply;
}

function maximumClumpPacket(packet: GrassGroundingWorkerRequest) {
  const count = GRASS_BLADE_GROUNDING_LIMITS.maxClumps;
  for (const [key, stride] of [
    ["offsets", 3],
    ["rotScaleHash", 3],
    ["groundColors", 3],
    ["grassTints", 4],
    ["groundNormals", 3],
  ] as const) {
    const source = packet.data[key],
      output = new Float32Array(count * stride);
    for (let i = 0; i < count; i++) {
      const start = (i % packet.data.count) * stride;
      output.set(source.subarray(start, start + stride), i * stride);
    }
    packet.data[key] = output;
  }
  packet.data.count = count;
  return packet;
}

/** Real fan topology requires more than 8192 admission resumptions, so a
 * queued cancellation can be observed without replacing clocks or schedulers. */
function cancellablePreparation() {
  const resolution = 48,
    geometry = gridGeometry(100, resolution, () => 20);
  const positions = Array.from(geometry.getAttribute("position").array),
    indices: number[] = [],
    offsets = [0];
  for (let z = 0; z < resolution - 1; z++)
    for (let x = 0; x < resolution - 1; x++) {
      const a = z * resolution + x,
        center = positions.length / 3;
      positions.push(
        (positions[a * 3] + positions[(a + 1) * 3]) / 2,
        20,
        (positions[a * 3 + 2] + positions[(a + resolution) * 3 + 2]) / 2,
      );
      const boundary = [a, a + resolution, a + resolution + 1, a + 1];
      for (let side = 0; side < 4; side++)
        indices.push(center, boundary[side], boundary[(side + 1) % 4]);
      offsets.push(indices.length);
    }
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(positions), 3),
  );
  geometry.setIndex(indices);
  geometry.userData.terrainCellTopology = Object.freeze({
    schemaVersion: 1,
    resolution,
    surfaceVertexCount: positions.length / 3,
    cellIndexOffsets: Object.freeze(offsets),
  });
  const surface = new RetainedTerrainSurface(
    101,
    "actual-client-cancellation-v1",
    0,
    0,
    100,
    resolution,
    geometry,
  );
  const steps = surface.copySnapshotSteps(surface.snapshotByteLength());
  for (let i = 0; i < 10000; i++) {
    const step = steps.next();
    if (step.done)
      return {
        geometry,
        surface,
        request: {
          type: "prepare_surface",
          schemaVersion: 1,
          generation: 9,
          token: 1,
          snapshot: step.value,
          consumed: { operations: 0, activeMs: 0, maximumSliceMs: 0 },
        } satisfies GrassGroundingClientRequest,
      };
  }
  steps.return(undefined as never);
  geometry.dispose();
  throw new Error("Actual cancellation surface snapshot exceeded bound");
}

beforeAll(async () => {
  bundledSource = (await bundleGrassGroundingWorker()).source;
});
afterEach(async () => {
  for (const { client, port } of sessions.splice(0)) {
    client.destroy();
    await port.close();
  }
});

describe("actual grounding worker client", () => {
  it.each<SameFaceCase>([
    "ordinary-lod0",
    "fine-near4",
    "refined-interiors",
    "adjacent-reversed",
    "missing-neighbor",
    "overlapping-owners",
    "mixed-exclusions",
    "empty",
  ])(
    "transfers owned cold %s input and preserves every output byte and dependency",
    async (id) => {
      const fixture = createSameFaceCase(id);
      try {
        const original = sameFaceInputHash(fixture),
          expected = groundGrassBlades(fixture.request);
        const { client, port } = await actualClient(),
          packet = workerRequest(fixture.request, 1, 7);
        const transfers = grassGroundingWorkerInputTransfers(packet);
        expect(client.busy).toBe(false);
        expect(client.takeSettled()).toBeNull();
        expect(client.cancel()).toBe(false);
        expect(client.submit(withoutId(packet))).toBe(1);
        expect(client.busy).toBe(true);
        expect(client.takeSettled()).toBeNull();
        expect(transfers.every((buffer) => buffer.byteLength === 0)).toBe(true);
        const result = await settledResponse(client, port, "result", 1);
        if (
          result.state.status !== "ready" &&
          result.state.status !== "waiting_support"
        )
          throw new Error(`Unexpected real result: ${JSON.stringify(result)}`);
        expect(semanticResult(result.state.result, fixture.request)).toEqual(
          semanticResult(expected, fixture.request),
        );
        expect(result.state.result.receipt.refinedSameFaceEdges).toBe(
          expected.receipt.refinedSameFaceEdges,
        );
        expect(
          Number.isSafeInteger(
            result.state.result.receipt.refinedSameFaceEdges,
          ),
        ).toBe(true);
        expect(
          result.state.result.receipt.refinedSameFaceEdges,
        ).toBeGreaterThanOrEqual(0);
        expect(
          result.state.result.receipt.refinedSameFaceEdges,
        ).toBeLessThanOrEqual(result.state.result.receipt.sameFaceEdges);
        expect(client.terminated).toBe(false);
        expect(client.transportFailure).toBeNull();
        expect(client.cacheReceipt).toEqual({
          owners: 0,
          inputBytes: 0,
          derivedBytesReserved: 0,
        });
        expect(sameFaceInputHash(fixture)).toBe(original);
        for (const { surface, geometry } of fixture.owned)
          expect(surface.matchesGeometry(geometry)).toBe(true);
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each<SameFaceCase>([
    "ordinary-lod1",
    "fine-near4",
    "adjacent-reversed",
    "mixed-exclusions",
  ])(
    "prepares, repeatedly fits and releases actual %s owners with exact cache receipts",
    async (id) => {
      const fixture = createSameFaceCase(id);
      try {
        const original = sameFaceInputHash(fixture),
          expected = groundGrassBlades(fixture.request);
        const { client, port } = await actualClient(),
          cold = workerRequest(fixture.request, 1, 11);
        let nextId = 1,
          payloadBytes = 0;
        for (let index = 0; index < cold.surfaces.length; index++) {
          const request = preparation(cold, index),
            bytes = request.snapshot.payloadBytes;
          const buffers = grassGroundingWorkerInputTransfers({
            ...request,
            jobId: nextId,
          });
          const jobId = client.submit(request);
          expect(jobId).toBe(nextId++);
          expect(buffers.every((buffer) => buffer.byteLength === 0)).toBe(true);
          const prepared = await settledResponse(
            client,
            port,
            "surface_prepared",
            jobId,
          );
          expect(prepared.state).toMatchObject({
            status: "prepared",
            token: request.token,
          });
          payloadBytes += bytes;
          expect(client.cacheReceipt).toEqual(prepared.cache);
          expect(client.cacheReceipt.owners).toBe(index + 1);
          expect(client.cacheReceipt.inputBytes).toBe(payloadBytes);
          expect(Object.isFrozen(client.cacheReceipt)).toBe(true);
        }
        const stableCache = client.cacheReceipt;
        for (const generation of [11, 12]) {
          const jobId = client.submit(
            cachedPacket(workerRequest(fixture.request), generation),
          );
          expect(jobId).toBe(nextId++);
          const result = await settledResponse(client, port, "result", jobId);
          expect(result.generation).toBe(generation);
          expect(result.terrainRebuildWork).toBeNull();
          expect(client.cacheReceipt).toEqual(stableCache);
          if (result.state.status !== "ready")
            throw new Error(`Cached fitting failed: ${JSON.stringify(result)}`);
          expect(semanticResult(result.state.result, fixture.request)).toEqual(
            semanticResult(expected, fixture.request),
          );
        }
        const releaseId = client.submit({
          type: "release_surfaces",
          schemaVersion: 1,
          generation: 13,
          surfaceTokens: cold.surfaces.map(({ token }) => token).reverse(),
        });
        expect(releaseId).toBe(nextId++);
        expect(client.cancel()).toBe(false);
        await settledResponse(client, port, "surfaces_released", releaseId);
        expect(client.cacheReceipt).toEqual({
          owners: 0,
          inputBytes: 0,
          derivedBytesReserved: 0,
        });
        expect(stableCache.owners).toBe(cold.surfaces.length);
        const emptyRelease = client.submit({
          type: "release_surfaces",
          schemaVersion: 1,
          generation: 14,
          surfaceTokens: [],
        });
        expect(emptyRelease).toBe(nextId);
        await settledResponse(client, port, "surfaces_released", emptyRelease);
        expect(sameFaceInputHash(fixture)).toBe(original);
      } finally {
        fixture.dispose();
      }
    },
  );

  it("holds the only slot before acknowledgement and while a real terminal result is parked", async () => {
    const fixture = createSameFaceCase("fine-dense-nonplanar");
    try {
      const { client, port } = await actualClient();
      const first = maximumClumpPacket(workerRequest(fixture.request, 1, 31));
      expect(client.submit(withoutId(first))).toBe(1);
      expect(client.cancel()).toBe(true);
      expect(client.cancel()).toBe(false);
      expect(client.busy).toBe(true);
      expect(client.takeSettled()).toBeNull();
      const next = workerRequest(fixture.request, 2, 32),
        buffers = grassGroundingWorkerInputTransfers(next);
      const postCalls = port.postCalls;
      expect(() => client.submit(withoutId(next))).toThrow(/busy/);
      expect(port.postCalls).toBe(postCalls);
      expect(buffers.every((buffer) => buffer.byteLength > 0)).toBe(true);
      const cancelled = await port.waitFor("result", 1);
      expect(cancelled.state).toEqual({
        status: "cancelled",
        reason: "caller",
      });
      expect(client.busy).toBe(true);
      expect(() => client.submit(withoutId(next))).toThrow(/busy/);
      expect(client.cancel()).toBe(false);
      expect(takeResponse(client).response).toBe(cancelled);
      expect(client.submit(withoutId(next))).toBe(2);
      const result = await settledResponse(client, port, "result", 2);
      expect(result.generation).toBe(32);
      expect(result.state.status).toBe("ready");
    } finally {
      fixture.dispose();
    }
  });

  it("cancels actual sliced preparation, burns its token and accepts a new generation", async () => {
    const owned = cancellablePreparation(),
      fixture = createSameFaceCase("ordinary-lod1");
    try {
      const { client, port } = await actualClient();
      expect(client.submit(owned.request)).toBe(1);
      expect(client.cancel()).toBe(true);
      expect(client.busy).toBe(true);
      expect(client.takeSettled()).toBeNull();
      const cancelled = await settledResponse(
        client,
        port,
        "surface_prepared",
        1,
      );
      expect(cancelled.state).toEqual({
        status: "cancelled",
        reason: "caller",
      });
      expect(client.cacheReceipt.owners).toBe(0);
      const request = preparation(workerRequest(fixture.request));
      expect(() => client.submit(request)).toThrow(/token/);
      request.token = 2;
      request.generation = 10;
      expect(client.submit(request)).toBe(2);
      expect(
        (await settledResponse(client, port, "surface_prepared", 2)).state
          .status,
      ).toBe("prepared");
      expect(owned.surface.matchesGeometry(owned.geometry)).toBe(true);
    } finally {
      owned.geometry.dispose();
      fixture.dispose();
    }
  });

  it.each([
    "generation",
    "length",
    "subview",
    "alias",
    "bytes",
    "consumed",
    "accessor",
  ] as const)(
    "rejects invalid %s before transfer, callback invocation or ID consumption",
    async (kind) => {
      const fixture = createSameFaceCase("ordinary-lod1");
      try {
        const { client, port } = await actualClient(),
          packet = workerRequest(fixture.request);
        const buffers = grassGroundingWorkerInputTransfers(packet);
        let getters = 0;
        if (kind === "generation") packet.generation = 0;
        if (kind === "length") packet.data.offsets = new Float32Array(1);
        if (kind === "subview")
          packet.geometry.position = new Float32Array(
            packet.geometry.position.length + 1,
          ).subarray(1);
        if (kind === "alias") packet.data.groundColors = packet.data.offsets;
        if (kind === "bytes")
          packet.surfaces[0].snapshot = {
            ...packet.surfaces[0].snapshot,
            payloadBytes: packet.surfaces[0].snapshot.payloadBytes + 1,
          };
        if (kind === "consumed") packet.consumed.activeMs = NaN;
        if (kind === "accessor")
          Object.defineProperty(packet.settings.wind, "x", {
            enumerable: true,
            get() {
              getters++;
              return 0;
            },
          });
        expect(() => client.submit(withoutId(packet))).toThrow();
        expect(port.postCalls).toBe(0);
        expect(getters).toBe(0);
        expect(buffers.every((buffer) => buffer.byteLength > 0)).toBe(true);
        expect(client.busy).toBe(false);
        expect(client.terminated).toBe(false);
        expect(client.submit(withoutId(workerRequest(fixture.request)))).toBe(
          1,
        );
        expect(
          (await settledResponse(client, port, "result", 1)).state.status,
        ).toBe("ready");
      } finally {
        fixture.dispose();
      }
    },
  );

  it("rejects unknown cache tokens and atomic invalid releases without transferring input or losing known owners", async () => {
    const fixture = createSameFaceCase("ordinary-lod1");
    try {
      const { client, port } = await actualClient(),
        cold = workerRequest(fixture.request);
      const cached = cachedPacket(cold),
        buffers = grassGroundingWorkerInputTransfers({ ...cached, jobId: 1 });
      expect(() => client.submit(cached)).toThrow(/cached/);
      expect(buffers.every((buffer) => buffer.byteLength > 0)).toBe(true);
      expect(port.postCalls).toBe(0);
      expect(client.submit(preparation(workerRequest(fixture.request)))).toBe(
        1,
      );
      await settledResponse(client, port, "surface_prepared", 1);
      const cache = client.cacheReceipt,
        sent = port.postCalls;
      expect(() =>
        client.submit({
          type: "release_surfaces",
          schemaVersion: 1,
          generation: 2,
          surfaceTokens: [1, 999],
        }),
      ).toThrow(/unknown/);
      expect(client.cacheReceipt).toEqual(cache);
      expect(port.postCalls).toBe(sent);
      expect(client.submit(cached)).toBe(2);
      expect(
        (await settledResponse(client, port, "result", 2)).state.status,
      ).toBe("ready");
    } finally {
      fixture.dispose();
    }
  });

  it("handles a real pre-acceptance worker rejection and remains usable with the next ID", async () => {
    const fixture = createSameFaceCase("adjacent-owners");
    try {
      const { client, port } = await actualClient(),
        packet = workerRequest(fixture.request, 1, 41);
      packet.surfaces[1].snapshot = {
        ...packet.surfaces[1].snapshot,
        terrainProfileIdentity: "different-actual-profile-v1",
      };
      expect(client.submit(withoutId(packet))).toBe(1);
      const rejected = await settledResponse(client, port, "rejected", 1);
      expect(rejected.reason).toBe("invalid_message");
      expect(client.transportFailure).toBeNull();
      expect(client.terminated).toBe(false);
      expect(
        client.submit(withoutId(workerRequest(fixture.request, 1, 42))),
      ).toBe(2);
      expect(
        (await settledResponse(client, port, "result", 2)).state.status,
      ).toBe("ready");
    } finally {
      fixture.dispose();
    }
  });

  it.each(["prepare", "fit"] as const)(
    "preserves actual %s budget failures as terminal responses",
    async (kind) => {
      const fixture = createSameFaceCase("ordinary-lod1");
      try {
        const { client, port } = await actualClient(),
          cold = workerRequest(fixture.request);
        const request =
          kind === "prepare" ? preparation(cold) : withoutId(cold);
        request.consumed = {
          operations: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations,
          activeMs: 1,
          maximumSliceMs: 1,
        };
        expect(client.submit(request)).toBe(1);
        const reply =
          kind === "prepare"
            ? await settledResponse(client, port, "surface_prepared", 1)
            : await settledResponse(client, port, "result", 1);
        expect(reply.state).toEqual({
          status: "failed_budget",
          reason: "operations",
        });
        expect(reply.work.operations).toBe(
          GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations,
        );
        expect(client.terminated).toBe(false);
        expect(client.cacheReceipt.owners).toBe(0);
      } finally {
        fixture.dispose();
      }
    },
  );

  it("keeps strict-admission and cached-core input failures recoverable without leaking or losing cache owners", async () => {
    const fixture = createSameFaceCase("ordinary-lod1");
    try {
      const { client, port } = await actualClient(),
        invalid = preparation(workerRequest(fixture.request));
      invalid.snapshot.positions[0] += 1;
      expect(client.submit(invalid)).toBe(1);
      expect(
        (await settledResponse(client, port, "surface_prepared", 1)).state
          .status,
      ).toBe("failed_input");
      expect(client.cacheReceipt.owners).toBe(0);
      const valid = preparation(workerRequest(fixture.request));
      valid.token = 2;
      expect(client.submit(valid)).toBe(2);
      expect(
        (await settledResponse(client, port, "surface_prepared", 2)).state
          .status,
      ).toBe("prepared");
      const cache = client.cacheReceipt,
        badFit = cachedPacket(workerRequest(fixture.request));
      badFit.surfaceTokens = [2];
      badFit.ownSurfaceToken = 2;
      badFit.data.offsets[0] = NaN;
      expect(client.submit(badFit)).toBe(3);
      expect(
        (await settledResponse(client, port, "result", 3)).state.status,
      ).toBe("failed_input");
      expect(client.cacheReceipt).toEqual(cache);
      expect(client.transportFailure).toBeNull();
      const next = cachedPacket(workerRequest(fixture.request));
      next.surfaceTokens = [2];
      next.ownSurfaceToken = 2;
      expect(client.submit(next)).toBe(4);
      expect(
        (await settledResponse(client, port, "result", 4)).state.status,
      ).toBe("ready");
    } finally {
      fixture.dispose();
    }
  });

  it("retains a native structured-clone failure without detaching input or reopening the transport", async () => {
    const fixture = createSameFaceCase("ordinary-lod1");
    try {
      const { client, port } = await actualClient(),
        packet = workerRequest(fixture.request, 1, 51);
      const buffers = grassGroundingWorkerInputTransfers(packet);
      // A real uncloneable nested value: Node's native postMessage throws,
      // rather than a replacement worker manufacturing a failure response.
      Reflect.set(
        packet.constraints.terrainSurface,
        "arenaGradeHeight",
        () => 0,
      );
      expect(client.submit(withoutId(packet))).toBe(1);
      expect(port.postCalls).toBe(1);
      expect(buffers.every((buffer) => buffer.byteLength > 0)).toBe(true);
      expect(client.busy).toBe(true);
      expect(client.terminated).toBe(true);
      expect(client.transportFailure?.reason).toBe("post_message");
      const failed = client.takeSettled();
      expect(failed).toMatchObject({
        status: "failed_transport",
        reason: "post_message",
        jobId: 1,
        generation: 51,
      });
      expect(client.busy).toBe(false);
      expect(client.takeSettled()).toBeNull();
      expect(port.listenerCount).toBe(0);
      expect(() =>
        client.submit(withoutId(workerRequest(fixture.request))),
      ).toThrow(/terminated/);
    } finally {
      fixture.dispose();
    }
  });

  it("handles actual unexpected worker termination and clears cached ownership", async () => {
    const fixture = createSameFaceCase("fine-dense-nonplanar");
    try {
      const { client, port } = await actualClient();
      expect(client.submit(preparation(workerRequest(fixture.request)))).toBe(
        1,
      );
      await settledResponse(client, port, "surface_prepared", 1);
      expect(client.cacheReceipt.owners).toBe(1);
      const packet = cachedPacket(
        maximumClumpPacket(workerRequest(fixture.request)),
        61,
      );
      expect(client.submit(packet)).toBe(2);
      await port.terminateUnexpectedly();
      expect(client.terminated).toBe(true);
      expect(client.cacheReceipt).toEqual({
        owners: 0,
        inputBytes: 0,
        derivedBytesReserved: 0,
      });
      expect(client.takeSettled()).toMatchObject({
        status: "failed_transport",
        reason: "error",
        jobId: 2,
        generation: 61,
      });
      expect(client.busy).toBe(false);
      expect(port.listenerCount).toBe(0);
    } finally {
      fixture.dispose();
    }
  });

  it.each(["active", "settled", "cached"] as const)(
    "destroys a real %s worker idempotently and discards owned state",
    async (phase) => {
      const fixture = createSameFaceCase("ordinary-lod1");
      try {
        const { client, port } = await actualClient();
        if (phase === "cached") {
          client.submit(preparation(workerRequest(fixture.request)));
          await settledResponse(client, port, "surface_prepared", 1);
          expect(client.cacheReceipt.owners).toBe(1);
        } else {
          client.submit(withoutId(workerRequest(fixture.request)));
          if (phase === "settled") await port.waitFor("result", 1);
          expect(client.busy).toBe(true);
        }
        expect(port.listenerCount).toBe(3);
        client.destroy();
        client.destroy();
        expect(client.terminated).toBe(true);
        expect(client.busy).toBe(false);
        expect(client.takeSettled()).toBeNull();
        expect(client.cancel()).toBe(false);
        expect(client.cacheReceipt).toEqual({
          owners: 0,
          inputBytes: 0,
          derivedBytesReserved: 0,
        });
        expect(port.listenerCount).toBe(0);
        expect(port.terminateCalls).toBe(1);
        expect(() =>
          client.submit(withoutId(workerRequest(fixture.request))),
        ).toThrow(/terminated/);
        await port.close();
      } finally {
        fixture.dispose();
      }
    },
  );
});
