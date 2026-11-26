import React, { useEffect, useRef, useState } from "react";
import { useThemeStore } from "@/ui";

import type {
  ClientNetwork,
  ControlAction,
  EntryRetryState,
  EventMap,
} from "@hyperforge/shared";
import {
  buttons,
  cls,
  EventType,
  isTouch,
  propToLabel,
} from "@hyperforge/shared";
import type { ClientWorld } from "../types";
import { PlayerDataProvider, usePlayerStatsContext } from "../hooks";
import { ActionProgressBar } from "./hud/ActionProgressBar";
import { ChatProvider } from "./chat/ChatContext";
import { EntityContextMenu } from "./hud/EntityContextMenu";
import { HandIcon, MouseLeftIcon, MouseRightIcon, MouseWheelIcon } from "@/ui";
import { LoadingScreen } from "../screens/LoadingScreen";
import {
  LoadingReadinessWarning,
  MEADOW_PREPARATION_BLOCKED_MESSAGE,
} from "../screens/LoadingReadinessWarning";
import {
  readWorldEntryReadiness,
  WorldEntryPresentationGate,
  type WorldEntryReadiness,
  type WorldEntryPresentationPhase,
} from "./WorldEntryReadiness";
import { InterfaceManager } from "./interface/InterfaceManager";
import { StatusBars } from "./hud/StatusBars";
import { XPProgressOrb } from "./hud/XPProgressOrb";
import { LevelUpNotification } from "./hud/level-up";
import { EscapeMenu } from "./hud/EscapeMenu";
import { ConnectionIndicator } from "./hud/ConnectionIndicator";
import { NotificationContainer } from "@/ui/components";
import {
  Disconnected,
  KickedOverlay,
  DeathScreen,
  WorldEntryRecoveryOverlay,
} from "./hud/overlays";
import {
  COLORS,
  spacing,
  borderRadius,
  shadows,
  zIndex,
  typography,
} from "../constants";

// Type for icon components
type IconComponent = React.ComponentType<{ size?: number | string }>;

export function CoreUI({
  world,
  worldInitialized,
}: {
  world: ClientWorld;
  worldInitialized: boolean;
}) {
  return (
    <PlayerDataProvider world={world}>
      <CoreUIContent world={world} initializationComplete={worldInitialized} />
    </PlayerDataProvider>
  );
}

