import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  MeshStandardNodeMaterial,
  StorageBufferAttribute,
  WGSLNodeBuilder,
} from "three/webgpu";
import {
  attribute,
  Fn,
  instanceIndex,
  uniform,
  varying,
  vec3,
  vec4,
  vertexIndex,
} from "three/tsl";
import type Node from "three/src/nodes/core/Node.js";
import ConvertNode from "three/src/nodes/utils/ConvertNode.js";
import type StorageBufferNode from "three/src/nodes/accessors/StorageBufferNode.js";
import {
  getGrassBladeLayout,
  type FineGrassGeometryLayout,
} from "../GrassBladeLayout";
import THREE from "../../../../extras/three/three";
import {
  createGroundedGrassMaterial,
  createGroundedGrassMeadowAuthoredMaterial,
  createMatrixFreeGrassGeometry,
  createMatrixFreeGrassMesh,
  GRASS_MEADOW_AUTHORED_GROUNDING,
  GRASS_BLADE_VISIBILITY_ATTRIBUTE,
  GRASS_ROOT_STORAGE_ATTRIBUTE,
  GrassClumpInvariantCache,
  readGrassClumpInvariant,
  GRASS_CLUMP_CACHE_ATTRIBUTE,
  GRASS_CLUMP_CACHE_INPUT_ATTRIBUTE,
  AdaptiveGrassDrawOwner,
  prepareAdaptiveGrassRenderData,
  createAdaptiveGrassDrawOwner,
  supportsAdaptiveGrassDraw,
  GRASS_ADAPTIVE_INDIRECT_ATTRIBUTE,
} from "../GrassGroundingGpu";
import { groundGrassBlades } from "../GrassBladeGrounding";
import { createSameFaceCase } from "./fixtures/GrassBladeGroundingSameFaceCases";
import {
  remapGrassGroundingSteps,
  type GrassGrounding,
} from "../GrassTerrainProjection";
import {
  createClumpGeometry,
  createPairedMeadowClumpGeometry,
  createMeadowAuthoredClumpGeometry,
  FINE_GRASS_FOLDED_BLADE_SHAPE,
  FINE_GRASS_MEADOW_FIELD_SHAPE,
  FINE_MEADOW_APPEARANCE,
} from "../GrassVisualManager";
import { createStorageInstancedMesh } from "../../../../utils/rendering/createStorageInstancedMesh";

