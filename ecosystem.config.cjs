/**
 * PM2 Ecosystem Config – Hyperia Duel Stack
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs          # start
 *   pm2 restart ecosystem.config.cjs        # restart all
 *   pm2 stop ecosystem.config.cjs           # stop all
 *   pm2 delete ecosystem.config.cjs         # remove from pm2
 *   pm2 logs hyperia-duel                # tail logs
 *
 * The duel-stack.mjs orchestrator already manages sub-processes internally
 * (game server, client, bots, RTMP bridge, betting app, keeper bot).
 * If ANY critical sub-process dies, the orchestrator tears everything down
 * and exits with code 1. PM2 then restarts it from scratch, giving us an
 * infinite self-healing loop.
 */

// ── Load deploy-time secrets into process.env ─────────────────────────────
// bunx pm2 may not inherit the deploy shell's exported env vars, so we
// read the secrets file directly to ensure DATABASE_URL et al. are present.
const fs = require("fs");
const SECRETS_FILES = [
  "/tmp/hyperia-secrets.env",
  require("path").join(__dirname, ".env.production"),
];
for (const secretsPath of SECRETS_FILES) {
  try {
    if (fs.existsSync(secretsPath)) {
      const lines = fs.readFileSync(secretsPath, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx < 1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  } catch {
    /* ignore missing/unreadable files */
  }
}

// Auto-detect DUEL_DATABASE_MODE from DATABASE_URL so sanitizeRuntimeEnv()
// doesn't strip it when the mode defaults to "local".
if (!process.env.DUEL_DATABASE_MODE && process.env.DATABASE_URL) {
  try {
    const dbHost = new URL(process.env.DATABASE_URL).hostname;
    const isLocal = ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(
      dbHost,
    );
    process.env.DUEL_DATABASE_MODE = isLocal ? "local" : "remote";
  } catch {
    process.env.DUEL_DATABASE_MODE = "remote";
  }
}

function isLoopbackHostname(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1"
  );
}

function isLocalDatabaseUrl(rawValue) {
  if (!rawValue) return false;
  try {
    return isLoopbackHostname(new URL(rawValue).hostname);
  } catch {
    return false;
  }
}

function sanitizeRuntimeEnv() {
  const requestedDatabaseMode =
    (process.env.DUEL_DATABASE_MODE || "").trim().toLowerCase() || "local";
  const useRemoteDatabase = requestedDatabaseMode === "remote";
  const runtimeEnv = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (!useRemoteDatabase) {
      if (
        key === "DATABASE_URL" ||
        key === "POSTGRES_URL" ||
        key === "USE_LOCAL_POSTGRES"
      ) {
        continue;
      }
    }
    runtimeEnv[key] = value;
  }

  runtimeEnv.DUEL_DATABASE_MODE = useRemoteDatabase ? "remote" : "local";
  runtimeEnv.USE_LOCAL_POSTGRES =
    process.env.USE_LOCAL_POSTGRES || (useRemoteDatabase ? "false" : "true");

  if (!useRemoteDatabase && isLocalDatabaseUrl(process.env.DATABASE_URL)) {
    runtimeEnv.DATABASE_URL = process.env.DATABASE_URL;
  }
  if (useRemoteDatabase && process.env.DATABASE_URL) {
    runtimeEnv.DATABASE_URL = process.env.DATABASE_URL;
  }

  return runtimeEnv;
}

const runtimeEnv = sanitizeRuntimeEnv();

