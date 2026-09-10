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

import { validateDuelAvatarMotionDefinition } from "./lib/duel-avatar-motion-manifest.mjs";
import { validateDuelMotionEquipmentSetManifest } from "./lib/duel-motion-equipment-set.mjs";

const MOTIONS = Object.freeze([
  {
    id: "idle",
    name: "Idle",
    asset: "emotes/emote-idle.glb",
    sampleRatio: 0.35,
  },
  {
    id: "walk",
    name: "Walk",
    asset: "emotes/emote-walk.glb",
    sampleRatio: 0.45,
  },
  {
    id: "run",
    name: "Run",
    asset: "emotes/emote-run.glb",
    sampleRatio: 0.45,
  },
  {
    id: "unarmed",
    name: "Unarmed attack",
    asset: "emotes/emote-punching.glb",
    sampleRatio: 0.5,
  },
  {
    id: "sword",
    name: "One-handed melee",
    asset: "emotes/emote_sword_swing.glb",
    sampleRatio: 0.45,
  },
  {
    id: "two-hand-idle",
    name: "Two-handed idle",
    asset: "emotes/emote-2h-idle.glb",
    sampleRatio: 0.4,
  },
  {
    id: "two-hand-slash",
    name: "Two-handed melee",
    asset: "emotes/emote-2h-slash.glb",
    sampleRatio: 0.45,
  },
  {
    id: "ranged",
    name: "Ranged attack",
    asset: "emotes/emote-range.glb",
    sampleRatio: 0.55,
  },
  {
    id: "magic",
    name: "Magic attack",
    asset: "emotes/emote-spell-cast.glb",
    sampleRatio: 0.55,
  },
  {
    id: "death",
    name: "Death",
    asset: "emotes/emote-death.glb",
    sampleRatio: 0.9,
  },
  {
    id: "victory",
    name: "Victory",
    asset: "emotes/emote-waving-both-hands.glb",
    sampleRatio: 0.55,
  },
  {
    id: "hit-reaction",
    name: "Hit reaction overlay",
    asset: "emotes/emote-idle.glb",
    sampleRatio: 0,
    hitReaction: {
      intensity: 1,
      side: 1,
      elapsedSeconds: 0.0504,
    },
  },
]);

const PRODUCTION_VRM_OVERLAP_ASSETS = Object.freeze({
  authoredMotion: "emotes/emote_sword_swing.glb",
  idleMotion: "emotes/emote-idle.glb",
});

const PRODUCTION_VRM_OVERLAP_SOURCES = Object.freeze([
  "scripts/capture-duel-avatar-motion.mjs",
  "scripts/duel-avatar-motion-browser.ts",
  "packages/shared/src/extras/three/createVRMFactory.ts",
  "packages/shared/src/extras/three/createEmoteFactory.ts",
  "packages/shared/src/extras/three/AvatarAuthoredMotionDiagnostics.ts",
  "packages/shared/src/extras/three/PlayerHitReactionController.ts",
]);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
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

function safePath(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) return null;
  return resolved;
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--production-vrm-overlap") {
      options.productionVrmOverlap = true;
    } else if (
      argument === "--avatar" ||
      argument === "--equipment" ||
      argument === "--equipment-set" ||
      argument === "--item-id" ||
      argument === "--equipment-slot" ||
      argument === "--avatar-id" ||
      argument === "--grip" ||
      argument === "--assets-root" ||
      argument === "--motions" ||
      argument === "--title" ||
      argument === "--output" ||
      argument === "--report"
    ) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      options[argument === "--assets-root" ? "assetsRoot" : argument.slice(2)] =
        value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function resolveWorkspacePath(workspaceRoot, value, fallback, label) {
  const resolved = path.resolve(workspaceRoot, value ?? fallback);
  if (
    resolved !== workspaceRoot &&
    !resolved.startsWith(`${workspaceRoot}${path.sep}`)
  ) {
    throw new Error(`${label} must remain inside the workspace`);
  }
  return resolved;
}

