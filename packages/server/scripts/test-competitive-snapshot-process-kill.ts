import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import pg from "pg";

import {
  DUEL_PREPARATION_BANK_ACTIONS,
  PostgresDuelPreparationStore,
} from "../src/systems/StreamingDuelScheduler/preparation.js";
import { buildDeterministicCompetitiveTacticalStrategy } from "../src/systems/StreamingDuelScheduler/competitive-tactical-strategy.js";

const execFileAsync = promisify(execFile);
const { Pool } = pg;
const scriptPath = fileURLToPath(import.meta.url);
const AGENT_1_ID = "competitive-chaos-agent-1";
const AGENT_2_ID = "competitive-chaos-agent-2";
const CYCLE_ID = "competitive-process-kill-cycle";

type WorkerEvent = {
  event: "frozen" | "terminal" | "retired" | "unclaimed" | "error";
  digest?: string;
  fencingToken?: string;
  cycleId?: string;
  duelId?: string;
  lockedAt?: number;
  duelStartedAt?: number;
  terminalAt?: number;
  recoveredAt?: number;
  message?: string;
};

const planEvidence = (agentId: string) => ({
  primaryStyle: "melee" as const,
  availableStyles: ["melee" as const],
  planningSource: "deterministic" as const,
  planningPolicyVersion: "competitive-chaos-policy-v1",
  agentPolicyFingerprint: "ab".repeat(32),
  modelProvider: "deterministic",
  model: agentId,
  tacticalStrategy: buildDeterministicCompetitiveTacticalStrategy("melee"),
});

const snapshotContestant = (side: "agent1" | "agent2", agentId: string) => ({
  side,
  agentId,
  name: agentId,
  provider: "deterministic",
  model: agentId,
  combatLevel: 10,
  startingHp: 20,
  maxHp: 20,
  wins: 0,
  losses: 0,
  rank: side === "agent1" ? 1 : 2,
  headToHeadWins: 0,
  headToHeadLosses: 0,
  loadoutFingerprint: (side === "agent1" ? "11" : "22").repeat(32),
  equipment: [{ slot: "weapon", itemId: "bronze_sword", quantity: 1 }],
  inventory: [{ slot: 0, itemId: "shark", quantity: 2 }],
  selectedSpell: null,
  skillLevels: [
    { skill: "attack", level: 10 },
    { skill: "constitution", level: 20 },
  ],
  prayer: {
    pointUnits: 100,
    points: 10,
    maxPoints: 10,
    activePrayers: [],
  },
  initialCombatStyle: "melee" as const,
  availableCombatStyles: ["melee" as const],
  combatLoadouts: {
    melee: {
      role: "melee" as const,
      weaponId: "bronze_sword",
      arrowsId: null,
      shieldId: null,
      spellId: null,
      armorIds: {
        helmet: null,
        body: null,
        legs: null,
        boots: null,
        gloves: null,
        cape: null,
        amulet: null,
        ring: null,
      },
    },
  },
  preparation: planEvidence(agentId),
});

