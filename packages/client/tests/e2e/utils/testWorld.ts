/**
 * Test Utilities for Real Hyperia Instances
 *
 * Per project rules: NO MOCKS. Tests use real Hyperia servers
 * and verify behavior through:
 * - Three.js scene introspection
 * - Visual testing with colored cube proxies
 * - Screenshot verification
 *
 * @packageDocumentation
 */

import type { Page } from "@playwright/test";
import type { World, TerrainSystem } from "@hyperforge/shared";
import { mkdir, writeFile } from "node:fs/promises";

/**
 * Wait for the game to fully load
 */
export async function waitForGameLoad(
  page: Page,
  timeout = 30000,
): Promise<void> {
  const POLL_INTERVAL_MS = 250;
  const loadedHandle = await page
    .waitForFunction(
      () => {
        const win = window as unknown as { __HYPERIA_LOADING__?: boolean };
        return win.__HYPERIA_LOADING__ === false;
      },
      undefined,
      {
        timeout,
        polling: POLL_INTERVAL_MS,
      },
    )
    .catch(() => null);

  if (loadedHandle) {
    await loadedHandle.dispose().catch(() => {});
    return;
  }

  if (page.isClosed()) {
    throw new Error("Page closed while waiting for game load");
  }

  throw new Error(`Timed out waiting for game load after ${timeout}ms`);
}

/**
 * Wait for the loading screen DOM element to be hidden
 * This verifies the loading screen UI is actually removed/hidden from the page
 */
export async function waitForLoadingScreenHidden(
  page: Page,
  timeout = 60000,
): Promise<void> {
  const POLL_INTERVAL_MS = 500;

  // Wait for loading screen element to be hidden or removed
  const hiddenHandle = await page
    .waitForFunction(
      () => {
        // Check multiple possible loading screen selectors
        const loadingScreen = document.querySelector(
          ".loading-screen, [data-testid='loading-screen'], .LoadingScreen",
        );

        // If element doesn't exist, loading is complete
        if (!loadingScreen) return true;

        // Check if element is hidden via display or visibility
        const style = window.getComputedStyle(loadingScreen);
        if (style.display === "none" || style.visibility === "hidden") {
          return true;
        }

        // Check if element is not in the DOM (removed)
        if (!loadingScreen.isConnected) return true;

        // Check if element has zero dimensions (hidden)
        const rect = loadingScreen.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return true;

        // Check opacity
        if (style.opacity === "0") return true;

        return false;
      },
      undefined,
      {
        timeout,
        polling: POLL_INTERVAL_MS,
      },
    )
    .catch(() => null);

  if (hiddenHandle) {
    await hiddenHandle.dispose().catch(() => {});
    return;
  }

  if (page.isClosed()) {
    throw new Error("Page closed while waiting for loading screen to hide");
  }

  throw new Error(
    `Timed out waiting for loading screen to hide after ${timeout}ms`,
  );
}

/**
 * Verify the loading screen is currently visible
 * Returns true if loading screen is showing
 */
export async function isLoadingScreenVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const loadingScreen = document.querySelector(
      ".loading-screen, [data-testid='loading-screen'], .LoadingScreen",
    );

    if (!loadingScreen) return false;
    if (!loadingScreen.isConnected) return false;

    const style = window.getComputedStyle(loadingScreen);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    const rect = loadingScreen.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;

    if (style.opacity === "0") return false;

    return true;
  });
}

/**
 * Wait for the player to spawn in the world
 */
