import * as THREE from "../../extras/three/three";
import { screenCoordinate, uniform } from "three/tsl";

/** Opaque endpoints and bounded Bayer coverage during the shared 220ms fade. */
export function createCompactRoofFade(name: string) {
  const fade = uniform(0).setName(name);
  const low = screenCoordinate.floor().mod(2);
  const high = screenCoordinate.div(2).floor().mod(2);
  const bayer = low.x
    .add(low.y)
    .mod(2)
    .mul(2)
    .add(low.y)
    .mul(4)
    .add(high.x.add(high.y).mod(2).mul(2).add(high.y))
    .add(0.5)
    .div(16);
  return { fade, visible: bayer.greaterThanEqual(fade) };
}

/** Bounded, camera-specific visibility policy. Reads prepared matrices only;
 * never moves cameras, modifies geometry or removes the physical roof/shadow.
 */
export class CompactRoofCutaway {
  value = 0;
  desired = false;
  decisionCount = 0;
  private lastTime: number | null = null;
  private lastCamera: THREE.Camera | null = null;
  private readonly previousMatrix = new Float64Array(16).fill(NaN);
  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private readonly ray = new THREE.Raycaster();
  private readonly hits: THREE.Intersection[] = [];
  private readonly localPoint = new THREE.Vector3();
  private readonly inverseRoot = new THREE.Matrix4();
  private readonly lodgeBounds: THREE.Box3 | null;
  readonly upperWallY: number | null;
  private lastFrame = -1;
  private lastFrameCamera: THREE.Camera | null = null;

  constructor(
    private readonly root: THREE.Group,
    private readonly roof: THREE.Mesh,
    private readonly timber: THREE.Mesh,
    mode: "court" | "lodge" = "court",
  ) {
    this.ray.layers.enableAll();
    this.lodgeBounds =
      mode === "lodge" ? (roof.geometry.boundingBox?.clone() ?? null) : null;
    if (
      mode === "lodge" &&
      (!this.lodgeBounds ||
        this.lodgeBounds.isEmpty() ||
        ![
          ...this.lodgeBounds.min.toArray(),
          ...this.lodgeBounds.max.toArray(),
        ].every(Number.isFinite) ||
        roof.name !== "roof" ||
        timber.name !== "walls")
    )
      throw new Error("Lodge cutaway requires its actual roof/wall geometry");
    // The admitted gable recipe's verge/eave trim extends 0.18m below its shell.
    // Preserve the lower walls and openings; only the upper roof band fades.
    this.upperWallY = this.lodgeBounds ? this.lodgeBounds.min.y - 0.2 : null;
  }

  /** Whether an intersection belongs to authored upper structure, not a post. */
  isUpperHit(hit: THREE.Intersection): boolean {
    if (hit.object === this.roof) return true;
    if (hit.object !== this.timber || hit.faceIndex == null) return false;
    if (this.upperWallY !== null) {
      this.inverseRoot.copy(this.root.matrixWorld).invert();
      return (
        this.localPoint.copy(hit.point).applyMatrix4(this.inverseRoot).y >=
        this.upperWallY
      );
    }
    const geometry = this.timber.geometry;
    const corner = hit.faceIndex * 3;
    return (
      geometry
        .getAttribute("courtRoof")
        .getX(geometry.index?.getX(corner) ?? corner) > 0.5
    );
  }

  /** Other view passes see a complete building. Returning to the main camera in
   * the same renderer frame restores its fade without advancing the clock twice.
   */
  valueForPass(
    camera: THREE.Camera,
    mainCamera: THREE.Camera,
    frame: number,
    now: number,
  ): number {
    if (!Number.isSafeInteger(frame) || frame < 0)
      throw new Error("Roof cutaway requires the WebGPU frame owner");
    if (camera !== mainCamera) return 0;
    if (frame !== this.lastFrame || mainCamera !== this.lastFrameCamera) {
      this.lastFrame = frame;
      this.lastFrameCamera = mainCamera;
      this.update(camera, now);
    }
    return this.value;
  }