function drain<T>(steps: Generator<string, T, void>): T {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

describe("adaptive indirect grounded grass (actual Three CPU objects)", () => {
  function fixture(
    lod: 0 | 1 | 2 = 0,
    partialRoad = false,
    points: readonly (readonly [number, number])[] = [
      [6, 6],
      [-6, -6],
      [6, -6],
      [-6, 6],
      [7, 7],
      [-7, -7],
    ],
  ) {
    const f = createSameFaceCase("fine-dense-plane");
    const layout = getGrassBladeLayout(lod, "fine-meadow-ribbon-v1");
    const template = createClumpGeometry(
      layout.bladesPerClump,
      layout.bladeSegments,
      FINE_GRASS_MEADOW_FIELD_SHAPE,
    );
    const data = {
      count: points.length,
      offsets: new Float32Array(
        points.flatMap(([x, z]) => [x, 20 + x * 0.12 - z * 0.07, z]),
      ),
      rotScaleHash: new Float32Array(
        points.flatMap((_, i) => [
          (i * 0.7) % (Math.PI * 2),
          0.8 + i * 0.05,
          i / 10,
        ]),
      ),
      groundColors: new Float32Array(
        points.flatMap((_, i) => [i / 20, 0.3, 0.2]),
      ),
      grassTints: new Float32Array(
        points.flatMap((_, i) => [1, 0.9, 0.8, i / 10]),
      ),
      groundNormals: new Float32Array(
        points.flatMap(() =>
          new THREE.Vector3(-0.12, 1, 0.07).normalize().toArray(),
        ),
      ),
    };
    const result = groundGrassBlades({
      ...f.request,
      lod,
      data,
      geometry: template,
      geometryLayout: "fine-meadow-ribbon-v1",
      roadClearance: "per-blade-v1",
      diagnosticSubcells: "world-grid-6.25m-v1",
      ...(partialRoad
        ? {
            roadSegments: [
              {
                startX: 6.5,
                endX: 6.5,
                startZ: -20,
                endZ: 20,
                width: 0.25,
                blendWidth: 0,
              },
            ],
          }
        : {}),
    });
    if (result.status !== "ready" || result.data.count !== points.length)
      throw new Error("Expected real accepted adaptive fixture");
    const prepared = prepareAdaptiveGrassRenderData(result, { x: 0, z: 0 });
    const geometry = template.clone();
    for (const [name, values, stride] of [
      ["instanceOffset", prepared.data.offsets, 3],
      ["instanceRotScaleHash", prepared.data.rotScaleHash, 3],
      ["instanceGroundNormal", prepared.data.groundNormals, 3],
    ] as const)
      geometry.setAttribute(
        name,
        new THREE.InstancedBufferAttribute(values, stride),
      );
    const colors = new Float32Array(data.count * 7);
    for (let i = 0; i < data.count; i++) {
      colors.set(prepared.data.groundColors.subarray(i * 3, i * 3 + 3), i * 7);
      colors.set(
        prepared.data.grassTints.subarray(i * 4, i * 4 + 4),
        i * 7 + 3,
      );
    }
    const colorBuffer = new THREE.InstancedInterleavedBuffer(colors, 7);
    geometry.setAttribute(
      "instanceGroundColor",
      new THREE.InterleavedBufferAttribute(colorBuffer, 3, 0),
    );
    geometry.setAttribute(
      "instanceGrassTint",
      new THREE.InterleavedBufferAttribute(colorBuffer, 4, 3),
    );
    const base = new MeshStandardNodeMaterial();
    base.positionNode = attribute("position", "vec3").add(
      attribute("instanceOffset", "vec3"),
    );
    const material = createGroundedGrassMaterial(
      base,
      geometry,
      prepared.rootDeltas,
      data.count,
      lod,
      "fine-meadow-ribbon-v1",
      prepared.bladeVisibility,
    );
    const mesh = createStorageInstancedMesh(geometry, material, data.count);
    mesh.updateMatrixWorld(true);
    const dom = new JSDOM("<!doctype html><canvas></canvas>");
    const canvas = dom.window.document.querySelector("canvas")!;
    const renderer = new THREE.WebGPURenderer({ canvas });
    const touched = new Set<AdaptiveGrassDrawOwner>();
    let owner: AdaptiveGrassDrawOwner | undefined;
    return {
      f,
      result,
      prepared,
      geometry,
      mesh,
      material,
      renderer,
      touched,
      install() {
        owner = new AdaptiveGrassDrawOwner(mesh, prepared, renderer, (value) =>
          touched.add(value),
        );
        return owner;
      },
      close() {
        owner?.dispose();
        geometry.dispose();
        material.dispose();
        base.dispose();
        template.dispose();
        renderer.dispose();
        dom.window.close();
        f.dispose();
      },
    };
  }
  function camera(left = -20, right = 20, bottom = -20, top = 20) {
    const value = new THREE.OrthographicCamera(
      left,
      right,
      top,
      bottom,
      0.1,
      100,
    );
    value.coordinateSystem = THREE.WebGPUCoordinateSystem;
    value.position.set(0, 60, 0);
    value.up.set(0, 0, -1);
    value.lookAt(0, 20, 0);
    value.updateProjectionMatrix();
    value.updateMatrixWorld(true);
    return value;
  }
  const bytes = (array: ArrayBufferView) =>
    Buffer.from(array.buffer, array.byteOffset, array.byteLength).toString(
      "hex",
    );

  // Read the real owner's immutable CPU table, not a fake camera/GPU result.
  // Camera selection and transformed bounds are exercised separately below.
  function commandsAtOffsets(
    owner: AdaptiveGrassDrawOwner,
    offsets: readonly number[],
  ) {
    return offsets.map((offset) => {
      expect(offset % 20).toBe(0);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset + 20).toBeLessThanOrEqual(owner.indirect.array.byteLength);
      return Array.from({ length: 5 }, (_, component) =>
        owner.indirect.getComponent(offset / 20, component),
      );
    });
  }
  function commandsForMask(owner: AdaptiveGrassDrawOwner, mask: number) {
    const offsets = Reflect.get(
      owner,
      "offsets",
    ) as readonly (readonly number[])[];
    return commandsAtOffsets(owner, offsets[mask]);
  }

  it.each([1, 2, 3, 4])(
    "coalesces all masks of %s unequal-count quadrants without changing instance order",
    (quadrantCount) => {
      const anchors = [
        [-6, -6],
        [-6, 6],
        [6, -6],
        [6, 6],
      ] as const;
      const points = anchors
        .slice(0, quadrantCount)
        .flatMap(([x, z], i) =>
          Array.from({ length: i + 1 }, (_, j) => [x + j * 0.2, z] as const),
        )
        .reverse();
      const f = fixture(0, false, points);
      try {
        const owner = f.install(),
          original = bytes(owner.indirect.array),
          indexCount = f.geometry.index!.count;
        expect(f.prepared.quadrants.map((q) => q.count)).toEqual(
          Array.from({ length: quadrantCount }, (_, i) => i + 1),
        );
        for (let mask = 0; mask < 1 << quadrantCount; mask++) {
          const selected = f.prepared.quadrants.filter(
            (_, i) => mask & (1 << i),
          );
          const expectedInstances = selected.flatMap((q) =>
            Array.from({ length: q.count }, (_, i) => q.start + i),
          );
          const commands = commandsForMask(owner, mask);
          const actualInstances = commands.flatMap((command) => {
            expect(command.slice(0, 1)).toEqual([indexCount]);
            expect(command.slice(2, 4)).toEqual([0, 0]);
            return Array.from({ length: command[1] }, (_, i) => command[4] + i);
          });
          expect(actualInstances).toEqual(expectedInstances);
          expect(
            actualInstances.map((i) => f.prepared.renderSourceIndices[i]),
          ).toEqual(
            expectedInstances.map(
              (i) => f.result.sourceIndices[f.prepared.renderOrder[i]],
            ),
          );
          const runCount = selected.filter(
            (q, i) =>
              i === 0 ||
              q.start !== selected[i - 1].start + selected[i - 1].count,
          ).length;
          expect(commands).toHaveLength(runCount);
          expect(commandsForMask(owner, mask)).toEqual(commands);
        }
        expect(bytes(owner.indirect.array)).toBe(original);
        expect(owner.indirect.version).toBe(0);
        expect(owner.indirect.array.byteLength).toBeLessThanOrEqual(200);
      } finally {
        f.close();
      }
    },
  );

  it("coalesces adjacent ranges but retains a gap in mixed selection commands", () => {
    const f = fixture();
    try {
      const owner = f.install(),
        indexCount = f.geometry.index!.count;
      expect(commandsForMask(owner, 0b1011)).toEqual([
        [indexCount, 3, 0, 0, 0],
        [indexCount, 2, 0, 0, 4],
      ]);
      expect(commandsForMask(owner, 0b1110)).toEqual([
        [indexCount, 4, 0, 0, 2],
      ]);
    } finally {
      f.close();
    }
  });

  it.each([0, 1, 2] as const)(
    "LOD%s stable permutation preserves every attribute/root/mask byte and original provenance",
    (lod) => {
      const f = fixture(lod);
      try {
        const { result, prepared } = f;
        const before = {
          data: Object.fromEntries(
            Object.entries(result.data)
              .filter(([, v]) => typeof v !== "number")
              .map(([k, v]) => [k, bytes(v as Float32Array)]),
          ),
          roots: bytes(result.rootDeltas),
          mask: bytes(result.bladeVisibility!),
          source: bytes(result.sourceIndices),
        };
        expect(Array.from(prepared.renderOrder)).toEqual([1, 5, 3, 2, 0, 4]);
        expect(
          prepared.quadrants.map(({ x, z, start, count }) => [
            x,
            z,
            start,
            count,
          ]),
        ).toEqual([
          [-1, -1, 0, 2],
          [-1, 0, 2, 1],
          [0, -1, 3, 1],
          [0, 0, 4, 2],
        ]);
        for (const [name, stride] of [
          ["offsets", 3],
          ["rotScaleHash", 3],
          ["groundColors", 3],
          ["grassTints", 4],
          ["groundNormals", 3],
        ] as const)
          for (let i = 0; i < result.data.count; i++) {
            const old = prepared.renderOrder[i];
            expect(
              bytes(prepared.data[name].subarray(i * stride, (i + 1) * stride)),
            ).toBe(
              bytes(
                result.data[name].subarray(old * stride, (old + 1) * stride),
              ),
            );
          }
        const stride = result.receipt.bladesPerClump * 2;
        expect(result.rootDeltas.some((value) => value !== 0)).toBe(true);
        for (let i = 0; i < result.data.count; i++) {
          const old = prepared.renderOrder[i];
          expect(
            bytes(prepared.rootDeltas.subarray(i * stride, (i + 1) * stride)),
          ).toBe(
            bytes(result.rootDeltas.subarray(old * stride, (old + 1) * stride)),
          );
          expect(prepared.bladeVisibility![i]).toBe(
            result.bladeVisibility![old],
          );
          expect(prepared.renderSourceIndices[i]).toBe(
            result.sourceIndices[old],
          );
        }
        prepareAdaptiveGrassRenderData(result, { x: 0, z: 0 });
        expect(bytes(result.rootDeltas)).toBe(before.roots);
        expect(bytes(result.bladeVisibility!)).toBe(before.mask);
        expect(bytes(result.sourceIndices)).toBe(before.source);
        for (const [name, value] of Object.entries(result.data))
          if (typeof value !== "number")
            expect(bytes(value)).toBe(before.data[name]);
        const owner = f.install(),
          indexCount = f.geometry.index!.count;
        expect(Array.from(owner.indirect.array)).toEqual([
          indexCount,
          6,
          0,
          0,
          0,
          indexCount,
          2,
          0,
          0,
          0,
          indexCount,
          1,
          0,
          0,
          2,
          indexCount,
          1,
          0,
          0,
          3,
          indexCount,
          2,
          0,
          0,
          4,
          indexCount,
          3,
          0,
          0,
          0,
          indexCount,
          4,
          0,
          0,
          0,
          indexCount,
          2,
          0,
          0,
          2,
          indexCount,
          4,
          0,
          0,
          2,
          indexCount,
          3,
          0,
          0,
          3,
        ]);
        expect(owner.indirect.array.byteLength).toBe(200);
        expect(f.geometry.getAttribute(GRASS_ADAPTIVE_INDIRECT_ATTRIBUTE)).toBe(
          owner.indirect,
        );
        expect(
          f.geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE).array,
        ).toBe(prepared.rootDeltas);
      } finally {
        f.close();
      }
    },
  );

  it("rejects absent or mismatched accepted metadata rather than inventing bounds", () => {
    const f = fixture();
    try {
      expect(() =>
        prepareAdaptiveGrassRenderData(
          { ...f.result, diagnosticSubcells: undefined },
          { x: 0, z: 0 },
        ),
      ).toThrow();
      expect(() =>
        prepareAdaptiveGrassRenderData(f.result, { x: 100, z: 0 }),
      ).toThrow("anchor/grid mismatch");
      expect(() =>
        prepareAdaptiveGrassRenderData(
          { ...f.result, rootDeltas: f.result.rootDeltas.subarray(2) },
          { x: 0, z: 0 },
        ),
      ).toThrow();
    } finally {
      f.close();
    }
  });

  it.each([0, 1, 2] as const)(
    "LOD%s retains actual partial-road masks in reordered instanceIndex addresses",
    (lod) => {
      const f = fixture(lod, true);
      try {
        const full = 2 ** f.result.receipt.bladesPerClump - 1;
        expect(f.result.bladeVisibility!.some((mask) => mask !== full)).toBe(
          true,
        );
        expect(f.result.bladeVisibility!.every((mask) => mask > 0)).toBe(true);
        for (let i = 0; i < f.prepared.data.count; i++)
          expect(f.prepared.bladeVisibility![i]).toBe(
            f.result.bladeVisibility![f.prepared.renderOrder[i]],
          );
        const owner = f.install();
        for (const q of f.prepared.quadrants) {
          const first = owner.indirect.getComponent(
            f.prepared.quadrants.indexOf(q) + 1,
            4,
          );
          for (let j = 0; j < q.count; j++) {
            const address = first + j;
            expect(
              f.geometry
                .getAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE)
                .getX(address),
            ).toBe(f.result.bladeVisibility![f.prepared.renderOrder[address]]);
          }
        }
      } finally {
        f.close();
      }
    },
  );

  it("uninitialized actual WebGPU renderer keeps the direct/default geometry untouched", () => {
    const f = fixture();
    try {
      expect(f.renderer.initialized).toBe(false);
      expect(supportsAdaptiveGrassDraw(f.renderer)).toBe(false);
      const before = f.mesh.onBeforeRender;
      expect(
        createAdaptiveGrassDrawOwner(f.mesh, f.prepared, f.renderer, () => {
          throw Error("not touched");
        }),
      ).toBeNull();
      expect(f.mesh.onBeforeRender).toBe(before);
      expect(f.geometry.indirect).toBeNull();
      expect(f.geometry.hasAttribute(GRASS_ADAPTIVE_INDIRECT_ATTRIBUTE)).toBe(
        false,
      );
    } finally {
      f.close();
    }
  });

  it("selects full, partial and empty immutable ranges from the actual current camera", () => {
    const f = fixture();
    try {
      const owner = f.install(),
        original = bytes(owner.indirect.array);
      expect(owner.selectCamera(camera())).toEqual([0]);
      expect(owner.selectCamera(camera(-20, -1))).toEqual([100]);
      expect(owner.selectCamera(camera(1, 20))).toEqual([180]);
      expect(owner.selectCamera(camera(30, 40))).toEqual([]);
      const held = owner.selectCamera(camera(-20, -1));
      expect(owner.selectCamera(camera(-20, -1))).toBe(held);
      expect(bytes(owner.indirect.array)).toBe(original);
      expect(owner.indirect.version).toBe(0);
    } finally {
      f.close();
    }
  });

  it("uses transformed wind-swept bounds and current WebGPU reversed/oblique projections", () => {
    const f = fixture();
    try {
      const owner = f.install(),
        parent = new THREE.Group();
      parent.add(f.mesh);
      parent.position.set(100, 0, -70);
      parent.rotation.y = Math.PI / 2;
      parent.scale.set(2, 1.3, 0.75);
      parent.updateMatrixWorld(true);
      const view = camera();
      view.position.add(new THREE.Vector3(100, 0, -70));
      view.updateMatrixWorld(true);
      expect(owner.selectCamera(view)).toEqual([0]);
      const reversedRenderer = new THREE.WebGPURenderer({
        canvas: f.renderer.domElement,
        reversedDepthBuffer: true,
      });
      try {
        const updateCamera: unknown = Reflect.get(
          reversedRenderer,
          "_updateCamera",
        );
        if (typeof updateCamera !== "function")
          throw Error("Missing r186 camera update");
        Reflect.apply(updateCamera, reversedRenderer, [view, false]);
        expect(view.reversedDepth).toBe(true);
      } finally {
        reversedRenderer.dispose();
      }
      expect(owner.selectCamera(view)).toEqual([0]);
      // Actual oblique projection matrix, not an FOV/AABB approximation.
      view.projectionMatrix.elements[8] += 0.15;
      const frustum = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(
          view.projectionMatrix,
          view.matrixWorldInverse,
        ),
        view.coordinateSystem,
        view.reversedDepth,
      );
      const expected = f.prepared.quadrants.flatMap((q) => {
        const b = q.bounds,
          pad = Math.max(
            0.001,
            ...Object.values(b).map((n) => Math.abs(n) * 2 ** -20),
          );
        const box = new THREE.Box3(
          new THREE.Vector3(b.minX, b.minY, b.minZ),
          new THREE.Vector3(b.maxX, b.maxY, b.maxZ),
        )
          .expandByScalar(pad)
          .applyMatrix4(f.mesh.matrixWorld);
        return frustum.intersectsBox(box)
          ? Array.from({ length: q.count }, (_, i) => q.start + i)
          : [];
      });
      const selected = owner.selectCamera(view);
      if (!Array.isArray(selected))
        throw Error("Expected current immutable ranges");
      expect(
        commandsAtOffsets(owner, selected).flatMap((command) =>
          Array.from({ length: command[1] }, (_, i) => command[4] + i),
        ),
      ).toEqual(expected);
      view.projectionMatrix.elements[0] = NaN;
      expect(owner.selectCamera(view)).toBe(0);
      expect(owner.selectCamera(new THREE.ArrayCamera())).toBe(0);
    } finally {
      f.close();
    }
  });

  it("uses a perspective off-axis camera independently from the primary view", () => {
    const f = fixture();
    try {
      const owner = f.install();
      const mirror = new THREE.PerspectiveCamera(30, 2, 0.1, 100);
      mirror.coordinateSystem = THREE.WebGPUCoordinateSystem;
      mirror.position.set(0, 60, 0);
      mirror.up.set(0, 0, -1);
      mirror.lookAt(0, 20, 0);
      mirror.setViewOffset(200, 100, 0, 0, 100, 100);
      mirror.updateMatrixWorld(true);
      expect(owner.selectCamera(mirror)).toEqual([100]);
      // Oblique near-plane row, as used by planar reflection cameras.
      mirror.projectionMatrix.elements[2] = 0.02;
      mirror.projectionMatrix.elements[6] = -0.01;
      expect(owner.selectCamera(mirror)).toEqual([100]);
      expect(owner.selectCamera(camera())).toEqual([0]);
      mirror.setViewOffset(200, 100, 100, 0, 100, 100);
      expect(owner.selectCamera(mirror)).toEqual([180]);
    } finally {
      f.close();
    }
  });

  it("nested callbacks, precompile and exception reset restore full range without disposing borrowed resources", () => {
    const f = fixture();
    try {
      const scene = new THREE.Scene(),
        view = camera(),
        order: string[] = [];
      let owner: AdaptiveGrassDrawOwner;
      let nested = false,
        fail = false;
      f.mesh.onBeforeRender = (...args) => {
        order.push("before");
        if (fail) throw Error("original callback failure");
        if (!nested) {
          nested = true;
          Reflect.apply(f.mesh.onBeforeRender, f.mesh, args);
          Reflect.apply(f.mesh.onAfterRender, f.mesh, args);
        }
      };
      f.mesh.onAfterRender = () => {
        order.push("after");
      };
      const before = f.mesh.onBeforeRender,
        after = f.mesh.onAfterRender;
      owner = f.install();
      const args = [f.renderer, scene, view, f.geometry, f.material, null];
      f.geometry.indirectOffset = [40];
      Reflect.apply(f.mesh.onBeforeRender, f.mesh, args);
      expect(f.geometry.indirectOffset).toBe(0); // Real uninitialized device: full fallback.
      Reflect.apply(f.mesh.onAfterRender, f.mesh, args);
      expect(f.geometry.indirectOffset).toEqual([40]);
      expect(order).toEqual(["before", "before", "after", "after"]);
      expect(f.touched.has(owner)).toBe(true);
      owner.resetAfterRender();
      expect(f.geometry.indirectOffset).toBe(0);
      f.mesh.frustumCulled = false;
      Reflect.apply(f.mesh.onBeforeRender, f.mesh, args);
      expect(f.geometry.indirectOffset).toBe(0);
      owner.resetAfterRender(); // compile or draw throwing before onAfterRender.
      fail = true;
      expect(() => Reflect.apply(f.mesh.onBeforeRender, f.mesh, args)).toThrow(
        "original callback failure",
      );
      expect(f.geometry.indirectOffset).toBe(0);
      let geometryDisposals = 0,
        materialDisposals = 0;
      f.geometry.addEventListener("dispose", () => {
        geometryDisposals++;
        expect(f.geometry.getAttribute(GRASS_ADAPTIVE_INDIRECT_ATTRIBUTE)).toBe(
          owner.indirect,
        );
      });
      f.material.addEventListener("dispose", () => materialDisposals++);
      owner.dispose();
      owner.dispose();
      expect(f.mesh.onBeforeRender).toBe(before);
      expect(f.mesh.onAfterRender).toBe(after);
      expect(geometryDisposals).toBe(0);
      expect(materialDisposals).toBe(0);
      expect(owner.selectCamera(view)).toBeNull();
    } finally {
      f.close();
    }
  });

  it("invalidated render inputs fall back full and foreign callback replacements survive disposal", () => {
    const f = fixture();
    try {
      const owner = f.install();
      expect(owner.selectCamera(camera(-20, -1))).toEqual([100]);
      f.geometry.getAttribute("instanceOffset").needsUpdate = true;
      expect(owner.selectCamera(camera(-20, -1))).toBeNull();
      const foreign = () => {};
      f.mesh.onBeforeRender = foreign;
      owner.dispose();
      expect(f.mesh.onBeforeRender).toBe(foreign);
    } finally {
      f.close();
    }
  });

  it("after-callback failure restores the outer range, and changing the packed color buffer falls back full", () => {
    const f = fixture();
    try {
      f.mesh.onAfterRender = () => {
        throw Error("after callback failure");
      };
      const owner = f.install(),
        args = [
          f.renderer,
          new THREE.Scene(),
          camera(),
          f.geometry,
          f.material,
          null,
        ];
      f.geometry.indirectOffset = [40];
      Reflect.apply(f.mesh.onBeforeRender, f.mesh, args);
      expect(() => Reflect.apply(f.mesh.onAfterRender, f.mesh, args)).toThrow(
        "after callback failure",
      );
      expect(f.geometry.indirectOffset).toEqual([40]);
      owner.resetAfterRender();
      const color = f.geometry.getAttribute("instanceGroundColor");
      if (!(color instanceof THREE.InterleavedBufferAttribute))
        throw Error("Expected actual production interleave");
      color.data.needsUpdate = true;
      expect(owner.selectCamera(camera(-20, -1))).toBeNull();
    } finally {
      f.close();
    }
  });

  it.each(["index", "count"] as const)(
    "changed %s uses the current direct draw, never stale immutable full commands",
    (change) => {
      const f = fixture();
      try {
        const owner = f.install(),
          commands = bytes(owner.indirect.array);
        if (change === "index") f.geometry.setIndex([0, 1, 2]);
        else f.mesh.count = 2;
        const args = [
          f.renderer,
          new THREE.Scene(),
          camera(),
          f.geometry,
          f.material,
          null,
        ];
        expect(owner.selectCamera(camera())).toBeNull();
        Reflect.apply(f.mesh.onBeforeRender, f.mesh, args);
        expect(f.geometry.indirect).toBeNull();
        Reflect.apply(f.mesh.onAfterRender, f.mesh, args);
        expect(f.geometry.indirect).toBeNull();
        owner.resetAfterRender();
        expect(f.geometry.indirect).toBeNull();
        expect(bytes(owner.indirect.array)).toBe(commands);
        expect(
          change === "index" ? f.geometry.index!.count : f.mesh.count,
        ).toBe(change === "index" ? 3 : 2);
        expect(f.geometry.getAttribute(GRASS_ADAPTIVE_INDIRECT_ATTRIBUTE)).toBe(
          owner.indirect,
        );
      } finally {
        f.close();
      }
    },
  );

  it("a replaced deformation graph falls back to the direct owner", () => {
    const f = fixture();
    try {
      const owner = f.install();
      expect(owner.selectCamera(camera(-20, -1))).toEqual([100]);
      f.material.positionNode = attribute("position", "vec3");
      expect(owner.selectCamera(camera(-20, -1))).toBeNull();
      owner.resetAfterRender();
      expect(f.geometry.indirect).toBeNull();
    } finally {
      f.close();
    }
  });
});