function emit(event: WorkerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function runFreezeWorker(): Promise<void> {
  const connectionString = process.env.COMPETITIVE_CHAOS_DATABASE_URL;
  const preparationId = process.env.COMPETITIVE_CHAOS_PREPARATION_ID;
  if (!connectionString || !preparationId) {
    throw new Error("competitive freeze worker configuration is incomplete");
  }
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const store = new PostgresDuelPreparationStore(pool);
    await store.create({
      preparationId,
      fencingToken: "1",
      agent1Id: AGENT_1_ID,
      agent2Id: AGENT_2_ID,
      durationMs: 120_000,
      allowedBankActions: DUEL_PREPARATION_BANK_ACTIONS,
    });
    const hostOwnerId = randomUUID();
    for (const agentId of [AGENT_1_ID, AGENT_2_ID]) {
      const lease = await store.claimContestantHostLease({
        preparationId,
        agentId,
        ownerId: hostOwnerId,
        leaseDurationMs: 60_000,
      });
      if (!lease) throw new Error(`host lease rejected for ${agentId}`);
    }
    await store.markReady({
      preparationId,
      fencingToken: "1",
      agentId: AGENT_1_ID,
      planEvidence: planEvidence(AGENT_1_ID),
    });
    await store.markReady({
      preparationId,
      fencingToken: "1",
      agentId: AGENT_2_ID,
      planEvidence: planEvidence(AGENT_2_ID),
    });
    const frozen = await store.freezeWithCompetitiveSnapshot({
      preparationId,
      fencingToken: "1",
      betWindowDurationMs: 60_000,
      draft: {
        diagnostic: false,
        preparationId,
        cycleId: CYCLE_ID,
        duelId: `streaming-${CYCLE_ID}`,
        duelKey: "33".repeat(32),
        contestants: [
          snapshotContestant("agent1", AGENT_1_ID),
          snapshotContestant("agent2", AGENT_2_ID),
        ],
      },
    });
    if (!frozen || frozen.lifecycleStatus !== "frozen") {
      throw new Error("competitive snapshot was not durably frozen");
    }
    const locked = await store.markCompetitiveSnapshotLocked({
      preparationId,
      fencingToken: "1",
      snapshotDigest: frozen.digest,
      lockedAt: frozen.snapshot.betCloseTime,
    });
    const duelStartedAt = frozen.snapshot.betCloseTime + 1;
    const started = await store.markCompetitiveSnapshotDuelStarted({
      preparationId,
      fencingToken: "1",
      snapshotDigest: frozen.digest,
      duelStartedAt,
    });
    if (
      !locked ||
      locked.lockedAt !== frozen.snapshot.betCloseTime ||
      !started ||
      started.lockedAt !== frozen.snapshot.betCloseTime ||
      started.duelStartedAt !== duelStartedAt
    ) {
      throw new Error("competitive lifecycle edges were not durably committed");
    }
    emit({
      event: "frozen",
      digest: started.digest,
      fencingToken: started.preparation.fencingToken,
      cycleId: started.snapshot.cycleId,
      duelId: started.snapshot.duelId,
      lockedAt: started.lockedAt ?? undefined,
      duelStartedAt: started.duelStartedAt ?? undefined,
    });
    await new Promise<never>(() => undefined);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function runRecoveryWorker(): Promise<void> {
  const connectionString = process.env.COMPETITIVE_CHAOS_DATABASE_URL;
  const expectedDigest = process.env.COMPETITIVE_CHAOS_SNAPSHOT_DIGEST;
  if (!connectionString || !expectedDigest) {
    throw new Error("competitive recovery worker configuration is incomplete");
  }
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const store = new PostgresDuelPreparationStore(pool);
    const recovered =
      await store.claimLatestCompetitiveSnapshotForRecovery("2");
    if (
      !recovered ||
      recovered.lifecycleStatus !== "frozen" ||
      recovered.digest !== expectedDigest ||
      recovered.snapshot.cycleId !== CYCLE_ID ||
      recovered.snapshot.duelId !== `streaming-${CYCLE_ID}` ||
      recovered.preparation.fencingToken !== "2" ||
      recovered.lockedAt !== recovered.snapshot.betCloseTime ||
      recovered.duelStartedAt !== recovered.snapshot.betCloseTime + 1
    ) {
      throw new Error("replacement process recovered different frozen truth");
    }
    const terminal = await store.markCompetitiveSnapshotTerminal({
      preparationId: recovered.preparation.preparationId,
      fencingToken: "2",
      snapshotDigest: recovered.digest,
      terminal: {
        outcome: "cancelled",
        winnerId: null,
        winReason: null,
        cancellationReason: "authority_process_restarted",
        seed: null,
        replayHash: null,
        terminalAt: Math.max(
          Date.now(),
          recovered.snapshot.frozenAt,
          recovered.duelStartedAt,
        ),
      },
    });
    if (!terminal || terminal.lifecycleStatus !== "terminal") {
      throw new Error("replacement process did not commit terminal truth");
    }
    emit({
      event: "terminal",
      digest: terminal.digest,
      fencingToken: terminal.preparation.fencingToken,
      cycleId: terminal.snapshot.cycleId,
      duelId: terminal.snapshot.duelId,
      lockedAt: terminal.lockedAt ?? undefined,
      duelStartedAt: terminal.duelStartedAt ?? undefined,
      terminalAt: terminal.terminal?.terminalAt,
    });
  } finally {
    await pool.end();
  }
}

async function runTerminalReplayWorker(): Promise<void> {
  const connectionString = process.env.COMPETITIVE_CHAOS_DATABASE_URL;
  const expectedDigest = process.env.COMPETITIVE_CHAOS_SNAPSHOT_DIGEST;
  if (!connectionString || !expectedDigest) {
    throw new Error("competitive replay worker configuration is incomplete");
  }
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const store = new PostgresDuelPreparationStore(pool);
    const recovered =
      await store.claimLatestCompetitiveSnapshotForRecovery("3");
    if (
      !recovered ||
      recovered.lifecycleStatus !== "terminal" ||
      recovered.digest !== expectedDigest ||
      recovered.preparation.fencingToken !== "3" ||
      recovered.terminal?.outcome !== "cancelled" ||
      recovered.terminal.cancellationReason !== "authority_process_restarted" ||
      recovered.lockedAt !== recovered.snapshot.betCloseTime ||
      recovered.duelStartedAt !== recovered.snapshot.betCloseTime + 1
    ) {
      throw new Error("third process did not recover exact terminal truth");
    }
    const replayed = await store.markCompetitiveSnapshotTerminal({
      preparationId: recovered.preparation.preparationId,
      fencingToken: "3",
      snapshotDigest: recovered.digest,
      terminal: recovered.terminal,
    });
    if (
      !replayed ||
      replayed.lifecycleStatus !== "terminal" ||
      replayed.digest !== recovered.digest ||
      replayed.terminal?.terminalAt !== recovered.terminal.terminalAt ||
      replayed.lockedAt !== recovered.lockedAt ||
      replayed.duelStartedAt !== recovered.duelStartedAt
    ) {
      throw new Error("terminal replay was not idempotent");
    }
    emit({
      event: "terminal",
      digest: replayed.digest,
      fencingToken: replayed.preparation.fencingToken,
      cycleId: replayed.snapshot.cycleId,
      duelId: replayed.snapshot.duelId,
      lockedAt: replayed.lockedAt ?? undefined,
      duelStartedAt: replayed.duelStartedAt ?? undefined,
      terminalAt: replayed.terminal?.terminalAt,
    });
  } finally {
    await pool.end();
  }
}

