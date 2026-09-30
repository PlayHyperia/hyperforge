/**
 * WorkerPool - Manages a pool of Web Workers for parallel processing
 *
 * Provides efficient task distribution across multiple worker threads with:
 * - Automatic load balancing (round-robin with busy tracking)
 * - Task queuing when all workers are busy
 * - Transfer support for zero-copy ArrayBuffer passing
 * - Promise-based API for easy async/await usage
 *
 * @example
 * const pool = new WorkerPool(workerCode, 4);
 * const result = await pool.execute({ type: 'process', data: myData });
 */

type WorkerTask<T, R> = {
  data: T;
  transfers?: Transferable[];
  resolve: (result: R) => void;
  reject: (error: Error) => void;
};

interface PoolWorker<TInput = unknown, TOutput = unknown> {
  worker: Worker;
  busy: boolean;
  activeTask?: WorkerTask<TInput, TOutput>;
  removeTaskListeners?: () => void;
  removeWorkerListeners?: () => void;
}

export class WorkerPool<TInput = unknown, TOutput = unknown> {
  private workers: PoolWorker<TInput, TOutput>[] = [];
  private taskQueue: WorkerTask<TInput, TOutput>[] = [];
  private nextWorkerIndex = 0;
  private terminated = false;
  private drainingQueue = false;
  private totalTasksProcessed = 0;
  private workerFailure: Error | null = null;
  /** Fallback function for synchronous execution when workers unavailable */
  private fallbackFn?: (input: TInput) => TOutput | Promise<TOutput>;
  /** True if workers are available and working */
  private workersAvailable = false;
  /** Initialization error if workers failed to create */
  private initError: Error | null = null;

  /**
   * Create a new worker pool
   * @param workerCode - Inline worker code as a string (will be converted to blob URL)
   * @param poolSize - Number of workers to spawn (defaults to navigator.hardwareConcurrency - 1, min 1)
   * @param fallbackFn - Optional fallback function for when workers unavailable (e.g., server-side)
   */
  constructor(
    workerCode: string,
    poolSize: number = Math.max(
      1,
      (typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4) -
        1,
    ),
    fallbackFn?: (input: TInput) => TOutput | Promise<TOutput>,
  ) {
    this.fallbackFn = fallbackFn;

    // Check if we're in an environment with Worker support
    if (typeof Worker === "undefined" || typeof Blob === "undefined") {
      this.initError = new Error(
        "Web Workers not available in this environment",
      );
      console.warn(
        "[WorkerPool] Web Workers not available - using fallback if provided",
      );
      return;
    }

    // Detect Bun runtime - Bun has Worker/Blob but blob URLs don't work for workers
    if (
      typeof process !== "undefined" &&
      process.versions &&
      "bun" in process.versions
    ) {
      this.initError = new Error("Blob URLs not supported in Bun runtime");
      console.warn(
        "[WorkerPool] Bun runtime detected - blob URLs not supported, using fallback if provided",
      );
      return;
    }

    // Detect non-browser environment (no window global)
    if (typeof window === "undefined") {
      this.initError = new Error(
        "Web Workers require browser environment (window global)",
      );
      console.warn(
        "[WorkerPool] Server environment detected - using fallback if provided",
      );
      return;
    }

    // Create blob URL from inline worker code
    let url: string;
    try {
      const blob = new Blob([workerCode], { type: "application/javascript" });
      url = URL.createObjectURL(blob);
    } catch (e) {
      this.initError =
        e instanceof Error ? e : new Error("Failed to create worker blob");
      console.warn("[WorkerPool] Failed to create worker blob:", e);
      return;
    }

    // Spawn workers
    for (let i = 0; i < poolSize; i++) {
      try {
        const worker = new Worker(url);
        const poolWorker: PoolWorker<TInput, TOutput> = {
          worker,
          busy: false,
        };
        const handleError = (e: ErrorEvent) => {
          console.error(`[WorkerPool] Worker ${i} error:`, e.message);
          this.retireWorker(poolWorker, new Error(e.message || "Worker error"));
        };
        const handleMessageError = () => {
          this.retireWorker(
            poolWorker,
            new Error("Worker message could not be deserialized"),
          );
        };
        worker.addEventListener("error", handleError);
        worker.addEventListener("messageerror", handleMessageError);
        poolWorker.removeWorkerListeners = () => {
          worker.removeEventListener("error", handleError);
          worker.removeEventListener("messageerror", handleMessageError);
        };
        this.workers.push(poolWorker);
      } catch (e) {
        console.warn(`[WorkerPool] Failed to create worker ${i}:`, e);
      }
    }

    // Clean up blob URL after workers are created
    URL.revokeObjectURL(url);

    this.workersAvailable = this.workers.length > 0;

    if (!this.workersAvailable) {
      console.warn(
        "[WorkerPool] No workers created - using fallback if provided",
      );
    }
  }