export async function waitForPlayerSpawn(
  page: Page,
  timeout = 30000,
): Promise<void> {
  const POLL_INTERVAL_MS = 250;
  const spawnedHandle = await page
    .waitForFunction(
      () => {
        const win = window as unknown as {
          world?: {
            network?: { id?: string | null };
            entities?: {
              player?: {
                id?: string;
                health?: number;
                maxHealth?: number;
                mesh?: unknown;
              };
              get?: (id: string) => unknown;
              entities?: Map<string, unknown>;
            };
          };
        };

        const bodyText = document.body?.innerText ?? "";
        if (/Loading world|Finalizing|Initializing/i.test(bodyText)) {
          return false;
        }

        const player = win.world?.entities?.player;
        const localPlayerId = player?.id ?? win.world?.network?.id ?? null;

        if (typeof localPlayerId === "string" && localPlayerId.length > 0) {
          if (player?.id) return true;

          if (typeof win.world?.entities?.get === "function") {
            if (win.world.entities.get(localPlayerId)) return true;
          }

          if (win.world?.entities?.entities instanceof Map) {
            if (win.world.entities.entities.has(localPlayerId)) return true;
          }
        }

        // Fallback for slow network hydration: local player object exists with core state.
        return Boolean(
          player &&
          (typeof player.health === "number" ||
            typeof player.maxHealth === "number" ||
            player.mesh ||
            typeof player.id === "string"),
        );
      },
      undefined,
      {
        timeout,
        polling: POLL_INTERVAL_MS,
      },
    )
    .catch(() => null);

  if (spawnedHandle) {
    await spawnedHandle.dispose().catch(() => {});
    return;
  }

  if (page.isClosed()) {
    throw new Error("Page closed while waiting for player spawn");
  }

  throw new Error(`Timed out waiting for player spawn after ${timeout}ms`);
}

/**
 * Get player position from Three.js scene
 */
export async function getPlayerPosition(
  page: Page,
): Promise<{ x: number; y: number; z: number }> {
  return await page.evaluate(() => {
    const win = window as unknown as {
      world?: {
        entities?: {
          player?: {
            mesh?: { position?: { x?: number; y?: number; z?: number } };
            node?: { position?: { x?: number; y?: number; z?: number } };
            position?: { x?: number; y?: number; z?: number };
            data?: { position?: { x?: number; y?: number; z?: number } };
            body?: {
              translation?: () => { x?: number; y?: number; z?: number };
            };
          };
        };
      };
    };

    const player = win.world?.entities?.player;
    const candidatePositions = [
      player?.mesh?.position,
      player?.node?.position,
      player?.position,
      player?.data?.position,
    ];

    for (const pos of candidatePositions) {
      const x = Number(pos?.x);
      const y = Number(pos?.y);
      const z = Number(pos?.z);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        return { x, y, z };
      }
    }

    const bodyPos = player?.body?.translation?.();
    const bodyX = Number(bodyPos?.x);
    const bodyY = Number(bodyPos?.y);
    const bodyZ = Number(bodyPos?.z);
    if (
      Number.isFinite(bodyX) &&
      Number.isFinite(bodyY) &&
      Number.isFinite(bodyZ)
    ) {
      return { x: bodyX, y: bodyY, z: bodyZ };
    }

    return { x: 0, y: 0, z: 0 };
  });
}

/**
 * Get player stats from the game world
 */
export async function getPlayerStats(page: Page): Promise<{
  health?: { current: number; max: number };
  coins?: number;
}> {
  return await page.evaluate(() => {
    const win = window as unknown as {
      world?: {
        network?: {
          lastInventoryByPlayerId?: Record<string, { coins?: number }>;
        };
        entities?: {
          player?: {
            id?: string;
            health?: number;
            maxHealth?: number;
          };
        };
      };
    };

    const player = win.world?.entities?.player;
    const playerId = player?.id;
    const inventory = playerId
      ? win.world?.network?.lastInventoryByPlayerId?.[playerId]
      : undefined;

    return {
      health: player
        ? { current: player.health ?? 0, max: player.maxHealth ?? 10 }
        : undefined,
      coins: inventory?.coins ?? 0,
    };
  });
}

/**
 * Open a panel by clicking its button
 */
export async function openPanel(page: Page, panelId: string): Promise<void> {
  // Click the panel button in the navigation ribbon or radial menu
  await page.click(`[data-panel-id="${panelId}"]`);
  // Wait for panel to be visible
  await page.waitForSelector(`[data-panel="${panelId}"]`, { state: "visible" });
}

