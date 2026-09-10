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

import { validateDuelEquipmentSwitchAuditManifest } from "./lib/duel-equipment-switch-audit.mjs";

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

function safePath(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  return resolved.startsWith(`${resolvedRoot}${path.sep}`) ? resolved : null;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      argument === "--assets-root" ||
      argument === "--manifest" ||
      argument === "--output" ||
      argument === "--report"
    ) {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function resolveWorkspacePath(root, value, fallback, label) {
  const resolved = path.resolve(root, value ?? fallback);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
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
    <title>Hyperia equipment switching audit</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 26px; width: 1600px; background: #080b13; color: #f3f5fb; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      header { margin-bottom: 22px; }
      h1 { margin: 0 0 6px; font-size: 28px; }
      header p { margin: 0; color: #99a4ba; font-size: 14px; }
      main { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
      article { overflow: hidden; border: 1px solid #28324a; border-radius: 14px; background: #111725; box-shadow: 0 12px 30px #0007; }
      article[data-status="fail"] { border-color: #a94055; }
      img { display: block; width: 100%; height: 440px; object-fit: contain; background: linear-gradient(#1b2740, #0c101a); }
      .meta { min-height: 84px; padding: 13px 15px 15px; border-top: 1px solid #28324a; }
      .name { font-size: 16px; font-weight: 700; }
      .stats { margin-top: 10px; color: #67d9a8; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
      article[data-status="fail"] .stats, pre { color: #ff8c8c; }
    </style>
  </head>
  <body>
    <header><h1></h1><p>Actual EquipmentVisualSystem · real VRM and fitted GLBs · Chrome/Metal · active manifests unchanged</p></header>
    <main></main>
    <script type="module">
      import { runEquipmentSwitchAudit } from "/audit.js";
      document.querySelector("h1").textContent = ${JSON.stringify(config.title)};
      try {
        window.__auditReport = await runEquipmentSwitchAudit(${serialized});
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
  const options = parseArgs(process.argv.slice(2));
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const assetsRoot = resolveWorkspacePath(
    workspaceRoot,
    options["assets-root"],
    "artifacts/duel-launch-avatar-bakeoff",
    "Assets root",
  );
  const manifestPath = resolveWorkspacePath(
    workspaceRoot,
    options.manifest,
    "scripts/kaykit-equipment-switch-audit.json",
    "Manifest",
  );
  const outputPath = resolveWorkspacePath(
    workspaceRoot,
    options.output,
    "artifacts/duel-launch-avatar-bakeoff/kaykit-equipment-switch-contact-sheet.png",
    "Output",
  );
  const reportPath = resolveWorkspacePath(
    workspaceRoot,
    options.report,
    "artifacts/duel-launch-avatar-bakeoff/kaykit-equipment-switch-report.json",
    "Report",
  );
  const manifest = validateDuelEquipmentSwitchAuditManifest(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );
  const assets = [
    manifest.avatar,
    ...(manifest.pose ? [manifest.pose] : []),
    ...Object.values(manifest.equipment).map((entry) => entry.asset),
  ];
  for (const asset of assets) {
    const filePath = safePath(assetsRoot, asset);
    if (!filePath || !existsSync(filePath)) {
      throw new Error(`Missing audit asset: ${asset}`);
    }
  }
  const canonicalAvatarPath = path.join(
    workspaceRoot,
    "packages/server/world/assets/avatars/duel-candidates/duel-steve.vrm",
  );
  const canonicalWeaponPath = path.join(
    workspaceRoot,
    "packages/server/world/assets/models/swords/shortswords/shortsword-bronze-aligned.glb",
  );
  if (!existsSync(canonicalAvatarPath) || !existsSync(canonicalWeaponPath)) {
    throw new Error("Missing canonical transport-fault audit assets");
  }

  const bundle = await build({
    entryPoints: [
      path.join(workspaceRoot, "scripts/duel-equipment-switch-browser.ts"),
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
  const transportFaultRequests = [];
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html(manifest));
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
      if (url.pathname === "/canonical/duel-steve.vrm") {
        response.writeHead(200, {
          "content-type": "model/gltf-binary",
          "cache-control": "no-store",
        });
        response.end(readFileSync(canonicalAvatarPath));
        return;
      }
      if (url.pathname.startsWith("/transport-fault/")) {
        const attempt = transportFaultRequests.length + 1;
        const status = attempt <= 2 ? 503 : 200;
        transportFaultRequests.push({
          attempt,
          method: request.method ?? null,
          path: url.pathname,
          status,
        });
        if (status === 503) {
          response.writeHead(status, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "retry-after": "0",
          });
          response.end("Injected equipment transport interruption");
          return;
        }
        response.writeHead(200, {
          "content-type": "model/gltf-binary",
          "cache-control": "no-store",
        });
        response.end(readFileSync(canonicalWeaponPath));
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
    await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 1 });
    const browserErrors = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${address.port}/`, {
      // The page deliberately performs a failed then successful HTTP request
      // during its audit. Document readiness and the explicit audit sentinel
      // below are the stable boundaries; Puppeteer's global network-idle
      // heuristic is not.
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForFunction(
      () =>
        document.body.dataset.ready === "true" || document.body.dataset.error,
      { timeout: 120_000 },
    );
    const pageError = await page.evaluate(() => document.body.dataset.error);
    if (pageError) throw new Error(pageError);
    const report = await page.evaluate(() => window.__auditReport);
    const expectedTransportBrowserErrors = browserErrors.filter(
      (error) =>
        transportFaultRequests.some((request) => request.status === 503) &&
        /Failed to load resource.*503/u.test(error),
    );
    report.expectedTransportBrowserErrors = [
      ...new Set(expectedTransportBrowserErrors),
    ];
    report.browserErrors = [
      ...new Set(
        browserErrors.filter(
          (error) => !expectedTransportBrowserErrors.includes(error),
        ),
      ),
    ];
    report.transportServerRequests = transportFaultRequests;
    report.transportInputs = {
      avatar: {
        path: path.relative(workspaceRoot, canonicalAvatarPath),
        sha256: sha256(readFileSync(canonicalAvatarPath)),
      },
      weapon: {
        path: path.relative(workspaceRoot, canonicalWeaponPath),
        sha256: sha256(readFileSync(canonicalWeaponPath)),
      },
    };
    report.inputs = Object.fromEntries(
      assets.map((asset) => [
        asset,
        sha256(readFileSync(path.join(assetsRoot, asset))),
      ]),
    );
    report.manifest = {
      path: path.relative(workspaceRoot, manifestPath),
      sha256: sha256(readFileSync(manifestPath)),
    };
    if (report.browserErrors.length > 0) {
      report.failures.push(
        ...report.browserErrors.map((error) => `browser: ${error}`),
      );
    }
    if (
      JSON.stringify(
        transportFaultRequests.map((request) => request.status),
      ) !== JSON.stringify([503, 503, 200])
    ) {
      report.failures.push(
        "server did not observe the exact injected primary-503, fallback-503, retry-200 request sequence",
      );
    }
    const screenshot = await page.screenshot({ fullPage: true, type: "png" });
    writeAtomic(outputPath, screenshot);
    writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if (report.failures.length > 0) {
      throw new Error(
        report.failures.map((failure) => `- ${failure}`).join("\n"),
      );
    }
    console.log(
      `Passed ${report.phases.length} single-contestant phases, ${report.twoContestantPhases.length} two-contestant phases, ${report.rapidSwitch.samples} single-contestant switches, ${report.twoContestantRapidSwitch.samples} simultaneous two-contestant switches, and one real HTTP primary-503/fallback-503/retry-200 recovery; report ${reportPath}; contact sheet ${outputPath}`,
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
