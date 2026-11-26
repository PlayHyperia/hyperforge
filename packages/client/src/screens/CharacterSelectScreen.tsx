/**
 * CharacterSelectScreen.tsx - Character Selection Screen
 *
 * UI for selecting or creating a character before entering the world.
 *
 * ## Wallet Architecture (Privy HD Wallets)
 *
 * This screen uses Privy's Hierarchical Deterministic (HD) wallet system.
 * Each user has ONE seed phrase that derives multiple wallets:
 *
 * - HD Index 0: User's main wallet (created automatically on first login via Privy config)
 * - HD Index 1: First character's wallet
 * - HD Index 2: Second character's wallet
 * - HD Index N: Nth character's wallet
 *
 * All wallets are:
 * - Derived from the same BIP-44 seed: m/44'/60'/0'/0/{index}
 * - Backed up automatically by Privy
 * - Recoverable from the user's main wallet
 * - Managed by Privy (no manual private key handling)
 *
 * This means users authenticate ONCE, then all character wallets are
 * created seamlessly without additional signatures or prompts.
 */

import {
  readPacket,
  writePacket,
  storage,
  AVATAR_OPTIONS,
} from "@hyperforge/shared";
import React from "react";
import { CharacterPreview } from "../game/character/CharacterPreview";
import { usePrivy, useCreateWallet } from "@privy-io/react-auth";
import { useThemeStore } from "@/ui";
import { ELIZAOS_API, GAME_WS_URL, CDN_URL } from "@/lib/api-config";
import { apiClient } from "@/lib/api-client";
import { privyAuthManager } from "@/auth/PrivyAuthManager";

type Character = {
  id: string;
  name: string;
  wallet?: string;
  isAgent?: boolean;
};

type CharacterTemplate = {
  id: number;
  name: string;
  description: string;
  emoji: string;
  templateUrl: string;
  // Full ElizaOS character configuration stored as JSON string in database
  templateConfig?: string;
};

// Music preference manager - syncs with game prefs
const getMusicEnabled = (): boolean => {
  const stored = localStorage.getItem("music_enabled");
  if (stored === null) return true; // Default to enabled
  return stored === "true";
};

const setMusicEnabled = (enabled: boolean): void => {
  localStorage.setItem("music_enabled", String(enabled));
  // Also update prefs if they exist (storage.get returns parsed object)
  const prefs = storage.get("prefs") as Record<string, unknown> | null;
  if (prefs) {
    const updated = { ...prefs, music: enabled ? 0.5 : 0 };
    storage.set("prefs", updated);
  }
};

// Intro Music Player Hook
const useIntroMusic = (enabled: boolean) => {
  const audioContextRef = React.useRef<AudioContext | null>(null);
  const sourceRef = React.useRef<AudioBufferSourceNode | null>(null);
  const gainNodeRef = React.useRef<GainNode | null>(null);
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [currentTrack, setCurrentTrack] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!enabled) {
      // Stop music if disabled
      if (sourceRef.current) {
        sourceRef.current.stop();
        sourceRef.current.disconnect();
        sourceRef.current = null;
      }
      setIsPlaying(false);
      return;
    }

    // Initialize audio context
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
      gainNodeRef.current = audioContextRef.current.createGain();
      gainNodeRef.current.connect(audioContextRef.current.destination);
      gainNodeRef.current.gain.value = 0.3; // 30% volume
    }

    const ctx = audioContextRef.current;
    const gainNode = gainNodeRef.current!;

    // Ref to track if resumeAudio listeners are active (for cleanup)
    let resumeAudioCleanup: (() => void) | null = null;

    // Load and play intro music
    const playIntroMusic = async () => {
      // Randomly select between intro tracks
      const track = Math.random() > 0.5 ? "1.mp3" : "2.mp3";
      setCurrentTrack(track);

      const musicPath = `${CDN_URL}/audio/music/intro/${track}`;

      // Load audio buffer (can do this before context is resumed)
      const response = await fetch(musicPath);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

      // Create source and connect (but don't start yet)
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.loop = true; // Loop the intro music
      source.connect(gainNode);
      sourceRef.current = source;

      // Helper to actually start playback
      const startPlayback = () => {
        // Fade in
        const now = ctx.currentTime;
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(0.3, now + 2); // 2 second fade in

        source.start(0);
        setIsPlaying(true);
      };

      // If context is already running, start immediately
      if (ctx.state === "running") {
        startPlayback();
        return;
      }

      // Otherwise, wait for user gesture to resume context and start playback
      const resumeAndPlay = async () => {
        await ctx.resume();
        // Remove listeners after resuming
        document.removeEventListener("click", resumeAndPlay);
        document.removeEventListener("keydown", resumeAndPlay);
        resumeAudioCleanup = null;
        // Now start playback
        startPlayback();
      };
      document.addEventListener("click", resumeAndPlay);
      document.addEventListener("keydown", resumeAndPlay);
      // Store cleanup function in case component unmounts before user interaction
      resumeAudioCleanup = () => {
        document.removeEventListener("click", resumeAndPlay);
        document.removeEventListener("keydown", resumeAndPlay);
      };
    };

    playIntroMusic();

    // Cleanup on unmount
    return () => {
      // Clean up resume audio listeners if still attached
      if (resumeAudioCleanup) {
        resumeAudioCleanup();
      }

      if (sourceRef.current) {
        const src = sourceRef.current;
        const ctx = audioContextRef.current!;
        const now = ctx.currentTime;

        // Fade out
        gainNodeRef.current!.gain.setValueAtTime(
          gainNodeRef.current!.gain.value,
          now,
        );
        gainNodeRef.current!.gain.linearRampToValueAtTime(0, now + 1);

        setTimeout(() => {
          src.stop();
          src.disconnect();
        }, 1000);
      }
    };
  }, [enabled]);

  return { isPlaying, currentTrack };
};

// Music Toggle Button Component
const MusicToggleButton = () => {
  const [enabled, setEnabled] = React.useState(getMusicEnabled());
  const entryGold = "#d4b06a";

  useIntroMusic(enabled);

  const toggleMusic = () => {
    const newEnabled = !enabled;
    setEnabled(newEnabled);
    setMusicEnabled(newEnabled);
  };

  return (
    <button
      onClick={toggleMusic}
      className="fixed top-4 left-4 z-50 bg-black/60 hover:bg-black/80 text-white rounded-lg px-4 py-2 border border-white/20 transition-all flex items-center gap-2 backdrop-blur-sm"
      title={enabled ? "Disable music" : "Enable music"}
      style={{
        color: entryGold,
        border: `1px solid ${entryGold}4d`,
      }}
    >
      <span className="text-xl">{enabled ? "🔊" : "🔇"}</span>
      <span className="text-sm font-medium">
        {enabled ? "Music On" : "Music Off"}
      </span>
    </button>
  );
};

// Agent Dashboard Button Component
const AgentDashboardButton = () => {
  const entryGold = "#d4b06a";
  return (
    <a
      href={`${window.location.origin}/?page=dashboard`}
      target="_blank"
      rel="noopener noreferrer"
      className="fixed bottom-4 right-4 z-50 bg-black/60 hover:bg-black/80 rounded-lg px-4 py-2 transition-all flex items-center gap-2 backdrop-blur-sm shadow-lg"
      style={{
        color: entryGold,
        border: `1px solid ${entryGold}4d`,
      }}
      title="Open Agent Dashboard"
    >
      <span className="text-xl">⚔️</span>
      <span className="text-sm font-medium">Agent Dashboard</span>
    </a>
  );
};