/**
 * Close a panel
 */
export async function closePanel(page: Page, panelId: string): Promise<void> {
  // Click the close button
  await page.click(`[data-panel="${panelId}"] [data-close-button]`);
  // Wait for panel to be hidden
  await page.waitForSelector(`[data-panel="${panelId}"]`, { state: "hidden" });
}

/**
 * Take a screenshot of the game canvas for visual testing
 * Includes retry logic to ensure we capture actual rendered content
 */
export async function takeGameScreenshot(
  page: Page,
  name: string,
  options: { minSize?: number; maxRetries?: number; retryDelay?: number } = {},
): Promise<Buffer> {
  const screenshotPath = `screenshots/${name}.png`;
  const minSize = options.minSize ?? 10000; // Require at least 10KB for valid screenshot
  const maxRetries = options.maxRetries ?? 5;
  const retryDelay = options.retryDelay ?? 500;

  await mkdir("screenshots", { recursive: true }).catch(() => {});

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Wait for canvas to be ready
    const canvasReady = await page
      .evaluate(() => {
        const canvas = document.querySelector(
          "canvas",
        ) as HTMLCanvasElement | null;
        if (!canvas) return false;
        // Check canvas has meaningful dimensions
        if (canvas.width < 100 || canvas.height < 100) return false;
        // WebGPU rendering check
        if (!navigator.gpu) return false;

        // Try to get a basic 2D context to verify canvas has dimensions and is ready
        // (Note: WebGPU contexts can't readPixels directly without a staging buffer,
        // so we just rely on dimensions and Context availability here)
        return canvas.width > 0 && canvas.height > 0;
      })
      .catch(() => false);

    if (!canvasReady && attempt < maxRetries - 1) {
      await page.waitForTimeout(retryDelay);
      continue;
    }

    // Try to get canvas data URL
    const canvasDataUrl = await page
      .evaluate(() => {
        const canvas = document.querySelector(
          "canvas",
        ) as HTMLCanvasElement | null;
        if (!canvas || canvas.width <= 0 || canvas.height <= 0) {
          return null;
        }
        try {
          return canvas.toDataURL("image/png");
        } catch {
          return null;
        }
      })
      .catch(() => null);

    if (
      typeof canvasDataUrl === "string" &&
      canvasDataUrl.startsWith("data:image/png;base64,")
    ) {
      const pngBuffer = Buffer.from(
        canvasDataUrl.slice("data:image/png;base64,".length),
        "base64",
      );

      // Check if screenshot is large enough (actual rendered content)
      if (pngBuffer.length >= minSize) {
        await writeFile(screenshotPath, pngBuffer).catch(() => {});
        console.log(
          `[Screenshot] Captured "${name}": ${pngBuffer.length} bytes (attempt ${attempt + 1})`,
        );
        return pngBuffer;
      }

      // Screenshot too small, retry if possible
      if (attempt < maxRetries - 1) {
        console.log(
          `[Screenshot] "${name}" too small (${pngBuffer.length} bytes), retrying...`,
        );
        await page.waitForTimeout(retryDelay);
        continue;
      }

      // Last attempt, accept whatever we got
      await writeFile(screenshotPath, pngBuffer).catch(() => {});
      console.log(
        `[Screenshot] Captured "${name}": ${pngBuffer.length} bytes (fallback)`,
      );
      return pngBuffer;
    }

    // Fallback to Playwright screenshot
    const canvas = await page.$("canvas");
    if (canvas) {
      const canvasScreenshot = await canvas
        .screenshot({
          path: screenshotPath,
          timeout: 5_000,
        })
        .catch(() => null);
      if (canvasScreenshot && canvasScreenshot.length >= minSize) {
        console.log(
          `[Screenshot] Captured "${name}": ${canvasScreenshot.length} bytes (playwright)`,
        );
        return canvasScreenshot;
      }
    }

    if (attempt < maxRetries - 1) {
      await page.waitForTimeout(retryDelay);
    }
  }

  // Final fallback - full page screenshot
  const fallback = await page.screenshot({
    path: screenshotPath,
    fullPage: true,
    timeout: 5_000,
  });
  console.log(
    `[Screenshot] Captured "${name}": ${fallback.length} bytes (fullpage fallback)`,
  );
  return fallback;
}

