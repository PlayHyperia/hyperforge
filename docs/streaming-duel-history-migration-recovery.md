# Streaming duel history migration and recovery

This runbook covers migrations `0052`, `0055`, and `0058` for
`streaming_duel_history`. The production strategy is forward-only at the
database layer: roll back the application while retaining the additive schema,
then restore data from a verified backup if data recovery is required. Do not
drop the outcome, participant, damage, or cancellation columns during an
incident; that would destroy draw/cancellation evidence.

## Safety boundary

- Put the scheduler in maintenance or disable streaming duels before the
  migration window. Allow any active sporting result and persistence write to
  finish before stopping writers.
- Record the application SHA, database server/version, migration journal,
  database name, table row count, minimum/maximum `finishedAt`, and backup
  checksum in the incident/change record.
- Take the full, release-bound custom-format PostgreSQL backup required by
  [`hyperia-postgres-backup-recovery.md`](./hyperia-postgres-backup-recovery.md).
  Its evidence includes `streaming_duel_history` and every other public table;
  a detached table-only dump is not the authoritative recovery point.
- Restore into a separate recovery database first. Never test a restore by
  overwriting the only production copy.

Use the canonical create and independent-verify commands in the full recovery
runbook. They reject password-bearing URLs and aliases, bind the archive and TOC
to the exact release/boundary/schema/migration journal, and refuse overwrite.

## Migration verification

Run the reusable verifier only against a newly created, empty disposable
database whose name begins with `hyperia_streaming_history_verify_`:

```sh
STREAMING_MIGRATION_VERIFY_DATABASE_URL='postgresql://USER@HOST:PORT/hyperia_streaming_history_verify_CHANGE_ID' \
STREAMING_MIGRATION_VERIFY_ALLOW_RESET=true \
bun run --cwd packages/server db:verify-streaming-history-migration
```

The verifier fails if the database contains any public table. It applies the
legacy schema, migrates a legacy win, writes a draw, replays the cancellation
migration twice, writes a cancellation, and simulates a pre-draw application
binary writing after the new schema is present. It then truncates and restores
the table inside the disposable database and proves exact row equality and a
stable SHA-256 fingerprint.

## Application rollback

1. Disable new streaming duel cycles and wait for the active write to settle.
2. Preserve the migrated schema. The new columns are additive, defaulted, or
   nullable, so the original winner/loser-only insert remains accepted.
3. Deploy the previously approved application artifact with streaming duels
   still disabled. Do not let an older binary create new product outcomes whose
   draw/cancellation policy it does not understand.
4. Check database connectivity, read-only game health, row-count invariants,
   and logs. If the rollback is stable, either keep streaming duels disabled or
   return to a forward-fixed artifact before resuming cycles.
5. The current reader reconstructs a rollback writer's missing participant and
   damage columns from the original winner/loser fields, so those rows remain
   visible after the forward fix is restored.

## Data recovery

1. Stop all history writers and capture a second forensic backup of the current
   state before changing anything.
2. Create a separate recovery database with the same PostgreSQL major version.
3. Restore the approved full backup into that database with `pg_restore`, then
   run the canonical `verify-restored` command before the history-specific
   outcome counts, nullability checks, and timestamp bounds. Create and
   independently verify both the restore certificate and the
   `db:restored-duel-application-readiness` certificate from
   [`hyperia-postgres-backup-recovery.md`](./hyperia-postgres-backup-recovery.md)
   before any application startup. The latter runs the production recent-duel
   hydrator and public-history sanitizer twice against the isolated database,
   retains the exact bounded competitive public facts for independent digest
   and restored-terminal comparison, and does not authorize writers or
   cutover. Do not apply migrations on top of
   an archive whose checked-in migration journal does not already match.
4. Build and start the exact approved production server artifact against the
   isolated database with migrations and all scheduler, capture, agent, oracle,
   web3, external-value, and alert-delivery authorities disabled. Require
   bounded healthy startup, exact restored public history, the expected
   capture-disabled streaming-health response, and graceful termination. The
   only accepted startup mutations are one monotonic betting-source-epoch
   advance and the exact named scheduler lease lifecycle. Do not rewind or
   delete those records on a real recovery candidate; the disposable local
   qualifier's targeted cleanup is test-fixture behavior only.
5. Compare the restored artifact checksum and database evidence with the change
   record. Have a second operator approve the recovery target and evidence.
6. Promote the recovered database using the infrastructure's approved database
   cutover procedure. Keep streaming duels disabled until the public history,
   authenticated monitor, and scheduler startup load all agree.

This local verifier proves migration semantics, legacy-writer compatibility,
exact table-data restoration, and the restored production Hyperia server's
bounded startup/read-path compatibility. The cross-repository owned-local
recovery qualification separately proves the actual Hyperbet production read
service against the exact materialized Keeper state. Finalized Solana
reconciliation, a production-volume anonymized copy, external backup/restore
rehearsal, measured timing, and two-person staging cutover remain required
before this runbook can be signed off for launch.
