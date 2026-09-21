import { BufferAttribute } from "three/src/core/BufferAttribute.js";
import { describe, expect, it } from "vitest";
import { createGrassTerrainSurfaceOperations } from "../../../../utils/workers/GrassTerrainSurfaceSnapshot";
import {
  GRASS_BLADE_GROUNDING_JOB_LIMITS,
  GRASS_BLADE_GROUNDING_LIMITS,
  captureGrassBankVerge,
  type GrassGroundingConsumedWork,
  type GrassGroundingRoadSegment,
} from "../GrassBladeGrounding";
import {
  GrassGroundingPreparationContinuation,
  prepareGrassGroundingHandoffSteps,
  type GrassGroundingHandoffRequest,
  type GrassGroundingPreparedInput,
} from "../GrassGroundingHandoff";
import type { GrassGroundingInputLease } from "../GrassGroundingPipeline";
import { projectGrassAnchors } from "../GrassTerrainProjection";
import {
  createSameFaceCase,
  sameFaceInputHash,
  type SameFaceCase,
} from "./fixtures/GrassBladeGroundingSameFaceCases";

type Fixture = ReturnType<typeof createSameFaceCase>;
const dataFields = [
  "offsets",
  "rotScaleHash",
  "groundColors",
  "grassTints",
  "groundNormals",
] as const;
const dry = () => -1000;
const allowed = () => false;

/** Real snapshot cloning kernel and a real one-use generator lease. The epoch
 * belongs to this authored test world; no manager or numerical method doubles. */
function inputLease(fixture: Fixture, epoch = { current: true }) {
  const events: string[] = [];
  const inputs: GrassGroundingInputLease = {
    isCurrent: () => epoch.current,
    steps: (function* () {
      events.push("started");
      try {
        const terrainSurface =
          yield* createGrassTerrainSurfaceOperations().cloneSnapshotSteps(
            fixture.request.terrainSurface,
          );
        const roadSegments: GrassGroundingRoadSegment[] = [];
        for (const road of fixture.request.roadSegments) {
          yield "test_road_snapshot";
          roadSegments.push({ ...road });
        }
        return { terrainSurface, roadSegments };
      } finally {
        events.push("closed");
      }
    })(),
  };
  return { inputs, epoch, events };
}

function createJob(
  fixture: Fixture,
  options: {
    maximumInputBytes?: number;
    consumed?: GrassGroundingConsumedWork;
    isExcluded?: (x: number, z: number) => boolean;
  } = {},
) {
  const lease = inputLease(fixture);
  const steps = prepareGrassGroundingHandoffSteps(
    fixture.request,
    lease.inputs,
    dry,
    options.isExcluded ?? allowed,
    options.maximumInputBytes,
  );
  const job = new GrassGroundingPreparationContinuation(
    steps,
    () => lease.inputs.isCurrent(),
    options.consumed,
  );
  return { job, steps, ...lease };
}

function finish(job: GrassGroundingPreparationContinuation) {
  for (let i = 0; i < 1_000_000 && job.state.status === "running"; i++)
    job.advance(64);
  if (job.state.status === "running")
    throw new Error(
      "Handoff fixture did not terminate within bounded operations",
    );
  return job.state;
}

function prepared(
  job: GrassGroundingPreparationContinuation,
): GrassGroundingPreparedInput {
  const state = finish(job);
  if (state.status !== "prepared")
    throw new Error("Expected prepared handoff: " + JSON.stringify(state));
  expect("result" in state).toBe(false);
  return state.prepared;
}

function atPhase(job: GrassGroundingPreparationContinuation, phase: string) {
  for (let i = 0; i < 100_000; i++) {
    job.advance(1);
    if (job.state.status !== "running")
      throw new Error("Handoff ended before " + phase);
    if (job.lastPhase === phase) return;
  }
  throw new Error("Handoff phase was not reached: " + phase);
}

