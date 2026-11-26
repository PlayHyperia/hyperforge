import crypto from "node:crypto";

const FETCH_TIMEOUT_MS = 15_000;
const HYPERIA_AUTH_MESSAGE_TYPE = "HYPERIA_AUTH";
const PLACEHOLDER_RE =
  /^\[?\s*(REDACTED|PLACEHOLDER|TODO|CHANGEME|EMPTY)\s*]?$/i;
const MANAGED_SOLANA_ADDRESS_ENV_KEY = "ELIZA_MANAGED_SOLANA_ADDRESS";

export interface HyperiaBridgeRuntimeLike {
  agentId?: string;
  character?: {
    name?: string;
    walletAddress?: unknown;
    walletAddresses?: Record<string, unknown>;
    settings?: {
      solanaAddress?: unknown;
      secrets?: Record<string, unknown>;
    };
    secrets?: Record<string, unknown>;
  } | null;
  getAgent?: (agentId: string) => Promise<unknown>;
  getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
  getSetting?: (key: string) => unknown;
  hasService?: (serviceType: string) => boolean;
  setSetting?: (key: string, value: string, secret?: boolean) => void;
}

export interface HyperiaLaunchDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface HyperiaViewerAuthMessage {
  type: "HYPERIA_AUTH";
  authToken: string;
  agentId?: string;
  characterId?: string;
  followEntity?: string;
}

interface HyperiaWalletCandidate {
  address: string;
}

interface HyperiaWalletChallengeResponse {
  challengeId?: string;
  expiresAt?: string;
  message?: string;
  signatureEncoding?: string;
  success?: boolean;
  error?: string;
}

interface HyperiaWalletVerifyResponse {
  success?: boolean;
  authToken?: string;
  characterId?: string;
  accountId?: string;
  error?: string;
}

interface WalletAddresses {
  solanaAddress: string | null;
}

function readRuntimeSetting(
  runtime: HyperiaBridgeRuntimeLike | null | undefined,
  key: string,
): string | null {
  const runtimeValue = runtime?.getSetting?.(key);
  if (typeof runtimeValue === "string" && runtimeValue.trim().length > 0) {
    return runtimeValue.trim();
  }
  const envValue = process.env[key];
  return typeof envValue === "string" && envValue.trim().length > 0
    ? envValue.trim()
    : null;
}

function isLikelySolanaAddress(
  value: string | null | undefined,
): value is string {
  return (
    typeof value === "string" &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim())
  );
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function base58Encode(data: Buffer | Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = BigInt(`0x${Buffer.from(data).toString("hex")}`);
  const chars: string[] = [];
  while (num > 0n) {
    chars.unshift(alphabet[Number(num % 58n)]);
    num /= 58n;
  }
  for (const byte of data) {
    if (byte === 0) {
      chars.unshift("1");
      continue;
    }
    break;
  }
  return chars.join("") || "1";
}

function base58Decode(value: string): Buffer {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (value.length === 0) {
    return Buffer.alloc(0);
  }
  let num = 0n;
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index === -1) {
      throw new Error(`Invalid base58 character: ${character}`);
    }
    num = num * 58n + BigInt(index);
  }
  const hex = num.toString(16).padStart(2, "0");
  const bytes = Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, "hex");
  let zeroCount = 0;
  for (const character of value) {
    if (character === "1") {
      zeroCount += 1;
      continue;
    }
    break;
  }
  return zeroCount > 0
    ? Buffer.concat([Buffer.alloc(zeroCount), bytes])
    : bytes;
}

