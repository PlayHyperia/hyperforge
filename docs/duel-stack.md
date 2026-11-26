# Duel Stack (`bun run duel`)

`bun run duel` boots the Hyperia duel/stream stack. Set
`DUEL_WITH_HYPERBET=true` to add the local SOL-only betting runtime:

1. Hyperia game server + client with one authoritative streaming scheduler
2. Model-backed duel agents or deterministic model-free local agents
3. RTMP bridge and HLS fanout
4. Hyperbet SOL backend, synchronized from Hyperia
5. Hyperbet browser app, routed through the Hyperbet backend
6. Hyperbet SOL keeper, consuming Hyperia's authenticated internal feed

The duel launcher is native-SOL-only. It never invokes an alternate-chain
bootstrap and exposes no flag that can add one to the launch path.

## Run

```bash
bun run duel
DUEL_WITH_HYPERBET=true bun run duel
```

`bun run duel` now bootstraps streaming prerequisites automatically on first run:

- verifies FFmpeg before starting services and passes its absolute executable path to the capture worker; `FFMPEG_PATH` is authoritative, followed by PATH/system installations and the optional `ffmpeg-static` package. An invalid explicit override fails startup. Retained-video smoke runs also verify `ffprobe` (`FFPROBE_PATH` can override it).
- auto-installs Playwright Chromium if the bundled browser is missing

No separate Docker stream container is required for stream fanout.

Built server starts go through `scripts/start-hyperia-server.mjs`. Its separate
bootstrap verifies competitive manifest v3 and the actual resolved gameplay
artifacts before importing any gameplay code, even when `NODE_ENV` is unset.
The bootstrap build permits only its two reviewed source inputs and Node builtin
imports. The package start command and both Railway configurations use this
wrapper; production prestart no longer runs development chain setup.
For a read-only runtime identity check, use the pinned Node runtime with
`node --import ./packages/server/scripts/register-hooks.mjs scripts/start-hyperia-server.mjs --preflight-only`.
This exits without starting the game or opening a listener. Missing bootstrap,
manifest, worker, or resolved runtime bytes must be rebuilt, not bypassed.

`bun run stream:runtime:test` runs real encoder/probe and early-startup rejection
checks. It requires the repository's pinned Node and Bun versions plus installed
FFmpeg and ffprobe; CI installs these explicitly. If several Bun versions are
installed, set `DUEL_HYPERIA_BUN_PATH` to the Hyperia version. Container image
builds verify the installed media binaries; these checks do not qualify a GPU,
browser capture, or an external streaming destination.

`bun run stream:browser-performance:test` requires Playwright Chromium and
FFmpeg. It serves real HTTP resources and encoded MPEG-TS media to reproduce
Chromium's finite resource-timing history, then verifies that the full-topology
observer keeps exact transfer totals beyond saturation and timeline clearing.
Requesting a performance profile requires a production-preview app, enabled
betting and streaming verification, and explicit valid HTTP(S) app, Hyperbet API,
and HLS endpoints. Missing prerequisites reject before readiness polling; they
cannot silently skip browser measurement. The transfer classifier assumes this
topology's exclusive `/live/` HLS route, not arbitrary unrelated media routes.
Explicit read-only or local-transaction browser verification also rejects
skipped betting or a missing Hyperbet API, even with the performance profile off.
The observer is installed before navigation and retains aggregate counters plus
at most 4,096 recent media completion records, never request URLs or an expanding
session history. Performance evidence schema v3 distinguishes startup (navigation
through first decoded frame), the fixed ten-second post-transaction sample, and
complete-session transfer totals. The unchanged 64 MiB segment transfer/encoded
ceilings apply separately to startup and the fixed sample; cumulative live-media
totals remain visible but are not capped independently of viewing duration.
The unchanged 10 MiB media ceiling also applies to the maximum rolling ten-second
window across the entire observed session, so a later quiet sample cannot hide
an earlier burst. Bytes are charged at observer delivery of completed Resource
Timing entries, not claimed as packet-level instantaneous throughput. The bounded
window queue is drained on snapshot; overflow, unsupported observation, reported
dropped/invalid entries, missing startup/sample segment data, and zero sample
transfers fail closed. Decode, frame-rate, latency, non-media, and all numeric
byte limits are unchanged. This corrects the old variable-session 64 MiB test,
which necessarily rejected sufficiently long healthy continuous playback.
CI provisions Chromium explicitly before this gate. This measurement regression
does not replace the production-built 3D/HLS/native-SOL lifecycle or soak.