async function runRetirementWorker(): Promise<void> {
  const connectionString = process.env.COMPETITIVE_CHAOS_DATABASE_URL;
  const expectedDigest = process.env.COMPETITIVE_CHAOS_SNAPSHOT_DIGEST;
  if (!connectionString || !expectedDigest) {
    throw new Error(
      "competitive retirement worker configuration is incomplete",
    );
  }
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const store = new PostgresDuelPreparationStore(pool);
    const recovered =
      await store.claimLatestCompetitiveSnapshotForRecovery("4");
    if (
      !recovered ||
      recovered.lifecycleStatus !== "terminal" ||
      recovered.digest !== expectedDigest ||
      recovered.preparation.fencingToken !== "4" ||
      !recovered.terminal ||
      recovered.lockedAt !== recovered.snapshot.betCloseTime ||
      recovered.duelStartedAt !== recovered.snapshot.betCloseTime + 1
    ) {
      throw new Error("fourth process did not recover exact terminal truth");
    }
    const recoveredAt = Math.max(Date.now(), recovered.terminal.terminalAt);
    const retired = await store.markCompetitiveSnapshotRecovered({
      preparationId: recovered.preparation.preparationId,
      fencingToken: "4",
      snapshotDigest: recovered.digest,
      recoveredAt,
    });
    if (
      !retired ||
      retired.lifecycleStatus !== "retired" ||
      retired.digest !== recovered.digest ||
      retired.terminal?.terminalAt !== recovered.terminal.terminalAt ||
      retired.lockedAt !== recovered.lockedAt ||
      retired.duelStartedAt !== recovered.duelStartedAt ||
      retired.recoveredAt !== recoveredAt
    ) {
      throw new Error("terminal truth drifted while retiring restart replay");
    }
    emit({
      event: "retired",
      digest: retired.digest,
      fencingToken: retired.preparation.fencingToken,
      cycleId: retired.snapshot.cycleId,
      duelId: retired.snapshot.duelId,
      lockedAt: retired.lockedAt ?? undefined,
      duelStartedAt: retired.duelStartedAt ?? undefined,
      terminalAt: retired.terminal?.terminalAt,
      recoveredAt: retired.recoveredAt ?? undefined,
    });
  } finally {
    await pool.end();
  }
}

