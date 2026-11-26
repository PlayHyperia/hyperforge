import { afterEach, describe, expect, it, vi } from "vitest";

import { Collider } from "../Collider";
import { RigidBody } from "../RigidBody";

describe("physicsless scene nodes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps stream colliders dormant instead of rebuilding and warning forever", () => {
    vi.stubGlobal("PHYSX", undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const collider = new Collider();
    collider.ctx = {} as never;

    collider.mount();
    collider.commit(false);
    collider.commit(false);

    expect(collider.needsRebuild).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps stream rigid bodies dormant without probing the missing runtime", () => {
    vi.stubGlobal("PHYSX", undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rigidBody = new RigidBody();
    rigidBody.ctx = {} as never;

    rigidBody.mount();
    rigidBody.commit(false);

    expect(rigidBody.needsRebuild).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
