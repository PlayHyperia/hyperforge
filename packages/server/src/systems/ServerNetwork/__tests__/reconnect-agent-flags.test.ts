import { describe, expect, it } from "vitest";
import { resolveReconnectAgentFlags } from "../reconnect-agent-flags.js";

describe("resolveReconnectAgentFlags", () => {
  it("restores external-agent routing only from retained server entity state", () => {
    expect(resolveReconnectAgentFlags({ data: { isAgent: true } })).toEqual({
      isAgent: true,
      isEmbeddedAgent: false,
    });
    expect(resolveReconnectAgentFlags({ isAgent: 1 })).toEqual({
      isAgent: true,
      isEmbeddedAgent: false,
    });
  });

  it("treats every embedded agent as an agent and defaults unknown entities closed", () => {
    expect(
      resolveReconnectAgentFlags({ data: { isEmbeddedAgent: true } }),
    ).toEqual({
      isAgent: true,
      isEmbeddedAgent: true,
    });
    expect(resolveReconnectAgentFlags(null)).toEqual({
      isAgent: false,
      isEmbeddedAgent: false,
    });
    expect(resolveReconnectAgentFlags({ data: { isAgent: "true" } })).toEqual({
      isAgent: false,
      isEmbeddedAgent: false,
    });
  });
});
