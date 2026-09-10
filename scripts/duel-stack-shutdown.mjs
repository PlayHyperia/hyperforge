import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { release } from "node:os";

const MAX_PROTOCOL_LINE_BYTES = 16_384;
const RESIDUAL_GRACE_MS = 5_000;
const KILL_GRACE_MS = 2_000;
const TERMINAL_FIELDS = [
  "sourceEpoch",
  "terminalFrameSeq",
  "duelId",
  "duelKeyHex",
  "competitiveSnapshotDigest",
  "outcome",
  "cancellationReason",
];
const COMPLETE_FIELDS = ["event", ...TERMINAL_FIELDS, "downstreamAcknowledged"];
const PROTOCOL_MARKER = /"event"\s*:\s*"shutdown-(?:complete|failed)/u;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PROCESS_DIAGNOSTIC_BOUNDS = Object.freeze({
  errorReceipts: 8,
  metadataSamples: 4,
  ownedProcessReceipts: 64,
  timeoutMs: 250,
  outputBytes: 131_072,
  groupRows: 32,
});

function inspectionErrorFields(error) {
  return {
    code: typeof error.code === "string" ? error.code.slice(0, 64) : null,
    errno: typeof error.errno === "number" ? error.errno : null,
    syscall:
      typeof error.syscall === "string" ? error.syscall.slice(0, 64) : null,
    message: String(error.message ?? error).slice(0, 512),
  };
}

/**
 * Read-only metadata for a launcher-owned detached ChildProcess, never a source
 * of new signal targets. No command lines, environment, or unrelated rows leave
 * this function. The ps sample is later than kill(0), not an atomic explanation
 * of that syscall; an absent row cannot turn EPERM into successful cleanup.
 */
export function inspectOwnedProcessGroupMetadata(proc) {
  const pid = proc?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Process diagnostics require an owned positive child PID");
  }
  const startedAt = Date.now();
  const started = performance.now();
  const base = {
    ownedPid: pid,
    ownedPgid: process.platform === "win32" ? null : pid,
    ownershipBasis:
      "Caller-owned detached ChildProcess; PGID assumed from spawn policy, not independently established generation identity",
    startedAt,
    source: "numeric-only ps snapshot filtered to exact owned PID or PGID",
    rows: [],
  };
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return { ...base, status: "unsupported-platform", completedAt: Date.now() };
  }
  const result = spawnSync(
    "/bin/ps",
    ["-axo", "pid=,ppid=,pgid=,uid=,stat=,etime="],
    {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      timeout: PROCESS_DIAGNOSTIC_BOUNDS.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: PROCESS_DIAGNOSTIC_BOUNDS.outputBytes,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const completion = {
    completedAt: Date.now(),
    elapsedMs: performance.now() - started,
    exitCode: result.status,
    signal: result.signal,
    stderrBytes: Buffer.byteLength(result.stderr ?? ""),
  };
  if (result.error || result.status !== 0) {
    return {
      ...base,
      ...completion,
      status: "inspection-failed",
      error: result.error ? inspectionErrorFields(result.error) : null,
    };
  }
  let matchingRows = 0;
  let invalidRows = 0;
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/u);
    if (
      fields.length !== 6 ||
      !fields.slice(0, 4).every((field) => /^\d+$/u.test(field)) ||
      !/^[A-Za-z+<>-]{1,16}$/u.test(fields[4]) ||
      !/^[\d:-]{1,32}$/u.test(fields[5])
    ) {
      invalidRows++;
      continue;
    }
    const [rowPid, ppid, pgid, uid] = fields.slice(0, 4).map(Number);
    if (![rowPid, ppid, pgid, uid].every(Number.isSafeInteger)) {
      invalidRows++;
      continue;
    }
    if (rowPid !== pid && pgid !== pid) continue;
    matchingRows++;
    if (base.rows.length < PROCESS_DIAGNOSTIC_BOUNDS.groupRows) {
      base.rows.push({
        pid: rowPid,
        ppid,
        pgid,
        uid,
        state: fields[4],
        elapsed: fields[5],
      });
    }
  }
  return {
    ...base,
    ...completion,
    status: invalidRows ? "partial-parse" : "observed",
    matchingRows,
    rowsTruncated: matchingRows > base.rows.length,
    invalidRows,
  };
}

