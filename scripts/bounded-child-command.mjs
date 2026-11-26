import { spawn } from "node:child_process";

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

/**
 * Run a captured command in its own POSIX process group. Cancellation waits for
 * close (including inherited pipes) and group removal, not merely root exit.
 * Output is bounded and never interpolated into the error message automatically.
 */
export function runBoundedChildCommand(
  command,
  args,
  {
    label,
    cwd,
    env,
    signal,
    timeoutMs,
    maxBuffer = 1024 * 1024,
    terminationGraceMs = 1_000,
    killGraceMs = 1_000,
  } = {},
) {
  if (
    typeof command !== "string" ||
    command.length === 0 ||
    command.includes("\0") ||
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  ) {
    throw new Error("Bounded command and string arguments are required");
  }
  if (typeof label !== "string" || !label.trim() || label.length > 200) {
    throw new Error("Bounded child label is required (at most 200 characters)");
  }
  if (process.platform === "win32") {
    throw new Error("Bounded captured commands require POSIX process groups");
  }
  for (const [value, name] of [
    [timeoutMs, "timeout"],
    [terminationGraceMs, "termination grace"],
    [killGraceMs, "kill grace"],
    [maxBuffer, "output limit"],
  ]) {
    positiveSafeInteger(value, `Bounded child ${name}`);
    if (value > 2_147_483_647) {
      throw new Error(`Bounded child ${name} exceeds the supported bound`);
    }
  }
  if (terminationGraceMs + killGraceMs > 2_147_483_647) {
    throw new Error(
      "Bounded child combined cleanup grace exceeds the supported bound",
    );
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new Error("Bounded child signal must be an AbortSignal");
  }
  if (signal?.aborted) {
    return Promise.reject(
      Object.assign(new Error(`${label} aborted before launch`), {
        name: "AbortError",
        code: "CHILD_ABORTED",
        stdout: "",
        stderr: "",
        ownedPid: null,
        closed: true,
        processGroupGone: true,
        cleanupComplete: true,
        forcedCleanup: false,
      }),
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // This ID comes only from our detached spawn, never process discovery.
    const ownedPid = child.pid ?? null;
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let closed = false;
    let settled = false;
    let failure = null;
    let forcedCleanup = false;
    let exitCode = null;
    let exitSignal = null;
    let timeout = null;
    let escalation = null;
    let cleanupDeadline = null;
    let cleanupPoll = null;

    const decodeOutput = (chunks) => {
      const captured = Buffer.concat(chunks);
      const decoded = captured.toString("utf8");
      const encoded = Buffer.from(decoded);
      // Invalid/truncated UTF-8 may expand into replacement characters. Keep
      // even that diagnostic within its share of the combined byte budget.
      return encoded.length <= captured.length
        ? decoded
        : new TextDecoder("utf-8", { ignoreBOM: true }).decode(
            encoded.subarray(0, captured.length),
            { stream: true },
          );
    };

    const groupGone = () => {
      if (ownedPid === null) return true;
      try {
        process.kill(-ownedPid, 0);
        return false;
      } catch (error) {
        return error?.code === "ESRCH";
      }
    };
    const signalGroup = (terminationSignal) => {
      if (ownedPid === null) return;
      try {
        process.kill(-ownedPid, terminationSignal);
      } catch {
        // Final close/group inspection decides whether cleanup really succeeded.
      }
    };
    const settle = (cleanupExpired = false) => {
      if (settled) return;
      const processGroupGone = groupGone();
      const cleanupComplete = closed && processGroupGone;
      if (!cleanupComplete && !cleanupExpired) return;
      settled = true;
      for (const timer of [timeout, escalation, cleanupDeadline]) {
        if (timer !== null) clearTimeout(timer);
      }
      if (cleanupPoll !== null) clearInterval(cleanupPoll);
      signal?.removeEventListener("abort", onAbort);
      const result = {
        stdout: decodeOutput(stdout),
        stderr: decodeOutput(stderr),
        ownedPid,
        closed,
        processGroupGone,
        cleanupComplete,
        forcedCleanup,
        exitCode,
        exitSignal,
      };
      if (!cleanupComplete) {
        failure = Object.assign(
          new Error(`${label} cleanup did not complete`),
          {
            code: "CHILD_CLEANUP_INCOMPLETE",
            cause: failure,
          },
        );
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      if (failure) reject(Object.assign(failure, result));
      else resolve(result);
    };
    const terminate = (error) => {
      if (settled || failure) return;
      failure = error;
      signalGroup("SIGTERM");
      escalation = setTimeout(() => {
        if (settled) return;
        forcedCleanup = true;
        signalGroup("SIGKILL");
        settle();
      }, terminationGraceMs);
      cleanupDeadline = setTimeout(
        () => settle(true),
        terminationGraceMs + killGraceMs,
      );
      cleanupPoll = setInterval(() => settle(), 20);
      settle();
    };
    const onAbort = () =>
      terminate(
        Object.assign(new Error(`${label} aborted`), {
          name: "AbortError",
          code: "CHILD_ABORTED",
        }),
      );
    const capture = (chunks, chunk) => {
      const remaining = maxBuffer - capturedBytes;
      const retained = chunk.subarray(0, remaining);
      if (retained.length) chunks.push(retained);
      capturedBytes += retained.length;
      if (chunk.length > remaining) {
        terminate(
          Object.assign(
            new Error(`${label} exceeded its captured output limit`),
            {
              code: "CHILD_OUTPUT_LIMIT",
            },
          ),
        );
      }
    };
    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.once("error", () => {
      terminate(
        Object.assign(new Error(`${label} could not run`), {
          code: "CHILD_PROCESS_ERROR",
        }),
      );
    });
    child.once("close", (code, terminationSignal) => {
      closed = true;
      exitCode = code;
      exitSignal = terminationSignal;
      if (!failure && (code !== 0 || terminationSignal !== null)) {
        terminate(
          Object.assign(
            new Error(
              `${label} exited with code=${code ?? "null"} signal=${terminationSignal ?? "null"}`,
            ),
            { code: "CHILD_EXIT_NONZERO" },
          ),
        );
      } else if (!failure && !groupGone()) {
        terminate(
          Object.assign(
            new Error(`${label} left an owned descendant running`),
            {
              code: "CHILD_DESCENDANT_REMAINED",
            },
          ),
        );
      }
      settle();
    });
    timeout = setTimeout(
      () =>
        terminate(
          Object.assign(new Error(`${label} timed out after ${timeoutMs}ms`), {
            name: "TimeoutError",
            code: "CHILD_TIMEOUT",
          }),
        ),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * Await one already-spawned child with an optional hard deadline. A timed-out
 * command is first asked to terminate, then killed if it ignores the grace
 * period. The promise never reports a timed-out exit as success.
 */
export function waitForBoundedChildExit(
  child,
  { label, timeoutMs = null, terminationGraceMs = 5_000 } = {},
) {
  if (
    !child ||
    typeof child.once !== "function" ||
    typeof child.kill !== "function"
  ) {
    throw new Error("Bounded child process is required");
  }
  if (typeof label !== "string" || label.trim().length === 0) {
    throw new Error("Bounded child label is required");
  }
  const boundedTimeoutMs =
    timeoutMs === null
      ? null
      : positiveSafeInteger(timeoutMs, "Bounded child timeout");
  const boundedTerminationGraceMs = positiveSafeInteger(
    terminationGraceMs,
    "Bounded child termination grace",
  );

  return new Promise((resolve, reject) => {
    let timeout = null;
    let killEscalation = null;
    let timedOut = false;
    let settled = false;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (killEscalation) clearTimeout(killEscalation);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };
    const settle = (operation) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onError = (error) => settle(() => reject(error));
    const onExit = (code, signal) => {
      if (timedOut) {
        settle(() =>
          reject(
            new Error(
              `${label} timed out after ${boundedTimeoutMs}ms (code=${code ?? "null"} signal=${signal ?? "null"})`,
            ),
          ),
        );
        return;
      }
      if (code === 0) {
        settle(() => resolve({ code, signal }));
        return;
      }
      settle(() =>
        reject(
          new Error(
            `${label} exited with code=${code ?? "null"} signal=${signal ?? "null"}`,
          ),
        ),
      );
    };

    child.once("error", onError);
    child.once("exit", onExit);
    if (boundedTimeoutMs !== null) {
      timeout = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // The exit/error listener remains the single settlement authority.
        }
        killEscalation = setTimeout(() => {
          if (settled) return;
          try {
            child.kill("SIGKILL");
          } catch {
            // The exit/error listener remains the single settlement authority.
          }
        }, boundedTerminationGraceMs);
        killEscalation.unref?.();
      }, boundedTimeoutMs);
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
    }
  });
}
