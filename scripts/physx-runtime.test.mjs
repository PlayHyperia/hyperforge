import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(
  new URL(
    "../packages/shared/src/physics/PhysXManager.server.ts",
    import.meta.url,
  ),
);
const physxDirectory = path.join(root, "packages/physx-js-webidl");
const expectedHash = createHash("sha256")
  .update(readFileSync(path.join(physxDirectory, "dist/physx-js-webidl.wasm")))
  .digest("hex");

function withFixture(run) {
  const directory = mkdtempSync(path.join(tmpdir(), "hyperia-physx-runtime-"));
  try {
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    mkdirSync(path.join(directory, "node_modules/@hyperforge"), {
      recursive: true,
    });
    mkdirSync(path.join(directory, "assets/web"), { recursive: true });
    writeFileSync(
      path.join(directory, "assets/web/physx-js-webidl.wasm"),
      "unverified-cwd-physics",
    );
    const workingDirectory = path.join(directory, "work");
    mkdirSync(workingDirectory);
    mkdirSync(path.join(directory, "physx-js-webidl/dist"), {
      recursive: true,
    });
    writeFileSync(
      path.join(directory, "physx-js-webidl/dist/physx-js-webidl.wasm"),
      "unverified-cwd-physics",
    );
    const modulePath = path.join(directory, "PhysXManager.server.ts");
    writeFileSync(modulePath, source);
    run({ directory, modulePath, workingDirectory });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function loadInChild({ workingDirectory, modulePath }) {
  const entry = `import { createHash } from 'node:crypto';
    process.chdir(${JSON.stringify(workingDirectory)});
    const { loadPhysXWasmForNode } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
    try {
      const bytes = await loadPhysXWasmForNode();
      console.log(JSON.stringify({ ok: true, hash: createHash('sha256').update(bytes).digest('hex') }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, message: String(error), code: error.code }));
    }`;
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", entry],
      {
        cwd: root,
        env: {
          ...process.env,
          NODE_ENV: "production",
          PUBLIC_CDN_URL: "invalid://unverified-physics",
        },
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
}

test("production physics reads the actual resolved package, never a cwd asset", () => {
  withFixture((fixture) => {
    symlinkSync(
      physxDirectory,
      path.join(fixture.directory, "node_modules/@hyperforge/physx-js-webidl"),
    );
    assert.deepEqual(loadInChild(fixture), { ok: true, hash: expectedHash });
  });
});

test("missing production package fails instead of accepting cwd/cache/CDN physics", () => {
  withFixture((fixture) => {
    const result = loadInChild(fixture);
    assert.equal(result.ok, false);
    assert.match(result.message, /physx-js-webidl/u);
  });
});

test("missing WASM beside a resolved production entry fails despite a readable cwd asset", () => {
  withFixture((fixture) => {
    const packageDirectory = path.join(
      fixture.directory,
      "node_modules/@hyperforge/physx-js-webidl",
    );
    mkdirSync(path.join(packageDirectory, "dist"), { recursive: true });
    writeFileSync(
      path.join(packageDirectory, "package.json"),
      JSON.stringify({
        name: "@hyperforge/physx-js-webidl",
        type: "module",
        exports: "./dist/physx-js-webidl.js",
      }),
    );
    writeFileSync(
      path.join(packageDirectory, "dist/physx-js-webidl.js"),
      "export {};\n",
    );
    const result = loadInChild(fixture);
    assert.equal(result.ok, false);
    assert.equal(result.code, "ENOENT");
    assert.match(result.message, /dist\/physx-js-webidl\.wasm/u);
  });
});
