import { expect, type Page } from "@playwright/test";
import type { World, TerrainSystem } from "@hyperforge/shared";
import {
  waitForPlayerSpawn,
  getPlayerPosition,
  clickAtWorldPosition,
  projectWorldPosition,
  waitForWorldCondition,
} from "./utils/testWorld";
import { evmTest } from "./fixtures/wallet-fixtures";
import {
  completeFullLoginFlow,
  waitForAppReady,
} from "./fixtures/privy-helpers";
import { BASE_URL } from "./fixtures/test-config";

const test = evmTest;
const nativeMovement = process.env.PW_NATIVE_MOVEMENT === "true";
const nativeErrors = new WeakMap<
  Page,
  {
    console: string[];
    page: string[];
    gpu: string[];
    dropped: number;
  }
>();

async function readNativeMovementState(page: Page) {
  return page.evaluate(() => {
    const win = window as unknown as {
      world?: World;
      __HYPERIA_EMBEDDED__?: boolean;
      __HYPERIA_CONFIG__?: { mode?: string };
    };
    const world = win.world;
    const player = world?.getPlayer();
    const network = world?.network as unknown as
      | {
          connected?: boolean;
          id?: string;
        }
      | undefined;
    const renderer = world?.graphics?.renderer;
    const backend = renderer?.backend as unknown as
      | {
          isWebGPUBackend?: boolean;
          device?: GPUDevice;
        }
      | undefined;
    const info = backend?.device?.adapterInfo;
    if (
      window.location.pathname !== "/" ||
      window.location.search ||
      window.location.hash ||
      win.__HYPERIA_EMBEDDED__ === true ||
      win.__HYPERIA_CONFIG__?.mode ||
      !player ||
      !world?.getSystem("physics") ||
      network?.connected !== true
    )
      throw new Error("Connected normal local player with physics is required");
    if (
      world.graphics?.isWebGPU !== true ||
      !renderer ||
      !renderer.hasInitialized() ||
      backend?.isWebGPUBackend !== true ||
      !info ||
      info.vendor.toLowerCase() !== "apple" ||
      !/^metal(?:-|$)/i.test(info.architecture) ||
      info.isFallbackAdapter !== false
    )
      throw new Error(
        "Actual rendering device must be non-fallback Apple Metal WebGPU",
      );
    return {
      player: { id: player.id, position: player.position.toArray() },
      network: { id: network.id, connected: network.connected },
      url: window.location.href,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      physicsRegistered: true,
      adapter: {
        source:
          "Actual renderer.backend.device.adapterInfo; no extra adapter requested",
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description,
        isFallbackAdapter: info.isFallbackAdapter,
      },
      rendering: {
        width: renderer.domElement.width,
        height: renderer.domElement.height,
        pixelRatio: renderer.getPixelRatio(),
        outputColorSpace: renderer.outputColorSpace,
        toneMapping: renderer.toneMapping,
        toneMappingExposure: renderer.toneMappingExposure,
      },
      scope:
        "Real local test-mode character/input/network/physics; not authentication, wallet, betting, performance or cleanup qualification.",
    };
  });
}

