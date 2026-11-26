import { randomUUID } from "node:crypto";
import { link, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

export type StreamingAlertProbeEnvironment = "staging" | "production";

export type StreamingAlertProbeEvidence = {
  schemaVersion: 1;
  type: "STREAMING_RUNTIME_ALERT_TEST";
  deliveryScope: "webhook_http_acceptance_only";
  routeId: string;
  environment: StreamingAlertProbeEnvironment;
  releaseSha: string;
  probeId: string;
  emittedAt: string;
  acceptedAt: string;
  elapsedMs: number;
  responseStatus: number;
  webhookAccepted: true;
  onCallAcknowledgementRequired: true;
};

export type StreamingAlertProbeFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export type StreamingAlertProbeInput = {
  approved: boolean;
  webhookUrl: string;
  routeId: string;
  environment: string;
  releaseSha: string;
  timeoutMs: number;
  fetchImpl?: StreamingAlertProbeFetch;
  now?: () => number;
  probeId?: () => string;
};

function requireProbeWebhook(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The alert probe webhook must be an absolute URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("The alert probe webhook must use https:");
  }
  if (url.username || url.password) {
    throw new Error("The alert probe webhook must not contain URL credentials");
  }
  return url.href;
}

function requireRouteId(value: string): string {
  const routeId = value.trim();
  if (!/^[a-z0-9][a-z0-9._:-]{2,63}$/u.test(routeId)) {
    throw new Error("The alert probe route ID is invalid");
  }
  return routeId;
}

function requireEnvironment(value: string): StreamingAlertProbeEnvironment {
  const environment = value.trim();
  if (environment !== "staging" && environment !== "production") {
    throw new Error(
      "The alert probe environment must be staging or production",
    );
  }
  return environment;
}

function requireReleaseSha(value: string): string {
  const releaseSha = value.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(releaseSha)) {
    throw new Error(
      "The alert probe release SHA must be 40 or 64 lowercase hex characters",
    );
  }
  return releaseSha;
}

function requireTimeoutMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 250 || value > 10_000) {
    throw new Error(
      "The alert probe timeout must be an integer from 250 to 10000 ms",
    );
  }
  return value;
}

export async function probeStreamingAlertRoute(
  input: StreamingAlertProbeInput,
): Promise<StreamingAlertProbeEvidence> {
  if (!input.approved) {
    throw new Error(
      "Alert-route probing requires explicit STREAMING_ALERT_TEST_APPROVED=true authorization",
    );
  }

  const webhookUrl = requireProbeWebhook(input.webhookUrl);
  const routeId = requireRouteId(input.routeId);
  const environment = requireEnvironment(input.environment);
  const releaseSha = requireReleaseSha(input.releaseSha);
  const timeoutMs = requireTimeoutMs(input.timeoutMs);
  const now = input.now ?? Date.now;
  const probeId = (input.probeId ?? randomUUID)();
  if (!/^[a-f0-9-]{16,64}$/u.test(probeId)) {
    throw new Error("The alert probe ID is invalid");
  }

  const emittedAtMs = now();
  const emittedAt = new Date(emittedAtMs).toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    const fetchImpl: StreamingAlertProbeFetch =
      input.fetchImpl ?? ((url, init) => fetch(url, init));
    response = await fetchImpl(webhookUrl, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "STREAMING_RUNTIME_ALERT_TEST",
        status: "test",
        actionRequired: false,
        routeId,
        environment,
        releaseSha,
        probeId,
        emittedAt,
      }),
      signal: controller.signal,
    });
  } catch {
    throw new Error("The alert-route probe did not receive HTTP acceptance");
  } finally {
    clearTimeout(timeout);
  }

  await response.body?.cancel().catch(() => {});
  if (!response.ok) {
    throw new Error(
      `The alert-route webhook rejected the test event with HTTP ${response.status}`,
    );
  }

  const acceptedAtMs = now();
  return {
    schemaVersion: 1,
    type: "STREAMING_RUNTIME_ALERT_TEST",
    deliveryScope: "webhook_http_acceptance_only",
    routeId,
    environment,
    releaseSha,
    probeId,
    emittedAt,
    acceptedAt: new Date(acceptedAtMs).toISOString(),
    elapsedMs: Math.max(0, Math.round(acceptedAtMs - emittedAtMs)),
    responseStatus: response.status,
    webhookAccepted: true,
    onCallAcknowledgementRequired: true,
  };
}

export async function writeStreamingAlertProbeEvidence(
  outputPath: string,
  evidence: StreamingAlertProbeEvidence,
): Promise<string> {
  const resolvedOutputPath = path.resolve(outputPath);
  const parent = path.dirname(resolvedOutputPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    parent,
    `.${path.basename(resolvedOutputPath)}.${randomUUID()}.tmp`,
  );
  let temporaryCreated = false;

  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, resolvedOutputPath);
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => {});
    }
  }

  return resolvedOutputPath;
}
