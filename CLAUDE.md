# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hyperia is a classic fantasy MMORPG built on a custom 3D multiplayer engine. The project features a real-time 3D metaverse engine (Hyperia) in a persistent world.

## CRITICAL: Secrets and Private Keys

**Never put private keys, seed phrases, API keys, tokens, RPC secrets, or wallet secrets into any tracked file.**

- ALWAYS use local untracked `.env` files for real secrets during development
- NEVER hardcode secrets in source, tests, docs, fixtures, scripts, config files, or GitHub workflow files
- NEVER place real credentials in `.env.example`; placeholders only
- Production and CI secrets must live in the platform secret manager, not in git
- If a new secret is required, add only the variable name to docs or `.env.example` and load the real value from `.env`, `.env.local`, or deployment secrets

## CRITICAL: WebGPU Required (NO WebGL)

**Hyperia requires WebGPU. WebGL WILL NOT WORK.**

This is a hard requirement due to our use of TSL (Three Shading Language) for all materials and post-processing effects. TSL only works with the WebGPU node material pipeline.

### Why WebGPU-Only?
- **TSL Shaders**: All materials use Three.js Shading Language (TSL) which requires WebGPU
- **Post-Processing**: Bloom, tone mapping, and other effects use TSL-based node materials
- **No Fallback**: There is NO WebGL fallback - the game will not render without WebGPU

### Browser Requirements
- Chrome 113+ (recommended)
- Edge 113+
- Safari 17+
- Firefox (behind flag, not recommended)

### Server/Streaming Requirements
For Vast.ai and other GPU servers running the streaming pipeline:
- **NVIDIA GPU with ANGLE support is REQUIRED**
- **Must run headful** with Xorg or Xvfb (NOT headless Chrome)
- **CRITICAL LINUX NOTE**: On Linux, use **Chrome Beta** (or Canary) with **ANGLE's Vulkan backend** (`--use-gl=angle --use-angle=vulkan --enable-features=DefaultANGLEVulkan,Vulkan,VulkanFromANGLE`). ANGLE OpenGL ES (`--use-angle=gl`) fails with "Invalid visual ID" on NVIDIA. Native Vulkan (`--use-vulkan`) crashes — only ANGLE Vulkan works. The `UnsafeWebGPU` feature flag must be enabled via `--enable-features=WebGPU,UnsafeWebGPU` for `navigator.gpu` to be available.
- **CRITICAL MAC NOTE**: It is important on macOS to use **Google Chrome** with the **Metal** backend for ANGLE (`--use-angle=metal`).
- If GPU cannot initialize WebGPU, deployment MUST FAIL (no soft fallbacks)

### Development Rules for WebGPU
- **NEVER add WebGL fallback code** - it will not work with TSL shaders
- **NEVER use `--disable-webgpu`** or `forceWebGL` flags
- **NEVER use headless Chrome modes** that don't support WebGPU
- All renderer code must assume WebGPU availability
- If WebGPU is unavailable, throw an error immediately

## Essential Commands

### Development Workflow
```bash
# Install dependencies
bun install

# Build all packages (required before first run)
bun run build

# Development mode with hot reload
bun run dev

# Start game server (production mode)
bun start               # or: cd packages/server && bun run start

# Run all tests
npm test

# Lint codebase
npm run lint

# Clean build artifacts
npm run clean
```

### Package-Specific Commands
```bash
# Build individual packages
bun run build:shared    # Core engine (must build first)
bun run build:client    # Web client
bun run build:server    # Game server

# Development mode for specific packages
bun run dev:shared      # Shared package with watch mode
bun run dev:client      # Client with Vite HMR
bun run dev:server      # Server with auto-restart
```

### Testing
```bash
# Run all tests (uses Playwright for real gameplay testing)
npm test

# Run tests for specific package
npm test --workspace=packages/server

# Tests MUST use real Hyperia instances - NO MOCKS ALLOWED
# Visual testing with screenshots and Three.js scene introspection
```

