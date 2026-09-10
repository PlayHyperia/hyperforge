import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  observeGameServerShutdown,
  parseGameServerShutdownCompletion,
  resolveDuelStackShutdownPolicy,
  shutdownDuelStackChildren,
} from "./duel-stack-shutdown.mjs";

const complete = {
  event: "shutdown-complete",
  sourceEpoch: 123,
  terminalFrameSeq: 456,
  duelId: "streaming-owned-test-cycle",
  duelKeyHex: "a".repeat(64),
  competitiveSnapshotDigest: "b".repeat(64),
  outcome: "cancelled",
  cancellationReason: "scheduler_shutdown",
  downstreamAcknowledged: true,
};
const noCycle = Object.fromEntries(
  Object.keys(complete).map((key) => [
    key,
    key === "event"
      ? "shutdown-complete"
      : key === "downstreamAcknowledged"
        ? false
        : null,
  ]),
);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function child(t, source, { game = false, requireAck = true } = {}) {
  const proc = spawn(process.execPath, ["--input-type=module", "-e", source], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {},
  });
  const messages = [];
  proc.on("message", (message) => messages.push(message));
  const monitor = game
    ? observeGameServerShutdown(proc, {
        graceMs: 2_000,
        requiresAcknowledgement: requireAck,
      })
    : null;
  if (!game) {
    proc.stdout.resume();
    proc.stderr.resume();
  }
  t.after(async () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    const deadline = Date.now() + 2_000;
    while (alive(-proc.pid) && Date.now() < deadline) await delay(10);
    assert.equal(
      alive(-proc.pid),
      false,
      "owned test process group must be gone",
    );
  });
  const readyDeadline = Date.now() + 3_000;
  while (!messages.includes("ready") && Date.now() < readyDeadline)
    await delay(5);
  assert(messages.includes("ready"), "real child installed its handlers");
  return { proc, monitor, messages };
}

const dependencySource = `
  process.on("SIGTERM", () => { process.send("stopping"); process.exit(0); });
  process.on("message", (message) => { if(message === "exit") process.exit(9); });
  setInterval(() => {}, 1000); process.send("ready");
`;
const gameSource = (onTerm, beforeReady = "") => `
  process.on("SIGTERM", () => { ${onTerm} });
  setInterval(() => {}, 1000);
  ${beforeReady}
  process.send("ready");
`;
const emit = (record = complete, channel = "stdout") =>
  `process.${channel}.write(${JSON.stringify(JSON.stringify(record) + "\n")});`;
const emitRaw = (raw) => `process.stdout.write(${JSON.stringify(raw)});`;

async function run(t, source, options = {}) {
  const dependency = await child(t, dependencySource);
  const game = await child(t, source, {
    game: true,
    requireAck: options.requireAck ?? true,
  });
  const pending = shutdownDuelStackChildren({
    entries: [
      { name: "keeper", proc: dependency.proc },
      { name: "game-server", proc: game.proc },
    ],
    gameServer: game.monitor,
    graceMs: options.graceMs ?? 800,
    residualGraceMs: 100,
    killGraceMs: 1_000,
    requestedExitCode: options.requestedExitCode ?? 0,
  });
  if (options.failDependency)
    setTimeout(() => dependency.proc.send("exit"), 50);
  const result = await pending;
  assert.deepEqual(result.remainingGroups, []);
  assert.equal(alive(-dependency.proc.pid), false);
  assert.equal(alive(-game.proc.pid), false);
  return { result, game, dependency };
}