function decodeSolanaPrivateKey(key: string): Buffer {
  if (PLACEHOLDER_RE.test(key)) {
    throw new Error("placeholder value");
  }
  if (key.startsWith("[") && key.endsWith("]") && /^\[\s*\d/.test(key)) {
    const parsed = JSON.parse(key) as unknown;
    if (
      !Array.isArray(parsed) ||
      !parsed.every((value) => typeof value === "number")
    ) {
      throw new Error("Invalid Solana key array");
    }
    return Buffer.from(parsed);
  }
  return base58Decode(key);
}

function deriveSolanaAddress(privateKeyString: string): string {
  const secretBytes = decodeSolanaPrivateKey(privateKeyString);
  if (secretBytes.length === 64) {
    return base58Encode(secretBytes.subarray(32));
  }
  if (secretBytes.length === 32) {
    const keyObject = crypto.createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        secretBytes,
      ]),
      format: "der",
      type: "pkcs8",
    });
    const publicKeyDer = crypto
      .createPublicKey(keyObject)
      .export({ type: "spki", format: "der" }) as Buffer;
    return base58Encode(publicKeyDer.subarray(12, 44));
  }
  throw new Error(`Invalid Solana secret key length: ${secretBytes.length}`);
}

function generateSolanaWalletKeys(): {
  solanaAddress: string;
  solanaPrivateKey: string;
} {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const privateKeyDer = privateKey.export({ type: "pkcs8", format: "der" });
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const seed = (privateKeyDer as Buffer).subarray(16, 48);
  const publicKeyRaw = (publicKeyDer as Buffer).subarray(12, 44);
  const solanaPrivateKey = base58Encode(Buffer.concat([seed, publicKeyRaw]));
  const solanaAddress = base58Encode(publicKeyRaw);

  return {
    solanaAddress,
    solanaPrivateKey,
  };
}

function signSolanaMessage(privateKeyString: string, message: string): string {
  const secretBytes = decodeSolanaPrivateKey(privateKeyString);
  if (secretBytes.length !== 32 && secretBytes.length !== 64) {
    throw new Error(`Invalid Solana secret key length: ${secretBytes.length}`);
  }
  const seed = secretBytes.subarray(0, 32);
  const keyObject = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
  return base58Encode(
    crypto.sign(null, Buffer.from(message, "utf8"), keyObject),
  );
}

function extractWalletCandidateFromRecord(
  record: unknown,
): HyperiaWalletCandidate | null {
  const objectRecord = readObject(record);
  if (!objectRecord) {
    return null;
  }

  const directWalletAddresses = readObject(objectRecord.walletAddresses);
  const characterRecord = readObject(objectRecord.character);
  const characterSettings = readObject(characterRecord?.settings);
  const characterWalletAddresses = readObject(characterRecord?.walletAddresses);
  const characterSecrets = readObject(characterSettings?.secrets);

  const solanaCandidates = [
    directWalletAddresses?.solana,
    objectRecord.walletAddress,
    characterWalletAddresses?.solana,
    characterRecord?.walletAddress,
    characterSettings?.solanaAddress,
    characterSecrets?.SOLANA_PUBLIC_KEY,
  ];
  for (const candidate of solanaCandidates) {
    if (typeof candidate === "string" && isLikelySolanaAddress(candidate)) {
      return {
        address: candidate.trim(),
      };
    }
  }

  return null;
}

async function resolveRuntimeWalletCandidate(
  runtime: HyperiaBridgeRuntimeLike | null,
): Promise<HyperiaWalletCandidate | null> {
  if (!runtime) {
    return null;
  }

  if (
    typeof runtime.getAgent === "function" &&
    typeof runtime.agentId === "string" &&
    runtime.agentId.trim().length > 0
  ) {
    const agentRecord = await runtime.getAgent(runtime.agentId);
    const candidate = extractWalletCandidateFromRecord(agentRecord);
    if (candidate) {
      return candidate;
    }
  }

  const characterCandidate = extractWalletCandidateFromRecord({
    character: runtime.character ?? null,
  });
  if (characterCandidate) {
    return {
      ...characterCandidate,
    };
  }

  const managedSolanaAddress = readRuntimeSetting(
    runtime,
    MANAGED_SOLANA_ADDRESS_ENV_KEY,
  );
  if (isLikelySolanaAddress(managedSolanaAddress)) {
    return {
      address: managedSolanaAddress.trim(),
    };
  }

  return null;
}

