import React, { useId } from "react";

export type WorldInitializationFailure = {
  kind: "renderer-preparation-timeout" | "initialization-failed";
  message: string;
};

/** Error wording cannot establish browser or GPU capability. */
export function normalizeWorldInitializationFailure(
  error: unknown,
): WorldInitializationFailure {
  return {
    kind:
      error instanceof Error &&
      "code" in error &&
      error.code === "renderer-preparation-timeout"
        ? "renderer-preparation-timeout"
        : "initialization-failed",
    message:
      error instanceof Error ? error.message : "Unknown initialization error",
  };
}

type WorldInitializationErrorProps = {
  failure: WorldInitializationFailure;
  entryRecoveryPresent?: boolean;
};

/** A failed startup needs a fresh world, not another entry on its old socket. */
export function WorldInitializationError({
  failure,
  entryRecoveryPresent = false,
}: WorldInitializationErrorProps): React.ReactElement {
  const titleId = useId();
  const messageId = useId();

  return (
    <div
      role="alert"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "#0a0a0a",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: "24px",
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: "500px" }}>
        <h1
          id={titleId}
          style={{
            fontSize: "24px",
            fontWeight: 600,
            marginBottom: "16px",
            color: "#ff6b6b",
          }}
        >
          {failure.kind === "renderer-preparation-timeout"
            ? "Graphics preparation did not finish"
            : "The world could not start"}
        </h1>
        <p
          id={messageId}
          style={{
            fontSize: "14px",
            marginBottom: "24px",
            opacity: 0.8,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {failure.message}
        </p>
        <p style={{ marginBottom: "24px" }}>
          {entryRecoveryPresent
            ? "Your character was also waiting to enter. Close the other game tab or window, then reload this page. Reloading does not disconnect another session."
            : "Startup stopped before the world was ready. Reload this page to start again."}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            padding: "12px 24px",
            fontSize: "14px",
            fontWeight: 500,
            backgroundColor: "#4a9eff",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: "pointer",
          }}
        >
          Reload this page
        </button>
      </div>
    </div>
  );
}
