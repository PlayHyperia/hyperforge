/**
 * QuestSystem - Quest Management System
 *
 * Manages player quest progression, tracking, and rewards.
 * Quests are defined in quests.json manifest and loaded at runtime.
 *
 * **Features:**
 * - Manifest-driven quest definitions
 * - Kill tracking for combat objectives
 * - Stage-based quest progression
 * - Item rewards on start/completion
 * - Quest points tracking
 * - Integration with DialogueSystem for quest-aware dialogue
 *
 * **Event Flow:**
 * 1. DialogueSystem effect "startQuest:quest_id" triggers quest start
 * 2. QuestSystem tracks progress (kills, etc.)
 * 3. When objective complete, status becomes "ready_to_complete"
 * 4. DialogueSystem effect "completeQuest:quest_id" triggers completion
 * 5. Rewards distributed, QUEST_COMPLETED event emitted
 *
 * **Runs on:** Server only (client receives state via network messages)
 */

import { EventType } from "../../../types/events";
import type { World } from "../../../types/index";
import { SystemBase } from "../infrastructure/SystemBase";
import type {
  QuestDefinition,
  QuestStatus,
  QuestDbStatus,
  QuestStage,
  StageProgress,
  QuestProgress,
  PlayerQuestState,
  QuestManifest,
} from "../../../types/game/quest-types";
import { validateQuestDefinition } from "../../../types/game/quest-types";
import type { NPCDiedPayload } from "../../../types/events/event-payloads";
import type { IQuestSystem } from "../../../types/game/quest-interfaces";

type DurableGatheringProgressReceipt = {
  operationId: string;
  playerId: string;
  questId: string;
  questStartedAt: number;
  capturedStage: string;
  rewardItemId: string;
  rewardQuantity: number;
  createdAt: number;
};

type DurableGatheringProgressResult =
  | {
      status: "applied" | "replayed" | "stale";
      currentStage: string;
      stageProgress: StageProgress;
    }
  | { status: "retired" };

type DurableGatheringProgressRepository = {
  getPendingGatheringProgressReceipts: (
    playerId: string,
  ) => Promise<DurableGatheringProgressReceipt[]>;
  applyGatheringProgressReceipt: (request: {
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
  }) => Promise<DurableGatheringProgressResult>;
  retireGatheringProgressReceipt: (
    receipt: DurableGatheringProgressReceipt,
  ) => Promise<"retired" | "already_resolved" | "still_active">;
  ignoreGatheringProgressReceipt: (
    receipt: DurableGatheringProgressReceipt,
  ) => Promise<"ignored" | "already_resolved">;
};

type DurableProcessingProgressReceipt = {
  operationId: string;
  playerId: string;
  questId: string;
  questStartedAt: number;
  capturedStage: string;
  targetId: string;
  quantity: number;
  createdAt: number;
};

type DurableProcessingProgressRepository = {
  getPendingProcessingProgressReceipts: (
    playerId: string,
  ) => Promise<DurableProcessingProgressReceipt[]>;
  applyProcessingProgressReceipt: (request: {
    operationId: string;
    playerId: string;
    questId: string;
    questStartedAt: number;
    capturedStage: string;
    targetId: string;
    quantity: number;
    expectedCurrentStage: string;
    expectedProgress: StageProgress;
    resultingStage: string;
    resultingProgress: StageProgress;
  }) => Promise<DurableGatheringProgressResult>;
  retireProcessingProgressReceipt: (
    receipt: DurableProcessingProgressReceipt,
  ) => Promise<"retired" | "already_resolved" | "still_active">;
  ignoreProcessingProgressReceipt: (
    receipt: DurableProcessingProgressReceipt,
  ) => Promise<"ignored" | "already_resolved">;
};

type DurableKillProgressReceipt = {
  operationId: string;
  playerId: string;
  questId: string;
  questStartedAt: number;
  capturedStage: string;
  mobId: string;
  mobType: string;
  quantity: number;
  createdAt: number;
};

type DurableKillProgressRepository = {
  getPendingKillProgressReceipts: (
    playerId: string,
  ) => Promise<DurableKillProgressReceipt[]>;
  applyKillProgressReceipt: (request: {
    operationId: string;
    playerId: string;
    questId: string;
    questStartedAt: number;
    capturedStage: string;
    mobId: string;
    mobType: string;
    quantity: number;
    createdAt: number;
    expectedCurrentStage: string;
    expectedProgress: StageProgress;
    resultingStage: string;
    resultingProgress: StageProgress;
  }) => Promise<DurableGatheringProgressResult>;
  retireKillProgressReceipt: (
    receipt: DurableKillProgressReceipt,
  ) => Promise<"retired" | "already_resolved" | "still_active">;
  ignoreKillProgressReceipt: (
    receipt: DurableKillProgressReceipt,
  ) => Promise<"ignored" | "already_resolved">;
};

/**
 * QuestSystem - Handles quest progression and rewards
 *
 * Implements IQuestSystem interface which combines:
 * - IQuestQuery: Read-only quest information queries
 * - IQuestProgress: Active quest progress tracking
 * - IQuestActions: Quest state mutation actions
 */
export class QuestSystem extends SystemBase implements IQuestSystem {
  /** Quest definitions loaded from manifest */
  private questDefinitions: Map<string, QuestDefinition> = new Map();

  /** Player quest state (in-memory cache, synced with database) */
  private playerStates: Map<string, PlayerQuestState> = new Map();

  /** Flag to check if manifest is loaded */
  private manifestLoaded: boolean = false;

  // =========================================================================
  // PRE-ALLOCATED REUSABLES (Memory optimization - avoid GC in hot paths)
  // =========================================================================

  /** Pre-allocated empty array for getActiveQuests when player has no state */
  private readonly _emptyQuestArray: QuestProgress[] = [];

  /** Cache for getActiveQuests results - invalidated when quest state changes */
  private _activeQuestsCache: Map<string, QuestProgress[]> = new Map();

  /** Tracks which players have dirty (stale) active quest caches */
  private _activeQuestsDirty: Set<string> = new Set();

  /** Pre-allocated payload for QUEST_PROGRESSED events */
  private readonly _progressEventPayload = {
    playerId: "",
    questId: "",
    stage: "",
    progress: {} as StageProgress,
    description: "",
  };

  /** Pre-allocated payload for CHAT_MESSAGE events */
  private readonly _chatEventPayload = {
    playerId: "",
    message: "",
    type: "game" as const,
  };

  // =========================================================================
  // STAGE LOOKUP CACHES (O(1) lookups instead of O(n) find() calls)
  // =========================================================================

  /** Cache: questId -> stageId -> QuestStage */
  private _stageByIdCache: Map<string, Map<string, QuestStage>> = new Map();

  /** Cache: questId -> stageId -> index in stages array */
  private _stageIndexCache: Map<string, Map<string, number>> = new Map();

  /** Cache: questId -> itemId -> QuestStage (for gather stages) */
  private _gatherStageCache: Map<string, Map<string, QuestStage>> = new Map();

  /** Cache: questId -> target -> QuestStage (for interact stages) */
  private _interactStageCache: Map<string, Map<string, QuestStage>> = new Map();

  /** One caller-visible acceptance attempt per player/quest at a time. */
  private readonly questStartInflight = new Map<string, Promise<boolean>>();

  /** Retains an uncertain start identity so a retry cannot mint a new request. */
  private readonly questStartAttempts = new Map<string, number>();

  /** Per-player drains serialize every durable non-combat progression edge. */
  private readonly questReceiptDrainTails = new Map<string, Promise<void>>();

