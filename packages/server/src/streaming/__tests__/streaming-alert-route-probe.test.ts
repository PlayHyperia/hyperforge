import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  probeStreamingAlertRoute,
  writeStreamingAlertProbeEvidence,
  type StreamingAlertProbeFetch,
  type StreamingAlertProbeInput,
} from "../streaming-alert-route-probe.js";

const temporaryDirectories: string[] = [];
const releaseSha = "a".repeat(40);
const probeId = "12345678-1234-1234-1234-123456789abc";

function input(
  overrides: Partial<StreamingAlertProbeInput> = {},
): StreamingAlertProbeInput {
  return {
    approved: true,
    webhookUrl: "https://alerts.example/streaming?token=private",
    routeId: "staging.primary",
    environment: "staging",
    releaseSha,
    timeoutMs: 2_000,
    probeId: () => probeId,
    now: vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_125),
    fetchImpl: vi.fn(
      async (_url: string, _request: RequestInit) =>
        new Response(null, { status: 204 }),
    ),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("streaming alert route probe", () => {
  it("sends a bounded non-actionable test event and retains no webhook secret", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _request: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    const evidence = await probeStreamingAlertRoute(input({ fetchImpl }));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("token=private");
    expect(request).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(request.body))).toEqual({
      type: "STREAMING_RUNTIME_ALERT_TEST",
      status: "test",
      actionRequired: false,
      routeId: "staging.primary",
      environment: "staging",
      releaseSha,
      probeId,
      emittedAt: "1970-01-01T00:00:01.000Z",
    });
    expect(evidence).toMatchObject({
      deliveryScope: "webhook_http_acceptance_only",
      elapsedMs: 125,
      responseStatus: 204,
      webhookAccepted: true,
      onCallAcknowledgementRequired: true,
    });
    expect(JSON.stringify(evidence)).not.toContain("private");
    expect(JSON.stringify(evidence)).not.toContain("alerts.example");
  });

  it("fails before network access without exact approval", async () => {
    const fetchImpl = vi.fn<StreamingAlertProbeFetch>();
    await expect(
      probeStreamingAlertRoute(input({ approved: false, fetchImpl })),
    ).rejects.toThrow("explicit STREAMING_ALERT_TEST_APPROVED=true");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unsafe identity, destination, and timeout inputs", async () => {
    for (const overrides of [
      { webhookUrl: "http://alerts.example/streaming" },
      { webhookUrl: "https://name:secret@alerts.example/streaming" },
      { routeId: "Production Primary" },
      { environment: "development" },
      { releaseSha: "abc123" },
      { timeoutMs: 249 },
      { timeoutMs: 10_001 },
    ]) {
      await expect(
        probeStreamingAlertRoute(input(overrides)),
      ).rejects.toThrow();
    }
  });

  it("does not treat a non-success response as route acceptance", async () => {
    await expect(
      probeStreamingAlertRoute(
        input({
          fetchImpl: vi.fn(
            async (_url: string, _request: RequestInit) =>
              new Response("not accepted", { status: 503 }),
          ),
        }),
      ),
    ).rejects.toThrow("HTTP 503");
  });

  it("writes private immutable evidence and refuses to replace it", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "hyperia-alert-probe-"),
    );
    temporaryDirectories.push(directory);
    const output = path.join(directory, "evidence.json");
    const evidence = await probeStreamingAlertRoute(input());

    await expect(
      writeStreamingAlertProbeEvidence(output, evidence),
    ).resolves.toBe(output);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(evidence);
    await expect(
      writeStreamingAlertProbeEvidence(output, evidence),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });
});
