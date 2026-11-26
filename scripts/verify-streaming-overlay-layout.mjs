#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const css = fs.readFileSync(
  path.join(
    workspaceRoot,
    "packages/client/src/components/streaming/StreamingOverlay.css",
  ),
  "utf8",
);
const captureDirectoryInput = process.env.STREAMING_LAYOUT_CAPTURE_DIR?.trim();
const captureDirectory = captureDirectoryInput
  ? path.resolve(workspaceRoot, captureDirectoryInput)
  : null;
if (captureDirectory) {
  fs.mkdirSync(captureDirectory, { recursive: true });
}

const viewports = [
  { name: "hd-landscape", width: 1280, height: 720 },
  { name: "full-hd", width: 1920, height: 1080 },
  { name: "broadcast-4x3", width: 1024, height: 768 },
  { name: "square", width: 1080, height: 1080 },
  { name: "mobile-portrait", width: 390, height: 844 },
  { name: "vertical-video", width: 1080, height: 1920 },
  { name: "mobile-landscape", width: 844, height: 390 },
];

function frozenLoadouts(side) {
  return `
    <section class="streaming-frozen-loadouts streaming-frozen-loadouts--${side}" data-loadout-fingerprint="0123456789abcdef">
      <div class="streaming-frozen-loadouts-header"><span>Frozen loadouts</span><span class="streaming-frozen-loadouts-fingerprint">01234567</span></div>
      <div class="streaming-frozen-loadouts-list">
        <div class="streaming-frozen-loadout-entry"><span class="streaming-frozen-loadout-role">melee</span><span class="streaming-frozen-loadout-details">Bronze Longsword · Wooden Shield</span></div>
        <div class="streaming-frozen-loadout-entry"><span class="streaming-frozen-loadout-role">ranged</span><span class="streaming-frozen-loadout-details">Shortbow · Iron Arrow</span></div>
        <div class="streaming-frozen-loadout-entry"><span class="streaming-frozen-loadout-role">mage</span><span class="streaming-frozen-loadout-details">Air Staff · Wind Strike</span></div>
      </div>
    </section>`;
}

function frozenStrategy(side) {
  return `
    <section class="streaming-frozen-strategy streaming-frozen-strategy--${side}" data-strategy-policy="duel-preparation-role-v3">
      <div class="streaming-frozen-strategy-header"><span>Committed strategy</span><span class="streaming-frozen-strategy-source">Agent-planned</span></div>
      <div class="streaming-frozen-strategy-primary"><strong>Balanced</strong><span>·</span><strong>Pressure</strong></div>
      <div class="streaming-frozen-strategy-details"><span>Aggressive attacks</span><span>Adaptive roles</span><span>Superhuman Strength</span></div>
      <div class="streaming-frozen-strategy-thresholds"><span>Recover 40%</span><span>Defend 30%</span></div>
    </section>`;
}

function agentCard(side, showFrozenLoadouts = false) {
  return `
    <section class="streaming-agent-stats streaming-agent-stats--${side}">
      <div class="streaming-agent-heading" style="display:flex;justify-content:space-between;align-items:flex-end;width:100%;padding:0 6px;font-family:Arial,sans-serif;text-transform:uppercase">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <span class="streaming-agent-rank" style="padding:2px 8px;background:#ff0d3c;color:#fff;font-weight:900">#1</span>
          <span class="streaming-agent-name" style="color:#fff;font-size:1.2rem;font-weight:900">Riven Ash the Unbroken</span>
        </div>
        <div class="streaming-agent-records" style="padding:2px 10px;background:rgba(0,0,0,.7);color:#f2d08a">OVR 3-1 / H2H 2-1</div>
      </div>
      ${showFrozenLoadouts ? `${frozenStrategy(side)}${frozenLoadouts(side)}` : ""}
      <div style="width:100%;height:28px;background:#0fc"></div>
      <div class="streaming-agent-prayer-resource" style="margin:2px 8px 0;padding:2px 7px">PRAYER 39/39</div>
      <div class="streaming-agent-loadout" style="width:100%;height:64px;background:#111"></div>
    </section>`;
}

function announcementMarkup() {
  return `
    <div class="streaming-overlay-root streaming-overlay-phase--announcement" style="position:absolute;inset:0;overflow:hidden">
      ${bettingRail("open")}
      <div class="streaming-between-strip">
        ${agentCard("left", true)}
        <div class="streaming-between-center">
          <span class="streaming-between-eyebrow">Matchup set</span>
          <span class="streaming-between-title">Matchup locked</span>
          <span class="streaming-between-matchup-compact">Riven Ash the Unbroken vs Astra Vale the Relentless</span>
          <div class="streaming-between-timer-wrap"><div class="streaming-between-timer-inner">1:48</div></div>
          <span>Starts in</span>
        </div>
        ${agentCard("right", true)}
      </div>
      ${lowerThird()}
    </div>`;
}