  constructor(world: World) {
    super(world, {
      name: "quest",
      dependencies: {
        optional: ["dialogue", "inventory", "skills"],
      },
      autoCleanup: true,
    });
  }

  async init(): Promise<void> {
    // Only run on server
    if (!this.world.isServer) {
      return;
    }

    // Load quest manifest
    await this.loadQuestManifest();

    // Transient death is a wake-up hint only. Durable mob-loot custody captures
    // every active quest incarnation before progress can change.
    this.subscribe<NPCDiedPayload>(EventType.NPC_DIED, async (data) => {
      if (data.killedBy) await this.queueQuestReceiptDrain(data.killedBy);
    });
    this.subscribe(
      EventType.MOB_LOOT_COMMITTED,
      async (data: { playerId: string }) => {
        await this.queueQuestReceiptDrain(data.playerId);
      },
    );

    // Subscribe to player registration for loading quest state
    this.subscribe(
      EventType.PLAYER_REGISTERED,
      async (data: { playerId: string }) => {
        await this.loadPlayerQuestState(data.playerId);
      },
    );

    // Subscribe to player cleanup
    this.subscribe(EventType.PLAYER_CLEANUP, (data: { playerId: string }) => {
      this.playerStates.delete(data.playerId);
      this._activeQuestsCache.delete(data.playerId);
      this._activeQuestsDirty.delete(data.playerId);
      for (const key of this.questStartInflight.keys()) {
        if (key.startsWith(`${data.playerId}\0`)) {
          this.questStartInflight.delete(key);
        }
      }
      for (const key of this.questStartAttempts.keys()) {
        if (key.startsWith(`${data.playerId}\0`)) {
          this.questStartAttempts.delete(key);
        }
      }
      this.questReceiptDrainTails.delete(data.playerId);
    });

    // Subscribe to quest start acceptance (player clicked Accept on quest start screen)
    this.subscribe(
      EventType.QUEST_START_ACCEPTED,
      async (data: { playerId: string; questId: string }) => {
        await this.startQuest(data.playerId, data.questId);
      },
    );

    // === Gather/Interact Stage Tracking ===

    // Track only an atomically committed gathering reward. Generic inventory
    // additions include bank withdrawals, grants, and recovery and therefore
    // are not evidence that a gather objective was performed.
    this.subscribe(EventType.RESOURCE_GATHERING_COMPLETED, async (data) => {
      if (
        !data.successful ||
        !data.operationId?.startsWith("gathering-reward:") ||
        !data.rewardItemId ||
        !Number.isSafeInteger(data.rewardQuantity) ||
        (data.rewardQuantity ?? 0) <= 0
      ) {
        return;
      }
      await this.queueQuestReceiptDrain(data.playerId);
    });

    // Processing events are wake-up hints only. The committed database receipt
    // is the sole authority for firemaking, cooking, smelting, smithing,
    // runecrafting, crafting, fletching, and tanning quest progress.
    const queueProcessingDrain = async (data: { playerId: string }) => {
      await this.queueQuestReceiptDrain(data.playerId);
    };
    this.subscribe(EventType.FIRE_CREATED, queueProcessingDrain);
    this.subscribe(EventType.COOKING_COMPLETED, queueProcessingDrain);
    this.subscribe(EventType.SMELTING_SUCCESS, queueProcessingDrain);
    this.subscribe(EventType.SMITHING_COMPLETE, queueProcessingDrain);
    this.subscribe(EventType.RUNECRAFTING_COMPLETE, queueProcessingDrain);
    this.subscribe(EventType.CRAFTING_COMPLETE, queueProcessingDrain);
    this.subscribe(EventType.FLETCHING_COMPLETE, queueProcessingDrain);
    this.subscribe(EventType.TANNING_COMPLETE, queueProcessingDrain);
    this.subscribe(
      EventType.PROCESSING_REQUEST_PROGRESS,
      async (data: { playerId: string; phase: string }) => {
        // Family-specific completion events are presentation-level wake-up
        // hints and can be lost or malformed after custody has committed. The
        // durable committed phase is the cross-family authority that a quest
        // receipt now exists and must be drained. Queueing both is safe because
        // receipt application is serialized and idempotent.
        if (data.phase === "committed") {
          await this.queueQuestReceiptDrain(data.playerId);
        }
      },
    );

    this.logger.info(
      `QuestSystem initialized with ${this.questDefinitions.size} quests`,
    );
  }

  /**
   * Load quest definitions from manifest
   */
  private async loadQuestManifest(): Promise<void> {
    try {
      // Check if we're on the server (Node.js environment)
      const isServer =
        typeof process !== "undefined" &&
        process.versions !== undefined &&
        process.versions.node !== undefined;

      if (!isServer) {
        // Client-side - quests are server-only
        this.logger.warn("Quest manifest not available on client");
        this.manifestLoaded = true;
        return;
      }

      // Server-side: Load from filesystem
      const fsModuleId = "node:fs/promises";
      const pathModuleId = "node:path";
      const fs = (await import(
        /* @vite-ignore */ fsModuleId
      )) as typeof import("node:fs/promises");
      const path = (await import(
        /* @vite-ignore */ pathModuleId
      )) as typeof import("node:path");

      // Find manifests directory
      let manifestsDir: string;
      if (process.env.ASSETS_DIR) {
        manifestsDir = path.join(process.env.ASSETS_DIR, "manifests");
      } else {
        const cwd = process.cwd();
        const normalizedCwd = cwd.replace(/\\/g, "/");
        if (
          normalizedCwd.endsWith("/packages/server") ||
          normalizedCwd.includes("/packages/server/")
        ) {
          manifestsDir = path.join(cwd, "world", "assets", "manifests");
        } else if (normalizedCwd.includes("/packages/")) {
          const workspaceRoot = path.resolve(cwd, "../..");
          manifestsDir = path.join(
            workspaceRoot,
            "packages",
            "server",
            "world",
            "assets",
            "manifests",
          );
        } else {
          manifestsDir = path.join(
            cwd,
            "packages",
            "server",
            "world",
            "assets",
            "manifests",
          );
        }
      }

      const questsPath = path.join(manifestsDir, "quests.json");

      try {
        const questsData = await fs.readFile(questsPath, "utf-8");
        const questData = JSON.parse(questsData) as QuestManifest;

        let validCount = 0;
        let invalidCount = 0;

        for (const [questId, definition] of Object.entries(questData)) {
          // Validate quest definition
          const validation = validateQuestDefinition(questId, definition);

          if (!validation.valid) {
            invalidCount++;
            for (const error of validation.errors) {
              this.logger.warn(`Quest validation error: ${error}`);
            }
            continue; // Skip invalid quests
          }

          this.questDefinitions.set(questId, definition as QuestDefinition);
          this.buildStageCaches(questId, definition as QuestDefinition);
          validCount++;
        }

        this.manifestLoaded = true;

        if (invalidCount > 0) {
          this.logger.warn(
            `Loaded ${validCount} valid quests, skipped ${invalidCount} invalid quests from ${questsPath}`,
          );
        } else {
          this.logger.info(
            `Loaded ${validCount} quest definitions from ${questsPath}`,
          );
        }
      } catch {
        this.logger.warn(
          `Quest manifest not found at ${questsPath}, using empty quest list`,
        );
        this.manifestLoaded = true;
      }
    } catch (error) {
      this.logger.error(
        "Failed to load quest manifest",
        error instanceof Error ? error : undefined,
      );
      this.manifestLoaded = true; // Continue without quests
    }
  }

