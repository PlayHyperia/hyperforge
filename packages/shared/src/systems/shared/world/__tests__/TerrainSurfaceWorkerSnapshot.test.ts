import { BufferAttribute, BufferGeometry } from "three";
import { describe, expect, it } from "vitest";
import {
  RetainedTerrainSurface,
  type RetainedTerrainSurfaceSnapshot,
  type TerrainCellTopology,
} from "../TerrainGridSurface";
import { gridGeometry } from "./terrain-grid.fixture";

type SnapshotSteps = Generator<string, RetainedTerrainSurfaceSnapshot, void>;

function finish(steps: SnapshotSteps) {
  const phases: string[] = [];
  for (let count = 0; count < 10000; count++) {
    const step = steps.next();
    if (step.done) return { snapshot: step.value, phases };
    phases.push(step.value);
  }
  throw new Error("Snapshot fixture did not finish within its step bound");
}

function pauseAt(steps: SnapshotSteps, phase: string, occurrence = 1) {
  for (let count = 0; count < 10000; count++) {
    const step = steps.next();
    if (step.done) throw new Error(`Snapshot finished before ${phase}`);
    if (step.value === phase && --occurrence === 0) return;
  }
  throw new Error(`Snapshot fixture did not reach ${phase}`);
}

/** Four real indexed faces share a nonplanar center. The last two triangles
 * are skirts; array-view padding is not part of the admitted geometry. */
function indexedFixture(wide = false) {
  const geometry = new BufferGeometry();
  const values = [
    -1, -0, -1, 1, 20, -1, -1, 20.2, 1, 1, 20.3, 1, 0, 21, 0, -1, 15, -1, 1, 15,
    -1,
  ];
  const backing = new Float32Array(values.length + 6).fill(91);
  const positions = backing.subarray(3, values.length + 3);
  positions.set(values);
  const faces = [0, 2, 4, 2, 3, 4, 3, 1, 4, 1, 0, 4, 0, 5, 1, 1, 5, 6];
  const indexBacking = wide
    ? new Uint32Array(faces.length + 4).fill(81)
    : new Uint16Array(faces.length + 4).fill(81);
  const indices = indexBacking.subarray(2, faces.length + 2);
  indices.set(faces);
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  const topology: TerrainCellTopology = Object.freeze({
    schemaVersion: 1,
    resolution: 2,
    surfaceVertexCount: 5,
    cellIndexOffsets: Object.freeze([0, 12]),
  });
  geometry.userData.terrainCellTopology = topology;
  geometry.getAttribute("position").needsUpdate = true;
  geometry.index!.needsUpdate = true;
  geometry.index!.needsUpdate = true;
  const surface = new RetainedTerrainSurface(
    7,
    "snapshot-fixture-v1",
    335,
    431,
    2,
    2,
    geometry,
  );
  return { geometry, surface, positions, indices, topology };
}

