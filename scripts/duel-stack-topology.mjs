import fs from "node:fs";
import path from "node:path";

import { assertHyperiaNodeVersion } from "./node-runtime-policy.mjs";

const HYPERBET_REQUIRED_PATHS = Object.freeze([
  "package.json",
  "packages/hyperbet-solana/package.json",
  "packages/hyperbet-solana/app/package.json",
  "packages/hyperbet-solana/keeper/package.json",
]);

export const DUEL_MODEL_PROVIDER_KEY_NAMES = Object.freeze([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
]);

function normalizeConfiguredPath(workspaceRoot, configuredPath) {
  const value = String(configuredPath || "").trim();
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value);
}

function isHyperbetWorkspace(candidate, existsSync) {
  return HYPERBET_REQUIRED_PATHS.every((relativePath) =>
    existsSync(path.join(candidate, relativePath)),
  );
}

export function resolveHyperbetWorkspace({
  workspaceRoot,
  configuredRoot,
  existsSync = fs.existsSync,
}) {
  const explicitRoot = normalizeConfiguredPath(workspaceRoot, configuredRoot);
  const candidates = explicitRoot
    ? [explicitRoot]
    : [
        path.resolve(workspaceRoot, "..", "hyperbet-solana-implementation"),
        path.resolve(workspaceRoot, "..", "hyperbet"),
      ];

  const root = candidates.find((candidate) =>
    isHyperbetWorkspace(candidate, existsSync),
  );
  if (!root) return null;

  const solanaDir = path.join(root, "packages", "hyperbet-solana");
  return Object.freeze({
    root,
    solanaDir,
    appDir: path.join(solanaDir, "app"),
    keeperDir: path.join(solanaDir, "keeper"),
    marketMakerDir: path.join(root, "packages", "market-maker-bot"),
  });
}

function normalizeSolanaCluster(rawCluster) {
  const cluster = String(rawCluster || "")
    .trim()
    .toLowerCase();
  if (cluster === "local") return "localnet";
  if (cluster === "mainnet") return "mainnet-beta";
  return cluster;
}

function assertSolanaProgramId(value, label) {
  const programId = String(value || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(programId)) {
    throw new Error(`${label} must be a base58 Solana program id`);
  }
  return programId;
}

export function resolveHyperbetSolanaDeployment({
  solanaDir,
  cluster,
  readFileSync = (filePath) => fs.readFileSync(filePath, "utf8"),
}) {
  const normalizedCluster = normalizeSolanaCluster(cluster);
  if (!normalizedCluster) {
    throw new Error("Hyperbet Solana cluster is required");
  }

  const registryPath = path.join(solanaDir, "deployments", "solana-v1.json");
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to read the Hyperbet Solana deployment registry at ${registryPath}: ${reason}`,
    );
  }

  const deployment = registry?.solana?.[normalizedCluster];
  if (!deployment || typeof deployment !== "object") {
    throw new Error(
      `Hyperbet Solana deployment registry has no ${normalizedCluster} entry`,
    );
  }

  return Object.freeze({
    cluster: normalizedCluster,
    fightOracleProgramId: assertSolanaProgramId(
      deployment.fightOracleProgramId,
      `${normalizedCluster} fight oracle program id`,
    ),
    duelMarketProgramId: assertSolanaProgramId(
      deployment.duelMarketProgramId,
      `${normalizedCluster} duel market program id`,
    ),
  });
}

export function normalizeHttpServiceUrl(rawValue, label) {
  const value = String(rawValue || "").trim();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain embedded credentials`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${label} must not contain a query or fragment`);
  }
  if (parsed.pathname !== "/") {
    throw new Error(`${label} must be an origin with no path`);
  }

  return parsed.origin;
}

function getRequiredServicePort(parsed, label) {
  const defaultPort =
    parsed.protocol === "https:" || parsed.protocol === "wss:" ? 443 : 80;
  const port = Number.parseInt(parsed.port || String(defaultPort), 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must include a valid TCP port`);
  }
  return port;
}

