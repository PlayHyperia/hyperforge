import assert from "node:assert/strict";
import test from "node:test";

import { accumulateFightingObservation } from "./duel-fighting-observation.mjs";

const initial = () => ({ totalMs: 0, previous: null });
const sample = (cycleId, observedAt) => ({ cycleId, observedAt });

test("accumulates adjacent accepted samples in one fight", () => {
  let tracker = accumulateFightingObservation(
    initial(),
    sample("cycle-a", 1_000),
  );
  tracker = accumulateFightingObservation(tracker, sample("cycle-a", 1_125));
  tracker = accumulateFightingObservation(tracker, sample("cycle-a", 1_250));

  assert.equal(tracker.totalMs, 250);
  assert.equal(tracker.acceptedIntervalMs, 125);
});

test("does not count the phase gap between duel cycles", () => {
  let tracker = accumulateFightingObservation(
    initial(),
    sample("cycle-a", 1_000),
  );
  tracker = accumulateFightingObservation(tracker, sample("cycle-a", 2_000));
  tracker = accumulateFightingObservation(tracker, sample("cycle-b", 20_000));
  tracker = accumulateFightingObservation(tracker, sample("cycle-b", 20_125));

  assert.equal(tracker.totalMs, 1_125);
});

test("does not count a long probe outage inside one fight", () => {
  let tracker = accumulateFightingObservation(
    initial(),
    sample("cycle-a", 1_000),
  );
  tracker = accumulateFightingObservation(tracker, sample("cycle-a", 1_125));
  tracker = accumulateFightingObservation(tracker, sample("cycle-a", 9_000));

  assert.equal(tracker.totalMs, 125);
  assert.equal(tracker.acceptedIntervalMs, 0);
});

test("rejects malformed tracker and sample state", () => {
  assert.throws(
    () => accumulateFightingObservation(initial(), sample("", 1_000)),
    /finite and valid/u,
  );
  assert.throws(
    () =>
      accumulateFightingObservation(
        { totalMs: Number.NaN, previous: null },
        sample("cycle-a", 1_000),
      ),
    /finite and valid/u,
  );
});
