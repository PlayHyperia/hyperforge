import type {
  AmmunitionShotCommitRequest,
  GroundItemSourceRegistrationRequest,
} from "../../types/network/database";

type AmmunitionRecoverySemantic = Pick<
  GroundItemSourceRegistrationRequest,
  | "itemId"
  | "quantity"
  | "stackable"
  | "position"
  | "tile"
  | "droppedBy"
  | "lifetimeMs"
  | "lootProtectionMs"
>;

export type AmmunitionShotIdentity = Omit<
  AmmunitionShotCommitRequest,
  "requestFingerprint" | "source"
> & {
  recovery: AmmunitionRecoverySemantic | null;
};

/** Candidate UUIDs and merge hints do not change the immutable shot outcome. */
export function serializeAmmunitionShotFingerprint(
  input: AmmunitionShotIdentity,
): string {
  return JSON.stringify({
    version: 1,
    operationId: input.operationId,
    playerId: input.playerId,
    itemId: input.itemId,
    quantity: input.quantity,
    recoveryDisposition: input.recoveryDisposition,
    recovery: input.recovery
      ? {
          itemId: input.recovery.itemId,
          quantity: input.recovery.quantity,
          stackable: input.recovery.stackable,
          position: {
            x: input.recovery.position.x,
            y: input.recovery.position.y,
            z: input.recovery.position.z,
          },
          tile: {
            x: input.recovery.tile.x,
            z: input.recovery.tile.z,
          },
          droppedBy: input.recovery.droppedBy,
          lifetimeMs: input.recovery.lifetimeMs,
          lootProtectionMs: input.recovery.lootProtectionMs,
        }
      : null,
  });
}

export function ammunitionShotIdentityFromRequest(
  request: Omit<AmmunitionShotCommitRequest, "requestFingerprint">,
): AmmunitionShotIdentity {
  const source = request.source;
  return {
    operationId: request.operationId,
    playerId: request.playerId,
    itemId: request.itemId,
    quantity: request.quantity,
    recoveryDisposition: request.recoveryDisposition,
    recovery: source
      ? {
          itemId: source.itemId,
          quantity: source.quantity,
          stackable: source.stackable,
          position: { ...source.position },
          tile: { ...source.tile },
          droppedBy: source.droppedBy,
          lifetimeMs: source.lifetimeMs,
          lootProtectionMs: source.lootProtectionMs,
        }
      : null,
  };
}