function CoreUIContent({
  world,
  initializationComplete,
}: {
  world: ClientWorld;
  initializationComplete: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const entryStateRef = useRef<{
    world: ClientWorld;
    interrupted: boolean;
    kicked: string | null;
    selectedCharacterId: string | null;
    selecting: boolean;
  } | null>(null);
  const [ready, setReady] = useState(false);
  const [loadingOverlayVisible, setLoadingOverlayVisible] = useState(true);
  const [loadingComplete, setLoadingComplete] = useState(false);
  const [systemsComplete, setSystemsComplete] = useState(false);
  const [assetsProgress, setAssetsProgress] = useState(0);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [meadowBlocked, setMeadowBlocked] = useState(false);
  const [preparationStage, setPreparationStage] = useState(
    "Initializing world...",
  );
  const [readiness, setReadiness] = useState<WorldEntryReadiness | null>(null);
  const [visualReadinessSampled, setVisualReadinessSampled] = useState(false);
  const [presentationPhase, setPresentationPhase] =
    useState<WorldEntryPresentationPhase>("loading");
  const [uiVisible, setUIVisible] = useState(true);
  const [disconnected, setDisconnected] = useState(false);
  const [kicked, setKicked] = useState<string | null>(null);
  const [entryRetry, setEntryRetry] = useState<EntryRetryState | null>(
    () => (world.network as ClientNetwork).entryRetryState ?? null,
  );
  const [characterFlowActive, setCharacterFlowActive] = useState(false);
  const [deathScreen, setDeathScreen] = useState<{
    message: string;
    killedBy: string;
    respawnTime: number;
  } | null>(null);
  const isSpectatorMode = window.__HYPERIA_CONFIG__?.mode === "spectator";
  const playerStats = usePlayerStatsContext();

  useEffect(() => {
    if (!entryStateRef.current || entryStateRef.current.world !== world) {
      entryStateRef.current = {
        world,
        interrupted: false,
        kicked: null,
        selectedCharacterId: null,
        selecting: Boolean((world.network as ClientNetwork)?.lastCharacterList),
      };
    }
    const entry = entryStateRef.current;
    const gate = new WorldEntryPresentationGate();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let interrupted = entry.interrupted;
    let entryKicked = entry.kicked !== null;
    let selectedCharacterId = entry.selectedCharacterId;
    let selecting = entry.selecting;
    let previous: WorldEntryReadiness | null = null;
    let startedAt = performance.now();
    let reportedReadError: unknown = null;
    setReady(false);
    setLoadingOverlayVisible(true);
    setReadinessError(null);
    setMeadowBlocked(false);
    setDisconnected(entry.interrupted);
    setKicked(entry.kicked);

    const sample = () => {
      if (disposed) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const now = performance.now();
      try {
        setEntryRetry((world.network as ClientNetwork).entryRetryState ?? null);
        const config = window.__HYPERIA_CONFIG__;
        const inspectVisuals = gate.phase !== "committed";
        const snapshot = readWorldEntryReadiness(world, {
          initializationComplete,
          spectator: isSpectatorMode,
          spectatorTargetId:
            config?.followEntity || config?.characterId || null,
          selectedCharacterId,
          selecting,
          interrupted,
          kicked: entryKicked,
          includeVisualReadiness: inspectVisuals,
        });
        if (
          previous &&
          (snapshot.owner !== previous.owner ||
            snapshot.connection !== previous.connection ||
            snapshot.targetId !== previous.targetId)
        )
          startedAt = now;
        const sameSnapshot =
          previous !== null &&
          previous.owner === snapshot.owner &&
          previous.connection === snapshot.connection &&
          previous.targetId === snapshot.targetId &&
          previous.ownershipReady === snapshot.ownershipReady &&
          previous.ready === snapshot.ready &&
          previous.playerReady === snapshot.playerReady &&
          previous.physReady === snapshot.physReady &&
          previous.terrainReady === snapshot.terrainReady &&
          previous.blockedChunks === snapshot.blockedChunks &&
          previous.selecting === snapshot.selecting &&
          previous.recovering === snapshot.recovering;
        previous = snapshot;
        // An acknowledgement is not admission. A current attached owner may
        // complete auto-entry even when no CHARACTER_SELECTED event was sent.
        selecting = snapshot.selecting;
        entry.selecting = selecting;
        setCharacterFlowActive(selecting);
        // The cheap post-entry owner poll must not rerender the HUD at 4Hz.
        if (!sameSnapshot) setReadiness(snapshot);
        setVisualReadinessSampled(inspectVisuals);
        const phase = gate.advance(snapshot, now);
        setPresentationPhase(phase);
        const fading = phase === "fading" || phase === "committed";
        setReady(fading);
        setLoadingOverlayVisible(phase !== "committed");
        const blocked = snapshot.blockedChunks > 0 && !snapshot.terrainReady;
        const warningAllowed =
          phase !== "committed" &&
          !selecting &&
          !snapshot.recovering &&
          !interrupted &&
          !entryKicked;
        setMeadowBlocked(warningAllowed && blocked);
        const stage = !initializationComplete
          ? "Initializing world..."
          : !snapshot.ownershipReady
            ? "Waiting for your character..."
            : !snapshot.playerReady
              ? "Preparing your avatar..."
              : !snapshot.physReady
                ? "Preparing physics..."
                : blocked
                  ? `Preparing meadow — ${snapshot.blockedChunks} required chunks stopped`
                  : "Preparing the surrounding world...";
        setPreparationStage(stage);
        setReadinessError(
          !warningAllowed
            ? null
            : blocked
              ? MEADOW_PREPARATION_BLOCKED_MESSAGE
              : now - startedAt >= 20_000
                ? "World preparation is not complete. Readiness is still being checked. Reload the page to start a new attempt."
                : null,
        );
        reportedReadError = null;
      } catch (error) {
        // Read failures never authorize presentation or restart grounding jobs.
        if (error !== reportedReadError)
          console.error("[CoreUI] Readiness check failed:", error);
        reportedReadError = error;
        gate.reset();
        setReady(false);
        setLoadingOverlayVisible(true);
        setReadiness(null);
        setVisualReadinessSampled(false);
        setPresentationPhase("loading");
        setMeadowBlocked(false);
        setReadinessError(
          selecting || interrupted || entryKicked
            ? null
            : "World readiness could not be verified. Readiness will be checked again; you can also reload.",
        );
      }
      if (!disposed)
        timer = setTimeout(sample, gate.nextDelay(performance.now()));
    };

    // Progress is descriptive only; it cannot bypass current visual readiness.
    const handleReady = () => setLoadingComplete(true);
    const handleLoadingProgress = (data: unknown) => {
      const progress = data as {
        progress: number;
        stage?: string;
        total?: number;
      };
      if (progress.stage) {
        if (progress.progress >= 100) setSystemsComplete(true);
      } else if (typeof progress.total === "number")
        setAssetsProgress(progress.progress);
    };
    const handleUIToggle = (data: { visible: boolean }) =>
      setUIVisible(data.visible);
    const handleUIKick = (data: { playerId: string; reason: string }) => {
      entryKicked = true;
      entry.kicked = data.reason || "Kicked from server";
      setKicked(entry.kicked);
      sample();
    };
    const handleDisconnected = () => {
      interrupted = true;
      entry.interrupted = true;
      setDisconnected(true);
      sample();
    };
    const handleReconnected = () => {
      interrupted = false;
      entry.interrupted = false;
      setDisconnected(false);
      // The reader still requires the current registered owner/open transport.
      sample();
    };
    const handleCharacterList = () => {
      selecting = true;
      selectedCharacterId = null;
      entry.selecting = true;
      entry.selectedCharacterId = null;
      sample();
    };
    const handleCharacterSelected = (data: { characterId: string | null }) => {
      selectedCharacterId = data.characterId;
      entry.selectedCharacterId = data.characterId;
      sample();
    };
    const handleDeathScreen = (...args: unknown[]) => {
      setDeathScreen(
        args[0] as { message: string; killedBy: string; respawnTime: number },
      );
    };
    const handleDeathScreenClose = () => setDeathScreen(null);

    world.on(EventType.READY, handleReady);
    world.on(EventType.ASSETS_LOADING_PROGRESS, handleLoadingProgress);
    world.on(EventType.PLAYER_SPAWNED, sample);
    world.on(EventType.AVATAR_LOAD_COMPLETE, sample);
    world.on("physics:ready", sample);
    world.on(EventType.UI_TOGGLE, handleUIToggle);
    world.on(EventType.UI_KICK, handleUIKick);
    world.on(EventType.NETWORK_DISCONNECTED, handleDisconnected);
    world.on(EventType.NETWORK_RECONNECTED, handleReconnected);
    // ClientNetwork currently emits these legacy names; retain enum listeners
    // for existing callers without changing the network protocol here.
    world.on("NETWORK_DISCONNECTED", handleDisconnected);
    world.on("NETWORK_RECONNECTED", handleReconnected);
    world.on(EventType.ENTRY_RETRY_CHANGED, sample);
    world.on(EventType.CHARACTER_LIST, handleCharacterList);
    world.on(EventType.CHARACTER_SELECTED, handleCharacterSelected);
    world.on(EventType.UI_DEATH_SCREEN, handleDeathScreen);
    world.on(EventType.UI_DEATH_SCREEN_CLOSE, handleDeathScreenClose);
    sample();
    return () => {
      disposed = true;
      gate.dispose();
      if (timer !== null) clearTimeout(timer);
      world.off(EventType.READY, handleReady);
      world.off(EventType.ASSETS_LOADING_PROGRESS, handleLoadingProgress);
      world.off(EventType.PLAYER_SPAWNED, sample);
      world.off(EventType.AVATAR_LOAD_COMPLETE, sample);
      world.off("physics:ready", sample);
      world.off(EventType.UI_TOGGLE, handleUIToggle);
      world.off(EventType.UI_KICK, handleUIKick);
      world.off(EventType.NETWORK_DISCONNECTED, handleDisconnected);
      world.off(EventType.NETWORK_RECONNECTED, handleReconnected);
      world.off("NETWORK_DISCONNECTED", handleDisconnected);
      world.off("NETWORK_RECONNECTED", handleReconnected);
      world.off(EventType.ENTRY_RETRY_CHANGED, sample);
      world.off(EventType.CHARACTER_LIST, handleCharacterList);
      world.off(EventType.CHARACTER_SELECTED, handleCharacterSelected);
      world.off(EventType.UI_DEATH_SCREEN, handleDeathScreen);
      world.off(EventType.UI_DEATH_SCREEN_CLOSE, handleDeathScreenClose);
    };
  }, [world, initializationComplete, isSpectatorMode]);

  useEffect(() => {
    const loadingState = {
      ready,
      loadingComplete,
      systemsComplete,
      assetsProgress,
      initializationComplete,
      presentationPhase,
      visualReadinessSampled,
      playerReady: visualReadinessSampled
        ? (readiness?.playerReady ?? false)
        : null,
      physReady: readiness?.physReady ?? false,
      terrainReady: visualReadinessSampled
        ? (readiness?.terrainReady ?? false)
        : null,
      blockedChunks: visualReadinessSampled
        ? (readiness?.blockedChunks ?? 0)
        : null,
      terrainTimedOut: false,
      playerId: world.entities.player?.id || null,
    };
    (
      window as Window & { __HYPERIA_LOADING__?: typeof loadingState }
    ).__HYPERIA_LOADING__ = loadingState;
  }, [
    world,
    ready,
    loadingComplete,
    systemsComplete,
    assetsProgress,
    initializationComplete,
    readiness,
    presentationPhase,
    visualReadinessSampled,
  ]);

  return (
    <ChatProvider>
      <main
        id="main-content"
        role="main"
        aria-label="Game Interface"
        ref={ref}
        className="coreui absolute inset-0 overflow-hidden pointer-events-none"
      >
        {disconnected && <Disconnected />}
        {<Toast world={world} />}
        {<ConnectionIndicator world={world} />}
        {<NotificationContainer />}
        {/* UI container */}
        <div className="absolute inset-0 pointer-events-none">
          {ready && uiVisible && <ActionsBlock world={world} />}
          {ready && uiVisible && <StatusBars stats={playerStats} />}
          {ready && uiVisible && <XPProgressOrb world={world} />}
          {ready && <LevelUpNotification world={world} />}
          {ready && uiVisible && <InterfaceManager world={world} />}
          {ready && uiVisible && <ActionProgressBar world={world} />}
          {ready && uiVisible && isTouch && <TouchBtns world={world} />}
          {ready && <EntityContextMenu world={world} />}
          {ready && <EscapeMenu world={world} />}
          <div id="core-ui-portal" />
        </div>
        {/* Non-scaled overlays - full screen elements */}
        {loadingOverlayVisible && (
          <div
            className="absolute inset-0 bg-black z-20"
            style={{
              opacity: ready ? 0 : 1,
              transition: ready ? "opacity 220ms linear" : "none",
              pointerEvents: ready ? "none" : "auto",
            }}
          >
            <LoadingScreen
              world={world}
              message={
                characterFlowActive ? "Entering world..." : preparationStage
              }
              fadingOut={ready}
            />
            {readinessError && (
              <LoadingReadinessWarning
                blocked={meadowBlocked}
                stage={preparationStage}
                message={readinessError}
                onReload={() => window.location.reload()}
              />
            )}
          </div>
        )}
        {kicked && <KickedOverlay code={kicked} />}
        {!kicked && entryRetry && (
          <WorldEntryRecoveryOverlay
            state={entryRetry}
            onRetry={() => {
              const network = world.network as ClientNetwork;
              network.retryEnterWorld();
              setEntryRetry(network.entryRetryState);
            }}
            onReload={() => window.location.reload()}
          />
        )}
        {deathScreen && <DeathScreen data={deathScreen} world={world} />}
      </main>
    </ChatProvider>
  );
}

function ActionsBlock({ world }: { world: ClientWorld }) {
  const [showActions, setShowActions] = useState(() => world.prefs?.actions);
  useEffect(() => {
    const onPrefsChange = (changes: Record<string, { value: unknown }>) => {
      if (changes.actions) setShowActions(changes.actions.value as boolean);
    };
    world.prefs?.on("change", onPrefsChange);
    return () => {
      world.prefs?.off("change", onPrefsChange);
    };
  }, []);
  if (isTouch) return null;
  if (!showActions) return null;
  return (
    <div className="absolute flex flex-col items-center top-[calc(2rem+env(safe-area-inset-top))] left-[calc(2rem+env(safe-area-inset-left))] bottom-[calc(2rem+env(safe-area-inset-bottom))] xl:top-[calc(2rem+env(safe-area-inset-top))] xl:left-[calc(2rem+env(safe-area-inset-left))] xl:bottom-[calc(2rem+env(safe-area-inset-bottom))] max-xl:top-[calc(1rem+env(safe-area-inset-top))] max-xl:left-[calc(1rem+env(safe-area-inset-left))] max-xl:bottom-[calc(1rem+env(safe-area-inset-bottom))]">
      <Actions world={world} />
    </div>
  );
}

function Actions({ world }: { world: ClientWorld }) {
  const [actions, setActions] = useState(() => world.controls?.actions || []);
  useEffect(() => {
    const handleActions = (data: unknown) => {
      if (Array.isArray(data)) {
        setActions(data);
      }
    };
    world.on(EventType.UI_ACTIONS_UPDATE, handleActions);
    return () => {
      world.off(EventType.UI_ACTIONS_UPDATE, handleActions);
    };
  }, []);
  return (
    <div className="actions flex-1 flex flex-col justify-center">
      {actions.map((action) => (
        <div className="actions-item flex items-center mb-2" key={action.id}>
          <div className="actions-item-icon">{getActionIcon(action)}</div>
          <div
            className="actions-item-label ml-2.5"
            style={{
              paintOrder: "stroke fill",
              WebkitTextStroke: "0.25rem rgba(0, 0, 0, 0.2)",
            }}
          >
            {(action as ControlAction & { label?: string }).label}
          </div>
        </div>
      ))}
    </div>
  );
}

function getActionIcon(
  action: ControlAction & { btn?: string; label?: string },
) {
  if (action.type === "custom") {
    return <ActionPill label={action.btn || ""} />;
  }
  if (action.type === "controlLeft") {
    return <ActionPill label="Ctrl" />;
  }
  if (action.type === "mouseLeft") {
    return <ActionIcon icon={MouseLeftIcon} />;
  }
  if (action.type === "mouseRight") {
    return <ActionIcon icon={MouseRightIcon} />;
  }
  if (action.type === "mouseWheel") {
    return <ActionIcon icon={MouseWheelIcon} />;
  }
  if (buttons.has(action.type)) {
    return (
      <ActionPill
        label={propToLabel[action.type as keyof typeof propToLabel]}
      />
    );
  }
  return <ActionPill label="?" />;
}

function ActionPill({ label }: { label: string }) {
  return (
    <div
      className="actionpill border border-white rounded bg-black/10 px-1.5 py-1 text-[0.875em] shadow-md"
      style={{
        paintOrder: "stroke fill",
        WebkitTextStroke: "0.25rem rgba(0, 0, 0, 0.2)",
      }}
    >
      {label}
    </div>
  );
}

function ActionIcon({ icon }: { icon: IconComponent }) {
  const Icon = icon;
  return (
    <div className="actionicon leading-none drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]">
      <Icon size="1.5rem" />
    </div>
  );
}

function Toast({ world }: { world: ClientWorld }) {
  const [msg, setMsg] = useState<{
    text: string;
    id: number;
    position?: { x: number; y: number };
  } | null>(null);
  useEffect(() => {
    let ids = 0;
    const onToast = (data: EventMap[EventType.UI_TOAST]) => {
      setMsg({ text: data.message, id: ++ids, position: data.position });
    };
    world.on(EventType.UI_TOAST, onToast);
    return () => {
      world.off(EventType.UI_TOAST, onToast);
    };
  }, []);
  if (!msg) return null;

  // modern MMORPG-style: If position is provided, render positioned tooltip
  if (msg.position) {
    return (
      <>
        <style>{`
          @keyframes examineTooltipIn {
            from {
              opacity: 0;
              transform: scale(0.95);
            }
            to {
              opacity: 1;
              transform: scale(1);
            }
          }
        `}</style>
        <PositionedToast key={msg.id} text={msg.text} position={msg.position} />
      </>
    );
  }

  // Default: Centered toast (for system messages)
  return (
    <div
      className="absolute left-0 right-0 flex justify-center"
      style={{
        top: "calc(50% - 4.375rem)",
      }}
    >
      <style>{`
        @keyframes toastIn {
          from {
            opacity: 0;
            transform: translateY(10px) scale(0.9);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
      {msg && <ToastMsg key={msg.id} text={msg.text} />}
    </div>
  );
}

/** modern MMORPG-style positioned tooltip that appears near cursor */
function PositionedToast({
  text,
  position,
}: {
  text: string;
  position: { x: number; y: number };
}) {
  const [visible, setVisible] = useState(true);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const tooltipRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Calculate position with edge detection
    const tooltipWidth = 250; // Estimated max width
    const tooltipHeight = 40; // Estimated height
    const offset = 15; // Offset from cursor
    const padding = 10; // Padding from viewport edge

    let x = position.x + offset;
    let y = position.y + offset;

    // Flip horizontally if too close to right edge
    if (x + tooltipWidth + padding > window.innerWidth) {
      x = position.x - tooltipWidth - offset;
    }

    // Flip vertically if too close to bottom edge
    if (y + tooltipHeight + padding > window.innerHeight) {
      y = position.y - tooltipHeight - offset;
    }

    // Clamp to viewport
    x = Math.max(
      padding,
      Math.min(x, window.innerWidth - tooltipWidth - padding),
    );
    y = Math.max(
      padding,
      Math.min(y, window.innerHeight - tooltipHeight - padding),
    );

    setCoords({ x, y });

    // modern MMORPG-style: Display for 2.5 seconds then fade out
    const timer = setTimeout(() => setVisible(false), 2500);
    return () => clearTimeout(timer);
  }, [position]);

  return (
    <div
      ref={tooltipRef}
      className={cls("fixed pointer-events-none max-w-[250px]", {
        "opacity-100 scale-100 animate-[examineTooltipIn_0.15s_ease-out]":
          visible,
        "opacity-0 scale-95 transition-all duration-300 ease-in-out": !visible,
      })}
      style={{
        left: `${coords.x}px`,
        top: `${coords.y}px`,
        padding: `${spacing.sm} ${spacing.md}`,
        background: COLORS.BG_SOLID,
        border: `1px solid ${COLORS.BORDER_SECONDARY}`,
        backdropFilter: "blur(8px)",
        borderRadius: borderRadius.lg,
        boxShadow: shadows.panel,
        zIndex: zIndex.tooltip,
        color: COLORS.TEXT_PRIMARY,
        fontSize: typography.fontSize.sm,
        fontFamily: typography.fontFamily.body,
        fontWeight: typography.fontWeight.medium,
      }}
    >
      {text}
    </div>
  );
}

function ToastMsg({ text }: { text: string }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), 3000); // Show for 3 seconds
    return () => clearTimeout(timer);
  }, []);
  return (
    <div
      className={cls(
        "flex items-center justify-center transition-all duration-100 ease-in-out",
        {
          "opacity-100 translate-y-0 scale-100 animate-[toastIn_0.1s_ease-in-out]":
            visible,
          "opacity-0 translate-y-2.5 scale-90": !visible,
        },
      )}
      style={{
        height: spacing["4xl"],
        padding: `0 ${spacing.lg}`,
        background: COLORS.BG_SOLID,
        border: `1px solid ${COLORS.BORDER_SECONDARY}`,
        backdropFilter: "blur(5px)",
        borderRadius: borderRadius.full,
        color: COLORS.TEXT_PRIMARY,
        fontSize: typography.fontSize.base,
        fontFamily: typography.fontFamily.body,
        fontWeight: typography.fontWeight.medium,
      }}
    >
      {text}
    </div>
  );
}

function TouchBtns({ world }: { world: ClientWorld }) {
  const theme = useThemeStore((s) => s.theme);
  const [isAction, setIsAction] = useState(() => {
    const prefs = world.prefs as { touchAction?: boolean };
    return prefs?.touchAction;
  });
  useEffect(() => {
    function onChange(isAction: boolean) {
      setIsAction(isAction);
    }
    world.prefs?.on("touchAction", onChange);
    return () => {
      world.prefs?.off("touchAction", onChange);
    };
  }, []);
  return (
    <div
      className="absolute flex flex-col items-center gap-2"
      style={{
        bottom: "calc(1rem + env(safe-area-inset-bottom))",
        right: "calc(1rem + env(safe-area-inset-right))",
      }}
    >
      {isAction && (
        <div
          role="button"
          tabIndex={0}
          aria-label="Action"
          className="pointer-events-auto w-14 h-14 flex items-center justify-center backdrop-blur-[5px] rounded-2xl cursor-pointer active:scale-95"
          style={{
            backgroundColor: theme.colors.state.danger,
            border: `1px solid ${theme.colors.state.danger}`,
            boxShadow: "0 0.125rem 0.25rem rgba(0,0,0,0.2)",
          }}
          onClick={() => {
            (
              world.controls as { action?: { onPress: () => void } }
            )?.action?.onPress();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              (
                world.controls as { action?: { onPress: () => void } }
              )?.action?.onPress();
            }
          }}
        >
          <HandIcon size={24} />
        </div>
      )}
    </div>
  );
}
