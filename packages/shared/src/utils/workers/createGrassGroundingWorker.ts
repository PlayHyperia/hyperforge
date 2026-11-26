import type { GrassGroundingWorkerPort } from "./GrassGroundingWorkerClient";

/** Shared libraries are flattened into build/framework*.js. This dedicated
 * fully bundled sibling is emitted by shared build/watch and then resolved as
 * a Worker asset by Vite. Do not point the flattened library at a source .ts URL. */
export function createGrassGroundingWorker(): GrassGroundingWorkerPort {
  return new Worker(new URL("./grass-grounding.worker.js", import.meta.url), {
    type: "module",
    name: "hyperia-grass-grounding",
  });
}
