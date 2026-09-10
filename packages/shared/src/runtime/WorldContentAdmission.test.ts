import { describe, expect, it } from "vitest";
import { WorldContentAdmission } from "./WorldContentAdmission";

// Public, synthetic content digests; not credentials or an admission bypass.
const LOCAL_IDENTITY = "a".repeat(64);
const DIFFERENT_IDENTITY = "b".repeat(64);

function pendingAdmission() {
  const admission = new WorldContentAdmission(() => LOCAL_IDENTITY);
  admission.beginConnection();
  return admission;
}

describe("WorldContentAdmission", () => {
  it("exposes only the exact currently admitted digest across transport lifecycles", () => {
    const admission = pendingAdmission();
    expect(admission.admittedIdentity).toBeNull();
    admission.admitSnapshot(LOCAL_IDENTITY);
    expect(admission.admittedIdentity).toBe(LOCAL_IDENTITY);
    admission.close();
    expect(admission.admittedIdentity).toBeNull();
    admission.beginConnection();
    expect(admission.admittedIdentity).toBeNull();
    admission.admitSnapshot(LOCAL_IDENTITY);
    expect(admission.admittedIdentity).toBe(LOCAL_IDENTITY);
    admission.beginConnection();
    expect(admission.admittedIdentity).toBeNull();
    admission.admitSnapshot(DIFFERENT_IDENTITY);
    expect(admission.admittedIdentity).toBeNull();
    admission.admitSnapshot(LOCAL_IDENTITY);
    expect(admission.admittedIdentity).toBeNull();
  });
  it("starts closed, independent of transport authentication", () => {
    const admission = new WorldContentAdmission(() => LOCAL_IDENTITY);
    expect(admission.admitted).toBe(false);
    expect(admission.allowsPacket("onSnapshot")).toBe(false);
    expect(admission.admitSnapshot(LOCAL_IDENTITY)).toBeNull();
  });

  it("permits only admission control before a validated snapshot", () => {
    const admission = pendingAdmission();
    for (const method of [
      "snapshot",
      "onSnapshot",
      "authResult",
      "onAuthResult",
    ]) {
      expect(admission.allowsPacket(method)).toBe(true);
    }
    for (const method of [
      "onEntityAdded",
      "onEntitiesBatchAdded",
      "onEntityModified",
      "onEnterWorldApproved",
      "onCharacterList",
      "onSettingsModified",
      "onChatAdded",
    ]) {
      expect(admission.allowsPacket(method)).toBe(false);
    }
    expect(admission.admitted).toBe(false);
  });

  it("admits exact content equality and allows world packets", () => {
    const admission = pendingAdmission();
    const generation = admission.admitSnapshot(LOCAL_IDENTITY);
    expect(generation).not.toBeNull();
    expect(admission.admitted).toBe(true);
    expect(admission.failure).toBeNull();
    expect(admission.isCurrent(generation!)).toBe(true);
    expect(admission.allowsPacket("onEntityAdded")).toBe(true);
  });

  it.each([
    undefined,
    null,
    123,
    {},
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    `${LOCAL_IDENTITY}\n`,
    ` ${LOCAL_IDENTITY}`,
  ])("rejects a missing or noncanonical remote digest (%j)", (value) => {
    const admission = pendingAdmission();
    expect(admission.admitSnapshot(value)).toBeNull();
    expect(admission.rejected).toBe(true);
    expect(admission.admitted).toBe(false);
    expect(admission.failure).toContain("missing or invalid");
    expect(admission.allowsPacket("onSnapshot")).toBe(false);
    expect(admission.allowsPacket("onEntityAdded")).toBe(false);
  });

  it("rejects a malformed local digest even when the remote matches it", () => {
    const admission = new WorldContentAdmission(() => "not-a-content-digest");
    admission.beginConnection();
    expect(admission.admitSnapshot("not-a-content-digest")).toBeNull();
    expect(admission.rejected).toBe(true);
  });

  it("fails closed if local manifests are unready or invalidated", () => {
    const admission = new WorldContentAdmission(() => {
      throw new Error("World content identity is not initialized");
    });
    admission.beginConnection();
    expect(admission.admitSnapshot(LOCAL_IDENTITY)).toBeNull();
    expect(admission.rejected).toBe(true);
    expect(admission.failure).toContain("not ready");
  });

  it("latches a mismatch even if a matching snapshot follows on the same transport", () => {
    const admission = pendingAdmission();
    expect(admission.admitSnapshot(DIFFERENT_IDENTITY)).toBeNull();
    const failure = admission.failure;
    expect(admission.admitSnapshot(LOCAL_IDENTITY)).toBeNull();
    admission.close();
    expect(admission.admitSnapshot(LOCAL_IDENTITY)).toBeNull();
    expect(admission.failure).toBe(failure);
    expect(admission.rejected).toBe(true);
  });

  it("requires a fresh matching admission to clear a previous failure", () => {
    const admission = pendingAdmission();
    admission.admitSnapshot(DIFFERENT_IDENTITY);
    const failure = admission.failure;
    admission.beginConnection();
    expect(admission.admitted).toBe(false);
    expect(admission.failure).toBe(failure);
    expect(admission.allowsPacket("onEntityAdded")).toBe(false);
    expect(admission.admitSnapshot(LOCAL_IDENTITY)).not.toBeNull();
    expect(admission.failure).toBeNull();
  });

  it("revokes delayed work on close and on a newly admitted transport", () => {
    const admission = pendingAdmission();
    const first = admission.admitSnapshot(LOCAL_IDENTITY)!;
    admission.close();
    expect(admission.isCurrent(first)).toBe(false);
    expect(admission.allowsPacket("onSnapshot")).toBe(false);
    admission.beginConnection();
    const second = admission.admitSnapshot(LOCAL_IDENTITY)!;
    expect(second).not.toBe(first);
    expect(admission.isCurrent(first)).toBe(false);
    expect(admission.isCurrent(second)).toBe(true);
  });

  it("rechecks locally loaded content on every snapshot", () => {
    let identity = LOCAL_IDENTITY;
    const admission = new WorldContentAdmission(() => identity);
    admission.beginConnection();
    const initial = admission.admitSnapshot(LOCAL_IDENTITY)!;
    identity = DIFFERENT_IDENTITY;
    expect(admission.admitSnapshot(LOCAL_IDENTITY)).toBeNull();
    expect(admission.isCurrent(initial)).toBe(false);
    expect(admission.admitted).toBe(false);
  });

  it("does not replace the original failure reason with a later rejection", () => {
    const admission = pendingAdmission();
    admission.reject("First admission failure");
    admission.reject("Later packet failure");
    expect(admission.failure).toBe("First admission failure");
  });
});
