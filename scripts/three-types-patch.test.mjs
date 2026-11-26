import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Installation/provenance checks only, not runtime, shader or project typechecking.
const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const patchPath = "patches/@types%2Fthree@0.185.4.patch";
const patch = readFileSync(join(fileURLToPath(root), patchPath), "utf8");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const expectedPatch =
  "ddd42c592b40c62f1aef18a0b9b47fc166e5d886e8191fb7daee8c274b51cef5";
const expectedDeclarations =
  "8b3f10bc081ee1bf28b64cb533dace52d69aa826c9182fda06aa770875a09b71";
const archivePath = "vendor/three-types-r186.tgz";
const expectedArchive =
  "4ce38cd4af22a49a6317ebbdef3c713b52ff243b24c853c0b3cd71ec8070c27e";
const preservedMetadata = {
  "package.json":
    "c3b4a2dad609524f2423886dc7039cfd324b46b272421940bdd5347b0e92bc60",
  LICENSE: "c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383",
  "README.md":
    "4929f4b6f73e620f91bfb69067cc13a1cb342d3f33c8da35d998b48623cd61d8",
};
const preservedForwarders = {
  "build/three.core.min.d.ts":
    "086cd29287810ef742009fcb5ad255ab783fd74ff2759c09f56c69da87120e8d",
  "build/three.module.min.d.ts":
    "a715a2786c285a9e27ea2bbaa2ed249d3017e7139782f5ebb8eeedb777b26926",
  "build/three.tsl.min.d.ts":
    "8888785c3e25e1a9e808a708293974163030229417ad8e2fcbe11507a911ff78",
  "build/three.webgpu.min.d.ts":
    "0463fe5552a4a22bfeafa83fffb82c662abb62bb4c78f44223b096dda8034083",
  "build/three.webgpu.nodes.min.d.ts":
    "83ab1b52484776c0c0e98ae895c7a68275a68c60eff871fead2a9f97ca388fb0",
};
const isDeclaration = (path) => /\.d\.(?:ts|cts|mts)$/.test(path);

test("declaration patch has the exact reviewed upstream bytes", () => {
  assert.equal(Buffer.byteLength(patch), 296250);
  assert.equal(hash(patch), expectedPatch);
});

test("declaration patch is restricted to the 182 upstream declaration changes", () => {
  const blocks = patch.split(/^diff --git /m).slice(1);
  const paths = [];
  const kinds = { added: 0, changed: 0, deleted: 0 };
  for (const block of blocks) {
    const match = block.match(/^a\/(\S+) b\/(\S+)\n/);
    assert.ok(match, "every block has matching relative paths");
    assert.equal(match[1], match[2]);
    assert.ok(isDeclaration(match[1]));
    assert.match(match[1], /^(?:src|examples)\//);
    assert.ok(!match[1].split("/").includes(".."));
    paths.push(match[1]);
    if (block.includes("\nnew file mode 100644\n")) kinds.added++;
    else if (block.includes("\ndeleted file mode 100644\n")) kinds.deleted++;
    else kinds.changed++;
  }
  assert.equal(paths.length, 182);
  assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(kinds, { added: 47, changed: 129, deleted: 6 });
});

test("vendored declaration archive has the exact reproducible reviewed bytes", () => {
  const archive = readFileSync(new URL(archivePath, root));
  assert.equal(archive.byteLength, 362202);
  assert.equal(hash(archive), expectedArchive);
});

test("installed declaration package uses the durable file override without metadata drift", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("package.json", root), "utf8"),
  );
  assert.equal(manifest.overrides["@types/three"], "file:" + archivePath);
  assert.equal(
    manifest.patchedDependencies?.["@types/three@0.185.4"],
    undefined,
  );
  const packageRoot = dirname(require.resolve("@types/three/package.json"));
  const installed = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(installed.version, "0.185.4");
  for (const [file, expected] of Object.entries(preservedMetadata)) {
    assert.equal(hash(readFileSync(join(packageRoot, file))), expected, file);
  }
  for (const [file, expected] of Object.entries(preservedForwarders)) {
    assert.equal(hash(readFileSync(join(packageRoot, file))), expected, file);
  }
});

test("installed declarations exactly match the pinned maintained r186 subtree and published forwarders", () => {
  const packageRoot = dirname(require.resolve("@types/three/package.json"));
  const paths = [];
  const walk = (relative) => {
    for (const entry of readdirSync(join(packageRoot, relative), {
      withFileTypes: true,
    })) {
      // Package-manager dependency links are not declaration content.
      if (entry.name === "node_modules") continue;
      const path = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && isDeclaration(path)) paths.push(path);
      else if (isDeclaration(path))
        assert.fail("unexpected linked declaration: " + path);
    }
  };
  walk("");
  paths.sort(); // Code-unit order, independent of host locale/ICU.
  assert.equal(paths.length, 966);
  const records = paths
    .map(
      (path) =>
        path + "\0" + hash(readFileSync(join(packageRoot, path))) + "\n",
    )
    .join("");
  assert.equal(hash(records), expectedDeclarations);
});
