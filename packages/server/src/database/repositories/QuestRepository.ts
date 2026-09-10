/**
 * QuestRepository - Quest progress database operations
 *
 * Tracks player quest progress, completion status, and quest points.
 * Each row in quest_progress represents a player's state for a specific quest.
 *
 * Responsibilities:
 * - Start quests (create progress row)
 * - Update quest stage and progress
 * - Complete quests
 * - Query quest status and progress
 * - Manage quest points
 * - Audit logging for all quest state changes
 *
 * Used by: QuestSystem
 */

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { BaseRepository } from "./BaseRepository";
import * as schema from "../schema";

/** Quest audit action types */
export type QuestAuditAction =
  "started" | "progressed" | "completed" | "abandoned";

/** Database status values (not including derived "ready_to_complete") */
export type QuestDbStatus = "not_started" | "in_progress" | "completed";

/** Stage progress data stored as JSON */
export interface StageProgress {
  [key: string]: number;
}

/** Quest progress row from database */
export interface QuestProgressRow {
  id: number;
  playerId: string;
  questId: string;
  status: QuestDbStatus;
  currentStage: string | null;
  stageProgress: StageProgress;
  startedAt: number | null;
  completedAt: number | null;
}

export interface QuestGatheringProgressReceiptRow {
  operationId: string;
  playerId: string;
  questId: string;
  questStartedAt: number;
  capturedStage: string;
  rewardItemId: string;
  rewardQuantity: number;
  createdAt: number;
}

export interface ApplyQuestGatheringProgressReceiptRequest {
  operationId: string;
  playerId: string;
  questId: string;
  questStartedAt: number;
  capturedStage: string;
  rewardItemId: string;
  rewardQuantity: number;
  expectedCurrentStage: string;
  expectedProgress: StageProgress;
  resultingStage: string;
  resultingProgress: StageProgress;
}

export type ApplyQuestGatheringProgressReceiptResult =
  | {
      status: "applied" | "replayed";
      currentStage: string;
      stageProgress: StageProgress;
    }
  | {
      status: "stale";
      currentStage: string;
      stageProgress: StageProgress;
    }
  | { status: "retired" };

export type RetireQuestGatheringProgressReceiptResult =
  "retired" | "already_resolved" | "still_active";

export type IgnoreQuestProgressReceiptResult = "ignored" | "already_resolved";

export interface QuestProcessingProgressReceiptRow {
  operationId: string;
  playerId: string;
  questId: string;
  questStartedAt: number;
  capturedStage: string;
  targetId: string;
  quantity: number;
  createdAt: number;
}

export interface ApplyQuestProcessingProgressReceiptRequest extends QuestProcessingProgressReceiptRow {
  expectedCurrentStage: string;
  expectedProgress: StageProgress;
  resultingStage: string;
  resultingProgress: StageProgress;
}

export type ApplyQuestProcessingProgressReceiptResult =
  ApplyQuestGatheringProgressReceiptResult;
export type RetireQuestProcessingProgressReceiptResult =
  RetireQuestGatheringProgressReceiptResult;

export interface QuestKillProgressReceiptRow {
  operationId: string;
  playerId: string;
  questId: string;
  questStartedAt: number;
  capturedStage: string;
  mobId: string;
  mobType: string;
  quantity: number;
  createdAt: number;
}

export interface ApplyQuestKillProgressReceiptRequest extends QuestKillProgressReceiptRow {
  expectedCurrentStage: string;
  expectedProgress: StageProgress;
  resultingStage: string;
  resultingProgress: StageProgress;
}

export type ApplyQuestKillProgressReceiptResult =
  ApplyQuestGatheringProgressReceiptResult;
export type RetireQuestKillProgressReceiptResult =
  RetireQuestGatheringProgressReceiptResult;

function normalizeStageProgress(value: unknown): StageProgress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized: StageProgress = {};
  for (const [key, count] of Object.entries(value)) {
    if (
      !key ||
      key.length > 256 ||
      !Number.isSafeInteger(count) ||
      Number(count) < 0
    ) {
      return null;
    }
    normalized[key] = Number(count);
  }
  return normalized;
}

function stageProgressMatches(
  left: StageProgress,
  right: StageProgress,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && left[key] === right[rightKeys[index]],
    )
  );
}

/**
 * QuestRepository class
 *
 * Provides all quest progress database operations.
 */
export class QuestRepository extends BaseRepository {
  /**
   * Get quest progress for a specific quest
   *
   * @param playerId - The player ID
   * @param questId - The quest identifier
   * @returns Quest progress or null if not started
   */
  async getQuestProgress(
    playerId: string,
    questId: string,
  ): Promise<QuestProgressRow | null> {
    this.ensureDatabase();

    const results = await this.db
      .select()
      .from(schema.questProgress)
      .where(
        and(
          eq(schema.questProgress.playerId, playerId),
          eq(schema.questProgress.questId, questId),
        ),
      )
      .limit(1);

    if (results.length === 0) {
      return null;
    }

    const row = results[0];
    return {
      id: row.id,
      playerId: row.playerId,
      questId: row.questId,
      status: row.status as QuestDbStatus,
      currentStage: row.currentStage,
      stageProgress: (row.stageProgress as StageProgress) || {},
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    };
  }

  /**
   * Get all quest progress for a player
   *
   * @param playerId - The player ID
   * @returns Array of quest progress rows
   */
  async getAllPlayerQuests(playerId: string): Promise<QuestProgressRow[]> {
    this.ensureDatabase();

    const results = await this.db
      .select()
      .from(schema.questProgress)
      .where(eq(schema.questProgress.playerId, playerId));

    return results.map((row) => ({
      id: row.id,
      playerId: row.playerId,
      questId: row.questId,
      status: row.status as QuestDbStatus,
      currentStage: row.currentStage,
      stageProgress: (row.stageProgress as StageProgress) || {},
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    }));
  }

