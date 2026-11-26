export function classifyMemoryProcess(command) {
  if (
    command.includes("stream-to-rtmp") ||
    command.includes("RTMPBridge") ||
    command.includes("playwright")
  ) {
    return "streaming";
  }
  if (
    command.includes("start-hyperia-server.mjs") ||
    command.includes("packages/server/dist") ||
    command.includes("packages/server")
  ) {
    return "server";
  }
  if (command.includes("vite") || command.includes("packages/client")) {
    return "client";
  }
  if (command.includes("turbo")) return "orchestrator";
  if (command.includes("packages/shared")) return "shared";
  return "other";
}

/**
 * Whole-process-tree totals are not comparable while compilers are exiting or
 * services are shutting down. A runtime sample begins only once the real
 * server process is present and its streaming metrics endpoint answers.
 */
export function isSteadyStateMemorySample(sample) {
  return (
    sample?.streaming?.metrics != null &&
    sample.processes?.some((process) => process.role === "server") === true
  );
}
