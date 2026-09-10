import { createHash } from "node:crypto";

export type CompetitiveTerminalProofInput = Readonly<{
  duelId: string;
  cycleId: string;
  winnerId: string | null;
  loserId: string | null;
  winReason: string;
  fightStartedAt: number;
  finishedAt: number;
  agent1Id: string | null;
  agent2Id: string | null;
  damageAgent1: number;
  damageAgent2: number;
}>;

/**
 * Build the exact oracle proof shared by live resolution and the lethal-hit
 * transaction. Keeping one canonical serializer prevents a crash-recovered
 * terminal from producing a different seed or replay identity.
 */
export function buildCompetitiveTerminalProof(
  input: CompetitiveTerminalProofInput,
): { seed: string; replayHash: string } {
  const duelSeedHex = createHash("sha256")
    .update(`${input.duelId}-${input.fightStartedAt}`)
    .digest("hex")
    .slice(0, 16);
  const seed = BigInt(`0x${duelSeedHex}`).toString();
  const replayHash = createHash("sha256")
    .update(
      JSON.stringify({
        duelId: input.duelId,
        cycleId: input.cycleId,
        winnerId: input.winnerId,
        loserId: input.loserId,
        winReason: input.winReason,
        fightStartedAt: input.fightStartedAt,
        finishedAt: input.finishedAt,
        agent1Id: input.agent1Id,
        agent2Id: input.agent2Id,
        damageAgent1: input.damageAgent1,
        damageAgent2: input.damageAgent2,
      }),
    )
    .digest("hex");
  return { seed, replayHash };
}
