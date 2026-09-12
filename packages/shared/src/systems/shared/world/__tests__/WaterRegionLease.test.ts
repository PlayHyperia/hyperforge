import { describe, expect, it } from "vitest";
import { WaterBodyRegistry } from "../WaterBodyRegistry";

const bounds = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
const body = (id: string, centerX = 5, radius = 2) => ({
  id,
  centerX,
  centerZ: 5,
  radius,
  radiusSq: radius * radius,
  surfaceY: 20,
  sourceType: "explicit" as const,
});

describe("actual water-registry ownership of suspended grass work", () => {
  it("captures bounds by value and admits unrelated changes without hiding local arrivals", () => {
    const water = new WaterBodyRegistry(16),
      query = { ...bounds };
    water.register(body("pond"));
    const lease = water.captureRegion(query);
    query.minX = 1000;
    water.register(body("distant", 100));
    water.getAllBodies()[1].surfaceY++;
    expect(lease.isCurrent()).toBe(true);
    water.register(body("arrived", 12)); // Closed boundary contact counts.
    expect(lease.isCurrent()).toBe(false);
  });

  it.each([
    "id",
    "centerX",
    "centerZ",
    "radius",
    "radiusSq",
    "surfaceY",
    "sourceType",
  ] as const)(
    "invalidates direct %s changes, even if restored after observation",
    (key) => {
      const water = new WaterBodyRegistry(16);
      water.register(body("pond"));
      const lease = water.captureRegion(bounds),
        current = water.getAllBodies()[0],
        original = { ...current };
      if (key === "id") current.id = "changed";
      else if (key === "sourceType") current.sourceType = "landscape_pond";
      else current[key]++;
      expect(lease.isCurrent()).toBe(false);
      Object.assign(current, original);
      expect(lease.isCurrent()).toBe(false);
    },
  );

  it("detects moved-in and moved-out bodies and the declared bank margin", () => {
    const water = new WaterBodyRegistry(16);
    water.register(body("far", 14));
    const exact = water.captureRegion(bounds),
      padded = water.captureRegion(bounds, 2);
    water.getAllBodies()[0].surfaceY++;
    expect(exact.isCurrent()).toBe(true);
    expect(padded.isCurrent()).toBe(false);
    water.getAllBodies()[0].centerX = 11;
    expect(exact.isCurrent()).toBe(false);
    const present = water.captureRegion(bounds);
    water.getAllBodies()[0].centerX = 100;
    expect(present.isCurrent()).toBe(false);
    expect(water.captureRegion(bounds).isCurrent()).toBe(true);
  });

  it("fails closed on invalid queries, malformed bodies, and registry capacity", () => {
    const water = new WaterBodyRegistry(16);
    for (const padding of [-1, 33, NaN, Infinity])
      expect(() => water.captureRegion(bounds, padding)).toThrow();
    expect(() => water.captureRegion({ ...bounds, minX: 11 })).toThrow();
    water.register(body("pond"));
    const lease = water.captureRegion(bounds);
    water.getAllBodies()[0].radiusSq++;
    expect(lease.isCurrent()).toBe(false);
    expect(() => water.captureRegion(bounds)).toThrow();
    const bounded = new WaterBodyRegistry(16);
    for (let i = 0; i < 128; i++) bounded.register(body(`pond${i}`, 100));
    const full = bounded.captureRegion(bounds);
    expect(full.isCurrent()).toBe(true);
    bounded.register(body("overflow", 100));
    expect(full.isCurrent()).toBe(false);
    expect(() => bounded.captureRegion(bounds)).toThrow();
  });
});
