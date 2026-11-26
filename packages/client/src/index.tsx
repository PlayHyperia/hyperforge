/**
 * index.tsx - Hyperia Client Entry Point
 * @build 2026-02-25 - Packet sync rebuild
 *
 * Main entry point for the Hyperia browser client. Initializes the React application,
 * authentication, and 3D game world. Handles the complete client lifecycle from login
 * to world connection.
 */

import "./polyfills/buffer-shim";

import {
  CircularSpawnArea,
  installThreeJSExtensions,
  THREE,
  World,
} from "@hyperforge/shared";
import React from "react";
import ReactDOM from "react-dom/client";
import { ErrorBoundary } from "./lib/ErrorBoundary";
import "./index.css";
import { PrivyAuthProvider } from "./auth/PrivyAuthProvider";
import { SolanaWalletProvider } from "./auth/SolanaWalletProvider";
import { playerTokenManager } from "./auth/PlayerTokenManager";
import { privyAuthManager } from "./auth/PrivyAuthManager";
import { injectFarcasterMetaTags } from "./lib/farcaster-frame-config";
import { logger } from "./lib/logger";
import { devValidateManifest } from "./lib/manifestValidator";
import {
  ensurePublicRuntimeEnv,
  isConfiguredPrivyAppId,
  resolvePrivyAppId,
} from "./lib/publicEnv";
import { primeStreamingAccessTokenFromWindow } from "./lib/streamingAccessToken";
import {
  applyHyperiaAuthMessage,
  isTrustedEmbedOrigin,
  parseHyperiaAuthMessage,
  resolveEmbedReadyTargetOrigin,
  resolveTrustedEmbedOrigins,
} from "./lib/embeddedAuth";
import type { StreamingWindow } from "./lib/streamingWindow";
import { MaintenanceBanner } from "./components/common/MaintenanceBanner";
// Loading fallback for lazy-loaded screens
function ScreenLoadingFallback() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        backgroundColor: "#000",
        color: "#f2d08a",
        fontSize: "20px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      Loading...
    </div>
  );
}

// Lazy-loaded screens for code splitting
// These are loaded on-demand, reducing initial bundle size
const GameClient = React.lazy(() =>
  import("./screens/GameClient").then((m) => ({ default: m.GameClient })),
);
const LoginScreen = React.lazy(() =>
  import("./screens/LoginScreen").then((m) => ({ default: m.LoginScreen })),
);
const CharacterSelectScreen = React.lazy(() =>
  import("./screens/CharacterSelectScreen").then((m) => ({
    default: m.CharacterSelectScreen,
  })),
);
const UsernameSelectionScreen = React.lazy(() =>
  import("./screens/UsernameSelectionScreen").then((m) => ({
    default: m.UsernameSelectionScreen,
  })),
);
const EmbeddedGameClient = React.lazy(() =>
  import("./game/EmbeddedGameClient").then((m) => ({
    default: m.EmbeddedGameClient,
  })),
);
const EmbeddedAgentControlScreen = React.lazy(() =>
  import("./screens/EmbeddedAgentControlScreen").then((m) => ({
    default: m.EmbeddedAgentControlScreen,
  })),
);
import { isEmbeddedMode } from "./types/embeddedConfig";
import { validateURLParams } from "./utils/InputValidator";
import { GAME_API_URL, GAME_WS_URL, refreshApiConfig } from "./lib/api-config";
import {
  buildEmbeddedConfig,
  embeddedParamSchema,
  getEmbeddedSurface,
} from "./lib/embedded-entry";

