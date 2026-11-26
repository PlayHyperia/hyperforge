# Hyperia JWT signing-key rotation and recovery

This runbook covers the server-issued tokens used by HTTP, WebSocket, spectator,
and autonomous-agent authentication. It does not cover Privy tokens, SOL wallet
keys, betting-feed credentials, stream-viewer credentials, or Solana program
authorities. Those are independent trust domains and must be rotated separately.

## Configuration contract

- `JWT_ACTIVE_KEY_ID` is the one key ID used for new tokens.
- `JWT_SIGNING_KEYS` is a JSON object from key IDs to independent random secrets.
  It may contain at most 16 keys. Every key ID must match
  `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and every secret must contain at least 32
  and at most 4,096 UTF-8 bytes. `legacy-no-kid` is reserved for diagnostic
  evidence and cannot be used as a keyed ID.
- A keyed token is accepted only when its `kid` names an exact configured key,
  its algorithm is `HS256`, its type is `JWT`, its issuer is
  `hyperia-server`, its audience is `hyperia-runtime`, and its issued/expiry
  claims establish a positive lifetime of no more than seven days.
- `JWT_SECRET` is the legacy no-`kid` verification bridge. When a key ring is
  configured, it is never used to issue a new token. Remove it after every
  pre-key-ring token has expired.
- Production and staging fail before opening a database or listener if the
  authority is absent, weak, malformed, ambiguous, or does not contain the
  active key.

Key IDs are operational labels, not secrets. Use a stable date/revision label;
never place secret material in a key ID. Secrets and their configuration belong
in the deployment secret manager, not in source control, images, database
backups, tickets, chat, or screenshots.

## Planned rotation with uninterrupted verification

The server currently issues tokens for at most seven days. Record the exact
activation time and complete each phase across every replica before advancing.

1. Generate a new independent random secret in the production secret manager.
   Do not replace or edit the old secret in place.
2. Deploy a key ring containing both the old and new keyed secrets. Keep the old
   key active. During the first migration from no-`kid` tokens, also retain the
   existing `JWT_SECRET` unchanged.
3. Confirm every replica reports the same mode, active key ID, key IDs, and
   16-hex diagnostic fingerprints. A fingerprint mismatch means replicas have
   different secret material under the same ID; stop the rollout.
4. Change only `JWT_ACTIVE_KEY_ID` to the new key and deploy that configuration
   to every replica. New tokens now use the new key while old keyed tokens remain
   valid through the old verification entry.
5. Verify issuance, HTTP authentication, first-message WebSocket authentication,
   reconnect, spectator access, agent credential status, agent credential
   rotation, and restored-server startup. Confirm newly issued token headers use
   the new `kid`; never copy full tokens into evidence.
6. Wait until the last token issued by the old key is expired. Base this on the
   recorded last-issuance time and observed token expiry, not on the deployment
   time alone.
7. Remove the old keyed entry. On the first no-`kid` migration, remove
   `JWT_SECRET` only after the last pre-key-ring token has expired. Re-run the
   verification in step 5 and prove retired tokens are rejected.

Do not reuse a secret under a new key ID, keep duplicate secrets in the ring, or
remove an old key before its intended sessions have expired unless executing an
emergency revocation.

## Emergency compromise response

1. Freeze new credential issuance at the application or edge boundary if the
   incident scope is still unknown.
2. Generate a clean key and distribute one consistent ring/active-key snapshot
   to every replica. Remove the compromised keyed entry immediately. If the
   compromised material was `JWT_SECRET`, remove that bridge immediately.
3. Restart or replace every process that held the compromised secret. Compare
   key IDs and diagnostic fingerprints across all replacements.
4. Revoke active autonomous-agent credential sessions in the database and evict
   their sockets. This invalidates agent access independently of JWT expiry.
   Stateless human and spectator tokens signed by a removed key are rejected at
   signature verification and must be reissued through their normal owner flow.
5. Rotate any other credential that shared storage, access controls, logs, or an
   incident path with the compromised key. Do not assume JWT rotation covers
   Privy, SOL wallets, betting feeds, viewer access, admin access, or chain keys.
6. Preserve timestamps, affected key IDs, fingerprints, replica inventory, and
   rejection evidence. Never retain raw secrets or full bearer tokens in the
   incident record.

## Disaster recovery qualification

- Restore the database and application artifacts without embedding JWT secrets
  in either artifact. Inject the intended key-ring snapshot from the secret
  manager at process start.
- Before accepting traffic, compare the restored process's active key ID and
  fingerprints with the approved recovery record.
- Prove a new-key token works on HTTP and WebSocket paths, an overlap-key token
  behaves according to the current phase, an unknown/retired `kid` is rejected,
  and a no-`kid` token is rejected whenever `JWT_SECRET` is absent.
- Treat a lost current secret as a revocation event, not as a reason to weaken
  verification or reintroduce an old secret. Activate a new key and require
  normal reauthentication.

This repository provides the rotation mechanism and deterministic tests. A
production launch still requires an operator-owned secret-manager configuration,
cross-replica rehearsal, independent security review, and retained evidence from
the actual deployment environment.
