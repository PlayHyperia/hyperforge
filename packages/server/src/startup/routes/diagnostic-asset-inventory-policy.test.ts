import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_ASSET_ITEMS,
  isDiagnosticAssetRequestAllowed,
  parseDiagnosticAssetAction,
} from "./diagnostic-asset-inventory-policy.js";

const characterId = "sparbot-standalone-12345678-1234-1234-1234-123456789abc";
describe("local asset inventory action policy", () => {
  it("accepts only exact bounded actions and canonical item identities", () => {
    expect(parseDiagnosticAssetAction({ action: "seed", characterId })).toEqual(
      { action: "seed", characterId },
    );
    expect(
      parseDiagnosticAssetAction({
        action: "equip",
        characterId,
        itemId: "bronze_kiteshield",
      }),
    ).toEqual({ action: "equip", characterId, itemId: "bronze_kiteshield" });
    for (const itemId of Object.keys(DIAGNOSTIC_ASSET_ITEMS)) {
      expect(
        parseDiagnosticAssetAction({ action: "equip", characterId, itemId }),
      ).toEqual({ action: "equip", characterId, itemId });
    }
    for (const value of [
      null,
      [],
      {},
      { action: "seed", characterId, quantity: 99 },
      { action: "seed", characterId, itemId: "bronze_gloves" },
      { action: "equip", characterId, itemId: "bronze_shield" },
      { action: "equip", characterId: "real-player", itemId: "bronze_gloves" },
      { action: "delete", characterId },
      { action: "equip", characterId, itemId: "__proto__" },
      // Processing tools remain inventory tools, not fabricated equip slots.
      { action: "equip", characterId, itemId: "hammer" },
    ]) {
      expect(() => parseDiagnosticAssetAction(value)).toThrow();
    }
  });
  it("requires explicit opt-in, independently validated no-money runtime and direct loopback transport", () => {
    const local = {
      localNoMoney: true,
      enabled: "true",
      remoteAddress: "127.0.0.1",
    };
    expect(isDiagnosticAssetRequestAllowed(local)).toBe(true);
    for (const remoteAddress of ["::1", "::ffff:127.0.0.1"])
      expect(isDiagnosticAssetRequestAllowed({ ...local, remoteAddress })).toBe(
        true,
      );
    expect(
      isDiagnosticAssetRequestAllowed({ ...local, localNoMoney: false }),
    ).toBe(false);
    for (const enabled of [undefined, "false", "1"])
      expect(isDiagnosticAssetRequestAllowed({ ...local, enabled })).toBe(
        false,
      );
    for (const remoteAddress of [
      undefined,
      "192.168.1.2",
      "127.0.0.2",
      "localhost",
    ])
      expect(isDiagnosticAssetRequestAllowed({ ...local, remoteAddress })).toBe(
        false,
      );
  });
});
