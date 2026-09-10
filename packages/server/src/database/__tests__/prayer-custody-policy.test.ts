import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  assertGenericPlayerUpdateExcludesAttackStyleAuthority,
  assertGenericPlayerUpdateExcludesPrayerAuthority,
  GENERIC_PLAYER_UPDATE_PROTECTED_ATTACK_STYLE_FIELDS,
  GENERIC_PLAYER_UPDATE_PROTECTED_PRAYER_FIELDS,
} from "../prayer-custody-policy";
import { PlayerRepository } from "../repositories/PlayerRepository";
import { DatabaseSystem } from "../../systems/DatabaseSystem";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("generic player-save atomic authority policy", () => {
  it("allows ordinary non-Prayer fields", () => {
    expect(() =>
      assertGenericPlayerUpdateExcludesPrayerAuthority(
        { health: 10, attackLevel: 5, attackXp: 500 },
        "test",
      ),
    ).not.toThrow();
  });

  it.each(GENERIC_PLAYER_UPDATE_PROTECTED_PRAYER_FIELDS)(
    "rejects an own %s field even when its value is undefined",
    (field) => {
      expect(() =>
        assertGenericPlayerUpdateExcludesPrayerAuthority(
          { [field]: undefined },
          "test-boundary",
        ),
      ).toThrow(
        `generic_player_update_prayer_custody_forbidden:test-boundary:${field}`,
      );
    },
  );

  it.each(GENERIC_PLAYER_UPDATE_PROTECTED_ATTACK_STYLE_FIELDS)(
    "rejects stale generic %s authority",
    (field) => {
      expect(() =>
        assertGenericPlayerUpdateExcludesAttackStyleAuthority(
          { [field]: "aggressive" },
          "test-boundary",
        ),
      ).toThrow(
        `generic_player_update_attack_style_custody_forbidden:test-boundary:${field}`,
      );
    },
  );

  it("keeps every generic persistence boundary behind the runtime guard", () => {
    const repositorySource = readFileSync(
      join(sourceRoot, "database/repositories/PlayerRepository.ts"),
      "utf8",
    );
    const databaseSystemSource = readFileSync(
      join(sourceRoot, "systems/DatabaseSystem/index.ts"),
      "utf8",
    );

    expect(repositorySource).toContain('"PlayerRepository.buildUpdateData"');
    expect(databaseSystemSource).toContain(
      '"DatabaseSystem.savePlayerCompleteAsync"',
    );
    expect(databaseSystemSource).toContain('"DatabaseSystem.savePlayer"');
    for (const field of GENERIC_PLAYER_UPDATE_PROTECTED_PRAYER_FIELDS) {
      expect(repositorySource).not.toContain(`u.${field} = data.${field}`);
      expect(databaseSystemSource).not.toContain(
        `updateData.${field} = data.${field}`,
      );
    }
    expect(repositorySource).not.toContain("u.attackStyle = data.attackStyle");
    expect(databaseSystemSource).not.toContain(
      "updateData.attackStyle = data.attackStyle",
    );
    expect(repositorySource).not.toContain("u.prayerLevel = data.prayerLevel");
    expect(repositorySource).not.toContain("u.prayerXp = data.prayerXp");
    expect(databaseSystemSource).not.toContain(
      "updateData.prayerLevel = data.prayerLevel",
    );
    expect(databaseSystemSource).not.toContain(
      "updateData.prayerXp = data.prayerXp",
    );
  });

  it("keeps generic skill writers and authored quest rewards outside Prayer progression", () => {
    const sharedSourceRoot = join(sourceRoot, "../../shared/src");
    const skillsSource = readFileSync(
      join(sharedSourceRoot, "systems/shared/character/SkillsSystem.ts"),
      "utf8",
    );
    const playerSource = readFileSync(
      join(sharedSourceRoot, "systems/shared/character/PlayerSystem.ts"),
      "utf8",
    );
    const quests = JSON.parse(
      readFileSync(
        join(sourceRoot, "../world/assets/manifests/quests.json"),
        "utf8",
      ),
    ) as Record<string, { rewards?: { xp?: Record<string, unknown> } }>;

    expect(skillsSource).toContain("rejectNonAtomicPrayerProgression");
    expect(skillsSource).not.toContain("setMaxPrayerPoints");
    expect(skillsSource).not.toContain("restorePrayerPoints");
    expect(playerSource).not.toContain("prayerLevel: s.prayer.level");
    expect(playerSource).not.toContain("prayerXp: Math.floor(s.prayer.xp)");
    expect(
      Object.entries(quests)
        .filter(([, quest]) =>
          Object.prototype.hasOwnProperty.call(
            quest.rewards?.xp ?? {},
            "prayer",
          ),
        )
        .map(([questId]) => questId),
    ).toEqual([]);
  });

  it("rejects protected state at the synchronous and complete-save facades", async () => {
    const database = new DatabaseSystem({} as never);

    expect(() =>
      database.savePlayer("player-1", { prayerPointUnits: 1_000_000 } as never),
    ).toThrow(
      "generic_player_update_prayer_custody_forbidden:DatabaseSystem.savePlayer:prayerPointUnits",
    );
    await expect(
      database.savePlayerCompleteAsync("player-1", {
        activePrayers: [],
      } as never),
    ).rejects.toThrow(
      "generic_player_update_prayer_custody_forbidden:DatabaseSystem.savePlayerCompleteAsync:activePrayers",
    );
    expect(() =>
      database.savePlayer("player-1", { attackStyle: "rapid" } as never),
    ).toThrow(
      "generic_player_update_attack_style_custody_forbidden:DatabaseSystem.savePlayer:attackStyle",
    );
  });

  it("rejects protected state in direct and batched repository saves", async () => {
    const repository = new PlayerRepository({} as never, {} as never);

    await expect(
      repository.savePlayerAsync("player-1", { prayerMaxPoints: 99 } as never),
    ).rejects.toThrow(
      "generic_player_update_prayer_custody_forbidden:PlayerRepository.buildUpdateData:prayerMaxPoints",
    );
    await expect(
      repository.batchSavePlayersAsync(
        new Map([["player-1", { prayerPoints: 99 } as never]]),
      ),
    ).rejects.toThrow(
      "generic_player_update_prayer_custody_forbidden:PlayerRepository.buildUpdateData:prayerPoints",
    );
    await expect(
      repository.savePlayerAsync("player-1", {
        attackStyle: "aggressive",
      } as never),
    ).rejects.toThrow(
      "generic_player_update_attack_style_custody_forbidden:PlayerRepository.buildUpdateData:attackStyle",
    );
  });
});
