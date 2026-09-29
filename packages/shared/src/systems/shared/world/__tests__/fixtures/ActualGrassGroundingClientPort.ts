import { Worker } from "node:worker_threads";
import type {
  GrassGroundingWorkerClient,
  GrassGroundingWorkerPort,
} from "../../../../../utils/workers/GrassGroundingWorkerClient";
import type { GrassGroundingWorkerResponse } from "../../../../../utils/workers/GrassGroundingWorkerWire";

type MessageListener = (event: MessageEvent<unknown>) => void;
type ErrorListener = (event: ErrorEvent) => void;
type EventName = "message" | "error" | "messageerror";

/** Browser event adapter around the actual bundled grounding worker. Only its
 * initial readiness handshake is filtered; protocol replies are not rewritten.
 * Unexpected Node worker exit is exposed as a transport error to the browser
 * port consumer. Intentional termination removes that notification. */
export class ActualGrassGroundingClientPort implements GrassGroundingWorkerPort {
  private readonly worker: Worker;
  private readonly messages = new Set<MessageListener>();
  private readonly errors = new Set<ErrorListener>();
  private readonly messageErrors = new Set<MessageListener>();
  private readonly received: GrassGroundingWorkerResponse[] = [];
  private readonly waiting: {
    type: GrassGroundingWorkerResponse["type"];
    jobId: number;
    resolve: (response: GrassGroundingWorkerResponse) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }[] = [];
  private readonly readiness: Promise<void>;
  private closing = false;
  private termination: Promise<number> | null = null;
  /** Gameplay/cancellation traffic, excluding bounded startup calibration. */
  postCalls = 0;
  clockPostCalls = 0;
  terminateCalls = 0;

  constructor(source: string) {
    this.worker = new Worker(
      `const {parentPort, MessageChannel} = require("node:worker_threads");
globalThis.MessageChannel = MessageChannel;
globalThis.self = {postMessage: (message, transfers) => parentPort.postMessage(message, transfers)};
${source}
parentPort.on("message", data => self.onmessage({data}));
parentPort.postMessage({testTransportReady: true});`,
      { eval: true, env: {} },
    );
    this.readiness = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Actual client worker startup timed out")),
        10_000,
      );
      this.worker.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      this.worker.on("message", (data: unknown) => {
        if (
          data &&
          typeof data === "object" &&
          "testTransportReady" in data &&
          data.testTransportReady === true
        ) {
          clearTimeout(timeout);
          resolve();
          return;
        }
        const event = new MessageEvent<unknown>("message", { data });
        for (const listener of this.messages) listener(event);
        // Deliver the actual startup sample to the client, but never cast it
        // into a job response or let it satisfy a gameplay response waiter.
        if (
          data &&
          typeof data === "object" &&
          "type" in data &&
          data.type === "clock_sample"
        )
          return;
        const response = data as GrassGroundingWorkerResponse;
        if (this.received.length >= 128)
          throw new Error("Actual client worker reply bound exceeded");
        this.received.push(response);
        for (let i = this.waiting.length - 1; i >= 0; i--) {
          const waiter = this.waiting[i];
          if (response.type !== waiter.type || response.jobId !== waiter.jobId)
            continue;
          this.waiting.splice(i, 1);
          clearTimeout(waiter.timeout);
          waiter.resolve(response);
        }
      });
    });
    this.worker.on("error", (error) => this.emitError(error));
    this.worker.on("messageerror", (error: Error) => {
      const event = new MessageEvent<unknown>("messageerror", { data: error });
      for (const listener of this.messageErrors) listener(event);
    });
    this.worker.on("exit", (code) => {
      if (!this.closing)
        this.emitError(
          new Error(`Actual worker exited unexpectedly with code ${code}`),
        );
    });
  }

  private emitError(error: Error): void {
    const event = Object.assign(new Event("error"), {
      message: error.message,
      error,
    }) as ErrorEvent;
    for (const listener of this.errors) listener(event);
    for (const waiter of this.waiting.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }

  get listenerCount(): number {
    return this.messages.size + this.errors.size + this.messageErrors.size;
  }

  addEventListener(type: "message", listener: MessageListener): void;
  addEventListener(type: "error", listener: ErrorListener): void;
  addEventListener(type: "messageerror", listener: MessageListener): void;
  addEventListener(
    type: EventName,
    listener: MessageListener | ErrorListener,
  ): void {
    if (type === "error") this.errors.add(listener as ErrorListener);
    else
      (type === "message" ? this.messages : this.messageErrors).add(
        listener as MessageListener,
      );
  }

  removeEventListener(type: "message", listener: MessageListener): void;
  removeEventListener(type: "error", listener: ErrorListener): void;
  removeEventListener(type: "messageerror", listener: MessageListener): void;
  removeEventListener(
    type: EventName,
    listener: MessageListener | ErrorListener,
  ): void {
    if (type === "error") this.errors.delete(listener as ErrorListener);
    else
      (type === "message" ? this.messages : this.messageErrors).delete(
        listener as MessageListener,
      );
  }

  postMessage(message: unknown, transfer: ArrayBuffer[]): void {
    if (
      message &&
      typeof message === "object" &&
      "type" in message &&
      message.type === "clock_probe"
    )
      this.clockPostCalls++;
    else this.postCalls++;
    this.worker.postMessage(message, transfer);
  }

  ready(): Promise<void> {
    return this.readiness;
  }

  /** Wait for the actual client handshake; never manufacture clock samples. */
  async readyFor(client: GrassGroundingWorkerClient): Promise<void> {
    const deadline = performance.now() + 11_000;
    await this.ready();
    for (;;) {
      if (client.terminated)
        throw new Error(
          client.transportFailure?.error ??
            "Actual grounding client terminated",
        );
      if (!client.busy) return;
      if (performance.now() >= deadline)
        throw new Error("Actual grounding client startup timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
  }

  waitFor<K extends GrassGroundingWorkerResponse["type"]>(
    type: K,
    jobId: number,
  ): Promise<Extract<GrassGroundingWorkerResponse, { type: K }>> {
    const present = this.received.find(
      (response) => response.type === type && response.jobId === jobId,
    );
    if (present)
      return Promise.resolve(
        present as Extract<GrassGroundingWorkerResponse, { type: K }>,
      );
    return new Promise<GrassGroundingWorkerResponse>((resolve, reject) => {
      const waiter = {
        type,
        jobId,
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new Error(`Actual client worker ${type} reply timed out`));
        }, 10_000),
      };
      this.waiting.push(waiter);
    }) as Promise<Extract<GrassGroundingWorkerResponse, { type: K }>>;
  }

  /** Exercise actual host termination, without fabricating a protocol reply. */
  async terminateUnexpectedly(): Promise<void> {
    await this.worker.terminate();
  }

  terminate(): void {
    this.terminateCalls++;
    this.closing = true;
    this.termination ??= this.worker.terminate();
  }

  async close(): Promise<void> {
    if (!this.closing) this.terminate();
    for (const waiter of this.waiting.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Actual client worker closed"));
    }
    await this.termination;
  }
}
