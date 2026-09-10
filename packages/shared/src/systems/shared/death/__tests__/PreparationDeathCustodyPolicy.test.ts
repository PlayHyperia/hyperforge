import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import type { WorldArea } from "../../../../types/core/core";
import { ALL_WORLD_AREAS } from "../../../../data/world-areas";
import { ZoneDetectionSystem } from "../ZoneDetectionSystem";
import {
  isExternalValueEnabled,
  requirePreparationDeathCustodyPolicy,
  validateExternalValueWorldAreaSafety,
  validatePreparationDeathCustodyAreas,
  validatePreparationDeathCustodyPolicy,
} from "../PreparationDeathCustodyPolicy";

function preparationArea(overrides: Partial<WorldArea> = {}): WorldArea {
  return {
    id: "preparation_training_grounds",
    name: "Preparation Training Grounds",
    description: "Test preparation area",
    difficultyLevel: 1,
    bounds: { minX: -36, maxX: 36, minZ: -36, maxZ: 36 },
    biomeType: "plains",
    safeZone: false,
    pvpEnabled: false,
    agentPreparationArea: true,
    deathCustodyPolicy: {
      version: 1,
      mode: "private_grave",
      approvalStatus: "diagnostic_only",
      keptItemCount: 3,
      ownerProtectionTicks: null,
      publicTransitionTicks: null,
      terminalExpirationTicks: null,
      spectatorCopyKey: "death_custody.preparation_private_grave",
    },
    npcs: [],
    resources: [],
    mobSpawns: [],
    ...overrides,
  };
}