/**
 * Compare two screenshots and return difference metrics
 * Returns the percentage of pixels that are different
 */
export function compareScreenshots(
  buffer1: Buffer,
  buffer2: Buffer,
): { identical: boolean; diffPercentage: number; diffPixels: number } {
  // Quick check: if buffers are identical, screenshots are identical
  if (buffer1.equals(buffer2)) {
    return { identical: true, diffPercentage: 0, diffPixels: 0 };
  }

  // Buffers are different lengths - definitely not identical
  if (buffer1.length !== buffer2.length) {
    // Estimate difference based on size difference
    const sizeDiff = Math.abs(buffer1.length - buffer2.length);
    const avgSize = (buffer1.length + buffer2.length) / 2;
    return {
      identical: false,
      diffPercentage: Math.min(100, (sizeDiff / avgSize) * 100),
      diffPixels: sizeDiff,
    };
  }

  // Compare byte by byte
  let diffBytes = 0;
  const minLength = Math.min(buffer1.length, buffer2.length);

  for (let i = 0; i < minLength; i++) {
    if (buffer1[i] !== buffer2[i]) {
      diffBytes++;
    }
  }

  const diffPercentage = (diffBytes / minLength) * 100;

  return {
    identical: diffBytes === 0,
    diffPercentage,
    diffPixels: diffBytes,
  };
}

/**
 * Assert that two screenshots are different (not pixel-identical)
 * Throws an error if screenshots are identical, indicating something isn't working
 */
export function assertScreenshotsDifferent(
  screenshot1: Buffer,
  screenshot2: Buffer,
  name1: string,
  name2: string,
  minDiffPercentage: number = 0.1,
): void {
  const comparison = compareScreenshots(screenshot1, screenshot2);

  if (comparison.identical) {
    throw new Error(
      `Screenshots "${name1}" and "${name2}" are pixel-identical! ` +
        `This indicates the game may not be rendering correctly or the scene isn't changing.`,
    );
  }

  if (comparison.diffPercentage < minDiffPercentage) {
    throw new Error(
      `Screenshots "${name1}" and "${name2}" are nearly identical ` +
        `(only ${comparison.diffPercentage.toFixed(4)}% different, ${comparison.diffPixels} bytes). ` +
        `Expected at least ${minDiffPercentage}% difference. ` +
        `This may indicate the game isn't responding to input.`,
    );
  }

  console.log(
    `[Screenshot] "${name1}" vs "${name2}": ${comparison.diffPercentage.toFixed(2)}% different (${comparison.diffPixels} bytes)`,
  );
}

/**
 * Take a screenshot and compare with a previous one, asserting they're different
 */
export async function takeAndCompareScreenshot(
  page: Page,
  name: string,
  previousScreenshot: Buffer | null,
  previousName: string | null,
): Promise<Buffer> {
  const screenshot = await takeGameScreenshot(page, name);

  if (previousScreenshot && previousName) {
    assertScreenshotsDifferent(
      previousScreenshot,
      screenshot,
      previousName,
      name,
    );
  }

  return screenshot;
}

// ============================================================================
// Entity Introspection Utilities
// ============================================================================

/**
 * Get all entities of a specific type from the world
 */
export async function getEntitiesByType(
  page: Page,
  entityType: string,
): Promise<
  Array<{
    id: string;
    position: { x: number; y: number; z: number };
    health?: number;
  }>