Recommended fresh-install prep command:

```bash
bun run install
```

This ensures assets are synced and Chromium is installed for local capture.

Database startup is fail-closed. With no explicit URL, the launcher uses the
single Docker container described by `POSTGRES_CONTAINER`, `POSTGRES_PORT`,
`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, and `POSTGRES_IMAGE`. An
existing container must match every value, and the requested host port must be
free before a new container is created. To use any pre-existing or hosted
PostgreSQL service, set `DUEL_DATABASE_MODE=remote`, provide
`DUEL_DATABASE_URL` (or `DATABASE_URL`), and set `USE_LOCAL_POSTGRES=false`.
The launcher never falls back to another process listening on a familiar port.

`GET /health` always executes the running `DatabaseSystem`'s bounded PostgreSQL
probe and returns its measured latency, pool counts, and explicit `healthy`,
`unhealthy`, `unavailable`, or `timeout` status. Database failure returns HTTP
503 by default. `HEALTH_CHECK_DB_TIMEOUT_MS` sets the bounded probe deadline
(minimum 250 ms). A deployment with a separate readiness endpoint may set
`HEALTH_CHECK_STRICT_DB=false` for a liveness-only HTTP 200 response, but the
payload remains `degraded` and never reports the database check as skipped.
The same endpoint exposes aggregate-only `duelDamageReconciliation` readiness:
normal in-flight commits report `processing`, an ambiguous response reports
`reconciling`, and a commit that returns no result within
`HEALTH_DUEL_DAMAGE_PENDING_MAX_AGE_MS` reports `stalled` (default 5,000 ms;
minimum 1,000 ms). Reconciling or stalled damage makes readiness return HTTP
503 without exposing duel, player, or operation identities.

When `STREAMING_DUEL_PREPARATION_MS` enables the private on-deck window,
startup also requires migration 0098's exact contestant-host lease table,
constraints, triggers, and expiry index. Each embedded contestant claims one
immutable process UUID before its preparation bank can open, refreshes the
lease on PostgreSQL time, and must still have a live lease at readiness and
competitive freeze. External ElizaOS contestants receive the preparation ID
and database-clock window only on their own authenticated socket. The plugin
does not enter its on-deck behavior until the server has bound its module-level
process UUID to that socket's player identity, claimed the lease, and completed
an immediate refresh. Heartbeats are correlated and non-overlapping; a
transient database response remains retryable, an exact rejection revokes
local preparation immediately, and an abnormal reconnect may resume only with
the same still-live process identity. Once that exact claim is active, the
embedded-agent manager no longer misclassifies the socket-owned contestant as
missing. It attaches a non-owning direct action facade to the existing player,
stops open-world movement/combat, opens only the durable preparation bank, and
runs the same deterministic owned/legal safety planner and atomic whole-plan
commit used by embedded agents. A reconnect resolves the immutable UUIDv5
receipt before planning and cannot repeat custody mutation. The plugin keeps
ordinary autonomy suspended, never runs its legacy location-based deposit-all
or food-withdrawal path, and never starts a second combat controller. After the
private bank is open and the server has derived the complete legal role and
Prayer allowlists, append-only packet `296` gives the authenticated plugin one
bounded pre-market strategy request containing only names and public build
profiles. Its ElizaOS runtime may select one legal opening role and allowlisted
tactical macro; exact schema validation rejects extra authority, unavailable
roles or Prayers, item requests, quantities, and direct actions. The server
freezes a valid response into the same atomic plan evidence and deterministic
combat executor used for embedded contestants, or uses the deterministic
strongest complete setup after a three-second deadline, malformed response,
disconnect, replay, or provider failure. The plugin caches one semantic
decision per preparation and does not call the model again for a correlated
retry. It receives only correlated `validating`, `ready`, or `failed` scalar
status while the server validates and later executes the frozen tactic. No
owner ID, opponent history, bank item, or bank quantity is sent to another
contestant, the plugin, or a public viewer. Missing claims after the bounded
grace or
expired leases are atomically promoted to the
existing `agent_unavailable` report; the scheduler cancels the private
selection before any market is published. An expired lease cannot be revived
or transferred to a restarted process. This closes the deterministic external
loadout/readiness fallback and authenticated external model-selected opening
strategy in source and unit coverage. The recorded provider/model labels prove
only the authenticated remote decision transport and protocol version; they do
not attest which remote model binary executed. This does not provide
cryptographic executable attestation for an arbitrary remote plugin build or
substitute for the disposable-PostgreSQL process-kill, live-provider, and
connected full-topology proof required by the launch checklist.
`DUEL_PREPARATION_AGENT_HOST_LEASE_MS` (default 15,000),
`DUEL_PREPARATION_AGENT_HOST_HEARTBEAT_MS` (default 3,000), and
`DUEL_PREPARATION_AGENT_HOST_CLAIM_GRACE_MS` (default 10,000) configure this
technical failure-detection envelope. They do not choose preparation duration,
combat rules, betting timing, or economics.

When no supported model-provider credential is configured, `bun run duel`
creates the requested deterministic server-side sparbot roster and requires the
entire roster to be ready before capture or markets can start. Direct
`bun run dev:duel` uses two or more deterministic local test agents in the same
situation; it enables `LOAD_TEST_MODE` only for the non-production server it
starts. With `--skip-dev`, both the existing local server and the duel-bot
process must explicitly set `LOAD_TEST_MODE=true`. Ordinary and production
clients cannot claim this bypass. Any roster below two connected agents is a
startup failure, never a successful `0/0` matchmaker.

Optional flags:

```bash
bun run duel --bots=6 --betting-port=4179 --rtmp-port=8765
bun run duel --hyperbet-api-url=http://localhost:8080
bun run duel --skip-keeper
bun run duel --skip-stream
bun run duel --verify
```

The integrated launcher auto-detects a complete sibling
`hyperbet-solana-implementation` or `hyperbet` monorepo. Set
`DUEL_HYPERBET_ROOT` (or `--hyperbet-root`) to use another location.

The launcher generates a private 32-byte betting-feed credential when one is
not configured, verifies that unauthenticated access is rejected, and proves an
authenticated schema-v3 bootstrap before starting Hyperbet. To preserve feed
credentials across process restarts, configure
`DUEL_BETTING_FEED_ACCESS_TOKEN` in the runtime secret store. The value is never
sent to the browser or logged.

The Hyperbet backend is intentionally read-only with respect to keeper signing
roles. The separate keeper process must have all required SOL role variables;
mainnet requires distinct wallets. If required programs, roles, synchronized
state, parser/RPC health, or fresh keeper health are unavailable, the launcher
fails instead of reporting the stack online. `--skip-keeper` is an explicit
development override and does not represent launch-ready betting health.

## Streaming Outputs

Configure the following env vars (root `.env` or `packages/server/.env`):

- `RTMP_MULTIPLEXER_URL` (+ optional `RTMP_MULTIPLEXER_STREAM_KEY`, `RTMP_MULTIPLEXER_NAME`)
- `TWITCH_STREAM_KEY` (or `TWITCH_RTMP_STREAM_KEY`)
  Optional ingest override: `TWITCH_STREAM_URL` / `TWITCH_RTMP_URL` / `TWITCH_RTMP_SERVER`
- `YOUTUBE_STREAM_KEY` (or `YOUTUBE_RTMP_STREAM_KEY`)
  Optional ingest override: `YOUTUBE_STREAM_URL` / `YOUTUBE_RTMP_URL`
- `KICK_STREAM_KEY` (+ optional `KICK_RTMP_URL`)
- `PUMPFUN_RTMP_URL` (+ optional `PUMPFUN_STREAM_KEY`)
- `X_RTMP_URL` (+ optional `X_STREAM_KEY`)
- `RTMP_DESTINATIONS_JSON` for additional/custom fanout destinations
- `STREAMING_VIEWER_ACCESS_TOKEN` optional gate for live WebSocket stream/spectator viewers

Canonical bettor-facing stream policy (no env required):

- Canonical platform: owned `hls`
- Canonical public source: `/live/stream.m3u8`
- Default public delay: `4000ms`
- Optional external platform: `STREAMING_CANONICAL_PLATFORM` (`youtube` | `twitch`)
- Required with an external platform: `STREAMING_CANONICAL_SOURCE_URL`
- Optional override: `STREAMING_PUBLIC_DELAY_MS`

The source URL is returned by `/api/streaming/config`. It must be a public
HTTP(S) URL or root-relative public path and cannot contain credentials or a
fragment. Unsupported platforms, missing external sources, and malformed delay
overrides stop startup instead of falling back to another channel. External RTMP
destinations are fanout outputs and never silently replace the canonical source.

Optional client-side extra delay (usually keep `0` if server delay is enabled):

- `VITE_UI_SYNC_DELAY_MS`

Website/betting stream input:

- The marketing website does not mount a second stream player or wallet. Its
  `NEXT_PUBLIC_HYPERBET_URL` navigation and `/arena` compatibility page hand off
  to the one supported Hyperbet deployment.
- Standalone Hyperbet deployments set `VITE_STREAM_URL` to that same canonical
  source. `VITE_STREAM_SOURCES` is reserved for an explicitly reviewed fallback
  list; no platform or channel is supplied by default.

The integrated launcher forces Hyperia's reported platform to `hls` and injects
the exact same absolute HLS URL into Hyperia's public configuration and the
Hyperbet player. A generic inherited `VITE_STREAM_URL` cannot redirect only one
side of that topology, and the browser is never pointed at a same-origin path
owned by the Vite process.

When `STREAMING_PUBLIC_DELAY_MS > 0`, live `mode=streaming` WebSocket viewers are restricted to:

- loopback/local capture clients, or
- clients presenting `streamToken=<STREAMING_VIEWER_ACCESS_TOKEN>`

`stream-to-rtmp` automatically appends `streamToken` to capture URLs when `STREAMING_VIEWER_ACCESS_TOKEN` is set.

## Spectator + Betting URLs

- Canonical game stream view: `http://localhost:3333/stream.html`
- Hyperbet backend: `http://localhost:8080`
- Hyperbet app: `http://localhost:4179`
- Local HLS source: `http://localhost:5555/live/stream.m3u8`

