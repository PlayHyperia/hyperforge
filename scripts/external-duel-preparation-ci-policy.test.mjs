import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rootUrl = new URL("../", import.meta.url);

test("keeps built external ElizaOS preparation process-loss fencing in CI", () => {
  const serverPackage = JSON.parse(
    readFileSync(new URL("packages/server/package.json", rootUrl), "utf8"),
  );
  const workflow = readFileSync(
    new URL(".github/workflows/ci.yml", rootUrl),
    "utf8",
  );
  const harness = readFileSync(
    new URL(
      "packages/server/scripts/test-external-duel-preparation-host-lease-process-kill.ts",
      rootUrl,
    ),
    "utf8",
  );

  assert.equal(
    serverPackage.scripts[
      "test:external-duel-preparation-host-lease-built-chaos"
    ],
    "bun run --cwd ../plugin-hyperia build && EXTERNAL_DUEL_PREPARATION_HOST_LEASE_PLUGIN_RUNTIME=built bun scripts/test-external-duel-preparation-host-lease-process-kill.ts",
  );

  const command =
    "bun run test:external-duel-preparation-host-lease-built-chaos";
  const testJobStart = workflow.indexOf("\n  test:\n");
  const buildJobStart = workflow.indexOf("\n  build:\n");
  assert.ok(testJobStart >= 0 && buildJobStart > testJobStart);
  const testJob = workflow.slice(testJobStart, buildJobStart);
  assert.equal(
    testJob.split(command).length - 1,
    1,
    "the database-backed CI test job must run built external preparation chaos exactly once",
  );
  assert.ok(
    testJob.indexOf(command) >
      testJob.indexOf("bun run test:processing-action-chaos"),
    "external preparation chaos must follow the underlying processing custody gate",
  );
  assert.ok(
    testJob.indexOf(command) <
      testJob.indexOf("bun run test:projectile-cost-host-loss-chaos"),
    "external preparation chaos must remain in the database-backed test job before build",
  );
  const commandLine = testJob
    .split("\n")
    .findIndex((line) => line.trim() === `run: ${command}`);
  assert.ok(commandLine >= 2, "external preparation CI step is missing");
  assert.deepEqual(
    testJob.split("\n").slice(commandLine - 2, commandLine + 1),
    [
      "      - name: Verify external ElizaOS preparation process-kill fencing",
      "        working-directory: packages/server",
      `        run: ${command}`,
    ],
  );
  assert.doesNotMatch(
    workflow,
    /EXTERNAL_DUEL_PREPARATION_HOST_LEASE_TEST_DATABASE_URL/u,
    "CI must use the harness-owned database and execute the real container cleanup path",
  );

  assert.match(harness, /actualWebSocket:\s*true/u);
  assert.match(harness, /actualMsgpack:\s*true/u);
  assert.match(
    harness,
    /strategyPacketId:\s*getPacketId\("duelPreparationStrategy"\)/u,
  );
  assert.match(harness, /boundedStrategyRoundTrip:\s*true/u);
  assert.match(harness, /pluginRuntime === "built"/u);
  assert.match(harness, /verifiedArtifact:\s*executableBuild\.verified/u);
  assert.match(harness, /child\.kill\("SIGKILL"\)/u);
  assert.match(harness, /strategyAnswered:\s*false/u);
  assert.match(harness, /competitiveSnapshotCount:\s*Number/u);
  assert.match(harness, /await openAuthoritativeAgentBank\(\{/u);
  assert.match(
    harness,
    /await databaseSystem\.commitDuelPreparationPlanOperationAsync\(/u,
  );
  assert.match(
    harness,
    /await databaseSystem\.getDuelPreparationPlanOperationAsync\(\{/u,
  );
  assert.match(harness, /streaming_duel_bank_open_events/u);
  assert.match(harness, /operationType"\s*=\s*'duel_preparation_plan'/u);
  assert.match(harness, /serverOwnedPreparation:\s*\{/u);
  assert.match(harness, /exactCommittedCustody,/u);
  assert.match(harness, /readinessCommitted:\s*firstReady\.agent1ReadyAt/u);
  assert.match(harness, /privateItemIdsSentToPlugin:\s*false/u);
  assert.match(harness, /docker\(\["rm", "-f", ownedContainerName\]\)/u);
  assert.match(harness, /productionAuthenticationCovered:\s*false/u);
  assert.match(harness, /serverNetworkLifecycleCovered:\s*false/u);
});
