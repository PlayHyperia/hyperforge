import { performance } from "node:perf_hooks";

const CLOSE_TIMEOUT_MS = 2_000;
const KILL_TIMEOUT_MS = 2_000;
const EXIT_TIMEOUT_MS = 1_000;

function operationError(label, kind, timeoutMs) {
  const error = new Error(
    kind === "abort"
      ? `${label} aborted`
      : `${label} timed out after ${timeoutMs}ms`,
  );
  error.name = kind === "abort" ? "AbortError" : "TimeoutError";
  return error;
}

/** Bounds operations, including APIs such as evaluate/CDP.send without timeouts. */
export function runDuelViewerOperation(
  operation,
  { signal, timeoutMs, label },
) {
  if (
    typeof operation !== "function" ||
    typeof label !== "string" ||
    !label.trim() ||
    label.length > 200
  ) {
    return Promise.reject(
      new Error("Viewer operation requires a function and a bounded label"),
    );
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120_000
  ) {
    return Promise.reject(
      new Error("Viewer operation timeout must be 1..120000ms"),
    );
  }
  if (signal && !(signal instanceof AbortSignal)) {
    return Promise.reject(
      new Error("Viewer operation signal must be an AbortSignal"),
    );
  }
  if (signal?.aborted)
    return Promise.reject(operationError(label, "abort", timeoutMs));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () =>
      finish(reject, operationError(label, "abort", timeoutMs));
    const timer = setTimeout(
      () => finish(reject, operationError(label, "timeout", timeoutMs)),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    // Both handlers stay attached after cancellation, so a later protocol
    // rejection cannot become unhandled. A pre-invocation abort calls no API.
    Promise.resolve()
      .then(() => (settled ? undefined : operation()))
      .then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
  });
}

