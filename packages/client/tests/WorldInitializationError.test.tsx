import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  RendererPreparationQueue,
  RendererPreparationTimeoutError,
} from "../../shared/src/utils/rendering/RendererPreparationQueue";
import {
  normalizeWorldInitializationFailure,
  WorldInitializationError,
} from "../src/screens/WorldInitializationError";
import {
  LoadingReadinessWarning,
  MEADOW_PREPARATION_BLOCKED_MESSAGE,
} from "../src/screens/LoadingReadinessWarning";

// Real React SSR checks; these do not exercise browser focus, reload or WebGPU.
function render(error: unknown, entryRecoveryPresent = false): string {
  return renderToStaticMarkup(
    <WorldInitializationError
      failure={normalizeWorldInitializationFailure(error)}
      entryRecoveryPresent={entryRecoveryPresent}
    />,
  );
}

describe("world initialization failure classification", () => {
  it("presents an actual queue timeout while its underlying work remains owned", async () => {
    const queue = new RendererPreparationQueue();
    let finishWork!: () => void;
    const work = new Promise<void>((resolve) => {
      finishWork = resolve;
    });
    const caller = queue.run(
      (startDeadline) => {
        startDeadline();
        return work;
      },
      5,
      "WebGPU renderer preparation timed out after 5ms",
    );
    try {
      const error: unknown = await caller.then(
        () => {
          throw new Error("Unfinished preparation must not succeed");
        },
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(RendererPreparationTimeoutError);
      expect(normalizeWorldInitializationFailure(error)).toEqual({
        kind: "renderer-preparation-timeout",
        message: "WebGPU renderer preparation timed out after 5ms",
      });
      expect(queue.pendingCount).toBe(1);
      const markup = render(error);
      expect(markup).toContain("Graphics preparation did not finish");
      expect(markup).not.toContain("does not support WebGPU");
    } finally {
      finishWork();
      await queue.run(() => undefined, 1000, "Cleanup must complete");
    }
    expect(queue.pendingCount).toBe(0);
  });

  it("recognizes the exact structured renderer preparation timeout", () => {
    const error = Object.assign(
      new Error("Preparation exceeded its deadline"),
      {
        code: "renderer-preparation-timeout",
      },
    );
    expect(normalizeWorldInitializationFailure(error)).toEqual({
      kind: "renderer-preparation-timeout",
      message: error.message,
    });
    expect(render(error)).toContain("Graphics preparation did not finish");
  });

  it.each([
    "WebGPU renderer preparation timed out after 15000ms",
    "WebGPU device lost",
    "Renderer preparation failed",
    "A renderer asset could not be loaded",
  ])("does not infer unsupported hardware from wording: %s", (message) => {
    const error = new Error(message);
    expect(normalizeWorldInitializationFailure(error)).toEqual({
      kind: "initialization-failed",
      message,
    });
    const markup = render(error);
    expect(markup).toContain("The world could not start");
    expect(markup).toContain(message);
    expect(markup).not.toContain("WebGPU Required");
    expect(markup).not.toContain("does not support WebGPU");
    expect(markup).not.toContain("Supported Browsers");
  });

  it("rejects near-match error codes", () => {
    const error = Object.assign(new Error("Timed out"), {
      code: "renderer-preparation-timeout-other",
    });
    expect(normalizeWorldInitializationFailure(error).kind).toBe(
      "initialization-failed",
    );
  });

  it.each([
    undefined,
    null,
    42,
    "WebGPU renderer unavailable",
    { code: "renderer-preparation-timeout", message: "not an Error" },
  ])("normalizes non-Error input without trusting its fields: %j", (error) => {
    expect(normalizeWorldInitializationFailure(error)).toEqual({
      kind: "initialization-failed",
      message: "Unknown initialization error",
    });
  });
});

describe("world initialization failure presentation", () => {
  it("offers one explicit page reload, not same-world entry retry", () => {
    const markup = render(new Error("Startup stopped"));
    expect(markup).toContain("Reload this page");
    expect(markup.match(/<button\b/g)).toHaveLength(1);
    expect(markup).toContain('type="button"');
    expect(markup).not.toContain("Try again");
    expect(markup).not.toContain("Close the other game tab");
    expect(markup).toContain("Startup stopped before the world was ready");
  });

  it("retains duplicate-entry context without promising session takeover", () => {
    const error = Object.assign(new Error("Preparation timed out"), {
      code: "renderer-preparation-timeout",
    });
    const markup = render(error, true);
    expect(markup).toContain("Graphics preparation did not finish");
    expect(markup).toContain("Close the other game tab or window");
    expect(markup).toContain("Reloading does not disconnect another session");
    expect(markup).toContain("Reload this page");
    expect(markup.match(/<button\b/g)).toHaveLength(1);
    expect(markup).not.toContain("Try again");
  });

  it("labels the failure and escapes error details as text", () => {
    const markup = render(new Error('<img src="x" onerror="alert(1)">'));
    const title = markup.match(/aria-labelledby="([^"]+)"/)?.[1];
    const message = markup.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(title).toBeTruthy();
    expect(message).toBeTruthy();
    expect(markup).toContain(`id="${title}"`);
    expect(markup).toContain(`id="${message}"`);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("&lt;img");
    expect(markup).not.toContain("<img");
  });
});

describe("loading readiness warning presentation", () => {
  it.each([false, true])(
    "distinguishes terminal meadow failure from waiting: %s",
    (blocked) => {
      const message = blocked
        ? MEADOW_PREPARATION_BLOCKED_MESSAGE
        : "Loading is continuing; you can wait or reload.";
      const markup = renderToStaticMarkup(
        <LoadingReadinessWarning
          blocked={blocked}
          stage={blocked ? "Meadow preparation failed" : "Growing meadow..."}
          message={message}
          onReload={() => {
            throw new Error("Rendering must not reload");
          }}
        />,
      );
      expect(markup).toContain(
        blocked ? "Meadow preparation failed" : "Still preparing the world",
      );
      expect(markup).toContain(blocked ? 'role="alert"' : 'role="status"');
      expect(markup).toContain(message);
      expect(markup.match(/<button\b/g)).toHaveLength(1);
      expect(markup).toContain('type="button"');
      expect(markup).toContain('data-modal="true"');
      expect(markup).toContain("Reload");
      if (blocked) {
        expect(markup).toContain("Waiting will not retry these failed jobs");
        expect(markup).not.toContain("Loading is continuing");
        expect(markup).not.toContain("Still preparing");
      }
    },
  );
});
