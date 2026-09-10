# Distributed authentication rate limiting

Hyperia uses two independent HTTP protections:

- `@fastify/rate-limit` remains a fast, process-local load-shedding layer.
- PostgreSQL migration `0093_add_distributed_rate_limit_authority` supplies the
  shared fixed-window authority for agent credential, SOL wallet-auth, username
  enumeration, and failed admin-auth routes.

Production and staging cannot disable the shared layer. Startup fails before a
listener opens unless `DISTRIBUTED_RATE_LIMIT_KEY_SECRET` is at least 32 bytes,
migration 0093 has the exact table, five constraints, and expiry index, and the
database is reachable. All replicas must use the same secret. Startup logs only
a 16-hex fingerprint so operators can compare replicas without exposing key
material.

The stored bucket key is an HMAC of a version tag, route scope, and Fastify's
resolved client IP. Neither the raw address nor the secret is persisted. A
database failure, timeout, missing pool, malformed identity, or incomplete
schema returns `503`; it never permits an uncounted authentication attempt.
The sixth request to an agent-auth route scope in a 60-second window returns
`429` with a bounded `Retry-After`; the username check allows 30 requests. Five
failed admin credentials within one minute create a shared five-minute lockout,
while successful admin operations are not counted. Route scopes and different
client identities are isolated.

## Proxy boundary

Forwarded addresses are ignored unless `TRUST_PROXY` names exact proxy IPs or
CIDRs as a comma-separated list. `TRUST_PROXY=true` is rejected in production
and staging because it lets an untrusted direct client choose its rate-limit
identity. The edge proxy must overwrite client-supplied forwarding headers and
must be the only network path to the application. Use deployment-specific
ranges from the chosen provider; do not copy the documentation examples into
production.

Before promoting a deployment:

1. Provision one independent distributed-limit secret in the deployment secret
   manager and deliver the same version to every replica.
2. Apply migration 0093 before starting the new release.
3. Configure only the actual proxy IPs/CIDRs and block direct application-port
   access at the network boundary.
4. Compare the rate-limit key fingerprint and proxy-entry count in every
   replica's startup output.
5. From the authorized staging edge, prove five attempts are accepted across
   multiple replicas, the sixth is rejected, a spoofed forwarding header does
   not change identity, and a database outage returns `503`.
6. Rotate the HMAC key only with an intentional counter reset. A mixed-key
   replica rollout creates independent buckets and is not allowed.

Local duel-stack runs generate a disposable key when none is configured. That
convenience is local orchestration only and is not a production provisioning
mechanism.
