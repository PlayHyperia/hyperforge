#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import puppeteer from "puppeteer";

import { validateFishingWorldPresentationAuditManifest } from "./lib/fishing-world-presentation-audit.mjs";

const EXPECTED_NODE_VERSION = "v22.23.2";
const CONFIG_PATH = "scripts/active-fishing-world-presentation-audit.json";
const OUTPUT_DIRECTORY =
  "artifacts/duel-launch-avatar-bakeoff/active-fishing-world-presentation";
const SCREENSHOT_PATH = `${OUTPUT_DIRECTORY}/active-fishing-world-presentation-contact-sheet.png`;
const REPORT_PATH = `${OUTPUT_DIRECTORY}/active-fishing-world-presentation-report.json`;
const IMPLEMENTATION_PATHS = Object.freeze([
  "scripts/capture-active-fishing-world-presentation.mjs",
  "scripts/fishing-world-presentation-browser.ts",
  "scripts/lib/fishing-world-presentation-audit.mjs",
  "packages/shared/src/systems/client/EquipmentVisualSystem.ts",
  "packages/shared/src/systems/client/EquipmentVisualHelpers.ts",
  "packages/shared/src/systems/shared/entities/gathering/FishingInteractionPresentation.ts",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeAtomic(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, contents, { flag: "wx" });
    renameSync(temporary, filePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function safeWorkspacePath(workspaceRoot, relativePath, label) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    path.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.startsWith("../")
  ) {
    throw new Error(`${label} must be a normalized workspace-relative path`);
  }
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes the workspace`);
  }
  return resolved;
}

function parseArguments(argv) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0])) {
    throw new Error("Specify exactly one of --write or --check");
  }
  return { write: argv[0] === "--write" };
}

function pngDimensions(input) {
  if (
    !Buffer.isBuffer(input) ||
    input.length < 24 ||
    input.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  ) {
    throw new Error("Fishing world-presentation contact sheet is not a PNG");
  }
  return { width: input.readUInt32BE(16), height: input.readUInt32BE(20) };
}

function html(config) {
  const serialized = JSON.stringify(config).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Hyperia active fishing world-presentation audit</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 26px; width: 1800px; background: #080b13; color: #f3f5fb; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      header { margin-bottom: 22px; }
      h1 { margin: 0 0 6px; font-size: 30px; }
      header p { margin: 0; color: #99a4ba; font-size: 14px; }
      main { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
      article { overflow: hidden; border: 1px solid #28324a; border-radius: 14px; background: #111725; box-shadow: 0 12px 30px #0007; }
      article[data-status="fail"] { border-color: #a94055; }
      img { display: block; width: 100%; height: 480px; object-fit: contain; background: linear-gradient(#1b2740, #0c101a); }
      .meta { min-height: 92px; padding: 13px 15px 15px; border-top: 1px solid #28324a; }
      .name { font-size: 16px; font-weight: 750; }
      .stats { margin-top: 10px; color: #67d9a8; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
      article[data-status="fail"] .stats, pre { color: #ff8c8c; }
    </style>
  </head>
  <body>
    <header><h1>${config.title}</h1><p>Actual EquipmentVisualSystem · exact active Steve fits and world models · release/deploy/retrieve/late-join/cleanup · Chrome/Metal</p></header>
    <main></main>
    <script type="module">
      import { runFishingWorldPresentationAudit } from "/audit.js";
      try {
        window.__auditReport = await runFishingWorldPresentationAudit(${serialized});
        document.body.dataset.ready = "true";
      } catch (error) {
        const output = document.createElement("pre");
        output.textContent = error?.stack ?? String(error);
        document.body.prepend(output);
        document.body.dataset.error = output.textContent;
      }
    </script>
  </body>
</html>`;
}

function validateActiveManifestLinkage(workspaceRoot, config) {
  const toolsPath = path.join(
    workspaceRoot,
    "packages/server/world/assets/manifests/items/tools.json",
  );
  const activationPath = path.join(
    workspaceRoot,
    "packages/server/world/assets/manifests/duel-presentation-assets.json",
  );
  const toolsDocument = JSON.parse(readFileSync(toolsPath, "utf8"));
  const tools = Array.isArray(toolsDocument)
    ? toolsDocument
    : toolsDocument.items;
  const activationDocument = JSON.parse(readFileSync(activationPath, "utf8"));
  for (const definition of config.items) {
    const item = tools.find((candidate) => candidate.id === definition.itemId);
    const activation = activationDocument.activations.find(
      (candidate) =>
        candidate.state === "active" &&
        candidate.avatarId === "steve" &&
        candidate.itemId === definition.itemId &&
        candidate.slot === "gatheringtool",
    );
    const heldUrl = `asset://${definition.heldAsset.replace(
      "packages/server/world/assets/",
      "",
    )}`;
    const worldUrl = `asset://${definition.worldAsset.replace(
      "packages/server/world/assets/",
      "",
    )}`;
    const deployMotionUrl = `asset://${definition.deployMotionAsset.replace(
      "packages/server/world/assets/",
      "",
    )}`;
    const retrievalMotionUrl = `asset://${config.retrievalMotion.asset.replace(
      "packages/server/world/assets/",
      "",
    )}`;
    if (
      !item ||
      item.gatheringModelPathsByAvatar?.steve !== heldUrl ||
      item.modelPath !== worldUrl ||
      !activation ||
      activation.equipment?.assetUrl !== heldUrl ||
      activation.equipment?.sha256 !== definition.heldSha256 ||
      activation.worldModel?.assetUrl !== worldUrl ||
      activation.worldModel?.sha256 !== definition.worldSha256 ||
      activation.motion?.assetUrl !== deployMotionUrl ||
      activation.motion?.sha256 !== definition.deployMotionSha256 ||
      activation.retrievalMotion?.assetUrl !== retrievalMotionUrl ||
      activation.retrievalMotion?.sha256 !== config.retrievalMotion.sha256
    ) {
      throw new Error(
        `${definition.itemId} active presentation linkage drifted`,
      );
    }
  }
  return {
    tools: {
      path: path.relative(workspaceRoot, toolsPath),
      sha256: sha256(readFileSync(toolsPath)),
    },
    activations: {
      path: path.relative(workspaceRoot, activationPath),
      sha256: sha256(readFileSync(activationPath)),
    },
  };
}

function validateReport(report, config, expected) {
  if (
    report.schemaVersion !== 1 ||
    report.exportedAt !== config.exportedAt ||
    report.status !== "active_fishing_world_presentation_certified" ||
    report.authority.sha256 !== expected.authority.sha256 ||
    JSON.stringify(report.inputs) !== JSON.stringify(expected.inputs) ||
    JSON.stringify(report.implementation) !==
      JSON.stringify(expected.implementation) ||
    JSON.stringify(report.activeManifestLinkage) !==
      JSON.stringify(expected.activeManifestLinkage) ||
    report.summary.itemCount !== 2 ||
    report.summary.phaseCount !== 16 ||
    report.summary.lateJoinCount !== 2 ||
    report.summary.failureCount !== 0 ||
    report.summary.browserErrorCount !== 0 ||
    report.summary.actionPosePhaseCount !== 8 ||
    typeof report.summary.minimumObservedActionArmDeviationDegrees !==
      "number" ||
    !Number.isFinite(report.summary.minimumObservedActionArmDeviationDegrees) ||
    report.summary.minimumObservedActionArmDeviationDegrees <
      config.pose.minimumActionArmDeviationDegrees ||
    report.summary.staleRevisionRejected !== true ||
    report.summary.cleanupPassed !== true ||
    !Array.isArray(report.phases) ||
    report.phases.length !== 16 ||
    report.phases.some((phase) => phase.failures.length > 0) ||
    report.phases.some(
      (phase) =>
        typeof phase.armPoseDeviationDegrees !== "number" ||
        phase.armPoseDeviationDegrees < phase.minimumArmPoseDeviationDegrees ||
        phase.worldVisualKind !== phase.expectedWorldVisualKind,
    ) ||
    !Array.isArray(report.lateJoin) ||
    report.lateJoin.length !== 2 ||
    report.lateJoin.some((entry) => entry.failures.length > 0) ||
    !Array.isArray(report.browserErrors) ||
    report.browserErrors.length > 0 ||
    !Array.isArray(report.failures) ||
    report.failures.length > 0 ||
    report.performance.iterations !== config.performance.iterations ||
    report.performance.p95FrameWorkMs >
      config.performance.maximumP95FrameWorkMs ||
    report.performance.maximumFrameWorkMs >
      config.performance.maximumSingleFrameWorkMs ||
    report.screenshot.sha256 !== expected.screenshot.sha256 ||
    report.screenshot.width !== expected.screenshot.width ||
    report.screenshot.height !== expected.screenshot.height
  ) {
    throw new Error(
      `Fishing world-presentation evidence is invalid or stale: ${JSON.stringify(
        {
          summary: report.summary,
          phaseFailures: report.phases
            ?.filter((phase) => phase.failures?.length > 0)
            .map((phase) => ({
              itemId: phase.itemId,
              id: phase.id,
              armPoseDeviationDegrees: phase.armPoseDeviationDegrees,
              minimumArmPoseDeviationDegrees:
                phase.minimumArmPoseDeviationDegrees,
              failures: phase.failures,
            })),
          lateJoinFailures: report.lateJoin?.filter(
            (entry) => entry.failures?.length > 0,
          ),
          performance: report.performance,
          browserErrors: report.browserErrors,
          failures: report.failures,
        },
      )}`,
    );
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (process.version !== EXPECTED_NODE_VERSION) {
    throw new Error(
      `Fishing world-presentation audit requires Node.js ${EXPECTED_NODE_VERSION}; found ${process.version}`,
    );
  }
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const configPath = safeWorkspacePath(workspaceRoot, CONFIG_PATH, "authority");
  const configBytes = readFileSync(configPath);
  const config = validateFishingWorldPresentationAuditManifest(
    JSON.parse(configBytes.toString("utf8")),
  );
  const inputs = Object.fromEntries(
    [
      { path: config.avatar.asset, sha256: config.avatar.sha256 },
      { path: config.idleMotion.asset, sha256: config.idleMotion.sha256 },
      {
        path: config.retrievalMotion.asset,
        sha256: config.retrievalMotion.sha256,
      },
      ...config.items.flatMap((item) => [
        { path: item.heldAsset, sha256: item.heldSha256 },
        { path: item.worldAsset, sha256: item.worldSha256 },
        { path: item.deployMotionAsset, sha256: item.deployMotionSha256 },
      ]),
    ].map((input) => {
      const filePath = safeWorkspacePath(workspaceRoot, input.path, "input");
      if (
        !existsSync(filePath) ||
        sha256(readFileSync(filePath)) !== input.sha256
      ) {
        throw new Error(`${input.path} hash drifted`);
      }
      return [input.path, input.sha256];
    }),
  );
  const implementation = Object.fromEntries(
    IMPLEMENTATION_PATHS.map((relativePath) => [
      relativePath,
      sha256(
        readFileSync(
          safeWorkspacePath(workspaceRoot, relativePath, "implementation"),
        ),
      ),
    ]),
  );
  const authority = { path: CONFIG_PATH, sha256: sha256(configBytes) };
  const activeManifestLinkage = validateActiveManifestLinkage(
    workspaceRoot,
    config,
  );
  const screenshotPath = safeWorkspacePath(
    workspaceRoot,
    SCREENSHOT_PATH,
    "screenshot",
  );
  const reportPath = safeWorkspacePath(workspaceRoot, REPORT_PATH, "report");

  if (!options.write) {
    if (!existsSync(screenshotPath) || !existsSync(reportPath)) {
      throw new Error("Fishing world-presentation evidence is missing");
    }
    const screenshotBytes = readFileSync(screenshotPath);
    const dimensions = pngDimensions(screenshotBytes);
    validateReport(JSON.parse(readFileSync(reportPath, "utf8")), config, {
      authority,
      inputs,
      implementation,
      activeManifestLinkage,
      screenshot: {
        sha256: sha256(screenshotBytes),
        ...dimensions,
      },
    });
    process.stdout.write(
      "Verified exact active net/pot release, deployment, retrieval, late-join, stale-revision, cleanup, and browser performance evidence\n",
    );
    return;
  }

  const bundle = await build({
    entryPoints: [
      path.join(workspaceRoot, "scripts/fishing-world-presentation-browser.ts"),
    ],
    absWorkingDir: workspaceRoot,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    write: false,
    sourcemap: false,
    logLevel: "silent",
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.DISABLE_EVENT_HISTORY": '"true"',
    },
  });
  const bundleBytes = bundle.outputFiles[0].contents;
  const allowedAssets = new Set(Object.keys(inputs));
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html(config));
        return;
      }
      if (url.pathname === "/audit.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(bundleBytes);
        return;
      }
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204).end();
        return;
      }
      if (!url.pathname.startsWith("/asset/")) {
        response.writeHead(404).end();
        return;
      }
      const relativePath = decodeURIComponent(
        url.pathname.slice("/asset/".length),
      );
      if (!allowedAssets.has(relativePath)) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "model/gltf-binary",
        "cache-control": "no-store",
      });
      response.end(
        readFileSync(safeWorkspacePath(workspaceRoot, relativePath, "asset")),
      );
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No audit port");

  let browser;
  try {
    const chrome =
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    browser = await puppeteer.launch({
      headless: true,
      executablePath: existsSync(chrome) ? chrome : undefined,
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1800, height: 1200, deviceScaleFactor: 1 });
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${address.port}/`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForFunction(
      () =>
        document.body.dataset.ready === "true" || document.body.dataset.error,
      { timeout: 120_000 },
    );
    const pageError = await page.evaluate(() => document.body.dataset.error);
    if (pageError) {
      const uniqueBrowserErrors = [...new Set(browserErrors)];
      throw new Error(
        `${pageError}${
          uniqueBrowserErrors.length > 0
            ? `\nBrowser errors:\n${uniqueBrowserErrors.join("\n")}`
            : ""
        }`,
      );
    }
    const browserReport = await page.evaluate(() => window.__auditReport);
    const screenshotBytes = await page.screenshot({
      fullPage: true,
      type: "png",
    });
    const dimensions = pngDimensions(screenshotBytes);
    if (dimensions.width !== 1800 || dimensions.height < 3_000) {
      throw new Error("Fishing world-presentation contact sheet is undersized");
    }
    const actionPhases = browserReport.phases.filter(
      (phase) =>
        phase.minimumArmPoseDeviationDegrees ===
        config.pose.minimumActionArmDeviationDegrees,
    );
    if (actionPhases.length !== 8) {
      throw new Error("Fishing body-motion phase coverage is incomplete");
    }
    const minimumObservedActionArmDeviationDegrees = Math.min(
      ...actionPhases.map((phase) => phase.armPoseDeviationDegrees),
    );
    const report = {
      schemaVersion: 1,
      exportedAt: config.exportedAt,
      status: "active_fishing_world_presentation_certified",
      authority,
      inputs,
      implementation,
      activeManifestLinkage,
      runtime: {
        node: process.version,
        chrome: browserReport.userAgent,
        renderer: browserReport.renderer,
      },
      summary: {
        itemCount: config.items.length,
        phaseCount: browserReport.phases.length,
        lateJoinCount: browserReport.lateJoin.length,
        failureCount: browserReport.failures.length,
        browserErrorCount: browserErrors.length,
        actionPosePhaseCount: actionPhases.length,
        minimumObservedActionArmDeviationDegrees,
        staleRevisionRejected: browserReport.staleRevisionRejected,
        cleanupPassed: browserReport.cleanupPassed,
      },
      equipmentValidation: browserReport.equipmentValidation,
      phases: browserReport.phases,
      lateJoin: browserReport.lateJoin,
      performance: browserReport.performance,
      browserErrors: [...new Set(browserErrors)],
      failures: browserReport.failures,
      screenshot: {
        path: SCREENSHOT_PATH,
        sha256: sha256(screenshotBytes),
        bytes: screenshotBytes.length,
        ...dimensions,
      },
    };
    validateReport(report, config, {
      authority,
      inputs,
      implementation,
      activeManifestLinkage,
      screenshot: report.screenshot,
    });
    writeAtomic(screenshotPath, screenshotBytes);
    writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(
      `Captured ${report.summary.phaseCount} exact active fishing lifecycle phases plus ${report.summary.lateJoinCount} late-join reconstructions; p95 browser frame work ${report.performance.p95FrameWorkMs} ms\n`,
    );
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
