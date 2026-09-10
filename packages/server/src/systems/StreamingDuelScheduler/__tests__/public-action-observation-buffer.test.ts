import { describe, expect, it, vi } from "vitest";
import { STREAMING_DUEL_ACTION_OBSERVATION_LIMIT } from "@hyperforge/shared";
import { StreamingDuelActionObservationBuffer } from "../public-action-observation-buffer";

const action = (cycleId: string, tick: number) => ({
  tick,
  cycleId,
  duelId: `duel-${cycleId}`,
  actorId: "fighter-a",
  opponentId: "fighter-b",
  phase: "FIGHTING" as const,
  combatRole: "ranged" as const,
  tacticalMacro: "kite" as const,
  action: "movement" as const,
  outcome: "accepted" as const,
  value: "reposition" as const,
  amount: null,
});

describe("StreamingDuelActionObservationBuffer", () => {
  it("assigns a monotonic per-cycle sequence and retains an immutable bounded tail", () => {
    const clock = vi.fn(() => 1_725_000_000_000);
    const buffer = new StreamingDuelActionObservationBuffer(clock);
    buffer.reset("cycle-1");

    const retainedEmptySnapshot = buffer.getSnapshot("cycle-1");
    for (
      let index = 1;
      index <= STREAMING_DUEL_ACTION_OBSERVATION_LIMIT + 8;
      index += 1
    ) {
      clock.mockReturnValue(1_725_000_000_000 + index);
      expect(buffer.append(action("cycle-1", index))).not.toBeNull();
    }

    const snapshot = buffer.getSnapshot("cycle-1");
    expect(retainedEmptySnapshot).toEqual([]);
    expect(snapshot).toHaveLength(STREAMING_DUEL_ACTION_OBSERVATION_LIMIT);
    expect(snapshot[0]?.sequence).toBe(9);
    expect(snapshot.at(-1)?.sequence).toBe(
      STREAMING_DUEL_ACTION_OBSERVATION_LIMIT + 8,
    );
    expect(snapshot.at(-1)?.observedAt).toBe(
      1_725_000_000_000 + STREAMING_DUEL_ACTION_OBSERVATION_LIMIT + 8,
    );
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
  });

  it("rejects invalid/private observations without spending sequence or mutating history", () => {
    const buffer = new StreamingDuelActionObservationBuffer(
      () => 1_725_000_000_000,
    );
    buffer.reset("cycle-1");
    expect(buffer.append(action("cycle-1", 1))?.sequence).toBe(1);
    const retained = buffer.getSnapshot("cycle-1");

    expect(
      buffer.append({
        ...action("cycle-1", 2),
        reasoning: "private",
      } as never),
    ).toBeNull();
    expect(buffer.getSnapshot("cycle-1")).toBe(retained);
    expect(buffer.append(action("cycle-1", 3))?.sequence).toBe(2);
  });

  it("fails closed across cycle identity and resets sequence/history explicitly", () => {
    const buffer = new StreamingDuelActionObservationBuffer(
      () => 1_725_000_000_000,
    );
    buffer.reset("cycle-1");
    expect(buffer.append(action("cycle-1", 1))?.sequence).toBe(1);
    expect(buffer.append(action("cycle-2", 2))).toBeNull();
    expect(buffer.getSnapshot("cycle-2")).toEqual([]);

    buffer.reset("cycle-2");

    expect(buffer.getSnapshot("cycle-1")).toEqual([]);
    expect(buffer.getSnapshot("cycle-2")).toEqual([]);
    expect(buffer.append(action("cycle-2", 3))?.sequence).toBe(1);
  });

  it("hydrates an ordered durable tail and accepts only the exact next sequence", () => {
    let now = 1_725_000_000_000;
    const source = new StreamingDuelActionObservationBuffer(() => ++now);
    source.reset("cycle-1");
    const first = source.append(action("cycle-1", 1))!;
    const second = source.append(action("cycle-1", 2))!;
    const third = source.append(action("cycle-1", 3))!;

    const restored = new StreamingDuelActionObservationBuffer(() => ++now);
    expect(restored.hydrate("cycle-1", [first, second])).toBe(true);
    expect(restored.getSnapshot("cycle-1")).toEqual([first, second]);
    expect(restored.appendPersisted(third)?.sequence).toBe(3);

    expect(restored.appendPersisted(third)).toBeNull();
    expect(restored.hydrate("cycle-1", [second, first])).toBe(false);
    expect(restored.getSnapshot("cycle-1").at(-1)?.sequence).toBe(3);
  });
});