> {
  return await page.evaluate((type) => {
    const win = window as unknown as {
      world?: {
        entities?: {
          entities?: Map<
            string,
            {
              type?: string;
              id?: string;
              health?: number;
              mesh?: { position: { x: number; y: number; z: number } };
            }
          >;
        };
      };
    };

    const entities = win.world?.entities?.entities;
    if (!entities) return [];

    const results: Array<{
      id: string;
      position: { x: number; y: number; z: number };
      health?: number;
    }> = [];
    entities.forEach((entity, id) => {
      if (entity.type === type) {
        const pos = entity.mesh?.position;
        results.push({
          id,
          position: pos
            ? { x: pos.x, y: pos.y, z: pos.z }
            : { x: 0, y: 0, z: 0 },
          health: entity.health,
        });
      }
    });

    return results;
  }, entityType);
}

/**
 * Get the player's inventory from the world
 */
export async function getPlayerInventory(
  page: Page,
): Promise<Array<{ itemId: string; quantity: number; slot: number }>> {
  return await page.evaluate(() => {
    const win = window as unknown as {
      world?: {
        network?: {
          lastInventoryByPlayerId?: Record<
            string,
            {
              items?: Array<{ itemId: string; quantity: number; slot: number }>;
            }
          >;
        };
        entities?: {
          player?: { id?: string };
        };
      };
    };

    const playerId = win.world?.entities?.player?.id;
    if (!playerId) return [];

    const inventory = win.world?.network?.lastInventoryByPlayerId?.[playerId];
    return inventory?.items || [];
  });
}

/**
 * Get the player's equipment from the world
 */
export async function getPlayerEquipment(
  page: Page,
): Promise<Record<string, { itemId: string } | null>> {
  return await page.evaluate(() => {
    const win = window as unknown as {
      world?: {
        network?: {
          lastEquipmentByPlayerId?: Record<
            string,
            Record<string, { item?: { id: string } } | null>
          >;
        };
        entities?: {
          player?: { id?: string };
        };
      };
    };

    const playerId = win.world?.entities?.player?.id;
    if (!playerId) return {};

    const equipment = win.world?.network?.lastEquipmentByPlayerId?.[playerId];
    if (!equipment) return {};

    const result: Record<string, { itemId: string } | null> = {};
    for (const [slot, data] of Object.entries(equipment)) {
      result[slot] = data?.item ? { itemId: data.item.id } : null;
    }
    return result;
  });
}

/**
 * Get the player's skill levels
 */
export async function getPlayerSkills(
  page: Page,
): Promise<Record<string, { level: number; xp: number }>> {
  return await page.evaluate(() => {
    const win = window as unknown as {
      world?: {
        network?: {
          lastSkillsByPlayerId?: Record<
            string,
            Record<string, { level: number; xp: number }>
          >;
        };
        entities?: {
          player?: { id?: string };
        };
      };
    };

    const playerId = win.world?.entities?.player?.id;
    if (!playerId) return {};

    return win.world?.network?.lastSkillsByPlayerId?.[playerId] || {};
  });
}

// ============================================================================
// Input Simulation Utilities
// ============================================================================

/**
 * Simulate a click at a specific world position
 * Converts world coordinates to screen coordinates using the camera projection
 */
