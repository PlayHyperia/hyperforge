/**
 * Explicit opt-in live contract check for ordinary agent planning.
 *
 * This test sends the current production prompt to the supported OpenAI
 * provider and validates the response with the same strict parser used by the
 * embedded runtime. It never reads local env files or runs from the presence
 * of a key alone. Enable it deliberately with:
 *
 *   RUN_LIVE_ELIZA_PROVIDER_TESTS=true OPENAI_API_KEY=... bun run test
 */
import { describe, expect, it } from "vitest";

import type { EmbeddedGameState, NearbyEntityData } from "../types.js";
import type { AgentInstance } from "../managers/AgentBehaviorTicker.js";
import {
  buildBehaviorDecisionPrompt,
  parseLlmBehaviorResponse,
} from "../llmBehaviorDecision.js";

const API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const MODEL =
  process.env.OPENAI_SMALL_MODEL?.trim() ||
  process.env.OPENAI_MODEL?.trim() ||
  "gpt-4o-mini";
const RUN_LIVE =
  process.env.RUN_LIVE_ELIZA_PROVIDER_TESTS === "true" && API_KEY.length > 0;
const describeLive = RUN_LIVE ? describe : describe.skip;

const nearby: NearbyEntityData[] = [
  {
    id: "training-mob-1",
    name: "Training Mob",
    type: "mob",
    position: [3, 0, 2],
    distance: 3.6,
    health: 10,
    maxHealth: 10,
    level: 1,
  },
  {
    id: "oak-tree-1",
    name: "Oak Tree",
    type: "resource",
    position: [5, 0, 1],
    distance: 5.1,
    resourceType: "woodcutting",
  },
];

const gameState: EmbeddedGameState = {
  playerId: "live-contract-agent",
  position: [0, 0, 0],
  health: 10,
  maxHealth: 10,
  alive: true,
  skills: { attack: { level: 1, xp: 0 } },
  inventory: [],
  equipment: {},
  nearbyEntities: nearby,
  inCombat: false,
  currentTarget: null,
  activePrayers: [],
};

function createInstance(): AgentInstance {
  return {
    config: {
      characterId: "live-contract-agent",
      accountId: "live-contract-account",
      name: "Live Contract Agent",
    },
    service: {
      getGameState: () => gameState,
      getNearbyEntities: () => nearby,
      getInventoryItems: () => [],
      getQuestState: () => [],
      getAvailableQuests: () => [],
      getWorldMap: () => ({ stations: [] }),
    },
    goal: null,
    recentLlmActions: [],
    recentActionLog: [],
    memories: [],
    questCompleteFailures: new Map(),
  } as unknown as AgentInstance;
}

async function callOpenAi(prompt: string): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 400,
      temperature: 0.4,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(
      `OpenAI live contract check failed with ${response.status}`,
    );
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("OpenAI live contract check returned no text content");
  }
  return content;
}

describeLive("ordinary agent live provider contract", () => {
  it("accepts the current production prompt as one bounded legal action", async () => {
    const instance = createInstance();
    const prompt = buildBehaviorDecisionPrompt(instance, gameState);
    const response = await callOpenAi(prompt);
    const result = parseLlmBehaviorResponse(response, instance);

    expect(result).not.toBeNull();
    expect(result?.action.type).toBeTypeOf("string");
  }, 45_000);
});
