import { describe, expect, it } from "vitest";
import { shouldRenderZoneMarker } from "../ZoneVisualsSystem";

function makeWindow(pathname: string, search = ""): Window {
  return { location: { pathname, search } } as unknown as Window;
}

describe("ZoneVisualsSystem streaming marker policy", () => {
  it("suppresses navigation emojis throughout broadcast preparation and arena views", () => {
    for (const win of [
      makeWindow("/stream.html"),
      makeWindow("/", "?embedded=true&mode=spectator"),
    ]) {
      for (const areaId of [
        "duel_arena",
        "central_haven",
        "haven_pond",
        "future_navigation_marker",
      ]) {
        expect(shouldRenderZoneMarker(areaId, win)).toBe(false);
      }
    }
  });

  it("preserves every navigation marker for ordinary gameplay", () => {
    for (const areaId of ["duel_arena", "central_haven", "haven_pond"]) {
      expect(shouldRenderZoneMarker(areaId, makeWindow("/play"))).toBe(true);
    }
  });
});