  /** Load unresolved gathering edges in authoritative commit order. */
  async getPendingGatheringProgressReceipts(
    playerId: string,
  ): Promise<QuestGatheringProgressReceiptRow[]> {
    this.ensureDatabase();
    const rows = await this.db
      .select({
        operationId: schema.questGatheringProgressReceipts.operationId,
        playerId: schema.questGatheringProgressReceipts.playerId,
        questId: schema.questGatheringProgressReceipts.questId,
        questStartedAt: schema.questGatheringProgressReceipts.questStartedAt,
        capturedStage: schema.questGatheringProgressReceipts.capturedStage,
        rewardItemId: schema.questGatheringProgressReceipts.rewardItemId,
        rewardQuantity: schema.questGatheringProgressReceipts.rewardQuantity,
        createdAt: schema.questGatheringProgressReceipts.createdAt,
      })
      .from(schema.questGatheringProgressReceipts)
      .where(
        and(
          eq(schema.questGatheringProgressReceipts.playerId, playerId),
          isNull(schema.questGatheringProgressReceipts.resolvedAt),
        ),
      )
      .orderBy(
        asc(schema.questGatheringProgressReceipts.createdAt),
        asc(schema.questGatheringProgressReceipts.id),
      );
    return rows.map((row) => ({
      operationId: row.operationId,
      playerId: row.playerId,
      questId: row.questId,
      questStartedAt: Number(row.questStartedAt),
      capturedStage: row.capturedStage,
      rewardItemId: row.rewardItemId,
      rewardQuantity: Number(row.rewardQuantity),
      createdAt: Number(row.createdAt),
    }));
  }

  /**
   * Apply one captured gathering edge and resolve its receipt atomically.
   * The repository derives the only legal count delta from the immutable
   * receipt; QuestSystem may choose only the manifest-derived resulting stage.
   */
  async applyGatheringProgressReceipt(
    request: ApplyQuestGatheringProgressReceiptRequest,
  ): Promise<ApplyQuestGatheringProgressReceiptResult> {
    if (this.isDestroying) {
      throw new Error("quest_gathering_progress_database_unavailable");
    }
    this.ensureDatabase();

    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const questId = String(request.questId ?? "").trim();
    const capturedStage = String(request.capturedStage ?? "").trim();
    const rewardItemId = String(request.rewardItemId ?? "").trim();
    const expectedCurrentStage = String(
      request.expectedCurrentStage ?? "",
    ).trim();
    const resultingStage = String(request.resultingStage ?? "").trim();
    const questStartedAt = Number(request.questStartedAt);
    const rewardQuantity = Number(request.rewardQuantity);
    const proposedProgress = normalizeStageProgress(request.resultingProgress);
    const expectedBaseProgress = normalizeStageProgress(
      request.expectedProgress,
    );
    if (
      !operationId ||
      operationId.length > 256 ||
      !playerId ||
      playerId.length > 256 ||
      !questId ||
      questId.length > 256 ||
      !capturedStage ||
      capturedStage.length > 256 ||
      !rewardItemId ||
      rewardItemId.length > 256 ||
      !expectedCurrentStage ||
      expectedCurrentStage.length > 256 ||
      !resultingStage ||
      resultingStage.length > 256 ||
      !Number.isSafeInteger(questStartedAt) ||
      questStartedAt < 0 ||
      !Number.isSafeInteger(rewardQuantity) ||
      rewardQuantity <= 0 ||
      !expectedBaseProgress ||
      !proposedProgress
    ) {
      throw new Error("quest_gathering_progress_request_invalid");
    }

    return this.withTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
      );
      const receiptRows = await tx
        .select()
        .from(schema.questGatheringProgressReceipts)
        .where(
          and(
            eq(schema.questGatheringProgressReceipts.operationId, operationId),
            eq(schema.questGatheringProgressReceipts.questId, questId),
          ),
        )
        .limit(1);
      const receipt = receiptRows[0];
      if (!receipt) {
        throw new Error("quest_gathering_progress_receipt_missing");
      }
      if (
        receipt.playerId !== playerId ||
        Number(receipt.questStartedAt) !== questStartedAt ||
        receipt.capturedStage !== capturedStage ||
        receipt.rewardItemId !== rewardItemId ||
        Number(receipt.rewardQuantity) !== rewardQuantity
      ) {
        throw new Error("quest_gathering_progress_receipt_conflict");
      }
      if (
        receipt.resolution === "retired" ||
        receipt.resolution === "ignored"
      ) {
        return { status: "retired" };
      }
      if (receipt.resolution === "applied") {
        const persisted = normalizeStageProgress(receipt.resultingProgress);
        if (!receipt.resultingStage || !persisted) {
          throw new Error("quest_gathering_progress_receipt_corrupt");
        }
        return {
          status: "replayed",
          currentStage: receipt.resultingStage,
          stageProgress: persisted,
        };
      }
      if (receipt.resolution !== null || receipt.resolvedAt !== null) {
        throw new Error("quest_gathering_progress_receipt_corrupt");
      }

      const progressRows = await tx
        .select()
        .from(schema.questProgress)
        .where(
          and(
            eq(schema.questProgress.playerId, playerId),
            eq(schema.questProgress.questId, questId),
          ),
        )
        .limit(1);
      const persistedQuest = progressRows[0];
      if (
        !persistedQuest ||
        persistedQuest.status !== "in_progress" ||
        Number(persistedQuest.startedAt) !== questStartedAt
      ) {
        await tx
          .update(schema.questGatheringProgressReceipts)
          .set({ resolution: "retired", resolvedAt: Date.now() })
          .where(eq(schema.questGatheringProgressReceipts.id, receipt.id));
        return { status: "retired" };
      }

      const currentStage = String(persistedQuest.currentStage ?? "").trim();
      const currentProgress = normalizeStageProgress(
        persistedQuest.stageProgress,
      );
      if (!currentStage || !currentProgress) {
        throw new Error("quest_gathering_progress_state_invalid");
      }
      if (
        currentStage !== expectedCurrentStage ||
        !stageProgressMatches(currentProgress, expectedBaseProgress)
      ) {
        return {
          status: "stale",
          currentStage,
          stageProgress: currentProgress,
        };
      }

      const nextCount = (currentProgress[rewardItemId] ?? 0) + rewardQuantity;
      if (!Number.isSafeInteger(nextCount) || nextCount <= 0) {
        throw new Error("quest_gathering_progress_state_invalid");
      }
      const expectedProgress = {
        ...currentProgress,
        [rewardItemId]: nextCount,
      };
      if (!stageProgressMatches(expectedProgress, proposedProgress)) {
        throw new Error("quest_gathering_progress_result_invalid");
      }

      const updated = await tx
        .update(schema.questProgress)
        .set({
          currentStage: resultingStage,
          stageProgress: expectedProgress,
        })
        .where(eq(schema.questProgress.id, persistedQuest.id))
        .returning({ id: schema.questProgress.id });
      if (updated.length !== 1) {
        throw new Error("quest_gathering_progress_update_failed");
      }