### Mobile Development
```bash
# iOS
npm run ios             # Build, sync, and open Xcode
npm run ios:dev         # Sync and open without rebuild
npm run ios:build       # Production build

# Android
npm run android         # Build, sync, and open Android Studio
npm run android:dev     # Sync and open without rebuild
npm run android:build   # Production build

# Capacitor sync (copy web build to native projects)
npm run cap:sync        # Sync both platforms
npm run cap:sync:ios    # iOS only
npm run cap:sync:android # Android only
```

### Documentation
```bash
# Generate API documentation (TypeDoc)
npm run docs:generate

# Start docs dev server (http://localhost:3402)
bun run docs:dev

# Build production docs
npm run docs:build
```

## Architecture Overview

### Monorepo Structure

This is a **Turbo monorepo** with packages:

```
packages/
├── shared/              # Core HyperForge 3D engine
│   ├── Entity Component System (ECS)
│   ├── Three.js + PhysX integration
│   ├── Real-time multiplayer networking
│   └── React UI components
├── server/              # Game server (Fastify + WebSockets)
│   ├── World management
│   ├── SQLite/PostgreSQL persistence
│   └── LiveKit voice chat integration
├── client/              # Web client (Vite + React)
│   ├── 3D rendering
│   ├── Player controls
│   └── UI/HUD
├── physx-js-webidl/     # PhysX WASM bindings
├── asset-forge/         # AI asset generation (GPT-4, MeshyAI)
└── docs-site/           # Docusaurus documentation site
```

### Build Dependency Graph

**Critical**: Packages must build in this order due to dependencies:

1. **physx-js-webidl** - PhysX WASM (takes longest, ~5-10 min first time)
2. **shared** - Depends on physx-js-webidl
3. **All other packages** - Depend on shared

The `turbo.json` configuration handles this automatically via `dependsOn: ["^build"]`.

> **TODO(AUDIT-004): CIRCULAR DEPENDENCY - shared ↔ procgen**
>
> There is a circular dependency between `@hyperforge/shared` and `@hyperforge/procgen`.
> - shared imports procgen for vegetation/terrain generation
> - procgen imports shared for TileCoord type in viewers
>
> **Current workaround**: procgen build ignores TypeScript errors.
>
> **Recommended fix**: Extract shared types to `@hyperforge/types` package:
> - Create new package with only type definitions (no runtime code)
> - Both shared and procgen depend on types (no circular dep)
> - Move TileCoord, Position3D, EntityData to types package

### Entity Component System (ECS)

The RPG is built using HyperForge's ECS architecture:

- **Entities**: Game objects (players, mobs, items, trees)
- **Components**: Data containers (position, health, inventory)
- **Systems**: Logic processors (combat, skills, movement)

All game logic runs through systems, not entity methods. Entities are just data containers.

### RPG Implementation Architecture

**Important**: Despite references to "Hyperia apps (.hyp)" in development rules, `.hyp` files **do not currently exist**. This is an aspirational architecture pattern for future development.

**Current Implementation**:
The RPG is built directly into [packages/shared/src/](packages/shared/src/) using:
- **Entity Classes**: [PlayerEntity.ts](packages/shared/src/entities/player/PlayerEntity.ts), [MobEntity.ts](packages/shared/src/entities/npc/MobEntity.ts), [ItemEntity.ts](packages/shared/src/entities/world/ItemEntity.ts)
- **ECS Systems**: Combat, inventory, skills, AI in [src/systems/](packages/shared/src/systems/)
- **Components**: Data containers for stats, health, equipment, etc.

**Design Principle** (from development rules):
- Keep RPG game logic **conceptually isolated** from core HyperForge engine
- Use existing HyperForge abstractions (ECS, networking, physics)
- Don't reinvent systems that Hyperia already provides
- Separation of concerns: core engine vs. game content

## Critical Development Rules

### TypeScript Strong Typing

**NO `any` types are allowed** - ESLint will reject them.

