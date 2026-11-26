import React, { useState, useCallback } from "react";
import {
  Save,
  RefreshCw,
  Trash2,
  Key,
  Eye,
  EyeOff,
  CheckCircle,
  XCircle,
  AlertCircle,
} from "lucide-react";
import type { Agent } from "./types";
import { ELIZAOS_API } from "@/lib/api-config";
import { apiClient } from "@/lib/api-client";

/** Status notification type */
type StatusType = "success" | "error" | "warning";

/** Status notification state */
interface StatusNotification {
  message: string;
  type: StatusType;
  id: number;
}

interface AgentSettingsProps {
  agent: Agent;
  onDelete?: (agentId: string) => Promise<void>;
}

interface AgentSettingsData {
  accountId?: string;
  characterType?: string;
  avatar?: string;
  [key: string]: unknown;
}

interface SecretsData {
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  [key: string]: string | undefined;
}

export const AgentSettings: React.FC<AgentSettingsProps> = ({
  agent,
  onDelete,
}) => {
  const [settings, setSettings] = useState<AgentSettingsData | null>(null);
  const [secrets, setSecrets] = useState<SecretsData>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingSecrets, setSavingSecrets] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState("Basic");
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [notifications, setNotifications] = useState<StatusNotification[]>([]);
  const notificationIdRef = React.useRef(0);
  const [streamingDuelEnabled, setStreamingDuelEnabled] = useState(true);
  const [streamingDuelPrefLoaded, setStreamingDuelPrefLoaded] = useState(false);
  const [hasHyperiaMapping, setHasHyperiaMapping] = useState(false);
  const [savingStreamingDuel, setSavingStreamingDuel] = useState(false);

  // Show a status notification
  const showNotification = useCallback((message: string, type: StatusType) => {
    const id = ++notificationIdRef.current;
    setNotifications((prev) => [...prev, { message, type, id }]);
    // Auto-dismiss after 5 seconds
    setTimeout(() => {
      setNotifications((prev) => prev.filter((n) => n.id !== id));
    }, 5000);
  }, []);

  // Dismiss a notification
  const dismissNotification = useCallback((id: number) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const tabs = ["Basic", "Content", "Style", "API Keys"] as const;

  // Common API key configurations
  const apiKeyConfigs = [
    {
      key: "OPENAI_API_KEY",
      label: "OpenAI API Key",
      placeholder: "sk-...",
      description: "Optional: Direct OpenAI API access",
    },
    {
      key: "ANTHROPIC_API_KEY",
      label: "Anthropic API Key",
      placeholder: "sk-ant-...",
      description: "Optional: Direct Anthropic API access",
    },
  ];

  React.useEffect(() => {
    const fetchSettings = async () => {
      try {
        // Use ElizaOS native agent API endpoint
        const response = await fetch(`${ELIZAOS_API}/agents/${agent.id}`);
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.data) {
            const root = data.data as Record<string, unknown>;
            const agentData =
              root.agent && typeof root.agent === "object"
                ? (root.agent as Record<string, unknown>)
                : root;
            setSettings({
              name: agentData.name as string | undefined,
              username: agentData.username as string | undefined,
              bio: Array.isArray(agentData.bio)
                ? (agentData.bio as string[]).join("\n")
                : (agentData.bio as string | undefined) ||
                  (agentData.system as string | undefined),
              lore: agentData.lore as AgentSettingsData["lore"],
              topics: agentData.topics as AgentSettingsData["topics"],
              style: agentData.style as AgentSettingsData["style"],
              adjectives:
                agentData.adjectives as AgentSettingsData["adjectives"],
              modelProvider: (
                agentData.settings as { model?: string } | undefined
              )?.model,
            });
            const settingsSecrets = (
              agentData.settings as { secrets?: Record<string, string> }
            )?.secrets;
            if (settingsSecrets) {
              const existingSecrets: SecretsData = {};
              for (const key of Object.keys(settingsSecrets)) {
                existingSecrets[key] = settingsSecrets[key] || "";
              }
              setSecrets(existingSecrets);
            }
          }
        }
      } catch (error) {
        console.error("Failed to fetch settings:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchSettings();
  }, [agent.id]);

  React.useEffect(() => {
    let cancelled = false;
    const loadStreamingDuelPref = async () => {
      try {
        const result = await apiClient.get<{
          success?: boolean;
          streamingDuelEnabled?: boolean;
        }>(`/api/agents/mapping/${encodeURIComponent(agent.id)}`, {
          useFreshToken: true,
        });
        if (cancelled) return;
        if (result.ok && result.data?.success) {
          setHasHyperiaMapping(true);
          setStreamingDuelEnabled(result.data.streamingDuelEnabled !== false);
        } else {
          setHasHyperiaMapping(false);
        }
      } catch {
        if (!cancelled) setHasHyperiaMapping(false);
      } finally {
        if (!cancelled) setStreamingDuelPrefLoaded(true);
      }
    };
    void loadStreamingDuelPref();
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  const saveStreamingDuelPreference = async (next: boolean) => {
    setSavingStreamingDuel(true);
    try {
      const result = await apiClient.post<{
        success?: boolean;
        streamingDuelEnabled?: boolean;
      }>(
        `/api/agents/mappings/${encodeURIComponent(agent.id)}/streaming-duel`,
        { streamingDuelEnabled: next },
        { useFreshToken: true },
      );
      const payload = result.data;
      if (
        result.ok &&
        payload &&
        payload.success === true &&
        typeof payload.streamingDuelEnabled === "boolean"
      ) {
        setStreamingDuelEnabled(payload.streamingDuelEnabled);
        showNotification("Streaming duel preference saved.", "success");
      } else {
        showNotification(
          result.error ?? "Could not update streaming duel setting.",
          "error",
        );
      }
    } catch {
      showNotification("Could not update streaming duel setting.", "error");
    } finally {
      setSavingStreamingDuel(false);
    }
  };

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      // Use official ElizaOS API to update agent configuration
      const response = await fetch(`${ELIZAOS_API}/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: settings.name,
          username: settings.username,
          bio: settings.bio,
          lore: settings.lore,
          topics: settings.topics,
          style: settings.style,
          adjectives: settings.adjectives,
        }),
      });
      if (response.ok) {
        showNotification("Settings saved successfully!", "success");
      } else {
        const errorData = await response.json().catch(() => ({}));
        console.error("[AgentSettings] ❌ Failed to save settings:", errorData);
        showNotification(
          `Failed to save settings: ${errorData.error || response.statusText}`,
          "error",
        );
      }
    } catch (error) {
      console.error("[AgentSettings] ❌ Error saving settings:", error);
      showNotification("Error saving settings.", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSecrets = async () => {
    setSavingSecrets(true);
    try {
      // Filter out empty secrets and only send non-empty values
      const secretsToSave: Record<string, string> = {};
      for (const [key, value] of Object.entries(secrets)) {
        if (value && value.trim() && !value.startsWith("***")) {
          secretsToSave[key] = value.trim();
        }
      }

      if (Object.keys(secretsToSave).length === 0) {
        showNotification(
          "No API keys to save. Please enter at least one API key.",
          "warning",
        );
        setSavingSecrets(false);
        return;
      }

      // Use ElizaOS API to update agent secrets
      const response = await fetch(`${ELIZAOS_API}/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            secrets: secretsToSave,
          },
        }),
      });

      if (response.ok) {
        showNotification(
          "API keys saved successfully! Restart the agent for changes to take effect.",
          "success",
        );
      } else {
        const errorData = await response.json().catch(() => ({}));
        console.error("[AgentSettings] ❌ Failed to save API keys:", errorData);
        showNotification(
          `Failed to save API keys: ${errorData.error || response.statusText}`,
          "error",
        );
      }
    } catch (error) {
      console.error("[AgentSettings] ❌ Error saving API keys:", error);
      showNotification("Error saving API keys.", "error");
    } finally {
      setSavingSecrets(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    setDeleting(true);
    try {
      await onDelete(agent.id);
      // Navigation will happen automatically when agent is removed from list
    } catch (error) {
      console.error("[AgentSettings] ❌ Error deleting agent:", error);
      showNotification("Failed to delete agent. Please try again.", "error");
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  const toggleSecretVisibility = (key: string) => {
    setShowSecrets((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  if (loading)
    return <div className="p-6 text-[#f2d08a]">Loading settings...</div>;
  if (!settings)
    return <div className="p-6 text-red-400">Failed to load settings.</div>;

  return (
    <div className="flex flex-col h-full bg-[#0b0a15]/50 backdrop-blur-sm overflow-hidden relative">
      {/* Notification Toast Container */}
      {notifications.length > 0 && (
        <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
          {notifications.map((notification) => (
            <div
              key={notification.id}
              className="flex items-center gap-3 p-3 rounded-lg shadow-lg animate-[slideIn_0.3s_ease-out]"
              style={{
                backgroundColor:
                  notification.type === "success"
                    ? "#065f46"
                    : notification.type === "error"
                      ? "#7f1d1d"
                      : "#78350f",
                border: `1px solid ${
                  notification.type === "success"
                    ? "#10b981"
                    : notification.type === "error"
                      ? "#ef4444"
                      : "#f59e0b"
                }`,
              }}
            >
              {notification.type === "success" && (
                <CheckCircle
                  className="text-emerald-400 flex-shrink-0"
                  size={18}
                />
              )}
              {notification.type === "error" && (
                <XCircle className="text-red-400 flex-shrink-0" size={18} />
              )}
              {notification.type === "warning" && (
                <AlertCircle
                  className="text-amber-400 flex-shrink-0"
                  size={18}
                />
              )}
              <span className="text-white text-sm flex-1">
                {notification.message}
              </span>
              <button
                onClick={() => dismissNotification(notification.id)}
                className="text-white/60 hover:text-white transition-colors"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(100%); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>

      {/* Header */}
      <div className="p-6 border-b border-[#8b4513]/30 bg-[#0b0a15]/80">
        <h2 className="font-bold text-[#f2d08a] text-2xl mb-2">
          Agent Settings
        </h2>
        <p className="text-[#f2d08a]/60 text-sm">
          Configure your AI agent's behaviour and capabilities.
        </p>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto space-y-8">
          {/* Tabs */}
          <div className="flex border-b border-[#8b4513]/30 gap-6">
            {tabs.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`pb-3 text-sm font-medium transition-colors relative ${
                  activeTab === tab
                    ? "text-[#f2d08a]"
                    : "text-[#f2d08a]/40 hover:text-[#f2d08a]/80"
                }`}
              >
                {tab}
                {activeTab === tab && (
                  <div className="absolute bottom-0 left-0 w-full h-0.5 bg-[#f2d08a]" />
                )}
              </button>
            ))}
          </div>

          {/* Form Fields - Tab Content */}
          <div className="space-y-6">
            {activeTab === "Basic" && (
              <>
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-[#f2d08a]/80">
                    Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={(settings.name as string | undefined) || ""}
                    onChange={(e) =>
                      setSettings({ ...settings, name: e.target.value })
                    }
                    className="w-full bg-[#1a1005] border border-[#8b4513]/30 rounded-lg p-3 text-[#e8ebf4] focus:border-[#f2d08a] outline-none transition-colors"
                  />
                  <p className="text-xs text-[#f2d08a]/40">
                    The primary identifier for this agent
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium text-[#f2d08a]/80">
                    Username
                  </label>
                  <input
                    type="text"
                    value={(settings.username as string | undefined) || ""}
                    onChange={(e) =>
                      setSettings({ ...settings, username: e.target.value })
                    }
                    placeholder="@username"
                    className="w-full bg-[#1a1005] border border-[#8b4513]/30 rounded-lg p-3 text-[#e8ebf4] focus:border-[#f2d08a] outline-none transition-colors"
                  />
                  <p className="text-xs text-[#f2d08a]/40">
                    Used in URLs and API endpoints
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium text-[#f2d08a]/80">
                    System Prompt <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    rows={6}
                    value={(settings.bio as string | undefined) || ""}
                    onChange={(e) =>
                      setSettings({ ...settings, bio: e.target.value })
                    }
                    className="w-full bg-[#1a1005] border border-[#8b4513]/30 rounded-lg p-3 text-[#e8ebf4] focus:border-[#f2d08a] outline-none transition-colors resize-none font-mono text-sm"
                  />
                  <p className="text-xs text-[#f2d08a]/40">
                    System prompt defining agent behavior
                  </p>
                </div>

                <div className="rounded-lg border border-[#8b4513]/25 bg-[#1a1005]/40 p-4 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-[#f2d08a]/90">
                        Streaming duel arena
                      </div>
                      <p className="text-xs text-[#f2d08a]/45 mt-1 max-w-xl">
                        When off, this agent is not matched or summoned into the
                        streaming duel arena so you can debug normal world
                        gameplay. Requires a Hyperia agent mapping for this
                        account.
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={streamingDuelEnabled}
                      disabled={
                        !streamingDuelPrefLoaded ||
                        !hasHyperiaMapping ||
                        savingStreamingDuel
                      }
                      onClick={() =>
                        void saveStreamingDuelPreference(!streamingDuelEnabled)
                      }
                      className={`relative inline-flex h-8 w-14 flex-shrink-0 cursor-pointer rounded-full border transition-colors ${
                        streamingDuelEnabled
                          ? "bg-emerald-700/80 border-emerald-500/50"
                          : "bg-[#2a2015] border-[#8b4513]/40"
                      } ${
                        !streamingDuelPrefLoaded ||
                        !hasHyperiaMapping ||
                        savingStreamingDuel
                          ? "opacity-40 cursor-not-allowed"
                          : ""
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-7 w-7 transform rounded-full bg-white shadow transition-transform mt-0.5 ${
                          streamingDuelEnabled
                            ? "translate-x-6"
                            : "translate-x-0.5"
                        }`}
                      />
                    </button>
                  </div>
                  {streamingDuelPrefLoaded && !hasHyperiaMapping && (
                    <p className="text-xs text-amber-400/90">
                      No Hyperia mapping found for this agent. Link the agent
                      from the dashboard (or create credentials) to enable this
                      toggle.
                    </p>
                  )}
                </div>
              </>
            )}

            {activeTab === "Content" && (
              <>
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-[#f2d08a]/80">
                    Lore
                  </label>
                  <textarea
                    rows={4}
                    value={
                      Array.isArray(settings.lore)
                        ? (settings.lore as string[]).join("\n")
                        : (settings.lore as string | undefined) || ""
                    }
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        lore: e.target.value.split("\n"),
                      })
                    }
                    placeholder="Background story and lore (one item per line)"
                    className="w-full bg-[#1a1005] border border-[#8b4513]/30 rounded-lg p-3 text-[#e8ebf4] focus:border-[#f2d08a] outline-none transition-colors resize-none font-mono text-sm"
                  />
                  <p className="text-xs text-[#f2d08a]/40">
                    Background information about the agent (one item per line)
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium text-[#f2d08a]/80">
                    Topics
                  </label>
                  <textarea
                    rows={3}
                    value={
                      Array.isArray(settings.topics)
                        ? (settings.topics as string[]).join(", ")
                        : (settings.topics as string | undefined) || ""
                    }
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        topics: e.target.value
                          .split(",")
                          .map((t) => t.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="gaming, rpg, exploration, combat"
                    className="w-full bg-[#1a1005] border border-[#8b4513]/30 rounded-lg p-3 text-[#e8ebf4] focus:border-[#f2d08a] outline-none transition-colors resize-none"
                  />
                  <p className="text-xs text-[#f2d08a]/40">
                    Topics the agent is knowledgeable about (comma-separated)
                  </p>
                </div>
              </>
            )}

            {activeTab === "Style" && (
              <>
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-[#f2d08a]/80">
                    Adjectives
                  </label>
                  <textarea
                    rows={2}
                    value={
                      Array.isArray(settings.adjectives)
                        ? (settings.adjectives as string[]).join(", ")
                        : (settings.adjectives as string | undefined) || ""
                    }
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        adjectives: e.target.value
                          .split(",")
                          .map((a) => a.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="adventurous, strategic, friendly"
                    className="w-full bg-[#1a1005] border border-[#8b4513]/30 rounded-lg p-3 text-[#e8ebf4] focus:border-[#f2d08a] outline-none transition-colors resize-none"
                  />
                  <p className="text-xs text-[#f2d08a]/40">
                    Personality traits (comma-separated)
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium text-[#f2d08a]/80">
                    Communication Style
                  </label>
                  <textarea
                    rows={3}
                    value={
                      typeof settings.style === "object" &&
                      settings.style !== null
                        ? JSON.stringify(settings.style, null, 2)
                        : ""
                    }
                    onChange={(e) => {
                      try {
                        const parsed = JSON.parse(e.target.value);
                        setSettings({ ...settings, style: parsed });
                      } catch {
                        // Allow typing invalid JSON temporarily
                      }
                    }}
                    placeholder='{"all": ["Be helpful", "Be concise"]}'
                    className="w-full bg-[#1a1005] border border-[#8b4513]/30 rounded-lg p-3 text-[#e8ebf4] focus:border-[#f2d08a] outline-none transition-colors resize-none font-mono text-sm"
                  />
                  <p className="text-xs text-[#f2d08a]/40">
                    Style configuration (JSON format)
                  </p>
                </div>
              </>
            )}

            {activeTab === "API Keys" && (
              <>
                <div className="bg-[#1a1005]/50 border border-[#8b4513]/30 rounded-lg p-4 mb-6">
                  <div className="flex items-center gap-2 mb-2">
                    <Key size={16} className="text-[#f2d08a]" />
                    <span className="text-sm font-medium text-[#f2d08a]">
                      API Key Configuration
                    </span>
                  </div>
                  <p className="text-xs text-[#f2d08a]/60">
                    Configure API keys for LLM providers. These are stored
                    securely and used by the agent for AI responses. You'll need
                    to restart the agent after saving for changes to take
                    effect.
                  </p>
                </div>

                {apiKeyConfigs.map((config) => (
                  <div key={config.key} className="space-y-2">
                    <label className="block text-sm font-medium text-[#f2d08a]/80">
                      {config.label}
                    </label>
                    <div className="relative">
                      <input
                        type={showSecrets[config.key] ? "text" : "password"}
                        value={secrets[config.key] || ""}
                        onChange={(e) =>
                          setSecrets({
                            ...secrets,
                            [config.key]: e.target.value,
                          })
                        }
                        placeholder={config.placeholder}
                        className="w-full bg-[#1a1005] border border-[#8b4513]/30 rounded-lg p-3 pr-12 text-[#e8ebf4] focus:border-[#f2d08a] outline-none transition-colors font-mono text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => toggleSecretVisibility(config.key)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[#f2d08a]/40 hover:text-[#f2d08a] transition-colors"
                      >
                        {showSecrets[config.key] ? (
                          <EyeOff size={18} />
                        ) : (
                          <Eye size={18} />
                        )}
                      </button>
                    </div>
                    <p className="text-xs text-[#f2d08a]/40">
                      {config.description}
                    </p>
                  </div>
                ))}

                <div className="pt-4">
                  <button
                    onClick={handleSaveSecrets}
                    disabled={savingSecrets}
                    className="flex items-center gap-2 px-6 py-2 rounded-lg bg-[#f2d08a] text-[#0b0a15] font-bold hover:bg-[#e5c07b] transition-colors shadow-lg shadow-[#f2d08a]/20 disabled:opacity-50"
                  >
                    <Key size={16} />
                    {savingSecrets ? "Saving..." : "Save API Keys"}
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Actions */}
          <div className="pt-6 flex items-center justify-between gap-4 border-t border-[#8b4513]/30">
            <div>
              {onDelete && (
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={deleting}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                >
                  <Trash2 size={16} />
                  Delete Agent
                </button>
              )}
            </div>
            <div className="flex items-center gap-4">
              <button
                onClick={() => window.location.reload()}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[#f2d08a]/30 text-[#f2d08a] hover:bg-[#f2d08a]/10 transition-colors"
              >
                <RefreshCw size={16} />
                Reset
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 px-6 py-2 rounded-lg bg-[#f2d08a] text-[#0b0a15] font-bold hover:bg-[#e5c07b] transition-colors shadow-lg shadow-[#f2d08a]/20 disabled:opacity-50"
              >
                <Save size={16} />
                {saving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#0b0a15] border-2 border-red-500/30 rounded-lg p-6 max-w-md w-full mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center">
                <Trash2 className="text-red-400" size={24} />
              </div>
              <div>
                <h3 className="font-bold text-[#f2d08a] text-lg">
                  Delete Agent
                </h3>
                <p className="text-[#f2d08a]/60 text-sm">
                  This action cannot be undone
                </p>
              </div>
            </div>

            <p className="text-[#e8ebf4]/80 mb-6">
              Are you sure you want to delete{" "}
              <span className="font-bold text-[#f2d08a]">{agent.name}</span>?
              This will permanently remove the agent and all its data.
            </p>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                className="flex-1 px-4 py-2 rounded-lg border border-[#f2d08a]/30 text-[#f2d08a] hover:bg-[#f2d08a]/10 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex-1 px-4 py-2 rounded-lg bg-red-500 text-white font-bold hover:bg-red-600 transition-colors disabled:opacity-50 shadow-lg shadow-red-500/20"
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
