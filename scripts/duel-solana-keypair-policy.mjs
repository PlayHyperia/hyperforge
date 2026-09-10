import fs from "node:fs";
import path from "node:path";

const ROLE_NAME_PATTERN = /^[a-z][a-zA-Z0-9-]*$/u;

function normalizeSecretKey(secretKey) {
  const bytes = Array.from(secretKey ?? []);
  if (
    bytes.length !== 64 ||
    bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    throw new Error("Solana keypair secret must contain exactly 64 bytes");
  }
  return bytes;
}

export function writeEphemeralSolanaKeypairFile({
  directory,
  role,
  secretKey,
}) {
  if (!path.isAbsolute(directory)) {
    throw new Error("Ephemeral Solana keypair directory must be absolute");
  }
  if (!ROLE_NAME_PATTERN.test(role)) {
    throw new Error(`Invalid ephemeral Solana keypair role: ${role}`);
  }

  const bytes = normalizeSecretKey(secretKey);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);

  const keypairPath = path.join(directory, `${role}.json`);
  fs.writeFileSync(keypairPath, `${JSON.stringify(bytes)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.chmodSync(keypairPath, 0o600);
  return keypairPath;
}
