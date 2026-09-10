import { describe, expect, it } from "vitest";

import {
  hasActiveStreamingPreparationPresentation,
  resolveStreamingPreparationFocus,
  type StreamingPreparationEntity,
} from "../streamingPreparationFocus";

describe("streaming preparation focus", () => {
  it("accepts only authoritative active preparation presentations", () => {
    expect(
      hasActiveStreamingPreparationPresentation({
        data: { gatheringToolPresentation: { revision: 1, itemId: "harpoon" } },
      }),
    ).toBe(true);
    expect(
      hasActiveStreamingPreparationPresentation({
        data: {
          gatheringToolPresentation: { revision: 2, itemId: null },
          fishingInteractionPresentation: {
            revision: 3,
            itemId: "harpoon",
            phase: "strike",
          },
        },
      }),
    ).toBe(true);
    expect(
      hasActiveStreamingPreparationPresentation({
        data: {
          gatheringToolPresentation: { revision: 4, itemId: null },
          fishingInteractionPresentation: {
            revision: 5,
            itemId: null,
            phase: "idle",
          },
        },
      }),
    ).toBe(false);
  });

  it("frames the active assigned preparation participants at their midpoint", () => {
    const entities = new Map<string, StreamingPreparationEntity>([
      [
        "agent-a",
        {
          node: { position: { x: -8.75, y: 28.08, z: -10.75 } },
          data: {
            gatheringToolPresentation: { revision: 1, itemId: "harpoon" },
          },
        },
      ],
      [
        "agent-b",
        {
          position: { x: -1.75, y: 28.08, z: -12.5 },
          data: {
            fishingInteractionPresentation: {
              revision: 1,
              itemId: "harpoon",
              phase: "held",
              targetPosition: { x: -6, y: 27.8, z: -12 },
            },
          },
        },
      ],
    ]);

    expect(
      resolveStreamingPreparationFocus({
        phase: "IDLE",
        participantIds: ["agent-a", "agent-b"],
        resolveEntity: (id) => entities.get(id),
      }),
    ).toMatchObject({
      actorId: "agent-a",
      position: { x: -5.25, y: 28.08, z: -11.625 },
      activityTargetPosition: { x: -6, y: 27.8, z: -12 },
      participants: [{ id: "agent-a" }, { id: "agent-b" }],
    });
  });

  it("uses the preferred active camera actor and only that actor's interaction target", () => {
    const entities = new Map<string, StreamingPreparationEntity>([
      [
        "agent-a",
        {
          position: { x: -8, y: 28, z: -10 },
          data: {
            fishingInteractionPresentation: {
              revision: 1,
              itemId: "harpoon",
              phase: "held",
              targetPosition: { x: -9, y: 27.8, z: -12 },
            },
          },
        },
      ],
      [
        "agent-b",
        {
          position: { x: 6, y: 28, z: 8 },
          data: {
            fishingInteractionPresentation: {
              revision: 1,
              itemId: "harpoon",
              phase: "held",
              targetPosition: { x: 7, y: 27.8, z: 10 },
            },
          },
        },
      ],
    ]);

    expect(
      resolveStreamingPreparationFocus({
        phase: "IDLE",
        participantIds: ["agent-a", "agent-b"],
        preferredActorId: "agent-b",
        resolveEntity: (id) => entities.get(id),
      }),
    ).toMatchObject({
      actorId: "agent-b",
      position: { x: -1, y: 28, z: -1 },
      activityTargetPosition: { x: 7, y: 27.8, z: 10 },
      participants: [{ id: "agent-a" }, { id: "agent-b" }],
    });
  });

  it("frames an exact authoritative processing target without private action data", () => {
    const entity: StreamingPreparationEntity = {
      position: { x: 2, y: 0, z: 3 },
      data: {
        processingInteractionPresentation: {
          revision: 6,
          skill: "smelting",
          phase: "working",
          phaseStartedAtServerTimeMs: 4000,
          targetPosition: { x: 4, y: 0, z: 5 },
        },
      },
    };
    expect(hasActiveStreamingPreparationPresentation(entity)).toBe(true);
    expect(
      resolveStreamingPreparationFocus({
        phase: "IDLE",
        participantIds: ["agent-a"],
        resolveEntity: () => entity,
      }),
    ).toMatchObject({
      actorId: "agent-a",
      position: { x: 2, y: 0, z: 3 },
      activityTargetPosition: { x: 4, y: 0, z: 5 },
    });
  });

  it("refuses unassigned, inactive, invalid-position, and non-idle focus", () => {
    const active: StreamingPreparationEntity = {
      position: { x: 1, y: 2, z: 3 },
      data: { gatheringToolPresentation: { revision: 1, itemId: "harpoon" } },
    };
    const invalid: StreamingPreparationEntity = {
      position: { x: Number.NaN, y: 2, z: 3 },
      data: { gatheringToolPresentation: { revision: 1, itemId: "harpoon" } },
    };
    const entities = new Map([
      ["assigned", active],
      ["invalid", invalid],
    ]);

    expect(
      resolveStreamingPreparationFocus({
        phase: "FIGHTING",
        participantIds: ["assigned"],
        resolveEntity: (id) => entities.get(id),
      }),
    ).toBeNull();
    expect(
      resolveStreamingPreparationFocus({
        phase: "IDLE",
        participantIds: ["invalid", "missing"],
        resolveEntity: (id) => entities.get(id),
      }),
    ).toBeNull();
    expect(
      resolveStreamingPreparationFocus({
        phase: "IDLE",
        participantIds: [],
        resolveEntity: () => active,
      }),
    ).toBeNull();
  });

  it("accepts live presentation authority when an activity event follows the entity snapshot", () => {
    const snapshotBeforeActivity: StreamingPreparationEntity = {
      position: { x: -5, y: 28, z: -12 },
      data: {},
    };
    expect(
      resolveStreamingPreparationFocus({
        phase: "IDLE",
        participantIds: ["agent-a"],
        resolveEntity: () => snapshotBeforeActivity,
        isParticipantActive: (id) => id === "agent-a",
      }),
    ).toMatchObject({
      actorId: "agent-a",
      position: { x: -5, y: 28, z: -12 },
    });
  });
});
