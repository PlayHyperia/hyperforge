import { GAME_API_URL } from "@/lib/api-config";
import { getApiAuthorizationHeaders } from "@/lib/api-client";
import {
  formatDashboardAgentReply,
  formatDashboardAgentReplyMetaLine,
  type DashboardMessageApiPayload,
} from "@/lib/formatDashboardAgentReply";
import { usePrivy } from "@privy-io/react-auth";
import {
  Bot,
  Maximize2,
  Minimize2,
  MessageSquare,
  MessageSquareOff,
  Send,
  User,
  Mic,
  X,
  RefreshCw,
} from "lucide-react";
import React, { useEffect, useRef, useState, useCallback } from "react";
import type { Agent } from "./types";
import { QuickActionMenu } from "./QuickActionMenu";
import { AgentThoughtsOverlay } from "./AgentThoughtsOverlay";

interface Message {
  id: string;
  sender: "user" | "agent";
  text: string;
  timestamp: Date;
}

interface AgentViewportChatProps {
  agent: Agent;
}

function composeAgentReplyBubbleText(data: DashboardMessageApiPayload): string {
  const main = formatDashboardAgentReply(data);
  const metaLine = formatDashboardAgentReplyMetaLine(data);
  return metaLine ? `${main}\n${metaLine}` : main;
}

// ─── Send logic extracted so both the manual send and QuickActionMenu share it ───
async function doSendMessage(opts: {
  agentId: string;
  authToken: string;
  content: string;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
}): Promise<{ ok: true; reply: string } | { ok: false; error: string }> {
  const { agentId, authToken, content, iframeRef } = opts;
  try {
    const response = await fetch(
      `${GAME_API_URL}/api/agents/${agentId}/message`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ content }),
      },
    );

    const data = (await response.json()) as DashboardMessageApiPayload & {
      success?: boolean;
      error?: string;
    };

    if (!response.ok) {
      return { ok: false, error: data.error || `HTTP ${response.status}` };
    }

    if (data.success) {
      // Signal the in-game chat to surface
      if (iframeRef.current?.contentWindow) {
        const origin = new URL(
          iframeRef.current.src || "/",
          window.location.origin,
        ).origin;
        iframeRef.current.contentWindow.postMessage(
          { type: "OPEN_CHAT" },
          origin,
        );
      }
      return { ok: true, reply: composeAgentReplyBubbleText(data) };
    }

    return { ok: false, error: data.error || "Failed to deliver message" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}