## Runtime APIs

Public Hyperia telemetry:

- `GET /api/streaming/state`
- `GET /api/streaming/duel-context`
- `GET /api/streaming/agent/:characterId/inventory`
- `GET /api/streaming/agent/:characterId/monologues?limit=20`

Private Hyperia-to-keeper synchronization (bearer token required):

- `GET /api/internal/bet-sync/state`
- `GET /api/internal/bet-sync/events?since=<sequence>`

The browser talks to the Hyperbet backend for synchronized stream state,
markets, points/history, settlement history, invites, and Solana RPC/sender
proxy routes. It does not receive the private feed credential.

## Verification

From a clean checkout, run the complete local launch gate with Docker running,
Git LFS installed, Node from `.node-version`, and Bun 1.3.14:

```bash
bun run duel:smoke:clean
bun run duel:smoke:clean --with-hyperbet
bun run duel:smoke:clean --with-hyperbet --with-keeper
bun run duel:smoke:clean --with-hyperbet --with-keeper --with-local-solana --with-stream-recovery
bun run duel:smoke:clean --with-hyperbet --with-keeper --with-local-solana --with-authority-recovery
bun run duel:smoke:clean --with-hyperbet --with-keeper --with-local-solana --soak-duration-s=300
bun run server:container:smoke
```

