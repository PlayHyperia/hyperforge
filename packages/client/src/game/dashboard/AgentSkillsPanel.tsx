import { GAME_API_URL } from "@/lib/api-config";
import { getApiAuthorizationHeaders } from "@/lib/api-client";
import React, { useState, useEffect, useRef } from "react";
import type { Agent } from "./types";
import { ChevronDown, ChevronUp, Swords, TrendingUp } from "lucide-react";

// Configuration constants
const SKILLS_POLL_INTERVAL_MS = 10000; // Poll every 10 seconds to avoid rate limiting
const SKILLS_BACKGROUND_POLL_INTERVAL_MS = 30000;
const MAX_SKILL_LEVEL = 99; // Maximum level for skill progress calculation
const MAX_RETRY_ATTEMPTS = 3; // Maximum retry attempts for failed requests
const RETRY_DELAY_MS = 1000; // Base delay between retries (exponential backoff)

/**
 * Fetch with retry logic and exponential backoff
 */
async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  maxRetries = MAX_RETRY_ATTEMPTS,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok || response.status === 404) {
        // Return on success or 404 (handled by caller for default skills)
        return response;
      }
      // Don't retry on client errors (4xx except 404)
      if (response.status >= 400 && response.status < 500) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    // Exponential backoff before retry
    if (attempt < maxRetries - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAY_MS * Math.pow(2, attempt)),
      );
    }
  }

  throw lastError || new Error("Request failed after retries");
}

interface SkillData {
  level: number;
  xp: number;
}

interface AgentSkills {
  attack?: SkillData;
  strength?: SkillData;
  defense?: SkillData;
  constitution?: SkillData;
  // ranged?: SkillData; // Hidden for melee-only MVP
  woodcutting?: SkillData;
  fishing?: SkillData;
  firemaking?: SkillData;
  cooking?: SkillData;
  agility?: SkillData;
}

interface AgentSkillsPanelProps {
  agent: Agent;
  isViewportActive: boolean;
}

// Skill definitions with icons (melee-only MVP - ranged hidden)
const SKILL_CONFIG = [
  { key: "attack", label: "Attack", icon: "⚔️" },
  { key: "strength", label: "Strength", icon: "💪" },
  { key: "defense", label: "Defense", icon: "🛡️" },
  { key: "constitution", label: "HP", icon: "❤️" },
  // { key: "ranged", label: "Ranged", icon: "🏹" }, // Hidden for melee-only MVP
  { key: "woodcutting", label: "Woodcut", icon: "🪓" },
  { key: "fishing", label: "Fishing", icon: "🎣" },
  { key: "firemaking", label: "Fire", icon: "🔥" },
  { key: "cooking", label: "Cooking", icon: "🍳" },
  { key: "agility", label: "Agility", icon: "🏃" },
] as const;

// XP calculation for progress bar
function calculateXPForLevel(level: number): number {
  let total = 0;
  for (let i = 1; i < level; i++) {
    total += Math.floor(i + 300 * Math.pow(2, i / 7));
  }
  return Math.floor(total / 4);
}

function getXPProgress(xp: number, level: number): number {
  if (level >= MAX_SKILL_LEVEL) return 100;
  const currentLevelXP = calculateXPForLevel(level);
  const nextLevelXP = calculateXPForLevel(level + 1);
  const xpIntoLevel = xp - currentLevelXP;
  const xpForThisLevel = nextLevelXP - currentLevelXP;
  return Math.min(100, Math.max(0, (xpIntoLevel / xpForThisLevel) * 100));
}

// Calculate combat level from skills (melee-only MVP)
function calculateCombatLevel(skills: AgentSkills): number {
  const defense = skills.defense?.level || 1;
  const constitution = skills.constitution?.level || 10;
  const attack = skills.attack?.level || 1;
  const strength = skills.strength?.level || 1;

  const base = 0.25 * (defense + constitution);
  const melee = 0.325 * (attack + strength);
  return Math.floor(base + melee);
}