export function resolveDuelGameServiceTopology({ serverUrl, websocketUrl }) {
  const normalizedServerUrl = normalizeHttpServiceUrl(
    serverUrl,
    "Duel game server URL",
  );
  const parsedServerUrl = new URL(normalizedServerUrl);

  const websocketValue = String(websocketUrl || "").trim();
  let parsedWebsocketUrl;
  try {
    parsedWebsocketUrl = new URL(websocketValue);
  } catch {
    throw new Error("Duel game WebSocket URL must be an absolute WS(S) URL");
  }
  if (
    parsedWebsocketUrl.protocol !== "ws:" &&
    parsedWebsocketUrl.protocol !== "wss:"
  ) {
    throw new Error("Duel game WebSocket URL must use WS or WSS");
  }
  if (parsedWebsocketUrl.username || parsedWebsocketUrl.password) {
    throw new Error(
      "Duel game WebSocket URL must not contain embedded credentials",
    );
  }
  if (parsedWebsocketUrl.search || parsedWebsocketUrl.hash) {
    throw new Error(
      "Duel game WebSocket URL must not contain a query or fragment",
    );
  }
  if (parsedWebsocketUrl.pathname !== "/ws") {
    throw new Error("Duel game WebSocket URL must use the /ws endpoint");
  }

  return Object.freeze({
    serverUrl: normalizedServerUrl,
    websocketUrl: `${parsedWebsocketUrl.protocol}//${parsedWebsocketUrl.host}/ws`,
    serverPort: getRequiredServicePort(parsedServerUrl, "Duel game server URL"),
    websocketPort: getRequiredServicePort(
      parsedWebsocketUrl,
      "Duel game WebSocket URL",
    ),
  });
}

export function isLoopbackHostname(hostname) {
  return ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(
    String(hostname || "")
      .trim()
      .toLowerCase(),
  );
}

