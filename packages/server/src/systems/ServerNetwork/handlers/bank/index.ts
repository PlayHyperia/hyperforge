/**
 * Bank Handlers - Barrel Export
 *
 * All bank-related packet handlers organized into focused modules:
 *
 * - core.ts: Open, deposit, withdraw, deposit all, close
 * - coins.ts: Coin deposit/withdraw to money pouch
 * - equipment.ts: Equipment tab interactions
 * - move.ts: Bank rearrangement (swap/insert modes)
 * - placeholders.ts: modern MMORPG-style placeholder system
 * - tabs.ts: Custom tab management
 * - utils.ts: Shared utilities (not exported externally)
 */

// Core handlers
export {
  handleBankOpen,
  handleBankDeposit,
  handleBankWithdraw,
  handleBankDepositAll,
  handleBankClose,
  handleRequestBankState,
} from "./core";

export {
  handleExternalAgentBankTransfer,
  handleExternalAgentBankRecovery,
} from "./agent";

// Coin handlers
export { handleBankDepositCoins, handleBankWithdrawCoins } from "./coins";

// Equipment handlers
export {
  handleBankWithdrawToEquipment,
  handleBankDepositEquipment,
  handleBankDepositAllEquipment,
} from "./equipment";

// Move handler
export { handleBankMove } from "./move";

// Placeholder handlers
export {
  handleBankWithdrawPlaceholder,
  handleBankReleasePlaceholder,
  handleBankReleaseAllPlaceholders,
  handleBankToggleAlwaysPlaceholder,
} from "./placeholders";

// Tab handlers
export {
  handleBankCreateTab,
  handleBankDeleteTab,
  handleBankMoveToTab,
} from "./tabs";
