export type StreamingRuntimeAlertConfig = {
  enabled: boolean;
  webhookUrl: string | null;
  routeId: string;
  monitorIntervalMs: number;
  reminderMs: number;
  retryMs: number;
  timeoutMs: number;
};

type AlertEnvironment = Record<string, string | undefined>;

function parseBoundedInteger(input: {
  env: AlertEnvironment;
  key: string;
  fallback: number;
  minimum: number;
  maximum: number;
  required: boolean;
}): number {
  const raw = input.env[input.key]?.trim();
  if (!raw) {
    if (input.required) {
      throw new Error(`${input.key} is required for a production authority`);
    }
    return input.fallback;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${input.key} must be a base-10 integer`);
  }
  const value = Number.parseInt(raw, 10);
  if (
    !Number.isSafeInteger(value) ||
    value < input.minimum ||
    value > input.maximum
  ) {
    throw new Error(
      `${input.key} must be between ${input.minimum} and ${input.maximum}`,
    );
  }
  return value;
}

function validateWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("STREAMING_ALERT_WEBHOOK_URL must be an absolute URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("STREAMING_ALERT_WEBHOOK_URL must use https:");
  }
  if (url.username || url.password) {
    throw new Error(
      "STREAMING_ALERT_WEBHOOK_URL must not contain URL credentials",
    );
  }
  return url.href;
}

function validateRouteId(value: string | undefined, required: boolean): string {
  const routeId = value?.trim() || (required ? "" : "local");
  if (!/^[a-z0-9][a-z0-9._:-]{2,63}$/u.test(routeId)) {
    throw new Error(
      "STREAMING_ALERT_ROUTE_ID must be 3-64 lowercase routing characters",
    );
  }
  return routeId;
}

export function resolveStreamingRuntimeAlertConfig(
  env: AlertEnvironment,
): StreamingRuntimeAlertConfig {
  const production = env.NODE_ENV?.trim() === "production";
  const schedulerRole = env.STREAMING_DUEL_SCHEDULER_ROLE?.trim() || "";
  const authority = schedulerRole === "authority";
  const productionAuthority = production && authority;
  const externalValueEnabled =
    env.HYPERIA_EXTERNAL_VALUE_ENABLED?.trim() === "true";
  const configuredStreamingWebhook =
    env.STREAMING_ALERT_WEBHOOK_URL?.trim() || "";
  const routeRequired = productionAuthority && externalValueEnabled;
  const strictProductionRoute =
    productionAuthority &&
    (routeRequired || Boolean(configuredStreamingWebhook));

  if (schedulerRole && !authority && configuredStreamingWebhook) {
    throw new Error(
      "STREAMING_ALERT_WEBHOOK_URL must be absent outside the streaming authority role",
    );
  }
  if (routeRequired && !configuredStreamingWebhook) {
    throw new Error(
      "STREAMING_ALERT_WEBHOOK_URL is required for an external-value production authority",
    );
  }

  const rawWebhook = production
    ? configuredStreamingWebhook
    : configuredStreamingWebhook || env.ALERT_WEBHOOK_URL?.trim() || "";
  const webhookUrl = rawWebhook ? validateWebhookUrl(rawWebhook) : null;
  const routeId = validateRouteId(
    env.STREAMING_ALERT_ROUTE_ID,
    strictProductionRoute,
  );
  const monitorIntervalMs = parseBoundedInteger({
    env,
    key: "STREAMING_HEALTH_MONITOR_INTERVAL_MS",
    fallback: 5_000,
    minimum: 1_000,
    maximum: 60_000,
    required: strictProductionRoute,
  });
  const reminderMs = parseBoundedInteger({
    env,
    key: "STREAMING_ALERT_REMINDER_MS",
    fallback: 300_000,
    minimum: 10_000,
    maximum: 86_400_000,
    required: strictProductionRoute,
  });
  const retryMs = parseBoundedInteger({
    env,
    key: "STREAMING_ALERT_RETRY_MS",
    fallback: 10_000,
    minimum: 1_000,
    maximum: 60_000,
    required: strictProductionRoute,
  });
  const timeoutMs = parseBoundedInteger({
    env,
    key: "STREAMING_ALERT_TIMEOUT_MS",
    fallback: 2_000,
    minimum: 250,
    maximum: 10_000,
    required: strictProductionRoute,
  });
  if (timeoutMs > monitorIntervalMs) {
    throw new Error(
      "STREAMING_ALERT_TIMEOUT_MS must not exceed the monitor interval",
    );
  }
  if (retryMs > reminderMs) {
    throw new Error(
      "STREAMING_ALERT_RETRY_MS must not exceed the reminder interval",
    );
  }
  const enabled =
    Boolean(webhookUrl) && (authority || (!schedulerRole && !production));

  return {
    enabled,
    webhookUrl: enabled ? webhookUrl : null,
    routeId,
    monitorIntervalMs,
    reminderMs,
    retryMs,
    timeoutMs,
  };
}
