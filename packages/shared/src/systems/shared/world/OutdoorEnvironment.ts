import THREE from "../../../extras/three/three";
import { mix, pmremTexture, uniform } from "three/tsl";
import type { ClientGraphics } from "../../client/ClientGraphics";
import { AMBIENT_LIGHT, HEMISPHERE_LIGHT } from "./LightingConfig";
import { sampleSkyCycle, type SkyLightingCapture } from "./SkySystem";

// Smooth sky radiance needs far less angular detail than reflected geometry.
// Twelve RGBA16F 384x512 atlases occupy 18 MiB of base color storage. This is
// not total renderer memory; generation has scratch targets and pipeline costs.
export const OUTDOOR_ENVIRONMENT_PHASES = Object.freeze([
  0, 0.125, 0.22, 0.25, 0.28, 0.32, 0.5, 0.68, 0.72, 0.75, 0.78, 0.875,
]);
export const OUTDOOR_ENVIRONMENT_FACE_SIZE = 128;
const ATLAS_WIDTH = 384;
const ATLAS_HEIGHT = 512;
type RGB = readonly [number, number, number];
type State = "idle" | "preparing" | "ready" | "failed" | "disposed";

/** Cleanup must attempt every owned resource even if one listener throws. */
function attemptAll(operations: Array<() => void>): void {
  const errors: unknown[] = [];
  for (const operation of operations) {
    try {
      operation();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Outdoor environment cleanup failed");
}

function cleanupAfter(errors: unknown[], operations: Array<() => void>): void {
  try {
    attemptAll(operations);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Outdoor preparation and cleanup failed");
}

/** Existing analytic fill is an irradiance budget, not emitted radiance. */
export function sampleOutdoorFill(
  dayIntensity: number,
  up: THREE.Color,
  down: THREE.Color,
): void {
  if (!Number.isFinite(dayIntensity) || dayIntensity < 0 || dayIntensity > 1) {
    throw new Error("Outdoor fill requires day intensity in [0, 1]");
  }
  const t = dayIntensity;
  const ambientIntensity =
    AMBIENT_LIGHT.INTENSITY_BASE + t * AMBIENT_LIGHT.INTENSITY_DAY_ADD;
  const hemiIntensity =
    HEMISPHERE_LIGHT.INTENSITY_BASE + t * HEMISPHERE_LIGHT.INTENSITY_DAY_ADD;
  const channel = (night: RGB, day: RGB, i: number) =>
    night[i] + t * (day[i] - night[i]);
  const values = [0, 1, 2].map((i) => {
    const ambient =
      channel(AMBIENT_LIGHT.NIGHT_COLOR, AMBIENT_LIGHT.DAY_COLOR, i) *
      ambientIntensity;
    return [
      ambient +
        channel(
          HEMISPHERE_LIGHT.NIGHT_SKY_COLOR,
          HEMISPHERE_LIGHT.DAY_SKY_COLOR,
          i,
        ) *
          hemiIntensity,
      ambient +
        channel(
          HEMISPHERE_LIGHT.NIGHT_GROUND_COLOR,
          HEMISPHERE_LIGHT.DAY_GROUND_COLOR,
          i,
        ) *
          hemiIntensity,
    ];
  });
  up.setRGB(values[0][0], values[1][0], values[2][0]);
  down.setRGB(values[0][1], values[1][1], values[2][1]);
}

/** Midpoint quadrature with cosine-weighted directions; startup only. */
export function calibrateOutdoorCapture(
  capture: SkyLightingCapture,
  phase: number,
): { skyScale: number; groundRadiance: RGB; upwardIrradiance: RGB } {
  const direction = new THREE.Vector3();
  const up = new THREE.Color();
  const down = new THREE.Color();
  sampleOutdoorFill(sampleSkyCycle(phase, direction), up, down);
  const sample = new THREE.Color();
  const mean = new THREE.Color(0, 0, 0);
  for (let row = 0; row < 16; row++) {
    const y = Math.sqrt((row + 0.5) / 16);
    const radius = Math.sqrt(1 - y * y);
    for (let column = 0; column < 32; column++) {
      const angle = ((column + 0.5) / 32) * Math.PI * 2;
      direction.set(radius * Math.cos(angle), y, radius * Math.sin(angle));
      capture.sampleRadiance(phase, direction, sample);
      mean.add(sample);
    }
  }
  mean.multiplyScalar(1 / 512);
  const luminance = (c: THREE.Color) =>
    0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const skyY = luminance(mean);
  if (!Number.isFinite(skyY) || skyY <= 0) {
    throw new Error("Outdoor sky capture has no finite positive radiance");
  }
  const skyScale = luminance(up) / (Math.PI * skyY);
  down.multiplyScalar(1 / Math.PI);
  return {
    skyScale,
    groundRadiance: [down.r, down.g, down.b],
    upwardIrradiance: [up.r, up.g, up.b],
  };
}

/** Writes a cyclic interval without allocating in the animation loop. */
export function sampleOutdoorInterval(
  phase: number,
  out: { a: number; b: number; blend: number },
): void {
  if (!Number.isFinite(phase)) throw new Error("Outdoor phase must be finite");
  const p = phase - Math.floor(phase);
  const phases = OUTDOOR_ENVIRONMENT_PHASES;
  let a = phases.length - 1;
  for (let i = 0; i < phases.length - 1; i++) {
    if (p < phases[i + 1]) {
      a = i;
      break;
    }
  }
  const b = (a + 1) % phases.length;
  const end = b === 0 ? 1 : phases[b];
  out.a = a;
  out.b = b;
  out.blend = (p - phases[a]) / (end - phases[a]);
}

/**
 * One world-owned IBL cache. No world geometry, actors, viewport nodes or
 * frame-time captures. PBR materials inherit the same two-map radiance blend.
 * Ground is a calibrated hemispherical approximation, not dynamic GI.
 */
export class OutdoorEnvironment {
  private state: State = "idle";
  private closed = false;
  private working = false;
  private targets: THREE.RenderTarget[] = [];
  private nodeA: ReturnType<typeof pmremTexture> | null = null;
  private nodeB: ReturnType<typeof pmremTexture> | null = null;
  private readonly weight = uniform(0);
  private environmentNode: THREE.Scene["environmentNode"] = null;
  private previousNode: THREE.Scene["environmentNode"] = null;
  private previousIntensity = 1;
  private readonly interval = { a: 0, b: 1, blend: 0 };
  private preparationMs = 0;
  private capturesCompleted = 0;

  constructor(private readonly scene: THREE.Scene) {}

  get ready(): boolean {
    return this.state === "ready" && !this.closed;
  }

  getStatus() {
    return {
      state: this.state,
      phaseCount: OUTDOOR_ENVIRONMENT_PHASES.length,
      faceSize: OUTDOOR_ENVIRONMENT_FACE_SIZE,
      baseColorBytes: this.targets.length * ATLAS_WIDTH * ATLAS_HEIGHT * 8,
      activeInterval: [this.interval.a, this.interval.b] as const,
      blend: this.interval.blend,
      capturesCompleted: this.capturesCompleted,
      preparationMs: this.preparationMs,
    };
  }

  async initialize(
    graphics: ClientGraphics,
    capture: SkyLightingCapture,
    phase: number,
  ): Promise<void> {
    if (this.state !== "idle") {
      capture.dispose();
      throw new Error("Outdoor environment already initialized");
    }
    if (!Number.isFinite(phase)) {
      capture.dispose();
      throw new Error("Outdoor phase must be finite");
    }
    this.state = "preparing";
    try {
      await graphics.prepareRenderer(async () => {
        if (this.closed) throw new Error("Outdoor preparation cancelled");
        this.working = true;
        const started = performance.now();
        const renderer = graphics.renderer;
        let generator: THREE.PMREMGenerator | undefined;
        let submittedDevice: GPUDevice | undefined;
        const errors: unknown[] = [];
        try {
          const device = (
            renderer?.backend as unknown as { device?: GPUDevice } | undefined
          )?.device;
          if (!device || !renderer?.hasInitialized())
            throw new Error("Outdoor lighting requires initialized WebGPU");
          generator = new THREE.PMREMGenerator(renderer);
          submittedDevice = device;
          for (const samplePhase of OUTDOOR_ENVIRONMENT_PHASES) {
            if (this.closed) throw new Error("Outdoor preparation cancelled");
            const calibration = calibrateOutdoorCapture(capture, samplePhase);
            capture.setPhase(
              samplePhase,
              calibration.skyScale,
              calibration.groundRadiance,
            );
            const target = new THREE.RenderTarget(ATLAS_WIDTH, ATLAS_HEIGHT, {
              minFilter: THREE.LinearFilter,
              magFilter: THREE.LinearFilter,
              generateMipmaps: false,
              type: THREE.HalfFloatType,
              format: THREE.RGBAFormat,
              colorSpace: THREE.LinearSRGBColorSpace,
              depthBuffer: false,
            });
            target.texture.mapping = THREE.CubeUVReflectionMapping;
            (
              target.texture as THREE.Texture & { isPMREMTexture: boolean }
            ).isPMREMTexture = true;
            target.texture.name = `OutdoorSky.phase-${samplePhase}`;
            target.scissorTest = true;
            this.targets.push(target); // Own before a potentially throwing render.
            this.capture(renderer, generator, capture.scene, target);
            await device.queue.onSubmittedWorkDone();
            this.capturesCompleted++;
          }
          if (this.closed) throw new Error("Outdoor preparation cancelled");
          this.nodeA = pmremTexture(this.targets[0].texture);
          this.nodeB = pmremTexture(this.targets[1].texture);
          // Distinct initial textures prevent shared sampled-uniform identities.
          this.environmentNode = mix(this.nodeA, this.nodeB, this.weight);
          this.previousNode = this.scene.environmentNode;
          this.previousIntensity = this.scene.environmentIntensity;
          this.scene.environmentNode = this.environmentNode;
          this.scene.environmentIntensity = 1;
          this.state = "ready";
          this.update(phase);
        } catch (error) {
          errors.push(error);
        } finally {
          // Also drain a partial/throwing capture before retiring its targets.
          // Device loss rejects the drain; it cannot leave valid work in flight.
          await submittedDevice?.queue
            .onSubmittedWorkDone()
            .catch(() => undefined);
          this.preparationMs = performance.now() - started;
          cleanupAfter(errors, [
            () => generator?.dispose(),
            () => capture.dispose(),
            () => {
              this.working = false;
              if (!this.ready) this.retireTargets();
            },
          ]);
        }
      });
    } catch (error) {
      this.closed = true;
      if (!this.isDisposed()) this.state = "failed";
      this.unpublish();
      // Caller deadlines do not cancel the active renderer operation.
      if (!this.working) {
        cleanupAfter(
          [error],
          [() => capture.dispose(), () => this.retireTargets()],
        );
      }
      throw error;
    }
  }

  update(phase: number): void {
    if (!this.ready || !this.nodeA || !this.nodeB) return;
    sampleOutdoorInterval(phase, this.interval);
    const textureA = this.targets[this.interval.a].texture;
    const textureB = this.targets[this.interval.b].texture;
    if (this.nodeA.value !== textureA) this.nodeA.value = textureA;
    if (this.nodeB.value !== textureB) this.nodeB.value = textureB;
    this.weight.value = this.interval.blend;
  }

  dispose(): void {
    if (this.state === "disposed") return;
    this.closed = true;
    this.state = "disposed";
    this.unpublish();
    if (!this.working) this.retireTargets();
  }

  private isDisposed(): boolean {
    return this.state === "disposed";
  }

  private unpublish(): void {
    if (
      this.environmentNode &&
      this.scene.environmentNode === this.environmentNode
    ) {
      this.scene.environmentNode = this.previousNode;
      this.scene.environmentIntensity = this.previousIntensity;
    }
  }

  private retireTargets(): void {
    const targets = this.targets;
    this.targets = [];
    this.nodeA = this.nodeB = null;
    attemptAll(targets.map((target) => () => target.dispose()));
  }

  private capture(
    renderer: ClientGraphics["renderer"],
    generator: THREE.PMREMGenerator,
    scene: THREE.Scene,
    target: THREE.RenderTarget,
  ): void {
    const previous = {
      target: renderer.getRenderTarget(),
      face: renderer.getActiveCubeFace(),
      mip: renderer.getActiveMipmapLevel(),
      mrt: renderer.getMRT(),
      viewport: renderer.getViewport(new THREE.Vector4()),
      scissor: renderer.getScissor(new THREE.Vector4()),
      scissorTest: renderer.getScissorTest(),
      clear: renderer.getClearColor(new THREE.Color()),
      alpha: renderer.getClearAlpha(),
      autoClear: renderer.autoClear,
      toneMapping: renderer.toneMapping,
      exposure: renderer.toneMappingExposure,
      colorSpace: renderer.outputColorSpace,
      renderObject: renderer.getRenderObjectFunction(),
    };
    const errors: unknown[] = [];
    try {
      renderer.setMRT(null);
      renderer.setRenderObjectFunction(null);
      renderer.setScissorTest(false);
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      generator.fromScene(scene, 0, 0.1, 100, {
        size: OUTDOOR_ENVIRONMENT_FACE_SIZE,
        renderTarget: target,
      });
    } catch (error) {
      errors.push(error);
    } finally {
      cleanupAfter(errors, [
        () =>
          renderer.setRenderTarget(
            previous.target,
            previous.face,
            previous.mip,
          ),
        () => renderer.setMRT(previous.mrt),
        () => renderer.setRenderObjectFunction(previous.renderObject),
        () => renderer.setViewport(previous.viewport),
        () => renderer.setScissor(previous.scissor),
        () => renderer.setScissorTest(previous.scissorTest),
        () => renderer.setClearColor(previous.clear, previous.alpha),
        () => {
          renderer.autoClear = previous.autoClear;
        },
        () => {
          renderer.toneMapping = previous.toneMapping;
        },
        () => {
          renderer.toneMappingExposure = previous.exposure;
        },
        () => {
          renderer.outputColorSpace = previous.colorSpace;
        },
      ]);
    }
  }
}
