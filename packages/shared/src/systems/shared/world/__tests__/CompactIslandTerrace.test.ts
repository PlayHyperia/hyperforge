import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import groveLayouts from "./fixtures/CompactResourceGroves.layouts.json";
import { DataManager } from "../../../../data/DataManager";
import {
  WORLD_IDENTITY_MANIFESTS,
  WorldManifestIdentityBuilder,
} from "../../../../data/WorldContentIdentity";
import { WorldContentAdmission } from "../../../../runtime/WorldContentAdmission";
import { NoiseGenerator } from "../../../../utils/NoiseGenerator";
import type { WorldConfigManifest } from "../../../../types/world/world-types";
import { createCompactIslandLandform } from "../CompactIslandLandform";
import { validateCompactResourceGroves } from "../CompactResourceGroves";
import {
  validateCompactPreparationLodge,
  COMPACT_PREPARATION_LODGE_V4_FIXTURE,
  COMPACT_PREPARATION_LODGE_V5_FIXTURE,
} from "../CompactPreparationLodge";
import {
  SCULPTED_COMPACT_V4_PROFILE_FIXTURE as current,
  SCULPTED_COMPACT_WORLD_TERRAIN_PROFILE as active,
  SCULPTED_COMPACT_V3_PROFILE_FIXTURE as previous,
  validateWorldTerrainProfile,
  worldTerrainProfileIdentity,
  type WorldTerrainProfile,
} from "../WorldTerrainProfile";

const landform = createCompactIslandLandform();
const noise = new NoiseGenerator(0);
const smooth = (v: number) => {
  const t = Math.max(0, Math.min(1, v));
  return t * t * (3 - 2 * t);
};
// Independent literal oracle for the measured 10 m candidate. It uses only the
// retained old height, not the new production terrace parameter values/function.
function expectedDelta(x: number, z: number): number {
  if (x <= 212 || x >= 280 || z <= 350 || z >= 460) return 0;
  const progress = Math.max(0, Math.min(1, (z - 335) / 140));
  const cross = x - (268 - 30 * Math.sin(Math.PI * progress));
  const old = 18 * smooth(1 - Math.abs(cross) / (cross < 0 ? 26 : 48));
  let next: number;
  if (cross <= -26) next = 0;
  else if (cross < -6) next = 20 * smooth((cross + 26) / 20);
  else if (cross <= 2) next = 20;
  else if (cross < 12) next = 20 - 9 * smooth((cross - 2) / 10);
  else if (cross <= 25) next = 11;
  else next = 11 * (1 - smooth((cross - 25) / 21));
  return (
    (next - old) *
    smooth((z - 335) / 35) *
    smooth((475 - z) / 35) *
    smooth((z - 350) / 12) *
    smooth((460 - z) / 12) *
    (1 - smooth((x - 274) / 6)) *
    landform.mask(x, z, noise, previous)
  );
}

