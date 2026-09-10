import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyPrivyToken } from "./privy-auth.js";

const MAX_BEARER_TOKEN_BYTES = 16 * 1024;

export function readSingleBearerToken(
  request: FastifyRequest,
): string | undefined {
  let occurrences = 0;
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === "authorization") {
      occurrences += 1;
    }
  }
  if (occurrences > 1) return undefined;

  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || authorization.includes(",")) {
    return undefined;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match?.[1]) return undefined;
  if (Buffer.byteLength(match[1], "utf8") > MAX_BEARER_TOKEN_BYTES) {
    return undefined;
  }
  return match[1];
}

export async function verifyPrivyRequestUser(
  request: FastifyRequest,
): Promise<string | null> {
  const token = readSingleBearerToken(request);
  if (!token) return null;

  try {
    const user = await verifyPrivyToken(token);
    return user?.isVerified === true && user.privyUserId
      ? user.privyUserId
      : null;
  } catch {
    return null;
  }
}

export async function requirePrivyRequestUser(
  request: FastifyRequest,
  reply: FastifyReply,
  claimedUserId?: string,
): Promise<string | null> {
  reply.header("Cache-Control", "no-store");
  const authenticatedUserId = await verifyPrivyRequestUser(request);
  if (!authenticatedUserId) {
    await reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  if (claimedUserId !== undefined && claimedUserId !== authenticatedUserId) {
    await reply.code(403).send({ error: "Forbidden" });
    return null;
  }
  return authenticatedUserId;
}
