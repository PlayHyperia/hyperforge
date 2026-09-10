/**
 * AgentStatsDisplay - Shows agent HP bar and stats during fight
 *
 * Fighting-game style display with skewed clip-path HP bar, equipment cells
 * with manifest-loaded item icons, and inventory grid.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { parseStreamingDuelStrategySummary } from "@hyperforge/shared";
import type {
  AgentInfo,
  FrozenStreamingCombatLoadout,
  StreamingCombatRole,
} from "../../screens/StreamingMode";
import { getRuntimeAssetBaseUrl } from "../../lib/api-config";
import {
  formatStreamingCombatRole,
  resolveActiveStreamingCombatRole,
} from "./streamingCombatRole";

interface AgentStatsDisplayProps {
  agent: AgentInfo;
  side: "left" | "right";
  showFrozenLoadouts?: boolean;
  showActiveCombatRole?: boolean;
  combatFeedbackEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Item icon manifest loading (cached singleton)
// ---------------------------------------------------------------------------

interface ManifestItemRecord {
  id: string;
  iconPath?: string | null;
}

const ITEM_MANIFEST_FILES = [
  "weapons.json",
  "ammunition.json",
  "resources.json",
  "tools.json",
  "misc.json",
  "armor.json",
  "runes.json",
  "food.json",
] as const;

const INVENTORY_FALLBACK_ICONS = [
  "🗡️",
  "🪓",
  "🛡️",
  "🏹",
  "🧪",
  "💎",
  "🪙",
  "📜",
  "🪄",
  "🧿",
] as const;

let cachedItemIconMap: Record<string, string> | null = null;
let itemIconMapPromise: Promise<Record<string, string>> | null = null;

export function resolveStreamingItemIconPath(iconPath: string): string {
  const base = getRuntimeAssetBaseUrl().replace(/\/$/, "");
  if (iconPath.startsWith("asset://")) {
    const relativePath = iconPath.replace("asset://", "");
    return `${base}/${relativePath}`;
  }
  if (iconPath.startsWith("/")) return `${base}${iconPath}`;
  return `${base}/${iconPath}`;
}

async function loadItemIconMap(): Promise<Record<string, string>> {
  if (cachedItemIconMap) return cachedItemIconMap;
  if (itemIconMapPromise) return itemIconMapPromise;

  itemIconMapPromise = (async () => {
    let responses: ManifestItemRecord[][] = [];
    try {
      responses = await Promise.all(
        ITEM_MANIFEST_FILES.map(async (fileName) => {
          const response = await fetch(
            `${getRuntimeAssetBaseUrl().replace(/\/$/, "")}/manifests/items/${fileName}`,
            { cache: "force-cache" },
          );
          if (!response.ok) return [] as ManifestItemRecord[];
          return (await response.json()) as ManifestItemRecord[];
        }),
      );
    } catch {
      responses = [];
    }

    const items = responses.flat();
    const iconMap: Record<string, string> = {};
    for (const item of items) {
      if (!item.id || !item.iconPath) continue;
      iconMap[item.id] = resolveStreamingItemIconPath(item.iconPath);
    }

    cachedItemIconMap = iconMap;
    return iconMap;
  })();

  return itemIconMapPromise;
}

export function resolveStreamingItemIconMap(
  authoritativePaths: Record<string, string> | undefined,
  legacyManifestMap: Record<string, string>,
): Record<string, string> {
  // Presence is authoritative, including an intentionally empty object. A
  // current server omits missing files so falling back to the raw manifest here
  // would recreate the same failed request the server explicitly prevented.
  if (authoritativePaths === undefined) return legacyManifestMap;
  return Object.fromEntries(
    Object.entries(authoritativePaths).map(([itemId, iconPath]) => [
      itemId,
      resolveStreamingItemIconPath(iconPath),
    ]),
  );
}

export function getStreamingItemFallbackIcon(
  itemKey: string,
  slot: number,
): string {
  const normalized = itemKey.toLowerCase();
  if (/arrow|bow/.test(normalized)) return "🏹";
  if (/sword|dagger|mace|axe|weapon/.test(normalized)) return "🗡️";
  if (/shield|helm|helmet|body|legs|boots|gloves|cape/.test(normalized)) {
    return "🛡️";
  }
  if (/rune|staff|wand|spell/.test(normalized)) return "🪄";
  if (/food|fish|bread|meat|potion/.test(normalized)) return "🧪";

  const source = `${itemKey}:${slot}`;
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  return INVENTORY_FALLBACK_ICONS[hash % INVENTORY_FALLBACK_ICONS.length]!;
}

function StreamItemIcon({
  itemId,
  iconUrl,
  fallbackSlot,
}: {
  itemId: string;
  iconUrl: string | null;
  fallbackSlot: number;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [iconUrl, itemId]);

  if (!iconUrl || failed) {
    return (
      <span
        role="img"
        aria-label={itemId.replaceAll("_", " ")}
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10,
          lineHeight: 1,
          filter: "drop-shadow(0 0 2px rgba(0,0,0,0.6))",
        }}
      >
        {getStreamingItemFallbackIcon(itemId, fallbackSlot)}
      </span>
    );
  }

  return (
    <img
      src={iconUrl}
      alt={itemId}
      onError={() => setFailed(true)}
      style={{
        width: "110%",
        height: "110%",
        objectFit: "cover",
        display: "block",
      }}
      draggable={false}
    />
  );
}

// ---------------------------------------------------------------------------
// Equipment slot ordering
// ---------------------------------------------------------------------------

const EQUIPMENT_SLOT_ORDER = [
  "weapon",
  "shield",
  "helm",
  "helmet",
  "body",
  "legs",
  "boots",
  "gloves",
  "cape",
  "amulet",
  "ring",
] as const;

const EQUIPPED_SLOTS_VISIBLE = 6;

const COMBAT_ROLE_ORDER = ["melee", "ranged", "mage"] as const;

function humanizeStreamingIdentifier(identifier: string): string {
  return identifier
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function describeFrozenStreamingCombatLoadout(
  loadout: FrozenStreamingCombatLoadout,
): string {
  const armor = loadout.armorIds
    ? Object.entries(loadout.armorIds)
        .filter((entry): entry is [string, string] => entry[1] !== null)
        .map(
          ([slot, itemId]) =>
            `${humanizeStreamingIdentifier(slot)}: ${humanizeStreamingIdentifier(itemId)}`,
        )
        .join(", ")
    : "Legacy snapshot";
  return [
    `Weapon: ${humanizeStreamingIdentifier(loadout.weaponId)}`,
    `Ammunition: ${
      loadout.arrowsId ? humanizeStreamingIdentifier(loadout.arrowsId) : "None"
    }`,
    `Shield: ${
      loadout.shieldId ? humanizeStreamingIdentifier(loadout.shieldId) : "None"
    }`,
    `Spell: ${
      loadout.spellId ? humanizeStreamingIdentifier(loadout.spellId) : "None"
    }`,
    `Armor: ${armor || "None"}`,
  ].join("; ");
}

function getVisibleLoadoutSummary(
  role: StreamingCombatRole,
  loadout: FrozenStreamingCombatLoadout,
): string {
  const parts = [humanizeStreamingIdentifier(loadout.weaponId)];
  if (role === "ranged" && loadout.arrowsId) {
    parts.push(humanizeStreamingIdentifier(loadout.arrowsId));
  }
  if (role === "mage" && loadout.spellId) {
    parts.push(humanizeStreamingIdentifier(loadout.spellId));
  }
  if (loadout.shieldId) {
    parts.push(humanizeStreamingIdentifier(loadout.shieldId));
  }
  const armorCount = loadout.armorIds
    ? Object.values(loadout.armorIds).filter((itemId) => itemId !== null).length
    : 0;
  if (armorCount > 0) parts.push(`${armorCount} armor`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const AgentStatsDisplay = React.memo(function AgentStatsDisplay({
  agent,
  side,
  showFrozenLoadouts = false,
  showActiveCombatRole = false,
  combatFeedbackEnabled = true,
}: AgentStatsDisplayProps) {
  const hpPercent = Math.max(0, Math.min(100, (agent.hp / agent.maxHp) * 100));
  const isCritical = hpPercent < 20;
  const hpColor = isCritical ? "#ff0d3c" : "#00ffcc";
  const isRight = side === "right";

  // Heal flash: tracks when HP increases or healsUsed increments
  const prevHpRef = useRef<number>(agent.hp);
  const prevHealRef = useRef<number>(agent.healsUsed ?? 0);
  const prevAgentIdRef = useRef(agent.id);
  const [healFlash, setHealFlash] = useState(false);
  const [healDelta, setHealDelta] = useState(0);
  const healTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const healUsedNow = agent.healsUsed ?? 0;
    const hpNow = agent.hp;
    const hpPrev = prevHpRef.current;
    const healsNow = healUsedNow;
    const healsPrev = prevHealRef.current;
    const sameAgent = prevAgentIdRef.current === agent.id;

    if (
      combatFeedbackEnabled &&
      sameAgent &&
      (healsNow > healsPrev || hpNow > hpPrev)
    ) {
      const delta = Math.max(0, hpNow - hpPrev);
      setHealDelta(delta);
      setHealFlash(true);
      if (healTimerRef.current) clearTimeout(healTimerRef.current);
      healTimerRef.current = setTimeout(() => setHealFlash(false), 900);
    } else if (!combatFeedbackEnabled || !sameAgent) {
      setHealFlash(false);
      if (healTimerRef.current) {
        clearTimeout(healTimerRef.current);
        healTimerRef.current = null;
      }
    }

    prevHpRef.current = hpNow;
    prevHealRef.current = healsNow;
    prevAgentIdRef.current = agent.id;
    return () => {
      if (healTimerRef.current) clearTimeout(healTimerRef.current);
    };
  }, [agent.hp, agent.healsUsed, agent.id, combatFeedbackEnabled]);

  const showHealFlash = combatFeedbackEnabled && healFlash;

  const [itemIconMap, setItemIconMap] = useState<Record<string, string>>({});

  useEffect(() => {
    if (agent.itemIconPaths !== undefined) return;
    let isMounted = true;
    void loadItemIconMap().then((iconMap) => {
      if (!isMounted) return;
      setItemIconMap(iconMap);
    });
    return () => {
      isMounted = false;
    };
  }, [agent.itemIconPaths]);

  const resolvedItemIconMap = useMemo(
    () => resolveStreamingItemIconMap(agent.itemIconPaths, itemIconMap),
    [agent.itemIconPaths, itemIconMap],
  );

  // Direction-dependent clip paths for the skewed HP bar (static per side)
  const { hpOuterClipPath, hpFillClipPath, skewDir } = useMemo(
    () => ({
      hpOuterClipPath: isRight
        ? "polygon(2% 0, 100% 0, 98% 100%, 0 100%)"
        : "polygon(0 0, 98% 0, 100% 100%, 2% 100%)",
      hpFillClipPath: isRight
        ? "polygon(10px 0, 100% 0, 100% 100%, 0 100%)"
        : "polygon(0 0, calc(100% - 10px) 0, 100% 100%, 0 100%)",
      skewDir: isRight ? "skew(15deg)" : "skew(-15deg)",
    }),
    [isRight],
  );

  // Build inventory lookup from positional array
  const inventoryBySlot = useMemo(() => {
    return new Map(
      (agent.inventory ?? [])
        .map((item, index) =>
          item
            ? ({ slot: index, ...item } as {
                slot: number;
                itemId: string;
                quantity: number;
              })
            : null,
        )
        .filter(
          (item): item is { slot: number; itemId: string; quantity: number } =>
            item !== null,
        )
        .map((item) => [item.slot, item] as const),
    );
  }, [agent.inventory]);

  // Build deduplicated equipped item list
  const equippedCells = useMemo(() => {
    const equippedItemIds: string[] = [];
    const seenEquipped = new Set<string>();
    for (const slot of EQUIPMENT_SLOT_ORDER) {
      const itemId = agent.equipment?.[slot];
      if (!itemId || seenEquipped.has(itemId)) continue;
      equippedItemIds.push(itemId);
      seenEquipped.add(itemId);
    }
    if (agent.equipment) {
      for (const itemId of Object.values(agent.equipment)) {
        if (!itemId || seenEquipped.has(itemId)) continue;
        equippedItemIds.push(itemId);
        seenEquipped.add(itemId);
      }
    }
    return [
      ...equippedItemIds.slice(0, EQUIPPED_SLOTS_VISIBLE),
      ...Array.from({
        length: Math.max(0, EQUIPPED_SLOTS_VISIBLE - equippedItemIds.length),
      }).map(() => null as string | null),
    ];
  }, [agent.equipment]);

  const frozenLoadoutEntries = useMemo(
    () =>
      COMBAT_ROLE_ORDER.flatMap((role) => {
        const loadout = agent.combatLoadouts?.[role];
        if (
          !loadout ||
          loadout.role !== role ||
          typeof loadout.weaponId !== "string" ||
          loadout.weaponId.trim().length === 0
        ) {
          return [];
        }
        return [{ role, loadout }];
      }),
    [agent.combatLoadouts],
  );
  const strategySummary = useMemo(
    () => parseStreamingDuelStrategySummary(agent.strategySummary),
    [agent.strategySummary],
  );
  const exactPrayerPoints =
    typeof agent.prayerPointUnits === "number" &&
    Number.isSafeInteger(agent.prayerPointUnits) &&
    agent.prayerPointUnits >= 0
      ? agent.prayerPointUnits / 1_000_000
      : null;
  const prayerPointLabel =
    exactPrayerPoints === null
      ? null
      : exactPrayerPoints.toFixed(2).replace(/\.00$/, "");
  const activeCombatRole = showActiveCombatRole
    ? resolveActiveStreamingCombatRole(agent)
    : null;

  return (
    <div
      className={`streaming-agent-stats streaming-agent-stats--${side}`}
      style={{
        alignItems: isRight ? "flex-end" : "flex-start",
      }}
    >
      {/* Name + stats row */}
      <div
        className="streaming-agent-heading"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          width: "100%",
          padding: "0 6px",
          fontFamily: "'Teko', 'Arial Black', sans-serif",
          textTransform: "uppercase" as const,
          flexDirection: isRight ? "row-reverse" : "row",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexDirection: isRight ? "row-reverse" : "row",
          }}
        >
          <span
            className="streaming-agent-rank"
            style={{
              background: "#ff0d3c",
              color: "#fff",
              padding: "2px 8px",
              fontSize: "0.85rem",
              fontWeight: 900,
              transform: skewDir,
              border: "1px solid #fff",
              display: "inline-block",
            }}
          >
            #{agent.rank > 0 ? agent.rank : "-"}
          </span>
          <span
            className="streaming-agent-name"
            style={{
              color: "#fff",
              fontSize: "clamp(0.95rem, 1.6vw, 1.2rem)",
              fontWeight: 900,
              letterSpacing: 1,
              textShadow: "2px 2px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000",
            }}
          >
            {agent.name}
          </span>
        </div>

        <div
          className="streaming-agent-records"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexDirection: isRight ? "row-reverse" : "row",
            background: "rgba(0,0,0,0.7)",
            padding: "2px 10px",
            transform: skewDir,
            border: "1px solid rgba(255,255,255,0.3)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              flexDirection: "row",
            }}
          >
            <span
              style={{ color: "#aaa", fontSize: "0.65rem", fontWeight: 800 }}
            >
              OVR
            </span>
            <span
              style={{ color: "#f2d08a", fontSize: "0.9rem", fontWeight: 900 }}
            >
              {agent.wins}-{agent.losses}
            </span>
          </div>
          <span style={{ color: "#555", fontSize: "0.8rem", margin: "0 4px" }}>
            /
          </span>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              flexDirection: "row",
            }}
          >
            <span
              style={{ color: "#aaa", fontSize: "0.65rem", fontWeight: 800 }}
            >
              H2H
            </span>
            <span
              style={{ color: "#f2d08a", fontSize: "0.9rem", fontWeight: 900 }}
            >
              {agent.headToHeadWins || 0}-{agent.headToHeadLosses || 0}
            </span>
          </div>
        </div>
      </div>

      {activeCombatRole ? (
        <div
          className={`streaming-agent-active-role streaming-agent-active-role--${side}`}
          aria-label={`${agent.name} active combat style: ${formatStreamingCombatRole(activeCombatRole)}`}
          data-active-combat-role={activeCombatRole}
        >
          <span className="streaming-agent-active-role-label">Active</span>
          <strong>{formatStreamingCombatRole(activeCombatRole)}</strong>
        </div>
      ) : null}

      {showFrozenLoadouts && agent.loadoutFrozen && strategySummary ? (
        <section
          className={`streaming-frozen-strategy streaming-frozen-strategy--${side}`}
          aria-label={`${agent.name} committed strategy. ${humanizeStreamingIdentifier(strategySummary.approach)} approach using ${humanizeStreamingIdentifier(strategySummary.tacticalMacro)} movement and ${humanizeStreamingIdentifier(strategySummary.attackStyle)} attacks. Recover at ${strategySummary.foodThreshold} percent health and defend at ${strategySummary.switchDefensiveAt} percent health.`}
          data-strategy-schema={strategySummary.schemaVersion}
          data-strategy-policy={strategySummary.policyVersion}
        >
          <div className="streaming-frozen-strategy-header">
            <span>Committed strategy</span>
            <span className="streaming-frozen-strategy-source">
              {strategySummary.source === "model"
                ? "Agent-planned"
                : strategySummary.source === "deterministic"
                  ? "Rules fallback"
                  : "Local test"}
            </span>
          </div>
          <div className="streaming-frozen-strategy-primary">
            <strong>
              {humanizeStreamingIdentifier(strategySummary.approach)}
            </strong>
            <span aria-hidden="true">·</span>
            <strong>
              {humanizeStreamingIdentifier(strategySummary.tacticalMacro)}
            </strong>
          </div>
          <div className="streaming-frozen-strategy-details">
            <span>
              {humanizeStreamingIdentifier(strategySummary.attackStyle)} attacks
            </span>
            <span>
              {strategySummary.preferredCombatRole
                ? `Prefer ${humanizeStreamingIdentifier(strategySummary.preferredCombatRole)}`
                : "Adaptive roles"}
            </span>
            <span>
              {strategySummary.prayer
                ? humanizeStreamingIdentifier(strategySummary.prayer)
                : "No Prayer plan"}
            </span>
          </div>
          <div className="streaming-frozen-strategy-thresholds">
            <span>Recover {strategySummary.foodThreshold}%</span>
            <span>Defend {strategySummary.switchDefensiveAt}%</span>
          </div>
        </section>
      ) : null}

      {showFrozenLoadouts && agent.loadoutFrozen ? (
        <section
          className={`streaming-frozen-loadouts streaming-frozen-loadouts--${side}`}
          aria-label={`${agent.name} frozen combat loadouts`}
          data-loadout-fingerprint={agent.loadoutFingerprint ?? undefined}
        >
          <div className="streaming-frozen-loadouts-header">
            <span>Frozen loadouts</span>
            {agent.loadoutFingerprint ? (
              <span
                className="streaming-frozen-loadouts-fingerprint"
                title={`Snapshot ${agent.loadoutFingerprint}`}
              >
                {agent.loadoutFingerprint.slice(0, 8).toUpperCase()}
              </span>
            ) : null}
          </div>
          {frozenLoadoutEntries.length > 0 ? (
            <div className="streaming-frozen-loadouts-list">
              {frozenLoadoutEntries.map(({ role, loadout }) => {
                const description =
                  describeFrozenStreamingCombatLoadout(loadout);
                return (
                  <div
                    key={role}
                    className="streaming-frozen-loadout-entry"
                    title={description}
                    aria-label={`${humanizeStreamingIdentifier(role)} loadout. ${description}`}
                  >
                    <span className="streaming-frozen-loadout-role">
                      {role}
                    </span>
                    <span className="streaming-frozen-loadout-details">
                      {getVisibleLoadoutSummary(role, loadout)}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <span className="streaming-frozen-loadouts-unavailable">
              Competitive loadout unavailable
            </span>
          )}
        </section>
      ) : null}

      {/* HP bar - skewed fighting-game style frame + inset fill */}
      <div style={{ position: "relative", width: "100%" }}>
        {/* Floating heal delta popup */}
        {showHealFlash && (
          <div
            style={{
              position: "absolute",
              top: -26,
              ...(isRight ? { left: 12 } : { right: 12 }),
              zIndex: 10,
              pointerEvents: "none",
              animation: "heal-float-up 0.9s ease-out forwards",
              color: "#34d399",
              fontSize: "1rem",
              fontWeight: 900,
              fontFamily: "monospace",
              textShadow:
                "0 0 8px rgba(52,211,153,0.8), 1px 1px 0 #000, -1px -1px 0 #000",
              whiteSpace: "nowrap",
            }}
          >
            {healDelta > 0 ? `+${healDelta}` : "🍖"}
          </div>
        )}
        <div
          style={{
            width: "100%",
            height: 28,
            position: "relative",
            clipPath: hpOuterClipPath,
            background: showHealFlash ? "#34d399" : "#fff",
            boxShadow: showHealFlash
              ? "0 4px 12px rgba(52,211,153,0.6), 0 0 24px rgba(52,211,153,0.4)"
              : "0 4px 12px rgba(0,0,0,0.5)",
            transition: "background 0.15s, box-shadow 0.15s",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 2,
              clipPath: hpOuterClipPath,
              background: "rgba(0,0,0,0.8)",
              overflow: "hidden",
              zIndex: 0,
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                ...(isRight ? { right: 0 } : { left: 0 }),
                width: `${hpPercent}%`,
                background: healFlash ? "#34d399" : hpColor,
                clipPath: hpFillClipPath,
                transition: "width 0.15s ease-out, background 0.2s",
                boxShadow: healFlash
                  ? "inset 0 0 14px rgba(52,211,153,0.7)"
                  : isCritical
                    ? "inset 0 0 8px rgba(255,13,60,0.45)"
                    : "inset 0 0 8px rgba(0,255,204,0.35)",
              }}
            />
          </div>
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              display: "flex",
              alignItems: "center",
              ...(isRight ? { right: 32 } : { left: 32 }),
              color: "#fff",
              fontSize: "1.2rem",
              fontWeight: 900,
              fontFamily: "monospace",
              textShadow:
                "1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000",
              pointerEvents: "none",
              zIndex: 1,
            }}
          >
            {agent.hp}
          </div>
        </div>
      </div>

      {prayerPointLabel !== null ? (
        <div
          className="streaming-agent-prayer-resource"
          aria-label={`${agent.name} prayer points ${prayerPointLabel} of ${agent.prayerMaxPoints ?? 1}`}
          data-prayer-point-units={agent.prayerPointUnits}
          title={`Exact resource: ${agent.prayerPointUnits} units`}
          style={{
            alignSelf: isRight ? "flex-end" : "flex-start",
            color: "#8fd8ff",
            background: "rgba(0, 16, 35, 0.82)",
            border: "1px solid rgba(143, 216, 255, 0.7)",
            borderRadius: 3,
            font: "800 0.7rem/1.2 monospace",
            letterSpacing: "0.04em",
            margin: "2px 8px 0",
            padding: "2px 7px",
            textShadow: "0 0 6px rgba(80, 180, 255, 0.65)",
          }}
        >
          PRAYER {prayerPointLabel}/{agent.prayerMaxPoints ?? 1}
        </div>
      ) : null}

      {/* Bottom: DMG + equipment + inventory */}
      <div
        className="streaming-agent-loadout"
        style={{
          display: "flex",
          width: "100%",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginTop: 4,
          padding: "0 6px",
          gap: 2,
          flexDirection: isRight ? "row-reverse" : "row",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.8)",
            border: "2px solid #ff0d3c",
            padding: "5px 15px",
            transform: skewDir,
            minWidth: 82,
            boxShadow: "0 0 10px rgba(255,13,60,0.3)",
          }}
        >
          <div
            style={{
              color: "#ff0d3c",
              fontSize: "1.55rem",
              fontWeight: 900,
              lineHeight: 1,
              textShadow: "0 0 8px rgba(255,13,60,0.6)",
            }}
          >
            {agent.damageDealtThisFight}
          </div>
          <div
            style={{
              color: "#fff",
              fontSize: "0.65rem",
              fontWeight: 800,
              letterSpacing: 2,
              marginTop: 2,
            }}
          >
            DMG
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flex: 1,
            minWidth: 0,
            gap: 6,
            background: "rgba(0,0,0,0.6)",
            padding: "3px 6px",
            minHeight: 56,
            border: "1px solid rgba(255,255,255,0.2)",
            transform: skewDir,
            flexDirection: isRight ? "row-reverse" : "row",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(17, minmax(0, 1fr))",
              gridTemplateRows: "repeat(2, minmax(0, 1fr))",
              gap: 2,
              flex: 1,
              minWidth: 0,
              width: "100%",
            }}
          >
            {renderEquipmentAndInventoryGrid(
              equippedCells,
              inventoryBySlot,
              resolvedItemIconMap,
              isRight,
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Equipment + Inventory grid renderer (17 cols x 2 rows)
// ---------------------------------------------------------------------------

function renderEquipmentAndInventoryGrid(
  equippedCells: (string | null)[],
  inventoryBySlot: Map<
    number,
    { slot: number; itemId: string; quantity: number }
  >,
  itemIconMap: Record<string, string>,
  isRight: boolean,
): React.ReactNode[] {
  const equippedSection = equippedCells.map((itemId, idx) => {
    const normalizedItemId =
      itemId && itemId.endsWith("_noted")
        ? itemId.replace(/_noted$/, "")
        : itemId;
    const iconUrl = normalizedItemId
      ? (itemIconMap[itemId ?? ""] ?? itemIconMap[normalizedItemId] ?? null)
      : null;

    return (
      <div
        key={`equipped-${idx}-${itemId ?? "empty"}`}
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "1 / 1",
          background: "rgba(255,255,255,0.05)",
          border: itemId
            ? "1px solid rgba(100,200,255,0.6)"
            : "1px solid rgba(100,200,255,0.2)",
          borderRadius: 2,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "all 0.2s",
        }}
      >
        {itemId ? (
          <StreamItemIcon
            itemId={normalizedItemId || itemId}
            iconUrl={iconUrl}
            fallbackSlot={idx}
          />
        ) : null}
      </div>
    );
  });

  const inventorySection = Array.from({ length: 28 }).map((_, i) => {
    const slotItem = inventoryBySlot.get(i);
    const hasItem = Boolean(slotItem);
    const itemId = slotItem?.itemId ?? "";
    const normalizedItemId = itemId.endsWith("_noted")
      ? itemId.replace(/_noted$/, "")
      : itemId;
    const iconUrl =
      itemIconMap[itemId] ?? itemIconMap[normalizedItemId] ?? null;

    return (
      <div
        key={`inv-${i}`}
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "1 / 1",
          background: "rgba(255,255,255,0.05)",
          border: hasItem
            ? "1px solid rgba(242,208,138,0.5)"
            : "1px solid rgba(255,255,255,0.08)",
          transition: "all 0.2s",
          overflow: "hidden",
          borderRadius: 2,
        }}
      >
        {hasItem ? (
          <StreamItemIcon
            itemId={normalizedItemId || "item"}
            iconUrl={iconUrl}
            fallbackSlot={i}
          />
        ) : null}
      </div>
    );
  });

  // Interleave: 3 equipment + 14 inventory per row, direction-aware
  const rows: React.ReactNode[] = [];
  for (let row = 0; row < 2; row++) {
    const eqRow = equippedSection.slice(row * 3, row * 3 + 3);
    const invRow = inventorySection.slice(row * 14, row * 14 + 14);
    if (isRight) {
      rows.push(...invRow, ...eqRow);
    } else {
      rows.push(...eqRow, ...invRow);
    }
  }
  return rows;
}
