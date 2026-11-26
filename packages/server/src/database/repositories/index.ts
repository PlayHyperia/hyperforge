/**
 * Repository Module - Barrel Export
 *
 * Exports all database repositories for easy import.
 * Each repository handles a specific domain of database operations.
 *
 * Usage:
 * ```typescript
 * import { PlayerRepository, InventoryRepository } from './database/repositories';
 * ```
 */

export { BaseRepository } from "./BaseRepository";
export { CharacterRepository } from "./CharacterRepository";
export { PlayerRepository } from "./PlayerRepository";
export { InventoryRepository } from "./InventoryRepository";
export { EquipmentRepository } from "./EquipmentRepository";
export { SessionRepository } from "./SessionRepository";
export { WorldChunkRepository } from "./WorldChunkRepository";
export { NPCKillRepository } from "./NPCKillRepository";
export { DeathRepository } from "./DeathRepository";
export { TemplateRepository } from "./TemplateRepository";
export type { TemplateRow } from "./TemplateRepository";
export { QuestRepository } from "./QuestRepository";
export type {
  QuestDbStatus,
  StageProgress,
  QuestProgressRow,
  QuestGatheringProgressReceiptRow,
  ApplyQuestGatheringProgressReceiptRequest,
  ApplyQuestGatheringProgressReceiptResult,
  RetireQuestGatheringProgressReceiptResult,
  IgnoreQuestProgressReceiptResult,
  QuestProcessingProgressReceiptRow,
  ApplyQuestProcessingProgressReceiptRequest,
  ApplyQuestProcessingProgressReceiptResult,
  RetireQuestProcessingProgressReceiptResult,
} from "./QuestRepository";
export { ActivityLogRepository } from "./ActivityLogRepository";
export { BankRepository } from "./BankRepository";
export { FriendRepository } from "./FriendRepository";
export type {
  FriendRow,
  FriendRequestRow,
  IgnoreRow,
} from "./FriendRepository";
