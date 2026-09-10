import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  assertAuthorityRestartDiagnosticBoundary,
  assertMultiStyleSparbotOptions,
  assertManagedLocalSolanaBoundary,
  assertStandaloneSparbotRuntimeBoundary,
  assertSupportedUwsNodeVersion,
  assertProcessTerminationAllowed,
  hasConfiguredDuelModelProvider,
  isBettingFeedBootstrap,
  isFreshHyperbetReadiness,
  isHyperbetStreamSynchronized,
  isStandaloneSparbotBootstrap,
  normalizeHttpServiceUrl,
  omitEnvironmentKeys,
  resolveDuelDatabaseConfiguration,
  resolveDuelGameServiceTopology,
  resolveHyperbetKeeperDatabaseTopology,
  resolveHyperbetRuntimeTopology,
  resolveHyperbetSolanaDeployment,
  resolveHyperbetWorkspace,
  resolvePrivateBettingFeedToken,
  resolveJwtRuntimeSecret,
  resolvePrivateRuntimeSecret,
  resolveStandaloneSparbotProfileSeed,
  resolveStandaloneSparbotStyles,
  shouldReleaseRestartedAuthorityStartupGate,
} from "../../../../../scripts/duel-stack-topology.mjs";

const launcherSource = readFileSync(
  new URL("../../../../../scripts/duel-stack.mjs", import.meta.url),
  "utf8",
);
const shutdownPolicySource = readFileSync(
  new URL("../../../../../scripts/duel-stack-shutdown.mjs", import.meta.url),
  "utf8",
);
const captureBrowserHostSource = readFileSync(
  new URL("../../../scripts/capture-browser-host.ts", import.meta.url),
  "utf8",
);
const streamToRtmpSource = readFileSync(
  new URL("../../../scripts/stream-to-rtmp.ts", import.meta.url),
  "utf8",
);
const persistedBetSyncServiceSource = readFileSync(
  new URL(
    "../../../scripts/run-agent-duel-bet-sync-service.ts",
    import.meta.url,
  ),
  "utf8",
);
const verifierUrl = new URL(
  "../../../../../scripts/verify-duel-stack.mjs",
  import.meta.url,
);
const verifierSource = readFileSync(verifierUrl, "utf8");
const execFileAsync = promisify(execFile);
// A cold macOS file-provider checkout can spend tens of seconds materializing
// verifier dependencies before Node reaches its first log line. Keep the child
// watchdog finite without turning a healthy cold checkout into a false failure.
const verifierProcessTimeoutMs = 60_000;

