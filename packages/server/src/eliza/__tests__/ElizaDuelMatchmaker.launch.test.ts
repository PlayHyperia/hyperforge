import { describe, expect, it } from "vitest";

import { ElizaDuelMatchmaker } from "../ElizaDuelMatchmaker";

describe("ElizaDuelMatchmaker launch prerequisites", () => {
  it("fails before start instead of reporting a zero-agent matchmaker ready", () => {
    expect(
      () =>
        new ElizaDuelMatchmaker({
          wsUrl: "ws://localhost:5556/ws",
          botCount: 2,
          modelConfigs: [],
        }),
    ).toThrow("requires at least 2 configured model agents; found 0");
  });
});
