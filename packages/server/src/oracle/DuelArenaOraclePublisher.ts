import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { World } from "@hyperforge/shared";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Logger } from "../systems/ServerNetwork/services/index.js";
import { getStreamingDuelScheduler } from "../systems/StreamingDuelScheduler/index.js";
import type {
  DuelArenaOracleAbortEvent,
  DuelArenaOracleAnnouncementEvent,
  DuelArenaOracleChainKey,
  DuelArenaOracleChainState,
  DuelArenaOracleConfig,
  DuelArenaOracleFightStartEvent,
  DuelArenaOracleParticipant,
  DuelArenaOracleRecord,
  DuelArenaOracleResolutionEvent,
  DuelArenaOracleSolanaTargetConfig,
  DuelArenaOracleStatus,
  DuelArenaOracleStoreFile,
  DuelArenaOracleWinnerSide,
} from "./types.js";

const ORACLE_CONFIG_SEED = Buffer.from("oracle_config", "utf8");
const DUEL_SEED = Buffer.from("duel", "utf8");
const SOLANA_STATUS_TO_VARIANT: Record<DuelArenaOracleStatus, number> = {
  BETTING_OPEN: 1,
  LOCKED: 2,
  RESOLVED: 3,
  CANCELLED: 4,
};
const WINNER_SIDE_TO_VARIANT: Record<DuelArenaOracleWinnerSide, number> = {
  A: 1,
  B: 2,
};

function nowIso(): string {
  return new Date().toISOString();
}

function hashParticipant(participantId: string): string {
  return crypto
    .createHash("sha256")
    .update(`hyperia:duel-arena:participant:${participantId}`)
    .digest("hex");
}

function buildMetadataUri(baseUrl: string, duelId: string): string {
  return `${baseUrl}/duels/${encodeURIComponent(duelId)}`;
}

function buildResultHash(record: DuelArenaOracleRecord): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        duelId: record.duelId,
        cycleId: record.cycleId,
        duelKeyHex: record.duelKeyHex,
        winnerId: record.winnerId,
        loserId: record.loserId,
        winReason: record.winReason,
        seed: record.seed,
        replayHashHex: record.replayHashHex,
        duelEndTime: record.duelEndTime,
      }),
    )
    .digest("hex");
}

function resolveOracleDuelStartTime(record: DuelArenaOracleRecord): number {
  return Math.max(
    record.fightStartTime ?? record.betCloseTime,
    record.betCloseTime,
  );
}

function encodeString(value: string): Buffer {
  const data = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32LE(data.length, 0);
  return Buffer.concat([length, data]);
}

function encodeI64(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigInt64LE(BigInt(Math.trunc(value)), 0);
  return buffer;
}

function encodeU64(value: bigint): Buffer {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64LE(value, 0);
  return buffer;
}