function html(config) {
  const serialized = JSON.stringify(config).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Hyperia duel-avatar motion audit</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 26px; width: 1600px; background: #080b13; color: #f3f5fb; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      header { margin: 0 0 22px; }
      h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: -0.02em; }
      header p { margin: 0; color: #99a4ba; font-size: 14px; }
      main { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
      article { overflow: hidden; border: 1px solid #28324a; border-radius: 14px; background: #111725; box-shadow: 0 12px 30px #0007; }
      article[data-status="fail"] { border-color: #a94055; }
      canvas { display: block; width: 100%; height: 440px; background: linear-gradient(#1b2740, #0c101a); }
      .meta { min-height: 99px; padding: 13px 15px 15px; border-top: 1px solid #28324a; }
      .name { font-size: 16px; font-weight: 700; }
      .asset { margin-top: 2px; color: #8f9ab0; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
      .stats { margin-top: 10px; color: #67d9a8; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
      article[data-status="fail"] .stats { color: #ff8c8c; }
      pre { white-space: pre-wrap; color: #ff8c8c; }
    </style>
  </head>
  <body>
    <header>
      <h1></h1>
      <p></p>
    </header>
    <main></main>
    <script type="module">
      import { runDuelAvatarMotionAudit } from "/motion-audit.js";
      try {
        document.querySelector("h1").textContent = ${JSON.stringify(config.title ?? "Hyperia canonical-rig motion audit")};
        document.querySelector("header p").textContent = ${JSON.stringify(config.subtitle ?? "Actual Hyperia retargeting and additive hit feedback · fixed representative poses · source registry unchanged")};
        window.__motionReport = await runDuelAvatarMotionAudit(${serialized});
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

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const assetsRoot = resolveWorkspacePath(
    workspaceRoot,
    options.assetsRoot,
    "packages/server/world/assets",
    "Assets root",
  );
  let motions = MOTIONS;
  let motionTitle;
  let framing = "avatar";
  let motionManifestPath;
  if (options.motions) {
    motionManifestPath = resolveWorkspacePath(
      workspaceRoot,
      options.motions,
      "",
      "Motion manifest",
    );
    const motionManifest = JSON.parse(readFileSync(motionManifestPath, "utf8"));
    const environment = motionManifest.environment;
    if (
      motionManifest.schemaVersion !== 1 ||
      !Array.isArray(motionManifest.motions) ||
      motionManifest.motions.length === 0 ||
      (motionManifest.framing !== undefined &&
        !["avatar", "avatar-and-equipment"].includes(motionManifest.framing)) ||
      (environment !== undefined &&
        (typeof environment !== "object" ||
          environment === null ||
          !Number.isFinite(environment.waterSurfaceBelowFeet) ||
          environment.waterSurfaceBelowFeet <= 0 ||
          environment.waterSurfaceBelowFeet > 2))
    ) {
      throw new Error(
        "Motion manifest must use schemaVersion 1 with motions and a supported framing mode",
      );
    }
    motions = motionManifest.motions.map((motion, index) => {
      if (!validateDuelAvatarMotionDefinition(motion)) {
        throw new Error(`Motion manifest entry ${index} is invalid`);
      }
      return motion;
    });
    motionTitle = motionManifest.title;
    framing = motionManifest.framing ?? "avatar";
    if (
      motions.some((motion) => motion.waterContact !== undefined) &&
      environment === undefined
    ) {
      throw new Error(
        "Water-contact motion expectations require an environment",
      );
    }
    options.environment = environment;
  }
  const avatarPath = resolveWorkspacePath(
    assetsRoot,
    options.avatar,
    "avatars/duel-candidates/duel-steve.vrm",
    "Avatar path",
  );
  if (!existsSync(avatarPath))
    throw new Error(`Avatar is missing: ${avatarPath}`);
  const avatarAsset = path
    .relative(assetsRoot, avatarPath)
    .split(path.sep)
    .join("/");
  const resolveEquipment = (definition) => {
    const equipmentPath = resolveWorkspacePath(
      assetsRoot,
      definition.asset,
      "",
      "Equipment path",
    );
    if (!existsSync(equipmentPath)) {
      throw new Error(`Equipment is missing: ${equipmentPath}`);
    }
    return {
      asset: path.relative(assetsRoot, equipmentPath).split(path.sep).join("/"),
      sha256: sha256(readFileSync(equipmentPath)),
      itemId: definition.itemId,
      avatarId: definition.avatarId,
      slot: definition.slot,
      grip: definition.grip,
    };
  };
  let equipment = null;
  let equipments = null;
  let equipmentSetTitle;
  let equipmentSetManifestPath;
  if (options["equipment-set"]) {
    if (
      options.equipment ||
      options["item-id"] ||
      options["equipment-slot"] ||
      options["avatar-id"] ||
      options.grip
    ) {
      throw new Error(
        "--equipment-set cannot be combined with single-equipment arguments",
      );
    }
    equipmentSetManifestPath = resolveWorkspacePath(
      workspaceRoot,
      options["equipment-set"],
      "",
      "Equipment-set manifest",
    );
    const equipmentSet = validateDuelMotionEquipmentSetManifest(
      JSON.parse(readFileSync(equipmentSetManifestPath, "utf8")),
    );
    equipmentSetTitle = equipmentSet.title;
    equipments = equipmentSet.equipments.map(resolveEquipment);
  } else if (options.equipment) {
    const equipmentSet = validateDuelMotionEquipmentSetManifest({
      schemaVersion: 1,
      equipments: [
        {
          asset: options.equipment,
          itemId: options["item-id"],
          avatarId: options["avatar-id"] ?? "steve",
          slot: options["equipment-slot"] ?? "weapon",
          grip: options.grip ?? "one-hand",
        },
      ],
    });
    equipment = resolveEquipment(equipmentSet.equipments[0]);
  } else if (
    options["item-id"] ||
    options["equipment-slot"] ||
    options["avatar-id"] ||
    options.grip
  ) {
    throw new Error("Single-equipment metadata requires --equipment");
  }
  for (const motion of motions) {
    const motionPath = safePath(assetsRoot, motion.asset);
    if (!motionPath || !existsSync(motionPath)) {
      throw new Error(`Motion asset is missing: ${motion.asset}`);
    }
  }
  const productionVrmOverlap = options.productionVrmOverlap
    ? Object.fromEntries(
        Object.entries(PRODUCTION_VRM_OVERLAP_ASSETS).map(([key, asset]) => {
          const assetPath = safePath(assetsRoot, asset);
          if (!assetPath || !existsSync(assetPath)) {
            throw new Error(
              `Production VRM overlap asset is missing: ${asset}`,
            );
          }
          return [
            key,
            {
              asset,
              sha256: sha256(readFileSync(assetPath)),
            },
          ];
        }),
      )
    : null;
  const outputPath = resolveWorkspacePath(
    workspaceRoot,
    options.output,
    "artifacts/duel-avatar-candidates/steve-motion-contact-sheet.png",
    "Output path",
  );
  const reportPath = resolveWorkspacePath(
    workspaceRoot,
    options.report,
    "artifacts/duel-avatar-candidates/steve-motion-report.json",
    "Report path",
  );
  const browserEntry = path.join(
    workspaceRoot,
    "scripts/duel-avatar-motion-browser.ts",
  );
  const bundleResult = await build({
    entryPoints: [browserEntry],
    absWorkingDir: workspaceRoot,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    write: false,
    sourcemap: false,
    logLevel: "silent",
  });
  const bundle = bundleResult.outputFiles[0].contents;
  const config = {
    avatarAsset,
    avatarSha256: sha256(readFileSync(avatarPath)),
    motions,
    framing,
    ...(options.environment ? { environment: options.environment } : {}),
    ...(equipment ? { equipment } : {}),
    ...(equipments ? { equipments } : {}),
    ...(productionVrmOverlap ? { productionVrmOverlap } : {}),
    title: options.title ?? equipmentSetTitle ?? motionTitle,
    subtitle: equipmentSetTitle
      ? `${motionTitle ?? "Canonical-rig motion matrix"} · combined production attachment path · active registry unchanged`
      : options.motions
        ? "Isolated non-AI candidate · combat, preparation, and reaction poses · active registry unchanged"
        : undefined,
  };
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html(config));
        return;
      }
      if (url.pathname === "/motion-audit.js") {
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
        });
        response.end(bundle);
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
      const filePath = safePath(
        assetsRoot,
        decodeURIComponent(url.pathname.slice("/asset/".length)),
      );
      if (!filePath) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "model/gltf-binary",
        "cache-control": "no-store",
      });
      response.end(readFileSync(filePath));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No local motion-audit server port");
  }

  let browser;
  try {
    const systemChrome =
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const executablePath =
      process.env.PUPPETEER_EXECUTABLE_PATH ??
      (existsSync(systemChrome) ? systemChrome : undefined);
    if (!executablePath || !existsSync(executablePath)) {
      throw new Error(
        "Motion acceptance requires an explicit installed Chrome executable",
      );
    }
    browser = await puppeteer.launch({
      headless: false,
      executablePath,
      args: ["--enable-unsafe-webgpu", "--use-angle=metal"],
    });
    const browserProcess = browser.process();
    if (
      !browserProcess?.pid ||
      browserProcess.spawnargs.some((argument) =>
        argument.startsWith("--headless"),
      )
    ) {
      throw new Error(
        "Motion acceptance requires a witnessed headful Chrome process",
      );
    }
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 1 });
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${address.port}/`, {
      waitUntil: "networkidle0",
      timeout: 120_000,
    });
    try {
      await page.waitForFunction(
        () =>
          document.body.dataset.ready === "true" || document.body.dataset.error,
        { timeout: 120_000 },
      );
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        ready: document.body.dataset.ready ?? null,
        error: document.body.dataset.error ?? null,
        text: document.body.innerText.slice(0, 2_000),
      }));
      throw new Error(
        `Motion audit readiness timed out: ${JSON.stringify({
          diagnostics,
          browserErrors: [...new Set(browserErrors)],
          cause: error instanceof Error ? error.message : String(error),
        })}`,
      );
    }
    const pageError = await page.evaluate(() => document.body.dataset.error);
    if (pageError) throw new Error(pageError);
    const report = await page.evaluate(() => window.__motionReport);
    if (
      typeof report?.userAgent !== "string" ||
      /HeadlessChrome/u.test(report.userAgent)
    ) {
      throw new Error(
        "Motion acceptance rejects missing or headless browser identity",
      );
    }
    if (report?.rendererBackend !== "webgpu") {
      throw new Error(
        `Motion audit did not report WebGPU: ${JSON.stringify(report?.rendererBackend ?? null)}`,
      );
    }
    report.browserLaunch = {
      headless: false,
      executablePath,
      version: await browser.version(),
      pid: browserProcess.pid,
      angle: "metal",
    };
    report.browserErrors = [...new Set(browserErrors)];
    report.browserBundle = {
      sha256: sha256(bundle),
      byteLength: bundle.length,
    };
    report.inputs = Object.fromEntries(
      [
        avatarAsset,
        ...motions.map((motion) => motion.asset),
        ...(equipment ? [equipment.asset] : []),
        ...(equipments ?? []).map((entry) => entry.asset),
        ...(productionVrmOverlap
          ? Object.values(productionVrmOverlap).map((entry) => entry.asset)
          : []),
      ].map((asset) => [
        asset,
        sha256(readFileSync(path.join(assetsRoot, asset))),
      ]),
    );
    report.manifests = Object.fromEntries(
      [
        motionManifestPath
          ? [
              "motions",
              {
                path: path.relative(workspaceRoot, motionManifestPath),
                sha256: sha256(readFileSync(motionManifestPath)),
              },
            ]
          : null,
        equipmentSetManifestPath
          ? [
              "equipmentSet",
              {
                path: path.relative(workspaceRoot, equipmentSetManifestPath),
                sha256: sha256(readFileSync(equipmentSetManifestPath)),
              },
            ]
          : null,
      ].filter(Boolean),
    );
    if (report.browserErrors.length > 0) {
      report.failures.push(
        ...report.browserErrors.map((error) => `browser: ${error}`),
      );
    }
    const screenshot = await page.screenshot({ fullPage: true, type: "png" });
    report.contactSheet = {
      path: path.relative(workspaceRoot, outputPath),
      sha256: sha256(screenshot),
      byteLength: screenshot.length,
      mimeType: "image/png",
    };
    if (report.productionVrmOverlap) {
      report.productionVrmOverlap.executionSource = {
        browserBundle: {
          sha256: sha256(bundle),
          byteLength: bundle.length,
        },
        files: Object.fromEntries(
          PRODUCTION_VRM_OVERLAP_SOURCES.map((sourcePath) => [
            sourcePath,
            sha256(readFileSync(path.join(workspaceRoot, sourcePath))),
          ]),
        ),
      };
      report.productionVrmOverlap.screenshotEvidence = {
        ...report.contactSheet,
        evidenceCardIds: report.productionVrmOverlap.snapshots.map(
          (snapshot) => snapshot.id,
        ),
      };
    }
    writeAtomic(outputPath, screenshot);
    writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if (report.failures.length > 0) {
      throw new Error(
        `Motion audit failed:\n${report.failures.map((failure) => `- ${failure}`).join("\n")}`,
      );
    }
    console.log(
      `Passed ${report.motions.length} avatar motions${report.productionVrmOverlap ? " plus production VRM authored-motion overlap proof" : ""}; report ${reportPath}; contact sheet ${outputPath}`,
    );
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
