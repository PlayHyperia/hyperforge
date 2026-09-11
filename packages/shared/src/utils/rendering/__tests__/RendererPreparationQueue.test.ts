import { describe, expect, it } from "vitest";
import { RendererPreparationQueue } from "../RendererPreparationQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("actual preparation ownership (CPU queue, no fake renderer)", () => {
  it("blocks later work and stays pending after the first caller times out", async () => {
    const queue = new RendererPreparationQueue();
    const underlying = deferred<number>();
    const events: string[] = [];
    const first = queue.run(
      (arm) => {
        arm();
        events.push("first");
        return underlying.promise;
      },
      10,
      "first timeout",
    );
    const outcome = first.then(
      () => "unexpected success",
      (error: Error) => error.message,
    );
    const second = queue.run(
      (arm) => {
        arm();
        events.push("second");
        return 42;
      },
      10,
      "second timeout",
    );
    expect(queue.pendingCount).toBe(2);
    expect(await outcome).toBe("first timeout");
    expect(events).toEqual(["first"]);
    expect(queue.pendingCount).toBe(2);
    await delay(20); // Queued work must not start its deadline yet.
    expect(events).toEqual(["first"]);
    underlying.resolve(7);
    expect(await second).toBe(42);
    expect(events).toEqual(["first", "second"]);
    expect(queue.pendingCount).toBe(0);
    expect(await outcome).toBe("first timeout");
  });

  it("observes a late rejection and drains subsequent work", async () => {
    const queue = new RendererPreparationQueue();
    const underlying = deferred<void>();
    const first = queue.run(
      (arm) => {
        arm();
        return underlying.promise;
      },
      10,
      "timeout",
    );
    const outcome = first.catch((error: Error) => error.message);
    let nextStarted = false;
    const next = queue.run(
      (arm) => {
        arm();
        nextStarted = true;
        return "next";
      },
      1000,
      "next timeout",
    );
    expect(await outcome).toBe("timeout");
    expect(nextStarted).toBe(false);
    expect(queue.pendingCount).toBe(2);
    underlying.reject(new Error("actual late compile failure"));
    expect(await next).toBe("next");
    expect(queue.pendingCount).toBe(0);
    await delay(0); // Vitest also detects unhandled late rejections.
  });

  it("preserves the separate readiness period before the compile deadline", async () => {
    const queue = new RendererPreparationQueue();
    const readiness = deferred<void>();
    const actual = deferred<string>();
    let completed = false;
    const first = queue.run(
      async (arm) => {
        await readiness.promise;
        arm();
        return actual.promise;
      },
      10,
      "compile deadline",
    );
    const outcome = first.then(
      (value) => {
        completed = true;
        return value;
      },
      (error: Error) => {
        completed = true;
        return error.message;
      },
    );
    await delay(25);
    expect(completed).toBe(false);
    expect(queue.pendingCount).toBe(1);
    readiness.resolve();
    expect(await outcome).toBe("compile deadline");
    expect(queue.pendingCount).toBe(1);
    actual.resolve("late success");
    await queue.run(() => undefined, 1000, "unused");
    expect(queue.pendingCount).toBe(0);
  });

  it("preserves synchronous/async values and errors without poisoning the queue", async () => {
    const queue = new RendererPreparationQueue();
    const failure = new Error("synchronous failure");
    await expect(
      queue.run(
        () => {
          throw failure;
        },
        1000,
        "unused",
      ),
    ).rejects.toBe(failure);
    expect(queue.pendingCount).toBe(0);
    expect(
      await queue.run(
        (arm) => {
          arm();
          return 17;
        },
        1000,
        "unused",
      ),
    ).toBe(17);
    const asyncFailure = new Error("async failure");
    await expect(
      queue.run(
        async (arm) => {
          arm();
          throw asyncFailure;
        },
        1000,
        "unused",
      ),
    ).rejects.toBe(asyncFailure);
    expect(
      await queue.run(
        async (arm) => {
          arm();
          return { value: 3 };
        },
        1000,
        "unused",
      ),
    ).toEqual({ value: 3 });
    expect(queue.pendingCount).toBe(0);
  });

  it("ignores repeated or late deadline arming", async () => {
    const queue = new RendererPreparationQueue();
    let savedArm!: () => void;
    expect(
      await queue.run(
        (arm) => {
          savedArm = arm;
          arm();
          arm();
          return 2;
        },
        10,
        "unused",
      ),
    ).toBe(2);
    savedArm();
    await delay(20);
    expect(queue.pendingCount).toBe(0);
    expect(await queue.run(() => 3, 1000, "unused")).toBe(3);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid deadline %s without adding work",
    async (timeout) => {
      const queue = new RendererPreparationQueue();
      let called = false;
      await expect(
        queue.run(
          () => {
            called = true;
          },
          timeout,
          "invalid",
        ),
      ).rejects.toThrow("Positive finite");
      expect(called).toBe(false);
      expect(queue.pendingCount).toBe(0);
    },
  );
});
