import { defineConfig, devices } from "@playwright/test";

const CLIENT_PORT = Number(process.env.VITE_PORT ?? 3333);
const SERVER_PORT = Number(process.env.PORT ?? 5555);
const IS_LINUX = process.platform === "linux";
const IS_MAC = process.platform === "darwin";
const DEFAULT_LINUX_WEBGPU_ARGS = [
  "--use-gl=angle",
  "--use-angle=vulkan",
  "--ozone-platform=x11",
  "--enable-features=DefaultANGLEVulkan,Vulkan,VulkanFromANGLE,WebGPU,UnsafeWebGPU,WebGPUDeveloperFeatures",
  "--ignore-gpu-blocklist",
];
const DEFAULT_MAC_WEBGPU_ARGS = [
  "--use-angle=metal",
  "--enable-features=WebGPU,UnsafeWebGPU,WebGPUDeveloperFeatures",
];
const EXTRA_WEBGPU_ARGS = (process.env.PW_WEBGPU_ARGS ?? "")
  .split(" ")
  .map((arg) => arg.trim())
  .filter(Boolean);
const WEBGPU_LAUNCH_ARGS = [
  ...(IS_LINUX
    ? DEFAULT_LINUX_WEBGPU_ARGS
    : IS_MAC
      ? DEFAULT_MAC_WEBGPU_ARGS
      : []),
  ...EXTRA_WEBGPU_ARGS,
];

// Explicit local movement qualification only. The default suite stays unchanged.
const NATIVE_MOVEMENT = process.env.PW_NATIVE_MOVEMENT === "true";
const NATIVE_MOVEMENT_TITLE =
  /moves to a visible ground tile through actual canvas input$/;
const nativeContainer = process.env.POSTGRES_CONTAINER ?? "";
if (NATIVE_MOVEMENT) {
  if (!IS_MAC || Number(process.versions.node.split(".")[0]) !== 22)
    throw new Error("Native movement requires macOS and Node.js 22");
  if (CLIENT_PORT !== 3333 || SERVER_PORT !== 5555)
    throw new Error("Native movement uses loopback ports 3333/5555/5556");
  if (
    !/^hyperia-native-movement-[a-z0-9][a-z0-9-]{0,63}$/.test(nativeContainer)
  )
    throw new Error(
      "A unique POSTGRES_CONTAINER for native movement is required",
    );
  if (EXTRA_WEBGPU_ARGS.length)
    throw new Error("Native movement does not accept extra GPU launch flags");
  if (
    (process.env.TEST_URL &&
      process.env.TEST_URL !== "http://localhost:3333") ||
    (process.env.TEST_SERVER_URL &&
      process.env.TEST_SERVER_URL !== "http://localhost:5555")
  )
    throw new Error(
      "Native movement cannot target an external or streaming URL",
    );
}

const nativeEnvironment = {
  // Empty, not unset: dotenv must not restore a personal/external database URL.
  DATABASE_URL: "",
  USE_LOCAL_POSTGRES: "true",
  NODE_ENV: "development",
  POSTGRES_CONTAINER: nativeContainer,
  POSTGRES_DB: "hyperia_native_movement",
  POSTGRES_PORT: "57832",
  POSTGRES_POOL_MAX: "4",
  POSTGRES_POOL_MIN: "1",
  PORT: "5555",
  UWS_PORT: "5556",
  UWS_ENABLED: "true",
  WORLD: "world",
  PLAYWRIGHT_TEST: "true",
  PUBLIC_PRIVY_APP_ID: "your-privy-app-id",
  PUBLIC_API_URL: "http://localhost:5555",
  PUBLIC_WS_URL: "ws://localhost:5556/ws",
  PUBLIC_CDN_URL: "http://localhost:5555/game-assets",
  PUBLIC_APP_URL: "http://localhost:3333",
  AUTO_START_AGENTS: "false",
  SPAWN_MODEL_AGENTS: "false",
  DISABLE_AI: "true",
  DISABLE_BOTS: "true",
  DUEL_BETTING_ENABLED: "false",
  DUEL_ARENA_ORACLE_ENABLED: "false",
  WEB3_ENABLED: "false",
  STREAMING_DUEL_ENABLED: "false",
  STREAMING_CAPTURE_ENABLED: "false",
  DUEL_SERVER_AGENT_MODE: "external-only",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  GROQ_API_KEY: "",
};

// Playwright sets FORCE_COLOR; if NO_COLOR is also present it emits noisy startup warnings.
delete process.env.NO_COLOR;

