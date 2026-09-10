-- Ground-source presentation is reconstructed from this durable registry.
-- Contributions are immutable idempotency identities, including stack merges.

CREATE TABLE IF NOT EXISTS "ground_item_sources" (
  "source_id" text PRIMARY KEY NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "item_id" text NOT NULL,
  "quantity" integer NOT NULL,
  "stackable" boolean NOT NULL,
  "position_x" double precision NOT NULL,
  "position_y" double precision NOT NULL,
  "position_z" double precision NOT NULL,
  "tile_x" integer NOT NULL,
  "tile_z" integer NOT NULL,
  "dropped_by" text,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "expires_at" bigint NOT NULL,
  "loot_protection_expires_at" bigint,
  "claimed_by_operation_id" text,
  "claimed_by_player_id" text,
  "claimed_at" bigint,
  "version" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "ground_item_sources_identity_check" CHECK (
    "source_id" ~ '^ground_item_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND length("item_id") BETWEEN 1 AND 256
    AND ("dropped_by" IS NULL OR length("dropped_by") BETWEEN 1 AND 128)
  ),
  CONSTRAINT "ground_item_sources_status_check" CHECK (
    "status" IN ('active', 'claimed', 'expired')
  ),
  CONSTRAINT "ground_item_sources_quantity_check" CHECK (
    "quantity" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT "ground_item_sources_position_check" CHECK (
    "position_x" > '-Infinity'::double precision
    AND "position_x" < 'Infinity'::double precision
    AND "position_y" > '-Infinity'::double precision
    AND "position_y" < 'Infinity'::double precision
    AND "position_z" > '-Infinity'::double precision
    AND "position_z" < 'Infinity'::double precision
  ),
  CONSTRAINT "ground_item_sources_lifetime_check" CHECK (
    "created_at" >= 0
    AND "updated_at" >= "created_at"
    AND "expires_at" > "created_at"
    AND (
      "loot_protection_expires_at" IS NULL
      OR "loot_protection_expires_at" BETWEEN "created_at" AND "expires_at"
    )
  ),
  CONSTRAINT "ground_item_sources_claim_check" CHECK (
    (
      "status" = 'claimed'
      AND "claimed_by_operation_id" IS NOT NULL
      AND "claimed_by_player_id" IS NOT NULL
      AND "claimed_at" IS NOT NULL
    ) OR (
      "status" <> 'claimed'
      AND "claimed_by_operation_id" IS NULL
      AND "claimed_by_player_id" IS NULL
      AND "claimed_at" IS NULL
    )
  ),
  CONSTRAINT "ground_item_sources_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uidx_ground_item_sources_claimed_operation"
  ON "ground_item_sources" ("claimed_by_operation_id")
  WHERE "claimed_by_operation_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ground_item_sources_active_expiry"
  ON "ground_item_sources" ("status", "expires_at", "source_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ground_item_sources_active_merge"
  ON "ground_item_sources" (
    "status", "tile_x", "tile_z", "item_id", "dropped_by", "expires_at"
  );
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "ground_item_source_contributions" (
  "contribution_id" text PRIMARY KEY NOT NULL,
  "source_id" text NOT NULL,
  "request_fingerprint" text NOT NULL,
  "item_id" text NOT NULL,
  "quantity" integer NOT NULL,
  "contributed_at" bigint NOT NULL,
  CONSTRAINT "ground_item_source_contributions_source_fk"
    FOREIGN KEY ("source_id") REFERENCES "ground_item_sources"("source_id")
    ON DELETE RESTRICT,
  CONSTRAINT "ground_item_source_contributions_identity_check" CHECK (
    "contribution_id" ~ '^ground-item-source:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "request_fingerprint" ~ '^[0-9a-f]{64}$'
    AND length("item_id") BETWEEN 1 AND 256
  ),
  CONSTRAINT "ground_item_source_contributions_quantity_check" CHECK (
    "quantity" BETWEEN 1 AND 2147483647
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ground_item_source_contributions_source"
  ON "ground_item_source_contributions" (
    "source_id", "contributed_at", "contribution_id"
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_ground_item_source_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  claim_record record;
  database_now bigint;
BEGIN
  IF OLD.status <> 'active' THEN
    RAISE EXCEPTION 'terminal ground item source is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.source_id <> OLD.source_id
    OR NEW.item_id <> OLD.item_id
    OR NEW.stackable <> OLD.stackable
    OR NEW.position_x <> OLD.position_x
    OR NEW.position_y <> OLD.position_y
    OR NEW.position_z <> OLD.position_z
    OR NEW.tile_x <> OLD.tile_x
    OR NEW.tile_z <> OLD.tile_z
    OR NEW.dropped_by IS DISTINCT FROM OLD.dropped_by
    OR NEW.created_at <> OLD.created_at
    OR NEW.quantity < OLD.quantity
    OR NEW.expires_at < OLD.expires_at
    OR (
      OLD.loot_protection_expires_at IS NOT NULL
      AND (
        NEW.loot_protection_expires_at IS NULL
        OR NEW.loot_protection_expires_at < OLD.loot_protection_expires_at
      )
    )
    OR NEW.updated_at < OLD.updated_at
    OR NEW.version <> OLD.version + 1
  THEN
    RAISE EXCEPTION 'invalid ground item source mutation' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'active' THEN
    IF NEW.claimed_by_operation_id IS NOT NULL
      OR NEW.claimed_by_player_id IS NOT NULL
      OR NEW.claimed_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'active ground item source cannot carry a claim'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.quantity <> OLD.quantity
    OR NEW.expires_at <> OLD.expires_at
    OR NEW.loot_protection_expires_at IS DISTINCT FROM OLD.loot_protection_expires_at
  THEN
    RAISE EXCEPTION 'terminal ground item source cannot change custody payload'
      USING ERRCODE = '23514';
  END IF;
  database_now := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
  IF NEW.status = 'expired' THEN
    IF NEW.expires_at > database_now THEN
      RAISE EXCEPTION 'ground item source cannot expire before its deadline'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT
    operation."playerId" AS player_id,
    operation."operationType" AS operation_type,
    operation."operationState" AS operation_state,
    operation.completed,
    operation."completedAt" AS completed_at
  INTO claim_record
  FROM "operations_log" AS operation
  WHERE operation.id = NEW.claimed_by_operation_id;
  IF NOT FOUND
    OR claim_record.player_id <> NEW.claimed_by_player_id
    OR claim_record.operation_type <> 'ground_item_pickup'
    OR claim_record.completed IS DISTINCT FROM true
    OR claim_record.operation_state->>'sourceEntityId' <> NEW.source_id
    OR claim_record.operation_state->>'itemId' <> NEW.item_id
    OR (claim_record.operation_state->>'quantity')::integer <> NEW.quantity
    OR claim_record.completed_at <> NEW.claimed_at
  THEN
    RAISE EXCEPTION 'ground item source claim has no exact pickup receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ground_item_sources_validate_update" ON "ground_item_sources";
--> statement-breakpoint
CREATE TRIGGER "ground_item_sources_validate_update"
  BEFORE UPDATE ON "ground_item_sources"
  FOR EACH ROW EXECUTE FUNCTION validate_ground_item_source_update();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_ground_item_source_delete_or_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ground item source history is append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ground_item_sources_reject_delete" ON "ground_item_sources";
--> statement-breakpoint
CREATE TRIGGER "ground_item_sources_reject_delete"
  BEFORE DELETE ON "ground_item_sources"
  FOR EACH ROW EXECUTE FUNCTION reject_ground_item_source_delete_or_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ground_item_sources_reject_truncate" ON "ground_item_sources";
--> statement-breakpoint
CREATE TRIGGER "ground_item_sources_reject_truncate"
  BEFORE TRUNCATE ON "ground_item_sources"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_ground_item_source_delete_or_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ground_item_source_contributions_reject_mutation"
  ON "ground_item_source_contributions";
--> statement-breakpoint
CREATE TRIGGER "ground_item_source_contributions_reject_mutation"
  BEFORE UPDATE OR DELETE ON "ground_item_source_contributions"
  FOR EACH ROW EXECUTE FUNCTION reject_ground_item_source_delete_or_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "ground_item_source_contributions_reject_truncate"
  ON "ground_item_source_contributions";
--> statement-breakpoint
CREATE TRIGGER "ground_item_source_contributions_reject_truncate"
  BEFORE TRUNCATE ON "ground_item_source_contributions"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_ground_item_source_delete_or_truncate();