function observeOwnedLeader(entry) {
  const proc = entry.proc;
  const initial = {
    at: Date.now(),
    exitCode: proc.exitCode,
    signalCode: proc.signalCode,
    closeAlreadyObserved: null,
  };
  let exit = null;
  let close = null;
  const onExit = (code, signal) => {
    exit = { at: Date.now(), code, signal };
  };
  const onClose = (code, signal) => {
    close = { at: Date.now(), code, signal };
  };
  proc.once("exit", onExit);
  proc.once("close", onClose);
  return {
    snapshot: () => ({
      name: entry.name,
      ownedPid: proc.pid,
      ownedPgid: process.platform === "win32" ? null : proc.pid,
      initial,
      current: {
        at: Date.now(),
        exitCode: proc.exitCode,
        signalCode: proc.signalCode,
        killed: proc.killed,
      },
      exitObservedSinceShutdownEntry: exit,
      closeObservedSinceShutdownEntry: close,
      scope:
        "ChildProcess fields and events observed since shutdown entry only; earlier close history and PID/PGID reuse are not established",
    }),
    dispose: () => {
      proc.removeListener("exit", onExit);
      proc.removeListener("close", onClose);
    },
  };
}

function createProcessGroupDiagnostics(entries) {
  const leaders = new Map();
  let omittedOwnedProcesses = 0;
  for (const entry of entries) {
    if (!entry.proc?.pid || leaders.has(entry.proc)) continue;
    if (leaders.size >= PROCESS_DIAGNOSTIC_BOUNDS.ownedProcessReceipts) {
      omittedOwnedProcesses++;
      continue;
    }
    leaders.set(entry.proc, observeOwnedLeader(entry));
  }
  const errors = new Map();
  let metadataSamples = 0;
  let inspectionErrorCount = 0;
  let omittedInspectionErrors = 0;
  return {
    recordInspectionError(entry, error, phase) {
      inspectionErrorCount++;
      const observedAt = Date.now();
      const leader = leaders.get(entry.proc)?.snapshot() ?? null;
      const existing = errors.get(entry.proc);
      if (existing) {
        existing.occurrences++;
        existing.lastObservedAt = observedAt;
        existing.lastPhase = phase;
        existing.lastError = inspectionErrorFields(error);
        existing.leaderAtLastError = leader;
        return;
      }
      if (errors.size >= PROCESS_DIAGNOSTIC_BOUNDS.errorReceipts) {
        omittedInspectionErrors++;
        return;
      }
      const receipt = {
        name: entry.name,
        ownedPid: entry.proc.pid,
        ownedPgid: process.platform === "win32" ? null : entry.proc.pid,
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        firstPhase: phase,
        lastPhase: phase,
        occurrences: 1,
        firstError: inspectionErrorFields(error),
        lastError: inspectionErrorFields(error),
        leaderAtFirstError: leader,
        leaderAtLastError: leader,
        metadata: { status: "sample-budget-exhausted", rows: [] },
      };
      errors.set(entry.proc, receipt);
      if (metadataSamples < PROCESS_DIAGNOSTIC_BOUNDS.metadataSamples) {
        metadataSamples++;
        try {
          receipt.metadata = inspectOwnedProcessGroupMetadata(entry.proc);
        } catch (diagnosticError) {
          // Diagnostic failure cannot abort cleanup or erase its original error.
          receipt.metadata = {
            status: "inspection-threw",
            error: inspectionErrorFields(diagnosticError),
            rows: [],
          };
        }
      }
    },
    receipt: () => ({
      schemaVersion: 1,
      runtime: {
        platform: process.platform,
        architecture: process.arch,
        kernelRelease: release(),
        nodeVersion: process.versions.node,
        bunVersion: process.versions.bun ?? null,
        launcherPid: process.pid,
        launcherPpid: process.ppid,
        uid: process.getuid?.() ?? null,
        effectiveUid: process.geteuid?.() ?? null,
      },
      bounds: PROCESS_DIAGNOSTIC_BOUNDS,
      scope:
        "Only original caller-owned detached ChildProcess handles; no discovered PID is signaled. Leader events are observed from shutdown entry, and ps is a later non-atomic OS snapshot, not proof of the identity or permission state at kill(0).",
      failClosedPolicy:
        "Every process-group inspection error remains a shutdown failure, including EPERM even if later observations find no remaining group. Diagnostic metadata never changes that verdict.",
      inspectionErrorCount,
      omittedInspectionErrors,
      metadataSamples,
      errors: [...errors.values()],
      ownedProcesses: [...leaders.values()].map((leader) => leader.snapshot()),
      omittedOwnedProcesses,
    }),
    dispose: () => {
      for (const leader of leaders.values()) leader.dispose();
    },
  };
}

