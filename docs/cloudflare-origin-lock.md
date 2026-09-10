# Cloudflare edge-to-origin request lock

The request lock is an optional defense-in-depth boundary between the
Cloudflare Worker and the Hyperia HTTP server. When
`CLOUDFLARE_ORIGIN_SECRET` is configured on the server, every request except an
exact `GET`/`HEAD` request to `/health` or `/status` must carry the matching
edge-injected `x-hyperia-origin-secret` header.

The secret must be 32-512 bytes of visible ASCII, excluding commas and outer
whitespace. Generate it with a cryptographically secure secret generator, store
it only in the deployment secret managers, and configure the exact same value
for the Worker and origin. Never use a `PUBLIC_*` variable or expose the value to
browser code, logs, screenshots, or source control.

The Worker removes any client-supplied copy of the header before setting its own
value. The header is deliberately absent from the server's CORS allow-list;
browsers are not part of this authentication exchange.

## Deployment gate

1. Set the same secret on the origin and Worker in a controlled maintenance or
   canary window. A server with no configured secret leaves the optional lock
   disabled; a server with an invalid configured value refuses to initialize its
   HTTP stack.
2. Confirm the server startup log reports `enforcement enabled` and record only
   the non-secret fingerprint. Never record the secret.
3. Verify the public edge URL can load `/`, `/env.js`, API routes, HLS media, and
   the WebSocket upgrade path.
4. Verify a direct origin request without the header and with an incorrect or
   duplicate header returns `403` with `Cache-Control: no-store`.
5. Verify exact `GET`/`HEAD` probes to `/health` and `/status` remain reachable,
   while lookalike paths and state-changing methods remain locked.
6. Restrict the origin at the network/platform layer to Cloudflare egress where
   the hosting provider supports it. The shared secret complements that control;
   it does not replace it.

Do not declare this gate complete until a deployed canary proves both the edge
success path and direct-origin rejection. Repository tests cannot validate
deployment secret parity, proxy header rewriting, or provider firewall rules.
