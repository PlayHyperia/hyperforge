import {
  GAME_WS_URL,
  CDN_URL,
  normalizeBrowserLoopbackUrl,
} from "@/lib/api-config";
import type { PublicRuntimeEnv, StreamingWindow } from "@/lib/streamingWindow";
import { useEffect, useMemo, useRef, useState } from "react";
import { THREE, createClientWorld, System } from "@hyperforge/shared";
import { World, type ClientNetwork } from "@hyperforge/shared";
import { CoreUI } from "../game/CoreUI";
import { ErrorBoundary } from "../components/common/ErrorBoundary";
import { ThreeResourceManager } from "@/lib/ThreeResourceManager";
import {
  normalizeWorldInitializationFailure,
  WorldInitializationError,
  type WorldInitializationFailure,
} from "./WorldInitializationError";

export { System };

interface GameClientProps {
  wsUrl?: string;
  /** Explicit choice; null disables legacy reload selection fallback. */
  selectedCharacterId?: string | null;
  onSetup?: (world: InstanceType<typeof World>, config: unknown) => void;
  onInitError?: (error: string | null) => void;
  /** Hide standard game UI (for streaming/spectator modes) */
  hideUI?: boolean;
  /** Use streaming-mode environment simplifications */
  streamingMode?: boolean;
}

type WindowWithEnv = StreamingWindow & {
  __CDN_URL?: string;
  __ASSETS_URL?: string;
};
const getRuntimeEnv = (): PublicRuntimeEnv | undefined => {
  if (typeof window === "undefined") return undefined;
  return (window as StreamingWindow).env;
};

const normalizeEnvValue = (value?: string): string | undefined => {
  if (!value) return undefined;
  if (value === "undefined") return undefined;
  return normalizeBrowserLoopbackUrl(value);
};

const resolveCdnUrlForClient = (
  runtimeCdnUrl?: string,
  buildCdnUrl?: string,
): string => {
  const sameOriginFallback = `${window.location.origin}/game-assets`;

  if (runtimeCdnUrl) {
    return runtimeCdnUrl;
  }

  if (buildCdnUrl) {
    return buildCdnUrl;
  }

  return sameOriginFallback;
};

const loadRuntimeEnv = async (): Promise<PublicRuntimeEnv | undefined> => {
  const existing = getRuntimeEnv();
  if (existing) return existing;
  if (typeof document === "undefined") return undefined;

  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "/env.js";
    script.async = true;
    const finalize = () => {
      script.onload = null;
      script.onerror = null;
      resolve(getRuntimeEnv());
    };
    script.onload = finalize;
    script.onerror = finalize;
    document.head.appendChild(script);
  });
};

