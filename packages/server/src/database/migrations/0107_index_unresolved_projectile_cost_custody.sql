-- Readiness polls only nonterminal ammunition/rune custody. Keep that global
-- aggregate bounded as the append-only operations ledger grows.

CREATE INDEX IF NOT EXISTS "idx_operations_log_projectile_cost_custody_unresolved"
ON "operations_log" USING btree ("operationType", "timestamp")
WHERE "operationType" IN ('ammunition_shot', 'projectile_rune_cost')
  AND (
    "completed" = false
    OR "operationState"->>'status' IN ('pending', 'fired')
  );
