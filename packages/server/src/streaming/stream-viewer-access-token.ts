import { createHash, timingSafeEqual } from "node:crypto";

export function resolveStreamingViewerAccessToken(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicitToken = (env.STREAMING_VIEWER_ACCESS_TOKEN || "").trim();
  if (explicitToken) {
    return explicitToken;
  }

  const jwtSecret = (env.JWT_SECRET || "").trim();
  if (!jwtSecret) {
    return "";
  }

  return createHash("sha256")
    .update("hyperia-stream-viewer:")
    .update(jwtSecret)
    .digest("hex");
}

function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function extractStreamingViewerBearerToken(
  authorizationHeader: string | string[] | undefined,
): string | null {
  const header = Array.isArray(authorizationHeader)
    ? authorizationHeader[0]
    : authorizationHeader;
  if (!header || !/^Bearer\s+/i.test(header)) return null;
  return header.replace(/^Bearer\s+/i, "").trim() || null;
}

export function hasValidStreamingViewerAccessToken(
  authorizationHeader: string | string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const expected = resolveStreamingViewerAccessToken(env);
  const provided = extractStreamingViewerBearerToken(authorizationHeader);
  if (!expected || !provided) return false;
  return timingSafeEqual(digestToken(expected), digestToken(provided));
}