  /**
   * Load player quest state from database
   */
  private async loadPlayerQuestState(playerId: string): Promise<void> {
    // Initialize player state
    const state: PlayerQuestState = {
      playerId,
      questPoints: 0,
      activeQuests: new Map(),
      completedQuests: new Set(),
    };

    // Load from database via DatabaseSystem if available
    try {
      const dbSystem = this.world.getSystem("database") as {
        getQuestRepository?: () => {
          getAllPlayerQuests: (playerId: string) => Promise<
            Array<{
              questId: string;
              status: QuestDbStatus;
              currentStage: string | null;
              stageProgress: StageProgress;
              startedAt: number | null;
              completedAt: number | null;
            }>
          >;
          getQuestPoints: (playerId: string) => Promise<number>;
        };
      };

      if (dbSystem?.getQuestRepository) {
        const repo = dbSystem.getQuestRepository();
        const questRows = await repo.getAllPlayerQuests(playerId);
        const questPoints = await repo.getQuestPoints(playerId);

        state.questPoints = questPoints;

        for (const row of questRows) {
          if (row.status === "completed") {
            state.completedQuests.add(row.questId);
          } else if (row.status === "in_progress") {
            state.activeQuests.set(row.questId, {
              playerId,
              questId: row.questId,
              status: this.computeQuestStatus(row.questId, row),
              currentStage: row.currentStage || "",
              stageProgress: row.stageProgress || {},
              startedAt: row.startedAt ?? undefined,
              completedAt: row.completedAt ?? undefined,
            });
          }
        }
      }
    } catch (error) {
      this.logger.error(
        `Failed to load quest state for ${playerId}`,
        error instanceof Error ? error : undefined,
      );
    }

    this.playerStates.set(playerId, state);
    await this.queueQuestReceiptDrain(playerId);
  }

  /**
   * Compute the full quest status including derived "ready_to_complete"
   */
  private computeQuestStatus(
    questId: string,
    row: {
      status: QuestDbStatus;
      currentStage: string | null;
      stageProgress: StageProgress;
    },
  ): QuestStatus {
    if (row.status !== "in_progress") {
      return row.status;
    }

    const definition = this.questDefinitions.get(questId);
    if (!definition || !row.currentStage) {
      return "in_progress";
    }

    // Check if current stage objective is complete
    const stage = definition.stages.find((s) => s.id === row.currentStage);
    if (!stage) {
      return "in_progress";
    }

    if (stage.type === "kill" && stage.count && stage.target) {
      const kills = row.stageProgress.kills || 0;
      if (kills >= stage.count) {
        return "ready_to_complete";
      }
    }

    if (stage.type === "gather" && stage.count && stage.target) {
      // Progress is tracked by item ID (e.g., copper_ore, tin_ore)
      const gathered = row.stageProgress[stage.target] || 0;
      if (gathered >= stage.count) {
        return "ready_to_complete";
      }
    }

    if (stage.type === "interact" && stage.count && stage.target) {
      // Progress is tracked by target ID (e.g., fire, bronze_bar)
      const interacted = row.stageProgress[stage.target] || 0;
      if (interacted >= stage.count) {
        return "ready_to_complete";
      }
    }

    if (stage.type === "dialogue") {
      const stageIndex = this.getStageIndex(questId, stage.id);
      const hasLaterObjective = definition.stages
        .slice(stageIndex + 1)
        .some((candidate) => candidate.type !== "dialogue");
      if (!hasLaterObjective) {
        // Database status intentionally stores only in_progress/completed.
        // A terminal dialogue stage is the durable representation of
        // "return to the quest NPC" and therefore derives ready-to-complete.
        return "ready_to_complete";
      }
    }

    return "in_progress";
  }

  /**
   * Get quest status for a player (used by DialogueSystem for quest overrides)
   */
  public getQuestStatus(playerId: string, questId: string): QuestStatus {
    const state = this.playerStates.get(playerId);
    if (!state) {
      return "not_started";
    }

    if (state.completedQuests.has(questId)) {
      return "completed";
    }

    const active = state.activeQuests.get(questId);
    if (active) {
      return active.status;
    }

    return "not_started";
  }

  /**
   * Return whether a quest can be started from the current authoritative state.
   * This read is intentionally fail-closed and is rechecked by startQuest().
   */
  public canStartQuest(playerId: string, questId: string): boolean {
    const state = this.playerStates.get(playerId);
    const definition = this.questDefinitions.get(questId);
    if (!state || !definition) {
      return false;
    }

    if (state.completedQuests.has(questId) || state.activeQuests.has(questId)) {
      return false;
    }

    return this.checkRequirements(playerId, definition);
  }

  /**
   * Get all active quests for a player
   * Uses cached array to avoid allocations - cache invalidated on quest state changes
   */
  public getActiveQuests(playerId: string): QuestProgress[] {
    const state = this.playerStates.get(playerId);
    if (!state) {
      return this._emptyQuestArray;
    }

    // Return cached array if still valid
    if (
      !this._activeQuestsDirty.has(playerId) &&
      this._activeQuestsCache.has(playerId)
    ) {
      return this._activeQuestsCache.get(playerId)!;
    }

    // Rebuild cache
    const quests = Array.from(state.activeQuests.values());
    this._activeQuestsCache.set(playerId, quests);
    this._activeQuestsDirty.delete(playerId);
    return quests;
  }

  /**
   * Mark a player's active quests cache as dirty (needs rebuild)
   * Call this whenever quest state changes for a player
   */
  private markActiveQuestsDirty(playerId: string): void {
    this._activeQuestsDirty.add(playerId);
  }

  /**
   * Build stage lookup caches for O(1) access in hot paths
   * Called once per quest when loading manifest
   */
  private buildStageCaches(questId: string, definition: QuestDefinition): void {
    const byId = new Map<string, QuestStage>();
    const byIndex = new Map<string, number>();
    const byGatherTarget = new Map<string, QuestStage>();
    const byInteractTarget = new Map<string, QuestStage>();

    definition.stages.forEach((stage, index) => {
      byId.set(stage.id, stage);
      byIndex.set(stage.id, index);

      if (stage.type === "gather" && stage.target) {
        byGatherTarget.set(stage.target, stage);
      }
      if (stage.type === "interact" && stage.target) {
        byInteractTarget.set(stage.target, stage);
      }
    });

    this._stageByIdCache.set(questId, byId);
    this._stageIndexCache.set(questId, byIndex);
    this._gatherStageCache.set(questId, byGatherTarget);
    this._interactStageCache.set(questId, byInteractTarget);
  }

  /**
   * Ensure stage caches are built for a quest definition
   */
  private ensureStageCaches(questId: string): void {
    if (this._stageByIdCache.has(questId)) {
      return;
    }

    const definition = this.questDefinitions.get(questId);
    if (!definition) {
      return;
    }

    this.buildStageCaches(questId, definition);
  }

  /**
   * Get stage by ID using cache (O(1) instead of O(n))
   */
  private getStageById(
    questId: string,
    stageId: string,
  ): QuestStage | undefined {
    this.ensureStageCaches(questId);
    return this._stageByIdCache.get(questId)?.get(stageId);
  }

  /**
   * Get stage index using cache (O(1) instead of O(n))
   */
  private getStageIndex(questId: string, stageId: string): number {
    this.ensureStageCaches(questId);
    return this._stageIndexCache.get(questId)?.get(stageId) ?? -1;
  }

  /**
   * Get gather stage by item ID using cache (O(1) instead of O(n))
   */
  private getGatherStageByTarget(
    questId: string,
    itemId: string,
  ): QuestStage | undefined {
    this.ensureStageCaches(questId);
    return this._gatherStageCache.get(questId)?.get(itemId);
  }