function timer() {
  return `
    <div class="streaming-fight-timer">
      <span class="streaming-fight-timer-eyebrow">Round timer</span>
      <div class="streaming-fight-timer-outer">
        <div class="streaming-fight-timer-inner" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center">0:48</div>
      </div>
    </div>`;
}

function lowerThird(status = "Live — round in progress") {
  return `
    <footer class="streaming-lower-third">
      <div class="streaming-lower-third-brand">
        <span class="streaming-lower-third-mark">Hyperia</span>
        <span>·</span><span class="streaming-lower-third-sub">AI duel arena</span>
      </div>
      <p class="streaming-lower-third-status">${status}</p>
    </footer>`;
}

function bettingRail(state) {
  const headline =
    state === "done"
      ? "Fight over"
      : state === "locked"
        ? "Betting locked"
        : "Betting open";
  return `
    <aside class="streaming-betting-rail streaming-betting-rail--${state}">
      <div class="streaming-betting-rail-eyebrow">Pick a side</div>
      <div class="streaming-betting-rail-title">Riven Ash vs Astra Vale</div>
      <div class="streaming-betting-rail-headline">${headline}</div>
      <p class="streaming-betting-rail-sub">Wagers lock at the announced deadline. Closes in 0:48.</p>
      <a class="streaming-betting-rail-cta"><span class="streaming-betting-rail-cta-state">${headline}</span><span>Open betting app</span></a>
      <p class="streaming-betting-rail-hint">Native SOL market</p>
    </aside>`;
}

function activeMarkup() {
  return `
    <div class="streaming-overlay-root streaming-overlay-phase--fighting" style="position:absolute;inset:0;overflow:hidden">
      <div class="streaming-combat-log" style="position:absolute;top:72px;left:16px;width:268px;height:180px"></div>
      ${bettingRail("locked")}
      <div class="streaming-duel-info">
        ${agentCard("left")}${timer()}${agentCard("right")}
      </div>
      ${lowerThird()}
    </div>`;
}

function resolutionMarkup() {
  return `
    <div class="streaming-overlay-root streaming-overlay-phase--resolution" style="position:absolute;inset:0;overflow:hidden">
      ${bettingRail("done")}
      <div class="streaming-between-strip">
        ${agentCard("left")}
        <div class="streaming-between-center">
          <span class="streaming-between-eyebrow">Winner</span>
          <span class="streaming-between-title">Riven Ash the Unbroken</span>
          <div class="streaming-between-timer-wrap"><div class="streaming-between-timer-inner">0:08</div></div>
          <span>Next duel</span>
        </div>
        ${agentCard("right")}
      </div>
      <div class="streaming-post-fight-position">
        <div class="streaming-post-fight-card" style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px 20px;background:rgba(0,0,0,.72);border:1px solid rgba(255,255,255,.1);border-radius:8px">
          <div style="width:100%;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,.08);color:rgba(148,163,184,.8);font:700 11.2px Arial,sans-serif;letter-spacing:.12em;text-align:center;text-transform:uppercase">Knockout</div>
          <div class="streaming-post-fight-table" style="display:flex;width:100%">
            <div class="streaming-post-fight-agent streaming-post-fight-agent--left" style="display:flex;flex:1;flex-direction:column;gap:2.4px">
              <div class="streaming-post-fight-agent-name" style="color:#f2d08a;font:700 13.6px Impact,sans-serif;letter-spacing:.04em;text-transform:uppercase;height:32px;display:flex;align-items:center">Riven Ash the Unbroken <span style="font-size:12px">♛</span></div>
              <div class="streaming-post-fight-stat-value">128</div><div class="streaming-post-fight-stat-value">19</div><div class="streaming-post-fight-stat-value">11</div><div class="streaming-post-fight-stat-value">2</div>
            </div>
            <div style="display:flex;flex:0 0 auto;min-width:90px;padding:0 8px;flex-direction:column;align-items:center;gap:2.4px;color:rgba(148,163,184,.7);font:600 10.4px Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase"><div style="height:32px"></div><div class="streaming-post-fight-stat-label">Damage</div><div class="streaming-post-fight-stat-label">Highest Hit</div><div class="streaming-post-fight-stat-label">Attacks</div><div class="streaming-post-fight-stat-label">Heals</div></div>
            <div class="streaming-post-fight-agent streaming-post-fight-agent--right" style="display:flex;flex:1;flex-direction:column;gap:2.4px">
              <div class="streaming-post-fight-agent-name" style="color:#94a3b8;font:700 13.6px Impact,sans-serif;letter-spacing:.04em;text-transform:uppercase;height:32px;display:flex;align-items:center">Astra Vale the Relentless</div>
              <div class="streaming-post-fight-stat-value">96</div><div class="streaming-post-fight-stat-value">14</div><div class="streaming-post-fight-stat-value">9</div><div class="streaming-post-fight-stat-value">3</div>
            </div>
          </div>
        </div>
      </div>
      ${lowerThird("Round complete — market settlement follows the official result")}
    </div>`;
}

