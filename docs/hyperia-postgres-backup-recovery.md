# Hyperia PostgreSQL backup and isolated recovery

This runbook covers the authoritative Hyperia PostgreSQL database. The tooling
creates a full custom-format snapshot, binds it to the exact release, migration
journal, public schema, archive table of contents, and row count of every public
table, and verifies an isolated restore. It does not authorize activation of a
recovered database.

The project owner and operations team must approve the production retention,
encryption, storage location, backup cadence, RPO, RTO, maintenance window,
PostgreSQL target version, witnesses, and final cutover procedure. Mode `0600`
protects a local file from other users; it is not storage encryption.

## Required boundary

1. Record one non-secret boundary ID and the full approved Hyperia release SHA.
2. Disable external SOL transaction authority and new Hyperbet market creation.
3. Put duel scheduling into maintenance, resolve or explicitly cancel the active
   cycle under the approved policy, and drain all keeper terminal work.
4. Stop every Hyperia database writer. Confirm no second server, worker, admin
   tool, or migration process can write. Record the witness and timestamps in
   the change record.
5. Confirm the approved backup destination parent exists on the intended
   filesystem and that the destination container itself does not exist.

The exported PostgreSQL snapshot is internally consistent even while the dump
runs. Quiescence is still mandatory for a cross-system recovery boundary that
must agree with the separate Hyperbet recovery set.

## Credential boundary

Do not put a password in a URL, command argument, `PGPASSWORD`, `DATABASE_URL`,
or `POSTGRES_URL`. Create an externally managed, mode-`0600` `PGPASSFILE` with
exactly one canonical line and a final newline:

```text
HOST:PORT:DATABASE:USER:PASSWORD
```

Escape a colon or backslash inside a field as `\:` or `\\`. Wildcards and
multiple entries are rejected. Set `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`,
`PGPASSFILE`, and the approved TLS variables. The evidence never records the
host, user, password-file path, password, or exported snapshot identity.

## Create and independently verify

Run from the repository root with the pinned Bun runtime and approved
PostgreSQL client tools on `PATH`:

```sh
bun run --cwd packages/server db:backup-recovery create \
  --database=APPROVED_SOURCE_DATABASE \
  --release-sha=FULL_40_CHARACTER_RELEASE_SHA \
  --boundary-id=APPROVED_NON_SECRET_BOUNDARY_ID \
  --destination-container=/approved/new/hyperia-backup-container \
  --query-timeout-ms=60000 \
  --dump-timeout-ms=3600000
```

Creation publishes only after two archive checks and an atomic same-filesystem
rename. The container is mode `0700`; `active/hyperia-postgres.dump` and
`active/evidence.json` are mode `0600`. Creation refuses overwrite and removes
its entire owned destination after any error.

From an independent approved host or process, run:

```sh
bun run --cwd packages/server db:backup-recovery verify \
  --database=APPROVED_SOURCE_DATABASE \
  --release-sha=FULL_40_CHARACTER_RELEASE_SHA \
  --boundary-id=APPROVED_NON_SECRET_BOUNDARY_ID \
  --backup-root=/approved/new/hyperia-backup-container/active \
  --tool-timeout-ms=60000
```

Retain the command output, both files' SHA-256 values, PostgreSQL tool versions,
storage identity, timestamps, and operator/witness identities in the protected
change record. Do not modify, rename, or add files inside the published
container.

## Isolated restore rehearsal

1. Create a new empty database with no application writers and an explicitly
   approved PostgreSQL server version. Never restore over production or the only
   surviving copy.
2. Independently verify the source backup again.
3. Restore with the approved target credentials:

```sh
pg_restore \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  --dbname=APPROVED_EMPTY_RECOVERY_DATABASE \
  /approved/new/hyperia-backup-container/active/hyperia-postgres.dump
```

4. Point the exact single-entry `PGPASSFILE` and `PGDATABASE` at the recovery
   database, then verify the restored state:

```sh
bun run --cwd packages/server db:backup-recovery verify-restored \
  --source-database=APPROVED_SOURCE_DATABASE \
  --restored-database=APPROVED_EMPTY_RECOVERY_DATABASE \
  --release-sha=FULL_40_CHARACTER_RELEASE_SHA \
  --boundary-id=APPROVED_NON_SECRET_BOUNDARY_ID \
  --backup-root=/approved/new/hyperia-backup-container/active \
  --approved-target-server-version-num=APPROVED_SERVER_VERSION_NUM \
  --query-timeout-ms=60000 \
  --tool-timeout-ms=60000
```