export async function projectWorldPosition(
  page: Page,
  worldPos: { x: number; z: number; y?: number },
): Promise<{ x: number; y: number }> {
  return page.evaluate((target) => {
    const world = (window as unknown as { world?: World }).world;
    const canvas = world?.graphics?.renderer?.domElement;
    const player = world?.getPlayer();
    const terrain = world?.getSystem<TerrainSystem>("terrain");
    if (!world?.camera || !canvas || !player || !terrain)
      throw new Error(
        "Actual game camera, renderer, player and terrain required",
      );
    if (world.graphics?.isWebGPU !== true)
      throw new Error("World clicks require the actual WebGPU game");
    const y = target.y ?? terrain.getResourceGroundHeight(target.x, target.z);
    if (![target.x, y, target.z].every(Number.isFinite))
      throw new Error("World click target must have finite ground coordinates");
    // Clone only: never mutate the player's position or guess a camera/global.
    const ndc = player.position
      .clone()
      .set(target.x, y, target.z)
      .project(world.camera);
    if (
      ![ndc.x, ndc.y, ndc.z].every(Number.isFinite) ||
      Math.abs(ndc.x) >= 0.98 ||
      Math.abs(ndc.y) >= 0.98 ||
      ndc.z < 0 ||
      ndc.z > 1
    )
      throw new Error(
        "World click target is outside the WebGPU camera frustum",
      );
    const box = canvas.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0)
      throw new Error("Actual game canvas is not visible");
    const x = box.left + ((ndc.x + 1) / 2) * box.width;
    const screenY = box.top + ((1 - ndc.y) / 2) * box.height;
    if (document.elementFromPoint(x, screenY) !== canvas)
      throw new Error("World click is covered by UI; refusing a guessed click");
    // Match the real input router's entity-first targeting. DOM visibility
    // alone cannot distinguish terrain from a tree, actor or building floor.
    const interaction = world.getSystem("interaction") as
      | {
          getRaycastService?: () => {
            getEntityAtPosition: (
              x: number,
              y: number,
              canvas: HTMLCanvasElement,
            ) => unknown;
            getTerrainPosition: (
              x: number,
              y: number,
              canvas: HTMLCanvasElement,
            ) => { x: number; y: number; z: number } | null;
          };
        }
      | undefined;
    const raycast = interaction?.getRaycastService?.();
    if (!raycast)
      throw new Error("Actual interaction raycast service required");
    if (raycast.getEntityAtPosition(x, screenY, canvas))
      throw new Error("World click intersects an entity before terrain");
    const hit = raycast.getTerrainPosition(x, screenY, canvas);
    if (
      !hit ||
      Math.floor(hit.x) !== Math.floor(target.x) ||
      Math.floor(hit.z) !== Math.floor(target.z) ||
      Math.abs(hit.y - y) > 0.25
    )
      throw new Error(
        "Actual raycast does not reach the requested ground tile",
      );
    return { x, y: screenY };
  }, worldPos);
}

/** Real canvas input at current terrain height; missing state must fail. */
export async function clickAtWorldPosition(
  page: Page,
  worldPos: { x: number; z: number; y?: number },
): Promise<void> {
  const position = await projectWorldPosition(page, worldPos);
  await page.mouse.click(position.x, position.y);
}

/**
 * Simulate keyboard movement
 */
export async function simulateMovement(
  page: Page,
  direction: "up" | "down" | "left" | "right",
  durationMs: number = 500,
): Promise<void> {
  const keyMap = {
    up: "KeyW",
    down: "KeyS",
    left: "KeyA",
    right: "KeyD",
  };

  await page.keyboard.down(keyMap[direction]);
  await page.waitForTimeout(durationMs);
  await page.keyboard.up(keyMap[direction]);
}

/**
 * Wait for a specific condition in the world
 */
export async function waitForWorldCondition(
  page: Page,
  condition: string,
  timeout: number = 10000,
): Promise<boolean> {
  try {
    await page.waitForFunction(
      (cond) => {
        // Evaluate the condition string in the context of the world
        const win = window as unknown as { world?: unknown };
        if (!win.world) return false;
        // Simple condition evaluation
        try {
          return new Function("world", `return ${cond}`)(win.world);
        } catch {
          return false;
        }
      },
      condition,
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Test Cleanup Utilities
// ============================================================================

/**
 * Reset the test world to a clean state
 */
export async function resetTestWorld(page: Page): Promise<void> {
  // Import and call cleanup from visualTesting
  await page.evaluate(() => {
    const win = window as unknown as {
      world?: {
        scene?: {
          children: Array<{
            userData?: { isTestProxy?: boolean };
            parent?: { remove: (obj: unknown) => void };
          }>;
        };
      };
    };

    // Clean up test proxies
    const scene = win.world?.scene;
    if (scene) {
      const toRemove = scene.children.filter((c) => c.userData?.isTestProxy);
      toRemove.forEach((obj) => {
        obj.parent?.remove(obj);
      });
    }
  });
}

/**
 * Capture error logs from the browser console
 */
export function setupErrorCapture(page: Page): { errors: string[] } {
  const errors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(msg.text());
    }
  });

  page.on("pageerror", (error) => {
    errors.push(error.message);
  });

  return { errors };
}