  /**
   * Get interact stage by target using cache (O(1) instead of O(n))
   */
  private getInteractStageByTarget(
    questId: string,
    target: string,
  ): QuestStage | undefined {
    this.ensureStageCaches(questId);
    return this._interactStageCache.get(questId)?.get(target);
  }

  /**
   * Get quest definition by ID
   */
  public getQuestDefinition(questId: string): QuestDefinition | undefined {
    return this.questDefinitions.get(questId);
  }

  /**
   * Request to start a quest - shows confirmation screen to player
   *
   * Called when DialogueSystem processes a "startQuest:quest_id" effect
   * This emits QUEST_START_CONFIRM to show the quest accept screen
   */
  public requestQuestStart(playerId: string, questId: string): boolean {
    const state = this.playerStates.get(playerId);
    if (!state) {
      this.logger.warn(
        `Cannot request quest start: player ${playerId} not found`,
      );
      return false;
    }

    // Check if already started or completed
    if (state.completedQuests.has(questId)) {
      this.logger.info(`Quest ${questId} already completed for ${playerId}`);
      return false;
    }

    if (state.activeQuests.has(questId)) {
      this.logger.info(`Quest ${questId} already active for ${playerId}`);
      return false;
    }

    const definition = this.questDefinitions.get(questId);
    if (!definition) {
      this.logger.warn(`Quest definition not found: ${questId}`);
      return false;
    }

    // Check requirements
    if (!this.checkRequirements(playerId, definition)) {
      this.logger.info(
        `Player ${playerId} doesn't meet requirements for ${questId}`,
      );
      return false;
    }

    // Emit confirmation event to show quest start screen
    this.emitTypedEvent(EventType.QUEST_START_CONFIRM, {
      playerId,
      questId,
      questName: definition.name,
      description: definition.description,
      difficulty: definition.difficulty,
      requirements: {
        quests: definition.requirements?.quests || [],
        skills: definition.requirements?.skills || {},
        items: definition.requirements?.items || [],
      },
      rewards: {
        questPoints: definition.rewards.questPoints,
        items: definition.rewards.items || [],
        xp: definition.rewards.xp || {},
      },
    });

    this.logger.info(
      `Quest start confirmation shown for ${questId} to ${playerId}`,
    );
    return true;
  }

  /**
   * Start a quest for a player (actually starts the quest)
   *
   * Called when player accepts quest via QUEST_START_ACCEPTED event
   */
  public async startQuest(playerId: string, questId: string): Promise<boolean> {
    const key = `${playerId}\0${questId}`;
    const existing = this.questStartInflight.get(key);
    if (existing) return existing;
    const attempt = this.startQuestAtomic(playerId, questId, key).finally(
      () => {
        if (this.questStartInflight.get(key) === attempt) {
          this.questStartInflight.delete(key);
        }
      },
    );
    this.questStartInflight.set(key, attempt);
    return attempt;
  }

  private async startQuestAtomic(
    playerId: string,
    questId: string,
    attemptKey: string,
  ): Promise<boolean> {
    const state = this.playerStates.get(playerId);
    if (!state) {
      this.logger.warn(`Cannot start quest: player ${playerId} not found`);
      return false;
    }

    // Check if already started or completed
    if (state.completedQuests.has(questId)) {
      this.logger.info(`Quest ${questId} already completed for ${playerId}`);
      return false;
    }

    if (state.activeQuests.has(questId)) {
      this.logger.info(`Quest ${questId} already active for ${playerId}`);
      return false;
    }

    const definition = this.questDefinitions.get(questId);
    if (!definition) {
      this.logger.warn(`Quest definition not found: ${questId}`);
      return false;
    }

    // Check requirements
    if (!this.checkRequirements(playerId, definition)) {
      this.logger.info(
        `Player ${playerId} doesn't meet requirements for ${questId}`,
      );
      return false;
    }

    // Get the first non-dialogue stage (since the first dialogue stage is "talking to NPC")
    // The actual first stage is the kill stage in our case
    const firstKillStage = definition.stages.find((s) => s.type !== "dialogue");
    const initialStage =
      firstKillStage?.id || definition.stages[1]?.id || definition.stages[0].id;

    const questStartedAt =
      this.questStartAttempts.get(attemptKey) ?? Date.now();
    this.questStartAttempts.set(attemptKey, questStartedAt);
    const inventorySystem = this.world.getSystem("inventory") as {
      commitQuestStartAtomic?: (
        playerId: string,
        questId: string,
        input: {
          questStartedAt: number;
          initialStage: string;
          items: Array<{ itemId: string; quantity: number }>;
        },
      ) => Promise<
        | {
            ok: true;
            committed: true;
            liveInventoryApplied: boolean;
            receipt: {
              operationId: string;
              replayed: boolean;
              playerId: string;
              questId: string;
              questStartedAt: number;
              initialStage: string;
            };
          }
        | {
            ok: false;
            committed: false | "unknown";
            reason: string;
            retryable: boolean;
          }
      >;
    };
    if (!inventorySystem?.commitQuestStartAtomic) {
      this.logger.error(
        `Atomic quest start is unavailable for ${playerId}/${questId}`,
      );
      return false;
    }
    const start = await inventorySystem.commitQuestStartAtomic(
      playerId,
      questId,
      {
        questStartedAt,
        initialStage,
        items: definition.onStart?.items ?? [],
      },
    );
    if (!start.ok) {
      if (start.committed !== "unknown") {
        this.questStartAttempts.delete(attemptKey);
      }
      this.logger.error(
        `Quest start was not confirmed for ${playerId}/${questId}: ${start.reason}`,
      );
      return false;
    }
    if (
      start.receipt.playerId !== playerId ||
      start.receipt.questId !== questId ||
      start.receipt.questStartedAt !== questStartedAt ||
      start.receipt.initialStage !== initialStage
    ) {
      this.logger.error(
        `Quest start returned contradictory authority for ${playerId}/${questId}`,
      );
      return false;
    }

    this.questStartAttempts.delete(attemptKey);
    const progress: QuestProgress = {
      playerId,
      questId,
      status: "in_progress",
      currentStage: initialStage,
      stageProgress: {},
      startedAt: questStartedAt,
    };
    state.activeQuests.set(questId, progress);
    this.markActiveQuestsDirty(playerId);
    if (!start.liveInventoryApplied) {
      this.logger.error(
        `Quest ${questId} started but live inventory requires reconciliation for ${playerId}`,
      );
    }

    // Emit quest started event
    this.emitTypedEvent(EventType.QUEST_STARTED, {
      playerId,
      questId,
      questName: definition.name,
    });

    // Send chat message
    this.emitTypedEvent(EventType.CHAT_MESSAGE, {
      playerId,
      message: `You have started a new quest: ${definition.name}`,
      type: "game",
    });

    this.logger.info(`Player ${playerId} started quest: ${questId}`);
    return true;
  }