The verifier runs in a repeatable-read, read-only transaction. It requires the
same PostgreSQL major version, the exact approved target server version, source
encoding, complete Drizzle journal, public schema fingerprint and object
counts, the exact 58-table recovery inventory, every table's row count, and a
deterministic SHA-256 over every canonical row in every recovery table. Its
result is explicitly scoped to `isolated_postgres_restore_only` and reports
`activationRequiresSeparateApproval=true`.

Create a retained private certificate from a fresh verification, then have the
independent verifier rerun the database inspection against that exact file:

```sh
bun run --cwd packages/server db:restore-recovery-evidence create \
  --source-database=APPROVED_SOURCE_DATABASE \
  --restored-database=APPROVED_EMPTY_RECOVERY_DATABASE \
  --release-sha=FULL_40_CHARACTER_RELEASE_SHA \
  --boundary-id=APPROVED_NON_SECRET_BOUNDARY_ID \
  --backup-root=/approved/new/hyperia-backup-container/active \
  --restore-evidence=/approved/new/rehearsal/hyperia-postgres-restore-evidence.json \
  --approved-target-server-version-num=APPROVED_SERVER_VERSION_NUM \
  --query-timeout-ms=60000 \
  --tool-timeout-ms=60000

bun run --cwd packages/server db:restore-recovery-evidence verify \
  --source-database=APPROVED_SOURCE_DATABASE \
  --restored-database=APPROVED_EMPTY_RECOVERY_DATABASE \
  --release-sha=FULL_40_CHARACTER_RELEASE_SHA \
  --boundary-id=APPROVED_NON_SECRET_BOUNDARY_ID \
  --backup-root=/approved/new/hyperia-backup-container/active \
  --restore-evidence=/approved/new/rehearsal/hyperia-postgres-restore-evidence.json \
  --approved-target-server-version-num=APPROVED_SERVER_VERSION_NUM \
  --query-timeout-ms=60000 \
  --tool-timeout-ms=60000
```

The certificate is a new mode-0600 file under a mode-0700 parent, binds both
source files and the complete restored-state digest, retains no connection
credential, and refuses overwrite. Its scope is
`isolated_postgres_restore_evidence_only`; it records
`productionCutoverAuthorized=false` and is never cutover authority.

5. Before starting any restored process, qualify the exact production recent-
   duel hydrator and public history sanitizer against the restored database:

```sh
bun run --cwd packages/server db:restored-duel-application-readiness create \
  --source-database=APPROVED_SOURCE_DATABASE \
  --restored-database=APPROVED_EMPTY_RECOVERY_DATABASE \
  --release-sha=FULL_40_CHARACTER_RELEASE_SHA \
  --boundary-id=APPROVED_NON_SECRET_BOUNDARY_ID \
  --backup-root=/approved/new/hyperia-backup-container/active \
  --restore-evidence=/approved/new/rehearsal/hyperia-postgres-restore-evidence.json \
  --application-readiness=/approved/new/rehearsal/hyperia-restored-duel-application-readiness.json \
  --approved-target-server-version-num=APPROVED_SERVER_VERSION_NUM \
  --query-timeout-ms=60000 \
  --tool-timeout-ms=60000

bun run --cwd packages/server db:restored-duel-application-readiness verify \
  --source-database=APPROVED_SOURCE_DATABASE \
  --restored-database=APPROVED_EMPTY_RECOVERY_DATABASE \
  --release-sha=FULL_40_CHARACTER_RELEASE_SHA \
  --boundary-id=APPROVED_NON_SECRET_BOUNDARY_ID \
  --backup-root=/approved/new/hyperia-backup-container/active \
  --restore-evidence=/approved/new/rehearsal/hyperia-postgres-restore-evidence.json \
  --application-readiness=/approved/new/rehearsal/hyperia-restored-duel-application-readiness.json \
  --approved-target-server-version-num=APPROVED_SERVER_VERSION_NUM \
  --query-timeout-ms=60000 \
  --tool-timeout-ms=60000
```

