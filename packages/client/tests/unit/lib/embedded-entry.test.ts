import { describe, expect, it } from "vitest";
import {
  buildEmbeddedConfig,
  embeddedParamSchema,
  getEmbeddedSurface,
} from "../../../src/lib/embedded-entry";
import { validateURLParams } from "../../../src/utils/InputValidator";

describe("embedded entry configuration", () => {
  it("defaults embedded sessions to the passive viewport when no surface is provided", () => {
    const config = buildEmbeddedConfig(
      {
        agentId: "agent-1",
        mode: "spectator",
      },
      { wsUrl: "ws://localhost:5556/ws" },
    );

    expect(config.mode).toBe("spectator");
    expect(getEmbeddedSurface(config)).toBe("viewport");
    expect(config.quality).toBe("low");
    expect(config.wsUrl).toBe("ws://localhost:5556/ws");
  });

  it("preserves the agent-control surface and validated hidden ui values", () => {
    const config = buildEmbeddedConfig(
      {
        agentId: "agent-2",
        mode: "spectator",
        surface: "agent-control",
        hiddenUI: "chat,inventory,invalid,stats",
        quality: "medium",
        characterId: "char-2",
      },
      { wsUrl: "wss://hyperia.gg/ws" },
    );

    expect(getEmbeddedSurface(config)).toBe("agent-control");
    expect(config.hiddenUI).toEqual(["chat", "inventory", "stats"]);
    expect(config.characterId).toBe("char-2");
    expect(config.quality).toBe("medium");
  });

  it("normalizes the legacy streaming alias to the passive spectator viewport", () => {
    const validation = validateURLParams(
      new URLSearchParams("embedded=true&mode=streaming"),
      embeddedParamSchema,
    );
    const config = buildEmbeddedConfig(validation.params, {
      wsUrl: "ws://localhost:5556/ws",
    });

    expect(validation.isValid).toBe(true);
    expect(validation.errors).toEqual({});
    expect(config.mode).toBe("spectator");
    expect(config.surface).toBe("viewport");
    expect(config.quality).toBe("low");
  });

  it("keeps arbitrary embedded modes invalid and falls back to passive viewing", () => {
    const validation = validateURLParams(
      new URLSearchParams("embedded=true&mode=operator"),
      embeddedParamSchema,
    );
    const config = buildEmbeddedConfig(validation.params, {
      wsUrl: "ws://localhost:5556/ws",
    });

    expect(validation.isValid).toBe(false);
    expect(validation.errors.mode).toContain("spectator, streaming, free");
    expect(config.mode).toBe("spectator");
    expect(config.surface).toBe("viewport");
  });
});
