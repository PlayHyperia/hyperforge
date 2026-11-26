#!/usr/bin/env node

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";

import { chromium } from "playwright";

const values = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    url: {
      type: "string",
      default: "http://localhost:3333/stream.html?disableBridgeCapture=1",
    },
    report: {
      type: "string",
      default: "artifacts/duel-avatar-lod-runtime/report.json",
    },
    screenshot: {
      type: "string",
      default: "artifacts/duel-avatar-lod-runtime/final-lod0.png",
    },
    "fault-mode": { type: "string", default: "http-503" },
    "timeout-ms": { type: "string", default: "120000" },
  },
  strict: true,
}).values;

if (values.help) {
  console.log(`
Verify remote-player avatar LOD swaps in a running production duel client.

Usage:
  node scripts/verify-duel-avatar-lod-runtime.mjs [options]

Options:
  --url <url>           Loopback stream page URL
  --report <path>       JSON evidence path
  --screenshot <path>   Final LOD0 screenshot path
  --fault-mode <mode>   http-503, truncated-200, stalled-body-200, connection-reset-200, or throttled-200
  --timeout-ms <ms>     Browser readiness deadline (default: 120000)
`);
  process.exit(0);
}

const clientUrl = normalizeLoopbackUrl(String(values.url));
const reportPath = path.resolve(String(values.report));
const screenshotPath = path.resolve(String(values.screenshot));
const timeoutMs = Number.parseInt(String(values["timeout-ms"]), 10);
const faultMode = String(values["fault-mode"]);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000) {
  throw new Error("--timeout-ms must be an integer of at least 30000");
}
if (
  ![
    "http-503",
    "truncated-200",
    "stalled-body-200",
    "connection-reset-200",
    "throttled-200",
  ].includes(faultMode)
) {
  throw new Error(
    "--fault-mode must be http-503, truncated-200, stalled-body-200, connection-reset-200, or throttled-200",
  );
}

function normalizeLoopbackUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("--url must be a valid URL");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("--url must use loopback HTTP");
  }
  return url.toString();
}

function unique(valuesToDedupe) {
  return [...new Set(valuesToDedupe)];
}

const systemChrome =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.env.PLAYWRIGHT_CHROME_PATH ?? systemChrome;
if (!existsSync(executablePath)) {
  throw new Error(
    `Chrome is required for the WebGPU runtime audit: ${executablePath}`,
  );
}

await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.mkdir(path.dirname(screenshotPath), { recursive: true });

const browserIssues = [];
const networkFailures = [];
const expectedLODBrowserIssues = [];
const expectedLODNetworkFailures = [];
const expectedLODRequestFailures = [];
const stalledBodyRequests = [];
const connectionResetRequests = [];
const throttledBodyRequests = [];
const lodNetworkFault = {
  mode: faultMode,
  armed: false,
  maxFailures: faultMode === "throttled-200" ? 1 : 3,
  requests: [],
  responses: [],
};
const isLOD1AvatarUrl = (rawUrl) => {
  try {
    return /_lod1\.vrm$/iu.test(new URL(rawUrl).pathname);
  } catch {
    return false;
  }
};
let partialBodyServer;
let partialBodyOrigin;
const throttledAvatarBody =
  faultMode === "throttled-200"
    ? await fs.readFile(
        new URL(
          "../packages/server/world/assets/avatars/duel-candidates/duel-steve_lod1.vrm",
          import.meta.url,
        ),
      )
    : null;
if (
  ["stalled-body-200", "connection-reset-200", "throttled-200"].includes(
    faultMode,
  )
) {
  partialBodyServer = createServer((request, response) => {
    const requestLog =
      faultMode === "stalled-body-200"
        ? stalledBodyRequests
        : faultMode === "connection-reset-200"
          ? connectionResetRequests
          : throttledBodyRequests;
    const startedAt = Date.now();
    const entry = {
      sequence: requestLog.length + 1,
      method: request.method,
      url: request.url,
      closedBeforeComplete: false,
      bytesSent: 0,
    };
    requestLog.push(entry);
    response.on("close", () => {
      entry.closedBeforeComplete = !response.writableEnded;
      entry.durationMs = Date.now() - startedAt;
    });
    const contentLength =
      faultMode === "throttled-200" ? throttledAvatarBody.length : 16 * 1024;
    response.writeHead(200, {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "content-length": String(contentLength),
      "content-type": "model/gltf-binary",
    });
    if (faultMode === "throttled-200") {
      entry.initialLatencyMs = 750;
      entry.chunkBytes = 16 * 1024;
      entry.chunkIntervalMs = 125;
      let offset = 0;
      const sendChunk = () => {
        if (response.destroyed) return;
        const end = Math.min(
          offset + entry.chunkBytes,
          throttledAvatarBody.length,
        );
        response.write(throttledAvatarBody.subarray(offset, end));
        offset = end;
        entry.bytesSent = offset;
        if (offset === throttledAvatarBody.length) {
          entry.completed = true;
          response.end();
          return;
        }
        setTimeout(sendChunk, entry.chunkIntervalMs);
      };
      setTimeout(sendChunk, entry.initialLatencyMs);
      return;
    }
    response.write(Buffer.alloc(1024, 0));
    entry.bytesSent = 1024;
    if (faultMode === "connection-reset-200") {
      entry.resetAfterPartialBody = true;
      setImmediate(() => response.destroy());
    }
  });
  await new Promise((resolve, reject) => {
    partialBodyServer.once("error", reject);
    partialBodyServer.listen(0, "127.0.0.1", () => {
      partialBodyServer.off("error", reject);
      resolve();
    });
  });
  const address = partialBodyServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve partial-body audit server address");
  }
  partialBodyOrigin = `http://127.0.0.1:${address.port}`;
}
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal"],
});

