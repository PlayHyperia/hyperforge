-- Firemaking inventory/XP custody and its world effect must survive the same
-- process failures. Rows remain as receipts after expiry; active queries are
-- bounded by authoritative expiry/extinguish timestamps.
CREATE TABLE IF NOT EXISTS "processing_active_fires" (
  "fire_id" text PRIMARY KEY NOT NULL,
  "operation_id" text NOT NULL,
  "player_id" text NOT NULL,
  "position_x" double precision NOT NULL,
  "position_y" double precision NOT NULL,
  "position_z" double precision NOT NULL,
  "tile_x" integer NOT NULL,
  "tile_z" integer NOT NULL,
  "created_at" bigint NOT NULL,
  "expires_at" bigint NOT NULL,
  "extinguished_at" bigint,
  CONSTRAINT "processing_active_fires_operation_unique" UNIQUE("operation_id"),
  CONSTRAINT "processing_active_fires_lifetime_valid"
    CHECK ("created_at" > 0 AND "expires_at" > "created_at"),
  CONSTRAINT "processing_active_fires_extinguish_valid"
    CHECK ("extinguished_at" IS NULL OR "extinguished_at" >= "created_at"),
  CONSTRAINT "processing_active_fires_operation_id_operations_log_id_fk"
    FOREIGN KEY ("operation_id") REFERENCES "operations_log"("id")
    ON DELETE CASCADE,
  CONSTRAINT "processing_active_fires_player_id_characters_id_fk"
    FOREIGN KEY ("player_id") REFERENCES "characters"("id")
    ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_processing_active_fires_expiry"
  ON "processing_active_fires" ("extinguished_at", "expires_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_processing_active_fires_tile"
  ON "processing_active_fires"
  ("tile_x", "tile_z", "extinguished_at", "expires_at");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "processing_active_fires_active_tile_unique"
  ON "processing_active_fires" ("tile_x", "tile_z")
  WHERE "extinguished_at" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_processing_active_fires_player"
  ON "processing_active_fires"
  ("player_id", "extinguished_at", "expires_at");
