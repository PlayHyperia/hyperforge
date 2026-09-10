import { describe, expect, it } from "vitest";

import { resolveStreamingRuntimeAlertConfig } from "../../../src/routes/streaming-runtime-alert-config.js";

const productionAuthority = {
  NODE_ENV: "production",
  STREAMING_DUEL_SCHEDULER_ROLE: "authority",
  HYPERIA_EXTERNAL_VALUE_ENABLED: "true",
  STREAMING_ALERT_WEBHOOK_URL: "https://alerts.example/streaming?route=private",
  STREAMING_ALERT_ROUTE_ID: "production.primary",
  STREAMING_HEALTH_MONITOR_INTERVAL_MS: "5000",
  STREAMING_ALERT_REMINDER_MS: "300000",
  STREAMING_ALERT_RETRY_MS: "10000",
  STREAMING_ALERT_TIMEOUT_MS: "2000",
} as const;

describe("streaming runtime alert configuration", () => {
  it("requires a complete explicit HTTPS route on the production authority", () => {
    expect(resolveStreamingRuntimeAlertConfig(productionAuthority)).toEqual({
      enabled: true,
      webhookUrl: "https://alerts.example/streaming?route=private",
      routeId: "production.primary",
      monitorIntervalMs: 5_000,
      reminderMs: 300_000,
      retryMs: 10_000,
      timeoutMs: 2_000,
    });

    for (const missing of [
      "STREAMING_ALERT_WEBHOOK_URL",
      "STREAMING_ALERT_ROUTE_ID",
      "STREAMING_HEALTH_MONITOR_INTERVAL_MS",
      "STREAMING_ALERT_REMINDER_MS",
      "STREAMING_ALERT_RETRY_MS",
      "STREAMING_ALERT_TIMEOUT_MS",
    ]) {
      expect(() =>
        resolveStreamingRuntimeAlertConfig({
          ...productionAuthority,
          [missing]: undefined,
        }),
      ).toThrow(/required|routing characters/u);
    }
  });

  it("prevents production replicas from holding or sending the streaming route", () => {
    expect(() =>
      resolveStreamingRuntimeAlertConfig({
        ...productionAuthority,
        STREAMING_DUEL_SCHEDULER_ROLE: "replica",
      }),
    ).toThrow("must be absent outside the streaming authority role");
    expect(
      resolveStreamingRuntimeAlertConfig({
        NODE_ENV: "production",
        STREAMING_DUEL_SCHEDULER_ROLE: "replica",
        ALERT_WEBHOOK_URL: "https://alerts.example/general",
      }),
    ).toMatchObject({ enabled: false, webhookUrl: null });
  });

  it("rejects unsafe webhook URLs and malformed threshold values", () => {
    for (const webhook of [
      "http://alerts.example/streaming",
      "https://name:secret@alerts.example/streaming",
      "not-a-url",
    ]) {
      expect(() =>
        resolveStreamingRuntimeAlertConfig({
          ...productionAuthority,
          STREAMING_ALERT_WEBHOOK_URL: webhook,
        }),
      ).toThrow();
    }
    for (const [key, value] of [
      ["STREAMING_HEALTH_MONITOR_INTERVAL_MS", "NaN"],
      ["STREAMING_ALERT_REMINDER_MS", "9999"],
      ["STREAMING_ALERT_RETRY_MS", "60001"],
      ["STREAMING_ALERT_TIMEOUT_MS", "10001"],
    ]) {
      expect(() =>
        resolveStreamingRuntimeAlertConfig({
          ...productionAuthority,
          [key]: value,
        }),
      ).toThrow();
    }
  });

  it("enforces coherent timeout, monitor, retry, and reminder ordering", () => {
    expect(() =>
      resolveStreamingRuntimeAlertConfig({
        ...productionAuthority,
        STREAMING_HEALTH_MONITOR_INTERVAL_MS: "1000",
        STREAMING_ALERT_TIMEOUT_MS: "2000",
      }),
    ).toThrow("must not exceed the monitor interval");
    expect(() =>
      resolveStreamingRuntimeAlertConfig({
        ...productionAuthority,
        STREAMING_ALERT_REMINDER_MS: "10000",
        STREAMING_ALERT_RETRY_MS: "11000",
      }),
    ).toThrow("must not exceed the reminder interval");
  });

  it("retains bounded local defaults without enabling an absent route", () => {
    expect(resolveStreamingRuntimeAlertConfig({ NODE_ENV: "test" })).toEqual({
      enabled: false,
      webhookUrl: null,
      routeId: "local",
      monitorIntervalMs: 5_000,
      reminderMs: 300_000,
      retryMs: 10_000,
      timeoutMs: 2_000,
    });
  });

  it("allows a no-money production authority to run without an alert route", () => {
    expect(
      resolveStreamingRuntimeAlertConfig({
        NODE_ENV: "production",
        STREAMING_DUEL_SCHEDULER_ROLE: "authority",
        HYPERIA_EXTERNAL_VALUE_ENABLED: "false",
      }),
    ).toEqual({
      enabled: false,
      webhookUrl: null,
      routeId: "local",
      monitorIntervalMs: 5_000,
      reminderMs: 300_000,
      retryMs: 10_000,
      timeoutMs: 2_000,
    });
  });

  it("never enables a configured streaming route on a replica", () => {
    expect(() =>
      resolveStreamingRuntimeAlertConfig({
        NODE_ENV: "development",
        STREAMING_DUEL_SCHEDULER_ROLE: "replica",
        STREAMING_ALERT_WEBHOOK_URL: "https://alerts.example/streaming",
      }),
    ).toThrow("must be absent outside the streaming authority role");
    expect(
      resolveStreamingRuntimeAlertConfig({
        NODE_ENV: "development",
        STREAMING_DUEL_SCHEDULER_ROLE: "replica",
        ALERT_WEBHOOK_URL: "https://alerts.example/general",
      }),
    ).toMatchObject({ enabled: false, webhookUrl: null });
  });
});