// Buffer polyfill for Privy (required for crypto operations in browser)
// Must be imported and assigned BEFORE any other imports that might use it
import { Buffer } from "buffer";
(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
// Also ensure window.Buffer is available for libraries that check there
if (typeof window !== "undefined") {
  (window as Window & { Buffer: typeof Buffer }).Buffer = Buffer;
  const isPlaywrightTestRuntime =
    import.meta.env.PLAYWRIGHT_TEST === true ||
    import.meta.env.PLAYWRIGHT_TEST === "true";
  (window as Window & { __PLAYWRIGHT_TEST__?: boolean }).__PLAYWRIGHT_TEST__ =
    isPlaywrightTestRuntime;

  if (isPlaywrightTestRuntime) {
    try {
      // Ensure strict E2E flows can observe local auth markers without relying
      // on external auth providers during test runtime.
      if (!localStorage.getItem("privy_auth_token")) {
        localStorage.setItem("privy_auth_token", "e2e-playwright-token");
      }
      if (!localStorage.getItem("privy_user_id")) {
        localStorage.setItem("privy_user_id", "e2e-playwright-user");
      }
      if (!sessionStorage.getItem("privy_auth_token")) {
        sessionStorage.setItem("privy_auth_token", "e2e-playwright-token");
      }
      if (!sessionStorage.getItem("privy_user_id")) {
        sessionStorage.setItem("privy_user_id", "e2e-playwright-user");
      }
    } catch {
      // Ignore storage access failures in constrained browser contexts.
    }
  }
}

// Early CDN URL initialization to prevent PhysX WASM loading race condition.
// When createClientWorld runs, it triggers PhysX WASM load before GameClient mounts.
// We must expose the CDN URL immediately so PhysX knows where to fetch the WASM file.
function syncRuntimeAssetBaseUrls(): void {
  if (typeof window === "undefined") {
    return;
  }

  const windowWithEnv = window as Window & {
    env?: { PUBLIC_CDN_URL?: string };
    __CDN_URL?: string;
    __ASSETS_URL?: string;
  };
  // Normalize the CDN URL if provided via env.js
  const envCdn = windowWithEnv.env?.PUBLIC_CDN_URL;
  if (envCdn && typeof envCdn === "string" && envCdn !== "undefined") {
    let resolvedCdn = envCdn;
    // Handle localhost edge case normalization
    if (resolvedCdn.includes("127.0.0.1") || resolvedCdn.includes("0.0.0.0")) {
      resolvedCdn = resolvedCdn
        .replace("127.0.0.1", "localhost")
        .replace("0.0.0.0", "localhost");
    }
    windowWithEnv.__CDN_URL = resolvedCdn;
    windowWithEnv.__ASSETS_URL = resolvedCdn;
  }
}

if (typeof window !== "undefined") {
  // Scrub streaming viewer secrets before React or telemetry code can observe
  // them in the address bar. Hash takes precedence over query for compatibility.
  primeStreamingAccessTokenFromWindow(window);
  syncRuntimeAssetBaseUrls();
}

// Browser polyfill uses setTimeout which returns a Timeout, but libraries expect
// the Node.js setImmediate signature. The cast is required for cross-platform compat.
declare global {
  interface GlobalThis {
    setImmediate?: typeof setImmediate;
  }
}

if (!globalThis.setImmediate) {
  // Browser polyfill: setTimeout(cb, 0) mimics setImmediate behavior
  // Cast required: setTimeout returns Timeout, setImmediate expects NodeJS.Immediate
  globalThis.setImmediate = ((
    callback: (...args: unknown[]) => void,
    ...args: unknown[]
  ) => setTimeout(callback, 0, ...args)) as unknown as typeof setImmediate;
}

try {
  devValidateManifest();
} catch (error) {
  console.warn(
    "[index] Development manifest validation failed:",
    error instanceof Error ? error.message : String(error),
  );
}

// Parse URL parameters for embedded configuration
const urlParams = new URLSearchParams(window.location.search);
const isEmbedded = urlParams.get("embedded") === "true";

if (isEmbedded) {
  window.__HYPERIA_EMBEDDED__ = true;

  // Validate URL parameters
  const validation = validateURLParams(urlParams, embeddedParamSchema);

  if (!validation.isValid) {
    console.warn(
      "[Hyperia] Invalid embedded URL parameters:",
      validation.errors,
    );
  }

  const config = buildEmbeddedConfig(validation.params, { wsUrl: GAME_WS_URL });

  window.__HYPERIA_CONFIG__ = config;

  const runtimeWindow = window as StreamingWindow;
  const trustedOrigins = resolveTrustedEmbedOrigins({
    currentOrigin: window.location.origin,
    publicAppUrl:
      runtimeWindow.env?.PUBLIC_APP_URL || import.meta.env.PUBLIC_APP_URL,
    embedAllowedOrigins:
      runtimeWindow.env?.PUBLIC_EMBED_ALLOWED_ORIGINS ||
      import.meta.env.PUBLIC_EMBED_ALLOWED_ORIGINS,
  });
  const allowWildcardEmbedFallback =
    import.meta.env.DEV ||
    import.meta.env.PLAYWRIGHT_TEST === true ||
    import.meta.env.PLAYWRIGHT_TEST === "true";

  // Setup secure postMessage listener for receiving auth token from parent window
  // This is the secure alternative to passing tokens via URL parameters
  const handleAuthMessage = (event: MessageEvent) => {
    if (event.source !== window.parent) {
      return;
    }

    if (!isTrustedEmbedOrigin(event.origin, trustedOrigins)) {
      console.warn(
        "[Hyperia] Ignoring HYPERIA_AUTH from untrusted origin:",
        event.origin,
      );
      return;
    }

    const message = parseHyperiaAuthMessage(event.data);
    if (!message) {
      return;
    }

    const currentConfig = window.__HYPERIA_CONFIG__;
    if (!currentConfig) {
      return;
    }

    applyHyperiaAuthMessage(currentConfig, message);
    window.dispatchEvent(new CustomEvent("hyperia:auth-ready"));
    window.removeEventListener("message", handleAuthMessage);
  };
  window.addEventListener("message", handleAuthMessage);

  // Notify parent window that embedded viewport is ready to receive auth
  if (window.parent !== window) {
    const readyTargetOrigin = resolveEmbedReadyTargetOrigin({
      currentOrigin: window.location.origin,
      trustedOrigins,
      referrer: document.referrer || null,
      allowWildcardFallback: allowWildcardEmbedFallback,
    });
    if (readyTargetOrigin) {
      window.parent.postMessage({ type: "HYPERIA_READY" }, readyTargetOrigin);
    } else {
      console.warn(
        "[Hyperia] Could not determine a trusted origin for HYPERIA_READY; skipping parent bootstrap message",
      );
    }
  }

  logger.config("[Hyperia] Configured from validated URL params:", {
    ...config,
    authToken: config.authToken ? "[REDACTED]" : "[PENDING]",
  });
}

// Set global environment flags
(
  globalThis as typeof globalThis & { isBrowser?: boolean; isServer?: boolean }
).isBrowser = true;
(
  globalThis as typeof globalThis & { isBrowser?: boolean; isServer?: boolean }
).isServer = false;

// Global window extensions
declare global {
  interface Window {
    THREE?: typeof THREE;
    world?: InstanceType<typeof World>;
    testChat?: () => void;
    Hyperia?: {
      CircularSpawnArea: typeof CircularSpawnArea;
    };
    __PLAYWRIGHT_TEST__?: boolean;
    privyLogout?: () => Promise<void> | void;
  }
}

// Vite environment variables - extend the built-in types
declare global {
  interface ImportMetaEnv {
    readonly PLAYWRIGHT_TEST?: string | boolean;
    readonly PUBLIC_PRIVY_APP_ID?: string;
    readonly PUBLIC_WS_URL?: string;
    readonly PUBLIC_CDN_URL?: string;
    readonly PUBLIC_ENABLE_FARCASTER?: string;
    readonly PUBLIC_APP_URL?: string;
    readonly PUBLIC_EMBED_ALLOWED_ORIGINS?: string;
    readonly PUBLIC_API_URL?: string;
    readonly PUBLIC_ELIZAOS_URL?: string;
  }
}

// Install Three.js extensions
installThreeJSExtensions();

/**
 * Clean up corrupted Privy localStorage data
 * Prevents JSON parse errors from malformed data
 */
function cleanupCorruptedPrivyData(): void {
  try {
    const corruptedKeys: string[] = [];

    // Our custom keys that store plain strings (not JSON)
    const plainStringKeys = new Set([
      "privy_user_id",
      "privy_auth_token",
      "farcaster_fid",
    ]);

    // Check each localStorage key for corruption
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;

      // Only check Privy SDK keys (not our custom plain string keys)
      if (key.startsWith("privy:") && !plainStringKeys.has(key)) {
        try {
          const value = localStorage.getItem(key);
          if (value) {
            // Try to parse as JSON - if it fails, it's corrupted
            JSON.parse(value);
          }
        } catch (parseError) {
          // Found corrupted data
          const errorStr =
            parseError instanceof Error
              ? parseError.message
              : String(parseError);
          if (
            errorStr.includes("setImmedia") ||
            errorStr.includes("Unexpected token")
          ) {
            if (import.meta.env.DEV) {
              console.warn(`[App] Found corrupted localStorage key: ${key}`);
            }
            corruptedKeys.push(key);
          }
        }
      }
    }

    // Remove corrupted keys
    if (corruptedKeys.length > 0) {
      corruptedKeys.forEach((key) => {
        try {
          localStorage.removeItem(key);
        } catch (e) {
          if (import.meta.env.DEV) {
            console.warn(`[App] Failed to remove corrupted key ${key}:`, e);
          }
        }
      });
    }
  } catch (error) {
    console.error("[App] Error during localStorage cleanup:", error);
  }
}