function isLoopbackRuntimeUrl(rawValue, allowedProtocols) {
  try {
    const parsed = new URL(String(rawValue || ""));
    return (
      allowedProtocols.includes(parsed.protocol) &&
      isLoopbackHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Fail before spawning services when model-free contestants could never pass
 * the server's production diagnostic-contestant boundary.
 */
export function assertStandaloneSparbotRuntimeBoundary({
  enabled,
  environment = {},
}) {
  if (enabled !== true) return false;
  const localSolanaIsNoMoney =
    environment.DUEL_LOCAL_SOLANA_MODE === "true" &&
    isLoopbackRuntimeUrl(environment.SOLANA_RPC_URL, ["http:", "https:"]);
  const hyperbetIsNoMoney =
    environment.DUEL_WITH_HYPERBET === "false" ||
    (environment.DUEL_WITH_HYPERBET === "true" &&
      (environment.DUEL_HYPERBET_READ_ONLY_MODE === "true" ||
        localSolanaIsNoMoney));
  const eligible =
    environment.NODE_ENV === "production" &&
    environment.DUEL_LOCAL_SMOKE_MODE === "true" &&
    environment.LOAD_TEST_MODE === "true" &&
    environment.DUEL_BETTING_ENABLED === "false" &&
    hyperbetIsNoMoney &&
    environment.STREAMING_DUEL_SCHEDULER_ROLE === "authority" &&
    isLoopbackRuntimeUrl(environment.PUBLIC_API_URL, ["http:", "https:"]) &&
    isLoopbackRuntimeUrl(environment.PUBLIC_WS_URL, ["ws:", "wss:"]);

  if (!eligible) {
    throw new Error(
      "Standalone scripted sparbots require an explicit production-shaped, authority-owned, loopback, no-money diagnostic boundary. Pass --local-smoke (or set DUEL_LOCAL_SMOKE_MODE=true and LOAD_TEST_MODE=true), and keep Hyperbet absent, explicitly read-only, or attached to the launcher-owned local Solana validator; otherwise configure a supported duel model provider.",
    );
  }
  return true;
}

export function assertManagedLocalSolanaBoundary({
  enabled,
  hyperbetRuntimeEnabled,
  remoteBettingMode,
  hyperbetReadOnlyMode,
  rpcUrl,
}) {
  if (enabled !== true) return false;
  if (
    hyperbetRuntimeEnabled !== true ||
    remoteBettingMode === true ||
    hyperbetReadOnlyMode === true ||
    !isLoopbackRuntimeUrl(rpcUrl, ["http:", "https:"])
  ) {
    throw new Error(
      "Managed local Solana requires the local transaction-enabled Hyperbet runtime and a loopback RPC URL",
    );
  }
  return true;
}

/**
 * A deliberate world-owner hard kill is never a normal launch capability.
 * Keep it inside the fully owned localnet smoke where every process, port,
 * database, signer, and on-chain account is disposable.
 */
export function assertAuthorityRestartDiagnosticBoundary({
  enabled,
  fresh,
  isolated,
  verify,
  localSmoke,
  localSolana,
  serverUrl,
  rpcUrl,
  pidFile,
}) {
  if (enabled !== true) return false;
  if (
    fresh !== true ||
    isolated !== true ||
    verify !== true ||
    localSmoke !== true ||
    localSolana !== true ||
    !isLoopbackRuntimeUrl(serverUrl, ["http:", "https:"]) ||
    !isLoopbackRuntimeUrl(rpcUrl, ["http:", "https:"]) ||
    !String(pidFile || "").trim()
  ) {
    throw new Error(
      "Authority restart injection requires a fresh, isolated, verified, loopback local-smoke with launcher-owned local Solana and an owned game-server PID file",
    );
  }
  return true;
}

export function shouldReleaseRestartedAuthorityStartupGate({
  authorityRecoveryEnabled,
  launcherOwnsStartupGate,
  generation,
}) {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("Game-server generation must be a positive integer");
  }
  return (
    authorityRecoveryEnabled === true &&
    launcherOwnsStartupGate === true &&
    generation > 1
  );
}

export function isLocalDatabaseUrl(rawValue) {
  if (!rawValue) return false;
  try {
    return isLoopbackHostname(new URL(rawValue).hostname);
  } catch {
    return false;
  }
}

function resolveDuelDatabaseMode(...rawValues) {
  for (const rawValue of rawValues) {
    const normalized = String(rawValue || "")
      .trim()
      .toLowerCase();
    if (!normalized) continue;
    if (normalized === "remote" || normalized === "local") {
      return normalized;
    }
    throw new Error("DUEL_DATABASE_MODE must be either local or remote");
  }
  return "local";
}

export function resolveDuelDatabaseConfiguration({
  runtimeEnvironment = {},
  serverEnvironment = {},
}) {
  const runtimeDatabaseUrl = String(
    runtimeEnvironment.DUEL_DATABASE_URL ||
      runtimeEnvironment.DATABASE_URL ||
      "",
  ).trim();
  const serverDatabaseUrl = String(serverEnvironment.DATABASE_URL || "").trim();
  const databaseUrl = runtimeDatabaseUrl || serverDatabaseUrl;
  const runtimeLocalPostgresSetting = runtimeEnvironment.USE_LOCAL_POSTGRES;
  const serverLocalPostgresSetting = serverEnvironment.USE_LOCAL_POSTGRES;
  const mode = resolveDuelDatabaseMode(
    runtimeEnvironment.DUEL_DATABASE_MODE,
    runtimeLocalPostgresSetting === "true" ? "local" : "",
    runtimeLocalPostgresSetting === "false" ? "remote" : "",
    isLocalDatabaseUrl(runtimeDatabaseUrl) ? "local" : "",
    runtimeDatabaseUrl ? "remote" : "",
    serverLocalPostgresSetting === "true" ? "local" : "",
    serverLocalPostgresSetting === "false" ? "remote" : "",
    isLocalDatabaseUrl(serverDatabaseUrl) ? "local" : "",
    serverDatabaseUrl ? "remote" : "",
  );

  if (!databaseUrl && mode === "remote") {
    throw new Error(
      "Remote duel database mode requires DUEL_DATABASE_URL or DATABASE_URL",
    );
  }

  if (databaseUrl) {
    let parsed;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      throw new Error(
        "The duel DATABASE_URL must be an absolute PostgreSQL URL",
      );
    }
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
      throw new Error("The duel DATABASE_URL must use postgres or postgresql");
    }
    if (!parsed.hostname || parsed.pathname === "/" || parsed.hash) {
      throw new Error(
        "The duel DATABASE_URL must include a host and database and must not contain a fragment",
      );
    }
    if (mode === "local" && !isLoopbackHostname(parsed.hostname)) {
      throw new Error(
        "Local duel database mode cannot silently discard a remote DATABASE_URL; set DUEL_DATABASE_MODE=remote or remove the URL",
      );
    }
  }

  return Object.freeze({
    mode,
    databaseUrl,
    useManagedLocalPostgres: !databaseUrl && mode === "local",
  });
}

export function resolveHyperbetRuntimeTopology({
  gameServerUrl,
  hyperbetApiUrl,
  bettingPort,
}) {
  const gameOrigin = normalizeHttpServiceUrl(
    gameServerUrl,
    "Hyperia game server URL",
  );
  const apiOrigin = normalizeHttpServiceUrl(
    hyperbetApiUrl,
    "Hyperbet backend URL",
  );
  if (
    !Number.isSafeInteger(bettingPort) ||
    bettingPort < 1 ||
    bettingPort > 65535
  ) {
    throw new Error("Hyperbet app port must be an integer between 1 and 65535");
  }

  return Object.freeze({
    gameOrigin,
    hyperbetApiUrl: apiOrigin,
    hyperbetAppUrl: `http://localhost:${bettingPort}`,
    streamStateSourceUrl: `${gameOrigin}/api/streaming/state`,
    bettingFeedStateUrl: `${gameOrigin}/api/internal/bet-sync/state`,
    bettingFeedEventsUrl: `${gameOrigin}/api/internal/bet-sync/events`,
  });
}

