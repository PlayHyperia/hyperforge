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
for (const blend of [0, 0.5, 1.5, 12])
  for (const peak of [0, 0.5, 0.8, 0.95, 1])
    for (let z = -15; z <= 15; z += 0.125)
      queries.push([-100, z, -110, 0, -90, 0, 0.65, blend, peak]);

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
  it("weights a complete capsule without changing legacy defaults or adding overlapping peaks", () => {
    for (const row of queries) {
      const [x, z, ax, az, bx, bz, width, blend, peak = 1] = row;
      const legacy = operations.sampleSegment(
        x,
        z,
        ax,
        az,
        bx,
        bz,
        width,
        blend,
      );
      expect(operations.sampleSegment(...row)).toBe(legacy * peak);
      expect(
        operations.sampleSegment(x, z, ax, az, bx, bz, width, blend, 1),
      ).toBe(legacy);
    }
    expect(
      operations.sampleSegment(0, 1.075, -10, 0, 10, 0, 0.65, 1.5, 0.6),
    ).toBeCloseTo(0.3, 14);
    expect(operations.sampleSegment(0, 0, -10, 0, 10, 0, 0.65, 1.5, 0)).toBe(0);
    // The union uses max, so two intersecting wear profiles never create a
    // grass-free core by summing their individual partial influence.
    expect(
      Math.max(
        operations.sampleSegment(0, 0, -10, 0, 10, 0, 0.65, 1.5, 0.6),
        operations.sampleSegment(0, 0, 0, -10, 0, 10, 0.7, 1.25, 0.55),
      ),
    ).toBe(0.6);
  });

  it("inverts the same threshold for blade exclusion, including partial and hard-edge profiles", () => {
    for (const peak of [0, 0.5, 0.8])
      expect(operations.getExclusionFeather(1.5, peak)).toBeNull();
    expect(operations.getExclusionFeather(0, 1)).toBe(0);
    for (const blend of [0.5, 1.25, 10])
      for (const peak of [0.81, 0.9, 1]) {
        const feather = operations.getExclusionFeather(blend, peak)!;
        expect(feather).toBeGreaterThan(0);
        expect(feather).toBeLessThan(blend);
        const sample = (offset: number) =>
          operations.sampleSegment(
            0,
            1 + feather + offset,
            -10,
            0,
            10,
            0,
            2,
            blend,
            peak,
          );
        expect(sample(0)).toBeCloseTo(0.8, 12);
        expect(sample(-1e-6)).toBeGreaterThan(0.8);
        expect(sample(1e-6)).toBeLessThan(0.8);
      }
  });

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
