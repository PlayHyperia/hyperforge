/** Bounded local fixture inventory only; no production item or visual overrides. */
export const DIAGNOSTIC_ASSET_ITEMS = Object.freeze({
  bronze_shortsword: "weapon",
  bronze_dagger: "weapon",
  bronze_scimitar: "weapon",
  bronze_pickaxe: "weapon",
  bronze_hatchet: "weapon",
  bronze_kiteshield: "shield",
  bronze_platebody: "body",
  bronze_full_helm: "helmet",
  bronze_platelegs: "legs",
  bronze_boots: "boots",
  bronze_gloves: "gloves",
} as const);

export type DiagnosticAssetItem = keyof typeof DIAGNOSTIC_ASSET_ITEMS;
export type DiagnosticAssetAction =
  | { action: "inspect" | "seed"; characterId: string }
  | {
      action: "equip" | "unequip";
      characterId: string;
      itemId: DiagnosticAssetItem;
    };

export function parseDiagnosticAssetAction(
  value: unknown,
): DiagnosticAssetAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an asset-test action object");
  }
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).some(
      (key) => !["action", "characterId", "itemId"].includes(key),
    )
  ) {
    throw new Error("Unknown asset-test action field");
  }
  if (
    typeof data.characterId !== "string" ||
    !/^sparbot-standalone-[a-f0-9-]{36}$/u.test(data.characterId)
  ) {
    throw new Error("An exact standalone diagnostic character ID is required");
  }
  if (data.action === "inspect" || data.action === "seed") {
    if (data.itemId !== undefined)
      throw new Error("This action does not accept itemId");
    return { action: data.action, characterId: data.characterId };
  }
  if (
    (data.action !== "equip" && data.action !== "unequip") ||
    typeof data.itemId !== "string" ||
    !Object.prototype.hasOwnProperty.call(DIAGNOSTIC_ASSET_ITEMS, data.itemId)
  ) {
    throw new Error("Unsupported diagnostic item/action");
  }
  return {
    action: data.action,
    characterId: data.characterId,
    itemId: data.itemId as DiagnosticAssetItem,
  };
}

export function isDiagnosticAssetRequestAllowed(options: {
  localNoMoney: boolean;
  enabled: string | undefined;
  remoteAddress: string | undefined;
}): boolean {
  return (
    options.localNoMoney &&
    options.enabled === "true" &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      options.remoteAddress ?? "",
    )
  );
}
