/**
 * Cloud Sync Hook
 *
 * Enables syncing layout presets with a server for cross-device persistence.
 * Works with the server's /api/layouts endpoints.
 *
 * @packageDocumentation
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { usePresetStore } from "../../stores/presetStore";
import type { WindowState } from "../../types";
import { privyAuthManager } from "../../../auth/PrivyAuthManager";

function authenticatedHeaders(contentType = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType) headers["Content-Type"] = "application/json";
  const token = privyAuthManager.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Cloud sync configuration */
export interface CloudSyncConfig {
  /** API base URL (e.g., https://api.example.com) */
  apiBaseUrl: string;
  /** User ID for authentication */
  userId: string;
  /** Whether to auto-sync on preset changes */
  autoSync?: boolean;
  /** Debounce delay for auto-sync (ms) */
  autoSyncDelay?: number;
}

/** Preset data for cloud storage */
export interface CloudPreset {
  slotIndex: number;
  name: string;
  layoutData: string;
  resolution?: { width: number; height: number };
  shared?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

/** Cloud sync state */
export interface CloudSyncState {
  /** Whether currently syncing */
  isSyncing: boolean;
  /** Last sync timestamp */
  lastSyncAt: number | null;
  /** Last error */
  error: string | null;
  /** Whether initial load has completed */
  isLoaded: boolean;
}

/** Return value from useCloudSync */
export interface CloudSyncResult extends CloudSyncState {
  /** Push local presets to cloud */
  pushToCloud: () => Promise<boolean>;
  /** Pull presets from cloud */
  pullFromCloud: () => Promise<boolean>;
  /** Sync specific preset */
  syncPreset: (slotIndex: number) => Promise<boolean>;
  /** Delete preset from cloud */
  deleteFromCloud: (slotIndex: number) => Promise<boolean>;
  /** Clear error */
  clearError: () => void;
}

/**
 * Hook for syncing layout presets with cloud storage
 *
 * @example
 * ```tsx
 * function LayoutSyncUI() {
 *   const { isSyncing, pushToCloud, pullFromCloud, error } = useCloudSync({
 *     apiBaseUrl: '/api',
 *     userId: currentUser.id,
 *     autoSync: true,
 *   });
 *
 *   return (
 *     <div>
 *       <button onClick={pullFromCloud} disabled={isSyncing}>
 *         {isSyncing ? 'Syncing...' : 'Load from Cloud'}
 *       </button>
 *       <button onClick={pushToCloud} disabled={isSyncing}>
 *         Save to Cloud
 *       </button>
 *       {error && <div className="error">{error}</div>}
 *     </div>
 *   );
 * }
 * ```
 */
export function useCloudSync(config: CloudSyncConfig): CloudSyncResult {
  const { apiBaseUrl, userId, autoSync = false, autoSyncDelay = 2000 } = config;

  const presets = usePresetStore((s) => s.presets);
  const _setPresets = usePresetStore((s) => s._setPresets);

  const [state, setState] = useState<CloudSyncState>({
    isSyncing: false,
    lastSyncAt: null,
    error: null,
    isLoaded: false,
  });

  const autoSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  /**
   * Fetch presets from cloud
   */
  const pullFromCloud = useCallback(async (): Promise<boolean> => {
    if (!userId) {
      setState((s) => ({ ...s, error: "No user ID provided" }));
      return false;
    }

    setState((s) => ({ ...s, isSyncing: true, error: null }));

    try {
      const response = await fetch(
        `${apiBaseUrl}/layouts?userId=${encodeURIComponent(userId)}`,
        { headers: authenticatedHeaders() },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || "Failed to fetch layouts");
      }

      // Convert cloud presets to local format
      const cloudPresets = data.presets as CloudPreset[];
      const now = Date.now();
      const currentResolution = {
        width: typeof window !== "undefined" ? window.innerWidth : 1920,
        height: typeof window !== "undefined" ? window.innerHeight : 1080,
      };

      // Convert to LayoutPreset format
      const localPresets = cloudPresets
        .map((preset) => {
          try {
            const windows = JSON.parse(preset.layoutData) as WindowState[];
            return {
              id: `preset-${preset.slotIndex}`,
              name: preset.name,
              windows,
              createdAt: preset.createdAt ?? now,
              modifiedAt: preset.updatedAt ?? now,
              resolution: preset.resolution ?? currentResolution,
            };
          } catch {
            console.warn(
              `[CloudSync] Failed to parse preset ${preset.slotIndex}`,
            );
            return null;
          }
        })
        .filter((p): p is NonNullable<typeof p> => p !== null);

      // Update preset store
      _setPresets(localPresets);

      setState((s) => ({
        ...s,
        isSyncing: false,
        lastSyncAt: Date.now(),
        isLoaded: true,
      }));

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setState((s) => ({
        ...s,
        isSyncing: false,
        error: `Failed to pull from cloud: ${message}`,
      }));
      return false;
    }
  }, [apiBaseUrl, userId, _setPresets]);

