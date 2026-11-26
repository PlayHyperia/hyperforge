/** Bounded shutdown progress, not proof that cleanup or persistence succeeded. */
export type ShutdownDiagnosticStage =
  | "alert"
  | "websocket-ingress"
  | "duel-terminal-barrier"
  | "stream-capture"
  | "http-close"
  | "agents"
  | "agent-thoughts"
  | "web3"
  | "oracle"
  | "player-persistence"
  | "database-pending"
  | "global-services"
  | "world"
  | "database-close"
  | "postgres-stop"
  | "memory-monitor"
  | "startup-flag"
  | "exit-timer";

export function createShutdownDiagnostics() {
  const started = performance.now();
  let sequence = 0;
  const record = (
    stage: ShutdownDiagnosticStage,
    phase: "enter" | "returned" | "threw" | "scheduled" | "fired",
  ): void => {
    // Eighteen stages, two records each, plus the final timer marker. Neither
    // diagnostic I/O nor arbitrary exception text may change shutdown policy.
    if (sequence >= 40) return;
    sequence++;
    try {
      process.stdout.write(
        JSON.stringify({
          event: "server-shutdown-stage",
          schemaVersion: 1,
          pid: process.pid,
          sequence,
          stage,
          phase,
          at: Date.now(),
          elapsedMs: performance.now() - started,
        }) + "\n",
      );
    } catch {
      // The existing shutdown result, not logging availability, owns exit.
    }
  };
  return {
    record,
    async run<T>(
      stage: ShutdownDiagnosticStage,
      operation: () => T | Promise<T>,
    ) {
      record(stage, "enter");
      try {
        const result = await operation();
        // "returned" deliberately does not claim success: existing cleanup
        // operations may catch/report errors themselves, as before.
        record(stage, "returned");
        return result;
      } catch (error) {
        record(stage, "threw");
        throw error;
      }
    },
  };
}
