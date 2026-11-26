import { describe, expect, it } from "vitest";

import { getSystemRuntimePolicy } from "../systemRuntime";

describe("shared system runtime registration policy", () => {
  it("keeps client-only render systems out of a headless server", () => {
    expect(getSystemRuntimePolicy("server")).toEqual({
      client: false,
      server: true,
    });
  });

  it("keeps server-only simulation systems out of a browser client", () => {
    expect(getSystemRuntimePolicy("client")).toEqual({
      client: true,
      server: false,
    });
  });
});
