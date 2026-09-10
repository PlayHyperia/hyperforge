const REQUIRED_PORT_NAMES = Object.freeze([
  "server",
  "websocket",
  "client",
  "capture",
  "captureBrowser",
  "spectator",
  "postgres",
  "hyperbetApi",
  "hyperbetApp",
  "solanaRpc",
]);

const DEFAULT_LOCAL_SOLANA_LEDGER_SHREDS = 10_000;
// Run-D measurements showed roughly 208 retained shreds per wall-clock second.
// Keep one full hour for bounded local restart/backfill while the lifecycle
// parser continuously persists its finalized checkpoint during longer soaks.
const LOCAL_SOLANA_LEDGER_SHREDS_PER_SECOND = 208;
const LOCAL_SOLANA_LEDGER_RECOVERY_WINDOW_SECONDS = 3_600;
const LOCAL_SOLANA_LEDGER_SHRED_INCREMENT = 10_000;

/**
 * Keep the outer launcher deadline distinct from the per-stage readiness
 * deadline passed to duel-stack. The stack starts several independently
 * bounded services in sequence, so reusing one stage deadline for the whole
 * launch can terminate a healthy cold start before the final service listens.
 */
export function validateDuelSmokeLaunchDeadlines({
  stageTimeoutMs,
  overallLaunchTimeoutMs,
}) {
  if (!Number.isSafeInteger(stageTimeoutMs) || stageTimeoutMs < 60_000) {
    throw new Error(
      "Duel smoke per-stage timeout must be an integer of at least 60000ms",
    );
  }
  if (
    !Number.isSafeInteger(overallLaunchTimeoutMs) ||
    overallLaunchTimeoutMs < 60_000 ||
    overallLaunchTimeoutMs > 7_200_000
  ) {
    throw new Error(
      "Duel smoke overall launch timeout must be an integer from 60000ms to 7200000ms",
    );
  }
  if (overallLaunchTimeoutMs < stageTimeoutMs) {
    throw new Error(
      "Duel smoke overall launch timeout cannot be shorter than its per-stage timeout",
    );
  }
  return Object.freeze({ stageTimeoutMs, overallLaunchTimeoutMs });
}

export function resolveDuelSmokeLocalSolanaLedgerShreds(soakDurationSeconds) {
  if (!Number.isSafeInteger(soakDurationSeconds) || soakDurationSeconds < 0) {
    throw new Error(
      "Duel smoke soak duration must be a safe non-negative integer",
    );
  }
  if (soakDurationSeconds === 0) {
    return DEFAULT_LOCAL_SOLANA_LEDGER_SHREDS;
  }
  const retainedSeconds = Math.min(
    soakDurationSeconds,
    LOCAL_SOLANA_LEDGER_RECOVERY_WINDOW_SECONDS,
  );
  const requiredShreds =
    retainedSeconds * LOCAL_SOLANA_LEDGER_SHREDS_PER_SECOND;
  return Math.max(
    DEFAULT_LOCAL_SOLANA_LEDGER_SHREDS,
    Math.ceil(requiredShreds / LOCAL_SOLANA_LEDGER_SHRED_INCREMENT) *
      LOCAL_SOLANA_LEDGER_SHRED_INCREMENT,
  );
}

export function listManagedLocalSolanaPorts(rpcPort) {
  const parsed = Number(rpcPort);
  if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 65_332) {
    throw new Error(
      "Duel smoke local Solana RPC port must be an integer from 1024 to 65332",
    );
  }
  return Object.freeze([
    parsed,
    parsed + 1,
    parsed + 2,
    parsed + 3,
    ...Array.from({ length: 100 }, (_, index) => parsed + 100 + index),
  ]);
}

export function validateDuelSmokePorts(ports) {
  const values = REQUIRED_PORT_NAMES.map((name) => {
    const value = Number(ports?.[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
      throw new Error(
        `Duel smoke ${name} port must be an integer from 1 to 65535`,
      );
    }
    return value;
  });
  if (new Set(values).size !== values.length) {
    throw new Error("Duel smoke service ports must be unique");
  }
  return Object.freeze(
    Object.fromEntries(
      REQUIRED_PORT_NAMES.map((name, index) => [name, values[index]]),
    ),
  );
}

export function describeDuelSmokePortAvailabilityError({ name, port, error }) {
  const code =
    error && typeof error === "object" && typeof error.code === "string"
      ? error.code
      : "UNKNOWN";
  if (code === "EADDRINUSE") {
    return `Duel smoke ${name} port ${port} is already in use`;
  }
  if (code === "EACCES" || code === "EPERM") {
    return (
      `Duel smoke cannot validate ${name} port ${port}: ` +
      `local network binding is not permitted in this environment (${code})`
    );
  }
  return `Duel smoke cannot validate ${name} port ${port}: socket bind failed (${code})`;
}

export function resolveDuelSmokeMotionStreamUrl(ports) {
  const validated = validateDuelSmokePorts(ports);
  return `http://127.0.0.1:${validated.client}/stream.html`;
}

export function resolveDuelSmokeMotionStartupTimeoutSeconds({
  durationSeconds,
  withLocalSolana,
}) {
  if (
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds < 15 ||
    durationSeconds > 300
  ) {
    throw new Error(
      "Duel smoke live-evidence duration must be an integer from 15 to 300 seconds",
    );
  }
  if (typeof withLocalSolana !== "boolean") {
    throw new Error("Duel smoke local-Solana timing policy must be boolean");
  }

  // A probe can attach just after a fight and must survive the complete
  // 65-second inter-cycle pause, 120-second betting announcement, and 5-second
  // preparation window before its first eligible FIGHTING sample.
  const cadenceFloorSeconds = withLocalSolana ? 240 : 120;
  return Math.min(300, Math.max(cadenceFloorSeconds, durationSeconds * 2));
}

/**
 * Sample the encoded stream across the complete retained clip instead of
 * treating one convenient frame as visual evidence. Keep a bounded margin at
 * both ends so decoder startup and the exact terminal frame cannot dominate
 * the review sheet.
 */
export function resolveDuelSmokeReviewFrameTimestamps(durationSeconds) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration < 15 || duration > 300) {
    throw new Error(
      "Duel smoke review duration must be a number from 15 to 300 seconds",
    );
  }
  const frameCount = 6;
  const marginSeconds = Math.min(2, duration * 0.1);
  const reviewSpanSeconds = duration - marginSeconds * 2;
  return Object.freeze(
    Array.from({ length: frameCount }, (_, index) =>
      Number(
        (
          marginSeconds +
          (reviewSpanSeconds * index) / (frameCount - 1)
        ).toFixed(3),
      ),
    ),
  );
}

