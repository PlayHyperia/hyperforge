import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DataManager } from "../../../../data/DataManager";
import {
  canonicalWorldJson,
  WORLD_IDENTITY_MANIFESTS,
  WorldManifestIdentityBuilder,
} from "../../../../data/WorldContentIdentity";
import { WorldContentAdmission } from "../../../../runtime/WorldContentAdmission";
import type {
  CompactResourceGrovesManifest,
  WorldConfigManifest,
} from "../../../../types/world/world-types";
import { COMPACT_WORLD_TERRAIN_PROFILE } from "../WorldTerrainProfile";
import { validateCompactResourceGroves } from "../CompactResourceGroves";

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
type Layout = Mutable<CompactResourceGrovesManifest>;
function copy(): Layout {
  return JSON.parse(
    canonicalWorldJson(DataManager.getWorldConfig()!.compactResourceGroves),
  ) as Layout;
}
const profile = () => DataManager.getWorldTerrainProfile();

describe("strict compact resource grove admission", () => {
  it("admits the detached 16-tree v4 layout without mutating its deeply frozen source", () => {
    const original = DataManager.getWorldConfig()!.compactResourceGroves!;
    const result = validateCompactResourceGroves(original, profile(), 2)!;
    expect(result).toEqual(original);
    expect(result).not.toBe(original);
    expect(result.regions.flatMap((r) => r.anchors)).toHaveLength(16);
    expect(Object.isFrozen(original.regions[0].anchors[0].position)).toBe(true);
    expect(() =>
      Object.assign(original.regions[0].anchors[0].position, { x: 0 }),
    ).toThrow();
    expect(
      validateCompactResourceGroves(
        undefined,
        COMPACT_WORLD_TERRAIN_PROFILE,
        1,
      ),
    ).toBeUndefined();
    expect(() =>
      validateCompactResourceGroves(undefined, profile(), 2),
    ).toThrow("requires");
    expect(() => validateCompactResourceGroves(original, profile(), 1)).toThrow(
      "version/profile",
    );
    expect(() =>
      validateCompactResourceGroves(original, COMPACT_WORLD_TERRAIN_PROFILE, 2),
    ).toThrow("version/profile");
  });

  it.each([
    ["schema", (v: Layout) => Object.assign(v, { schemaVersion: 2 })],
    ["layout", (v: Layout) => Object.assign(v, { layoutId: "unknown" })],
    [
      "profile",
      (v: Layout) =>
        Object.assign(v, { terrainProfileId: "compact-duel-island-v3" }),
    ],
    ["extra layout field", (v: Layout) => Object.assign(v, { density: 100 })],
    ["missing region", (v: Layout) => v.regions.pop()],
    [
      "duplicate region",
      (v: Layout) => {
        v.regions[1].id = v.regions[0].id;
      },
    ],
    [
      "empty region",
      (v: Layout) => {
        v.regions[0].anchors = [];
      },
    ],
    [
      "reversed bounds",
      (v: Layout) => {
        v.regions[0].bounds.maxX = v.regions[0].bounds.minX;
      },
    ],
    [
      "outside core",
      (v: Layout) => {
        v.regions[0].bounds.minX = 249;
      },
    ],
    [
      "outside region",
      (v: Layout) => {
        v.regions[0].anchors[0].position.x = 249.5;
      },
    ],
    [
      "unsnapped",
      (v: Layout) => {
        v.regions[0].anchors[0].position.x += 0.1;
      },
    ],
    [
      "NaN height",
      (v: Layout) => {
        v.regions[0].anchors[0].position.y = NaN;
      },
    ],
    [
      "infinite coordinate",
      (v: Layout) => {
        v.regions[0].anchors[0].position.x = Infinity;
      },
    ],
    [
      "string coordinate",
      (v: Layout) =>
        Object.assign(v.regions[0].anchors[0].position, { x: "287.5" }),
    ],
    [
      "water height",
      (v: Layout) => {
        v.regions[0].anchors[0].position.y = 16;
      },
    ],
    [
      "arbitrary ID",
      (v: Layout) => {
        v.regions[0].anchors[0].id = "grove_arbitrary";
      },
    ],
    [
      "duplicate ID/anchor",
      (v: Layout) => {
        v.regions[0].anchors[1] = structuredClone(v.regions[0].anchors[0]);
      },
    ],
    [
      "instanceId bypass",
      (v: Layout) =>
        Object.assign(v.regions[0].anchors[0], { instanceId: "tree_1_1" }),
    ],
    [
      "extra species",
      (v: Layout) =>
        Object.assign(v.regions[0].anchors[0], { subType: "magic" }),
    ],
    [
      "zero scale",
      (v: Layout) => {
        v.regions[0].anchors[0].scale = 0;
      },
    ],
    [
      "changed scale",
      (v: Layout) => {
        v.regions[0].anchors[0].scale = 1.1;
      },
    ],
    [
      "NaN rotation",
      (v: Layout) => {
        v.regions[0].anchors[0].rotation = NaN;
      },
    ],
    [
      "negative rotation",
      (v: Layout) => {
        v.regions[0].anchors[0].rotation = -0.1;
      },
    ],
    [
      "wrapped rotation",
      (v: Layout) => {
        v.regions[0].anchors[0].rotation = Math.PI * 2;
      },
    ],
    [
      "aggregate cap",
      (v: Layout) => {
        const a = structuredClone(v.regions[2].anchors[0]);
        a.position.x += 1;
        a.id = `tree_${a.position.x.toFixed(0)}_${a.position.z.toFixed(0)}`;
        v.regions[2].anchors.push(a);
      },
    ],
  ] as const)("rejects %s", (_name, mutate) => {
    const value = copy();
    mutate(value);
    expect(() => validateCompactResourceGroves(value, profile(), 2)).toThrow();
    const config = structuredClone(
      DataManager.getWorldConfig()!,
    ) as WorldConfigManifest;
    config.compactResourceGroves = value;
    expect(() => DataManager.setWorldConfig(config)).toThrow();
  });

  it("rejects accessors and sparse input without executing them", () => {
    const value = copy();
    let calls = 0;
    Object.defineProperty(value.regions[0].anchors[0], "scale", {
      enumerable: true,
      get() {
        calls++;
        return 1;
      },
    });
    expect(() => validateCompactResourceGroves(value, profile(), 2)).toThrow(
      "accessors",
    );
    expect(calls).toBe(0);
    const sparse = copy();
    delete sparse.regions[0].anchors[0];
    expect(() => validateCompactResourceGroves(sparse, profile(), 2)).toThrow(
      "dense",
    );
  });

  it("hashes the complete actual collection and rejects stale/mutated content before world admission", async () => {
    const config = structuredClone(DataManager.getWorldConfig()!);
    const build = async (replacement: unknown) => {
      const builder = new WorldManifestIdentityBuilder();
      for (const name of WORLD_IDENTITY_MANIFESTS) {
        const value =
          name === "world-config.json"
            ? replacement
            : JSON.parse(
                readFileSync(
                  new URL(
                    `../../../../../../server/world/assets/manifests/${name}`,
                    import.meta.url,
                  ),
                  "utf8",
                ),
              );
        builder.record(name, value);
      }
      return builder.build(profile());
    };
    const current = await build(config);
    expect(current).toBe(DataManager.getWorldContentIdentity());
    const old = structuredClone(config);
    delete old.compactResourceGroves;
    old.version = 1;
    const oldIdentity = await build(old);
    expect(oldIdentity).not.toBe(current);
    const altered = structuredClone(config);
    Object.assign(altered.compactResourceGroves!.regions[0].anchors[0], {
      rotation: 0.123,
    });
    expect(
      validateCompactResourceGroves(
        altered.compactResourceGroves,
        profile(),
        2,
      ),
    ).toBeDefined();
    expect(await build(altered)).not.toBe(current);
    expect(() => DataManager.setWorldConfig(altered)).toThrow("fresh startup");
    const admission = new WorldContentAdmission(() =>
      DataManager.getWorldContentIdentity(),
    );
    admission.beginConnection();
    expect(admission.admitSnapshot(oldIdentity)).toBeNull();
    expect(admission.allowsPacket("resourceSnapshot")).toBe(false);
    expect(admission.rejected).toBe(true);
    const matching = new WorldContentAdmission(() => current);
    matching.beginConnection();
    expect(matching.admitSnapshot(current)).not.toBeNull();
  });
});