      const now = Date.now();
      await tx
        .update(schema.questGatheringProgressReceipts)
        .set({
          resolution: "applied",
          resolvedAt: now,
          resultingStage,
          resultingProgress: expectedProgress,
        })
        .where(eq(schema.questGatheringProgressReceipts.id, receipt.id));
      await tx.insert(schema.questAuditLog).values({
        playerId,
        questId,
        action: "progressed",
        stageId: resultingStage,
        stageProgress: expectedProgress,
        timestamp: now,
        metadata: {
          source: "gathering_reward",
          operationId,
          rewardItemId,
          rewardQuantity,
          capturedStage,
        },
      });
      return {
        status: "applied",
        currentStage: resultingStage,
        stageProgress: expectedProgress,
      };
    }, "apply gathering quest progress receipt");
  }

  /** Retire an edge only after its captured quest incarnation is gone. */
  async retireGatheringProgressReceipt(
    receipt: QuestGatheringProgressReceiptRow,
  ): Promise<RetireQuestGatheringProgressReceiptResult> {
    if (this.isDestroying) {
      throw new Error("quest_gathering_progress_database_unavailable");
    }
    const operationId = String(receipt.operationId ?? "").trim();
    const playerId = String(receipt.playerId ?? "").trim();
    const questId = String(receipt.questId ?? "").trim();
    const capturedStage = String(receipt.capturedStage ?? "").trim();
    const rewardItemId = String(receipt.rewardItemId ?? "").trim();
    const questStartedAt = Number(receipt.questStartedAt);
    const rewardQuantity = Number(receipt.rewardQuantity);
    if (
      !operationId ||
      !playerId ||
      !questId ||
      !capturedStage ||
      !rewardItemId ||
      !Number.isSafeInteger(questStartedAt) ||
      questStartedAt < 0 ||
      !Number.isSafeInteger(rewardQuantity) ||
      rewardQuantity <= 0
    ) {
      throw new Error("quest_gathering_progress_request_invalid");
    }
    return this.withTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
      );
      const rows = await tx
        .select()
        .from(schema.questGatheringProgressReceipts)
        .where(
          and(
            eq(schema.questGatheringProgressReceipts.operationId, operationId),
            eq(schema.questGatheringProgressReceipts.questId, questId),
          ),
        )
        .limit(1);
      const persisted = rows[0];
      if (!persisted) {
        throw new Error("quest_gathering_progress_receipt_missing");
      }
      if (
        persisted.playerId !== playerId ||
        Number(persisted.questStartedAt) !== questStartedAt ||
        persisted.capturedStage !== capturedStage ||
        persisted.rewardItemId !== rewardItemId ||
        Number(persisted.rewardQuantity) !== rewardQuantity
      ) {
        throw new Error("quest_gathering_progress_receipt_conflict");
      }
      if (persisted.resolution !== null || persisted.resolvedAt !== null) {
        return "already_resolved";
      }
      const active = await tx
        .select({ id: schema.questProgress.id })
        .from(schema.questProgress)
        .where(
          and(
            eq(schema.questProgress.playerId, playerId),
            eq(schema.questProgress.questId, questId),
            eq(schema.questProgress.status, "in_progress"),
            eq(schema.questProgress.startedAt, questStartedAt),
          ),
        )
        .limit(1);
      if (active.length > 0) return "still_active";
      await tx
        .update(schema.questGatheringProgressReceipts)
        .set({ resolution: "retired", resolvedAt: Date.now() })
        .where(eq(schema.questGatheringProgressReceipts.id, persisted.id));
      return "retired";
    }, "retire gathering quest progress receipt");
  }

  /** Resolve a manifest-proven irrelevant gathering edge without progress. */
  async ignoreGatheringProgressReceipt(
    receipt: QuestGatheringProgressReceiptRow,
  ): Promise<IgnoreQuestProgressReceiptResult> {
    if (this.isDestroying) {
      throw new Error("quest_gathering_progress_database_unavailable");
    }
    const operationId = String(receipt.operationId ?? "").trim();
    const playerId = String(receipt.playerId ?? "").trim();
    const questId = String(receipt.questId ?? "").trim();
    if (!operationId || !playerId || !questId) {
      throw new Error("quest_gathering_progress_request_invalid");
    }
    return this.withTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
      );
      const rows = await tx
        .select()
        .from(schema.questGatheringProgressReceipts)
        .where(
          and(
            eq(schema.questGatheringProgressReceipts.operationId, operationId),
            eq(schema.questGatheringProgressReceipts.questId, questId),
          ),
        )
        .limit(1);
      const persisted = rows[0];
      if (!persisted) {
        throw new Error("quest_gathering_progress_receipt_missing");
      }
      if (
        persisted.playerId !== playerId ||
        Number(persisted.questStartedAt) !== receipt.questStartedAt ||
        persisted.capturedStage !== receipt.capturedStage ||
        persisted.rewardItemId !== receipt.rewardItemId ||
        Number(persisted.rewardQuantity) !== receipt.rewardQuantity
      ) {
        throw new Error("quest_gathering_progress_receipt_conflict");
      }
      if (persisted.resolution !== null || persisted.resolvedAt !== null) {
        return "already_resolved";
      }
      await tx
        .update(schema.questGatheringProgressReceipts)
        .set({ resolution: "ignored", resolvedAt: Date.now() })
        .where(eq(schema.questGatheringProgressReceipts.id, persisted.id));
      return "ignored";
    }, "ignore gathering quest progress receipt");
  }

  /** Load unresolved interact-stage edges in authoritative commit order. */
  async getPendingProcessingProgressReceipts(
    playerId: string,
  ): Promise<QuestProcessingProgressReceiptRow[]> {
    this.ensureDatabase();
    const rows = await this.db
      .select({
        operationId: schema.questProcessingProgressReceipts.operationId,
        playerId: schema.questProcessingProgressReceipts.playerId,
        questId: schema.questProcessingProgressReceipts.questId,
        questStartedAt: schema.questProcessingProgressReceipts.questStartedAt,
        capturedStage: schema.questProcessingProgressReceipts.capturedStage,
        targetId: schema.questProcessingProgressReceipts.targetId,
        quantity: schema.questProcessingProgressReceipts.quantity,
        createdAt: schema.questProcessingProgressReceipts.createdAt,
      })
      .from(schema.questProcessingProgressReceipts)
      .where(
        and(
          eq(schema.questProcessingProgressReceipts.playerId, playerId),
          isNull(schema.questProcessingProgressReceipts.resolvedAt),
        ),
      )
      .orderBy(
        asc(schema.questProcessingProgressReceipts.createdAt),
        asc(schema.questProcessingProgressReceipts.id),
      );
    return rows.map((row) => ({
      operationId: row.operationId,
      playerId: row.playerId,
      questId: row.questId,
      questStartedAt: Number(row.questStartedAt),
      capturedStage: row.capturedStage,
      targetId: row.targetId,
      quantity: Number(row.quantity),
      createdAt: Number(row.createdAt),
    }));
  }

  /** Atomically apply one processing output to its captured quest. */
  async applyProcessingProgressReceipt(
    request: ApplyQuestProcessingProgressReceiptRequest,
  ): Promise<ApplyQuestProcessingProgressReceiptResult> {
    if (this.isDestroying) {
      throw new Error("quest_processing_progress_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const questId = String(request.questId ?? "").trim();
    const capturedStage = String(request.capturedStage ?? "").trim();
    const targetId = String(request.targetId ?? "").trim();
    const expectedCurrentStage = String(
      request.expectedCurrentStage ?? "",
    ).trim();
    const resultingStage = String(request.resultingStage ?? "").trim();
    const questStartedAt = Number(request.questStartedAt);
    const quantity = Number(request.quantity);
    const expectedBaseProgress = normalizeStageProgress(
      request.expectedProgress,
    );
    const proposedProgress = normalizeStageProgress(request.resultingProgress);
    if (
      !operationId ||
      operationId.length > 256 ||
      !playerId ||
      playerId.length > 256 ||
      !questId ||
      questId.length > 256 ||
      !capturedStage ||
      capturedStage.length > 256 ||
      !targetId ||
      targetId.length > 256 ||
      !expectedCurrentStage ||
      expectedCurrentStage.length > 256 ||
      !resultingStage ||
      resultingStage.length > 256 ||
      !Number.isSafeInteger(questStartedAt) ||
      questStartedAt < 0 ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      !expectedBaseProgress ||
      !proposedProgress
    ) {
      throw new Error("quest_processing_progress_request_invalid");
    }

    return this.withTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
      );
      const receiptRows = await tx
        .select()
        .from(schema.questProcessingProgressReceipts)
        .where(
          and(
            eq(schema.questProcessingProgressReceipts.operationId, operationId),
            eq(schema.questProcessingProgressReceipts.questId, questId),
            eq(schema.questProcessingProgressReceipts.targetId, targetId),
          ),
        )
        .limit(1);
      const receipt = receiptRows[0];
      if (!receipt) {
        throw new Error("quest_processing_progress_receipt_missing");
      }
      if (
        receipt.playerId !== playerId ||
        Number(receipt.questStartedAt) !== questStartedAt ||
        receipt.capturedStage !== capturedStage ||
        Number(receipt.quantity) !== quantity
      ) {
        throw new Error("quest_processing_progress_receipt_conflict");
      }
      if (
        receipt.resolution === "retired" ||
        receipt.resolution === "ignored"
      ) {
        return { status: "retired" };
      }
      if (receipt.resolution === "applied") {
        const persisted = normalizeStageProgress(receipt.resultingProgress);
        if (!receipt.resultingStage || !persisted) {
          throw new Error("quest_processing_progress_receipt_corrupt");
        }
        return {
          status: "replayed",
          currentStage: receipt.resultingStage,
          stageProgress: persisted,
        };
      }
      if (receipt.resolution !== null || receipt.resolvedAt !== null) {
        throw new Error("quest_processing_progress_receipt_corrupt");
      }

      const progressRows = await tx
        .select()
        .from(schema.questProgress)
        .where(
          and(
            eq(schema.questProgress.playerId, playerId),
            eq(schema.questProgress.questId, questId),
          ),
        )
        .limit(1);
      const persistedQuest = progressRows[0];
      if (
        !persistedQuest ||
        persistedQuest.status !== "in_progress" ||
        Number(persistedQuest.startedAt) !== questStartedAt
      ) {
        await tx
          .update(schema.questProcessingProgressReceipts)
          .set({ resolution: "retired", resolvedAt: Date.now() })
          .where(eq(schema.questProcessingProgressReceipts.id, receipt.id));
        return { status: "retired" };
      }

      const currentStage = String(persistedQuest.currentStage ?? "").trim();
      const currentProgress = normalizeStageProgress(
        persistedQuest.stageProgress,
      );
      if (!currentStage || !currentProgress) {
        throw new Error("quest_processing_progress_state_invalid");
      }
      if (
        currentStage !== expectedCurrentStage ||
        !stageProgressMatches(currentProgress, expectedBaseProgress)
      ) {
        return {
          status: "stale",
          currentStage,
          stageProgress: currentProgress,
        };
      }

      const nextCount = (currentProgress[targetId] ?? 0) + quantity;
      if (!Number.isSafeInteger(nextCount) || nextCount <= 0) {
        throw new Error("quest_processing_progress_state_invalid");
      }
      const expectedProgress = { ...currentProgress, [targetId]: nextCount };
      if (!stageProgressMatches(expectedProgress, proposedProgress)) {
        throw new Error("quest_processing_progress_result_invalid");
      }

      const updated = await tx
        .update(schema.questProgress)
        .set({ currentStage: resultingStage, stageProgress: expectedProgress })
        .where(eq(schema.questProgress.id, persistedQuest.id))
        .returning({ id: schema.questProgress.id });
      if (updated.length !== 1) {
        throw new Error("quest_processing_progress_update_failed");
      }
      const now = Date.now();
      await tx
        .update(schema.questProcessingProgressReceipts)
        .set({
          resolution: "applied",
          resolvedAt: now,
          resultingStage,
          resultingProgress: expectedProgress,
        })
        .where(eq(schema.questProcessingProgressReceipts.id, receipt.id));
      await tx.insert(schema.questAuditLog).values({
        playerId,
        questId,
        action: "progressed",
        stageId: resultingStage,
        stageProgress: expectedProgress,
        timestamp: now,
        metadata: {
          source: "processing_action",
          operationId,
          targetId,
          quantity,
          capturedStage,
        },
      });
      return {
        status: "applied",
        currentStage: resultingStage,
        stageProgress: expectedProgress,
      };
    }, "apply processing quest progress receipt");
  }

  /** Retire a processing edge only after its quest incarnation is gone. */
  async retireProcessingProgressReceipt(
    receipt: QuestProcessingProgressReceiptRow,
  ): Promise<RetireQuestProcessingProgressReceiptResult> {
    if (this.isDestroying) {
      throw new Error("quest_processing_progress_database_unavailable");
    }
    const operationId = String(receipt.operationId ?? "").trim();
    const playerId = String(receipt.playerId ?? "").trim();
    const questId = String(receipt.questId ?? "").trim();
    if (!operationId || !playerId || !questId) {
      throw new Error("quest_processing_progress_request_invalid");
    }
    return this.withTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
      );
      const rows = await tx
        .select()
        .from(schema.questProcessingProgressReceipts)
        .where(
          and(
            eq(schema.questProcessingProgressReceipts.operationId, operationId),
            eq(schema.questProcessingProgressReceipts.questId, questId),
            eq(
              schema.questProcessingProgressReceipts.targetId,
              receipt.targetId,
            ),
          ),
        )
        .limit(1);
      const persisted = rows[0];
      if (!persisted) {
        throw new Error("quest_processing_progress_receipt_missing");
      }
      if (
        persisted.playerId !== playerId ||
        Number(persisted.questStartedAt) !== receipt.questStartedAt ||
        persisted.capturedStage !== receipt.capturedStage ||
        Number(persisted.quantity) !== receipt.quantity
      ) {
        throw new Error("quest_processing_progress_receipt_conflict");
      }
      if (persisted.resolution !== null || persisted.resolvedAt !== null) {
        return "already_resolved";
      }
      const active = await tx
        .select({ id: schema.questProgress.id })
        .from(schema.questProgress)
        .where(
          and(
            eq(schema.questProgress.playerId, playerId),
            eq(schema.questProgress.questId, questId),
            eq(schema.questProgress.status, "in_progress"),
            eq(schema.questProgress.startedAt, receipt.questStartedAt),
          ),
        )
        .limit(1);
      if (active.length > 0) return "still_active";
      await tx
        .update(schema.questProcessingProgressReceipts)
        .set({ resolution: "retired", resolvedAt: Date.now() })
        .where(eq(schema.questProcessingProgressReceipts.id, persisted.id));
      return "retired";
    }, "retire processing quest progress receipt");
  }

  /** Resolve a manifest-proven irrelevant processing edge without progress. */
  async ignoreProcessingProgressReceipt(
    receipt: QuestProcessingProgressReceiptRow,
  ): Promise<IgnoreQuestProgressReceiptResult> {
    if (this.isDestroying) {
      throw new Error("quest_processing_progress_database_unavailable");
    }
    const operationId = String(receipt.operationId ?? "").trim();
    const playerId = String(receipt.playerId ?? "").trim();
    const questId = String(receipt.questId ?? "").trim();
    if (!operationId || !playerId || !questId) {
      throw new Error("quest_processing_progress_request_invalid");
    }
    return this.withTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
      );
      const rows = await tx
        .select()
        .from(schema.questProcessingProgressReceipts)
        .where(
          and(
            eq(schema.questProcessingProgressReceipts.operationId, operationId),
            eq(schema.questProcessingProgressReceipts.questId, questId),
            eq(
              schema.questProcessingProgressReceipts.targetId,
              receipt.targetId,
            ),
          ),
        )
        .limit(1);
      const persisted = rows[0];
      if (!persisted) {
        throw new Error("quest_processing_progress_receipt_missing");
      }
      if (
        persisted.playerId !== playerId ||
        Number(persisted.questStartedAt) !== receipt.questStartedAt ||
        persisted.capturedStage !== receipt.capturedStage ||
        Number(persisted.quantity) !== receipt.quantity
      ) {
        throw new Error("quest_processing_progress_receipt_conflict");
      }
      if (persisted.resolution !== null || persisted.resolvedAt !== null) {
        return "already_resolved";
      }
      await tx
        .update(schema.questProcessingProgressReceipts)
        .set({ resolution: "ignored", resolvedAt: Date.now() })
        .where(eq(schema.questProcessingProgressReceipts.id, persisted.id));
      return "ignored";
    }, "ignore processing quest progress receipt");
  }

  /** Load unresolved authenticated mob-kill edges in commit order. */
  async getPendingKillProgressReceipts(
    playerId: string,
  ): Promise<QuestKillProgressReceiptRow[]> {
    this.ensureDatabase();
    const rows = await this.db
      .select({
        operationId: schema.questKillProgressReceipts.operationId,
        playerId: schema.questKillProgressReceipts.playerId,
        questId: schema.questKillProgressReceipts.questId,
        questStartedAt: schema.questKillProgressReceipts.questStartedAt,
        capturedStage: schema.questKillProgressReceipts.capturedStage,
        mobId: schema.questKillProgressReceipts.mobId,
        mobType: schema.questKillProgressReceipts.mobType,
        quantity: schema.questKillProgressReceipts.quantity,
        createdAt: schema.questKillProgressReceipts.createdAt,
      })
      .from(schema.questKillProgressReceipts)
      .where(
        and(
          eq(schema.questKillProgressReceipts.playerId, playerId),
          isNull(schema.questKillProgressReceipts.resolvedAt),
        ),
      )
      .orderBy(
        asc(schema.questKillProgressReceipts.createdAt),
        asc(schema.questKillProgressReceipts.id),
      );
    return rows.map((row) => ({
      operationId: row.operationId,
      playerId: row.playerId,
      questId: row.questId,
      questStartedAt: Number(row.questStartedAt),
      capturedStage: row.capturedStage,
      mobId: row.mobId,
      mobType: row.mobType,
      quantity: Number(row.quantity),
      createdAt: Number(row.createdAt),
    }));
  }

  /** Atomically apply one authenticated mob kill to its captured quest. */
  async applyKillProgressReceipt(
    request: ApplyQuestKillProgressReceiptRequest,
  ): Promise<ApplyQuestKillProgressReceiptResult> {
    if (this.isDestroying) {
      throw new Error("quest_kill_progress_database_unavailable");
    }
    const operationId = String(request.operationId ?? "").trim();
    const playerId = String(request.playerId ?? "").trim();
    const questId = String(request.questId ?? "").trim();
    const capturedStage = String(request.capturedStage ?? "").trim();
    const mobId = String(request.mobId ?? "").trim();
    const mobType = String(request.mobType ?? "").trim();
    const expectedCurrentStage = String(
      request.expectedCurrentStage ?? "",
    ).trim();
    const resultingStage = String(request.resultingStage ?? "").trim();
    const questStartedAt = Number(request.questStartedAt);
    const quantity = Number(request.quantity);
    const createdAt = Number(request.createdAt);
    const expectedBaseProgress = normalizeStageProgress(
      request.expectedProgress,
    );
    const proposedProgress = normalizeStageProgress(request.resultingProgress);
    if (
      !/^ground-item-mob-loot:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        operationId,
      ) ||
      !playerId ||
      playerId.length > 256 ||
      !questId ||
      questId.length > 256 ||
      !capturedStage ||
      capturedStage.length > 256 ||
      !mobId ||
      mobId.length > 256 ||
      !mobType ||
      mobType.length > 128 ||
      !expectedCurrentStage ||
      expectedCurrentStage.length > 256 ||
      expectedCurrentStage !== capturedStage ||
      !resultingStage ||
      resultingStage.length > 256 ||
      !Number.isSafeInteger(questStartedAt) ||
      questStartedAt < 0 ||
      quantity !== 1 ||
      !Number.isSafeInteger(createdAt) ||
      createdAt < 0 ||
      !expectedBaseProgress ||
      !proposedProgress
    ) {
      throw new Error("quest_kill_progress_request_invalid");
    }

    return this.withTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
      );
      const receiptRows = await tx
        .select()
        .from(schema.questKillProgressReceipts)
        .where(
          and(
            eq(schema.questKillProgressReceipts.operationId, operationId),
            eq(schema.questKillProgressReceipts.questId, questId),
          ),
        )
        .limit(1);
      const receipt = receiptRows[0];
      if (!receipt) {
        throw new Error("quest_kill_progress_receipt_missing");
      }
      if (
        receipt.playerId !== playerId ||
        Number(receipt.questStartedAt) !== questStartedAt ||
        receipt.capturedStage !== capturedStage ||
        receipt.mobId !== mobId ||
        receipt.mobType !== mobType ||
        Number(receipt.quantity) !== quantity ||
        Number(receipt.createdAt) !== createdAt
      ) {
        throw new Error("quest_kill_progress_receipt_conflict");
      }
      if (
        receipt.resolution === "retired" ||
        receipt.resolution === "ignored"
      ) {
        return { status: "retired" };
      }
      if (receipt.resolution === "applied") {
        const persisted = normalizeStageProgress(receipt.resultingProgress);
        if (!receipt.resultingStage || !persisted) {
          throw new Error("quest_kill_progress_receipt_corrupt");
        }
        return {
          status: "replayed",
          currentStage: receipt.resultingStage,
          stageProgress: persisted,
        };
      }
      if (receipt.resolution !== null || receipt.resolvedAt !== null) {
        throw new Error("quest_kill_progress_receipt_corrupt");
      }

      const progressRows = await tx
        .select()
        .from(schema.questProgress)
        .where(
          and(
            eq(schema.questProgress.playerId, playerId),
            eq(schema.questProgress.questId, questId),
          ),
        )
        .limit(1);
      const persistedQuest = progressRows[0];
      if (
        !persistedQuest ||
        persistedQuest.status !== "in_progress" ||
        Number(persistedQuest.startedAt) !== questStartedAt
      ) {
        await tx
          .update(schema.questKillProgressReceipts)
          .set({ resolution: "retired", resolvedAt: Date.now() })
          .where(eq(schema.questKillProgressReceipts.id, receipt.id));
        return { status: "retired" };
      }

      const currentStage = String(persistedQuest.currentStage ?? "").trim();
      const currentProgress = normalizeStageProgress(
        persistedQuest.stageProgress,
      );
      if (!currentStage || !currentProgress) {
        throw new Error("quest_kill_progress_state_invalid");
      }
      if (
        currentStage !== expectedCurrentStage ||
        !stageProgressMatches(currentProgress, expectedBaseProgress)
      ) {
        return {
          status: "stale",
          currentStage,
          stageProgress: currentProgress,
        };
      }

      const nextCount = (currentProgress.kills ?? 0) + quantity;
      if (!Number.isSafeInteger(nextCount) || nextCount <= 0) {
        throw new Error("quest_kill_progress_state_invalid");
      }
      const expectedProgress = { ...currentProgress, kills: nextCount };
      if (!stageProgressMatches(expectedProgress, proposedProgress)) {
        throw new Error("quest_kill_progress_result_invalid");
      }

      const updated = await tx
        .update(schema.questProgress)
        .set({ currentStage: resultingStage, stageProgress: expectedProgress })
        .where(eq(schema.questProgress.id, persistedQuest.id))
        .returning({ id: schema.questProgress.id });
      if (updated.length !== 1) {
        throw new Error("quest_kill_progress_update_failed");
      }
      const now = Date.now();
      await tx
        .update(schema.questKillProgressReceipts)
        .set({
          resolution: "applied",
          resolvedAt: now,
          resultingStage,
          resultingProgress: expectedProgress,
        })
        .where(eq(schema.questKillProgressReceipts.id, receipt.id));
      await tx.insert(schema.questAuditLog).values({
        playerId,
        questId,
        action: "progressed",
        stageId: resultingStage,
        stageProgress: expectedProgress,
        timestamp: now,
        metadata: {
          source: "mob_loot",
          operationId,
          mobId,
          mobType,
          capturedStage,
        },
      });
      return {
        status: "applied",
        currentStage: resultingStage,
        stageProgress: expectedProgress,
      };
    }, "apply kill quest progress receipt");
  }

  /** Retire a kill edge only after its captured quest incarnation is gone. */
  async retireKillProgressReceipt(
    receipt: QuestKillProgressReceiptRow,
  ): Promise<RetireQuestKillProgressReceiptResult> {
    if (this.isDestroying) {
      throw new Error("quest_kill_progress_database_unavailable");
    }
    const operationId = String(receipt.operationId ?? "").trim();
    const playerId = String(receipt.playerId ?? "").trim();
    const questId = String(receipt.questId ?? "").trim();
    if (!operationId || !playerId || !questId) {
      throw new Error("quest_kill_progress_request_invalid");
    }
    return this.withTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
      );
      const rows = await tx
        .select()
        .from(schema.questKillProgressReceipts)
        .where(
          and(
            eq(schema.questKillProgressReceipts.operationId, operationId),
            eq(schema.questKillProgressReceipts.questId, questId),
          ),
        )
        .limit(1);
      const persisted = rows[0];
      if (!persisted) {
        throw new Error("quest_kill_progress_receipt_missing");
      }
      if (
        persisted.playerId !== playerId ||
        Number(persisted.questStartedAt) !== receipt.questStartedAt ||
        persisted.capturedStage !== receipt.capturedStage ||
        persisted.mobId !== receipt.mobId ||
        persisted.mobType !== receipt.mobType ||
        Number(persisted.quantity) !== receipt.quantity ||
        Number(persisted.createdAt) !== receipt.createdAt
      ) {
        throw new Error("quest_kill_progress_receipt_conflict");
      }
      if (persisted.resolution !== null || persisted.resolvedAt !== null) {
        return "already_resolved";
      }
      const active = await tx
        .select({ id: schema.questProgress.id })
        .from(schema.questProgress)
        .where(
          and(
            eq(schema.questProgress.playerId, playerId),
            eq(schema.questProgress.questId, questId),
            eq(schema.questProgress.status, "in_progress"),
            eq(schema.questProgress.startedAt, receipt.questStartedAt),
          ),
        )
        .limit(1);
      if (active.length > 0) return "still_active";
      await tx
        .update(schema.questKillProgressReceipts)
        .set({ resolution: "retired", resolvedAt: Date.now() })
        .where(eq(schema.questKillProgressReceipts.id, persisted.id));
      return "retired";
    }, "retire kill quest progress receipt");
  }

  /** Resolve a manifest-proven irrelevant mob kill without progress. */
  async ignoreKillProgressReceipt(
    receipt: QuestKillProgressReceiptRow,
  ): Promise<IgnoreQuestProgressReceiptResult> {
    if (this.isDestroying) {
      throw new Error("quest_kill_progress_database_unavailable");
    }
    const operationId = String(receipt.operationId ?? "").trim();
    const playerId = String(receipt.playerId ?? "").trim();
    const questId = String(receipt.questId ?? "").trim();
    if (!operationId || !playerId || !questId) {
      throw new Error("quest_kill_progress_request_invalid");
    }
    return this.withTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
      );
      const rows = await tx
        .select()
        .from(schema.questKillProgressReceipts)
        .where(
          and(
            eq(schema.questKillProgressReceipts.operationId, operationId),
            eq(schema.questKillProgressReceipts.questId, questId),
          ),
        )
        .limit(1);
      const persisted = rows[0];
      if (!persisted) {
        throw new Error("quest_kill_progress_receipt_missing");
      }
      if (
        persisted.playerId !== playerId ||
        Number(persisted.questStartedAt) !== receipt.questStartedAt ||
        persisted.capturedStage !== receipt.capturedStage ||
        persisted.mobId !== receipt.mobId ||
        persisted.mobType !== receipt.mobType ||
        Number(persisted.quantity) !== receipt.quantity ||
        Number(persisted.createdAt) !== receipt.createdAt
      ) {
        throw new Error("quest_kill_progress_receipt_conflict");
      }
      if (persisted.resolution !== null || persisted.resolvedAt !== null) {
        return "already_resolved";
      }
      await tx
        .update(schema.questKillProgressReceipts)
        .set({ resolution: "ignored", resolvedAt: Date.now() })
        .where(eq(schema.questKillProgressReceipts.id, persisted.id));
      return "ignored";
    }, "ignore kill quest progress receipt");
  }

  /**
   * Get list of completed quest IDs for a player
   *
   * @param playerId - The player ID
   * @returns Array of completed quest IDs
   */
  async getCompletedQuests(playerId: string): Promise<string[]> {
    this.ensureDatabase();

    const results = await this.db
      .select({ questId: schema.questProgress.questId })
      .from(schema.questProgress)
      .where(
        and(
          eq(schema.questProgress.playerId, playerId),
          eq(schema.questProgress.status, "completed"),
        ),
      );

    return results.map((row) => row.questId);
  }

  /**
   * Start a quest for a player
   *
   * Creates a new quest progress row with status "in_progress".
   *
   * @param playerId - The player ID
   * @param questId - The quest identifier
   * @param initialStage - The starting stage ID
   */
  async startQuest(
    playerId: string,
    questId: string,
    initialStage: string,
    startedAt: number = Date.now(),
  ): Promise<void> {
    if (this.isDestroying) {
      return;
    }

    this.ensureDatabase();

    if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
      throw new Error("quest_started_at_invalid");
    }
    const now = startedAt;

    await this.withTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
      );
      // Create quest progress entry
      await tx.insert(schema.questProgress).values({
        playerId,
        questId,
        status: "in_progress",
        currentStage: initialStage,
        stageProgress: {},
        startedAt: now,
      });

      // Audit log entry for quest start
      await tx.insert(schema.questAuditLog).values({
        playerId,
        questId,
        action: "started",
        stageId: initialStage,
        timestamp: now,
      });
    });
  }

  /**
   * Update quest progress
   *
   * Updates the current stage and/or stage progress for a quest.
   *
   * @param playerId - The player ID
   * @param questId - The quest identifier
   * @param stage - The current stage ID
   * @param progress - Stage progress data (e.g., {"kills": 7})
   */
  async updateProgress(
    playerId: string,
    questId: string,
    stage: string,
    progress: StageProgress,
  ): Promise<void> {
    if (this.isDestroying) {
      return;
    }

    this.ensureDatabase();

    await this.withTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
      );
      await tx
        .update(schema.questProgress)
        .set({
          currentStage: stage,
          stageProgress: progress,
        })
        .where(
          and(
            eq(schema.questProgress.playerId, playerId),
            eq(schema.questProgress.questId, questId),
          ),
        );
    });
  }

  /**
   * Complete a quest
   *
   * Marks the quest as completed with a timestamp.
   *
   * @param playerId - The player ID
   * @param questId - The quest identifier
   */
  async completeQuest(playerId: string, questId: string): Promise<void> {
    if (this.isDestroying) {
      return;
    }

    this.ensureDatabase();

    await this.withTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
      );
      await tx
        .update(schema.questProgress)
        .set({
          status: "completed",
          completedAt: Date.now(),
        })
        .where(
          and(
            eq(schema.questProgress.playerId, playerId),
            eq(schema.questProgress.questId, questId),
          ),
        );
    });
  }

  /**
   * Abandon a quest
   *
   * Deletes the quest progress row, effectively resetting the quest to not_started.
   * Logs the abandonment in the audit log.
   *
   * @param playerId - The player ID
   * @param questId - The quest identifier
   */
  async abandonQuest(
    playerId: string,
    questId: string,
    questStartedAt?: number,
  ): Promise<void> {
    if (this.isDestroying) {
      return;
    }

    this.ensureDatabase();

    if (
      questStartedAt !== undefined &&
      (!Number.isSafeInteger(questStartedAt) || questStartedAt <= 0)
    ) {
      throw new Error("quest_abandon_started_at_invalid");
    }

    await this.withTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
      );
      // Delete quest progress entry
      const deleted = await tx
        .delete(schema.questProgress)
        .where(
          and(
            eq(schema.questProgress.playerId, playerId),
            eq(schema.questProgress.questId, questId),
            eq(schema.questProgress.status, "in_progress"),
            ...(questStartedAt === undefined
              ? []
              : [eq(schema.questProgress.startedAt, questStartedAt)]),
          ),
        )
        .returning({ id: schema.questProgress.id });
      if (deleted.length !== 1) {
        throw new Error("quest_abandon_progress_state_conflict");
      }

      // Audit log entry for quest abandonment
      await tx.insert(schema.questAuditLog).values({
        playerId,
        questId,
        action: "abandoned",
        timestamp: Date.now(),
        metadata:
          questStartedAt === undefined
            ? {}
            : { questStartedAt: questStartedAt },
      });
    });
  }

  /**
   * Get quest points for a player
   *
   * @param playerId - The player ID (character ID)
   * @returns Number of quest points
   */
  async getQuestPoints(playerId: string): Promise<number> {
    this.ensureDatabase();

    const results = await this.db
      .select({ questPoints: schema.characters.questPoints })
      .from(schema.characters)
      .where(eq(schema.characters.id, playerId))
      .limit(1);

    return results.length > 0 ? (results[0].questPoints ?? 0) : 0;
  }

  /**
   * Add quest points to a player
   *
   * Atomically increments the player's quest points.
   *
   * @param playerId - The player ID (character ID)
   * @param points - Number of points to add
   */
  async addQuestPoints(playerId: string, points: number): Promise<void> {
    if (this.isDestroying) {
      return;
    }

    this.ensureDatabase();

    await this.db
      .update(schema.characters)
      .set({
        questPoints: sql`${schema.characters.questPoints} + ${points}`,
      })
      .where(eq(schema.characters.id, playerId));
  }

  /**
   * Complete a quest and award points atomically
   *
   * Wraps quest completion and point award in a transaction to ensure
   * database consistency. If either operation fails, both are rolled back.
   *
   * @param playerId - The player ID (character ID)
   * @param questId - The quest identifier
   * @param questPoints - Number of quest points to award
   */
  async completeQuestWithPoints(
    playerId: string,
    questId: string,
    questPoints: number,
  ): Promise<void> {
    if (this.isDestroying) {
      return;
    }

    this.ensureDatabase();

    await this.withTransaction(async (tx) => {
      await tx.execute(
        sql`SELECT "id" FROM "characters" WHERE "id" = ${playerId} FOR UPDATE`,
      );
      // Mark quest as completed
      await tx
        .update(schema.questProgress)
        .set({
          status: "completed",
          completedAt: Date.now(),
        })
        .where(
          and(
            eq(schema.questProgress.playerId, playerId),
            eq(schema.questProgress.questId, questId),
          ),
        );

      // Award quest points (if any)
      if (questPoints > 0) {
        await tx
          .update(schema.characters)
          .set({
            questPoints: sql`${schema.characters.questPoints} + ${questPoints}`,
          })
          .where(eq(schema.characters.id, playerId));
      }

      // Audit log entry for quest completion
      await tx.insert(schema.questAuditLog).values({
        playerId,
        questId,
        action: "completed",
        questPointsAwarded: questPoints,
        timestamp: Date.now(),
      });
    });
  }

  // =========================================================================
  // AUDIT LOGGING
  // =========================================================================

  /**
   * Log a quest audit event
   *
   * Creates an immutable audit trail entry for quest actions.
   * Used for security auditing and exploit detection.
   *
   * @param playerId - The player ID
   * @param questId - The quest identifier
   * @param action - The action type ("started", "progressed", "completed")
   * @param options - Optional additional data
   */
  async logAuditEvent(
    playerId: string,
    questId: string,
    action: QuestAuditAction,
    options?: {
      questPointsAwarded?: number;
      stageId?: string;
      stageProgress?: StageProgress;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    if (this.isDestroying) {
      return;
    }

    this.ensureDatabase();

    await this.db.insert(schema.questAuditLog).values({
      playerId,
      questId,
      action,
      questPointsAwarded: options?.questPointsAwarded ?? 0,
      stageId: options?.stageId ?? null,
      stageProgress: options?.stageProgress ?? {},
      timestamp: Date.now(),
      metadata: options?.metadata ?? {},
    });
  }

  /**
   * Get audit log entries for a player
   *
   * @param playerId - The player ID
   * @param limit - Maximum entries to return (default: 100)
   * @returns Array of audit log entries, newest first
   */
  async getPlayerAuditLog(
    playerId: string,
    limit: number = 100,
  ): Promise<
    Array<{
      id: number;
      playerId: string;
      questId: string;
      action: string;
      questPointsAwarded: number | null;
      stageId: string | null;
      stageProgress: StageProgress;
      timestamp: number;
      metadata: Record<string, unknown>;
    }>
  > {
    this.ensureDatabase();

    const results = await this.db
      .select()
      .from(schema.questAuditLog)
      .where(eq(schema.questAuditLog.playerId, playerId))
      .orderBy(desc(schema.questAuditLog.timestamp))
      .limit(limit);

    return results.map((row) => ({
      id: row.id,
      playerId: row.playerId,
      questId: row.questId,
      action: row.action,
      questPointsAwarded: row.questPointsAwarded,
      stageId: row.stageId,
      stageProgress: (row.stageProgress as StageProgress) || {},
      timestamp: row.timestamp,
      metadata: (row.metadata as Record<string, unknown>) || {},
    }));
  }

  /**
   * Get audit log entries for a specific quest
   *
   * @param questId - The quest identifier
   * @param limit - Maximum entries to return (default: 100)
   * @returns Array of audit log entries, newest first
   */
  async getQuestAuditLog(
    questId: string,
    limit: number = 100,
  ): Promise<
    Array<{
      id: number;
      playerId: string;
      questId: string;
      action: string;
      questPointsAwarded: number | null;
      stageId: string | null;
      stageProgress: StageProgress;
      timestamp: number;
      metadata: Record<string, unknown>;
    }>
  > {
    this.ensureDatabase();

    const results = await this.db
      .select()
      .from(schema.questAuditLog)
      .where(eq(schema.questAuditLog.questId, questId))
      .orderBy(desc(schema.questAuditLog.timestamp))
      .limit(limit);

    return results.map((row) => ({
      id: row.id,
      playerId: row.playerId,
      questId: row.questId,
      action: row.action,
      questPointsAwarded: row.questPointsAwarded,
      stageId: row.stageId,
      stageProgress: (row.stageProgress as StageProgress) || {},
      timestamp: row.timestamp,
      metadata: (row.metadata as Record<string, unknown>) || {},
    }));
  }
}