module.exports = {
  apps: [
    {
      name: "hyperia-duel",
      script: "scripts/duel-stack.mjs",
      interpreter: process.env.DUEL_HYPERIA_BUN_PATH || "bun",
      args: "--skip-betting --skip-bots",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 999999,
      min_uptime: "10s",
      restart_delay: 10000,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: "4G",
      error_file: "logs/duel-error.log",
      out_file: "logs/duel-out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        ...runtimeEnv,
        NODE_ENV: "production",
        DISPLAY: process.env.DISPLAY || ":99",
        POSTGRES_POOL_MAX: "20",
        POSTGRES_POOL_MIN: "2",
        SKIP_MIGRATIONS: "true",
        DATABASE_URL: process.env.DATABASE_URL || "",
        USE_LOCAL_POSTGRES:
          process.env.USE_LOCAL_POSTGRES ||
          (process.env.DATABASE_URL ? "false" : "true"),
        STREAMING_DUEL_ENABLED: "true",
        DUEL_BETTING_ENABLED: "false",
        SOLANA_RPC_URL: "https://api.devnet.solana.com",
        SOLANA_WS_URL: "wss://api.devnet.solana.com/",
        ORACLE_SETTLEMENT_DELAY_MS: "7000",
        SOLANA_ARENA_MARKET_PROGRAM_ID:
          process.env.SOLANA_ARENA_MARKET_PROGRAM_ID ||
          "9NdidShnVzy1fc1WHWJTvyuXmH47ynfNGA6QFdyfAuSU",
        PUBLIC_CDN_URL:
          process.env.PUBLIC_CDN_URL || "https://assets.hyperia.club",
        DISABLE_RATE_LIMIT: "false",
        HYPERIA_SOL_AGENT_AUTH_ENABLED:
          process.env.HYPERIA_SOL_AGENT_AUTH_ENABLED || "false",
        HYPERIA_SOL_AGENT_AUTH_DOMAIN:
          process.env.HYPERIA_SOL_AGENT_AUTH_DOMAIN || "",
        HYPERIA_SOL_AGENT_AUTH_ORIGIN:
          process.env.HYPERIA_SOL_AGENT_AUTH_ORIGIN || "",
        HYPERIA_SOL_AGENT_AUTH_CLUSTER:
          process.env.HYPERIA_SOL_AGENT_AUTH_CLUSTER || "",
        HYPERIA_SOL_AGENT_AUTH_TTL_SECONDS:
          process.env.HYPERIA_SOL_AGENT_AUTH_TTL_SECONDS || "",
        ALLOW_DESTRUCTIVE_CHANGES: "false",
        AUTO_START_AGENTS: "true",
        AUTO_START_AGENTS_MAX: "10",
        SPAWN_MODEL_AGENTS: "true",
        MAX_MODEL_AGENTS: "4",
        SPAWN_MODEL_AGENTS_WITH_EMBEDDED: "false",
        MALLOC_TRIM_THRESHOLD_: "-1",
        MIMALLOC_ALLOW_DECOMMIT: "0",
        MIMALLOC_ALLOW_RESET: "0",
        MIMALLOC_PAGE_RESET: "0",
        MIMALLOC_PURGE_DELAY: "1000000",
        STREAM_CAPTURE_MODE: "cdp",
        STREAM_CAPTURE_HEADLESS: "false",
        STREAM_CAPTURE_CHANNEL: "chrome-beta",
        STREAM_CAPTURE_ANGLE: "vulkan",
        STREAM_CAPTURE_WIDTH: "1280",
        STREAM_CAPTURE_HEIGHT: "720",
        STREAM_OUTPUT_WIDTH: "1280",
        STREAM_OUTPUT_HEIGHT: "720",
        FFMPEG_PATH: process.env.FFMPEG_PATH || "ffmpeg",
        TWITCH_STREAM_URL:
          process.env.TWITCH_STREAM_URL || "rtmp://live.twitch.tv/app",
        TWITCH_STREAM_KEY:
          process.env.TWITCH_STREAM_KEY ||
          process.env.TWITCH_RTMP_STREAM_KEY ||
          "",
        KICK_STREAM_KEY: process.env.KICK_STREAM_KEY || "",
        KICK_RTMP_URL:
          process.env.KICK_RTMP_URL ||
          "rtmps://fa723fc1b171.global-contribute.live-video.net/app",
        STREAM_ENABLED_DESTINATIONS:
          process.env.STREAM_ENABLED_DESTINATIONS ||
          process.env.DUEL_STREAM_DESTINATIONS ||
          "",
        YOUTUBE_STREAM_URL:
          process.env.YOUTUBE_STREAM_URL || "rtmp://a.rtmp.youtube.com/live2",
        GAME_URL: "http://localhost:3333/?page=stream",
        GAME_FALLBACK_URLS:
          "http://localhost:3333/?page=stream,http://localhost:3333/?embedded=true&mode=spectator,http://localhost:3333/",
        STREAMING_DUEL_COMBAT_AI_ENABLED: "false",
        SERVER_RUNTIME_MAX_TICKS_PER_FRAME: "1",
        SERVER_RUNTIME_MIN_DELAY_MS: "10",
      },
    },
  ],
};