let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route(/_lod1\.vrm(?:\?.*)?$/iu, async (route) => {
    if (!lodNetworkFault.armed) {
      await route.continue();
      return;
    }
    const request = route.request();
    const failureCount = lodNetworkFault.requests.filter(
      (entry) => entry.action !== "continued",
    ).length;
    const injectedAction =
      faultMode === "http-503"
        ? "fulfilled-503"
        : faultMode === "truncated-200"
          ? "fulfilled-truncated-200"
          : faultMode;
    const action =
      failureCount < lodNetworkFault.maxFailures ? injectedAction : "continued";
    lodNetworkFault.requests.push({
      sequence: lodNetworkFault.requests.length + 1,
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url(),
      action,
    });
    if (action === "fulfilled-503") {
      await route.fulfill({
        status: 503,
        contentType: "text/plain; charset=utf-8",
        headers: {
          "cache-control": "no-store",
          "retry-after": "0",
        },
        body: "Injected avatar LOD transport interruption",
      });
      return;
    }
    if (action === "fulfilled-truncated-200") {
      await route.fulfill({
        status: 200,
        contentType: "model/gltf-binary",
        headers: {
          "cache-control": "no-store",
        },
        body: Buffer.alloc(16 * 1024, 0),
      });
      return;
    }
    if (
      action === "stalled-body-200" ||
      action === "connection-reset-200" ||
      action === "throttled-200"
    ) {
      const rewrittenUrl = `${partialBodyOrigin}/duel-steve_lod1.vrm?attempt=${failureCount + 1}`;
      lodNetworkFault.requests.at(-1).rewrittenUrl = rewrittenUrl;
      await route.continue({ url: rewrittenUrl });
      return;
    }
    await route.continue();
  });
  await page.exposeFunction("__HYPERIA_SET_LOD_NETWORK_FAULT__", (armed) => {
    lodNetworkFault.armed = armed === true;
    return {
      armed: lodNetworkFault.armed,
      failures: lodNetworkFault.requests.filter(
        (request) => request.action !== "continued",
      ).length,
    };
  });
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      const issue = `${message.type()}: ${message.text()}`;
      if (
        lodNetworkFault.armed &&
        (issue.includes("[PlayerRemote] Avatar fetch attempt") ||
          issue.includes("[PlayerRemote] Avatar load failed:") ||
          (issue.includes("[ClientLoader] Fetch failed for") &&
            issue.includes("_lod1.vrm") &&
            issue.includes("status: 503")) ||
          /Failed to load resource.*503/iu.test(issue) ||
          (faultMode === "connection-reset-200" &&
            /Failed to load resource.*ERR_CONTENT_LENGTH_MISMATCH/iu.test(
              issue,
            )))
      ) {
        expectedLODBrowserIssues.push(issue);
      } else {
        browserIssues.push(issue);
      }
    }
  });
  page.on("pageerror", (error) => {
    browserIssues.push(`pageerror: ${error.message}`);
  });
  page.on("response", (response) => {
    if (lodNetworkFault.armed && isLOD1AvatarUrl(response.url())) {
      lodNetworkFault.responses.push({
        sequence: lodNetworkFault.responses.length + 1,
        status: response.status(),
        url: response.url(),
      });
    }
    if (response.status() >= 400) {
      const failure = `${response.status()} ${response.url()}`;
      if (
        lodNetworkFault.armed &&
        response.status() === 503 &&
        isLOD1AvatarUrl(response.url())
      ) {
        expectedLODNetworkFailures.push(failure);
      } else {
        networkFailures.push(failure);
      }
    }
  });
  page.on("requestfailed", (request) => {
    const detail = request.failure()?.errorText ?? "request failed";
    if (
      lodNetworkFault.armed &&
      ["stalled-body-200", "connection-reset-200"].includes(faultMode) &&
      isLOD1AvatarUrl(request.url())
    ) {
      expectedLODRequestFailures.push(`${detail} ${request.url()}`);
    } else if (!detail.includes("ERR_ABORTED")) {
      networkFailures.push(`${detail} ${request.url()}`);
    }
  });

  await page.goto(clientUrl, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await page.waitForFunction(
    async () => Boolean(await navigator.gpu?.requestAdapter()),
    undefined,
    { timeout: timeoutMs },
  );
  await page.waitForFunction(
    () =>
      window.world?.entities?.players?.size >= 2 &&
      [...window.world.entities.players.values()].every(
        (player) => player.avatar && !player.isLoadingAvatar,
      ),
    undefined,
    { timeout: timeoutMs },
  );
  await page.waitForFunction(
    () => {
      const world = window.world;
      const readiness =
        world?.[
          "equipment-visual"
        ]?.getStreamingDuelEquipmentVisualReadiness?.();
      if (!readiness?.ready || readiness.requiredCount < 1) return false;
      const camera = world.camera?.position;
      return Boolean(
        camera &&
        [...world.entities.players.values()].some(
          (player) =>
            Math.hypot(
              player.node.position.x - camera.x,
              player.node.position.z - camera.z,
            ) < 100,
        ),
      );
    },
    undefined,
    { timeout: timeoutMs },
  );
  await page.waitForFunction(
    () => {
      const fightLogVisible = [...document.querySelectorAll("span")].some(
        (element) =>
          element.textContent?.trim() === "FIGHT LOG" &&
          element.getBoundingClientRect().width > 0 &&
          element.getBoundingClientRect().height > 0,
      );
      return (
        window.__HYPERIA_STREAM_READY__ === true &&
        window.__HYPERIA_STREAM_RENDERER_HEALTH__?.ready === true &&
        window.__HYPERIA_STREAM_RENDERER_HEALTH__?.phase === "FIGHTING" &&
        window.__HYPERIA_STREAM_BOOT_STATUS__ === null &&
        document.querySelector(".loading-screen") === null &&
        fightLogVisible
      );
    },
    undefined,
    { timeout: timeoutMs },
  );

  const runtime = await page.evaluate(
    async (faultProfile) => {
      const world = window.world;
      const players = [...world.entities.players.values()];
      const initialCameraPosition = world.camera.position;
      const player = [...players].sort(
        (left, right) =>
          Math.hypot(
            left.node.position.x - initialCameraPosition.x,
            left.node.position.z - initialCameraPosition.z,
          ) -
          Math.hypot(
            right.node.position.x - initialCameraPosition.x,
            right.node.position.z - initialCameraPosition.z,
          ),
      )[0];
      const equipmentVisuals = world["equipment-visual"];
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (description, predicate, deadlineMs = 30_000) => {
        const deadline = performance.now() + deadlineMs;
        while (performance.now() < deadline) {
          if (predicate()) return;
          await sleep(25);
        }
        throw new Error(`Timed out waiting for ${description}`);
      };
      const getScene = (avatar) => avatar?.instance?.raw?.scene ?? null;
      const contestantUrls = new Map(
        players.map((candidate) => {
          const requestedUrl =
            candidate.data.sessionAvatar || candidate.data.avatar;
          if (!requestedUrl?.endsWith(".vrm")) {
            throw new Error(
              `${candidate.data.name} has no canonical VRM URL: ${requestedUrl}`,
            );
          }
          return [
            candidate.id,
            {
              0: requestedUrl,
              1: requestedUrl.replace(/\.vrm$/i, "_lod1.vrm"),
              2: requestedUrl.replace(/\.vrm$/i, "_lod2.vrm"),
            },
          ];
        }),
      );
      const urls = contestantUrls.get(player.id);
      const expectedUrlFor = (candidate, lod) =>
        contestantUrls.get(candidate.id)?.[lod];

      const naturalSamples = [];
      for (let index = 0; index < 10; index += 1) {
        const camera = world.camera.position;
        naturalSamples.push({
          elapsedMs: Math.round(performance.now()),
          url: player.avatarUrl,
          lod: player.avatarLOD,
          loading: player.isLoadingAvatar,
          planarDistance: Number(
            Math.hypot(
              player.node.position.x - camera.x,
              player.node.position.z - camera.z,
            ).toFixed(3),
          ),
        });
        await sleep(50);
      }

      const cameraSystem = world.getSystem?.("client-camera-system");
      if (!cameraSystem || typeof cameraSystem.update !== "function") {
        throw new Error("Production client camera system is unavailable");
      }
      const originalCameraUpdate = cameraSystem.update;
      const cameraUpdateWasOwnProperty = Object.prototype.hasOwnProperty.call(
        cameraSystem,
        "update",
      );
      const controlledCamera = world.camera;
      let controlledDistance = null;
      let cameraControlFrame = 0;
      const positionControlledCamera = () => {
        if (controlledDistance === null) return;
        const firstPosition = players[0].node.position;
        const secondPosition = players[1].node.position;
        const separationX = secondPosition.x - firstPosition.x;
        const separationZ = secondPosition.z - firstPosition.z;
        const separation = Math.hypot(separationX, separationZ);
        const halfSeparation = separation / 2;
        if (halfSeparation > controlledDistance) {
          throw new Error(
            `Contestants are ${separation.toFixed(3)} units apart, too far for a shared ${controlledDistance}-unit camera audit`,
          );
        }
        const midpointX = (firstPosition.x + secondPosition.x) / 2;
        const midpointY = (firstPosition.y + secondPosition.y) / 2;
        const midpointZ = (firstPosition.z + secondPosition.z) / 2;
        const perpendicularX = separation > 0 ? -separationZ / separation : 1;
        const perpendicularZ = separation > 0 ? separationX / separation : 0;
        const perpendicularDistance = Math.sqrt(
          controlledDistance * controlledDistance -
            halfSeparation * halfSeparation,
        );
        controlledCamera.position.set(
          midpointX + perpendicularX * perpendicularDistance,
          midpointY + 10,
          midpointZ + perpendicularZ * perpendicularDistance,
        );
        controlledCamera.lookAt(midpointX, midpointY + 1, midpointZ);
        controlledCamera.updateMatrixWorld(true);
      };
      const maintainControlledCamera = () => {
        positionControlledCamera();
        cameraControlFrame = requestAnimationFrame(maintainControlledCamera);
      };
      const contestantLODStates = (expectedLOD) =>
        players.map((candidate) => ({
          id: candidate.id,
          name: candidate.data.name,
          url: candidate.avatarUrl,
          expectedUrl: expectedUrlFor(candidate, expectedLOD),
          lod: candidate.avatarLOD,
          loading: candidate.isLoadingAvatar,
          sceneVisible: Boolean(
            getScene(candidate.avatar)?.parent &&
            getScene(candidate.avatar)?.visible,
          ),
          planarDistance: Number(
            Math.hypot(
              candidate.node.position.x - controlledCamera.position.x,
              candidate.node.position.z - controlledCamera.position.z,
            ).toFixed(3),
          ),
        }));
      const distanceTraversal = [];
      const distanceSteps = [
        {
          id: "lod0-hold-below-outward-threshold",
          distance: 29,
          expectedLOD: 0,
          transitionExpected: false,
        },
        {
          id: "lod0-to-lod1",
          distance: 31,
          expectedLOD: 1,
          transitionExpected: true,
        },
        {
          id: "lod1-hold-below-outward-threshold",
          distance: 59,
          expectedLOD: 1,
          transitionExpected: false,
        },
        {
          id: "lod1-to-lod2",
          distance: 61,
          expectedLOD: 2,
          transitionExpected: true,
        },
        {
          id: "lod2-hold-inside-return-band",
          distance: 55,
          expectedLOD: 2,
          transitionExpected: false,
        },
        {
          id: "lod2-to-lod1",
          distance: 53,
          expectedLOD: 1,
          transitionExpected: true,
        },
        {
          id: "lod1-hold-inside-return-band",
          distance: 28,
          expectedLOD: 1,
          transitionExpected: false,
        },
        {
          id: "lod1-to-lod0",
          distance: 26,
          expectedLOD: 0,
          transitionExpected: true,
        },
      ];
      try {
        // The production camera controller is paused, but PlayerRemote.update()
        // and every other world system keep running. Moving the real world camera
        // therefore exercises the exact distance-selection path used by viewers.
        cameraSystem.update = () => undefined;
        cameraControlFrame = requestAnimationFrame(maintainControlledCamera);
        for (const step of distanceSteps) {
          await waitFor(`all avatar loads before ${step.id}`, () =>
            players.every((candidate) => !candidate.isLoadingAvatar),
          );
          await waitFor(
            `equipment readiness before ${step.id}`,
            () =>
              equipmentVisuals.getStreamingDuelEquipmentVisualReadiness()
                .ready === true,
          );
          const targetUrl = urls[step.expectedLOD];
          const previousAvatar = player.avatar;
          const previousScene = getScene(previousAvatar);
          const previousUrl = player.avatarUrl;
          const previousEmote = player.lastEmote ?? null;
          const previousContestants = players.map((candidate) => ({
            candidate,
            avatar: candidate.avatar,
            scene: getScene(candidate.avatar),
            url: candidate.avatarUrl,
          }));
          const contestantBlankFrames = new Map(
            players.map((candidate) => [candidate.id, 0]),
          );
          let frameCount = 0;
          let blankFrameCount = 0;
          let monitoring = true;
          let monitorFrame = 0;
          const monitor = () => {
            if (!monitoring) return;
            frameCount += 1;
            const currentScene = getScene(player.avatar);
            const previousVisible = Boolean(
              previousScene?.parent && previousScene.visible,
            );
            const currentVisible = Boolean(
              currentScene?.parent && currentScene.visible,
            );
            if (!previousVisible && !currentVisible) blankFrameCount += 1;
            for (const previous of previousContestants) {
              const currentContestantScene = getScene(
                previous.candidate.avatar,
              );
              const previousContestantVisible = Boolean(
                previous.scene?.parent && previous.scene.visible,
              );
              const currentContestantVisible = Boolean(
                currentContestantScene?.parent &&
                currentContestantScene.visible,
              );
              if (!previousContestantVisible && !currentContestantVisible) {
                contestantBlankFrames.set(
                  previous.candidate.id,
                  (contestantBlankFrames.get(previous.candidate.id) ?? 0) + 1,
                );
              }
            }
            monitorFrame = requestAnimationFrame(monitor);
          };
          monitorFrame = requestAnimationFrame(monitor);
          const startedAt = performance.now();
          controlledDistance = step.distance;
          positionControlledCamera();
          if (step.transitionExpected) {
            await waitFor(`${step.id} two-contestant convergence`, () =>
              players.every(
                (candidate) =>
                  candidate.avatarUrl ===
                    expectedUrlFor(candidate, step.expectedLOD) &&
                  candidate.avatarLOD === step.expectedLOD &&
                  !candidate.isLoadingAvatar,
              ),
            );
          } else {
            await sleep(500);
            if (
              players.some(
                (candidate) =>
                  candidate.avatarUrl !==
                    expectedUrlFor(candidate, step.expectedLOD) ||
                  candidate.avatarLOD !== step.expectedLOD ||
                  candidate.isLoadingAvatar,
              )
            ) {
              throw new Error(
                `${step.id} did not hold LOD${step.expectedLOD} for both contestants`,
              );
            }
          }
          await waitFor(`all avatar loads after ${step.id}`, () =>
            players.every((candidate) => !candidate.isLoadingAvatar),
          );
          await waitFor(
            `equipment readiness after ${step.id}`,
            () =>
              equipmentVisuals.getStreamingDuelEquipmentVisualReadiness()
                .ready === true,
          );
          await new Promise((resolve) => requestAnimationFrame(resolve));
          monitoring = false;
          cancelAnimationFrame(monitorFrame);
          const currentScene = getScene(player.avatar);
          const readiness =
            equipmentVisuals.getStreamingDuelEquipmentVisualReadiness();
          distanceTraversal.push({
            ...step,
            previousUrl,
            targetUrl,
            committedUrl: player.avatarUrl,
            committedLOD: player.avatarLOD,
            actualDistance: Number(
              Math.hypot(
                player.node.position.x - controlledCamera.position.x,
                player.node.position.z - controlledCamera.position.z,
              ).toFixed(3),
            ),
            durationMs: Number((performance.now() - startedAt).toFixed(1)),
            frameCount,
            blankFrameCount,
            avatarReplaced: player.avatar !== previousAvatar,
            previousSceneRemoved: !previousScene?.parent,
            previousSceneRetained: Boolean(previousScene?.parent),
            currentSceneVisible: Boolean(
              currentScene?.parent && currentScene.visible,
            ),
            previousEmote,
            committedEmote: player.lastEmote ?? null,
            equipmentReady: readiness.ready,
            equipmentReadyCount: readiness.readyCount,
            equipmentRequiredCount: readiness.requiredCount,
            equipmentUnresolved: readiness.unresolved,
            equipmentAttachmentMismatches: readiness.attachmentMismatches,
            contestantTransitions: previousContestants.map((previous) => {
              const currentAvatar = previous.candidate.avatar;
              const currentScene = getScene(currentAvatar);
              return {
                id: previous.candidate.id,
                name: previous.candidate.data.name,
                previousUrl: previous.url,
                targetUrl: expectedUrlFor(previous.candidate, step.expectedLOD),
                committedUrl: previous.candidate.avatarUrl,
                avatarReplaced: currentAvatar !== previous.avatar,
                previousSceneRemoved: !previous.scene?.parent,
                previousSceneRetained: Boolean(previous.scene?.parent),
                currentSceneVisible: Boolean(
                  currentScene?.parent && currentScene.visible,
                ),
                blankFrameCount:
                  contestantBlankFrames.get(previous.candidate.id) ?? 0,
              };
            }),
            contestants: contestantLODStates(step.expectedLOD),
          });
        }
      } finally {
        controlledDistance = null;
        cancelAnimationFrame(cameraControlFrame);
        if (cameraUpdateWasOwnProperty) {
          cameraSystem.update = originalCameraUpdate;
        } else {
          delete cameraSystem.update;
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }

      const networkFault = {
        targetUrl: urls[1],
        targetLOD: 1,
        failedAttempt: null,
        recovery: null,
      };
      const swaps = [];
      const originalResolver = player.resolveAvatarLODSelection.bind(player);
      const originalUpdate = player.update;
      try {
        // Hold this audited entity in its current visible state while each manual
        // loader handoff runs. Natural distance selection remains sampled above;
        // this isolates scene disposal, emote continuity, and equipment replay.
        player.update = () => undefined;
        await world.loader.clearCachedFile(networkFault.targetUrl);
        world.loader.promises?.delete?.(`avatar/${networkFault.targetUrl}`);
        const faultPreviousAvatar = player.avatar;
        const faultPreviousScene = getScene(faultPreviousAvatar);
        const faultPreviousUrl = player.avatarUrl;
        const faultPreviousEmote = player.lastEmote ?? null;
        let faultFrameCount = 0;
        let faultBlankFrameCount = 0;
        let faultLifecycleBlankFrameCount = 0;
        let faultMonitorFrame = 0;
        let faultMonitoring = true;
        const monitorFault = () => {
          if (!faultMonitoring) return;
          faultFrameCount += 1;
          const currentScene = getScene(player.avatar);
          const previousVisible = Boolean(
            faultPreviousScene?.parent && faultPreviousScene.visible,
          );
          const currentVisible = Boolean(
            currentScene?.parent && currentScene.visible,
          );
          if (!previousVisible && !currentVisible) {
            faultLifecycleBlankFrameCount += 1;
            const readiness =
              equipmentVisuals.getStreamingDuelEquipmentVisualReadiness();
            const presentationRequired =
              readiness.requiredCount > 0 &&
              window.__HYPERIA_STREAM_RENDERER_HEALTH__?.phase === "FIGHTING";
            if (presentationRequired) {
              faultBlankFrameCount += 1;
            }
          }
          faultMonitorFrame = requestAnimationFrame(monitorFault);
        };
        player.resolveAvatarLODSelection = () => ({
          url: networkFault.targetUrl,
          lod: networkFault.targetLOD,
        });
        await window.__HYPERIA_SET_LOD_NETWORK_FAULT__(true);
        faultMonitorFrame = requestAnimationFrame(monitorFault);
        const faultStartedAt = performance.now();
        await player.applyAvatar();
        if (faultProfile.expectInitialFailure) {
          await waitFor(
            "active-fight retained avatar after failed LOD load",
            () => {
              const readiness =
                equipmentVisuals.getStreamingDuelEquipmentVisualReadiness();
              const scene = getScene(player.avatar);
              return (
                readiness.ready === true &&
                readiness.requiredCount > 0 &&
                window.__HYPERIA_STREAM_RENDERER_HEALTH__?.phase ===
                  "FIGHTING" &&
                Boolean(scene?.parent && scene.visible)
              );
            },
            90_000,
          );
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const failedScene = getScene(player.avatar);
          const failedReadiness =
            equipmentVisuals.getStreamingDuelEquipmentVisualReadiness();
          networkFault.failedAttempt = {
            fromUrl: faultPreviousUrl,
            targetUrl: networkFault.targetUrl,
            committedUrl: player.avatarUrl,
            committedLOD: player.avatarLOD,
            durationMs: Number((performance.now() - faultStartedAt).toFixed(1)),
            avatarUnchanged: player.avatar === faultPreviousAvatar,
            previousSceneRetained: Boolean(faultPreviousScene?.parent),
            previousSceneVisible: Boolean(
              faultPreviousScene?.parent && faultPreviousScene.visible,
            ),
            currentSceneVisible: Boolean(
              failedScene?.parent && failedScene.visible,
            ),
            loading: player.isLoadingAvatar,
            previousEmote: faultPreviousEmote,
            committedEmote: player.lastEmote ?? null,
            equipmentReady: failedReadiness.ready,
            equipmentReadyCount: failedReadiness.readyCount,
            equipmentRequiredCount: failedReadiness.requiredCount,
            equipmentUnresolved: failedReadiness.unresolved,
            equipmentAttachmentMismatches: failedReadiness.attachmentMismatches,
          };
          if (player.avatar !== faultPreviousAvatar) {
            throw new Error("failed LOD request replaced the active avatar");
          }

          // Resume the real production update loop. PlayerRemote's 15-second
          // outer retry fence must elapse before the fourth HTTP request can load
          // and atomically replace the retained LOD0 scene.
          player.update = originalUpdate;
          await waitFor(
            "automatic LOD retry after complete asset-load failure",
            () =>
              player.avatarUrl === networkFault.targetUrl &&
              player.avatarLOD === networkFault.targetLOD &&
              !player.isLoadingAvatar,
            40_000,
          );
        }
        await waitFor(
          "active-fight equipment readiness after automatic LOD retry",
          () => {
            const readiness =
              equipmentVisuals.getStreamingDuelEquipmentVisualReadiness();
            const scene = getScene(player.avatar);
            return (
              readiness.ready === true &&
              readiness.requiredCount > 0 &&
              window.__HYPERIA_STREAM_RENDERER_HEALTH__?.phase === "FIGHTING" &&
              Boolean(scene?.parent && scene.visible)
            );
          },
          90_000,
        );
        await new Promise((resolve) => requestAnimationFrame(resolve));
        faultMonitoring = false;
        cancelAnimationFrame(faultMonitorFrame);
        const recoveredScene = getScene(player.avatar);
        const recoveredReadiness =
          equipmentVisuals.getStreamingDuelEquipmentVisualReadiness();
        networkFault.recovery = {
          targetUrl: networkFault.targetUrl,
          committedUrl: player.avatarUrl,
          committedLOD: player.avatarLOD,
          totalDurationMs: Number(
            (performance.now() - faultStartedAt).toFixed(1),
          ),
          frameCount: faultFrameCount,
          blankFrameCount: faultBlankFrameCount,
          lifecycleBlankFrameCount: faultLifecycleBlankFrameCount,
          avatarReplaced: player.avatar !== faultPreviousAvatar,
          previousSceneRemoved: !faultPreviousScene?.parent,
          currentSceneVisible: Boolean(
            recoveredScene?.parent && recoveredScene.visible,
          ),
          previousEmote: faultPreviousEmote,
          committedEmote: player.lastEmote ?? null,
          equipmentReady: recoveredReadiness.ready,
          equipmentReadyCount: recoveredReadiness.readyCount,
          equipmentRequiredCount: recoveredReadiness.requiredCount,
          equipmentUnresolved: recoveredReadiness.unresolved,
          equipmentAttachmentMismatches:
            recoveredReadiness.attachmentMismatches,
        };
        await window.__HYPERIA_SET_LOD_NETWORK_FAULT__(false);

        player.update = () => undefined;
        for (const targetLOD of [2, 1, 0]) {
          await waitFor(
            "the preceding avatar load",
            () => !player.isLoadingAvatar,
          );
          const targetUrl = urls[targetLOD];
          const previousAvatar = player.avatar;
          const previousScene = getScene(previousAvatar);
          const previousUrl = player.avatarUrl;
          const previousEmote = player.lastEmote ?? null;
          let frameCount = 0;
          let blankFrameCount = 0;
          let rafId = 0;
          let monitoring = true;
          const monitor = () => {
            if (!monitoring) return;
            frameCount += 1;
            const currentScene = getScene(player.avatar);
            const previousVisible = Boolean(
              previousScene?.parent && previousScene.visible,
            );
            const currentVisible = Boolean(
              currentScene?.parent && currentScene.visible,
            );
            if (!previousVisible && !currentVisible) blankFrameCount += 1;
            rafId = requestAnimationFrame(monitor);
          };

          player.resolveAvatarLODSelection = () => ({
            url: targetUrl,
            lod: targetLOD,
          });
          rafId = requestAnimationFrame(monitor);
          const startedAt = performance.now();
          await player.applyAvatar();
          await new Promise((resolve) => requestAnimationFrame(resolve));
          monitoring = false;
          cancelAnimationFrame(rafId);

          await waitFor(
            `equipment readiness after LOD${targetLOD}`,
            () =>
              equipmentVisuals.getStreamingDuelEquipmentVisualReadiness()
                .ready === true,
          );
          const currentScene = getScene(player.avatar);
          const readiness =
            equipmentVisuals.getStreamingDuelEquipmentVisualReadiness();
          swaps.push({
            fromUrl: previousUrl,
            targetUrl,
            committedUrl: player.avatarUrl,
            committedLOD: player.avatarLOD,
            durationMs: Number((performance.now() - startedAt).toFixed(1)),
            frameCount,
            blankFrameCount,
            avatarReplaced: player.avatar !== previousAvatar,
            previousSceneRemoved: !previousScene?.parent,
            currentSceneVisible: Boolean(
              currentScene?.parent && currentScene.visible,
            ),
            previousEmote,
            committedEmote: player.lastEmote ?? null,
            equipmentReady: readiness.ready,
            equipmentReadyCount: readiness.readyCount,
            equipmentRequiredCount: readiness.requiredCount,
            equipmentUnresolved: readiness.unresolved,
            equipmentAttachmentMismatches: readiness.attachmentMismatches,
          });
        }
      } finally {
        await window.__HYPERIA_SET_LOD_NETWORK_FAULT__(false);
        player.resolveAvatarLODSelection = originalResolver;
        player.update = originalUpdate;
      }

      return {
        userAgent: navigator.userAgent,
        renderer: world.graphics?.renderer?.info?.render ?? null,
        player: {
          id: player.id,
          name: player.data.name,
          requestedUrl: urls[0],
        },
        contestants: players.map((candidate) => ({
          id: candidate.id,
          name: candidate.data.name,
          avatarUrl: candidate.avatarUrl,
        })),
        naturalSamples,
        distanceTraversal,
        networkFault,
        swaps,
        finalEquipmentReadiness:
          equipmentVisuals.getStreamingDuelEquipmentVisualReadiness(),
      };
    },
    { expectInitialFailure: faultMode !== "throttled-200" },
  );

  await page.waitForFunction(
    () => {
      const fightLogVisible = [...document.querySelectorAll("span")].some(
        (element) =>
          element.textContent?.trim() === "FIGHT LOG" &&
          element.getBoundingClientRect().width > 0 &&
          element.getBoundingClientRect().height > 0,
      );
      return (
        window.__HYPERIA_STREAM_READY__ === true &&
        window.__HYPERIA_STREAM_RENDERER_HEALTH__?.ready === true &&
        window.__HYPERIA_STREAM_RENDERER_HEALTH__?.phase === "FIGHTING" &&
        window.__HYPERIA_STREAM_BOOT_STATUS__ === null &&
        document.querySelector(".loading-screen") === null &&
        fightLogVisible
      );
    },
    undefined,
    { timeout: timeoutMs },
  );
  const presentation = await page.evaluate(() => ({
    rendererHealth: window.__HYPERIA_STREAM_RENDERER_HEALTH__ ?? null,
    bootStatus: window.__HYPERIA_STREAM_BOOT_STATUS__ ?? null,
    loadingScreenCount: document.querySelectorAll(".loading-screen").length,
    fightLogVisible: [...document.querySelectorAll("span")].some(
      (element) =>
        element.textContent?.trim() === "FIGHT LOG" &&
        element.getBoundingClientRect().width > 0 &&
        element.getBoundingClientRect().height > 0,
    ),
  }));
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const failures = [];
  if (presentation.rendererHealth?.ready !== true) {
    failures.push("stream renderer did not report ready");
  }
  if (presentation.rendererHealth?.phase !== "FIGHTING") {
    failures.push("stream renderer was not presenting an active fight");
  }
  if (presentation.bootStatus !== null) {
    failures.push("stream boot status did not clear");
  }
  if (presentation.loadingScreenCount !== 0) {
    failures.push("stream loading screen remained visible");
  }
  if (!presentation.fightLogVisible) {
    failures.push("stream Fight Log was not visible");
  }
  const faultRequestActions = lodNetworkFault.requests.map(
    (request) => request.action,
  );
  const injectedAction =
    faultMode === "http-503"
      ? "fulfilled-503"
      : faultMode === "truncated-200"
        ? "fulfilled-truncated-200"
        : faultMode;
  const expectedFaultActions =
    faultMode === "throttled-200"
      ? [injectedAction]
      : [injectedAction, injectedAction, injectedAction, "continued"];
  if (
    JSON.stringify(faultRequestActions) !== JSON.stringify(expectedFaultActions)
  ) {
    failures.push(
      `wrong LOD fault request sequence: ${faultRequestActions.join(",") || "none"}`,
    );
  }
  if (
    new Set(lodNetworkFault.requests.map((request) => request.url)).size !== 1
  ) {
    failures.push("LOD retry requests did not retain one exact target URL");
  }
  const faultResponseStatuses = lodNetworkFault.responses.map(
    (response) => response.status,
  );
  const expectedFaultStatuses =
    faultMode === "http-503"
      ? [503, 503, 503, 200]
      : faultMode === "throttled-200"
        ? [200]
        : [200, 200, 200, 200];
  if (
    JSON.stringify(faultResponseStatuses) !==
    JSON.stringify(expectedFaultStatuses)
  ) {
    failures.push(
      `wrong LOD fault response sequence: ${faultResponseStatuses.join(",") || "none"}`,
    );
  }
  const expectedNetworkFailureCount = faultMode === "http-503" ? 3 : 0;
  if (expectedLODNetworkFailures.length !== expectedNetworkFailureCount) {
    failures.push(
      `expected ${expectedNetworkFailureCount} retained LOD HTTP failures, received ${expectedLODNetworkFailures.length}`,
    );
  }
  const expectedRequestFailureCount = [
    "stalled-body-200",
    "connection-reset-200",
  ].includes(faultMode)
    ? 3
    : 0;
  if (expectedLODRequestFailures.length !== expectedRequestFailureCount) {
    failures.push(
      `expected ${expectedRequestFailureCount} retained LOD request aborts, received ${expectedLODRequestFailures.length}`,
    );
  }
  if (
    faultMode === "stalled-body-200" &&
    (stalledBodyRequests.length !== 3 ||
      stalledBodyRequests.some((request) => !request.closedBeforeComplete))
  ) {
    failures.push("stalled-body server did not observe three bounded aborts");
  }
  if (
    faultMode === "connection-reset-200" &&
    (connectionResetRequests.length !== 3 ||
      connectionResetRequests.some(
        (request) =>
          !request.resetAfterPartialBody || !request.closedBeforeComplete,
      ))
  ) {
    failures.push(
      "connection-reset server did not observe three partial-body resets",
    );
  }
  if (faultMode === "throttled-200") {
    const request = throttledBodyRequests[0];
    if (
      throttledBodyRequests.length !== 1 ||
      !request?.completed ||
      request.closedBeforeComplete ||
      request.bytesSent !== throttledAvatarBody.length ||
      request.durationMs < 3_500
    ) {
      failures.push(
        "throttled-body server did not complete one shaped transfer",
      );
    }
    if (expectedLODBrowserIssues.length !== 0) {
      failures.push(
        "throttled-body load unexpectedly entered retry diagnostics",
      );
    }
  } else {
    if (
      !expectedLODBrowserIssues.some((issue) =>
        issue.includes("Avatar fetch attempt 1/3 failed"),
      ) ||
      !expectedLODBrowserIssues.some((issue) =>
        issue.includes("Avatar fetch attempt 2/3 failed"),
      ) ||
      !expectedLODBrowserIssues.some((issue) =>
        issue.includes("Avatar load failed:"),
      )
    ) {
      failures.push("LOD retry diagnostics did not prove exhaustion");
    }
  }
  const failedLOD = runtime.networkFault.failedAttempt;
  if (faultMode === "throttled-200" && failedLOD) {
    failures.push("throttled successful load recorded a failed attempt");
  } else if (faultMode !== "throttled-200" && !failedLOD) {
    failures.push("missing failed LOD-attempt evidence");
  } else if (failedLOD) {
    if (!failedLOD.avatarUnchanged) {
      failures.push("failed LOD attempt changed avatar authority");
    }
    if (!failedLOD.previousSceneRetained || !failedLOD.previousSceneVisible) {
      failures.push("failed LOD attempt did not retain the visible old scene");
    }
    if (!failedLOD.currentSceneVisible) {
      failures.push("failed LOD attempt left the contestant invisible");
    }
    if (failedLOD.loading) {
      failures.push("failed LOD attempt left loading authority stuck");
    }
    if (
      !failedLOD.equipmentReady ||
      failedLOD.equipmentRequiredCount < 1 ||
      failedLOD.equipmentReadyCount !== failedLOD.equipmentRequiredCount ||
      failedLOD.equipmentUnresolved.length > 0 ||
      failedLOD.equipmentAttachmentMismatches.length > 0
    ) {
      failures.push("failed LOD attempt disturbed equipment readiness");
    }
  }
  const recoveredLOD = runtime.networkFault.recovery;
  if (!recoveredLOD) {
    failures.push("missing recovered LOD evidence");
  } else {
    if (
      recoveredLOD.committedUrl !== runtime.networkFault.targetUrl ||
      recoveredLOD.committedLOD !== runtime.networkFault.targetLOD
    ) {
      failures.push("automatic LOD retry committed the wrong selection");
    }
    if (!recoveredLOD.avatarReplaced || !recoveredLOD.previousSceneRemoved) {
      failures.push("automatic LOD retry did not replace the retained scene");
    }
    if (!recoveredLOD.currentSceneVisible) {
      failures.push("automatic LOD retry committed an invisible scene");
    }
    if (recoveredLOD.blankFrameCount !== 0) {
      failures.push(
        `${recoveredLOD.blankFrameCount} blank frames across LOD fault recovery`,
      );
    }
    if (
      faultMode !== "throttled-200" &&
      recoveredLOD.totalDurationMs < 19_000
    ) {
      failures.push("LOD recovery bypassed the production outer retry fence");
    }
    if (
      faultMode === "throttled-200" &&
      (recoveredLOD.totalDurationMs < 3_500 ||
        recoveredLOD.totalDurationMs >= 30_000)
    ) {
      failures.push("throttled LOD transfer missed its bounded success window");
    }
    if (
      !recoveredLOD.equipmentReady ||
      recoveredLOD.equipmentRequiredCount < 1 ||
      recoveredLOD.equipmentReadyCount !==
        recoveredLOD.equipmentRequiredCount ||
      recoveredLOD.equipmentUnresolved.length > 0 ||
      recoveredLOD.equipmentAttachmentMismatches.length > 0
    ) {
      failures.push("automatic LOD retry did not restore equipment readiness");
    }
  }
  for (const step of runtime.distanceTraversal) {
    if (step.committedUrl !== step.targetUrl) {
      failures.push(`wrong natural-traversal URL for ${step.id}`);
    }
    if (step.committedLOD !== step.expectedLOD) {
      failures.push(`wrong natural-traversal LOD for ${step.id}`);
    }
    if (Math.abs(step.actualDistance - step.distance) > 0.25) {
      failures.push(`camera distance drifted during ${step.id}`);
    }
    if (step.transitionExpected) {
      if (!step.avatarReplaced) {
        failures.push(`avatar not replaced during ${step.id}`);
      }
      if (!step.previousSceneRemoved) {
        failures.push(`previous scene retained during ${step.id}`);
      }
    } else {
      if (step.avatarReplaced) {
        failures.push(
          `avatar thrashed inside hysteresis band during ${step.id}`,
        );
      }
      if (!step.previousSceneRetained) {
        failures.push(`active scene was removed during ${step.id}`);
      }
    }
    if (!step.currentSceneVisible) {
      failures.push(`current scene invisible after ${step.id}`);
    }
    if (step.blankFrameCount !== 0) {
      failures.push(`${step.blankFrameCount} blank frames during ${step.id}`);
    }
    if (!step.equipmentReady) {
      failures.push(`equipment not ready after ${step.id}`);
    }
    if (
      step.equipmentReadyCount !== step.equipmentRequiredCount ||
      step.equipmentUnresolved.length > 0 ||
      step.equipmentAttachmentMismatches.length > 0
    ) {
      failures.push(`equipment contract mismatch after ${step.id}`);
    }
    if (step.contestants.some((contestant) => contestant.loading)) {
      failures.push(`contestant still loading after ${step.id}`);
    }
    if (
      step.contestants.some(
        (contestant) =>
          contestant.lod !== step.expectedLOD ||
          contestant.url !== contestant.expectedUrl,
      )
    ) {
      failures.push(
        `contestants did not converge on their expected LOD URLs after ${step.id}`,
      );
    }
    if (step.contestants.some((contestant) => !contestant.sceneVisible)) {
      failures.push(`contestant scene invisible after ${step.id}`);
    }
    for (const contestant of step.contestantTransitions) {
      if (contestant.committedUrl !== contestant.targetUrl) {
        failures.push(
          `${contestant.name} committed the wrong URL during ${step.id}`,
        );
      }
      if (step.transitionExpected) {
        if (!contestant.avatarReplaced) {
          failures.push(
            `${contestant.name} was not replaced during ${step.id}`,
          );
        }
        if (!contestant.previousSceneRemoved) {
          failures.push(
            `${contestant.name} retained its previous scene during ${step.id}`,
          );
        }
      } else {
        if (contestant.avatarReplaced) {
          failures.push(
            `${contestant.name} thrashed inside the hysteresis band during ${step.id}`,
          );
        }
        if (!contestant.previousSceneRetained) {
          failures.push(
            `${contestant.name} lost its active scene during ${step.id}`,
          );
        }
      }
      if (!contestant.currentSceneVisible) {
        failures.push(`${contestant.name} was invisible after ${step.id}`);
      }
      if (contestant.blankFrameCount !== 0) {
        failures.push(
          `${contestant.name} had ${contestant.blankFrameCount} blank frames during ${step.id}`,
        );
      }
    }
  }
  for (const swap of runtime.swaps) {
    if (swap.committedUrl !== swap.targetUrl) {
      failures.push(`wrong committed URL for ${swap.targetUrl}`);
    }
    if (!swap.avatarReplaced)
      failures.push(`avatar not replaced for ${swap.targetUrl}`);
    if (!swap.previousSceneRemoved) {
      failures.push(`previous scene retained for ${swap.targetUrl}`);
    }
    if (!swap.currentSceneVisible) {
      failures.push(`replacement scene invisible for ${swap.targetUrl}`);
    }
    if (swap.blankFrameCount !== 0) {
      failures.push(
        `${swap.blankFrameCount} blank frames for ${swap.targetUrl}`,
      );
    }
    if (!swap.equipmentReady) {
      failures.push(`equipment not ready after ${swap.targetUrl}`);
    }
    if (
      swap.equipmentReadyCount !== swap.equipmentRequiredCount ||
      swap.equipmentUnresolved.length > 0 ||
      swap.equipmentAttachmentMismatches.length > 0
    ) {
      failures.push(`equipment contract mismatch after ${swap.targetUrl}`);
    }
  }

  const unexpectedBrowserIssues = unique(browserIssues);
  if (unexpectedBrowserIssues.length > 0) {
    failures.push(`${unexpectedBrowserIssues.length} browser issue(s)`);
  }
  if (networkFailures.length > 0) {
    failures.push(`${unique(networkFailures).length} network failure(s)`);
  }

  const evidence = {
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    clientUrl,
    browser: {
      executablePath,
      webgpu: true,
      backendFlags: ["--enable-unsafe-webgpu", "--use-angle=metal"],
    },
    runtime,
    presentation,
    lodNetworkFault: {
      mode: faultMode,
      maxFailures: lodNetworkFault.maxFailures,
      requests: lodNetworkFault.requests,
      responses: lodNetworkFault.responses,
      expectedBrowserIssues: unique(expectedLODBrowserIssues),
      expectedNetworkFailures: unique(expectedLODNetworkFailures),
      expectedRequestFailures: expectedLODRequestFailures,
      stalledBodyRequests,
      connectionResetRequests,
      throttledBodyRequests,
    },
    browserIssues: unique(browserIssues),
    unexpectedBrowserIssues,
    networkFailures: unique(networkFailures),
    failures,
    screenshotPath,
  };
  await fs.writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.ok) process.exitCode = 1;
} finally {
  await page?.close().catch(() => undefined);
  await browser.close();
  if (partialBodyServer) {
    partialBodyServer.closeAllConnections();
    await new Promise((resolve) => partialBodyServer.close(resolve));
  }
}
