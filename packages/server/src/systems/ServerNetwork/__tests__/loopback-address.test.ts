import { describe, expect, it } from "vitest";

import { isLoopbackAddress } from "../loopback-address.js";

describe("isLoopbackAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "::1",
    "[::1]",
    "::1%lo0",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
  ])("accepts loopback address %s", (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  it.each([
    "",
    "localhost",
    "127.0.0.1:5556",
    "10.0.0.1",
    "192.168.1.21",
    "::",
    "::ffff:10.0.0.1",
    "2001:db8::1",
  ])("rejects non-address or non-loopback value %s", (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });
});
