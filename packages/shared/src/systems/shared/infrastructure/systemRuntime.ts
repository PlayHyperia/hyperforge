export type SystemRuntimeKind = "client" | "server";

export interface SystemRuntimePolicy {
  client: boolean;
  server: boolean;
}

/**
 * Resolve registration policy before a network system exists.
 *
 * World.isClient intentionally defaults to true while the world is being
 * assembled, so it cannot identify a headless server until ServerNetwork is
 * registered later by the server package.
 */
export function getSystemRuntimePolicy(
  runtimeKind: SystemRuntimeKind,
): SystemRuntimePolicy {
  return runtimeKind === "server"
    ? { client: false, server: true }
    : { client: true, server: false };
}