- **Prefer classes over interfaces** for type definitions
- Use type assertions when you know the type: `entity as Player`
- Share types from `types.ts` files - don't recreate them
- Use `import type` for type-only imports
- Make strong type assumptions based on context (don't over-validate)

```typescript
// ❌ FORBIDDEN
const player: any = getEntity(id);
if ('health' in player) { ... }

// ✅ CORRECT
const player = getEntity(id) as Player;
player.health -= damage;
```

### File Management

**Don't create new files unless absolutely necessary.**

- Revise existing files instead of creating `_v2.ts` variants
- Delete old files when replacing them
- Update all imports when moving code
- Clean up test files immediately after use
- Don't create temporary `check-*.ts`, `test-*.mjs`, `fix-*.js` files

### Testing Philosophy

**NO MOCKS** - Use real Hyperia instances with Playwright.

Every feature MUST have tests that:
1. Start a real Hyperia server
2. Open a real browser with Playwright
3. Execute actual gameplay actions
4. Verify with screenshots + Three.js scene queries
5. Save error logs to `/logs/` folder

Visual testing uses colored cube proxies:
- 🔴 Players
- 🟢 Goblins
- 🔵 Items
- 🟡 Trees
- 🟣 Banks

### Production Code Only

- No TODOs or "will fill this out later" - implement completely
- No hardcoded data - use JSON files and general systems
- No shortcuts or workarounds - fix root causes
- Build toward the general case (many items, players, mobs)

### Separation of Concerns

- **Data vs Logic**: Never hardcode data into logic files
- **RPG vs Engine**: Keep RPG isolated from HyperForge core
- **Types**: Define in `types.ts`, import everywhere
- **Systems**: Use existing HyperForge systems before creating new ones

## Working with the Codebase

### Understanding HyperForge Systems

Before creating new abstractions, research existing HyperForge systems:

1. Check [packages/shared/src/systems/](packages/shared/src/systems/)
2. Look for similar patterns in existing code
3. Use Hyperia's built-in features (ECS, networking, physics)
4. Read entity/component definitions in `types/` folders

### Common Patterns

**Getting Systems:**
```typescript
const combatSystem = world.getSystem('combat') as CombatSystem;
```

**Entity Queries:**
```typescript
const players = world.getEntitiesByType('Player');
```

**Event Handling:**
```typescript
world.on('inventory:add', (event: InventoryAddEvent) => {
  // Handle event - assume properties exist
});
```

### Development Server

The dev server provides:
- Hot module replacement (HMR) for client
- Auto-rebuild and restart for server
- Watch mode for shared package
- Colored logs for debugging

**Commands:**
```bash
bun run dev        # Core game (client + server + shared)
bun run dev:forge  # AssetForge (standalone)
bun run docs:dev   # Documentation site (standalone)
```

### Port Allocation

All services have unique default ports to avoid conflicts:

| Port | Service | Env Var | Started By |
|------|---------|---------|------------|
| 3333 | Game Client | `VITE_PORT` | `bun run dev` |
| 3400 | AssetForge UI | `ASSET_FORGE_PORT` | `bun run dev:forge` |
| 3401 | AssetForge API | `ASSET_FORGE_API_PORT` | `bun run dev:forge` |
| 3402 | Docusaurus | (hardcoded) | `bun run docs:dev` |
| 5555 | Game Server | `PORT` | `bun run dev` |

### Environment Variables

**Zero-config local development**: The defaults work out of the box. Just run `bun run dev`.

**Secret handling is non-negotiable**:
- Real private keys and API tokens must come from local untracked `.env` files
- Tracked files may only contain placeholders and variable names
- If you find a real credential in a tracked file, remove it and move it to `.env` or the deployment secret store immediately

**Package-specific `.env` files**: Each package has its own `.env.example` with deployment documentation:

| Package | File | Purpose |
|---------|------|---------|
| Server | `packages/server/.env.example` | Server deployment (Railway, Fly.io, Docker) |
| Client | `packages/client/.env.example` | Client deployment (Vercel, Netlify, Pages) |
| AssetForge | `packages/asset-forge/.env.example` | AssetForge deployment |

**Common variables**:
```bash
# Server (packages/server/.env)
DATABASE_URL=postgresql://...    # Required for production
JWT_SECRET=...                   # Required for production
PRIVY_APP_ID=...                 # For Privy auth
PRIVY_APP_SECRET=...             # For Privy auth

# Client (packages/client/.env)
PUBLIC_PRIVY_APP_ID=...          # Must match server's PRIVY_APP_ID
PUBLIC_API_URL=https://...       # Point to your server
PUBLIC_WS_URL=wss://...          # Point to your server WebSocket
```

**Split deployment** (client and server on different hosts):
- `PUBLIC_PRIVY_APP_ID` (client) must equal `PRIVY_APP_ID` (server)
- `PUBLIC_WS_URL` and `PUBLIC_API_URL` must point to your server

## Package Manager

This project uses **Bun** (v1.1.38+) as the package manager and runtime.

- Install: `bun install` (NOT `npm install`)
- Run scripts: `bun run <script>` or `bun <file>`
- Some commands use `npm` prefix for Turbo workspace filtering

## Tech Stack

- **Runtime**: Bun v1.1.38+
- **Rendering**: WebGPU ONLY (Three.js WebGPURenderer + TSL shaders) - NO WebGL
- **Engine**: Three.js 0.180.0, PhysX (WASM)
- **UI**: React 19.2.0, styled-components
- **Server**: Fastify, WebSockets, LiveKit
- **Database**: SQLite (local), PostgreSQL (production via Neon)
- **Testing**: Playwright, Vitest
- **Build**: Turbo, esbuild, Vite
- **Mobile**: Capacitor

## Troubleshooting

### Build Issues

```bash
# Clean everything and rebuild
npm run clean
rm -rf node_modules packages/*/node_modules
bun install
bun run build
```

### PhysX Build Fails

PhysX is pre-built and committed. If it needs rebuilding:
```bash
cd packages/physx-js-webidl
./make.sh  # Requires emscripten toolchain
```

### Port Conflicts

```bash
# Kill processes on common Hyperia ports
lsof -ti:3333 | xargs kill -9  # Game Client
lsof -ti:5555 | xargs kill -9  # Game Server
```

See [Port Allocation](#port-allocation) section for full port list.

### Tests Failing

- Ensure server is not running before tests
- Check `/logs/` folder for error details
- Tests spawn their own Hyperia instances
- Visual tests require WebGPU support (headful browser with GPU access)

## Agent Combat System

This section covers every layer of the embedded-agent combat stack. Read this before touching anything related to agent behavior, duels, or the streaming arena.

### Architecture Overview

There are **two separate combat loops** for agents. They are mutually exclusive:

| Loop | File | Tick Rate | When Active |
|------|------|-----------|-------------|
| `AgentBehaviorTicker` | `packages/server/src/eliza/managers/AgentBehaviorTicker.ts` | 8 seconds | Normal overworld play |
| `DuelCombatAI` | `packages/server/src/duel/DuelCombatAI.ts` | 600 ms | Inside the streaming duel arena |

The `DuelOrchestrator` (`packages/server/src/systems/StreamingDuelScheduler/managers/DuelOrchestrator.ts`) manages the transition: when a duel starts it calls `service.setAutonomousBehaviorEnabled(false)` on each agent's service, suspending the 8-second loop entirely. When the duel ends `stopCombatAIs()` calls `setAutonomousBehaviorEnabled(true)` to resume normal behavior.

### EmbeddedHyperiaService — the action layer

`packages/server/src/eliza/EmbeddedHyperiaService.ts`

This is the single interface through which ALL agent actions are issued. Every combat method below ultimately emits a world event or calls a game system — never touch game state directly, always go through this service.

**Key combat methods:**

| Method | What it does |
|--------|-------------|
| `executeAttack(targetId)` | Initiates/re-initiates combat against a specific entity ID |
| `executeMove(target, runMode?)` | Moves the agent to `[x, y, z]`; clamped to `_arenaBounds` when set |
| `executeUse(itemId)` | Uses an item from inventory — used for food/potions |
| `executePrayer(prayerId)` | Activates a single prayer by ID |
| `executePrayerToggle(prayerId)` | Toggles a prayer on/off, returns new state |
| `executePrayerDeactivateAll()` | Deactivates all active prayers |
| `executeStop()` | Cancels current movement and combat |
| `getGameState()` | Returns cached `EmbeddedGameState` (position, HP, inCombat, inventory, prayers, etc.) |
| `getNearbyEntities()` | Returns `NearbyEntityData[]` of everything in scan radius |
| `getEquippedItems()` | Returns a map of slot → itemId for all equipped gear |
| `getInventoryItems()` | Returns the agent's full inventory array |

**Arena-mode methods (set by DuelOrchestrator):**

| Method | Purpose |
|--------|---------|
| `setArenaBounds(bounds)` | Clamps movement to `{minX, maxX, minZ, maxZ}` at **two layers**: (1) `executeMove` on the service, and (2) `entity.data.arenaBounds` checked by `TileMovementManager.movePlayerToward()` — this second layer catches combat-follow, pending-attack walk, and every other server-side movement path that bypasses the service |
| `clearArenaBounds()` | Removes both clamps (service + entity data) |
| `setAutonomousBehaviorEnabled(false)` | Suspends the 8-second `AgentBehaviorTicker` loop |
| `setAutonomousBehaviorEnabled(true)` | Restores normal behavior ticking |

**IEmbeddedHyperiaService** (`packages/server/src/eliza/types.ts`) is the interface contract. Add any new service methods here first, then implement in `EmbeddedHyperiaService`.

### AgentBehaviorTicker — overworld combat (8-second loop)

`packages/server/src/eliza/managers/AgentBehaviorTicker.ts`

This is the autonomous behavior loop for agents outside the duel arena. It runs every 8 seconds per agent (staggered by 800 ms across agents to prevent simultaneous spikes).

**Tick pipeline (in order):**
1. Death-loop recovery check
2. Arena-ejection check
3. `inStreamingDuel` flag check — skips tick if true
4. `isAutonomousEnabled()` check — skips tick if false (arena mode)
5. Combat chat reactions
6. `manageQuests()` — update goal, auto-accept quests
7. `manageInventory()` — drop junk, bury bones
8. `manageShopping()` — buy missing tools/weapons
9. `manageEquipment()` — equip best gear
10. `assessAndEat()` — eat food if HP < threshold; returns early if eaten
11. `pickBehaviorAction()` — decide and return the next action
12. Execute the action, sync dashboard

**Combat-specific behavior in `pickBehaviorAction`:**

- **`inCombat = true`**: The game's auto-attack system handles hits. The ticker:
  - Activates offensive prayer (fire-and-forget) on the first tick of each fight, determined by `getOffensivePrayerForAgent()` (mage staff → `mystic_lore`, bow → `hawk_eye`, else → `superhuman_strength`)
  - Re-issues `executeAttack(currentTargetId)` every 16 seconds to prevent silent combat drops
  - Returns `idle` otherwise (let the game engine tick)
- **`inCombat = false` → nearby mobs**: calls `pickCombatOrExplore()` which selects the best target (spreading agents across different mobs to avoid all piling on one) and returns `{ type: "attack", targetId }`
- **`inCombat = false` → no mobs**: gathers resources or returns to spawn

**On attack execution (`case "attack"` in the switch):**
- `executeAttack(targetId)` is awaited
- `executePrayer(offensivePrayer)` is fired immediately (fire-and-forget) if prayer not already active
- `instance.combatPrayerActive` is set to `true`

**On leaving combat (`inCombat` just became false):**
- `executePrayerDeactivateAll()` fires to save prayer points
- `instance.combatPrayerActive` and `instance.lastCombatReEngageAt` reset to 0

**Key `AgentInstance` fields for combat:**

| Field | Type | Purpose |
|-------|------|---------|
| `currentTargetId` | `string \| null` | ID of the mob the agent last chose to attack |
| `lastCombatReEngageAt` | `number` | Timestamp of last re-engage attack; used for 16s re-engage interval |
| `combatPrayerActive` | `boolean` | Whether offensive prayer has been activated this fight |
| `lastAteAt` | `number` | Timestamp of last food use; prevents eat-spam |

**Editing thresholds:**
- Eat threshold: `assessAndEat()` — `eatThreshold = inCombat ? 0.5 : 0.7` (50%/70% HP)
- Eat cooldown: `EAT_COOLDOWN_MS = inCombat ? 6000 : 12000`
- Re-engage interval: `RE_ENGAGE_INTERVAL_MS = 16000` (constant in `pickBehaviorAction`)
- Combat-distance mob scan: `entity.distance <= 40` in `nearbyMobs` filter
- HP threshold to initiate combat: `healthPercent > 0.5` in `pickCombatOrExplore`, `healthPercent > 0.4` for quest kill stages

### DuelCombatAI — arena combat (600 ms loop)

`packages/server/src/duel/DuelCombatAI.ts`

A dedicated tick-based combat controller used only during streaming duels. Created and owned by `DuelOrchestrator`. Has no knowledge of quests or overworld — pure combat only.

**Config (`DuelCombatConfig`):**

| Field | Default | Purpose |
|-------|---------|---------|
| `combatRole` | `"melee"` | `"melee" \| "ranged" \| "mage"` — determines ideal range and offensive prayer |
| `healThresholdPct` | `40` | Eat food below this HP% |
| `aggressiveThresholdPct` | `70` | Switch to aggressive style above this HP% |
| `defensiveThresholdPct` | `30` | Enter "desperate" phase below this HP% |
| `noFood` | `false` | Skip all food use (for no-food duel rules) |
| `tacticalStrategy` | `undefined` | Strict strategy committed during private preparation; required by current competitive snapshots |
| `movementClampBounds` | `undefined` | Legacy arena bounds clamp (superseded by `setArenaBounds` on the service) |
| `initialStrafeSign` | random | `+1 \| -1` — initial lateral strafe direction; set opposite for each fighter |

**Tick pipeline (in order, runs every 600 ms):**
1. Get game state, check alive
2. Sync active prayers from entity state
3. Track HP deltas (damage dealt/received counters)
4. Get opponent data from `getNearbyEntities()`
5. Determine `CombatPhase`: `opening | trading | finishing | desperate`
6. Activate protection prayer based on opponent's weapon type (fire-and-forget)
7. Trash talk — check HP milestones, ambient taunts
8. `tryHeal()` — context-aware food use; returns early if healed
9. `tryBuff()` — activate offensive prayer at fight start; returns early if buffed
10. `movementTick()` — kite/chase opponent to stay at `IDEAL_RANGE`
11. `maybeReplanStrategyBackground()` / `executeStrategy()` (LLM mode only)
12. `tryAttack()` — re-engage opponent

**Combat phases:**

| Phase | Condition | Effect |
|-------|-----------|--------|
| `opening` | First 5 ticks | Heal threshold unchanged |
| `trading` | Default mid-fight | Standard thresholds |
| `finishing` | Opponent HP < 25% | Lower heal threshold (more aggressive) |
| `desperate` | Own HP < 30% | Raise heal threshold, force defensive prayer |

**Ideal engagement ranges by role:**

| Role | Min distance | Max distance |
|------|-------------|-------------|
| `melee` | 0.8 | 1.8 |
| `ranged` | 5 | 8 |
| `mage` | 5 | 8 |

Movement constants: `MOVE_COOLDOWN_MS = 1200`, `STRAFE_STEP = 1.35` world units.

**Offensive prayers by role:**

| Role | Prayer ID |
|------|-----------|
| `melee` | `superhuman_strength` |
| `ranged` | `hawk_eye` |
| `mage` | `mystic_lore` |

Defensive/protection prayer (always): `rock_skin`. Protection prayers (activated based on opponent weapon type) are separate and fire every tick but no-op if already active.

**Trash talk system:**
- Opening taunt fires at `start()`
- HP milestone taunts fire when own HP or opponent HP crosses 90/80/70/60/50/40/30/20/10%
- Ambient taunts fire every 5–12 ticks randomly
- All taunts are fire-and-forget; `TRASH_TALK_COOLDOWN_MS = 4000`
- With a `chatRuntime` (ElizaOS), taunts use the LLM; fallback arrays are used otherwise

**Adding a new duel rule / config change:**
1. Add the field to `DuelCombatConfig` in `DuelCombatAI.ts`
2. Pass it in `startCombatAIs()` inside `DuelOrchestrator.ts` via `baseAiConfig`
3. Use `process.env.YOUR_FLAG` with a sensible default so it can be toggled without deploys

### DuelOrchestrator — arena lifecycle

`packages/server/src/systems/StreamingDuelScheduler/managers/DuelOrchestrator.ts`

Manages the full duel lifecycle: provisioning agents, teleporting them to the arena, running the fight, resolving the result, and cleaning up.

**Arena mode transition (the critical sequence):**

```
startCombatAIs()
  ├─ service.setArenaBounds(movementClampBounds)   // clamp movement at source
  ├─ service.setAutonomousBehaviorEnabled(false)   // suspend 8s behavior loop
  ├─ DuelCombatAI.start()                          // begin 600ms tick loop
  └─ cache services in _arenaModeServices[]

stopCombatAIs()   (called on fight resolution or destroy)
  ├─ DuelCombatAI.stop()                           // end 600ms tick loop
  ├─ service.clearArenaBounds()                    // restore free movement
  └─ service.setAutonomousBehaviorEnabled(true)    // resume 8s behavior loop
```

**`_arenaModeServices`**: Array of cached service references. Typed as `Array<{ clearArenaBounds(); setAutonomousBehaviorEnabled(enabled) }>`. Both operations are called in `stopCombatAIs()` without needing the dynamic AgentManager import (which is only available in async contexts).

**Duel flags on entity data:**
- `entity.data.inStreamingDuel = true/false` — secondary guard checked by `AgentBehaviorTicker` and `DuelSystem.ejectNonDuelingPlayersFromCombatArenas()`
- `entity.data.preventRespawn = true/false` — prevents normal respawn during a duel
- These are set by `setDuelFlags(inDuel)` and cleared by `clearAllDuelFlags()` / `cleanupAfterDuel()`

**Suppressing teleport effects:**
All housekeeping teleports (arena bounds enforcement, spawn-lock, facing correction) must pass `suppressEffect: true`:
```typescript
this.world.emit("player:teleport", {
  playerId: id,
  position: { x, y, z },
  suppressEffect: true,  // REQUIRED — prevents blue helix VFX
});
```

### Prayer IDs reference

These are the prayer IDs used in `executePrayer(id)` calls:

| ID | Type | Effect |
|----|------|--------|
| `superhuman_strength` | Offensive (melee) | Strength bonus |
| `hawk_eye` | Offensive (ranged) | Ranged attack bonus |
| `mystic_lore` | Offensive (mage) | Magic attack bonus |
| `rock_skin` | Defensive | Defense bonus |
| `protect_from_melee` | Protection | Reduces melee damage |
| `protect_from_missiles` | Protection | Reduces ranged damage |
| `protect_from_magic` | Protection | Reduces magic damage |

### Common edits and where to make them

**Change when agents eat food in general combat:**
→ `assessAndEat()` in `AgentBehaviorTicker.ts` — adjust `eatThreshold` constants

**Change when the DuelCombatAI heals:**
→ `tryHeal()` in `DuelCombatAI.ts` — adjust `this.config.healThresholdPct` or the burst-reactive ease values

**Change how far arena agents strafe/kite:**
→ `DuelCombatAI.IDEAL_RANGE` and `DuelCombatAI.STRAFE_STEP` static fields

**Change how often general combat re-engages stale fights:**
→ `RE_ENGAGE_INTERVAL_MS` constant in `pickBehaviorAction()` in `AgentBehaviorTicker.ts`

**Change the 8-second behavior tick interval:**
→ `EMBEDDED_BEHAVIOR_TICK_INTERVAL` constant at top of `AgentBehaviorTicker.ts`

**Change the DuelCombatAI tick rate:**
→ The `externalTick()` caller in `DuelOrchestrator` controls when ticks fire; look for the combat loop interval there

**Add a new action type to general agent behavior:**
1. Add it to the `EmbeddedBehaviorAction` union type in `AgentBehaviorTicker.ts`
2. Handle it in the `switch (action.type)` in `executeBehaviorTick()`
3. Return it from `pickBehaviorAction()` or `pickQuestAction()`
4. Add the corresponding `execute*()` method to `EmbeddedHyperiaService` if needed

**Add a new service method:**
1. Add the signature to `IEmbeddedHyperiaService` in `types.ts`
2. Implement it in `EmbeddedHyperiaService.ts`
3. The method must emit a world event or call a game system — never mutate state directly

## Additional Resources

- [README.md](README.md) - Full project documentation
- [.cursor/rules/](.cursor/rules/) - Detailed development rules
- [packages/shared/](packages/shared/) - Core engine source
- Game Design Document: See `.cursor/rules/gdd.mdc`
