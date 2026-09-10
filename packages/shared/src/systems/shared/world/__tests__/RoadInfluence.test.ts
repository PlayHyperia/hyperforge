import { describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { transform } from "esbuild";
import { createRoadInfluenceOperations } from "../RoadInfluence";

const operations = createRoadInfluenceOperations();
type Query = Parameters<typeof operations.sampleSegment>;
const queries: Query[] = [];
for (let x = -12; x <= 12; x += 0.75)
  for (let z = -5; z <= 5; z += 0.25)
    queries.push([x, z, -10, 0, 10, 0, 1.8, 0.5]);

async function inWorker(factorySource: string): Promise<number[]> {
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
    const operations = (${factorySource})();
    parentPort.on("message", rows => parentPort.postMessage(rows.map(row => operations.sampleSegment(...row))));`,
    { eval: true },
  );
  try {
    return await new Promise<number[]>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("message", resolve);
      worker.postMessage(queries);
    });
  } finally {
    await worker.terminate();
  }
}

describe("shared road influence arithmetic", () => {
  it("has the GPU mask kernel's core, edge and degenerate-segment semantics", () => {
    expect(operations.sampleSegment(0, 3, -10, 0, 10, 0, 6, 0.5)).toBe(1);
    expect(operations.sampleSegment(0, 3.25, -10, 0, 10, 0, 6, 0.5)).toBe(0.5);
    expect(operations.sampleSegment(0, 3.5, -10, 0, 10, 0, 6, 0.5)).toBe(0);
    expect(operations.sampleSegment(0, 3, -10, 0, 10, 0, 6, 0)).toBe(0);
    expect(operations.sampleSegment(0, 0, 0, 0, 0.001, 0.001, 2, 0.5)).toBe(1);
    expect(operations.sampleSegment(1000, 1000, -10, 0, 10, 0, 6, 0.5)).toBe(0);
    for (const row of queries)
      expect(operations.sampleSegment(...row)).toBeGreaterThanOrEqual(0);
    for (const row of queries)
      expect(operations.sampleSegment(...row)).toBeLessThanOrEqual(1);
  });

  it("runs the same self-contained factory in a real isolated Node worker", async () => {
    expect(await inWorker(createRoadInfluenceOperations.toString())).toEqual(
      queries.map((row) => operations.sampleSegment(...row)),
    );
  });

  it("remains source-isolated after actual esbuild minification and keepNames", async () => {
    const code = readFileSync(
      new URL("../RoadInfluence.ts", import.meta.url),
      "utf8",
    );
    const output = await transform(code, {
      loader: "ts",
      format: "esm",
      minify: true,
      keepNames: true,
      target: "es2022",
    });
    const module = (await import(
      "data:text/javascript;base64," +
        Buffer.from(output.code).toString("base64")
    )) as {
      createRoadInfluenceOperations: typeof createRoadInfluenceOperations;
    };
    expect(
      await inWorker(module.createRoadInfluenceOperations.toString()),
    ).toEqual(queries.map((row) => operations.sampleSegment(...row)));
  });
});
