/**
 * UsernameSelectionScreen.tsx - Account Username Selection
 *
 * New users must choose a unique username for their account.
 * This username is different from character names and represents the main account.
 *
 * Flow:
 * 1. User authenticates with Privy → Gets Privy ID and main HD wallet (index 0)
 * 2. If no username exists → Show this screen
 * 3. User chooses username → Account created with username + main wallet
 * 4. Proceed to character selection
 */

import React from "react";
import { usePrivy } from "@privy-io/react-auth";
import { GAME_API_URL } from "@/lib/api-config";
import { useThemeStore } from "@/ui";
import { privyAuthManager } from "@/auth/PrivyAuthManager";

interface UsernameSelectionScreenProps {
  onUsernameSelected: (username: string) => void;
}

export function UsernameSelectionScreen({
  onUsernameSelected,
}: UsernameSelectionScreenProps) {
  const theme = useThemeStore((s) => s.theme);
  const [username, setUsername] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const { user, ready, authenticated } = usePrivy();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate username
    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 3) {
      setError("Username must be at least 3 characters");
      return;
    }
    if (trimmedUsername.length > 16) {
      setError("Username must be 16 characters or less");
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(trimmedUsername)) {
      setError("Username can only contain letters, numbers, and underscores");
      return;
    }

    if (!ready || !authenticated || !user) {
      setError("Please wait for authentication to complete");
      return;
    }

    setIsSubmitting(true);

    try {
      // Get user's embedded wallet (HD index 0)
      const embeddedWallet = user.wallet;
      if (!embeddedWallet?.address) {
        setError("No wallet found. Please refresh the page and try again.");
        setIsSubmitting(false);
        return;
      }

      // Use PrivyAuthManager with localStorage fallback
      const accountId =
        privyAuthManager.getUserId() || localStorage.getItem("privy_user_id");
      if (!accountId) {
        setError("Authentication error. Please refresh the page.");
        setIsSubmitting(false);
        return;
      }

      // Create user account with username and main wallet
      const authToken =
        privyAuthManager.getToken() || localStorage.getItem("privy_auth_token");
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
      }
      const response = await fetch(`${GAME_API_URL}/api/users/create`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          accountId,
          username: trimmedUsername,
          wallet: embeddedWallet.address,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        setError(
          errorData.error || "Failed to create account. Please try again.",
        );
        setIsSubmitting(false);
        return;
      }
      // Success - proceed to character selection
      onUsernameSelected(trimmedUsername);
    } catch (err) {
      console.error("[UsernameSelection] ❌ Error creating account:", err);
      setError("Network error. Please check your connection and try again.");
      setIsSubmitting(false);
    }
  };

  const GoldRule = ({ thick = false }: { thick?: boolean }) => (
    <div
      className={`${thick ? "h-[2px]" : "h-px"} w-full`}
      style={{
        background: `linear-gradient(to right, transparent, ${theme.colors.text.accent}e6, transparent)`,
      }}
    />
  );

  return (
    <div className="absolute inset-0 overflow-hidden">
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
        <div className="w-full max-w-md mx-auto p-6">
          {/* Logo */}
          <div className="relative">
            <div className="mx-auto mb-8 w-full flex items-center justify-center">
              <img
                src="/images/hyperia-wordmark.svg"
                alt="Hyperia"
                className="h-20 md:h-32 object-contain"
              />
            </div>
          </div>

          {/* Welcome Message */}
          <div className="mb-6 text-center">
            <h2
              className="text-2xl font-bold mb-2"
              style={{ color: theme.colors.text.accent }}
            >
              Welcome to Hyperia!
            </h2>
            <p
              className="text-sm"
              style={{ color: theme.colors.text.secondary }}
            >
              Choose a username for your account
            </p>
            <p
              className="text-xs mt-2"
              style={{ color: theme.colors.text.muted }}
            >
              This username represents your account and main HD wallet.
              <br />
              You'll create characters under this username.
            </p>
          </div>

          {/* Error Message */}
          {error && (
            <div
              className="mb-4 rounded p-3"
              style={{
                backgroundColor: `${theme.colors.state.danger}1a`,
                border: `1px solid ${theme.colors.state.danger}80`,
              }}
            >
              <div className="flex items-center gap-2">
                <span
                  className="text-lg"
                  style={{ color: theme.colors.state.danger }}
                >
                  ⚠️
                </span>
                <span
                  className="text-sm"
                  style={{ color: theme.colors.text.primary }}
                >
                  {error}
                </span>
              </div>
            </div>
          )}

          {/* Username Input Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div
              className="rounded bg-black/40 p-6"
              style={{ border: `1px solid ${theme.colors.text.accent}4d` }}
            >
              <label
                className="block text-sm font-semibold mb-3"
                style={{ color: theme.colors.text.accent }}
              >
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setError(null);
                }}
                placeholder="Enter username (3-16 characters)"
                maxLength={16}
                className="w-full bg-black/60 rounded px-4 py-3 outline-none transition-colors"
                style={{
                  color: theme.colors.text.primary,
                  border: `1px solid ${theme.colors.border.default}`,
                }}
                autoFocus
                disabled={isSubmitting}
              />
              <div
                className="mt-2 text-xs"
                style={{ color: theme.colors.text.muted }}
              >
                • 3-16 characters
                <br />
                • Letters, numbers, and underscores only
                <br />• Cannot be changed later
              </div>
            </div>

            {/* Submit Button */}
            <div className="relative">
              <GoldRule thick />
              <button
                type="submit"
                disabled={
                  isSubmitting ||
                  username.trim().length < 3 ||
                  !ready ||
                  !authenticated
                }
                className="w-full px-6 py-4 text-center rounded-sm transition-all"
                style={{
                  backgroundColor:
                    isSubmitting ||
                    username.trim().length < 3 ||
                    !ready ||
                    !authenticated
                      ? "rgba(0,0,0,0.4)"
                      : "rgba(0,0,0,0.6)",
                  color:
                    isSubmitting ||
                    username.trim().length < 3 ||
                    !ready ||
                    !authenticated
                      ? theme.colors.text.disabled
                      : theme.colors.text.accent,
                  cursor:
                    isSubmitting ||
                    username.trim().length < 3 ||
                    !ready ||
                    !authenticated
                      ? "not-allowed"
                      : "pointer",
                  border: `1px solid ${theme.colors.text.accent}4d`,
                  textShadow:
                    isSubmitting || username.trim().length < 3
                      ? "none"
                      : `0 0 12px ${theme.colors.accent.secondary}80`,
                }}
              >
                <span className="font-semibold text-lg uppercase tracking-[0.2em]">
                  {isSubmitting ? "Creating Account..." : "Create Account"}
                </span>
              </button>
              <GoldRule thick />
            </div>
          </form>

          {/* Info Box */}
          <div
            className="mt-6 rounded p-4"
            style={{
              backgroundColor: `${theme.colors.text.accent}1a`,
              border: `1px solid ${theme.colors.text.accent}4d`,
            }}
          >
            <div className="flex items-start gap-3">
              <span
                className="text-xl"
                style={{ color: theme.colors.text.accent }}
              >
                💡
              </span>
              <div className="flex-1">
                <div
                  className="font-semibold text-sm mb-1"
                  style={{ color: theme.colors.text.accent }}
                >
                  Account Structure
                </div>
                <div
                  className="text-xs leading-relaxed"
                  style={{ color: theme.colors.text.secondary }}
                >
                  Your{" "}
                  <span
                    className="font-medium"
                    style={{ color: theme.colors.text.accent }}
                  >
                    username
                  </span>{" "}
                  is your permanent account identity linked to your main HD
                  wallet (index 0).{" "}
                  <span
                    className="font-medium"
                    style={{ color: theme.colors.text.accent }}
                  >
                    Characters
                  </span>{" "}
                  are created under your username, each with their own wallet
                  (indices 1, 2, 3, etc.).
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
