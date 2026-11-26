import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EntryRetryState } from "@hyperforge/shared";
import { WorldEntryRecoveryOverlay } from "../src/game/hud/overlays/WorldEntryRecoveryOverlay";

// These are real React markup checks, not a browser/focus or network simulation.
function render(state: EntryRetryState): string {
  const noRenderAction = () => {
    throw new Error("Rendering must not issue a retry or reload");
  };
  return renderToStaticMarkup(
    <WorldEntryRecoveryOverlay
      state={state}
      onRetry={noRenderAction}
      onReload={noRenderAction}
    />,
  );
}

describe("world entry recovery presentation", () => {
  it("offers an explicit retry without exposing character IDs or promising takeover", () => {
    const markup = render({
      characterId: "internal-character-id",
      status: "available",
      message: "This character is still connected.",
    });
    expect(markup).toContain("Your character is already connected");
    expect(markup).toContain("Try again");
    expect(markup).toContain("will not disconnect another session");
    expect(markup).not.toContain("internal-character-id");
    expect(markup).not.toContain("disabled=");
    expect(markup).not.toContain("Reload page");
  });

  it("disables another request while waiting for the server", () => {
    const markup = render({
      characterId: "selected-character",
      status: "pending",
      message: "Waiting for the server to confirm entry.",
    });
    expect(markup).toContain("Entering world");
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("Waiting for server…");
    expect(markup).not.toContain("Try again");
    expect(markup).not.toContain("Reload page");
  });

  it("offers reload instead of a second uncorrelated request after timeout", () => {
    const markup = render({
      characterId: "selected-character",
      status: "expired",
      message: "The server has not confirmed entry yet.",
    });
    expect(markup).toContain("Still waiting for the server");
    expect(markup).toContain("Reload page");
    expect(markup).toContain("You can keep waiting");
    expect(markup).not.toContain("disabled=");
    expect(markup).not.toContain("Try again");
  });

  it("labels the modal and escapes server messages as text", () => {
    const markup = render({
      characterId: "selected-character",
      status: "available",
      message: '<img src="missing" onerror="alert(1)">',
    });
    const title = markup.match(/aria-labelledby="([^"]+)"/)?.[1];
    const message = markup.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(title).toBeTruthy();
    expect(message).toBeTruthy();
    expect(markup).toContain(`id="${title}"`);
    expect(markup).toContain(`id="${message}" role="status"`);
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("&lt;img");
    expect(markup).not.toContain("<img");
  });
});
