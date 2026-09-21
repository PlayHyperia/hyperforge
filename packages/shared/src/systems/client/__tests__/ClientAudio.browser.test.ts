import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

// Native autoplay/lifecycle proof only: no game boot, audio-content quality,
// stream encoding, speakers, microphone, renderer or performance qualification.
const native =
  process.env.HYPERIA_NATIVE_AUDIO === "1"
    ? describe.sequential
    : describe.skip;
type Snapshot = {
  state: AudioContextState;
  unlocked: boolean;
  queued: number;
  calls: string[];
  nativeContext: boolean;
  nativeWorld: boolean;
  hadActivation: boolean;
  hasHandler: boolean;
};
type ProbeWindow = typeof window & {
  audioProbe: {
    create(): Snapshot;
    snapshot(): Snapshot;
    untrusted(): void;
    arm(mode: "duplicates" | "destroy"): void;
    observation(): {
      before: Snapshot;
      after: Snapshot;
      trusted: boolean;
    } | null;
    closeContext(): Promise<void>;
    setup(): void;
    readyAgain(): void;
    queueNativeFailure(): void;
    destroyAudio(): void;
    dispose(): void;
  };
};

const probe = String.raw`
const world = new World();
let audio = null, disposed = false, observed = null;
const calls = [];
const snapshot = () => ({
  state: audio.ctx.state, unlocked: audio.unlocked, queued: audio.queue.length,
  calls: [...calls], nativeContext: audio.ctx instanceof AudioContext,
  nativeWorld: world instanceof World,
  hadActivation: navigator.userActivation.hasBeenActive,
  hasHandler: audio.unlockHandler !== null,
});
const untrusted = () => {
  for (const type of ["click", "touchend", "keydown"])
    document.dispatchEvent(new Event(type, {bubbles: true}));
};
function disposeAudio() {
  if (audio && !disposed) { disposed = true; audio.destroy(); }
}
globalThis.audioProbe = {
  create() {
    if (audio) throw new Error("Audio fixture already created");
    audio = new ClientAudio(world);
    // No source nodes are created; mute the real master bus as an extra guard.
    audio.masterGain.gain.value = 0;
    audio.ready(() => calls.push("one"));
    audio.ready(() => calls.push("two"));
    return snapshot();
  },
  snapshot, untrusted,
  arm(mode) {
    // Registered AFTER ClientAudio's document handler. The trusted click has
    // issued native resume(), but its awaited continuation cannot run until
    // this event stack returns. No browser/production methods are replaced.
    document.addEventListener("click", (event) => {
      const before = snapshot();
      if (mode === "destroy") disposeAudio();
      else for (let i = 0; i < 3; i++) audio.setupUnlockListener();
      untrusted();
      observed = {before, after: snapshot(), trusted: event.isTrusted};
    }, {once: true});
  },
  observation: () => observed,
  closeContext: () => audio.ctx.close(),
  setup: () => audio.setupUnlockListener(),
  readyAgain: () => audio.ready(() => calls.push("late")),
  queueNativeFailure: () => audio.ready(() => {
    calls.push("native-failure");
    // A trackless real MediaStream cannot form a native audio source.
    audio.ctx.createMediaStreamSource(new MediaStream());
  }),
  destroyAudio: disposeAudio,
  dispose() { disposeAudio(); world.destroy(); },
};`;

