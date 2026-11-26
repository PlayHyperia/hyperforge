/**
 * Agent Behavior Worker — runs agent AI decisions off the main thread.
 *
 * This worker receives game state snapshots from the main thread,
 * makes agent behavior decisions (quest/inventory/combat/movement),
 * and sends back action commands to be executed on the main thread.
 *
 * The game tick loop on the main thread is NEVER blocked by agent AI.
 */

import { parentPort } from "node:worker_threads";
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
} from "./workerTypes.js";
import { initializeItems, processAgentTicks } from "./AgentBehaviorEngine.js";

if (!parentPort) {
  throw new Error(
    "[AgentBehaviorWorker] Must be run as a worker thread, not main thread",
  );
}

const port = parentPort;

function send(msg: WorkerToMainMessage): void {
  port.postMessage(msg);
}

port.on("message", (msg: MainToWorkerMessage) => {
  switch (msg.type) {
    case "init": {
      initializeItems(msg.itemsData, msg.processingRecipes);
      send({ type: "ready" });
      break;
    }

    case "tick": {
      try {
        // Populate shared data into each agent's input (sent once to avoid
        // structured clone duplicating large arrays N times)
        const shared = msg.shared;
        for (const agent of msg.agents) {
          agent.npcPositions = shared.npcPositions;
          agent.otherAgentTargets = shared.otherAgentTargets;
          agent.resourceSystemAvailable = shared.resourceSystemAvailable;
          agent.spawnAnchors = shared.spawnAnchors;
          agent.worldResources = shared.worldResources;
          agent.worldMobs = shared.worldMobs;
          agent.stationPositions = shared.stationPositions;
          agent.storePositions = shared.storePositions;
        }
        const results = processAgentTicks(msg.agents);
        send({ type: "tickResults", results });
      } catch (err) {
        send({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case "shutdown": {
      process.exit(0);
    }
  }
});

// Signal that the worker script loaded (init data comes separately)
console.log("[AgentBehaviorWorker] Worker thread started");