function readWalletAddressesFromEnv(): WalletAddresses {
  let solanaAddress: string | null = null;

  const solanaPrivateKey = process.env.SOLANA_PRIVATE_KEY;
  if (solanaPrivateKey && !PLACEHOLDER_RE.test(solanaPrivateKey)) {
    try {
      solanaAddress = deriveSolanaAddress(solanaPrivateKey);
    } catch {
      solanaAddress = null;
    }
  }

  if (!solanaAddress) {
    const managedSolanaAddress = process.env[MANAGED_SOLANA_ADDRESS_ENV_KEY];
    if (managedSolanaAddress) {
      const trimmed = managedSolanaAddress.trim();
      try {
        if (base58Decode(trimmed).length === 32) {
          solanaAddress = trimmed;
        }
      } catch {
        solanaAddress = null;
      }
    }
  }

  return { solanaAddress };
}

async function getWalletAddressesWithSteward(): Promise<
  WalletAddresses & {
    stewardSolanaAddress?: string | null;
  }
> {
  const base = readWalletAddressesFromEnv();
  const stewardApiUrl = process.env.STEWARD_API_URL?.trim();
  if (!stewardApiUrl) {
    return base;
  }

  const agentId =
    process.env.STEWARD_AGENT_ID?.trim() ||
    process.env.MILADY_STEWARD_AGENT_ID?.trim() ||
    process.env.ELIZA_STEWARD_AGENT_ID?.trim() ||
    base.solanaAddress?.trim() ||
    null;
  if (!agentId) {
    return base;
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const stewardBearerToken = process.env.STEWARD_AGENT_TOKEN?.trim();
  const stewardApiKey = process.env.STEWARD_API_KEY?.trim();
  const stewardTenantId = process.env.STEWARD_TENANT_ID?.trim();
  if (stewardBearerToken) {
    headers.Authorization = `Bearer ${stewardBearerToken}`;
  } else if (stewardApiKey) {
    headers["X-Steward-Key"] = stewardApiKey;
  }
  if (stewardTenantId) {
    headers["X-Steward-Tenant"] = stewardTenantId;
  }

  try {
    const response = await fetch(
      `${stewardApiUrl.replace(/\/+$/, "")}/agents/${encodeURIComponent(agentId)}`,
      {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      return base;
    }

    const payload = (await response.json()) as {
      ok?: boolean;
      data?: {
        walletAddress?: string;
        walletAddresses?: { solana?: string };
      };
    };
    const agent = payload.data ?? (payload as unknown as typeof payload.data);
    const stewardSolana =
      agent?.walletAddresses?.solana?.trim() ||
      (isLikelySolanaAddress(agent?.walletAddress)
        ? agent?.walletAddress?.trim()
        : null);

    return {
      solanaAddress: base.solanaAddress ?? stewardSolana,
      stewardSolanaAddress: stewardSolana,
    };
  } catch {
    return base;
  }
}

async function resolveHyperiaWalletCandidate(
  runtime: HyperiaBridgeRuntimeLike | null,
): Promise<HyperiaWalletCandidate | null> {
  const runtimeWallet = await resolveRuntimeWalletCandidate(runtime);
  if (runtimeWallet) {
    return runtimeWallet;
  }

  const walletAddresses = await getWalletAddressesWithSteward();
  if (isLikelySolanaAddress(walletAddresses.solanaAddress)) {
    return {
      address: walletAddresses.solanaAddress.trim(),
    };
  }

  return null;
}

function persistRuntimeSecret(
  runtime: HyperiaBridgeRuntimeLike | null,
  key: string,
  value: string,
): void {
  process.env[key] = value;
  runtime?.setSetting?.(key, value, true);
  const character = runtime?.character;
  if (!character) {
    return;
  }

  if (!character.settings) {
    character.settings = {};
  }
  if (!character.settings.secrets) {
    character.settings.secrets = {};
  }
  character.settings.secrets[key] = value;
  if (!character.secrets) {
    character.secrets = {};
  }
  character.secrets[key] = value;
}

function provisionRuntimeWalletCandidate(
  runtime: HyperiaBridgeRuntimeLike,
): HyperiaWalletCandidate {
  const walletKeys = generateSolanaWalletKeys();
  persistRuntimeSecret(
    runtime,
    "SOLANA_PRIVATE_KEY",
    walletKeys.solanaPrivateKey,
  );

  return {
    address: walletKeys.solanaAddress,
  };
}

function persistHyperiaCredential(
  runtime: HyperiaBridgeRuntimeLike | null,
  key: "HYPERIA_AUTH_TOKEN" | "HYPERIA_CHARACTER_ID" | "HYPERIA_ACCOUNT_ID",
  value: string,
  secret = false,
): void {
  process.env[key] = value;
  runtime?.setSetting?.(key, value, secret);
  const character = runtime?.character;
  if (!character) {
    return;
  }

  if (!character.settings) {
    character.settings = {};
  }
  if (!character.settings.secrets) {
    character.settings.secrets = {};
  }
  character.settings.secrets[key] = value;
  if (!character.secrets) {
    character.secrets = {};
  }
  character.secrets[key] = value;
}

function resolveHyperiaApiBaseUrl(
  runtime: HyperiaBridgeRuntimeLike | null,
): string {
  const runtimeUrl = readRuntimeSetting(runtime, "HYPERIA_API_URL");
  if (runtimeUrl) {
    return runtimeUrl.replace(/\/+$/, "");
  }
  return process.env.NODE_ENV === "production"
    ? "https://hyperia.gg"
    : "http://localhost:5555";
}

function resolveMatchingSolanaPrivateKey(
  runtime: HyperiaBridgeRuntimeLike,
  walletAddress: string,
): string {
  const candidates = [
    readRuntimeSetting(runtime, "SOLANA_PRIVATE_KEY"),
    runtime.character?.settings?.secrets?.SOLANA_PRIVATE_KEY,
    runtime.character?.secrets?.SOLANA_PRIVATE_KEY,
  ];
  for (const candidate of candidates) {
    if (
      typeof candidate !== "string" ||
      candidate.trim().length === 0 ||
      PLACEHOLDER_RE.test(candidate)
    ) {
      continue;
    }
    try {
      if (deriveSolanaAddress(candidate.trim()) === walletAddress) {
        return candidate.trim();
      }
    } catch {
      // Try the next explicitly configured key source.
    }
  }
  throw new Error(
    "SOL wallet authentication requires a signing key that exactly matches the configured agent wallet.",
  );
}

async function readWalletAuthJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    let detail = "";
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") detail = parsed.error.trim();
    } catch {
      // Keep untrusted non-JSON response content out of agent diagnostics.
    }
    throw new Error(
      detail
        ? `Hyperia SOL wallet authentication failed (${response.status}): ${detail}`
        : `Hyperia SOL wallet authentication failed with status ${response.status}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Hyperia SOL wallet authentication returned invalid JSON.");
  }
}

async function hasActiveAgentCredentialSession(
  runtime: HyperiaBridgeRuntimeLike,
  authToken: string,
): Promise<boolean> {
  const response = await fetch(
    new URL(
      "/api/agents/credentials/status",
      resolveHyperiaApiBaseUrl(runtime),
    ),
    {
      method: "GET",
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  if (response.status === 401 || response.status === 403) {
    return false;
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Hyperia agent credential validation failed with status ${response.status}.`,
    );
  }
  try {
    const payload = JSON.parse(text) as { active?: unknown; success?: unknown };
    if (payload.success !== true || payload.active !== true) {
      throw new Error("invalid status payload");
    }
  } catch {
    throw new Error(
      "Hyperia agent credential validation returned invalid JSON.",
    );
  }
  return true;
}

