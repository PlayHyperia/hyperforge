import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPACT_WORLD_TERRAIN_PROFILE } from "../systems/shared/world/WorldTerrainProfile";
import { resolveWorldSpawnPosition } from "./WorldSpawnAdmission";

const PROFILE = COMPACT_WORLD_TERRAIN_PROFILE;
const LOBBY: readonly [number, number, number] = [385, 0.42, 374];

describe("compact world spawn admission", () => {
  it.each([
    [350, 18, 320],
    [385, 0.42, 374],
    [150, -20, 200],
    [550, 900, 600],
    [150, 0, 600],
    [550, 5, 200],
    [349.75, 22.125, 321.125],
  ])(
    "preserves finite in-bounds coordinates including exact edges (%j)",
    (...position) => {
      const original = [...position];
      const result = resolveWorldSpawnPosition(position, LOBBY, PROFILE);
      expect(result).toEqual({ position, rehomed: false, reason: null });
      expect(result.position).not.toBe(position);
      expect(position).toEqual(original);
    },
  );

  it.each([
    [0, 50, 0],
    [-5000, 20, 5000],
    [149.999, 20, 400],
    [550.001, 20, 400],
    [350, 20, 199.999],
    [350, 20, 600.001],
  ])(
    "rehomes old/outside coordinates without translation or clamping (%j)",
    (...position) => {
      const result = resolveWorldSpawnPosition(position, LOBBY, PROFILE);
      expect(result).toEqual({
        position: [...LOBBY],
        rehomed: true,
        reason: "outside-world-bounds",
      });
    },
  );

  it.each(
    [
      undefined,
      null,
      [],
      [350, 20],
      [350, 20, 400, 0],
      [NaN, 20, 400],
      [350, NaN, 400],
      [350, 20, Infinity],
      [-Infinity, 20, 400],
      [350, undefined, 400],
      [350, null, 400],
      ["350", 20, 400],
      { x: 350, y: 20, z: 400 },
    ].map((position) => ({ position })),
  )(
    "rehomes malformed coordinates without coercing them to the origin ($position)",
    ({ position }) => {
      const result = resolveWorldSpawnPosition(position, LOBBY, PROFILE);
      expect(result).toEqual({
        position: [...LOBBY],
        rehomed: true,
        reason: "invalid-position",
      });
    },
  );

  it("rejects sparse arrays instead of accepting an absent Y coordinate", () => {
    const position = new Array<number>(3);
    position[0] = 350;
    position[2] = 400;
    expect(resolveWorldSpawnPosition(position, LOBBY, PROFILE).reason).toBe(
      "invalid-position",
    );
  });

  it("is idempotent after rehoming and leaves all inputs untouched", () => {
    const candidate = Object.freeze([0, 10, 0]);
    const fallback = Object.freeze([...LOBBY]) as readonly [
      number,
      number,
      number,
    ];
    const first = resolveWorldSpawnPosition(candidate, fallback, PROFILE);
    const second = resolveWorldSpawnPosition(first.position, fallback, PROFILE);
    expect(second.position).toEqual(first.position);
    expect(second.rehomed).toBe(false);
    expect(candidate).toEqual([0, 10, 0]);
    expect(fallback).toEqual(LOBBY);
    first.position[0] = 0;
    expect(fallback).toEqual(LOBBY);
  });

  it.each([
    [0, 10, 0],
    [385, NaN, 374],
    [Infinity, 0.42, 374],
    [385, 0.42, 600.01],
  ])(
    "fails closed on an invalid lobby even when the saved candidate is valid (%j)",
    (x, y, z) => {
      expect(() =>
        resolveWorldSpawnPosition([350, 20, 320], [x, y, z], PROFILE),
      ).toThrow("World lobby spawn");
    },
  );

  it("requires a valid explicit terrain profile", () => {
    expect(() =>
      resolveWorldSpawnPosition(LOBBY, LOBBY, {
        ...PROFILE,
        bounds: { ...PROFILE.bounds, minX: Infinity },
      }),
    ).toThrow("Invalid WorldTerrainProfile");
  });

  it("admits the real duel manifest lobby and every deterministic 6–9m lobby ring direction", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL(
          "../../../server/world/assets/manifests/duel-arenas.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      lobby: { spawnPoint: { x: number; y: number; z: number } };
    };
    const { x, y, z } = manifest.lobby.spawnPoint;
    const actualLobby: [number, number, number] = [x, y, z];
    expect(actualLobby).toEqual(LOBBY);
    expect(
      resolveWorldSpawnPosition(actualLobby, actualLobby, PROFILE).rehomed,
    ).toBe(false);
    for (let degrees = 0; degrees < 360; degrees++) {
      for (let radius = 6; radius <= 9; radius++) {
        const angle = (degrees * Math.PI) / 180;
        const candidate = [
          x + Math.cos(angle) * radius,
          y,
          z + Math.sin(angle) * radius,
        ];
        expect(
          resolveWorldSpawnPosition(candidate, actualLobby, PROFILE).rehomed,
        ).toBe(false);
      }
    }
  });
});