  /**
   * Complete a quest for a player
   *
   * Called when DialogueSystem processes a "completeQuest:quest_id" effect
   */
  public async completeQuest(
    playerId: string,
    questId: string,
  ): Promise<boolean> {
    const state = this.playerStates.get(playerId);
    if (!state) {
      return false;
    }

    const progress = state.activeQuests.get(questId);
    if (!progress) {
      this.logger.warn(`Quest ${questId} not active for ${playerId}`);
      return false;
    }

    // Verify quest is ready to complete
    if (progress.status !== "ready_to_complete") {
      this.logger.warn(
        `Quest ${questId} not ready to complete for ${playerId}`,
      );
      return false;
    }

    const definition = this.questDefinitions.get(questId);
    if (!definition) {
      return false;
    }

    const questStartedAt = Number(progress.startedAt);
    if (!Number.isSafeInteger(questStartedAt) || questStartedAt <= 0) {
      this.logger.error(
        `Quest ${questId} has no durable incarnation identity for ${playerId}`,
      );
      return false;
    }
    const inventorySystem = this.world.getSystem("inventory") as {
      commitQuestCompletionAtomic?: (
        playerId: string,
        questId: string,
        input: {
          questStartedAt: number;
          expectedStage: string;
          expectedProgress: Record<string, number>;
          questPoints: number;
          items: Array<{ itemId: string; quantity: number }>;
          xp: Record<string, number>;
        },
      ) => Promise<
        | {
            ok: true;
            committed: true;
            liveInventoryApplied: boolean;
            receipt: {
              operationId: string;
              replayed: boolean;
              currentQuestPoints: number;
              progress: Array<{
                skill:
                  | "attack"
                  | "strength"
                  | "defense"
                  | "constitution"
                  | "ranged"
                  | "magic"
                  | "prayer"
                  | "woodcutting"
                  | "mining"
                  | "fishing"
                  | "firemaking"
                  | "cooking"
                  | "smithing"
                  | "agility"
                  | "crafting"
                  | "fletching"
                  | "runecrafting";
                xpAmount: number;
                awardedXp: number;
                operationCommittedXp: number;
                currentXp: number;
                currentLevel: number;
              }>;
              prayer: {
                pointUnits: number;
                maxPoints: number;
                activePrayers: string[];
              } | null;
            };
          }
        | {
            ok: false;
            reason: string;
            committed: false | "unknown";
            retryable: boolean;
          }
      >;
    };
    if (!inventorySystem?.commitQuestCompletionAtomic) {
      this.logger.error(
        `Atomic quest completion is unavailable for ${playerId}/${questId}`,
      );
      return false;
    }
    const completion = await inventorySystem.commitQuestCompletionAtomic(
      playerId,
      questId,
      {
        questStartedAt,
        expectedStage: progress.currentStage,
        expectedProgress: progress.stageProgress,
        questPoints: definition.rewards.questPoints,
        items: definition.rewards.items,
        xp: definition.rewards.xp,
      },
    );
    if (!completion.ok) {
      this.logger.error(
        `Quest completion was not confirmed for ${playerId}/${questId}: ${completion.reason}`,
      );
      return false;
    }

    // The durable receipt is now the only authority allowed to move live state.
    state.activeQuests.delete(questId);
    state.completedQuests.add(questId);
    state.questPoints = completion.receipt.currentQuestPoints;
    this.markActiveQuestsDirty(playerId);
    if (!completion.liveInventoryApplied) {
      this.logger.error(
        `Quest ${questId} committed but live inventory requires reconciliation for ${playerId}`,
      );
    }
    this.emitTypedEvent(EventType.QUEST_COMPLETION_COMMITTED, {
      playerId,
      questId,
      operationId: completion.receipt.operationId,
      replayed: completion.receipt.replayed,
      progress: completion.receipt.progress,
      prayer: completion.receipt.prayer,
    });

    // Presentation only: every reward mutation above is already committed.
    this.logger.info(
      `[QuestSystem] Emitting QUEST_COMPLETED for ${playerId}, quest ${questId}`,
    );
    this.emitTypedEvent(EventType.QUEST_COMPLETED, {
      playerId,
      questId,
      questName: definition.name,
      rewards: definition.rewards,
      progressionCommitted: true,
    });

    this.logger.info(`Player ${playerId} completed quest: ${questId}`);
    return true;
  }

  /**
   * Queue one authoritative scan so gathering and processing edges cannot race.
   * Gathering drains first because it commonly unlocks the following
   * processing stage; the processing scan also closes missed wake-up events.
   */
  private queueQuestReceiptDrain(playerId: string): Promise<void> {
    const previous =
      this.questReceiptDrainTails.get(playerId) ?? Promise.resolve();
    const drain = previous
      .catch(() => {})
      .then(async () => {
        await this.drainGatheringProgressReceipts(playerId);
        await this.drainProcessingProgressReceipts(playerId);
        await this.drainKillProgressReceipts(playerId);
      });
    this.questReceiptDrainTails.set(playerId, drain);
    return drain.finally(() => {
      if (this.questReceiptDrainTails.get(playerId) === drain) {
        this.questReceiptDrainTails.delete(playerId);
      }
    });
  }

  /**
   * Await the durable quest-receipt projection for a player. Processing
   * callers use this as a commit barrier before scheduling the agent's next
   * decision; event delivery starts the same drain but does not await async
   * subscribers.
   */
  public reconcileDurableProgress(playerId: string): Promise<void> {
    return this.queueQuestReceiptDrain(playerId);
  }

  /**
   * Recover and resolve the immutable quest contexts captured by gathering
   * custody. Absence of this production repository fails closed: event payloads
   * alone are never accepted as quest authority.
   */
  private async drainGatheringProgressReceipts(
    playerId: string,
  ): Promise<void> {
    if (!this.playerStates.has(playerId)) return;
    const dbSystem = this.world.getSystem("database") as {
      getQuestRepository?: () => Partial<DurableGatheringProgressRepository>;
    };
    const candidate = dbSystem?.getQuestRepository?.();
    if (
      !candidate?.getPendingGatheringProgressReceipts ||
      !candidate.applyGatheringProgressReceipt ||
      !candidate.retireGatheringProgressReceipt ||
      !candidate.ignoreGatheringProgressReceipt
    ) {
      return;
    }
    const repository = candidate as DurableGatheringProgressRepository;
    const receipts =
      await repository.getPendingGatheringProgressReceipts(playerId);
    for (const receipt of receipts) {
      if (
        receipt.playerId !== playerId ||
        !receipt.operationId.startsWith("gathering-reward:") ||
        !receipt.questId ||
        !Number.isSafeInteger(receipt.questStartedAt) ||
        receipt.questStartedAt < 0 ||
        !receipt.capturedStage ||
        !receipt.rewardItemId ||
        !Number.isSafeInteger(receipt.rewardQuantity) ||
        receipt.rewardQuantity <= 0 ||
        !Number.isSafeInteger(receipt.createdAt) ||
        receipt.createdAt < 0
      ) {
        throw new Error("quest_gathering_progress_receipt_invalid");
      }
      await this.applyGatheringProgressReceipt(repository, receipt);
    }
  }

