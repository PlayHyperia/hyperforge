export type DuelArenaOracleProfile = "local" | "testnet" | "mainnet" | "all";

export type DuelArenaOracleChainKey =
  "solanaLocalnet" | "solanaDevnet" | "solanaMainnet";

export type DuelArenaOracleStatus =
  "BETTING_OPEN" | "LOCKED" | "RESOLVED" | "CANCELLED";

export type DuelArenaOracleWinnerSide = "A" | "B";

export interface DuelArenaOracleParticipant {
  id: string;
  name: string;
  hashHex: string;
}

export interface DuelArenaOracleChainState {
  target: DuelArenaOracleChainKey;
  kind: "solana";
  label: string;
  lastAction: "UPSERT" | "RESOLVE" | "CANCEL" | null;
  lastTxHash: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface DuelArenaOracleRecord {
  duelId: string;
  cycleId: string;
  duelKeyHex: string;
  status: DuelArenaOracleStatus;
  metadataUri: string;
  participantA: DuelArenaOracleParticipant;
  participantB: DuelArenaOracleParticipant;
  betOpenTime: number;
  betCloseTime: number;
  fightStartTime: number | null;
  duelEndTime: number | null;
  winnerId: string | null;
  loserId: string | null;
  winnerSide: DuelArenaOracleWinnerSide | null;
  winnerName: string | null;
  loserName: string | null;
  winReason: "kill" | "hp_advantage" | "damage_advantage" | "draw" | null;
  seed: string | null;
  replayHashHex: string | null;
  resultHashHex: string | null;
  chainState: Partial<
    Record<DuelArenaOracleChainKey, DuelArenaOracleChainState>
  >;
  createdAt: string;
  updatedAt: string;
}

export interface DuelArenaOracleStoreFile {
  updatedAt: string;
  records: DuelArenaOracleRecord[];
}

export interface DuelArenaOracleAnnouncementEvent {
  cycleId: string;
  duelId: string;
  duelKeyHex: string;
  betOpenTime: number;
  betCloseTime: number;
  agent1: {
    id: string;
    name: string;
  };
  agent2: {
    id: string;
    name: string;
  };
}

export interface DuelArenaOracleFightStartEvent {
  cycleId: string;
  duelId: string;
  duelKeyHex: string;
  betCloseTime: number;
  fightStartTime: number;
  agent1Id: string | null;
  agent2Id: string | null;
  duration: number;
}

export interface DuelArenaOracleResolutionEvent {
  cycleId: string;
  duelId: string;
  duelKeyHex: string;
  duelEndTime: number;
  outcome: "win" | "draw";
  winnerId: string | null;
  loserId: string | null;
  winnerName: string | null;
  loserName: string | null;
  winReason: "kill" | "hp_advantage" | "damage_advantage" | "draw";
  seed: string | null;
  replayHash: string | null;
}

export interface DuelArenaOracleAbortEvent {
  cycleId: string;
  duelId: string;
  duelKeyHex: string;
  reason: string;
  agent1Id: string | null;
  agent2Id: string | null;
  agent1Name: string | null;
  agent2Name: string | null;
}

export interface DuelArenaOracleSolanaTargetConfig {
  key: Extract<
    DuelArenaOracleChainKey,
    "solanaLocalnet" | "solanaDevnet" | "solanaMainnet"
  >;
  label: string;
  rpcUrl: string;
  wsUrl: string;
  programId: string;
  authoritySecret: string | null;
  reporterSecret: string | null;
}

export interface DuelArenaOracleConfig {
  enabled: boolean;
  profile: DuelArenaOracleProfile;
  metadataBaseUrl: string;
  storePath: string;
  solanaTargets: DuelArenaOracleSolanaTargetConfig[];
  settlementDelayMs: number;
}
