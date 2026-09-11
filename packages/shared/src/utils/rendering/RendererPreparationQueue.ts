/**
 * Serializes actual renderer work, independently of a caller's timeout.
 * A timeout never cancels GPU work or makes its resources safe to dispose.
 */
export class RendererPreparationQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  get pendingCount(): number {
    return this.pending;
  }

  /**
   * The operation arms its caller deadline once preparation starts. This lets
   * renderer readiness keep its separate deadline without timing queued work.
   * Never await another operation on this same queue from inside an operation.
   */
  run<T>(
    operation: (startCallerDeadline: () => void) => T | Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(
        new Error("Positive finite preparation timeout required"),
      );
    }

    this.pending++;
    let resolveCaller!: (value: T | PromiseLike<T>) => void;
    let rejectCaller!: (reason: unknown) => void;
    const caller = new Promise<T>((resolve, reject) => {
      resolveCaller = resolve;
      rejectCaller = reject;
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let active = false;
    let deadlineStarted = false;
    const work = this.tail.then(async () => {
      active = true;
      const startCallerDeadline = () => {
        if (!active || deadlineStarted) return;
        deadlineStarted = true;
        timeout = setTimeout(() => {
          rejectCaller(new Error(timeoutMessage));
        }, timeoutMs);
      };
      return operation(startCallerDeadline);
    });
    const settled = work.finally(() => {
      active = false;
      if (timeout !== undefined) clearTimeout(timeout);
      this.pending--;
    });

    // Only underlying settlement releases the next operation. Both rejection
    // handlers also observe late failures after the caller has already timed out.
    this.tail = settled.then(
      () => undefined,
      () => undefined,
    );
    void settled.then(resolveCaller, rejectCaller);
    return caller;
  }
}