export function validateDuelSmokeReviewFrameEvidence({
  frameSha256Values,
  contactSheetWidth,
  contactSheetHeight,
}) {
  if (
    !Array.isArray(frameSha256Values) ||
    frameSha256Values.length !== 6 ||
    frameSha256Values.some(
      (value) => !/^[0-9a-f]{64}$/.test(String(value ?? "")),
    )
  ) {
    throw new Error(
      "Duel smoke visual review requires exactly six SHA-256-locked frames",
    );
  }
  const uniqueFrameCount = new Set(frameSha256Values).size;
  if (uniqueFrameCount !== frameSha256Values.length) {
    throw new Error(
      "Duel smoke visual review frames must be byte-distinct across the retained clip",
    );
  }
  if (contactSheetWidth !== 1_920 || contactSheetHeight !== 720) {
    throw new Error(
      "Duel smoke visual review contact sheet must be exactly 1920x720",
    );
  }
  return Object.freeze({
    frameCount: frameSha256Values.length,
    uniqueFrameCount,
    contactSheetWidth,
    contactSheetHeight,
  });
}

/**
 * Validate the browser profile before an expensive clean launch starts. The
 * downstream motion gate validates these values again, but the top-level smoke
 * must fail before builds, validators, browsers, or stream processes exist.
 */
export function validateDuelSmokeLiveEvidenceProfile({
  viewport,
  networkLatencyMs,
  cpuThrottleRate,
}) {
  const viewportMatch = /^(\d{2,5})x(\d{2,5})$/i.exec(
    String(viewport ?? "").trim(),
  );
  if (!viewportMatch) {
    throw new Error(
      "Duel smoke live-evidence viewport must use WIDTHxHEIGHT format",
    );
  }
  const width = Number(viewportMatch[1]);
  const height = Number(viewportMatch[2]);
  if (!Number.isSafeInteger(width) || width < 320 || width > 7_680) {
    throw new Error(
      "Duel smoke live-evidence viewport width must be an integer from 320 to 7680",
    );
  }
  if (!Number.isSafeInteger(height) || height < 320 || height > 4_320) {
    throw new Error(
      "Duel smoke live-evidence viewport height must be an integer from 320 to 4320",
    );
  }

  const resolvedLatencyMs = Number(networkLatencyMs);
  if (
    !Number.isSafeInteger(resolvedLatencyMs) ||
    resolvedLatencyMs < 0 ||
    resolvedLatencyMs > 2_000
  ) {
    throw new Error(
      "Duel smoke live-evidence network latency must be an integer from 0 to 2000ms",
    );
  }
  const resolvedCpuThrottleRate = Number(cpuThrottleRate);
  if (
    !Number.isFinite(resolvedCpuThrottleRate) ||
    resolvedCpuThrottleRate < 1 ||
    resolvedCpuThrottleRate > 20
  ) {
    throw new Error(
      "Duel smoke live-evidence CPU throttle must be a number from 1 to 20",
    );
  }

  return Object.freeze({
    viewport: `${width}x${height}`,
    networkLatencyMs: resolvedLatencyMs,
    cpuThrottleRate: resolvedCpuThrottleRate,
  });
}

const HEADFUL_CAPTURE_VALUES = Object.freeze(["false", "0", "no", "off"]);

/**
 * Bind qualification smoke capture to an installed, headful browser and the
 * platform's required ANGLE backend. A conflicting inherited shell setting is
 * rejected before any build or service starts rather than silently weakening
 * the renderer exercised by the smoke.
 */
