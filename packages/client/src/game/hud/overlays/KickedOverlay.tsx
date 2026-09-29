/**
 * Kicked Overlay Component
 *
 * Shows when the player is kicked from the server.
 * Displays the reason for being kicked.
 *
 * @packageDocumentation
 */

import React from "react";
import { useThemeStore } from "@/ui";

/**
 * Kick reason messages
 */
const kickMessages: Record<string, string> = {
  duplicate_user: "Player already active on another device or window.",
  state_unavailable:
    "Your character state could not be loaded safely. Reload to reconnect and try again.",
  player_limit: "Player limit reached.",
  unknown: "You were kicked.",
};

interface KickedOverlayProps {
  /** Kick reason code */
  code: string;
}

/**
 * Kicked overlay component
 */
export function KickedOverlay({
  code,
}: KickedOverlayProps): React.ReactElement {
  const theme = useThemeStore((s) => s.theme);

  return (
    <div
      className="absolute inset-0 flex items-center justify-center pointer-events-auto"
      style={{ backgroundColor: theme.colors.background.primary }}
    >
      <div className="text-lg" style={{ color: theme.colors.text.primary }}>
        {kickMessages[code] || kickMessages.unknown}
      </div>
    </div>
  );
}

export default KickedOverlay;