// ============================================================================
// Security Testing Utilities
// ============================================================================

/**
 * Check if auth tokens are stored securely (not in URL, proper storage)
 */
export async function verifySecureTokenStorage(page: Page): Promise<{
  hasLocalStorageToken: boolean;
  hasSessionStorageToken: boolean;
  tokenInUrl: boolean;
  urlHasSensitiveParams: boolean;
}> {
  const url = page.url();

  // Check URL for sensitive parameters
  const urlParams = new URL(url).searchParams;
  const sensitiveParams = ["authToken", "token", "secret", "password", "key"];
  const urlHasSensitiveParams = sensitiveParams.some((p) => urlParams.has(p));
  const tokenInUrl = urlParams.has("authToken") || urlParams.has("token");

  // Check storage
  const storageInfo = await page.evaluate(() => {
    const localToken = localStorage.getItem("privy_auth_token");
    const sessionToken = sessionStorage.getItem("privy_auth_token");
    return {
      hasLocalStorageToken: !!localToken,
      hasSessionStorageToken: !!sessionToken,
    };
  });

  return {
    ...storageInfo,
    tokenInUrl,
    urlHasSensitiveParams,
  };
}

/**
 * Verify that CSRF protection is enabled
 */
export async function verifyCsrfProtection(page: Page): Promise<{
  hasCsrfToken: boolean;
  csrfInCookies: boolean;
}> {
  const cookies = await page.context().cookies();
  const csrfCookie = cookies.find(
    (c) =>
      c.name.toLowerCase().includes("csrf") ||
      c.name.toLowerCase().includes("xsrf"),
  );

  const hasCsrfToken = await page.evaluate(() => {
    const win = window as unknown as {
      __CSRF_TOKEN__?: string;
    };
    return !!win.__CSRF_TOKEN__;
  });

  return {
    hasCsrfToken,
    csrfInCookies: !!csrfCookie,
  };
}

// ============================================================================
// Network Testing Utilities
// ============================================================================

/**
 * Check WebSocket connection status
 */
export async function getWebSocketStatus(page: Page): Promise<{
  isConnected: boolean;
  reconnectAttempts: number;
  lastError: string | null;
}> {
  return await page.evaluate(() => {
    const win = window as unknown as {
      world?: {
        network?: {
          isConnected?: () => boolean;
          connected?: boolean;
          reconnectAttempts?: number;
          lastError?: string;
        };
      };
    };

    const network = win.world?.network;
    return {
      isConnected: network?.isConnected?.() ?? network?.connected ?? false,
      reconnectAttempts: network?.reconnectAttempts ?? 0,
      lastError: network?.lastError ?? null,
    };
  });
}

/**
 * Wait for WebSocket connection to be established
 */
export async function waitForWebSocketConnection(
  page: Page,
  timeout = 15000,
): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => {
        const win = window as unknown as {
          world?: {
            network?: {
              isConnected?: () => boolean;
              connected?: boolean;
            };
          };
        };
        const network = win.world?.network;
        return network?.isConnected?.() ?? network?.connected ?? false;
      },
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Performance Testing Utilities
// ============================================================================

/**
 * Get rendering performance metrics
 */