// Defer cleanup so app boot is not blocked on a full localStorage scan.
if (typeof window !== "undefined") {
  const schedulePrivyCleanup = () => cleanupCorruptedPrivyData();
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(schedulePrivyCleanup, { timeout: 1500 });
  } else {
    globalThis.setTimeout(schedulePrivyCleanup, 0);
  }
}

// In development, aggressively unregister any stale service workers.
// Devs occasionally run production builds locally ('vite preview'), which installs
// a service worker that intercepts dev server requests and causes MIME type errors.
if (import.meta.env.DEV && "serviceWorker" in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => {
      for (const registration of registrations) {
        registration.unregister();
      }
    })
    .catch((err) =>
      console.warn("[App] Failed to unregister service worker:", err),
    );
}

function App() {
  // Determine Privy availability
  const appId = resolvePrivyAppId(import.meta.env.PUBLIC_PRIVY_APP_ID);
  const privyEnabled = isConfiguredPrivyAppId(appId);

  const [authState, setAuthState] = React.useState(privyAuthManager.getState());
  const [showCharacterPage, setShowCharacterPage] =
    React.useState<boolean>(privyEnabled);
  const [hasUsername, setHasUsername] = React.useState<boolean | null>(null); // null = checking, true/false = result
  const [isCheckingUsername, setIsCheckingUsername] = React.useState(false);

  // Subscribe to auth state changes (runs immediately)
  React.useEffect(() => {
    const unsubscribe = privyAuthManager.subscribe(setAuthState);
    injectFarcasterMetaTags();
    return unsubscribe;
  }, []);

  // Restore auth from localStorage ONLY after Privy SDK is ready
  // This prevents race conditions where we read stale/incomplete data
  React.useEffect(() => {
    if (!authState.privySdkReady) return;
    privyAuthManager.restoreFromStorage();
  }, [authState.privySdkReady]);

  // Check if user has a username when authenticated
  // Gate on privySdkReady to ensure Privy has finished initializing
  React.useEffect(() => {
    const checkUsername = async () => {
      // Wait for Privy SDK to be ready before checking
      if (!authState.privySdkReady) {
        return;
      }

      if (!authState.isAuthenticated) {
        setHasUsername(null);
        return;
      }

      // Use PrivyAuthManager with localStorage fallback
      const accountId = authState.privyUserId || privyAuthManager.getUserId();
      if (!accountId) {
        // Don't immediately assume no username - Privy may still be writing
        // Stay in loading state briefly, then check again
        setHasUsername(null);
        return;
      }

      setIsCheckingUsername(true);

      // Retry logic for API call - server may not be ready on fresh start
      const apiBaseUrl = GAME_API_URL;
      const maxRetries = 3;
      const retryDelayMs = 500;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const response = await fetch(
            `${apiBaseUrl}/api/users/check?accountId=${encodeURIComponent(accountId)}`,
            {
              headers: privyAuthManager.getToken()
                ? {
                    Authorization: `Bearer ${privyAuthManager.getToken()}`,
                  }
                : undefined,
            },
          );

          if (response.ok) {
            const data = await response.json();
            setHasUsername(data.exists);
            setIsCheckingUsername(false);
            return;
          }
        } catch {}

        // Wait before retry (unless last attempt)
        if (attempt < maxRetries - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, retryDelayMs * (attempt + 1)),
          );
        }
      }

      // All retries failed - stay in loading state rather than showing wrong screen
      setHasUsername(null);
      setIsCheckingUsername(false);
    };

    checkUsername();
  }, [
    authState.isAuthenticated,
    authState.privySdkReady,
    authState.privyUserId,
  ]);

  // Show character page when authenticated and has username
  React.useEffect(() => {
    if (authState.isAuthenticated && hasUsername === true) {
      setShowCharacterPage(true);
    }
  }, [authState.isAuthenticated, hasUsername]);

  // Initialize player token
  React.useEffect(() => {
    playerTokenManager.getOrCreatePlayerToken("Player");
    playerTokenManager.startSession();
    return () => {
      playerTokenManager.endSession();
      playerTokenManager.dispose();
    };
  }, []);

  const wsUrl: string = GAME_WS_URL;
  const appRef = React.useRef<HTMLDivElement>(null);

  const handleUsernameSelected = React.useCallback((_username: string) => {
    setHasUsername(true);
    setShowCharacterPage(true);
  }, []);

  const handleLogout = React.useCallback(() => {
    try {
      // Clear Privy auth manager first
      privyAuthManager.clearAuth();

      // Clear potentially corrupted Privy localStorage keys
      // This prevents JSON parse errors from corrupted data
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (
          key &&
          (key.startsWith("privy:") ||
            key.startsWith("privy_") ||
            key.includes("privy") ||
            key.includes("wallet"))
        ) {
          keysToRemove.push(key);
        }
      }

      keysToRemove.forEach((key) => {
        try {
          localStorage.removeItem(key);
        } catch (e) {
          console.warn(`[App] Failed to remove key ${key}:`, e);
        }
      });

      // Update React state
      setShowCharacterPage(false);
      setHasUsername(null);

      // Attempt Privy logout (wrapped in try-catch to handle errors gracefully)
      try {
        window.privyLogout?.();
      } catch (privyError) {
        console.warn(
          "[App] ⚠️ Privy logout error (safe to ignore):",
          privyError,
        );
      }

      // Force reload to ensure completely clean state
      setTimeout(() => {
        window.location.href = "/";
      }, 100);
    } catch (error) {
      console.error("[App] ❌ Error during logout:", error);
      // Even if logout fails, force reload for clean state
      window.location.href = "/";
    }
  }, []);

  const handleSetup = React.useCallback(
    (world: InstanceType<typeof World>, _config: unknown) => {
      // Extend window with debug utilities
      if (import.meta.env.DEV) {
        window.world = world;
        window.THREE = THREE;
        window.Hyperia = {
          CircularSpawnArea,
        };

        window.testChat = () => {
          const chat = world.getSystem("chat") as {
            send?: (msg: string) => void;
          } | null;
          chat?.send?.(
            "Test message from console at " + new Date().toLocaleTimeString(),
          );
        };
      }
    },
    [],
  );

  // Show initializing screen while Privy SDK loads
  // This prevents race conditions where we show the wrong screen
  if (privyEnabled && !authState.privySdkReady) {
    return (
      <div
        ref={appRef}
        data-component="app-root"
        className="flex items-center justify-center h-screen bg-black"
      >
        <div className="text-[#f2d08a] text-xl">Initializing...</div>
      </div>
    );
  }

  // Show login screen if Privy enabled and not authenticated
  if (privyEnabled && !authState.isAuthenticated) {
    return (
      <div ref={appRef} data-component="app-root">
        <ErrorBoundary>
          <React.Suspense fallback={<ScreenLoadingFallback />}>
            <LoginScreen />
          </React.Suspense>
        </ErrorBoundary>
      </div>
    );
  }

  // Show username selection for new users (authenticated but no username yet)
  if (
    privyEnabled &&
    authState.isAuthenticated &&
    hasUsername === false &&
    !isCheckingUsername
  ) {
    return (
      <div ref={appRef} data-component="app-root">
        <ErrorBoundary>
          <React.Suspense fallback={<ScreenLoadingFallback />}>
            <UsernameSelectionScreen
              onUsernameSelected={handleUsernameSelected}
            />
          </React.Suspense>
        </ErrorBoundary>
      </div>
    );
  }

  // Show character selection (only if Privy enabled and user has username)
  if (showCharacterPage && privyEnabled && hasUsername === true) {
    return (
      <div ref={appRef} data-component="app-root">
        <ErrorBoundary>
          <React.Suspense fallback={<ScreenLoadingFallback />}>
            <CharacterSelectScreen
              wsUrl={wsUrl}
              onPlay={(id) => {
                if (id) {
                  // Use sessionStorage (per-tab) instead of localStorage (shared across tabs)
                  // This prevents Tab B from overwriting Tab A's selected character
                  sessionStorage.setItem("selectedCharacterId", id);
                }
                setShowCharacterPage(false);
              }}
              onLogout={handleLogout}
            />
          </React.Suspense>
        </ErrorBoundary>
      </div>
    );
  }

  // Show loading screen while checking auth status (prevent GameClient from loading prematurely)
  if (privyEnabled && (hasUsername === null || isCheckingUsername)) {
    return (
      <div
        ref={appRef}
        data-component="app-root"
        className="flex items-center justify-center h-screen bg-black"
      >
        <div className="text-[#f2d08a] text-xl">Loading...</div>
      </div>
    );
  }

  // Show game (when Privy disabled, skip character selection and go straight to game)
  // The client will automatically send enterWorld without characterId for dev mode
  return (
    <div ref={appRef} data-component="app-root">
      <ErrorBoundary>
        <React.Suspense fallback={<ScreenLoadingFallback />}>
          <GameClient wsUrl={wsUrl} onSetup={handleSetup} />
        </React.Suspense>
      </ErrorBoundary>
    </div>
  );
}