With a migrated disposable PostgreSQL database, the dedicated hard-loss gate
can be run from `packages/server`:

```bash
DUEL_PREPARATION_HOST_LEASE_TEST_DATABASE_URL=postgresql://... \
  bun run test:duel-preparation-host-lease-chaos
```

It claims both private contestant hosts, marks one ready, `SIGKILL`s that host,
waits for the last committed database-clock lease to expire, then proves one
immutable `agent_unavailable` report, no replacement lease takeover, no bank or
second-readiness access, no competitive snapshot, and the existing fenced
pre-market cancellation.

This single command performs a frozen dependency install, requires the full
game asset pack, installs the bundled Chromium capture browser (and Linux
system dependencies in CI), builds the production monorepo, and launches an
isolated fresh stack. It provisions a uniquely named PostgreSQL container and
volume, uses six dedicated ports (eight when Hyperbet is included), starts the
production server and client plus exactly two deterministic agents, waits for
a browser-rendered combat duel and healthy advancing HLS/audio capture, and
then removes only the processes, container, volume, HLS output, runtime
directory, and client runtime-env change created by that invocation. The
command fails if any owned resource leaks.

`server:container:smoke` independently qualifies the canonical
`Dockerfile.server` release boundary. It performs a frozen build, verifies the
exact non-root Node 22 runtime and immutable asset input, starts a uniquely
named private Docker network with fresh pinned PostgreSQL, applies and counts
the complete migration journal, requires the launch-critical duel/bank/autonomy
tables, probes strict database health plus the built client and stream pages,
rejects public environment or log credential leakage, confirms that disabled
streaming dependencies fail closed, and requires a zero-exit `SIGTERM`. It
removes its server, database, network, and image and fails if any owned resource
survives. Published asset diagnostics currently listed in the launch checklist
are reported separately; any new warning or error fails the command.

