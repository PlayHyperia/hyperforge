import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import {
  WORLD_IDENTITY_MANIFESTS,
  WorldManifestIdentityBuilder,
} from "../../../../data/WorldContentIdentity";
import { WorldContentAdmission } from "../../../../runtime/WorldContentAdmission";
import { DataManager } from "../../../../data/DataManager";
import { NoiseGenerator } from "../../../../utils/NoiseGenerator";
import {
  createTerrainWorkerConfig,
  buildTerrainWorkerProfileGuardJS,
} from "../../../../utils/workers/TerrainWorkerShared";
import { createCompactIslandLandform } from "../CompactIslandLandform";
import { COMPACT_PREPARATION_LODGE_V5_FIXTURE } from "../CompactPreparationLodge";
import {
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE as current,
  SCULPTED_COMPACT_V4_PROFILE_FIXTURE as previous,
  COMPACT_RIDGE_BREAKUP_PARAMETERS,
  validateWorldTerrainProfile,
  worldTerrainProfileIdentity,
} from "../WorldTerrainProfile";

const landform = createCompactIslandLandform(),
  noise = new NoiseGenerator(0);
const smooth = (v: number) => {
  const t = Math.max(0, Math.min(1, v));
  return t * t * (3 - 2 * t);
};
const at = (x: number, z: number, profile = current) =>
  landform.height(x, z, noise, profile);
const spine = (z: number) =>
  268 - 30 * Math.sin(Math.PI * Math.max(0, Math.min(1, (z - 335) / 140)));
const guard = runInNewContext(
  buildTerrainWorkerProfileGuardJS() + "\nassertTerrainWorkerInput;",
) as (input: unknown) => void;
function request(profile: typeof current) {
  return {
    seed: profile.seed,
    type: "generateHeightmap",
    config: createTerrainWorkerConfig(profile, 64),
  };
}

