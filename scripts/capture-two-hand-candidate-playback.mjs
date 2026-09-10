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

import { resolveTwoHandPlaybackActivation } from "./lib/two-hand-playback-approval.mjs";

const AVATAR_ASSET = "avatars/duel-candidates/duel-steve.vrm";
const EQUIPMENT_ASSET =
  "models/swords/2h-swords/candidates/2h-sword-bronze-semantic-grip-candidate.glb";
const CANONICAL_EQUIPMENT_ASSET =
  "models/swords/2h-swords/2h-sword-bronze-steve-fitted.glb";
const CLIPS = Object.freeze([
  {
    id: "idle",
    asset:
      "emotes/candidates/emote-2h-idle-steve-controlled-guard-candidate.glb",
    loop: true,
    speed: 1,
  },
  {
    id: "walk",
    asset:
      "emotes/candidates/emote-2h-walk-steve-controlled-guard-candidate.glb",
    loop: true,
    speed: 1.3,
  },
  {
    id: "run",
    asset:
      "emotes/candidates/emote-2h-run-steve-controlled-guard-candidate.glb",
    loop: true,
    speed: 1.4,
  },
  {
    id: "attack",
    asset:
      "emotes/candidates/emote-2h-planted-cut-steve-controlled-45-candidate.glb",
    loop: false,
    speed: 1,
  },
]);
const CANONICAL_CLIPS = Object.freeze([
  {
    id: "idle",
    asset: "emotes/emote-2h-duel-idle-steve.glb",
    loop: true,
    speed: 1,
  },
  {
    id: "walk",
    asset: "emotes/emote-2h-duel-walk-steve.glb",
    loop: true,
    speed: 1.3,
  },
  {
    id: "run",
    asset: "emotes/emote-2h-duel-run-steve.glb",
    loop: true,
    speed: 1.4,
  },
  {
    id: "attack",
    asset: "emotes/emote-2h-duel-slash-steve.glb",
    loop: false,
    speed: 1,
  },
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeAtomic(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, contents, { flag: "wx" });
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function safePath(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  return resolved.startsWith(`${resolvedRoot}${path.sep}`) ? resolved : null;
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--canonical") {
      options.canonical = true;
      continue;
    }
    if (
      argument !== "--avatar" &&
      argument !== "--approval-record" &&
      argument !== "--contact-sheet" &&
      argument !== "--output" &&
      argument !== "--report"
    ) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a path`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function workspacePath(workspaceRoot, value, fallback, label) {
  const resolved = path.resolve(workspaceRoot, value ?? fallback);
  if (!resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
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
    <title>Hyperia two-hand candidate playback</title>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #080b13; }
      canvas { display: block; width: 1280px; height: 720px; }
      pre { position: fixed; inset: 0; margin: 0; padding: 24px; overflow: auto; color: #ff8c8c; background: #080b13; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <script type="module">
      import { runTwoHandCandidatePlayback } from "/playback.js";
      try {
        window.__playbackResult = await runTwoHandCandidatePlayback(${serialized});
        document.body.dataset.ready = "true";
      } catch (error) {
        const output = document.createElement("pre");
        output.textContent = error?.stack ?? String(error);
        document.body.replaceChildren(output);
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
  const assetsRoot = path.join(workspaceRoot, "packages/server/world/assets");
  const outputPath = workspacePath(
    workspaceRoot,
    options.output,
    "artifacts/duel-avatar-candidates/two-hand-candidate-playback.webm",
    "Output path",
  );
  const reportPath = workspacePath(
    workspaceRoot,
    options.report,
    "artifacts/duel-avatar-candidates/two-hand-candidate-playback-report.json",
    "Report path",
  );
  const contactSheetPath = workspacePath(
    workspaceRoot,
    options["contact-sheet"],
    "artifacts/duel-avatar-candidates/two-hand-candidate-webgpu-exact-angle.png",
    "Contact-sheet path",
  );
  const avatarAsset = options.avatar ?? AVATAR_ASSET;
  const equipmentAsset = options.canonical
    ? CANONICAL_EQUIPMENT_ASSET
    : EQUIPMENT_ASSET;
  const clips = options.canonical ? CANONICAL_CLIPS : CLIPS;
  const assetDefinitions = [
    avatarAsset,
    equipmentAsset,
    ...clips.map(({ asset }) => asset),
  ];
  const inputs = Object.fromEntries(
    assetDefinitions.map((asset) => {
      const filePath = safePath(assetsRoot, asset);
      if (!filePath || !existsSync(filePath)) {
        throw new Error(`Playback input is missing: ${asset}`);
      }
      return [asset, sha256(readFileSync(filePath))];
    }),
  );
  let approvalRecord = null;
  let approvalRecordPath = null;
  let approvalRecordSha256 = null;
  const evidenceSha256 = {};
  if (options["approval-record"]) {
    const approvalFilePath = workspacePath(
      workspaceRoot,
      options["approval-record"],
      "",
      "Approval-record path",
    );
    const approvalBytes = readFileSync(approvalFilePath);
    approvalRecord = JSON.parse(approvalBytes.toString("utf8"));
    approvalRecordPath = path.relative(workspaceRoot, approvalFilePath);
    approvalRecordSha256 = sha256(approvalBytes);
    if (!Array.isArray(approvalRecord?.evidence)) {
      throw new Error("two-hand product approval evidence is missing");
    }
    for (const evidence of approvalRecord.evidence) {
      const evidencePath = workspacePath(
        workspaceRoot,
        evidence?.path,
        "",
        "Approval evidence path",
      );
      evidenceSha256[evidence.path] = sha256(readFileSync(evidencePath));
    }
  }
  const activation = resolveTwoHandPlaybackActivation({
    canonical: options.canonical === true,
    approvalRecord,
    approvalRecordPath,
    approvalRecordSha256,
    expectedInputs: inputs,
    evidenceSha256,
  });
  const config = {
    avatarAsset,
    avatarSha256: inputs[avatarAsset],
    avatarId: "steve",
    equipmentAsset,
    equipmentSha256: inputs[equipmentAsset],
    itemId: "bronze_2h_sword",
    clips,
    ...activation,
  };
  const bundleResult = await build({
    entryPoints: [
      path.join(
        workspaceRoot,
        "scripts/two-hand-candidate-playback-browser.ts",
      ),
    ],
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
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html(config));
        return;
      }
      if (url.pathname === "/playback.js") {
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
    throw new Error("No local playback server port");
  }

  let browser;
  try {
    const systemChrome =
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const executablePath =
      process.env.PUPPETEER_EXECUTABLE_PATH ??
      (existsSync(systemChrome) ? systemChrome : undefined);
    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--enable-unsafe-webgpu",
        "--use-angle=metal",
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${address.port}/`, {
      waitUntil: "networkidle0",
      timeout: 180_000,
    });
    await page.waitForFunction(
      () =>
        document.body.dataset.ready === "true" || document.body.dataset.error,
      { timeout: 180_000 },
    );
    const pageError = await page.evaluate(() => document.body.dataset.error);
    if (pageError) throw new Error(pageError);
    const result = await page.evaluate(() => window.__playbackResult);
    if (
      !result?.report ||
      typeof result.videoBase64 !== "string" ||
      typeof result.exactAngleContactSheetBase64 !== "string"
    ) {
      throw new Error("Playback browser returned an invalid result");
    }
    const video = Buffer.from(result.videoBase64, "base64");
    if (video.length < 100_000 || video[0] !== 0x1a || video[1] !== 0x45) {
      throw new Error("Playback browser returned an invalid WebM video");
    }
    const contactSheet = Buffer.from(
      result.exactAngleContactSheetBase64,
      "base64",
    );
    if (
      contactSheet.length < 100_000 ||
      !contactSheet
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      throw new Error("Playback browser returned an invalid PNG contact sheet");
    }
    const report = {
      ...result.report,
      browserErrors: [...new Set(browserErrors)],
      inputs,
      video: {
        path: path.relative(workspaceRoot, outputPath),
        sha256: sha256(video),
        byteLength: video.length,
        mimeType: result.report.recording.mimeType,
      },
      exactAngleReview: {
        ...result.report.exactAngleReview,
        contactSheet: {
          path: path.relative(workspaceRoot, contactSheetPath),
          sha256: sha256(contactSheet),
          byteLength: contactSheet.length,
          mimeType: "image/png",
        },
      },
    };
    writeAtomic(outputPath, video);
    writeAtomic(contactSheetPath, contactSheet);
    writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if (
      !report.evaluation.passed ||
      report.renderer?.backend !== "webgpu" ||
      report.browserErrors.length > 0
    ) {
      throw new Error(
        `Playback gate failed: ${JSON.stringify({
          checks: report.evaluation.checks.filter((check) => !check.passed),
          browserErrors: report.browserErrors,
        })}`,
      );
    }
    console.log(
      `Passed ${report.deterministicTelemetry.deterministicFrameCount}-frame technical two-hand playback gate as ${report.activationStatus}; product approval ${report.approvedForRuntimeActivation ? "present" : "required"}; report ${reportPath}; video ${outputPath}`,
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
