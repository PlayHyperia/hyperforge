export type ClientConnectionAuthMode =
  "url-token" | "first-message" | "anonymous-viewer" | "load-test-bypass";

function hasExactQueryValue(url: string, name: string, expected: string) {
  try {
    return new URL(url).searchParams.get(name) === expected;
  } catch {
    return false;
  }
}

export function resolveClientConnectionAuthMode({
  url,
  urlHasAuthToken,
  authToken,
  embeddedSpectator,
  allowLoadTestBypass,
}: {
  url: string;
  urlHasAuthToken: boolean;
  authToken: string;
  embeddedSpectator: boolean;
  allowLoadTestBypass: boolean;
}): ClientConnectionAuthMode {
  if (urlHasAuthToken || authToken) return "url-token";

  if (allowLoadTestBypass && hasExactQueryValue(url, "loadTestBot", "true")) {
    return "load-test-bypass";
  }

  if (
    hasExactQueryValue(url, "mode", "streaming") ||
    hasExactQueryValue(url, "mode", "spectator") ||
    embeddedSpectator
  ) {
    return "anonymous-viewer";
  }

  return "first-message";
}