  /**
   * Push all local presets to cloud
   */
  const pushToCloud = useCallback(async (): Promise<boolean> => {
    if (!userId) {
      setState((s) => ({ ...s, error: "No user ID provided" }));
      return false;
    }

    setState((s) => ({ ...s, isSyncing: true, error: null }));

    try {
      const resolution = {
        width: typeof window !== "undefined" ? window.innerWidth : 1920,
        height: typeof window !== "undefined" ? window.innerHeight : 1080,
      };

      const cloudPresets: CloudPreset[] = presets.map((preset, index) => ({
        slotIndex: index,
        name: preset.name,
        layoutData: JSON.stringify(preset.windows),
        resolution,
        shared: false,
      }));

      const response = await fetch(`${apiBaseUrl}/layouts/sync`, {
        method: "POST",
        headers: authenticatedHeaders(true),
        body: JSON.stringify({ userId, presets: cloudPresets }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || "Failed to sync layouts");
      }

      setState((s) => ({
        ...s,
        isSyncing: false,
        lastSyncAt: Date.now(),
      }));

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setState((s) => ({
        ...s,
        isSyncing: false,
        error: `Failed to push to cloud: ${message}`,
      }));
      return false;
    }
  }, [apiBaseUrl, userId, presets]);

  /**
   * Sync a single preset
   */
  const syncPreset = useCallback(
    async (slotIndex: number): Promise<boolean> => {
      if (!userId) {
        setState((s) => ({ ...s, error: "No user ID provided" }));
        return false;
      }

      const preset = presets[slotIndex];
      if (!preset) {
        setState((s) => ({ ...s, error: `No preset at slot ${slotIndex}` }));
        return false;
      }

      setState((s) => ({ ...s, isSyncing: true, error: null }));

      try {
        const resolution = {
          width: typeof window !== "undefined" ? window.innerWidth : 1920,
          height: typeof window !== "undefined" ? window.innerHeight : 1080,
        };

        const response = await fetch(`${apiBaseUrl}/layouts`, {
          method: "POST",
          headers: authenticatedHeaders(true),
          body: JSON.stringify({
            userId,
            slotIndex,
            name: preset.name,
            layoutData: JSON.stringify(preset.windows),
            resolution,
            shared: false,
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!data.success) {
          throw new Error(data.error || "Failed to save layout");
        }

        setState((s) => ({
          ...s,
          isSyncing: false,
          lastSyncAt: Date.now(),
        }));

        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        setState((s) => ({
          ...s,
          isSyncing: false,
          error: `Failed to sync preset: ${message}`,
        }));
        return false;
      }
    },
    [apiBaseUrl, userId, presets],
  );

  /**
   * Delete preset from cloud
   */
  const deleteFromCloud = useCallback(
    async (slotIndex: number): Promise<boolean> => {
      if (!userId) {
        setState((s) => ({ ...s, error: "No user ID provided" }));
        return false;
      }

      setState((s) => ({ ...s, isSyncing: true, error: null }));

      try {
        const response = await fetch(`${apiBaseUrl}/layouts/${slotIndex}`, {
          method: "DELETE",
          headers: authenticatedHeaders(true),
          body: JSON.stringify({ userId }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!data.success) {
          throw new Error(data.error || "Failed to delete layout");
        }

        setState((s) => ({
          ...s,
          isSyncing: false,
          lastSyncAt: Date.now(),
        }));

        return true;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        setState((s) => ({
          ...s,
          isSyncing: false,
          error: `Failed to delete from cloud: ${message}`,
        }));
        return false;
      }
    },
    [apiBaseUrl, userId],
  );

  // Auto-sync on preset changes
  useEffect(() => {
    if (!autoSync || !userId) return;

    // Clear existing timeout
    if (autoSyncTimeoutRef.current) {
      clearTimeout(autoSyncTimeoutRef.current);
    }

    // Debounce auto-sync
    autoSyncTimeoutRef.current = setTimeout(() => {
      pushToCloud();
    }, autoSyncDelay);

    return () => {
      if (autoSyncTimeoutRef.current) {
        clearTimeout(autoSyncTimeoutRef.current);
      }
    };
  }, [presets, autoSync, autoSyncDelay, userId, pushToCloud]);

  return {
    ...state,
    pushToCloud,
    pullFromCloud,
    syncPreset,
    deleteFromCloud,
    clearError,
  };
}