/** Inspect the actual constructed TSL address. Integer division mirrors the
 * uint operands here; this deliberately does not claim native GPU execution. */
function storageAddress(
  node: Node,
  instance: number,
  vertex: number,
  visibility?: number,
): number {
  if (node === instanceIndex) return instance;
  if (node === vertexIndex) return vertex;
  const value: unknown = Reflect.get(node, "value");
  if (node.type === "ConstNode" && Number.isSafeInteger(value))
    return value as number;
  const child = (name: string): number => {
    const next: unknown = Reflect.get(node, name);
    if (!(next instanceof THREE.Node))
      throw new Error(`Unexpected ${name} on ${node.type}`);
    return storageAddress(next, instance, vertex, visibility);
  };
  if (node.type === "ConvertNode" || node.type === "VarNode")
    return child("node");
  if (node.type === "StorageArrayElementNode") {
    const binding = childNode(node, "node"),
      attribute: unknown = Reflect.get(binding, "value");
    if (
      binding.nodeType !== "uint" ||
      !(attribute instanceof StorageBufferAttribute) ||
      !(attribute.array instanceof Uint32Array)
    )
      throw new Error("Expected actual uint visibility storage");
    const index = child("indexNode");
    if (index !== instance || attribute.getX(index) !== visibility)
      throw new Error(
        "Visibility address/value differs from compacted instance",
      );
    return attribute.getX(index);
  }
  if (node.type !== "OperatorNode")
    throw new Error(`Unexpected grass address node ${node.type}`);
  const a = child("aNode"),
    b = child("bNode");
  switch (Reflect.get(node, "op")) {
    case "+":
      return a + b;
    case "*":
      return a * b;
    case "/":
      return Math.floor(a / b);
    case ">>":
      return a >>> b;
    case "&":
      return a & b;
    case "!=":
      return Number(a !== b);
    default:
      throw new Error("Unexpected grass address operation");
  }
}

function childNode(node: Node, name: string): Node {
  const child: unknown = Reflect.get(node, name);
  if (!(child instanceof THREE.Node))
    throw new Error(`Missing actual ${name} on ${node.type}`);
  return child;
}

/** Generate the actual installed r186 stage flow using a real uninitialized
 * WebGPU renderer. This is not full material compilation or GPU execution. */
function groundingStageFlow(
  geometry: THREE.BufferGeometry,
  material: MeshStandardNodeMaterial,
  object?: THREE.Mesh,
) {
  const dom = new JSDOM("<canvas></canvas>");
  const canvas = dom.window.document.querySelector("canvas");
  if (!canvas) throw new Error("Missing constructor canvas");
  const renderer = new THREE.WebGPURenderer({ canvas });
  try {
    const builder = new WGSLNodeBuilder(
      object ?? new THREE.Mesh(geometry, material),
      renderer,
    );
    Reflect.set(builder, "camera", new THREE.PerspectiveCamera());
    const generate: unknown = Reflect.get(builder, "flowStagesNode");
    const declarations: unknown = Reflect.get(builder, "getUniforms");
    if (typeof generate !== "function" || typeof declarations !== "function")
      throw new Error("Missing installed stage builder methods");
    const flow = (stage: "vertex" | "fragment", node: unknown) => {
      if (!(node instanceof THREE.Node))
        throw new Error("Missing actual material node");
      Reflect.set(builder, "shaderStage", stage);
      const result: unknown = generate.call(
        builder,
        Fn(() => new ConvertNode<"vec3">(node, "vec3"), "vec3")(),
        "vec3",
      );
      if (
        !result ||
        typeof result !== "object" ||
        !("code" in result) ||
        !("result" in result) ||
        typeof result.code !== "string" ||
        typeof result.result !== "string"
      )
        throw new Error("Missing actual generated flow");
      return result.code + result.result;
    };
    const fragment = flow("fragment", material.normalNode);
    const setupPosition: unknown = Reflect.get(material, "setupPosition");
    if (object && typeof setupPosition !== "function")
      throw new Error("Missing actual installed material position setup");
    const vertex = flow(
      "vertex",
      object
        ? Fn((nodeBuilder) => {
            const position: unknown = Reflect.apply(
              setupPosition as (...args: unknown[]) => unknown,
              material,
              [nodeBuilder],
            );
            if (!(position instanceof THREE.Node))
              throw new Error("Missing actual installed position result");
            return new ConvertNode<"vec3">(position, "vec3");
          }, "vec3")()
        : material.positionNode,
    );
    const vertexDeclarations: unknown = declarations.call(builder, "vertex");
    const fragmentDeclarations: unknown = declarations.call(
      builder,
      "fragment",
    );
    if (
      typeof vertexDeclarations !== "string" ||
      typeof fragmentDeclarations !== "string"
    )
      throw new Error("Missing actual declarations");
    const attributes: unknown = Reflect.get(builder, "attributes");
    if (!Array.isArray(attributes))
      throw new Error("Missing actual builder attributes");
    const attributeNames = attributes.map((value: unknown) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("name" in value) ||
        typeof value.name !== "string"
      )
        throw new Error("Invalid actual builder attribute");
      return value.name;
    });
    return {
      vertex: vertexDeclarations + vertex,
      fragment: fragmentDeclarations + fragment,
      attributes: attributeNames,
    };
  } finally {
    renderer.dispose();
    dom.window.close();
  }
}

/** Actual graph topology and inputs, excluding allocation-specific UUIDs. */
function graphShape(node: Node): unknown {
  const value: unknown = Reflect.get(node, "value");
  return {
    type: node.type,
    nodeType: node.nodeType,
    op: Reflect.get(node, "op"),
    method: Reflect.get(node, "method"),
    components: Reflect.get(node, "components"),
    convertTo: Reflect.get(node, "convertTo"),
    attributeName: Reflect.get(node, "_attributeName"),
    scope: Reflect.get(node, "scope"),
    access: Reflect.get(node, "access"),
    bufferCount: Reflect.get(node, "bufferCount"),
    value:
      value instanceof THREE.BufferAttribute
        ? Array.from(value.array)
        : typeof value === "number"
          ? value
          : undefined,
    children: [...node.getChildren()].map(graphShape),
  };
}

function bindingGeometry(
  lod: number,
  count: number,
  geometryLayout?: FineGrassGeometryLayout,
): THREE.BufferGeometry {
  const tier = getGrassBladeLayout(lod, geometryLayout);
  const actualSheath = geometryLayout === "fine-folded-sheath-near5-v1";
  const actualPaired = geometryLayout === "fine-meadow-paired-near-v1";
  const geometry = actualSheath
    ? createClumpGeometry(
        tier.bladesPerClump,
        tier.bladeSegments,
        FINE_GRASS_FOLDED_BLADE_SHAPE,
        lod === 0
          ? "folded-sheath-v1"
          : lod === 1
            ? "folded-lancet-v1"
            : undefined,
      )
    : actualPaired
      ? lod === 0
        ? createPairedMeadowClumpGeometry()
        : createClumpGeometry(
            tier.bladesPerClump,
            tier.bladeSegments,
            FINE_GRASS_MEADOW_FIELD_SHAPE,
          )
      : new THREE.BufferGeometry();
  if (!actualSheath && !actualPaired)
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(
        new Float32Array(
          getGrassBladeLayout(lod, geometryLayout).verticesPerClump * 3,
        ),
        3,
      ),
    );
  geometry.setAttribute(
    "instanceOffset",
    new THREE.InstancedBufferAttribute(
      Float32Array.from({ length: count * 3 }, (_, index) => index * 1.25 - 7),
      3,
    ),
  );
  return geometry;
}

