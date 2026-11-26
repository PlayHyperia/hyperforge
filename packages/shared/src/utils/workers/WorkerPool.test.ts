import { resolveObjectURL } from "node:buffer";
import { createHash } from "node:crypto";
import { Worker as NodeWorker } from "node:worker_threads";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerPool } from "./WorkerPool";
import {
  generateVegetationPlacementsAsync,
  getVegetationWorkerPool,
  terminateVegetationWorkerPool,
  type VegetationLayerInput,
} from "./VegetationWorker";

type TransportListener = (event: MessageEvent | ErrorEvent) => void;

/** Real worker_threads transport for the pool's browser Blob/event API. The
 * supplied inline worker source and structured-clone operation run unchanged;
 * only the host API and an out-of-band test-ready message are adapted. Errors
 * below originate in the worker, never from synthetic event dispatch. */
class ActualPoolWorker {
  static instances: ActualPoolWorker[] = [];
  private readonly worker: NodeWorker;
  private readonly listeners = new Map<string, Set<TransportListener>>();
  readonly ready: Promise<void>;
  private closing = false;
  private termination: Promise<number> | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postCalls = 0;
  terminateCalls = 0;

  constructor(url: string) {
    const source = resolveObjectURL(url);
    if (!source) throw new Error("Actual worker Blob URL is unavailable");
    this.worker = new NodeWorker(
      `const { parentPort, workerData } = require("node:worker_threads");
globalThis.self = { postMessage: (data, transfers) => parentPort.postMessage(data, transfers) };
(async () => {
  const source = await workerData.source.text();
  (0, eval)(source);
  parentPort.on("message", data => self.onmessage({ data }));
  parentPort.postMessage({ actualPoolTransportReady: true });
})();`,
      { eval: true, workerData: { source }, env: {} },
    );
    this.ready = new Promise<void>((resolve, reject) => {
      this.worker.once("error", reject);
      this.worker.on("message", (data: unknown) => {
        if (
          data &&
          typeof data === "object" &&
          "actualPoolTransportReady" in data
        ) {
          resolve();
          return;
        }
        if (this.closing) return;
        const event = new MessageEvent("message", { data });
        for (const listener of [...(this.listeners.get("message") ?? [])])
          if (this.listeners.get("message")?.has(listener)) listener(event);
      });
    });
    // Startup-error tests can submit work before awaiting readiness.
    void this.ready.catch(() => undefined);
    this.worker.on("error", (error: Error) => {
      if (this.closing) return;
      const event = Object.assign(new Event("error"), {
        message: error.message,
        error,
      }) as ErrorEvent;
      this.onerror?.(event);
      for (const listener of [...(this.listeners.get("error") ?? [])])
        if (this.listeners.get("error")?.has(listener)) listener(event);
    });
    this.worker.on("messageerror", (error: Error) => {
      if (this.closing) return;
      const event = new MessageEvent("messageerror", { data: error });
      for (const listener of [...(this.listeners.get("messageerror") ?? [])])
        if (this.listeners.get("messageerror")?.has(listener)) listener(event);
    });
    ActualPoolWorker.instances.push(this);
  }

  addEventListener(type: string, listener: TransportListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: TransportListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }

  postMessage(data: unknown, transfers?: readonly ArrayBuffer[]): void {
    this.postCalls++;
    this.worker.postMessage(data, transfers);
  }

  terminate(): void {
    this.terminateCalls++;
    this.closing = true;
    this.termination ??= this.worker.terminate();
  }

  async close(): Promise<void> {
    if (!this.closing) this.terminate();
    await this.termination;
  }
}

const TRANSPORT_SOURCE = `self.onmessage = ({data}) => {
  if (data.crash) throw new Error("actual active worker crash");
  if (data.hold) return;
  if (data.failure) { self.postMessage({error: "actual task rejection"}); return; }
  self.postMessage({result: data}, data.bytes ? [data.bytes.buffer] : []);
};`;

type Request = {
  value?: number;
  crash?: boolean;
  hold?: boolean;
  failure?: boolean;
  uncloneable?: () => void;
  bytes?: Uint8Array;
};

const pools: WorkerPool<Request, Request>[] = [];
let dom: JSDOM;
let previousWorker: PropertyDescriptor | undefined;
let previousWindow: PropertyDescriptor | undefined;

function pool(source = TRANSPORT_SOURCE, size = 1) {
  const result = new WorkerPool<Request, Request>(source, size);
  pools.push(result);
  return result;
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Actual pool test timed out")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function outcome<T>(pending: Promise<T>) {
  return pending.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

beforeEach(() => {
  previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  dom = new JSDOM("<!doctype html>", { runScripts: "outside-only" });
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: ActualPoolWorker,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
  });
  ActualPoolWorker.instances = [];
});

