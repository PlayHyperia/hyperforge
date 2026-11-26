import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEFAULT_LAUNCH_ASSET_READ_TIMEOUT_MS = 15_000;

const DEFAULT_READER_PATH = fileURLToPath(
  new URL("./read-launch-asset-bytes.mjs", import.meta.url),
);

function isByteEvidence(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isSafeInteger(value.statSize) &&
    value.statSize > 0 &&
    Number.isSafeInteger(value.bytesRead) &&
    value.bytesRead === value.statSize &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.sha256)
  );
}

export function resolveLaunchAssetReadTimeoutMs(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_LAUNCH_ASSET_READ_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 60_000) {
    throw new Error(
      "DUEL_ASSET_READ_TIMEOUT_MS must be an integer from 100 to 60000",
    );
  }
  return parsed;
}

export function readLaunchAssetByteEvidence(
  absolutePath,
  {
    timeoutMs = DEFAULT_LAUNCH_ASSET_READ_TIMEOUT_MS,
    processPath = process.execPath,
    readerPath = DEFAULT_READER_PATH,
    spawn = spawnSync,
  } = {},
) {
  const result = spawn(processPath, [readerPath, absolutePath], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      timeout: true,
      error: `asset bytes were not readable within ${timeoutMs}ms`,
    };
  }
  if (result.error) {
    return {
      ok: false,
      timeout: false,
      error: `asset byte reader failed: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || "").trim();
    return {
      ok: false,
      timeout: false,
      error: detail || `asset byte reader exited with status ${result.status}`,
    };
  }

  let evidence;
  try {
    evidence = JSON.parse(String(result.stdout || ""));
  } catch {
    return {
      ok: false,
      timeout: false,
      error: "asset byte reader returned malformed evidence",
    };
  }
  if (!isByteEvidence(evidence)) {
    return {
      ok: false,
      timeout: false,
      error: "asset byte reader returned invalid size or hash evidence",
    };
  }

  return { ok: true, evidence };
}