test("budget includes terminal wait, configured ACK, and cleanup margin", () => {
  assert.deepEqual(resolveDuelStackShutdownPolicy({}), {
    graceMs: 24_000,
    requiresAcknowledgement: false,
    totalGraceMs: 31_000,
  });
  assert.equal(
    resolveDuelStackShutdownPolicy({ DUEL_STACK_SHUTDOWN_GRACE_MS: "30000" })
      .totalGraceMs,
    37_000,
  );
  const env = { STREAMING_DUEL_SHUTDOWN_ACK_URL: "http://127.0.0.1/health" };
  assert.equal(
    resolveDuelStackShutdownPolicy(env).requiresAcknowledgement,
    true,
  );
  assert.throws(
    () =>
      resolveDuelStackShutdownPolicy({
        ...env,
        DUEL_STACK_SHUTDOWN_GRACE_MS: "19000",
      }),
    /5000ms terminal wait/,
  );
  assert.equal(
    resolveDuelStackShutdownPolicy({
      ...env,
      DUEL_STACK_SHUTDOWN_GRACE_MS: "22000",
    }).graceMs,
    22_000,
  );
  assert.throws(
    () =>
      resolveDuelStackShutdownPolicy({
        ...env,
        STREAMING_DUEL_SHUTDOWN_ACK_TIMEOUT_MS: "20000",
      }),
    /5000ms terminal wait/,
  );
  assert.equal(
    resolveDuelStackShutdownPolicy({
      ...env,
      STREAMING_DUEL_SHUTDOWN_ACK_TIMEOUT_MS: "20000",
      DUEL_STACK_SHUTDOWN_GRACE_MS: "27000",
    }).graceMs,
    27_000,
  );
  for (const value of ["0", "6999", "30001", "24000garbage", "1.5", "NaN"]) {
    assert.throws(() =>
      resolveDuelStackShutdownPolicy({ DUEL_STACK_SHUTDOWN_GRACE_MS: value }),
    );
  }
  for (const value of ["999", "20001", "15000garbage"]) {
    assert.throws(() =>
      resolveDuelStackShutdownPolicy({
        ...env,
        STREAMING_DUEL_SHUTDOWN_ACK_TIMEOUT_MS: value,
      }),
    );
  }
});

test("strict complete schema accepts no-cycle without fabricating an ACK", () => {
  assert.deepEqual(
    parseGameServerShutdownCompletion(JSON.stringify(noCycle), true),
    noCycle,
  );
  assert.deepEqual(
    parseGameServerShutdownCompletion(JSON.stringify(complete), true),
    complete,
  );
  assert.doesNotThrow(() =>
    parseGameServerShutdownCompletion(
      JSON.stringify({ ...complete, downstreamAcknowledged: false }),
      false,
    ),
  );
  for (const key of Object.keys(complete)) {
    const record = { ...complete };
    delete record[key];
    assert.throws(
      () => parseGameServerShutdownCompletion(JSON.stringify(record), true),
      key,
    );
  }
  for (const change of [
    { unexpected: true },
    { sourceEpoch: 0 },
    { sourceEpoch: 1.5 },
    { terminalFrameSeq: -1 },
    { duelId: " " },
    { duelId: "a".repeat(257) },
    { duelKeyHex: "bad" },
    { competitiveSnapshotDigest: null },
    { outcome: "resolved" },
    { cancellationReason: "other" },
    { downstreamAcknowledged: false },
    { downstreamAcknowledged: "true" },
  ])
    assert.throws(() =>
      parseGameServerShutdownCompletion(
        JSON.stringify({ ...complete, ...change }),
        true,
      ),
    );
  assert.throws(() =>
    parseGameServerShutdownCompletion(
      JSON.stringify({ ...noCycle, downstreamAcknowledged: true }),
      true,
    ),
  );
  assert.throws(() =>
    parseGameServerShutdownCompletion(
      JSON.stringify({ ...noCycle, duelId: complete.duelId }),
      true,
    ),
  );
});

