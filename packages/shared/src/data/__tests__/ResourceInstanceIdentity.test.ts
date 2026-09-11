import { describe, expect, it } from "vitest";
import { ALL_WORLD_AREAS } from "../world-areas";
import {
  validateAuthoredResourceIdentities,
  validateAuthoredTreeInstanceId,
} from "../ResourceInstanceIdentity";

describe("authored-only durable tree identities", () => {
  it("retains legacy coordinate-shaped identities only on authored trees", () => {
    for (const id of ["tree_367_311", "tree_-26_-26", "tree_0_0"])
      expect(validateAuthoredTreeInstanceId(id, "tree", true)).toBe(id);
    expect(
      validateAuthoredTreeInstanceId(undefined, "tree", false),
    ).toBeUndefined();
    expect(() =>
      validateAuthoredTreeInstanceId("tree_1_2", "tree", false),
    ).toThrow("only for authored trees");
    for (const type of ["ore", "fish", "rock", "herb"])
      expect(() =>
        validateAuthoredTreeInstanceId("tree_1_2", type, true),
      ).toThrow("only for authored trees");
  });

  it.each([
    null,
    123,
    "arbitrary-id",
    "tree_01_2",
    "tree_-0_2",
    "tree_1.5_2",
    "tree_1_2\n",
    "tree_9007199254740992_2",
  ])("rejects invalid ID %s without a coordinate fallback", (value) =>
    expect(() => validateAuthoredTreeInstanceId(value, "tree", true)).toThrow(
      "Invalid authored tree instanceId",
    ),
  );

  it("checks explicit/implicit collisions across different world-area groups before publication", () => {
    const source = ALL_WORLD_AREAS.central_haven;
    const original = source.resources!.find((row) => row.type === "tree")!;
    const first = {
      ...source,
      resources: [{ ...original, instanceId: "tree_11_21" }],
    };
    const second = {
      ...source,
      id: "other",
      resources: [
        {
          ...original,
          instanceId: undefined,
          position: { x: 10.5, y: 0, z: 20.5 },
        },
      ],
    };
    expect(() =>
      validateAuthoredResourceIdentities([{ first }, { second }]),
    ).toThrow("Duplicate authored tree identity: tree_11_21");
    second.resources[0].position.x = 11.5;
    expect(() =>
      validateAuthoredResourceIdentities([{ first }, { second }]),
    ).not.toThrow();
    expect(() =>
      validateAuthoredResourceIdentities([ALL_WORLD_AREAS]),
    ).not.toThrow();
  });

  it("rejects two durable identities occupying the same snapped tree anchor", () => {
    const area = ALL_WORLD_AREAS.central_haven;
    const tree = area.resources.find((resource) => resource.type === "tree")!;
    expect(() =>
      validateAuthoredResourceIdentities([
        {
          ...ALL_WORLD_AREAS,
          central_haven: {
            ...area,
            resources: [tree, { ...tree, instanceId: "tree_1_2" }],
          },
        },
      ]),
    ).toThrow("Duplicate authored tree anchor");
  });
});