describe("explicit western rocky terrace successor", () => {
  it("binds all 13 numeric terrace fields to v5 while keeping the complete v4 fixture", () => {
    expect(DataManager.getWorldTerrainProfile()).toEqual(active);
    expect([current.id, current.algorithm]).toEqual([
      "compact-duel-island-v5",
      "compact-island-sculpt-v4",
    ]);
    expect([previous.id, previous.algorithm, previous.terrace]).toEqual([
      "compact-duel-island-v4",
      "compact-island-sculpt-v3",
      undefined,
    ]);
    const { id: id5, algorithm: algorithm5, terrace, ...same5 } = current;
    const { id: id4, algorithm: algorithm4, ...same4 } = previous;
    expect(same5).toEqual(same4);
    expect(terrace).toEqual({
      startZ: -50,
      endZ: 60,
      endFade: 12,
      westFoot: -26,
      crestStart: -6,
      crestEnd: 2,
      crestHeight: 20,
      scarpRun: 10,
      shelfWidth: 13,
      shelfHeight: 11,
      apronWidth: 21,
      eastPreservationStart: -76,
      eastPreservationEnd: -70,
    });
    expect(Object.isFrozen(terrace)).toBe(true);
    for (const key of Object.keys(terrace!) as Array<
      keyof NonNullable<typeof terrace>
    >) {
      if (key === "westFoot") continue; // Coupled exactly to the old zero-height foot.
      expect(
        worldTerrainProfileIdentity(
          validateWorldTerrainProfile({
            ...current,
            terrace: { ...terrace, [key]: terrace![key] + 0.01 },
          }),
        ),
      ).not.toBe(worldTerrainProfileIdentity(current));
    }
    for (const value of [
      { ...current, terrace: undefined },
      { ...previous, terrace },
      { ...current, id: id4 },
      { ...previous, id: id5 },
      ...[
        { startZ: -66 },
        { endZ: 76 },
        { startZ: 61 },
        { endFade: 0 },
        { westFoot: -27 },
        { westFoot: -20 },
        { crestStart: -25 },
        { crestEnd: -5 },
        { crestHeight: NaN },
        { crestHeight: 25 },
        { shelfHeight: 20 },
        { scarpRun: 1e-12 },
        { scarpRun: 17 },
        { shelfWidth: 0 },
        { apronWidth: Infinity },
        { eastPreservationStart: -200 },
        { eastPreservationEnd: -75 },
        { eastPreservationEnd: 0 },
        { unexpected: 1 },
      ].map((patch) => ({ ...current, terrace: { ...terrace, ...patch } })),
    ])
      expect(() => validateWorldTerrainProfile(value)).toThrow();
    expect(algorithm5).not.toBe(algorithm4);
  });

  it("reproduces the chosen 10 m shape, preserves coast exactly and remains C1 at support/section joins", () => {
    let changed = 0;
    for (let x = 150; x <= 550; x += 2)
      for (let z = 200; z <= 600; z += 2) {
        const before = landform.height(x, z, noise, previous),
          after = landform.height(x, z, noise, current);
        expect(landform.mask(x, z, noise, current)).toBe(
          landform.mask(x, z, noise, previous),
        );
        expect(after).toBeCloseTo(before + expectedDelta(x, z), 11);
        if (after !== before) {
          changed++;
          expect(x).toBeGreaterThan(212);
          expect(x).toBeLessThan(280);
          expect(z).toBeGreaterThan(350);
          expect(z).toBeLessThan(460);
          expect(before).toBeGreaterThan(19);
          expect(after).toBeGreaterThan(19);
        }
      }
    expect(changed).toBeGreaterThan(1500);
    for (const [x, z] of [
      [212, 405],
      [232, 405],
      [240, 405],
      [250, 405],
      [263, 405],
      [274, 405],
      [280, 405],
      [250, 350],
      [250, 362],
      [250, 448],
      [250, 460],
    ]) {
      const e = 1e-4;
      for (const [dx, dz] of [
        [e, 0],
        [0, e],
      ]) {
        const h0 = landform.height(x - dx, z - dz, noise, current),
          h1 = landform.height(x, z, noise, current),
          h2 = landform.height(x + dx, z + dz, noise, current);
        expect(Math.abs((h1 - h0) / e - (h2 - h1) / e)).toBeLessThan(0.001);
      }
    }
    const relocated = validateWorldTerrainProfile({
      ...current,
      id: "terrace-translated-fixture",
      bounds: { minX: 1150, maxX: 1550, minZ: -800, maxZ: -400 },
      island: { ...current.island, centerX: 1350, centerZ: -600 },
    });
    for (let x = 214; x <= 280; x += 3)
      for (let z = 350; z <= 460; z += 7)
        expect(
          landform.height(x + 1000, z - 1000, noise, relocated),
        ).toBeCloseTo(landform.height(x, z, noise, current), 10);
  });

  it("pairs old/new grove and lodge bindings, and rejects old content on a current session", async () => {
    // Keep this historical v4→v5 migration oracle independent of the new
    // active v6 profile. No source anchors, rewards, layout or pose changes.
    const config = structuredClone(DataManager.getWorldConfig()!);
    delete config.compactServiceCourt;
    delete config.compactServicePlanting;
    config.terrainProfile = current;
    config.compactResourceGroves!.terrainProfileId = current.id;
    config.compactPreparationLodge = structuredClone(
      COMPACT_PREPARATION_LODGE_V5_FIXTURE,
    );
    const oldConfig = structuredClone(config);
    oldConfig.terrainProfile = previous;
    // Historical terrain uses its actual v1 tree layout, not the new v2
    // population relabeled as old content. The v2/v4 combination must reject.
    oldConfig.compactResourceGroves = {
      ...structuredClone(groveLayouts.previous),
      terrainProfileId: "compact-duel-island-v4",
    } as WorldConfigManifest["compactResourceGroves"];
    oldConfig.compactPreparationLodge = structuredClone(
      COMPACT_PREPARATION_LODGE_V4_FIXTURE,
    );
    expect(
      validateCompactResourceGroves(config.compactResourceGroves, current, 2),
    ).toBeDefined();
    expect(
      config.compactResourceGroves!.regions.flatMap((r) => r.anchors),
    ).toHaveLength(35);
    expect(
      oldConfig.compactResourceGroves!.regions.flatMap((r) => r.anchors),
    ).toHaveLength(16);
    expect(() =>
      validateCompactResourceGroves(
        {
          ...config.compactResourceGroves!,
          terrainProfileId: previous.id,
        },
        previous,
        2,
      ),
    ).toThrow(/layout identity/);
    expect(
      validateCompactResourceGroves(
        oldConfig.compactResourceGroves,
        previous,
        2,
      ),
    ).toBeDefined();
    expect(
      validateCompactPreparationLodge(config.compactPreparationLodge, current),
    ).toBeDefined();
    expect(
      validateCompactPreparationLodge(
        oldConfig.compactPreparationLodge,
        previous,
      ),
    ).toBeDefined();
    for (const [value, profile] of [
      [config, previous],
      [oldConfig, current],
    ] as const) {
      expect(() =>
        validateCompactResourceGroves(value.compactResourceGroves, profile, 2),
      ).toThrow();
      expect(() =>
        validateCompactPreparationLodge(value.compactPreparationLodge, profile),
      ).toThrow();
    }
    async function identity(
      value: WorldConfigManifest,
      profile: WorldTerrainProfile,
    ) {
      const builder = new WorldManifestIdentityBuilder();
      for (const name of WORLD_IDENTITY_MANIFESTS) {
        const manifest =
          name === "world-config.json"
            ? value
            : JSON.parse(
                readFileSync(
                  new URL(
                    `../../../../../../server/world/assets/manifests/${name}`,
                    import.meta.url,
                  ),
                  "utf8",
                ),
              );
        // Both sides are historical compact worlds with the original floors.
        if (name === "duel-arenas.json") {
          manifest.lobby.size = { width: 40, depth: 25 };
          manifest.hospital.size = { width: 28, depth: 23 };
        }
        builder.record(name, manifest);
      }
      return builder.build(profile);
    }
    const before = await identity(oldConfig, previous),
      after = await identity(config, current);
    expect(after).toBe(
      "198859e9e703e4a1cfd8d09b341d1fb70177a73e894dfcf149c2a529c9cba87f",
    );
    expect(after).not.toBe(DataManager.getWorldContentIdentity());
    expect(after).not.toBe(before);
    const admission = new WorldContentAdmission(() => after);
    admission.beginConnection();
    expect(admission.admitSnapshot(before)).toBeNull();
    expect(admission.allowsPacket("resourceSnapshot")).toBe(false);
    process.stdout.write(
      `Terrace full world-content migration: ${JSON.stringify({ previous: before, current: after })}\n`,
    );
  });
});