async function authenticateHyperiaWallet(
  runtime: HyperiaBridgeRuntimeLike,
  wallet: HyperiaWalletCandidate,
): Promise<{
  authToken: string;
  characterId: string;
  accountId?: string;
}> {
  const privateKey = resolveMatchingSolanaPrivateKey(runtime, wallet.address);
  const apiBaseUrl = resolveHyperiaApiBaseUrl(runtime);
  const challengeResponse = await fetch(
    new URL("/api/agents/sol-wallet-auth/challenge", apiBaseUrl),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        walletAddress: wallet.address,
        agentName: runtime.character?.name || "Agent",
        characterId:
          readRuntimeSetting(runtime, "HYPERIA_CHARACTER_ID") ?? undefined,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  const challenge =
    await readWalletAuthJson<HyperiaWalletChallengeResponse>(challengeResponse);
  if (
    !challenge.success ||
    typeof challenge.challengeId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      challenge.challengeId,
    ) ||
    typeof challenge.message !== "string" ||
    challenge.message.length < 1 ||
    challenge.message.length > 4096 ||
    challenge.signatureEncoding !== "base58" ||
    typeof challenge.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(challenge.expiresAt)) ||
    Date.parse(challenge.expiresAt) <= Date.now()
  ) {
    throw new Error("Hyperia SOL wallet challenge response is invalid.");
  }

  const signature = signSolanaMessage(privateKey, challenge.message);
  const verifyResponse = await fetch(
    new URL("/api/agents/sol-wallet-auth/verify", apiBaseUrl),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        message: challenge.message,
        signature,
        walletAddress: wallet.address,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  const data =
    await readWalletAuthJson<HyperiaWalletVerifyResponse>(verifyResponse);
  if (
    !data.success ||
    !data.authToken ||
    !data.characterId ||
    !data.accountId
  ) {
    throw new Error("Hyperia SOL wallet verification response is invalid.");
  }

  if (runtime.agentId) {
    const mappingResponse = await fetch(
      new URL("/api/agents/mappings", apiBaseUrl),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${data.authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          accountId: data.accountId,
          agentId: runtime.agentId,
          agentName: runtime.character?.name || "Agent",
          characterId: data.characterId,
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    await readWalletAuthJson<{ success?: boolean }>(mappingResponse).then(
      (mapping) => {
        if (!mapping.success) {
          throw new Error("Hyperia agent mapping response is invalid.");
        }
      },
    );
  }

  return {
    authToken: data.authToken,
    characterId: data.characterId,
    ...(data.accountId ? { accountId: data.accountId } : {}),
  };
}

export async function prepareHyperiaAppLaunch(
  runtime: HyperiaBridgeRuntimeLike | null,
): Promise<HyperiaLaunchDiagnostic[]> {
  if (!runtime) {
    return [];
  }

  const authToken = readRuntimeSetting(runtime, "HYPERIA_AUTH_TOKEN");
  const characterId = readRuntimeSetting(runtime, "HYPERIA_CHARACTER_ID");

  try {
    if (
      authToken &&
      characterId &&
      (await hasActiveAgentCredentialSession(runtime, authToken))
    ) {
      return [];
    }
    let wallet = await resolveHyperiaWalletCandidate(runtime);
    if (!wallet) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "Production SOL wallet authentication requires an explicitly provisioned agent signing key.",
        );
      }
      wallet = provisionRuntimeWalletCandidate(runtime);
    }
    const authResult = await authenticateHyperiaWallet(runtime, wallet);
    persistHyperiaCredential(
      runtime,
      "HYPERIA_AUTH_TOKEN",
      authResult.authToken,
      true,
    );
    persistHyperiaCredential(
      runtime,
      "HYPERIA_CHARACTER_ID",
      authResult.characterId,
    );
    if (authResult.accountId) {
      persistHyperiaCredential(
        runtime,
        "HYPERIA_ACCOUNT_ID",
        authResult.accountId,
      );
    }
    return [];
  } catch (error) {
    return [
      {
        code: "hyperia-auth-provisioning-failed",
        severity: "warning",
        message:
          error instanceof Error
            ? error.message
            : "Hyperia wallet auth failed.",
      },
    ];
  }
}