/**
 * Playwright Configuration for Client Tests
 *
 * Tests run against real Hyperia instances - NO MOCKS.
 * Uses visual testing with colored cube proxies per project rules.
 *
 * Supports two test categories:
 *   1. Web3 Login tests (web3-login.spec.ts) — headless wallet injection via
 *      headless-web3-provider + Phantom mock. No browser extensions needed.
 *   2. Game E2E tests (auth.spec.ts, combat.spec.ts, etc.) — full game testing.
 *
 * Run all:       bunx playwright test
 * Run web3:      bunx playwright test tests/e2e/web3-login.spec.ts
 * Run auth:      bunx playwright test tests/e2e/auth.spec.ts
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  timeout: 120000, // 2 minutes per test
  expect: {
    timeout: 15000,
  },
  fullyParallel: false, // Run tests sequentially for reliable screenshots
  workers: 1,
  retries: NATIVE_MOVEMENT ? 0 : process.env.CI ? 2 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? [
        ["html", { open: "never", outputFolder: "playwright-report" }],
        ["github"],
      ]
    : [
        ["list"],
        ["html", { open: "never", outputFolder: "playwright-report" }],
      ],
  use: {
    // WebGPU is required; run headed browser sessions for all E2E tests.
    headless: false,
    launchOptions: WEBGPU_LAUNCH_ARGS.length
      ? { args: WEBGPU_LAUNCH_ARGS }
      : undefined,
    // Base URL for the client
    baseURL: `http://localhost:${CLIENT_PORT}`,
    // Capture trace on first retry
    trace: "on-first-retry",
    // Screenshot on failure
    screenshot: "only-on-failure",
    // Video on failure
    video: "on-first-retry",
    // Action and navigation timeouts
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: NATIVE_MOVEMENT
    ? [
        {
          name: "native-movement",
          testMatch: "navigation.spec.ts",
          grep: NATIVE_MOVEMENT_TITLE,
          use: {
            ...devices["Desktop Chrome"],
            channel: "chrome",
            headless: false,
            viewport: { width: 1280, height: 720 },
            deviceScaleFactor: 1,
            trace: "on",
            video: "off",
          },
        },
      ]
    : [
        {
          name: "chromium",
          use: { ...devices["Desktop Chrome"] },
        },
        {
          name: "mobile-chrome",
          use: { ...devices["Pixel 5"] },
        },
      ],
  // Auto-start dev servers before tests
  webServer: NATIVE_MOVEMENT
    ? [
        {
          name: "native-movement-server",
          command: `exec ${JSON.stringify(process.execPath)} --import ./scripts/register-hooks.mjs ../../scripts/native-movement-server.mjs`,
          cwd: "../server",
          env: nativeEnvironment,
          port: SERVER_PORT,
          reuseExistingServer: false,
          timeout: 120_000,
          stdout: "pipe",
          stderr: "pipe",
          // Playwright may force-kill after this deadline. Exit/owned-PID/DB proof
          // must still be checked externally; this setting is not cleanup approval.
          gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
        },
        {
          name: "native-movement-client",
          command: `exec ${JSON.stringify(process.execPath)} node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3333 --strictPort --logLevel error`,
          env: { ...nativeEnvironment, E2E_DISABLE_SHARED_WATCH: "true" },
          url: "http://localhost:3333",
          reuseExistingServer: false,
          timeout: 300_000,
          stdout: "pipe",
          stderr: "pipe",
          gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
        },
      ]
    : [
        // Start the game server
        {
          command:
            "env -u NO_COLOR PLAYWRIGHT_TEST=true PLAYWRIGHT_FORCE_GC=true WS_PING_INTERVAL_SEC=1 WS_PING_MISS_TOLERANCE=1 WS_PING_GRACE_MS=0 TEST_IDLE_SOCKET_TTL_MS=15000 TEST_PENDING_READY_TTL_MS=12000 TEST_MAX_SOCKET_COUNT=8 RECONNECT_GRACE_MS=0 COMBAT_LOGOUT_DELAY_MS=0 AUTO_START_AGENTS=false SPAWN_MODEL_AGENTS=false DISABLE_AI=true DISABLE_BOTS=true DUEL_BETTING_ENABLED=false node --import ./scripts/register-hooks.mjs ./dist/index.js",
          cwd: "../server",
          port: SERVER_PORT,
          timeout: 120 * 1000,
          reuseExistingServer: true,
        },
        // Start the client
        {
          command: `env -u NO_COLOR PLAYWRIGHT_TEST=true E2E_DISABLE_SHARED_WATCH=true PUBLIC_PRIVY_APP_ID=your-privy-app-id node node_modules/vite/bin/vite.js --host --port ${CLIENT_PORT} --strictPort --logLevel error`,
          url: `http://localhost:${CLIENT_PORT}`,
          reuseExistingServer: true,
          timeout: 300000, // 5 minutes
          stdout: "pipe",
          stderr: "pipe",
        },
      ],
});