async function runNoReplayWorker(): Promise<void> {
  const connectionString = process.env.COMPETITIVE_CHAOS_DATABASE_URL;
  if (!connectionString) {
    throw new Error("competitive no-replay worker configuration is incomplete");
  }
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const store = new PostgresDuelPreparationStore(pool);
    const recovered =
      await store.claimLatestCompetitiveSnapshotForRecovery("5");
    if (recovered !== null) {
      throw new Error("retired terminal snapshot remained restart-replayable");
    }
    emit({ event: "unclaimed" });
  } finally {
    await pool.end();
  }
}

async function docker(args: string[]): Promise<string> {
  const binary = process.env.DOCKER_BIN?.trim() || "docker";
  const result = await execFileAsync(binary, args, {
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function waitForPostgres(connectionString: string): Promise<pg.Pool> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString, max: 2 });
    try {
      await pool.query("SELECT 1");
      return pool;
    } catch (error) {
      lastError = error;
      await pool.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(
    `temporary PostgreSQL did not become ready: ${String(lastError)}`,
  );
}

function spawnWorker(input: {
  mode: "freeze" | "recover" | "replay" | "retire" | "verify";
  connectionString: string;
  preparationId: string;
  expectedDigest?: string;
}): { child: ChildProcess; event: Promise<WorkerEvent>; stderr: string[] } {
  const child = spawn(process.execPath, [scriptPath, `--${input.mode}`], {
    env: {
      ...process.env,
      COMPETITIVE_CHAOS_DATABASE_URL: input.connectionString,
      COMPETITIVE_CHAOS_PREPARATION_ID: input.preparationId,
      COMPETITIVE_CHAOS_SNAPSHOT_DIGEST: input.expectedDigest,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) {
    throw new Error("competitive chaos worker pipes were not created");
  }
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));
  const event = new Promise<WorkerEvent>((resolveEvent, reject) => {
    let buffered = "";
    const timer = setTimeout(
      () =>
        reject(new Error(`competitive worker timed out: ${stderr.join("")}`)),
      20_000,
    );
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as WorkerEvent;
          if (
            ["frozen", "terminal", "retired", "unclaimed", "error"].includes(
              parsed.event,
            )
          ) {
            clearTimeout(timer);
            resolveEvent(parsed);
            return;
          }
        } catch {
          // Runtime diagnostics may share stdout; only JSON events are relevant.
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGKILL") return;
      clearTimeout(timer);
      reject(
        new Error(
          `competitive worker exited ${code ?? signal}: ${stderr.join("")}`,
        ),
      );
    });
  });
  return { child, event, stderr };
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(
      () => reject(new Error("competitive worker did not exit")),
      10_000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

function migration(name: string): string {
  return readFileSync(
    new URL(`../src/database/migrations/${name}`, import.meta.url),
    "utf8",
  );
}

async function runParent(): Promise<void> {
  const containerName = `hyperia-competitive-chaos-${process.pid}`;
  const databaseUser = "competitive_test";
  const databaseName = "competitive_test";
  const databasePassword = `competitive-${randomUUID()}`;
  const preparationId = randomUUID();
  const backfilledPreparationId = randomUUID();
  const image =
    process.env.COMPETITIVE_CHAOS_POSTGRES_IMAGE?.trim() ||
    "postgres:16-alpine";
  const workers: ChildProcess[] = [];
  let containerStarted = false;
  let pool: pg.Pool | null = null;
  try {
    await docker(["info", "--format", "{{.ServerVersion}}"]);
    await docker([
      "run",
      "--rm",
      "-d",
      "--name",
      containerName,
      "-e",
      `POSTGRES_USER=${databaseUser}`,
      "-e",
      `POSTGRES_PASSWORD=${databasePassword}`,
      "-e",
      `POSTGRES_DB=${databaseName}`,
      "-p",
      "127.0.0.1::5432",
      image,
    ]);
    containerStarted = true;
    const portOutput = await docker(["port", containerName, "5432/tcp"]);
    const port = Number(portOutput.split(":").pop());
    if (!Number.isSafeInteger(port) || port <= 0) {
      throw new Error("could not resolve temporary PostgreSQL port");
    }
    const connectionString = `postgresql://${databaseUser}:${encodeURIComponent(databasePassword)}@127.0.0.1:${port}/${databaseName}`;
    pool = await waitForPostgres(connectionString);
    await pool.query(`CREATE TABLE characters (id text PRIMARY KEY NOT NULL)`);
    await pool.query(`INSERT INTO characters (id) VALUES ($1), ($2)`, [
      AGENT_1_ID,
      AGENT_2_ID,
    ]);
    await pool.query(migration("0060_add_streaming_duel_preparations.sql"));
    await pool.query(
      migration("0066_add_streaming_duel_competitive_snapshots.sql"),
    );
    await pool.query(
      migration("0069_add_streaming_duel_lifecycle_timestamps.sql"),
    );
    await pool.query(
      `INSERT INTO streaming_duel_preparations (
         "preparationId", "fencingToken", "agent1Id", "agent2Id",
         "allowedBankActions", status, "selectedAt", "expiresAt",
         "cancelledAt", "cancellationReason", version
       ) VALUES (
         $1, 99, $2, $3, ARRAY['open'], 'cancelled',
         100, 200, 150, 'historical_test_cancellation', 2
       )`,
      [backfilledPreparationId, AGENT_1_ID, AGENT_2_ID],
    );
    await pool.query(
      migration("0070_add_streaming_duel_transition_events.sql"),
    );
    const backfilledBeforeReapply = await pool.query<{
      eventSource: string;
      eventType: string;
      occurredAt: string;
      fencingToken: string | null;
      preparationVersion: number | null;
      reason: string | null;
    }>(
      `SELECT "eventSource", "eventType", "occurredAt"::text AS "occurredAt",
              "fencingToken"::text AS "fencingToken", "preparationVersion", reason
       FROM streaming_duel_transition_events
       WHERE "preparationId" = $1
       ORDER BY "eventSequence" ASC`,
      [backfilledPreparationId],
    );
    await pool.query(
      migration("0070_add_streaming_duel_transition_events.sql"),
    );
    const backfilledAfterReapply = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM streaming_duel_transition_events
       WHERE "preparationId" = $1`,
      [backfilledPreparationId],
    );
    if (
      JSON.stringify(backfilledBeforeReapply.rows) !==
        JSON.stringify([
          {
            eventSource: "migration_backfill",
            eventType: "preparation_selected",
            occurredAt: "100",
            fencingToken: null,
            preparationVersion: null,
            reason: null,
          },
          {
            eventSource: "migration_backfill",
            eventType: "preparation_cancelled",
            occurredAt: "150",
            fencingToken: null,
            preparationVersion: null,
            reason: "historical_test_cancellation",
          },
        ]) ||
      backfilledAfterReapply.rows[0]?.count !== "2"
    ) {
      throw new Error(
        `transition backfill/reapply drifted: ${JSON.stringify({ before: backfilledBeforeReapply.rows, after: backfilledAfterReapply.rows })}`,
      );
    }

    const freezer = spawnWorker({
      mode: "freeze",
      connectionString,
      preparationId,
    });
    workers.push(freezer.child);
    const frozenEvent = await freezer.event;
    if (
      frozenEvent.event !== "frozen" ||
      !frozenEvent.digest ||
      frozenEvent.fencingToken !== "1" ||
      frozenEvent.cycleId !== CYCLE_ID ||
      !frozenEvent.lockedAt ||
      frozenEvent.duelStartedAt !== frozenEvent.lockedAt + 1
    ) {
      throw new Error(
        `freeze worker returned invalid evidence: ${JSON.stringify(frozenEvent)}`,
      );
    }
    freezer.child.kill("SIGKILL");
    await waitForExit(freezer.child);

    const recovery = spawnWorker({
      mode: "recover",
      connectionString,
      preparationId,
      expectedDigest: frozenEvent.digest,
    });
    workers.push(recovery.child);
    const terminalEvent = await recovery.event;
    await waitForExit(recovery.child);
    if (
      terminalEvent.event !== "terminal" ||
      terminalEvent.digest !== frozenEvent.digest ||
      terminalEvent.fencingToken !== "2" ||
      terminalEvent.cycleId !== CYCLE_ID ||
      terminalEvent.lockedAt !== frozenEvent.lockedAt ||
      terminalEvent.duelStartedAt !== frozenEvent.duelStartedAt ||
      !terminalEvent.terminalAt
    ) {
      throw new Error(
        `recovery worker returned invalid evidence: ${JSON.stringify(terminalEvent)}`,
      );
    }

    const replay = spawnWorker({
      mode: "replay",
      connectionString,
      preparationId,
      expectedDigest: frozenEvent.digest,
    });
    workers.push(replay.child);
    const replayEvent = await replay.event;
    await waitForExit(replay.child);
    if (
      replayEvent.event !== "terminal" ||
      replayEvent.digest !== frozenEvent.digest ||
      replayEvent.fencingToken !== "3" ||
      replayEvent.cycleId !== CYCLE_ID ||
      replayEvent.lockedAt !== frozenEvent.lockedAt ||
      replayEvent.duelStartedAt !== frozenEvent.duelStartedAt ||
      replayEvent.terminalAt !== terminalEvent.terminalAt
    ) {
      throw new Error(
        `terminal replay worker returned invalid evidence: ${JSON.stringify(replayEvent)}`,
      );
    }

    const retirement = spawnWorker({
      mode: "retire",
      connectionString,
      preparationId,
      expectedDigest: frozenEvent.digest,
    });
    workers.push(retirement.child);
    const retiredEvent = await retirement.event;
    await waitForExit(retirement.child);
    if (
      retiredEvent.event !== "retired" ||
      retiredEvent.digest !== frozenEvent.digest ||
      retiredEvent.fencingToken !== "4" ||
      retiredEvent.cycleId !== CYCLE_ID ||
      retiredEvent.lockedAt !== frozenEvent.lockedAt ||
      retiredEvent.duelStartedAt !== frozenEvent.duelStartedAt ||
      retiredEvent.terminalAt !== terminalEvent.terminalAt ||
      !retiredEvent.recoveredAt ||
      retiredEvent.recoveredAt < retiredEvent.terminalAt
    ) {
      throw new Error(
        `retirement worker returned invalid evidence: ${JSON.stringify(retiredEvent)}`,
      );
    }

    const noReplay = spawnWorker({
      mode: "verify",
      connectionString,
      preparationId,
      expectedDigest: frozenEvent.digest,
    });
    workers.push(noReplay.child);
    const noReplayEvent = await noReplay.event;
    await waitForExit(noReplay.child);
    if (noReplayEvent.event !== "unclaimed") {
      throw new Error(
        `no-replay worker returned invalid evidence: ${JSON.stringify(noReplayEvent)}`,
      );
    }

    const rows = await pool.query<{
      lifecycleStatus: string;
      snapshotDigest: string;
      terminalOutcome: string | null;
      terminalCancellationReason: string | null;
      terminalWinnerId: string | null;
      terminalSeed: string | null;
      terminalReplayHash: string | null;
      terminalAt: string | null;
      lockedAt: string | null;
      duelStartedAt: string | null;
      recoveredAt: string | null;
      fencingToken: string;
    }>(
      `SELECT s."lifecycleStatus", s."snapshotDigest", s."terminalOutcome",
              s."terminalCancellationReason", s."terminalWinnerId",
              s."terminalSeed", s."terminalReplayHash", s."terminalAt"::text,
              s."lockedAt"::text, s."duelStartedAt"::text,
              s."recoveredAt"::text,
              p."fencingToken"::text AS "fencingToken"
       FROM streaming_duel_competitive_snapshots s
       JOIN streaming_duel_preparations p USING ("preparationId")`,
    );
    const row = rows.rows[0];
    if (
      rows.rowCount !== 1 ||
      row?.lifecycleStatus !== "retired" ||
      row.snapshotDigest !== frozenEvent.digest ||
      row.terminalOutcome !== "cancelled" ||
      row.terminalCancellationReason !== "authority_process_restarted" ||
      row.terminalWinnerId !== null ||
      row.terminalSeed !== null ||
      row.terminalReplayHash !== null ||
      row.lockedAt !== String(frozenEvent.lockedAt) ||
      row.duelStartedAt !== String(frozenEvent.duelStartedAt) ||
      row.terminalAt !== String(terminalEvent.terminalAt) ||
      row.recoveredAt !== String(retiredEvent.recoveredAt) ||
      row.fencingToken !== "4"
    ) {
      throw new Error(
        `durable terminal row drifted: ${JSON.stringify(rows.rows)}`,
      );
    }

    const transitionResult = await pool.query<{
      eventSequence: string;
      eventSource: string;
      eventType: string;
      fencingToken: string | null;
      preparationVersion: number | null;
      actorAgentId: string | null;
      snapshotDigest: string | null;
      terminalOutcome: string | null;
      reason: string | null;
    }>(
      `SELECT event."eventSequence"::text AS "eventSequence", event."eventSource",
              event."eventType", event."fencingToken"::text AS "fencingToken",
              event."preparationVersion", event."actorAgentId",
              event."snapshotDigest", event."terminalOutcome", event.reason
       FROM streaming_duel_transition_events AS event
       WHERE event."preparationId" = $1
       ORDER BY event."eventSequence" ASC`,
      [preparationId],
    );
    const expectedTransitionTypes = [
      "preparation_selected",
      "contestant_ready",
      "contestant_ready",
      "competitive_snapshot_frozen",
      "market_locked",
      "duel_started",
      "authority_claimed",
      "terminal_committed",
      "authority_claimed",
      "authority_claimed",
      "recovery_committed",
    ];
    if (
      transitionResult.rows.map((event) => event.eventType).join(",") !==
        expectedTransitionTypes.join(",") ||
      transitionResult.rows.some(
        (event, index) =>
          event.eventSource !== "runtime" ||
          (index > 0 &&
            BigInt(event.eventSequence) <=
              BigInt(transitionResult.rows[index - 1]!.eventSequence)),
      ) ||
      transitionResult.rows[1]?.actorAgentId !== AGENT_1_ID ||
      transitionResult.rows[2]?.actorAgentId !== AGENT_2_ID ||
      transitionResult.rows[3]?.snapshotDigest !== frozenEvent.digest ||
      transitionResult.rows[6]?.fencingToken !== "2" ||
      transitionResult.rows[6]?.preparationVersion !== 5 ||
      transitionResult.rows[7]?.terminalOutcome !== "cancelled" ||
      transitionResult.rows[7]?.reason !== "authority_process_restarted" ||
      transitionResult.rows[8]?.fencingToken !== "3" ||
      transitionResult.rows[8]?.preparationVersion !== 6 ||
      transitionResult.rows[9]?.fencingToken !== "4" ||
      transitionResult.rows[9]?.preparationVersion !== 7 ||
      transitionResult.rows[10]?.fencingToken !== "4" ||
      transitionResult.rows[10]?.preparationVersion !== 7
    ) {
      throw new Error(
        `durable transition history drifted: ${JSON.stringify(transitionResult.rows)}`,
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        freezeWorkerPid: freezer.child.pid,
        recoveryWorkerPid: recovery.child.pid,
        replayWorkerPid: replay.child.pid,
        retirementWorkerPid: retirement.child.pid,
        noReplayWorkerPid: noReplay.child.pid,
        freezeWorkerKilled: true,
        exactDigestRecovered: true,
        lifecycleEdgesRecovered: true,
        fencingTokenAdvanced: "4",
        terminalOutcome: "cancelled",
        terminalReason: "authority_process_restarted",
        snapshotRows: rows.rowCount,
        terminalReplayAfterSecondRestart: true,
        terminalTruthRetainedAfterRecovery: true,
        retiredSnapshotExcludedAfterThirdRestart: true,
        orderedTransitionHistoryRecovered: true,
        transitionRows: transitionResult.rowCount,
        provenanceMarkedBackfillRows: 2,
        migrationReapplyDuplicatedBackfill: false,
        duplicateTerminalTransition: false,
        duplicateAuthorityTransition: false,
        duplicateSnapshot: false,
      })}\n`,
    );
  } finally {
    for (const child of workers) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child).catch(() => undefined);
      }
    }
    if (pool) await pool.end().catch(() => undefined);
    if (containerStarted) {
      await docker(["stop", "--time", "1", containerName]).catch(
        () => undefined,
      );
    }
  }
}

try {
  if (process.argv.includes("--freeze")) {
    await runFreezeWorker();
  } else if (process.argv.includes("--recover")) {
    await runRecoveryWorker();
  } else if (process.argv.includes("--replay")) {
    await runTerminalReplayWorker();
  } else if (process.argv.includes("--retire")) {
    await runRetirementWorker();
  } else if (process.argv.includes("--verify")) {
    await runNoReplayWorker();
  } else {
    await runParent();
  }
} catch (error) {
  if (process.argv.some((argument) => argument.startsWith("--"))) {
    emit({
      event: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  throw error;
}