export function resolveDuelSmokeCaptureBrowserEnvironment({
  platform,
  environment = {},
}) {
  if (!environment || typeof environment !== "object") {
    throw new Error("Duel smoke capture environment must be an object");
  }
  const normalizedPlatform = String(platform ?? "")
    .trim()
    .toLowerCase();
  const requestedChannel = String(environment.STREAM_CAPTURE_CHANNEL ?? "")
    .trim()
    .toLowerCase();
  const requestedAngle = String(environment.STREAM_CAPTURE_ANGLE ?? "")
    .trim()
    .toLowerCase();
  const requestedHeadless = String(environment.STREAM_CAPTURE_HEADLESS ?? "")
    .trim()
    .toLowerCase();
  const requestedObserverChannel = String(
    environment.STREAMING_CAPTURE_BROWSER_CHANNEL ?? "",
  )
    .trim()
    .toLowerCase();
  const requestedObserverAngle = String(
    environment.STREAMING_CAPTURE_ANGLE ?? "",
  )
    .trim()
    .toLowerCase();

  const assertHeadful = () => {
    if (
      requestedHeadless &&
      !HEADFUL_CAPTURE_VALUES.includes(requestedHeadless)
    ) {
      throw new Error(
        "Duel smoke 3D capture must be headful (STREAM_CAPTURE_HEADLESS=false)",
      );
    }
  };

  if (normalizedPlatform === "darwin") {
    const allowedChannels = ["chrome", "chromium"];
    if (
      (requestedChannel && !allowedChannels.includes(requestedChannel)) ||
      (requestedObserverChannel &&
        !allowedChannels.includes(requestedObserverChannel))
    ) {
      throw new Error(
        "macOS duel smoke capture requires installed Google Chrome (STREAM_CAPTURE_CHANNEL=chrome)",
      );
    }
    if (
      (requestedAngle && requestedAngle !== "metal") ||
      (requestedObserverAngle && requestedObserverAngle !== "metal")
    ) {
      throw new Error(
        "macOS duel smoke capture requires ANGLE Metal (STREAM_CAPTURE_ANGLE=metal)",
      );
    }
    assertHeadful();
    return Object.freeze({
      STREAM_CAPTURE_CHANNEL: "chrome",
      STREAM_CAPTURE_ANGLE: "metal",
      STREAM_CAPTURE_HEADLESS: "false",
      STREAMING_CAPTURE_BROWSER_CHANNEL: "chrome",
      STREAMING_CAPTURE_ANGLE: "metal",
    });
  }

  if (normalizedPlatform === "linux") {
    const allowedChannels = ["chrome-canary", "chromium", "bundled"];
    if (
      (requestedChannel && !allowedChannels.includes(requestedChannel)) ||
      (requestedObserverChannel &&
        !allowedChannels.includes(requestedObserverChannel))
    ) {
      throw new Error(
        "Linux duel smoke capture requires installed Chrome Canary through ANGLE",
      );
    }
    if (
      (requestedAngle && requestedAngle !== "vulkan") ||
      (requestedObserverAngle && requestedObserverAngle !== "vulkan")
    ) {
      throw new Error(
        "Linux duel smoke capture requires ANGLE Vulkan (STREAM_CAPTURE_ANGLE=vulkan)",
      );
    }
    assertHeadful();
    return Object.freeze({
      STREAM_CAPTURE_CHANNEL: "chrome-canary",
      STREAM_CAPTURE_ANGLE: "vulkan",
      STREAM_CAPTURE_HEADLESS: "false",
      STREAMING_CAPTURE_BROWSER_CHANNEL: "chrome-canary",
      STREAMING_CAPTURE_ANGLE: "vulkan",
    });
  }

  // Preserve the prior bundled-browser behavior on platforms without a
  // repository-defined installed-browser GPU contract.
  return Object.freeze({ STREAM_CAPTURE_CHANNEL: "bundled" });
}

const DUEL_SMOKE_COMBAT_ROLES = Object.freeze(["melee", "ranged", "mage"]);

/**
 * Resolve the exact combat role contract before starting an expensive smoke.
 * `multi` retains the dynamic all-role launch qualification. A two-role CSV
 * freezes one opening/loadout role per contestant so isolated and same-style
 * launch slices cannot pass on evidence collected from another role.
 */
export function validateDuelSmokeCombatProfile(value) {
  const configured = String(value ?? "")
    .trim()
    .toLowerCase();
  if (configured === "multi") {
    return Object.freeze({
      name: "multi",
      roles: DUEL_SMOKE_COMBAT_ROLES,
      botStyles: "melee,ranged",
      multiStyle: true,
    });
  }

  const roles = configured.split(",").map((role) => role.trim());
  if (
    roles.length !== 2 ||
    roles.some((role) => !role || !DUEL_SMOKE_COMBAT_ROLES.includes(role))
  ) {
    throw new Error(
      "Duel smoke combat profile must be multi or exactly two comma-separated melee/ranged/mage roles",
    );
  }
  return Object.freeze({
    name: roles.join(","),
    roles: Object.freeze([...roles]),
    botStyles: roles.join(","),
    multiStyle: false,
  });
}

export function buildDuelSmokeMotionCombatArgs(value) {
  const profile = validateDuelSmokeCombatProfile(value);
  return Object.freeze([
    "--roles",
    profile.roles.join(","),
    ...(profile.multiStyle ? ["--multi-style"] : []),
    // This observer inspects the actual WebGPU scene. It is distinct from the
    // intentionally headless HLS-only Hyperbet viewer used by the soak.
    "--headed",
  ]);
}

export function bindDuelSmokeStreamCredential(token) {
  const normalized = String(token ?? "").trim();
  if (!normalized) {
    throw new Error("Duel smoke stream credential must be non-empty");
  }
  return Object.freeze({
    STREAMING_VIEWER_ACCESS_TOKEN: normalized,
    STREAMING_CAPTURE_VIEWER_TOKEN: normalized,
  });
}

