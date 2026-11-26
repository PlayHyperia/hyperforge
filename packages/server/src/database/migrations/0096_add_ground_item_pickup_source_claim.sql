-- A pickup receipt is the permanent ownership claim for one exact ground
-- source occurrence. Enforce that invariant in PostgreSQL as a final fence
-- behind the application advisory lock and make claim lookups index-backed.

CREATE UNIQUE INDEX IF NOT EXISTS "uidx_operations_log_ground_item_pickup_source"
  ON "public"."operations_log" USING btree (
    (("operationState"->>'sourceEntityId'))
  )
  WHERE "operationType" = 'ground_item_pickup' AND "completed" = true;
