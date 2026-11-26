/**
 * AgentBehaviorBridge — Main-thread coordinator for worker-based agent AI.
 *
 * Replaces the old per-agent setInterval approach. Instead of running agent
 * decision logic on the main thread (which blocked the game tick event loop),
 * this bridge:
 *
 * 1. Collects game state snapshots for due agents
 * 2. Sends them to a worker thread for decision-making
 * 3. Receives action commands back and executes them on the main thread
 *
 * The game tick loop is NEVER blocked by agent AI decisions.
 */

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, statSync } from "node:fs";
import {
  EventType,
  getCombatNPCs,
  getAllStores,
  getExternalResources,
  getItem,
  INTERACTION_DISTANCE,
  ProcessingDataProvider,
  SessionType,
} from "@hyperforge/shared";
import { ITEMS } from "@hyperforge/shared";
import type { World } from "@hyperforge/shared";
import {
  ejectAgentFromCombatArena,
  recoverAgentFromDeathLoop,
} from "../agentRecovery.js";
import { errMsg } from "../../shared/errMsg.js";
import type {
  AgentTickInput,
  AgentTickOutput,
  SharedTickData,
  MainToWorkerMessage,
  WorkerToMainMessage,
  WorkerItemData,
  WorkerProcessingRecipeSnapshot,
  WorkerStationData,
} from "../worker/workerTypes.js";
import type {
  AgentInstance,
  EmbeddedBehaviorAction,
} from "./AgentBehaviorTicker.js";
import {
  EMBEDDED_BEHAVIOR_TICK_INTERVAL,
  ATTACK_OBSERVATION_SETTLE_MS,
  AGENT_STAGGER_OFFSET_MS,
  CRITICAL_HIT_THRESHOLD,
  NEAR_DEATH_THRESHOLD,
  COMBAT_CHAT_COOLDOWN,
} from "./AgentBehaviorTicker.js";
import {
  isLlmBehaviorEnabled,
  pickBehaviorActionWithLlm,
  recordAuthoritativeBehaviorOutcome,
} from "../llmBehaviorDecision.js";
import type { LlmBehaviorResult } from "../llmBehaviorDecision.js";
import {
  recordAgentThought,
  findWorldMapMoveTarget,
  syncEmbeddedAgentDashboardForTick,
} from "../dashboardInterop.js";
import type { AgentAutonomyActionResult } from "../agentAutonomyCheckpoint.js";
import {
  captureAgentAutonomyCheckpointContext,
  type AgentAutonomyCheckpointContext,
} from "../agentAutonomyCheckpoint.js";
import type {
  AgentAutonomyDecisionSource,
  AgentAutonomyProgressionAttempt,
} from "../agentAutonomyProgression.js";
import {
  executeOrdinaryBankDepositSurplus,
  executeOrdinaryBankStageMaterials,
  recordOrdinaryBankStageOutcome,
} from "../ordinaryAgentBanking.js";
import { executeOrdinaryBoneBurial } from "../ordinaryAgentPrayerTraining.js";
import {
  executeOrdinaryStoreBuy,
  hasOrdinaryCoinRecoveryAuthorization,
  recordOrdinaryStoreBuyOutcome,
} from "../ordinaryAgentStore.js";
import {
  isOrdinaryProcessingActionSuppressed,
  recordOrdinaryProcessingActionOutcome,
  snapshotOrdinaryProcessingRetrySuppressions,
} from "../ordinaryProcessingRetry.js";
import { getAuthoritativeRuntimeMobType } from "../runtimeEntityIdentity.js";
import { resolveOrdinaryCombatSpecialization } from "../ordinaryCombatSpecialization.js";
import { buildOrdinaryCombatReadinessCatalog } from "../ordinaryCombatReadinessCatalog.js";

/** How often the bridge checks which agents are due for a tick (ms) */
const BRIDGE_POLL_INTERVAL_MS = 1000;

/** Bound the asynchronous quest persistence acknowledgement per action. */
const QUEST_ACCEPT_CONFIRMATION_TIMEOUT_MS = 5_000;
const QUEST_ACCEPT_CONFIRMATION_POLL_MS = 25;

/** Max agents to process per poll cycle to avoid blocking the event loop */
const MAX_AGENTS_PER_POLL = 5;

/** Yield to the event loop so the tick setTimeout can fire */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

async function waitForQuestStartConfirmation(
  instance: AgentInstance,
  questId: string,
): Promise<boolean> {
  const deadline = Date.now() + QUEST_ACCEPT_CONFIRMATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (
      instance.service
        .getQuestState()
        .some((quest) => quest.questId === questId)
    ) {
      return true;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, QUEST_ACCEPT_CONFIRMATION_POLL_MS),
    );
  }
  return instance.service
    .getQuestState()
    .some((quest) => quest.questId === questId);
}

function actionResult(
  attemptedActionType: EmbeddedBehaviorAction["type"],
  outcome: AgentAutonomyActionResult["outcome"],
  appliedActionType: EmbeddedBehaviorAction["type"] | null = null,
): AgentAutonomyActionResult {
  return { attemptedActionType, appliedActionType, outcome };
}

const RECEIPT_BOUND_CUSTODY_ACTIONS = new Set<EmbeddedBehaviorAction["type"]>([
  "gather",
  "pickup",
  "lootGravestone",
  "bury",
  "firemake",
  "cook",
  "smelt",
  "smith",
  "runecraft",
  "craft",
  "fletch",
  "tan",
  "storeBuy",
  "bankDepositAll",
  "bankWithdraw",
]);

function isReceiptBoundCustodyAction(action: EmbeddedBehaviorAction): boolean {
  return RECEIPT_BOUND_CUSTODY_ACTIONS.has(action.type);
}

/**
 * Per-agent scheduling state tracked on the main thread.
 */
interface AgentSchedule {
  nextTickAt: number;
  /** Prevents overlapping ticks for the same agent */
  tickInProgress: boolean;
  /** Timestamp of last arena ejection — cooldown prevents spam */
  lastEjectedAt: number;
}

/** Build the public, structured-clone-safe item/recipe snapshot for the worker. */
export function buildWorkerItemDataSnapshot(): Array<[string, WorkerItemData]> {
  const itemsData: Array<[string, WorkerItemData]> = [];
  const processingData = ProcessingDataProvider.getInstance();
  for (const [id, item] of ITEMS.entries()) {
    const raw = item as unknown as Record<string, unknown>;
    const cooking = processingData.getCookingData(id);
    const smelting = processingData.getSmeltingData(id);
    const smithing = processingData.getSmithingRecipe(id);
    itemsData.push([
      id,
      {
        id,
        name: (raw.name as string) || id,
        type: (raw.type as string) || "misc",
        stackable: raw.stackable as boolean | undefined,
        equipSlot: raw.equipSlot as string | undefined,
        attackType: raw.attackType as string | undefined,
        bonuses: raw.bonuses as Record<string, number> | undefined,
        healAmount: raw.healAmount as number | undefined,
        prayerXp: raw.prayerXp as number | undefined,
        buryLevelRequired: raw.buryLevelRequired as number | undefined,
        requirements: raw.requirements as Record<string, unknown> | undefined,
        tool:
          raw.tool && typeof raw.tool === "object"
            ? {
                skill: String(
                  (raw.tool as Record<string, unknown>).skill ?? "",
                ),
                priority: Number(
                  (raw.tool as Record<string, unknown>).priority ?? 0,
                ),
              }
            : undefined,
        cooking: cooking
          ? {
              cookedItemId: cooking.cookedItemId,
              levelRequired: cooking.levelRequired,
            }
          : undefined,
        smelting: smelting
          ? {
              inputs: smelting.inputs?.map((input) => ({ ...input })) ?? [
                { itemId: smelting.primaryOre, quantity: 1 },
                ...(smelting.secondaryOre
                  ? [{ itemId: smelting.secondaryOre, quantity: 1 }]
                  : []),
                ...(smelting.coalRequired > 0
                  ? [{ itemId: "coal", quantity: smelting.coalRequired }]
                  : []),
              ],
              levelRequired: smelting.levelRequired,
            }
          : undefined,
        smithing: smithing
          ? {
              barItemId: smithing.barType,
              barsRequired: smithing.barsRequired,
              levelRequired: smithing.levelRequired,
              outputQuantity: smithing.outputQuantity,
            }
          : undefined,
      },
    ]);
  }
  return itemsData;
}

