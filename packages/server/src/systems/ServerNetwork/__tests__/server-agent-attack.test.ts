import { describe, expect, it } from "vitest";

import {
  classifyRedundantAttackRequest,
  isDuelAiMovementOwned,
} from "../index";

describe("ServerNetwork server-agent attack requests", () => {
  it("classifies a same-target active combat request as redundant", () => {
    expect(
      classifyRedundantAttackRequest(
        "fighter-b",
        "player",
        {
          inCombat: true,
          targetId: "fighter-b",
          targetType: "player",
        },
        null,
      ),
    ).toBe("active_same_target");
  });

  it("classifies a same-target pending combat request as redundant", () => {
    expect(
      classifyRedundantAttackRequest("fighter-b", "player", null, "fighter-b"),
    ).toBe("pending_same_target");
  });

  it("does not suppress a target switch or a target-type change", () => {
    expect(
      classifyRedundantAttackRequest(
        "fighter-c",
        "player",
        {
          inCombat: true,
          targetId: "fighter-b",
          targetType: "player",
        },
        "fighter-b",
      ),
    ).toBeNull();
    expect(
      classifyRedundantAttackRequest(
        "fighter-b",
        "mob",
        {
          inCombat: true,
          targetId: "fighter-b",
          targetType: "player",
        },
        null,
      ),
    ).toBeNull();
  });

  it("recognizes only explicit active duel-AI movement ownership", () => {
    expect(isDuelAiMovementOwned({ duelAiControlsMovement: true })).toBe(true);
    expect(isDuelAiMovementOwned({ duelAiControlsMovement: false })).toBe(
      false,
    );
    expect(isDuelAiMovementOwned({ inStreamingDuel: true })).toBe(false);
    expect(isDuelAiMovementOwned(null)).toBe(false);
  });
});