  private async applyGatheringProgressReceipt(
    repository: DurableGatheringProgressRepository,
    receipt: DurableGatheringProgressReceipt,
  ): Promise<void> {
    const state = this.playerStates.get(receipt.playerId);
    const progress = state?.activeQuests.get(receipt.questId);
    const definition = this.questDefinitions.get(receipt.questId);
    if (!state) return;
    if (!progress || progress.startedAt !== receipt.questStartedAt) {
      const retirement =
        await repository.retireGatheringProgressReceipt(receipt);
      if (retirement === "still_active") {
        throw new Error("quest_gathering_progress_memory_desynchronized");
      }
      return;
    }
    if (!definition) {
      throw new Error("quest_gathering_progress_definition_missing");
    }
    const relevantStage = this.getGatherStageByTarget(
      receipt.questId,
      receipt.rewardItemId,
    );
    if (!relevantStage) {
      await repository.ignoreGatheringProgressReceipt(receipt);
      return;
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      const originalStage = progress.currentStage;
      const originalStatus = progress.status;
      const originalStageDefinition = this.getStageById(
        receipt.questId,
        originalStage,
      );
      const nextCount =
        (progress.stageProgress[receipt.rewardItemId] ?? 0) +
        receipt.rewardQuantity;
      if (!Number.isSafeInteger(nextCount) || nextCount <= 0) {
        throw new Error("quest_gathering_progress_state_invalid");
      }
      const candidate: QuestProgress = {
        ...progress,
        stageProgress: {
          ...progress.stageProgress,
          [receipt.rewardItemId]: nextCount,
        },
      };
      this.advanceThroughCompletedStages(
        receipt.playerId,
        receipt.questId,
        candidate,
        definition,
      );

      const result = await repository.applyGatheringProgressReceipt({
        ...receipt,
        expectedCurrentStage: originalStage,
        expectedProgress: { ...progress.stageProgress },
        resultingStage: candidate.currentStage,
        resultingProgress: candidate.stageProgress,
      });
      if (result.status === "retired") return;
      if (result.status === "stale") {
        progress.currentStage = result.currentStage;
        progress.stageProgress = { ...result.stageProgress };
        progress.status = this.computeQuestStatus(receipt.questId, {
          status: "in_progress",
          currentStage: result.currentStage,
          stageProgress: result.stageProgress,
        });
        continue;
      }

      progress.currentStage = result.currentStage;
      progress.stageProgress = { ...result.stageProgress };
      progress.status = this.computeQuestStatus(receipt.questId, {
        status: "in_progress",
        currentStage: result.currentStage,
        stageProgress: result.stageProgress,
      });
      this.markActiveQuestsDirty(receipt.playerId);

      const currentCount = progress.stageProgress[receipt.rewardItemId] ?? 0;
      const requiredCount = relevantStage.count || 1;
      const halfway = Math.floor(requiredCount / 2);
      if (
        currentCount === receipt.rewardQuantity ||
        currentCount === halfway ||
        currentCount >= requiredCount
      ) {
        this.logger.info(
          `Quest ${receipt.questId}: gathered ${currentCount}/${requiredCount} ${receipt.rewardItemId}`,
        );
      }
      if (
        progress.status === "ready_to_complete" &&
        originalStatus !== "ready_to_complete"
      ) {
        this.emitTypedEvent(EventType.CHAT_MESSAGE, {
          playerId: receipt.playerId,
          message: `Quest objective complete! Return to ${definition.startNpc.replace(/_/g, " ")}.`,
          type: "game",
        });
      } else if (progress.currentStage !== originalStage) {
        const nextStage = this.getStageById(
          receipt.questId,
          progress.currentStage,
        );
        if (nextStage) {
          this.emitTypedEvent(EventType.CHAT_MESSAGE, {
            playerId: receipt.playerId,
            message: `New objective: ${nextStage.description}`,
            type: "game",
          });
        }
      }

      const emitStage = originalStageDefinition || relevantStage;
      this.emitTypedEvent(EventType.QUEST_PROGRESSED, {
        playerId: receipt.playerId,
        questId: receipt.questId,
        stage: progress.currentStage,
        progress: progress.stageProgress,
        description: emitStage.description,
        stageType: emitStage.type,
        stageTarget: emitStage.target,
        stageCount: emitStage.count,
      });
      return;
    }
    throw new Error("quest_gathering_progress_stale_retry_exhausted");
  }

  /**
   * Recover immutable interact-stage edges captured in the same transaction as
   * their inventory, skill, coin, consumable, and world-effect custody.
   */
  private async drainProcessingProgressReceipts(
    playerId: string,
  ): Promise<void> {
    if (!this.playerStates.has(playerId)) return;
    const dbSystem = this.world.getSystem("database") as {
      getQuestRepository?: () => Partial<DurableProcessingProgressRepository>;
    };
    const candidate = dbSystem?.getQuestRepository?.();
    if (
      !candidate?.getPendingProcessingProgressReceipts ||
      !candidate.applyProcessingProgressReceipt ||
      !candidate.retireProcessingProgressReceipt ||
      !candidate.ignoreProcessingProgressReceipt
    ) {
      return;
    }
    const repository = candidate as DurableProcessingProgressRepository;
    const receipts =
      await repository.getPendingProcessingProgressReceipts(playerId);
    for (const receipt of receipts) {
      if (
        receipt.playerId !== playerId ||
        !receipt.operationId ||
        receipt.operationId.length > 256 ||
        !receipt.questId ||
        !Number.isSafeInteger(receipt.questStartedAt) ||
        receipt.questStartedAt < 0 ||
        !receipt.capturedStage ||
        !receipt.targetId ||
        !Number.isSafeInteger(receipt.quantity) ||
        receipt.quantity <= 0 ||
        !Number.isSafeInteger(receipt.createdAt) ||
        receipt.createdAt < 0
      ) {
        throw new Error("quest_processing_progress_receipt_invalid");
      }
      await this.applyProcessingProgressReceipt(repository, receipt);
    }
  }

  private async applyProcessingProgressReceipt(
    repository: DurableProcessingProgressRepository,
    receipt: DurableProcessingProgressReceipt,
  ): Promise<void> {
    const state = this.playerStates.get(receipt.playerId);
    const progress = state?.activeQuests.get(receipt.questId);
    const definition = this.questDefinitions.get(receipt.questId);
    if (!state) return;
    if (!progress || progress.startedAt !== receipt.questStartedAt) {
      const retirement =
        await repository.retireProcessingProgressReceipt(receipt);
      if (retirement === "still_active") {
        throw new Error("quest_processing_progress_memory_desynchronized");
      }
      return;
    }
    if (!definition) {
      throw new Error("quest_processing_progress_definition_missing");
    }
    const relevantStage = this.getInteractStageByTarget(
      receipt.questId,
      receipt.targetId,
    );
    if (!relevantStage) {
      await repository.ignoreProcessingProgressReceipt(receipt);
      return;
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      const originalStage = progress.currentStage;
      const originalStatus = progress.status;
      const originalStageDefinition = this.getStageById(
        receipt.questId,
        originalStage,
      );
      const nextCount =
        (progress.stageProgress[receipt.targetId] ?? 0) + receipt.quantity;
      if (!Number.isSafeInteger(nextCount) || nextCount <= 0) {
        throw new Error("quest_processing_progress_state_invalid");
      }
      const candidate: QuestProgress = {
        ...progress,
        stageProgress: {
          ...progress.stageProgress,
          [receipt.targetId]: nextCount,
        },
      };
      this.advanceThroughCompletedStages(
        receipt.playerId,
        receipt.questId,
        candidate,
        definition,
      );

      const result = await repository.applyProcessingProgressReceipt({
        ...receipt,
        expectedCurrentStage: originalStage,
        expectedProgress: { ...progress.stageProgress },
        resultingStage: candidate.currentStage,
        resultingProgress: candidate.stageProgress,
      });
      if (result.status === "retired") return;
      if (result.status === "stale") {
        progress.currentStage = result.currentStage;
        progress.stageProgress = { ...result.stageProgress };
        progress.status = this.computeQuestStatus(receipt.questId, {
          status: "in_progress",
          currentStage: result.currentStage,
          stageProgress: result.stageProgress,
        });
        continue;
      }

      progress.currentStage = result.currentStage;
      progress.stageProgress = { ...result.stageProgress };
      progress.status = this.computeQuestStatus(receipt.questId, {
        status: "in_progress",
        currentStage: result.currentStage,
        stageProgress: result.stageProgress,
      });
      this.markActiveQuestsDirty(receipt.playerId);

      const currentCount = progress.stageProgress[receipt.targetId] ?? 0;
      const requiredCount = relevantStage.count || 1;
      const halfway = Math.floor(requiredCount / 2);
      if (
        currentCount === receipt.quantity ||
        currentCount === halfway ||
        currentCount >= requiredCount
      ) {
        this.logger.info(
          `Quest ${receipt.questId}: processed ${currentCount}/${requiredCount} ${receipt.targetId}`,
        );
      }
      if (
        progress.status === "ready_to_complete" &&
        originalStatus !== "ready_to_complete"
      ) {
        this.emitTypedEvent(EventType.CHAT_MESSAGE, {
          playerId: receipt.playerId,
          message: `Quest objective complete! Return to ${definition.startNpc.replace(/_/g, " ")}.`,
          type: "game",
        });
      } else if (progress.currentStage !== originalStage) {
        const nextStage = this.getStageById(
          receipt.questId,
          progress.currentStage,
        );
        if (nextStage) {
          this.emitTypedEvent(EventType.CHAT_MESSAGE, {
            playerId: receipt.playerId,
            message: `New objective: ${nextStage.description}`,
            type: "game",
          });
        }
      }

      const emitStage = originalStageDefinition || relevantStage;
      this.emitTypedEvent(EventType.QUEST_PROGRESSED, {
        playerId: receipt.playerId,
        questId: receipt.questId,
        stage: progress.currentStage,
        progress: progress.stageProgress,
        description: emitStage.description,
        stageType: emitStage.type,
        stageTarget: emitStage.target,
        stageCount: emitStage.count,
      });
      return;
    }
    throw new Error("quest_processing_progress_stale_retry_exhausted");
  }

