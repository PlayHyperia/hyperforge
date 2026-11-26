-- Couple a successful depleting gathering reward to the node's canonical
-- wall-clock respawn deadline. A replacement server hydrates this state before
-- exposing the resource, so an already-paid node cannot silently reappear.

CREATE TABLE IF NOT EXISTS "gathering_resource_states" (
  "resource_id" text PRIMARY KEY NOT NULL,
  "operation_id" text NOT NULL,
  "depleted_at" bigint NOT NULL,
  "respawn_at" bigint NOT NULL,
  CONSTRAINT "gathering_resource_states_operation_id_operations_log_id_fk"
    FOREIGN KEY ("operation_id") REFERENCES "public"."operations_log"("id")
    ON DELETE RESTRICT,
  CONSTRAINT "gathering_resource_states_identity_check"
    CHECK (
      length("resource_id") BETWEEN 1 AND 256
      AND length("operation_id") BETWEEN 1 AND 256
    ),
  CONSTRAINT "gathering_resource_states_deadline_check"
    CHECK (
      "depleted_at" >= 0
      AND "respawn_at" > "depleted_at"
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gathering_resource_states_operation_unique"
  ON "gathering_resource_states" USING btree ("operation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gathering_resource_states_respawn"
  ON "gathering_resource_states" USING btree ("respawn_at");