/** Owns a fresh 2D HLS browser; never connects to an external/user browser. */
export async function launchOwnedDuelViewer({
  chromium,
  signal,
  timeoutMs = 15_000,
  onOwnedProcess,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("Owned viewer launch timeout must be 1..30000ms");
  }
  if (onOwnedProcess !== undefined && typeof onOwnedProcess !== "function") {
    throw new Error("Owned viewer ownership callback must be a function");
  }
  let server = null;
  let browser = null;
  let ownedProcess = null;
  let abandoned = false;
  let launchPromise = null;
  let launchSettled = false;
  let connectionPromise = null;
  let connectionSettled = false;
  let closePromise = null;
  let stage = "launch";
  const diagnostic = {
    ownedPid: null,
    closed: false,
    forcedCleanup: false,
    processExited: false,
    processGroupGone: false,
    browserDisconnected: false,
    errors: [],
  };
  const snapshot = () => ({ ...diagnostic, errors: [...diagnostic.errors] });
  const recordError = (label) => {
    if (diagnostic.errors.length < 8 && !diagnostic.errors.includes(label))
      diagnostic.errors.push(label);
  };
  const processOrGroupAlive = (group) => {
    if (!diagnostic.ownedPid) return false;
    try {
      process.kill(
        group && process.platform !== "win32"
          ? -ownedProcess.pid
          : ownedProcess.pid,
        0,
      );
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      recordError("owned process inspection failed");
      return true;
    }
  };
  const updateClosure = () => {
    diagnostic.processExited = Boolean(
      diagnostic.ownedPid &&
      ownedProcess &&
      (ownedProcess.exitCode !== null || ownedProcess.signalCode !== null) &&
      !processOrGroupAlive(false),
    );
    diagnostic.processGroupGone = Boolean(
      diagnostic.ownedPid && !processOrGroupAlive(true),
    );
    diagnostic.browserDisconnected = !browser || !browser.isConnected();
    diagnostic.closed =
      diagnostic.processExited &&
      diagnostic.processGroupGone &&
      diagnostic.browserDisconnected;
  };
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (!server) {
        recordError("browser ownership was not established");
        return snapshot();
      }
      // Cleanup intentionally has no work AbortSignal: cancellation must not
      // cancel the very operation responsible for removing the owned browser.
      try {
        await runDuelViewerOperation(() => server.close(), {
          timeoutMs: CLOSE_TIMEOUT_MS,
          label: "owned viewer close",
        });
      } catch {
        diagnostic.forcedCleanup = true;
        recordError("graceful browser close failed or timed out");
      }
      updateClosure();
      if (!diagnostic.processExited || !diagnostic.processGroupGone) {
        diagnostic.forcedCleanup = true;
        try {
          await runDuelViewerOperation(() => server.kill(), {
            timeoutMs: KILL_TIMEOUT_MS,
            label: "owned viewer kill",
          });
        } catch {
          recordError("BrowserServer kill failed or timed out");
        }
        if (processOrGroupAlive(true)) {
          // Playwright launchServer creates a detached POSIX process group.
          // Keep its exact handle: a dead leader can leave silent descendants,
          // which BrowserServer.kill may skip after its root has already exited.
          try {
            if (process.platform === "win32") ownedProcess.kill("SIGKILL");
            else process.kill(-ownedProcess.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH")
              recordError("exact owned process-group kill failed");
          }
        }
      }
      const deadline = performance.now() + EXIT_TIMEOUT_MS;
      updateClosure();
      while (!diagnostic.closed && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        updateClosure();
      }
      if (!diagnostic.closed)
        recordError(
          "owned browser process or connection remains after cleanup deadline",
        );
      return snapshot();
    })();
    return closePromise;
  };
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const ms = Math.ceil(deadline - performance.now());
    if (ms < 1)
      throw operationError("owned viewer startup", "timeout", timeoutMs);
    return ms;
  };
  try {
    await runDuelViewerOperation(
      () => {
        launchPromise = chromium
          .launchServer({
            headless: true,
            host: "127.0.0.1",
            timeout: remaining(),
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false,
          })
          .then(async (launched) => {
            server = launched;
            ownedProcess = server.process();
            if (
              !Number.isSafeInteger(ownedProcess?.pid) ||
              ownedProcess.pid < 2 ||
              ownedProcess.pid === process.pid
            ) {
              throw new Error("BrowserServer did not expose its owned process");
            }
            diagnostic.ownedPid = ownedProcess.pid;
            if (abandoned) await close();
            return server;
          });
        launchPromise.then(
          () => {
            launchSettled = true;
          },
          () => {
            launchSettled = true;
          },
        );
        return launchPromise;
      },
      { signal, timeoutMs: remaining(), label: "owned viewer launch" },
    );
    stage = "ownership callback";
    if (onOwnedProcess) {
      await runDuelViewerOperation(
        () => onOwnedProcess({ pid: diagnostic.ownedPid }),
        {
          signal,
          timeoutMs: remaining(),
          label: "owned viewer ownership callback",
        },
      );
    }
    stage = "connection";
    await runDuelViewerOperation(
      () => {
        connectionPromise = chromium
          .connect(server.wsEndpoint(), { timeout: remaining() })
          .then(async (connected) => {
            browser = connected;
            if (abandoned) {
              await runDuelViewerOperation(() => connected.close(), {
                timeoutMs: CLOSE_TIMEOUT_MS,
                label: "late viewer connection close",
              });
            }
            return connected;
          });
        connectionPromise.then(
          () => {
            connectionSettled = true;
          },
          () => {
            connectionSettled = true;
          },
        );
        return connectionPromise;
      },
      { signal, timeoutMs: remaining(), label: "owned viewer connection" },
    );
    if (
      !browser.isConnected() ||
      ownedProcess.exitCode !== null ||
      ownedProcess.signalCode !== null ||
      !processOrGroupAlive(false)
    ) {
      throw new Error("Owned viewer disconnected before startup completed");
    }
    return {
      browser,
      ownedPid: diagnostic.ownedPid,
      close,
      get diagnostic() {
        return snapshot();
      },
    };
  } catch (error) {
    abandoned = true;
    if (launchPromise && !launchSettled) {
      // launchServer has a native deadline but no AbortSignal. Retain its
      // promise and clean any late-created server before leaving when possible.
      // The continuation above remains attached even if this final bound expires.
      try {
        await runDuelViewerOperation(() => launchPromise, {
          timeoutMs:
            timeoutMs + CLOSE_TIMEOUT_MS + KILL_TIMEOUT_MS + EXIT_TIMEOUT_MS,
          label: "abandoned viewer launch cleanup",
        });
      } catch {
        if (!launchSettled)
          recordError("launch cleanup settlement exceeded its bound");
      }
    }
    if (server) await close();
    if (connectionPromise) {
      try {
        await runDuelViewerOperation(() => connectionPromise, {
          timeoutMs: CLOSE_TIMEOUT_MS,
          label: "abandoned viewer connection cleanup",
        });
      } catch {
        if (!connectionSettled) {
          diagnostic.closed = false;
          recordError("connection cleanup settlement exceeded its bound");
        }
      }
    }
    const failureName =
      error?.name === "AbortError" || error?.name === "TimeoutError"
        ? error.name
        : "Error";
    const failure = new Error(
      `Owned duel viewer ${stage} failed (${failureName === "AbortError" ? "aborted" : failureName === "TimeoutError" ? "timed out" : "operation rejected"})`,
    );
    failure.name = failureName;
    // Retain safe ownership/cleanup evidence, never the private wsEndpoint URL.
    Object.defineProperty(failure, "viewerDiagnostic", { get: snapshot });
    throw failure;
  }
}
