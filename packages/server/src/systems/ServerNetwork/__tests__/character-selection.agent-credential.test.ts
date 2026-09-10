import { describe, expect, it, vi } from "vitest";
import {
  handleCharacterSelected,
  handleEnterWorld,
} from "../character-selection.js";

describe("agent credential character authority", () => {
  it("rejects a character selection outside the persisted credential binding", () => {
    const sendTo = vi.fn();
    const socket = {
      id: "agent-socket",
      agentCredentialCharacterId: "owned-character",
    };

    handleCharacterSelected(
      socket as never,
      { characterId: "different-character" },
      sendTo,
    );

    expect(socket).toHaveProperty("selectedCharacterId", undefined);
    expect(sendTo).toHaveBeenCalledWith(
      "agent-socket",
      "enterWorldRejected",
      expect.objectContaining({ reason: "credential_character_mismatch" }),
    );
  });

  it("accepts the exact character selected by the persisted credential", () => {
    const sendTo = vi.fn();
    const socket = {
      id: "agent-socket",
      agentCredentialCharacterId: "owned-character",
    };

    handleCharacterSelected(
      socket as never,
      { characterId: "owned-character" },
      sendTo,
    );

    expect(socket).toMatchObject({ selectedCharacterId: "owned-character" });
    expect(sendTo).toHaveBeenCalledWith("agent-socket", "characterSelected", {
      characterId: "owned-character",
    });
  });

  it("fails before world access when enterWorld requests another character", async () => {
    const send = vi.fn();
    const sendTo = vi.fn();
    const socket = {
      id: "agent-socket",
      accountId: "owner-account",
      agentCredentialCharacterId: "owned-character",
    };

    await handleEnterWorld(
      socket as never,
      { characterId: "different-character" },
      {} as never,
      {
        position: [0, 10, 0],
        quaternion: [0, 0, 0, 1],
      },
      send,
      sendTo,
    );

    expect(socket).not.toHaveProperty("characterId");
    expect(send).not.toHaveBeenCalled();
    expect(sendTo).toHaveBeenCalledWith(
      "agent-socket",
      "enterWorldRejected",
      expect.objectContaining({ reason: "credential_character_mismatch" }),
    );
  });
});
