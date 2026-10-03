import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  Matrix4,
  NodeFrame,
  PerspectiveCamera,
  RenderTarget,
  Vector2,
  Vector4,
  WebGPURenderer,
  type Node,
} from "three/webgpu";
import {
  renderGroup,
  screenCoordinate,
  screenUV,
  viewportCoordinate,
  viewportSize,
} from "three/tsl";
import {
  alignCroppedReflectionRect,
  ReflectionCropCapacity,
  REFLECTION_CROP_CAPACITY_BUCKET,
  REFLECTION_CROP_REENTRY_UPDATES,
  REFLECTION_CROP_SHRINK_UPDATES,
  cropReflectionProjection,
  createCroppedReflectionScreen,
  resolveCroppedReflectionCapture,
  type CroppedReflectionScreen,
} from "../CroppedReflectionScreen";

function expectCoverage(
  actual: Vector4 | null,
  required: Vector4,
  fullWidth = 1512,
  fullHeight = 862,
): asserts actual is Vector4 {
  expect(actual).not.toBeNull();
  if (!actual) throw new Error("Expected admitted crop capacity");
  expect(actual.toArray().every(Number.isSafeInteger)).toBe(true);
  expect(actual.x % 8).toBe(0);
  expect(actual.y % 8).toBe(0);
  expect(actual.x).toBeGreaterThanOrEqual(0);
  expect(actual.y).toBeGreaterThanOrEqual(0);
  expect(actual.z).toBeGreaterThan(0);
  expect(actual.w).toBeGreaterThan(0);
  expect(actual.x + actual.z).toBeLessThanOrEqual(fullWidth);
  expect(actual.y + actual.w).toBeLessThanOrEqual(fullHeight);
  expect(actual.x).toBeLessThanOrEqual(required.x);
  expect(actual.y).toBeLessThanOrEqual(required.y);
  expect(actual.x + actual.z).toBeGreaterThanOrEqual(required.x + required.z);
  expect(actual.y + actual.w).toBeGreaterThanOrEqual(required.y + required.w);
}

function fixture() {
  const dom = new JSDOM("<!doctype html><canvas></canvas>");
  const renderer = new WebGPURenderer({
    canvas: dom.window.document.querySelector("canvas")!,
  });
  const camera = new PerspectiveCamera(70, 1512 / 862, 0.1, 500);
  const target = new RenderTarget(744, 120);
  const capture = {
    renderer,
    camera,
    target,
    fullWidth: 1512,
    fullHeight: 862,
    x: 768,
    y: 344,
    width: 744,
    height: 120,
  };
  const frame = new NodeFrame();
  frame.renderer = renderer;
  frame.camera = camera;
  renderer.setRenderTarget(target);
  return { dom, renderer, camera, target, capture, frame };
}

function update(owner: CroppedReflectionScreen, frame: NodeFrame) {
  frame.renderId++;
  for (const node of Object.values(owner.uniforms!)) frame.updateNode(node);
}

// Evaluate only the real aliases' scalar/vector arithmetic, with explicit
// fragment inputs. This is not GPU code generation or a filtering oracle.
function evaluate(node: Node, inputs: Map<Node, number[]>): number[] {
  const supplied = inputs.get(node);
  if (supplied) return supplied;
  const value = node as Node & {
    isUniformNode?: boolean;
    value?: Vector2 | Vector4;
    isSplitNode?: boolean;
    isVarNode?: boolean;
    node?: Node;
    components?: string;
    isOperatorNode?: boolean;
    op?: string;
    aNode?: Node;
    bNode?: Node;
  };
  if (value.isUniformNode) return value.value!.toArray();
  if (value.isVarNode) return evaluate(value.node!, inputs);
  if (value.isSplitNode) {
    const source = evaluate(value.node!, inputs);
    return [...value.components!].map(
      (component) => source["xyzw".indexOf(component)],
    );
  }
  if (value.isOperatorNode && ["+", "*"].includes(value.op!)) {
    const a = evaluate(value.aNode!, inputs);
    const b = evaluate(value.bNode!, inputs);
    return a.map((v, i) => (value.op === "+" ? v + b[i] : v * b[i]));
  }
  throw new Error(`Unexpected alias graph node: ${node.type}`);
}