export function GameClient({
  wsUrl,
  selectedCharacterId,
  onSetup,
  onInitError,
  hideUI = false,
  streamingMode = false,
}: GameClientProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const uiRef = useRef<HTMLDivElement>(null);
  const initialWsUrlRef = useRef(wsUrl);
  // Account/character changes require a new keyed GameClient/world instance.
  const initialSelectedCharacterIdRef = useRef(selectedCharacterId);
  const initialStreamingModeRef = useRef(streamingMode);
  const onSetupRef = useRef(onSetup);
  const onInitErrorRef = useRef(onInitError);
  const [initError, setInitError] = useState<WorldInitializationFailure | null>(
    null,
  );
  const [initializedWorld, setInitializedWorld] = useState<World | null>(null);

  onSetupRef.current = onSetup;
  onInitErrorRef.current = onInitError;

  // Detect HMR and force full page reload instead of hot reload
  useEffect(() => {
    if (import.meta.hot) {
      import.meta.hot.dispose(() => {
        window.location.reload();
      });
    }
  }, []);

  // Create world immediately so network can connect and deliver characterList
  const world = useMemo(() => {
    const w = createClientWorld();

    if (import.meta.env.DEV) {
      // Expose world for browser debugging in development only.
      (window as { world?: InstanceType<typeof World> }).world = w;

      const debugCommands = {
        seeHighEntities: () => {
          if (w.camera) {
            w.camera.position.set(10, 50, 10);
            w.camera.lookAt(0, 40, 0);
          }
        },
        seeGround: () => {
          if (w.camera) {
            w.camera.position.set(10, 5, 10);
            w.camera.lookAt(0, 0, 0);
          }
        },
        mobs: () => {
          type EntityWithNode = {
            type: string;
            name: string;
            node: { position: { toArray: () => number[] } };
            mesh?: { visible: boolean };
          };
          type EntityManagerType = {
            getAllEntities?: () => Map<string, EntityWithNode>;
          };

          const entityManager = w.getSystem(
            "entity-manager",
          ) as EntityManagerType | null;
          const mobs: Array<{
            name: string;
            position: number[];
            hasMesh: boolean;
            meshVisible: boolean;
          }> = [];

          if (entityManager?.getAllEntities) {
            for (const [_id, entity] of entityManager.getAllEntities()) {
              if (entity.type === "mob") {
                mobs.push({
                  name: entity.name,
                  position: entity.node.position.toArray(),
                  hasMesh: !!entity.mesh,
                  meshVisible: entity.mesh?.visible ?? false,
                });
              }
            }
          }
          console.table(mobs);
          return mobs;
        },
      };
      (window as unknown as Record<string, unknown>).debug = debugCommands;
    }

    return w;
  }, []);
  // The UI overlay container is always visible. Per-component visibility
  // (HUD, sidebar, etc.) is controlled by the `hideUI` prop below.
  // Component-scoped UI_UPDATE events are handled by CoreUI, Sidebar,
  // and useInterfaceEvents — not at this level.
  // Handle window resize to update Three.js canvas
  useEffect(() => {
    const handleResize = () => {
      const viewport = viewportRef.current;
      const graphics = world.getSystem("graphics") as {
        resize?: (width: number, height: number) => void;
      } | null;
      if (viewport && graphics?.resize) {
        const width = viewport.offsetWidth;
        const height = viewport.offsetHeight;
        graphics.resize(width, height);
      }
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [world]);

  useEffect(() => {
    let cleanedUp = false;
    // Guards against the race where the cleanup callback fires while world.init()
    // is still awaiting. If cleanup arrives first, init will destroy on landing.
    // If init finishes first, cleanup destroys immediately as normal.
    let initComplete = false;
    let needsCleanup = false;

    const doCleanup = () => {
      try {
        world.destroy();
      } catch (error) {
        console.warn(
          "[GameClient] world.destroy() threw during cleanup:",
          error instanceof Error ? error.message : String(error),
        );
      }
      // Stop the dev memory monitor and reset the disposed-object tracker
      // so the next world init (e.g. hot-reload) starts completely clean
      ThreeResourceManager.teardown();
    };

    const init = async () => {
      const viewport = viewportRef.current;
      const ui = uiRef.current;

      if (!viewport || !ui) {
        return;
      }

      const baseEnvironment = {
        ...(initialStreamingModeRef.current
          ? {}
          : {
              bg: "asset://world/day2-2k.jpg",
              hdr: "asset://world/day2.hdr",
            }),
        sunDirection: new THREE.Vector3(-1, -2, -2).normalize(),
        sunIntensity: 1,
        sunColor: 0xffffff,
        fogNear: null,
        fogFar: null,
        fogColor: null,
      };

      // Direct connection - no Vite proxy
      // Default to game server on 5555, CDN on 8080
      const runtimeEnv = await loadRuntimeEnv();
      const runtimeWsUrl = normalizeEnvValue(runtimeEnv?.PUBLIC_WS_URL);
      const finalWsUrl = initialWsUrlRef.current || runtimeWsUrl || GAME_WS_URL;
      const runtimeCdnUrl = normalizeEnvValue(runtimeEnv?.PUBLIC_CDN_URL);
      const buildCdnUrl = normalizeEnvValue(CDN_URL);
      const resolvedCdnUrl = resolveCdnUrlForClient(runtimeCdnUrl, buildCdnUrl);
      const assetsUrl = resolvedCdnUrl.endsWith("/")
        ? resolvedCdnUrl
        : `${resolvedCdnUrl}/`;

      // Expose the initial asset base globally for early loaders and manifest fetches.
      (window as WindowWithEnv).__CDN_URL = resolvedCdnUrl;
      (window as WindowWithEnv).__ASSETS_URL = resolvedCdnUrl;

      const config = {
        viewport,
        ui,
        wsUrl: finalWsUrl,
        selectedCharacterId: initialSelectedCharacterIdRef.current,
        baseEnvironment,
        assetsUrl, // This will be overridden by server snapshot
      };

      // Call onSetup if provided
      if (onSetupRef.current) {
        onSetupRef.current(world, config);
      }

      // Ensure RPG systems are registered before initializing the world
      await world.systemsLoadedPromise;

      try {
        await world.init(config);
        if (!cleanedUp && !needsCleanup) {
          setInitializedWorld(world);
          onInitErrorRef.current?.(null);
        }
      } catch (error) {
        const failure = normalizeWorldInitializationFailure(error);
        const { message } = failure;
        console.error("[GameClient] World initialization failed:", message);
        if (!cleanedUp && !needsCleanup) {
          const degradedReason =
            failure.kind === "renderer-preparation-timeout"
              ? "renderer_preparation_timeout"
              : "initialization_failed";
          const win = window as StreamingWindow;
          win.__HYPERIA_STREAM_READY__ = false;
          win.__HYPERIA_STREAM_RENDERER_HEALTH__ = {
            ready: false,
            degradedReason,
            updatedAt: Date.now(),
            phase: null,
          };
          onInitErrorRef.current?.(message);
          setInitError(failure);
        }
      }

      // If cleanup fired while we were initializing, execute it now.
      // Set initComplete even when init threw — partial worlds still hold
      // resources (WebSocket, systems, render targets) that doCleanup() must
      // release when the error screen eventually unmounts. doCleanup() is
      // always wrapped in try/catch so it is safe to call on a failed init.
      if (needsCleanup) {
        doCleanup();
      } else {
        initComplete = true;
      }
    };

    init();

    // Cleanup function
    return () => {
      if (!cleanedUp) {
        cleanedUp = true;
        if (initComplete) {
          // Normal path — init finished before unmount
          doCleanup();
        } else {
          // Init is still running — signal it to clean up when it lands
          needsCleanup = true;
        }
      }
    };
  }, [world]);

  // Startup has aborted: entry recovery cannot safely reuse this partial world.
  if (initError) {
    return (
      <WorldInitializationError
        failure={initError}
        entryRecoveryPresent={Boolean(
          (world.network as ClientNetwork).entryRetryState,
        )}
      />
    );
  }

  return (
    <div className="App absolute top-0 left-0 right-0 h-screen">
      <style>{`
        .App__viewport {
          position: fixed;
          overflow: hidden;
          width: 100%;
          height: 100%;
          inset: 0;
        }
        .App__ui {
          position: absolute;
          inset: 0;
          pointer-events: none;
          user-select: none;
          display: block;
          overflow: hidden;
          z-index: 10;
        }
      `}</style>
      <div
        id="game-canvas"
        className="App__viewport"
        ref={viewportRef}
        data-component="viewport"
        aria-label="Game Canvas"
        role="application"
      >
        <div className="App__ui" ref={uiRef} data-component="ui">
          {!hideUI && (
            <ErrorBoundary
              onError={(error) => {
                console.error(
                  "[GameClient] CoreUI error caught by boundary:",
                  error.message,
                );
              }}
            >
              <CoreUI
                world={world}
                worldInitialized={initializedWorld === world}
              />
            </ErrorBoundary>
          )}
        </div>
      </div>
    </div>
  );
}