function duration(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be ${minimum}..${maximum}`);
  }
  return value;
}

export function resolveDuelStackShutdownPolicy(env = process.env) {
  const rawGrace = env.DUEL_STACK_SHUTDOWN_GRACE_MS?.trim() || "24000";
  if (!/^\d+$/u.test(rawGrace)) {
    throw new Error("DUEL_STACK_SHUTDOWN_GRACE_MS must be 2000..30000");
  }
  const graceMs = duration(
    Number(rawGrace),
    "DUEL_STACK_SHUTDOWN_GRACE_MS",
    2_000,
    30_000,
  );
  const requiresAcknowledgement = Boolean(
    env.STREAMING_DUEL_SHUTDOWN_ACK_URL?.trim(),
  );
  let ackTimeoutMs = 0;
  if (requiresAcknowledgement) {
    const rawAck =
      env.STREAMING_DUEL_SHUTDOWN_ACK_TIMEOUT_MS?.trim() || "15000";
    if (!/^\d+$/u.test(rawAck)) {
      throw new Error(
        "STREAMING_DUEL_SHUTDOWN_ACK_TIMEOUT_MS must be 1000..20000",
      );
    }
    ackTimeoutMs = duration(
      Number(rawAck),
      "STREAMING_DUEL_SHUTDOWN_ACK_TIMEOUT_MS",
      1_000,
      20_000,
    );
  }
  // The server first waits up to 5s for its exact terminal frame, THEN for
  // downstream acknowledgement. Neither interval may consume cleanup margin.
  if (graceMs < 5_000 + ackTimeoutMs + 2_000) {
    throw new Error(
      "DUEL_STACK_SHUTDOWN_GRACE_MS must cover the 5000ms terminal wait, configured ACK timeout, and 2000ms cleanup margin",
    );
  }
  return {
    graceMs,
    requiresAcknowledgement,
    totalGraceMs: graceMs + RESIDUAL_GRACE_MS + KILL_GRACE_MS,
  };
}

export function parseGameServerShutdownCompletion(
  line,
  requiresAcknowledgement,
) {
  const record = JSON.parse(line);
  if (record?.event === "shutdown-failed") {
    throw new Error("game-server reported shutdown-failed");
  }
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).length !== COMPLETE_FIELDS.length ||
    !COMPLETE_FIELDS.every((key) => Object.hasOwn(record, key)) ||
    record.event !== "shutdown-complete" ||
    typeof record.downstreamAcknowledged !== "boolean"
  ) {
    throw new Error("malformed game-server shutdown completion");
  }
  if (TERMINAL_FIELDS.every((key) => record[key] === null)) {
    if (record.downstreamAcknowledged !== false) {
      throw new Error(
        "no-cycle shutdown cannot claim downstream acknowledgement",
      );
    }
    return record;
  }
  if (
    !Number.isSafeInteger(record.sourceEpoch) ||
    record.sourceEpoch < 1 ||
    !Number.isSafeInteger(record.terminalFrameSeq) ||
    record.terminalFrameSeq < 1 ||
    typeof record.duelId !== "string" ||
    record.duelId.trim() !== record.duelId ||
    record.duelId.length < 1 ||
    record.duelId.length > 256 ||
    !/^[a-f0-9]{64}$/u.test(record.duelKeyHex) ||
    !/^[a-f0-9]{64}$/u.test(record.competitiveSnapshotDigest) ||
    record.outcome !== "cancelled" ||
    record.cancellationReason !== "scheduler_shutdown"
  ) {
    throw new Error("malformed exact game-server shutdown terminal identity");
  }
  if (requiresAcknowledgement && record.downstreamAcknowledged !== true) {
    throw new Error(
      "game-server shutdown omitted required downstream acknowledgement",
    );
  }
  return record;
}

/** Observe from spawn, before any output filtering; one monitor per generation. */
export function observeGameServerShutdown(proc, policy) {
  const state = {
    proc,
    policy,
    requested: false,
    completion: null,
    failure: null,
    closed: false,
    code: null,
    signal: null,
  };
  const fail = (message) => {
    state.failure ??= message;
  };
  for (const stream of [proc.stdout, proc.stderr]) {
    if (!stream) {
      fail("game-server shutdown protocol requires both output pipes");
      continue;
    }
    stream.setEncoding("utf8");
    let buffer = "";
    let discarded = false;
    let beganBeforeRequest = false;
    let markerTail = "";
    let lineHasMarker = false;
    const flush = () => {
      if (PROTOCOL_MARKER.test(buffer)) {
        if (!state.requested || beganBeforeRequest) {
          fail(
            "game-server shutdown result predates this generation's shutdown request",
          );
        } else if (state.completion) {
          fail("duplicate game-server shutdown result");
        } else {
          try {
            state.completion = parseGameServerShutdownCompletion(
              buffer.trim(),
              policy.requiresAcknowledgement,
            );
          } catch (error) {
            fail(
              error instanceof SyntaxError
                ? "malformed game-server shutdown JSON"
                : error.message,
            );
          }
        }
      }
      buffer = "";
      discarded = false;
      markerTail = "";
      lineHasMarker = false;
    };
    stream.on("data", (chunk) => {
      // Chunk splitting does not permit an oversized line to grow indefinitely.
      for (const part of chunk.split(/(?<=\n)/u)) {
        if (!buffer && !discarded) beganBeforeRequest = !state.requested;
        lineHasMarker ||= PROTOCOL_MARKER.test(markerTail + part);
        markerTail = part.slice(-64);
        if (!discarded) {
          const available = MAX_PROTOCOL_LINE_BYTES - Buffer.byteLength(buffer);
          if (Buffer.byteLength(part) > available) {
            // Do not retain a partial multibyte character or an unbounded line.
            discarded = true;
          } else {
            buffer += part;
          }
        }
        if (discarded && lineHasMarker)
          fail("game-server shutdown protocol line exceeded its bound");
        if (part.endsWith("\n")) {
          if (discarded) {
            buffer = "";
            discarded = false;
            markerTail = "";
            lineHasMarker = false;
          } else flush();
        }
      }
    });
    stream.on("end", flush);
    stream.on("error", () => fail("game-server shutdown output pipe failed"));
  }
  proc.once("error", () =>
    fail("game-server process failed to start or signal"),
  );
  proc.once("close", (code, signal) => {
    state.closed = true;
    state.code = code;
    state.signal = signal;
  });
  return state;
}

function groupIsAlive(proc) {
  if (!proc?.pid) return false;
  if (process.platform === "win32")
    return proc.exitCode === null && proc.signalCode === null;
  try {
    process.kill(-proc.pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function signalGroup(proc, signal) {
  if (!proc?.pid) return;
  try {
    if (process.platform === "win32") proc.kill(signal);
    else process.kill(-proc.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

/**
 * Entries are detached children owned by this launcher, not discovered PIDs.
 * Protocol success and clean close are BOTH required before dependencies stop.
 * This verifies the existing server ACK assertion, not on-chain custody.
 */
export async function shutdownDuelStackChildren({
  entries,
  gameServer = null,
  requestedExitCode = 0,
  graceMs = 24_000,
  residualGraceMs = RESIDUAL_GRACE_MS,
  killGraceMs = KILL_GRACE_MS,
}) {
  duration(graceMs, "game shutdown grace", 1, 30_000);
  duration(residualGraceMs, "residual shutdown grace", 1, RESIDUAL_GRACE_MS);
  duration(killGraceMs, "residual kill grace", 1, KILL_GRACE_MS);
  const diagnostics = createProcessGroupDiagnostics(entries);
  try {
    const failures = [];
    const forcedGroups = [];
    const dependencyListeners = [];
    const startedAt = performance.now();
    const game = gameServer?.proc;
    let drainingGame = Boolean(game?.pid);
    for (const entry of entries) {
      if (entry.proc === game || !entry.proc?.pid) continue;
      const exited = (code, signal) => {
        if (drainingGame)
          failures.push(
            `${entry.name} exited during game-server drain (code=${code} signal=${signal})`,
          );
      };
      entry.proc.on("exit", exited);
      dependencyListeners.push(() => entry.proc.removeListener("exit", exited));
      if (entry.proc.exitCode !== null || entry.proc.signalCode !== null) {
        exited(entry.proc.exitCode, entry.proc.signalCode);
      }
    }
    try {
      if (drainingGame) {
        gameServer.requested = true;
        // Signal only the game root: its workers must survive its own drain too.
        if (game.exitCode === null && game.signalCode === null)
          game.kill("SIGTERM");
        const deadline = performance.now() + graceMs;
        while (
          !gameServer.closed &&
          !gameServer.failure &&
          failures.length === 0 &&
          performance.now() < deadline
        ) {
          await sleep(Math.min(25, Math.max(1, deadline - performance.now())));
        }
        if (gameServer.failure) failures.push(gameServer.failure);
        if (!gameServer.closed)
          failures.push(
            "game-server did not close within its shutdown barrier",
          );
        else if (gameServer.code !== 0 || gameServer.signal !== null) {
          failures.push(
            `game-server exited with code=${gameServer.code} signal=${gameServer.signal}`,
          );
        }
        if (!gameServer.completion)
          failures.push("game-server shutdown completion is missing");
      }
    } catch (error) {
      failures.push(`game-server shutdown failed: ${error.message}`);
    } finally {
      drainingGame = false;
      for (const remove of dependencyListeners) remove();
    }

    // Keep original process handles even after leaders exit: detached descendants
    // can outlive a clean leader and may no longer hold its output pipes open.
    const remaining = (phase) =>
      entries.filter((entry) => {
        try {
          return groupIsAlive(entry.proc);
        } catch (error) {
          const message = `${entry.name} process-group inspection failed: ${error.message}`;
          if (!failures.includes(message)) failures.push(message);
          diagnostics.recordInspectionError(entry, error, phase);
          return true;
        }
      });
    const signal = (entry, requestedSignal) => {
      try {
        signalGroup(entry.proc, requestedSignal);
      } catch (error) {
        failures.push(
          `${entry.name} ${requestedSignal} failed: ${error.message}`,
        );
      }
    };
    for (const entry of remaining("before-sigterm").reverse())
      signal(entry, "SIGTERM");
    const residualDeadline = performance.now() + residualGraceMs;
    while (
      remaining("sigterm-wait").length > 0 &&
      performance.now() < residualDeadline
    )
      await sleep(25);
    for (const entry of remaining("before-sigkill")) {
      forcedGroups.push(entry.name);
      signal(entry, "SIGKILL");
    }
    const killDeadline = performance.now() + killGraceMs;
    while (
      remaining("sigkill-wait").length > 0 &&
      performance.now() < killDeadline
    )
      await sleep(25);
    const remainingGroups = remaining("final").map((entry) => entry.name);
    if (forcedGroups.length)
      failures.push(
        `residual shutdown required SIGKILL: ${forcedGroups.join(", ")}`,
      );
    if (remainingGroups.length)
      failures.push(
        `owned process groups remain: ${remainingGroups.join(", ")}`,
      );
    return {
      ok: requestedExitCode === 0 && failures.length === 0,
      exitCode: requestedExitCode === 0 && failures.length === 0 ? 0 : 1,
      failures,
      forcedGroups,
      remainingGroups,
      processGroupDiagnostics: diagnostics.receipt(),
      elapsedMs: performance.now() - startedAt,
      gameServer: game?.pid
        ? {
            pid: game.pid,
            completion: gameServer.completion,
            closed: gameServer.closed,
            code: gameServer.code,
            signal: gameServer.signal,
          }
        : null,
    };
  } finally {
    diagnostics.dispose();
  }
}
