import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

describe("shipped model-call inventory", () => {
  it("requires every direct call site to remain explicitly reviewed", () => {
    const actual: Record<string, number> = {};
    for (const file of listProductionTypeScriptFiles(SRC_ROOT)) {
      const source = readFileSync(file, "utf8");
      const count =
        source.match(/\b(?:this\.)?runtime\.useModel\s*\(/gu)?.length ?? 0;
      if (count > 0) {
        actual[relative(SRC_ROOT, file)] = count;
        expect(source, relative(SRC_ROOT, file)).toContain(
          "formatUntrustedPromptData",
        );
      }
    }

    expect(actual).toEqual({
      "actions/goals.ts": 1,
      "actions/social.ts": 1,
      "managers/autonomous-behavior-manager.ts": 4,
      // Operator classification plus the bounded, pre-market duel strategy.
      "services/HyperiaService.ts": 2,
      "utils/ai-helpers.ts": 1,
    });
  });

  it("keeps authority-bearing responses exact and public model chat gated", () => {
    const manager = readFileSync(
      resolve(SRC_ROOT, "managers/autonomous-behavior-manager.ts"),
      "utf8",
    );
    const goals = readFileSync(resolve(SRC_ROOT, "actions/goals.ts"), "utf8");
    const service = readFileSync(
      resolve(SRC_ROOT, "services/HyperiaService.ts"),
      "utf8",
    );
    const social = readFileSync(resolve(SRC_ROOT, "actions/social.ts"), "utf8");

    expect(manager).toContain("parseAutonomousActionDecision");
    expect(manager).toContain("parseDuelCombatPlanResponse");
    expect(manager).toContain("isDevelopmentPublicModelChatEnabled");
    expect(manager).not.toContain("text.match(/\\{[\\s\\S]*\\}/)");
    expect(manager).not.toContain("upperResponse.includes(action.name)");
    expect(goals).toContain("parseExactAllowedToken");
    expect(goals).not.toContain("g.id.includes(selectedGoalId)");
    expect(service).toContain("parseExactAllowedToken");
    expect(service).toContain("isAuthorizedOperatorChat");
    expect(service).toContain("HYPERIA_OPERATOR_CHAT_ENTITY_ID");
    expect(social).toContain("isDevelopmentPublicModelChatEnabled");
  });
});