The command re-verifies the full restore certificate, invokes the production
`MatchmakingManager` database hydration and public recent-duel sanitizer
twice inside repeatable-read/read-only UTC transactions, and binds the
bounded 200-entry route projection plus its authoritative competitive subset
to canonical SHA-256 digests. The certificate also carries the exact sorted,
bounded competitive fact list (cycle/duel identity, participants, public
outcome, winner/reason, and terminal time), so a downstream verifier can
independently recompute the subset digest and compare every projected fact to
the restored terminal authority. It requires one exact mode-0600 `PGPASSFILE`,
writes one no-overwrite mode-0600 certificate, retains no credential, and
records `restored_hyperia_application_read_projection_only`,
`databaseMutationAuthorized=false`,
`activationRequiresSeparateApproval=true`, and
`productionCutoverAuthorized=false`. This proves the restored public-history
read projection, not complete server startup, writer compatibility, or
cutover readiness.

6. Build and start the exact approved production server artifact against the
   isolated target with migrations, scheduler/capture authority, agents, oracle
   publication, web3, external-value actions, and alert delivery disabled. The
   server must use the approved Node runtime and the already certified restored
   database. Require bounded startup, `200` from `/status`, `/health`, and
   `/api/streaming/state`, the expected fail-closed `503` from
   `/api/streaming/health` while capture is deliberately disabled, and exact
   restored public history from
   `/api/streaming/leaderboard/details?historyLimit=200`. Shut it down through
   `SIGTERM` and require exit code zero.

   Startup is not read-only: the authority boot path advances the durable
   betting-source epoch once and acquires/releases its named scheduler lease.
   Those are the only permitted table changes in the isolated qualification.
   Compare every table before and after startup and fail on any other mutation.
   Do not delete, rewind, or otherwise "clean up" these monotonic records on a
   real recovery candidate. The disposable engineering qualifier may restore
   only the exact seeded test epoch row and remove only its exact expired test
   lease, after which it must re-verify the complete 58-table restore and both
   recovery certificates.

7. Run the remaining approved settlement, agent-custody, Hyperbet-service, and
   performance checks against the isolated target.

8. Have the required second operator compare this result with the same-boundary
   Hyperbet recovery-set evidence. From the exact Hyperbet release, create and
   independently verify the `platform-recovery-set` manifest documented in
   `docs/runbooks/backup-restore-and-release-rollback.md`. That manifest binds
   both repositories' release identities and recovery artifacts to this same
   boundary. Record and review its timestamp skew; the tooling does not invent
   an acceptable skew threshold.

## Activation and rollback

No command in this runbook changes production routing or enables transaction,
duel, or market authority. Activation requires the separately approved cutover
procedure, complete reconciliation, current backups of both old and candidate
targets, monitoring and alert readiness, and named human approval. Keep the old
database immutable and recoverable until the approved rollback window closes.

On any verification, reconciliation, readiness, or cutover failure, leave all
authorities disabled, retain the failed evidence for incident review, and route
back only through the approved database rollback procedure. Never manually
complete a partial backup directory or edit its evidence to force acceptance.

## Owned-local engineering qualification

The repeatable local gate creates a fresh PostgreSQL 16 container, applies every
checked-in migration, seeds authoritative state, creates and independently
verifies a backup, restores into a second database, compares all schema and
table evidence, and exercises corruption and policy failures:

```sh
bun run --cwd packages/server db:test-backup-recovery
```

This disposable test is engineering evidence only. It is not the required
witnessed staging rehearsal, production-volume timing measurement, approved
RPO/RTO proof, encrypted-storage proof, or production cutover.

The same gate also builds the production server and starts it with the pinned
Node 22 runtime against the restored database. It proves the four bounded HTTP
responses, exact public-history projection, one source-epoch advance, one
released scheduler lease, graceful termination, exact expected mutation-table
set, targeted disposable-test cleanup, and full 58-table/certificate
reverification. This closes owned-local Hyperia production-server
startup/read-path compatibility for the restored schema. The cross-repository
platform qualifier separately proves the actual Hyperbet production read
service against an exact materialized Keeper copy. This command alone does not,
and neither proof closes production-volume behavior, finalized Solana
reconciliation, or production activation.
