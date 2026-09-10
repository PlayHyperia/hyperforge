import { describe, expect, it } from "vitest";
import {
  canonicalWorldJson,
  WORLD_IDENTITY_MANIFESTS,
  WORLD_IDENTITY_MAX_BYTES,
  WorldManifestIdentityBuilder,
} from "../WorldContentIdentity";
import { COMPACT_WORLD_TERRAIN_PROFILE } from "../../systems/shared/world/WorldTerrainProfile";

function completeBuilder(
  reverse = false,
  changedName?: string,
): WorldManifestIdentityBuilder {
  const builder = new WorldManifestIdentityBuilder();
  const names = [...WORLD_IDENTITY_MANIFESTS];
  if (reverse) names.reverse();
  for (const name of names)
    builder.record(
      name,
      name === "world-config.json"
        ? { terrainProfile: COMPACT_WORLD_TERRAIN_PROFILE }
        : { value: name === changedName ? 2 : 1 },
    );
  return builder;
}

describe("canonical world JSON", () => {
  it("is deterministic with sorted object keys, ordered arrays, Unicode and finite numbers", () => {
    expect(
      canonicalWorldJson({ b: ["é", -0, true, null], a: { z: 2, x: 1 } }),
    ).toBe('{"a":{"x":1,"z":2},"b":["é",0,true,null]}');
    expect(canonicalWorldJson({ b: 2, a: 1 })).toBe(
      canonicalWorldJson({ a: 1, b: 2 }),
    );
    expect(canonicalWorldJson([1, 2])).not.toBe(canonicalWorldJson([2, 1]));
  });

  it("never invokes object, array or toJSON accessors", () => {
    let calls = 0;
    const get = () => {
      calls++;
      return 1;
    };
    for (const value of [
      Object.defineProperty({}, "x", { enumerable: true, get }),
      Object.defineProperty([1], "0", { enumerable: true, get }),
      Object.defineProperty({}, "toJSON", { enumerable: true, get }),
    ]) {
      expect(() => canonicalWorldJson(value)).toThrow();
    }
    expect(calls).toBe(0);
  });

  it("rejects sparse arrays, extra keys, hidden indices, symbols and custom prototypes", () => {
    const holeWithSymbol = new Array(1);
    Object.defineProperty(holeWithSymbol, Symbol("extra"), { value: 1 });
    for (const value of [
      new Array(2),
      Object.assign([1], { extra: 1 }),
      Object.defineProperty([1], "0", { enumerable: false }),
      { [Symbol("x")]: 1 },
      holeWithSymbol,
      Object.create({ x: 1 }),
      Object.defineProperty({}, "hidden", { value: 1 }),
      new Date(),
    ]) {
      expect(() => canonicalWorldJson(value)).toThrow();
    }
  });

  it("rejects non-JSON values, cycles, oversized depth, nodes and bytes", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [
      undefined,
      NaN,
      Infinity,
      1n,
      () => 1,
      { x: undefined },
      cycle,
      new Array(200_001).fill(0),
      "x".repeat(WORLD_IDENTITY_MAX_BYTES),
    ]) {
      expect(() => canonicalWorldJson(value)).toThrow();
    }
  });
});

describe("WorldManifestIdentityBuilder", () => {
  it("hashes all required content deterministically independent of load order", async () => {
    const identity = await completeBuilder().build(
      COMPACT_WORLD_TERRAIN_PROFILE,
    );
    expect(identity).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await completeBuilder(true).build(COMPACT_WORLD_TERRAIN_PROFILE),
    ).toBe(identity);
    expect(
      await completeBuilder(false, "gathering/woodcutting.json").build(
        COMPACT_WORLD_TERRAIN_PROFILE,
      ),
    ).not.toBe(identity);
    expect(
      await completeBuilder(false, "buildings.json").build(
        COMPACT_WORLD_TERRAIN_PROFILE,
      ),
    ).not.toBe(identity);
  });

  it("requires every manifest, including an explicit buildings absence marker", async () => {
    for (const missing of WORLD_IDENTITY_MANIFESTS) {
      const builder = new WorldManifestIdentityBuilder();
      for (const name of WORLD_IDENTITY_MANIFESTS)
        if (name !== missing) builder.record(name, null);
      await expect(
        builder.build(COMPACT_WORLD_TERRAIN_PROFILE),
      ).rejects.toThrow(missing);
    }
  });

  it("rejects profile mismatch, unknown names and changed duplicate content", async () => {
    const builder = completeBuilder();
    expect(() => builder.record("unknown.json", {})).toThrow("Unsupported");
    expect(() => builder.record("npcs.json", { value: 2 })).toThrow("changed");
    builder.record("npcs.json", { value: 1 });
    await expect(
      builder.build({ ...COMPACT_WORLD_TERRAIN_PROFILE, seed: 12 }),
    ).rejects.toThrow("differs");
  });

  it("caps the combined UTF-8 payload, not just each manifest; duplicate records cost nothing", () => {
    const builder = new WorldManifestIdentityBuilder();
    const half = "é".repeat(Math.floor(WORLD_IDENTITY_MAX_BYTES / 4));
    builder.record("npcs.json", half);
    builder.record("npcs.json", half);
    expect(() => builder.record("biomes.json", half)).toThrow("Combined");
  });
});
