import { parseArgs } from "node:util";
import {
  probeStreamingAlertRoute,
  writeStreamingAlertProbeEvidence,
} from "../src/streaming/streaming-alert-route-probe.js";

const { values } = parseArgs({
  options: {
    environment: { type: "string" },
    "release-sha": { type: "string" },
    output: { type: "string" },
    "timeout-ms": { type: "string", default: "2000" },
  },
  strict: true,
});

if (!values.environment || !values["release-sha"] || !values.output) {
  throw new Error(
    "Usage: bun run stream:alert:probe -- --environment=<staging|production> --release-sha=<full-sha> --output=<evidence.json>",
  );
}

const rawTimeout = values["timeout-ms"];
if (!/^\d+$/u.test(rawTimeout)) {
  throw new Error("--timeout-ms must be a base-10 integer");
}

const evidence = await probeStreamingAlertRoute({
  approved: process.env.STREAMING_ALERT_TEST_APPROVED === "true",
  webhookUrl: process.env.STREAMING_ALERT_WEBHOOK_URL?.trim() || "",
  routeId: process.env.STREAMING_ALERT_ROUTE_ID?.trim() || "",
  environment: values.environment,
  releaseSha: values["release-sha"],
  timeoutMs: Number.parseInt(rawTimeout, 10),
});
const evidencePath = await writeStreamingAlertProbeEvidence(
  values.output,
  evidence,
);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    evidencePath,
    routeId: evidence.routeId,
    probeId: evidence.probeId,
    webhookAccepted: evidence.webhookAccepted,
    onCallAcknowledgementRequired: evidence.onCallAcknowledgementRequired,
  })}\n`,
);
