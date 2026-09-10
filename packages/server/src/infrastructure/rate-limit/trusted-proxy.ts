import { isIP } from "node:net";

const MAX_TRUSTED_PROXY_ENTRIES = 32;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export class TrustedProxyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustedProxyConfigurationError";
  }
}

export type TrustedProxyConfig = false | true | string[];

function isDeploymentEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return (
    environment.NODE_ENV === "production" || environment.NODE_ENV === "staging"
  );
}

function validateIpOrCidr(value: string): void {
  const slashIndex = value.indexOf("/");
  const address = slashIndex === -1 ? value : value.slice(0, slashIndex);
  const version = isIP(address);
  if (version === 0) {
    throw new TrustedProxyConfigurationError(
      `TRUST_PROXY contains an invalid IP address or CIDR: ${value}`,
    );
  }
  if (slashIndex === -1) return;

  if (value.indexOf("/", slashIndex + 1) !== -1) {
    throw new TrustedProxyConfigurationError(
      `TRUST_PROXY contains an invalid CIDR: ${value}`,
    );
  }
  const prefix = value.slice(slashIndex + 1);
  if (!/^(0|[1-9][0-9]{0,2})$/u.test(prefix)) {
    throw new TrustedProxyConfigurationError(
      `TRUST_PROXY contains an invalid CIDR prefix: ${value}`,
    );
  }
  const prefixNumber = Number(prefix);
  const maximum = version === 4 ? 32 : 128;
  if (prefixNumber > maximum) {
    throw new TrustedProxyConfigurationError(
      `TRUST_PROXY contains an invalid CIDR prefix: ${value}`,
    );
  }
}

export function resolveTrustedProxy(
  environment: NodeJS.ProcessEnv = process.env,
): TrustedProxyConfig {
  const raw = environment.TRUST_PROXY;
  const normalized = raw?.trim().toLowerCase();
  if (raw === undefined || normalized === "" || normalized === "false") {
    return false;
  }

  if (normalized === "true") {
    if (isDeploymentEnvironment(environment)) {
      throw new TrustedProxyConfigurationError(
        "TRUST_PROXY=true is forbidden in production and staging; configure exact proxy IP addresses or CIDRs",
      );
    }
    return true;
  }
  if (CONTROL_CHARACTER_PATTERN.test(raw)) {
    throw new TrustedProxyConfigurationError(
      "TRUST_PROXY must not contain control characters",
    );
  }

  const entries = raw.split(",").map((entry) => entry.trim());
  if (
    entries.length < 1 ||
    entries.length > MAX_TRUSTED_PROXY_ENTRIES ||
    entries.some((entry) => entry.length === 0)
  ) {
    throw new TrustedProxyConfigurationError(
      `TRUST_PROXY must contain between 1 and ${MAX_TRUSTED_PROXY_ENTRIES} IP addresses or CIDRs`,
    );
  }

  const uniqueEntries = new Set(entries);
  if (uniqueEntries.size !== entries.length) {
    throw new TrustedProxyConfigurationError(
      "TRUST_PROXY must not contain duplicate entries",
    );
  }
  for (const entry of entries) validateIpOrCidr(entry);
  return entries;
}
