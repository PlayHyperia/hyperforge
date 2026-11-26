import net from "node:net";

const loopbackAddresses = new net.BlockList();
loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddresses.addAddress("::1", "ipv6");

/**
 * Normalize uWS / Node remote address text and detect loopback across IPv4,
 * IPv6, and every valid IPv4-mapped IPv6 spelling.
 */
export function isLoopbackAddress(rawAddress: string): boolean {
  let address = rawAddress.trim();
  if (address.startsWith("[") && address.endsWith("]")) {
    address = address.slice(1, -1);
  }
  const baseAddress = address.split("%")[0] ?? address;
  const family = net.isIP(baseAddress);
  if (family === 0) return false;
  return loopbackAddresses.check(baseAddress, family === 4 ? "ipv4" : "ipv6");
}
