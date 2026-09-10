import { describe, expect, test } from "vitest";
import * as THREE from "three";
import {
  generateRigidCandidates,
  halton,
  sampleClipTimes,
  searchKnightShortswordPoseFit,
} from "./search-kaykit-shortsword-pose-fit";

describe("bounded Knight wrist-local search foundation, no fit approval", () => {
  test("candidate zero preserves the matrix; subsequent rotations preserve the actual scaled handle pivot", () => {
    const base = new THREE.Matrix4().compose(
      new THREE.Vector3(0.01, 0.17, -0.06),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.2, 1.57)),
      new THREE.Vector3(0.9999999, 1, 1),
    );
    const handle = new THREE.Vector3(0.003, -0.002, 0.001),
      scale = 0.62915218347;
    const candidates = generateRigidCandidates(base, handle, scale, 1024);
    expect(candidates[0].matrix.toArray()).toEqual(base.toArray());
    const pivot = handle.clone().applyMatrix4(base);
    for (const c of candidates) {
      expect(c.rotationDegrees).toBeLessThanOrEqual(20);
      expect(c.translationMetres.every((v) => Math.abs(v) <= 0.012)).toBe(true);
      const actual = handle.clone().applyMatrix4(c.matrix);
      const expected = pivot
        .clone()
        .add(new THREE.Vector3(...c.translationMetres).divideScalar(scale));
      expect(actual.distanceTo(expected)).toBeLessThan(1e-12);
      const originalScale = new THREE.Vector3(),
        candidateScale = new THREE.Vector3();
      base.decompose(
        new THREE.Vector3(),
        new THREE.Quaternion(),
        originalScale,
      );
      c.matrix.decompose(
        new THREE.Vector3(),
        new THREE.Quaternion(),
        candidateScale,
      );
      expect(candidateScale.distanceTo(originalScale)).toBeLessThan(1e-12);
    }
    expect(
      generateRigidCandidates(base, handle, scale, 1024).map((c) =>
        c.matrix.toArray(),
      ),
    ).toEqual(candidates.map((c) => c.matrix.toArray()));
  });
  test("time samples include source keys, observed failure region and one unique endpoint", () => {
    const duration = 1.2333333492279053;
    const samples = sampleClipTimes(duration, [
      0.1,
      0.2,
      0.5550000071525574,
      0.8666666666666667,
      1.0483333468437195,
      duration,
    ]);
    expect(samples[0]).toBe(0);
    expect(samples.at(-1)).toBe(duration);
    expect(samples).toContain(duration - 0.001);
    expect(new Set(samples).size).toBe(samples.length);
    expect(samples.some((t) => Math.abs(t - 0.8666666666666667) < 1e-7)).toBe(
      true,
    );
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i] - samples[i - 1]).toBeGreaterThan(1e-7);
      expect(samples[i] - samples[i - 1]).toBeLessThanOrEqual(1 / 60 + 1e-7);
    }
  });
  test("invalid search bounds and times fail closed", async () => {
    expect(() => halton(-1, 2)).toThrow();
    expect(() => halton(1, 1)).toThrow();
    expect(() => sampleClipTimes(Infinity, [])).toThrow();
    expect(() => sampleClipTimes(1, [NaN])).toThrow();
    expect(() =>
      generateRigidCandidates(new THREE.Matrix4(), new THREE.Vector3(), 0, 1),
    ).toThrow();
    expect(() =>
      generateRigidCandidates(
        new THREE.Matrix4(),
        new THREE.Vector3(),
        1,
        1025,
      ),
    ).toThrow();
    await expect(
      searchKnightShortswordPoseFit({ cpuBudgetMs: 90001 }),
    ).rejects.toThrow("90 seconds");
    await expect(
      searchKnightShortswordPoseFit({ candidateCount: 1025 }),
    ).rejects.toThrow("candidate budget");
    await expect(
      searchKnightShortswordPoseFit({ candidateCount: 0 }),
    ).rejects.toThrow("candidate budget");
  });
  test("actual frozen Knight baseline reproduces recovery failure with every avatar triangle accounted for", async () => {
    const report = await searchKnightShortswordPoseFit({
      candidateCount: 1,
      cpuBudgetMs: 10_000,
    });
    expect(report.status).toBe(
      "no-feasible-transform-found-among-tested-candidates",
    );
    expect(report.productApproved).toBe(false);
    expect(report.evaluated).toBe(1);
    expect(report.attempted).toBe(1);
    expect(report.coverage).toEqual({
      coarsePoseTests: 1,
      densePoseTests: 0,
      interruptedCandidate: null,
    });
    expect(report.feasible).toBeNull();
    expect(report.rejections).toMatchObject([
      {
        index: 0,
        predicate: "handle-contact",
        pose: "sword:1.048333347",
        passedCoarsePoses: 0,
      },
    ]);
    expect(report.inputHashes.semanticDefinition).toBe(
      "a6a8c5ee5749c9af4f35f4aa456a9c82e1562ce3e82364aec9bc58a248114182",
    );
    expect(report.membership).toHaveLength(9);
    expect(
      report.membership!.reduce((sum, mesh) => sum + mesh.handTriangles, 0),
    ).toBe(136);
    expect(
      report.membership!.reduce(
        (sum, mesh) => sum + mesh.forbiddenTriangles,
        0,
      ),
    ).toBe(5664);
    for (const mesh of report.membership!) {
      const indices = [
        ...mesh.allowedSourceTriangleIndices,
        ...mesh.forbiddenSourceTriangleIndices,
      ].sort((a, b) => a - b);
      expect(indices).toEqual(
        Array.from(
          { length: mesh.handTriangles + mesh.forbiddenTriangles },
          (_, i) => i,
        ),
      );
      if (mesh.handTriangles) expect(mesh.mesh).toBe("Knight_ArmRight");
    }
    for (const pose of report.coarsePoses) {
      expect(pose.initialHeight).toBeCloseTo(2.5431048990015626, 10);
      expect(pose.normalizationScale).toBeCloseTo(0.6291521834699658, 10);
      expect(pose.handTriangleCount).toBe(136);
      expect(pose.forbiddenTriangleCount).toBe(5664);
    }
  }, 15_000);
  test("deadline exhaustion never claims an untested candidate or clip was evaluated", async () => {
    const report = await searchKnightShortswordPoseFit({
      candidateCount: 1,
      cpuBudgetMs: 0.000001,
    });
    expect(report.status).toBe("budget-exhausted-no-approved-fit");
    expect(report.evaluated).toBe(0);
    expect(report.attempted).toBe(0);
    expect(report.feasible).toBeNull();
    expect(report.coverage.coarsePoseTests).toBe(0);
    expect(report.coverage.densePoseTests).toBe(0);
  });
});