export function resolveDuelSmokeMaterializedSourceAttestation({
  runtimeHasGitMetadata,
  sourceRevision,
}) {
  if (typeof runtimeHasGitMetadata !== "boolean") {
    throw new Error("Duel smoke runtime Git-metadata policy must be boolean");
  }
  if (runtimeHasGitMetadata) return Object.freeze([]);
  const revision = String(sourceRevision ?? "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(revision)) {
    throw new Error(
      "Duel smoke materialized runtime requires a valid source revision",
    );
  }
  return Object.freeze([
    "--hyperbet-source-revision",
    revision,
    "--hyperbet-working-tree-dirty",
  ]);
}

export function buildDuelSmokeLauncherArgs({
  ports,
  timeoutMs,
  withHyperbet = false,
  withKeeper = false,
  withLocalSolana = false,
  withAuthorityRecovery = false,
  reuseGameBuilds = false,
  localSolanaLedgerShreds = DEFAULT_LOCAL_SOLANA_LEDGER_SHREDS,
  combatProfile = "multi",
}) {
  const validated = validateDuelSmokePorts(ports);
  const validatedCombatProfile = validateDuelSmokeCombatProfile(combatProfile);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000) {
    throw new Error("Duel smoke timeout must be at least 60000ms");
  }
  if (withKeeper && !withHyperbet) {
    throw new Error(
      "Duel smoke keeper verification requires the Hyperbet runtime",
    );
  }
  if (withLocalSolana && !withKeeper) {
    throw new Error(
      "Duel smoke managed local Solana requires keeper verification",
    );
  }
  if (withAuthorityRecovery && !withLocalSolana) {
    throw new Error(
      "Duel smoke authority recovery requires the owned local Solana topology",
    );
  }
  if (typeof reuseGameBuilds !== "boolean") {
    throw new Error("Duel smoke reuse-game-builds policy must be boolean");
  }
  if (withLocalSolana) {
    if (
      !Number.isSafeInteger(localSolanaLedgerShreds) ||
      localSolanaLedgerShreds < DEFAULT_LOCAL_SOLANA_LEDGER_SHREDS ||
      localSolanaLedgerShreds > 10_000_000
    ) {
      throw new Error(
        "Duel smoke local Solana ledger shreds must be an integer from 10000 to 10000000",
      );
    }
    const solanaPorts = new Set(
      listManagedLocalSolanaPorts(validated.solanaRpc),
    );
    for (const [name, port] of Object.entries(validated)) {
      if (name !== "solanaRpc" && solanaPorts.has(port)) {
        throw new Error(
          `Duel smoke ${name} port overlaps the managed local Solana range`,
        );
      }
    }
  }

  const args = [
    "scripts/duel-stack.mjs",
    "--fresh",
    "--isolated",
    "--verify",
    "--bots=2",
    "--local-smoke",
    "--bot-styles",
    validatedCombatProfile.botStyles,
    "--sparbot-profile-seed",
    "1592594996",
    "--server-url",
    `http://127.0.0.1:${validated.server}`,
    "--ws-url",
    `ws://127.0.0.1:${validated.websocket}/ws`,
    "--client-url",
    `http://127.0.0.1:${validated.client}`,
    "--rtmp-port",
    String(validated.capture),
    "--capture-browser-port",
    String(validated.captureBrowser),
    "--startup-timeout-ms",
    String(timeoutMs),
    "--verify-timeout-ms",
    String(timeoutMs),
  ];
  if (validatedCombatProfile.multiStyle) {
    args.push("--multi-style-sparbots");
  }
  if (reuseGameBuilds) args.push("--reuse-game-builds");

  if (withHyperbet) {
    args.push(
      "--betting-port",
      String(validated.hyperbetApp),
      "--hyperbet-api-url",
      `http://127.0.0.1:${validated.hyperbetApi}`,
    );
    if (!withKeeper) args.push("--skip-keeper");
    if (withLocalSolana) {
      args.push(
        "--local-solana",
        "--local-solana-rpc-port",
        String(validated.solanaRpc),
        "--local-solana-ledger-shreds",
        String(localSolanaLedgerShreds),
      );
    }
  } else {
    args.push("--skip-betting", "--skip-keeper");
  }
  if (withAuthorityRecovery) args.push("--authority-recovery");

  return Object.freeze(args);
}

export function isDuelSmokeOnlineLine(line) {
  return /^\[duel\] stack online\s*$/.test(String(line || "").trim());
}

const FORBIDDEN_KEEPER_RUNTIME_DIAGNOSTICS = Object.freeze([
  ["market-create-failed", /Failed to create market for duel/i],
  ["market-lock-failed", /Failed to lock market for duel/i],
  ["invalid-lifecycle-transition", /\bInvalidLifecycleTransition\b/i],
  ["finalized-duel-replayed", /\bDuelAlreadyFinalized\b/i],
  ["keeper-cycle-failed", /\[bot\]\s+cycle failed/i],
  ["betting-feed-poll-failed", /\[GameClient\]\s+streaming poll failed/i],
]);

export function classifyDuelSmokeForbiddenRuntimeDiagnostic(line) {
  const text = String(line || "").trim();
  if (!text) return null;
  const match = FORBIDDEN_KEEPER_RUNTIME_DIAGNOSTICS.find(([, pattern]) =>
    pattern.test(text),
  );
  return match ? Object.freeze({ code: match[0], line: text }) : null;
}

const SOLANA_PUBLIC_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const SOLANA_SYSTEM_PROGRAM = "11111111111111111111111111111111";

function toNonNegativeBigInt(value, label) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