describe("opt-in matrix-free grounded grass (real Three CPU construction)", () => {
  function fixture(lod = 0, count = 3) {
    const layout = "fine-meadow-ribbon-v1";
    const tier = getGrassBladeLayout(lod, layout);
    const template = createClumpGeometry(
      tier.bladesPerClump,
      tier.bladeSegments,
      FINE_GRASS_MEADOW_FIELD_SHAPE,
    );
    const geometry = createMatrixFreeGrassGeometry(template, count);
    const offsets = new THREE.InstancedBufferAttribute(
      new Float32Array(count * 3),
      3,
    );
    geometry.setAttribute("instanceOffset", offsets);
    const base = new MeshStandardNodeMaterial();
    const time = uniform(0.37);
    const texture = new THREE.Texture();
    base.positionNode = Fn(
      () => attribute("position", "vec3").add(vec3(time, 0, 0)),
      "vec3",
    )();
    base.normalNode = varying(
      attribute("normal", "vec3"),
      "matrixFreeGroundingNormal",
    );
    base.map = texture;
    const roots = new Float32Array(count * tier.bladesPerClump * 2);
    const masks = new Uint32Array(count).fill(2 ** tier.bladesPerClump - 1);
    const material = createGroundedGrassMaterial(
      base,
      geometry,
      roots,
      count,
      lod,
      layout,
      masks,
    );
    return {
      tier,
      template,
      geometry,
      offsets,
      base,
      time,
      texture,
      roots,
      masks,
      material,
      dispose() {
        geometry.dispose();
        template.dispose();
        material.dispose();
        base.dispose();
        texture.dispose();
      },
    };
  }

  function cacheFixture() {
    const f = fixture();
    const rotations = new THREE.InstancedBufferAttribute(
      new Float32Array([0.25, 1, 0.1, 1.5, 0.8, 0.2, 2.75, 1.1, 0.3]),
      3,
    );
    const normals = new THREE.InstancedBufferAttribute(
      new Float32Array([0, 1, 0, 0.6, 0.8, 0, 0, 0.8, 0.6]),
      3,
    );
    f.offsets.setXYZ(0, 2, 10, 3);
    f.offsets.setXYZ(1, -4, 11, 5);
    f.offsets.setXYZ(2, 6, 12, -7);
    f.geometry.setAttribute("instanceRotScaleHash", rotations);
    f.geometry.setAttribute("instanceGroundNormal", normals);
    const mesh = createMatrixFreeGrassMesh(f.geometry, f.material);
    const positionNode = f.material.positionNode;
    if (!(positionNode instanceof THREE.Node))
      throw new Error("Actual grounded position required");
    const position = vec3(new ConvertNode<"vec3">(positionNode, "vec3"));
    f.material.positionNode = Fn(() =>
      position.add(
        readGrassClumpInvariant(0, () => vec4(2, 3, 4, 5)).xyz.add(
          readGrassClumpInvariant(1, () => vec4(6, 7, 8, 0)).xyz,
        ),
      ),
    )();
    const cache = new GrassClumpInvariantCache(mesh, (world) =>
      vec4(world.x.mul(0.1), world.z.mul(0.2), world.x.add(world.z), 0),
    );
    return {
      ...f,
      mesh,
      cache,
      rotations,
      normals,
      release() {
        mesh.dispose();
        f.dispose();
      },
    };
  }

  it("owns two vec4 GPU cache records without changing the source vertex layout", async () => {
    const f = cacheFixture();
    try {
      expect(f.cache.snapshot()).toMatchObject({
        ready: false,
        preparations: 0,
        inputBytes: 96,
        outputBytes: 96,
      });
      expect(f.geometry.getAttribute(GRASS_CLUMP_CACHE_ATTRIBUTE)).toBe(
        f.cache.output,
      );
      expect(f.geometry.getAttribute(GRASS_CLUMP_CACHE_INPUT_ATTRIBUTE)).toBe(
        f.cache.inputs,
      );
      expect(f.cache.compute.count).toBe(3);
      expect(f.cache.compute.workgroupSize).toEqual([64, 1, 1]);
      // CPU operation boundary only: asserts packing/ownership, not GPU values.
      await f.cache.runPreparation(async () => {});
      expect(Array.from(f.cache.inputs.array)).toEqual([
        2,
        3,
        Math.fround(0.25),
        0,
        0,
        1,
        0,
        0,
        -4,
        5,
        Math.fround(1.5),
        0,
        Math.fround(0.6),
        Math.fround(0.8),
        0,
        0,
        6,
        -7,
        Math.fround(2.75),
        0,
        0,
        Math.fround(0.8),
        Math.fround(0.6),
        0,
      ]);
      for (const attribute of [f.offsets, f.rotations, f.normals]) {
        expect(attribute.itemSize).toBe(3);
        expect(attribute.count).toBe(3);
      }
      expect(f.cache.snapshot().completion).toBe(
        "ordered-submission-not-gpu-fence",
      );
      const flow = groundingStageFlow(f.geometry, f.material, f.mesh);
      expect(flow.vertex).toMatch(/grassClumpInvariant0/);
      expect(flow.vertex).toMatch(/grassClumpInvariant1/);
      expect(flow.vertex.match(/var<storage,\s*read>/g)).toHaveLength(3);
      expect(flow.vertex).toMatch(/if \(/);
      expect(flow.vertex).toMatch(/else/);
      expect(flow.attributes).not.toContain(GRASS_CLUMP_CACHE_ATTRIBUTE);
      expect(flow.attributes).not.toContain(GRASS_CLUMP_CACHE_INPUT_ATTRIBUTE);
      expect(flow.vertex + flow.fragment).not.toMatch(/undefined|NaN|Infinity/);
    } finally {
      f.cache.retire(f.release);
    }
  });

  it("emits the installed r186 bounded compute-stage flow with two output records and no live-time inputs", () => {
    const f = cacheFixture();
    const dom = new JSDOM("<canvas></canvas>");
    const canvas = dom.window.document.querySelector("canvas");
    if (!canvas) throw new Error("Missing constructor canvas");
    const renderer = new THREE.WebGPURenderer({ canvas });
    try {
      // Actual installed builder, not a GPU or renderer replacement. This
      // proves emitted stage flow only; complete native compilation/execution
      // still requires an initialized GPU (including its feature discovery).
      const builder = new WGSLNodeBuilder(new THREE.Object3D(), renderer);
      builder.compute = f.cache.compute;
      Reflect.set(builder, "shaderStage", "compute");
      const generate: unknown = Reflect.get(builder, "flowStagesNode");
      const declarations: unknown = Reflect.get(builder, "getUniforms");
      if (typeof generate !== "function" || typeof declarations !== "function")
        throw new Error("Missing installed compute stage methods");
      const flow: unknown = generate.call(builder, f.cache.compute, "void");
      const uniforms: unknown = declarations.call(builder, "compute");
      if (
        !flow ||
        typeof flow !== "object" ||
        !("code" in flow) ||
        typeof flow.code !== "string" ||
        typeof uniforms !== "string"
      )
        throw new Error("Missing actual compute stage flow");
      const shader = uniforms + flow.code;
      expect(shader).toMatch(/instanceIndex\s*>=\s*[^\n]+\{ return;/);
      expect(shader).toMatch(/cos\(/);
      expect(shader).toMatch(/sin\(/);
      expect(shader).toMatch(/var<storage,\s*read>/);
      expect(shader).toMatch(/var<storage,\s*read_write>/);
      expect(shader).toMatch(/instanceIndex\s*\*\s*2u/);
      expect(shader).not.toMatch(/time|player|undefined|NaN|Infinity/);
    } finally {
      f.cache.retire(f.release);
      renderer.dispose();
      dom.window.close();
    }
  });

  it("falls back after parent transforms or source versions and refreshes only on a new preparation", async () => {
    const f = cacheFixture(),
      parent = new THREE.Group();
    parent.add(f.mesh);
    try {
      await f.cache.runPreparation(async () => {});
      expect(f.cache.isCurrent()).toBe(true);
      parent.position.set(4, 2, -5);
      parent.rotation.y = 0.4;
      parent.scale.set(1.2, 0.8, 1.1);
      parent.updateMatrixWorld(true);
      expect(f.cache.isCurrent()).toBe(false);
      expect(f.cache.needsPreparation()).toBe(true);
      await f.cache.runPreparation(async () => {});
      expect(f.cache.isCurrent()).toBe(true);
      f.normals.needsUpdate = true;
      expect(f.cache.isCurrent()).toBe(false);
      await f.cache.runPreparation(async () => {});
      expect(f.cache.isCurrent()).toBe(true);
      expect(f.cache.snapshot().preparations).toBe(3);
      f.geometry.setAttribute("instanceGroundNormal", f.normals.clone());
      expect(f.cache.isCurrent()).toBe(false);
      await f.cache.request((owner) => owner.runPreparation(async () => {}));
      expect(f.cache.snapshot()).toMatchObject({
        ready: false,
        failed: true,
        lastError: "Grass invariant source owner was replaced",
      });
    } finally {
      f.cache.retire(f.release);
    }
  });

  it("retires a queued owner before it starts without submitting or disposing twice", async () => {
    const f = cacheFixture();
    let releaseQueue: (() => void) | undefined,
      operations = 0,
      disposals = 0;
    const gate = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const request = f.cache.request(async (owner) => {
      await gate;
      await owner.runPreparation(async () => {
        operations++;
      });
    });
    f.cache.retire(() => {
      disposals++;
      f.release();
    });
    expect(f.cache.snapshot()).toMatchObject({
      ready: false,
      disposed: true,
      retired: true,
    });
    releaseQueue!();
    await request;
    f.cache.retire(() => {
      disposals++;
    });
    expect([operations, disposals]).toEqual([0, 1]);
  });

  it("keeps actual-operation ownership after a caller timeout and blocks late publication", async () => {
    const f = cacheFixture();
    let finish: (() => void) | undefined,
      operation: Promise<void> | undefined,
      disposals = 0;
    const request = f.cache.request((owner) => {
      operation = owner.runPreparation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      return Promise.reject(new Error("caller deadline"));
    });
    await request;
    expect(f.cache.snapshot()).toMatchObject({
      running: true,
      failed: true,
      ready: false,
    });
    f.cache.retire(() => {
      disposals++;
      f.release();
    });
    expect(disposals).toBe(0);
    finish!();
    await operation;
    expect(f.cache.snapshot()).toMatchObject({
      running: false,
      retired: true,
      disposed: true,
      ready: false,
      preparations: 0,
    });
    expect(disposals).toBe(1);
  });

  it("never publishes a cache prepared against a superseded parent matrix", async () => {
    const f = cacheFixture(),
      parent = new THREE.Group();
    parent.add(f.mesh);
    let finish: (() => void) | undefined;
    try {
      const operation = f.cache.runPreparation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      parent.position.x = 17;
      parent.updateMatrixWorld(true);
      finish!();
      await operation;
      expect(f.cache.isCurrent()).toBe(false);
      expect(f.cache.needsPreparation()).toBe(true);
    } finally {
      f.cache.retire(f.release);
    }
  });

  it.each([0, 1, 2])(
    "copies exact LOD %s template bytes before binding and retains the actual storage owners",
    (lod) => {
      const f = fixture(lod);
      try {
        expect(f.geometry).toBeInstanceOf(THREE.InstancedBufferGeometry);
        expect(f.geometry.instanceCount).toBe(3);
        expect(f.geometry.index?.array).toEqual(f.template.index?.array);
        expect(f.geometry.index).not.toBe(f.template.index);
        for (const name of ["position", "normal", "uv"]) {
          const original = f.template.getAttribute(name),
            copy = f.geometry.getAttribute(name);
          expect(copy.array).toEqual(original.array);
          expect(copy.array).not.toBe(original.array);
          expect(copy.itemSize).toBe(original.itemSize);
          expect(copy.normalized).toBe(original.normalized);
        }
        expect(f.template.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(
          false,
        );
        const roots = f.geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE);
        const masks = f.geometry.getAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE);
        const position = f.material.positionNode;
        if (!(position instanceof THREE.Node))
          throw new Error("Missing real grounded position");
        const storageOwners: unknown[] = [];
        position.traverse((node) => {
          if (node.type === "StorageBufferNode")
            storageOwners.push(Reflect.get(node, "value"));
        });
        expect(new Set(storageOwners)).toEqual(new Set([roots, masks]));
        const mesh = createMatrixFreeGrassMesh(f.geometry, f.material);
        try {
          expect(mesh).toBeInstanceOf(THREE.Mesh);
          expect(mesh).not.toBeInstanceOf(THREE.InstancedMesh);
          expect(mesh.geometry).toBe(f.geometry);
          expect(mesh.material).toBe(f.material);
          expect(mesh.count).toBe(3);
          expect(Reflect.has(mesh, "instanceMatrix")).toBe(false);
          expect(Reflect.has(mesh, "instanceColor")).toBe(false);
          expect(f.geometry.hasAttribute("instanceMatrixStorage")).toBe(false);
          expect(f.geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(
            roots,
          );
          expect(
            f.geometry.getAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE),
          ).toBe(masks);
          expect(roots.array).toBe(f.roots);
          expect(masks.array).toBe(f.masks);
          expect(f.geometry.getAttribute("instanceOffset")).toBe(f.offsets);
          expect(f.material.normalNode).toBe(f.base.normalNode);
          expect(f.material.map).toBe(f.texture);
          expect(f.material.positionNode).not.toBe(position);
          expect(() =>
            createMatrixFreeGrassMesh(f.geometry, f.material),
          ).toThrow(/ownership/);
          expect(Reflect.set(mesh, "count", 4)).toBe(false);
          expect(Reflect.set(f.geometry, "instanceCount", 4)).toBe(false);
          expect(mesh.count).toBe(f.geometry.instanceCount);
        } finally {
          mesh.dispose();
        }
      } finally {
        f.dispose();
      }
    },
  );

  it.each([0, 1, 2])(
    "preserves r186 identity-normal ordering without matrix storage for LOD %s",
    (lod) => {
      const f = fixture(lod);
      const oldGeometry = f.template.clone();
      oldGeometry.setAttribute("instanceOffset", f.offsets.clone());
      const oldMaterial = createGroundedGrassMaterial(
        f.base,
        oldGeometry,
        f.roots.slice(),
        3,
        lod,
        "fine-meadow-ribbon-v1",
        f.masks.slice(),
      );
      const oldMesh = createStorageInstancedMesh(oldGeometry, oldMaterial, 3);
      const mesh = createMatrixFreeGrassMesh(f.geometry, f.material);
      try {
        const before = groundingStageFlow(oldGeometry, oldMaterial, oldMesh);
        const after = groundingStageFlow(f.geometry, f.material, mesh);
        expect(before.vertex).toContain("tsl_inverse");
        expect(before.vertex).toContain("transpose");
        expect(after.vertex).not.toMatch(/tsl_inverse|transpose|mat4x4<f32>/);
        expect(
          after.vertex.match(/normalLocal\s*=\s*normalize\( normalLocal \)/g),
        ).toHaveLength(1);
        const normalization = after.vertex.indexOf(
          "normalLocal = normalize( normalLocal )",
        );
        expect(normalization).toBeGreaterThan(-1);
        expect(normalization).toBeLessThan(after.vertex.indexOf("mix("));
        expect(normalization).toBeLessThan(
          after.vertex.lastIndexOf("positionLocal ="),
        );
        expect(after.vertex.match(/var<storage,\s*read>/g)).toHaveLength(2);
        expect(before.vertex.match(/var<storage,\s*read>/g)).toHaveLength(3);
        expect(after.vertex).toMatch(
          new RegExp(`vertexIndex\\s*\\/\\s*${f.tier.verticesPerBlade}u`),
        );
        expect(after.vertex).toMatch(
          new RegExp(`instanceIndex\\s*\\*\\s*${f.tier.bladesPerClump}u`),
        );
        expect(after.fragment).toBe(before.fragment);
        expect(after.vertex + after.fragment).not.toMatch(
          /undefined|NaN|Infinity/,
        );
        const normals = f.geometry.getAttribute("normal");
        const identityNormal = new THREE.Matrix3().getNormalMatrix(
          new THREE.Matrix4(),
        );
        for (let index = 0; index < normals.count; index++) {
          const original = new THREE.Vector3().fromBufferAttribute(
            normals,
            index,
          );
          expect(
            original.clone().applyNormalMatrix(identityNormal).toArray(),
          ).toEqual(original.clone().normalize().toArray());
        }
      } finally {
        mesh.dispose();
        oldMesh.dispose();
        oldMaterial.dispose();
        oldGeometry.dispose();
        f.dispose();
      }
    },
  );

  it.each([0, 1.5, 4097, NaN, Infinity])(
    "rejects invalid count %s before allocating a copied template",
    (count) => {
      const template = createClumpGeometry(
        21,
        3,
        FINE_GRASS_MEADOW_FIELD_SHAPE,
      );
      const attributes = { ...template.attributes };
      try {
        expect(() => createMatrixFreeGrassGeometry(template, count)).toThrow(
          /template or count/,
        );
        expect(template.attributes).toEqual(attributes);
      } finally {
        template.dispose();
      }
    },
  );

  it("refuses an already-bound or instanced source instead of cloning registered storage", () => {
    const f = fixture();
    try {
      expect(() => createMatrixFreeGrassGeometry(f.geometry, 3)).toThrow();
      f.template.setAttribute(
        GRASS_ROOT_STORAGE_ATTRIBUTE,
        f.geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE),
      );
      expect(() => createMatrixFreeGrassGeometry(f.template, 3)).toThrow();
    } finally {
      f.template.deleteAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE);
      f.dispose();
    }
  });

  it.each([
    "count",
    "position",
    "roots",
    "visibility",
    "foreign",
    "base",
  ] as const)(
    "rejects %s ownership changes without publishing or changing nodes",
    (kind) => {
      const f = fixture();
      const foreign = createMatrixFreeGrassGeometry(f.template, 3);
      try {
        if (kind === "count") f.geometry.instanceCount = 2;
        if (kind === "position") f.material.positionNode = vec3(0);
        if (kind === "roots")
          f.geometry.setAttribute(
            GRASS_ROOT_STORAGE_ATTRIBUTE,
            new StorageBufferAttribute(f.roots.slice(), 2),
          );
        if (kind === "visibility")
          f.geometry.setAttribute(
            GRASS_BLADE_VISIBILITY_ATTRIBUTE,
            new StorageBufferAttribute(f.masks.slice(), 1),
          );
        const position = f.material.positionNode,
          basePosition = f.base.positionNode;
        expect(() =>
          createMatrixFreeGrassMesh(
            kind === "foreign" ? foreign : f.geometry,
            kind === "base" ? f.base : f.material,
          ),
        ).toThrow(/ownership/);
        expect(f.material.positionNode).toBe(position);
        expect(f.base.positionNode).toBe(basePosition);
      } finally {
        foreign.dispose();
        f.dispose();
      }
    },
  );

  it("keeps the one clone and borrowed inputs alive through explicit chunk disposal", () => {
    const f = fixture();
    const basePosition = f.base.positionNode,
      baseNormal = f.base.normalNode;
    const mesh = createMatrixFreeGrassMesh(f.geometry, f.material);
    const disposals = {
      mesh: 0,
      geometry: 0,
      material: 0,
      base: 0,
      texture: 0,
    };
    mesh.addEventListener("dispose", () => disposals.mesh++);
    f.geometry.addEventListener("dispose", () => disposals.geometry++);
    f.material.addEventListener("dispose", () => disposals.material++);
    f.base.addEventListener("dispose", () => disposals.base++);
    f.texture.addEventListener("dispose", () => disposals.texture++);
    expect(mesh.material).toBe(f.material);
    f.geometry.dispose();
    f.material.dispose();
    mesh.dispose();
    expect(disposals).toEqual({
      mesh: 1,
      geometry: 1,
      material: 1,
      base: 0,
      texture: 0,
    });
    expect(f.base.positionNode).toBe(basePosition);
    expect(f.base.normalNode).toBe(baseNormal);
    expect(f.base.map).toBe(f.texture);
    f.template.dispose();
    f.base.dispose();
    f.texture.dispose();
  });

  it("never exposes undeformed template triangles as gameplay ray hits", () => {
    const f = fixture();
    const mesh = createMatrixFreeGrassMesh(f.geometry, f.material);
    const triangle = new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 0, 1, 0], 3),
    );
    const ray = new THREE.Raycaster(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, -1),
    );
    const ordinary = new THREE.Mesh(triangle, f.base);
    try {
      expect(ray.intersectObject(ordinary, false)).toHaveLength(1);
      // Exercise the same actual ray traversal with guaranteed hittable
      // geometry: the candidate's explicit policy must not inspect it.
      const bound = mesh.geometry;
      mesh.geometry = triangle;
      try {
        expect(ray.intersectObject(mesh, false)).toEqual([]);
      } finally {
        mesh.geometry = bound;
      }
    } finally {
      mesh.dispose();
      triangle.dispose();
      f.dispose();
    }
  });
});

