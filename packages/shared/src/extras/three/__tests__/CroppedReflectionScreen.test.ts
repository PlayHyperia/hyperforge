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
  cropReflectionProjection,
  createCroppedReflectionScreen,
  resolveCroppedReflectionCapture,
  type CroppedReflectionScreen,
} from "../CroppedReflectionScreen";

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