export function validateLocalSolanaBrowserOrderEvidence(input) {
  const signature = String(input?.signature || "").trim();
  const wallet = String(input?.wallet || "").trim();
  const marketRef = String(input?.marketRef || "").trim();
  const vault = String(input?.vault || "").trim();
  const programId = String(input?.programId || "").trim();
  if (!SOLANA_SIGNATURE.test(signature)) {
    throw new Error("Local browser order is missing a canonical signature");
  }
  for (const [label, value] of [
    ["wallet", wallet],
    ["market", marketRef],
    ["vault", vault],
    ["program", programId],
  ]) {
    if (!SOLANA_PUBLIC_KEY.test(value)) {
      throw new Error(`Local browser order ${label} is not a Solana address`);
    }
  }

  const transaction = input?.transaction;
  if (!transaction || transaction.error != null) {
    throw new Error("Local browser order transaction did not finalize cleanly");
  }
  if (String(transaction.signature || "").trim() !== signature) {
    throw new Error(
      "Browser signature does not match the finalized transaction",
    );
  }
  const accountKeys = Array.isArray(transaction.accountKeys)
    ? transaction.accountKeys.map((value) => String(value))
    : [];
  const preBalances = Array.isArray(transaction.preBalances)
    ? transaction.preBalances
    : [];
  const postBalances = Array.isArray(transaction.postBalances)
    ? transaction.postBalances
    : [];
  if (
    accountKeys.length === 0 ||
    preBalances.length !== accountKeys.length ||
    postBalances.length !== accountKeys.length
  ) {
    throw new Error("Local browser order transaction balance vectors drifted");
  }
  for (const required of [wallet, marketRef, vault, programId]) {
    if (!accountKeys.includes(required)) {
      throw new Error(
        `Local browser order transaction omitted required account ${required}`,
      );
    }
  }
  const instructions = Array.isArray(transaction.instructions)
    ? transaction.instructions
    : [];
  const invokesProgram = instructions.some((instruction) => {
    if (String(instruction?.programId || "") === programId) return true;
    const index = Number(instruction?.programIdIndex);
    return Number.isInteger(index) && accountKeys[index] === programId;
  });
  const logMessages = Array.isArray(transaction.logMessages)
    ? transaction.logMessages.map((value) => String(value))
    : [];
  if (
    !invokesProgram ||
    !logMessages.some((line) => /Instruction:\s*PlaceOrder\b/i.test(line))
  ) {
    throw new Error("Local browser transaction is not an exact PlaceOrder");
  }

  const walletIndex = accountKeys.indexOf(wallet);
  const walletBefore = toNonNegativeBigInt(
    preBalances[walletIndex],
    "wallet pre-balance",
  );
  const walletAfter = toNonNegativeBigInt(
    postBalances[walletIndex],
    "wallet post-balance",
  );
  if (walletAfter >= walletBefore) {
    throw new Error("Local browser order did not debit its signing wallet");
  }
  const walletDebit = walletBefore - walletAfter;
  const feeLamports = toNonNegativeBigInt(
    transaction.feeLamports,
    "transaction fee",
  );
  if (feeLamports <= 0n) {
    throw new Error("Local browser order has no transaction fee evidence");
  }

  const owners = input?.accountOwners || {};
  const positiveCustodyAccounts = [];
  const positiveProgramAccounts = [];
  let positiveDeltaLamports = 0n;
  let positiveProgramDeltaLamports = 0n;
  for (let index = 0; index < accountKeys.length; index += 1) {
    if (index === walletIndex) continue;
    const before = toNonNegativeBigInt(
      preBalances[index],
      `pre-balance for ${accountKeys[index]}`,
    );
    const after = toNonNegativeBigInt(
      postBalances[index],
      `post-balance for ${accountKeys[index]}`,
    );
    if (after < before) {
      throw new Error(
        `Local browser order unexpectedly debited ${accountKeys[index]}`,
      );
    }
    if (after === before) continue;
    const delta = after - before;
    const address = accountKeys[index];
    const owner = String(owners[address] || "");
    positiveDeltaLamports += delta;
    if (address === vault) {
      if (owner !== SOLANA_SYSTEM_PROGRAM) {
        throw new Error(
          "Local browser order exact native SOL vault is not system-owned",
        );
      }
      positiveCustodyAccounts.push({
        address,
        owner,
        role: "native-sol-vault",
        deltaLamports: delta.toString(),
      });
      continue;
    }
    if (owner !== programId) {
      throw new Error(
        `Local browser order credited non-program account ${address}`,
      );
    }
    const programAccount = {
      address,
      owner,
      role: "program-account",
      deltaLamports: delta.toString(),
    };
    positiveProgramDeltaLamports += delta;
    positiveProgramAccounts.push(programAccount);
    positiveCustodyAccounts.push(programAccount);
  }
  const vaultDelta = positiveCustodyAccounts.find(
    (account) => account.address === vault,
  );
  if (!vaultDelta || BigInt(vaultDelta.deltaLamports) <= 0n) {
    throw new Error("Local browser order did not fund the exact market vault");
  }
  if (positiveProgramAccounts.length < 1) {
    throw new Error(
      "Local browser order did not fund its vault plus durable program custody",
    );
  }
  if (walletDebit !== feeLamports + positiveDeltaLamports) {
    throw new Error(
      "Local browser order lamport deltas do not conserve wallet debit, fee, and program custody",
    );
  }

  const tracking = input?.tracking;
  const execution = tracking?.execution;
  if (tracking?.ok !== true || !execution) {
    throw new Error("Keeper did not verify and record the local browser order");
  }
  const matchedAmountUnits = toNonNegativeBigInt(
    execution.matchedAmountUnits,
    "matched amount",
  );
  const collateralLamports = toNonNegativeBigInt(
    execution.collateralLamports,
    "collateral",
  );
  const executedCostLamports = toNonNegativeBigInt(
    execution.executedCostLamports,
    "executed cost",
  );
  const tradeTreasuryFeeLamports = toNonNegativeBigInt(
    execution.tradeTreasuryFeeLamports,
    "treasury fee",
  );
  const tradeMarketMakerFeeLamports = toNonNegativeBigInt(
    execution.tradeMarketMakerFeeLamports,
    "market-maker fee",
  );
  const sourceAmountLamports = toNonNegativeBigInt(
    execution.sourceAmountLamports,
    "source amount",
  );
  const rewardEligibleLamports = toNonNegativeBigInt(
    execution.rewardEligibleLamports,
    "reward-eligible amount",
  );
  const executionFees = tradeTreasuryFeeLamports + tradeMarketMakerFeeLamports;
  if (matchedAmountUnits <= 0n || executedCostLamports <= 0n) {
    throw new Error(
      "Local browser order did not execute against live liquidity",
    );
  }
  if (collateralLamports < executedCostLamports) {
    throw new Error("Keeper execution cost exceeds verified collateral");
  }
  if (sourceAmountLamports !== collateralLamports + executionFees) {
    throw new Error(
      "Keeper source amount does not conserve collateral and fees",
    );
  }
  if (rewardEligibleLamports !== executedCostLamports + executionFees) {
    throw new Error(
      "Keeper reward-eligible amount does not conserve execution cost and fees",
    );
  }

  return Object.freeze({
    signature,
    wallet,
    marketRef,
    vault,
    programId,
    slot: Number(transaction.slot),
    feeLamports: feeLamports.toString(),
    walletDebitLamports: walletDebit.toString(),
    vaultCreditLamports: vaultDelta.deltaLamports,
    custodyCreditLamports: positiveDeltaLamports.toString(),
    programAccountCreditLamports: positiveProgramDeltaLamports.toString(),
    positiveCustodyAccounts: Object.freeze(positiveCustodyAccounts),
    positiveProgramAccounts: Object.freeze(positiveProgramAccounts),
    execution: Object.freeze({
      matchedAmountUnits: matchedAmountUnits.toString(),
      collateralLamports: collateralLamports.toString(),
      executedCostLamports: executedCostLamports.toString(),
      tradeTreasuryFeeLamports: tradeTreasuryFeeLamports.toString(),
      tradeMarketMakerFeeLamports: tradeMarketMakerFeeLamports.toString(),
      sourceAmountLamports: sourceAmountLamports.toString(),
      rewardEligibleLamports: rewardEligibleLamports.toString(),
    }),
  });
}