describe("bounded retained terrain worker snapshots", () => {
  for (const wide of [false, true]) {
    it(`copies exact ${wide ? 32 : 16}-bit indexed views, source identity and packed topology`, () => {
      const f = indexedFixture(wide);
      try {
        const expectedBytes = f.positions.byteLength + f.indices.byteLength + 8;
        expect(f.surface.snapshotByteLength()).toBe(expectedBytes);
        const { snapshot, phases } = finish(
          f.surface.copySnapshotSteps(expectedBytes),
        );
        expect(snapshot).toMatchObject({
          schemaVersion: 1,
          nodeId: 7,
          terrainProfileIdentity: "snapshot-fixture-v1",
          revision: f.geometry.uuid,
          centerX: 335,
          centerZ: 431,
          size: 2,
          resolution: 2,
          positionVersion: 1,
          indexVersion: 2,
          positionCount: 7,
          indexCount: 18,
          payloadBytes: expectedBytes,
        });
        expect(snapshot.positions).toEqual(f.positions);
        expect(Object.is(snapshot.positions[1], -0)).toBe(true);
        expect(snapshot.indices).toEqual(f.indices);
        expect(snapshot.indices).toBeInstanceOf(
          wide ? Uint32Array : Uint16Array,
        );
        expect(snapshot.positions.byteOffset).toBe(0);
        expect(snapshot.indices.byteOffset).toBe(0);
        expect(snapshot.positions.buffer.byteLength).toBe(
          f.positions.byteLength,
        );
        expect(snapshot.indices.buffer.byteLength).toBe(f.indices.byteLength);
        expect(snapshot.positions.buffer).not.toBe(f.positions.buffer);
        expect(snapshot.indices.buffer).not.toBe(f.indices.buffer);
        expect(snapshot.topology).toEqual({
          schemaVersion: 1,
          resolution: 2,
          surfaceVertexCount: 5,
          cellIndexOffsets: new Uint32Array([0, 12]),
        });
        expect(phases).toEqual([
          "snapshot-position-allocation",
          "snapshot-position-copy",
          "snapshot-index-allocation",
          "snapshot-index-copy",
          "snapshot-topology-allocation",
          "snapshot-topology-copy",
          "snapshot-finalize",
        ]);
        const originalPositionBytes = new Uint8Array(
          f.positions.buffer,
          f.positions.byteOffset,
          f.positions.byteLength,
        ).slice();
        const transfers: ArrayBuffer[] = [];
        for (const buffer of [
          snapshot.positions.buffer,
          snapshot.indices.buffer,
          snapshot.topology!.cellIndexOffsets.buffer,
        ]) {
          if (!(buffer instanceof ArrayBuffer))
            throw new Error("Expected private transferable buffer");
          transfers.push(buffer);
        }
        const received = structuredClone(snapshot, {
          transfer: transfers,
        });
        expect(snapshot.positions.byteLength).toBe(0);
        expect(snapshot.indices.byteLength).toBe(0);
        expect(snapshot.topology!.cellIndexOffsets.byteLength).toBe(0);
        expect(received.positions).toEqual(f.positions);
        expect(received.indices).toEqual(f.indices);
        expect(
          new Uint8Array(
            f.positions.buffer,
            f.positions.byteOffset,
            f.positions.byteLength,
          ),
        ).toEqual(originalPositionBytes);
        expect(f.surface.matchesGeometry(f.geometry)).toBe(true);
        expect(f.surface.snapshotByteLength()).toBe(expectedBytes);
      } finally {
        f.geometry.dispose();
      }
    });
  }

  it("copies regular geometry in bounded batches without inventing topology", () => {
    const geometry = gridGeometry(32, 33, (x, z) => 20 + x * 0.02 + z * 0.01);
    try {
      const surface = new RetainedTerrainSurface(
        8,
        "regular",
        0,
        0,
        32,
        33,
        geometry,
      );
      const { snapshot, phases } = finish(
        surface.copySnapshotSteps(surface.snapshotByteLength()),
      );
      expect(snapshot.topology).toBeNull();
      expect(snapshot.positions).toEqual(
        geometry.getAttribute("position").array,
      );
      expect(snapshot.indices).toEqual(geometry.index!.array);
      expect(
        phases.filter((phase) => phase === "snapshot-position-copy"),
      ).toHaveLength(Math.ceil(snapshot.positions.length / 1024));
      expect(
        phases.filter((phase) => phase === "snapshot-index-copy"),
      ).toHaveLength(Math.ceil(snapshot.indices.length / 1024));
      expect(
        phases.some((phase) => phase.startsWith("snapshot-topology")),
      ).toBe(false);
    } finally {
      geometry.dispose();
    }
  });

  it("rejects insufficient and invalid reservations before the first allocation yield", () => {
    const f = indexedFixture();
    try {
      const bytes = f.surface.snapshotByteLength();
      for (const maximum of [
        0,
        bytes - 1,
        -1,
        0.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        const steps = f.surface.copySnapshotSteps(maximum);
        expect(() => steps.next()).toThrow(/byte bound/);
        expect(steps.next().done).toBe(true);
      }
      expect(f.surface.matchesGeometry(f.geometry)).toBe(true);
    } finally {
      f.geometry.dispose();
    }
  });

  it("packs topology offsets in bounded batches without caching the copies", () => {
    const geometry = gridGeometry(32, 33, () => 20);
    try {
      const offsets = Object.freeze(
        Array.from({ length: 1025 }, (_, i) => i * 6),
      );
      geometry.userData.terrainCellTopology = Object.freeze({
        schemaVersion: 1,
        resolution: 33,
        surfaceVertexCount: 1089,
        cellIndexOffsets: offsets,
      } satisfies TerrainCellTopology);
      const surface = new RetainedTerrainSurface(
        12,
        "indexed",
        0,
        0,
        32,
        33,
        geometry,
      );
      const bytes = surface.snapshotByteLength();
      const first = finish(surface.copySnapshotSteps(bytes));
      const second = finish(surface.copySnapshotSteps(bytes));
      expect(first.snapshot.topology!.cellIndexOffsets).toEqual(
        new Uint32Array(offsets),
      );
      expect(
        first.phases.filter((phase) => phase === "snapshot-topology-copy"),
      ).toHaveLength(2);
      expect(first.snapshot.positions.buffer).not.toBe(
        second.snapshot.positions.buffer,
      );
      expect(first.snapshot.indices.buffer).not.toBe(
        second.snapshot.indices.buffer,
      );
      expect(first.snapshot.topology!.cellIndexOffsets.buffer).not.toBe(
        second.snapshot.topology!.cellIndexOffsets.buffer,
      );
      const invalidated = surface.copySnapshotSteps(bytes);
      pauseAt(invalidated, "snapshot-topology-copy", 2);
      geometry.userData.terrainCellTopology = Object.freeze({
        ...geometry.userData.terrainCellTopology,
      });
      expect(() => invalidated.next()).toThrow(/changed during admission/);
    } finally {
      geometry.dispose();
    }
  });

  const mutations: readonly [string, (geometry: BufferGeometry) => void][] = [
    [
      "position version",
      (g) => {
        g.getAttribute("position").needsUpdate = true;
      },
    ],
    [
      "index version",
      (g) => {
        g.index!.needsUpdate = true;
      },
    ],
    [
      "position attribute",
      (g) => {
        g.setAttribute("position", g.getAttribute("position").clone());
      },
    ],
    [
      "index attribute",
      (g) => {
        g.setIndex(g.index!.clone());
      },
    ],
    [
      "position array",
      (g) => {
        const position = g.getAttribute("position");
        if (!(position instanceof BufferAttribute))
          throw new Error("Expected fixture attribute");
        position.array = position.array.slice();
      },
    ],
    [
      "geometry revision",
      (g) => {
        g.uuid = "replacement-revision";
      },
    ],
    [
      "topology identity",
      (g) => {
        g.userData.terrainCellTopology = Object.freeze({
          ...g.userData.terrainCellTopology,
        });
      },
    ],
    [
      "topology descriptor",
      (g) => {
        Object.defineProperty(g.userData, "terrainCellTopology", {
          enumerable: false,
        });
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    for (const phase of [
      "snapshot-position-allocation",
      "snapshot-position-copy",
      "snapshot-index-allocation",
      "snapshot-index-copy",
      "snapshot-topology-allocation",
      "snapshot-topology-copy",
      "snapshot-finalize",
    ])
      it(`rejects ${name} changes while suspended at ${phase}`, () => {
        const f = indexedFixture();
        try {
          const steps = f.surface.copySnapshotSteps(
            f.surface.snapshotByteLength(),
          );
          pauseAt(steps, phase);
          mutate(f.geometry);
          expect(() => steps.next()).toThrow(/changed during admission/);
          expect(() => f.surface.snapshotByteLength()).toThrow(
            /changed during admission/,
          );
          expect(steps.next().done).toBe(true);
        } finally {
          f.geometry.dispose();
        }
      });

  it("checks owners between later copy batches and allows explicit abandonment", () => {
    const geometry = gridGeometry(32, 33, () => 20);
    try {
      const surface = new RetainedTerrainSurface(
        9,
        "regular",
        0,
        0,
        32,
        33,
        geometry,
      );
      const abandoned = surface.copySnapshotSteps(surface.snapshotByteLength());
      pauseAt(abandoned, "snapshot-position-copy", 2);
      abandoned.return(undefined as never);
      expect(abandoned.next().done).toBe(true);
      expect(surface.matchesGeometry(geometry)).toBe(true);
      const invalidated = surface.copySnapshotSteps(
        surface.snapshotByteLength(),
      );
      pauseAt(invalidated, "snapshot-index-copy", 2);
      geometry.index!.needsUpdate = true;
      expect(() => invalidated.next()).toThrow(/changed during admission/);
    } finally {
      geometry.dispose();
    }
  });

  it("keeps strict topology admission and rejects unsupported snapshot index widths", () => {
    const f = indexedFixture();
    const regular = gridGeometry(2, 2, () => 20);
    try {
      f.geometry.userData.terrainCellTopology = Object.freeze({
        ...f.topology,
        cellIndexOffsets: Object.freeze([0, 9]),
      });
      expect(
        () => new RetainedTerrainSurface(10, "invalid", 0, 0, 2, 2, f.geometry),
      ).toThrow(/indexed cell coverage/);
      regular.setIndex(
        new BufferAttribute(new Uint8Array(regular.index!.array), 1),
      );
      const surface = new RetainedTerrainSurface(
        11,
        "regular",
        0,
        0,
        2,
        2,
        regular,
      );
      expect(() => surface.snapshotByteLength()).toThrow(/attribute layout/);
      expect(() => surface.copySnapshotSteps(1000).next()).toThrow(
        /attribute layout/,
      );
    } finally {
      f.geometry.dispose();
      regular.dispose();
    }
  });
});
