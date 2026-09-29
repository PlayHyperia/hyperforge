import React, { useEffect, useId, useRef } from "react";
import type { EntryRetryState } from "@hyperforge/shared";
import { useThemeStore } from "../../../ui/stores/themeStore";

type WorldEntryRecoveryOverlayProps = {
  state: EntryRetryState;
  onRetry: () => void;
  onReload: () => void;
};

/** Entry denial is recoverable without dismissing or replacing a live session. */
export function WorldEntryRecoveryOverlay({
  state,
  onRetry,
  onReload,
}: WorldEntryRecoveryOverlayProps): React.ReactElement {
  const theme = useThemeStore((store) => store.theme);
  const dialog = useRef<React.ComponentRef<"dialog">>(null);
  const titleId = useId();
  const messageId = useId();
  const pending = state.status === "pending";
  const expired = state.status === "expired";

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => element.close();
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={messageId}
      aria-modal="true"
      data-testid="world-entry-recovery"
      onCancel={(event) => event.preventDefault()}
      className="fixed inset-0 m-auto h-full w-full max-h-none max-w-none border-0 p-6 pointer-events-auto"
      style={{
        backgroundColor: theme.colors.background.primary,
        color: theme.colors.text.primary,
      }}
    >
      <div className="flex h-full items-center justify-center">
        <div className="w-full max-w-md text-center">
          <h1 id={titleId} className="text-2xl font-semibold mb-4">
            {pending
              ? "Entering world"
              : expired
                ? "Still waiting for the server"
                : "Your character is already connected"}
          </h1>
          <p id={messageId} role="status" className="mb-4">
            {state.message}
          </p>
          {!pending && !expired && (
            <p
              className="mb-6 text-sm"
              style={{ color: theme.colors.text.secondary }}
            >
              Close the other game tab or window, then try again. If you just
              reloaded, give the previous connection a moment to close. Retrying
              will not disconnect another session.
            </p>
          )}
          {expired && (
            <p
              className="mb-6 text-sm"
              style={{ color: theme.colors.text.secondary }}
            >
              You can keep waiting or reload this page to reconnect. No
              additional entry request will be sent on this connection.
            </p>
          )}
          <button
            type="button"
            autoFocus
            disabled={pending}
            onClick={expired ? onReload : onRetry}
            className="rounded-lg border px-5 py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 disabled:opacity-60 disabled:cursor-wait"
            style={{
              borderColor: theme.colors.border.default,
              backgroundColor: theme.colors.background.secondary,
              color: theme.colors.text.primary,
            }}
          >
            {pending
              ? "Waiting for server…"
              : expired
                ? "Reload page"
                : "Try again"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