describe("default-off cropped reflection screen coordinates", () => {
  it("admits exactly one explicit selector and retains exact default node identities", () => {
    expect(resolveCroppedReflectionCapture("")).toBe(false);
    expect(resolveCroppedReflectionCapture("?other=1")).toBe(false);
    expect(
      resolveCroppedReflectionCapture("?reflectionCapture=cropped-v1"),
    ).toBe(true);
    for (const query of [
      "?reflectionCapture",
      "?reflectionCapture=",
      "?reflectionCapture=off",
      "?reflectionCapture=cropped-v2",
      "?reflectionCapture=cropped-v1&reflectionCapture=cropped-v1",
    ])
      expect(() => resolveCroppedReflectionCapture(query)).toThrow();
    const off = createCroppedReflectionScreen(false);
    expect(off.screenUV).toBe(screenUV);
    expect(off.screenCoordinate).toBe(screenCoordinate);
    expect(off.viewportCoordinate).toBe(viewportCoordinate);
    expect(off.viewportSize).toBe(viewportSize);
    expect(off.uniforms).toBeNull();
  });

  it("outward-aligns actual crop bounds without exceeding the full texture", () => {
    const input = new Vector4(773, 348, 739, 117);
    expect(alignCroppedReflectionRect(input, 1512, 862)?.toArray()).toEqual([
      768, 344, 744, 128,
    ]);
    expect(input.toArray()).toEqual([773, 348, 739, 117]);
    expect(
      alignCroppedReflectionRect(
        new Vector4(1401, 801, 111, 61),
        1512,
        862,
      )?.toArray(),
    ).toEqual([1400, 800, 112, 62]);
    for (const rect of [
      new Vector4(0, 0, 1512, 862),
      new Vector4(-1, 0, 3, 3),
      new Vector4(0, 0, 0, 3),
      new Vector4(1511, 0, 2, 3),
      new Vector4(0.5, 0, 2, 3),
      new Vector4(NaN, 0, 2, 3),
    ])
      expect(alignCroppedReflectionRect(rect, 1512, 862)).toBeNull();
    expect(alignCroppedReflectionRect(input, Infinity, 862)).toBeNull();
  });

  it("preserves full-frame pixel centers and oblique clip Z/W with C * P", () => {
    const camera = new PerspectiveCamera(70, 1512 / 862, 0.1, 500);
    const projection = camera.projectionMatrix.clone();
    projection.elements[2] = 0.12;
    projection.elements[6] = -0.24;
    projection.elements[10] = -0.61;
    projection.elements[14] = -0.35;
    const original = projection.clone();
    const rect = new Vector4(768, 344, 744, 128);
    const cropped = cropReflectionProjection(projection, rect, 1512, 862);
    for (const x of [-2.4, 0, 1.8])
      for (const y of [-1.2, 0.5, 2]) {
        const point = new Vector4(x, y, -5, 1);
        const before = point.clone().applyMatrix4(projection);
        const after = point.clone().applyMatrix4(cropped);
        expect(after.z).toBe(before.z);
        expect(after.w).toBe(before.w);
        const fullX = ((before.x / before.w + 1) * 1512) / 2;
        const fullY = ((1 - before.y / before.w) * 862) / 2;
        expect(((after.x / after.w + 1) * rect.z) / 2 + rect.x).toBeCloseTo(
          fullX,
          10,
        );
        expect(((1 - after.y / after.w) * rect.w) / 2 + rect.y).toBeCloseTo(
          fullY,
          10,
        );
      }
    expect(projection.equals(original)).toBe(true);
    expect(
      cropReflectionProjection(
        projection,
        new Vector4(0, 0, 1512, 862),
        1512,
        862,
      ).equals(projection),
    ).toBe(true);
    expect(() =>
      cropReflectionProjection(
        new Matrix4(),
        new Vector4(0, 0, 1, 0),
        1512,
        862,
      ),
    ).toThrow();
  });

  it("uses real render-group updates and maps UV, physical pixels and viewport size", () => {
    const f = fixture(),
      owner = createCroppedReflectionScreen(true);
    const end = owner.begin(f.capture);
    try {
      update(owner, f.frame);
      for (const node of Object.values(owner.uniforms!)) {
        expect(node.groupNode).toBe(renderGroup);
        expect(node.updateType).toBe("render");
      }
      for (const point of [
        [0.5, 0.5],
        [21.5, 37.5],
        [743.5, 119.5],
      ]) {
        const inputs = new Map<Node, number[]>([
          [screenUV, [point[0] / 744, point[1] / 120]],
          [screenCoordinate, point],
          [viewportCoordinate, point],
          [viewportSize, [744, 120]],
        ]);
        const expected = [point[0] + 768, point[1] + 344];
        expect(evaluate(owner.screenCoordinate, inputs)).toEqual(expected);
        expect(evaluate(owner.viewportCoordinate, inputs)).toEqual(expected);
        expect(evaluate(owner.viewportSize, inputs)).toEqual([1512, 862]);
        const uv = evaluate(owner.screenUV, inputs);
        expect(uv[0]).toBeCloseTo(expected[0] / 1512, 14);
        expect(uv[1]).toBeCloseTo(expected[1] / 862, 14);
        expect(Math.floor(expected[0]) % 8).toBe(Math.floor(point[0]) % 8);
        expect(Math.floor(expected[1]) % 8).toBe(Math.floor(point[1]) % 8);
      }
      expect(() => owner.begin(f.capture)).toThrow("overlaps");
    } finally {
      end();
      f.target.dispose();
      f.dom.window.close();
    }
  });

  it("keeps unrelated cameras, targets and renderers at identity, then resumes the exact owner", () => {
    const f = fixture(),
      other = fixture(),
      owner = createCroppedReflectionScreen(true);
    const end = owner.begin(f.capture);
    try {
      const identity = () => {
        update(owner, f.frame);
        expect(owner.uniforms!.uvTransform.value.toArray()).toEqual([
          1, 1, 0, 0,
        ]);
        expect(owner.uniforms!.pixelOffset.value.toArray()).toEqual([0, 0]);
        expect(owner.uniforms!.viewportScale.value.toArray()).toEqual([1, 1]);
      };
      f.frame.camera = other.camera;
      identity();
      f.frame.camera = f.camera;
      f.renderer.setRenderTarget(other.target);
      identity();
      f.renderer.setRenderTarget(f.target);
      f.frame.renderer = other.renderer;
      identity();
      f.frame.renderer = f.renderer;
      update(owner, f.frame);
      expect(owner.uniforms!.pixelOffset.value.toArray()).toEqual([768, 344]);
      end();
      end();
      identity();
      const next = owner.begin(f.capture);
      end(); // A stale disposer cannot retire a later lease.
      update(owner, f.frame);
      expect(owner.uniforms!.pixelOffset.value.toArray()).toEqual([768, 344]);
      next();
    } finally {
      end();
      f.target.dispose();
      other.target.dispose();
      f.dom.window.close();
      other.dom.window.close();
    }
  });

  it("can acquire before binding the target without changing renderer state", () => {
    const f = fixture();
    const owner = createCroppedReflectionScreen(true);
    f.renderer.setRenderTarget(null);
    const end = owner.begin(f.capture);
    try {
      expect(f.renderer.getRenderTarget()).toBeNull();
      update(owner, f.frame);
      expect(owner.uniforms!.pixelOffset.value.toArray()).toEqual([0, 0]);
      f.renderer.setRenderTarget(f.target);
      update(owner, f.frame);
      expect(owner.uniforms!.pixelOffset.value.toArray()).toEqual([768, 344]);
      end();
      expect(f.renderer.getRenderTarget()).toBe(f.target);
    } finally {
      end();
      f.target.dispose();
      f.dom.window.close();
    }
  });

  it.each(["target", "texture", "size", "viewport", "replacement"] as const)(
    "retires changed %s ownership without disposing borrowed resources",
    (change) => {
      const f = fixture(),
        owner = createCroppedReflectionScreen(true);
      const end = owner.begin(f.capture);
      const originalTexture = f.target.texture;
      try {
        update(owner, f.frame);
        if (change === "target") f.target.dispose();
        if (change === "texture") f.target.texture.dispose();
        if (change === "size") f.target.width++;
        if (change === "viewport") f.target.viewport.x = 1;
        if (change === "replacement")
          f.target.texture = originalTexture.clone();
        update(owner, f.frame);
        expect(owner.uniforms!.pixelOffset.value.toArray()).toEqual([0, 0]);
        if (f.target.texture !== originalTexture) f.target.texture.dispose();
        f.target.width = 744;
        f.target.viewport.x = 0;
        f.target.texture = originalTexture;
        update(owner, f.frame);
        expect(owner.uniforms!.pixelOffset.value.toArray()).toEqual([0, 0]);
      } finally {
        end();
        f.target.dispose();
        f.dom.window.close();
      }
    },
  );

  it("rejects malformed capture bounds before installing a lease and copies scalar input", () => {
    const f = fixture(),
      owner = createCroppedReflectionScreen(true);
    try {
      for (const overrides of [
        { x: 769 },
        { y: 345 },
        { width: 743 },
        { fullWidth: 0 },
        { fullHeight: NaN },
        { x: 800 },
      ])
        expect(() => owner.begin({ ...f.capture, ...overrides })).toThrow();
      const end = owner.begin(f.capture);
      f.capture.x = 0;
      update(owner, f.frame);
      expect(owner.uniforms!.pixelOffset.value.toArray()).toEqual([768, 344]);
      end();
    } finally {
      f.target.dispose();
      f.dom.window.close();
    }
  });
});

