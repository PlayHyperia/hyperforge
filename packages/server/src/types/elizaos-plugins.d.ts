/**
 * Ambient module declarations for ElizaOS plugins.
 *
 * These serve two purposes:
 *
 * 1. Fix broken upstream type chains where .d.ts re-exports point to missing files:
 *    - plugin-anthropic@2.0.0-alpha.6  (index.node.d.ts missing)
 *    - plugin-sql@2.0.0-alpha.12       (index.node.d.ts missing)
 *    - plugin-trajectory-logger@2.0.0-alpha.11 (no .d.ts files at all)
 *
 * 2. Unify Plugin types across version mismatches: plugins depend on different
 *    @elizaos/core versions (alpha.3, alpha.10) while the server uses alpha.12.
 *    By importing Plugin from @elizaos/core here, all declarations reference the
 *    server's resolved version, avoiding structural incompatibilities.
 *
 * These declarations can be removed once upstream packages ship correct .d.ts
 * files and align on a single @elizaos/core version.
 */

declare module "@elizaos/plugin-openai" {
  import type { Plugin } from "@elizaos/core";

  export const openaiPlugin: Plugin;
  const _default: Plugin;
  export default _default;
}

declare module "@elizaos/plugin-anthropic" {
  import type { Plugin } from "@elizaos/core";

  export const anthropicPlugin: Plugin;
  const _default: Plugin;
  export default _default;
}

declare module "@elizaos/plugin-sql" {
  import type { Plugin } from "@elizaos/core";

  export const plugin: Plugin;
  const _default: Plugin;
  export default _default;
}

declare module "@elizaos/plugin-local-embedding" {
  import type { Plugin } from "@elizaos/core";

  export const localAiPlugin: Plugin;
  const _default: Plugin;
  export default _default;
}

declare module "@elizaos/plugin-trajectory-logger" {
  import type { Plugin, IAgentRuntime } from "@elizaos/core";

  export class TrajectoryLoggerService {
    startTrajectory(contextId: string): string;
    wrapPlugin(plugin: Plugin): Plugin;
  }

  export class RewardService {}

  export function wrapPluginActions(
    plugin: Plugin,
    logger: TrajectoryLoggerService,
  ): Plugin;

  export function wrapPluginProviders(
    plugin: Plugin,
    logger: TrajectoryLoggerService,
  ): Plugin;

  export function setTrajectoryContext(
    runtime: IAgentRuntime,
    trajectoryId: string,
    logger: TrajectoryLoggerService,
  ): void;

  export function getTrajectoryContext(
    runtime: IAgentRuntime,
  ): { trajectoryId: string; logger: TrajectoryLoggerService } | undefined;

  export function clearTrajectoryContext(runtime: IAgentRuntime): void;

  export const trajectoryLoggerPlugin: Plugin;
  const _default: Plugin;
  export default _default;
}

declare module "@elizaos/plugin-trajectory-logger" {
  import type { Plugin } from "@elizaos/core";

  export class TrajectoryLoggerService {
    wrapPlugin(plugin: Plugin): Plugin;
  }
  export class RewardService {}

  export const trajectoryLoggerPlugin: Plugin | undefined;
  const _default: Plugin;
  export default _default;
}
