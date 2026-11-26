import { describe, expect, it } from "vitest";
import {
  formatPhaseLabel,
  formatRelativeTime,
  formatWinDrawLoss,
  formatWinLoss,
  normalizeSearchTerm,
  toWinRatePercent,
} from "../../../src/lib/leaderboard-utils";

describe("leaderboard-utils", () => {
  describe("toWinRatePercent", () => {
    it("returns zero for empty records", () => {
      expect(toWinRatePercent(0, 0)).toBe(0);
    });

    it("calculates percentage from wins and losses", () => {
      expect(toWinRatePercent(7, 3)).toBe(70);
    });

    it("sanitizes invalid values", () => {
      expect(toWinRatePercent(Number.NaN, Number.POSITIVE_INFINITY)).toBe(0);
    });
  });

  describe("formatWinLoss", () => {
    it("formats wins-losses as integers", () => {
      expect(formatWinLoss(10.9, 4.2)).toBe("10-4");
    });

    it("guards negative values", () => {
      expect(formatWinLoss(-2, -5)).toBe("0-0");
    });
  });

  describe("formatWinDrawLoss", () => {
    it("keeps draws visible without folding them into wins or losses", () => {
      expect(formatWinDrawLoss(10, 3, 4)).toBe("10-3-4");
    });

    it("sanitizes invalid draw counts", () => {
      expect(formatWinDrawLoss(2, Number.NaN, 1)).toBe("2-0-1");
    });
  });

  describe("normalizeSearchTerm", () => {
    it("trims and lowercases", () => {
      expect(normalizeSearchTerm("  GPT-5 OpenAI  ")).toBe("gpt-5 openai");
    });
  });

  describe("formatRelativeTime", () => {
    const now = 1_700_000_000_000;

    it("formats seconds", () => {
      expect(formatRelativeTime(now - 42_000, now)).toBe("42s ago");
    });

    it("formats minutes", () => {
      expect(formatRelativeTime(now - 11 * 60_000, now)).toBe("11m ago");
    });

    it("formats hours", () => {
      expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe("3h ago");
    });

    it("formats days", () => {
      expect(formatRelativeTime(now - 4 * 24 * 60 * 60_000, now)).toBe(
        "4d ago",
      );
    });
  });

  describe("formatPhaseLabel", () => {
    it("normalizes known phases", () => {
      expect(formatPhaseLabel("FIGHTING")).toBe("Fighting");
      expect(formatPhaseLabel("COUNTDOWN")).toBe("Countdown");
    });

    it("falls back to idle for unknown values", () => {
      expect(formatPhaseLabel("something-else")).toBe("Idle");
    });
  });
});