describe("real Three grounding bindings and provenance (not a GPU test)", () => {
  it("admits only explicit bounded layouts, not array-derived topology", () => {
    expect(getGrassBladeLayout(0)).toMatchObject({
      verticesPerBlade: 7,
      verticesPerClump: 168,
      trianglesPerClump: 120,
    });
    expect(getGrassBladeLayout(0, "fine-linear-sweep-near4-v1")).toMatchObject({
      verticesPerBlade: 9,
      verticesPerClump: 216,
      trianglesPerClump: 168,
      rootComponents: 2,
    });
    expect(getGrassBladeLayout(1, "fine-linear-sweep-near4-v1")).toMatchObject({
      verticesPerBlade: 5,
      verticesPerClump: 60,
      trianglesPerClump: 36,
    });
    expect(getGrassBladeLayout(0, "fine-folded-lancet-v1")).toMatchObject({
      bladeSegments: 3,
      verticesPerBlade: 9,
      verticesPerClump: 216,
      trianglesPerClump: 216,
      rootComponents: 2,
    });
    for (const lod of [0, 1, 2])
      expect(
        getGrassBladeLayout(lod, "fine-folded-sheath-near5-v1"),
      ).toMatchObject({
        bladesPerClump: [24, 24, 12][lod],
        bladeSegments: [5, 3, 2][lod],
        verticesPerBlade: [15, 9, 5][lod],
        verticesPerClump: [360, 216, 60][lod],
        trianglesPerClump: [408, 216, 36][lod],
        rootComponents: 2,
      });
    for (const lod of [-1, 3, 0.5, NaN, Infinity])
      expect(() => getGrassBladeLayout(lod)).toThrow(/layout/);
    for (const layout of [
      null,
      "",
      "ordinary-v1",
      {},
      "fine-linear-sweep-near5-v1",
      "fine-folded-sheath-near6-v1",
    ])
      expect(() =>
        getGrassBladeLayout(0, layout as FineGrassGeometryLayout),
      ).toThrow(/layout/);
    const base = new MeshStandardNodeMaterial();
    base.positionNode = vec3(0);
    for (const [vertices, layout] of [
      [216, undefined],
      [216, "fine-linear-sweep-3seg-v1"],
      [168, "fine-linear-sweep-near4-v1"],
      [168, "fine-folded-lancet-v1"],
      [216, "fine-folded-sheath-near5-v1"],
      [432, "fine-folded-sheath-near5-v1"],
    ] as const) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(vertices * 3), 3),
      );
      try {
        expect(() =>
          createGroundedGrassMaterial(
            base,
            geometry,
            new Float32Array(48),
            1,
            0,
            layout,
          ),
        ).toThrow(/binding/);
        expect(geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);
      } finally {
        geometry.dispose();
      }
    }
    base.dispose();
  });
  it.each([0, 1, 2])(
    "owns one independent LOD%s storage binding per chunk while borrowing base nodes/maps",
    (lod) => {
      const blades = [24, 12, 4][lod],
        vertices = [7, 5, 3][lod];
      const base = new MeshStandardNodeMaterial(),
        texture = new THREE.Texture(),
        time = uniform(0);
      base.positionNode = vec3(time, 0, 0);
      base.map = texture;
      const basePosition = base.positionNode;
      let textureDisposals = 0,
        baseDisposals = 0;
      texture.addEventListener("dispose", () => textureDisposals++);
      base.addEventListener("dispose", () => baseDisposals++);
      const chunks = [1, 3].map((count) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(blades * vertices * 3), 3),
        );
        const deltas = Float32Array.from(
          { length: count * blades * 2 },
          (_, i) => i * 0.01,
        );
        const material = createGroundedGrassMaterial(
          base,
          geometry,
          deltas,
          count,
          lod,
        );
        return { geometry, material, deltas };
      });
      try {
        const bindings: StorageBufferAttribute[] = [];
        for (const { geometry, material, deltas } of chunks) {
          const nodes: Node[] = [];
          (material.positionNode as Node).traverse((node) => nodes.push(node));
          const storage = [
            ...new Set(
              nodes.filter(
                (node): node is StorageBufferNode<"vec2"> =>
                  "isStorageBufferNode" in node &&
                  node.isStorageBufferNode === true,
              ),
            ),
          ];
          expect(storage).toHaveLength(1);
          expect(storage[0].bufferCount).toBe(0);
          expect(storage[0].nodeType).toBe("vec2");
          expect(storage[0].access).toBe("readOnly");
          const binding = geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE);
          expect(binding).toBeInstanceOf(StorageBufferAttribute);
          expect(storage[0].value).toBe(binding);
          expect(binding.array).toBe(deltas);
          expect(nodes).toContain(basePosition);
          expect(nodes).toContain(time);
          expect(material.map).toBe(texture);
          expect(base.positionNode).toBe(basePosition);
          expect(() =>
            createGroundedGrassMaterial(
              base,
              geometry,
              deltas,
              deltas.length / (blades * 2),
              lod,
            ),
          ).toThrow();
          bindings.push(binding as StorageBufferAttribute);
        }
        expect(bindings[0]).not.toBe(bindings[1]);
      } finally {
        for (const { geometry, material } of chunks) {
          geometry.dispose();
          material.dispose();
        }
        expect(baseDisposals).toBe(0);
        expect(textureDisposals).toBe(0);
        base.dispose();
        texture.dispose();
      }
    },
  );

  it("rejects wrong capacity/layout before attaching a storage allocation", () => {
    const base = new MeshStandardNodeMaterial(),
      geometry = new THREE.BufferGeometry();
    base.positionNode = vec3(0);
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(180), 3),
    );
    try {
      for (const count of [-1, 0, 1.1, 4097, NaN])
        expect(() =>
          createGroundedGrassMaterial(
            base,
            geometry,
            new Float32Array(24),
            count,
            1,
          ),
        ).toThrow();
      for (const lod of [-1, 0, 2, 3])
        expect(() =>
          createGroundedGrassMaterial(
            base,
            geometry,
            new Float32Array(24),
            1,
            lod,
          ),
        ).toThrow();
      expect(() =>
        createGroundedGrassMaterial(base, geometry, new Float32Array(23), 1, 1),
      ).toThrow();
      expect(geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);
    } finally {
      geometry.dispose();
      base.dispose();
    }
  });

  it.each([
    { lod: 0, blades: 24, vertices: 7, count: 1276, geometryLayout: undefined },
    { lod: 1, blades: 12, vertices: 5, count: 1276, geometryLayout: undefined },
    { lod: 0, blades: 24, vertices: 7, count: 4096, geometryLayout: undefined },
    { lod: 1, blades: 12, vertices: 5, count: 4096, geometryLayout: undefined },
    {
      lod: 0,
      blades: 24,
      vertices: 7,
      count: 1276,
      geometryLayout: "fine-linear-sweep-3seg-v1" as const,
    },
    {
      lod: 0,
      blades: 24,
      vertices: 9,
      count: 1276,
      geometryLayout: "fine-linear-sweep-near4-v1" as const,
    },
    {
      lod: 0,
      blades: 24,
      vertices: 9,
      count: 4096,
      geometryLayout: "fine-linear-sweep-near4-v1" as const,
    },
    {
      lod: 1,
      blades: 12,
      vertices: 5,
      count: 1276,
      geometryLayout: "fine-linear-sweep-near4-v1" as const,
    },
    {
      lod: 0,
      blades: 24,
      vertices: 9,
      count: 1276,
      geometryLayout: "fine-folded-lancet-v1" as const,
    },
    {
      lod: 0,
      blades: 24,
      vertices: 9,
      count: 4096,
      geometryLayout: "fine-folded-lancet-v1" as const,
    },
    ...[1276, 4096].flatMap((count) =>
      [0, 1, 2].map((lod) => ({
        lod,
        count,
        blades: [24, 24, 12][lod],
        vertices: [15, 9, 5][lod],
        geometryLayout: "fine-folded-sheath-near5-v1" as const,
      })),
    ),
    ...[1276, 4096].flatMap((count) =>
      [0, 1, 2].map((lod) => ({
        lod,
        count,
        blades: [21, 21, 12][lod],
        vertices: [8, 5, 5][lod],
        geometryLayout: "fine-meadow-paired-near-v1" as const,
      })),
    ),
  ])(
    "keeps LOD$lod count$count correction capacity and every boundary address exact",
    ({ lod, blades, vertices, count, geometryLayout }) => {
      // 1,276 is the complete proposed 25 m/.7 m candidate quota, not an
      // accepted-population claim. The existing 4,096 hard cap stays unchanged.
      expect(Math.ceil(25 ** 2 / 0.7 ** 2)).toBe(1276);
      const base = new MeshStandardNodeMaterial(),
        geometry = new THREE.BufferGeometry();
      base.positionNode = vec3(1, 2, 3);
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(blades * vertices * 3), 3),
      );
      let material: MeshStandardNodeMaterial | undefined;
      try {
        // Reject cross-tier correction layouts before publishing any binding.
        const otherBlades = blades === 24 ? 12 : 24;
        expect(() =>
          createGroundedGrassMaterial(
            base,
            geometry,
            new Float32Array(count * otherBlades * 2),
            count,
            lod,
            geometryLayout,
          ),
        ).toThrow("Invalid grounded grass binding");
        expect(geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);
        expect(() =>
          createGroundedGrassMaterial(
            base,
            geometry,
            new Float32Array(4097 * blades * 2),
            4097,
            lod,
            geometryLayout,
          ),
        ).toThrow("Invalid grounded grass binding");
        expect(geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);

        const deltas = Float32Array.from(
          { length: count * blades * 2 },
          (_, i) => (i % 1024) / 1024,
        );
        material = createGroundedGrassMaterial(
          base,
          geometry,
          deltas,
          count,
          lod,
          geometryLayout,
        );
        if (geometryLayout === undefined)
          expect(
            Object.prototype.hasOwnProperty.call(
              material.userData,
              "grassBladeLayout",
            ),
          ).toBe(false);
        else {
          const descriptor = getGrassBladeLayout(lod, geometryLayout);
          expect(material.userData.grassBladeLayout).toBe(descriptor);
          expect(Object.isFrozen(descriptor)).toBe(true);
          expect(
            Object.getOwnPropertyDescriptor(
              material.userData,
              "grassBladeLayout",
            ),
          ).toMatchObject({
            writable: false,
            configurable: false,
            enumerable: true,
          });
        }
        const binding = geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE);
        expect(binding).toBeInstanceOf(StorageBufferAttribute);
        expect(binding.itemSize).toBe(2);
        expect(binding.count).toBe(count * blades);
        expect(binding.array).toBe(deltas);
        expect(binding.array.byteLength).toBe(count * blades * 8);
        const accesses = new Set<Node>();
        const positionNode = material.positionNode;
        if (!(positionNode instanceof THREE.Node))
          throw new Error("Missing actual corrected grass position node");
        positionNode.traverse((node) => {
          if (
            Reflect.get(node, "isArrayElementNode") === true &&
            Reflect.get(Reflect.get(node, "node"), "value") === binding
          )
            accesses.add(node);
        });
        expect(accesses.size).toBe(1);
        const address: unknown = Reflect.get([...accesses][0], "indexNode");
        if (!(address instanceof THREE.Node))
          throw new Error("Missing actual root storage address");
        for (const instance of [0, 1, count - 1])
          for (let vertex = 0; vertex < blades * vertices; vertex++) {
            const actual = storageAddress(address, instance, vertex);
            expect(actual).toBe(
              instance * blades + Math.floor(vertex / vertices),
            );
            expect(actual).toBeGreaterThanOrEqual(0);
            expect(actual).toBeLessThan(binding.count);
          }
        expect(storageAddress(address, count - 1, blades * vertices - 1)).toBe(
          binding.count - 1,
        );
        expect(base.positionNode).not.toBe(material.positionNode);
      } finally {
        material?.dispose();
        geometry.dispose();
        base.dispose();
      }
    },
  );

  it.each(
    (
      [
        undefined,
        "fine-linear-sweep-3seg-v1",
        "fine-linear-sweep-near4-v1",
        "fine-folded-lancet-v1",
        "fine-folded-sheath-near5-v1",
        "fine-meadow-paired-near-v1",
      ] as const
    ).flatMap((geometryLayout) =>
      [0, 1, 2].map((lod) => ({ geometryLayout, lod })),
    ),
  )(
    "selects exact per-instance visible blade bits and a common collapse anchor for $geometryLayout LOD$lod",
    ({ geometryLayout, lod }) => {
      const tier = getGrassBladeLayout(lod, geometryLayout),
        count = 3,
        allBits = 2 ** tier.bladesPerClump - 1,
        masks = new Uint32Array([1, 2 ** (tier.bladesPerClump - 1), allBits]),
        maskBefore = masks.slice(),
        base = new MeshStandardNodeMaterial(),
        time = uniform(0.37),
        geometry = bindingGeometry(lod, count, geometryLayout),
        unmaskedGeometry = bindingGeometry(lod, count, geometryLayout),
        deltas = Float32Array.from(
          { length: count * tier.bladesPerClump * 2 },
          (_, index) => (index + 1) / 16,
        );
      base.positionNode = vec3(time, 9, -3);
      const borrowedPosition = base.positionNode;
      let material: MeshStandardNodeMaterial | undefined,
        unmasked: MeshStandardNodeMaterial | undefined;
      try {
        material = createGroundedGrassMaterial(
          base,
          geometry,
          deltas,
          count,
          lod,
          geometryLayout,
          masks,
        );
        unmasked = createGroundedGrassMaterial(
          base,
          unmaskedGeometry,
          deltas,
          count,
          lod,
          geometryLayout,
        );
        const binding = geometry.getAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE);
        expect(binding).toBeInstanceOf(StorageBufferAttribute);
        if (!(binding instanceof StorageBufferAttribute))
          throw new Error("Missing actual visibility binding");
        expect(binding.array).toBe(masks);
        expect(binding.array.byteLength).toBe(count * 4);
        expect(binding.count).toBe(count);
        expect(binding.itemSize).toBe(1);
        expect(binding.isStorageBufferAttribute).toBe(true);
        expect(binding).not.toBeInstanceOf(THREE.InstancedBufferAttribute);
        expect(binding.normalized).toBe(false);
        const selected = material.positionNode as Node;
        expect(selected.type).toBe("ConditionalNode");
        const condition = childNode(selected, "condNode"),
          corrected = childNode(selected, "ifNode"),
          collapsed = childNode(selected, "elseNode");
        expect(graphShape(corrected)).toEqual(
          graphShape(unmasked.positionNode as Node),
        );
        expect(collapsed.type).toBe("AttributeNode");
        expect(collapsed.nodeType).toBe("vec3");
        expect(Reflect.get(collapsed, "_attributeName")).toBe("instanceOffset");
        expect([...collapsed.getChildren()]).toEqual([]);
        const nodes: Node[] = [];
        selected.traverse((node) => nodes.push(node));
        const maskStorage = nodes.filter(
          (node) =>
            node.type === "StorageBufferNode" &&
            Reflect.get(node, "value") === binding,
        );
        expect(new Set(maskStorage).size).toBe(1);
        expect(maskStorage[0].nodeType).toBe("uint");
        expect(Reflect.get(maskStorage[0], "bufferCount")).toBe(0);
        expect(Reflect.get(maskStorage[0], "access")).toBe("readOnly");
        expect(
          nodes.some(
            (node) =>
              node.type === "AttributeNode" &&
              Reflect.get(node, "_attributeName") ===
                GRASS_BLADE_VISIBILITY_ATTRIBUTE,
          ),
        ).toBe(false);
        expect(nodes).toContain(borrowedPosition);
        expect(nodes).toContain(time);
        expect(
          nodes.filter((node) => node.type === "ConditionalNode"),
        ).toHaveLength(1);
        expect(nodes.some((node) => /Discard/.test(node.type))).toBe(false);
        const offset = geometry.getAttribute("instanceOffset");
        for (let instance = 0; instance < count; instance++) {
          const anchor = [
            offset.getX(instance),
            offset.getY(instance),
            offset.getZ(instance),
          ];
          for (let blade = 0; blade < tier.bladesPerClump; blade++) {
            const visible = (masks[instance] & (1 << blade)) !== 0;
            const hiddenPositions: number[][] = [];
            for (let v = 0; v < tier.verticesPerBlade; v++) {
              const vertex = blade * tier.verticesPerBlade + v;
              expect(
                storageAddress(
                  condition,
                  instance,
                  vertex,
                  binding.getX(instance),
                ),
              ).toBe(Number(visible));
              if (!visible) {
                // Interpret the actual selected attribute leaf, not an invented
                // shader: no vertex-dependent node or correction follows it.
                const actual = geometry.getAttribute(
                  Reflect.get(collapsed, "_attributeName"),
                );
                hiddenPositions.push([
                  actual.getX(instance),
                  actual.getY(instance),
                  actual.getZ(instance),
                ]);
              }
            }
            if (!visible) {
              expect(hiddenPositions).toHaveLength(tier.verticesPerBlade);
              for (const position of hiddenPositions)
                expect(position).toEqual(anchor);
              const a = new THREE.Vector3().fromArray(hiddenPositions[0]),
                b = new THREE.Vector3().fromArray(hiddenPositions[1]),
                c = new THREE.Vector3().fromArray(hiddenPositions[2]);
              expect(b.sub(a).cross(c.sub(a)).lengthSq()).toBe(0);
            }
          }
        }
        expect(masks).toEqual(maskBefore);
        expect(base.positionNode).toBe(borrowedPosition);
        expect(
          unmaskedGeometry.hasAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE),
        ).toBe(false);
      } finally {
        material?.dispose();
        unmasked?.dispose();
        geometry.dispose();
        unmaskedGeometry.dispose();
        base.dispose();
      }
    },
  );

  it.each([
    {
      geometryLayout: "fine-meadow-paired-near-v1",
      lod: 0,
      blades: 21,
      segments: 2,
      vertices: 8,
      triangles: 6,
      crossSection: undefined,
      centers: [4, 7],
    },
    {
      geometryLayout: "fine-folded-lancet-v1",
      lod: 0,
      blades: 24,
      segments: 3,
      vertices: 9,
      triangles: 9,
      crossSection: "folded-lancet-v1",
      centers: [7, 8],
    },
    {
      geometryLayout: "fine-folded-sheath-near5-v1",
      lod: 0,
      blades: 24,
      segments: 5,
      vertices: 15,
      triangles: 17,
      crossSection: "folded-sheath-v1",
      centers: [11, 12, 13, 14],
    },
    {
      geometryLayout: "fine-folded-sheath-near5-v1",
      lod: 1,
      blades: 24,
      segments: 3,
      vertices: 9,
      triangles: 9,
      crossSection: "folded-lancet-v1",
      centers: [7, 8],
    },
    {
      geometryLayout: "fine-folded-sheath-near5-v1",
      lod: 2,
      blades: 12,
      segments: 2,
      vertices: 5,
      triangles: 3,
      crossSection: undefined,
      centers: [],
    },
  ] as const)(
    "addresses every actual $geometryLayout LOD$lod vertex, center and root pair without new vertex-input bindings",
    ({
      geometryLayout,
      lod,
      blades,
      segments,
      vertices,
      triangles,
      crossSection,
      centers,
    }) => {
      const geometry =
        geometryLayout === "fine-meadow-paired-near-v1"
          ? createPairedMeadowClumpGeometry()
          : createClumpGeometry(
              blades,
              segments,
              FINE_GRASS_FOLDED_BLADE_SHAPE,
              crossSection,
            );
      const base = new MeshStandardNodeMaterial();
      base.positionNode = vec3(0);
      const count = 3;
      const deltas = Float32Array.from(
        { length: count * blades * 2 },
        (_, i) => (i + 1) / 4,
      );
      const masks = new Uint32Array([
        1,
        1 << (blades - 1),
        0x555555 & (2 ** blades - 1),
      ]);
      geometry.setAttribute(
        "instanceOffset",
        new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3),
      );
      let material: MeshStandardNodeMaterial | undefined;
      try {
        expect(geometry.getAttribute("position").count).toBe(blades * vertices);
        expect(geometry.getIndex()?.count).toBe(blades * triangles * 3);
        if (geometryLayout === "fine-meadow-paired-near-v1") {
          // Forty-two physical leaves still own twenty-one root pairs/bits.
          expect(() =>
            createGroundedGrassMaterial(
              base,
              geometry,
              new Float32Array(count * 42 * 2),
              count,
              lod,
              geometryLayout,
              masks,
            ),
          ).toThrow(/binding/);
          expect(geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(
            false,
          );
          expect(geometry.hasAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE)).toBe(
            false,
          );
        }
        // Historical/default tier descriptors must not interpret a new stride
        // or population. Equal stride alone is not a topology proof: exact
        // folded index order is validated by CPU admission, not this binder.
        for (const wrong of [undefined, "fine-linear-sweep-3seg-v1"] as const) {
          expect(() =>
            createGroundedGrassMaterial(
              base,
              geometry,
              deltas,
              count,
              lod,
              wrong,
              masks,
            ),
          ).toThrow(/binding/);
          expect(geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(
            false,
          );
          expect(geometry.hasAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE)).toBe(
            false,
          );
        }
        expect(() =>
          createGroundedGrassMaterial(
            base,
            geometry,
            deltas,
            count,
            lod,
            geometryLayout,
            new Uint32Array([1, 2 ** blades, 1]),
          ),
        ).toThrow(/visibility/);
        expect(geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);
        expect(geometry.hasAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE)).toBe(
          false,
        );
        material = createGroundedGrassMaterial(
          base,
          geometry,
          deltas,
          count,
          lod,
          geometryLayout,
          masks,
        );
        const roots = geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE);
        const visibility = geometry.getAttribute(
          GRASS_BLADE_VISIBILITY_ATTRIBUTE,
        );
        if (
          !(roots instanceof StorageBufferAttribute) ||
          !(visibility instanceof StorageBufferAttribute)
        )
          throw new Error("Missing actual folded storage bindings");
        const selected = material.positionNode;
        if (!(selected instanceof THREE.Node))
          throw new Error("Missing actual folded position graph");
        expect(selected.type).toBe("ConditionalNode");
        const condition = childNode(selected, "condNode");
        const nodes = new Set<Node>();
        selected.traverse((node) => nodes.add(node));
        const mixes = [...nodes].filter(
          (node) =>
            node.type === "MathNode" && Reflect.get(node, "method") === "mix",
        );
        expect(mixes).toHaveLength(1);
        const mix = mixes[0];
        const rootAccess = childNode(childNode(mix, "aNode"), "node");
        expect(rootAccess.type).toBe("StorageArrayElementNode");
        expect(Reflect.get(childNode(rootAccess, "node"), "value")).toBe(roots);
        const address = childNode(rootAccess, "indexNode");
        const uv = geometry.getAttribute("uv");
        // Interpret only the actual constructed scalar root mix and its bound
        // storage/UV leaves; no renderer or replacement shader is simulated.
        const scalar = (
          node: Node,
          instance: number,
          vertex: number,
        ): number => {
          if (node.type === "VarNode" || node.type === "ConvertNode")
            return scalar(childNode(node, "node"), instance, vertex);
          if (
            node.type === "MathNode" &&
            Reflect.get(node, "method") === "mix"
          ) {
            const a = scalar(childNode(node, "aNode"), instance, vertex);
            const b = scalar(childNode(node, "bNode"), instance, vertex);
            const t = scalar(childNode(node, "cNode"), instance, vertex);
            return a * (1 - t) + b * t;
          }
          if (node.type !== "SplitNode")
            throw new Error("Unexpected actual root interpolation node");
          const component: unknown = Reflect.get(node, "components");
          const source = childNode(node, "node");
          if (
            source.type === "AttributeNode" &&
            Reflect.get(source, "_attributeName") === "uv" &&
            component === "x"
          )
            return uv.getX(vertex);
          if (
            source.type !== "StorageArrayElementNode" ||
            Reflect.get(childNode(source, "node"), "value") !== roots ||
            (component !== "x" && component !== "y")
          )
            throw new Error(
              "Root interpolation must use its own vec2 storage and actual uv.x",
            );
          const index = storageAddress(
            childNode(source, "indexNode"),
            instance,
            vertex,
          );
          return component === "x" ? roots.getX(index) : roots.getY(index);
        };
        for (const instance of [0, 1, 2])
          for (let blade = 0; blade < blades; blade++) {
            const root = instance * blades + blade;
            for (let local = 0; local < vertices; local++) {
              const vertex = blade * vertices + local;
              expect(storageAddress(address, instance, vertex)).toBe(root);
              expect(
                storageAddress(condition, instance, vertex, masks[instance]),
              ).toBe(Number((masks[instance] & (1 << blade)) !== 0));
              const u = uv.getX(vertex);
              expect(scalar(mix, instance, vertex)).toBe(
                deltas[root * 2] * (1 - u) + deltas[root * 2 + 1] * u,
              );
            }
            for (const center of centers) {
              const vertex = blade * vertices + center;
              expect(uv.getX(vertex)).toBe(0.5);
              expect(uv.getY(vertex)).toBe(
                geometryLayout === "fine-meadow-paired-near-v1"
                  ? 1
                  : Math.fround((center - 2 * segments) / segments),
              );
              expect(scalar(mix, instance, vertex)).toBe(
                (deltas[root * 2] + deltas[root * 2 + 1]) / 2,
              );
              if (blade < blades - 1) {
                expect(
                  storageAddress(address, instance, vertex + vertices - center),
                ).toBe(root + 1);
                expect(storageAddress(address, instance, vertex)).not.toBe(
                  storageAddress(address, instance, vertex + vertices - center),
                );
              }
            }
          }
        // These two runtime arrays must not add vertex inputs to the existing
        // eight-buffer production layout. Native compilation remains a later gate.
        const storage = [...nodes].filter(
          (node) => node.type === "StorageBufferNode",
        );
        expect(storage).toHaveLength(2);
        for (const node of storage) {
          expect(Reflect.get(node, "bufferCount")).toBe(0);
          expect(Reflect.get(node, "access")).toBe("readOnly");
        }
        expect(new Set(storage.map((node) => node.nodeType))).toEqual(
          new Set(["vec2", "uint"]),
        );
        expect(
          [...nodes]
            .filter((node) => node.type === "AttributeNode")
            .map((node) => Reflect.get(node, "_attributeName"))
            .sort(),
        ).toEqual(["instanceOffset", "uv"]);
        for (const binding of [roots, visibility])
          expect(binding).not.toBeInstanceOf(THREE.InstancedBufferAttribute);
        expect(roots.array.byteLength).toBe(count * blades * 2 * 4);
        expect(visibility.array.byteLength).toBe(count * 4);
      } finally {
        material?.dispose();
        geometry.dispose();
        base.dispose();
      }
    },
  );

  it.each([1, 2])(
    "retains the historical LOD%s root/mask graph for the folded near-only layout",
    (lod) => {
      const oldTier = getGrassBladeLayout(lod, "fine-linear-sweep-3seg-v1");
      const foldedTier = getGrassBladeLayout(lod, "fine-folded-lancet-v1");
      expect(foldedTier).toEqual({
        ...oldTier,
        geometryLayout: "fine-folded-lancet-v1",
      });
      const base = new MeshStandardNodeMaterial();
      base.positionNode = vec3(1, 2, 3);
      const oldGeometry = bindingGeometry(lod, 2, "fine-linear-sweep-3seg-v1");
      const foldedGeometry = bindingGeometry(lod, 2, "fine-folded-lancet-v1");
      const deltas = Float32Array.from(
        { length: 2 * oldTier.bladesPerClump * 2 },
        (_, i) => i / 8,
      );
      const masks = new Uint32Array([1, 2 ** oldTier.bladesPerClump - 1]);
      const oldMaterial = createGroundedGrassMaterial(
        base,
        oldGeometry,
        deltas,
        2,
        lod,
        "fine-linear-sweep-3seg-v1",
        masks,
      );
      const foldedMaterial = createGroundedGrassMaterial(
        base,
        foldedGeometry,
        deltas,
        2,
        lod,
        "fine-folded-lancet-v1",
        masks,
      );
      try {
        const oldNode = oldMaterial.positionNode,
          foldedNode = foldedMaterial.positionNode;
        if (
          !(oldNode instanceof THREE.Node) ||
          !(foldedNode instanceof THREE.Node)
        )
          throw new Error("Missing actual LOD position graph");
        expect(graphShape(foldedNode)).toEqual(graphShape(oldNode));
        expect(Object.keys(foldedGeometry.attributes)).toEqual(
          Object.keys(oldGeometry.attributes),
        );
      } finally {
        oldMaterial.dispose();
        foldedMaterial.dispose();
        oldGeometry.dispose();
        foldedGeometry.dispose();
        base.dispose();
      }
    },
  );

  it("leaves omitted and explicit-undefined mask graphs and attributes identical", () => {
    const base = new MeshStandardNodeMaterial(),
      omittedGeometry = bindingGeometry(1, 1),
      undefinedGeometry = bindingGeometry(1, 1),
      deltas = new Float32Array(24);
    base.positionNode = vec3(1, 2, 3);
    // Legacy bindings never required instanceOffset, and still must not.
    omittedGeometry.deleteAttribute("instanceOffset");
    undefinedGeometry.deleteAttribute("instanceOffset");
    const omitted = createGroundedGrassMaterial(
        base,
        omittedGeometry,
        deltas,
        1,
        1,
      ),
      explicit = createGroundedGrassMaterial(
        base,
        undefinedGeometry,
        deltas,
        1,
        1,
        undefined,
        undefined,
      );
    try {
      expect(graphShape(omitted.positionNode as Node)).toEqual(
        graphShape(explicit.positionNode as Node),
      );
      for (const geometry of [omittedGeometry, undefinedGeometry])
        expect(Object.keys(geometry.attributes)).toEqual([
          "position",
          GRASS_ROOT_STORAGE_ATTRIBUTE,
        ]);
      for (const material of [omitted, explicit]) {
        const positionNode = material.positionNode;
        if (!(positionNode instanceof THREE.Node))
          throw new Error("Missing actual unmasked grass position node");
        expect(positionNode.type).toBe("VarNode");
        const sum = childNode(positionNode, "node");
        expect(sum.type).toBe("OperatorNode");
        expect(Reflect.get(sum, "op")).toBe("+");
        const nodes: Node[] = [];
        positionNode.traverse((node) => nodes.push(node));
        expect(nodes.some((node) => node.type === "ConditionalNode")).toBe(
          false,
        );
        expect(
          nodes.some(
            (node) =>
              Reflect.get(node, "_attributeName") ===
              GRASS_BLADE_VISIBILITY_ATTRIBUTE,
          ),
        ).toBe(false);
      }
    } finally {
      omitted.dispose();
      explicit.dispose();
      omittedGeometry.dispose();
      undefinedGeometry.dispose();
      base.dispose();
    }
  });

  it.each([0, 1, 2])(
    "rejects invalid LOD%s visibility masks before mutating geometry",
    (lod) => {
      const tier = getGrassBladeLayout(lod),
        base = new MeshStandardNodeMaterial(),
        geometry = bindingGeometry(lod, 2),
        deltas = new Float32Array(4 * tier.bladesPerClump),
        valid = 2 ** tier.bladesPerClump - 1;
      base.positionNode = vec3(0);
      try {
        for (const invalid of [
          null,
          [1, 1],
          new Float32Array([1, 1]),
          new Int32Array([1, 1]),
          new Uint32Array(),
          new Uint32Array([1]),
          new Uint32Array([1, 1, 1]),
          new Uint32Array([0, 1]),
          new Uint32Array([1, 0]),
          new Uint32Array([valid, 2 ** tier.bladesPerClump]),
          new Uint32Array([1, 0xffffffff]),
        ]) {
          expect(() =>
            createGroundedGrassMaterial(
              base,
              geometry,
              deltas,
              2,
              lod,
              undefined,
              invalid as Uint32Array,
            ),
          ).toThrow(/visibility/);
          expect(Object.keys(geometry.attributes)).toEqual([
            "position",
            "instanceOffset",
          ]);
        }
        const previous = new THREE.InstancedBufferAttribute(
          new Uint32Array([1, 1]),
          1,
        );
        geometry.setAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE, previous);
        expect(() =>
          createGroundedGrassMaterial(
            base,
            geometry,
            deltas,
            2,
            lod,
            undefined,
            new Uint32Array([1, 1]),
          ),
        ).toThrow(/visibility/);
        expect(geometry.getAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE)).toBe(
          previous,
        );
        expect(geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);
      } finally {
        geometry.dispose();
        base.dispose();
      }
    },
  );

  it("requires a finite per-instance Float32 common anchor for masked bindings", () => {
    const base = new MeshStandardNodeMaterial(),
      geometry = bindingGeometry(1, 2);
    base.positionNode = vec3(0);
    const repeated = new THREE.InstancedBufferAttribute(
      new Float32Array(6),
      3,
      false,
      2,
    );
    const nan = new THREE.InstancedBufferAttribute(
      new Float32Array([0, NaN, 0, 0, 0, 0]),
      3,
    );
    try {
      for (const offset of [
        undefined,
        new THREE.BufferAttribute(new Float32Array(6), 3),
        new THREE.InstancedBufferAttribute(new Float32Array(4), 2),
        new THREE.InstancedBufferAttribute(new Float32Array(3), 3),
        new THREE.InstancedBufferAttribute(new Float32Array(9), 3),
        new THREE.InstancedBufferAttribute(new Float32Array(6), 3, true),
        new THREE.InstancedBufferAttribute(new Uint32Array(6), 3),
        repeated,
        nan,
      ]) {
        if (offset) geometry.setAttribute("instanceOffset", offset);
        else geometry.deleteAttribute("instanceOffset");
        expect(() =>
          createGroundedGrassMaterial(
            base,
            geometry,
            new Float32Array(48),
            2,
            1,
            undefined,
            new Uint32Array([1, 1]),
          ),
        ).toThrow(/visibility/);
        expect(geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);
        expect(geometry.hasAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE)).toBe(
          false,
        );
      }
    } finally {
      geometry.dispose();
      base.dispose();
    }
  });

  it("gives each masked chunk independent geometry bindings without retiring borrowed resources", () => {
    const base = new MeshStandardNodeMaterial(),
      texture = new THREE.Texture(),
      time = uniform(0);
    base.positionNode = vec3(time, 0, 0);
    base.map = texture;
    let baseDisposals = 0,
      textureDisposals = 0;
    base.addEventListener("dispose", () => baseDisposals++);
    texture.addEventListener("dispose", () => textureDisposals++);
    const chunks = [1, 2].map((count) => {
      const geometry = bindingGeometry(1, count),
        masks = new Uint32Array(count).fill(1);
      const material = createGroundedGrassMaterial(
        base,
        geometry,
        new Float32Array(count * 24),
        count,
        1,
        undefined,
        masks,
      );
      return { geometry, material, masks };
    });
    try {
      expect(
        chunks[0].geometry.getAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE),
      ).not.toBe(
        chunks[1].geometry.getAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE),
      );
      expect(
        chunks[0].geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE),
      ).not.toBe(chunks[1].geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE));
      for (const { geometry, material, masks } of chunks) {
        let geometryDisposals = 0,
          materialDisposals = 0;
        geometry.addEventListener("dispose", () => {
          geometryDisposals++;
          expect(
            geometry.getAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE).array,
          ).toBe(masks);
          expect(
            geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE),
          ).toBeInstanceOf(StorageBufferAttribute);
        });
        material.addEventListener("dispose", () => materialDisposals++);
        expect(material.map).toBe(texture);
        material.dispose();
        expect(geometryDisposals).toBe(0);
        expect(materialDisposals).toBe(1);
        geometry.dispose();
        expect(geometryDisposals).toBe(1);
      }
      expect(baseDisposals).toBe(0);
      expect(textureDisposals).toBe(0);
      expect(time.value).toBe(0);
    } finally {
      base.dispose();
      texture.dispose();
    }
  });

  it("compacts ecological provenance in admitted order without retaining or changing borrowed arrays", () => {
    const source: GrassGrounding = {
      schemaVersion: 1,
      surfaceRevision: "retained:7",
      computedHeights: new Float32Array([10, 20, 30]),
      ecologicalNormals: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    };
    const before = structuredClone(source);
    const result = drain(
      remapGrassGroundingSteps(source, new Uint32Array([0, 2])),
    );
    expect(result).toEqual({
      ...source,
      computedHeights: new Float32Array([10, 30]),
      ecologicalNormals: new Float32Array([1, 2, 3, 7, 8, 9]),
    });
    expect(source).toEqual(before);
    expect(result.computedHeights.buffer).not.toBe(
      source.computedHeights.buffer,
    );
    expect(result.ecologicalNormals.buffer).not.toBe(
      source.ecologicalNormals.buffer,
    );
    expect(
      drain(remapGrassGroundingSteps(source, new Uint32Array())),
    ).toMatchObject({
      computedHeights: new Float32Array(),
      ecologicalNormals: new Float32Array(),
    });
    for (const indices of [[0, 0], [2, 1], [3], [0, 1, 2, 3]])
      expect(() =>
        drain(remapGrassGroundingSteps(source, new Uint32Array(indices))),
      ).toThrow();
    source.computedHeights[0] = NaN;
    expect(() =>
      drain(remapGrassGroundingSteps(source, new Uint32Array([0]))),
    ).toThrow();
  });
});

