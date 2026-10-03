import {
  Matrix4,
  RenderTarget,
  Vector2,
  Vector4,
  WebGPURenderer,
  type Camera,
  type Node,
  type NodeFrame,
  type UniformNode,
} from "three/webgpu";
import {
  renderGroup,
  screenCoordinate,
  screenUV,
  uniform,
  viewportCoordinate,
  viewportSize,
} from "three/tsl";

export const CROPPED_REFLECTION_ALIGNMENT = 8;

/** An explicit experiment; no environment or saved-setting fallback. */
export function resolveCroppedReflectionCapture(search: string): boolean {
  const values = new URLSearchParams(search).getAll("reflectionCapture");
  if (values.length === 0) return false;
  if (values.length !== 1 || values[0] !== "cropped-v1")
    throw new Error("Unsupported reflectionCapture selector");
  return true;
}

function validSize(width: number, height: number): boolean {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0
  );
}

function validRect(rect: Vector4, width: number, height: number): boolean {
  return (
    validSize(width, height) &&
    rect.toArray().every(Number.isSafeInteger) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.z > 0 &&
    rect.w > 0 &&
    rect.x <= width - rect.z &&
    rect.y <= height - rect.w
  );
}

/** Outward alignment preserves existing eight-pixel screen-space patterns.
 * The far edge may be clamped to a non-aligned framebuffer boundary. */
export function alignCroppedReflectionRect(
  rect: Vector4,
  fullWidth: number,
  fullHeight: number,
): Vector4 | null {
  if (!validRect(rect, fullWidth, fullHeight)) return null;
  const alignment = CROPPED_REFLECTION_ALIGNMENT;
  const x = Math.floor(rect.x / alignment) * alignment;
  const y = Math.floor(rect.y / alignment) * alignment;
  const right = Math.min(
    fullWidth,
    Math.ceil((rect.x + rect.z) / alignment) * alignment,
  );
  const bottom = Math.min(
    fullHeight,
    Math.ceil((rect.y + rect.w) / alignment) * alignment,
  );
  if (x === 0 && y === 0 && right === fullWidth && bottom === fullHeight)
    return null;
  return new Vector4(x, y, right - x, bottom - y);
}

/** Return C * P, after the reflector has installed its oblique clip plane.
 * Only clip X/Y change; clip Z/W and their depth test remain untouched.
 * Rectangle coordinates follow WebGPU's top-left physical framebuffer. */
export function cropReflectionProjection(
  projection: Matrix4,
  rect: Vector4,
  fullWidth: number,
  fullHeight: number,
): Matrix4 {
  if (
    !validRect(rect, fullWidth, fullHeight) ||
    !projection.elements.every(Number.isFinite)
  )
    throw new Error("Invalid cropped reflection projection");
  const crop = new Matrix4().set(
    fullWidth / rect.z,
    0,
    0,
    (fullWidth - 2 * rect.x - rect.z) / rect.z,
    0,
    fullHeight / rect.w,
    0,
    (2 * rect.y + rect.w - fullHeight) / rect.w,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
  );
  const result = projection.clone().premultiply(crop);
  if (!result.elements.every(Number.isFinite))
    throw new Error("Non-finite cropped reflection projection");
  return result;
}

