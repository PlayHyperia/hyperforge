import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  STREAMING_DUEL_CERTIFIED_VISIBLE_ITEM_IDS_BY_SLOT,
  isStreamingDuelEquipmentPresentationEligible,
  isStreamingDuelWeaponPresentationEligible,
} from "../duel-equipment-presentation.js";

describe("streaming duel equipment presentation authority", () => {
  it("matches the frozen canonical-avatar rigid certification manifest", () => {
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../../../scripts/duel-rigid-equipment-certifications.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ) as {
      avatarId: string;
      certifications: Array<{ itemId: string; slot: string }>;
    };

    expect(manifest.avatarId).toBe("steve");
    expect(
      [...STREAMING_DUEL_CERTIFIED_VISIBLE_ITEM_IDS_BY_SLOT.weapon].sort(),
    ).toEqual(
      manifest.certifications
        .filter((certification) => certification.slot === "weapon")
        .map((certification) => certification.itemId)
        .sort(),
    );
    for (const slot of [
      "shield",
      "helmet",
      "body",
      "legs",
      "boots",
      "gloves",
      "cape",
    ] as const) {
      expect(STREAMING_DUEL_CERTIFIED_VISIBLE_ITEM_IDS_BY_SLOT[slot]).toEqual(
        [],
      );
    }
  });

  it("admits only certified visible meshes while preserving non-mesh slots", () => {
    expect(isStreamingDuelWeaponPresentationEligible("bronze_shortsword")).toBe(
      true,
    );
    expect(isStreamingDuelWeaponPresentationEligible("bronze_dagger")).toBe(
      false,
    );
    expect(isStreamingDuelWeaponPresentationEligible("bronze_2h_sword")).toBe(
      false,
    );
    expect(
      isStreamingDuelEquipmentPresentationEligible(
        "bronze_full_helm",
        "helmet",
      ),
    ).toBe(false);
    expect(
      isStreamingDuelEquipmentPresentationEligible("bronze_arrow", "arrows"),
    ).toBe(true);
    expect(
      isStreamingDuelEquipmentPresentationEligible("power_amulet", "amulet"),
    ).toBe(true);
    expect(
      isStreamingDuelEquipmentPresentationEligible("seer_ring", "ring"),
    ).toBe(true);
    expect(
      isStreamingDuelEquipmentPresentationEligible(
        " bronze_shortsword",
        "weapon",
      ),
    ).toBe(false);
    expect(
      isStreamingDuelEquipmentPresentationEligible(
        "bronze_shortsword",
        "unknown",
      ),
    ).toBe(false);
  });
});