function overlaps(first, second) {
  if (!first || !second) return false;
  return (
    Math.min(first.right, second.right) - Math.max(first.left, second.left) >
      1 &&
    Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 1
  );
}

function horizontalOverlap(first, second) {
  return (
    Math.min(first.right, second.right) - Math.max(first.left, second.left)
  );
}

function announcementClearRatioMinimum(viewport) {
  if (viewport.height <= 560 && viewport.width > viewport.height) return 0.3;
  if (viewport.width <= 520) return 0.48;
  if (viewport.height >= 900) return 0.68;
  return 0.57;
}

const browser = await chromium.launch({ headless: true });
const failures = [];
let assertions = 0;

try {
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport });
    for (const [scenario, markup] of [
      ["active", activeMarkup()],
      ["announcement", announcementMarkup()],
      ["resolution", resolutionMarkup()],
    ]) {
      await page.setContent(`
        <!doctype html>
        <html><head><style>
          * { box-sizing: border-box; }
          html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #000; }
          .streaming-post-fight-stat-value,
          .streaming-post-fight-stat-label {
            display: flex;
            align-items: center;
            height: 32px;
          }
          .streaming-post-fight-stat-value {
            color: #e2e8f0;
            font: 600 16px Arial, sans-serif;
          }
          .streaming-post-fight-agent--left .streaming-post-fight-stat-value {
            justify-content: flex-end;
          }
          .streaming-post-fight-agent--right .streaming-post-fight-stat-value {
            justify-content: flex-start;
          }
          .streaming-post-fight-stat-label {
            justify-content: center;
          }
          ${css}
        </style></head><body>${markup}</body></html>
      `);
      await page.waitForTimeout(850);

      if (captureDirectory) {
        await page.screenshot({
          path: path.join(captureDirectory, `${scenario}-${viewport.name}.png`),
          fullPage: true,
        });
      }

      const geometry = await page.evaluate(() => {
        const hasClippedContent = (element) => {
          if (!element) return false;
          const elementRect = element.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          const textRects = Array.from(range.getClientRects());
          return (
            element.scrollWidth > element.clientWidth + 1 ||
            element.scrollHeight > element.clientHeight + 1 ||
            textRects.some(
              (rect) =>
                rect.left < elementRect.left - 1 ||
                rect.right > elementRect.right + 1 ||
                rect.top < elementRect.top - 1 ||
                rect.bottom > elementRect.bottom + 1,
            )
          );
        };
        const identitySelectors = [
          ".streaming-agent-stats--left .streaming-agent-name",
          ".streaming-agent-stats--right .streaming-agent-name",
        ];
        const resultIdentitySelectors = [
          ".streaming-post-fight-agent--left .streaming-post-fight-agent-name",
          ".streaming-post-fight-agent--right .streaming-post-fight-agent-name",
        ];
        const selectors = [
          ".streaming-duel-info",
          ".streaming-between-strip",
          ".streaming-agent-stats--left",
          ".streaming-agent-stats--right",
          ".streaming-agent-stats--left .streaming-agent-name",
          ".streaming-agent-stats--right .streaming-agent-name",
          ".streaming-between-center",
          ".streaming-frozen-loadouts--left",
          ".streaming-frozen-loadouts--right",
          ".streaming-frozen-strategy--left",
          ".streaming-frozen-strategy--right",
          ".streaming-agent-stats--left .streaming-agent-prayer-resource",
          ".streaming-agent-stats--left .streaming-agent-loadout",
          ".streaming-fight-timer",
          ".streaming-combat-log",
          ".streaming-betting-rail",
          ".streaming-post-fight-position",
          ".streaming-lower-third",
          ".streaming-betting-rail-cta",
        ];
        const boxes = Object.fromEntries(
          selectors.map((selector) => {
            const element = document.querySelector(selector);
            if (!element || getComputedStyle(element).display === "none") {
              return [selector, null];
            }
            const rect = element.getBoundingClientRect();
            return [
              selector,
              {
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
              },
            ];
          }),
        );
        return {
          boxes,
          clippedIdentities: Object.fromEntries(
            identitySelectors.map((selector) => {
              const element = document.querySelector(selector);
              return [selector, hasClippedContent(element)];
            }),
          ),
          clippedResultIdentities: Object.fromEntries(
            resultIdentitySelectors.map((selector) => {
              const element = document.querySelector(selector);
              return [selector, hasClippedContent(element)];
            }),
          ),
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          width: window.innerWidth,
          height: window.innerHeight,
        };
      });

      const topHud =
        geometry.boxes[".streaming-between-strip"] ??
        geometry.boxes[".streaming-duel-info"];
      const bottomHud = geometry.boxes[".streaming-lower-third"];
      if (topHud && bottomHud) {
        const bettingRail = geometry.boxes[".streaming-betting-rail"];
        const centralActionBand = {
          left: geometry.width * 0.3,
          right: geometry.width * 0.7,
        };
        const actionClearBottom =
          bettingRail &&
          horizontalOverlap(bettingRail, centralActionBand) > 1 &&
          bettingRail.top > topHud.bottom
            ? Math.min(bottomHud.top, bettingRail.top)
            : bottomHud.top;
        const actionClearRatio =
          (actionClearBottom - topHud.bottom) / geometry.height;
        const leftCard = geometry.boxes[".streaming-agent-stats--left"];
        console.log(
          JSON.stringify({
            metric: "arena_vertical_clearance",
            viewport: viewport.name,
            scenario,
            topHudBottom: Math.round(topHud.bottom),
            bottomHudTop: Math.round(bottomHud.top),
            clearPixels: Math.round(bottomHud.top - topHud.bottom),
            clearRatio: Number(
              ((bottomHud.top - topHud.bottom) / geometry.height).toFixed(3),
            ),
            actionClearRatio: Number(actionClearRatio.toFixed(3)),
            leftCardWidth: leftCard
              ? Math.round(leftCard.right - leftCard.left)
              : null,
          }),
        );

        if (scenario === "announcement") {
          assertions += 10;
          const minimumClearRatio = announcementClearRatioMinimum(viewport);
          if (actionClearRatio < minimumClearRatio) {
            failures.push({
              viewport: viewport.name,
              scenario,
              reason: "insufficient_central_arena_clearance",
              actual: Number(actionClearRatio.toFixed(3)),
              expectedMinimum: minimumClearRatio,
            });
          }

          if (
            viewport.width >= 721 &&
            viewport.width / viewport.height >= 0.75 &&
            leftCard &&
            (leftCard.right - leftCard.left) / viewport.width > 0.31
          ) {
            failures.push({
              viewport: viewport.name,
              scenario,
              reason: "fighter_card_too_wide_for_arena",
              actual: Number(
                ((leftCard.right - leftCard.left) / viewport.width).toFixed(3),
              ),
              expectedMaximum: 0.31,
            });
          }

          const lowerThirdWidth = bottomHud.right - bottomHud.left;
          if (viewport.width >= 721 && lowerThirdWidth > 561) {
            failures.push({
              viewport: viewport.name,
              scenario,
              reason: "lower_third_too_wide_for_arena",
              actual: Math.round(lowerThirdWidth),
              expectedMaximum: 560,
            });
          }

          if (bettingRail && bettingRail.right - bettingRail.left > 561) {
            failures.push({
              viewport: viewport.name,
              scenario,
              reason: "betting_rail_too_wide_for_arena",
              actual: Math.round(bettingRail.right - bettingRail.left),
              expectedMaximum: 560,
            });
          }

          for (const selector of [
            ".streaming-frozen-strategy--left",
            ".streaming-frozen-strategy--right",
            ".streaming-frozen-loadouts--left",
            ".streaming-frozen-loadouts--right",
          ]) {
            if (!geometry.boxes[selector]) {
              failures.push({
                viewport: viewport.name,
                scenario,
                reason: "missing_pre_bell_decision_signal",
                selector,
              });
            }
          }

          for (const selector of [
            ".streaming-agent-stats--left .streaming-agent-prayer-resource",
            ".streaming-agent-stats--left .streaming-agent-loadout",
          ]) {
            if (geometry.boxes[selector]) {
              failures.push({
                viewport: viewport.name,
                scenario,
                reason: "redundant_announcement_chrome_visible",
                selector,
              });
            }
          }
        }
      }

      // Desktop and broadcast layouts have enough space to preserve exact
      // contestant identity in every phase. Checking only the announcement
      // misses the active-fight row, where the immutable records compete with
      // the name for width and a real 1280x720 stream previously ellipsized
      // both contestants to the same unreadable prefix.
      if (viewport.width >= 721) {
        assertions += 2;
        for (const [selector, clipped] of Object.entries(
          geometry.clippedIdentities,
        )) {
          if (clipped) {
            failures.push({
              viewport: viewport.name,
              scenario,
              reason: "agent_identity_clipped",
              selector,
            });
          }
        }
      }
      if (scenario === "resolution") {
        for (const [selector, clipped] of Object.entries(
          geometry.clippedResultIdentities,
        )) {
          assertions++;
          if (clipped) {
            failures.push({
              viewport: viewport.name,
              scenario,
              selector,
              reason: "post_fight_agent_identity_clipped",
            });
          }
        }
      }

      if (
        viewport.height <= 560 &&
        scenario !== "resolution" &&
        geometry.boxes[".streaming-betting-rail-cta"]
      ) {
        assertions += 1;
        const cta = geometry.boxes[".streaming-betting-rail-cta"];
        if (cta.bottom - cta.top < 44) {
          failures.push({
            viewport: viewport.name,
            scenario,
            reason: "betting_cta_below_touch_target",
            actual: cta.bottom - cta.top,
            expectedMinimum: 44,
          });
        }
      }

      for (const [selector, box] of Object.entries(geometry.boxes)) {
        if (!box) continue;
        assertions += 1;
        if (
          box.left < -1 ||
          box.top < -1 ||
          box.right > geometry.width + 1 ||
          box.bottom > geometry.height + 1
        ) {
          failures.push({ viewport: viewport.name, scenario, selector, box });
        }
      }

      assertions += 2;
      if (geometry.scrollWidth > geometry.width) {
        failures.push({
          viewport: viewport.name,
          scenario,
          reason: "horizontal_overflow",
          actual: geometry.scrollWidth,
          expected: geometry.width,
        });
      }
      if (geometry.scrollHeight > geometry.height) {
        failures.push({
          viewport: viewport.name,
          scenario,
          reason: "vertical_overflow",
          actual: geometry.scrollHeight,
          expected: geometry.height,
        });
      }

      const boxes = geometry.boxes;
      if (viewport.name === "broadcast-4x3" && scenario === "active") {
        assertions += 2;
        if (boxes[".streaming-combat-log"] !== null) {
          failures.push({
            viewport: viewport.name,
            scenario,
            reason: "combat_log_occludes_4x3_gameplay",
          });
        }
        if (boxes[".streaming-betting-rail"] !== null) {
          failures.push({
            viewport: viewport.name,
            scenario,
            reason: "locked_betting_rail_occludes_4x3_gameplay",
          });
        }
      }
      const collisionPairs =
        scenario === "active"
          ? [
              [".streaming-agent-stats--left", ".streaming-combat-log"],
              [".streaming-agent-stats--right", ".streaming-betting-rail"],
              [".streaming-betting-rail", ".streaming-lower-third"],
            ]
          : scenario === "announcement"
            ? [
                [
                  ".streaming-agent-stats--left .streaming-agent-name",
                  ".streaming-between-center",
                ],
                [
                  ".streaming-agent-stats--right .streaming-agent-name",
                  ".streaming-between-center",
                ],
                [".streaming-agent-stats--right", ".streaming-betting-rail"],
                [".streaming-betting-rail", ".streaming-lower-third"],
              ]
            : [
                [".streaming-post-fight-position", ".streaming-betting-rail"],
                [".streaming-post-fight-position", ".streaming-lower-third"],
              ];

      for (const [first, second] of collisionPairs) {
        assertions += 1;
        if (overlaps(boxes[first], boxes[second])) {
          failures.push({
            viewport: viewport.name,
            scenario,
            reason: "hud_collision",
            first,
            second,
          });
        }
      }
    }
    await page.close();
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, assertions, failures }, null, 2));
  process.exit(1);
}

console.log(
  JSON.stringify({
    ok: true,
    viewports: viewports.length,
    scenariosPerViewport: 3,
    assertions,
    capturedScreenshots: captureDirectory ? viewports.length * 3 : 0,
  }),
);
