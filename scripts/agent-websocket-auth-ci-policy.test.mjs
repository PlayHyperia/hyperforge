import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rootUrl = new URL("../", import.meta.url);

test("keeps production agent authentication, reconnect, and on-deck host-loss proof in CI", () => {
  const rootPackage = JSON.parse(
    readFileSync(new URL("package.json", rootUrl), "utf8"),
  );
  const serverPackage = JSON.parse(
    readFileSync(new URL("packages/server/package.json", rootUrl), "utf8"),
  );
  const workflow = readFileSync(
    new URL(".github/workflows/ci.yml", rootUrl),
    "utf8",
  );
  const harness = readFileSync(
    new URL(
      "packages/server/scripts/test-agent-websocket-auth-postgres.ts",
      rootUrl,
    ),
    "utf8",
  );
  const network = readFileSync(
    new URL("packages/server/src/systems/ServerNetwork/index.ts", rootUrl),
    "utf8",
  );
  const pluginService = readFileSync(
    new URL("packages/plugin-hyperia/src/services/HyperiaService.ts", rootUrl),
    "utf8",
  );
  const pluginWorldJoinTest = readFileSync(
    new URL(
      "packages/plugin-hyperia/src/__tests__/HyperiaService.worldJoin.test.ts",
      rootUrl,
    ),
    "utf8",
  );

  assert.equal(
    serverPackage.scripts["test:agent-websocket-auth-built"],
    "bun run --cwd ../shared build && bun run --cwd ../plugin-hyperia build && AGENT_WEBSOCKET_AUTH_PLUGIN_RUNTIME=built bun scripts/test-agent-websocket-auth-postgres.ts",
  );
  assert.match(
    rootPackage.scripts["duel:smoke:policy:test"],
    /scripts\/agent-websocket-auth-ci-policy\.test\.mjs/u,
  );

  const command = "bun run test:agent-websocket-auth-built";
  const testJobStart = workflow.indexOf("\n  test:\n");
  const buildJobStart = workflow.indexOf("\n  build:\n");
  assert.ok(testJobStart >= 0 && buildJobStart > testJobStart);
  const testJob = workflow.slice(testJobStart, buildJobStart);
  assert.equal(testJob.split(command).length - 1, 1);
  assert.match(
    testJob,
    /- name: Verify production agent WebSocket authentication, reconnect, and on-deck host loss[\s\S]*?working-directory: packages\/server[\s\S]*?run: bun run test:agent-websocket-auth-built/u,
  );

  assert.match(harness, /new WebSocketServer\(/u);
  assert.match(harness, /network\.onConnection\(/u);
  assert.match(harness, /createDrizzleAdapter\(/u);
  assert.match(harness, /buildAgentCredentialJwtPayload\(/u);
  assert.match(harness, /createJWT\(/u);
  assert.match(harness, /INSERT INTO agent_credential_sessions/u);
  assert.match(harness, /new pluginModule\.HyperiaService\(/u);
  assert.match(harness, /await service\.connect\(socketUrl\)/u);
  assert.match(harness, /agentCredentialCharacterId/u);
  assert.match(harness, /firstMessageAuthentication:\s*true/u);
  assert.match(harness, /serverNetworkLifecycle:\s*true/u);
  assert.match(harness, /retainedEntityReconnected:\s*true/u);
  assert.match(harness, /singleWorldEntryPerConnection:\s*true/u);
  assert.match(harness, /twoAuthenticatedOnDeckContestants:\s*true/u);
  assert.match(harness, /onDeckDisconnectReportedDurably:\s*true/u);
  assert.match(harness, /spawn\(process\.execPath/u);
  assert.match(harness, /child\.kill\("SIGKILL"\)/u);
  assert.match(harness, /child\.kill\("SIGSTOP"\)/u);
  assert.match(harness, /child\.kill\("SIGCONT"\)/u);
  assert.match(harness, /separateAuthenticatedHostProcesses:\s*true/u);
  assert.match(harness, /onDeckProcessSigkillReportedDurably:\s*true/u);
  assert.match(harness, /onDeckProcessStallReportedDurably:\s*true/u);
  assert.match(harness, /stalledPeerHeartbeatContinued:\s*true/u);
  assert.match(harness, /resumedStaleHostAuthorityRevoked:\s*true/u);
  assert.match(harness, /CHILD_MODEL_MODE_ENV/u);
  assert.match(harness, /modelMode === "hang"/u);
  assert.match(harness, /modelMode === "valid"/u);
  assert.match(harness, /new Promise<string>\(\(\) => undefined\)/u);
  assert.match(harness, /hungElizaOsProviderBoundedFallback:\s*true/u);
  assert.match(harness, /hungProviderSingleInvocation:\s*true/u);
  assert.match(harness, /hungProviderPrivateAuthorityAbsent:\s*true/u);
  assert.match(harness, /productionAuthenticatedSelectedStrategy:\s*true/u);
  assert.match(harness, /selectedStrategySemanticReplayExact:\s*true/u);
  assert.match(harness, /selectedProviderSingleInvocation:\s*true/u);
  assert.match(harness, /selectedProviderPrivateAuthorityAbsent:\s*true/u);
  assert.match(harness, /openAuthoritativeAgentBank\(/u);
  assert.match(harness, /commitOwnedDuelPreparationPlan\(/u);
  assert.match(harness, /recoverOwnedDuelPreparationPlan\(/u);
  assert.match(harness, /await preparationStore\.markReady\(/u);
  assert.match(harness, /authenticatedPrivatePreparationBankOpened:\s*true/u);
  assert.match(harness, /authenticatedSelectedWholePlanCommitted:\s*true/u);
  assert.match(
    harness,
    /authenticatedSelectedWholePlanRecoveredExactly:\s*true/u,
  );
  assert.match(
    harness,
    /authenticatedSelectedWholePlanLiveStateSynchronized:\s*true/u,
  );
  assert.match(
    harness,
    /authenticatedSelectedWholePlanReadinessCommitted:\s*true/u,
  );
  assert.match(
    harness,
    /authenticatedSelectedReadinessPrivateDecisionExcluded:\s*true/u,
  );
  assert.match(
    harness,
    /authenticatedSelectedWholePlanStableAfterPeerLoss:\s*true/u,
  );
  assert.match(harness, /replacementHostAuthorityRejected:\s*true/u);
  assert.match(harness, /marketAuthorityBlockedAfterHostLoss:\s*true/u);
  assert.match(harness, /staleOnDeckAuthorityRevokedAfterReconnect:\s*true/u);
  assert.match(harness, /revokedCredentialRejected:\s*true/u);
  assert.match(harness, /webSocketListenerClosed/u);
  assert.match(
    harness,
    /transportSocketCount:\s*serverTransportSockets\.size/u,
  );
  assert.match(harness, /docker\(\["rm", "-f", CONTAINER_NAME\]\)/u);

  assert.match(
    network,
    /this\.handlers\["onDuelPreparationHostLease"\][\s\S]*?this\.handlers\["duelPreparationHostLease"\]\s*=\s*this\.handlers\["onDuelPreparationHostLease"\]/u,
  );
  assert.match(
    network,
    /this\.handlers\["onDuelPreparationStrategy"\][\s\S]*?this\.handlers\["duelPreparationStrategy"\]\s*=\s*this\.handlers\["onDuelPreparationStrategy"\]/u,
  );
  assert.match(
    pluginService,
    /private worldJoinPromise:\s*Promise<void>\s*\|\s*null/u,
  );
  assert.match(
    pluginService,
    /this\.worldJoinPromise\s*=\s*null;[\s\S]*?private ensureWorldJoin\(/u,
  );
  assert.match(
    pluginWorldJoinTest,
    /coalesces overlapping snapshot and reconnect joins for one socket/u,
  );
  assert.match(pluginWorldJoinTest, /toHaveBeenCalledTimes\(2\)/u);
});