export function resolveHyperbetKeeperDatabaseTopology({
  managedLocalSolana,
  terminalDbPath,
  configuredServiceDbPath = "",
}) {
  const terminal = String(terminalDbPath || "").trim();
  const configuredService = String(configuredServiceDbPath || "").trim();
  if (!terminal || !path.isAbsolute(terminal)) {
    throw new Error("Hyperbet terminal ledger path must be absolute");
  }
  if (configuredService && !path.isAbsolute(configuredService)) {
    throw new Error("Hyperbet service database path must be absolute");
  }
  const service =
    configuredService ||
    (managedLocalSolana
      ? path.join(path.dirname(terminal), "service.sqlite")
      : terminal);
  if (managedLocalSolana && service === terminal) {
    throw new Error(
      "Managed local SOL service database and terminal ledger must not share a file",
    );
  }
  return Object.freeze({
    terminalDbPath: terminal,
    serviceDbPath: service,
  });
}

export function resolvePrivateBettingFeedToken(candidates, generateToken) {
  return resolvePrivateRuntimeSecret(
    candidates,
    generateToken,
    "The integrated betting-feed bearer token",
  );
}

export function resolvePrivateRuntimeSecret(
  candidates,
  generateSecret,
  label = "The private runtime secret",
) {
  const normalizedCandidates = candidates.map((value) =>
    value == null ? "" : String(value),
  );
  const malformed = normalizedCandidates.find(
    (value) => value.length > 0 && value !== value.trim(),
  );
  if (malformed !== undefined) {
    throw new Error(`${label} must not contain outer whitespace`);
  }
  const configured = normalizedCandidates.find(Boolean);
  const generated = configured ? "" : String(generateSecret());
  if (generated !== generated.trim()) {
    throw new Error(`${label} must not contain outer whitespace`);
  }
  const token = configured || generated;
  if (Buffer.byteLength(token, "utf8") < 32) {
    throw new Error(`${label} must contain at least 32 bytes`);
  }
  return Object.freeze({ token, generated: !configured });
}

export function resolveJwtRuntimeSecret(
  keyRingCandidates,
  legacySecretCandidates,
  generateSecret,
) {
  const keyRingConfigured = keyRingCandidates.some(
    (value) => String(value || "").trim().length > 0,
  );
  if (!keyRingConfigured) {
    return Object.freeze({
      ...resolvePrivateRuntimeSecret(
        legacySecretCandidates,
        generateSecret,
        "The local duel JWT secret",
      ),
      keyRingConfigured: false,
    });
  }

  const configuredLegacySecret = legacySecretCandidates
    .map((value) => String(value || "").trim())
    .find(Boolean);
  if (
    configuredLegacySecret &&
    Buffer.byteLength(configuredLegacySecret, "utf8") < 32
  ) {
    throw new Error(
      "The legacy duel JWT secret must contain at least 32 bytes",
    );
  }
  return Object.freeze({
    token: configuredLegacySecret || "",
    generated: false,
    keyRingConfigured: true,
  });
}

export function assertSupportedUwsNodeVersion(value) {
  return assertHyperiaNodeVersion(value);
}

export function assertProcessTerminationAllowed({ isolated, label, pids }) {
  const normalizedPids = Array.from(
    new Set(
      (Array.isArray(pids) ? pids : [])
        .map((pid) => Number(pid))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
    ),
  );
  if (isolated === true && normalizedPids.length > 0) {
    throw new Error(
      `Isolated duel launch refuses to terminate pre-existing ${label} process(es): ${normalizedPids.join(", ")}`,
    );
  }
  return Object.freeze(normalizedPids);
}

export function hasConfiguredDuelModelProvider(environment) {
  return DUEL_MODEL_PROVIDER_KEY_NAMES.some((name) =>
    Boolean(String(environment?.[name] || "").trim()),
  );
}

const STANDALONE_SPARBOT_STYLES = Object.freeze([
  "melee",
  "ranged",
  "mage",
  "prayer",
]);