/** Build the non-custodial public recipe catalogs that are not item-keyed. */
export function buildWorkerProcessingRecipeSnapshot(
  combatNpcs = getCombatNPCs(),
  authoredStores = getAllStores(),
): WorkerProcessingRecipeSnapshot {
  const provider = ProcessingDataProvider.getInstance();
  return {
    stores: authoredStores
      .map((store) => ({
        storeId: store.id,
        items: store.items
          .map((item) => ({
            itemId: item.itemId,
            price: item.price,
            category: item.category,
          }))
          .sort(
            (a, b) => a.price - b.price || a.itemId.localeCompare(b.itemId),
          ),
      }))
      .sort((a, b) => a.storeId.localeCompare(b.storeId)),
    gathering: [...getExternalResources().values()]
      .map((resource) => ({
        resourceId: resource.id,
        harvestSkill: resource.harvestSkill,
        toolRequired: resource.toolRequired,
        levelRequired: resource.levelRequired,
        outputItemIds: [
          ...new Set(resource.harvestYield.map((drop) => drop.itemId)),
        ].sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
    guaranteedMobDrops: combatNpcs
      .map((npc) => {
        const guaranteedItemIds = [
          ...(npc.drops?.defaultDrop?.enabled
            ? [npc.drops.defaultDrop.itemId]
            : []),
          ...[
            ...(npc.drops?.always ?? []),
            ...(npc.drops?.common ?? []),
            ...(npc.drops?.uncommon ?? []),
            ...(npc.drops?.rare ?? []),
            ...(npc.drops?.veryRare ?? []),
          ]
            .filter((drop) => drop.chance === 1)
            .map((drop) => drop.itemId),
        ];
        return {
          mobType: npc.id,
          itemIds: [...new Set(guaranteedItemIds)].sort((a, b) =>
            a.localeCompare(b),
          ),
        };
      })
      .filter((entry) => entry.itemIds.length > 0)
      .sort((a, b) => a.mobType.localeCompare(b.mobType)),
    firemaking: [...provider.getBurnableLogIds()]
      .map((logItemId) => ({
        logItemId,
        levelRequired:
          provider.getFiremakingData(logItemId)?.levelRequired ?? 1,
      }))
      .sort((a, b) => a.logItemId.localeCompare(b.logItemId)),
    crafting: provider
      .getAllCraftingRecipes()
      .map((recipe) => ({
        outputItemId: recipe.output,
        category: recipe.category,
        inputs: recipe.inputs.map((input) => ({
          itemId: input.item,
          quantity: input.amount,
        })),
        tools: [...recipe.tools],
        consumables: recipe.consumables.map((consumable) => ({
          itemId: consumable.item,
          uses: consumable.uses,
        })),
        levelRequired: recipe.level,
        station: recipe.station,
      }))
      .sort((a, b) => a.outputItemId.localeCompare(b.outputItemId)),
    tanning: provider
      .getAllTanningRecipes()
      .map((recipe) => ({
        inputItemId: recipe.input,
        outputItemId: recipe.output,
        coinCost: recipe.cost,
      }))
      .sort((a, b) => a.inputItemId.localeCompare(b.inputItemId)),
    fletching: provider
      .getAllFletchingRecipes()
      .map((recipe) => ({
        recipeId: recipe.recipeId,
        outputItemId: recipe.output,
        outputQuantity: recipe.outputQuantity,
        category: recipe.category,
        inputs: recipe.inputs.map((input) => ({
          itemId: input.item,
          quantity: input.amount,
        })),
        tools: [...recipe.tools],
        levelRequired: recipe.level,
      }))
      .sort((a, b) => a.recipeId.localeCompare(b.recipeId)),
    runecrafting: provider
      .getAllRunecraftingRecipes()
      .map((recipe) => ({
        runeType: recipe.runeType,
        runeItemId: recipe.runeItemId,
        essenceItemIds: [...recipe.essenceTypes],
        levelRequired: recipe.levelRequired,
      }))
      .sort((a, b) => a.runeType.localeCompare(b.runeType)),
    combatReadiness: buildOrdinaryCombatReadinessCatalog(authoredStores),
  };
}

/**
 * Resolve the worker paired with this bridge. Bundled dev/production bridges
 * always use their sibling. Direct source consumers may have both build/ and
 * dist/ artifacts, so they use the freshest generated worker instead of
 * silently loading an obsolete bundle.
 */
export function resolveAgentBehaviorWorkerPath(
  thisFile: string,
  fileExists: (candidate: string) => boolean = existsSync,
  fileModifiedAt: (candidate: string) => number = (candidate) =>
    statSync(candidate).mtimeMs,
): string {
  const siblingWorkerPath = path.join(
    path.dirname(thisFile),
    "agentBehaviorWorker.js",
  );
  if (fileExists(siblingWorkerPath)) return siblingWorkerPath;

  const generatedCandidates = [
    path.resolve(
      path.dirname(thisFile),
      "../../../dist/agentBehaviorWorker.js",
    ),
    path.resolve(
      path.dirname(thisFile),
      "../../../build/agentBehaviorWorker.js",
    ),
  ];
  let freshest: { path: string; modifiedAt: number } | null = null;
  for (const candidate of generatedCandidates) {
    if (!fileExists(candidate)) continue;
    let modifiedAt: number;
    try {
      modifiedAt = fileModifiedAt(candidate);
    } catch {
      continue;
    }
    if (!freshest || modifiedAt > freshest.modifiedAt) {
      freshest = { path: candidate, modifiedAt };
    }
  }
  return freshest?.path ?? siblingWorkerPath;
}

export class AgentBehaviorBridge {
  private worker: Worker | null = null;
  private workerReady = false;
  private schedules = new Map<string, AgentSchedule>();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private restartTimeout: ReturnType<typeof setTimeout> | null = null;
  private restartScheduled = false;
  private stopped = true;
  private agentStartIndex = 0;

  /** Pending tick results callback — resolves when worker responds */
  private pendingResolve: ((results: AgentTickOutput[]) => void) | null = null;

  /**
   * Per-agent apply drains. Duel preparation waits on this fence before it
   * opens a private bank, so an already-started ordinary action cannot race
   * loadout custody.
   */
  private readonly applyDrains = new Map<string, Promise<void>>();

  /** World-observation caches (recomputed periodically, not every tick). */
  private spawnAnchorsCache: Array<{
    position: [number, number, number];
    name: string;
  }> = [];
  private worldResourcesCache: Array<{
    entityId: string;
    position: [number, number, number];
    name: string;
    resourceId: string;
    resourceType: string;
    depleted: boolean;
  }> = [];
  private worldMobsCache: Array<{
    position: [number, number, number];
    mobType: string;
  }> = [];
  private stationPositionsCache: WorkerStationData[] = [];
  private storePositionsCache: Array<{
    entityId: string;
    storeId: string;
    name: string;
    position: [number, number, number];
  }> = [];
  private lastWorldScanTick = -1;
  /** Recompute world scan every N bridge polls (~5s) */
  private static readonly WORLD_SCAN_INTERVAL = 5;
  private worldScanCounter = 0;

  constructor(
    private readonly world: World,
    private readonly getAgent: (
      characterId: string,
    ) => AgentInstance | undefined,
    private readonly getAllAgentIds: () => string[],
    private readonly persistAutonomyCheckpoint?: (
      instance: AgentInstance,
      actionResult: AgentAutonomyActionResult,
      attempt?: AgentAutonomyProgressionAttempt,
      checkpointContext?: AgentAutonomyCheckpointContext,
    ) => Promise<void>,
    private readonly beginAutonomyProgressionAttempt?: (
      instance: AgentInstance,
      actionType: Exclude<EmbeddedBehaviorAction["type"], "idle">,
      decisionSource: AgentAutonomyDecisionSource,
    ) => Promise<AgentAutonomyProgressionAttempt | null>,
  ) {}

  // ─── LIFECYCLE ──────────────────────────────────────────────────────────

  /**
   * Start the worker thread and begin polling for due agents.
   */
  async start(): Promise<void> {
    if (this.worker) return;
    this.stopped = false;

    // Spawn worker — resolve relative to this file's compiled output location.
    // esbuild bundles to build/ (dev) or dist/ (prod), with the worker as a
    // sibling file (agentBehaviorWorker.js) in the same directory.
    const thisFile = fileURLToPath(import.meta.url);
    const workerPath = resolveAgentBehaviorWorkerPath(thisFile);
    this.worker = new Worker(workerPath);

    // Handle messages from worker
    this.worker.on("message", (msg: WorkerToMainMessage) => {
      this.handleWorkerMessage(msg);
    });

    this.worker.on("error", (err) => {
      console.error("[AgentBehaviorBridge] Worker error:", err);
      if (!this.stopped) {
        void this.restartWorker();
      }
    });

    this.worker.on("exit", (code) => {
      this.worker = null;
      this.workerReady = false;
      if (code !== 0 && !this.stopped) {
        console.warn(
          `[AgentBehaviorBridge] Worker exited with code ${code}, restarting`,
        );
        void this.restartWorker();
      }
    });

    // Send item data to worker
    await this.initializeWorker();
    if (this.stopped || !this.worker) return;

    // Start polling for due agents
    this.pollInterval = setInterval(() => {
      void this.pollAndDispatch();
    }, BRIDGE_POLL_INTERVAL_MS);

    console.log("[AgentBehaviorBridge] Started with worker thread");
  }

  /**
   * Stop the bridge and terminate the worker.
   */
  stop(): void {
    this.stopped = true;
    this.restartScheduled = false;
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.worker) {
      this.sendToWorker({ type: "shutdown" });
      this.worker.terminate();
      this.worker = null;
      this.workerReady = false;
    }

    this.schedules.clear();
    console.log("[AgentBehaviorBridge] Stopped");
  }

  // ─── AGENT SCHEDULING ──────────────────────────────────────────────────

  /**
   * Register an agent for behavior ticks. Stagger offset is applied automatically.
   */
  startAgent(characterId: string): void {
    const staggerDelay = this.agentStartIndex * AGENT_STAGGER_OFFSET_MS;
    this.agentStartIndex++;

    this.schedules.set(characterId, {
      nextTickAt: Date.now() + 3000 + staggerDelay, // Initial delay + stagger
      tickInProgress: false,
      lastEjectedAt: 0,
    });
  }

  /**
   * Unregister an agent from behavior ticks.
   */
  stopAgent(characterId: string): void {
    this.schedules.delete(characterId);

    // Best-effort stop so paused/stopped agents don't keep pathing or attacking.
    const instance = this.getAgent(characterId);
    if (instance) {
      void instance.service.executeStop().catch(() => {});
    }
  }

  /**
   * Wait until any ordinary autonomous result already being applied has
   * completely finished. New results are rejected by the preparation/epoch
   * gates, so one observed drain is sufficient.
   */
  async waitForAgentQuiescence(characterId: string): Promise<void> {
    const drain = this.applyDrains.get(characterId);
    if (drain) await drain;
  }

  // ─── COMBAT DAMAGE HANDLER (main thread) ──────────────────────────────

  /**
   * Handle combat damage events to queue chat reactions.
   * Stays on main thread since it reads World entities directly.
   */
  handleCombatDamageDealt(data: unknown): void {
    const payload = data as {
      attackerId: string;
      targetId: string;
      damage: number;
    };
    const { attackerId, targetId, damage } = payload;
    const now = Date.now();

    // Check if attacker is an agent
    const attackerInstance = this.getAgent(attackerId);
    if (attackerInstance && attackerInstance.state === "running") {
      const targetEntity = this.world.entities.get(targetId);
      const targetData = targetEntity?.data as {
        maxHealth?: number;
        health?: number;
        name?: string;
      };

      if (
        targetData?.maxHealth &&
        damage >= targetData.maxHealth * CRITICAL_HIT_THRESHOLD
      ) {
        if (now - attackerInstance.lastCombatChatAt > COMBAT_CHAT_COOLDOWN) {
          attackerInstance.pendingChatReaction = {
            type: "critical_hit_dealt",
            opponentName: targetData.name || "opponent",
            timestamp: now,
          };
        }
      }

      if (targetData?.health && targetData?.maxHealth) {
        const remainingHealthPercent = targetData.health / targetData.maxHealth;
        if (remainingHealthPercent <= NEAR_DEATH_THRESHOLD && damage > 0) {
          if (now - attackerInstance.lastCombatChatAt > COMBAT_CHAT_COOLDOWN) {
            attackerInstance.pendingChatReaction = {
              type: "victory_imminent",
              opponentName: targetData.name || "opponent",
              timestamp: now,
            };
          }
        }
      }
    }

    // Check if target is an agent
    const targetInstance = this.getAgent(targetId);
    if (targetInstance && targetInstance.state === "running") {
      const attackerEntity = this.world.entities.get(attackerId);
      const attackerData = attackerEntity?.data as { name?: string };
      const opponentName = attackerData?.name || "opponent";

      const targetEntity = this.world.entities.get(targetId);
      const targetData = targetEntity?.data as {
        maxHealth?: number;
        health?: number;
      };

      if (
        targetData?.maxHealth &&
        damage >= targetData.maxHealth * CRITICAL_HIT_THRESHOLD
      ) {
        if (now - targetInstance.lastCombatChatAt > COMBAT_CHAT_COOLDOWN) {
          targetInstance.pendingChatReaction = {
            type: "critical_hit_taken",
            opponentName,
            timestamp: now,
          };
        }
      }

      if (targetData?.health && targetData?.maxHealth) {
        const remainingHealthPercent = targetData.health / targetData.maxHealth;
        if (remainingHealthPercent <= NEAR_DEATH_THRESHOLD) {
          if (now - targetInstance.lastCombatChatAt > COMBAT_CHAT_COOLDOWN) {
            targetInstance.pendingChatReaction = {
              type: "near_death",
              opponentName,
              timestamp: now,
            };
          }
        }
      }
    }
  }

  // ─── PRIVATE: WORKER COMMUNICATION ────────────────────────────────────

  private async initializeWorker(): Promise<void> {
    const itemsData = buildWorkerItemDataSnapshot();
    const processingRecipes = buildWorkerProcessingRecipeSnapshot();

    // Send init and wait for ready
    return new Promise<void>((resolve) => {
      const worker = this.worker;
      if (!worker) {
        resolve();
        return;
      }
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        worker.off("message", onReady);
        worker.off("exit", onUnavailable);
        worker.off("error", onUnavailable);
        if (ready && !this.stopped && this.worker === worker) {
          this.workerReady = true;
        }
        resolve();
      };
      const onReady = (msg: WorkerToMainMessage) => {
        if (msg.type === "ready") {
          finish(true);
        }
      };
      const onUnavailable = () => finish(false);
      // Temporarily listen for ready
      worker.on("message", onReady);
      worker.once("exit", onUnavailable);
      worker.once("error", onUnavailable);
      this.sendToWorker({ type: "init", itemsData, processingRecipes });

      // Timeout after 5s
      timeout = setTimeout(() => {
        if (!this.workerReady) {
          console.error(
            "[AgentBehaviorBridge] Worker did not send ready in 5s",
          );
          finish(false); // Don't block forever
        }
      }, 5000);
    });
  }

  private sendToWorker(msg: MainToWorkerMessage): void {
    if (this.worker) {
      this.worker.postMessage(msg);
    }
  }

  private handleWorkerMessage(msg: WorkerToMainMessage): void {
    switch (msg.type) {
      case "ready":
        this.workerReady = true;
        break;

      case "tickResults":
        if (this.pendingResolve) {
          this.pendingResolve(msg.results);
          this.pendingResolve = null;
        }
        break;

      case "error":
        console.error(
          `[AgentBehaviorBridge] Worker error${msg.characterId ? ` (agent ${msg.characterId})` : ""}: ${msg.error}`,
        );
        // Release pending resolve on error
        if (this.pendingResolve) {
          this.pendingResolve([]);
          this.pendingResolve = null;
        }
        break;
    }
  }

  private async restartWorker(): Promise<void> {
    if (this.stopped || this.restartScheduled) return;
    this.restartScheduled = true;

    // Terminate existing worker if still alive
    if (this.worker) {
      try {
        await this.worker.terminate();
      } catch {
        // Already dead
      }
      this.worker = null;
    }
    this.workerReady = false;

    // Clear tickInProgress for all agents so they aren't permanently stuck
    // after the worker crash (same fix as timeout path).
    for (const schedule of this.schedules.values()) {
      schedule.tickInProgress = false;
    }

    // Reject any pending tick promise so sendTickAndWait doesn't hang
    if (this.pendingResolve) {
      this.pendingResolve([]);
      this.pendingResolve = null;
    }

    // Re-spawn after short delay
    if (this.stopped) {
      this.restartScheduled = false;
      return;
    }
    this.restartTimeout = setTimeout(() => {
      this.restartTimeout = null;
      this.restartScheduled = false;
      if (this.stopped) return;
      void this.start().catch((err) => {
        console.error(
          "[AgentBehaviorBridge] Failed to restart worker:",
          errMsg(err),
        );
      });
    }, 100);
  }

  // ─── PRIVATE: POLL AND DISPATCH ───────────────────────────────────────

  /**
   * Called every BRIDGE_POLL_INTERVAL_MS. Finds agents that are due for a
   * behavior tick, collects their snapshots, sends to worker, and applies results.
   */
  private async pollAndDispatch(): Promise<void> {
    if (!this.workerReady || !this.worker) return;
    if (this.pendingResolve) return; // Previous batch still in-flight

    const pollStart = Date.now();
    const now = pollStart;
    const dueAgents: AgentTickInput[] = [];

    // Update world scan caches periodically
    this.worldScanCounter++;
    if (this.worldScanCounter >= AgentBehaviorBridge.WORLD_SCAN_INTERVAL) {
      this.worldScanCounter = 0;
      const t0 = Date.now();
      this.updateWorldScanCaches();
      const scanMs = Date.now() - t0;
      if (scanMs > 50) {
        console.warn(`[AgentBridge] updateWorldScanCaches took ${scanMs}ms`);
      }
    }

    // Collect other agent targets for mob spreading (cheap — just reads instance fields)
    const allAgentIds = this.getAllAgentIds();
    const otherAgentTargets: Array<{
      agentId: string;
      targetId: string | null;
    }> = [];
    for (const id of allAgentIds) {
      const inst = this.getAgent(id);
      if (inst) {
        otherAgentTargets.push({
          agentId: id,
          targetId: inst.currentTargetId,
        });
      }
    }

    const resourceSystemAvailable = !!this.world.getSystem("resource");

    // Compute NPC positions once per poll, shared across all agents in this batch
    let sharedNpcPositions: ReturnType<
      AgentInstance["service"]["getAllNPCPositions"]
    > | null = null;

    let agentsProcessed = 0;

    for (const [characterId, schedule] of this.schedules) {
      if (schedule.tickInProgress) continue;
      if (now < schedule.nextTickAt) continue;

      // Cap agents per poll cycle to avoid blocking the event loop
      if (agentsProcessed >= MAX_AGENTS_PER_POLL) break;

      const instance = this.getAgent(characterId);
      if (!instance || instance.state !== "running") continue;

      // Private duel preparation owns loadout/inventory exclusively. The
      // scheduler/manager clears this state only at a terminal transition.
      if (instance.duelPreparation) {
        schedule.nextTickAt = now + EMBEDDED_BEHAVIOR_TICK_INTERVAL;
        continue;
      }

      // Main-thread-only checks (need direct World access)
      if (
        recoverAgentFromDeathLoop(
          this.world,
          characterId,
          "AgentBehaviorBridge",
        )
      ) {
        instance.lastActivity = Date.now();
        schedule.nextTickAt = now + EMBEDDED_BEHAVIOR_TICK_INTERVAL;
        continue;
      }

      // Arena ejection is handled by the DuelSystem per game-tick.
      // Doing it here caused teleport spam — the agent would get ejected to
      // the nearby lobby, then the behavior engine would send it right back
      // into the arena on the next tick.

      const entity = this.world.entities.get(characterId);
      const inStreamingDuel =
        (entity?.data as { inStreamingDuel?: boolean } | undefined)
          ?.inStreamingDuel === true;
      if (inStreamingDuel) {
        schedule.nextTickAt = now + EMBEDDED_BEHAVIOR_TICK_INTERVAL;
        continue;
      }

      // Operator command grace — when the dashboard user just sent a command,
      // the worker should still run survival tasks (eating, equipment) but
      // skip autonomous action picking so it doesn't override the command.
      const inOperatorGrace =
        instance.operatorCommandAt > 0 &&
        now - instance.operatorCommandAt < 30_000;

      // Autonomy toggle — used by arena mode to suspend the behavior loop
      if (!instance.service.isAutonomousEnabled()) {
        schedule.nextTickAt = now + EMBEDDED_BEHAVIOR_TICK_INTERVAL;
        continue;
      }

      // Collect game state snapshot
      const gameState = instance.service.getGameState();
      if (!gameState || !gameState.position) {
        schedule.nextTickAt = now + EMBEDDED_BEHAVIOR_TICK_INTERVAL;
        continue;
      }

      // Compute NPC positions once per poll batch (not per agent)
      if (!sharedNpcPositions) {
        sharedNpcPositions = instance.service.getAllNPCPositions();
      }

      const inventoryItems = instance.service.getInventoryItems();
      const equippedItems = instance.service.getEquippedItems();
      const coinRecoveryAuthorized = hasOrdinaryCoinRecoveryAuthorization(
        instance,
        now,
        { inventoryItems, equippedItems },
      );

      // Per-agent data only — shared data is sent separately to avoid
      // structured clone duplicating large arrays N times
      const tickInput: AgentTickInput = {
        characterId,
        combatSpecialization: resolveOrdinaryCombatSpecialization(
          instance.config,
        ),
        behaviorEpoch: instance.behaviorEpoch,
        playerId: instance.service.getPlayerId(),
        name: instance.config.name,
        gameState,
        inventoryItems,
        equippedItems,
        questState: instance.service.getQuestState(),
        availableQuests: instance.service.getAvailableQuests(),
        storeRetryAfter: instance.storeRetryAfter,
        coinRecoveryAuthorized,
        attackObservationRetryAfter: instance.attackObservationRetryAfter,
        bankStageRetryAfter: instance.bankStageRetryAfter,
        questEntryAcquisitionQuestId:
          instance.questEntryAcquisition &&
          instance.questEntryAcquisition.expiresAt > now
            ? instance.questEntryAcquisition.questId
            : null,
        ordinaryProcessingAcquisitionAuthorized:
          Boolean(instance.ordinaryProcessingAcquisition) &&
          instance.ordinaryProcessingAcquisition!.expiresAt > now,
        survivalFoodAcquisitionAuthorized:
          Boolean(instance.survivalFoodAcquisition) &&
          instance.survivalFoodAcquisition!.expiresAt > now,
        ordinaryProcessingRetrySuppressions:
          snapshotOrdinaryProcessingRetrySuppressions(instance, now),
        operatorGrace: inOperatorGrace,
        // Placeholder empty arrays — worker fills from SharedTickData
        npcPositions: [],
        otherAgentTargets: [],
        resourceSystemAvailable,
        spawnAnchors: [],
        worldResources: [],
        worldMobs: [],
        stationPositions: [],
        storePositions: [],
        agentState: {
          goal: instance.goal,
          questsAccepted: Array.from(instance.questsAccepted),
          currentTargetId: instance.currentTargetId,
          lastAteAt: instance.lastAteAt,
          dropCooldownUntil: instance.dropCooldownUntil,
          lastGatherTargetId: instance.lastGatherTargetId,
          lastGatherQueuedAt: instance.lastGatherQueuedAt,
          pendingChatReaction: instance.pendingChatReaction,
          lastCombatChatAt: instance.lastCombatChatAt,
        },
      };

      dueAgents.push(tickInput);
      schedule.tickInProgress = true;
      schedule.nextTickAt = now + EMBEDDED_BEHAVIOR_TICK_INTERVAL;
      agentsProcessed++;

      // Yield to event loop between agents so tick timer can fire
      if (agentsProcessed < MAX_AGENTS_PER_POLL) {
        await yieldToEventLoop();
      }
    }

    const snapshotMs = Date.now() - pollStart;
    if (dueAgents.length === 0) {
      if (snapshotMs > 50) {
        console.warn(`[AgentBridge] Poll (0 agents) took ${snapshotMs}ms`);
      }
      return;
    }

    if (snapshotMs > 50) {
      console.warn(
        `[AgentBridge] Snapshot collection for ${dueAgents.length} agents took ${snapshotMs}ms`,
      );
    }

    // Build shared data sent ONCE (not duplicated per agent in structured clone)
    const shared: SharedTickData = {
      npcPositions: sharedNpcPositions ?? [],
      spawnAnchors: this.spawnAnchorsCache,
      worldResources: this.worldResourcesCache,
      worldMobs: this.worldMobsCache,
      stationPositions: this.stationPositionsCache,
      storePositions: this.storePositionsCache,
      otherAgentTargets,
      resourceSystemAvailable,
    };

    // Send to worker and wait for results
    const t0 = Date.now();
    const results = await this.sendTickAndWait(dueAgents, shared);
    const workerMs = Date.now() - t0;
    if (workerMs > 100) {
      console.warn(
        `[AgentBridge] Worker round-trip took ${workerMs}ms for ${dueAgents.length} agents`,
      );
    }

    const acceptedResults = this.reconcileTickResults(dueAgents, results);

    // Results belong to distinct agents, so their asynchronous action
    // completions can safely overlap. Per-agent tick fences remain held until
    // that agent's action and durable checkpoint have both completed.
    const applyStart = Date.now();
    await this.applyTickResultsConcurrently(acceptedResults);
    const applyMs = Date.now() - applyStart;

    const totalMs = Date.now() - pollStart;
    if (totalMs > 100) {
      console.warn(
        `[AgentBridge] Total poll: ${totalMs}ms (snapshot=${snapshotMs}ms, worker=${workerMs}ms, apply=${applyMs}ms, agents=${dueAgents.length})`,
      );
    }
  }

  /**
   * Accept at most one current result for each agent dispatched in this
   * batch. A malformed/partial worker response must neither replay an action
   * nor leave an agent permanently fenced as tick-in-progress.
   */
  private reconcileTickResults(
    dueAgents: AgentTickInput[],
    results: AgentTickOutput[],
  ): AgentTickOutput[] {
    const expectedEpochByCharacter = new Map(
      dueAgents.map((agent) => [agent.characterId, agent.behaviorEpoch]),
    );
    const acceptedCharacters = new Set<string>();
    const acceptedResults: AgentTickOutput[] = [];

    for (const result of results) {
      const expectedEpoch = expectedEpochByCharacter.get(result.characterId);
      if (expectedEpoch === undefined) {
        console.warn(
          `[AgentBehaviorBridge] Ignoring unexpected worker result for ${result.characterId}`,
        );
        continue;
      }
      if (acceptedCharacters.has(result.characterId)) {
        console.warn(
          `[AgentBehaviorBridge] Ignoring duplicate worker result for ${result.characterId}`,
        );
        continue;
      }
      if (result.behaviorEpoch !== expectedEpoch) {
        console.warn(
          `[AgentBehaviorBridge] Ignoring stale worker result for ${result.characterId}: expected epoch ${expectedEpoch}, received ${result.behaviorEpoch}`,
        );
        continue;
      }

      acceptedCharacters.add(result.characterId);
      acceptedResults.push(result);
    }

    for (const agent of dueAgents) {
      if (acceptedCharacters.has(agent.characterId)) continue;
      const schedule = this.schedules.get(agent.characterId);
      if (schedule) schedule.tickInProgress = false;
    }

    return acceptedResults;
  }

  private async applyTickResultsConcurrently(
    results: AgentTickOutput[],
  ): Promise<void> {
    await Promise.all(
      results.map(async (result) => {
        await this.applyTickResultWithDrain(result);
        await yieldToEventLoop();
      }),
    );
  }

  private sendTickAndWait(
    agents: AgentTickInput[],
    shared: SharedTickData,
  ): Promise<AgentTickOutput[]> {
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      this.sendToWorker({ type: "tick", agents, shared });

      // Timeout after 5s — don't block agent scheduling forever
      setTimeout(() => {
        if (this.pendingResolve === resolve) {
          console.warn("[AgentBehaviorBridge] Worker tick timed out after 5s");
          this.pendingResolve = null;
          resolve([]);
        }
      }, 5000);
    });
  }

  private async applyTickResultWithDrain(
    result: AgentTickOutput,
  ): Promise<void> {
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    this.applyDrains.set(result.characterId, drain);
    try {
      await this.applyTickResult(result);
    } finally {
      releaseDrain();
      if (this.applyDrains.get(result.characterId) === drain) {
        this.applyDrains.delete(result.characterId);
      }
    }
  }

  /** Apply one fenced, typed agent action. */
  private async applyTickResult(result: AgentTickOutput): Promise<void> {
    const applyStartedAt = Date.now();
    let appliedActionType = result.action.type;
    let beginAttemptMs = 0;
    let actionExecutionMs = 0;
    let checkpointMs = 0;
    const instance = this.getAgent(result.characterId);
    if (!instance || instance.state !== "running") {
      const schedule = this.schedules.get(result.characterId);
      if (schedule) schedule.tickInProgress = false;
      return;
    }

    if (
      instance.duelPreparation ||
      result.behaviorEpoch !== instance.behaviorEpoch
    ) {
      const schedule = this.schedules.get(result.characterId);
      if (schedule) schedule.tickInProgress = false;
      return;
    }

    try {
      const resultIsStale = (): boolean =>
        instance.duelPreparation !== undefined ||
        result.behaviorEpoch !== instance.behaviorEpoch;

      // Update agent state from worker decisions
      const s = result.updatedState;
      instance.goal = s.goal;
      instance.questsAccepted = new Set(s.questsAccepted);
      instance.currentTargetId = s.currentTargetId;
      instance.lastCombatChatAt = s.lastCombatChatAt;
      instance.pendingChatReaction = null; // Worker consumed it

      // Send combat chat if decided
      if (result.chatMessage) {
        try {
          await instance.service.sendChatMessage(result.chatMessage);
        } catch (err) {
          // Non-critical, don't fail the tick
        }
        if (resultIsStale()) return;
      }

      // ── Persistent navigation: if the agent has an active navigationTarget,
      // check if arrived, stuck, or timed out.
      const ARRIVAL_DIST_SQ = 64; // 8 tiles — close enough for long-distance nav
      const NAV_TIMEOUT_MS = 90_000; // 90s — enough for long walks, short enough to not loop forever
      const NAV_STUCK_THRESHOLD_SQ = 4; // 2 tiles — less than this movement = stuck
      const NAV_NOT_CLOSER_THRESHOLD = 3; // tiles — if not getting 3+ tiles closer per tick, count as no-progress
      const NAV_STUCK_TICKS_TO_CLEAR = 4; // clear after 4 ticks of no progress
      const now = Date.now();
      const nav = instance.navigationTarget;
      if (nav) {
        const gameState = instance.service.getGameState();
        const pos = gameState?.position;
        if (pos) {
          const dx = pos[0] - nav.position[0];
          const dz = pos[2] - nav.position[2];
          const distSq = dx * dx + dz * dz;
          const timedOut = now - nav.setAt > NAV_TIMEOUT_MS;

          // Stuck detection: track if agent is making progress toward target
          let navStuckCount = instance.navStuckCount || 0;
          const currentDist = Math.sqrt(distSq);
          if (instance.navStuckLastPos) {
            const movedDx = pos[0] - instance.navStuckLastPos[0];
            const movedDz = pos[2] - instance.navStuckLastPos[2];
            const movedDistSq = movedDx * movedDx + movedDz * movedDz;
            // Check both: agent not moving at all, OR agent moving but not getting closer
            const notMoving = movedDistSq < NAV_STUCK_THRESHOLD_SQ;
            const notCloser =
              instance.navStuckLastDist !== undefined &&
              instance.navStuckLastDist - currentDist <
                NAV_NOT_CLOSER_THRESHOLD;
            if (notMoving || notCloser) {
              navStuckCount++;
            } else {
              navStuckCount = 0;
            }
          }
          instance.navStuckLastPos = [pos[0], pos[1], pos[2]];
          instance.navStuckLastDist = currentDist;
          instance.navStuckCount = navStuckCount;

          const isStuck = navStuckCount >= NAV_STUCK_TICKS_TO_CLEAR;
          if (distSq < ARRIVAL_DIST_SQ || timedOut || isStuck) {
            instance.navigationTarget = null;
            instance.navStuckCount = 0;
          }
        }
      }

      // During operator grace period, skip LLM override.
      const inOperatorGrace =
        instance.operatorCommandAt > 0 &&
        now - instance.operatorCommandAt < 30_000;

      let action = result.action;
      appliedActionType = action.type;
      let consumedLlmResult: LlmBehaviorResult | null = null;
      const provisioningAction =
        action.type === "storeBuy" ||
        action.type === "bankWithdraw" ||
        action.type === "bankDepositAll" ||
        instance.goal?.type === "provisioning" ||
        instance.goal?.type === "banking";
      if (provisioningAction && instance.navigationTarget) {
        instance.navigationTarget = null;
        instance.navStuckCount = 0;
        instance.navStuckLastPos = undefined;
        instance.navStuckLastDist = undefined;
      }

      // If navigating, check if there are nearby mobs to fight first.
      // Also respect the worker's scripted action if it chose to attack something.
      if (instance.navigationTarget && !provisioningAction) {
        const gs = instance.service.getGameState();
        const nearby = instance.service.getNearbyEntities?.() ?? [];
        const goal = instance.goal;
        let combatInterrupt = false;

        // If the worker's scripted action is already an attack, prefer that
        // over continuing navigation — the worker sees nearby mobs too.
        if (
          result.action.type === "attack" &&
          (result.action as { targetId: string }).targetId
        ) {
          const attackAction = result.action as {
            type: "attack";
            targetId: string;
          };
          action = attackAction;
          instance.currentTargetId = attackAction.targetId;
          combatInterrupt = true;
          recordAgentThought(result.characterId, {
            type: "thinking",
            content: `Worker chose to attack ${attackAction.targetId} — pausing navigation to ${instance.navigationTarget.description}`,
            decisionPath: "scripted",
          });
        }

        // Quest-mob combat interrupt
        if (
          !combatInterrupt &&
          goal?.type === "questing" &&
          goal.questStageType === "kill" &&
          goal.questStageTarget &&
          gs &&
          !gs.inCombat &&
          gs.maxHealth > 0 &&
          gs.health / gs.maxHealth > 0.4
        ) {
          const target = goal.questStageTarget.toLowerCase();
          const questMob = nearby.find(
            (e: {
              type: string;
              name?: string;
              mobType?: string;
              health?: number;
              distance: number;
            }) => {
              if (e.type !== "mob" || e.distance > 40) return false;
              if (e.health !== undefined && e.health <= 0) return false;
              const name = (e.name || "").toLowerCase();
              const mType = (e.mobType || "").toLowerCase();
              return (
                name.includes(target) ||
                mType.includes(target) ||
                target.includes(name) ||
                target.includes(mType)
              );
            },
          );
          if (questMob) {
            action = { type: "attack", targetId: questMob.id };
            instance.currentTargetId = questMob.id;
            combatInterrupt = true;
            recordAgentThought(result.characterId, {
              type: "thinking",
              content: `Spotted ${questMob.name} — attacking for quest instead of continuing to ${instance.navigationTarget.description}`,
              decisionPath: "scripted",
            });
          }
        }

        // Generic combat interrupt: if any mob is very close and agent is healthy enough, fight it
        if (
          !combatInterrupt &&
          gs &&
          !gs.inCombat &&
          gs.maxHealth > 0 &&
          gs.health / gs.maxHealth > 0.3
        ) {
          const closeMob = nearby.find(
            (e: { type: string; health?: number; distance: number }) => {
              if (e.type !== "mob" || e.distance > 20) return false;
              if (e.health !== undefined && e.health <= 0) return false;
              return true;
            },
          );
          if (closeMob) {
            action = { type: "attack", targetId: closeMob.id };
            instance.currentTargetId = closeMob.id;
            combatInterrupt = true;
            recordAgentThought(result.characterId, {
              type: "thinking",
              content: `Engaging nearby ${(closeMob as { name?: string }).name || "mob"} while en route to ${instance.navigationTarget.description}`,
              decisionPath: "scripted",
            });
          }
        }

        if (!combatInterrupt) {
          // Still navigating — re-issue move toward the target
          action = {
            type: "move",
            target: instance.navigationTarget.position,
            runMode: true,
          };
          recordAgentThought(result.characterId, {
            type: "thinking",
            content: `Navigating to ${instance.navigationTarget.description}`,
            decisionPath: "scripted",
          });
        }
      } else if (
        !provisioningAction &&
        !inOperatorGrace &&
        isLlmBehaviorEnabled(instance)
      ) {
        // LLM-driven action selection — consume pre-fetched result from
        // the previous tick so we never block the game loop waiting on an
        // API call. The LLM call for the *next* tick is fired non-blocking
        // after apply completes (see below).
        const llmResult = instance.pendingLlmResult ?? null;
        instance.pendingLlmResult = undefined; // consumed
        if (
          llmResult &&
          !isOrdinaryProcessingActionSuppressed(
            instance.ordinaryProcessingRetries,
            llmResult.action,
            now,
          )
        ) {
          action = llmResult.action;
          consumedLlmResult = llmResult;
          // A consumed goal is advisory intent. Action/plan history is committed
          // only after execution, and action handlers may still clear this goal.
          if (llmResult.goal) {
            instance.goal = llmResult.goal;
          }
          // Publish only the model's bounded, public-safe decision summary.
          const thoughtContent = llmResult.thinking
            ? `💭 ${llmResult.thinking}\n→ ${llmResult.reasoning}`
            : llmResult.reasoning;
          recordAgentThought(result.characterId, {
            type: "thinking",
            content: thoughtContent,
            decisionPath: "llm",
          });
        }
      }

      if (
        consumedLlmResult === null &&
        instance.pendingLlmResult !== undefined &&
        (instance.navigationTarget !== null ||
          provisioningAction ||
          inOperatorGrace ||
          !isLlmBehaviorEnabled(instance))
      ) {
        // A prefetch is valid for the immediately following ordinary decision
        // only. Navigation, provisioning, operator control, or a disabled model
        // path makes its observed world state stale, so it must be discarded.
        instance.pendingLlmResult = undefined;
      }

      // The worker receives this state as guidance, but the main process is
      // the final authority. A stale/model result cannot bypass an active
      // exact-recipe suppression.
      if (
        isOrdinaryProcessingActionSuppressed(
          instance.ordinaryProcessingRetries,
          action,
          now,
        )
      ) {
        action = { type: "idle" };
        consumedLlmResult = null;
      }

      // Record a thought for all non-idle actions from any decision path.
      // Navigation and LLM paths record thoughts above; this handles the scripted
      // worker fallback path so the visualizer always shows what agents are doing.
      if (action.type !== "idle") {
        const actionSummary =
          action.type === "navigateTo"
            ? `Navigate to ${(action as { destination: string }).destination}`
            : action.type === "attack"
              ? `Attacking ${(action as { targetId: string }).targetId}`
              : action.type === "gather"
                ? `Gathering ${(action as { targetId: string }).targetId}`
                : action.type === "move"
                  ? `Moving to [${(action as { target: [number, number, number] }).target?.[0]?.toFixed(0)},${(action as { target: [number, number, number] }).target?.[2]?.toFixed(0)}]`
                  : action.type === "pickup"
                    ? `Picking up ${(action as { targetId: string }).targetId}`
                    : action.type === "questAccept"
                      ? `Accepting quest ${(action as { questId: string }).questId}`
                      : action.type === "questComplete"
                        ? `Completing quest ${(action as { questId: string }).questId}`
                        : action.type === "storeBuy"
                          ? `Buying ${(action as { itemId: string }).itemId}`
                          : action.type === "cook"
                            ? `Cooking ${(action as { itemId: string }).itemId}`
                            : action.type === "smelt"
                              ? `Smelting ${(action as { recipe: string }).recipe}`
                              : action.type === "smith"
                                ? `Smithing ${(action as { recipe: string }).recipe}`
                                : action.type === "bankDepositAll"
                                  ? "Depositing surplus items at bank"
                                  : action.type === "bankWithdraw"
                                    ? instance.goal?.bankPurpose ===
                                      "survival_food"
                                      ? "Staging survival food from private bank"
                                      : "Staging an authored processing batch from bank"
                                    : action.type === "bury"
                                      ? `Training Prayer with ${(action as { itemId: string }).itemId}`
                                      : action.type === "homeTeleport"
                                        ? "Teleporting home"
                                        : action.type;
        // Only record if no thought was already recorded by nav/LLM paths above
        if (!instance.navigationTarget) {
          recordAgentThought(result.characterId, {
            type: "thinking",
            content: actionSummary,
            decisionPath: "scripted",
          });
        }
      }

      // Reset questCompleteFailures when agent is doing non-complete quest work.
      // This prevents stale failure counts from blocking future completion attempts
      // after the underlying issue (e.g. missing materials) has been resolved.
      if (
        action.type !== "questComplete" &&
        action.type !== "idle" &&
        instance.questCompleteFailures?.size
      ) {
        instance.questCompleteFailures.clear();
      }

      appliedActionType = action.type;
      let actionExecution = actionResult(
        action.type,
        action.type === "idle" ? "idle" : "rejected",
      );
      const decisionSource: AgentAutonomyDecisionSource = consumedLlmResult
        ? "llm"
        : "scripted";
      let progressionAttempt: AgentAutonomyProgressionAttempt | null = null;
      let preActionCheckpointContext: AgentAutonomyCheckpointContext | null =
        null;
      if (action.type !== "idle" && this.beginAutonomyProgressionAttempt) {
        const safePreActionContext =
          captureAgentAutonomyCheckpointContext(instance);
        const beginAttemptStartedAt = Date.now();
        try {
          progressionAttempt = await this.beginAutonomyProgressionAttempt(
            instance,
            action.type,
            decisionSource,
          );
          if (progressionAttempt) {
            preActionCheckpointContext = safePreActionContext;
          }
        } catch (error) {
          actionExecution = actionResult(action.type, "failed");
          if (!resultIsStale()) {
            recordAuthoritativeBehaviorOutcome(instance, {
              action,
              execution: actionExecution,
              source: decisionSource,
              llmResult: consumedLlmResult,
            });
          }
          instance.pendingLlmResult = undefined;
          console.warn(
            `[AgentBehaviorBridge] Refusing untracked action ${action.type} for ${result.characterId}: ${errMsg(error)}`,
          );
          return;
        } finally {
          beginAttemptMs = Date.now() - beginAttemptStartedAt;
        }

        if (resultIsStale()) {
          if (
            progressionAttempt &&
            preActionCheckpointContext &&
            this.persistAutonomyCheckpoint
          ) {
            try {
              await this.persistAutonomyCheckpoint(
                instance,
                actionExecution,
                progressionAttempt,
                preActionCheckpointContext,
              );
            } catch (error) {
              console.warn(
                `[AgentBehaviorBridge] Failed to close fenced autonomy attempt for ${result.characterId}: ${errMsg(error)}`,
              );
            }
          }
          return;
        }
      }
      const actionExecutionStartedAt = Date.now();
      try {
        switch (action.type) {
          case "attack":
            if (await instance.service.executeAttack(action.targetId)) {
              actionExecution = actionResult("attack", "dispatched", "attack");
              instance.attackObservationRetryAfter =
                Date.now() + ATTACK_OBSERVATION_SETTLE_MS;
            }
            break;

          case "gather":
            if (!progressionAttempt) break;
            if (
              await instance.service.executeGather(
                action.targetId,
                progressionAttempt.attemptId,
              )
            ) {
              actionExecution = actionResult("gather", "completed", "gather");
            }
            break;

          case "pickup":
            if (!progressionAttempt) break;
            if (
              await instance.service.executePickup(
                action.targetId,
                progressionAttempt.attemptId,
              )
            ) {
              actionExecution = actionResult("pickup", "completed", "pickup");
            }
            break;

          case "lootGravestone": {
            if (!progressionAttempt) break;
            if (
              await instance.service.executeLootGravestone(
                action.gravestoneId,
                progressionAttempt.attemptId,
              )
            ) {
              actionExecution = actionResult(
                "lootGravestone",
                "completed",
                "lootGravestone",
              );
            }
            break;
          }

          case "move":
            if (
              await instance.service.executeMove(action.target, action.runMode)
            ) {
              actionExecution = actionResult("move", "dispatched", "move");
            }
            break;

          case "firemake":
            if (!progressionAttempt) break;
            if (
              await instance.service.executeFiremake(
                action.logsItemId,
                progressionAttempt.attemptId,
              )
            ) {
              actionExecution = actionResult(
                "firemake",
                "completed",
                "firemake",
              );
            }
            break;

          case "questAccept": {
            const accepted = await instance.service.executeQuestAccept(
              action.questId,
            );
            const questStarted =
              accepted &&
              (await waitForQuestStartConfirmation(instance, action.questId));
            if (questStarted) {
              instance.questsAccepted.add(action.questId);
              actionExecution = actionResult(
                "questAccept",
                "completed",
                "questAccept",
              );
            }
            break;
          }

          case "questComplete": {
            // Track quest completion failures to avoid infinite loops.
            // After 3 failed attempts, clear the goal so the agent reassesses.
            if (!instance.questCompleteFailures) {
              instance.questCompleteFailures = new Map();
            }
            const failCount =
              instance.questCompleteFailures.get(action.questId) || 0;
            if (failCount >= 3) {
              instance.goal = null;
              break;
            }

            const completed = await instance.service.executeQuestComplete(
              action.questId,
            );
            if (completed) {
              instance.goal = null;
              instance.questCompleteFailures.delete(action.questId);
              actionExecution = actionResult(
                "questComplete",
                "completed",
                "questComplete",
              );
              break;
            }

            instance.questCompleteFailures.set(action.questId, failCount + 1);
            const quest = instance.service
              .getQuestState()
              .find((candidate) => candidate.questId === action.questId);
            const npcName = quest?.startNpc;
            if (npcName && !instance.navigationTarget) {
              const gameState = instance.service.getGameState();
              const coords = findWorldMapMoveTarget(
                npcName,
                instance.service,
                gameState?.position ?? null,
              );
              if (coords) {
                instance.navigationTarget = {
                  position: coords,
                  description: `${npcName} (turn in ${quest?.name || action.questId})`,
                  setAt: Date.now(),
                };
                if (await instance.service.executeMove(coords, true)) {
                  actionExecution = actionResult(
                    "questComplete",
                    "dispatched",
                    "move",
                  );
                }
              }
            }
            break;
          }

          case "navigateTo": {
            const gameState = instance.service.getGameState();
            const coords = findWorldMapMoveTarget(
              action.destination,
              instance.service,
              gameState?.position ?? null,
            );
            if (coords) {
              // LLM destinations are reassessed every tick rather than stored as
              // replayable navigation commands.
              if (await instance.service.executeMove(coords, true)) {
                actionExecution = actionResult(
                  "navigateTo",
                  "dispatched",
                  "move",
                );
              }
            } else {
              // An unresolvable LLM destination may fall back to the worker's
              // independently validated scripted action.
              const fallback = result.action;
              if (
                fallback.type !== "idle" &&
                fallback.type !== "navigateTo" &&
                !isReceiptBoundCustodyAction(fallback)
              ) {
                let fallbackExecution: AgentAutonomyActionResult;
                try {
                  fallbackExecution = await this.executeAction(
                    instance,
                    fallback,
                  );
                } catch (error) {
                  recordOrdinaryProcessingActionOutcome(instance, fallback, {
                    outcome: "failed",
                    appliedActionType: null,
                  });
                  throw error;
                }
                recordOrdinaryProcessingActionOutcome(
                  instance,
                  fallback,
                  fallbackExecution,
                );
                actionExecution = {
                  ...fallbackExecution,
                  attemptedActionType: "navigateTo",
                };
              }
            }
            break;
          }

          case "use":
            if ((await instance.service.executeUse(action.itemId)).ok) {
              actionExecution = actionResult("use", "completed", "use");
              const healAmount = (
                getItem(action.itemId) as { healAmount?: number } | undefined
              )?.healAmount;
              if (typeof healAmount === "number" && healAmount > 0) {
                instance.lastAteAt = Date.now();
              }
            }
            break;

          case "bury": {
            if (!progressionAttempt) break;
            const burial = await executeOrdinaryBoneBurial(
              instance,
              action.itemId,
              progressionAttempt,
            );
            if (!burial.settled) {
              instance.pendingLlmResult = undefined;
              return;
            }
            if (burial.applied) {
              actionExecution = actionResult("bury", "completed", "bury");
            }
            break;
          }

          case "equip":
            if ((await instance.service.executeEquip(action.itemId)).ok) {
              actionExecution = actionResult("equip", "completed", "equip");
            }
            break;

          case "setAutocast":
            if (await instance.service.executeSetAutocast(action.spellId)) {
              actionExecution = actionResult(
                "setAutocast",
                "completed",
                "setAutocast",
              );
            }
            break;

          case "cook": {
            if (!progressionAttempt) break;
            if (
              await instance.service.executeCook(
                action.itemId,
                progressionAttempt.attemptId,
              )
            ) {
              actionExecution = actionResult("cook", "completed", "cook");
            }
            break;
          }

          case "smelt":
            if (!progressionAttempt) break;
            if (
              await instance.service.executeSmelt(
                action.recipe,
                progressionAttempt.attemptId,
              )
            ) {
              actionExecution = actionResult("smelt", "completed", "smelt");
            }
            break;

          case "smith":
            if (!progressionAttempt) break;
            if (
              await instance.service.executeSmith(
                action.recipe,
                progressionAttempt.attemptId,
              )
            ) {
              actionExecution = actionResult("smith", "completed", "smith");
            }
            break;

          case "runecraft":
            if (!progressionAttempt) break;
            if (
              await instance.service.executeRunecraft(
                action.runeType,
                progressionAttempt.attemptId,
              )
            ) {
              actionExecution = actionResult(
                "runecraft",
                "completed",
                "runecraft",
              );
            }
            break;

          case "craft":
            if (!progressionAttempt) break;
            if (
              await instance.service.executeCraft(
                action.recipeId,
                action.quantity ?? 1,
                progressionAttempt.attemptId,
              )
            ) {
              actionExecution = actionResult("craft", "completed", "craft");
            }
            break;

          case "fletch":
            if (!progressionAttempt) break;
            if (
              await instance.service.executeFletch(
                action.recipeId,
                action.quantity ?? 1,
                progressionAttempt.attemptId,
              )
            ) {
              actionExecution = actionResult("fletch", "completed", "fletch");
            }
            break;

          case "tan":
            if (!progressionAttempt) break;
            if (
              await instance.service.executeTan(
                action.inputItemId,
                action.quantity ?? 1,
                progressionAttempt.attemptId,
              )
            ) {
              actionExecution = actionResult("tan", "completed", "tan");
            }
            break;

          case "storeBuy": {
            if (!progressionAttempt) break;
            const purchase = await executeOrdinaryStoreBuy(
              instance,
              action.storeId,
              action.itemId,
              action.quantity,
              progressionAttempt,
            );
            if (!purchase.settled) {
              // Keep the durable attempt open for startup receipt recovery.
              instance.pendingLlmResult = undefined;
              return;
            }
            recordOrdinaryStoreBuyOutcome(instance, purchase, action);
            if (purchase.applied) {
              actionExecution = actionResult(
                "storeBuy",
                "completed",
                "storeBuy",
              );
            }
            break;
          }

          case "bankDepositAll": {
            if (!progressionAttempt) break;
            const banking = await executeOrdinaryBankDepositSurplus(
              instance,
              action.bankId,
              progressionAttempt,
            );
            if (!banking.settled) {
              // Process shutdown owns the remaining uncertainty. Leave the
              // immutable start open so startup can reconcile its bank receipt.
              instance.pendingLlmResult = undefined;
              return;
            }
            if (banking.applied) {
              actionExecution = actionResult(
                "bankDepositAll",
                "completed",
                "bankDepositAll",
              );
            }
            break;
          }

          case "bankWithdraw": {
            if (!progressionAttempt) break;
            const banking = await executeOrdinaryBankStageMaterials(
              instance,
              action.bankId,
              progressionAttempt,
            );
            if (!banking.settled) {
              // Process shutdown owns the remaining uncertainty. Leave the
              // immutable start open for receipt reconciliation on restart.
              instance.pendingLlmResult = undefined;
              return;
            }
            recordOrdinaryBankStageOutcome(instance, banking);
            if (banking.applied) {
              actionExecution = actionResult(
                "bankWithdraw",
                "completed",
                "bankWithdraw",
              );
            }
            break;
          }

          case "homeTeleport":
            if (await instance.service.executeHomeTeleport()) {
              actionExecution = actionResult(
                "homeTeleport",
                "dispatched",
                "homeTeleport",
              );
            }
            break;

          case "stop":
            instance.navigationTarget = null;
            if (await instance.service.executeStop()) {
              actionExecution = actionResult("stop", "completed", "stop");
            }
            break;

          case "idle":
          default:
            break;
        }
      } catch (error) {
        actionExecution = actionResult(action.type, "failed");
        console.warn(
          `[AgentBehaviorBridge] Action ${action.type} failed for ${result.characterId}: ${errMsg(error)}`,
        );
      } finally {
        actionExecutionMs = Date.now() - actionExecutionStartedAt;
      }

      if (actionExecution.appliedActionType !== null) {
        instance.lastActivity = Date.now();
      }

      if (resultIsStale()) {
        if (
          progressionAttempt &&
          preActionCheckpointContext &&
          this.persistAutonomyCheckpoint
        ) {
          try {
            await this.persistAutonomyCheckpoint(
              instance,
              actionExecution,
              progressionAttempt,
              preActionCheckpointContext,
            );
          } catch (error) {
            console.warn(
              `[AgentBehaviorBridge] Failed to close stale autonomy attempt for ${result.characterId}: ${errMsg(error)}`,
            );
          }
        }
        return;
      }

      // The worker proposes this throttle before the main thread can ask the
      // authoritative path/reservation manager. Commit it only after exact
      // queue admission; a rejected or superseded request must remain
      // immediately retryable and must not hide another eligible resource.
      if (actionExecution.appliedActionType === "gather") {
        instance.lastGatherTargetId = s.lastGatherTargetId;
        instance.lastGatherQueuedAt = s.lastGatherQueuedAt;
      } else if (actionExecution.appliedActionType !== null) {
        // The throttle protects one still-active gather from duplicate queue
        // submissions. Once any different action is authoritatively applied,
        // that gathering phase is over and burn/material recovery may return
        // to the same resource immediately.
        instance.lastGatherTargetId = null;
        instance.lastGatherQueuedAt = 0;
      }

      recordOrdinaryProcessingActionOutcome(instance, action, actionExecution);

      recordAuthoritativeBehaviorOutcome(instance, {
        action,
        execution: actionExecution,
        source: decisionSource,
        llmResult: consumedLlmResult,
      });

      // Sync goal to ServerNetwork so the dashboard can display it
      syncEmbeddedAgentDashboardForTick(
        result.characterId,
        instance.goal,
        instance.service.getQuestState(),
        instance.service.getAvailableQuests(),
        instance.startedAt,
        actionExecution.appliedActionType ?? "idle",
        actionExecution.appliedActionType === null
          ? `${actionExecution.attemptedActionType} ${actionExecution.outcome}`
          : `${actionExecution.attemptedActionType} ${actionExecution.outcome} as ${actionExecution.appliedActionType}`,
      );

      // Commit only bounded context after the action dispatch has returned.
      // No target or pending action is stored, so a replacement process can
      // never replay this tick and must decide again from live world state.
      let checkpointPersisted = true;
      if (this.persistAutonomyCheckpoint) {
        const checkpointStartedAt = Date.now();
        try {
          if (progressionAttempt) {
            await this.persistAutonomyCheckpoint(
              instance,
              actionExecution,
              progressionAttempt,
            );
          } else {
            await this.persistAutonomyCheckpoint(instance, actionExecution);
          }
        } catch (error) {
          checkpointPersisted = false;
          instance.pendingLlmResult = undefined;
          console.warn(
            `[AgentBehaviorBridge] Failed to persist autonomy checkpoint for ${result.characterId}: ${errMsg(error)}`,
          );
        } finally {
          checkpointMs = Date.now() - checkpointStartedAt;
        }
      }

      if (progressionAttempt && !checkpointPersisted) {
        // The head remains open, preventing any later main action from creating
        // a misleading history until this ambiguity is recovered.
        return;
      }

      // ── NON-BLOCKING LLM PRE-FETCH ──────────────────────────────────
      // Fire the LLM call for the NEXT tick now. The result will be
      // consumed by applyTickResult on the next cycle (~8s from now).
      // This moves the 1-2s LLM latency completely off the critical path.
      if (
        !instance.llmCallInFlight &&
        instance.pendingLlmResult === undefined &&
        instance.navigationTarget === null &&
        !provisioningAction &&
        !inOperatorGrace &&
        isLlmBehaviorEnabled(instance)
      ) {
        const freshState = instance.service.getGameState();
        if (freshState?.position) {
          const behaviorEpoch = instance.behaviorEpoch;
          instance.llmCallInFlight = true;
          pickBehaviorActionWithLlm(instance, freshState)
            .then((llmResult) => {
              if (
                instance.state === "running" &&
                !instance.duelPreparation &&
                instance.behaviorEpoch === behaviorEpoch &&
                instance.navigationTarget === null &&
                !(
                  instance.operatorCommandAt > 0 &&
                  Date.now() - instance.operatorCommandAt < 30_000
                )
              ) {
                instance.pendingLlmResult = llmResult;
              }
            })
            .catch(() => {
              if (
                !instance.duelPreparation &&
                instance.behaviorEpoch === behaviorEpoch
              ) {
                instance.pendingLlmResult = null;
              }
            })
            .finally(() => {
              instance.llmCallInFlight = false;
            });
        }
      }
    } catch (err) {
      console.warn(
        `[AgentBehaviorBridge] Failed to apply tick result for ${result.characterId}: ${errMsg(err)}`,
      );
    } finally {
      const totalMs = Date.now() - applyStartedAt;
      if (totalMs > 100) {
        console.warn(
          `[AgentBridge] Slow apply for ${result.characterId} action=${appliedActionType}: total=${totalMs}ms begin=${beginAttemptMs}ms execute=${actionExecutionMs}ms checkpoint=${checkpointMs}ms residual=${Math.max(0, totalMs - beginAttemptMs - actionExecutionMs - checkpointMs)}ms`,
        );
      }
      const schedule = this.schedules.get(result.characterId);
      if (schedule) schedule.tickInProgress = false;
    }
  }

  /**
   * Execute a single behavior action on behalf of an agent. Used by the main
   * switch and by the navigateTo fallback path so all action types are handled.
   */
  private async executeAction(
    instance: AgentInstance,
    action: EmbeddedBehaviorAction,
  ): Promise<AgentAutonomyActionResult> {
    // Receipt-bound custody actions are valid only in the primary switch,
    // where the immutable progression-attempt identity is available. A
    // navigation fallback must never synthesize a second operation identity.
    if (isReceiptBoundCustodyAction(action)) {
      return actionResult(action.type, "rejected");
    }
    switch (action.type) {
      case "attack": {
        const dispatched = await instance.service.executeAttack(
          action.targetId,
        );
        if (!dispatched) return actionResult("attack", "rejected");
        instance.attackObservationRetryAfter =
          Date.now() + ATTACK_OBSERVATION_SETTLE_MS;
        return actionResult("attack", "dispatched", "attack");
      }
      case "move":
        return (await instance.service.executeMove(
          action.target,
          action.runMode,
        ))
          ? actionResult("move", "dispatched", "move")
          : actionResult("move", "rejected");
      case "firemake":
        return (await instance.service.executeFiremake(action.logsItemId))
          ? actionResult("firemake", "completed", "firemake")
          : actionResult("firemake", "rejected");
      case "questAccept":
        return (await instance.service.executeQuestAccept(action.questId))
          ? actionResult("questAccept", "dispatched", "questAccept")
          : actionResult("questAccept", "rejected");
      case "questComplete":
        return (await instance.service.executeQuestComplete(action.questId))
          ? actionResult("questComplete", "completed", "questComplete")
          : actionResult("questComplete", "rejected");
      case "use":
        return (await instance.service.executeUse(action.itemId)).ok
          ? actionResult("use", "completed", "use")
          : actionResult("use", "rejected");
      case "equip":
        return (await instance.service.executeEquip(action.itemId)).ok
          ? actionResult("equip", "completed", "equip")
          : actionResult("equip", "rejected");
      case "setAutocast":
        return (await instance.service.executeSetAutocast(action.spellId))
          ? actionResult("setAutocast", "completed", "setAutocast")
          : actionResult("setAutocast", "rejected");
      case "cook":
        return (await instance.service.executeCook(action.itemId))
          ? actionResult("cook", "completed", "cook")
          : actionResult("cook", "rejected");
      case "smelt":
        return (await instance.service.executeSmelt(action.recipe))
          ? actionResult("smelt", "completed", "smelt")
          : actionResult("smelt", "rejected");
      case "smith":
        return (await instance.service.executeSmith(action.recipe))
          ? actionResult("smith", "completed", "smith")
          : actionResult("smith", "rejected");
      case "runecraft":
        return (await instance.service.executeRunecraft(action.runeType))
          ? actionResult("runecraft", "completed", "runecraft")
          : actionResult("runecraft", "rejected");
      case "craft":
        return (await instance.service.executeCraft(
          action.recipeId,
          action.quantity ?? 1,
        ))
          ? actionResult("craft", "completed", "craft")
          : actionResult("craft", "rejected");
      case "fletch":
        return (await instance.service.executeFletch(
          action.recipeId,
          action.quantity ?? 1,
        ))
          ? actionResult("fletch", "completed", "fletch")
          : actionResult("fletch", "rejected");
      case "tan":
        return (await instance.service.executeTan(
          action.inputItemId,
          action.quantity ?? 1,
        ))
          ? actionResult("tan", "completed", "tan")
          : actionResult("tan", "rejected");
      case "homeTeleport":
        return (await instance.service.executeHomeTeleport())
          ? actionResult("homeTeleport", "dispatched", "homeTeleport")
          : actionResult("homeTeleport", "rejected");
      case "stop":
        return (await instance.service.executeStop())
          ? actionResult("stop", "completed", "stop")
          : actionResult("stop", "rejected");
      default:
        return actionResult("idle", "idle");
    }
  }

  // ─── PRIVATE: WORLD SCAN CACHES ───────────────────────────────────────

  /**
   * Pre-compute spawn anchors and world resources so the worker doesn't
   * need to iterate all world entities.
   */
  private updateWorldScanCaches(): void {
    const anchors: typeof this.spawnAnchorsCache = [];
    const resources: typeof this.worldResourcesCache = [];
    const mobs: typeof this.worldMobsCache = [];
    const stations: typeof this.stationPositionsCache = [];
    const stores: typeof this.storePositionsCache = [];

    for (const [, entity] of this.world.entities.items.entries()) {
      const data = (entity as { data?: Record<string, unknown> }).data;
      if (!data) continue;

      const name = String(data.name || "").toLowerCase();
      const entityType = String(data.type || "").toLowerCase();
      const runtimeEntity = entity as unknown as {
        entityType?: unknown;
        config?: {
          interactionDistance?: unknown;
          npcType?: unknown;
          resourceId?: unknown;
          resourceType?: unknown;
          depleted?: unknown;
        };
        node?: { userData?: { interactionDistance?: unknown } };
        getInteractionFootprint?: () => unknown;
      };
      const runtimeEntityType = String(
        runtimeEntity.entityType ?? "",
      ).toLowerCase();
      const configuredResourceId = runtimeEntity.config?.resourceId;
      const configuredResourceType = runtimeEntity.config?.resourceType;
      const resourceType = String(
        data.resourceType ?? configuredResourceType ?? "",
      ).toLowerCase();
      const resourceId =
        typeof data.resourceId === "string" ? data.resourceId.trim() : "";
      const exactResourceId =
        resourceId ||
        (typeof configuredResourceId === "string"
          ? configuredResourceId.trim()
          : "");
      const configuredStoreId = (
        entity as unknown as {
          config?: { storeId?: unknown };
        }
      ).config?.storeId;
      const storeId =
        typeof data.storeId === "string"
          ? data.storeId
          : typeof configuredStoreId === "string"
            ? configuredStoreId
            : null;

      // Collect spawn anchors
      const isAnchor =
        name.includes("starter chest") ||
        name.includes("goblin") ||
        name.includes("bank") ||
        name.includes("spawn") ||
        name.includes("start");

      if (isAnchor) {
        const pos = this.getEntityPosition(entity);
        if (pos) {
          anchors.push({ position: pos, name });
        }
      }

      // Collect resources
      if ((entityType === "resource" || resourceType) && exactResourceId) {
        const pos = this.getEntityPosition(entity);
        if (pos) {
          resources.push({
            entityId: String(data.id || entity.id),
            position: pos,
            name,
            resourceId: exactResourceId,
            resourceType,
            depleted:
              data.depleted === true || runtimeEntity.config?.depleted === true,
          });
        }
      }

      const mobType = getAuthoritativeRuntimeMobType(entity, data) ?? "";
      const mobAlive =
        data.alive !== false &&
        data.dead !== true &&
        data.isDead !== true &&
        (typeof data.health !== "number" || data.health > 0);
      if (
        mobType &&
        mobAlive &&
        (entityType === "mob" || runtimeEntityType === "mob")
      ) {
        const pos = this.getEntityPosition(entity);
        if (pos) mobs.push({ position: pos, mobType });
      }

      // Collect only exact, server-loaded workstation identities. Display-name
      // matches are insufficient: a decorative object named "anvil" must not
      // become an autonomous navigation target.
      const npcType = String(
        runtimeEntity.config?.npcType ?? data.npcType ?? "",
      ).toLowerCase();
      const stationType =
        runtimeEntityType === "furnace" || entityType === "furnace"
          ? "furnace"
          : runtimeEntityType === "anvil" || entityType === "anvil"
            ? "anvil"
            : runtimeEntityType === "range" || entityType === "range"
              ? "range"
              : runtimeEntityType === "runecrafting_altar" ||
                  entityType === "runecrafting_altar"
                ? "runecrafting"
                : entityType === "bank"
                  ? "bank"
                  : npcType === "tanner"
                    ? "tanner"
                    : null;
      if (stationType) {
        const pos = this.getEntityPosition(entity);
        const configuredRange =
          stationType === "bank"
            ? INTERACTION_DISTANCE[SessionType.BANK]
            : Number(
                runtimeEntity.config?.interactionDistance ??
                  runtimeEntity.node?.userData?.interactionDistance ??
                  data.interactionDistance ??
                  (stationType === "tanner" ? 3 : Number.NaN),
              );
        const runtimeFootprint = runtimeEntity.getInteractionFootprint?.() as
          { width?: unknown; depth?: unknown } | undefined;
        const footprintWidth = Number(runtimeFootprint?.width ?? 1);
        const footprintDepth = Number(runtimeFootprint?.depth ?? 1);
        if (
          pos &&
          Number.isFinite(configuredRange) &&
          configuredRange > 0 &&
          configuredRange <= 10 &&
          Number.isSafeInteger(footprintWidth) &&
          footprintWidth >= 1 &&
          footprintWidth <= 10 &&
          Number.isSafeInteger(footprintDepth) &&
          footprintDepth >= 1 &&
          footprintDepth <= 10
        ) {
          // Include entity ID in name for specific station matching (e.g. "air_altar_spawn")
          const entityId = String(data.id || entity.id);
          const normalizedEntityId = entityId.toLowerCase();
          const stationName = name
            ? `${name} ${normalizedEntityId}`
            : normalizedEntityId;
          stations.push({
            entityId,
            position: pos,
            name: stationName,
            stationType,
            interactionRange: configuredRange,
            footprintWidth,
            footprintDepth,
          });
        }
      }

      if (storeId) {
        const pos = this.getEntityPosition(entity);
        if (pos) {
          stores.push({
            entityId: String(data.id || entity.id),
            storeId,
            name: String(data.name || storeId),
            position: pos,
          });
        }
      }
    }

    this.spawnAnchorsCache = anchors;
    this.worldResourcesCache = resources;
    this.worldMobsCache = mobs.sort(
      (a, b) =>
        a.mobType.localeCompare(b.mobType) ||
        a.position[0] - b.position[0] ||
        a.position[2] - b.position[2],
    );
    this.stationPositionsCache = stations;
    this.storePositionsCache = stores;
  }

  private getEntityPosition(entity: unknown): [number, number, number] | null {
    const e = entity as {
      position?: unknown;
      data?: Record<string, unknown>;
    };

    const directPos = e.position;
    if (Array.isArray(directPos) && directPos.length >= 3) {
      return [directPos[0], directPos[1], directPos[2]];
    }
    if (
      directPos &&
      typeof directPos === "object" &&
      "x" in directPos &&
      "z" in directPos
    ) {
      const p = directPos as { x: number; y?: number; z: number };
      return [p.x, p.y ?? 0, p.z];
    }

    const dataPos = e.data?.position;
    if (Array.isArray(dataPos) && dataPos.length >= 3) {
      return [dataPos[0] as number, dataPos[1] as number, dataPos[2] as number];
    }
    if (
      dataPos &&
      typeof dataPos === "object" &&
      "x" in dataPos &&
      "z" in dataPos
    ) {
      const p = dataPos as { x: number; y?: number; z: number };
      return [p.x, p.y ?? 0, p.z];
    }
    return null;
  }
}