// Additional lazy-loaded screens
const DashboardScreen = React.lazy(() =>
  import("./screens/DashboardScreen").then((m) => ({
    default: m.DashboardScreen,
  })),
);
const CharacterEditorScreen = React.lazy(() =>
  import("./screens/CharacterEditorScreen").then((m) => ({
    default: m.CharacterEditorScreen,
  })),
);
const AdminScreen = React.lazy(() =>
  import("./screens/AdminScreen").then((m) => ({ default: m.AdminScreen })),
);
const StreamingMode = React.lazy(() =>
  import("./screens/StreamingMode").then((m) => ({ default: m.StreamingMode })),
);
const LeaderboardScreen = React.lazy(() =>
  import("./screens/LeaderboardScreen").then((m) => ({
    default: m.LeaderboardScreen,
  })),
);
const AgentMonitorScreen = React.lazy(() =>
  import("./screens/AgentMonitorScreen").then((m) => ({
    default: m.AgentMonitorScreen,
  })),
);
import {
  isTauriApp,
  onDeepLink,
  parseOAuthCallback,
} from "./lib/tauri-integration";

/**
 * Setup Tauri deep link handler for OAuth callbacks
 */
async function setupTauriDeepLinks(): Promise<void> {
  if (!isTauriApp()) return;

  const unlisten = await onDeepLink((url) => {
    const { code, state, error } = parseOAuthCallback(url);

    if (error) {
      console.error("[Hyperia] OAuth error:", error);
      return;
    }

    if (code) {
      // Store the auth code for Privy to pick up
      // Privy will handle the token exchange

      // Dispatch custom event for auth handling
      window.dispatchEvent(
        new CustomEvent("hyperia:oauth-callback", {
          detail: { code, state },
        }),
      );
    }
  });

  // Store unlisten function for cleanup if needed
  if (unlisten) {
    (
      window as Window & { __tauriDeepLinkUnlisten?: () => void }
    ).__tauriDeepLinkUnlisten = unlisten;
  }
}