test("real keeper stays alive after terminal output until game clean close", async (t) => {
  const dependency = await child(t, dependencySource);
  const game = await child(
    t,
    gameSource(`
    process.kill(${dependency.proc.pid}, 0);
    ${emit()}
    setTimeout(() => {
      process.kill(${dependency.proc.pid}, 0);
      process.send("dependency-alive-after-terminal");
      process.exit(0);
    }, 150);
  `),
    { game: true },
  );
  const result = await shutdownDuelStackChildren({
    entries: [
      { name: "game-server", proc: game.proc },
      { name: "keeper", proc: dependency.proc },
    ],
    gameServer: game.monitor,
    graceMs: 2_000,
    residualGraceMs: 200,
    killGraceMs: 1_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.failures, []);
  assert(game.messages.includes("dependency-alive-after-terminal"));
  assert(dependency.messages.includes("stopping"));
  assert.deepEqual(result.gameServer.completion, complete);
  assert.equal(result.gameServer.closed, true);
});

test("real negative control reproduces the old simultaneous-stop dependency loss", async (t) => {
  const dependency = await child(t, dependencySource);
  const game = await child(
    t,
    gameSource(`
    setTimeout(() => {
      try { process.kill(${dependency.proc.pid}, 0); process.exit(0); }
      catch { process.exit(42); }
    }, 100);
  `),
    { game: true },
  );
  // Reproduce the old outer launcher policy using only these owned children.
  dependency.proc.kill("SIGTERM");
  game.proc.kill("SIGTERM");
  const deadline = Date.now() + 2_000;
  while (!game.monitor.closed && Date.now() < deadline) await delay(5);
  assert.equal(game.monitor.closed, true);
  assert.equal(
    game.monitor.code,
    42,
    "old ordering removes a required dependency before drain",
  );
});

test("real no-cycle completion and stderr completion are supported", async (t) => {
  for (const [record, channel] of [
    [noCycle, "stdout"],
    [complete, "stderr"],
  ]) {
    const { result } = await run(
      t,
      gameSource(`${emit(record, channel)} process.exit(0);`),
    );
    assert.equal(result.ok, true);
  }
});

test("real split and final non-newline records survive process close", async (t) => {
  const raw = JSON.stringify(complete);
  const { result } = await run(
    t,
    gameSource(`
    process.stdout.write(${JSON.stringify(raw.slice(0, 31))});
    setTimeout(() => { process.stdout.write(${JSON.stringify(raw.slice(31))}); process.exit(0); }, 30);
  `),
  );
  assert.equal(result.ok, true);
});

test("real failure/malformed/missing/duplicate/nonzero results fail and still clean dependencies", async (t) => {
  const cases = [
    [
      emit({
        event: "shutdown-failed",
        signal: "SIGTERM",
        reason: "unacknowledged",
      }),
      /shutdown-failed/,
    ],
    [emitRaw('{"event":"shutdown-complete",bad}\n'), /malformed/],
    ["", /completion is missing/],
    [emit({ ...complete, duelKeyHex: null }), /terminal identity/],
    [
      emit({ ...complete, downstreamAcknowledged: false }),
      /required downstream/,
    ],
    [emit() + emit(), /duplicate/],
    [emit() + "process.exit(7);", /code=7/],
  ];
  for (const [output, pattern] of cases) {
    const { result } = await run(t, gameSource(`${output} process.exit(0);`));
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.match(result.failures.join("; "), pattern);
  }
});

test("real stale generation output and pre-request partial record cannot authorize shutdown", async (t) => {
  const raw = JSON.stringify(complete);
  for (const [before, after] of [
    [emit(), ""],
    [
      `process.stdout.write(${JSON.stringify(raw.slice(0, 30))});`,
      `process.stdout.write(${JSON.stringify(raw.slice(30) + "\n")});`,
    ],
  ]) {
    const { result } = await run(
      t,
      gameSource(`${after} process.exit(0);`, before),
    );
    assert.equal(result.ok, false);
    assert.match(result.failures.join("; "), /predates/);
  }
});

test("real oversized protocol fails closed with bounded capture", async (t) => {
  const { result } = await run(
    t,
    gameSource(
      `${emitRaw('{"event":"shutdown-complete","padding":"' + "x".repeat(100000) + '"}\n')} process.exit(0);`,
    ),
  );
  assert.equal(result.ok, false);
  assert.match(result.failures.join("; "), /exceeded its bound/);
});

test("real dependency death during drain is failure even with subsequent valid completion", async (t) => {
  const { result } = await run(
    t,
    gameSource(`setTimeout(() => { ${emit()} process.exit(0); }, 250);`),
    { failDependency: true },
  );
  assert.equal(result.ok, false);
  assert.match(
    result.failures.join("; "),
    /keeper exited during game-server drain/,
  );
});

test("real hung game is bounded and cannot pass on protocol alone", async (t) => {
  const { result } = await run(t, gameSource(emit()), { graceMs: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.failures.join("; "), /did not close/);
  assert(result.elapsedMs < 2_000);
  assert(result.forcedGroups.includes("game-server"));
});

test("real inherited stdout descendant prevents premature game close acceptance", async (t) => {
  const source = `
    import { spawn } from "node:child_process";
    const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio:["ignore",1,2] });
    ${gameSource(`${emit()} process.exit(0);`)}
  `;
  const { result } = await run(t, source, { graceMs: 100 });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("; "), /did not close/);
  assert(result.forcedGroups.includes("game-server"));
});

test("real detached-group descendant is removed after clean root even without inherited pipes", async (t) => {
  const source = `
    import { spawn } from "node:child_process";
    const worker = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio:"ignore" });
    worker.unref();
    ${gameSource(`${emit()} setTimeout(() => { process.kill(worker.pid, 0); process.exit(0); }, 100);`)}
  `;
  const { result } = await run(t, source);
  assert.equal(result.ok, true);
  assert.deepEqual(result.remainingGroups, []);
});

test("startup failure and no owned server keep their existing exit intent", async (t) => {
  const dependency = await child(t, dependencySource);
  const result = await shutdownDuelStackChildren({
    entries: [{ name: "keeper", proc: dependency.proc }],
    requestedExitCode: 1,
    graceMs: 100,
    residualGraceMs: 100,
    killGraceMs: 1_000,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.gameServer, null);
  assert.deepEqual(result.failures, []);
  const empty = await shutdownDuelStackChildren({ entries: [] });
  assert.equal(empty.exitCode, 0);
  assert.equal(empty.gameServer, null);
});

test("real game spawn failure is not misrepresented as an active terminal drain", async () => {
  const proc = spawn("/definitely-missing-hyperia-shutdown-test-node", [], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {},
  });
  const monitor = observeGameServerShutdown(proc, {
    requiresAcknowledgement: true,
  });
  const deadline = Date.now() + 2_000;
  while (!monitor.closed && Date.now() < deadline) await delay(5);
  assert.equal(monitor.closed, true);
  assert.equal(proc.pid, undefined);
  const result = await shutdownDuelStackChildren({
    entries: [{ name: "game-server", proc }],
    gameServer: monitor,
    requestedExitCode: 1,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.gameServer, null);
  assert.deepEqual(result.remainingGroups, []);
});

test("launcher wires per-generation observation before filtered output and drains before path cleanup", () => {
  const source = readFileSync(
    new URL("./duel-stack.mjs", import.meta.url),
    "utf8",
  );
  assert(
    source.indexOf("entry.shutdownMonitor = observeGameServerShutdown(") <
      source.indexOf("attachPrefixedOutput(proc.stdout"),
  );
  assert.match(
    source,
    /name === "game-server" \? \{ stdio: \["ignore", "pipe", "pipe"\] \}/u,
  );
  const shutdown = source.slice(
    source.indexOf("async function shutdown("),
    source.indexOf('process.on("SIGINT"'),
  );
  assert(
    shutdown.indexOf("clearTimeout(entry.restartTimer)") <
      shutdown.indexOf("await shutdownDuelStackChildren("),
  );
  assert(
    shutdown.indexOf("await shutdownDuelStackChildren(") <
      shutdown.indexOf("fs.rmSync(runtimePath"),
  );
  assert.match(shutdown, /if \(result.remainingGroups.length === 0\)/u);
  assert.match(
    shutdown,
    /shutdownExitCode = Math.max\(shutdownExitCode, result.exitCode\)/u,
  );
  assert.match(shutdown, /process.exit\(shutdownExitCode\)/u);
  assert.doesNotMatch(shutdown, /signalProcessTree/u);
});