  /**
   * Check if workers are available
   */
  hasWorkers(): boolean {
    return this.workersAvailable;
  }

  /**
   * Get initialization error if workers failed to create
   * Returns null if workers initialized successfully or haven't been attempted yet
   */
  getInitError(): Error | null {
    return this.initError;
  }

  /**
   * Execute a task on the worker pool
   * @param data - Task data to send to worker
   * @param transfers - Optional transferable objects (e.g., ArrayBuffers)
   * @returns Promise that resolves with worker result
   */
  execute(data: TInput, transfers?: Transferable[]): Promise<TOutput> {
    if (this.terminated) {
      return Promise.reject(new Error("WorkerPool has been terminated"));
    }

    // Use fallback if no workers available
    if (!this.workersAvailable) {
      if (this.fallbackFn) {
        try {
          const result = this.fallbackFn(data);
          return result instanceof Promise ? result : Promise.resolve(result);
        } catch (error) {
          return Promise.reject(error);
        }
      }
      return Promise.reject(
        this.workerFailure ??
          new Error("WorkerPool has no workers and no fallback function"),
      );
    }

    return new Promise<TOutput>((resolve, reject) => {
      const task: WorkerTask<TInput, TOutput> = {
        data,
        transfers,
        resolve,
        reject,
      };

      this.taskQueue.push(task);
      this.processQueue();
    });
  }

  /**
   * Execute multiple tasks in parallel
   * @param tasks - Array of task data
   * @returns Promise that resolves with all results
   */
  executeAll(
    tasks: Array<{ data: TInput; transfers?: Transferable[] }>,
  ): Promise<TOutput[]> {
    return Promise.all(tasks.map((t) => this.execute(t.data, t.transfers)));
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    workerCount: number;
    busyCount: number;
    queuedTasks: number;
    totalTasksProcessed: number;
    workersAvailable: boolean;
    initError: string | null;
  } {
    const busyCount = this.workers.filter((w) => w.busy).length;
    return {
      workerCount: this.workers.length,
      busyCount,
      queuedTasks: this.taskQueue.length,
      // Retiring a worker does not erase already completed replies.
      totalTasksProcessed: this.totalTasksProcessed,
      workersAvailable: this.workersAvailable,
      initError: this.initError?.message ?? null,
    };
  }

  /**
   * Terminate all workers and clean up
   */
  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.workersAvailable = false;
    for (const pw of this.workers) {
      pw.removeWorkerListeners?.();
      pw.removeWorkerListeners = undefined;
      if (pw.activeTask) {
        this.settleTask(pw, pw.activeTask, new Error("WorkerPool terminated"));
      }
      pw.worker.terminate();
    }
    this.workers = [];

