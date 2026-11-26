import { describe, expect, it } from "vitest";

import { isLoadTestMode } from "../authentication";

describe("load-test authentication policy", () => {
  it("requires an explicit non-production load-test runtime", () => {
    expect(isLoadTestMode({})).toBe(false);
    expect(
      isLoadTestMode({ LOAD_TEST_MODE: "true", NODE_ENV: "development" }),
    ).toBe(true);
    expect(isLoadTestMode({ LOAD_TEST_MODE: "true", NODE_ENV: "test" })).toBe(
      true,
    );
  });

  it("cannot be enabled in production", () => {
    expect(
      isLoadTestMode({ LOAD_TEST_MODE: "true", NODE_ENV: "production" }),
    ).toBe(false);
  });
});
