import { describe, expect, it } from "vitest";

import type { FlatZone } from "../../../types/world/terrain";
import {
  resolveRadialPondTerrainHeight,
  validateRadialPondTerrainProfile,
} from "./RadialPondTerrainProfile";

const zone: FlatZone = {
  id: "pond",
  centerX: 10,
  centerZ: -5,
  width: 20,
  depth: 20,
  height: 26.6,
  blendRadius: 2,
  radialPond: {
    bedRadius: 5,
    bankInnerRadius: 7,
    bankOuterRadius: 8,
    bankHeight: 28.4,
  },
};

describe("radial pond terrain profile", () => {
  it("creates a level bed, smooth shore, level bank, and smooth outer blend", () => {
    expect(validateRadialPondTerrainProfile(zone)).toBeNull();
    expect(resolveRadialPondTerrainHeight(zone, 10, -5, () => 30)).toBe(26.6);
    expect(resolveRadialPondTerrainHeight(zone, 16, -5, () => 30)).toBe(27.5);
    expect(resolveRadialPondTerrainHeight(zone, 17.5, -5, () => 30)).toBe(28.4);
    expect(resolveRadialPondTerrainHeight(zone, 19, -5, () => 30)).toBe(29.2);
    expect(resolveRadialPondTerrainHeight(zone, 20, -5, () => 30)).toBeNull();
  });

  it("rejects profiles whose index bounds cannot contain their full blend", () => {
    expect(
      validateRadialPondTerrainProfile({ ...zone, width: 19.9 }),
    ).toContain("at least 20m");
  });
});