function SkillRow({
  icon,
  label,
  level,
  xp,
  sessionGain,
}: {
  icon: string;
  label: string;
  level: number;
  xp: number;
  sessionGain?: number;
}) {
  const progress = getXPProgress(xp, level);

  return (
    <div className="flex flex-col gap-0.5 py-0.5">
      {/* Skill name and level */}
      <div className="flex items-center gap-1.5">
        <span className="text-sm" title={label}>
          {icon}
        </span>
        <span className="text-[9px] text-[#f2d08a]/80 font-medium flex-1">
          {label}
        </span>
        <span className="text-[10px] text-[#f2d08a] font-bold">Lv {level}</span>
      </div>

      {/* XP bar with actual numbers */}
      <div className="ml-5">
        <div className="relative h-2.5 bg-black/40 rounded overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 bg-gradient-to-r from-green-600 to-green-500 transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
          <div className="absolute inset-0 flex items-center justify-end pr-1">
            <span
              className="text-[8px] text-white/90 font-medium"
              style={{ textShadow: "0 1px 2px black" }}
            >
              {Math.round(progress)}%
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between mt-0.5">
          <span className="text-[8px] text-[#f2d08a]/50">
            {formatXP(xp)} XP
          </span>
          {sessionGain && sessionGain > 0 ? (
            <span className="text-[8px] text-green-400/80 flex items-center gap-0.5">
              <TrendingUp size={8} />+{formatXP(sessionGain)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Format XP with comma separators
function formatXP(xp: number): string {
  return xp.toLocaleString();
}

export const AgentSkillsPanel: React.FC<AgentSkillsPanelProps> = ({
  agent,
  isViewportActive,
}) => {
  const [skills, setSkills] = useState<AgentSkills | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [characterId, setCharacterId] = useState<string | null>(null);
  // Track session XP gains
  const initialSkillsRef = useRef<AgentSkills | null>(null);
  const [sessionXpGains, setSessionXpGains] = useState<Record<string, number>>(
    {},
  );
  const pollTimeoutRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);

  // Fetch character ID once when agent changes
  useEffect(() => {
    if (agent.status !== "active") {
      setSkills(null);
      setCharacterId(null);
      return;
    }
    fetchCharacterId();
  }, [agent.id, agent.status]);

  useEffect(() => {
    const clearPollTimeout = () => {
      if (pollTimeoutRef.current !== null) {
        window.clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    };

    if (agent.status !== "active" || !characterId) return;

    const scheduleNextPoll = () => {
      clearPollTimeout();
      const isVisible = document.visibilityState === "visible";
      const delay =
        isViewportActive && isVisible
          ? SKILLS_POLL_INTERVAL_MS
          : SKILLS_BACKGROUND_POLL_INTERVAL_MS;
      pollTimeoutRef.current = window.setTimeout(() => {
        pollTimeoutRef.current = null;
        void fetchSkills().finally(scheduleNextPoll);
      }, delay);
    };

    void fetchSkills().finally(scheduleNextPoll);
    return clearPollTimeout;
  }, [isViewportActive, agent.id, agent.status, characterId]);

  const fetchCharacterId = async () => {
    try {
      setLoading(true);
      setError(null);

      const mappingResponse = await fetchWithRetry(
        `${GAME_API_URL}/api/agents/mapping/${agent.id}`,
        { headers: getApiAuthorizationHeaders() },
      );

      if (!mappingResponse.ok) {
        if (mappingResponse.status === 404) {
          setError("Agent not mapped");
          return;
        }
        throw new Error(`Mapping failed: ${mappingResponse.status}`);
      }

      const mappingData = await mappingResponse.json();
      const charId = mappingData.characterId;

      if (!charId) {
        setError("No character linked");
        return;
      }

      setCharacterId(charId);
    } catch (err) {
      console.error("[AgentSkillsPanel] Error fetching character ID:", err);
      setError("Failed to fetch");
    } finally {
      setLoading(false);
    }
  };

  const fetchSkills = async () => {
    if (!characterId || inFlightRef.current) return;
    inFlightRef.current = true;

    try {
      const skillsResponse = await fetchWithRetry(
        `${GAME_API_URL}/api/characters/${characterId}/skills`,
        { headers: getApiAuthorizationHeaders() },
      );

      if (!skillsResponse.ok) {
        // Skills endpoint might not exist yet, use defaults
        if (skillsResponse.status === 404) {
          setSkills({
            attack: { level: 1, xp: 0 },
            strength: { level: 1, xp: 0 },
            defense: { level: 1, xp: 0 },
            constitution: { level: 10, xp: 0 },
            woodcutting: { level: 1, xp: 0 },
            fishing: { level: 1, xp: 0 },
            firemaking: { level: 1, xp: 0 },
            cooking: { level: 1, xp: 0 },
            agility: { level: 1, xp: 0 },
          });
          return;
        }
        throw new Error(`Skills failed: ${skillsResponse.status}`);
      }

      const skillsData = await skillsResponse.json();
      const newSkills = skillsData.skills || skillsData;

      // Track initial skills for session gains
      if (!initialSkillsRef.current) {
        initialSkillsRef.current = JSON.parse(JSON.stringify(newSkills));
      }

      // Calculate session XP gains
      if (initialSkillsRef.current) {
        const gains: Record<string, number> = {};
        for (const config of SKILL_CONFIG) {
          const key = config.key as keyof AgentSkills;
          const currentXp = newSkills[key]?.xp || 0;
          const initialXp = initialSkillsRef.current[key]?.xp || 0;
          const gain = currentXp - initialXp;
          if (gain > 0) {
            gains[config.key] = gain;
          }
        }
        setSessionXpGains(gains);
      }

      setSkills(newSkills);
      setError(null);
    } catch {
      // Set default skills on error but don't spam error state
      if (!skills) {
        setSkills({
          attack: { level: 1, xp: 0 },
          strength: { level: 1, xp: 0 },
          defense: { level: 1, xp: 0 },
          constitution: { level: 10, xp: 0 },
          woodcutting: { level: 1, xp: 0 },
          fishing: { level: 1, xp: 0 },
          firemaking: { level: 1, xp: 0 },
          cooking: { level: 1, xp: 0 },
          agility: { level: 1, xp: 0 },
        });
      }
    } finally {
      inFlightRef.current = false;
    }
  };

  // Don't show if agent is inactive
  if (agent.status !== "active") {
    return null;
  }

  const totalLevel = skills
    ? SKILL_CONFIG.reduce((sum, s) => {
        const skill = skills[s.key as keyof AgentSkills];
        return sum + (skill?.level || 1);
      }, 0)
    : 0;

  const combatLevel = skills ? calculateCombatLevel(skills) : 3;

  return (
    <div className="border-t border-[#8b4513]/30 bg-[#0b0a15]/80">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-2 hover:bg-[#f2d08a]/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Swords size={14} className="text-[#f2d08a]/60" />
          <span className="text-xs font-bold text-[#f2d08a]/80 uppercase tracking-wider">
            Skills
          </span>
          {skills && (
            <span className="text-[10px] text-[#f2d08a]/50">
              Lvl {totalLevel} / Cmb {combatLevel}
            </span>
          )}
        </div>
        {expanded ? (
          <ChevronUp size={14} className="text-[#f2d08a]/40" />
        ) : (
          <ChevronDown size={14} className="text-[#f2d08a]/40" />
        )}
      </button>

      {/* Skills Grid */}
      {expanded && (
        <div className="px-2 pb-2">
          {loading && !skills ? (
            <div className="flex items-center justify-center py-3">
              <div className="animate-spin rounded-full h-4 w-4 border-t border-b border-[#f2d08a]/60" />
            </div>
          ) : error ? (
            <div className="text-center py-2 text-[10px] text-red-400/70">
              {error}
            </div>
          ) : skills ? (
            <div className="space-y-0.5">
              {/* Combat Skills (melee-only MVP: 4 skills) */}
              <div className="text-[8px] text-[#f2d08a]/50 uppercase tracking-wider mb-1 font-medium">
                Combat
              </div>
              <div className="space-y-1">
                {SKILL_CONFIG.slice(0, 4).map((skillConfig) => {
                  const skill = skills[skillConfig.key as keyof AgentSkills];
                  return (
                    <SkillRow
                      key={skillConfig.key}
                      icon={skillConfig.icon}
                      label={skillConfig.label}
                      level={skill?.level || 1}
                      xp={skill?.xp || 0}
                      sessionGain={sessionXpGains[skillConfig.key]}
                    />
                  );
                })}
              </div>

              {/* Divider */}
              <div className="border-t border-[#8b4513]/20 my-2" />

              {/* Gathering Skills */}
              <div className="text-[8px] text-[#f2d08a]/50 uppercase tracking-wider mb-1 font-medium">
                Gathering
              </div>
              <div className="space-y-1">
                {SKILL_CONFIG.slice(4).map((skillConfig) => {
                  const skill = skills[skillConfig.key as keyof AgentSkills];
                  return (
                    <SkillRow
                      key={skillConfig.key}
                      icon={skillConfig.icon}
                      label={skillConfig.label}
                      level={skill?.level || 1}
                      xp={skill?.xp || 0}
                      sessionGain={sessionXpGains[skillConfig.key]}
                    />
                  );
                })}
              </div>

              {/* Session Total XP Gains */}
              {Object.keys(sessionXpGains).length > 0 && (
                <div className="mt-2 pt-2 border-t border-[#8b4513]/20">
                  <div className="flex items-center justify-between p-1.5 rounded bg-green-500/10 border border-green-500/20">
                    <div className="flex items-center gap-1.5">
                      <TrendingUp size={12} className="text-green-400" />
                      <span className="text-[9px] text-green-400/80 font-medium">
                        Session XP
                      </span>
                    </div>
                    <span className="text-[10px] text-green-400 font-bold">
                      +
                      {formatXP(
                        Object.values(sessionXpGains).reduce(
                          (a, b) => a + b,
                          0,
                        ),
                      )}
                    </span>
                  </div>
                </div>
              )}

              {/* Live indicator when viewport active */}
              {isViewportActive && (
                <div className="flex items-center justify-center gap-1 mt-1 pt-1 border-t border-[#8b4513]/20">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                  <span className="text-[9px] text-green-500/80">
                    Live Tracking
                  </span>
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};