export type CroppedReflectionCapture = {
  renderer: NonNullable<NodeFrame["renderer"]>;
  target: RenderTarget;
  camera: Camera;
  fullWidth: number;
  fullHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type TransformUniforms = {
  uvTransform: UniformNode<"vec4", Vector4>;
  pixelOffset: UniformNode<"vec2", Vector2>;
  viewportScale: UniformNode<"vec2", Vector2>;
};

export type CroppedReflectionScreen = {
  readonly enabled: boolean;
  readonly screenUV: Node<"vec2">;
  readonly viewportCoordinate: Node<"vec2">;
  readonly viewportSize: Node<"vec2">;
  readonly screenCoordinate: Node<"vec2">;
  /** Exposed real render-group nodes for graph/native qualification. */
  readonly uniforms: TransformUniforms | null;
  begin(capture: CroppedReflectionCapture): () => void;
};

/** Virtualize only the admitted mirror's screen-space inputs. It does not
 * resize, render, alter cameras, install callbacks, or own any GPU resources. */
export function createCroppedReflectionScreen(
  enabled: boolean,
): CroppedReflectionScreen {
  if (!enabled)
    return Object.freeze({
      enabled,
      screenUV,
      viewportCoordinate,
      viewportSize,
      screenCoordinate,
      uniforms: null,
      begin: () => {
        throw new Error("Cropped reflection screen is disabled");
      },
    });

  type Scope = CroppedReflectionCapture & {
    texture: RenderTarget["texture"];
    end: () => void;
  };
  let active: Scope | null = null;
  const matches = (frame: NodeFrame): Scope | null => {
    const scope = active;
    if (
      !scope ||
      frame.renderer !== scope.renderer ||
      frame.camera !== scope.camera ||
      frame.renderer.getRenderTarget() !== scope.target
    )
      return null;
    const { target, width, height } = scope;
    if (
      target.texture !== scope.texture ||
      target.width !== width ||
      target.height !== height ||
      target.viewport.x !== 0 ||
      target.viewport.y !== 0 ||
      target.viewport.z !== width ||
      target.viewport.w !== height
    ) {
      scope.end();
      return null;
    }
    return scope;
  };
  const uvValue = new Vector4(1, 1, 0, 0);
  const offsetValue = new Vector2();
  const viewportValue = new Vector2(1, 1);
  const uvTransform = uniform(uvValue)
    .setName("croppedReflectionUVTransform")
    .setGroup(renderGroup)
    .onRenderUpdate((frame) => {
      const scope = matches(frame);
      return scope
        ? uvValue.set(
            scope.width / scope.fullWidth,
            scope.height / scope.fullHeight,
            scope.x / scope.fullWidth,
            scope.y / scope.fullHeight,
          )
        : uvValue.set(1, 1, 0, 0);
    });
  const pixelOffset = uniform(offsetValue)
    .setName("croppedReflectionPixelOffset")
    .setGroup(renderGroup)
    .onRenderUpdate((frame) => {
      const scope = matches(frame);
      return scope ? offsetValue.set(scope.x, scope.y) : offsetValue.set(0, 0);
    });
  const viewportScale = uniform(viewportValue)
    .setName("croppedReflectionViewportScale")
    .setGroup(renderGroup)
    .onRenderUpdate((frame) => {
      const scope = matches(frame);
      return scope
        ? viewportValue.set(
            scope.fullWidth / scope.width,
            scope.fullHeight / scope.height,
          )
        : viewportValue.set(1, 1);
    });

  return Object.freeze({
    enabled,
    screenUV: screenUV.mul(uvTransform.xy).add(uvTransform.zw),
    viewportCoordinate: viewportCoordinate.add(pixelOffset),
    viewportSize: viewportSize.mul(viewportScale),
    screenCoordinate: screenCoordinate.add(pixelOffset),
    uniforms: Object.freeze({ uvTransform, pixelOffset, viewportScale }),
    begin(capture: CroppedReflectionCapture) {
      if (active) throw new Error("Cropped reflection screen lease overlaps");
      const { target, camera, fullWidth, fullHeight, x, y, width, height } =
        capture;
      if (
        !validRect(new Vector4(x, y, width, height), fullWidth, fullHeight) ||
        x % CROPPED_REFLECTION_ALIGNMENT !== 0 ||
        y % CROPPED_REFLECTION_ALIGNMENT !== 0 ||
        !(capture.renderer instanceof WebGPURenderer) ||
        !(target instanceof RenderTarget) ||
        !camera.isCamera ||
        target.width !== width ||
        target.height !== height ||
        target.viewport.x !== 0 ||
        target.viewport.y !== 0 ||
        target.viewport.z !== width ||
        target.viewport.w !== height
      )
        throw new Error("Invalid cropped reflection screen lease");
      let ended = false;
      const scope: Scope = {
        ...capture,
        texture: target.texture,
        end: () => {
          if (ended) return;
          ended = true;
          target.removeEventListener("dispose", scope.end);
          scope.texture.removeEventListener("dispose", scope.end);
          if (active === scope) active = null;
        },
      };
      active = scope;
      target.addEventListener("dispose", scope.end);
      scope.texture.addEventListener("dispose", scope.end);
      return scope.end;
    },
  });
}

/** One canonical graph owner shared by the barrel, water and stock-PCF alias. */
export const croppedReflectionScreen = createCroppedReflectionScreen(
  resolveCroppedReflectionCapture(
    typeof window === "undefined" ? "" : window.location.search,
  ),
);
