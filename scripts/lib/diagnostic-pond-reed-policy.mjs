import path from "node:path";

export const DIAGNOSTIC_POND_REED_FILE = "pond_reed_clump.glb";
export const DIAGNOSTIC_POND_REED_SHA_ENV = "DUEL_DIAGNOSTIC_POND_REED_SHA256";
export const DIAGNOSTIC_POND_BOULDER_FILE = "pond_boulder.glb";
export const DIAGNOSTIC_POND_BOULDER_SHA_ENV =
  "DUEL_DIAGNOSTIC_POND_BOULDER_SHA256";

const requiredEnvironment = Object.freeze({
  // The existing local-smoke launcher deliberately uses production-shaped
  // bundles. NODE_ENV=production alone is NOT diagnostic authorization.
  NODE_ENV: "production",
  DUEL_LOCAL_SMOKE_MODE: "true",
  LOAD_TEST_MODE: "true",
  STREAMING_DUEL_DIAGNOSTIC_ASSET_TESTS: "true",
  STREAMING_DUEL_MAINTENANCE_MODE: "true",
  STREAMING_DUEL_SCHEDULER_ROLE: "authority",
  DUEL_BETTING_ENABLED: "false",
  DUEL_WITH_HYPERBET: "false",
});

function exactLoopbackUrl(value, protocols, paths = ["/"]) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      protocols.includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      paths.includes(url.pathname) &&
      // Reject alternate numeric spellings, whitespace and URL normalization.
      (value === url.origin || value === url.origin + url.pathname)
    );
  } catch {
    return false;
  }
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/**
 * Pure, one-file diagnostic policy. All four filesystem paths MUST be actual
 * realpathSync results supplied by the validator, not unchecked path strings.
 * Absence is exactly the historical contract. A present but invalid request
 * throws; it must never silently fall back to the production expected hash.
 * This does not certify geometry or replace byte-complete SHA validation.
 */
function resolveDiagnosticPondAssetSha256({
  environment,
  assetsRoot,
  canonicalAssetsRoot,
  assetPath,
  canonicalAssetPath,
  kind,
  shaEnvironment,
}) {
  const reject = (message) => {
    throw new Error(`Diagnostic pond ${kind} audition rejected: ${message}`);
  };
  const requested = environment[shaEnvironment];
  if (requested === undefined) return null;
  if (typeof requested !== "string" || !/^[a-f0-9]{64}$/u.test(requested))
    reject("an explicit lowercase 64-character SHA-256 is required");
  for (const [key, expected] of Object.entries(requiredEnvironment))
    if (environment[key] !== expected) reject(`${key} must be ${expected}`);
  for (const [key, protocols, paths] of [
    ["PUBLIC_API_URL", ["http:", "https:"], ["/"]],
    ["PUBLIC_WS_URL", ["ws:", "wss:"], ["/", "/ws"]],
    ["DUEL_LOCAL_BROWSER_ORIGIN", ["http:", "https:"], ["/"]],
    ["PUBLIC_CDN_URL", ["http:", "https:"], ["/", "/game-assets"]],
  ])
    if (!exactLoopbackUrl(environment[key], protocols, paths))
      reject(`${key} must use an exact loopback URL without credentials/query`);
  if (
    typeof environment.ASSETS_DIR !== "string" ||
    !path.isAbsolute(environment.ASSETS_DIR)
  )
    reject("an explicit absolute ASSETS_DIR is required");
  for (const value of [
    assetsRoot,
    canonicalAssetsRoot,
    assetPath,
    canonicalAssetPath,
  ])
    if (typeof value !== "string" || !path.isAbsolute(value))
      reject("resolved absolute asset paths are required");
  if (
    contains(canonicalAssetsRoot, assetsRoot) ||
    contains(assetsRoot, canonicalAssetsRoot)
  )
    reject("ASSETS_DIR must be isolated from the canonical asset tree");
  if (
    assetPath === canonicalAssetPath ||
    contains(canonicalAssetsRoot, assetPath)
  )
    reject(`the audition ${kind} must be detached from canonical assets`);
  return requested;
}

// Preserve the historical reed API, including its exact error prefix.
export function resolveDiagnosticPondReedSha256({
  environment,
  assetsRoot,
  canonicalAssetsRoot,
  reedPath,
  canonicalReedPath,
}) {
  return resolveDiagnosticPondAssetSha256({
    environment,
    assetsRoot,
    canonicalAssetsRoot,
    assetPath: reedPath,
    canonicalAssetPath: canonicalReedPath,
    kind: "reed",
    shaEnvironment: DIAGNOSTIC_POND_REED_SHA_ENV,
  });
}

/** Same exact local-no-money boundary; only the named boulder lock is selected. */
export function resolveDiagnosticPondBoulderSha256({
  environment,
  assetsRoot,
  canonicalAssetsRoot,
  boulderPath,
  canonicalBoulderPath,
}) {
  return resolveDiagnosticPondAssetSha256({
    environment,
    assetsRoot,
    canonicalAssetsRoot,
    assetPath: boulderPath,
    canonicalAssetPath: canonicalBoulderPath,
    kind: "boulder",
    shaEnvironment: DIAGNOSTIC_POND_BOULDER_SHA_ENV,
  });
}