describe("shared broken-ridge sculpt", () => {
  it("hashes the actual complete v6 content and rejects the previously shipped v5 content before packets", async () => {
    const config = structuredClone(DataManager.getWorldConfig()!);
    const old = structuredClone(config);
    // This architecture did not exist in the retained v5 world content.
    delete old.compactServiceCourt;
    delete old.compactServicePlanting;
    old.terrainProfile = previous;
    old.compactResourceGroves = {
      ...old.compactResourceGroves!,
      terrainProfileId: previous.id,
    };
    old.compactPreparationLodge = structuredClone(
      COMPACT_PREPARATION_LODGE_V5_FIXTURE,
    );
    const identity = async (replacement: typeof config) => {
      const builder = new WorldManifestIdentityBuilder();
      for (const name of WORLD_IDENTITY_MANIFESTS) {
        const manifest =
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
        // Reconstruct the actual historical floors, not current courts
        // relabelled as the previously shipped v5 content.
        if (replacement === old && name === "duel-arenas.json") {
          manifest.lobby.size = { width: 40, depth: 25 };
          manifest.hospital.size = { width: 28, depth: 23 };
        }
        builder.record(name, manifest);
      }
      return builder.build(replacement.terrainProfile!);
    };
    const before = await identity(old),
      after = await identity(config);
    expect(before).toBe(
      "198859e9e703e4a1cfd8d09b341d1fb70177a73e894dfcf149c2a529c9cba87f",
    );
    expect(after).toBe(DataManager.getWorldContentIdentity());
    expect(after).not.toBe(before);
    const admission = new WorldContentAdmission(() => after);
    admission.beginConnection();
    expect(admission.admitSnapshot(before)).toBeNull();
    expect(admission.rejected).toBe(true);
    expect(admission.allowsPacket("resourceSnapshot")).toBe(false);
    admission.beginConnection();
    expect(admission.admitSnapshot(after)).not.toBeNull();
    expect(admission.allowsPacket("resourceSnapshot")).toBe(true);
    process.stdout.write(
      "Broken ridge full content migration: " +
        JSON.stringify({ before, after }) +
        "\n",
    );
  });
  it("selects a complete v6 world without changing existing service or grove geometry", () => {
    expect(DataManager.getWorldTerrainProfile()).toEqual(current);
    expect([current.id, current.algorithm]).toEqual([
      "compact-duel-island-v6",
      "compact-island-sculpt-v5",
    ]);
    expect(current.ridgeBreakup).toEqual(COMPACT_RIDGE_BREAKUP_PARAMETERS);
    expect(Object.isFrozen(current.ridgeBreakup)).toBe(true);
    const { id, algorithm, ridgeBreakup, ...same } = current;
    const { id: oldId, algorithm: oldAlgorithm, ...old } = previous;
    expect(same).toEqual(old);
    expect(id).not.toBe(oldId);
    expect(algorithm).not.toBe(oldAlgorithm);
    expect(worldTerrainProfileIdentity(current)).not.toBe(
      worldTerrainProfileIdentity(previous),
    );
    expect(() => guard(request(current))).not.toThrow();
    expect(() => guard(request(previous))).not.toThrow();
    const config = DataManager.getWorldConfig()!;
    expect(config.compactResourceGroves!.terrainProfileId).toBe(current.id);
    expect(config.compactPreparationLodge!.terrainProfileId).toBe(current.id);
    const anchors = config.compactResourceGroves!.regions.flatMap(
      (r) => r.anchors,
    );
    expect(anchors).toHaveLength(35);
    for (const anchor of anchors) {
      expect(at(anchor.position.x, anchor.position.z)).toBe(
        at(anchor.position.x, anchor.position.z, previous),
      );
    }
  });

  it("can disable only the new shaping and exactly reproduce the original terrace", () => {
    const zero = validateWorldTerrainProfile({
      ...current,
      ridgeBreakup: {
        ...current.ridgeBreakup!,
        northGapDepth: 0,
        southGapDepth: 0,
        lateralWarp: 0,
        facetRelief: 0,
      },
    });
    for (let x = 208; x <= 284; x += 1.3)
      for (let z = 346; z <= 464; z += 1.7)
        expect(at(x, z, zero)).toBe(at(x, z, previous));
  });

  it("matches independent literal saddle depth on the unwarped crest", () => {
    const plain = validateWorldTerrainProfile({
      ...current,
      ridgeBreakup: {
        ...current.ridgeBreakup!,
        lateralWarp: 0,
        facetRelief: 0,
      },
    });
    for (let z = 350; z <= 460; z += 0.5) {
      const x = spine(z) - 2,
        az = z - 400;
      const depth =
        (1 - 0.72 * (1 - smooth(Math.abs(az + 15) / 20))) *
        (1 - 0.58 * (1 - smooth(Math.abs(az - 26) / 20)));
      const delta =
        20 *
        (depth - 1) *
        smooth((z - 335) / 35) *
        smooth((475 - z) / 35) *
        smooth((z - 350) / 12) *
        smooth((460 - z) / 12);
      expect(at(x, z, plain) - at(x, z, previous)).toBeCloseTo(
        delta * landform.mask(x, z, noise, previous),
        11,
      );
    }
    expect(
      at(spine(385) - 2, 385, previous) - at(spine(385) - 2, 385),
    ).toBeGreaterThan(10);
    expect(
      at(spine(426) - 2, 426, previous) - at(spine(426) - 2, 426),
    ).toBeGreaterThan(8);
    expect(at(spine(408) - 2, 408)).toBeGreaterThan(45);
  });

  it("preserves the coastline and every height outside the existing western support", () => {
    let changed = 0,
      maxLowering = 0,
      minChanged = Infinity,
      maxGradient = 0;
    for (let x = 150; x <= 550; x += 2)
      for (let z = 200; z <= 600; z += 2) {
        const old = at(x, z, previous),
          next = at(x, z);
        expect(landform.mask(x, z, noise, current)).toBe(
          landform.mask(x, z, noise, previous),
        );
        expect(next > 16).toBe(old > 16);
        expect(Number.isFinite(next)).toBe(true);
        if (next !== old) {
          expect(x > 212 && x < 280 && z > 350 && z < 460).toBe(true);
          changed++;
          maxLowering = Math.max(maxLowering, old - next);
          minChanged = Math.min(minChanged, next);
          maxGradient = Math.max(
            maxGradient,
            Math.hypot(
              at(x + 0.5, z) - at(x - 0.5, z),
              at(x, z + 0.5) - at(x, z - 0.5),
            ),
          );
        }
      }
    // Report the changed area separately; saddle depth and support are checked above.
    expect(changed).toBeGreaterThan(0);
    expect(maxLowering).toBeGreaterThan(10);
    expect(minChanged).toBeGreaterThan(19);
    expect(maxGradient).toBeLessThan(2.5);
    process.stdout.write(
      "Broken ridge CPU shape (not native art/GPU acceptance): " +
        JSON.stringify({ changed, maxLowering, minChanged, maxGradient }) +
        "\n",
    );
  });

  it("is continuous with continuous first derivatives at saddles, foot and preserved boundaries", () => {
    for (const z of [350, 362, 365, 385, 405, 406, 426, 446, 448, 460]) {
      for (const x of [
        212,
        spine(z) - 26,
        spine(z) - 6,
        spine(z) + 2,
        spine(z) + 12,
        274,
        280,
      ]) {
        const e = 1e-4;
        for (const [dx, dz] of [
          [e, 0],
          [0, e],
        ]) {
          const a = at(x - dx, z - dz),
            b = at(x, z),
            c = at(x + dx, z + dz);
          expect(Math.abs((b - a) / e - (c - b) / e)).toBeLessThan(0.005);
        }
      }
    }
  });

  it("binds every breakup value to profile identity and rejects invalid groups in CPU and real worker guard", () => {
    for (const [key, value] of Object.entries(
      COMPACT_RIDGE_BREAKUP_PARAMETERS,
    )) {
      const changed = validateWorldTerrainProfile({
        ...current,
        ridgeBreakup: {
          ...current.ridgeBreakup!,
          [key]: value + (key === "lateralWarp" ? -0.001 : 0.001),
        },
      });
      expect(worldTerrainProfileIdentity(changed)).not.toBe(
        worldTerrainProfileIdentity(current),
      );
      expect(() => guard(request(changed))).not.toThrow();
    }
    const invalid = [
      { northGapZ: -50 },
      { northGapHalfWidth: 0 },
      { northGapDepth: 1 },
      { southGapZ: 61 },
      { southGapHalfWidth: 100 },
      { southGapDepth: -1 },
      { lateralWarp: 4.01 },
      { warpWavelength: 0 },
      { facetRelief: 2 },
      { facetScale: 0.2 },
      { northGapDepth: NaN },
      { extra: 1 },
    ];
    for (const patch of invalid) {
      const profile = {
        ...current,
        ridgeBreakup: { ...current.ridgeBreakup!, ...patch },
      };
      expect(() => validateWorldTerrainProfile(profile)).toThrow();
      const input = request(current);
      const raw = {
        ...input,
        config: {
          ...input.config,
          TERRAIN_PROFILE: profile,
          TERRAIN_PROFILE_IDENTITY:
            "hyperia-world-terrain-profile-v1\n" + JSON.stringify(profile),
        },
      };
      expect(() => guard(raw)).toThrow();
    }
    expect(() =>
      validateWorldTerrainProfile({
        ...previous,
        ridgeBreakup: current.ridgeBreakup,
      }),
    ).toThrow();
    expect(() =>
      validateWorldTerrainProfile({ ...current, ridgeBreakup: undefined }),
    ).toThrow();
    expect(() =>
      validateWorldTerrainProfile({ ...current, id: previous.id }),
    ).toThrow();
  });
});