function payloadArrays(value: GrassGroundingPreparedInput) {
  return [
    ...dataFields.map((key) => value.data[key]),
    value.geometry.position,
    value.geometry.normal,
    value.geometry.uv,
    value.geometry.index,
  ];
}

describe("real main-thread grass grounding handoff preparation", () => {
  it.each<SameFaceCase>([
    "ordinary-lod0",
    "ordinary-lod1",
    "ordinary-lod2",
    "fine-lod0",
    "fine-lod1",
    "fine-lod2",
    "fine-near4",
    "refined-interiors",
    "adjacent-owners",
    "empty",
  ])(
    "preserves exact projection, source ownership and ecological grounding for %s",
    (id) => {
      const fixture = createSameFaceCase(id);
      try {
        // Computed heights and ecological normals intentionally differ from
        // mesh-fitted values so reprojection provenance is not an empty check.
        for (let i = 0; i < fixture.request.data.count; i++) {
          fixture.request.data.offsets[i * 3 + 1] = 30.25 + i;
          fixture.request.data.groundNormals.set([0.6, 0.8, 0], i * 3);
        }
        const original = sameFaceInputHash(fixture);
        const excluded = (x: number) => x < -10;
        const expected = projectGrassAnchors(
          fixture.request.data,
          fixture.request.ownSurface,
          dry,
          excluded,
        );
        const value = prepared(
          createJob(fixture, { isExcluded: excluded }).job,
        );
        expect(value.data.count).toBe(expected.count);
        for (const key of dataFields) {
          expect(value.data[key]).toEqual(expected[key]);
          expect(value.data[key].byteOffset).toBe(0);
          expect(value.data[key].byteLength).toBe(
            value.data[key].buffer.byteLength,
          );
          expect(value.data[key].buffer).not.toBe(
            fixture.request.data[key].buffer,
          );
        }
        expect(value.grounding).toEqual(expected.grounding);
        expect(value.ownSurface).toBe(fixture.request.ownSurface);
        expect(value.surfaces).toEqual(fixture.request.surfaces);
        expect(value.surfaces).not.toBe(fixture.request.surfaces);
        expect(value.constraints).toEqual({
          terrainSurface: fixture.request.terrainSurface,
          roadSegments: fixture.request.roadSegments,
        });
        expect(value.inputBytes).toBe(
          payloadArrays(value).reduce(
            (bytes, array) => bytes + array.byteLength,
            0,
          ),
        );
        const transfer = payloadArrays(value).map((array) => {
          if (!(array.buffer instanceof ArrayBuffer))
            throw new Error("Expected transferable owned copy");
          return array.buffer;
        });
        expect(new Set(transfer).size).toBe(9);
        expect(transfer).not.toContain(value.grounding.computedHeights.buffer);
        expect(transfer).not.toContain(
          value.grounding.ecologicalNormals.buffer,
        );
        structuredClone(
          { data: value.data, geometry: value.geometry },
          { transfer },
        );
        expect(transfer.every((buffer) => buffer.byteLength === 0)).toBe(true);
        expect(value.grounding).toEqual(expected.grounding);
        expect(sameFaceInputHash(fixture)).toBe(original);
        for (const owner of fixture.owned)
          expect(owner.surface.matchesGeometry(owner.geometry)).toBe(true);
      } finally {
        fixture.dispose();
      }
    },
  );

  it("copies source subarrays and compacted projections into independent exact-sized views", () => {
    const fixture = createSameFaceCase("fine-lod0");
    try {
      for (const name of ["position", "normal", "uv"] as const) {
        const attribute = fixture.request.geometry.getAttribute(name);
        if (!(attribute.array instanceof Float32Array))
          throw new Error("Expected real float blade attribute");
        const padded = new Float32Array(attribute.array.length + 8);
        padded.fill(12345);
        padded.set(attribute.array, 4);
        fixture.request.geometry.setAttribute(
          name,
          new BufferAttribute(
            padded.subarray(4, padded.length - 4),
            attribute.itemSize,
          ),
        );
      }
      for (const key of dataFields) {
        const padded = new Float32Array(fixture.request.data[key].length + 8);
        padded.fill(12345);
        padded.set(fixture.request.data[key], 4);
        fixture.request.data[key] = padded.subarray(4, padded.length - 4);
      }
      const sourceIndex = fixture.request.geometry.getIndex();
      if (!sourceIndex || !(sourceIndex.array instanceof Uint16Array))
        throw new Error("Expected small Uint16 blade index");
      const paddedIndex = new Uint16Array(sourceIndex.array.length + 8);
      paddedIndex.set(sourceIndex.array, 4);
      fixture.request.geometry.setIndex(
        new BufferAttribute(paddedIndex.subarray(4, paddedIndex.length - 4), 1),
      );
      const expected = projectGrassAnchors(
        fixture.request.data,
        fixture.request.ownSurface,
        dry,
        (x) => x < 0,
      );
      const value = prepared(
        createJob(fixture, { isExcluded: (x) => x < 0 }).job,
      );
      expect(value.data.count).toBeLessThan(fixture.request.data.count);
      for (const key of dataFields)
        expect(value.data[key]).toEqual(expected[key]);
      for (const [name, copy] of [
        ["position", value.geometry.position],
        ["normal", value.geometry.normal],
        ["uv", value.geometry.uv],
      ] as const)
        expect(copy).toEqual(fixture.request.geometry.getAttribute(name).array);
      expect(value.geometry.index).toEqual(
        fixture.request.geometry.getIndex()?.array,
      );
      for (const array of payloadArrays(value)) {
        expect(array.byteOffset).toBe(0);
        expect(array.byteLength).toBe(array.buffer.byteLength);
      }
    } finally {
      fixture.dispose();
    }
  });

  it("copies a maximum-capacity projection through exactly bounded 1024-element steps", () => {
    const fixture = createSameFaceCase("fine-lod2");
    try {
      const count = GRASS_BLADE_GROUNDING_LIMITS.maxClumps;
      for (const key of dataFields) {
        const stride = key === "grassTints" ? 4 : 3;
        const first = fixture.request.data[key].slice(0, stride);
        const array = new Float32Array(count * stride);
        for (let i = 0; i < count; i++) array.set(first, i * stride);
        fixture.request.data[key] = array;
      }
      fixture.request.data.count = count;
      const { steps } = createJob(fixture);
      const phases = new Map<string, number>();
      let step = steps.next();
      while (!step.done) {
        phases.set(step.value, (phases.get(step.value) ?? 0) + 1);
        step = steps.next();
      }
      const value = step.value;
      expect(value.data.count).toBe(count);
      for (const key of dataFields) {
        expect(phases.get("handoff_data_" + key + "_allocation")).toBe(1);
        expect(phases.get("handoff_data_" + key + "_copy")).toBe(
          Math.ceil(value.data[key].length / 1024),
        );
      }
      for (const key of ["position", "normal", "uv", "index"] as const) {
        expect(phases.get("handoff_geometry_" + key + "_allocation")).toBe(1);
        expect(phases.get("handoff_geometry_" + key + "_copy")).toBe(
          Math.ceil(value.geometry[key].length / 1024),
        );
      }
      expect(value.inputBytes).toBe(
        payloadArrays(value).reduce(
          (bytes, array) => bytes + array.byteLength,
          0,
        ),
      );
      expect(value.grounding.computedHeights.length).toBe(count);
    } finally {
      fixture.dispose();
    }
  });

  it("preserves a real Uint32 blade index without transferring its source buffer", () => {
    const fixture = createSameFaceCase("fine-lod0");
    try {
      const index = fixture.request.geometry.getIndex();
      if (!index) throw new Error("Expected real indexed blade");
      const source = Uint32Array.from(index.array);
      fixture.request.geometry.setIndex(new BufferAttribute(source, 1));
      const value = prepared(createJob(fixture).job);
      expect(value.geometry.index).toBeInstanceOf(Uint32Array);
      expect(value.geometry.index).toEqual(source);
      expect(value.geometry.index.buffer).not.toBe(source.buffer);
    } finally {
      fixture.dispose();
    }
  });

  it("rejects a source above the clump cap before resuming its constraints lease", () => {
    const fixture = createSameFaceCase("fine-lod1");
    try {
      fixture.request.data.count = GRASS_BLADE_GROUNDING_LIMITS.maxClumps + 1;
      const { job, events } = createJob(fixture);
      expect(finish(job).status).toBe("failed_input");
      expect(events).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it.each([
    "attribute",
    "array",
    "version",
    "index",
    "draw-range",
    "groups",
    "morph",
    "source-array",
    "surface-order",
  ] as const)(
    "fails stale %s at a guarded copy boundary without producing a handoff",
    (kind) => {
      const fixture = createSameFaceCase("adjacent-owners");
      try {
        const { job } = createJob(fixture);
        atPhase(job, "handoff_geometry_position_copy");
        const position = fixture.request.geometry.getAttribute("position");
        if (
          !(position.array instanceof Float32Array) ||
          !("version" in position)
        )
          throw new Error("Expected real blade position");
        if (kind === "attribute")
          fixture.request.geometry.setAttribute(
            "position",
            new BufferAttribute(position.array.slice(), 3),
          );
        if (kind === "array") position.array = position.array.slice();
        if (kind === "version") position.needsUpdate = true;
        if (kind === "index")
          fixture.request.geometry.getIndex()!.needsUpdate = true;
        if (kind === "draw-range")
          fixture.request.geometry.setDrawRange(1, Infinity);
        if (kind === "groups") fixture.request.geometry.addGroup(0, 3);
        if (kind === "morph")
          fixture.request.geometry.morphAttributes.position = [];
        if (kind === "source-array")
          fixture.request.data.offsets = fixture.request.data.offsets.slice();
        if (kind === "surface-order")
          fixture.request.surfaces = [...fixture.request.surfaces].reverse();
        const state = finish(job);
        expect(state.status).toBe("failed_input");
        expect("prepared" in state).toBe(false);
      } finally {
        fixture.dispose();
      }
    },
  );

  it("cancels during the real input lease and closes its generator", () => {
    const fixture = createSameFaceCase("mixed-exclusions");
    try {
      const { job, events } = createJob(fixture);
      for (let i = 0; i < 1000 && !events.includes("started"); i++)
        job.advance(1);
      expect(events).toContain("started");
      expect(job.cancel()).toEqual({ status: "cancelled", reason: "caller" });
      expect(events).toContain("closed");
      const operations = job.operations;
      expect(job.advance()).toEqual({ status: "cancelled", reason: "caller" });
      expect(job.operations).toBe(operations);
    } finally {
      fixture.dispose();
    }
  });

  it("invalidates a changed complete lease before copying or returning prepared data", () => {
    const fixture = createSameFaceCase("fine-lod0");
    try {
      const { job, epoch } = createJob(fixture);
      atPhase(job, "handoff_data_offsets_copy");
      epoch.current = false;
      expect(job.advance()).toEqual({
        status: "cancelled",
        reason: "invalidated",
      });
    } finally {
      fixture.dispose();
    }
  });

  it.each([-1, 0, 1] as const)(
    "enforces the exact projected payload bound with %+i byte slack",
    (slack) => {
      const fixture = createSameFaceCase("fine-lod1");
      try {
        const baseline = prepared(createJob(fixture).job);
        const state = finish(
          createJob(fixture, { maximumInputBytes: baseline.inputBytes + slack })
            .job,
        );
        expect(state.status).toBe(slack < 0 ? "failed_input" : "prepared");
        if (state.status === "prepared")
          expect(state.prepared.inputBytes).toBe(baseline.inputBytes);
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each([
    {
      operations: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations,
      activeMs: 0,
      maximumSliceMs: 0,
      reason: "operations",
    },
    {
      operations: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations - 1,
      activeMs: 0,
      maximumSliceMs: 0,
      reason: "operations",
    },
    {
      operations: 37,
      activeMs: GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumActiveMs,
      maximumSliceMs: 1.25,
      reason: "active_cpu",
    },
  ] as const)(
    "preserves exhausted cumulative $reason across the handoff preparation",
    ({ reason, ...consumed }) => {
      const fixture = createSameFaceCase("fine-lod1");
      try {
        const { job } = createJob(fixture, { consumed });
        expect(finish(job)).toEqual({ status: "failed_budget", reason });
        expect(job.operations).toBeGreaterThanOrEqual(consumed.operations);
        expect(job.operations).toBeLessThanOrEqual(
          GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumOperations,
        );
        expect(job.activeMs).toBeGreaterThanOrEqual(consumed.activeMs);
        expect(job.maximumSliceMs).toBeGreaterThanOrEqual(
          consumed.maximumSliceMs,
        );
      } finally {
        fixture.dispose();
      }
    },
  );

  it("preserves nonexhausted work and honors operation/deadline bounds without fake clocks", () => {
    const fixture = createSameFaceCase("fine-lod1");
    try {
      const { job } = createJob(fixture, {
        consumed: { operations: 37, activeMs: 12.5, maximumSliceMs: 1.25 },
      });
      expect(job.advance(1, 0)).toEqual({ status: "running" });
      expect(job.operations).toBe(37);
      expect(job.lastSliceOperations).toBe(0);
      job.advance(1);
      expect(job.operations).toBe(38);
      expect(job.lastSliceOperations).toBe(1);
      expect(() => job.advance(0)).toThrow();
      expect(() =>
        job.advance(
          GRASS_BLADE_GROUNDING_JOB_LIMITS.maximumSliceOperations + 1,
        ),
      ).toThrow();
      expect(() => job.advance(1, Number.NaN)).toThrow();
      prepared(job);
      expect(job.operations).toBeGreaterThan(38);
      expect(job.activeMs).toBeGreaterThanOrEqual(12.5);
      expect(job.maximumSliceMs).toBeGreaterThanOrEqual(1.25);
    } finally {
      fixture.dispose();
    }
  });

  it("captures optional art settings once rather than borrowing mutable nested descriptors", () => {
    const fixture = createSameFaceCase("fine-lod1");
    try {
      const bankVerge = {
        minX: -10,
        maxX: 10,
        minZ: -10,
        maxZ: 10,
        feather: 2,
        wearStart: 0.1,
        wearEnd: 0.9,
        minimumScale: 0.5,
        heightScale: 0.7,
        wornHeightScale: 0.4,
        tipBrightness: 1,
        grassTint: [1, 1, 1] as [number, number, number],
        wear: [],
      } satisfies NonNullable<GrassGroundingHandoffRequest["bankVerge"]>;
      fixture.request.bankVerge = bankVerge;
      fixture.request.roadClearance = "per-blade-v1";
      const expected = captureGrassBankVerge(fixture.request);
      const { job } = createJob(fixture);
      job.advance(1);
      bankVerge.grassTint[0] = 0.3;
      bankVerge.heightScale = 0.2;
      fixture.request.wind.x = 0;
      const value = prepared(job);
      expect(value.settings.bankVerge).toEqual(expected);
      expect(value.settings.bankVerge).not.toBe(bankVerge);
      expect(value.settings.roadClearance).toBe("per-blade-v1");
      expect(value.settings.wind.x).toBe(0.4);
    } finally {
      fixture.dispose();
    }
  });
});