describe("explicit authored meadow grounding prerequisite (no runtime admission)", () => {
  it.each([1, 3, 128])(
    "addresses all 21 blades and 15 vertices for %s clumps",
    (count) => {
      const { geometry, coarseGeometry } = createMeadowAuthoredClumpGeometry();
      const base = new MeshStandardNodeMaterial(),
        time = uniform(0.37),
        texture = new THREE.Texture();
      base.positionNode = attribute("position", "vec3").add(vec3(time, 0, 0));
      base.normalNode = varying(
        attribute("normal", "vec3"),
        "authoredGroundingNormal",
      );
      base.map = texture;
      const deltas = Float32Array.from(
        { length: count * 42 },
        (_, i) => (i - 17) / 32,
      );
      const masks = Uint32Array.from({ length: count }, (_, i) =>
        i % 3 === 0 ? 1 : i % 3 === 1 ? 1 << 20 : 0x155555,
      );
      geometry.setAttribute(
        "instanceOffset",
        new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3),
      );
      const positions = geometry.getAttribute("position").array.slice();
      const original = {
        position: base.positionNode,
        normal: base.normalNode,
        deltas: deltas.slice(),
        masks: masks.slice(),
      };
      let material: MeshStandardNodeMaterial | undefined;
      let baseDisposals = 0,
        textureDisposals = 0;
      base.addEventListener("dispose", () => baseDisposals++);
      texture.addEventListener("dispose", () => textureDisposals++);
      try {
        expect(() =>
          createGroundedGrassMaterial(
            base,
            geometry,
            deltas,
            count,
            0,
            "fine-meadow-ribbon-v1",
            masks,
          ),
        ).toThrow(/binding/);
        expect(geometry.hasAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE)).toBe(false);
        material = createGroundedGrassMeadowAuthoredMaterial(
          base,
          geometry,
          coarseGeometry,
          deltas,
          count,
          masks,
        );
        expect(material.userData.grassMeadowAuthoredGrounding).toBe(
          GRASS_MEADOW_AUTHORED_GROUNDING,
        );
        expect(GRASS_MEADOW_AUTHORED_GROUNDING.endpointId).toBe(
          "meadow-authored-silhouette-v1",
        );
        expect(
          Object.getOwnPropertyDescriptor(
            material.userData,
            "grassMeadowAuthoredGrounding",
          ),
        ).toMatchObject({ writable: false, configurable: false });
        expect(
          Object.isFrozen(material.userData.grassMeadowAuthoredGrounding),
        ).toBe(true);
        expect(material.userData.grassBladeLayout).toBeUndefined();
        const roots = geometry.getAttribute(GRASS_ROOT_STORAGE_ATTRIBUTE),
          visibility = geometry.getAttribute(GRASS_BLADE_VISIBILITY_ATTRIBUTE);
        expect(roots).toBeInstanceOf(StorageBufferAttribute);
        expect(visibility).toBeInstanceOf(StorageBufferAttribute);
        expect(roots.array).toBe(deltas);
        expect(visibility.array).toBe(masks);
        expect(roots.count).toBe(count * 21);
        expect(roots.itemSize).toBe(2);
        expect(visibility.count).toBe(count);
        expect(visibility.itemSize).toBe(1);
        const node = material.positionNode;
        if (!(node instanceof THREE.Node))
          throw new Error("Missing authored grounded position");
        const condition = childNode(node, "condNode");
        const collapsed = childNode(node, "elseNode");
        expect(Reflect.get(collapsed, "_attributeName")).toBe("instanceOffset");
        expect([...collapsed.getChildren()]).toEqual([]);
        const nodes = new Set<Node>();
        node.traverse((value) => nodes.add(value));
        const mixes = [...nodes].filter(
          (value) =>
            value.type === "MathNode" && Reflect.get(value, "method") === "mix",
        );
        expect(mixes).toHaveLength(1);
        const mixNode = mixes[0],
          left = childNode(mixNode, "aNode"),
          right = childNode(mixNode, "bNode"),
          blend = childNode(mixNode, "cNode");
        const access = childNode(left, "node");
        expect(access.type).toBe("StorageArrayElementNode");
        expect(childNode(right, "node")).toBe(access);
        expect(Reflect.get(left, "components")).toBe("x");
        expect(Reflect.get(right, "components")).toBe("y");
        expect(Reflect.get(childNode(access, "node"), "value")).toBe(roots);
        expect(Reflect.get(blend, "components")).toBe("x");
        expect(Reflect.get(childNode(blend, "node"), "_attributeName")).toBe(
          "uv",
        );
        const address = childNode(access, "indexNode"),
          uv = geometry.getAttribute("uv");
        for (let instance = 0; instance < count; instance++)
          for (let v = 0; v < 315; v++) {
            const blade = Math.floor(v / 15),
              index = storageAddress(address, instance, v);
            expect(index).toBe(instance * 21 + blade);
            expect(
              storageAddress(condition, instance, v, masks[instance]),
            ).toBe(Number((masks[instance] & (1 << blade)) !== 0));
            // The actual graph above is exactly mix(owned vec2.x, vec2.y, actual UV.x).
            const u = uv.getX(v);
            expect(roots.getX(index) * (1 - u) + roots.getY(index) * u).toBe(
              deltas[(instance * 21 + blade) * 2] * (1 - u) +
                deltas[(instance * 21 + blade) * 2 + 1] * u,
            );
          }
        expect(uv.getX(13)).toBe(0.25);
        expect(uv.getX(14)).toBe(0.75);
        expect(storageAddress(address, count - 1, 314)).toBe(count * 21 - 1);
        const bindings = [...nodes].filter(
          (value) => value.type === "StorageBufferNode",
        );
        expect(bindings).toHaveLength(2);
        for (const binding of bindings) {
          expect(Reflect.get(binding, "access")).toBe("readOnly");
          expect(Reflect.get(binding, "bufferCount")).toBe(0);
        }
        expect(
          [...nodes]
            .filter((value) => value.type === "AttributeNode")
            .map((value) => Reflect.get(value, "_attributeName")),
        ).not.toContain(GRASS_ROOT_STORAGE_ATTRIBUTE);
        expect(
          [...nodes]
            .filter((value) => value.type === "AttributeNode")
            .map((value) => Reflect.get(value, "_attributeName")),
        ).not.toContain(GRASS_BLADE_VISIBILITY_ATTRIBUTE);
        expect(material.normalNode).toBe(original.normal);
        expect(material.map).toBe(texture);
        expect(base.positionNode).toBe(original.position);
        expect(base.normalNode).toBe(original.normal);
        expect(geometry.getAttribute("position").array).toEqual(positions);
        expect(deltas).toEqual(original.deltas);
        expect(masks).toEqual(original.masks);
        if (count === 3) {
          const stages = groundingStageFlow(geometry, material);
          expect(stages.vertex).toMatch(/vertexIndex\s*\/\s*15u/);
          expect(stages.vertex).toMatch(/instanceIndex\s*\*\s*21u/);
          expect(stages.vertex).toContain("mix(");
          expect(stages.vertex.match(/var<storage,\s*read>/g)).toHaveLength(2);
          expect(stages.fragment).not.toMatch(
            /NodeBuffer_|var<storage|vertexIndex/,
          );
          expect(stages.attributes).not.toContain(GRASS_ROOT_STORAGE_ATTRIBUTE);
          expect(stages.attributes).not.toContain(
            GRASS_BLADE_VISIBILITY_ATTRIBUTE,
          );
          expect(stages.vertex + stages.fragment).not.toMatch(
            /undefined|NaN|Infinity/,
          );
        }
        expect(() =>
          createGroundedGrassMeadowAuthoredMaterial(
            base,
            geometry,
            coarseGeometry,
            deltas,
            count,
            masks,
          ),
        ).toThrow();
      } finally {
        material?.dispose();
        geometry.dispose();
        coarseGeometry.dispose();
        expect(baseDisposals).toBe(0);
        expect(textureDisposals).toBe(0);
        base.dispose();
        texture.dispose();
      }
    },
  );

  it("rejects malformed authored batches without publishing either storage binding", () => {
    const base = new MeshStandardNodeMaterial();
    base.positionNode = vec3(0);
    try {
      for (const kind of [
        "zero",
        "over-batch",
        "fraction",
        "root-length",
        "nonfinite",
        "empty-mask",
        "high-mask",
        "mask-length",
        "wrong-topology",
        "changed-root",
        "prior-binding",
      ] as const) {
        const { geometry, coarseGeometry } =
          createMeadowAuthoredClumpGeometry();
        const count =
          kind === "zero"
            ? 0
            : kind === "over-batch"
              ? 129
              : kind === "fraction"
                ? 1.5
                : 1;
        const deltas = new Float32Array(kind === "root-length" ? 41 : 42);
        if (kind === "nonfinite") deltas[17] = NaN;
        const mask =
          kind === "mask-length"
            ? new Uint32Array(2)
            : new Uint32Array([
                kind === "empty-mask" ? 0 : kind === "high-mask" ? 1 << 21 : 1,
              ]);
        geometry.setAttribute(
          "instanceOffset",
          new THREE.InstancedBufferAttribute(new Float32Array(3), 3),
        );
        if (kind === "wrong-topology") {
          if (!geometry.index) throw new Error("Missing authored topology");
          geometry.index.setX(1, 2);
        }
        if (kind === "changed-root")
          geometry.getAttribute("position").setY(0, 0.01);
        if (kind === "prior-binding")
          geometry.setAttribute(
            GRASS_ROOT_STORAGE_ATTRIBUTE,
            new StorageBufferAttribute(new Float32Array(42), 2),
          );
        const before = { ...geometry.attributes };
        try {
          expect(() =>
            createGroundedGrassMeadowAuthoredMaterial(
              base,
              geometry,
              coarseGeometry,
              deltas,
              count,
              mask,
            ),
          ).toThrow();
          expect(geometry.attributes).toEqual(before);
        } finally {
          geometry.dispose();
          coarseGeometry.dispose();
        }
      }
    } finally {
      base.dispose();
    }
  });
});
