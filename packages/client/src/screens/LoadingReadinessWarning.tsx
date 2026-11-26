import React from "react";

export const MEADOW_PREPARATION_BLOCKED_MESSAGE =
  "Required meadow preparation stopped after an error. Waiting will not retry these failed jobs. Reload the page to start a new attempt.";

/** Presentation only: readiness ownership and the opaque cover remain in CoreUI. */
export function LoadingReadinessWarning({
  blocked,
  stage,
  message,
  onReload,
}: {
  blocked: boolean;
  stage: string;
  message: string;
  onReload: () => void;
}) {
  return (
    <div
      data-modal="true"
      data-testid="loading-readiness-warning"
      className="absolute bottom-8 inset-x-4 flex pointer-events-auto justify-center z-20"
    >
      <div className="text-center bg-black/90 text-[#f2d08a] p-4 rounded">
        <p className="text-2xl mb-3">
          {blocked ? "Meadow preparation failed" : "Still preparing the world"}
        </p>
        <p role={blocked ? "alert" : "status"} className="mb-3">
          {stage}
        </p>
        <p className="max-w-md mb-4">{message}</p>
        <button
          type="button"
          className="px-4 py-2 rounded bg-[#f2d08a] text-black font-bold"
          onClick={onReload}
        >
          Reload
        </button>
      </div>
    </div>
  );
}
