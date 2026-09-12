import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { BuildingGenerator } from "./BuildingGenerator";
import { geometryCache } from "./geometry";

describe("private building generator teardown", () => {
  it("preserves actual shared cached templates when a private lease ends; default disposal still clears them", () => {
    const first = new BuildingGenerator();
    const second = new BuildingGenerator();
    const key = "lifecycle-owned-template";
    const template = new THREE.BoxGeometry(0.123, 0.456, 0.789);
    let disposed = 0;
    template.addEventListener("dispose", () => disposed++);
    const originalClone = geometryCache.getOrCreate(key, () => template);
    const before = BuildingGenerator.getOptimizationStats();
    try {
      first.dispose({ clearGeometryCache: false });
      expect(disposed).toBe(0);
      expect(BuildingGenerator.getOptimizationStats()).toEqual(before);
      // An actual second owner gets a detached clone from the original cache.
      const borrowed = geometryCache.getOrCreate(key, () => {
        throw new Error("cache was unexpectedly cleared");
      });
      expect(borrowed).not.toBe(template);
      expect(borrowed.getAttribute("position").array).toEqual(
        originalClone.getAttribute("position").array,
      );
      borrowed.dispose();
      second.dispose();
      expect(disposed).toBe(1);
      expect(BuildingGenerator.getOptimizationStats().geometryCacheCount).toBe(
        0,
      );
    } finally {
      originalClone.dispose();
      geometryCache.clear();
    }
  });
});
