import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installKayKitRuntimeAvatar } from "./install-kaykit-runtime-avatar.mjs";

const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

test("installs only exact report-locked KayKit LOD bytes and verifies drift", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hyperia-kaykit-install-"));
  try {
    const candidateDir = path.join(root, "candidate");
    const destinationDir = path.join(root, "runtime");
    mkdirSync(candidateDir, { recursive: true });
    const lods = ["lod0", "lod1", "lod2"].map((id, index) => {
      const file = `candidate-${id}.vrm`;
      const bytes = Buffer.from(`vrm-${index}`);
      writeFileSync(path.join(candidateDir, file), bytes);
      return {
        id,
        file,
        bytes: bytes.length,
        sha256: sha256(bytes),
        validatorErrors: 0,
      };
    });
    writeFileSync(
      path.join(candidateDir, "kaykit-knight-report.json"),
      JSON.stringify({
        candidateId: "kaykit-knight",
        validator: { errors: 0 },
        lods,
      }),
    );

    const installed = installKayKitRuntimeAvatar({
      candidateDir,
      destinationDir,
      check: false,
    });
    assert.deepEqual(
      installed.map(({ lod, sha256: digest }) => ({ lod, digest })),
      lods.map(({ id, sha256: digest }) => ({ lod: id, digest })),
    );
    assert.equal(
      readFileSync(path.join(destinationDir, "duel-kaykit-knight.vrm"), "utf8"),
      "vrm-0",
    );
    assert.doesNotThrow(() =>
      installKayKitRuntimeAvatar({
        candidateDir,
        destinationDir,
        check: true,
      }),
    );

    writeFileSync(
      path.join(destinationDir, "duel-kaykit-knight_lod1.vrm"),
      "drift",
    );
    assert.throws(
      () =>
        installKayKitRuntimeAvatar({
          candidateDir,
          destinationDir,
          check: true,
        }),
      /missing or stale/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