The clean smoke is deliberately a loopback-only, model-free, no-money launch
test by default. Synthetic contestants are accepted only when production
artifacts are combined with the smoke's explicit loopback, authority,
load-test, and betting-disabled invariants.

`--with-hyperbet` extends that no-money boundary with the real synchronized
Hyperbet backend and browser app. It explicitly disables transaction authority,
does not mount the Solana provider, scan/reconnect wallets, poll the cluster or
keeper, or expose wallet identity/signing functions to the market panel. It
removes wallet and transaction controls while preserving public matchup data.
The player prefers hls.js for Chromium's MPEG-TS live path and uses native HLS
only when Media Source Extensions are unavailable. The automated verifier
requires a fresh authoritative backend source observation, both authoritative
agent names in the browser, the exact declared Hyperia HLS URL, a playing video
whose `currentTime` advances, meaningful UI content, the spectator label, no
wallet/transaction call to action, no console warning/error or page error, and
no failed or HTTP 4xx/5xx browser request.

`--with-keeper` is a separate transaction-enabled gate. It requires
`--with-hyperbet`, executable fight-oracle and duel-market programs on the
selected Solana cluster, and every required keeper role. Missing programs or
roles stop startup before the scheduler is released or the launcher reports
online. Run this mode only against an intentionally provisioned environment;
unlike spectator mode, the keeper can submit SOL transactions.

`--with-local-solana --with-stream-recovery` is the owned transaction and
capture-recovery qualification path. It creates a fresh local validator and
ephemeral diagnostic wallet, submits and reconciles one browser-signed native
SOL order, retains terminal/dispute evidence, injects renderer unavailability,
and sends `SIGKILL` only to the separately validated capture-worker process
group. The gate requires Hyperia, Hyperbet, and the browser to fail closed
within five seconds, zero actionable wager controls during recovery, the same
duel/market authority before and after replacement, an unchanged viewer and
warm-renderer navigation epoch, and an advancing HLS playlist after restart.
The supervisor publishes an immediate unavailable status when the worker exits;
the server samples this local status at most every 500 ms. This diagnostic path
does not contact a public cluster or external broadcast destination.

