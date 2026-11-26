# Native-SOL Duel Scope

Hyperia supplies authoritative duel identity, timing, lifecycle, outcome, replay proof, and stream health. Hyperbet owns the browser betting experience and every market, order, collateral, fee, refund, payout, referral, and accounting concern. The launch asset is native SOL, represented as exact integer lamports at authoritative boundaries.

## Forbidden launch assumptions

The active duel/stream/Hyperbet closure must not contain:

- a separate betting token, token mint, token program, holding balance, staking balance, or holding-duration multiplier;
- alternate-chain RPCs, contracts, origins, signers, wallet identities, or deployment commands;
- floating-point or generic `number` values as authoritative money;
- an in-game betting client that bypasses Hyperbet's canonical backend;
- hard-coded fee, referral-share, or profitability parameters that have not been approved and modeled.

The automated `duel:scope:sol` gate scans the active launcher, server integration, oracle, streaming UI, environment examples, and operational documentation for these regressions. Historical migration snapshots are deliberately excluded because they are immutable records of prior schemas.

## Retired Hyperia betting state

Hyperia's former market, bet, payout, fee-share, referral, cross-wallet, and token-gated points tables had no runtime consumers. Migration `0057_retire_in_server_betting_integration.sql` copies every row into the read-only `retired_arena_integration_records` archive, verifies source/archive row counts per table, and only then removes the active tables. The migration is idempotent. Hyperbet's separately verified native-SOL ledger remains the launch accounting source.

The unused in-game betting panel was removed because it accepted floating-point amounts, performed optimistic payout math, emitted network packets with no server handler, and duplicated the canonical Hyperbet experience.

## Allowed ordinary game vocabulary

The following are not crypto assets and remain valid:

- coins, gold bars, jewelry inputs, item values, duel-stake item values, loot, and agent-session currency earned inside the RPG;
- gold/yellow theme names, CSS variables, color comments, highlights, and material descriptions;
- natural-language references to earning ordinary game currency.

These uses must never be presented as Hyperbet collateral, a fee or payout unit, a wallet token balance, a purchase requirement, or a multiplier input. If an allowed gameplay term becomes reachable from the betting launch path, it stops being allowlisted and the scope gate must be extended to reject it.
