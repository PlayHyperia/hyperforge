#!/usr/bin/env node
// Reconstruct the reviewed declaration package without Bun's new-directory patch path.
// This does not install dependencies or change package-manager/global cache state.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselineUrl =
  "https://registry.npmjs.org/@types/three/-/three-0.185.4.tgz";
const baselineHash =
  "4012a0b1c7842ba67230cc8fa1698e520aa370dbe9f5131f2d7c707e1d7088cd";
const patchHash =
  "ddd42c592b40c62f1aef18a0b9b47fc166e5d886e8191fb7daee8c274b51cef5";
const declarationHash =
  "8b3f10bc081ee1bf28b64cb533dace52d69aa826c9182fda06aa770875a09b71";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isDeclaration = (path) => /\.d\.(?:ts|cts|mts)$/.test(path);

const args = process.argv.slice(2);
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  assert.ok(["--output", "--baseline"].includes(args[i]), "unknown option");
  assert.ok(args[i + 1] && !options.has(args[i]), "missing/duplicate option");
  options.set(args[i], args[i + 1]);
}
const output = options.get("--output");
assert.ok(
  output && isAbsolute(output),
  "--output must be an absolute new path",
);
const scratch = mkdtempSync(join(tmpdir(), "hyperia-three-types-package-"));
let baseline;
if (options.has("--baseline")) {
  baseline = readFileSync(resolve(options.get("--baseline")));
} else {
  const response = await fetch(baselineUrl, {
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  assert.ok(response.ok, `npm download failed: ${response.status}`);
  // Bound accumulation even if a future endpoint has a missing/false Content-Length.
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    assert.ok(length <= 348571, "unexpected oversized npm archive");
    chunks.push(Buffer.from(chunk));
  }
  baseline = Buffer.concat(chunks);
}
assert.equal(baseline.length, 348571, "npm archive byte length");
assert.equal(sha256(baseline), baselineHash, "npm archive identity");
const archive = join(scratch, "baseline.tgz");
writeFileSync(archive, baseline, { flag: "wx" });
// The exact official input is authenticated before any tar operation. Also reject
// traversal paths rather than relying on tar's extraction sanitization.
const archiveNames = execFileSync("tar", ["-tzf", archive], {
  encoding: "utf8",
  maxBuffer: 2 * 1024 * 1024,
})
  .trimEnd()
  .split("\n");
for (const name of archiveNames) {
  assert.ok(name.startsWith("three/"), `unexpected archive root: ${name}`);
  assert.ok(!name.split("/").includes("..") && !name.includes("\\"));
}
execFileSync("tar", ["-xzf", archive, "-C", scratch]);
const packageRoot = join(scratch, "three");
function readFiles(directory) {
  const files = new Map();
  const walk = (relative) => {
    for (const name of readdirSync(join(directory, relative))) {
      const path = relative ? `${relative}/${name}` : name;
      const absolute = join(directory, path);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) walk(path);
      else {
        assert.ok(stat.isFile(), `not a regular package file: ${path}`);
        files.set(path, readFileSync(absolute));
      }
    }
  };
  walk("");
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
const original = readFiles(packageRoot);
const patch = readFileSync(join(root, "patches/@types%2Fthree@0.185.4.patch"));
assert.equal(patch.length, 296250, "reviewed patch byte length");
assert.equal(sha256(patch), patchHash, "reviewed patch identity");
const patchFile = join(scratch, "declarations.patch");
writeFileSync(patchFile, patch, { flag: "wx" });
execFileSync("git", ["apply", "--check", patchFile], { cwd: packageRoot });
execFileSync("git", ["apply", patchFile], { cwd: packageRoot });
execFileSync("git", ["apply", "--reverse", "--check", patchFile], {
  cwd: packageRoot,
});
const files = readFiles(packageRoot);
const declarations = [...files.keys()].filter(isDeclaration);
assert.equal(declarations.length, 966, "complete declaration file count");
const manifest = declarations
  .map((path) => `${path}\0${sha256(files.get(path))}\n`)
  .join("");
assert.equal(
  sha256(manifest),
  declarationHash,
  "complete declaration identity",
);
for (const [path, bytes] of original) {
  if (!isDeclaration(path) || /^build\/.*\.min\.d\.ts$/.test(path)) {
    assert.deepEqual(
      files.get(path),
      bytes,
      `preserved original bytes: ${path}`,
    );
  }
}
for (const path of files.keys()) {
  assert.ok(
    isDeclaration(path) || original.has(path),
    `unexpected file: ${path}`,
  );
}
const metadata = JSON.parse(files.get("package.json"));
assert.equal(metadata.name, "@types/three");
assert.equal(metadata.version, "0.185.4");

// Minimal deterministic POSIX ustar: sorted regular files, no PAX/platform
// metadata, uid/gid/mtime zero, ordinary 0644 files. Directories are implicit;
// package managers create them normally, independently of patch file modes.
function tarFile(path, bytes) {
  const header = Buffer.alloc(512);
  let name = `package/${path}`;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const slash = name.lastIndexOf("/", 155);
    assert.ok(slash > 0, "tar path cannot be split");
    prefix = name.slice(0, slash);
    name = name.slice(slash + 1);
  }
  assert.ok(Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155);
  header.write(name, 0, 100, "utf8");
  const octal = (value, offset, length) => {
    const text = value.toString(8).padStart(length - 1, "0") + "\0";
    assert.equal(text.length, length, "tar numeric field overflow");
    header.write(text, offset, length, "ascii");
  };
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(bytes.length, 124, 12);
  octal(0, 136, 12);
  header.fill(32, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return Buffer.concat([
    header,
    bytes,
    Buffer.alloc((512 - (bytes.length % 512)) % 512),
  ]);
}
const tar = Buffer.concat([
  ...[...files].map(([path, bytes]) => tarFile(path, bytes)),
  Buffer.alloc(1024),
]);
const packed = gzipSync(tar, { level: 9 });
assert.equal(packed.readUInt32LE(4), 0, "gzip timestamp must be deterministic");
packed[9] = 255; // No host OS identity; payload/checksum are unchanged.
writeFileSync(output, packed, { flag: "wx", mode: 0o644 });
console.log(
  JSON.stringify(
    {
      output,
      scratch,
      baseline: {
        url: baselineUrl,
        sha256: baselineHash,
        bytes: baseline.length,
      },
      patch: { sha256: patchHash, bytes: patch.length },
      archive: { sha256: sha256(packed), bytes: packed.length },
      uncompressedTarSha256: sha256(tar),
      declarations: { count: declarations.length, sha256: declarationHash },
      package: {
        name: metadata.name,
        version: metadata.version,
        files: files.size,
      },
      tooling: { node: process.version, zlib: process.versions.zlib },
    },
    null,
    2,
  ),
);
