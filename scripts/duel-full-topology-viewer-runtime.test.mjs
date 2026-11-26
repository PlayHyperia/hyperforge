import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { existsSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright";
import {
  launchOwnedDuelViewer,
  runDuelViewerOperation,
} from "./duel-full-topology-viewer-runtime.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const work = (operation, options = {}) =>
  runDuelViewerOperation(operation, {
    label: "real viewer test operation",
    timeoutMs: 5_000,
    ...options,
  });

async function viewer(t, options = {}) {
  const owner = await launchOwnedDuelViewer({
    chromium,
    timeoutMs: 15_000,
    ...options,
  });
  assert(Number.isSafeInteger(owner.ownedPid));
  assert(alive(owner.ownedPid));
  t.after(async () => {
    const diagnostic = await owner.close();
    assert.equal(diagnostic.closed, true, JSON.stringify(diagnostic));
    assert.equal(alive(owner.ownedPid), false);
    if (process.platform !== "win32")
      assert.equal(alive(-owner.ownedPid), false);
  });
  return owner;
}

test("lazy operation rejects pre-abort without invocation or retained listeners", async () => {
  const controller = new AbortController();
  controller.abort();
  let invoked = 0;
  await assert.rejects(
    work(
      () => {
        invoked += 1;
      },
      { signal: controller.signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(invoked, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("success, synchronous throw, abort and timeout remove timers/listeners", async () => {
  const controller = new AbortController();
  const timeoutsBefore = process
    .getActiveResourcesInfo()
    .filter((entry) => entry === "Timeout").length;
  assert.equal(
    await work(() => 42, { signal: controller.signal, timeoutMs: 60_000 }),
    42,
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(
    process.getActiveResourcesInfo().filter((entry) => entry === "Timeout")
      .length,
    timeoutsBefore,
  );
  await assert.rejects(
    work(
      () => {
        throw new Error("actual synchronous failure");
      },
      { signal: controller.signal },
    ),
    /actual synchronous failure/,
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const pending = work(() => new Promise(() => {}), {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const timed = new AbortController();
  await assert.rejects(
    work(() => new Promise(() => {}), { signal: timed.signal, timeoutMs: 20 }),
    { name: "TimeoutError" },
  );
  assert.equal(getEventListeners(timed.signal, "abort").length, 0);
});

test("invalid bounds fail before invoking any operation", async () => {
  let calls = 0;
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 120_001]) {
    await assert.rejects(
      work(
        () => {
          calls += 1;
        },
        { timeoutMs },
      ),
      /timeout must/,
    );
  }
  assert.equal(calls, 0);
});

test("late rejection after timeout is consumed, not an unhandled rejection", async () => {
  const unhandled = [];
  const observe = (error) => unhandled.push(error);
  process.on("unhandledRejection", observe);
  try {
    await assert.rejects(
      work(
        async () => {
          await delay(60);
          throw new Error("late real promise failure");
        },
        { timeoutMs: 10 },
      ),
      { name: "TimeoutError" },
    );
    await delay(100);
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", observe);
  }
});

test(
  "real owned Playwright browser evaluates blank page/CDP and closes exact process",
  { timeout: 25_000 },
  async (t) => {
    assert(
      existsSync(chromium.executablePath()),
      "installed Playwright browser is required; this test never downloads it",
    );
    const owner = await viewer(t);
    const page = await work(() => owner.browser.newPage());
    await work(() => page.goto("about:blank"));
    assert.equal(
      await work(() => page.evaluate(() => location.href)),
      "about:blank",
    );
    const session = await work(() => page.context().newCDPSession(page));
    await work(() => session.send("Performance.enable"));
    const metrics = await work(() => session.send("Performance.getMetrics"));
    assert(metrics.metrics.some((entry) => entry.name === "JSHeapUsedSize"));
    const firstClose = owner.close();
    assert.equal(owner.close(), firstClose, "close is idempotent");
    const diagnostic = await firstClose;
    assert.equal(diagnostic.closed, true, JSON.stringify(diagnostic));
    assert.equal(diagnostic.forcedCleanup, false, JSON.stringify(diagnostic));
    assert.equal(diagnostic.ownedPid, owner.ownedPid);
    assert.equal(diagnostic.processExited, true);
    assert.equal(diagnostic.processGroupGone, true);
    assert.equal(diagnostic.browserDisconnected, true);
    assert.deepEqual(diagnostic.errors, []);
  },
);

test(
  "actual never-settling page.evaluate times out and owned cleanup consumes its late rejection",
  { timeout: 25_000 },
  async (t) => {
    const owner = await viewer(t);
    const page = await work(() => owner.browser.newPage());
    const startedAt = Date.now();
    await assert.rejects(
      work(() => page.evaluate(() => new Promise(() => {})), {
        timeoutMs: 100,
      }),
      { name: "TimeoutError" },
    );
    assert(Date.now() - startedAt < 2_000);
    const session = await work(() => page.context().newCDPSession(page));
    await assert.rejects(
      work(
        () =>
          session.send("Runtime.evaluate", {
            expression: "new Promise(() => {})",
            awaitPromise: true,
          }),
        { timeoutMs: 100 },
      ),
      { name: "TimeoutError" },
    );
    const diagnostic = await owner.close();
    assert.equal(diagnostic.closed, true);
    assert.equal(diagnostic.forcedCleanup, false);
  },
);

test(
  "actual pending page.evaluate aborts and cleanup ignores the already-aborted work signal",
  { timeout: 25_000 },
  async (t) => {
    const controller = new AbortController();
    const owner = await viewer(t, { signal: controller.signal });
    const page = await work(() => owner.browser.newPage());
    const pending = work(() => page.evaluate(() => new Promise(() => {})), {
      signal: controller.signal,
    });
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await assert.rejects(pending, { name: "AbortError" });
    } finally {
      clearTimeout(timer);
    }
    const diagnostic = await owner.close();
    assert.equal(diagnostic.closed, true);
    assert.equal(diagnostic.forcedCleanup, false);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  },
);

test(
  "stopped exact owned browser forces bounded kill and cannot masquerade as graceful cleanup",
  { timeout: 25_000 },
  async (t) => {
    const owner = await viewer(t);
    process.kill(owner.ownedPid, "SIGSTOP");
    const startedAt = Date.now();
    const diagnostic = await owner.close();
    assert.equal(diagnostic.closed, true, JSON.stringify(diagnostic));
    assert.equal(diagnostic.forcedCleanup, true);
    assert(
      diagnostic.errors.includes("graceful browser close failed or timed out"),
    );
    assert(Date.now() - startedAt < 7_000);
  },
);

test(
  "real connection failure cleans the browser created before connect",
  { timeout: 25_000 },
  async () => {
    let ownedPid = null;
    await assert.rejects(
      launchOwnedDuelViewer({
        chromium,
        timeoutMs: 15_000,
        onOwnedProcess: async ({ pid }) => {
          ownedPid = pid;
          process.kill(pid, "SIGKILL");
          const deadline = Date.now() + 2_000;
          while (alive(pid) && Date.now() < deadline) await delay(10);
          assert.equal(alive(pid), false);
        },
      }),
      (error) => {
        assert.match(error.message, /connection failed/);
        assert.equal(
          error.viewerDiagnostic.closed,
          true,
          JSON.stringify(error.viewerDiagnostic),
        );
        assert.equal(error.viewerDiagnostic.ownedPid, ownedPid);
        return true;
      },
    );
    assert.equal(alive(ownedPid), false);
    assert.equal(alive(-ownedPid), false);
  },
);

test(
  "throwing ownership callback and abort after ownership both clean exact browser",
  { timeout: 30_000 },
  async () => {
    for (const abort of [false, true]) {
      const controller = new AbortController();
      let ownedPid = null;
      await assert.rejects(
        launchOwnedDuelViewer({
          chromium,
          signal: controller.signal,
          timeoutMs: 15_000,
          onOwnedProcess: ({ pid }) => {
            ownedPid = pid;
            if (abort) controller.abort();
            else throw new Error("deliberate owned callback failure");
          },
        }),
        (error) => {
          assert.equal(
            error.viewerDiagnostic.closed,
            true,
            JSON.stringify(error.viewerDiagnostic),
          );
          if (abort) assert.equal(error.name, "AbortError");
          return true;
        },
      );
      assert.equal(alive(ownedPid), false);
      assert.equal(alive(-ownedPid), false);
    }
  },
);

test(
  "startup callback deadline still cleans the actual owned browser",
  { timeout: 25_000 },
  async () => {
    let ownedPid = null;
    await assert.rejects(
      launchOwnedDuelViewer({
        chromium,
        timeoutMs: 1_500,
        onOwnedProcess: ({ pid }) => {
          ownedPid = pid;
          return new Promise(() => {});
        },
      }),
      (error) => {
        assert.equal(error.name, "TimeoutError");
        assert.equal(
          error.viewerDiagnostic.closed,
          true,
          JSON.stringify(error.viewerDiagnostic),
        );
        assert(Number.isSafeInteger(ownedPid));
        assert.equal(alive(ownedPid), false);
        assert.equal(alive(-ownedPid), false);
        return true;
      },
    );
  },
);

test(
  "abort while real launch is pending cleans any late BrowserServer before rejection settles",
  { timeout: 25_000 },
  async () => {
    const controller = new AbortController();
    const pending = launchOwnedDuelViewer({
      chromium,
      signal: controller.signal,
      timeoutMs: 15_000,
    });
    // The helper has invoked the real launch by the next macrotask; abort while
    // Playwright is still starting Chrome, without substituting either API.
    const timer = setTimeout(() => controller.abort(), 1);
    try {
      await assert.rejects(pending, (error) => {
        assert.equal(error.name, "AbortError");
        const diagnostic = error.viewerDiagnostic;
        assert(
          Number.isSafeInteger(diagnostic.ownedPid),
          "real late browser ownership was observed",
        );
        assert.equal(diagnostic.closed, true, JSON.stringify(diagnostic));
        assert.equal(alive(diagnostic.ownedPid), false);
        assert.equal(alive(-diagnostic.ownedPid), false);
        return true;
      });
    } finally {
      clearTimeout(timer);
    }
  },
);
