import { GAME_API_URL } from "@/lib/api-config";
import { getApiAuthorizationHeaders } from "@/lib/api-client";
import React, { useState, useEffect, useRef, useCallback } from "react";
import { Agent } from "../../screens/DashboardScreen";
import {
  ChevronDown,
  ChevronUp,
  Scroll,
  Clock,
  RefreshCw,
  Minimize2,
  Maximize2,
} from "lucide-react";

// Configuration constants
const THOUGHTS_POLL_INTERVAL_MS = 3000;
const MAX_THOUGHTS_DISPLAYED = 100;
const FLASH_DURATION_MS = 1500; // How long the "new thought" flash lasts

interface AgentThought {
  id: string;
  type: "situation" | "evaluation" | "thinking" | "decision";
  content: string;
  timestamp: number;
  decisionPath?: "short-circuit" | "llm" | "scripted" | "planner" | "curiosity";
  providers?: string[];
}

interface AgentThoughtsOverlayProps {
  agent: Agent;
}

const formatTimeAgo = (timestamp: number): string => {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  if (seconds > 10) return `${seconds}s ago`;
  return "just now";
};

const cleanThoughtContent = (content: string): string => {
  let cleaned = content.replace(/\*\*/g, "");
  cleaned = cleaned.trim().replace(/\n{3,}/g, "\n\n");
  return cleaned;
};

const renderThoughtContent = (content: string): React.ReactNode => {
  const cleaned = cleanThoughtContent(content);
  const lines = cleaned.split("\n");

  return (
    <div className="space-y-1">
      {lines.map((line, idx) => {
        if (!line.trim()) return null;
        return (
          <p key={idx} className="text-[11px] text-[#ddd7ce] leading-relaxed">
            {line}
          </p>
        );
      })}
    </div>
  );
};

const DECISION_PATH_STYLES: Record<
  string,
  { label: string; bg: string; text: string }
> = {
  "short-circuit": {
    label: "SC",
    bg: "bg-blue-500/20 border-blue-500/40",
    text: "text-blue-300",
  },
  llm: {
    label: "LLM",
    bg: "bg-purple-500/20 border-purple-500/40",
    text: "text-purple-300",
  },
  scripted: {
    label: "SCRIPT",
    bg: "bg-gray-500/20 border-gray-500/40",
    text: "text-gray-300",
  },
  planner: {
    label: "PLAN",
    bg: "bg-green-500/20 border-green-500/40",
    text: "text-green-300",
  },
  curiosity: {
    label: "CURIOUS",
    bg: "bg-orange-500/20 border-orange-500/40",
    text: "text-orange-300",
  },
};

const DecisionPathBadge: React.FC<{
  path?: string;
}> = ({ path }) => {
  if (!path) return null;
  const style = DECISION_PATH_STYLES[path];
  if (!style) return null;
  return (
    <span
      className={`text-[8px] px-1 py-0.5 rounded border ${style.bg} ${style.text} font-medium`}
    >
      {style.label}
    </span>
  );
};

const ProviderChips: React.FC<{
  providers?: string[];
  decisionPath?: string;
}> = ({ providers, decisionPath }) => {
  if (!providers || providers.length === 0 || decisionPath !== "llm")
    return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {providers.map((p) => (
        <span
          key={p}
          className="text-[7px] px-1 py-0.5 rounded bg-purple-500/10 border border-purple-500/20 text-purple-300/70"
        >
          {p}
        </span>
      ))}
    </div>
  );
};