describe("preparation death-custody launch policy", () => {
  it("keeps the production manifest free of generic public-risk areas", () => {
    const manifestPath = path.resolve(
      import.meta.dirname,
      "../../../../../../server/world/assets/manifests/world-areas.json",
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      starterTowns: Record<string, WorldArea>;
      level1Areas: Record<string, WorldArea>;
      level2Areas: Record<string, WorldArea>;
      level3Areas: Record<string, WorldArea>;
      specialAreas?: Record<string, WorldArea>;
    };
    const areas = {
      ...manifest.starterTowns,
      ...manifest.level1Areas,
      ...manifest.level2Areas,
      ...manifest.level3Areas,
      ...(manifest.specialAreas ?? {}),
    };

    expect(areas).not.toHaveProperty("wilderness_test");
    expect(
      validateExternalValueWorldAreaSafety(areas, {
        externalValueEnabled: true,
      }),
    ).toEqual([]);
    expect(
      validatePreparationDeathCustodyAreas(areas, { requireApproval: true }),
    ).toContain(
      "Area preparation_training_grounds death-custody policy is not launch approved",
    );
  });

  it("rejects generic PvP and ungoverned unsafe areas in external-value mode", () => {
    const unsafe = preparationArea({
      id: "ordinary_unsafe_area",
      agentPreparationArea: false,
      deathCustodyPolicy: undefined,
    });
    const pvp = preparationArea({
      id: "generic_pvp_area",
      safeZone: true,
      agentPreparationArea: false,
      deathCustodyPolicy: undefined,
      pvpEnabled: true,
    });

    expect(
      validateExternalValueWorldAreaSafety(
        { unsafe, pvp },
        { externalValueEnabled: true },
      ),
    ).toEqual([
      "Area ordinary_unsafe_area exposes unapproved public-risk death custody while external value is enabled",
      "Area generic_pvp_area enables unapproved PvP while external value is enabled",
    ]);
    expect(
      validateExternalValueWorldAreaSafety(
        { unsafe, pvp },
        { externalValueEnabled: false },
      ),
    ).toEqual([]);
  });

  it("recognizes only the explicit external-value opt-in", () => {
    expect(
      isExternalValueEnabled({ HYPERIA_EXTERNAL_VALUE_ENABLED: "true" }),
    ).toBe(true);
    expect(
      isExternalValueEnabled({ HYPERIA_EXTERNAL_VALUE_ENABLED: "TRUE" }),
    ).toBe(false);
    expect(isExternalValueEnabled({})).toBe(false);
  });

  it("covers every exact production-manifest overlap cell with a safe or protected policy", () => {
    const manifestPath = path.resolve(
      import.meta.dirname,
      "../../../../../../server/world/assets/manifests/world-areas.json",
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      starterTowns: Record<string, WorldArea>;
      level1Areas: Record<string, WorldArea>;
      level2Areas: Record<string, WorldArea>;
      level3Areas: Record<string, WorldArea>;
      specialAreas?: Record<string, WorldArea>;
    };
    const areas = {
      ...manifest.starterTowns,
      ...manifest.level1Areas,
      ...manifest.level2Areas,
      ...manifest.level3Areas,
      ...(manifest.specialAreas ?? {}),
    };
    const priorAreas = new Map(Object.entries(ALL_WORLD_AREAS));
    for (const id of Object.keys(ALL_WORLD_AREAS)) delete ALL_WORLD_AREAS[id];
    Object.assign(ALL_WORLD_AREAS, areas);
    try {
      const preparation = areas.preparation_training_grounds;
      expect(preparation).toBeDefined();
      expect(
        validatePreparationDeathCustodyPolicy(preparation, {
          requireApproval: false,
        }).errors,
      ).toEqual([]);

      const relevantAreas = Object.values(areas).filter(
        (area) =>
          area.bounds.maxX > preparation.bounds.minX &&
          area.bounds.minX < preparation.bounds.maxX &&
          area.bounds.maxZ > preparation.bounds.minZ &&
          area.bounds.minZ < preparation.bounds.maxZ,
      );
      const axisSamples = (axis: "X" | "Z"): number[] => {
        const min = preparation.bounds[`min${axis}`];
        const max = preparation.bounds[`max${axis}`];
        const boundaries = [
          min,
          max,
          ...relevantAreas.flatMap((area) => [
            Math.max(min, area.bounds[`min${axis}`]),
            Math.min(max, area.bounds[`max${axis}`]),
          ]),
        ].sort((left, right) => left - right);
        const unique = [...new Set(boundaries)];
        return [
          min + 0.001,
          max,
          ...unique.slice(0, -1).map((value, index) => {
            const next = unique[index + 1]!;
            return value + (next - value) / 2;
          }),
        ];
      };
      const detector = new ZoneDetectionSystem({
        getSystem: () => null,
      } as never);
      const lookup = (
        detector as unknown as {
          lookupZoneProperties: (position: { x: number; z: number }) => {
            id?: string;
            isSafe: boolean;
          };
        }
      ).lookupZoneProperties.bind(detector);
      const observed = new Set<string>();
      for (const x of axisSamples("X")) {
        for (const z of axisSamples("Z")) {
          const selected = lookup({ x, z });
          observed.add(String(selected.id));
          expect(
            selected.isSafe || selected.id === preparation.id,
            `unsafe unprotected overlap at (${x}, ${z}) selected ${String(selected.id)}`,
          ).toBe(true);
        }
      }
      expect(observed).toContain("central_haven");
      expect(observed).toContain("preparation_training_grounds");
    } finally {
      for (const id of Object.keys(ALL_WORLD_AREAS)) delete ALL_WORLD_AREAS[id];
      for (const [id, area] of priorAreas) ALL_WORLD_AREAS[id] = area;
    }
  });

  it("accepts the implemented private diagnostic policy but not a launch approval claim", () => {
    const area = preparationArea();
    expect(
      validatePreparationDeathCustodyPolicy(area, { requireApproval: false }),
    ).toMatchObject({ policy: area.deathCustodyPolicy, errors: [] });
    expect(
      validatePreparationDeathCustodyPolicy(area, { requireApproval: true })
        .errors,
    ).toContain(
      "Area preparation_training_grounds death-custody policy is not launch approved",
    );
  });

  it("accepts approval only with an explicit identity and timestamp", () => {
    const area = preparationArea({
      deathCustodyPolicy: {
        ...preparationArea().deathCustodyPolicy!,
        approvalStatus: "approved",
        approvalId: "launch-owner/ticket-123",
        approvedAt: "2026-08-13T10:00:00.000Z",
      },
    });
    expect(
      validatePreparationDeathCustodyPolicy(area, { requireApproval: true }),
    ).toMatchObject({ policy: area.deathCustodyPolicy, errors: [] });
  });

  it("rejects absent, public, expiring, or contradictory preparation custody", () => {
    const missing = preparationArea({ deathCustodyPolicy: undefined });
    const publicRisk = preparationArea({
      deathCustodyPolicy: {
        ...preparationArea().deathCustodyPolicy!,
        mode: "public_risk",
        publicTransitionTicks: 100,
        terminalExpirationTicks: 1_000,
      },
    });
    const pvp = preparationArea({ pvpEnabled: true });

    expect(
      validatePreparationDeathCustodyAreas(
        { missing, publicRisk, pvp },
        { requireApproval: false },
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("missing its preparation death-custody policy"),
        expect.stringContaining("public_risk is not implemented"),
        expect.stringContaining("cannot be both preparation and PvP enabled"),
      ]),
    );
    expect(() => requirePreparationDeathCustodyPolicy(publicRisk)).toThrow(
      "preparation_death_custody_policy_invalid",
    );
  });

  it("does not impose a preparation policy on ordinary world areas", () => {
    const ordinary = preparationArea({
      id: "ordinary_wilderness",
      agentPreparationArea: false,
      deathCustodyPolicy: undefined,
      pvpEnabled: true,
    });
    expect(
      validatePreparationDeathCustodyPolicy(ordinary, {
        requireApproval: true,
      }),
    ).toEqual({ policy: null, errors: [] });
  });
});
