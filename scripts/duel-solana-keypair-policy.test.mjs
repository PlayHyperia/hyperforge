import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeEphemeralSolanaKeypairFile } from "./duel-solana-keypair-policy.mjs";

test("writes a keeper-compatible keypair file with private permissions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "duel-keypair-policy-"));
  try {
    const directory = path.join(root, "roles");
    const secretKey = Uint8Array.from({ length: 64 }, (_, index) => index);
    const keypairPath = writeEphemeralSolanaKeypairFile({
      directory,
      role: "marketMaker",
      secretKey,
    });

    assert.equal(keypairPath, path.join(directory, "marketMaker.json"));
    assert.deepEqual(JSON.parse(fs.readFileSync(keypairPath, "utf8")), [
      ...secretKey,
    ]);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(keypairPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses malformed secret material and unsafe role names", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "duel-keypair-policy-"));
  try {
    assert.throws(
      () =>
        writeEphemeralSolanaKeypairFile({
          directory: root,
          role: "../escape",
          secretKey: new Uint8Array(64),
        }),
      /Invalid ephemeral Solana keypair role/u,
    );
    assert.throws(
      () =>
        writeEphemeralSolanaKeypairFile({
          directory: root,
          role: "reporter",
          secretKey: new Uint8Array(63),
        }),
      /exactly 64 bytes/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("never overwrites an existing ephemeral role key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "duel-keypair-policy-"));
  try {
    const input = {
      directory: root,
      role: "feePayer",
      secretKey: new Uint8Array(64),
    };
    writeEphemeralSolanaKeypairFile(input);
    assert.throws(() => writeEphemeralSolanaKeypairFile(input), /EEXIST/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