// Track React root instance to prevent double mounting on HMR
let reactRoot: ReactDOM.Root | null = null;

async function mountApp() {
  const rootElement = document.getElementById("root")!;

  await ensurePublicRuntimeEnv();
  refreshApiConfig();
  syncRuntimeAssetBaseUrls();

  // Reuse existing root if already created (prevents HMR double-mount warning)
  if (!reactRoot) {
    reactRoot = ReactDOM.createRoot(rootElement);
  }
  const root = reactRoot;

  // Setup Tauri deep links for OAuth
  await setupTauriDeepLinks();

  // Check for special page modes
  const urlParams = new URLSearchParams(window.location.search);
  const page = urlParams.get("page");

  // Check if running in embedded viewport mode
  if (isEmbeddedMode()) {
    const embeddedSurface = getEmbeddedSurface(window.__HYPERIA_CONFIG__);
    const EmbeddedEntryComponent =
      embeddedSurface === "agent-control"
        ? EmbeddedAgentControlScreen
        : EmbeddedGameClient;
    // Render embedded game client directly (no auth screens)
    root.render(
      <ErrorBoundary>
        <MaintenanceBanner />
        <React.Suspense fallback={<ScreenLoadingFallback />}>
          <EmbeddedEntryComponent />
        </React.Suspense>
      </ErrorBoundary>,
    );
  } else {
    if (page === "dashboard") {
      root.render(
        <ErrorBoundary>
          <MaintenanceBanner />
          <SolanaWalletProvider>
            <PrivyAuthProvider>
              <React.Suspense fallback={<ScreenLoadingFallback />}>
                <DashboardScreen />
              </React.Suspense>
            </PrivyAuthProvider>
          </SolanaWalletProvider>
        </ErrorBoundary>,
      );
    } else if (page === "character-editor") {
      root.render(
        <ErrorBoundary>
          <MaintenanceBanner />
          <SolanaWalletProvider>
            <PrivyAuthProvider>
              <React.Suspense fallback={<ScreenLoadingFallback />}>
                <CharacterEditorScreen />
              </React.Suspense>
            </PrivyAuthProvider>
          </SolanaWalletProvider>
        </ErrorBoundary>,
      );
    } else if (page === "admin") {
      root.render(
        <ErrorBoundary>
          <MaintenanceBanner />
          <React.Suspense fallback={<ScreenLoadingFallback />}>
            <AdminScreen />
          </React.Suspense>
        </ErrorBoundary>,
      );
    } else if (page === "stream") {
      root.render(
        <ErrorBoundary>
          <MaintenanceBanner />
          <React.Suspense fallback={<ScreenLoadingFallback />}>
            <StreamingMode />
          </React.Suspense>
        </ErrorBoundary>,
      );
    } else if (page === "leaderboard") {
      root.render(
        <ErrorBoundary>
          <MaintenanceBanner />
          <React.Suspense fallback={<ScreenLoadingFallback />}>
            <LeaderboardScreen />
          </React.Suspense>
        </ErrorBoundary>,
      );
    } else if (page === "agent-monitor") {
      root.render(
        <ErrorBoundary>
          <MaintenanceBanner />
          <React.Suspense fallback={<ScreenLoadingFallback />}>
            <AgentMonitorScreen />
          </React.Suspense>
        </ErrorBoundary>,
      );
    } else {
      // Normal mode - render full app with auth
      root.render(
        <ErrorBoundary>
          <MaintenanceBanner />
          <SolanaWalletProvider>
            <PrivyAuthProvider>
              <App />
            </PrivyAuthProvider>
          </SolanaWalletProvider>
        </ErrorBoundary>,
      );
    }
  }

  // Verify render completion
  const verifyRender = (attempts = 0) => {
    const maxAttempts = 10;
    const hasContent = rootElement.innerHTML.length > 0;

    if (hasContent) {
      return;
    }

    if (attempts < maxAttempts) {
      requestAnimationFrame(() => verifyRender(attempts + 1));
      return;
    }

    // Should never reach here - React render failed
    throw new Error(
      "React app mounted but no content rendered after multiple attempts",
    );
  };

  setTimeout(() => {
    requestAnimationFrame(() => verifyRender(0));
  }, 0);
}

// Ensure DOM is ready before mounting
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void mountApp();
  });
} else {
  void mountApp();
}