The existing recovery observer opens a separate browser session without
connecting the diagnostic wallet. Its earlier signed order is a prerequisite
from the startup verifier, not proof that an already-open unsigned confirmation
is invalidated during an outage. Connected-wallet authority-loss acceptance
remains separate: retain the exact wallet/market and unsigned review, prove no
automatic signing or stale review after recovery, then explicitly review and
verify a fresh finalized transaction.

`--with-local-solana --with-authority-recovery` is the complementary owned
world-authority qualification path. After the full production-built 3D,
streaming, Hyperbet, browser-transaction, keeper, and local-Solana gate passes,
the verifier resolves the launcher's exact game-server PID, requires a fresh
announcement with one canonical open SOL market, and sends `SIGKILL` only to
that validated child. The already-open Hyperbet page must fail closed within
five seconds while retaining the current market panel and exposing zero wager
controls. A cold replacement must reacquire the exact cycle, duel, duel key,
and keeper market within 45 seconds; the same page must then resume without a
reload while preserving its viewer marker, time origin, single navigation
entry, and warm-renderer target, and HLS video must advance. During the outage,
Hyperbet returns `503` instead of reauthorizing cached state and ignores the
cold replacement's anonymous `IDLE` bootstrap until a valid authoritative frame
arrives. The discriminator-filtered on-chain market account set must remain
unchanged through a post-recovery hold, which rejects an overlapping cycle or
duplicate market. Evidence is private mode, write-once per run directory, and
records browser, renderer, stream, authority, PID, timing, and exact market
continuity. This is loopback/localnet evidence; it does not claim multi-host,
public-cluster, external-network, or production-infrastructure failover.

`--soak-duration-s=<seconds>` runs the load and same-session browser soak
concurrently after the transaction-enabled topology has passed. The isolated
Hyperbet browser is opened once and closed in `finally`; the soak clock and
start screenshot are withheld until decoded canonical HLS, the exact fresh
cycle/duel/key/market authority, and the actual enabled prediction-submit
control agree. The browser must keep its marker, time origin, and single
navigation entry while every observation remains authoritative and wager-safe.
It fails on playback stalls, browser/console/page/network issues, authority or
market drift, unsafe controls, or bounded heap/DOM/document ceilings. The load
side simultaneously enforces SSE, HLS, API, lifecycle, server, renderer,
resource-timing, and resource-ecology checks. Both mode-0600 evidence files and
their combined summary are write-once. A rejection or failed monitor result
aborts every concurrent path; the launcher sends `SIGTERM` and then a bounded
`SIGKILL` only to its exact owned load-test child while browser closure remains
in `finally`. Terminal list/inspect/feed-status/history probes use read-only
SQLite connections so evidence collection cannot contend with live checkpoint
writes. A short run qualifies the harness and rollover behavior only; it does
not close the six-hour production-shaped gate.

When this launcher owns the disposable Agave validator, it also sizes
`--limit-ledger-size` from the requested soak duration. The retained-shred
budget uses the measured local rate of 208 shreds per second, rounds up to
10,000-shred increments, and keeps Agave's 10,000-shred default only when the
soak is disabled. To stay inside the host's available disk, it is capped at a
one-hour rolling recovery window: a five-minute run retains 70,000 shreds and
every run of at least one hour retains 750,000. The lifecycle parser persists
finalized checkpoints continuously and remains fail-closed if history before
its checkpoint is unavailable. This is local test-infrastructure custody, not
proof that a production RPC can backfill an outage longer than one hour.

Run the full startup verifier against a running stack:

```bash
bun run duel:verify
bun run duel:verify --require-destinations=twitch,youtube
bun run duel:test:hyperbet-backend
```

This validates server/client/betting uptime, active duel combat, RTMP bridge status evidence, and telemetry endpoints.
RTMP bridge status is best-effort by default, and can be made strict with `--require-destinations`.
The backend smoke test launches an isolated real Hyperbet service against a
synthetic authoritative Hyperia source, proves fresh source polling and proxy
state, verifies that keeper authority secrets are not injected, then cleans up
all temporary state.