export function resolveStandaloneSparbotStyles(rawValue, expectedCount) {
  if (
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 1 ||
    expectedCount > 20
  ) {
    throw new Error("Standalone sparbot count must be an integer from 1 to 20");
  }

  const configured = String(rawValue || "").trim();
  if (!configured || configured.toLowerCase() === "auto") {
    return Object.freeze(
      Array.from(
        { length: expectedCount },
        (_, index) =>
          STANDALONE_SPARBOT_STYLES[index % STANDALONE_SPARBOT_STYLES.length],
      ),
    );
  }

  const styles = configured
    .split(",")
    .map((style) => style.trim().toLowerCase());

  if (
    styles.some((style) => !style || !STANDALONE_SPARBOT_STYLES.includes(style))
  ) {
    throw new Error(
      `Standalone sparbot styles must be one of: ${STANDALONE_SPARBOT_STYLES.join(", ")}`,
    );
  }

  if (styles.length === 1) {
    return Object.freeze(Array(expectedCount).fill(styles[0]));
  }
  if (styles.length !== expectedCount) {
    throw new Error(
      `Standalone sparbot styles must contain either one style or exactly ${expectedCount} comma-separated styles`,
    );
  }
  return Object.freeze([...styles]);
}

export function resolveStandaloneSparbotProfileSeed(rawValue, options = {}) {
  const configured = String(rawValue ?? "").trim();
  if (!configured) return null;
  if (options.enabled !== true || options.localSmoke !== true) {
    throw new Error(
      "A standalone sparbot profile seed requires the explicit local-smoke no-money diagnostic lane",
    );
  }
  if (!/^\d+$/.test(configured)) {
    throw new Error(
      "Standalone sparbot profile seed must be an unsigned 32-bit integer",
    );
  }
  const seed = Number(configured);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error(
      "Standalone sparbot profile seed must be an unsigned 32-bit integer",
    );
  }
  return seed;
}

export function assertMultiStyleSparbotOptions({
  enabled,
  localSmoke,
  styles,
}) {
  if (enabled !== true) return false;
  if (
    localSmoke !== true ||
    !Array.isArray(styles) ||
    styles.length === 0 ||
    styles.some((style) => !["melee", "ranged", "mage"].includes(style))
  ) {
    throw new Error(
      "Multi-style sparbots require local smoke mode and melee/ranged/mage opening styles",
    );
  }
  return true;
}

export function isStandaloneSparbotBootstrap(payload, expectedCount) {
  return Boolean(
    payload?.success === true &&
    Array.isArray(payload.spawned) &&
    payload.spawned.length === expectedCount &&
    payload.spawned.every(
      (sparbot) =>
        sparbot &&
        typeof sparbot.characterId === "string" &&
        sparbot.characterId.startsWith("sparbot-standalone-") &&
        typeof sparbot.name === "string" &&
        sparbot.name.trim().length > 0 &&
        sparbot.tier === "adept",
    ),
  );
}

export function isBettingFeedBootstrap(payload) {
  return Boolean(
    payload &&
    typeof payload === "object" &&
    payload.schemaVersion === 3 &&
    Number.isSafeInteger(payload.sourceEpoch) &&
    payload.sourceEpoch > 0 &&
    Number.isSafeInteger(payload.seq) &&
    payload.seq >= 0 &&
    Number.isSafeInteger(payload.emittedAt) &&
    payload.emittedAt > 0 &&
    payload.replay &&
    typeof payload.replay === "object" &&
    payload.replay.sourceEpoch === payload.sourceEpoch,
  );
}

export function isHyperbetStreamSynchronized(payload, expected) {
  const stream = payload?.stream;
  const hasAuthoritativeIdentity =
    stream?.cycleId !== "boot-cycle" &&
    ((stream?.phase === "IDLE" &&
      (stream?.cycleId === "" || stream?.cycleId === null)) ||
      (typeof stream?.cycleId === "string" &&
        stream.cycleId.trim().length > 0));
  return Boolean(
    payload?.service === "hyperbet-solana-backend" &&
    stream &&
    typeof stream === "object" &&
    stream.sourceUrl === expected.sourceUrl &&
    Number.isSafeInteger(stream.lastSourcePollAt) &&
    stream.lastSourcePollAt >= expected.startedAtMs &&
    stream.lastSourceError === null &&
    hasAuthoritativeIdentity &&
    Number.isSafeInteger(stream.seq) &&
    stream.seq >= 0,
  );
}

export function isFreshHyperbetReadiness(payload, keeperStartedAtMs) {
  const health = payload?.health;
  return Boolean(
    payload?.ok === true &&
    payload?.readiness?.ready === true &&
    Array.isArray(payload?.readiness?.reasons) &&
    payload.readiness.reasons.length === 0 &&
    health?.running === true &&
    Number.isSafeInteger(health.bootedAtMs) &&
    health.bootedAtMs >= keeperStartedAtMs,
  );
}

export function omitEnvironmentKeys(environment, names) {
  const omitted = new Set(names);
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !omitted.has(name)),
  );
}