  update(camera: THREE.Camera, now: number): void {
    if (!Number.isFinite(now))
      throw new Error("Roof cutaway requires a finite clock");
    const dt =
      this.lastTime === null
        ? 0
        : Math.min(0.05, Math.max(0, (now - this.lastTime) / 1000));
    this.lastTime = now;
    let changed = this.lastCamera !== camera;
    for (let i = 0; i < 16; i++) {
      if (this.previousMatrix[i] !== camera.matrixWorld.elements[i])
        changed = true;
      this.previousMatrix[i] = camera.matrixWorld.elements[i];
    }
    if (changed) {
      this.lastCamera = camera;
      this.desired = this.interceptsFocus(camera);
      this.decisionCount++;
    }
    const target = this.desired ? 1 : 0;
    const step = dt / 0.22;
    this.value =
      target > this.value
        ? Math.min(target, this.value + step)
        : Math.max(target, this.value - step);
  }

  private interceptsFocus(camera: THREE.Camera): boolean {
    if (!(camera instanceof THREE.PerspectiveCamera)) return false;
    this.origin.setFromMatrixPosition(camera.matrixWorld);
    if (this.lodgeBounds) {
      // The bank camera looks OUT toward its service chest while its lens is
      // inside the lodge eaves. A center-target ray cannot detect that large
      // foreground roof. Use the actual local roof envelope, not a bigger
      // camera frustum or an arbitrary external service target.
      this.inverseRoot.copy(this.root.matrixWorld).invert();
      this.localPoint.copy(this.origin).applyMatrix4(this.inverseRoot);
      const margin = this.desired ? 0.35 : -0.05;
      const p = this.localPoint,
        box = this.lodgeBounds;
      return (
        p.x >= box.min.x - margin &&
        p.x <= box.max.x + margin &&
        p.z >= box.min.z - margin &&
        p.z <= box.max.z + margin &&
        p.y >= 0.4 &&
        p.y <= box.max.y + 0.5 + margin
      );
    }
    this.direction.set(0, 0, -1).transformDirection(camera.matrixWorld);
    const base = this.root.position;
    if (
      !this.origin.toArray().every(Number.isFinite) ||
      this.direction.y >= -0.01 ||
      Math.hypot(this.origin.x - base.x, this.origin.z - base.z) > 40
    )
      return false;
    const distance = (base.y + 1.2 - this.origin.y) / this.direction.y;
    if (distance <= 0 || distance > 80) return false;
    this.focus.copy(this.origin).addScaledVector(this.direction, distance);
    const margin = this.desired ? 0.35 : -0.05;
    if (
      Math.abs(this.focus.x - base.x) > 5 + margin ||
      Math.abs(this.focus.z - base.z) > 3 + margin
    )
      return false;
    this.ray.ray.set(this.origin, this.direction);
    this.ray.near = 0.01;
    this.ray.far = distance - 0.05;
    this.hits.length = 0;
    // Bypass pointer filtering: a hidden roof must still inform the next
    // visibility decision, otherwise the roof would flicker on/off forever.
    THREE.Mesh.prototype.raycast.call(this.roof, this.ray, this.hits);
    THREE.Mesh.prototype.raycast.call(this.timber, this.ray, this.hits);
    return this.hits.some((hit) => this.isUpperHit(hit));
  }

  installPointerFilter(mesh: THREE.Mesh): void {
    mesh.raycast = (raycaster, intersections) => {
      const start = intersections.length;
      THREE.Mesh.prototype.raycast.call(mesh, raycaster, intersections);
      if (this.value < 1) return;
      let write = start;
      for (let i = start; i < intersections.length; i++)
        if (!this.isUpperHit(intersections[i]))
          intersections[write++] = intersections[i];
      intersections.length = write;
    };
  }
}