native("native ClientAudio gesture lifecycle", () => {
  let browser: Browser | undefined,
    context: BrowserContext | undefined,
    page: Page | undefined,
    cdp: CDPSession | undefined,
    server: Server | undefined;
  let origin = "";
  const pageErrors: string[] = [],
    consoleErrors: string[] = [],
    expectedConsoleErrors: string[] = [],
    unexpectedPaths: string[] = [];
  const remember = (list: string[], value: string) => {
    if (list.length < 32) list.push(value.slice(0, 1024));
  };
  const eventTypes = ["click", "touchstart", "touchend", "keydown"] as const;
  type Counts = Record<(typeof eventTypes)[number], number>;
  let baseline: Counts;

  /** Playwright evaluation grants user activation. Probe reads, setup and
   * cleanup must instead use the actual CDP no-gesture path; only input.click
   * may activate the page. Never suspend a context to manufacture this state. */
  async function evaluate<T>(callback: () => T): Promise<Awaited<T>> {
    const result = await cdp!.send("Runtime.evaluate", {
      expression: `(${callback.toString()})()`,
      userGesture: false,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    return result.result.value as Awaited<T>;
  }

  async function listeners(): Promise<Counts> {
    const owned = cdp!;
    try {
      const result = await owned.send("Runtime.evaluate", {
        expression: "document",
        objectGroup: "hyperia-audio-listeners",
        userGesture: false,
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text,
        );
      if (!result.result.objectId) throw new Error("Missing actual document");
      const observed = await owned.send("DOMDebugger.getEventListeners", {
        objectId: result.result.objectId,
      });
      return Object.fromEntries(
        eventTypes.map((type) => [
          type,
          observed.listeners.filter((listener) => listener.type === type)
            .length,
        ]),
      ) as Counts;
    } finally {
      await owned.send("Runtime.releaseObjectGroup", {
        objectGroup: "hyperia-audio-listeners",
      });
    }
  }

  async function closePage() {
    try {
      if (page && !page.isClosed() && cdp)
        await evaluate(() => (window as ProbeWindow).audioProbe?.dispose());
    } finally {
      cdp = undefined;
      page = undefined;
      const owned = context;
      context = undefined;
      await owned?.close();
    }
  }

  async function cleanup() {
    try {
      await closePage();
    } finally {
      try {
        const owned = browser;
        browser = undefined;
        await owned?.close();
      } finally {
        const owned = server;
        server = undefined;
        if (owned?.listening)
          await new Promise<void>((resolve, reject) => {
            owned.close((error) => (error ? reject(error) : resolve()));
            owned.closeAllConnections();
          });
      }
    }
  }

  beforeAll(async () => {
    try {
      const worldPath = fileURLToPath(
          new URL("../../../core/World.ts", import.meta.url),
        ),
        audioPath = fileURLToPath(
          new URL("../ClientAudio.ts", import.meta.url),
        );
      const built = await build({
        stdin: {
          contents:
            `import { World } from ${JSON.stringify(worldPath)};\n` +
            `import { ClientAudio } from ${JSON.stringify(audioPath)};\n` +
            probe,
          loader: "ts",
          resolveDir: fileURLToPath(new URL(".", import.meta.url)),
        },
        bundle: true,
        write: false,
        metafile: true,
        platform: "browser",
        format: "esm",
        target: "es2022",
        define: { "process.env": "{}" },
        // Same server-only boundary as the client library; never initialized
        // by this actual World constructor. No dependency is replaced by a stub.
        external: [
          "./PhysXManager.server",
          "./PhysXManager.server.js",
          "./storage.server",
          "./storage.server.js",
          "node:*",
          "os",
          "fs",
          "path",
          "url",
          "@hyperforge/physx-js-webidl",
        ],
      });
      expect(built.outputFiles).toHaveLength(1);
      const inputs = Object.keys(built.metafile.inputs);
      expect(inputs.some((path) => path.endsWith("/core/World.ts"))).toBe(true);
      expect(
        inputs.some((path) => path.endsWith("/client/ClientAudio.ts")),
      ).toBe(true);
      const source = built.outputFiles[0].text;
      server = createServer((request, response) => {
        if (request.url === "/") {
          response.setHeader("Content-Type", "text/html");
          response.end(
            '<!doctype html><meta charset="utf-8"><title>Native audio qualification</title><button id="gesture">Enable audio</button><script type="module" src="/probe.js"></script>',
          );
        } else if (request.url === "/probe.js") {
          response.setHeader("Content-Type", "text/javascript");
          response.end(source);
        } else if (request.url === "/favicon.ico") {
          response.statusCode = 204;
          response.end();
        } else {
          remember(unexpectedPaths, request.url ?? "missing URL");
          response.statusCode = 404;
          response.end();
        }
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => {
          server!.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing owned loopback port");
      origin = `http://127.0.0.1:${address.port}`;
      const { chromium } = await import("playwright");
      browser = await chromium.launch({
        channel: "chrome",
        headless: false,
        args: [
          "--use-angle=metal",
          "--enable-features=WebGPU,UnsafeWebGPU",
          "--autoplay-policy=document-user-activation-required",
        ],
        ignoreDefaultArgs: ["--autoplay-policy=no-user-gesture-required"],
      });
    } catch (error) {
      await cleanup();
      throw error;
    }
  }, 60_000);
  afterAll(cleanup, 15_000);

  beforeEach(async () => {
    pageErrors.length = 0;
    consoleErrors.length = 0;
    expectedConsoleErrors.length = 0;
    unexpectedPaths.length = 0;
    context = await browser!.newContext();
    page = await context.newPage();
    page.on("pageerror", (error) => remember(pageErrors, error.message));
    page.on("console", (message) => {
      if (message.type() === "error") remember(consoleErrors, message.text());
    });
    await page.goto(origin, { waitUntil: "load" });
    cdp = await context.newCDPSession(page);
    // load includes this module's synchronous execution; probing its presence
    // must not seed activation through Playwright's polling implementation.
    expect(
      await evaluate(() => Boolean((window as ProbeWindow).audioProbe)),
    ).toBe(true);
    baseline = await listeners();
    const initial = await evaluate(() =>
      (window as ProbeWindow).audioProbe.create(),
    );
    expect(initial).toMatchObject({
      state: "suspended",
      unlocked: false,
      queued: 2,
      calls: [],
      nativeContext: true,
      nativeWorld: true,
      hadActivation: false,
      hasHandler: true,
    });
    expect(await listeners()).toEqual({
      ...baseline,
      click: baseline.click + 1,
      touchend: baseline.touchend + 1,
      keydown: baseline.keydown + 1,
    });
  });
  afterEach(async () => {
    try {
      await closePage();
    } finally {
      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual(expectedConsoleErrors);
      expect(unexpectedPaths).toEqual([]);
    }
  }, 15_000);

  it("ignores pregesture events and drains once after a trusted gesture despite duplicate pending events", async () => {
    await evaluate(() => (window as ProbeWindow).audioProbe.untrusted());
    expect(
      await evaluate(() => (window as ProbeWindow).audioProbe.snapshot()),
    ).toMatchObject({
      state: "suspended",
      unlocked: false,
      queued: 2,
      calls: [],
      hadActivation: false,
    });
    await evaluate(() => (window as ProbeWindow).audioProbe.arm("duplicates"));
    await page!.getByRole("button", { name: "Enable audio" }).click();
    await expect
      .poll(
        async () =>
          (await evaluate(() => (window as ProbeWindow).audioProbe.snapshot()))
            .unlocked,
        { timeout: 10_000, interval: 50 },
      )
      .toBe(true);
    const observed = await evaluate(() =>
      (window as ProbeWindow).audioProbe.observation(),
    );
    expect(observed?.trusted).toBe(true);
    expect(observed?.before).toMatchObject({
      unlocked: false,
      queued: 2,
      calls: [],
      hadActivation: true,
    });
    expect(observed?.after).toMatchObject({
      unlocked: false,
      queued: 2,
      calls: [],
    });
    expect(
      await evaluate(() => (window as ProbeWindow).audioProbe.snapshot()),
    ).toMatchObject({
      state: "running",
      unlocked: true,
      queued: 0,
      calls: ["two", "one"],
      hasHandler: false,
    });
    expect(await listeners()).toEqual(baseline);
    await evaluate(() => {
      const probe = (window as ProbeWindow).audioProbe;
      probe.untrusted();
      probe.setup();
      probe.readyAgain();
    });
    expect(
      (await evaluate(() => (window as ProbeWindow).audioProbe.snapshot()))
        .calls,
    ).toEqual(["two", "one", "late"]);
    expect(await listeners()).toEqual(baseline);
  });

  it("reports a native ready-callback failure without rejecting the gesture handler or retrying the remaining queue", async () => {
    await evaluate(() =>
      (window as ProbeWindow).audioProbe.queueNativeFailure(),
    );
    await page!.getByRole("button", { name: "Enable audio" }).click();
    await expect
      .poll(() => consoleErrors.length, { timeout: 10_000, interval: 50 })
      .toBe(1);
    expect(consoleErrors[0]).toMatch(
      /^Audio unlocked, but a ready callback failed: /,
    );
    expect(consoleErrors[0]).toContain("InvalidStateError");
    // Permit exactly this inspected diagnostic for this test, never pageerrors
    // or another callback/native-resume error, including during teardown.
    expectedConsoleErrors.push(consoleErrors[0]);
    expect(
      await evaluate(() => (window as ProbeWindow).audioProbe.snapshot()),
    ).toMatchObject({
      state: "running",
      unlocked: true,
      queued: 2,
      calls: ["native-failure"],
      hasHandler: false,
    });
    expect(await listeners()).toEqual(baseline);
    await evaluate(() => {
      const probe = (window as ProbeWindow).audioProbe;
      probe.untrusted();
      probe.setup();
      probe.readyAgain();
    });
    await page!.getByRole("button", { name: "Enable audio" }).click();
    // Preserve historical LIFO abort-on-throw behavior: the failed callback is
    // popped, the earlier two stay queued, and new ready callbacks run directly.
    expect(
      await evaluate(() => (window as ProbeWindow).audioProbe.snapshot()),
    ).toMatchObject({
      state: "running",
      unlocked: true,
      queued: 2,
      calls: ["native-failure", "late"],
      hasHandler: false,
    });
    expect(await listeners()).toEqual(baseline);
    await evaluate(() => (window as ProbeWindow).audioProbe.destroyAudio());
    await expect
      .poll(
        async () =>
          (await evaluate(() => (window as ProbeWindow).audioProbe.snapshot()))
            .state,
        { timeout: 10_000, interval: 50 },
      )
      .toBe("closed");
    expect(
      await evaluate(() => (window as ProbeWindow).audioProbe.snapshot()),
    ).toMatchObject({ queued: 0, calls: ["native-failure", "late"] });
    expect(await listeners()).toEqual(baseline);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual(expectedConsoleErrors);
  });

  it("never unlocks a genuinely closed context and removes its gesture listeners", async () => {
    await evaluate(() => (window as ProbeWindow).audioProbe.closeContext());
    await page!.getByRole("button", { name: "Enable audio" }).click();
    expect(
      await evaluate(() => (window as ProbeWindow).audioProbe.snapshot()),
    ).toMatchObject({
      state: "closed",
      unlocked: false,
      calls: [],
      hasHandler: false,
    });
    await evaluate(() => (window as ProbeWindow).audioProbe.setup());
    expect(await listeners()).toEqual(baseline);
  });

  it("does not drain or reinstall listeners when destroyed before native resume completes", async () => {
    await evaluate(() => (window as ProbeWindow).audioProbe.arm("destroy"));
    await page!.getByRole("button", { name: "Enable audio" }).click();
    await expect
      .poll(
        async () =>
          (await evaluate(() => (window as ProbeWindow).audioProbe.snapshot()))
            .state,
        { timeout: 10_000, interval: 50 },
      )
      .toBe("closed");
    const observed = await evaluate(() =>
      (window as ProbeWindow).audioProbe.observation(),
    );
    expect(observed?.trusted).toBe(true);
    expect(observed?.before).toMatchObject({
      unlocked: false,
      queued: 2,
      calls: [],
      hadActivation: true,
    });
    expect(observed?.after).toMatchObject({
      unlocked: false,
      queued: 0,
      calls: [],
      hasHandler: false,
    });
    expect(
      await evaluate(() => (window as ProbeWindow).audioProbe.snapshot()),
    ).toMatchObject({
      state: "closed",
      unlocked: false,
      queued: 0,
      calls: [],
      hasHandler: false,
    });
    expect(await listeners()).toEqual(baseline);
  });
});