  /** Recover mob kills captured in the same transaction as durable loot. */
  private async drainKillProgressReceipts(playerId: string): Promise<void> {
    if (!this.playerStates.has(playerId)) return;
    const dbSystem = this.world.getSystem("database") as {
      getQuestRepository?: () => Partial<DurableKillProgressRepository>;
    };
    const candidate = dbSystem?.getQuestRepository?.();
    if (
      !candidate?.getPendingKillProgressReceipts ||
      !candidate.applyKillProgressReceipt ||
      !candidate.retireKillProgressReceipt ||
      !candidate.ignoreKillProgressReceipt
    ) {
      return;
    }
    const repository = candidate as DurableKillProgressRepository;
    const receipts = await repository.getPendingKillProgressReceipts(playerId);
    for (const receipt of receipts) {
      if (
        receipt.playerId !== playerId ||
        !/^ground-item-mob-loot:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          receipt.operationId,
        ) ||
        !receipt.questId ||
        !Number.isSafeInteger(receipt.questStartedAt) ||
        receipt.questStartedAt < 0 ||
        !receipt.capturedStage ||
        !receipt.mobId ||
        !receipt.mobType ||
        receipt.quantity !== 1 ||
        !Number.isSafeInteger(receipt.createdAt) ||
        receipt.createdAt < 0
      ) {
        throw new Error("quest_kill_progress_receipt_invalid");
      }
      await this.applyKillProgressReceipt(repository, receipt);
    }
  }

  private async applyKillProgressReceipt(
    repository: DurableKillProgressRepository,
    receipt: DurableKillProgressReceipt,
  ): Promise<void> {
    const state = this.playerStates.get(receipt.playerId);
    const progress = state?.activeQuests.get(receipt.questId);
    const definition = this.questDefinitions.get(receipt.questId);
    if (!state) return;
    if (!progress || progress.startedAt !== receipt.questStartedAt) {
      const retirement = await repository.retireKillProgressReceipt(receipt);
      if (retirement === "still_active") {
        throw new Error("quest_kill_progress_memory_desynchronized");
      }
      return;
    }
    if (!definition) {
      throw new Error("quest_kill_progress_definition_missing");
    }
    const capturedStage = this.getStageById(
      receipt.questId,
      receipt.capturedStage,
    );
    if (
      !capturedStage ||
      capturedStage.type !== "kill" ||
      capturedStage.target !== receipt.mobType
    ) {
      await repository.ignoreKillProgressReceipt(receipt);
      return;
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      const originalStage = progress.currentStage;
      const originalStatus = progress.status;
      if (originalStage !== receipt.capturedStage) {
        await repository.ignoreKillProgressReceipt(receipt);
        return;
      }
      const originalStageDefinition = this.getStageById(
        receipt.questId,
        originalStage,
      );
      const nextCount = (progress.stageProgress.kills ?? 0) + receipt.quantity;
      if (!Number.isSafeInteger(nextCount) || nextCount <= 0) {
        throw new Error("quest_kill_progress_state_invalid");
      }
      const candidate: QuestProgress = {
        ...progress,
        stageProgress: { ...progress.stageProgress, kills: nextCount },
      };
      this.advanceThroughCompletedStages(
        receipt.playerId,
        receipt.questId,
        candidate,
        definition,
      );

      const result = await repository.applyKillProgressReceipt({
        ...receipt,
        expectedCurrentStage: originalStage,
        expectedProgress: { ...progress.stageProgress },
        resultingStage: candidate.currentStage,
        resultingProgress: candidate.stageProgress,
      });
      if (result.status === "retired") return;
      if (result.status === "stale") {
        progress.currentStage = result.currentStage;
        progress.stageProgress = { ...result.stageProgress };
        progress.status = this.computeQuestStatus(receipt.questId, {
          status: "in_progress",
          currentStage: result.currentStage,
          stageProgress: result.stageProgress,
        });
        continue;
      }

      progress.currentStage = result.currentStage;
      progress.stageProgress = { ...result.stageProgress };
      progress.status = this.computeQuestStatus(receipt.questId, {
        status: "in_progress",
        currentStage: result.currentStage,
        stageProgress: result.stageProgress,
      });
      this.markActiveQuestsDirty(receipt.playerId);

      const currentCount = progress.stageProgress.kills ?? 0;
      const requiredCount = capturedStage.count || 1;
      const halfway = Math.floor(requiredCount / 2);
      if (
        currentCount === receipt.quantity ||
        currentCount === halfway ||
        currentCount >= requiredCount
      ) {
        this.logger.info(
          `Quest ${receipt.questId}: ${currentCount}/${requiredCount} kills`,
        );
      }
      if (
        progress.status === "ready_to_complete" &&
        originalStatus !== "ready_to_complete"
      ) {
        this.emitTypedEvent(EventType.CHAT_MESSAGE, {
          playerId: receipt.playerId,
          message: `You've killed enough ${receipt.mobType}s. Return to ${definition.startNpc.replace(/_/g, " ")}.`,
          type: "game",
        });
      } else if (progress.currentStage !== originalStage) {
        const nextStage = this.getStageById(
          receipt.questId,
          progress.currentStage,
        );
        if (nextStage) {
          this.emitTypedEvent(EventType.CHAT_MESSAGE, {
            playerId: receipt.playerId,
            message: `New objective: ${nextStage.description}`,
            type: "game",
          });
        }
      }

      const emitStage = originalStageDefinition || capturedStage;
      this.emitTypedEvent(EventType.QUEST_PROGRESSED, {
        playerId: receipt.playerId,
        questId: receipt.questId,
        stage: progress.currentStage,
        progress: progress.stageProgress,
        description: emitStage.description,
        stageType: emitStage.type,
        stageTarget: emitStage.target,
        stageCount: emitStage.count,
      });
      return;
    }
    throw new Error("quest_kill_progress_stale_retry_exhausted");
  }

  /**
   * Advance across every objective already satisfied by source-authentic
   * progress. This preserves flexible preparation order without requiring an
   * agent to repeat a valid action merely because an earlier receipt drained
   * later.
   */
  private advanceThroughCompletedStages(
    playerId: string,
    questId: string,
    progress: QuestProgress,
    definition: QuestDefinition,
  ): void {
    for (let step = 0; step <= definition.stages.length; step++) {
      if (progress.status === "ready_to_complete") return;
      const stage = this.getStageById(questId, progress.currentStage);
      if (!stage?.target || !stage.count) return;
      const completed =
        stage.type === "kill"
          ? (progress.stageProgress.kills ?? 0) >= stage.count
          : stage.type === "gather" || stage.type === "interact"
            ? (progress.stageProgress[stage.target] ?? 0) >= stage.count
            : false;
      if (!completed) return;

      const previousStage = progress.currentStage;
      this.advanceToNextStage(playerId, questId, progress, definition, false);
      if (progress.currentStage === previousStage) return;
    }
    throw new Error("quest_progress_stage_advance_cycle");
  }

  /**
   * Advance quest to next stage, or mark ready_to_complete if at final objective
   */
  private advanceToNextStage(
    playerId: string,
    questId: string,
    progress: QuestProgress,
    definition: QuestDefinition,
    emitMessages: boolean = true,
  ): void {
    // Use cached index lookup (O(1) instead of O(n))
    const currentIndex = this.getStageIndex(questId, progress.currentStage);

    // Find next stage
    let nextStage = definition.stages[currentIndex + 1];

    // Skip dialogue stages to find next objective
    while (nextStage && nextStage.type === "dialogue") {
      // Use cached index lookup (O(1) instead of O(n))
      const nextStageIndex = this.getStageIndex(questId, nextStage.id);
      const afterDialogue = definition.stages[nextStageIndex + 1];
      if (!afterDialogue || afterDialogue.type === "dialogue") {
        // Preserve the authored return stage instead of leaving the journal on
        // the objective that just completed. The database retains
        // `in_progress`; computeQuestStatus derives ready-to-complete from this
        // terminal dialogue stage after recovery.
        progress.currentStage = nextStage.id;
        progress.status = "ready_to_complete";
        if (emitMessages) {
          this.emitTypedEvent(EventType.CHAT_MESSAGE, {
            playerId,
            message: `Quest objective complete! Return to ${definition.startNpc.replace(/_/g, " ")}.`,
            type: "game",
          });
        }
        return;
      }
      nextStage = afterDialogue;
    }

    if (
      nextStage &&
      (nextStage.type === "gather" ||
        nextStage.type === "interact" ||
        nextStage.type === "kill")
    ) {
      // Move to next objective stage
      progress.currentStage = nextStage.id;
      // Don't reset stageProgress - keep tracked item counts for flexible completion order

      // Check if this stage is already complete (player pre-gathered items)
      if (
        (nextStage.type === "gather" || nextStage.type === "interact") &&
        nextStage.target &&
        nextStage.count
      ) {
        const existingProgress = progress.stageProgress[nextStage.target] || 0;
        if (existingProgress >= nextStage.count) {
          // This stage is already complete, advance again
          this.advanceToNextStage(
            playerId,
            questId,
            progress,
            definition,
            emitMessages,
          );
          return;
        }
      }

      if (emitMessages) {
        this.emitTypedEvent(EventType.CHAT_MESSAGE, {
          playerId,
          message: `New objective: ${nextStage.description}`,
          type: "game",
        });
      }
    } else {
      // No more objective stages - ready to complete
      progress.status = "ready_to_complete";
      if (emitMessages) {
        this.emitTypedEvent(EventType.CHAT_MESSAGE, {
          playerId,
          message: `Quest objective complete! Return to ${definition.startNpc.replace(/_/g, " ")}.`,
          type: "game",
        });
      }
    }
  }

  /**
   * Check if player meets quest requirements
   */
  private checkRequirements(
    playerId: string,
    definition: QuestDefinition,
  ): boolean {
    const state = this.playerStates.get(playerId);
    if (!state) return false;

    // Check prerequisite quests
    for (const prereqQuestId of definition.requirements.quests) {
      if (!state.completedQuests.has(prereqQuestId)) {
        return false;
      }
    }

    // Check skill requirements
    const skills = definition.requirements.skills;
    for (const [skillName, requiredLevel] of Object.entries(skills)) {
      const playerLevel = this.world.getSkillLevel?.(playerId, skillName) ?? 1;
      if (playerLevel < requiredLevel) {
        return false;
      }
    }

    // Check item requirements - player must have all required items
    const items = definition.requirements.items;
    for (const itemId of items) {
      const hasItem = this.world.hasItem?.(playerId, itemId, 1) ?? false;
      if (!hasItem) {
        return false;
      }
    }

    return true;
  }

  /**
   * Abandon an active quest for a player
   *
   * Removes the quest from active quests and deletes progress from database
   */
  public async abandonQuest(
    playerId: string,
    questId: string,
  ): Promise<boolean> {
    const state = this.playerStates.get(playerId);
    if (!state) {
      this.logger.warn(`Cannot abandon quest: player ${playerId} not found`);
      return false;
    }

    const progress = state.activeQuests.get(questId);
    if (!progress) {
      this.logger.warn(`Quest ${questId} not active for ${playerId}`);
      return false;
    }

    const definition = this.questDefinitions.get(questId);
    const questName = definition?.name || questId;
    if ((definition?.onStart?.items?.length ?? 0) > 0) {
      this.logger.warn(
        `Quest ${questId} cannot be abandoned after starter custody was issued for ${playerId}`,
      );
      return false;
    }
    const questStartedAt = Number(progress.startedAt);
    if (!Number.isSafeInteger(questStartedAt) || questStartedAt <= 0) {
      this.logger.error(
        `Quest ${questId} has no durable incarnation identity for ${playerId}`,
      );
      return false;
    }

    // Persist the exact active-incarnation deletion before changing live state.
    try {
      const dbSystem = this.world.getSystem("database") as {
        getQuestRepository?: () => {
          abandonQuest: (
            playerId: string,
            questId: string,
            questStartedAt: number,
          ) => Promise<void>;
        };
      };
      if (!dbSystem?.getQuestRepository) {
        this.logger.error(
          `Durable quest abandonment is unavailable for ${playerId}/${questId}`,
        );
        return false;
      }
      await dbSystem
        .getQuestRepository()
        .abandonQuest(playerId, questId, questStartedAt);
    } catch (error) {
      this.logger.error(
        `Failed to delete quest ${questId} from database for ${playerId}`,
        error instanceof Error ? error : undefined,
      );
      return false;
    }

    state.activeQuests.delete(questId);
    this.markActiveQuestsDirty(playerId);

    // Send chat message
    this.emitTypedEvent(EventType.CHAT_MESSAGE, {
      playerId,
      message: `You have abandoned the quest: ${questName}`,
      type: "game",
    });

    // Emit quest abandoned event
    this.emitTypedEvent(EventType.QUEST_ABANDONED, {
      playerId,
      questId,
      questName,
    });

    this.logger.info(`Player ${playerId} abandoned quest: ${questId}`);
    return true;
  }

  /**
   * Get player's quest points
   */
  public getQuestPoints(playerId: string): number {
    return this.playerStates.get(playerId)?.questPoints || 0;
  }

  /**
   * Check if player has completed a quest
   */
  public hasCompletedQuest(playerId: string, questId: string): boolean {
    return (
      this.playerStates.get(playerId)?.completedQuests.has(questId) || false
    );
  }

  /**
   * Get all quest definitions (for quest journal)
   */
  public getAllQuestDefinitions(): QuestDefinition[] {
    return Array.from(this.questDefinitions.values());
  }
}
