# Solana Duel Arena Oracle Deployment

The duel arena oracle is a Solana-only publication path inside Hyperia. It is separate from Hyperbet's native-SOL market and never accepts betting collateral.

## Components

- Solana oracle package: `packages/duel-oracle-solana`
- Server publisher: `packages/server/src/oracle/DuelArenaOraclePublisher.ts`
- Metadata API: `GET /api/duel-arena/oracle/duels/:duelId`

The authoritative event flow is:

1. `streaming:announcement:start` publishes the duel announcement/open state.
2. `streaming:fight:start` publishes the locked/start state.
3. `streaming:resolution:start` publishes the canonical result.
4. `streaming:cycle:aborted` publishes cancellation.

## Signer generation

Generate separate, unfunded Solana authority and reporter keypairs:

```bash
bun --cwd packages/server run scripts/generate-duel-oracle-wallets.ts
```

The command updates the ignored `packages/server/.env` and writes private keypairs plus a public summary under `.codex-artifacts/duel-arena-oracle-wallets/`. Keep both locations private. Fund only the public addresses on the intended Solana cluster.

The generated authority and reporter are intentionally different. Do not collapse production roles into one hot key.

## Local end-to-end verification

Run the duel, stream, and oracle publication flow against `solana-test-validator`:

```bash
bun run duel:oracle:verify:local
```

The verifier starts or reuses Solana localnet, builds and deploys `fight_oracle`, starts the local duel stack, verifies streamed combat, and confirms the resolved record and finalized signature on Solana. It does not start, deploy, or inspect any other chain.

## Server runtime configuration

```dotenv
DUEL_ARENA_ORACLE_ENABLED=true
DUEL_ARENA_ORACLE_PROFILE=testnet
DUEL_ARENA_ORACLE_METADATA_BASE_URL=https://your-domain.example/api/duel-arena/oracle
DUEL_ARENA_ORACLE_STORE_PATH=/var/lib/hyperia/duel-arena-oracle/records.json
DUEL_ARENA_ORACLE_SOLANA_AUTHORITY_SECRET=base64:...
DUEL_ARENA_ORACLE_SOLANA_REPORTER_SECRET=base64:...
```

Profiles select a Solana cluster only:

- `local`: localnet
- `testnet`: devnet
- `mainnet`: mainnet-beta
- `all`: every configured Solana cluster; intended only for explicit verification

Cluster-specific signer variables override shared signer variables. Enabling the publisher without an authority or reporter secret for the selected profile is a fatal startup error.

## Build and deploy

Build the canonical program:

```bash
bun --cwd packages/duel-oracle-solana run anchor:build
```

Deploy to one cluster with an explicitly selected authority keypair:

```bash
cd packages/duel-oracle-solana/anchor
ANCHOR_WALLET=/absolute/path/to/solana-authority.json bash scripts/deploy-fight-oracle.sh devnet
ANCHOR_WALLET=/absolute/path/to/solana-authority.json bash scripts/deploy-fight-oracle.sh mainnet-beta
```

After deployment, set the matching program ID:

```dotenv
DUEL_ARENA_ORACLE_SOLANA_DEVNET_PROGRAM_ID=...
DUEL_ARENA_ORACLE_SOLANA_MAINNET_PROGRAM_ID=...
```

The publisher initializes the oracle config when authority material is present and uses the reporter for lifecycle/result writes.

## IDL usage

- Canonical IDL: `packages/duel-oracle-solana/anchor/target/idl/fight_oracle.json`
- Generated TypeScript export: `packages/duel-oracle-solana/src/generated/fightOracleIdl.ts`
- Public manifest: `@playhyperia/duel-oracle-solana/config.json`

```ts
import { PublicKey } from "@solana/web3.js";
import { FIGHT_ORACLE_IDL } from "../packages/duel-oracle-solana/dist/index.js";

const programId = new PublicKey(FIGHT_ORACLE_IDL.address);
```

The current schema fields `betOpenTs` and `betCloseTs` represent the arena announcement window and immutable lock boundary; the oracle itself never handles stake amounts or fees.

## Production gate

1. Use separate authority and reporter keypairs and record their ownership/rotation procedure.
2. Deploy only the approved Solana program and verify its program-data and upgrade authority.
3. Select exactly the intended production profile, RPC, WebSocket endpoint, and program ID.
4. Enable the publisher only after signer and metadata configuration validation passes.
5. Verify `GET /api/duel-arena/oracle/recent`, `GET /api/duel-arena/oracle/duels/<duelId>`, the returned Solana signature, and the on-chain duel PDA.
6. Treat any missing target, initialization failure, publish error, or signature mismatch as a launch failure.