afterEach(async () => {
  terminateVegetationWorkerPool();
  for (const owner of pools.splice(0)) owner.terminate();
  await Promise.all(ActualPoolWorker.instances.map((worker) => worker.close()));
  dom.window.close();
  for (const [key, descriptor] of [
    ["Worker", previousWorker],
    ["window", previousWindow],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe("WorkerPool actual worker lifecycle", () => {
  it("cleans a real uncloneable submission and reuses the same healthy worker", async () => {
    const owner = pool();
    const [worker] = ActualPoolWorker.instances;
    await bounded(worker.ready);
    await expect(
      owner.execute({ uncloneable: () => undefined }),
    ).rejects.toMatchObject({ name: "DataCloneError" });
    expect(owner.getStats()).toMatchObject({
      workerCount: 1,
      busyCount: 0,
      queuedTasks: 0,
      totalTasksProcessed: 0,
      workersAvailable: true,
    });
    expect(worker.terminateCalls).toBe(0);
    await expect(bounded(owner.execute({ value: 17 }))).resolves.toEqual({
      value: 17,
    });
    expect(worker.postCalls).toBe(2);
    owner.terminate();
    expect(worker.listenerCount).toBe(0);
  });

  it("drains queued uncloneable requests iteratively without losing later valid work", async () => {
    const owner = pool();
    await bounded(ActualPoolWorker.instances[0].ready);
    const first = outcome(owner.execute({ value: 1 }));
    const rejected = Array.from({ length: 2048 }, () =>
      outcome(owner.execute({ uncloneable: () => undefined })),
    );
    const last = outcome(owner.execute({ value: 2 }));
    const results = await bounded(Promise.all([first, ...rejected, last]));
    expect(results[0]).toEqual({ ok: true, value: { value: 1 } });
    expect(results.at(-1)).toEqual({ ok: true, value: { value: 2 } });
    for (const result of results.slice(1, -1)) {
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatchObject({ name: "DataCloneError" });
    }
    expect(owner.getStats()).toMatchObject({
      workerCount: 1,
      busyCount: 0,
      queuedTasks: 0,
      totalTasksProcessed: 2,
    });
    expect(ActualPoolWorker.instances[0].terminateCalls).toBe(0);
  });

  it("preserves a real foreign-realm DOMException name during error normalization", async () => {
    const owner = pool();
    await bounded(ActualPoolWorker.instances[0].ready);
    const error = new dom.window.DOMException(
      "Cannot clone input",
      "DataCloneError",
    );
    expect(error instanceof Error).toBe(false);
    // This is the language/realm boundary, not a fabricated worker event.
    const normalize = Reflect.get(owner, "asError") as (
      error: unknown,
    ) => Error;
    expect(normalize.call(owner, error)).toMatchObject({
      name: "DataCloneError",
    });
  });

  it("retires an actual startup failure before accepting later work", async () => {
    const owner = pool('throw new Error("actual startup worker crash");');
    const [worker] = ActualPoolWorker.instances;
    await expect(bounded(worker.ready)).rejects.toThrow(
      "actual startup worker crash",
    );
    expect(owner.getStats()).toMatchObject({
      workerCount: 0,
      busyCount: 0,
      workersAvailable: false,
    });
    await expect(bounded(owner.execute({ value: 1 }))).rejects.toThrow();
    expect(worker.postCalls).toBe(0);
    expect(worker.terminateCalls).toBe(1);
    expect(worker.listenerCount).toBe(0);
  });

  it("rejects active and queued jobs after a real crash without retrying either", async () => {
    const owner = pool();
    const [worker] = ActualPoolWorker.instances;
    await bounded(worker.ready);
    const active = outcome(owner.execute({ crash: true }));
    const queued = outcome(owner.execute({ value: 3 }));
    const results = await bounded(Promise.all([active, queued]));
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(Error);
    }
    expect(worker.postCalls).toBe(1);
    expect(worker.terminateCalls).toBe(1);
    expect(worker.listenerCount).toBe(0);
    expect(owner.getStats()).toMatchObject({
      workerCount: 0,
      queuedTasks: 0,
      busyCount: 0,
      workersAvailable: false,
    });
  });

  it("keeps surviving capacity and completed-task statistics after another worker crashes", async () => {
    const owner = pool(TRANSPORT_SOURCE, 2);
    const [first, second] = ActualPoolWorker.instances;
    await bounded(Promise.all([first.ready, second.ready]));
    await bounded(owner.execute({ value: 1 }));
    await bounded(owner.execute({ value: 2 }));
    const failed = outcome(owner.execute({ crash: true }));
    const good = outcome(owner.execute({ value: 3 }));
    const queued = outcome(owner.execute({ value: 4 }));
    const results = await bounded(Promise.all([failed, good, queued]));
    expect(results[0].ok).toBe(false);
    expect(results[1]).toEqual({ ok: true, value: { value: 3 } });
    expect(results[2]).toEqual({ ok: true, value: { value: 4 } });
    expect(first.postCalls).toBe(2);
    expect(first.terminateCalls).toBe(1);
    expect(second.postCalls).toBe(3);
    expect(second.terminateCalls).toBe(0);
    expect(owner.getStats()).toMatchObject({
      workerCount: 1,
      busyCount: 0,
      queuedTasks: 0,
      totalTasksProcessed: 4,
      workersAvailable: true,
    });
  });

  it("does not retry admitted jobs in fallback but allows a fresh explicit fallback request", async () => {
    let fallbackCalls = 0;
    const owner = new WorkerPool<Request, Request>(
      TRANSPORT_SOURCE,
      1,
      (request) => {
        fallbackCalls++;
        return request;
      },
    );
    pools.push(owner);
    await bounded(ActualPoolWorker.instances[0].ready);
    const active = outcome(owner.execute({ crash: true }));
    const queued = outcome(owner.execute({ value: 2 }));
    const results = await bounded(Promise.all([active, queued]));
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(fallbackCalls).toBe(0);
    await expect(owner.execute({ value: 3 })).resolves.toEqual({ value: 3 });
    expect(fallbackCalls).toBe(1);
    expect(ActualPoolWorker.instances[0].postCalls).toBe(1);
  });

  it("settles termination once and never dispatches queued work", async () => {
    const owner = pool();
    const [worker] = ActualPoolWorker.instances;
    await bounded(worker.ready);
    const active = outcome(owner.execute({ hold: true }));
    const queued = outcome(owner.execute({ value: 1 }));
    owner.terminate();
    owner.terminate();
    const results = await bounded(Promise.all([active, queued]));
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatchObject({
          message: "WorkerPool terminated",
        });
    }
    expect(worker.postCalls).toBe(1);
    expect(worker.terminateCalls).toBe(1);
    expect(worker.listenerCount).toBe(0);
    expect(owner.getStats()).toMatchObject({
      workerCount: 0,
      busyCount: 0,
      queuedTasks: 0,
      workersAvailable: false,
    });
    await expect(owner.execute({ value: 2 })).rejects.toThrow(
      "WorkerPool has been terminated",
    );
  });

  it("preserves task rejection and transferred success without retiring healthy workers", async () => {
    const owner = pool();
    await expect(bounded(owner.execute({ failure: true }))).rejects.toThrow(
      "actual task rejection",
    );
    const bytes = new Uint8Array([1, 9, 27, 81]);
    const result = owner.execute({ value: 4, bytes }, [bytes.buffer]);
    expect(bytes.byteLength).toBe(0);
    const received = await bounded(result);
    expect(received.value).toBe(4);
    expect(received.bytes).toEqual(new Uint8Array([1, 9, 27, 81]));
    expect(owner.getStats()).toMatchObject({
      workerCount: 1,
      totalTasksProcessed: 2,
      workersAvailable: true,
    });
  });

  it("preserves deterministic output of the actual production vegetation worker", async () => {
    const layers: VegetationLayerInput[] = [
      {
        category: "flowers",
        assets: [
          {
            id: "meadow-flower",
            weight: 1,
            scaleMin: 0.8,
            scaleMax: 1.2,
            randomRotation: true,
            alignToNormal: false,
            yOffset: 0,
          },
        ],
        density: 12,
        minSpacing: 2,
        noiseScale: 0.04,
        noiseThreshold: 0.2,
      },
    ];
    const original = structuredClone(layers);
    const owner = getVegetationWorkerPool(2);
    expect(owner).not.toBeNull();
    const first = await bounded(
      generateVegetationPlacementsAsync("3_4", 300, 400, 100, layers, 1743),
    );
    const second = await bounded(
      generateVegetationPlacementsAsync("3_4", 300, 400, 100, layers, 1743),
    );
    expect(first).toEqual(second);
    expect(layers).toEqual(original);
    expect(first?.stats.placementsCreated).toBe(12);
    expect(first?.placements).toHaveLength(12);
    expect(owner?.getStats()).toMatchObject({
      workerCount: 2,
      busyCount: 0,
      totalTasksProcessed: 2,
    });
    process.stdout.write(
      "WorkerPool actual vegetation output SHA256 " +
        createHash("sha256").update(JSON.stringify(first)).digest("hex") +
        "\n",
    );
  });
});
