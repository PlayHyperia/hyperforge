import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyMemoryProcess,
  isSteadyStateMemorySample,
} from "./lib/memory-leak-analysis.mjs";

test("classifies the production server wrapper separately from launch orchestration", () => {
  assert.equal(
    classifyMemoryProcess(
      "node --import ./scripts/register-hooks.mjs ../../scripts/start-hyperia-server.mjs",
    ),
    "server",
  );
  assert.equal(
    classifyMemoryProcess("bun scripts/duel-stack.mjs --local-smoke"),
    "other",
  );
  assert.equal(
    classifyMemoryProcess(
      "node packages/client/node_modules/.bin/vite preview",
    ),
    "client",
  );
});

test("accepts only ready samples containing the actual server process", () => {
  const ready = {
    processes: [{ role: "server" }, { role: "client" }],
    streaming: { metrics: { replaySize: 1 } },
  };
  assert.equal(isSteadyStateMemorySample(ready), true);
  assert.equal(isSteadyStateMemorySample({ ...ready, streaming: null }), false);
  assert.equal(
    isSteadyStateMemorySample({
      ...ready,
      processes: [{ role: "client" }],
    }),
    false,
  );
});
