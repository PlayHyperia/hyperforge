import { describe, expect, it } from "vitest";
import { isAuthorizedOperatorChat } from "../services/HyperiaService.js";

describe("in-world operator chat authority", () => {
  it("fails closed unless the server sender exactly matches configured identity", () => {
    expect(isAuthorizedOperatorChat("player-1", undefined)).toBe(false);
    expect(isAuthorizedOperatorChat("player-1", "")).toBe(false);
    expect(isAuthorizedOperatorChat("player-1", "player-2")).toBe(false);
    expect(isAuthorizedOperatorChat("PLAYER-1", "player-1")).toBe(false);
    expect(isAuthorizedOperatorChat("player-1", " player-1 ")).toBe(true);
  });
});
