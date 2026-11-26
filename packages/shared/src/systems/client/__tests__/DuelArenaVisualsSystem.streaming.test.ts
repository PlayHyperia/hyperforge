import { describe, expect, it } from "vitest";
import {
  shouldRenderArenaCenterMarker,
  shouldRenderInteractiveArenaProps,
} from "../DuelArenaVisualsSystem";

function viewport(pathname: string, search = ""): Window {
  return {
    location: { pathname, search },
  } as unknown as Window;
}

describe("DuelArenaVisualsSystem streaming viewport policy", () => {
  it("omits interaction markers and banners from the stream page", () => {
    expect(shouldRenderInteractiveArenaProps(viewport("/stream.html"))).toBe(
      false,
    );
  });

  it("omits interaction markers and banners from embedded spectator views", () => {
    expect(
      shouldRenderInteractiveArenaProps(
        viewport("/", "?embedded=true&mode=spectator"),
      ),
    ).toBe(false);
  });

  it("preserves interaction markers and banners in normal gameplay", () => {
    expect(shouldRenderInteractiveArenaProps(viewport("/"))).toBe(true);
  });

  it("keeps the center marker out of cinematic spectator framing", () => {
    expect(shouldRenderArenaCenterMarker(viewport("/stream.html"))).toBe(false);
    expect(
      shouldRenderArenaCenterMarker(
        viewport("/", "?embedded=true&mode=spectator"),
      ),
    ).toBe(false);
    expect(shouldRenderArenaCenterMarker(viewport("/"))).toBe(true);
  });
});
