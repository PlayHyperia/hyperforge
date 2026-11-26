import { describe, it, expect, vi } from "vitest";
import { CycleStateMachine } from "../managers/CycleStateMachine.js";
import type { StreamingPhase } from "../types.js";

describe("CycleStateMachine", () => {
  describe("initial state", () => {
    it("starts in IDLE", () => {
      const sm = new CycleStateMachine();
      expect(sm.phase).toBe("IDLE");
    });

    it("isIn returns true for IDLE", () => {
      const sm = new CycleStateMachine();
      expect(sm.isIn("IDLE")).toBe(true);
      expect(sm.isIn("FIGHTING")).toBe(false);
    });
  });

  describe("valid transitions", () => {
    it("IDLE → ANNOUNCEMENT", () => {
      const sm = new CycleStateMachine();
      sm.transition("ANNOUNCEMENT");
      expect(sm.phase).toBe("ANNOUNCEMENT");
    });

    it("ANNOUNCEMENT → COUNTDOWN", () => {
      const sm = new CycleStateMachine();
      sm.transition("ANNOUNCEMENT");
      sm.transition("COUNTDOWN");
      expect(sm.phase).toBe("COUNTDOWN");
    });

    it("COUNTDOWN → FIGHTING", () => {
      const sm = new CycleStateMachine();
      sm.transition("ANNOUNCEMENT");
      sm.transition("COUNTDOWN");
      sm.transition("FIGHTING");
      expect(sm.phase).toBe("FIGHTING");
    });

    it("FIGHTING → RESOLUTION", () => {
      const sm = new CycleStateMachine();
      sm.transition("ANNOUNCEMENT");
      sm.transition("COUNTDOWN");
      sm.transition("FIGHTING");
      sm.transition("RESOLUTION");
      expect(sm.phase).toBe("RESOLUTION");
    });

    it("RESOLUTION → IDLE (full cycle)", () => {
      const sm = new CycleStateMachine();
      sm.transition("ANNOUNCEMENT");
      sm.transition("COUNTDOWN");
      sm.transition("FIGHTING");
      sm.transition("RESOLUTION");
      sm.forceIdle();
      expect(sm.phase).toBe("IDLE");
    });

    it("ANNOUNCEMENT → IDLE (abort)", () => {
      const sm = new CycleStateMachine();
      sm.transition("ANNOUNCEMENT");
      sm.transition("IDLE");
      expect(sm.phase).toBe("IDLE");
    });

    it("COUNTDOWN → IDLE (abort)", () => {
      const sm = new CycleStateMachine();
      sm.transition("ANNOUNCEMENT");
      sm.transition("COUNTDOWN");
      sm.transition("IDLE");
      expect(sm.phase).toBe("IDLE");
    });

    it("FIGHTING → IDLE (abort)", () => {
      const sm = new CycleStateMachine();
      sm.transition("ANNOUNCEMENT");
      sm.transition("COUNTDOWN");
      sm.transition("FIGHTING");
      sm.transition("IDLE");
      expect(sm.phase).toBe("IDLE");
    });
  });

  describe("illegal transitions", () => {
    it("IDLE → COUNTDOWN throws", () => {
      const sm = new CycleStateMachine();
      expect(() => sm.transition("COUNTDOWN")).toThrow("Illegal transition");
    });

    it("IDLE → FIGHTING throws", () => {
      const sm = new CycleStateMachine();
      expect(() => sm.transition("FIGHTING")).toThrow("Illegal transition");
    });

    it("IDLE → RESOLUTION throws", () => {
      const sm = new CycleStateMachine();
      expect(() => sm.transition("RESOLUTION")).toThrow("Illegal transition");
    });

    it("ANNOUNCEMENT → FIGHTING throws (must go through COUNTDOWN)", () => {
      const sm = new CycleStateMachine();
      sm.transition("ANNOUNCEMENT");
      expect(() => sm.transition("FIGHTING")).toThrow("Illegal transition");
    });

    it("ANNOUNCEMENT → RESOLUTION throws", () => {
      const sm = new CycleStateMachine();
      sm.transition("ANNOUNCEMENT");
      expect(() => sm.transition("RESOLUTION")).toThrow("Illegal transition");
    });

    it("COUNTDOWN → ANNOUNCEMENT throws", () => {
      const sm = new CycleStateMachine();
      sm.transition("ANNOUNCEMENT");
      sm.transition("COUNTDOWN");
      expect(() => sm.transition("ANNOUNCEMENT")).toThrow("Illegal transition");
    });

    it("COUNTDOWN → RESOLUTION is allowed for pre-fight resolution", () => {
      const sm = new CycleStateMachine();
      sm.transition("ANNOUNCEMENT");
      sm.transition("COUNTDOWN");
      sm.transition("RESOLUTION");
      expect(sm.phase).toBe("RESOLUTION");
    });

    it("FIGHTING → ANNOUNCEMENT throws", () => {
      const sm = new CycleStateMachine();
      sm.transition("ANNOUNCEMENT");
      sm.transition("COUNTDOWN");
      sm.transition("FIGHTING");
      expect(() => sm.transition("ANNOUNCEMENT")).toThrow("Illegal transition");
    });

    it("RESOLUTION → ANNOUNCEMENT throws (must go through IDLE)", () => {
      const sm = new CycleStateMachine();
      sm.transition("ANNOUNCEMENT");
      sm.transition("COUNTDOWN");
      sm.transition("FIGHTING");
      sm.transition("RESOLUTION");
      expect(() => sm.transition("ANNOUNCEMENT")).toThrow("Illegal transition");
    });
  });

  describe("self-transition is no-op", () => {
    it("IDLE → IDLE does nothing", () => {
      const sm = new CycleStateMachine();
      const listener = vi.fn();
      sm.onPhaseChange(listener);
      sm.transition("IDLE");
      expect(sm.phase).toBe("IDLE");
      expect(listener).not.toHaveBeenCalled();
    });

    it("FIGHTING → FIGHTING does nothing", () => {
      const sm = new CycleStateMachine();
      sm.transition("ANNOUNCEMENT");
      sm.transition("COUNTDOWN");
      sm.transition("FIGHTING");
      const listener = vi.fn();
      sm.onPhaseChange(listener);
      sm.transition("FIGHTING");
      expect(sm.phase).toBe("FIGHTING");
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("canTransition", () => {
    it("returns true for valid transitions", () => {
      const sm = new CycleStateMachine();
      expect(sm.canTransition("ANNOUNCEMENT")).toBe(true);
      expect(sm.canTransition("COUNTDOWN")).toBe(false);
    });

    it("returns false for self-transition", () => {
      const sm = new CycleStateMachine();
      expect(sm.canTransition("IDLE")).toBe(false);
    });

    it("returns false for illegal transitions", () => {
      const sm = new CycleStateMachine();
      expect(sm.canTransition("FIGHTING")).toBe(false);
      expect(sm.canTransition("RESOLUTION")).toBe(false);
    });
  });

  describe("forceIdle", () => {
    it("resets from any state to IDLE", () => {
      const phases: StreamingPhase[] = [
        "ANNOUNCEMENT",
        "COUNTDOWN",
        "FIGHTING",
        "RESOLUTION",
      ];

      for (const target of phases) {
        const sm = new CycleStateMachine();
        // Navigate to the target phase
        if (
          target === "ANNOUNCEMENT" ||
          target === "COUNTDOWN" ||
          target === "FIGHTING" ||
          target === "RESOLUTION"
        ) {
          sm.transition("ANNOUNCEMENT");
        }
        if (
          target === "COUNTDOWN" ||
          target === "FIGHTING" ||
          target === "RESOLUTION"
        ) {
          sm.transition("COUNTDOWN");
        }
        if (target === "FIGHTING" || target === "RESOLUTION") {
          sm.transition("FIGHTING");
        }
        if (target === "RESOLUTION") {
          sm.transition("RESOLUTION");
        }

        expect(sm.phase).toBe(target);
        sm.forceIdle();
        expect(sm.phase).toBe("IDLE");
      }
    });

    it("is no-op when already IDLE", () => {
      const sm = new CycleStateMachine();
      const listener = vi.fn();
      sm.onPhaseChange(listener);
      sm.forceIdle();
      expect(listener).not.toHaveBeenCalled();
    });

    it("fires listener on reset", () => {
      const sm = new CycleStateMachine();
      sm.transition("ANNOUNCEMENT");
      const listener = vi.fn();
      sm.onPhaseChange(listener);
      sm.forceIdle();
      expect(listener).toHaveBeenCalledWith("ANNOUNCEMENT", "IDLE");
    });
  });

  describe("listeners", () => {
    it("fires listener on transition", () => {
      const sm = new CycleStateMachine();
      const listener = vi.fn();
      sm.onPhaseChange(listener);

      sm.transition("ANNOUNCEMENT");
      expect(listener).toHaveBeenCalledWith("IDLE", "ANNOUNCEMENT");

      sm.transition("COUNTDOWN");
      expect(listener).toHaveBeenCalledWith("ANNOUNCEMENT", "COUNTDOWN");
    });

    it("fires multiple listeners", () => {
      const sm = new CycleStateMachine();
      const l1 = vi.fn();
      const l2 = vi.fn();
      sm.onPhaseChange(l1);
      sm.onPhaseChange(l2);

      sm.transition("ANNOUNCEMENT");
      expect(l1).toHaveBeenCalledTimes(1);
      expect(l2).toHaveBeenCalledTimes(1);
    });

    it("removeAllListeners stops notifications", () => {
      const sm = new CycleStateMachine();
      const listener = vi.fn();
      sm.onPhaseChange(listener);
      sm.removeAllListeners();

      sm.transition("ANNOUNCEMENT");
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("phaseStartTime", () => {
    it("updates on transition", () => {
      const sm = new CycleStateMachine();
      const before = Date.now();
      sm.transition("ANNOUNCEMENT");
      const after = Date.now();
      expect(sm.phaseStartTime).toBeGreaterThanOrEqual(before);
      expect(sm.phaseStartTime).toBeLessThanOrEqual(after);
    });
  });

  describe("phaseElapsed", () => {
    it("returns 0 before first transition", () => {
      const sm = new CycleStateMachine();
      expect(sm.phaseElapsed()).toBe(0);
    });

    it("returns positive value after transition", async () => {
      const sm = new CycleStateMachine();
      sm.transition("ANNOUNCEMENT");
      // Small delay to ensure non-zero
      await new Promise((r) => setTimeout(r, 5));
      expect(sm.phaseElapsed()).toBeGreaterThan(0);
    });
  });

  describe("full cycle simulation", () => {
    it("runs multiple cycles without error", () => {
      const sm = new CycleStateMachine();

      for (let i = 0; i < 10; i++) {
        sm.transition("ANNOUNCEMENT");
        sm.transition("COUNTDOWN");
        sm.transition("FIGHTING");
        sm.transition("RESOLUTION");
        sm.forceIdle();
      }

      expect(sm.phase).toBe("IDLE");
    });

    it("preserves the legal graph across seeded randomized transitions", () => {
      const phases: readonly StreamingPhase[] = [
        "IDLE",
        "ANNOUNCEMENT",
        "COUNTDOWN",
        "FIGHTING",
        "RESOLUTION",
      ];
      const allowed: Record<StreamingPhase, readonly StreamingPhase[]> = {
        IDLE: ["ANNOUNCEMENT"],
        ANNOUNCEMENT: ["COUNTDOWN", "IDLE"],
        COUNTDOWN: ["FIGHTING", "RESOLUTION", "IDLE"],
        FIGHTING: ["RESOLUTION", "IDLE"],
        RESOLUTION: ["IDLE"],
      };
      let randomState = 0xc1c1e5ed;
      const nextRandom = (): number => {
        randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
        return randomState / 0x1_0000_0000;
      };

      for (let run = 0; run < 128; run += 1) {
        const sm = new CycleStateMachine();
        let acceptedResolutionTransitions = 0;
        let observedResolutionTransitions = 0;
        sm.onPhaseChange((_from, to) => {
          if (to === "RESOLUTION") {
            observedResolutionTransitions += 1;
          }
        });

        for (let step = 0; step < 80; step += 1) {
          if (nextRandom() < 0.1) {
            sm.forceIdle();
            continue;
          }

          const from = sm.phase;
          const to = phases[Math.floor(nextRandom() * phases.length)];
          const isSelfTransition = from === to;
          const isAllowed = allowed[from].includes(to);
          expect(sm.canTransition(to)).toBe(!isSelfTransition && isAllowed);

          if (isSelfTransition) {
            sm.transition(to);
            expect(sm.phase).toBe(from);
          } else if (isAllowed) {
            sm.transition(to);
            expect(sm.phase).toBe(to);
            if (to === "RESOLUTION") {
              acceptedResolutionTransitions += 1;
            }
          } else {
            expect(() => sm.transition(to)).toThrow("Illegal transition");
            expect(sm.phase).toBe(from);
          }

          expect(observedResolutionTransitions).toBe(
            acceptedResolutionTransitions,
          );
        }
      }
    });
  });
});
