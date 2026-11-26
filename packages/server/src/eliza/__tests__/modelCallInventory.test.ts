import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function listProductionTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") {
        files.push(...listProductionTypeScriptFiles(path));
      }
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("server model-call inventory", () => {
  it("requires each shipped direct call site to remain explicitly reviewed", () => {
    const actual: Record<string, number> = {};
    for (const file of listProductionTypeScriptFiles(SRC_ROOT)) {
      const source = readFileSync(file, "utf8");
      const count =
        source.match(/\b(?:this\.)?runtime!?\.useModel\s*\(/gu)?.length ?? 0;
      if (count > 0) {
        const name = relative(SRC_ROOT, file);
        actual[name] = count;
        expect(source, name).toContain("formatUntrustedPromptData");
      }
      expect(source, relative(SRC_ROOT, file)).not.toContain(
        ".match(/\\{[\\s\\S]*\\}/)",
      );
    }

    expect(actual).toEqual({
      "duel/DuelCombatAI.ts": 1,
      "eliza/AgentManager.ts": 3,
      "eliza/ModelAgentSpawner.ts": 1,
      "eliza/duelPreparationStrategy.ts": 1,
      "eliza/llmBehaviorDecision.ts": 1,
    });
  });

  it("keeps authority-bearing outputs strict and public model chat gated", () => {
    const read = (name: string) =>
      readFileSync(resolve(SRC_ROOT, name), "utf8");
    expect(read("duel/DuelCombatAI.ts")).toContain(
      "parseCombatStrategyResponse",
    );
    expect(read("duel/DuelCombatAI.ts")).not.toContain(
      "maybeReplanStrategyBackground",
    );
    expect(read("duel/DuelCombatAI.ts")).toContain("DUEL_LLM_CHAT_ENABLED");
    expect(read("eliza/AgentManager.ts")).toContain(
      "parseAgentCharacterVisionResponse",
    );
    expect(read("eliza/duelPreparationStrategy.ts")).toContain(
      "parseDuelPreparationRoleResponse",
    );
    expect(read("eliza/ModelAgentSpawner.ts")).toContain(
      "parsePreparationBehaviorPlanResponse",
    );
  });
});