// Public leaderboard button
const LeaderboardButton = () => {
  const entryGold = "#d4b06a";
  return (
    <a
      href={`${window.location.origin}/?page=leaderboard`}
      target="_blank"
      rel="noopener noreferrer"
      className="fixed bottom-20 right-4 z-50 bg-black/60 hover:bg-black/80 rounded-lg px-4 py-2 transition-all flex items-center gap-2 backdrop-blur-sm shadow-lg"
      style={{
        color: entryGold,
        border: `1px solid ${entryGold}4d`,
      }}
      title="Open Leaderboard"
    >
      <span className="text-sm font-medium">Leaderboard</span>
    </a>
  );
};

export function CharacterSelectScreen({
  wsUrl,
  onPlay,
  onLogout,
}: {
  wsUrl: string;
  onPlay: (selectedCharacterId: string | null) => void;
  onLogout: () => void;
}) {
  const theme = useThemeStore((s) => s.theme);
  const entryGold = "#d4b06a";
  const entryGoldBright = "#f0d59a";
  const entryGoldSoft = "#b89354";
  const [characters, setCharacters] = React.useState<Character[]>([]);
  // Sort characters alphabetically by name for display
  const sortedCharacters = React.useMemo(
    () => [...characters].sort((a, b) => a.name.localeCompare(b.name)),
    [characters],
  );
  const [selectedCharacterId, setSelectedCharacterId] = React.useState<
    string | null
  >(null);
  const [newCharacterName, setNewCharacterName] = React.useState("");
  const [wsReady, setWsReady] = React.useState(false);
  const [view, setView] = React.useState<"select" | "confirm" | "create">(
    "select",
  );
  const [showCreate, setShowCreate] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [selectedAvatarIndex, setSelectedAvatarIndex] = React.useState(0);
  const [creatingCharacter, setCreatingCharacter] = React.useState(false);
  // Check if we're creating an agent from dashboard
  const urlParams = new URLSearchParams(window.location.search);
  const createAgentMode = urlParams.get("createAgent") === "true";

  const [characterType, setCharacterType] = React.useState<"human" | "agent">(
    createAgentMode ? "agent" : "human",
  );
  const [elizaOSAvailable, setElizaOSAvailable] = React.useState(false);
  const [checkingElizaOS, setCheckingElizaOS] = React.useState(true);

  // Character templates
  const [templates, setTemplates] = React.useState<CharacterTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] =
    React.useState<CharacterTemplate | null>(null);
  const [loadingTemplates, setLoadingTemplates] = React.useState(false);

  // Privy hooks
  const { user, ready, authenticated } = usePrivy();
  const { createWallet } = useCreateWallet();

  // Refs for message handler state (prevents stale closures)
  const characterTypeRef = React.useRef(characterType);
  const selectedAvatarIndexRef = React.useRef(selectedAvatarIndex);
  const selectedTemplateRef = React.useRef(selectedTemplate);
  const userRef = React.useRef(user);

  // Check if ElizaOS is available with Hyperia plugin
  React.useEffect(() => {
    const checkElizaOS = async () => {
      try {
        // Check if ElizaOS API is running
        const response = await fetch(`${ELIZAOS_API}/agents`, {
          method: "GET",
        });

        if (!response.ok) {
          setElizaOSAvailable(false);
          setCheckingElizaOS(false);
          return;
        }

        // ElizaOS is running - assume Hyperia plugin is available
        // (Plugin availability is verified during agent creation)
        setElizaOSAvailable(true);
        console.log("[CharacterSelect] ✅ ElizaOS detected and available");
      } catch (error) {
        console.log(
          "[CharacterSelect] ℹ️ ElizaOS not detected (AI agents disabled)",
        );
        console.warn(
          "[CharacterSelect] ElizaOS availability check failed:",
          error instanceof Error ? error.message : String(error),
        );
        setElizaOSAvailable(false);
      } finally {
        setCheckingElizaOS(false);
      }
    };

    checkElizaOS();
  }, []);

  // Sync refs with current state (allows message handlers to access latest values)
  React.useEffect(() => {
    characterTypeRef.current = characterType;
    selectedAvatarIndexRef.current = selectedAvatarIndex;
    selectedTemplateRef.current = selectedTemplate;
    userRef.current = user;
  }, [characterType, selectedAvatarIndex, selectedTemplate, user]);

  // Auto-open create form if in createAgent mode
  React.useEffect(() => {
    if (createAgentMode && !showCreate && !checkingElizaOS) {
      if (elizaOSAvailable) {
        setShowCreate(true);
      } else {
        // ElizaOS not available, show error
        setErrorMessage(
          "ElizaOS is not running. Please start ElizaOS to create AI agents.",
        );
      }
    }
  }, [createAgentMode, showCreate, checkingElizaOS, elizaOSAvailable]);

  // Fetch character templates when ElizaOS is available
  React.useEffect(() => {
    const fetchTemplates = async () => {
      if (!elizaOSAvailable) return;

      setLoadingTemplates(true);
      try {
        const result = await apiClient.get<{
          success: boolean;
          templates: CharacterTemplate[];
        }>("/api/templates");
        if (result.ok && result.data?.success && result.data.templates) {
          setTemplates(result.data.templates);
          // Auto-select first template as default
          if (result.data.templates.length > 0) {
            setSelectedTemplate(result.data.templates[0]);
          }
          console.log(
            "[CharacterSelect] ✅ Loaded character templates:",
            result.data.templates,
          );
        }
      } catch (error) {
        console.error("[CharacterSelect] ❌ Failed to fetch templates:", error);
      } finally {
        setLoadingTemplates(false);
      }
    };

    fetchTemplates();
  }, [elizaOSAvailable]);
  const preWsRef = React.useRef<WebSocket | null>(null);
  const pendingActionRef = React.useRef<null | {
    type: "create";
    name: string;
  }>(null);
  // Ref for synchronous double-click prevention when entering world
  const enteringWorldRef = React.useRef(false);

  // Reconnection state and refs
  const reconnectAttemptsRef = React.useRef(0);
  const reconnectTimeoutRef = React.useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const intentionalDisconnectRef = React.useRef(false);
  const MAX_RECONNECT_ATTEMPTS = 5;
  const [connectionState, setConnectionState] = React.useState<
    "disconnected" | "connecting" | "connected" | "reconnecting" | "failed"
  >("disconnected");
  // Use primitive states instead of object to prevent unnecessary re-renders
  // Initialize from PrivyAuthManager with localStorage fallback
  const [authToken, setAuthToken] = React.useState(
    privyAuthManager.getToken() ||
      localStorage.getItem("privy_auth_token") ||
      "",
  );
  const [privyUserId, setPrivyUserId] = React.useState(
    privyAuthManager.getUserId() || localStorage.getItem("privy_user_id") || "",
  );

  const syncPrivyAuthState = React.useCallback(() => {
    const nextToken =
      privyAuthManager.getToken() ||
      localStorage.getItem("privy_auth_token") ||
      "";
    const nextUserId =
      privyAuthManager.getUserId() ||
      userRef.current?.id ||
      localStorage.getItem("privy_user_id") ||
      "";

    if (nextToken && nextToken !== authToken) {
      setAuthToken(nextToken);
    }
    if (nextUserId && nextUserId !== privyUserId) {
      setPrivyUserId(nextUserId);
    }
  }, [authToken, privyUserId]);

  // Subscribe to PrivyAuthManager state changes
  React.useEffect(() => {
    const unsubscribe = privyAuthManager.subscribe((state) => {
      const newToken = state.privyToken || "";
      const newUserId = state.privyUserId || userRef.current?.id || "";
      if (newToken && newToken !== authToken) setAuthToken(newToken);
      if (newUserId && newUserId !== privyUserId) setPrivyUserId(newUserId);
    });
    return unsubscribe;
  }, [authToken, privyUserId]);

  // Watch for Privy auth being written to localStorage as fallback
  React.useEffect(() => {
    const onStorage = (e: Event) => {
      const storageEvent = e as { key?: string | null };
      if (!storageEvent.key) return;
      if (storageEvent.key === "privy_auth_token") {
        syncPrivyAuthState();
      }
      if (storageEvent.key === "privy_user_id") {
        syncPrivyAuthState();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [syncPrivyAuthState]);

  React.useEffect(() => {
    if (!ready || !authenticated) return;
    syncPrivyAuthState();
  }, [ready, authenticated, syncPrivyAuthState]);

  // Debug logging for state changes
  React.useEffect(() => {}, [wsReady, showCreate, characters]);

  React.useEffect(() => {
    // Wait for Privy to finish initializing and authenticating
    if (!ready || !authenticated) {
      setWsReady(false);
      setConnectionState("disconnected");
      return; // Don't create websocket until Privy is ready
    }

    // CRITICAL: Verify Privy user object exists before attempting connection
    // This prevents race conditions where `authenticated=true` but user data isn't loaded yet
    const currentUser = userRef.current;
    if (!currentUser || !currentUser.id) {
      setWsReady(false);
      setConnectionState("disconnected");
      return;
    }

    // Use the SDK user id as the source of truth and allow the token to arrive
    // through either the auth manager or localStorage.
    if (!privyUserId) {
      setPrivyUserId(currentUser.id);
    }

    if (!authToken || !privyUserId) {
      syncPrivyAuthState();
      setWsReady(false);
      setConnectionState("disconnected");
      return; // Don't create websocket without auth
    }

    // Extra validation: ensure localStorage privyUserId matches Privy hook user.id
    // This catches cases where stale tokens are in localStorage
    if (currentUser.id !== privyUserId) {
      console.warn(
        `[CharacterSelect] ⚠️ Privy user ID mismatch! Hook: ${currentUser.id}, localStorage: ${privyUserId}`,
      );
      localStorage.removeItem("privy_auth_token");
      localStorage.removeItem("privy_user_id");
      setAuthToken("");
      setPrivyUserId("");
      setWsReady(false);
      setConnectionState("disconnected");
      return;
    }

    // Reset reconnection state for fresh connection
    intentionalDisconnectRef.current = false;
    reconnectAttemptsRef.current = 0;

    // Create WebSocket connection with reconnection support
    const connect = (): void => {
      // Don't connect if intentionally disconnected
      if (intentionalDisconnectRef.current) return;

      // AUTHENTICATION: Include authToken in URL for reliable authentication
      // The server supports both URL-based auth and first-message auth.
      // Using URL-based auth for reliability - it works consistently across all environments.
      // While URL params can appear in logs, the authToken is a short-lived JWT,
      // and the server properly validates it before granting access.
      let urlWithAuth = wsUrl;
      if (authToken) {
        const queryParts = [`authToken=${encodeURIComponent(authToken)}`];
        if (privyUserId) {
          queryParts.push(`privyUserId=${encodeURIComponent(privyUserId)}`);
        }
        const separator = wsUrl.includes("?") ? "&" : "?";
        urlWithAuth = `${wsUrl}${separator}${queryParts.join("&")}`;
      }

      setConnectionState(
        reconnectAttemptsRef.current > 0 ? "reconnecting" : "connecting",
      );

      const ws = new WebSocket(urlWithAuth);
      ws.binaryType = "arraybuffer";
      preWsRef.current = ws;
      setWsReady(false);

      // Track if we've received auth result
      let authCompleted = false;

      // Define named handlers for proper cleanup
      const handleOpen = (): void => {};

      // Handle auth result messages - need to intercept authResult before wsReady
      const handleAuthMessage = (event: MessageEvent): void => {
        if (authCompleted) return;

        const packetResult = readPacket(event.data as ArrayBuffer);
        if (!packetResult || packetResult.length === 0) return;

        const [method, data] = packetResult;

        // Handle both authResult (first-message auth) and snapshot (URL-based auth)
        if (method === "onAuthResult") {
          const result = data as { success: boolean; error?: string };

          // Remove auth handler since we're done with auth phase
          ws.removeEventListener("message", handleAuthMessage);

          if (result.success) {
            authCompleted = true;

            // Reset reconnection state on successful auth
            reconnectAttemptsRef.current = 0;
            setConnectionState("connected");
            setWsReady(true);

            // Request character list from server
            const packet = writePacket("characterListRequest", {});
            ws.send(packet);

            // Flush any pending create
            const pending = pendingActionRef.current;
            if (pending && pending.type === "create") {
              ws.send(writePacket("characterCreate", { name: pending.name }));
              pendingActionRef.current = null;
            }
          } else {
            console.error(
              "[CharacterSelect] ❌ Authentication failed:",
              result.error,
            );
            setConnectionState("disconnected");
            // Let the close handler deal with reconnection
          }
        } else if (method === "onSnapshot") {
          // URL-based auth succeeded - snapshot received directly
          console.log(
            "[CharacterSelect] ✅ Authentication successful (URL-based auth)",
          );
          authCompleted = true;

          // Remove auth handler since we're done with auth phase
          ws.removeEventListener("message", handleAuthMessage);

          // Reset reconnection state on successful auth
          reconnectAttemptsRef.current = 0;
          setConnectionState("connected");
          setWsReady(true);

          // The snapshot contains character list - let handleMessage process it
          // Re-dispatch this event so handleMessage can process it
          handleMessage(event);
        } else if (method === "onKick") {
          // Authentication or connection rejected
          const reason = data as string;
          console.error("[CharacterSelect] ❌ Kicked:", reason);
          ws.removeEventListener("message", handleAuthMessage);
          setConnectionState("disconnected");
          setErrorMessage(reason.replace("banned: ", ""));
        }
      };

      ws.addEventListener("message", handleAuthMessage);

      const handleError = (err: Event): void => {
        console.error("[CharacterSelect] ❌ WebSocket ERROR:", err);
      };

      const handleClose = (event: CloseEvent): void => {
        setWsReady(false);

        // Don't reconnect if intentionally closed
        if (intentionalDisconnectRef.current) {
          setConnectionState("disconnected");
          return;
        }

        console.log(
          `[CharacterSelect] 🔌 WebSocket closed (code: ${event.code}, reason: ${event.reason || "none"})`,
        );

        // Attempt reconnection with exponential backoff
        if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.min(
            1000 * Math.pow(2, reconnectAttemptsRef.current),
            30000,
          );
          reconnectAttemptsRef.current++;

          console.log(
            `[CharacterSelect] 🔄 Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS})`,
          );
          setConnectionState("reconnecting");

          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, delay);
        } else {
          console.error(
            "[CharacterSelect] ❌ Max reconnection attempts exceeded",
          );
          setConnectionState("failed");
        }
      };

      const handleMessage = (e: MessageEvent): void => {
        const result = readPacket(e.data);
        if (!result) {
          console.warn(
            "[CharacterSelect] ⚠️ readPacket returned null/undefined",
          );
          return;
        }
        const [method, data] = result as [string, unknown];

        if (method === "onSnapshot") {
          // Extract characters from snapshot
          const snap = data as { characters?: Character[] };
          if (snap.characters && Array.isArray(snap.characters)) {
            setCharacters(snap.characters);
          }
        } else if (method === "onCharacterList") {
          const listData = data as { characters: Character[] };
          setCharacters(listData.characters);
        } else if (method === "onCharacterCreated") {
          const c = data as Character;
          setCharacters((prev) => {
            const newList = [...prev, c];
            return newList;
          });

          // Read current values from refs (prevents stale closures)
          const currentCharacterType = characterTypeRef.current;
          const currentUserFromRef = userRef.current;
          const currentSelectedTemplate = selectedTemplateRef.current;
          const currentSelectedAvatarIndex = selectedAvatarIndexRef.current;

          // AGENT FLOW: Generate JWT, create ElizaOS agent, redirect to character editor
          // HUMAN FLOW: Show "Enter World" confirmation screen
          if (currentCharacterType === "agent") {
            console.log(
              "[CharacterSelect] 🤖 Agent character created, generating JWT and creating ElizaOS agent...",
            );

            // Generate JWT and create ElizaOS agent immediately
            const createAgentAndRedirect = async () => {
              try {
                // Use user.id from Privy hook instead of localStorage to ensure correct Privy DID
                const accountId = currentUserFromRef?.id;
                if (!accountId) {
                  throw new Error(
                    "No account ID found - user not authenticated",
                  );
                }

                // Step 1: Generate JWT
                console.log("[CharacterSelect] 🔑 Generating JWT for agent...");
                const credentialsResult = await apiClient.post<{
                  authToken: string;
                }>("/api/agents/credentials", {
                  characterId: c.id,
                  accountId,
                });

                if (!credentialsResult.ok || !credentialsResult.data) {
                  throw new Error(
                    `Failed to generate JWT: ${credentialsResult.error || credentialsResult.status}`,
                  );
                }

                const credentials = credentialsResult.data;
                console.log("[CharacterSelect] ✅ JWT generated successfully");

                // Step 2: Get template config and create ElizaOS agent
                if (!currentSelectedTemplate) {
                  throw new Error("No character template selected");
                }

                console.log(
                  `[CharacterSelect] 📥 Using template: ${currentSelectedTemplate.name}`,
                );

                // Parse template config from database (stored as JSON string)
                // This avoids a separate fetch - config is already in the templates response
                let templateJson: Record<string, unknown>;
                if (currentSelectedTemplate.templateConfig) {
                  try {
                    templateJson = JSON.parse(
                      currentSelectedTemplate.templateConfig,
                    );
                    console.log(
                      "[CharacterSelect] ✅ Template config parsed from database",
                    );
                  } catch (parseError) {
                    console.error(
                      "[CharacterSelect] ❌ Failed to parse templateConfig:",
                      parseError,
                    );
                    throw new Error(
                      "Invalid template configuration in database",
                    );
                  }
                } else {
                  // Fallback: Fetch from templateUrl (legacy support)
                  console.log(
                    "[CharacterSelect] ⚠️ No templateConfig in database, fetching from URL...",
                  );
                  const templateResponse = await fetch(
                    currentSelectedTemplate.templateUrl,
                  );
                  if (!templateResponse.ok) {
                    throw new Error(
                      `Failed to fetch template: ${templateResponse.status}`,
                    );
                  }
                  templateJson = await templateResponse.json();
                  console.log("[CharacterSelect] ✅ Template fetched from URL");
                }

                // Remove fields that ElizaOS validation doesn't accept
                // Migration 0006 has 'modelProvider' but ElizaOS schema rejects it
                delete templateJson.modelProvider;

                // Merge template with character-specific data
                // Handle case where templateJson.settings might not exist
                const baseSettings = (templateJson.settings || {}) as Record<
                  string,
                  unknown
                >;
                const baseSecrets = (baseSettings.secrets || {}) as Record<
                  string,
                  unknown
                >;

                const characterTemplate = {
                  ...templateJson,
                  name: c.name, // Override template name with character name
                  username: c.name.toLowerCase().replace(/\s+/g, "_"),
                  settings: {
                    ...baseSettings,
                    accountId,
                    characterId: c.id,
                    characterType: "ai-agent",
                    avatar:
                      AVATAR_OPTIONS[currentSelectedAvatarIndex]?.url || "",
                    secrets: {
                      ...baseSecrets,
                      HYPERIA_AUTH_TOKEN: credentials.authToken,
                      HYPERIA_CHARACTER_ID: c.id,
                      HYPERIA_ACCOUNT_ID: accountId,
                      HYPERIA_SERVER_URL: GAME_WS_URL,
                      wallet: c.wallet || "",
                    },
                  },
                };

                console.log(
                  `[CharacterSelect] 🤖 Creating ${currentSelectedTemplate.name} agent with character-specific data...`,
                );

                // Create agent in ElizaOS
                const createAgentResponse = await fetch(
                  `${ELIZAOS_API}/agents`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ characterJson: characterTemplate }),
                  },
                );

                if (!createAgentResponse.ok) {
                  const errorData = await createAgentResponse
                    .json()
                    .catch((parseError) => {
                      console.warn(
                        "[CharacterSelect] Failed to parse agent error response:",
                        parseError instanceof Error
                          ? parseError.message
                          : String(parseError),
                      );
                      return {};
                    });
                  throw new Error(
                    `Failed to create ElizaOS agent: ${errorData.error || createAgentResponse.statusText}`,
                  );
                }

                const agentResult = await createAgentResponse.json();
                console.log(
                  "[CharacterSelect] ✅ ElizaOS agent creation response:",
                  agentResult,
                );

                // Embedded server: data.agent.id. Legacy Eliza: data.character.id
                const agentId =
                  agentResult.data?.agent?.id ??
                  agentResult.data?.character?.id;

                if (!agentId) {
                  console.error(
                    "[CharacterSelect] ❌ No agent ID in response! Full response:",
                    agentResult,
                  );
                  throw new Error(
                    "Agent created but no ID was returned. Response structure may have changed.",
                  );
                }

                console.log(
                  "[CharacterSelect] ✅ Agent ID extracted:",
                  agentId,
                );

                // Store agent ID for dashboard
                localStorage.setItem("last_created_agent_id", agentId);

                // Step 3: Create agent mapping in Hyperia database (CRITICAL for dashboard)
                // This must happen BEFORE redirect so agent shows in dashboard even if user cancels editor
                console.log(
                  "[CharacterSelect] 📝 Creating agent mapping in Hyperia database...",
                );
                try {
                  const mappingResult = await apiClient.post(
                    "/api/agents/mappings",
                    {
                      agentId: agentId,
                      accountId: accountId,
                      characterId: c.id,
                      agentName: c.name,
                    },
                  );

                  if (!mappingResult.ok) {
                    console.error(
                      "[CharacterSelect] ⚠️ Failed to create agent mapping:",
                      mappingResult.error || mappingResult.status,
                    );
                    // Don't throw - agent was created, mapping is for dashboard filtering
                    // User can still use the agent, it just won't show in dashboard
                  } else {
                    console.log(
                      "[CharacterSelect] ✅ Agent mapping created successfully",
                    );
                  }
                } catch (mappingError) {
                  console.error(
                    "[CharacterSelect] ⚠️ Error creating agent mapping:",
                    mappingError,
                  );
                  // Don't throw - continue to editor even if mapping fails
                }

                // Step 4: Redirect to character editor for customization
                // Note: JWT is stored in agent's secrets, not passed in URL (security risk)
                const params = new URLSearchParams({
                  characterId: c.id,
                  agentId: agentId,
                  name: c.name,
                  wallet: c.wallet || "",
                  avatar: AVATAR_OPTIONS[selectedAvatarIndex]?.url || "",
                });

                window.location.href = `/?page=character-editor&${params.toString()}`;
              } catch (error) {
                console.error(
                  "[CharacterSelect] ❌ Failed to create agent:",
                  error,
                );
                setErrorMessage(
                  error instanceof Error
                    ? error.message
                    : "Failed to create agent. Please try again.",
                );
              }
            };

            createAgentAndRedirect();
            return; // Exit early - agents go to character editor, NOT to "Enter World"
          }

          // HUMAN FLOW: Show "Enter World" confirmation screen
          // This ONLY runs for human players (agents exit early above)
          setSelectedCharacterId(c.id);
          setView("confirm"); // Show the "Enter World" confirmation screen
          setShowCreate(false);
          const currentWs = preWsRef.current!;
          if (currentWs.readyState === WebSocket.OPEN) {
            currentWs.send(
              writePacket("characterSelected", { characterId: c.id }),
            );
          }
        } else if (method === "onCharacterSelected") {
          const payload = data as { characterId: string | null };
          setSelectedCharacterId(payload.characterId || null);
          if (payload.characterId) setView("confirm");
        } else if (method === "onEntityEvent") {
          const evt = data as {
            id?: string;
            version?: number;
            name?: string;
            data?: unknown;
          };
          if (evt?.name === "character:list") {
            const list =
              (evt.data as { characters?: Character[] })?.characters || [];
            setCharacters(list);
          }
        } else if (method === "onEnterWorldApproved") {
          // Server approved entering world - proceed to game
          const payload = data as { characterId: string };
          console.log(
            "[CharacterSelect] ✅ Enter world approved for:",
            payload.characterId,
          );
          enteringWorldRef.current = false;
          setEnteringWorld(false);
          // Mark as intentional disconnect before transitioning to game
          intentionalDisconnectRef.current = true;
          // Call onPlay to transition to game
          onPlayRef.current(payload.characterId);
        } else if (method === "onEnterWorldRejected") {
          // Character is already logged in on another session
          const payload = data as { reason: string; message: string };
          console.warn(
            "[CharacterSelect] ⚠️ Enter world rejected:",
            payload.reason,
          );
          enteringWorldRef.current = false;
          setEnteringWorld(false);
          setErrorMessage(payload.message);
          // Stay on character select screen (already on confirm view, just show error)
        } else if (method === "onShowToast") {
          const toast = data as { message?: string; type?: string };
          console.error("[CharacterSelect] ❌ Server error:", toast.message);
          setErrorMessage(toast.message || "An error occurred");
        } else if (method === "onEntityModified") {
          // Entity updates are not relevant for character selection screen
          // These are real-time position/rotation/velocity updates that happen in the world
          // Silently ignore them
        }
      };

      // Add event listeners with named handlers for proper cleanup
      ws.addEventListener("open", handleOpen);
      ws.addEventListener("error", handleError);
      ws.addEventListener("close", handleClose);
      ws.addEventListener("message", handleMessage);
    };

    // Start initial connection
    connect();

    return () => {
      // Mark as intentional disconnect to prevent reconnection attempts
      intentionalDisconnectRef.current = true;

      // Clear any pending reconnection timeout
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      // Close WebSocket
      const ws = preWsRef.current;
      if (ws) {
        ws.close();
        preWsRef.current = null;
      }

      setConnectionState("disconnected");
    };
  }, [wsUrl, authToken, privyUserId, ready, authenticated]);

  const selectCharacter = React.useCallback(
    async (id: string) => {
      // Find the character to check if it's an AI agent
      const character = characters.find((c) => c.id === id);

      if (character?.isAgent) {
        // AI AGENT: Check if agent exists in ElizaOS
        console.log(
          "[CharacterSelect] 🤖 AI agent selected, checking if agent exists in ElizaOS...",
        );

        try {
          // Try to fetch agent from ElizaOS by character ID
          const response = await fetch(`${ELIZAOS_API}/agents`);
          if (response.ok) {
            const data = await response.json();
            const agents = data.data?.agents || [];

            // Check if agent exists for this character
            const agentExists = agents.some(
              (agent: {
                name?: string;
                settings?: { secrets?: { HYPERIA_CHARACTER_ID?: string } };
              }) =>
                agent.settings?.secrets?.HYPERIA_CHARACTER_ID === id ||
                agent.name === character.name,
            );

            if (agentExists) {
              // Agent exists - go to dashboard with agent pre-selected
              console.log(
                "[CharacterSelect] ✅ Agent exists, redirecting to dashboard...",
              );
              window.location.href = `/?page=dashboard&agentId=${encodeURIComponent(id)}`;
            } else {
              // Agent doesn't exist - go to character editor to create it
              console.log(
                "[CharacterSelect] ⚠️ Agent doesn't exist, redirecting to editor...",
              );

              // Fetch full character data from Hyperia DB to get avatar
              const accountId = user?.id;
              if (!accountId) {
                throw new Error("No account ID - user not authenticated");
              }
              const hyperiaResult = await apiClient.get<{
                characters?: { id: string; avatar?: string }[];
              }>(`/api/characters/${accountId}`);

              let avatarUrl = "";
              if (hyperiaResult.ok && hyperiaResult.data) {
                const hyperiaChar = hyperiaResult.data.characters?.find(
                  (c: { id: string }) => c.id === id,
                );
                avatarUrl = hyperiaChar?.avatar || "";
                console.log(
                  "[CharacterSelect] Loaded avatar from Hyperia DB:",
                  avatarUrl,
                );
              }

              window.location.href = `/?page=character-editor&characterId=${id}&name=${encodeURIComponent(character.name)}&wallet=${encodeURIComponent(character.wallet || "")}&avatar=${encodeURIComponent(avatarUrl)}`;
            }
          } else {
            // ElizaOS not responding - show error
            setErrorMessage(
              "ElizaOS is not responding. Please check if it's running.",
            );
          }
        } catch (error) {
          console.error(
            "[CharacterSelect] ❌ Failed to check agent existence:",
            error,
          );
          setErrorMessage("Failed to connect to ElizaOS. Please try again.");
        }
        return;
      }

      // HUMAN PLAYER: Show confirmation screen to enter world
      console.log(
        "[CharacterSelect] 🎮 Human character selected, showing confirmation...",
      );
      setSelectedCharacterId(id);
      setView("confirm");

      // DON'T send characterSelected packet here!
      // For spectator mode: Browser should not spawn ANY character (human or agent)
      // Characters are only spawned when clicked "Enter World" OR by the agent service
      // This allows you to view the game world without controlling a character
    },
    [characters],
  );

  const createCharacter = React.useCallback(async () => {
    const name = newCharacterName.trim().slice(0, 20);

    if (!name || name.length < 3) {
      console.warn(
        "[CharacterSelect] ❌ Name validation failed - must be 3-20 characters",
      );
      setErrorMessage("Character name must be 3-20 characters");
      return;
    }

    // Prevent agent creation if ElizaOS is not available
    if (characterType === "agent" && !elizaOSAvailable) {
      setErrorMessage(
        "Cannot create AI agent: ElizaOS is not running. Please start ElizaOS first.",
      );
      return;
    }

    setCreatingCharacter(true);
    setErrorMessage(null);

    try {
      // Create HD wallet for character using Privy's native HD wallet system
      let walletAddress: string | undefined;

      if (user) {
        // Privy's HD wallet system creates additional wallets sequentially
        // The first call creates wallet at index 0, subsequent calls create wallets at indices 1, 2, 3, etc.
        // All wallets use Privy's BIP-44 derivation path: m/44'/60'/0'/0/{index}

        // Helper to clear corrupted Privy state from localStorage
        const clearPrivyState = () => {
          console.log(
            "[CharacterSelect] 🧹 Clearing potentially corrupted Privy wallet state...",
          );
          const keysToRemove: string[] = [];

          // Find all Privy wallet-related keys
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (
              key &&
              (key.startsWith("privy:wallets") ||
                key.startsWith("privy:embedded_wallets") ||
                key.includes("wallet_state"))
            ) {
              keysToRemove.push(key);
            }
          }

          // Remove them
          keysToRemove.forEach((key) => {
            console.log(`[CharacterSelect] Removing corrupted key: ${key}`);
            localStorage.removeItem(key);
          });

          console.log(
            `[CharacterSelect] ✅ Cleared ${keysToRemove.length} corrupted Privy keys`,
          );
        };

        // Attempt wallet creation with retry logic
        const MAX_RETRIES = 2;
        let retryCount = 0;
        let lastError: Error | null = null;

        while (!walletAddress && retryCount < MAX_RETRIES) {
          try {
            console.log(
              `[CharacterSelect] 🔑 Attempt ${retryCount + 1}/${MAX_RETRIES}: Creating HD wallet for character "${name}"`,
            );

            // Create an additional HD wallet in the sequence
            // Privy manages the index internally - we just request a new wallet
            const characterWallet = await createWallet({
              createAdditional: true,
            });

            walletAddress = characterWallet.address;
            console.log(
              `[CharacterSelect] ✅ HD wallet created:`,
              walletAddress,
            );
            break; // Success! Exit retry loop
          } catch (walletError) {
            lastError = walletError as Error;
            const errorStr = String(walletError);
            const errorMsg = lastError.message || errorStr;

            console.error(
              `[CharacterSelect] ❌ Wallet creation attempt ${retryCount + 1} failed:`,
              walletError,
            );

            // Check if this is a Privy state corruption error (JSON parse error)
            const isCorruptionError =
              errorStr.includes("SyntaxError") ||
              errorStr.includes("JSON") ||
              errorStr.includes("setImmedia") ||
              errorMsg.includes("JSON") ||
              errorMsg.includes("parse");

            if (isCorruptionError && retryCount < MAX_RETRIES - 1) {
              console.log(
                "[CharacterSelect] 🔧 Detected Privy state corruption, clearing and retrying...",
              );
              clearPrivyState();
              retryCount++;

              // Wait 500ms before retry to let Privy settle
              await new Promise((resolve) => setTimeout(resolve, 500));
            } else {
              // Either not a corruption error, or we've exhausted retries
              retryCount = MAX_RETRIES; // Force exit
            }
          }
        }

        // If wallet creation failed after all retries
        if (!walletAddress) {
          console.error(
            "[CharacterSelect] ❌ Failed to create HD wallet after all retries",
          );

          const errorMsg = lastError?.message || String(lastError);
          const isCorruptionError =
            errorMsg.includes("JSON") ||
            errorMsg.includes("SyntaxError") ||
            errorMsg.includes("setImmedia");

          setErrorMessage(
            isCorruptionError
              ? "Wallet creation failed due to corrupted browser data. Please refresh the page and try again."
              : `Failed to create wallet: ${errorMsg}`,
          );
          setCreatingCharacter(false);
          return;
        }
      } else {
        console.warn(
          "[CharacterSelect] ⚠️ No user authenticated, character will have no wallet",
        );
        setErrorMessage("You must be logged in to create a character.");
        setCreatingCharacter(false);
        return;
      }

      const ws = preWsRef.current;

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn(
          "[CharacterSelect] ⚠️ WebSocket not ready, queueing create request",
        );
        pendingActionRef.current = { type: "create", name };
        setCreatingCharacter(false);
        return;
      }

      const packet = writePacket("characterCreate", {
        name,
        wallet: walletAddress,
        avatar: AVATAR_OPTIONS[selectedAvatarIndex].url,
        isAgent: characterType === "agent",
      });
      ws.send(packet);

      setNewCharacterName("");
      // Don't hide the create form yet - wait for server response
    } catch (error) {
      console.error("[CharacterSelect] ❌ Failed to create character:", error);
      setErrorMessage("Failed to create character. Please try again.");
    } finally {
      setCreatingCharacter(false);
    }
  }, [
    newCharacterName,
    user,
    characters.length,
    selectedAvatarIndex,
    createWallet,
    characterType,
    elizaOSAvailable,
  ]);

  // State for "entering world" loading
  const [enteringWorld, setEnteringWorld] = React.useState(false);

  // Store onPlay in ref so message handler can access it
  const onPlayRef = React.useRef(onPlay);
  React.useEffect(() => {
    onPlayRef.current = onPlay;
  }, [onPlay]);

  const enterWorld = React.useCallback(() => {
    // Use ref for synchronous check to prevent double-click race condition
    if (!selectedCharacterId || enteringWorldRef.current) return;
    enteringWorldRef.current = true;

    const ws = preWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      enteringWorldRef.current = false;
      setErrorMessage("Connection lost. Please refresh the page.");
      return;
    }

    // Set loading state and send enterWorld packet
    // Wait for server to respond with enterWorldApproved or enterWorldRejected
    setEnteringWorld(true);
    setErrorMessage(null);

    const packet = writePacket("enterWorld", {
      characterId: selectedCharacterId,
    });
    ws.send(packet);
  }, [selectedCharacterId]);

  const GoldRule = ({
    className = "",
    thick = false,
  }: {
    className?: string;
    thick?: boolean;
  }) => (
    <div
      className={`${thick ? "h-[2px]" : "h-px"} w-full ${className}`}
      style={{
        background: `linear-gradient(to right, transparent, ${entryGold}e6, transparent)`,
      }}
    />
  );

  return (
    <div className="absolute inset-0 overflow-hidden">
      <MusicToggleButton />
      <AgentDashboardButton />
      <LeaderboardButton />
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: "url('/images/app_background.png')",
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      />
      <div className="absolute inset-0 bg-black/80" />
      <div className="absolute inset-0 flex items-center justify-center text-white">
        <div className="w-full max-w-2xl mx-auto p-6">
          <div className="relative">
            <div className="mx-auto mt-20 md:mt-0 mb-2 w-full max-w-2xl flex items-center justify-center">
              <img
                src="/images/hyperia-wordmark.svg"
                alt="Hyperia"
                className="h-20 md:h-36 object-contain"
              />
            </div>
          </div>

          {view === "select" && (
            <div className="mt-8">
              {/* Error message display */}
              {errorMessage && (
                <div className="mb-3 mx-auto max-w-md p-3 bg-red-900/80 border border-red-500 rounded-lg text-center">
                  <p className="text-red-200 text-sm">{errorMessage}</p>
                </div>
              )}
              <div className="space-y-3 max-h-[360px] overflow-y-auto pr-2 scrollbar-thin">
                {sortedCharacters.map((c) => (
                  <div
                    key={c.id}
                    className="relative w-full overflow-hidden h-24"
                  >
                    <div className="flex items-center justify-between h-full p-4 pr-5">
                      <img
                        src="/images/stock_character.png"
                        alt=""
                        className="w-24 h-24 rounded-sm object-cover"
                      />
                      <div className="text-yellow-400 text-2xl">›</div>
                    </div>
                    {/* Gold lines and centered name that extend across the middle. Clickable area is only between the lines. */}
                    <div
                      className="absolute"
                      style={{
                        left: "112px",
                        right: "16px",
                        top: "50%",
                        transform: "translateY(-50%)",
                      }}
                    >
                      <GoldRule thick className="pointer-events-none" />
                      <button
                        onClick={() => selectCharacter(c.id)}
                        className="w-full px-4 py-3 text-center bg-black/40 hover:bg-black/50 focus:outline-none focus:ring-1 rounded-sm"
                        style={{
                          color: entryGold,
                          boxShadow: `0 0 0 1px ${entryGoldSoft}99`,
                        }}
                      >
                        <div className="flex items-center gap-2">
                          {c.isAgent && <span className="text-lg">🤖</span>}
                          <span className="font-semibold text-xl">
                            {c.name}
                          </span>
                          {c.isAgent && (
                            <span
                              className="text-xs font-medium"
                              style={{ color: theme.colors.state.info }}
                            >
                              AI Agent
                            </span>
                          )}
                        </div>
                      </button>
                      <GoldRule thick className="pointer-events-none" />
                    </div>
                  </div>
                ))}
                {sortedCharacters.length === 0 && (
                  <div className="text-sm opacity-70">No characters yet.</div>
                )}
              </div>

              {/* Create New button - always visible below character list */}
              {!showCreate && (
                <div className="relative w-full overflow-hidden h-24 mt-3">
                  <div className="flex items-center h-full p-4 pr-5">
                    <img
                      src="/images/stock_character.png"
                      alt=""
                      className="w-24 h-24 rounded-sm object-cover ml-auto"
                    />
                  </div>
                  <div
                    className="absolute"
                    style={{
                      left: "16px",
                      right: "112px",
                      top: "50%",
                      transform: "translateY(-50%)",
                    }}
                  >
                    <GoldRule thick className="pointer-events-none" />
                    <button
                      onClick={() => setShowCreate(true)}
                      className="w-full px-4 py-2 text-left bg-black/40 hover:bg-black/50 focus:outline-none focus:ring-1 ring-yellow-400/60 rounded-sm"
                    >
                      <span className="font-semibold text-xl">Create New</span>
                    </button>
                    <GoldRule thick className="pointer-events-none" />
                  </div>
                </div>
              )}

              {/* Character creation form with 3D preview - Side by side layout */}
              {showCreate && (
                <div className="w-full mt-3">
                  <div className="flex gap-4">
                    {/* Left Column - Name, Type, Preview, Cancel */}
                    <div
                      className={`space-y-3 ${characterType === "agent" && elizaOSAvailable ? "w-1/2" : "w-full"}`}
                    >
                      {/* Name Input Form */}
                      <form
                        className="w-full rounded bg-white/5"
                        onSubmit={(e) => {
                          e.preventDefault();
                          createCharacter();
                        }}
                      >
                        <GoldRule thick />
                        <div className="flex items-center gap-2 p-3 h-14">
                          <div className="flex-1">
                            <input
                              className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-white outline-none text-sm"
                              placeholder="Name (3–20 chars)"
                              value={newCharacterName}
                              onChange={(e) => {
                                setNewCharacterName(e.target.value);
                                // Clear any error message when user starts typing
                                if (errorMessage) {
                                  setErrorMessage(null);
                                }
                              }}
                              maxLength={20}
                              autoFocus
                              disabled={creatingCharacter}
                            />
                          </div>

                          <button
                            type="submit"
                            className={`px-3 py-1.5 rounded font-bold text-sm ${wsReady && newCharacterName.trim().length >= 3 && !creatingCharacter ? "bg-emerald-600 hover:bg-emerald-500" : "bg-white/20 cursor-not-allowed"}`}
                            disabled={
                              !wsReady ||
                              newCharacterName.trim().length < 3 ||
                              creatingCharacter
                            }
                          >
                            {creatingCharacter ? "Creating..." : "Create"}
                          </button>
                        </div>
                        <GoldRule thick />
                      </form>

                      {/* Character Type Selection */}
                      {!checkingElizaOS && (
                        <div
                          className="w-full rounded bg-black/60 p-3"
                          style={{
                            border: `1px solid ${entryGold}4d`,
                          }}
                        >
                          <div
                            className="text-sm font-semibold mb-2"
                            style={{ color: entryGold }}
                          >
                            Character Type
                          </div>
                          <div className="flex gap-2">
                            <label
                              className="flex-1 flex items-center gap-2 p-2 rounded-lg border-2 bg-black/40 cursor-pointer transition-all hover:bg-black/60"
                              style={{
                                borderColor: `${entryGold}4d`,
                              }}
                              onMouseEnter={(e) =>
                                (e.currentTarget.style.borderColor = `${entryGold}99`)
                              }
                              onMouseLeave={(e) =>
                                (e.currentTarget.style.borderColor = `${entryGold}4d`)
                              }
                            >
                              <input
                                type="radio"
                                name="characterType"
                                value="human"
                                checked={characterType === "human"}
                                onChange={(e) =>
                                  setCharacterType(
                                    e.target.value as "human" | "agent",
                                  )
                                }
                                className="w-4 h-4"
                                style={{
                                  accentColor: entryGold,
                                }}
                              />
                              <div className="flex-1">
                                <div
                                  className="font-medium text-sm"
                                  style={{ color: entryGold }}
                                >
                                  🎮 Human
                                </div>
                              </div>
                            </label>
                            {elizaOSAvailable ? (
                              <label
                                className="flex-1 flex items-center gap-2 p-2 rounded-lg border-2 bg-black/40 cursor-pointer transition-all hover:bg-black/60"
                                style={{
                                  borderColor: `${entryGold}4d`,
                                }}
                                onMouseEnter={(e) =>
                                  (e.currentTarget.style.borderColor = `${entryGold}99`)
                                }
                                onMouseLeave={(e) =>
                                  (e.currentTarget.style.borderColor = `${entryGold}4d`)
                                }
                              >
                                <input
                                  type="radio"
                                  name="characterType"
                                  value="agent"
                                  checked={characterType === "agent"}
                                  onChange={(e) =>
                                    setCharacterType(
                                      e.target.value as "human" | "agent",
                                    )
                                  }
                                  className="w-4 h-4"
                                  style={{
                                    accentColor: entryGold,
                                  }}
                                />
                                <div className="flex-1">
                                  <div
                                    className="font-medium text-sm"
                                    style={{ color: entryGold }}
                                  >
                                    🤖 AI Agent
                                  </div>
                                </div>
                              </label>
                            ) : (
                              <div
                                className="flex-1 flex items-center gap-2 p-2 rounded-lg border-2 bg-black/20 opacity-50"
                                style={{
                                  borderColor: `${theme.colors.border.decorative}33`,
                                }}
                              >
                                <input
                                  type="radio"
                                  name="characterType"
                                  value="agent"
                                  disabled
                                  className="w-4 h-4"
                                  style={{
                                    accentColor: theme.colors.text.disabled,
                                  }}
                                />
                                <div className="flex-1">
                                  <div
                                    className="font-medium text-sm"
                                    style={{
                                      color: theme.colors.text.disabled,
                                    }}
                                  >
                                    🤖 AI Agent
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* 3D Preview Section - Compact height */}
                      <div
                        className="relative w-full h-48 bg-black/60 rounded-lg overflow-hidden"
                        style={{
                          border: `1px solid ${entryGold}4d`,
                        }}
                      >
                        <CharacterPreview
                          vrmUrl={`${CDN_URL}${AVATAR_OPTIONS[selectedAvatarIndex].previewPath}`}
                          className="w-full h-full"
                        />

                        {/* Avatar Selector Overlay */}
                        <div className="absolute bottom-2 left-1/2 transform -translate-x-1/2 flex items-center gap-2 bg-black/80 rounded-lg px-3 py-1.5 backdrop-blur">
                          <button
                            onClick={() =>
                              setSelectedAvatarIndex(
                                (prev) =>
                                  (prev - 1 + AVATAR_OPTIONS.length) %
                                  AVATAR_OPTIONS.length,
                              )
                            }
                            className="px-2 py-0.5 rounded transition-colors text-sm"
                            style={{
                              backgroundColor: `${entryGold}33`,
                              color: entryGold,
                            }}
                          >
                            ‹
                          </button>
                          <span
                            className="text-xs font-medium min-w-[100px] text-center"
                            style={{ color: entryGold }}
                          >
                            {AVATAR_OPTIONS[selectedAvatarIndex].name}
                          </span>
                          <button
                            onClick={() =>
                              setSelectedAvatarIndex(
                                (prev) => (prev + 1) % AVATAR_OPTIONS.length,
                              )
                            }
                            className="px-2 py-0.5 rounded transition-colors text-sm"
                            style={{
                              backgroundColor: `${entryGold}33`,
                              color: entryGold,
                            }}
                          >
                            ›
                          </button>
                        </div>
                      </div>

                      {/* Cancel Button */}
                      <button
                        className="w-full px-4 py-2 bg-black/40 hover:bg-black/50 rounded transition-colors text-sm"
                        style={{
                          color: entryGold,
                          border: `1px solid ${entryGold}4d`,
                        }}
                        onClick={() => {
                          setShowCreate(false);
                          setNewCharacterName("");
                          setSelectedAvatarIndex(0);
                          setCharacterType("human"); // Reset to default
                        }}
                      >
                        Cancel
                      </button>
                    </div>

                    {/* Right Column - Template Selection (only for AI agents) */}
                    {characterType === "agent" &&
                      elizaOSAvailable &&
                      !checkingElizaOS && (
                        <div
                          className="w-1/2 rounded bg-black/60 p-3 h-fit"
                          style={{
                            border: `1px solid ${entryGold}4d`,
                          }}
                        >
                          <div
                            className="text-sm font-semibold mb-2"
                            style={{ color: entryGold }}
                          >
                            Agent Archetype
                          </div>
                          {loadingTemplates ? (
                            <div
                              className="text-center text-sm py-4"
                              style={{ color: theme.colors.text.muted }}
                            >
                              Loading templates...
                            </div>
                          ) : templates.length > 0 ? (
                            <div className="space-y-2">
                              {templates.map((template) => (
                                <button
                                  key={template.id}
                                  onClick={() => setSelectedTemplate(template)}
                                  className="w-full p-2.5 rounded-lg border-2 transition-all text-left"
                                  style={{
                                    borderColor:
                                      selectedTemplate?.id === template.id
                                        ? entryGold
                                        : `${entryGold}4d`,
                                    backgroundColor:
                                      selectedTemplate?.id === template.id
                                        ? `${entryGold}1a`
                                        : "rgba(0,0,0,0.4)",
                                  }}
                                >
                                  <div className="flex items-center gap-2">
                                    <span className="text-xl">
                                      {template.emoji}
                                    </span>
                                    <div
                                      className="font-medium text-sm"
                                      style={{
                                        color: entryGold,
                                      }}
                                    >
                                      {template.name}
                                    </div>
                                  </div>
                                  <div
                                    className="text-xs leading-relaxed mt-1 ml-7"
                                    style={{ color: theme.colors.text.muted }}
                                  >
                                    {template.description}
                                  </div>
                                </button>
                              ))}
                            </div>
                          ) : (
                            <div
                              className="text-center text-sm py-4"
                              style={{ color: theme.colors.text.muted }}
                            >
                              No templates available
                            </div>
                          )}
                        </div>
                      )}
                  </div>
                </div>
              )}

              {/* Connection status indicator */}
              {connectionState === "connecting" && (
                <div className="text-xs opacity-60 mt-2">Connecting...</div>
              )}
              {connectionState === "reconnecting" && (
                <div className="mt-3 mx-auto max-w-md p-3 bg-yellow-900/60 border border-yellow-500/50 rounded-lg text-center">
                  <p className="text-yellow-200 text-sm flex items-center justify-center gap-2">
                    <span className="animate-spin">↻</span>
                    Reconnecting... (attempt {reconnectAttemptsRef.current}/
                    {MAX_RECONNECT_ATTEMPTS})
                  </p>
                </div>
              )}
              {connectionState === "failed" && (
                <div className="mt-3 mx-auto max-w-md p-3 bg-red-900/60 border border-red-500/50 rounded-lg text-center">
                  <p className="text-red-200 text-sm mb-2">
                    Connection failed after {MAX_RECONNECT_ATTEMPTS} attempts.
                  </p>
                  <button
                    onClick={() => {
                      reconnectAttemptsRef.current = 0;
                      intentionalDisconnectRef.current = false;
                      setConnectionState("connecting");
                      // Force re-render by updating a dependency
                      window.location.reload();
                    }}
                    className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded text-sm font-medium transition-colors"
                  >
                    Retry Connection
                  </button>
                </div>
              )}
              <div className="mt-6 flex justify-center">
                <div className="w-full max-w-sm relative">
                  <div
                    className="h-[1px] w-full mb-2"
                    style={{
                      background: `linear-gradient(to right, transparent, ${entryGold}e6, transparent)`,
                    }}
                  />
                  <button
                    className="w-full px-6 py-3 text-center bg-transparent hover:bg-black/20 focus:outline-none transition-all rounded-sm"
                    onClick={onLogout}
                    style={{
                      color: entryGold,
                      textShadow: `0 0 12px ${entryGoldSoft}80, 0 0 25px ${entryGoldSoft}4d`,
                      filter:
                        "drop-shadow(0 8px 20px rgba(0, 0, 0, 0.8)) drop-shadow(0 4px 10px rgba(0, 0, 0, 0.6))",
                    }}
                  >
                    <span className="font-semibold text-lg uppercase tracking-[0.2em]">
                      Sign out
                    </span>
                  </button>
                  <div
                    className="h-[1px] w-full mt-2"
                    style={{
                      background: `linear-gradient(to right, transparent, ${entryGold}e6, transparent)`,
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {view === "confirm" && (
            <div className="mt-2">
              <div className="rounded bg-white/5 overflow-hidden">
                <div className="relative">
                  <div
                    className="w-full overflow-hidden"
                    style={{ height: "55vh" }}
                  >
                    <img
                      src="/images/stock_character.png"
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="absolute inset-x-0 bottom-0">
                    <GoldRule />
                    <div className="flex items-center justify-between px-5 py-4 bg-black/50 backdrop-blur">
                      <div
                        className="font-semibold text-xl"
                        style={{ color: entryGold }}
                      >
                        {characters.find((c) => c.id === selectedCharacterId)
                          ?.name || "Unnamed"}
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-xl" style={{ color: entryGold }}>
                          ✓
                        </div>
                      </div>
                    </div>
                    <GoldRule />
                  </div>
                </div>
              </div>
              {/* Error message display */}
              {errorMessage && (
                <div className="mt-3 mx-auto max-w-md p-3 bg-red-900/80 border border-red-500 rounded-lg text-center">
                  <p className="text-red-200 text-sm">{errorMessage}</p>
                </div>
              )}
              <div className="mt-3 flex justify-center">
                <div className="w-full max-w-md relative">
                  <div
                    className="h-[1px] w-full mb-1"
                    style={{
                      background: `linear-gradient(to right, transparent, ${entryGold}e6, transparent)`,
                    }}
                  />
                  <button
                    className="w-full px-6 py-1.5 text-center bg-transparent hover:bg-black/20 focus:outline-none transition-all rounded-sm"
                    disabled={!selectedCharacterId || enteringWorld}
                    onClick={enterWorld}
                    style={{
                      color: entryGold,
                      textShadow: `0 0 12px ${entryGoldSoft}80, 0 0 25px ${entryGoldSoft}4d`,
                      filter:
                        "drop-shadow(0 8px 20px rgba(0, 0, 0, 0.8)) drop-shadow(0 4px 10px rgba(0, 0, 0, 0.6))",
                      opacity: selectedCharacterId && !enteringWorld ? 1 : 0.5,
                      cursor:
                        selectedCharacterId && !enteringWorld
                          ? "pointer"
                          : "not-allowed",
                    }}
                  >
                    <span className="font-semibold text-lg uppercase tracking-[0.2em]">
                      {enteringWorld ? "Entering..." : "Enter World"}
                    </span>
                  </button>
                  <div
                    className="h-[1px] w-full mt-1"
                    style={{
                      background: `linear-gradient(to right, transparent, ${entryGold}e6, transparent)`,
                    }}
                  />
                </div>
              </div>
              <div className="mt-3 flex justify-center">
                <button
                  className="px-6 py-2 bg-transparent hover:bg-black/20 focus:outline-none transition-all rounded-sm"
                  onClick={() => setView("select")}
                  style={{
                    color: entryGold,
                    textShadow: `0 0 8px ${entryGoldSoft}66`,
                    border: `1px solid ${entryGold}4d`,
                  }}
                >
                  <span className="font-medium text-sm uppercase tracking-[0.15em]">
                    Back to Select
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
