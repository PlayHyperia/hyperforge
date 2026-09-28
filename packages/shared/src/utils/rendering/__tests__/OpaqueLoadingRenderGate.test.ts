import { describe, expect, it } from "vitest";
import { OpaqueLoadingRenderGate } from "../OpaqueLoadingRenderGate";

/** Exercise the real CPU ownership state machine, not a renderer substitute.
 * GPU execution, first-frame appearance and performance require native tests. */
function submit(gate: OpaqueLoadingRenderGate, frame: number | null): boolean {
  const ticket = gate.beginSubmission();
  if (ticket === null) return false;
  gate.completeSubmission(ticket, frame);
  return true;
}

describe("opaque loading ownership (actual CPU state machine)", () => {
  it("does not suppress rendering without an owner", () => {
    const gate = new OpaqueLoadingRenderGate(() => 0);
    expect(submit(gate, 1)).toBe(true);
    expect(submit(gate, null)).toBe(true);
    expect(gate.getStatus()).toMatchObject({
      state: "uncovered",
      skippedSubmissions: 0,
      successfulPrimarySubmissions: 1,
      successfulWarmFrames: 0,
    });
  });

  it("suppresses submissions only while the owner remains opaque", () => {
    const gate = new OpaqueLoadingRenderGate(() => 4);
    const lease = gate.acquire();
    expect(submit(gate, 5)).toBe(false);
    expect(submit(gate, null)).toBe(false);
    expect(lease.isWarm()).toBe(false);
    expect(gate.getStatus()).toMatchObject({
      state: "opaque",
      skippedSubmissions: 2,
      successfulPrimarySubmissions: 0,
    });
    lease.beginWarmup();
    expect(submit(gate, 5)).toBe(true);
    expect(gate.getStatus().state).toBe("warming");
  });

  it("requires two fresh distinct world frames after warmup begins", () => {
    let frame = 10;
    const gate = new OpaqueLoadingRenderGate(() => frame);
    const lease = gate.acquire();
    frame = 15;
    lease.beginWarmup();
    for (const stale of [0, 10, 14, 15]) submit(gate, stale);
    expect(gate.getStatus().successfulWarmFrames).toBe(0);
    submit(gate, 16);
    submit(gate, 16);
    expect(lease.isWarm()).toBe(false);
    expect(gate.getStatus().successfulWarmFrames).toBe(1);
    submit(gate, 17);
    expect(lease.isWarm()).toBe(true);
    expect(gate.getStatus().lastWarmFrame).toBe(17);
  });

  it("direct and resize submissions never acknowledge warmup", () => {
    const gate = new OpaqueLoadingRenderGate(() => 0);
    const lease = gate.acquire();
    lease.beginWarmup();
    for (let i = 0; i < 5; i++) expect(submit(gate, null)).toBe(true);
    expect(gate.getStatus().successfulWarmFrames).toBe(0);
    submit(gate, 1);
    submit(gate, null);
    expect(lease.isWarm()).toBe(false);
    submit(gate, 2);
    expect(lease.isWarm()).toBe(true);
  });

  it("does not count a submission that never completes successfully", () => {
    const gate = new OpaqueLoadingRenderGate(() => 0);
    const lease = gate.acquire();
    lease.beginWarmup();
    expect(gate.beginSubmission()).not.toBeNull();
    expect(gate.getStatus().successfulWarmFrames).toBe(0);
    submit(gate, 2);
    expect(lease.isWarm()).toBe(false);
    submit(gate, 3);
    expect(lease.isWarm()).toBe(true);
  });

  it("keeps beginWarmup idempotent during and after warming", () => {
    let frame = 0;
    const gate = new OpaqueLoadingRenderGate(() => frame);
    const lease = gate.acquire();
    lease.beginWarmup();
    const generation = gate.getStatus().generation;
    frame = 1;
    submit(gate, frame);
    lease.beginWarmup();
    expect(gate.getStatus().generation).toBe(generation);
    frame = 2;
    submit(gate, frame);
    lease.beginWarmup();
    expect(lease.isWarm()).toBe(true);
    expect(gate.getStatus().generation).toBe(generation);
    expect(submit(gate, 3)).toBe(true);
    expect(gate.getStatus().successfulWarmFrames).toBe(2);
  });

  it("replaces ownership without letting an old lease unblock it", () => {
    const gate = new OpaqueLoadingRenderGate(() => 0);
    const old = gate.acquire();
    old.beginWarmup();
    submit(gate, 1);
    submit(gate, 2);
    expect(old.isWarm()).toBe(true);
    const current = gate.acquire();
    expect(old.isWarm()).toBe(false);
    old.release();
    old.beginWarmup();
    expect(submit(gate, 3)).toBe(false);
    expect(current.isWarm()).toBe(false);
    current.beginWarmup();
    submit(gate, 3);
    submit(gate, 4);
    expect(current.isWarm()).toBe(true);
  });

  it("does not credit an in-flight ticket to a replacement owner", () => {
    const gate = new OpaqueLoadingRenderGate(() => 0);
    gate.acquire().beginWarmup();
    const ticket = gate.beginSubmission()!;
    const next = gate.acquire();
    next.beginWarmup();
    gate.completeSubmission(ticket, 1);
    expect(gate.getStatus().successfulWarmFrames).toBe(0);
    submit(gate, 2);
    expect(next.isWarm()).toBe(false);
    submit(gate, 3);
    expect(next.isWarm()).toBe(true);
  });

  it("invalidates warm frames while retaining permission to render", () => {
    let frame = 0;
    const gate = new OpaqueLoadingRenderGate(() => frame);
    const lease = gate.acquire();
    lease.beginWarmup();
    submit(gate, 1);
    submit(gate, 2);
    expect(lease.isWarm()).toBe(true);
    frame = 2;
    gate.invalidate();
    expect(lease.isWarm()).toBe(false);
    expect(gate.getStatus().lastWarmFrame).toBeNull();
    expect(submit(gate, frame)).toBe(true);
    expect(gate.getStatus().successfulWarmFrames).toBe(0);
    submit(gate, 3);
    submit(gate, 4);
    expect(lease.isWarm()).toBe(true);
  });

  it("does not credit a ticket invalidated during a render", () => {
    let frame = 0;
    const gate = new OpaqueLoadingRenderGate(() => frame);
    const lease = gate.acquire();
    lease.beginWarmup();
    const ticket = gate.beginSubmission()!;
    frame = 1;
    gate.invalidate();
    gate.completeSubmission(ticket, frame);
    expect(gate.getStatus().successfulWarmFrames).toBe(0);
    submit(gate, 2);
    expect(lease.isWarm()).toBe(false);
    submit(gate, 3);
    expect(lease.isWarm()).toBe(true);
  });

  it("cannot acknowledge frames while preparation repeatedly invalidates", () => {
    let frame = 0;
    const gate = new OpaqueLoadingRenderGate(() => frame);
    const lease = gate.acquire();
    lease.beginWarmup();
    for (frame = 1; frame < 5; frame++) {
      gate.invalidate();
      submit(gate, frame);
      expect(lease.isWarm()).toBe(false);
    }
    submit(gate, frame++);
    expect(lease.isWarm()).toBe(false);
    submit(gate, frame);
    expect(lease.isWarm()).toBe(true);
  });

  it("release is idempotent and cannot be reversed by that lease", () => {
    const gate = new OpaqueLoadingRenderGate(() => 0);
    const lease = gate.acquire();
    lease.release();
    const generation = gate.getStatus().generation;
    lease.release();
    lease.beginWarmup();
    expect(lease.isWarm()).toBe(false);
    expect(gate.getStatus().generation).toBe(generation);
    expect(submit(gate, 1)).toBe(true);
    expect(gate.getStatus().state).toBe("uncovered");
  });

  it("ignores non-integer, non-finite and out-of-order frame credit", () => {
    const gate = new OpaqueLoadingRenderGate(() => 0);
    const lease = gate.acquire();
    lease.beginWarmup();
    for (const frame of [NaN, Infinity, -Infinity, 0.5, -1])
      submit(gate, frame);
    expect(gate.getStatus().successfulWarmFrames).toBe(0);
    submit(gate, 10);
    submit(gate, 9);
    expect(lease.isWarm()).toBe(false);
    submit(gate, 11);
    expect(lease.isWarm()).toBe(true);
  });

  it("returns detached diagnostics without leaking mutable ownership", () => {
    const gate = new OpaqueLoadingRenderGate(() => 0);
    const lease = gate.acquire();
    const before = gate.getStatus();
    lease.beginWarmup();
    submit(gate, 1);
    expect(before.state).toBe("opaque");
    expect(before.successfulWarmFrames).toBe(0);
    expect(gate.getStatus().successfulWarmFrames).toBe(1);
    expect(Object.isFrozen(lease)).toBe(true);
  });

  it("destroy cancels outstanding ownership and tickets permanently", () => {
    const gate = new OpaqueLoadingRenderGate(() => 0);
    const lease = gate.acquire();
    lease.beginWarmup();
    const ticket = gate.beginSubmission()!;
    gate.destroy();
    const generation = gate.getStatus().generation;
    lease.release();
    lease.beginWarmup();
    gate.completeSubmission(ticket, 1);
    gate.destroy();
    expect(lease.isWarm()).toBe(false);
    expect(gate.beginSubmission()).toBeNull();
    expect(gate.getStatus()).toMatchObject({
      state: "destroyed",
      generation,
      successfulWarmFrames: 0,
      successfulPrimarySubmissions: 0,
    });
    expect(() => gate.acquire()).toThrow("after destruction");
  });
});