describe("bounded reflection crop allocation capacity", () => {
  it("selects immediately, retains all required pixels and preserves their projection density", () => {
    expect(REFLECTION_CROP_CAPACITY_BUCKET).toBe(64);
    expect(REFLECTION_CROP_SHRINK_UPDATES).toBe(60);
    expect(REFLECTION_CROP_REENTRY_UPDATES).toBe(8);
    const required = new Vector4(768, 344, 744, 128);
    const selected = new ReflectionCropCapacity().select(required, 1512, 862);
    expectCoverage(selected, required);
    expect([selected.z, selected.w]).toEqual([768, 134]);
    const projection = new PerspectiveCamera(70, 1512 / 862, 0.1, 500)
      .projectionMatrix;
    const cropped = cropReflectionProjection(projection, selected, 1512, 862);
    for (const [x, y] of [
      [0.5, 0.5],
      [37.5, 20.5],
      [selected.z - 0.5, selected.w - 0.5],
    ]) {
      const fullNdc = new Vector4(
        (2 * (x + selected.x)) / 1512 - 1,
        1 - (2 * (y + selected.y)) / 862,
        0.5,
        1,
      );
      const view = fullNdc.clone().applyMatrix4(projection.clone().invert());
      const actual = view.applyMatrix4(cropped);
      expect(((actual.x / actual.w + 1) * selected.z) / 2).toBeCloseTo(x, 10);
      expect(((1 - actual.y / actual.w) * selected.w) / 2).toBeCloseTo(y, 10);
    }
  });

  it("absorbs small motion and size changes without changing allocation extents", () => {
    const planner = new ReflectionCropCapacity();
    const allocations = new Set<string>();
    const exactSizes = new Set<string>();
    let first: Vector4 | null = null;
    for (let i = 0; i < 120; i++) {
      const required = new Vector4(
        500 + (i % 19),
        300 + (i % 13),
        710 + (i % 13),
        110 + (i % 9),
      );
      const selected = planner.select(required, 1512, 862);
      expectCoverage(selected, required);
      first ??= selected.clone();
      allocations.add(`${selected.z}:${selected.w}`);
      exactSizes.add(`${required.z}:${required.w}`);
    }
    expect(allocations.size).toBe(1);
    expect(exactSizes.size).toBeGreaterThan(50);
    // This is a logical capacity test, not observed GPU allocation or cadence.
    expect(first).not.toBeNull();
  });

  it("moves only the aligned origin when an unchanged capacity reaches either edge", () => {
    const planner = new ReflectionCropCapacity();
    const sizes = new Set<string>();
    let prior: Vector4 | null = null;
    for (const [x, y] of [
      [0, 0],
      [10, 10],
      [1384, 734],
      [0, 734],
      [1384, 0],
      [0, 0],
    ]) {
      const required = new Vector4(x, y, 128, 128);
      const selected = planner.select(required, 1512, 862);
      expectCoverage(selected, required);
      sizes.add(`${selected.z}:${selected.w}`);
      if (prior && x === 10) expect(selected.x).toBe(prior.x);
      prior = selected;
    }
    // The unaligned (10,10) demand grows once; subsequent edge movement fits.
    expect(sizes.size).toBe(2);
    const bottom = new ReflectionCropCapacity().select(
      new Vector4(1384, 734, 128, 128),
      1512,
      862,
    );
    expectCoverage(bottom, new Vector4(1384, 734, 128, 128));
    expect(bottom.w).toBe(198);
    const alignedBottom = new ReflectionCropCapacity().select(
      new Vector4(1384, 736, 128, 126),
      1512,
      862,
    );
    expectCoverage(alignedBottom, new Vector4(1384, 736, 128, 126));
    expect(alignedBottom.w).toBe(134);
    expect(alignedBottom.y + alignedBottom.w).toBe(862);
  });

  it("grows immediately and shrinks only after a complete bounded maximum-demand window", () => {
    const planner = new ReflectionCropCapacity();
    const small = new Vector4(400, 240, 100, 70);
    const large = new Vector4(400, 240, 600, 320);
    const initial = planner.select(small, 1512, 862)!;
    const grown = planner.select(large, 1512, 862)!;
    expectCoverage(grown, large);
    expect(grown.z).toBeGreaterThan(initial.z);
    expect(grown.w).toBeGreaterThan(initial.w);
    for (let i = 0; i < REFLECTION_CROP_SHRINK_UPDATES - 1; i++) {
      const selected = planner.select(small, 1512, 862)!;
      expect([selected.z, selected.w]).toEqual([grown.z, grown.w]);
    }
    // The growth sample belonged to the first window. The next window must
    // contain only smaller demand before its maximum permits downsizing.
    for (let i = 0; i < REFLECTION_CROP_SHRINK_UPDATES - 1; i++) {
      const selected = planner.select(small, 1512, 862)!;
      expect([selected.z, selected.w]).toEqual([grown.z, grown.w]);
    }
    const shrunk = planner.select(small, 1512, 862)!;
    expectCoverage(shrunk, small);
    expect([shrunk.z, shrunk.w]).toEqual([initial.z, initial.w]);
    const regrown = planner.select(large, 1512, 862)!;
    expectCoverage(regrown, large);
    expect([regrown.z, regrown.w]).toEqual([grown.z, grown.w]);
  });

  it("sizes shrink and reentry from window maxima, not merely the last rectangle", () => {
    const planner = new ReflectionCropCapacity();
    const small = new Vector4(400, 240, 100, 70);
    const wider = new Vector4(400, 240, 300, 70);
    const taller = new Vector4(400, 240, 100, 200);
    expect(planner.select(null, 1512, 862)).toBeNull();
    for (let i = 0; i < 7; i++)
      expect(
        planner.select(i === 2 ? wider : i === 4 ? taller : small, 1512, 862),
      ).toBeNull();
    const reentered = planner.select(small, 1512, 862)!;
    expectCoverage(reentered, small);
    expect([reentered.z, reentered.w]).toEqual([320, 262]);
    for (let i = 0; i < 60; i++) {
      const required = i === 20 ? wider : small;
      const selected = planner.select(required, 1512, 862)!;
      expectCoverage(selected, required);
      if (i < 59) expect(selected.w).toBe(262);
      else expect([selected.z, selected.w]).toEqual([320, 134]);
    }
  });

  it("requires eight consecutive valid selections after full fallback and resets on interruption", () => {
    const planner = new ReflectionCropCapacity();
    const required = new Vector4(500, 300, 200, 100);
    expectCoverage(planner.select(required, 1512, 862), required);
    expect(planner.select(null, 1512, 862)).toBeNull();
    for (let i = 0; i < 7; i++)
      expect(planner.select(required, 1512, 862)).toBeNull();
    expect(planner.select(new Vector4(0, 0, 1512, 862), 1512, 862)).toBeNull();
    for (let i = 0; i < 7; i++)
      expect(planner.select(required, 1512, 862)).toBeNull();
    expectCoverage(planner.select(required, 1512, 862), required);
  });

  it("never traps a full-size high-water mark and restarts immediately for a new full-size epoch", () => {
    const planner = new ReflectionCropCapacity();
    expectCoverage(
      planner.select(new Vector4(0, 0, 1512, 64), 1512, 862),
      new Vector4(0, 0, 1512, 64),
    );
    expect(planner.select(new Vector4(0, 0, 64, 862), 1512, 862)).toBeNull();
    const small = new Vector4(0, 0, 100, 70);
    for (let i = 0; i < 7; i++)
      expect(planner.select(small, 1512, 862)).toBeNull();
    const returned = planner.select(small, 1512, 862)!;
    expectCoverage(returned, small);
    expect(returned.z).toBeLessThan(1512);
    expect(returned.w).toBeLessThan(862);
    planner.select(null, 1512, 862);
    expectCoverage(planner.select(small, 1920, 1080), small, 1920, 1080);
    expectCoverage(planner.select(small, 1512, 862), small);
  });

  it("fails closed for invalid and non-finite inputs without returning a malformed rectangle", () => {
    const invalid = [
      new Vector4(NaN, 0, 1, 1),
      new Vector4(0, Infinity, 1, 1),
      new Vector4(-1, 0, 1, 1),
      new Vector4(0, 0, 0, 1),
      new Vector4(0, 0, 1.5, 1),
      new Vector4(1512, 0, 1, 1),
      new Vector4(0, 861, 1, 2),
    ];
    for (const required of invalid)
      expect(
        new ReflectionCropCapacity().select(required, 1512, 862),
      ).toBeNull();
    for (const [width, height] of [
      [0, 862],
      [-1, 862],
      [1512.5, 862],
      [Infinity, 862],
      [1512, NaN],
      [Number.MAX_SAFE_INTEGER + 1, 862],
    ])
      expect(
        new ReflectionCropCapacity().select(
          new Vector4(0, 0, 1, 1),
          width,
          height,
        ),
      ).toBeNull();
  });

  it("returns detached values and keeps independent camera/target planners isolated", () => {
    const first = new ReflectionCropCapacity(),
      second = new ReflectionCropCapacity();
    const required = new Vector4(768, 344, 744, 128);
    const firstResult = first.select(required, 1512, 862)!;
    const expected = firstResult.clone();
    const secondResult = second.select(required, 1512, 862)!;
    firstResult.set(-10, -20, 1, 1);
    required.set(0, 0, 1512, 862);
    const original = new Vector4(768, 344, 744, 128);
    expect(first.select(original, 1512, 862)!.toArray()).toEqual(
      expected.toArray(),
    );
    expect(secondResult.toArray()).toEqual(expected.toArray());
    first.select(null, 1512, 862);
    expectCoverage(second.select(original, 1512, 862), original);
  });

  it("conservatively covers deterministic motion across varied framebuffer edges", () => {
    for (const [fullWidth, fullHeight] of [
      [1512, 862],
      [1920, 1080],
      [1001, 777],
      [63, 65],
    ]) {
      const planner = new ReflectionCropCapacity();
      for (let i = 0; i < 240; i++) {
        const width =
          1 + ((i * 31) % Math.max(1, Math.floor(fullWidth * 0.55)));
        const height =
          1 + ((i * 17) % Math.max(1, Math.floor(fullHeight * 0.55)));
        const x = (i * 97) % (fullWidth - width + 1);
        const y = (i * 53) % (fullHeight - height + 1);
        const required = new Vector4(x, y, width, height);
        const selected = planner.select(required, fullWidth, fullHeight);
        if (selected) expectCoverage(selected, required, fullWidth, fullHeight);
        // A null selection deliberately retains native full capture.
      }
    }
  });
});