export function resolveHyperiaViewerAuthMessage(
  runtime: HyperiaBridgeRuntimeLike | null,
): HyperiaViewerAuthMessage | null {
  const authToken = readRuntimeSetting(runtime, "HYPERIA_AUTH_TOKEN");
  if (!authToken) {
    return null;
  }

  const characterId = readRuntimeSetting(runtime, "HYPERIA_CHARACTER_ID");
  const agentId =
    typeof runtime?.agentId === "string" && runtime.agentId.trim().length > 0
      ? runtime.agentId
      : undefined;

  return {
    type: HYPERIA_AUTH_MESSAGE_TYPE,
    authToken,
    ...(agentId ? { agentId } : {}),
    ...(characterId ? { characterId, followEntity: characterId } : {}),
  };
}

export function isHyperiaRuntimeReady(
  runtime: HyperiaBridgeRuntimeLike | null,
): boolean {
  return Boolean(
    runtime &&
    typeof runtime.hasService === "function" &&
    runtime.hasService("hyperiaService"),
  );
}

export async function ensureHyperiaRuntimeReady(
  runtime: HyperiaBridgeRuntimeLike | null,
): Promise<void> {
  if (!runtime) {
    return;
  }
  if (!isHyperiaRuntimeReady(runtime)) {
    throw new Error("Hyperia service was not registered on the agent runtime.");
  }
  if (typeof runtime.getServiceLoadPromise === "function") {
    await runtime.getServiceLoadPromise("hyperiaService");
  }
}

