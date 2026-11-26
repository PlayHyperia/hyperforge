import { describe, expect, it } from "vitest";

import { Emotes } from "../playerEmotes";
import {
  resolveStreamingDuelAttackEmote,
  resolveStreamingDuelLocomotionEmote,
} from "../streamingDuelPresentationEmotes";

describe("resolveStreamingDuelLocomotionEmote", () => {
  it.each([
    ["idle", Emotes.ONE_HAND_DUEL_IDLE],
    ["walk", Emotes.ONE_HAND_DUEL_WALK],
    ["run", Emotes.ONE_HAND_DUEL_RUN],
  ])("maps melee-duel %s locomotion to its guard clip", (emote, expected) => {
    expect(
      resolveStreamingDuelLocomotionEmote(emote, {
        inStreamingDuel: true,
        streamingDuelCombatRole: "melee",
        streamingDuelWeaponId: "bronze_shortsword",
      }),
    ).toBe(expected);
  });

  it.each([
    ["idle", Emotes.BOW_DUEL_IDLE],
    ["walk", Emotes.BOW_DUEL_WALK],
    ["run", Emotes.BOW_DUEL_RUN],
  ])("maps ranged-duel %s locomotion to its bow carry", (emote, expected) => {
    for (const weaponId of ["shortbow", "magic_shortbow"]) {
      expect(
        resolveStreamingDuelLocomotionEmote(emote, {
          inStreamingDuel: true,
          streamingDuelCombatRole: "ranged",
          streamingDuelWeaponId: weaponId,
        }),
      ).toBe(expected);
    }
  });

  it.each([
    ["idle", Emotes.TWO_HAND_DUEL_IDLE],
    ["2h_idle", Emotes.TWO_HAND_DUEL_IDLE],
    ["walk", Emotes.TWO_HAND_DUEL_WALK],
    ["run", Emotes.TWO_HAND_DUEL_RUN],
  ])(
    "maps bronze two-hand duel %s presentation to its certified clip",
    (emote, expected) => {
      expect(
        resolveStreamingDuelLocomotionEmote(emote, {
          inStreamingDuel: true,
          streamingDuelCombatRole: "melee",
          streamingDuelWeaponId: "bronze_2h_sword",
        }),
      ).toBe(expected);
    },
  );

  it.each(["mage", "prayer", null, undefined])(
    "does not replace locomotion for the %s role",
    (role) => {
      expect(
        resolveStreamingDuelLocomotionEmote("idle", {
          inStreamingDuel: true,
          streamingDuelCombatRole: role,
          streamingDuelWeaponId: "bronze_shortsword",
        }),
      ).toBeNull();
    },
  );

  it("does not replace attacks or ordinary world locomotion", () => {
    expect(
      resolveStreamingDuelLocomotionEmote("sword_swing", {
        inStreamingDuel: true,
        streamingDuelCombatRole: "melee",
        streamingDuelWeaponId: "bronze_shortsword",
      }),
    ).toBeNull();
    expect(
      resolveStreamingDuelLocomotionEmote("range", {
        inStreamingDuel: true,
        streamingDuelCombatRole: "ranged",
        streamingDuelWeaponId: "shortbow",
      }),
    ).toBeNull();
    expect(
      resolveStreamingDuelLocomotionEmote("walk", {
        inStreamingDuel: false,
        streamingDuelCombatRole: "melee",
        streamingDuelWeaponId: "bronze_shortsword",
      }),
    ).toBeNull();
  });

  it.each(["staff_of_air", "shortbow", null, undefined])(
    "does not apply a one-hand melee guard to %s",
    (weaponId) => {
      expect(
        resolveStreamingDuelLocomotionEmote("idle", {
          inStreamingDuel: true,
          streamingDuelCombatRole: "melee",
          streamingDuelWeaponId: weaponId,
        }),
      ).toBeNull();
    },
  );
});

describe("resolveStreamingDuelAttackEmote", () => {
  it("maps only the bronze two-hand streamed-duel slash", () => {
    const duel = {
      inStreamingDuel: true,
      streamingDuelCombatRole: "melee",
      streamingDuelWeaponId: "bronze_2h_sword",
    };
    expect(resolveStreamingDuelAttackEmote("2h_slash", duel)).toBe(
      Emotes.TWO_HAND_DUEL_SLASH,
    );
    expect(resolveStreamingDuelAttackEmote("walk", duel)).toBeNull();
    expect(
      resolveStreamingDuelAttackEmote("2h_slash", {
        ...duel,
        inStreamingDuel: false,
      }),
    ).toBeNull();
    expect(
      resolveStreamingDuelAttackEmote("2h_slash", {
        ...duel,
        streamingDuelWeaponId: "bronze_shortsword",
      }),
    ).toBeNull();
  });
});