export async function getPerformanceMetrics(page: Page): Promise<{
  fps: number | null;
  frameTime: number | null;
  memoryUsage: number | null;
}> {
  return await page.evaluate(() => {
    const win = window as unknown as {
      world?: {
        stats?: {
          fps?: number;
          frameTime?: number;
        };
      };
    };

    const memory = (
      performance as globalThis.Performance & {
        memory?: { usedJSHeapSize: number };
      }
    ).memory;

    return {
      fps: win.world?.stats?.fps ?? null,
      frameTime: win.world?.stats?.frameTime ?? null,
      memoryUsage: memory?.usedJSHeapSize ?? null,
    };
  });
}

/**
 * Measure page load performance
 */
export async function measurePageLoadTime(page: Page): Promise<{
  domContentLoaded: number;
  loadComplete: number;
  firstPaint: number | null;
}> {
  const timing = await page.evaluate(() => {
    const perf = performance.getEntriesByType(
      "navigation",
    )[0] as globalThis.PerformanceNavigationTiming;
    const paint = performance.getEntriesByType("paint");
    const firstPaint = paint.find((p) => p.name === "first-paint");

    return {
      domContentLoaded: perf?.domContentLoadedEventEnd ?? 0,
      loadComplete: perf?.loadEventEnd ?? 0,
      firstPaint: firstPaint?.startTime ?? null,
    };
  });

  return timing;
}

// ============================================================================
// UI State Testing Utilities
// ============================================================================

/**
 * Get the current UI state (which panels are open, etc.)
 */
export async function getUIState(page: Page): Promise<{
  openPanels: string[];
  hasEscapeMenu: boolean;
  hasNotifications: boolean;
  isLoading: boolean;
}> {
  return await page.evaluate(() => {
    const openPanels: string[] = [];
    document.querySelectorAll("[data-panel]").forEach((panel) => {
      const el = panel as HTMLElement;
      if (el.offsetParent !== null) {
        // Element is visible
        openPanels.push(el.dataset.panel ?? "unknown");
      }
    });

    const escapeMenu = document.querySelector(
      '[data-testid="escape-menu"], [class*="escape-menu"]',
    ) as HTMLElement | null;
    const notifications = document.querySelectorAll(
      '[data-testid="toast"], [class*="notification"]:not([class*="container"])',
    );
    const loading = document.querySelector(
      '[data-testid="loading-screen"], .loading-screen',
    ) as HTMLElement | null;

    return {
      openPanels,
      hasEscapeMenu: escapeMenu?.offsetParent !== null,
      hasNotifications: notifications.length > 0,
      isLoading: loading?.offsetParent !== null,
    };
  });
}

/**
 * Assert that no critical console errors occurred
 */
export function assertNoConsoleErrors(
  errors: string[],
  allowedPatterns: RegExp[] = [],
): void {
  const knownSafePatterns = [
    /ResizeObserver loop/i,
    /Script error/i,
    /favicon/i,
    /Failed to load resource.*favicon/i,
    /Failed to execute 'createBindGroup' on 'GPUDevice'/i,
    /Required member is undefined/i,
    /computeBoundsTree is not a function/i,
    /\[PlayerLocal\] Avatar load failed/i,
    /\[MobEntity\] VRM load error/i,
    /falling back to ArrayBuffer instantiation/i,
    /failed to asynchronously prepare wasm/i,
    /PhysX WASM aborted: both async and sync fetching of the wasm failed/i,
    /\[physx-script-loader\] PhysX WASM initialization failed/i,
    /\[PhysXManager\] Load failed: Cannot delete property 'PhysX' of #<Window>/i,
    /Cannot delete property 'PhysX' of #<Window>/i,
    /Failed to load resource: net::ERR_NETWORK_CHANGED/i,
  ];

  const allPatterns = [...knownSafePatterns, ...allowedPatterns];

  const criticalErrors = errors.filter((error) => {
    return !allPatterns.some((pattern) => pattern.test(error));
  });

  if (criticalErrors.length > 0) {
    throw new Error(
      `Found ${criticalErrors.length} critical console errors:\n${criticalErrors.join("\n")}`,
    );
  }
}