export const AgentThoughtsOverlay: React.FC<AgentThoughtsOverlayProps> = ({
  agent,
}) => {
  const [thoughts, setThoughts] = useState<AgentThought[]>([]);
  const [loading, setLoading] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isNewThought, setIsNewThought] = useState(false);
  const lastTimestampRef = useRef<number>(0);
  const lastThoughtIdRef = useRef<string | null>(null);
  const pollTimeoutRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);

  // Flash effect when new thought arrives
  useEffect(() => {
    if (isNewThought) {
      const timer = setTimeout(() => setIsNewThought(false), FLASH_DURATION_MS);
      return () => clearTimeout(timer);
    }
  }, [isNewThought]);

  const fetchThoughts = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const sinceParam =
        lastTimestampRef.current > 0
          ? `&since=${lastTimestampRef.current}`
          : "";
      const response = await fetch(
        `${GAME_API_URL}/api/agents/${agent.id}/thoughts?limit=${MAX_THOUGHTS_DISPLAYED}${sinceParam}`,
        { headers: getApiAuthorizationHeaders() },
      );

      if (!response.ok) {
        if (response.status === 503) {
          setError("Service not ready");
          return;
        }
        throw new Error(`Failed: ${response.status}`);
      }

      const data = await response.json();

      if (data.thoughts && data.thoughts.length > 0) {
        lastTimestampRef.current = data.thoughts[0].timestamp;

        // Check if there's a new thought
        const latestId = data.thoughts[0]?.id;
        if (latestId && latestId !== lastThoughtIdRef.current) {
          lastThoughtIdRef.current = latestId;
          // Only flash if we had a previous thought (not on initial load)
          if (thoughts.length > 0) {
            setIsNewThought(true);
          }
        }

        setThoughts((prev) => {
          const existingIds = new Set(prev.map((t) => t.id));
          const newThoughts = data.thoughts.filter(
            (t: AgentThought) => !existingIds.has(t.id),
          );

          if (sinceParam && newThoughts.length > 0) {
            return [...newThoughts, ...prev].slice(0, MAX_THOUGHTS_DISPLAYED);
          }

          return data.thoughts.slice(0, MAX_THOUGHTS_DISPLAYED);
        });
      }

      setError(null);
    } catch {
      setError((prev) => prev ?? "Unable to refresh thoughts");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [agent.id, thoughts.length]);

  useEffect(() => {
    if (agent.status !== "active") {
      setThoughts([]);
      return;
    }

    let cancelled = false;
    const schedule = (delay: number) => {
      if (pollTimeoutRef.current !== null) {
        window.clearTimeout(pollTimeoutRef.current);
      }
      pollTimeoutRef.current = window.setTimeout(run, delay);
    };
    const run = async () => {
      await fetchThoughts();
      if (!cancelled) {
        schedule(
          document.visibilityState === "visible"
            ? THOUGHTS_POLL_INTERVAL_MS
            : THOUGHTS_POLL_INTERVAL_MS * 2,
        );
      }
    };
    const onVisibilityChange = () => {
      if (!cancelled) {
        schedule(
          document.visibilityState === "visible"
            ? 1000
            : THOUGHTS_POLL_INTERVAL_MS * 2,
        );
      }
    };

    void run();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (pollTimeoutRef.current !== null) {
        window.clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    };
  }, [agent.status, fetchThoughts]);

  // Don't show if agent is inactive
  if (agent.status !== "active") {
    return null;
  }

  // Get latest thinking thought
  const latestThinking =
    thoughts.find((t) => t.type === "thinking") || thoughts[0];
  const olderThoughts = thoughts.filter((t) => t.id !== latestThinking?.id);

  // Minimized state - compact pill button
  if (minimized) {
    return (
      <button
        onClick={() => setMinimized(false)}
        className="group bg-[#14181f]/95 backdrop-blur-md border border-[#3c444f]/70 rounded-full px-3 py-1.5 flex items-center gap-2 hover:border-[#c6b18d]/40 hover:bg-[#1b2129] transition-all shadow-lg"
      >
        <Scroll size={14} className="text-[#c6b18d]" />
        <span className="text-[11px] font-medium text-[#ddd7ce]/80">Mind</span>
        {thoughts.length > 0 && (
          <>
            <div className="w-1 h-1 rounded-full bg-[#4ade80] animate-pulse" />
            <span className="text-[10px] text-[#c6b18d]/70">
              {thoughts.length}
            </span>
          </>
        )}
        <Maximize2
          size={10}
          className="text-[#c6b18d]/30 group-hover:text-[#ddd7ce]/60"
        />
      </button>
    );
  }

  return (
    <div className="bg-[#11151b]/95 backdrop-blur-md border border-[#3c444f]/70 rounded-xl shadow-2xl w-80 overflow-hidden">
      {/* Header - classic fantasy MMORPG scroll style */}
      <div className="flex items-center justify-between px-3 py-2 bg-gradient-to-r from-[#1c2128] to-[#12161c] border-b border-white/10">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Scroll size={16} className="text-[#c6b18d]" />
            {thoughts.length > 0 && (
              <div className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[#4ade80] animate-pulse" />
            )}
          </div>
          <span className="text-xs font-semibold text-[#ddd7ce] tracking-wide">
            Agent's Mind
          </span>
          {isNewThought && (
            <span className="text-[9px] text-[#4ade80] font-medium animate-pulse">
              NEW
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={fetchThoughts}
            className="p-1 rounded hover:bg-white/5 transition-colors"
            title="Refresh"
          >
            <RefreshCw
              size={11}
              className={`text-[#c6b18d]/60 hover:text-[#ddd7ce] ${loading ? "animate-spin" : ""}`}
            />
          </button>
          <button
            onClick={() => setMinimized(true)}
            className="p-1 rounded hover:bg-white/5 transition-colors"
            title="Minimize"
          >
            <Minimize2
              size={11}
              className="text-[#c6b18d]/60 hover:text-[#ddd7ce]"
            />
          </button>
        </div>
      </div>

      {/* Content */}
      <div
        className="p-3 max-h-80 overflow-y-auto"
        style={{ scrollbarWidth: "thin" }}
      >
        {loading && thoughts.length === 0 ? (
          <div className="flex items-center justify-center py-4">
            <div className="flex items-center gap-2 text-[#c6b18d]/60">
              <Scroll size={14} className="animate-pulse" />
              <span className="text-[11px]">Reading the scrolls...</span>
            </div>
          </div>
        ) : error ? (
          <div className="text-center py-3 text-[11px] text-red-400/70">
            {error}
          </div>
        ) : !latestThinking ? (
          <div className="text-center py-4">
            <Scroll size={24} className="mx-auto mb-2 text-[#c6b18d]/30" />
            <p className="text-[11px] text-[#c6b18d]/50">
              The mind is quiet...
            </p>
            <p className="text-[10px] text-[#c6b18d]/30 mt-1">
              Thoughts will appear here
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Current Thinking - Parchment style */}
            <div className="relative">
              {/* Header */}
              <div className="flex items-center gap-1.5 mb-2">
                <div
                  className={`w-2 h-2 rounded-full ${isNewThought ? "bg-[#4ade80] animate-ping" : "bg-[#c6b18d]/60"}`}
                />
                <span className="text-[10px] font-medium text-[#c6b18d] uppercase tracking-wider">
                  Current Thought
                </span>
                <DecisionPathBadge path={latestThinking.decisionPath} />
                <span className="text-[9px] text-[#8f98a3] ml-auto">
                  {formatTimeAgo(latestThinking.timestamp)}
                </span>
              </div>

              {/* Thought content - Parchment/scroll look */}
              <div
                className={`
                  relative rounded border p-3 transition-all duration-300
                  ${
                    isNewThought
                      ? "bg-[#222933] border-[#c6b18d]/45 shadow-[0_0_12px_rgba(198,177,141,0.18)]"
                      : "bg-[#171c23] border-[#3c444f]"
                  }
                `}
              >
                {/* Decorative corner */}
                <div className="absolute top-0 left-0 w-3 h-3 border-t-2 border-l-2 border-[#57616d]/60 rounded-tl" />
                <div className="absolute bottom-0 right-0 w-3 h-3 border-b-2 border-r-2 border-[#57616d]/60 rounded-br" />

                {/* Content */}
                <div className="px-1">
                  {renderThoughtContent(latestThinking.content)}
                  <ProviderChips
                    providers={latestThinking.providers}
                    decisionPath={latestThinking.decisionPath}
                  />
                </div>
              </div>
            </div>

            {/* History Section (collapsible) */}
            {olderThoughts.length > 0 && (
              <div className="pt-2 border-t border-white/8">
                <button
                  onClick={() => setShowHistory(!showHistory)}
                  className="flex items-center gap-1.5 text-[10px] text-[#8f98a3] hover:text-[#ddd7ce] transition-colors w-full"
                >
                  <Clock size={10} />
                  <span>Past thoughts ({olderThoughts.length})</span>
                  {showHistory ? (
                    <ChevronUp size={10} className="ml-auto" />
                  ) : (
                    <ChevronDown size={10} className="ml-auto" />
                  )}
                </button>

                {showHistory && (
                  <div
                    className="mt-2 space-y-2 max-h-96 overflow-y-auto pr-1"
                    style={{ scrollbarWidth: "thin" }}
                  >
                    {olderThoughts.map((thought) => (
                      <div
                        key={thought.id}
                        className="bg-[#13181f] border border-[#313943] rounded p-2"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[9px] text-[#8f98a3] uppercase">
                              {thought.type}
                            </span>
                            <DecisionPathBadge path={thought.decisionPath} />
                          </div>
                          <span className="text-[8px] text-[#8f98a3]/60">
                            {formatTimeAgo(thought.timestamp)}
                          </span>
                        </div>
                        <p className="text-[10px] text-[#c7cfd8]/72">
                          {cleanThoughtContent(thought.content)}
                        </p>
                        <ProviderChips
                          providers={thought.providers}
                          decisionPath={thought.decisionPath}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Live indicator */}
            <div className="flex items-center justify-center gap-1.5 pt-2">
              <div className="w-1.5 h-1.5 rounded-full bg-[#4ade80] animate-pulse" />
              <span className="text-[9px] text-[#4ade80]/70">Live</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
