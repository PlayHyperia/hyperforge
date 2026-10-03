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
export const REFLECTION_CROP_CAPACITY_BUCKET = 64;
export const REFLECTION_CROP_SHRINK_UPDATES = 60;
export const REFLECTION_CROP_REENTRY_UPDATES = 8;

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

/** Per-target allocation policy only: it never changes sampling density or
 * reduces the conservative required rectangle. Construct only for an opted-in
 * target. The caller must report every full fallback with a null selection.
 *
 * Grow immediately; shrink to the maximum demand of 60 uninterrupted admitted
 * updates. Following full fallback, require eight consecutive admitted updates
 * and size from their maximum, rather than permanently retaining a full-sized
 * high-water mark. These update counts and 64-pixel buckets amortize allocation;
 * they are not visibility, distortion, or image-quality tolerances.
 */
export class ReflectionCropCapacity {
  private fullWidth = 0;
  private fullHeight = 0;
  private width = 0;
  private height = 0;
  private x = 0;
  private y = 0;
  private fullFallback = false;
  private demandWidth = 0;
  private demandHeight = 0;
  private demandUpdates = 0;

  private resetDemand(): void {
    this.demandWidth = 0;
    this.demandHeight = 0;
    this.demandUpdates = 0;
  }

  private fallback(): null {
    this.fullFallback = true;
    this.resetDemand();
    return null;
  }

  private capacity(left: number, extent: number, full: number): number {
    const alignment = CROPPED_REFLECTION_ALIGNMENT;
    const alignedLeft = Math.floor(left / alignment) * alignment;
    const required = left + extent - alignedLeft;
    // Edge-compatible capacities permit an aligned origin at BOTH boundaries.
    // E.g. full height 862 uses 64*k + 6, not a 128-high target whose bottom
    // origin would have to be the unsupported, unaligned coordinate 734.
    const edgeRemainder = full % alignment;
    return Math.min(
      full,
      Math.ceil(required / REFLECTION_CROP_CAPACITY_BUCKET) *
        REFLECTION_CROP_CAPACITY_BUCKET +
        edgeRemainder,
    );
  }

  private origin(
    previous: number,
    left: number,
    extent: number,
    capacity: number,
    full: number,
  ): number | null {
    const alignment = CROPPED_REFLECTION_ALIGNMENT;
    const low =
      Math.ceil(Math.max(0, left + extent - capacity) / alignment) * alignment;
    const high =
      Math.floor(Math.min(left, full - capacity) / alignment) * alignment;
    if (low > high) return null;
    return Math.max(low, Math.min(previous, high));
  }

  /** Returns a detached actual capture rectangle, or null for native full.
   * Changing full dimensions starts a new epoch. Invalid inputs fail full.
   */
  select(
    required: Vector4 | null,
    fullWidth: number,
    fullHeight: number,
  ): Vector4 | null {
    if (this.fullWidth !== fullWidth || this.fullHeight !== fullHeight) {
      this.fullWidth = fullWidth;
      this.fullHeight = fullHeight;
      this.width = this.height = this.x = this.y = 0;
      this.fullFallback = false;
      this.resetDemand();
    }
    if (!required || !validRect(required, fullWidth, fullHeight))
      return this.fallback();
    const width = this.capacity(required.x, required.z, fullWidth);
    const height = this.capacity(required.y, required.w, fullHeight);
    if (width === fullWidth && height === fullHeight) return this.fallback();

    if (this.fullFallback) {
      this.demandWidth = Math.max(this.demandWidth, width);
      this.demandHeight = Math.max(this.demandHeight, height);
      this.demandUpdates++;
      if (this.demandUpdates < REFLECTION_CROP_REENTRY_UPDATES) return null;
      if (this.demandWidth === fullWidth && this.demandHeight === fullHeight)
        return this.fallback();
      this.width = this.demandWidth;
      this.height = this.demandHeight;
      this.fullFallback = false;
      this.resetDemand();
    } else {
      const grownWidth = Math.max(this.width, width);
      const grownHeight = Math.max(this.height, height);
      if (grownWidth === fullWidth && grownHeight === fullHeight)
        return this.fallback();
      if (grownWidth !== this.width || grownHeight !== this.height) {
        this.width = grownWidth;
        this.height = grownHeight;
        this.resetDemand();
      }
      this.demandWidth = Math.max(this.demandWidth, width);
      this.demandHeight = Math.max(this.demandHeight, height);
      this.demandUpdates++;
      if (this.demandUpdates >= REFLECTION_CROP_SHRINK_UPDATES) {
        this.width = this.demandWidth;
        this.height = this.demandHeight;
        this.resetDemand();
      }
    }
    const x = this.origin(
      this.x,
      required.x,
      required.z,
      this.width,
      fullWidth,
    );
    const y = this.origin(
      this.y,
      required.y,
      required.w,
      this.height,
      fullHeight,
    );
    if (x === null || y === null) return this.fallback();
    this.x = x;
    this.y = y;
    return new Vector4(x, y, this.width, this.height);
  }
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
