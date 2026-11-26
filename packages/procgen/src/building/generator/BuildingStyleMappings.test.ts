import { describe, expect, it, vi } from "vitest";
import { getDoorFrameStyleForBuildingType } from "./DoorTrimGeometry";
import { getWindowStyleForBuildingType } from "./WindowGeometry";

describe("building style mappings", () => {
  it("uses the religious styles for chapels without falling back", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      expect(getWindowStyleForBuildingType("chapel")).toBe("leaded");
      expect(getDoorFrameStyleForBuildingType("chapel", true)).toBe("grand");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