    for (const task of this.taskQueue) {
      task.reject(new Error("WorkerPool terminated"));
    }
    this.taskQueue = [];
  }

  private getAvailableWorker(): PoolWorker<TInput, TOutput> | null {
    // Round-robin with availability check
    const startIndex = this.nextWorkerIndex;
    for (let i = 0; i < this.workers.length; i++) {
      const index = (startIndex + i) % this.workers.length;
      const worker = this.workers[index];
      if (!worker.busy) {
        this.nextWorkerIndex = (index + 1) % this.workers.length;
        return worker;
      }
    }
    return null;
  }

  private runTask(
    poolWorker: PoolWorker<TInput, TOutput>,
    task: WorkerTask<TInput, TOutput>,
  ): void {
    poolWorker.busy = true;
    poolWorker.activeTask = task;

    const handleMessage = (e: MessageEvent) => {
      if (poolWorker.activeTask !== task) return;
      try {
        const error = e.data.error ? new Error(e.data.error) : null;
        const result = e.data.result as TOutput;
        this.totalTasksProcessed++;
        this.settleTask(poolWorker, task, error, result);
      } catch (error) {
        this.retireWorker(poolWorker, this.asError(error));
      }
      this.processQueue();
    };
    poolWorker.removeTaskListeners = () => {
      poolWorker.worker.removeEventListener("message", handleMessage);
    };
    poolWorker.worker.addEventListener("message", handleMessage);

    try {
      if (task.transfers && task.transfers.length > 0) {
        poolWorker.worker.postMessage(task.data, task.transfers);
      } else {
        poolWorker.worker.postMessage(task.data);
      }
    } catch (error) {
      const failure = this.asError(error);
      if (failure.name === "DataCloneError") {
        // Serialization rejected this request before enqueueing it. The
        // worker is still healthy; release only this task's ownership.
        this.settleTask(poolWorker, task, failure);
      } else {
        // Unknown transport failure: preserve neither its capacity nor a
        // speculative retry of possibly transferred input.
        this.retireWorker(poolWorker, failure);
      }
    }
  }

  private asError(error: unknown): Error {
    if (error instanceof Error) return error;
    const result = new Error(String(error));
    // DOMExceptions from another realm need not inherit this realm's Error.
    // Preserve the classification of genuine structured-clone rejection.
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      typeof error.name === "string"
    ) {
      result.name = error.name;
    }
    return result;
  }

  private settleTask(
    worker: PoolWorker<TInput, TOutput>,
    task: WorkerTask<TInput, TOutput>,
    error: Error | null,
    result?: TOutput,
  ): void {
    if (worker.activeTask !== task) return;
    worker.removeTaskListeners?.();
    worker.removeTaskListeners = undefined;
    worker.activeTask = undefined;
    worker.busy = false;
    if (error) task.reject(error);
    else task.resolve(result as TOutput);
  }

  private retireWorker(
    worker: PoolWorker<TInput, TOutput>,
    error: Error,
  ): void {
    const index = this.workers.indexOf(worker);
    if (index < 0) return;
    this.workers.splice(index, 1);
    this.nextWorkerIndex %= Math.max(1, this.workers.length);
    this.workersAvailable = this.workers.length > 0;
    this.workerFailure = error;
    worker.removeWorkerListeners?.();
    worker.removeWorkerListeners = undefined;
    if (worker.activeTask) this.settleTask(worker, worker.activeTask, error);
    worker.worker.terminate();
    this.processQueue();
  }

  private processQueue(): void {
    if (this.terminated || this.drainingQueue) return;
    this.drainingQueue = true;
    try {
      while (this.taskQueue.length > 0) {
        if (!this.workersAvailable) {
          const error =
            this.workerFailure ?? new Error("WorkerPool has no usable workers");
          for (const task of this.taskQueue.splice(0)) task.reject(error);
          break;
        }
        const availableWorker = this.getAvailableWorker();
        if (!availableWorker) break;
        this.runTask(availableWorker, this.taskQueue.shift()!);
      }
    } finally {
      this.drainingQueue = false;
    }
  }
}

/**
 * Create a worker pool from a function
 * The function will be stringified and run in the worker context
 */
export function createWorkerFromFunction<TInput, TOutput>(
  fn: (input: TInput) => TOutput,
  poolSize?: number,
): WorkerPool<TInput, TOutput> {
  const workerCode = `
    const processFn = ${fn.toString()};
    
    self.onmessage = async function(e) {
      try {
        const result = await processFn(e.data);
        self.postMessage({ result });
      } catch (error) {
        self.postMessage({ error: error.message || 'Unknown error' });
      }
    };
  `;
  return new WorkerPool<TInput, TOutput>(workerCode, poolSize);
}