export const AgentViewportChat: React.FC<AgentViewportChatProps> = ({
  agent,
}) => {
  const [characterId, setCharacterId] = useState<string>("");
  const [authToken, setAuthToken] = useState<string>("");
  const [needsPrivyLogin, setNeedsPrivyLogin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [waitingForEntity, setWaitingForEntity] = useState(false);
  const [entityError, setEntityError] = useState<string | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isTyping, setIsTyping] = useState(false);

  // Chat sidebar state
  const [chatOpen, setChatOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  // Fullscreen state
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isMountedRef = useRef(true);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  /** Ignore stale /api/spectator/token responses after the user picks another agent. */
  const latestAgentIdRef = useRef(agent.id);
  latestAgentIdRef.current = agent.id;
  /** Keep authToken and characterId accessible inside the postMessage listener. */
  const authTokenRef = useRef(authToken);
  const characterIdRef = useRef(characterId);
  authTokenRef.current = authToken;
  characterIdRef.current = characterId;

  const { getAccessToken, user } = usePrivy();

  // ── Mount / unmount lifecycle ──────────────────────────────────────────────
  useEffect(() => {
    isMountedRef.current = true;
    if (agent.status === "active") {
      setLoading(true);
      setWaitingForEntity(false);
      setEntityError(null);
      setCharacterId("");
      setAuthToken("");
      void fetchSpectatorData(agent.id);
    } else {
      setLoading(false);
      setWaitingForEntity(false);
      setEntityError(null);
    }
    return () => {
      isMountedRef.current = false;
    };
  }, [agent.id, agent.status]);

  // ── Fullscreen listener ──────────────────────────────────────────────────
  useEffect(() => {
    const onFSChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFSChange);
    return () => document.removeEventListener("fullscreenchange", onFSChange);
  }, []);

  // ── Scroll messages to bottom ────────────────────────────────────────────
  useEffect(() => {
    if (chatOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, chatOpen]);

  // ── Unread badge when chat is closed ────────────────────────────────────
  useEffect(() => {
    if (!chatOpen && messages[messages.length - 1]?.sender === "agent") {
      setUnreadCount((n) => n + 1);
    }
  }, [messages]); // chatOpen intentionally omitted: only trigger on new messages

  const openChat = () => {
    setChatOpen(true);
    setUnreadCount(0);
  };

  const closeChat = () => setChatOpen(false);

  // ── Spectator token fetch / poll ──────────────────────────────────────────
  const fetchSpectatorData = async (requestedAgentId: string) => {
    const MAX_ATTEMPTS = 30;
    const stillThisAgent = () =>
      isMountedRef.current && requestedAgentId === latestAgentIdRef.current;

    try {
      setNeedsPrivyLogin(false);

      const privyToken = await getAccessToken();
      if (!stillThisAgent()) return;
      if (!privyToken) {
        setNeedsPrivyLogin(true);
        setLoading(false);
        return;
      }

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (!stillThisAgent()) return;

        const tokenResponse = await fetch(
          `${GAME_API_URL}/api/spectator/token`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentId: requestedAgentId, privyToken }),
          },
        );

        if (!stillThisAgent()) return;

        if (tokenResponse.ok) {
          const tokenData = await tokenResponse.json();
          if (!stillThisAgent()) return;
          if (tokenData.entityExists) {
            setAuthToken(tokenData.spectatorToken);
            setCharacterId(tokenData.characterId || "");
            setWaitingForEntity(false);
            setLoading(false);
            return;
          }
          if (attempt === 1) {
            setWaitingForEntity(true);
            setAuthToken(tokenData.spectatorToken);
            setCharacterId(tokenData.characterId || "");
          }
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        } else if (tokenResponse.status === 401) {
          localStorage.removeItem("privy_auth_token");
          if (stillThisAgent()) setLoading(false);
          return;
        } else if (tokenResponse.status === 403) {
          if (stillThisAgent()) setLoading(false);
          return;
        } else if (tokenResponse.status === 404) {
          if (attempt === 1 && stillThisAgent()) setWaitingForEntity(true);
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        } else {
          // Fallback: mapping endpoint
          const mappingResponse = await fetch(
            `${GAME_API_URL}/api/agents/mapping/${requestedAgentId}`,
            { headers: getApiAuthorizationHeaders() },
          );
          if (!stillThisAgent()) return;
          if (mappingResponse.ok) {
            const mappingData = await mappingResponse.json();
            setCharacterId(mappingData.characterId || "");
            setAuthToken(privyToken);
          }
          if (stillThisAgent()) setLoading(false);
          return;
        }
      }

      if (stillThisAgent()) {
        setEntityError(
          "Agent is still connecting to the game world. Make sure the agent is running with valid Hyperia credentials.",
        );
        setWaitingForEntity(false);
        setLoading(false);
      }
    } catch (error) {
      console.error(
        "[AgentViewportChat] Error fetching spectator data:",
        error,
      );
      if (stillThisAgent()) setLoading(false);
    }
  };

  // ── Message send ──────────────────────────────────────────────────────────
  const handleSendMessage = useCallback(async () => {
    const text = inputValue.trim();
    if (!text) return;
    if (!authToken) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          sender: "agent",
          text: "⚠️ Please log in to send messages.",
          timestamp: new Date(),
        },
      ]);
      return;
    }

    const userMsg: Message = {
      id: Date.now().toString(),
      sender: "user",
      text,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInputValue("");
    setIsTyping(true);

    const result = await doSendMessage({
      agentId: agent.id,
      authToken,
      content: text,
      iframeRef,
    });

    setIsTyping(false);
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now().toString(),
        sender: "agent",
        text: result.ok ? result.reply : `⚠️ ${result.error}`,
        timestamp: new Date(),
      },
    ]);
  }, [inputValue, authToken, agent.id]);

  // ── Quick-action send ─────────────────────────────────────────────────────
  const handleQuickAction = useCallback(
    async (command: string) => {
      if (!authToken) return;
      const userMsg: Message = {
        id: Date.now().toString(),
        sender: "user",
        text: command,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setInputValue("");
      setIsTyping(true);

      const result = await doSendMessage({
        agentId: agent.id,
        authToken,
        content: command,
        iframeRef,
      });

      setIsTyping(false);
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          sender: "agent",
          text: result.ok ? result.reply : `⚠️ ${result.error}`,
          timestamp: new Date(),
        },
      ]);
    },
    [authToken, agent.id],
  );

  // ── Send HYPERIA_AUTH to iframe once it signals HYPERIA_READY ──────
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Only react to the ready signal from our own iframe
      if (
        !iframeRef.current ||
        event.source !== iframeRef.current.contentWindow
      )
        return;
      if (
        !event.data ||
        typeof event.data !== "object" ||
        event.data.type !== "HYPERIA_READY"
      )
        return;

      const token = authTokenRef.current;
      const charId = characterIdRef.current;
      if (!token) return;

      iframeRef.current.contentWindow?.postMessage(
        {
          type: "HYPERIA_AUTH",
          authToken: token,
          agentId: agent.id,
          characterId: charId || undefined,
          followEntity: charId || undefined,
        },
        window.location.origin,
      );
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [agent.id]);

  // ── Toggle fullscreen ─────────────────────────────────────────────────────
  const toggleFullscreen = async () => {
    if (!document.fullscreenElement && containerRef.current) {
      await containerRef.current.requestFullscreen().catch(() => {});
    } else {
      await document.exitFullscreen().catch(() => {});
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Loading / error guards
  // ─────────────────────────────────────────────────────────────────────────

  if (loading || waitingForEntity) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#0b0a15]">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-[#f2d08a]" />
        {waitingForEntity && (
          <p className="text-[#f2d08a]/60 mt-4 text-sm">
            Connecting agent to game world…
          </p>
        )}
      </div>
    );
  }

  if (entityError) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#0b0a15] text-[#f2d08a]/60">
        <div className="text-5xl mb-4">⚠️</div>
        <h2 className="text-lg font-bold text-[#f2d08a] mb-2">
          Connection Issue
        </h2>
        <p className="text-center max-w-md mb-6 text-sm">{entityError}</p>
        <button
          onClick={() => {
            setEntityError(null);
            setLoading(true);
            void fetchSpectatorData(agent.id);
          }}
          className="flex items-center gap-2 px-4 py-2 bg-[#f2d08a] text-[#0b0a15] rounded-lg font-bold hover:bg-[#e5c07b] transition-colors"
        >
          <RefreshCw size={16} />
          Retry
        </button>
      </div>
    );
  }

  if (agent.status !== "active") {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#0b0a15] text-[#f2d08a]/60">
        <div className="text-5xl mb-4">⏸️</div>
        <h2 className="text-lg font-bold text-[#f2d08a] mb-2">
          Agent is {agent.status}
        </h2>
        <p className="text-center max-w-md text-sm">
          Start the agent to view the live game world and interact with it.
        </p>
      </div>
    );
  }

  if (needsPrivyLogin || !authToken) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#0b0a15] text-[#f2d08a]/60">
        <div className="text-5xl mb-4">🔐</div>
        <h2 className="text-lg font-bold text-[#f2d08a] mb-2">
          Authentication Required
        </h2>
        <p className="text-center max-w-md text-sm">
          {needsPrivyLogin
            ? "Sign in with Privy to open the live viewfinder."
            : "Please log in to view and interact with the agent."}
        </p>
      </div>
    );
  }

  if (!characterId) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#0b0a15] text-[#f2d08a]/60">
        <div className="text-5xl mb-4 animate-pulse">🔗</div>
        <h2 className="text-lg font-bold text-[#f2d08a] mb-2">
          Waiting for Agent to Connect
        </h2>
        <p className="text-center max-w-md mb-6 text-sm">
          The agent is starting up. The viewport will activate once it enters
          the game world.
        </p>
        <button
          onClick={() => {
            setLoading(true);
            void fetchSpectatorData(agent.id);
          }}
          className="flex items-center gap-2 px-4 py-2 bg-[#f2d08a]/20 text-[#f2d08a] border border-[#f2d08a]/40 rounded-lg font-bold hover:bg-[#f2d08a]/30 transition-colors"
        >
          <RefreshCw size={16} />
          Check Now
        </button>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Main viewport + chat panel render
  // ─────────────────────────────────────────────────────────────────────────

  const privyUserId = user?.id || "";
  // SECURITY: authToken is NOT included in the iframe URL — it would appear in
  // server logs, browser history, and referrer headers.  Instead it is delivered
  // to the embedded client via a HYPERIA_AUTH postMessage after the iframe
  // fires HYPERIA_READY (see the useEffect above).
  const iframeParams = new URLSearchParams({
    embedded: "true",
    mode: "spectator",
    agentId: agent.id,
    characterId,
    followEntity: characterId,
    privyUserId,
    hiddenUI: "chat,inventory,minimap,hotbar,stats",
  });

  const agentDisplayName = agent.characterName || agent.name;
  const agentMessages = messages.filter(
    (message) => message.sender === "agent",
  );
  const lastAgentMsg = agentMessages[agentMessages.length - 1];

  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 bg-black relative isolate overflow-hidden"
    >
      {/* ── Game Viewport ──────────────────────────────────────────────── */}
      <iframe
        key={`${agent.id}-${characterId}`}
        ref={iframeRef}
        className="absolute inset-0 w-full h-full border-none bg-[#0b0a15]"
        src={`/?${iframeParams.toString()}`}
        allow="autoplay; fullscreen; microphone; camera"
        title={`Viewport: ${agentDisplayName}`}
      />

      {/* ── Top Status Bar ─────────────────────────────────────────────── */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center px-4 py-3 gap-3">
        {/* Live indicator badge */}
        <div className="flex items-center gap-2 bg-black/70 backdrop-blur-md border border-[#f2d08a]/25 rounded-lg px-3 py-1.5 pointer-events-none select-none">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
          </span>
          <span className="text-[#f2d08a] font-semibold text-xs uppercase tracking-widest">
            Live
          </span>
          <span className="w-px h-3 bg-[#f2d08a]/20" />
          <span className="text-[#e8ebf4]/80 text-xs font-medium">
            {agentDisplayName}
          </span>
          <span className="w-px h-3 bg-[#f2d08a]/20" />
          <span className="text-green-400/90 text-xs">Active</span>
        </div>

        <div className="flex-1" />

        {/* Controls */}
        <div className="flex items-center gap-2">
          {/* Chat toggle */}
          <button
            onClick={chatOpen ? closeChat : openChat}
            title={chatOpen ? "Close chat" : "Open chat"}
            className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all backdrop-blur-md border ${
              chatOpen
                ? "bg-[#f2d08a]/15 border-[#f2d08a]/40 text-[#f2d08a]"
                : "bg-black/60 border-[#f2d08a]/20 text-[#e8ebf4]/70 hover:text-[#f2d08a] hover:border-[#f2d08a]/35"
            }`}
          >
            {chatOpen ? (
              <MessageSquareOff size={14} />
            ) : (
              <MessageSquare size={14} />
            )}
            <span className="hidden sm:inline">
              {chatOpen ? "Close Chat" : "Chat"}
            </span>
            {!chatOpen && unreadCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-[#f2d08a] text-[#0b0a15] text-[10px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-1">
                {unreadCount}
              </span>
            )}
          </button>

          {/* Fullscreen toggle */}
          <button
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            className="flex items-center justify-center w-8 h-8 rounded-lg bg-black/60 backdrop-blur-md border border-[#f2d08a]/20 text-[#e8ebf4]/60 hover:text-[#f2d08a] hover:border-[#f2d08a]/35 transition-all"
          >
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>

      {/* ── Agent Thoughts Overlay (bottom-right, hides when chat open) ── */}
      {!chatOpen && (
        <div className="absolute bottom-20 right-4 z-10 pointer-events-auto">
          <AgentThoughtsOverlay agent={agent} />
        </div>
      )}

      {/* ── Latest agent reply toast (when chat is closed) ──────────────── */}
      {!chatOpen && lastAgentMsg && (
        <div className="absolute top-16 right-4 z-10 max-w-xs pointer-events-none">
          <div className="bg-black/60 backdrop-blur-md border border-[#f2d08a]/20 rounded-xl p-3 shadow-lg">
            <div className="flex items-center gap-2 mb-1.5">
              <Bot size={13} className="text-[#f2d08a] shrink-0" />
              <span className="text-[10px] font-bold text-[#f2d08a]/80 uppercase tracking-wide">
                {agentDisplayName}
              </span>
              <span className="text-[9px] text-[#f2d08a]/40 ml-auto">
                {lastAgentMsg.timestamp.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
            <p className="text-[11px] text-[#e8ebf4]/85 leading-relaxed line-clamp-3">
              {lastAgentMsg.text}
            </p>
            {messages.filter((m) => m.sender === "agent").length > 1 && (
              <button
                onClick={openChat}
                className="mt-2 text-[10px] text-[#f2d08a]/60 hover:text-[#f2d08a] pointer-events-auto"
              >
                View full history →
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Compact input bar (when chat is closed) ─────────────────────── */}
      {!chatOpen && (
        <div className="absolute bottom-4 left-4 right-4 z-10 pointer-events-auto">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-end gap-2 bg-black/70 backdrop-blur-md border border-[#8b4513]/50 rounded-xl p-2 focus-within:border-[#f2d08a]/50 transition-colors shadow-2xl">
              <QuickActionMenu
                agentId={agent.id}
                authToken={authToken}
                onCommandSend={handleQuickAction}
              />
              <textarea
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
                placeholder={`Message ${agentDisplayName}…`}
                className="flex-1 bg-transparent border-none outline-none text-[#e8ebf4] placeholder-[#f2d08a]/30 resize-none py-2 max-h-32 min-h-[24px] text-sm"
                rows={1}
              />
              {isTyping ? (
                <div className="flex items-center gap-1 px-2 py-2">
                  {[0, 150, 300].map((delay) => (
                    <span
                      key={delay}
                      className="w-1.5 h-1.5 bg-[#f2d08a]/60 rounded-full animate-bounce"
                      style={{ animationDelay: `${delay}ms` }}
                    />
                  ))}
                </div>
              ) : inputValue.trim() ? (
                <button
                  onClick={handleSendMessage}
                  className="p-2 bg-[#f2d08a] text-[#0b0a15] rounded-lg hover:bg-[#e5c07b] transition-colors"
                >
                  <Send size={16} />
                </button>
              ) : (
                <button className="p-2 text-[#f2d08a]/40 hover:text-[#f2d08a] transition-colors rounded-lg hover:bg-[#f2d08a]/5">
                  <Mic size={18} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Chat History Sidebar ──────────────────────────────────────────── */}
      <div
        className={`absolute top-0 right-0 bottom-0 z-30 flex flex-col w-80 transition-transform duration-300 ease-in-out ${
          chatOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!chatOpen}
      >
        {/* Sidebar backdrop */}
        <div className="absolute inset-0 bg-[#0b0a15]/90 backdrop-blur-xl border-l border-[#f2d08a]/15" />

        {/* Sidebar contents (relative so they stack on top of backdrop) */}
        <div className="relative flex flex-col h-full">
          {/* Panel header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-[#f2d08a]/10 shrink-0">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <Bot size={16} className="text-[#f2d08a] shrink-0" />
              <span className="text-[#f2d08a] font-semibold text-sm truncate">
                {agentDisplayName}
              </span>
            </div>
            <button
              onClick={closeChat}
              className="text-[#e8ebf4]/40 hover:text-[#e8ebf4] transition-colors rounded-md hover:bg-white/5 p-1"
            >
              <X size={16} />
            </button>
          </div>

          {/* Message history */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-[#f2d08a]/30 text-center text-xs gap-2">
                <MessageSquare size={28} className="opacity-40" />
                <span>Send a message to talk to {agentDisplayName}.</span>
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-2 ${
                  msg.sender === "user" ? "flex-row-reverse" : "flex-row"
                }`}
              >
                {/* Avatar */}
                <div
                  className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5 ${
                    msg.sender === "user"
                      ? "bg-[#f2d08a]/15 text-[#f2d08a]"
                      : "bg-[#1a1005] border border-[#f2d08a]/20 text-[#f2d08a]/70"
                  }`}
                >
                  {msg.sender === "user" ? (
                    <User size={12} />
                  ) : (
                    <Bot size={12} />
                  )}
                </div>

                {/* Bubble */}
                <div
                  className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                    msg.sender === "user"
                      ? "bg-[#f2d08a]/15 border border-[#f2d08a]/20 text-[#e8ebf4]"
                      : "bg-[#1a1005] border border-[#8b4513]/25 text-[#e8dcc8]"
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                  <p
                    className={`text-[9px] mt-1 ${
                      msg.sender === "user"
                        ? "text-[#f2d08a]/40 text-right"
                        : "text-[#e8dcc8]/30"
                    }`}
                  >
                    {msg.timestamp.toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </div>
            ))}

            {/* Typing indicator */}
            {isTyping && (
              <div className="flex gap-2 items-end">
                <div className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center bg-[#1a1005] border border-[#f2d08a]/20 text-[#f2d08a]/70">
                  <Bot size={12} />
                </div>
                <div className="bg-[#1a1005] border border-[#8b4513]/25 rounded-xl px-3 py-2">
                  <div className="flex items-center gap-1">
                    {[0, 150, 300].map((delay) => (
                      <span
                        key={delay}
                        className="w-1.5 h-1.5 bg-[#f2d08a]/50 rounded-full animate-bounce"
                        style={{ animationDelay: `${delay}ms` }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Chat input inside panel */}
          <div className="shrink-0 px-3 py-3 border-t border-[#f2d08a]/10">
            <div className="flex items-end gap-2 bg-[#1a1005] border border-[#8b4513]/40 rounded-xl p-2 focus-within:border-[#f2d08a]/40 transition-colors">
              <QuickActionMenu
                agentId={agent.id}
                authToken={authToken}
                onCommandSend={handleQuickAction}
              />
              <textarea
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
                placeholder="Message…"
                className="flex-1 bg-transparent border-none outline-none text-[#e8ebf4] placeholder-[#f2d08a]/25 resize-none py-1 max-h-28 min-h-[20px] text-sm"
                rows={1}
              />
              {inputValue.trim() ? (
                <button
                  onClick={handleSendMessage}
                  className="p-1.5 bg-[#f2d08a] text-[#0b0a15] rounded-lg hover:bg-[#e5c07b] transition-colors"
                >
                  <Send size={14} />
                </button>
              ) : (
                <button className="p-1.5 text-[#f2d08a]/30 hover:text-[#f2d08a] transition-colors rounded-lg">
                  <Mic size={15} />
                </button>
              )}
            </div>
            <p className="text-center mt-1.5 text-[9px] text-[#f2d08a]/25">
              AI can make mistakes. Verify important info.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
