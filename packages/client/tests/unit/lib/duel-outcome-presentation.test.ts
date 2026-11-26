import { describe, expect, it } from "vitest";
import {
  formatDuelReason,
  formatTerminalMatchup,
  getCancellationPresentation,
  isDuelTerminalNotice,
  type DuelTerminalNotice,
} from "../../../src/lib/duel-outcome-presentation";

const notice: DuelTerminalNotice = {
  cycleId: "cycle-7",
  duelId: "duel-7",
  outcome: "cancelled",
  reason: "agent_disconnect",
  occurredAt: 1_000,
  expiresAt: 11_000,
  agent1Id: "agent-a",
  agent1Name: "Riven Ash",
  agent2Id: "agent-b",
  agent2Name: "Astra Vale",
};

describe("duel outcome presentation", () => {
  it("strictly accepts cancellation notices", () => {
    expect(isDuelTerminalNotice(notice)).toBe(true);
    expect(isDuelTerminalNotice({ ...notice, outcome: "win" })).toBe(false);
    expect(isDuelTerminalNotice({ ...notice, occurredAt: "now" })).toBe(false);
  });

  it("uses contestant names without exposing identifiers", () => {
    expect(formatTerminalMatchup(notice)).toBe("Riven Ash vs Astra Vale");
    expect(formatTerminalMatchup({ ...notice, agent2Name: null })).toBe(
      "Round cancelled",
    );
  });

  it("maps internal cancellation families to viewer-safe copy", () => {
    const disconnected = getCancellationPresentation("agent_disconnect");
    expect(disconnected.title).toBe("No contest");
    expect(disconnected.sub).toContain("contestant became unavailable");
    expect(disconnected.sub).toContain("No winner was declared");
    expect(disconnected.sub).not.toContain("agent_disconnect");
  });

  it("preserves tailored copy for server-redacted public categories", () => {
    expect(
      getCancellationPresentation("insufficient_verified_combat").sub,
    ).toContain("without enough verified combat");
    expect(getCancellationPresentation("contestant_unavailable").sub).toContain(
      "contestant became unavailable",
    );
    expect(getCancellationPresentation("broadcast_interrupted").sub).toContain(
      "broadcast ended",
    );
  });

  it("formats administrative result reasons for scanning", () => {
    expect(formatDuelReason("hp_advantage")).toBe("Hp Advantage");
    expect(formatDuelReason(null)).toBe("Result unavailable");
  });
});