test.describe("Navigation System", () => {
  // Increase test timeout
  test.setTimeout(360000); // 6 minutes per test

  if (!nativeMovement)
    test.beforeEach(async ({ page, wallet }) => {
      // Increase navigation timeouts
      page.setDefaultTimeout(120000);
      page.setDefaultNavigationTimeout(120000);

      const setupAttempt = async (): Promise<boolean> => {
        await waitForAppReady(page, BASE_URL);
        const enteredGame = await completeFullLoginFlow(page, wallet);
        if (!enteredGame) return false;

        try {
          await waitForPlayerSpawn(page, 120000);
          return true;
        } catch {
          return false;
        }
      };

      let setupOk = await setupAttempt();
      if (!setupOk) {
        console.log(
          "[navigation.beforeEach] Initial login/spawn setup failed, reloading and retrying once...",
        );
        if (!page.isClosed()) {
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
          await page.waitForTimeout(1000).catch(() => {});
        }
        setupOk = await setupAttempt();
      }

      expect(setupOk).toBe(true);
    });

  if (nativeMovement) {
    // The wallet fixture is lazy and is deliberately NOT requested in this mode.
    test.beforeEach(async ({ page }, testInfo) => {
      const errors = {
        console: [] as string[],
        page: [] as string[],
        gpu: [] as string[],
        dropped: 0,
      };
      nativeErrors.set(page, errors);
      const retain = (kind: "console" | "page" | "gpu", message: string) => {
        if (errors[kind].length < 64) errors[kind].push(message.slice(0, 2048));
        else errors.dropped++;
      };
      page.on("console", (message) => {
        if (message.type() === "error") retain("console", message.text());
      });
      page.on("pageerror", (error) => retain("page", error.message));
      await page.exposeFunction("__nativeMovementGpuError", (message: string) =>
        retain("gpu", message),
      );
      await page.bringToFront();
      await page.goto("http://localhost:3333/", {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
      });
      await waitForPlayerSpawn(page, 120_000);
      await page.waitForFunction(
        () => {
          const loading = (
            window as unknown as {
              __HYPERIA_LOADING__?: {
                ready: boolean;
                playerReady: boolean;
                physReady: boolean;
                terrainReady: boolean;
                terrainTimedOut: boolean;
              };
            }
          ).__HYPERIA_LOADING__;
          return (
            loading?.ready === true &&
            loading.playerReady === true &&
            loading.physReady === true &&
            loading.terrainReady === true &&
            loading.terrainTimedOut === false
          );
        },
        undefined,
        { timeout: 120_000 },
      );
      const before = await readNativeMovementState(page);
      expect(before.visibility).toBe("visible");
      expect(before.focused).toBe(true);
      expect(before.rendering).toMatchObject({
        width: 1280,
        height: 720,
        pixelRatio: 1,
      });
      await page.evaluate(() => {
        const win = window as unknown as {
          world: World;
          __nativeMovementGpuError: (message: string) => Promise<void>;
          __nativeMovementGpuCleanup?: () => void;
        };
        const renderer = win.world.graphics?.renderer;
        if (!renderer) throw new Error("Actual renderer disappeared");
        const device = (renderer.backend as unknown as { device: GPUDevice })
          .device;
        if (win.__nativeMovementGpuCleanup)
          throw new Error("Existing movement GPU observer");
        let active = true;
        const onError = (event: Event) => {
          void win.__nativeMovementGpuError(
            (event as Event & { error: { message: string } }).error.message,
          );
        };
        device.addEventListener("uncapturederror", onError);
        void device.lost.then((info) => {
          if (active)
            void win.__nativeMovementGpuError(
              "device-lost: " + info.reason + ": " + info.message,
            );
        });
        win.__nativeMovementGpuCleanup = () => {
          active = false;
          device.removeEventListener("uncapturederror", onError);
          delete win.__nativeMovementGpuCleanup;
        };
      });
      await testInfo.attach("native-movement-before", {
        body: JSON.stringify(
          { browser: page.context().browser()?.version(), ...before },
          null,
          2,
        ),
        contentType: "application/json",
      });
    });
    test.afterEach(async ({ page }, testInfo) => {
      let after:
        Awaited<ReturnType<typeof readNativeMovementState>> | undefined;
      const failures: { stage: string; error: unknown }[] = [];
      try {
        if (page.isClosed())
          throw new Error("Movement page closed before final observation");
        after = await readNativeMovementState(page);
      } catch (error) {
        failures.push({ stage: "final-state", error });
      }
      try {
        if (!page.isClosed())
          await page.evaluate(() => {
            (
              window as unknown as { __nativeMovementGpuCleanup?: () => void }
            ).__nativeMovementGpuCleanup?.();
          });
      } catch (error) {
        failures.push({ stage: "observer-cleanup", error });
      }
      const errors = nativeErrors.get(page);
      try {
        await testInfo.attach("native-movement-after", {
          body: JSON.stringify(
            {
              after,
              errors,
              failures: failures.map(({ stage, error }) => ({
                stage,
                message: (error instanceof Error
                  ? error.message
                  : String(error)
                ).slice(0, 2048),
              })),
              contentClean: errors?.console.length === 0,
              productionApproved: false,
              gpuObservation:
                "Existing device events from readiness until test end only; startup errors retained through console/page listeners.",
              cleanupAcceptance:
                "Not established by Playwright test pass; owned exit logs/PIDs/ports/database and forced-kill checks are required externally.",
            },
            null,
            2,
          ),
          contentType: "application/json",
        });
      } catch (error) {
        failures.push({ stage: "artifact-attachment", error });
      } finally {
        nativeErrors.delete(page);
      }
      // Preserve the original state failure while retaining any later cleanup
      // failure in the artifact. Cleanup failure alone also fails this test.
      if (failures.length) throw failures[0].error;
      expect(errors?.page).toEqual([]);
      expect(errors?.gpu).toEqual([]);
      expect(errors?.dropped).toBe(0);
      // Content console errors are retained, not discarded or called clean.
    });
  }

  test("should load game and spawn player", async ({ page }) => {
    const pos = await getPlayerPosition(page);
    expect(pos).toBeDefined();
    expect(typeof pos.x).toBe("number");
    expect(typeof pos.y).toBe("number");
    expect(typeof pos.z).toBe("number");
  });

  test("moves to a visible ground tile through actual canvas input", async ({
    page,
  }, testInfo) => {
    const readPosition = () =>
      page.evaluate(() => {
        const player = (
          window as unknown as { world?: World }
        ).world?.getPlayer();
        if (!player) throw new Error("The real local player is required");
        const { x, y, z } = player.position;
        if (![x, y, z].every(Number.isFinite))
          throw new Error("Non-finite local player position");
        return { id: player.id, x, y, z };
      });
    const start = await readPosition();
    const candidates = await page.evaluate(() => {
      const world = (window as unknown as { world?: World }).world;
      const player = world?.getPlayer();
      const terrain = world?.getSystem<TerrainSystem>("terrain");
      if (!player || !terrain) throw new Error("Player/terrain not ready");
      const { x, z } = player.position;
      // Two-tile diagonal options first, then cardinal. These are candidate
      // inputs, not a movement bypass or a claim of server-side reachability.
      return [
        [2, 2],
        [-2, 2],
        [2, -2],
        [-2, -2],
        [3, 0],
        [-3, 0],
        [0, 3],
        [0, -3],
      ]
        .map(([dx, dz]) => ({
          x: Math.floor(x) + 0.5 + dx,
          z: Math.floor(z) + 0.5 + dz,
        }))
        .filter((target) => {
          for (let step = 1; step <= 12; step++) {
            const t = step / 12;
            if (
              !terrain.isTileWalkable(
                x + (target.x - x) * t,
                z + (target.z - z) * t,
              )
            )
              return false;
          }
          return true;
        });
    });
    let target: { x: number; z: number } | undefined;
    const rejected: string[] = [];
    for (const candidate of candidates) {
      try {
        await projectWorldPosition(page, candidate);
        target = candidate;
        break;
      } catch (error) {
        rejected.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (!target)
      throw new Error(
        "No visible clear movement target: " + rejected.join("; "),
      );
    const destination = target;
    const samples = [{ time: Date.now(), ...start }];
    try {
      await page.screenshot({
        path: testInfo.outputPath("movement-before.png"),
      });
      // Reproject at click time. No WASD, private move API or position mutation.
      await clickAtWorldPosition(page, destination);
      await expect
        .poll(
          async () => {
            const position = await readPosition();
            expect(position.id).toBe(start.id);
            samples.push({ time: Date.now(), ...position });
            return Math.hypot(
              position.x - destination.x,
              position.z - destination.z,
            );
          },
          { timeout: 15_000, intervals: [100] },
        )
        .toBeLessThan(0.35);
      const end = await readPosition();
      expect(end.id).toBe(start.id);
      expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeGreaterThan(1.5);
      // Merely having controls/network, or jumping straight to the destination,
      // cannot pass this movement test.
      const traveled = samples.map((p) =>
        Math.hypot(p.x - start.x, p.z - start.z),
      );
      const length = Math.hypot(
        destination.x - start.x,
        destination.z - start.z,
      );
      expect(
        traveled.filter((d) => d > 0.15 && d < length - 0.35).length,
      ).toBeGreaterThanOrEqual(2);
      await page.screenshot({
        path: testInfo.outputPath("movement-after.png"),
      });
    } finally {
      await testInfo.attach("actual-canvas-movement", {
        body: JSON.stringify(
          { start, destination, samples, rejected },
          null,
          2,
        ),
        contentType: "application/json",
      });
    }
  });

  test("should transition player Y when entering building", async ({
    page,
  }) => {
    console.log("Waiting for buildings to generate...");

    // 1. Wait for buildings to exist in the world
    const buildingsFound = await waitForWorldCondition(
      page,
      "world.getSystem('buildingCollision') && world.getSystem('buildingCollision').buildings.size > 0",
      120000, // up to 120s for gen
    );

    if (!buildingsFound) {
      console.warn("No buildings generated in time. Skipping test.");
      test.skip();
      return;
    }

    // 2. Find a suitable building with an entrance
    const targetBuilding = await page.evaluate(() => {
      const world = (window as any).world;
      const buildingService = world.getSystem("buildingCollision");
      const buildings = Array.from(
        (buildingService as any).buildings.values(),
      ) as any[];

      // Find one with step tiles (entrances)
      for (const b of buildings) {
        if (b.stepTiles && b.stepTiles.length > 0) {
          // Start position: on the step tile (outside/transition)
          const step = b.stepTiles[0];
          // Target position: center of the building (inside)
          return {
            id: b.buildingId,
            startX: step.tileX + 0.5,
            startZ: step.tileZ + 0.5,
            targetX: b.worldPosition.x,
            targetZ: b.worldPosition.z,
            floorHeight: b.floors[0].elevation,
          };
        }
      }
      return null;
    });

    if (!targetBuilding) {
      console.warn("No suitable building found (with entrance).");
      test.skip();
      return;
    }

    console.log(
      `Targeting building ${targetBuilding.id} at (${targetBuilding.targetX}, ${targetBuilding.targetZ})`,
    );
    console.log(
      `Starting at step (${targetBuilding.startX}, ${targetBuilding.startZ})`,
    );

    // 3. Teleport player to the "start" position (near entrance)
    await page.evaluate(
      (pos) => {
        const player = (window as any).world.entities.player;
        // Set position, slightly above ground to avoid falling through initially
        if (player.position && player.position.set) {
          player.position.set(pos.x, 10, pos.z);
          // Reset physics velocity if possible
          if (player.body) {
            player.body.setTranslation({ x: pos.x, y: 10, z: pos.z }, true);
            player.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          }
          // Reset pathfinding state
          if (player.resetPath) player.resetPath();
        }
      },
      { x: targetBuilding.startX, z: targetBuilding.startZ },
    );

    // Wait for player to settle on the ground/step
    await page.waitForTimeout(3000);

    // Check Y position outside (should be ~terrain height)
    const startY = await page.evaluate(
      () => (window as any).world.entities.player.mesh.position.y,
    );
    console.log(`Player landed at Y=${startY}`);

    // 4. Move INTO the building
    console.log("Moving into building...");
    await page.evaluate(
      (target) => {
        const world = (window as any).world;
        const playerMovement = world.getSystem("playerMovement");
        if (playerMovement) {
          // Move to building center
          playerMovement.moveTo({
            x: Math.floor(target.x),
            z: Math.floor(target.z),
          });
        }
      },
      { x: targetBuilding.targetX, z: targetBuilding.targetZ },
    );

    // Wait for movement
    await page.waitForTimeout(5000);

    // 5. Verify Y position matches floor height
    const endY = await page.evaluate(
      () => (window as any).world.entities.player.mesh.position.y,
    );
    const expectedY = targetBuilding.floorHeight;

    console.log(
      `Player entered building at Y=${endY} (Expected floor: ${expectedY})`,
    );

    // Check if Y is close to floor height (allowing small tolerance)
    expect(endY).toBeGreaterThanOrEqual(expectedY - 0.1);
    expect(endY).toBeLessThan(expectedY + 2.5);
  });
});