export function validateHyperbetLiveFightObservation(input) {
  const observation = input?.observation;
  const transaction = input?.transaction;
  const expectedHlsUrl = String(input?.expectedHlsUrl || "").trim();
  let parsedHlsUrl;
  try {
    parsedHlsUrl = new URL(expectedHlsUrl);
  } catch {
    throw new Error("Hyperbet live-fight proof requires an absolute HLS URL");
  }
  if (
    !["http:", "https:"].includes(parsedHlsUrl.protocol) ||
    parsedHlsUrl.username ||
    parsedHlsUrl.password
  ) {
    throw new Error("Hyperbet live-fight proof HLS URL is unsafe");
  }
  if (!observation || observation.liveState !== "LIVE") {
    throw new Error("Hyperbet browser never observed an exact live fight");
  }

  const cycleId = String(observation.cycleId || "").trim();
  const duelId = String(observation.duelId || "").trim();
  const duelKey = String(observation.duelKey || "").trim();
  if (!cycleId || cycleId.length > 128 || !duelId || duelId.length > 128) {
    throw new Error(
      "Hyperbet live-fight proof is missing bounded duel identity",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(duelKey)) {
    throw new Error("Hyperbet live-fight proof has an invalid duel key");
  }
  if (
    duelId !== String(transaction?.duelId || "").trim() ||
    duelKey !== String(transaction?.duelKey || "").trim()
  ) {
    throw new Error(
      "Hyperbet live-fight proof does not match the signed browser order",
    );
  }

  const observedAtMs = Number(observation.observedAtMs);
  const streamStateEmittedAt = Number(observation.streamStateEmittedAt);
  const stateAgeMs = observedAtMs - streamStateEmittedAt;
  if (
    !Number.isSafeInteger(observedAtMs) ||
    observedAtMs <= 0 ||
    !Number.isSafeInteger(streamStateEmittedAt) ||
    streamStateEmittedAt <= 0 ||
    stateAgeMs < -5_000 ||
    stateAgeMs > 60_000
  ) {
    throw new Error(
      "Hyperbet live-fight proof has stale or invalid authority time",
    );
  }

  const video = observation.video;
  const currentSource = String(video?.currentSource || "").trim();
  const declaredSource = String(video?.declaredSource || "").trim();
  if (
    !video ||
    video.paused !== false ||
    !Number.isInteger(video.readyState) ||
    video.readyState < 2 ||
    !Number.isFinite(video.currentTime) ||
    video.currentTime <= 0 ||
    !declaredSource.startsWith(expectedHlsUrl) ||
    !(
      currentSource.startsWith("blob:") ||
      currentSource.startsWith(expectedHlsUrl)
    )
  ) {
    throw new Error("Hyperbet live-fight proof has no advancing HLS player");
  }

  return Object.freeze({
    cycleId,
    duelId,
    duelKey,
    observedAtMs,
    streamStateEmittedAt,
    stateAgeMs,
    video: Object.freeze({
      currentSource,
      declaredSource,
      currentTime: video.currentTime,
      readyState: video.readyState,
      paused: video.paused,
    }),
  });
}

export function selectExactResolvedTerminalEvidence(
  status,
  terminal,
  expected = {},
) {
  if (
    status?.readiness?.ready !== true ||
    Number(terminal?.summary?.MANUAL_REVIEW || 0) !== 0 ||
    Number(terminal?.summary?.DEAD_LETTER || 0) !== 0
  ) {
    return null;
  }
  const operations = Array.isArray(terminal?.operations)
    ? terminal.operations
    : [];
  const markets = Array.isArray(status?.bot?.health?.markets)
    ? status.bot.health.markets
    : [];

  for (const operation of operations) {
    if (
      operation?.status !== "SUCCEEDED" ||
      operation?.lastError != null ||
      typeof operation?.duelId !== "string" ||
      !/^[0-9a-f]{64}$/.test(String(operation?.duelKey || "")) ||
      (operation?.winnerSide !== "A" && operation?.winnerSide !== "B")
    ) {
      continue;
    }
    const market = markets.find(
      (candidate) =>
        candidate?.duelId === operation.duelId &&
        candidate?.duelKey === operation.duelKey &&
        candidate?.lifecycleStatus === "RESOLVED" &&
        candidate?.winner === operation.winnerSide &&
        typeof candidate?.marketRef === "string" &&
        SOLANA_PUBLIC_KEY.test(candidate.marketRef) &&
        Number.isSafeInteger(candidate?.lastResolvedAtMs) &&
        candidate.lastResolvedAtMs > 0 &&
        Number.isSafeInteger(candidate?.lastRpcAtMs) &&
        candidate.lastRpcAtMs > 0 &&
        Array.isArray(candidate?.recovery) &&
        candidate.recovery.length === 0,
    );
    if (
      market &&
      (!expected.duelId || operation.duelId === expected.duelId) &&
      (!expected.duelKey || operation.duelKey === expected.duelKey) &&
      (!expected.marketRef || market.marketRef === expected.marketRef)
    ) {
      return Object.freeze({ operation, market });
    }
  }
  return null;
}

/**
 * Accept only a renderer snapshot for the exact active cycle where every
 * expected contestant contributes at least one fitted, attached item. This is
 * deliberately stricter than general renderer readiness: maintenance and an
 * unequipped inter-round scene may legitimately report ready with a 0/0 set,
 * but neither proves a broadcast duel loadout.
 */
export function getNonVacuousFightingEquipmentEvidence(
  status,
  { cycleId, expectedAgentCount },
) {
  if (
    typeof cycleId !== "string" ||
    cycleId.length === 0 ||
    !Number.isSafeInteger(expectedAgentCount) ||
    expectedAgentCount < 2
  ) {
    return null;
  }
  const renderer = status?.rendererHealth;
  const scene = renderer?.diagnostics?.sceneReadiness;
  if (
    renderer?.ready !== true ||
    renderer?.degradedReason != null ||
    renderer?.phase !== "FIGHTING" ||
    scene?.ready !== true ||
    scene?.phase !== "FIGHTING" ||
    scene?.cycleId !== cycleId ||
    scene?.equipmentVisualsReady !== true ||
    scene?.equipmentConfigured !== true ||
    scene?.equipmentCycleId !== cycleId ||
    scene?.expectedAgentCount !== expectedAgentCount ||
    scene?.equipmentExpectedPlayerCount !== expectedAgentCount ||
    scene?.equipmentRequiredPlayerCount !== expectedAgentCount ||
    scene?.equipmentActivePlayerCount !== expectedAgentCount ||
    scene?.equipmentActiveVisiblePlayerCount !== expectedAgentCount ||
    !Number.isSafeInteger(scene?.equipmentRequiredCount) ||
    scene.equipmentRequiredCount < expectedAgentCount ||
    !Number.isSafeInteger(scene?.equipmentActiveVisualCount) ||
    scene.equipmentActiveVisualCount < expectedAgentCount ||
    scene?.equipmentActiveVisibleCount !== scene.equipmentActiveVisualCount ||
    scene?.equipmentReadyCount !== scene.equipmentRequiredCount ||
    scene?.equipmentUnresolvedCount !== 0 ||
    scene?.equipmentAttachmentMismatchCount !== 0
  ) {
    return null;
  }
  return Object.freeze({
    cycleId,
    expectedAgentCount,
    requiredCount: scene.equipmentRequiredCount,
    requiredPlayerCount: scene.equipmentRequiredPlayerCount,
    readyCount: scene.equipmentReadyCount,
    activeVisualCount: scene.equipmentActiveVisualCount,
    activeVisibleCount: scene.equipmentActiveVisibleCount,
  });
}

/**
 * Require the isolated browser master mix to reach the encoder and remain
 * live. Pulse/system capture and generated silence are intentionally rejected:
 * neither proves that the game's own music and effects are in the broadcast.
 */
export function getHealthyBrowserAudioEvidence(status) {
  const stats = status?.stats;
  const browser = status?.browserAudioCaptureHealth;
  if (
    stats?.audioSource !== "browser" ||
    stats?.audioHealthy !== true ||
    !Number.isSafeInteger(stats?.audioChunks) ||
    stats.audioChunks <= 0 ||
    !Number.isFinite(stats?.audioLastChunkAt) ||
    stats.audioLastChunkAt <= 0 ||
    browser?.contextState !== "running" ||
    browser?.sourceContextState !== "running" ||
    browser?.trackState !== "live" ||
    browser?.channels !== 2 ||
    !Number.isFinite(browser?.sampleRate) ||
    browser.sampleRate <= 0 ||
    !Number.isSafeInteger(browser?.chunks) ||
    browser.chunks <= 0 ||
    !Number.isSafeInteger(browser?.bytes) ||
    browser.bytes <= 0 ||
    !Number.isSafeInteger(browser?.contentChunks) ||
    browser.contentChunks <= 0 ||
    !Number.isFinite(browser?.contentThreshold) ||
    browser.contentThreshold < 1e-6 ||
    !Number.isFinite(browser?.maxSamplePeak) ||
    browser.maxSamplePeak < browser.contentThreshold ||
    !Number.isFinite(browser?.lastContentChunkAt) ||
    browser.lastContentChunkAt <= 0 ||
    !Number.isFinite(status?.updatedAt) ||
    status.updatedAt < browser.lastContentChunkAt ||
    status.updatedAt - browser.lastContentChunkAt > 15_000 ||
    !Number.isFinite(browser?.lastChunkAt) ||
    browser.lastChunkAt <= 0
  ) {
    return null;
  }
  return Object.freeze({
    source: "browser",
    healthy: true,
    bridgeChunks: stats.audioChunks,
    bridgeLastChunkAt: stats.audioLastChunkAt,
    captureChunks: browser.chunks,
    captureBytes: browser.bytes,
    contentChunks: browser.contentChunks,
    contentThreshold: browser.contentThreshold,
    maxSamplePeak: browser.maxSamplePeak,
    lastContentChunkAt: browser.lastContentChunkAt,
    captureLastChunkAt: browser.lastChunkAt,
    sampleRate: browser.sampleRate,
    channels: browser.channels,
    droppedChunks: Number.isSafeInteger(stats?.audioDroppedChunks)
      ? stats.audioDroppedChunks
      : null,
    trimmedChunks: Number.isSafeInteger(stats?.audioTrimmedChunks)
      ? stats.audioTrimmedChunks
      : null,
  });
}

/** Require retained proof to contain the complete 720p-or-better A/V stream. */
export function getCompleteRetainedLiveMediaEvidence(
  mediaProbe,
  requestedDurationSeconds,
) {
  if (
    !Number.isSafeInteger(requestedDurationSeconds) ||
    requestedDurationSeconds < 1
  ) {
    return null;
  }
  const streams = Array.isArray(mediaProbe?.streams) ? mediaProbe.streams : [];
  const video = streams.find((stream) => stream?.codec_type === "video");
  const audio = streams.find((stream) => stream?.codec_type === "audio");
  const durationSeconds = Number(mediaProbe?.format?.duration);
  const sampleRate = Number(audio?.sample_rate);
  const channels = Number(audio?.channels);
  if (
    typeof video?.codec_name !== "string" ||
    video.codec_name.length === 0 ||
    Number(video.width) < 1280 ||
    Number(video.height) < 720 ||
    typeof audio?.codec_name !== "string" ||
    audio.codec_name.length === 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate < 32_000 ||
    channels !== 2 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds < requestedDurationSeconds - 2
  ) {
    return null;
  }
  return Object.freeze({
    durationSeconds,
    videoCodec: video.codec_name,
    width: Number(video.width),
    height: Number(video.height),
    averageFrameRate: String(video.avg_frame_rate || ""),
    audioCodec: audio.codec_name,
    sampleRate,
    channels,
  });
}

export function describeDuelSmokeLauncherShutdownFailure({
  exitCode,
  signalCode,
  forcedKill = false,
}) {
  if (forcedKill) return "Duel launcher shutdown required forced termination";
  if (exitCode !== 0 || signalCode !== null) {
    return `Duel launcher shutdown failed (exitCode=${exitCode ?? "pending"}, signal=${signalCode ?? "none"})`;
  }
  return null;
}

/** Keep the initiating failure first without discarding cleanup diagnostics. */
export function resolveDuelSmokeFailure({
  runError = null,
  launcherShutdownFailure = null,
  cleanupErrors = [],
  forbiddenRuntimeDiagnostics = [],
} = {}) {
  const failures = [];
  const retain = (phase, value) => {
    failures.push({
      phase,
      error: value instanceof Error ? value : new Error(String(value)),
    });
  };
  if (runError !== null && runError !== undefined) retain("run", runError);
  if (launcherShutdownFailure !== null && launcherShutdownFailure !== undefined)
    retain("launcher-shutdown", launcherShutdownFailure);
  for (const error of cleanupErrors) retain("cleanup", error);
  for (const diagnostic of forbiddenRuntimeDiagnostics) {
    retain(
      "runtime",
      new Error(
        `Duel smoke observed forbidden ${diagnostic.code} diagnostic on ${diagnostic.stream}: ${diagnostic.line}`,
      ),
    );
  }
  if (failures.length === 0) return null;
  return new AggregateError(
    failures.map(({ error }) => error),
    `Duel smoke failed:\n${failures
      .map(({ phase, error }) => `- [${phase}] ${error.message}`)
      .join("\n")}`,
  );
}
