#!/usr/bin/env node

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".vrm": "model/gltf-binary",
});

function safePath(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) return null;
  return resolved;
}

function html(manifest) {
  const models = manifest.candidates.flatMap((candidate) =>
    candidate.lods.map((lod) => ({
      id: candidate.id,
      name: candidate.name,
      archetype: candidate.archetype,
      ...lod,
    })),
  );
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Hyperia VRM technical review</title>
    <script type="importmap">
      {"imports":{"three":"/vendor/three/build/three.module.js","three/addons/":"/vendor/three/examples/jsm/","@pixiv/three-vrm":"/vendor/three-vrm/lib/three-vrm.module.js"}}
    </script>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 26px; width: 1600px; background: #080b13; color: #f3f5fb; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      header { margin: 0 0 22px; }
      h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: -0.02em; }
      header p { margin: 0; color: #99a4ba; font-size: 14px; }
      main { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; }
      article { overflow: hidden; border: 1px solid #28324a; border-radius: 14px; background: #111725; box-shadow: 0 12px 30px #0007; }
      canvas { display: block; width: 100%; height: 430px; background: linear-gradient(#1b2740, #0c101a); }
      .meta { padding: 13px 15px 15px; border-top: 1px solid #28324a; }
      .name { font-size: 16px; font-weight: 700; }
      .role { margin-top: 2px; color: #8f9ab0; font-size: 12px; }
      .stats { display: flex; justify-content: space-between; margin-top: 10px; color: #cbd4e8; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
      .lod { color: #67d9a8; text-transform: uppercase; }
      .error { padding: 30px; color: #ff8c8c; font: 12px ui-monospace, monospace; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <header><h1></h1><p></p></header>
    <main></main>
    <script type="module">
      import * as THREE from "three";
      import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
      import { VRMLoaderPlugin } from "@pixiv/three-vrm";

      const models = ${JSON.stringify(models).replaceAll("<", "\\u003c")};
      const pageMeta = ${JSON.stringify({
        title: manifest.title ?? "Hyperia duel-avatar candidates",
        subtitle:
          manifest.subtitle ??
          "Front-view technical review · generated LOD0 / LOD1 / LOD2 · source masters preserved",
      }).replaceAll("<", "\\u003c")};
      const main = document.querySelector("main");
      document.querySelector("header h1").textContent = pageMeta.title;
      document.querySelector("header p").textContent = pageMeta.subtitle;

      const renderCanvas = document.createElement("canvas");
      renderCanvas.width = 360;
      renderCanvas.height = 430;
      const renderer = new THREE.WebGLRenderer({ canvas: renderCanvas, antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(1);
      renderer.setSize(360, 430, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;

      function disposeScene(scene) {
        const disposedTextures = new Set();
        scene.traverse((object) => {
          object.geometry?.dispose?.();
          const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
          for (const material of materials) {
            for (const value of Object.values(material)) {
              if (value?.isTexture && !disposedTextures.has(value)) {
                disposedTextures.add(value);
                value.dispose();
              }
            }
            material.dispose?.();
          }
        });
        scene.clear();
      }

      async function renderModel(model) {
        const card = document.createElement("article");
        const canvas = document.createElement("canvas");
        canvas.width = 360;
        canvas.height = 430;
        card.append(canvas);
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.innerHTML = '<div class="name"></div><div class="role"></div><div class="stats"><span class="lod"></span><span class="numbers"></span></div>';
        meta.querySelector(".name").textContent = model.name;
        meta.querySelector(".role").textContent = model.archetype;
        meta.querySelector(".lod").textContent = model.lod;
        meta.querySelector(".numbers").textContent = model.triangles.toLocaleString() + " tris · " + (model.bytes / 1048576).toFixed(2) + " MiB";
        card.append(meta);
        main.append(card);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x172139);
        scene.add(new THREE.HemisphereLight(0xc9dcff, 0x202025, 2.3));
        const key = new THREE.DirectionalLight(0xffffff, 2.2);
        key.position.set(3, 5, 4);
        scene.add(key);
        const rim = new THREE.DirectionalLight(0x73a6ff, 1.4);
        rim.position.set(-4, 3, -3);
        scene.add(rim);

        const loader = new GLTFLoader();
        loader.register((parser) => new VRMLoaderPlugin(parser));
        const gltf = await loader.loadAsync("/asset/" + model.asset.split("/").map(encodeURIComponent).join("/"));
        const vrm = gltf.userData.vrm;
        if (model.kind !== "model" && !vrm) throw new Error(model.asset + " did not load as VRM");
        const root = model.kind === "model" ? gltf.scene : vrm.scene;
        if (model.kind === "model" && Array.isArray(model.rotationDegrees)) {
          root.rotation.set(
            ...model.rotationDegrees.map(THREE.MathUtils.degToRad),
          );
        }
        scene.add(root);
        root.updateMatrixWorld(true);
        vrm?.update(0);

        const box = new THREE.Box3().setFromObject(root);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const largest = Math.max(size.x, size.y, size.z);
        const camera = new THREE.PerspectiveCamera(27, 360 / 430, 0.01, largest * 20);
        camera.position.set(center.x, center.y + size.y * 0.01, center.z + largest * 2.45);
        camera.lookAt(center.x, center.y + size.y * 0.01, center.z);

        const ground = new THREE.Mesh(
          new THREE.CircleGeometry(largest * 0.72, 64),
          new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.94, metalness: 0.02 }),
        );
        ground.rotation.x = -Math.PI / 2;
        ground.position.set(center.x, box.min.y - 0.005, center.z);
        scene.add(ground);
        renderer.render(scene, camera);
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("2D capture context is unavailable");
        context.drawImage(renderCanvas, 0, 0);
        disposeScene(scene);
      }

      try {
        for (const model of models) await renderModel(model);
        renderer.dispose();
        renderer.forceContextLoss();
        document.body.dataset.ready = "true";
      } catch (error) {
        const output = document.createElement("pre");
        output.className = "error";
        output.textContent = error?.stack ?? String(error);
        document.body.prepend(output);
        document.body.dataset.error = output.textContent;
      }
    </script>
  </body>
</html>`;
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      argument === "--manifest" ||
      argument === "--output" ||
      argument === "--assets-root"
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
  const threeRoot = path.join(
    workspaceRoot,
    "packages/client/node_modules/three",
  );
  const threeVrmRoot = path.join(
    workspaceRoot,
    "packages/client/node_modules/@pixiv/three-vrm",
  );
  const manifestPath = resolveWorkspacePath(
    workspaceRoot,
    options.manifest,
    "artifacts/duel-avatar-candidates/manifest.json",
    "Manifest path",
  );
  const outputPath = resolveWorkspacePath(
    workspaceRoot,
    options.output,
    "artifacts/duel-avatar-candidates/contact-sheet.png",
    "Output path",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": MIME_TYPES[".html"] });
        response.end(html(manifest));
        return;
      }
      const routes = [
        ["/asset/", assetsRoot],
        ["/vendor/three/", threeRoot],
        ["/vendor/three-vrm/", threeVrmRoot],
      ];
      const route = routes.find(([prefix]) => url.pathname.startsWith(prefix));
      if (!route) {
        response.writeHead(404).end();
        return;
      }
      const [prefix, root] = route;
      const filePath = safePath(
        root,
        decodeURIComponent(url.pathname.slice(prefix.length)),
      );
      if (!filePath) {
        response.writeHead(403).end();
        return;
      }
      const body = readFileSync(filePath);
      response.writeHead(200, {
        "content-type":
          MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No server port");

  let browser;
  try {
    const systemChrome =
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const executablePath =
      process.env.PUPPETEER_EXECUTABLE_PATH ??
      (existsSync(systemChrome) ? systemChrome : undefined);
    browser = await puppeteer.launch({ headless: true, executablePath });
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${address.port}/`, {
      waitUntil: "networkidle0",
      timeout: 120_000,
    });
    await page.waitForFunction(
      () =>
        document.body.dataset.ready === "true" || document.body.dataset.error,
      { timeout: 120_000 },
    );
    const pageError = await page.evaluate(() => document.body.dataset.error);
    if (pageError) throw new Error(pageError);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    await page.screenshot({ path: outputPath, fullPage: true });
    console.log(outputPath);
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
