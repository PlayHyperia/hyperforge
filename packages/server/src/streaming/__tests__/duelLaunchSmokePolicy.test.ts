import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildDuelSmokeLauncherArgs,
  isDuelSmokeOnlineLine,
  resolveDuelSmokeCaptureBrowserEnvironment,
  validateDuelSmokePorts,
} from "../../../../../scripts/duel-launch-smoke-policy.mjs";

const PORTS = {
  server: 35551,
  websocket: 35552,
  client: 35553,
  capture: 35554,
  captureBrowser: 35559,
  spectator: 35556,
  postgres: 35555,
  hyperbetApi: 35557,
  hyperbetApp: 35558,
  solanaRpc: 35800,
};
const smokeSource = readFileSync(
  new URL("../../../../../scripts/smoke-duel-launch.mjs", import.meta.url),
  "utf8",
);
const oracleVerifierSource = readFileSync(
  new URL(
    "../../../../../scripts/verify-duel-oracle-local.mjs",
    import.meta.url,
  ),
  "utf8",
);
const streamRecoveryVerifierSource = readFileSync(
  new URL(
    "../../../../../scripts/verify-duel-stream-recovery.mjs",
    import.meta.url,
  ),
  "utf8",
);

describe("clean duel launch smoke policy", () => {
  it("requires every owned service port to be valid and unique", () => {
    expect(validateDuelSmokePorts(PORTS)).toEqual(PORTS);
    expect(() =>
      validateDuelSmokePorts({ ...PORTS, postgres: PORTS.server }),
    ).toThrow("must be unique");
    expect(() => validateDuelSmokePorts({ ...PORTS, client: 0 })).toThrow(
      "client port must be an integer",
    );
  });

  it("uses the real fresh verified rendered stack with exactly two agents", () => {
    const args = buildDuelSmokeLauncherArgs({
      ports: PORTS,
      timeoutMs: 240_000,
    });
    expect(args).toContain("--fresh");
    expect(args).toContain("--isolated");
    expect(args).toContain("--verify");
    expect(args).toContain("--skip-betting");
    expect(args).toContain("--skip-keeper");
    expect(args).toContain("--bots=2");
    expect(args).toContain("http://127.0.0.1:35553");
    expect(smokeSource).toContain("delete environment.PORT");
    expect(smokeSource).toContain("delete environment.UWS_PORT");
    expect(smokeSource).not.toContain("PORT: String(ports.server)");
    expect(smokeSource).not.toContain("UWS_PORT: String(ports.websocket)");
  });

  it("enables the isolated Hyperbet UI/backend without silently enabling transaction authority", () => {
    const args = buildDuelSmokeLauncherArgs({
      ports: PORTS,
      timeoutMs: 240_000,
      withHyperbet: true,
    });
    expect(args).not.toContain("--skip-betting");
    expect(args).toContain("--skip-keeper");
    expect(args).toContain("http://127.0.0.1:35557");
    expect(args).toContain("35558");
  });

  it("requires an explicit Hyperbet runtime before keeper verification", () => {
    expect(() =>
      buildDuelSmokeLauncherArgs({
        ports: PORTS,
        timeoutMs: 240_000,
        withKeeper: true,
      }),
    ).toThrow("requires the Hyperbet runtime");

    const args = buildDuelSmokeLauncherArgs({
      ports: PORTS,
      timeoutMs: 240_000,
      withHyperbet: true,
      withKeeper: true,
    });
    expect(args).not.toContain("--skip-keeper");
  });

  it("keeps renderer-loss recovery local, fail-closed, and opt-in", () => {
    expect(smokeSource).toContain('"with-stream-recovery"');
    expect(smokeSource).toContain(
      'throw new Error("--with-stream-recovery requires --with-hyperbet")',
    );
    expect(smokeSource).toContain('"scripts/verify-duel-stream-recovery.mjs"');
    expect(smokeSource).toContain('"--capture-port"');
    expect(streamRecoveryVerifierSource).toContain("must use loopback HTTP");
    expect(streamRecoveryVerifierSource).toContain(
      'degradedReason: "camera_target_unresolved"',
    );
    expect(streamRecoveryVerifierSource).toContain('"Waiting for stream"');
    expect(streamRecoveryVerifierSource).toContain(
      '"Live arena view temporarily unavailable"',
    );
    expect(streamRecoveryVerifierSource).toContain(
      "sameSessionMarkerRetained: true",
    );
    expect(streamRecoveryVerifierSource).toContain(
      '"capture_process_group_sigkill"',
    );
    expect(streamRecoveryVerifierSource).toContain(
      "validateCaptureRestartTarget",
    );
    expect(streamRecoveryVerifierSource).toContain(
      "Local diagnostic Hyperbet topology",
    );
  });

  it("accepts only the launcher's exact post-verification online marker", () => {
    expect(isDuelSmokeOnlineLine("[duel] stack online")).toBe(true);
    expect(isDuelSmokeOnlineLine("[duel] starting stack online checks")).toBe(
      false,
    );
  });

  it("keeps synthetic contestants in explicit load-test mode with production-built artifacts", () => {
    expect(smokeSource).toContain('STREAMING_DUEL_PREPARATION_MS: "5000"');
    expect(smokeSource).not.toContain('STREAM_CAPTURE_CHANNEL: "bundled"');
    expect(smokeSource).toContain("...smokeCaptureBrowserEnvironment");
    expect(
      resolveDuelSmokeCaptureBrowserEnvironment({
        platform: "darwin",
        environment: {},
      }),
    ).toEqual({
      STREAM_CAPTURE_CHANNEL: "chrome",
      STREAM_CAPTURE_ANGLE: "metal",
      STREAM_CAPTURE_HEADLESS: "false",
      STREAMING_CAPTURE_BROWSER_CHANNEL: "chrome",
      STREAMING_CAPTURE_ANGLE: "metal",
    });
    expect(smokeSource).toContain('DUEL_USE_PRODUCTION_CLIENT: "true"');
    expect(smokeSource).toContain('DUEL_NODE_ENV: "production"');
    expect(smokeSource).toContain('DUEL_LOG_LEVEL: "info"');
    expect(smokeSource).toContain('DUEL_LOCAL_SMOKE_MODE: "true"');
    expect(smokeSource).toContain('LOAD_TEST_MODE: "true"');
    expect(smokeSource).toContain('TERRAIN_SEED: "0"');
    expect(smokeSource).toContain('TOWN_COLLISION_DEEP_VALIDATION: "false"');
    expect(smokeSource).toContain("DUEL_HYPERBET_KEEPER_HEALTH_FILE:");
    expect(smokeSource).toContain("DUEL_HYPERBET_STREAM_STATE_FILE:");
    expect(smokeSource).toContain("DUEL_HYPERBET_KEEPER_DB_PATH:");
    expect(smokeSource).toContain("DUEL_HYPERBET_READ_ONLY_MODE:");
    expect(smokeSource).toContain('HYPERIA_REQUIRE_FULL_ASSETS: "true"');
    expect(smokeSource).toContain(
      'HYPERIA_REQUIRE_BROWSER_SYSTEM_DEPS: "true"',
    );
  });

  it("restricts every retained live-evidence file to its owner", () => {
    expect(smokeSource).toContain("await fsp.chmod(videoPath, 0o600)");
    expect(smokeSource).toContain(
      "await fsp.chmod(retainedRtmpStatusPath, 0o600)",
    );
    expect(smokeSource).toContain('mode: 0o600, flag: "wx"');
  });

  it("supplies an explicit preparation window in the local oracle verifier", () => {
    expect(oracleVerifierSource).toContain(
      'process.env.STREAMING_DUEL_PREPARATION_MS || "5000"',
    );
    expect(oracleVerifierSource).toContain(
      "This is a local verification fixture, not a production timing",
    );
  });

  it("isolates and removes the local oracle verifier's PostgreSQL resources", () => {
    expect(oracleVerifierSource).toContain('"--isolated"');
    expect(oracleVerifierSource).toContain(
      "const postgresContainer = `hyperia-duel-oracle-${runId}`",
    );
    expect(oracleVerifierSource).toContain(
      "POSTGRES_CONTAINER: postgresContainer",
    );
    expect(oracleVerifierSource).toContain(
      'removeOwnedDockerResource("container", postgresContainer)',
    );
    expect(oracleVerifierSource).toContain(
      'removeOwnedDockerResource("volume", postgresVolume)',
    );
    expect(oracleVerifierSource).toContain(
      'process.once("SIGINT", () => void handleSignal("SIGINT", 130))',
    );
  });

  it("wires the local oracle verifier to a distinct uWS listener", () => {
    expect(oracleVerifierSource).toContain(
      'process.env.DUEL_LOCAL_WS_PORT || "5566"',
    );
    expect(oracleVerifierSource).toContain(
      "const serverWsUrl = `ws://127.0.0.1:${serverWsPort}/ws`",
    );
    expect(oracleVerifierSource).toContain("UWS_PORT: String(serverWsPort)");
    expect(oracleVerifierSource).toContain(
      'clearPortListeners(serverWsPort, "game websocket")',
    );
  });

  it("starts every local oracle proof with fresh owned logs", () => {
    expect(oracleVerifierSource).toContain(
      "async function clearOwnedRunLogs()",
    );
    expect(oracleVerifierSource).toContain('entry.name.endsWith(".log")');
    expect(oracleVerifierSource).toContain("await clearOwnedRunLogs()");
  });

  it("uses explicit no-money diagnostic contestants for oracle transport verification", () => {
    expect(oracleVerifierSource).toContain('DUEL_WITH_HYPERBET: "false"');
    expect(oracleVerifierSource).toContain('DUEL_LOCAL_SMOKE_MODE: "true"');
    expect(oracleVerifierSource).toContain('LOAD_TEST_MODE: "true"');
    expect(oracleVerifierSource).toContain(
      "This harness validates transport/oracle integration with synthetic",
    );
  });

  it("preloads the canonical program identity into an owned validator", () => {
    expect(oracleVerifierSource).toContain('"--upgradeable-program"');
    expect(oracleVerifierSource).toContain("upgradeAuthority");
    expect(oracleVerifierSource).toContain(
      "refusing to reuse an unowned validator",
    );
    expect(oracleVerifierSource).toContain(
      "async function verifyPreloadedSolanaOracle(programId)",
    );
    expect(oracleVerifierSource).not.toContain("anchor:deploy:localnet");
  });
});
