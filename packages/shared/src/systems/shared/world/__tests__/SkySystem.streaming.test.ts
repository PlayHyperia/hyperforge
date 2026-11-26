import { describe, expect, it } from "vitest";
import { shouldRenderDecorativeSkyBillboards } from "../SkySystem";

function viewport(pathname: string, search = ""): Window {
  return {
    location: { pathname, search },
  } as unknown as Window;
}

describe("SkySystem streaming viewport policy", () => {
  it("omits decorative sky billboards from the dedicated stream page", () => {
    expect(shouldRenderDecorativeSkyBillboards(viewport("/stream.html"))).toBe(
      false,
    );
  });

  it("omits decorative sky billboards from embedded spectator views", () => {
    expect(
      shouldRenderDecorativeSkyBillboards(
        viewport("/", "?embedded=true&mode=spectator"),
      ),
    ).toBe(false);
  });

  it("preserves decorative sky billboards in normal gameplay", () => {
    expect(shouldRenderDecorativeSkyBillboards(viewport("/"))).toBe(true);
  });
});
