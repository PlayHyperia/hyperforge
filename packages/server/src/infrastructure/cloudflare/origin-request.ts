export const CLOUDFLARE_ORIGIN_SECRET_HEADER =
  "x-hyperia-origin-secret" as const;

/**
 * Remove any client-provided origin credential and, when configured, replace it
 * with the edge-owned value before forwarding a request to the game server.
 */
export function prepareOriginRequest(
  request: Request,
  originSecret: string | undefined,
): Request {
  const headers = new Headers(request.headers);
  headers.delete(CLOUDFLARE_ORIGIN_SECRET_HEADER);
  if (originSecret) {
    headers.set(CLOUDFLARE_ORIGIN_SECRET_HEADER, originSecret);
  }
  return new Request(request, { headers });
}