describe("duel stack launch policy", () => {
  it("retains verifier evidence with owner-only permissions", () => {
    expect(verifierSource).toContain("await fsp.chmod(screenshotPath, 0o600);");
    expect(verifierSource).toContain("mode: 0o600");
  });

  it("uses one validated custom-port topology for server binding and discovery", () => {
    expect(
      resolveDuelGameServiceTopology({
        serverUrl: "http://127.0.0.1:15555/",
        websocketUrl: "ws://127.0.0.1:15556/ws",
      }),
    ).toEqual({
      serverUrl: "http://127.0.0.1:15555",
      websocketUrl: "ws://127.0.0.1:15556/ws",
      serverPort: 15555,
      websocketPort: 15556,
    });

    expect(
      resolveDuelGameServiceTopology({
        serverUrl: "https://duel.example.com",
        websocketUrl: "wss://duel.example.com/ws",
      }),
    ).toMatchObject({ serverPort: 443, websocketPort: 443 });
    expect(() =>
      resolveDuelGameServiceTopology({
        serverUrl: "ftp://127.0.0.1:15555",
        websocketUrl: "ws://127.0.0.1:15556/ws",
      }),
    ).toThrow("must use HTTP or HTTPS");
    expect(() =>
      resolveDuelGameServiceTopology({
        serverUrl: "http://127.0.0.1:15555/api",
        websocketUrl: "ws://127.0.0.1:15556/ws",
      }),
    ).toThrow("must be an origin with no path");
    expect(() =>
      resolveDuelGameServiceTopology({
        serverUrl: "http://127.0.0.1:15555",
        websocketUrl: "http://127.0.0.1:15556/ws",
      }),
    ).toThrow("must use WS or WSS");
    expect(() =>
      resolveDuelGameServiceTopology({
        serverUrl: "http://127.0.0.1:15555",
        websocketUrl: "ws://127.0.0.1:15556/other",
      }),
    ).toThrow("must use the /ws endpoint");

    expect(launcherSource).toContain(
      "PORT: String(gameServiceTopology.serverPort)",
    );
    expect(launcherSource).toContain(
      "UWS_PORT: String(gameServiceTopology.websocketPort)",
    );
  });

  it("keeps alternate-chain bootstrap out of the native SOL launcher", () => {
    expect(launcherSource).not.toMatch(/\b(?:skip-)?chain-setup\b/i);
    expect(launcherSource).not.toMatch(/\b(?:anvil|mud|forge)\b/i);
    expect(launcherSource).toContain(
      '"../../scripts/start-hyperia-server.mjs"',
    );
    expect(launcherSource).toContain("starting the native SOL duel server");
  });

  it("resolves database mode and URL overrides without silently changing targets", () => {
    expect(
      resolveDuelDatabaseConfiguration({
        runtimeEnvironment: {},
        serverEnvironment: {},
      }),
    ).toEqual({
      mode: "local",
      databaseUrl: "",
      useManagedLocalPostgres: true,
    });

    expect(
      resolveDuelDatabaseConfiguration({
        runtimeEnvironment: {
          DUEL_DATABASE_URL: "postgresql://duel@db.example/launch",
        },
        serverEnvironment: {
          DATABASE_URL: "postgresql://stale@old.example/wrong",
          USE_LOCAL_POSTGRES: "true",
        },
      }),
    ).toEqual({
      mode: "remote",
      databaseUrl: "postgresql://duel@db.example/launch",
      useManagedLocalPostgres: false,
    });

    expect(
      resolveDuelDatabaseConfiguration({
        runtimeEnvironment: {
          DATABASE_URL: "postgresql://duel@127.0.0.1:6543/launch",
        },
      }),
    ).toEqual({
      mode: "local",
      databaseUrl: "postgresql://duel@127.0.0.1:6543/launch",
      useManagedLocalPostgres: false,
    });

    expect(() =>
      resolveDuelDatabaseConfiguration({
        runtimeEnvironment: { USE_LOCAL_POSTGRES: "false" },
      }),
    ).toThrow("Remote duel database mode requires");
    expect(() =>
      resolveDuelDatabaseConfiguration({
        runtimeEnvironment: {
          DUEL_DATABASE_MODE: "local",
          DATABASE_URL: "postgresql://duel@db.example/launch",
        },
      }),
    ).toThrow("cannot silently discard a remote DATABASE_URL");
    expect(() =>
      resolveDuelDatabaseConfiguration({
        runtimeEnvironment: { DUEL_DATABASE_MODE: "automatic" },
      }),
    ).toThrow("must be either local or remote");

    expect(launcherSource).toContain("...serverEnv,\n    ...process.env");
    expect(launcherSource).not.toContain("cleanupStaleLocalPostgresSessions");
    expect(launcherSource).toContain("String(clientPort)");
    expect(launcherSource).toContain('verifyArgs.push("--skip-betting")');
    expect(launcherSource).toContain('requestedChannel === "bundled"');
  });

  it("makes isolated launches fail closed instead of terminating existing processes", () => {
    expect(
      assertProcessTerminationAllowed({
        isolated: false,
        label: "capture",
        pids: [32, 32, 44],
      }),
    ).toEqual([32, 44]);
    expect(() =>
      assertProcessTerminationAllowed({
        isolated: true,
        label: "capture",
        pids: [32],
      }),
    ).toThrow(
      "Isolated duel launch refuses to terminate pre-existing capture process(es): 32",
    );
    expect(launcherSource).toContain("isolated: options.isolated");
  });

  it("requires the authoritative duel state before launch can complete", () => {
    expect(launcherSource).toMatch(
      /await waitForHttp\(\s*gameStreamingStateUrl,\s*"streaming duel api"/,
    );
    expect(launcherSource).not.toContain(
      "streaming duel api not ready at ${gameStreamingStateUrl}",
    );
  });

  it("requires the capture client and live HLS unless streaming is explicitly skipped", () => {
    expect(launcherSource).toContain(
      'if (!options["skip-stream"] || !clientWasReady || options.fresh)',
    );
    expect(launcherSource).toMatch(
      /await waitForLiveHls\(hlsUrl, hlsReadyTimeoutMs\)/,
    );
    expect(launcherSource).not.toMatch(/waitForLiveHls\([^;]+\.catch\(/s);
    expect(launcherSource).toContain(
      'process.env.STREAMING_CAPTURE_ENABLED || "false"',
    );
    expect(launcherSource).toContain(
      'RTMP_STATUS_FILE: options["skip-stream"] ? "" : rtmpStatusFile',
    );
    expect(launcherSource).toContain('verifyArgs.push("--skip-stream")');
    expect(launcherSource).toContain('"capture renderer"');
    expect(launcherSource).toContain("payload?.rendererHealth?.ready === true");
  });

  it("keeps the persisted restart source on the production streaming contract", () => {
    expect(persistedBetSyncServiceSource).toContain(
      'requestUrl.pathname === "/api/streaming/state"',
    );
    expect(persistedBetSyncServiceSource).toContain(
      'requestUrl.pathname === "/api/streaming/state/events"',
    );
    expect(persistedBetSyncServiceSource).toContain(
      '"content-type": "text/event-stream; charset=utf-8"',
    );
    expect(persistedBetSyncServiceSource).toContain(
      "rendererHealth: {\n        ready: true as const,",
    );
    expect(persistedBetSyncServiceSource).toContain(
      "streamingBroadcastTimer = setInterval(broadcastStreamingState, 1_000)",
    );
    expect(persistedBetSyncServiceSource).toContain("streamingClients.clear()");
  });

  it("allows browser-audio preflight to finish before CDP startup can time out", () => {
    expect(streamToRtmpSource).toContain(
      'process.env.STREAM_CAPTURE_START_TIMEOUT_MS || "15000"',
    );
    expect(streamToRtmpSource).not.toContain(
      'process.env.STREAM_CAPTURE_START_TIMEOUT_MS || "15_000"',
    );
  });

  it("keeps the FFmpeg video timeline on an independent constant-rate pump", () => {
    expect(streamToRtmpSource).toContain(
      "new CaptureFramePump<Buffer>(TARGET_FPS",
    );
    expect(streamToRtmpSource).toContain(
      "const framePacer = new CaptureFramePacer(CAPTURE_SOURCE_FPS)",
    );
    expect(streamToRtmpSource).toContain(
      "framePump.start(1000 / (TARGET_FPS * 2))",
    );
    expect(streamToRtmpSource).toContain(".runPaced(async () =>");
    expect(streamToRtmpSource).toContain("await framePacer?.drain()");
    expect(streamToRtmpSource).toContain("framePump.pushFrame(jpegBuffer)");
    expect(streamToRtmpSource).not.toContain(
      "const written = await bridge.feedFrame(jpegBuffer)",
    );
  });

  it("supervises the warm WebGPU renderer separately from the restartable encoder worker", () => {
    expect(launcherSource).toContain("const PROCESS_QUERY_TIMEOUT_MS = 2_000;");
    expect(launcherSource).toContain(
      'const out = execFileSync(\n      "pgrep",',
    );
    expect(launcherSource).toContain(
      '["-f", escapeProcessQueryPattern(pattern)]',
    );
    expect(launcherSource).toContain("timeout: PROCESS_QUERY_TIMEOUT_MS");
    expect(launcherSource).toContain('killSignal: "SIGKILL"');
    expect(launcherSource).not.toContain(
      'execFileSync("ps", ["-axo", "pid=,command="]',
    );
    expect(launcherSource).toContain('spawnManaged("capture-browser-host"');
    expect(launcherSource).toContain("STREAM_CAPTURE_BROWSER_ENDPOINT");
    expect(launcherSource).toContain("STREAM_BROWSER_AUDIO_REQUIRED");
    expect(launcherSource).toContain("await startCaptureBrowserHost()");
    expect(launcherSource).toContain("restartDelayMs: 500");
    expect(launcherSource).toContain("cleanupProcessGroupOnExit: true");
    expect(launcherSource).toContain('process.kill(-proc.pid, "SIGKILL")');
    expect(shutdownPolicySource).toContain(
      'env.DUEL_STACK_SHUTDOWN_GRACE_MS?.trim() || "24000"',
    );
    expect(shutdownPolicySource).toContain(
      "DUEL_STACK_SHUTDOWN_GRACE_MS must be 2000..30000",
    );
    expect(shutdownPolicySource).toContain(
      "DUEL_STACK_SHUTDOWN_GRACE_MS must cover the 5000ms terminal wait, configured ACK timeout, and 2000ms cleanup margin",
    );
    expect(launcherSource).toContain(
      "const result = await shutdownDuelStackChildren({",
    );
    expect(launcherSource).toContain(
      "entry.shutdownMonitor = observeGameServerShutdown(",
    );
    expect(launcherSource).toContain("process.exit(shutdownExitCode)");
    expect(launcherSource).toContain(
      "STRUCTURED_SHUTDOWN_EVENT_PATTERN.test(trimmedLine)",
    );
    expect(captureBrowserHostSource).not.toContain(
      '"--remote-allow-origins=*"',
    );
    expect(captureBrowserHostSource).toContain('browser.on("disconnected"');
    expect(captureBrowserHostSource).toContain('page.on("crash"');
    expect(captureBrowserHostSource).toContain('page.on("close"');
    expect(captureBrowserHostSource).toContain('"renderer_degraded"');
    expect(captureBrowserHostSource).toContain(
      "resolveCaptureBrowserFrameIpcConfig(process.env)",
    );
    expect(captureBrowserHostSource).toContain(
      "parseCaptureBrowserFrameRequest(rawRequest",
    );
    expect(captureBrowserHostSource).toContain(
      "await waitForStableFrameCaptureReadiness(page, request)",
    );
    expect(captureBrowserHostSource).toContain(
      "normalizeCaptureSceneReadinessDiagnostics(rawReadiness)",
    );
    expect(captureBrowserHostSource).toContain("postCaptureReadiness");
    expect(captureBrowserHostSource).toContain(
      'fs.writeFileSync(outputPath, screenshot, { flag: "wx", mode: 0o600 })',
    );
    expect(captureBrowserHostSource).toContain(
      'source: "capture-browser-host"',
    );
    expect(captureBrowserHostSource).toContain(
      'createHash("sha256").update(screenshot).digest("hex")',
    );
    expect(captureBrowserHostSource).not.toContain("connectOverCDP");
    expect(streamToRtmpSource).toContain(
      "chromium.connectOverCDP(STREAM_CAPTURE_BROWSER_ENDPOINT)",
    );
    expect(streamToRtmpSource).toContain(
      "Supervised capture browser must expose exactly one configured game page",
    );
    expect(streamToRtmpSource).toContain(
      "if (!browserExternallyOwned) {\n      await browser.close();",
    );
    expect(streamToRtmpSource).toContain(
      "Required browser game-master audio did not pass PCM preflight",
    );
  });

  it("verifies a streamless duel stack without weakening streamed delivery checks", async () => {
    let hlsRequests = 0;
    let rtmpRequests = 0;
    let origin = "";
    const mockStack = createServer((request, response) => {
      const requestUrl = new URL(request.url || "/", origin);
      const sendJson = (payload: unknown, statusCode = 200) => {
        response.writeHead(statusCode, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };

      if (requestUrl.pathname === "/never-ready.m3u8") {
        hlsRequests += 1;
        response.writeHead(503);
        response.end("stream intentionally unavailable");
        return;
      }
      if (requestUrl.pathname === "/api/streaming/rtmp/status") {
        rtmpRequests += 1;
        const updatedAt = Date.now();
        sendJson({
          active: false,
          updatedAt,
          stats: {
            bytesReceived: 0,
            audioSource: "browser",
            audioHealthy: true,
            audioLastChunkAt: Date.now(),
            audioChunks: 1,
            audioDroppedChunks: 0,
            audioTrimmedChunks: 0,
          },
          browserAudioCaptureHealth: {
            contextState: "running",
            sourceContextState: "running",
            trackState: "live",
            sampleRate: 48_000,
            channels: 2,
            chunks: 1,
            bytes: 4_096,
            contentChunks: 1,
            contentThreshold: 0.0001,
            maxSamplePeak: 0.25,
            lastContentChunkAt: updatedAt,
            lastChunkAt: updatedAt,
          },
          rendererHealth: {
            ready: true,
            degradedReason: null,
            phase: "FIGHTING",
            diagnostics: {
              sceneReadiness: {
                ready: true,
                cycleId: "streamless-cycle",
                phase: "FIGHTING",
                equipmentVisualsReady: true,
                equipmentConfigured: true,
                equipmentCycleId: "streamless-cycle",
                equipmentRequiredCount: 6,
                equipmentRequiredPlayerCount: 2,
                equipmentReadyCount: 6,
                equipmentExpectedPlayerCount: 2,
                equipmentActiveVisualCount: 2,
                equipmentActiveVisibleCount: 2,
                equipmentActivePlayerCount: 2,
                equipmentActiveVisiblePlayerCount: 2,
                equipmentUnresolvedCount: 0,
                equipmentAttachmentMismatchCount: 0,
                expectedAgentCount: 2,
              },
            },
          },
        });
        return;
      }
      if (requestUrl.pathname === "/health") {
        sendJson({
          status: "ok",
          database: { healthy: true, status: "healthy", latencyMs: 1 },
        });
        return;
      }
      if (requestUrl.pathname === "/api/streaming/config") {
        sendJson({
          canonicalPlatform: "hls",
          canonicalSourceUrl: `${origin}/never-ready.m3u8`,
          publicDelayMs: 0,
        });
        return;
      }
      if (requestUrl.pathname === "/api/streaming/duel-context") {
        sendJson({
          cycle: {
            cycleId: "streamless-cycle",
            phase: "FIGHTING",
            agent1: {
              id: "streamless-agent-a",
              hp: 20,
              damageDealtThisFight: 1,
            },
            agent2: {
              id: "streamless-agent-b",
              hp: 20,
              damageDealtThisFight: 0,
            },
          },
        });
        return;
      }
      if (requestUrl.pathname.includes("/inventory")) {
        sendJson({ inventory: [] });
        return;
      }
      if (requestUrl.pathname.includes("/monologues")) {
        sendJson({ thoughts: [] });
        return;
      }
      if (
        requestUrl.pathname === "/" ||
        requestUrl.pathname === "/api/streaming/state"
      ) {
        sendJson({ ok: true });
        return;
      }

      sendJson({ error: "not found" }, 404);
    });

    await new Promise<void>((resolve, reject) => {
      mockStack.once("error", reject);
      mockStack.listen(0, "127.0.0.1", resolve);
    });
    const address = mockStack.address();
    if (!address || typeof address === "string") {
      mockStack.close();
      throw new Error("mock duel stack did not expose a TCP address");
    }
    origin = `http://127.0.0.1:${address.port}`;
    const evidenceDirectory = await mkdtemp(
      path.join(tmpdir(), "hyperia-duel-verifier-evidence-"),
    );

    try {
      const verifierArgs = [
        fileURLToPath(verifierUrl),
        "--server-url",
        origin,
        "--client-url",
        origin,
        "--hls-url",
        `${origin}/never-ready.m3u8`,
        "--skip-betting",
        "--timeout-ms",
        "1000",
        "--fight-timeout-ms",
        "1000",
        "--rtmp-timeout-ms",
        "250",
        "--poll-ms",
        "10",
        "--browser-evidence-dir",
        evidenceDirectory,
      ];
      const { stdout } = await execFileAsync(
        process.execPath,
        [...verifierArgs, "--skip-stream"],
        { timeout: verifierProcessTimeoutMs },
      );

      expect(stdout).toContain("verification passed");
      expect(stdout).toContain('"skipStream": true');
      const retainedReport = JSON.parse(
        await readFile(
          path.join(evidenceDirectory, "duel-stack-verification-report.json"),
          "utf8",
        ),
      );
      expect(retainedReport).toMatchObject({
        ok: true,
        skipStream: true,
        combatEvidence: { damageRecorded: true },
      });
      expect(hlsRequests).toBe(0);
      expect(rtmpRequests).toBe(0);

      await expect(
        execFileAsync(process.execPath, verifierArgs, {
          timeout: verifierProcessTimeoutMs,
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("Timed out waiting for HLS playlist"),
      });
      expect(hlsRequests).toBeGreaterThan(0);
      expect(rtmpRequests).toBeGreaterThan(0);

      await expect(
        execFileAsync(
          process.execPath,
          [
            ...verifierArgs,
            "--skip-stream",
            "--require-destinations",
            "twitch",
          ],
          { timeout: verifierProcessTimeoutMs },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "--skip-stream cannot be combined with --require-destinations",
        ),
      });
    } finally {
      await new Promise<void>((resolve) => mockStack.close(() => resolve()));
      await rm(evidenceDirectory, { recursive: true, force: true });
    }
  }, 90_000);

  it("holds the first duel until the complete launch surface is ready", () => {
    expect(launcherSource).toContain(
      "STREAMING_DUEL_MAINTENANCE_MODE: launcherOwnsStartupGate",
    );

    const contestantsIndex = launcherSource.indexOf(
      "await startContestants();",
    );
    const streamIndex = launcherSource.indexOf("await startStreamBridge();");
    const servicesIndex = launcherSource.indexOf("await startMarketMakers();");
    const releaseIndex = launcherSource.indexOf(
      "await setDuelMaintenanceMode(",
      contestantsIndex,
    );
    const verificationIndex = launcherSource.indexOf(
      'if (verifyEnabled) {\n    log("running startup verification checks...")',
    );
    const combinedReadinessIndex = launcherSource.indexOf(
      '"combined Hyperbet launch readiness"',
    );

    expect(contestantsIndex).toBeGreaterThan(0);
    expect(streamIndex).toBeGreaterThan(contestantsIndex);
    expect(servicesIndex).toBeGreaterThan(streamIndex);
    expect(releaseIndex).toBeGreaterThan(servicesIndex);
    expect(combinedReadinessIndex).toBeGreaterThan(releaseIndex);
    expect(verificationIndex).toBeGreaterThan(combinedReadinessIndex);
    expect(verificationIndex).toBeGreaterThan(releaseIndex);
  });

  it("sends valid JSON for both startup maintenance actions", () => {
    expect(launcherSource).toContain('"content-type": "application/json"');
    expect(launcherSource).toMatch(
      /body: JSON\.stringify\(\s*enabled\s*\?\s*\{[\s\S]*?\}\s*:\s*\{\},\s*\)/,
    );
  });

  it("does not inject legacy, embedded, or home-page capture fallbacks", () => {
    expect(launcherSource).toContain(
      "GAME_FALLBACK_URLS: explicitStreamFallbackUrls",
    );
    expect(launcherSource).not.toContain("legacyStreamPageUrl");
    expect(launcherSource).not.toContain("embeddedSpectatorCaptureUrl");
    expect(launcherSource).not.toContain("homeCaptureUrl");
  });

  it("discovers only a complete SOL Hyperbet workspace and honors an explicit root", () => {
    const completeRoot = "/workspace/hyperbet-solana-implementation";
    const existing = new Set([
      `${completeRoot}/package.json`,
      `${completeRoot}/packages/hyperbet-solana/package.json`,
      `${completeRoot}/packages/hyperbet-solana/app/package.json`,
      `${completeRoot}/packages/hyperbet-solana/keeper/package.json`,
    ]);
    const workspace = resolveHyperbetWorkspace({
      workspaceRoot: "/workspace/hyperia",
      configuredRoot: completeRoot,
      existsSync: (candidate) => existing.has(String(candidate)),
    });

    expect(workspace).toMatchObject({
      root: completeRoot,
      solanaDir: `${completeRoot}/packages/hyperbet-solana`,
      appDir: `${completeRoot}/packages/hyperbet-solana/app`,
      keeperDir: `${completeRoot}/packages/hyperbet-solana/keeper`,
    });
    existing.delete(
      `${completeRoot}/packages/hyperbet-solana/keeper/package.json`,
    );
    expect(
      resolveHyperbetWorkspace({
        workspaceRoot: "/workspace/hyperia",
        configuredRoot: completeRoot,
        existsSync: (candidate) => existing.has(String(candidate)),
      }),
    ).toBeNull();
  });

  it("takes keeper program identity from the versioned SOL deployment registry", () => {
    const registry = JSON.stringify({
      solana: {
        localnet: {
          cluster: "localnet",
          fightOracleProgramId: "GFdnu7kUnZGiXh4ejWiJSBCUxvq4UfdEeUv9jjFzr5EM",
          duelMarketProgramId: "3QUVoaKJqo1rg9eXe7vyFewJrY75NWdtH8JZfvTb79Uy",
        },
      },
    });
    const readFile = () => registry;

    expect(
      resolveHyperbetSolanaDeployment({
        solanaDir: "/workspace/hyperbet/packages/hyperbet-solana",
        cluster: "local",
        readFileSync: readFile,
      }),
    ).toEqual({
      cluster: "localnet",
      fightOracleProgramId: "GFdnu7kUnZGiXh4ejWiJSBCUxvq4UfdEeUv9jjFzr5EM",
      duelMarketProgramId: "3QUVoaKJqo1rg9eXe7vyFewJrY75NWdtH8JZfvTb79Uy",
    });
    expect(() =>
      resolveHyperbetSolanaDeployment({
        solanaDir: "/workspace/hyperbet/packages/hyperbet-solana",
        cluster: "devnet",
        readFileSync: readFile,
      }),
    ).toThrow("has no devnet entry");
    expect(() =>
      resolveHyperbetSolanaDeployment({
        solanaDir: "/workspace/hyperbet/packages/hyperbet-solana",
        cluster: "localnet",
        readFileSync: () =>
          JSON.stringify({
            solana: {
              localnet: {
                fightOracleProgramId: "not-a-program",
                duelMarketProgramId:
                  "3QUVoaKJqo1rg9eXe7vyFewJrY75NWdtH8JZfvTb79Uy",
              },
            },
          }),
      }),
    ).toThrow("must be a base58 Solana program id");

    expect(launcherSource).toContain("resolveHyperbetSolanaDeployment({");
    expect(launcherSource).toContain(
      "FIGHT_ORACLE_PROGRAM_ID: keeperDeployment.fightOracleProgramId",
    );
    expect(launcherSource).toContain(
      "DUEL_MARKET_PROGRAM_ID: keeperDeployment.duelMarketProgramId",
    );
    expect(launcherSource).toContain(
      'path.join(hyperbetKeeperDir, "src/duelBot.ts")',
    );
    expect(launcherSource).not.toContain('"keeper:duel"');
    expect(launcherSource).not.toContain('"keeper:bot"');
    expect(launcherSource).toContain(
      'BOT_LOOP: process.env.DUEL_KEEPER_BOT_LOOP || "true"',
    );
    expect(launcherSource).toContain(
      'HYPERBET_LOCAL_DIAGNOSTIC_FEED: manageLocalSolana ? "true" : "false"',
    );
    expect(launcherSource).toContain(
      "SOLANA_ORACLE_DISPUTE_WINDOW_SECS: localOracleDisputeWindowSeconds",
    );
    expect(launcherSource).toContain("ORACLE_CONFIG_AUTHORITY_KEYPAIR:");
    expect(launcherSource).toContain("CLOB_CONFIG_AUTHORITY_KEYPAIR:");
  });

  it("keeps the game origin, backend origin, and browser app origin distinct", () => {
    expect(
      resolveHyperbetRuntimeTopology({
        gameServerUrl: "http://127.0.0.1:5555/",
        hyperbetApiUrl: "http://localhost:8080",
        bettingPort: 4179,
      }),
    ).toEqual({
      gameOrigin: "http://127.0.0.1:5555",
      hyperbetApiUrl: "http://localhost:8080",
      hyperbetAppUrl: "http://localhost:4179",
      streamStateSourceUrl: "http://127.0.0.1:5555/api/streaming/state",
      bettingFeedStateUrl: "http://127.0.0.1:5555/api/internal/bet-sync/state",
      bettingFeedEventsUrl:
        "http://127.0.0.1:5555/api/internal/bet-sync/events",
    });
    expect(() =>
      normalizeHttpServiceUrl(
        "https://user:secret@example.test/path?token=secret",
        "service",
      ),
    ).toThrow();
  });

  it("isolates the managed local SOL service index from the terminal ledger", () => {
    expect(
      resolveHyperbetKeeperDatabaseTopology({
        managedLocalSolana: false,
        terminalDbPath: "/runtime/keeper.sqlite",
      }),
    ).toEqual({
      terminalDbPath: "/runtime/keeper.sqlite",
      serviceDbPath: "/runtime/keeper.sqlite",
    });
    expect(
      resolveHyperbetKeeperDatabaseTopology({
        managedLocalSolana: true,
        terminalDbPath: "/runtime/keeper.sqlite",
      }),
    ).toEqual({
      terminalDbPath: "/runtime/keeper.sqlite",
      serviceDbPath: "/runtime/service.sqlite",
    });
    expect(() =>
      resolveHyperbetKeeperDatabaseTopology({
        managedLocalSolana: true,
        terminalDbPath: "/runtime/keeper.sqlite",
        configuredServiceDbPath: "/runtime/keeper.sqlite",
      }),
    ).toThrow("must not share");
    expect(launcherSource).toContain("KEEPER_DB_PATH: keeperServiceDbPath");
    expect(launcherSource).toContain("KEEPER_DB_PATH: keeperDbPath");
  });

  it("requires a high-entropy private feed token and never substitutes the viewer token", () => {
    const generated = "a".repeat(64);
    expect(
      resolvePrivateBettingFeedToken(["", undefined], () => generated),
    ).toEqual({ token: generated, generated: true });
    expect(
      resolvePrivateBettingFeedToken(["b".repeat(32)], () => generated),
    ).toEqual({ token: "b".repeat(32), generated: false });
    expect(() =>
      resolvePrivateBettingFeedToken(["too-short"], () => generated),
    ).toThrow("at least 32 bytes");
  });

  it("creates a private local JWT secret and rejects unsupported server runtimes", () => {
    const generated = "c".repeat(64);
    expect(
      resolvePrivateRuntimeSecret(
        ["", undefined],
        () => generated,
        "The local duel JWT secret",
      ),
    ).toEqual({ token: generated, generated: true });
    expect(() =>
      resolvePrivateRuntimeSecret(
        ["too-short"],
        () => generated,
        "The local duel JWT secret",
      ),
    ).toThrow("at least 32 bytes");
    expect(() =>
      resolvePrivateRuntimeSecret(
        [` ${"d".repeat(32)}`],
        () => generated,
        "The distributed authentication rate-limit key",
      ),
    ).toThrow("must not contain outer whitespace");

    expect(
      resolveJwtRuntimeSecret(
        [JSON.stringify({ current: generated })],
        ["", undefined],
        () => {
          throw new Error("must not generate a legacy bridge");
        },
      ),
    ).toEqual({
      token: "",
      generated: false,
      keyRingConfigured: true,
    });
    expect(
      resolveJwtRuntimeSecret(
        [JSON.stringify({ current: generated })],
        ["d".repeat(32)],
        () => generated,
      ),
    ).toEqual({
      token: "d".repeat(32),
      generated: false,
      keyRingConfigured: true,
    });
    expect(() =>
      resolveJwtRuntimeSecret(
        [JSON.stringify({ current: generated })],
        ["too-short"],
        () => generated,
      ),
    ).toThrow("legacy duel JWT secret must contain at least 32 bytes");

    expect(assertSupportedUwsNodeVersion("v22.23.2")).toBe("22.23.2");
    expect(() => assertSupportedUwsNodeVersion("v22.23.1")).toThrow(
      "requires Node.js 22.23.2 exactly",
    );
    expect(() => assertSupportedUwsNodeVersion("v24.19.0")).toThrow(
      "requires Node.js 22.23.2 exactly",
    );
    expect(() => assertSupportedUwsNodeVersion("v25.2.1")).toThrow(
      "requires Node.js 22.23.2 exactly",
    );
    expect(() => assertSupportedUwsNodeVersion("not-a-version")).toThrow(
      "requires Node.js 22.23.2 exactly",
    );

    expect(launcherSource).toContain("JWT_SECRET: jwtCredential.token");
    expect(launcherSource).not.toMatch(/log\([^;]*jwtCredential\.token/s);
    expect(launcherSource).toContain("STREAMING_DUEL_SCHEDULER_ROLE:");
    expect(launcherSource).not.toContain("STREAMING_DUEL_ROLE:");
    expect(launcherSource).toContain(
      'configuredLocalPostgresPassword || "hyperia_dev_password"',
    );
    expect(launcherSource).toContain(
      "databaseConfiguration.useManagedLocalPostgres",
    );
  });

  it("falls back to verified model-free sparbots when no provider key exists", () => {
    expect(hasConfiguredDuelModelProvider({})).toBe(false);
    expect(
      hasConfiguredDuelModelProvider({ OPENAI_API_KEY: "  configured  " }),
    ).toBe(true);
    expect(hasConfiguredDuelModelProvider({ OPENAI_API_KEY: "   " })).toBe(
      false,
    );

    const sparbots = {
      success: true,
      spawned: [
        {
          characterId: "sparbot-standalone-a",
          name: "Riven Ash",
          tier: "adept",
        },
        {
          characterId: "sparbot-standalone-b",
          name: "Astra Vale",
          tier: "adept",
        },
      ],
    };
    expect(isStandaloneSparbotBootstrap(sparbots, 2)).toBe(true);
    expect(isStandaloneSparbotBootstrap(sparbots, 3)).toBe(false);
    expect(
      isStandaloneSparbotBootstrap(
        {
          ...sparbots,
          spawned: [{ ...sparbots.spawned[0], characterId: "model-agent" }],
        },
        1,
      ),
    ).toBe(false);

    expect(launcherSource).toContain("`${serverUrl}/admin/sparbots`");
    expect(launcherSource).toContain('"x-admin-code": adminCode');
    expect(launcherSource).toContain(
      "await seedStandaloneSparbots(\n        serverHttpUrl,",
    );
    expect(launcherSource).not.toMatch(/log\([^;]*adminCredential\.token/s);
  });

  it("fails before startup when standalone sparbots lack the exact no-money diagnostic boundary", () => {
    const validEnvironment = {
      NODE_ENV: "production",
      DUEL_LOCAL_SMOKE_MODE: "true",
      LOAD_TEST_MODE: "true",
      DUEL_BETTING_ENABLED: "false",
      DUEL_WITH_HYPERBET: "false",
      DUEL_HYPERBET_READ_ONLY_MODE: "false",
      STREAMING_DUEL_SCHEDULER_ROLE: "authority",
      PUBLIC_API_URL: "http://127.0.0.1:5555",
      PUBLIC_WS_URL: "ws://[::1]:5556/ws",
    };

    expect(
      assertStandaloneSparbotRuntimeBoundary({
        enabled: false,
        environment: {},
      }),
    ).toBe(false);
    expect(
      assertStandaloneSparbotRuntimeBoundary({
        enabled: true,
        environment: validEnvironment,
      }),
    ).toBe(true);
    expect(
      assertStandaloneSparbotRuntimeBoundary({
        enabled: true,
        environment: {
          ...validEnvironment,
          DUEL_WITH_HYPERBET: "true",
          DUEL_LOCAL_SOLANA_MODE: "true",
          SOLANA_RPC_URL: "http://127.0.0.1:18899",
        },
      }),
    ).toBe(true);
    expect(() =>
      assertStandaloneSparbotRuntimeBoundary({
        enabled: true,
        environment: {
          ...validEnvironment,
          DUEL_WITH_HYPERBET: "true",
          DUEL_LOCAL_SOLANA_MODE: "true",
          SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
        },
      }),
    ).toThrow("Standalone scripted sparbots require");
    expect(
      assertStandaloneSparbotRuntimeBoundary({
        enabled: true,
        environment: {
          ...validEnvironment,
          DUEL_WITH_HYPERBET: "true",
          DUEL_HYPERBET_READ_ONLY_MODE: "true",
        },
      }),
    ).toBe(true);

    for (const [name, value] of [
      ["NODE_ENV", "development"],
      ["DUEL_LOCAL_SMOKE_MODE", "false"],
      ["LOAD_TEST_MODE", "false"],
      ["DUEL_BETTING_ENABLED", "true"],
      ["DUEL_WITH_HYPERBET", "true"],
      ["STREAMING_DUEL_SCHEDULER_ROLE", "replica"],
      ["PUBLIC_API_URL", "https://arena.example"],
      ["PUBLIC_WS_URL", "wss://arena.example/ws"],
    ]) {
      expect(
        () =>
          assertStandaloneSparbotRuntimeBoundary({
            enabled: true,
            environment: { ...validEnvironment, [name]: value },
          }),
        name,
      ).toThrow("Standalone scripted sparbots require");
    }

    const assertionIndex = launcherSource.indexOf(
      "assertStandaloneSparbotRuntimeBoundary({",
    );
    const secretIndex = launcherSource.indexOf(
      "const bettingFeedCredential = resolvePrivateBettingFeedToken(",
    );
    const hlsMutationIndex = launcherSource.indexOf(
      "prepareHlsOutput(hlsOutputPath);",
    );
    const serverStartIndex = launcherSource.indexOf(
      'log("starting the native SOL duel server")',
    );
    expect(assertionIndex).toBeGreaterThan(0);
    expect(assertionIndex).toBeLessThan(hlsMutationIndex);
    expect(assertionIndex).toBeLessThan(secretIndex);
    expect(assertionIndex).toBeLessThan(serverStartIndex);
    expect(launcherSource).toContain('"local-smoke": { type: "boolean" }');
    expect(launcherSource).toContain(
      "DUEL_WITH_HYPERBET: effectiveDuelWithHyperbet",
    );
    expect(launcherSource).toContain(
      "DUEL_LOCAL_SMOKE_MODE: effectiveDuelLocalSmokeMode",
    );
    expect(launcherSource).toContain("LOAD_TEST_MODE: effectiveLoadTestMode");
    expect(launcherSource).toContain(
      "DUEL_LOCAL_BROWSER_ORIGIN: localSmokeBrowserOrigin",
    );
    expect(launcherSource).toContain(
      '"The local-smoke game client URL must use an exact loopback hostname"',
    );
    expect(launcherSource).toContain('(localSmokeRequested ? "5000" : "")');
    expect(launcherSource).toContain(
      "STREAMING_DUEL_PREPARATION_MS: effectiveDuelPreparationMs",
    );
  });

  it("owns transaction-enabled local SOL only behind an explicit loopback boundary", () => {
    const validBoundary = {
      enabled: true,
      hyperbetRuntimeEnabled: true,
      remoteBettingMode: false,
      hyperbetReadOnlyMode: false,
      rpcUrl: "http://127.0.0.1:18899",
    };
    expect(assertManagedLocalSolanaBoundary(validBoundary)).toBe(true);
    expect(
      assertManagedLocalSolanaBoundary({
        ...validBoundary,
        enabled: false,
        hyperbetRuntimeEnabled: false,
      }),
    ).toBe(false);
    for (const override of [
      { hyperbetRuntimeEnabled: false },
      { remoteBettingMode: true },
      { hyperbetReadOnlyMode: true },
      { rpcUrl: "https://api.mainnet-beta.solana.com" },
    ]) {
      expect(() =>
        assertManagedLocalSolanaBoundary({ ...validBoundary, ...override }),
      ).toThrow("Managed local Solana requires");
    }

    const boundaryIndex = launcherSource.indexOf(
      "assertManagedLocalSolanaBoundary({",
    );
    const localnetStartIndex = launcherSource.indexOf(
      "await startManagedLocalSolana();",
    );
    const hlsMutationIndex = launcherSource.indexOf(
      "prepareHlsOutput(hlsOutputPath);",
    );
    expect(boundaryIndex).toBeGreaterThan(0);
    expect(localnetStartIndex).toBeGreaterThan(boundaryIndex);
    expect(localnetStartIndex).toBeLessThan(hlsMutationIndex);
    expect(launcherSource).toContain('"local-solana": { type: "boolean" }');
    expect(launcherSource).toContain('"--upgradeable-program"');
    expect(launcherSource).toContain('spawnManaged(\n    "solana-localnet"');
    expect(launcherSource).toContain("ownedRuntimePaths.push(ledgerDir)");
    expect(launcherSource).toContain(
      "ownedRuntimePaths.push(managedLocalHyperbetRuntimeDir)",
    );
    expect(launcherSource).toContain(
      "VITE_SOLANA_RPC_URL: keeperRpcUrl || defaultSolanaRpcUrl(keeperCluster)",
    );
    expect(launcherSource).toContain(
      '(keeperCluster === "localnet" ? localSolanaWsUrl : "")',
    );
    expect(launcherSource).toContain(
      'input.scriptPath,\n    "--cluster",\n    "localnet"',
    );
    expect(launcherSource).toContain(
      "const browserWallet = Keypair.generate()",
    );
    expect(launcherSource).toContain("connection.requestAirdrop(");
    expect(launcherSource).toContain("VITE_HEADLESS_WALLET_SECRET_KEY:");
    expect(launcherSource).toContain(
      'VITE_HEADLESS_WALLET_NAME: "Full Topology Test Wallet"',
    );
    expect(launcherSource).toContain('"--hyperbet-local-transactions",');
    expect(launcherSource).toContain('"--expected-local-wallet",');
    expect(launcherSource).toContain('"--duel-market-program-id",');
  });

  it("keeps world-owner hard-kill injection inside the owned localnet smoke", () => {
    const validBoundary = {
      enabled: true,
      fresh: true,
      isolated: true,
      verify: true,
      localSmoke: true,
      localSolana: true,
      serverUrl: "http://127.0.0.1:35551",
      rpcUrl: "http://127.0.0.1:35800",
      pidFile: "/tmp/owned-game-server.json",
    };
    expect(assertAuthorityRestartDiagnosticBoundary(validBoundary)).toBe(true);
    for (const override of [
      { fresh: false },
      { isolated: false },
      { verify: false },
      { localSmoke: false },
      { localSolana: false },
      { serverUrl: "https://game.example" },
      { rpcUrl: "https://api.mainnet-beta.solana.com" },
      { pidFile: "" },
    ]) {
      expect(() =>
        assertAuthorityRestartDiagnosticBoundary({
          ...validBoundary,
          ...override,
        }),
      ).toThrow("Authority restart injection requires");
    }
    expect(
      assertAuthorityRestartDiagnosticBoundary({
        ...validBoundary,
        enabled: false,
      }),
    ).toBe(false);
    expect(
      shouldReleaseRestartedAuthorityStartupGate({
        authorityRecoveryEnabled: true,
        launcherOwnsStartupGate: true,
        generation: 1,
      }),
    ).toBe(false);
    expect(
      shouldReleaseRestartedAuthorityStartupGate({
        authorityRecoveryEnabled: true,
        launcherOwnsStartupGate: true,
        generation: 2,
      }),
    ).toBe(true);
    expect(
      shouldReleaseRestartedAuthorityStartupGate({
        authorityRecoveryEnabled: false,
        launcherOwnsStartupGate: true,
        generation: 2,
      }),
    ).toBe(false);
    expect(
      shouldReleaseRestartedAuthorityStartupGate({
        authorityRecoveryEnabled: true,
        launcherOwnsStartupGate: false,
        generation: 2,
      }),
    ).toBe(false);
    expect(() =>
      shouldReleaseRestartedAuthorityStartupGate({
        authorityRecoveryEnabled: true,
        launcherOwnsStartupGate: true,
        generation: 0,
      }),
    ).toThrow("positive integer");
    expect(launcherSource).toContain("releaseRestartedAuthorityStartupGate");
  });

  it("resolves an explicit, deterministic combat style for every standalone sparbot", () => {
    expect(resolveStandaloneSparbotStyles("melee", 2)).toEqual([
      "melee",
      "melee",
    ]);
    expect(resolveStandaloneSparbotStyles("", 6)).toEqual([
      "melee",
      "ranged",
      "mage",
      "prayer",
      "melee",
      "ranged",
    ]);
    expect(resolveStandaloneSparbotStyles("AUTO", 2)).toEqual([
      "melee",
      "ranged",
    ]);
    expect(resolveStandaloneSparbotStyles("RANGED", 3)).toEqual([
      "ranged",
      "ranged",
      "ranged",
    ]);
    expect(resolveStandaloneSparbotStyles("ranged, mage", 2)).toEqual([
      "ranged",
      "mage",
    ]);
    expect(() => resolveStandaloneSparbotStyles("ranged,mage", 3)).toThrow(
      "exactly 3",
    );
    expect(() => resolveStandaloneSparbotStyles("ranged,unknown", 2)).toThrow(
      "melee, ranged, mage, prayer",
    );
    expect(() => resolveStandaloneSparbotStyles("melee", 21)).toThrow(
      "1 to 20",
    );

    expect(launcherSource).toContain('options["bot-styles"]');
    expect(launcherSource).toContain(
      'default: process.env.DUEL_BOT_STYLES || "auto"',
    );
    expect(launcherSource).toContain(
      "standalone scripted sparbots ready (${count}/${count}; ${styles.join",
    );
    expect(launcherSource).toContain(
      'process.env.STREAMING_DUEL_COMBAT_AI_ENABLED || "true"',
    );
    expect(launcherSource).not.toContain(
      'process.env.STREAMING_DUEL_COMBAT_AI_ENABLED || "false"',
    );
  });

  it("admits repeatable sparbot profiles only in the local-smoke lane", () => {
    expect(
      resolveStandaloneSparbotProfileSeed("", {
        enabled: true,
        localSmoke: true,
      }),
    ).toBeNull();
    expect(
      resolveStandaloneSparbotProfileSeed(" 0 ", {
        enabled: true,
        localSmoke: true,
      }),
    ).toBe(0);
    expect(
      resolveStandaloneSparbotProfileSeed("4294967295", {
        enabled: true,
        localSmoke: true,
      }),
    ).toBe(0xffffffff);

    for (const configured of ["-1", "1.5", "4294967296", "seed"] as const) {
      expect(() =>
        resolveStandaloneSparbotProfileSeed(configured, {
          enabled: true,
          localSmoke: true,
        }),
      ).toThrow("unsigned 32-bit integer");
    }
    expect(() =>
      resolveStandaloneSparbotProfileSeed("7", {
        enabled: false,
        localSmoke: true,
      }),
    ).toThrow("local-smoke no-money diagnostic lane");
    expect(() =>
      resolveStandaloneSparbotProfileSeed("7", {
        enabled: true,
        localSmoke: false,
      }),
    ).toThrow("local-smoke no-money diagnostic lane");

    expect(launcherSource).toContain('"sparbot-profile-seed": {');
    expect(launcherSource).toContain("DUEL_SPARBOT_PROFILE_SEED");
    expect(launcherSource).toContain("standaloneSparbotProfileSeed");
    expect(launcherSource).toContain(
      "...(profileSeed == null ? {} : { profileSeed })",
    );
  });

  it("keeps multi-style sparbots inside the explicit local no-money lane", () => {
    expect(
      assertMultiStyleSparbotOptions({
        enabled: false,
        localSmoke: false,
        styles: ["prayer"],
      }),
    ).toBe(false);
    expect(
      assertMultiStyleSparbotOptions({
        enabled: true,
        localSmoke: true,
        styles: ["melee", "ranged"],
      }),
    ).toBe(true);
    expect(() =>
      assertMultiStyleSparbotOptions({
        enabled: true,
        localSmoke: false,
        styles: ["melee", "ranged"],
      }),
    ).toThrow("local smoke mode");
    expect(() =>
      assertMultiStyleSparbotOptions({
        enabled: true,
        localSmoke: true,
        styles: ["melee", "prayer"],
      }),
    ).toThrow("melee/ranged/mage");
    expect(launcherSource).toContain(
      '"multi-style-sparbots": { type: "boolean" }',
    );
    expect(launcherSource).toContain("multiStyleSparbots");
    expect(launcherSource).toContain("multiStyle,");
  });

  it("validates authenticated bootstrap, fresh source sync, and fresh keeper health", () => {
    const bootstrap = {
      schemaVersion: 3,
      sourceEpoch: 100,
      seq: 3,
      emittedAt: 2_000,
      replay: { sourceEpoch: 100 },
    };
    expect(isBettingFeedBootstrap(bootstrap)).toBe(true);
    expect(isBettingFeedBootstrap({ ...bootstrap, schemaVersion: 1 })).toBe(
      false,
    );

    const status = {
      service: "hyperbet-solana-backend",
      stream: {
        sourceUrl: "http://127.0.0.1:5555/api/streaming/state",
        lastSourcePollAt: 5_000,
        lastSourceError: null,
        cycleId: "cycle-1",
        seq: 8,
      },
    };
    expect(
      isHyperbetStreamSynchronized(status, {
        sourceUrl: "http://127.0.0.1:5555/api/streaming/state",
        startedAtMs: 4_000,
      }),
    ).toBe(true);
    expect(
      isHyperbetStreamSynchronized(status, {
        sourceUrl: "http://127.0.0.1:5555/api/streaming/state",
        startedAtMs: 5_001,
      }),
    ).toBe(false);

    expect(
      isHyperbetStreamSynchronized(
        {
          ...status,
          stream: {
            ...status.stream,
            cycleId: "",
            phase: "IDLE",
          },
        },
        {
          sourceUrl: "http://127.0.0.1:5555/api/streaming/state",
          startedAtMs: 4_000,
        },
      ),
    ).toBe(true);
    expect(
      isHyperbetStreamSynchronized(
        {
          ...status,
          stream: {
            ...status.stream,
            cycleId: "boot-cycle",
            phase: "IDLE",
          },
        },
        {
          sourceUrl: "http://127.0.0.1:5555/api/streaming/state",
          startedAtMs: 4_000,
        },
      ),
    ).toBe(false);

    const readiness = {
      ok: true,
      readiness: { ready: true, reasons: [] },
      health: { running: true, bootedAtMs: 8_000 },
    };
    expect(isFreshHyperbetReadiness(readiness, 7_000)).toBe(true);
    expect(isFreshHyperbetReadiness(readiness, 8_001)).toBe(false);
  });

  it("strips signing authorities from the read-only backend environment", () => {
    expect(
      omitEnvironmentKeys(
        {
          PATH: "/bin",
          HELIUS_API_KEY: "server-provider-secret",
          KEEPER_FEE_PAYER_KEYPAIR: "authority-secret",
        },
        ["KEEPER_FEE_PAYER_KEYPAIR"],
      ),
    ).toEqual({
      PATH: "/bin",
      HELIUS_API_KEY: "server-provider-secret",
    });
  });

  it("boots the backend before the app, routes the UI through it, and gates private feed auth", () => {
    const backendSpawn = launcherSource.indexOf('"hyperbet-backend"');
    const appSpawn = launcherSource.indexOf('"betting-app"');
    expect(backendSpawn).toBeGreaterThan(0);
    expect(appSpawn).toBeGreaterThan(backendSpawn);
    expect(launcherSource).toContain(
      "VITE_GAME_API_URL: hyperbetTopology.hyperbetApiUrl",
    );
    expect(launcherSource).toContain("verifyAuthenticatedBettingFeed(");
    expect(launcherSource).toContain("BET_SYNC_SOURCE_BEARER_TOKEN:");
    expect(launcherSource).toContain("isHyperbetStreamSynchronized(");
    expect(launcherSource).toContain("isFreshHyperbetReadiness(");
    expect(launcherSource).toContain(
      'VITE_TRANSACTIONS_ENABLED: hyperbetReadOnlyMode ? "false" : "true"',
    );
    expect(launcherSource).toContain('STREAMING_CANONICAL_PLATFORM: "hls"');
    expect(launcherSource).toContain("STREAMING_CANONICAL_SOURCE_URL: hlsUrl");
    expect(launcherSource).toContain("VITE_STREAM_URL: hlsUrl");
    expect(launcherSource).toContain(
      "HLS_PUBLIC_DIR: path.dirname(hlsOutputPath)",
    );
    expect(launcherSource).toContain("hyperia-duel-hls-");
    expect(launcherSource).toContain("VITE_UI_SYNC_DELAY_MS:");
    expect(launcherSource).toContain("process.env.VITE_UI_SYNC_DELAY_MS ||");
    expect(launcherSource).toContain('"8000"');
    expect(launcherSource).not.toContain(
      "VITE_STREAM_URL: process.env.VITE_STREAM_URL",
    );
    expect(launcherSource).toContain(
      'verifyArgs.push("--hyperbet-api-url", hyperbetTopology.hyperbetApiUrl)',
    );
    expect(launcherSource).toContain('verifyArgs.push("--hyperbet-read-only")');
    expect(launcherSource).toContain(
      '"read-only Hyperbet authoritative stream readiness"',
    );
    expect(launcherSource).toMatch(
      /if \(hyperbetReadOnlyMode\) \{[\s\S]*?isHyperbetStreamSynchronized\([\s\S]*?\} else \{[\s\S]*?"combined Hyperbet launch readiness"/,
    );
  });

  it("contains no retired token or perps launcher configuration", () => {
    expect(launcherSource).not.toMatch(/SOLANA_GOLD|GOLD_MINT|KEEPER_PERPS/);
    expect(launcherSource).not.toMatch(/ENABLE_PERPS|includeKeeperPerps/);
  });
});