export function collectHyperiaLaunchDiagnostics(params: {
  requestedViewerAuth: boolean;
  runtime: HyperiaBridgeRuntimeLike | null;
  sessionFound: boolean;
  viewerAuthMessage: HyperiaViewerAuthMessage | null;
}): HyperiaLaunchDiagnostic[] {
  const diagnostics: HyperiaLaunchDiagnostic[] = [];
  const authToken = readRuntimeSetting(params.runtime, "HYPERIA_AUTH_TOKEN");
  const characterId = readRuntimeSetting(
    params.runtime,
    "HYPERIA_CHARACTER_ID",
  );

  if (params.requestedViewerAuth && !params.viewerAuthMessage) {
    const missing: string[] = [];
    if (!authToken) {
      missing.push("HYPERIA_AUTH_TOKEN");
    }
    if (!characterId) {
      missing.push("HYPERIA_CHARACTER_ID");
    }
    diagnostics.push({
      code: "hyperia-auth-unavailable",
      severity: "error",
      message:
        missing.length > 0
          ? `Hyperia auto-sign-in is unavailable because ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not configured for this agent.`
          : "Hyperia auto-sign-in is unavailable for this agent.",
    });
  }

  if (
    params.runtime &&
    !params.sessionFound &&
    !isHyperiaRuntimeReady(params.runtime)
  ) {
    diagnostics.push({
      code: "hyperia-runtime-bridge-inactive",
      severity: "warning",
      message:
        "The Hyperia runtime bridge is not active in this agent, so the host cannot attach to a live in-world session yet.",
    });
  }

  if (params.runtime && !params.sessionFound && characterId) {
    diagnostics.push({
      code: "hyperia-session-not-found",
      severity: "warning",
      message:
        "No live Hyperia session matched this agent. Start or reconnect the Hyperia agent in-world, then launch again.",
    });
  }

  return diagnostics;
}