function ixDiscriminator(name: string): Buffer {
  return crypto
    .createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

function parseSolanaSignerSecret(raw: string | null): Keypair | null {
  if (!raw) return null;
  let trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    if (
      trimmed.endsWith(".json") ||
      trimmed.startsWith("~/") ||
      trimmed.startsWith("./") ||
      trimmed.startsWith("../") ||
      trimmed.startsWith("/")
    ) {
      const resolvedPath = trimmed.startsWith("~/")
        ? path.resolve(process.env.HOME || "", trimmed.slice(2))
        : path.resolve(trimmed);
      trimmed = awaitReadJsonSecret(resolvedPath);
    }

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const parsed = JSON.parse(trimmed) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(parsed));
    }

    if (trimmed.includes(",")) {
      const values = trimmed.split(",").map((part) => Number(part.trim()));
      return Keypair.fromSecretKey(Uint8Array.from(values));
    }

    const base64Raw = trimmed.startsWith("base64:")
      ? trimmed.slice("base64:".length).trim()
      : trimmed;
    const decoded = Buffer.from(base64Raw, "base64");
    if (decoded.length === 64) {
      return Keypair.fromSecretKey(Uint8Array.from(decoded));
    }
  } catch (error) {
    Logger.warn(
      "DuelArenaOraclePublisher",
      `Failed to parse Solana signer secret: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return null;
}

function awaitReadJsonSecret(filePath: string): string {
  return readFileSync(filePath, "utf8").trim();
}

class SolanaOracleTarget {
  public readonly key: DuelArenaOracleChainKey;
  public readonly label: string;
  private readonly programId: PublicKey;
  private readonly connection: Connection;
  private readonly authority: Keypair | null;
  private readonly reporter: Keypair | null;
  private configReady: Promise<void> | null = null;

  public constructor(config: DuelArenaOracleSolanaTargetConfig) {
    this.key = config.key;
    this.label = config.label;
    this.programId = new PublicKey(config.programId);
    this.connection = new Connection(config.rpcUrl, {
      wsEndpoint: config.wsUrl,
      commitment: "confirmed",
    });
    this.authority = parseSolanaSignerSecret(config.authoritySecret);
    this.reporter =
      parseSolanaSignerSecret(config.reporterSecret) ?? this.authority;
  }

  public async publishAnnouncement(
    record: DuelArenaOracleRecord,
  ): Promise<string> {
    await this.ensureOracleConfig();
    return this.upsertRecord(record, "BETTING_OPEN");
  }

  public async publishFightStart(
    record: DuelArenaOracleRecord,
  ): Promise<string> {
    await this.ensureOracleConfig();
    return this.upsertRecord(record, "LOCKED");
  }

  public async publishCancellation(
    record: DuelArenaOracleRecord,
  ): Promise<string> {
    await this.ensureOracleConfig();
    await this.upsertRecord(
      record,
      record.fightStartTime ? "LOCKED" : "BETTING_OPEN",
    );
    const reporter = this.requireReporter();
    const duelKey = Buffer.from(record.duelKeyHex, "hex");
    const oracleConfigPda = this.findOracleConfigPda();
    const duelStatePda = this.findDuelStatePda(duelKey);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: reporter.publicKey, isSigner: true, isWritable: true },
        { pubkey: oracleConfigPda, isSigner: false, isWritable: false },
        { pubkey: duelStatePda, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([
        ixDiscriminator("cancel_duel"),
        duelKey,
        encodeString(record.metadataUri),
      ]),
    });
    return this.sendWithSigner(ix, reporter);
  }

  public async publishResolution(
    record: DuelArenaOracleRecord,
  ): Promise<string> {
    await this.ensureOracleConfig();
    await this.upsertRecord(record, "LOCKED");
    if (!record.winnerSide || !record.seed || !record.replayHashHex) {
      throw new Error("Resolved duel is missing winner/seed/replayHash data");
    }
    const reporter = this.requireReporter();
    const duelKey = Buffer.from(record.duelKeyHex, "hex");
    const oracleConfigPda = this.findOracleConfigPda();
    const duelStatePda = this.findDuelStatePda(duelKey);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: reporter.publicKey, isSigner: true, isWritable: true },
        { pubkey: oracleConfigPda, isSigner: false, isWritable: false },
        { pubkey: duelStatePda, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([
        ixDiscriminator("report_result"),
        duelKey,
        Buffer.from([WINNER_SIDE_TO_VARIANT[record.winnerSide]]),
        encodeU64(BigInt(record.seed)),
        Buffer.from(record.replayHashHex, "hex"),
        Buffer.from(record.resultHashHex || buildResultHash(record), "hex"),
        encodeI64(record.duelEndTime || Date.now()),
        encodeString(record.metadataUri),
      ]),
    });
    return this.sendWithSigner(ix, reporter);
  }

  private async ensureOracleConfig(): Promise<void> {
    if (this.configReady) {
      return this.configReady;
    }

    this.configReady = (async () => {
      const oracleConfigPda = this.findOracleConfigPda();
      const existing = await this.connection.getAccountInfo(oracleConfigPda);
      if (existing) {
        return;
      }

      const authority = this.authority;
      const reporter = this.reporter ?? authority;
      if (!authority || !reporter) {
        throw new Error(
          `${this.label}: missing authority/reporter signer for oracle config initialization`,
        );
      }

      const programDataAddress = PublicKey.findProgramAddressSync(
        [this.programId.toBuffer()],
        new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
      )[0];

      const ix = new TransactionInstruction({
        programId: this.programId,
        keys: [
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: oracleConfigPda, isSigner: false, isWritable: true },
          { pubkey: this.programId, isSigner: false, isWritable: false },
          { pubkey: programDataAddress, isSigner: false, isWritable: false },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: Buffer.concat([
          ixDiscriminator("initialize_oracle"),
          reporter.publicKey.toBuffer(),
        ]),
      });

      await this.sendWithSigner(ix, authority);
    })();

    try {
      await this.configReady;
    } catch (error) {
      this.configReady = null;
      throw error;
    }
  }

  private async upsertRecord(
    record: DuelArenaOracleRecord,
    status: Extract<DuelArenaOracleStatus, "BETTING_OPEN" | "LOCKED">,
  ): Promise<string> {
    const reporter = this.requireReporter();
    const duelKey = Buffer.from(record.duelKeyHex, "hex");
    const oracleConfigPda = this.findOracleConfigPda();
    const duelStatePda = this.findDuelStatePda(duelKey);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: reporter.publicKey, isSigner: true, isWritable: true },
        { pubkey: oracleConfigPda, isSigner: false, isWritable: false },
        { pubkey: duelStatePda, isSigner: false, isWritable: true },
        {
          pubkey: SystemProgram.programId,
          isSigner: false,
          isWritable: false,
        },
      ],
      data: Buffer.concat([
        ixDiscriminator("upsert_duel"),
        duelKey,
        Buffer.from(record.participantA.hashHex, "hex"),
        Buffer.from(record.participantB.hashHex, "hex"),
        encodeI64(record.betOpenTime),
        encodeI64(record.betCloseTime),
        encodeI64(resolveOracleDuelStartTime(record)),
        encodeString(record.metadataUri),
        Buffer.from([SOLANA_STATUS_TO_VARIANT[status]]),
      ]),
    });
    return this.sendWithSigner(ix, reporter);
  }

  private findOracleConfigPda(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [ORACLE_CONFIG_SEED],
      this.programId,
    )[0];
  }

  private findDuelStatePda(duelKey: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync(
      [DUEL_SEED, duelKey],
      this.programId,
    )[0];
  }

  private requireReporter(): Keypair {
    if (!this.reporter) {
      throw new Error(`${this.label}: reporter signer is not configured`);
    }
    return this.reporter;
  }

  private async sendWithSigner(
    instruction: TransactionInstruction,
    signer: Keypair,
  ): Promise<string> {
    const latestBlockhash =
      await this.connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({
      feePayer: signer.publicKey,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    }).add(instruction);

    transaction.sign(signer);
    const signature = await this.connection.sendRawTransaction(
      transaction.serialize(),
      {
        preflightCommitment: "confirmed",
      },
    );
    await this.connection.confirmTransaction(
      {
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      "confirmed",
    );
    return signature;
  }
}

type OracleWorld = World & {
  duelArenaOraclePublisher?: DuelArenaOraclePublisher;
};

type DuelArenaOraclePublisherDeps = {
  getStreamingDuelScheduler?: typeof getStreamingDuelScheduler;
};

type AuthoritativeEventExpectation = {
  eventName: string;
  duelId: string;
  cycleId: string;
  duelKeyHex: string;
  agent1Id: string;
  agent2Id: string;
  phases: readonly string[];
  outcome?: "win" | "draw";
  winnerId?: string | null;
  loserId?: string | null;
  betOpenTime?: number;
  betCloseTime?: number;
  fightStartTime?: number;
  duelEndTime?: number;
  seed?: string | null;
  replayHash?: string | null;
};

export class DuelArenaOraclePublisher {
  private readonly records = new Map<string, DuelArenaOracleRecord>();
  private readonly listeners: Array<{
    event: string;
    handler: (payload: unknown) => void;
  }> = [];
  private readonly solanaTargets: SolanaOracleTarget[];
  private readonly getStreamingDuelSchedulerFn: typeof getStreamingDuelScheduler;
  private persistQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly world: World,
    private readonly config: DuelArenaOracleConfig,
    deps: DuelArenaOraclePublisherDeps = {},
  ) {
    this.getStreamingDuelSchedulerFn =
      deps.getStreamingDuelScheduler ?? getStreamingDuelScheduler;
    this.solanaTargets = config.solanaTargets.map(
      (target) => new SolanaOracleTarget(target),
    );
  }

  public async init(): Promise<void> {
    await this.loadPersistedRecords();
    this.attach();
    (this.world as OracleWorld).duelArenaOraclePublisher = this;
    Logger.info("DuelArenaOraclePublisher", "Initialized duel arena oracle", {
      profile: this.config.profile,
      solanaTargets: this.solanaTargets.length,
      metadataBaseUrl: this.config.metadataBaseUrl,
      storePath: this.config.storePath,
    });
  }

  public destroy(): void {
    for (const { event, handler } of this.listeners) {
      this.world.off(event, handler);
    }
    this.listeners.length = 0;
  }

  public getRecord(duelId: string): DuelArenaOracleRecord | null {
    return this.records.get(duelId) ?? null;
  }

  public getRecentRecords(limit: number = 50): DuelArenaOracleRecord[] {
    return Array.from(this.records.values())
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(1, limit));
  }

  private attach(): void {
    this.on("streaming:announcement:start", (payload) => {
      this.runEventHandler("streaming:announcement:start", () =>
        this.handleAnnouncement(payload),
      );
    });
    this.on("streaming:fight:start", (payload) => {
      this.runEventHandler("streaming:fight:start", () =>
        this.handleFightStart(payload),
      );
    });
    this.on("streaming:resolution:start", (payload) => {
      this.runEventHandler("streaming:resolution:start", () =>
        this.handleResolution(payload),
      );
    });
    this.on("streaming:cycle:aborted", (payload) => {
      this.runEventHandler("streaming:cycle:aborted", () =>
        this.handleAbort(payload),
      );
    });
  }

  private runEventHandler(
    eventName: string,
    handler: () => Promise<void>,
  ): void {
    void handler().catch((error) => {
      Logger.error(
        "DuelArenaOraclePublisher",
        `Failed to handle ${eventName}`,
        error instanceof Error ? error : null,
      );
    });
  }

  private on(event: string, handler: (payload: unknown) => void): void {
    this.listeners.push({ event, handler });
    this.world.on(event, handler);
  }

  private rejectTransition(
    eventName: string,
    duelId: string | null,
    reason: string,
  ): void {
    Logger.error(
      "DuelArenaOraclePublisher",
      "Rejected non-canonical oracle lifecycle event",
      null,
      { eventName, duelId, reason },
    );
  }

  private getAuthoritativeMismatch(
    expected: AuthoritativeEventExpectation,
  ): string | null {
    const scheduler = this.getStreamingDuelSchedulerFn();
    const cycle = scheduler?.getCurrentCycle();
    if (!cycle) return "authoritative_cycle_missing";
    if (cycle.duelId !== expected.duelId) return "duel_id_mismatch";
    if (cycle.cycleId !== expected.cycleId) return "cycle_id_mismatch";
    if (cycle.duelKeyHex !== expected.duelKeyHex) return "duel_key_mismatch";
    if (cycle.agent1?.characterId !== expected.agent1Id)
      return "participant_a_mismatch";
    if (cycle.agent2?.characterId !== expected.agent2Id)
      return "participant_b_mismatch";
    if (!expected.phases.includes(cycle.phase)) return "phase_mismatch";
    if (expected.outcome !== undefined && cycle.outcome !== expected.outcome)
      return "outcome_mismatch";
    if (expected.winnerId !== undefined && cycle.winnerId !== expected.winnerId)
      return "winner_mismatch";
    if (expected.loserId !== undefined && cycle.loserId !== expected.loserId)
      return "loser_mismatch";
    if (
      expected.betOpenTime !== undefined &&
      cycle.betOpenTime !== expected.betOpenTime
    )
      return "bet_open_time_mismatch";
    if (
      expected.betCloseTime !== undefined &&
      cycle.betCloseTime !== expected.betCloseTime
    )
      return "bet_close_time_mismatch";
    if (
      expected.fightStartTime !== undefined &&
      cycle.phaseStartTime !== expected.fightStartTime
    )
      return "fight_start_time_mismatch";
    if (
      expected.duelEndTime !== undefined &&
      cycle.duelEndTime !== expected.duelEndTime
    )
      return "duel_end_time_mismatch";
    if (expected.seed !== undefined && cycle.seed !== expected.seed)
      return "seed_mismatch";
    if (
      expected.replayHash !== undefined &&
      cycle.replayHash !== expected.replayHash
    )
      return "replay_hash_mismatch";
    return null;
  }

  private async handleAnnouncement(payload: unknown): Promise<void> {
    const event = payload as DuelArenaOracleAnnouncementEvent;
    if (
      !event?.duelId ||
      !event.cycleId ||
      !event.duelKeyHex ||
      !event.agent1?.id ||
      !event.agent2?.id ||
      event.agent1.id === event.agent2.id ||
      !Number.isFinite(event.betOpenTime) ||
      !Number.isFinite(event.betCloseTime) ||
      event.betCloseTime <= event.betOpenTime
    ) {
      this.rejectTransition(
        "streaming:announcement:start",
        event?.duelId ?? null,
        "invalid_payload",
      );
      return;
    }

    const authoritativeMismatch = this.getAuthoritativeMismatch({
      eventName: "streaming:announcement:start",
      duelId: event.duelId,
      cycleId: event.cycleId,
      duelKeyHex: event.duelKeyHex,
      agent1Id: event.agent1.id,
      agent2Id: event.agent2.id,
      phases: ["ANNOUNCEMENT"],
      betOpenTime: event.betOpenTime,
      betCloseTime: event.betCloseTime,
    });
    if (authoritativeMismatch) {
      this.rejectTransition(
        "streaming:announcement:start",
        event.duelId,
        authoritativeMismatch,
      );
      return;
    }

    const participantA: DuelArenaOracleParticipant = {
      id: event.agent1.id,
      name: event.agent1.name,
      hashHex: hashParticipant(event.agent1.id),
    };
    const participantB: DuelArenaOracleParticipant = {
      id: event.agent2.id,
      name: event.agent2.name,
      hashHex: hashParticipant(event.agent2.id),
    };
    const existing = this.records.get(event.duelId);
    if (existing) {
      const isExactReplay =
        existing.status === "BETTING_OPEN" &&
        existing.cycleId === event.cycleId &&
        existing.duelKeyHex === event.duelKeyHex &&
        existing.participantA.id === event.agent1.id &&
        existing.participantB.id === event.agent2.id &&
        existing.betOpenTime === event.betOpenTime &&
        existing.betCloseTime === event.betCloseTime;
      if (!isExactReplay) {
        this.rejectTransition(
          "streaming:announcement:start",
          event.duelId,
          "immutable_record_mismatch",
        );
      }
      return;
    }

    const createdAt = nowIso();
    const updatedAt = nowIso();
    const record: DuelArenaOracleRecord = {
      duelId: event.duelId,
      cycleId: event.cycleId,
      duelKeyHex: event.duelKeyHex,
      status: "BETTING_OPEN",
      metadataUri: buildMetadataUri(this.config.metadataBaseUrl, event.duelId),
      participantA,
      participantB,
      betOpenTime: event.betOpenTime,
      betCloseTime: event.betCloseTime,
      fightStartTime: null,
      duelEndTime: null,
      winnerId: null,
      loserId: null,
      winnerSide: null,
      winnerName: null,
      loserName: null,
      winReason: null,
      seed: null,
      replayHashHex: null,
      resultHashHex: null,
      chainState: {},
      createdAt,
      updatedAt,
    };
    this.records.set(record.duelId, record);
    await this.persistRecords();
    await this.publishAcrossTargets(record, "UPSERT");
  }

  private async handleFightStart(payload: unknown): Promise<void> {
    const event = payload as DuelArenaOracleFightStartEvent;
    if (
      !event?.duelId ||
      !event.cycleId ||
      !event.duelKeyHex ||
      !event.agent1Id ||
      !event.agent2Id ||
      event.agent1Id === event.agent2Id ||
      !Number.isFinite(event.betCloseTime) ||
      !Number.isFinite(event.fightStartTime)
    ) {
      this.rejectTransition(
        "streaming:fight:start",
        event?.duelId ?? null,
        "invalid_payload",
      );
      return;
    }

    const existing = this.records.get(event.duelId);
    if (!existing) {
      this.rejectTransition(
        "streaming:fight:start",
        event.duelId,
        "record_missing",
      );
      return;
    }

    const authoritativeMismatch = this.getAuthoritativeMismatch({
      eventName: "streaming:fight:start",
      duelId: event.duelId,
      cycleId: event.cycleId,
      duelKeyHex: event.duelKeyHex,
      agent1Id: event.agent1Id,
      agent2Id: event.agent2Id,
      phases: ["FIGHTING"],
      betCloseTime: event.betCloseTime,
      fightStartTime: event.fightStartTime,
    });
    const recordMismatch =
      existing.cycleId !== event.cycleId ||
      existing.duelKeyHex !== event.duelKeyHex ||
      existing.participantA.id !== event.agent1Id ||
      existing.participantB.id !== event.agent2Id;
    if (authoritativeMismatch || recordMismatch) {
      this.rejectTransition(
        "streaming:fight:start",
        event.duelId,
        authoritativeMismatch ?? "immutable_record_mismatch",
      );
      return;
    }
    if (existing.status === "LOCKED") {
      if (
        existing.fightStartTime !== event.fightStartTime ||
        existing.betCloseTime !== event.betCloseTime
      ) {
        this.rejectTransition(
          "streaming:fight:start",
          event.duelId,
          "locked_record_mismatch",
        );
      }
      return;
    }
    if (existing.status !== "BETTING_OPEN") {
      this.rejectTransition(
        "streaming:fight:start",
        event.duelId,
        "terminal_state_regression",
      );
      return;
    }

    const lockedRecord: DuelArenaOracleRecord = {
      ...existing,
      status: "LOCKED",
      betCloseTime: event.betCloseTime,
      fightStartTime: event.fightStartTime,
      updatedAt: nowIso(),
    };
    this.records.set(lockedRecord.duelId, lockedRecord);
    await this.persistRecords();
    await this.publishAcrossTargets(lockedRecord, "UPSERT");
  }

  private async handleResolution(payload: unknown): Promise<void> {
    const event = payload as DuelArenaOracleResolutionEvent;
    if (
      !event?.duelId ||
      !event.cycleId ||
      !event.duelKeyHex ||
      (event.outcome !== "win" && event.outcome !== "draw") ||
      !Number.isFinite(event.duelEndTime)
    ) {
      this.rejectTransition(
        "streaming:resolution:start",
        event?.duelId ?? null,
        "invalid_payload",
      );
      return;
    }

    const existing = this.records.get(event.duelId);
    if (!existing) {
      this.rejectTransition(
        "streaming:resolution:start",
        event.duelId,
        "record_missing",
      );
      return;
    }

    if (event.outcome === "draw") {
      if (
        event.winReason !== "draw" ||
        event.winnerId !== null ||
        event.loserId !== null
      ) {
        this.rejectTransition(
          "streaming:resolution:start",
          event.duelId,
          "contradictory_draw_payload",
        );
        return;
      }
      await this.handleAbort({
        duelId: event.duelId,
        cycleId: event.cycleId,
        duelKeyHex: event.duelKeyHex,
        reason: "draw",
        agent1Id: existing.participantA.id,
        agent2Id: existing.participantB.id,
        agent1Name: existing.participantA.name,
        agent2Name: existing.participantB.name,
      });
      return;
    }

    if (
      !event.winnerId ||
      !event.loserId ||
      event.winnerId === event.loserId ||
      event.winReason === "draw" ||
      !event.seed ||
      !event.replayHash
    ) {
      this.rejectTransition(
        "streaming:resolution:start",
        event.duelId,
        "invalid_win_payload",
      );
      return;
    }

    const participantPairMatches =
      (existing.participantA.id === event.winnerId &&
        existing.participantB.id === event.loserId) ||
      (existing.participantA.id === event.loserId &&
        existing.participantB.id === event.winnerId);
    const authoritativeMismatch = this.getAuthoritativeMismatch({
      eventName: "streaming:resolution:start",
      duelId: event.duelId,
      cycleId: event.cycleId,
      duelKeyHex: event.duelKeyHex,
      agent1Id: existing.participantA.id,
      agent2Id: existing.participantB.id,
      phases: ["RESOLUTION"],
      outcome: "win",
      winnerId: event.winnerId,
      loserId: event.loserId,
      duelEndTime: event.duelEndTime,
      seed: event.seed,
      replayHash: event.replayHash,
    });
    const recordMismatch =
      existing.cycleId !== event.cycleId ||
      existing.duelKeyHex !== event.duelKeyHex ||
      !participantPairMatches;
    if (authoritativeMismatch || recordMismatch) {
      this.rejectTransition(
        "streaming:resolution:start",
        event.duelId,
        authoritativeMismatch ?? "immutable_record_mismatch",
      );
      return;
    }

    if (existing.status === "RESOLVED") {
      const isExactReplay =
        existing.winnerId === event.winnerId &&
        existing.loserId === event.loserId &&
        existing.duelEndTime === event.duelEndTime &&
        existing.seed === event.seed &&
        existing.replayHashHex === event.replayHash;
      if (!isExactReplay) {
        this.rejectTransition(
          "streaming:resolution:start",
          event.duelId,
          "resolved_record_mismatch",
        );
      }
      return;
    }
    if (existing.status !== "BETTING_OPEN" && existing.status !== "LOCKED") {
      this.rejectTransition(
        "streaming:resolution:start",
        event.duelId,
        "terminal_state_conflict",
      );
      return;
    }

    const winnerSide: DuelArenaOracleWinnerSide =
      existing.participantA.id === event.winnerId ? "A" : "B";
    const resolvedRecord: DuelArenaOracleRecord = {
      ...existing,
      status: "RESOLVED",
      duelEndTime: event.duelEndTime,
      winnerId: event.winnerId,
      loserId: event.loserId,
      winnerName: event.winnerName,
      loserName: event.loserName,
      winReason: event.winReason,
      seed: event.seed,
      replayHashHex: event.replayHash,
      winnerSide,
      resultHashHex: null,
      updatedAt: nowIso(),
    };
    resolvedRecord.resultHashHex = buildResultHash(resolvedRecord);
    this.records.set(resolvedRecord.duelId, resolvedRecord);
    await this.persistRecords();

    if (this.config.settlementDelayMs > 0) {
      Logger.info(
        "DuelArenaOraclePublisher",
        `Delaying oracle publish for ${resolvedRecord.duelId} by ${this.config.settlementDelayMs}ms to sync with stream`,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.settlementDelayMs),
      );
    }

    const latest = this.records.get(resolvedRecord.duelId);
    if (
      latest?.status !== "RESOLVED" ||
      latest.resultHashHex !== resolvedRecord.resultHashHex
    ) {
      this.rejectTransition(
        "streaming:resolution:start",
        resolvedRecord.duelId,
        "terminal_state_changed_during_delay",
      );
      return;
    }
    await this.publishAcrossTargets(resolvedRecord, "RESOLVE");
  }

  private async handleAbort(payload: unknown): Promise<void> {
    const event = payload as DuelArenaOracleAbortEvent;
    if (
      !event?.duelId ||
      !event.cycleId ||
      !event.duelKeyHex ||
      !event.reason ||
      !event.agent1Id ||
      !event.agent2Id ||
      event.agent1Id === event.agent2Id
    ) {
      this.rejectTransition(
        "streaming:cycle:aborted",
        event?.duelId ?? null,
        "invalid_payload",
      );
      return;
    }

    const existing = this.records.get(event.duelId);
    if (!existing) {
      this.rejectTransition(
        "streaming:cycle:aborted",
        event.duelId,
        "record_missing",
      );
      return;
    }

    const isDraw = event.reason === "draw";
    const authoritativeMismatch = this.getAuthoritativeMismatch({
      eventName: "streaming:cycle:aborted",
      duelId: event.duelId,
      cycleId: event.cycleId,
      duelKeyHex: event.duelKeyHex,
      agent1Id: event.agent1Id,
      agent2Id: event.agent2Id,
      phases: isDraw
        ? ["RESOLUTION"]
        : ["ANNOUNCEMENT", "COUNTDOWN", "FIGHTING"],
      outcome: isDraw ? "draw" : undefined,
      winnerId: isDraw ? null : undefined,
      loserId: isDraw ? null : undefined,
    });
    const recordMismatch =
      existing.cycleId !== event.cycleId ||
      existing.duelKeyHex !== event.duelKeyHex ||
      existing.participantA.id !== event.agent1Id ||
      existing.participantB.id !== event.agent2Id;
    if (authoritativeMismatch || recordMismatch) {
      this.rejectTransition(
        "streaming:cycle:aborted",
        event.duelId,
        authoritativeMismatch ?? "immutable_record_mismatch",
      );
      return;
    }

    if (existing.status === "CANCELLED") {
      return;
    }
    if (existing.status === "RESOLVED") {
      this.rejectTransition(
        "streaming:cycle:aborted",
        event.duelId,
        "resolved_state_is_immutable",
      );
      return;
    }

    const cancelledRecord: DuelArenaOracleRecord = {
      ...existing,
      status: "CANCELLED",
      winnerId: null,
      loserId: null,
      winnerSide: null,
      winnerName: null,
      loserName: null,
      winReason: isDraw ? "draw" : null,
      seed: null,
      replayHashHex: null,
      resultHashHex: null,
      updatedAt: nowIso(),
    };
    this.records.set(cancelledRecord.duelId, cancelledRecord);
    await this.persistRecords();
    await this.publishAcrossTargets(cancelledRecord, "CANCEL");
  }

  private async publishAcrossTargets(
    record: DuelArenaOracleRecord,
    action: "UPSERT" | "RESOLVE" | "CANCEL",
  ): Promise<void> {
    for (const target of this.solanaTargets) {
      await this.publishToTarget(record, target, action);
    }
  }

  private async publishToTarget(
    record: DuelArenaOracleRecord,
    target: SolanaOracleTarget,
    action: "UPSERT" | "RESOLVE" | "CANCEL",
  ): Promise<void> {
    try {
      let txHash: string;
      if (action === "UPSERT") {
        txHash =
          record.status === "LOCKED"
            ? await target.publishFightStart(record)
            : await target.publishAnnouncement(record);
      } else if (action === "RESOLVE") {
        txHash = await target.publishResolution(record);
      } else {
        txHash = await target.publishCancellation(record);
      }
      this.updateChainState(record.duelId, target.key, {
        target: target.key,
        kind: "solana",
        label: target.label,
        lastAction: action,
        lastTxHash: txHash,
        lastError: null,
        updatedAt: nowIso(),
      });
    } catch (error) {
      let errorMessage = error instanceof Error ? error.message : String(error);

      if (error && typeof error === "object" && "logs" in error) {
        const logs = (error as { logs?: unknown }).logs;
        if (Array.isArray(logs)) {
          errorMessage = errorMessage
            .replace(
              /Catch the `SendTransactionError` and call `getLogs\(\)` on it for full details\./g,
              "",
            )
            .trim();

          const logsStr = logs.join("\n  ");
          errorMessage = `${errorMessage}\nTransaction Logs:\n  ${logsStr}`;

          if (logsStr.includes("insufficient lamports")) {
            errorMessage = `Insufficient SOL to pay for transaction rent or fees.\n${errorMessage}`;
          }
        }
      }

      this.updateChainState(record.duelId, target.key, {
        target: target.key,
        kind: "solana",
        label: target.label,
        lastAction: action,
        lastTxHash: null,
        lastError: errorMessage,
        updatedAt: nowIso(),
      });
      Logger.warn(
        "DuelArenaOraclePublisher",
        `Failed oracle publish on ${target.label} (${action}) for ${record.duelId}: ${errorMessage}`,
      );
    }
  }

  private updateChainState(
    duelId: string,
    targetKey: DuelArenaOracleChainKey,
    nextState: DuelArenaOracleChainState,
  ): void {
    const record = this.records.get(duelId);
    if (!record) return;
    record.chainState[targetKey] = nextState;
    record.updatedAt = nowIso();
    this.records.set(duelId, record);
    void this.persistRecords();
  }

  private async loadPersistedRecords(): Promise<void> {
    try {
      const raw = await fs.readFile(this.config.storePath, "utf8");
      const parsed = JSON.parse(raw) as DuelArenaOracleStoreFile;
      for (const record of parsed.records || []) {
        this.records.set(record.duelId, record);
      }
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: string }).code === "string"
          ? (error as { code: string }).code
          : null;
      if (code !== "ENOENT") {
        Logger.warn(
          "DuelArenaOraclePublisher",
          `Failed to load persisted oracle records: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async persistRecords(): Promise<void> {
    const snapshot: DuelArenaOracleStoreFile = {
      updatedAt: nowIso(),
      records: Array.from(this.records.values()).sort((left, right) =>
        left.duelId.localeCompare(right.duelId),
      ),
    };

    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(async () => {
        const directory = path.dirname(this.config.storePath);
        await fs.mkdir(directory, { recursive: true });
        const tempPath = `${this.config.storePath}.tmp`;
        await fs.writeFile(tempPath, JSON.stringify(snapshot, null, 2) + "\n");
        await fs.rename(tempPath, this.config.storePath);
      });

    await this.persistQueue;
  }
}

export function getDuelArenaOraclePublisher(
  world: World,
): DuelArenaOraclePublisher | null {
  return (world as OracleWorld).duelArenaOraclePublisher ?? null;
}
