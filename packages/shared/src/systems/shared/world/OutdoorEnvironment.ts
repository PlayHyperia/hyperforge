import THREE from "../../../extras/three/three";
import type Node from "three/src/nodes/core/Node.js";
import {
  acos,
  atan,
  cos,
  float,
  materialEnvRotation,
  mix,
  normalWorld,
  pmremTexture,
  sin,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { ClientGraphics } from "../../client/ClientGraphics";
import { AMBIENT_LIGHT, HEMISPHERE_LIGHT } from "./LightingConfig";
import { sampleSkyCycle, type SkyLightingCapture } from "./SkySystem";
import {
  setRoughLeafEnvironment,
  supportsRoughLeafRecipe,
} from "./GrassRoughLeafMaterial";

// Smooth sky radiance needs far less angular detail than reflected geometry.
// Twelve RGBA16F 384x512 atlases occupy 18 MiB of base color storage. This is
// not total renderer memory; generation has scratch targets and pipeline costs.
export const OUTDOOR_ENVIRONMENT_PHASES = Object.freeze([
  0, 0.125, 0.22, 0.25, 0.28, 0.32, 0.5, 0.68, 0.72, 0.75, 0.78, 0.875,
]);
export const OUTDOOR_ENVIRONMENT_FACE_SIZE = 128;
const ATLAS_WIDTH = 384;
const ATLAS_HEIGHT = 512;
/** Opt-in finite-resolution approximation of the SAME roughness-one PMREM
 * radiance. Explicit duplicate longitude endpoint and pole rows, no mip chain.
 * Native radiometry, seam/orientation and full-world performance remain gates. */
export const OUTDOOR_ROUGH_LEAF_MAP = Object.freeze({
  width: 129,
  height: 65,
  longitudeSegments: 128,
  polarSegments: 64,
  bytesPerPhase: 129 * 65 * 8,
});
type RGB = readonly [number, number, number];
export type OutdoorCalibration = "luminance-v1" | "rgb-irradiance-v1";
type State = "idle" | "preparing" | "ready" | "failed" | "disposed";
// Public r186 callback; installed declarations do not yet expose its contract.
type RoughLeafBuilder = {
  material: THREE.Material | null;
  fragmentShader?: string;
};
type RoughLeafBuilderCallback = (
  builder: RoughLeafBuilder,
  owner: { object?: THREE.Object3D; material?: THREE.Material },
) => void;
type RoughLeafDebug = { onNodeBuilderCreated: RoughLeafBuilderCallback | null };

type OutdoorPreparationStep =
  | "calibrationMs"
  | "captureCpuMs"
  | "compileMs"
  | "drawCpuMs"
  | "completionMs"
  | "drainMs"
  | "cleanupDrainMs"
  | "scopePopMs";

/** Startup wall-clock evidence, not GPU timestamps. Null means not attempted.
 * The clock parameter keeps receipt arithmetic independently CPU-testable. */
export class OutdoorPreparationPhaseTiming {
  private readonly startedAtMs: number;
  private finishedAtMs: number | null = null;
  private completed = false;
  private readonly activeSteps = new Map<OutdoorPreparationStep, number>();
  private readonly steps: Record<OutdoorPreparationStep, number | null> = {
    calibrationMs: null,
    captureCpuMs: null,
    compileMs: null,
    drawCpuMs: null,
    completionMs: null,
    drainMs: null,
    cleanupDrainMs: null,
    scopePopMs: null,
  };

  constructor(
    private readonly phaseIndex: number,
    private readonly phase: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.startedAtMs = now();
  }

  private begin(step: OutdoorPreparationStep): void {
    this.activeSteps.set(step, this.now());
  }

  private end(step: OutdoorPreparationStep): void {
    this.steps[step] =
      (this.steps[step] ?? 0) + this.now() - this.activeSteps.get(step)!;
    this.activeSteps.delete(step);
  }

  measure<T>(step: OutdoorPreparationStep, operation: () => T): T {
    this.begin(step);
    try {
      return operation();
    } finally {
      this.end(step);
    }
  }

  async measureAsync<T>(
    step: OutdoorPreparationStep,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    this.begin(step);
    try {
      return await operation();
    } finally {
      this.end(step);
    }
  }

  finish(completed: boolean): void {
    if (this.finishedAtMs !== null) return;
    this.finishedAtMs = this.now();
    this.completed = completed;
  }

  snapshot() {
    const now = this.now();
    const activeSteps = [...this.activeSteps].map(([step, startedAtMs]) => ({
      step,
      elapsedMs: now - startedAtMs,
    }));
    return {
      phaseIndex: this.phaseIndex,
      phase: this.phase,
      startedAtMs: this.startedAtMs,
      elapsedMs: (this.finishedAtMs ?? now) - this.startedAtMs,
      completed: this.completed,
      settled: this.finishedAtMs !== null,
      activeStep: activeSteps[0]?.step ?? null,
      activeStepElapsedMs: activeSteps[0]?.elapsedMs ?? null,
      activeSteps,
      ...this.steps,
    };
  }
}

/** Start every ordered operation before awaiting any of them. In particular,
 * popErrorScope removes its scope when called, not when its promise resolves.
 * Synchronous failures must not prevent later scopes from being popped. */
export function settleOutdoorPreparationOperations<T>(
  operations: ReadonlyArray<() => T | Promise<T>>,
) {
  const pending = operations.map((operation) => {
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  });
  return Promise.allSettled(pending);
}

type SceneEnvironmentNode = NonNullable<THREE.Scene["environmentNode"]>;
type SharedGrassEnvironmentNode = Node<"vec3">;
type GrassEnvironmentOwner = {
  source: SceneEnvironmentNode;
  shared: SharedGrassEnvironmentNode | null;
  roughLeaf: SharedGrassEnvironmentNode | null;
};
const grassEnvironmentOwners = new WeakMap<
  THREE.Scene,
  GrassEnvironmentOwner
>();
// Keep historical provenance while a material/clone still holds the node. A
// retired source must cease sampling, but its old binding is still ours to undo.
const sharedGrassEnvironmentOwners = new WeakMap<Node, GrassEnvironmentOwner>();
const unsupportedGrassScalars = [
  "anisotropy",
  "clearcoat",
  "retroreflectivity",
  "transmission",
  "sheen",
  "iridescence",
  "dispersion",
] as const;
const unsupportedGrassFlags = [
  "useAnisotropy",
  "useClearcoat",
  "useRetroreflection",
  "useTransmission",
  "useSheen",
  "useIridescence",
  "useDispersion",
] as const;
const unsupportedGrassNodesAndMaps = [
  "anisotropyNode",
  "anisotropyMap",
  "clearcoatNode",
  "clearcoatRoughnessNode",
  "clearcoatNormalNode",
  "clearcoatMap",
  "clearcoatNormalMap",
  "clearcoatRoughnessMap",
  "retroreflectivityNode",
  "transmissionNode",
  "transmissionMap",
  "sheenNode",
  "sheenRoughnessNode",
  "sheenColorMap",
  "sheenRoughnessMap",
  "iridescenceNode",
  "iridescenceIORNode",
  "iridescenceThicknessNode",
  "iridescenceMap",
  "iridescenceThicknessMap",
  "dispersionNode",
  "iorNode",
  "specularIntensityNode",
  "specularColorNode",
  "specularIntensityMap",
  "specularColorMap",
  "lightsNode",
  "fragmentNode",
  "backdropNode",
] as const;

function supportsSharedGrassEnvironment(material: THREE.NodeMaterial): boolean {
  if (
    !(material instanceof THREE.MeshSSSNodeMaterial) ||
    material.roughness !== 1 ||
    material.roughnessNode !== null ||
    material.roughnessMap !== null ||
    material.metalness !== 0 ||
    material.metalnessNode !== null ||
    material.metalnessMap !== null ||
    material.envMap !== null ||
    material.ior !== 1.5 ||
    material.specularIntensity !== 1 ||
    material.specularColor.r !== 1 ||
    material.specularColor.g !== 1 ||
    material.specularColor.b !== 1
  )
    return false;
  // Indexed loops and immutable field tables avoid allocating per grass draw.
  // Reflect covers r186 fields missing from the older installed declarations.
  for (let i = 0; i < unsupportedGrassScalars.length; i++)
    if (Reflect.get(material, unsupportedGrassScalars[i]) !== 0) return false;
  for (let i = 0; i < unsupportedGrassFlags.length; i++)
    if (Reflect.get(material, unsupportedGrassFlags[i]) !== false) return false;
  for (let i = 0; i < unsupportedGrassNodesAndMaps.length; i++)
    if (Reflect.get(material, unsupportedGrassNodesAndMaps[i]) != null)
      return false;
  return true;
}

/** Bind only this world's published outdoor graph to an admitted matte leaf.
 * Called from the object's before-render hook, before Three selects its program.
 * A scalar recipe change restores the stock graph and requests one recompile;
 * stable draws and sky-phase/texture updates do not change material versions.
 * This reduces duplicate PMREM lookup work, not the physical lighting model. */
export function updateGrassEnvironmentMaterial(
  scene: THREE.Scene,
  material: THREE.Material,
): void {
  let owner = grassEnvironmentOwners.get(scene);
  // A temporary foreign scene override is not the owner's disposal. Preserve
  // registration so restoring that still-live source can re-admit the recipe.
  if (owner && scene.environmentNode !== owner.source) owner = undefined;
  if (!(material instanceof THREE.NodeMaterial)) return;
  const previous = material.envNode;
  // Respect another writer even when this material previously held our node.
  if (previous !== null && !sharedGrassEnvironmentOwners.has(previous)) return;
  let next: SharedGrassEnvironmentNode | null = null;
  if (owner && supportsSharedGrassEnvironment(material)) {
    if (owner.shared === null) {
      owner.shared = vec3(owner.source)
        .context({ getUV: () => normalWorld, getTextureLevel: () => float(1) })
        .toVar("grassMaxRoughnessEnvironment");
      sharedGrassEnvironmentOwners.set(owner.shared, owner);
    }
    next = owner.shared;
  }
  if (previous !== next) {
    material.envNode = next;
    material.needsUpdate = true;
  }
}

/** The object callback runs before pipeline selection. Missing, foreign or
 * retired owners restore the material's stock path; the setter never takes
 * ownership of a foreign envNode or of the owner's textures. */
export function updateGrassRoughLeafEnvironmentMaterial(
  scene: THREE.Scene,
  material: THREE.Material,
): void {
  const owner = grassEnvironmentOwners.get(scene);
  const node =
    owner &&
    scene.environmentNode === owner.source &&
    supportsRoughLeafRecipe(material)
      ? owner.roughLeaf
      : null;
  setRoughLeafEnvironment(material, node);
}

/** Texel-center grid used only for the preparation quad. Rounding selects the
 * exact integer cell despite interpolated-UV roundoff. Seam columns and every
 * texel on a pole row resolve to identical directions, not almost-equal sine. */
export function createOutdoorRoughLeafDirection(
  mapUV: Node<"vec2">,
): Node<"vec3"> {
  const grid = mapUV
    .mul(vec2(OUTDOOR_ROUGH_LEAF_MAP.width, OUTDOOR_ROUGH_LEAF_MAP.height))
    .sub(0.5)
    .round();
  const longitude = grid.x
    .div(OUTDOOR_ROUGH_LEAF_MAP.longitudeSegments)
    .fract()
    .sub(0.5)
    .mul(Math.PI * 2);
  const polar = grid.y
    .clamp(0, OUTDOOR_ROUGH_LEAF_MAP.polarSegments)
    .div(OUTDOOR_ROUGH_LEAF_MAP.polarSegments)
    .mul(Math.PI);
  const direction = vec3(
    cos(longitude).mul(sin(polar)),
    cos(polar),
    sin(longitude).mul(sin(polar)),
  );
  return grid.y
    .lessThanEqual(0)
    .select(
      vec3(0, 1, 0),
      grid.y
        .greaterThanEqual(OUTDOOR_ROUGH_LEAF_MAP.polarSegments)
        .select(vec3(0, -1, 0), direction),
    );
}

/** Map a unit direction into the endpoint-inclusive texel-center domain.
 * atan(0,0) is indeterminate in WGSL: feed (0,1) at either pole instead. */
export function createOutdoorRoughLeafUV(
  direction: Node<"vec3">,
): Node<"vec2"> {
  const radial = direction.x
    .mul(direction.x)
    .add(direction.z.mul(direction.z))
    .greaterThan(1e-20);
  const angle = atan(
    radial.select(direction.z, float(0)),
    radial.select(direction.x, float(1)),
  );
  const angular = vec2(
    angle.div(Math.PI * 2).add(0.5),
    acos(direction.y.clamp(-1, 1)).div(Math.PI),
  );
  return angular
    .mul(
      vec2(
        OUTDOOR_ROUGH_LEAF_MAP.longitudeSegments,
        OUTDOOR_ROUGH_LEAF_MAP.polarSegments,
      ),
    )
    .add(0.5)
    .div(vec2(OUTDOOR_ROUGH_LEAF_MAP.width, OUTDOOR_ROUGH_LEAF_MAP.height));
}

/** Explicit visual candidate; ordinary startup retains the existing lighting. */
export function resolveOutdoorCalibration(
  search = typeof window === "undefined" ? "" : window.location.search,
): OutdoorCalibration {
  const values = new URLSearchParams(search).getAll("outdoorCalibration");
  if (values.length === 0) return "luminance-v1";
  if (
    values.length !== 1 ||
    (values[0] !== "luminance-v1" && values[0] !== "rgb-irradiance-v1")
  ) {
    throw new Error("Invalid outdoor lighting calibration");
  }
  return values[0];
}

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
  calibration: OutdoorCalibration = "luminance-v1",
): {
  skyScale: number;
  skyColor: RGB;
  groundRadiance: RGB;
  upwardIrradiance: RGB;
} {
  if (calibration !== "luminance-v1" && calibration !== "rgb-irradiance-v1") {
    throw new Error("Invalid outdoor lighting calibration");
  }
  const direction = new THREE.Vector3();
  const up = new THREE.Color();
  const down = new THREE.Color();
  sampleOutdoorFill(sampleSkyCycle(phase, direction), up, down);
  const sample = new THREE.Color();
  const mean = new THREE.Color(0, 0, 0);
  // Resolve individual scattering channels accurately near the horizon. This
  // is twelve startup integrations, not work in the render/update loop.
  const rows = calibration === "rgb-irradiance-v1" ? 64 : 16;
  const columns = rows * 2;
  for (let row = 0; row < rows; row++) {
    const y = Math.sqrt((row + 0.5) / rows);
    const radius = Math.sqrt(1 - y * y);
    for (let column = 0; column < columns; column++) {
      const angle = ((column + 0.5) / columns) * Math.PI * 2;
      direction.set(radius * Math.cos(angle), y, radius * Math.sin(angle));
      capture.sampleRadiance(phase, direction, sample);
      mean.add(sample);
    }
  }
  mean.multiplyScalar(1 / (rows * columns));
  const luminance = (c: THREE.Color) =>
    0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const skyY = luminance(mean);
  if (!Number.isFinite(skyY) || skyY <= 0) {
    throw new Error("Outdoor sky capture has no finite positive radiance");
  }
  const skyScale = luminance(up) / (Math.PI * skyY);
  let skyColor: RGB = [1, 1, 1];
  if (calibration === "rgb-irradiance-v1") {
    const channels = [mean.r, mean.g, mean.b];
    if (!channels.every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error(
        "Outdoor RGB calibration requires positive radiance in every channel",
      );
    }
    // Match the existing linear RGB irradiance budget, not only luminance.
    // This preserves directional sky detail and does not brighten the budget,
    // alter visible sky/exposure, or add actor-specific lighting. Startup only.
    const denominator = Math.PI * skyScale;
    skyColor = [
      up.r / (mean.r * denominator),
      up.g / (mean.g * denominator),
      up.b / (mean.b * denominator),
    ];
    if (!skyColor.every((value) => Number.isFinite(value) && value >= 0)) {
      throw new Error(
        "Outdoor RGB calibration produced invalid radiance gains",
      );
    }
  }
  down.multiplyScalar(1 / Math.PI);
  return {
    skyScale,
    skyColor,
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
  private preparationStartedAtMs: number | null = null;
  private preparationCleanupDrainMs: number | null = null;
  private readonly phaseTimings: OutdoorPreparationPhaseTiming[] = [];
  private capturesCompleted = 0;
  private roughLeafTargets: THREE.RenderTarget[] = [];
  private roughLeafNodeA: ReturnType<typeof texture> | null = null;
  private roughLeafNodeB: ReturnType<typeof texture> | null = null;
  private roughLeafNode: SharedGrassEnvironmentNode | null = null;
  private roughLeafState: State = "idle";
  private roughLeafFailure: string | null = null;
  private roughLeafCapturesCompleted = 0;
  private roughLeafPreparationMs: number | null = null;
  private roughLeafCleanupDrainMs: number | null = null;
  private readonly roughLeafPhaseTimings: OutdoorPreparationPhaseTiming[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly calibration: OutdoorCalibration = "luminance-v1",
    private readonly enableRoughLeaf = false,
  ) {
    if (calibration !== "luminance-v1" && calibration !== "rgb-irradiance-v1") {
      throw new Error("Invalid outdoor lighting calibration");
    }
    if (typeof enableRoughLeaf !== "boolean")
      throw new Error("Invalid rough-leaf environment selection");
  }

  get ready(): boolean {
    return this.state === "ready" && !this.closed;
  }

  getStatus() {
    return {
      state: this.state,
      calibration: this.calibration,
      phaseCount: OUTDOOR_ENVIRONMENT_PHASES.length,
      faceSize: OUTDOOR_ENVIRONMENT_FACE_SIZE,
      baseColorBytes: this.targets.length * ATLAS_WIDTH * ATLAS_HEIGHT * 8,
      activeInterval: [this.interval.a, this.interval.b] as const,
      blend: this.interval.blend,
      capturesCompleted: this.capturesCompleted,
      preparationMs: this.preparationMs,
      preparationStartedAtMs: this.preparationStartedAtMs,
      cleanupDrainMs: this.preparationCleanupDrainMs,
      phaseTimings: this.phaseTimings.map((timing) => timing.snapshot()),
      roughLeaf: {
        enabled: this.enableRoughLeaf,
        state: this.roughLeafState,
        failure: this.roughLeafFailure,
        ...OUTDOOR_ROUGH_LEAF_MAP,
        phaseCount: this.roughLeafTargets.length,
        baseColorBytes:
          this.roughLeafTargets.length * OUTDOOR_ROUGH_LEAF_MAP.bytesPerPhase,
        capturesCompleted: this.roughLeafCapturesCompleted,
        preparationMs: this.roughLeafPreparationMs,
        cleanupDrainMs: this.roughLeafCleanupDrainMs,
        completionTiming:
          "completionMs contains overlapping drainMs and scopePopMs; do not sum these waits",
        phaseTimings: this.roughLeafPhaseTimings.map((timing) =>
          timing.snapshot(),
        ),
      },
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
        this.preparationStartedAtMs = started;
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
          for (const [
            phaseIndex,
            samplePhase,
          ] of OUTDOOR_ENVIRONMENT_PHASES.entries()) {
            if (this.closed) throw new Error("Outdoor preparation cancelled");
            const timing = new OutdoorPreparationPhaseTiming(
              phaseIndex,
              samplePhase,
            );
            this.phaseTimings.push(timing);
            const calibration = timing.measure("calibrationMs", () =>
              calibrateOutdoorCapture(capture, samplePhase, this.calibration),
            );
            capture.setPhase(
              samplePhase,
              calibration.skyScale,
              calibration.groundRadiance,
              calibration.skyColor,
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
            timing.measure("captureCpuMs", () =>
              this.capture(renderer, generator!, capture.scene, target),
            );
            await timing.measureAsync("drainMs", () =>
              device.queue.onSubmittedWorkDone(),
            );
            this.capturesCompleted++;
            timing.finish(true);
          }
          if (this.enableRoughLeaf) {
            const roughLeafStarted = performance.now();
            try {
              await this.prepareRoughLeaf(renderer, device);
            } catch (error) {
              this.roughLeafFailure = String(error);
              this.roughLeafState = this.closed ? "disposed" : "failed";
              this.retireRoughLeafTargets();
              // A cancelled queue operation cannot publish even the stock graph.
              // A failed optional bake otherwise leaves all ordinary PMREMs intact.
              if (this.closed) throw error;
            } finally {
              this.roughLeafPreparationMs =
                performance.now() - roughLeafStarted;
            }
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
          this.publishGrassOwner();
        } catch (error) {
          errors.push(error);
        } finally {
          this.phaseTimings.at(-1)?.finish(false);
          // Also drain a partial/throwing capture before retiring its targets.
          // Settlement alone is not device-liveness evidence after device loss.
          const drainStarted = performance.now();
          await submittedDevice?.queue
            .onSubmittedWorkDone()
            .catch(() => undefined);
          this.preparationCleanupDrainMs = submittedDevice
            ? performance.now() - drainStarted
            : null;
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
    if (this.roughLeafNodeA && this.roughLeafNodeB) {
      const roughA = this.roughLeafTargets[this.interval.a].texture;
      const roughB = this.roughLeafTargets[this.interval.b].texture;
      if (this.roughLeafNodeA.value !== roughA)
        this.roughLeafNodeA.value = roughA;
      if (this.roughLeafNodeB.value !== roughB)
        this.roughLeafNodeB.value = roughB;
    }
    this.weight.value = this.interval.blend;
  }

  dispose(): void {
    if (this.state === "disposed") return;
    this.closed = true;
    this.state = "disposed";
    this.roughLeafState = "disposed";
    this.unpublish();
    if (!this.working) this.retireTargets();
  }

  private isDisposed(): boolean {
    return this.state === "disposed";
  }

  private unpublish(): void {
    if (grassEnvironmentOwners.get(this.scene)?.source === this.environmentNode)
      grassEnvironmentOwners.delete(this.scene);
    if (
      this.environmentNode &&
      this.scene.environmentNode === this.environmentNode
    ) {
      this.scene.environmentNode = this.previousNode;
      this.scene.environmentIntensity = this.previousIntensity;
    }
  }

  private publishGrassOwner(): void {
    if (
      !this.ready ||
      !this.environmentNode ||
      this.scene.environmentNode !== this.environmentNode
    )
      throw new Error(
        "Outdoor grass binding requires its published live owner",
      );
    grassEnvironmentOwners.set(this.scene, {
      source: this.environmentNode,
      shared: null,
      roughLeaf: this.roughLeafNode,
    });
  }

  private retireTargets(): void {
    const targets = this.targets;
    this.targets = [];
    this.nodeA = this.nodeB = null;
    attemptAll([
      () => this.retireRoughLeafTargets(),
      ...targets.map((target) => () => target.dispose()),
    ]);
  }

  private retireRoughLeafTargets(): void {
    const targets = this.roughLeafTargets;
    this.roughLeafTargets = [];
    this.roughLeafNodeA = this.roughLeafNodeB = null;
    this.roughLeafNode = null;
    attemptAll(targets.map((target) => () => target.dispose()));
  }

  /** Already inside this owner's prepareRenderer lease. No nested queue,
   * source replacement, new sky captures or camera-dependent world baking. */
  private async prepareRoughLeaf(
    renderer: ClientGraphics["renderer"],
    device: GPUDevice,
  ): Promise<void> {
    if (
      this.closed ||
      this.targets.length !== OUTDOOR_ENVIRONMENT_PHASES.length ||
      !renderer.hasInitialized() ||
      device.limits.maxTextureDimension2D < OUTDOOR_ROUGH_LEAF_MAP.width
    )
      throw new Error("Rough-leaf preparation requires twelve live PMREMs");
    this.roughLeafState = "preparing";
    await this.bakeRoughLeafPhases(renderer, device);
    this.publishRoughLeaf();
  }

  private publishRoughLeaf(): void {
    if (
      this.closed ||
      !this.enableRoughLeaf ||
      this.roughLeafTargets.length !== OUTDOOR_ENVIRONMENT_PHASES.length
    )
      throw new Error("Rough-leaf binding requires all twelve phase maps");
    // Distinct starting maps keep both sampled bindings independently live.
    this.roughLeafNodeA = texture(this.roughLeafTargets[0].texture);
    this.roughLeafNodeB = texture(this.roughLeafTargets[1].texture);
    this.roughLeafNodeA.updateMatrix = this.roughLeafNodeB.updateMatrix = false;
    // Stock PMREMNode rotates AFTER flipping Y on render-target sources.
    // The preparation quad cancels that flip, storing raw F(direction). This
    // live transform therefore exactly retains the stock rotation convention.
    const direction = materialEnvRotation
      .mul(vec3(normalWorld.x, normalWorld.y.negate(), normalWorld.z))
      .xyz.normalize();
    const mapUV = createOutdoorRoughLeafUV(direction).toVar(
      "roughLeafEnvironmentUV",
    );
    const a = this.roughLeafNodeA.sample(mapUV).level(float(0));
    const b = this.roughLeafNodeB.sample(mapUV).level(float(0));
    a.updateMatrix = b.updateMatrix = false;
    // .level() loses its vector dimension in the installed declarations.
    // Concrete ConvertNodes retain an actual typed graph, not a type assertion.
    const rgbaA = vec4(new THREE.ConvertNode<"vec4">(a, "vec4"));
    const rgbaB = vec4(new THREE.ConvertNode<"vec4">(b, "vec4"));
    this.roughLeafNode = mix(rgbaA.rgb, rgbaB.rgb, this.weight).toVar(
      "roughLeafEnvironmentRadiance",
    );
    this.roughLeafState = "ready";
  }

  private async bakeRoughLeafPhases(
    renderer: ClientGraphics["renderer"],
    device: GPUDevice,
  ): Promise<void> {
    const material = new THREE.NodeMaterial();
    let pmrem: ReturnType<typeof pmremTexture> | null = null;
    let compilation: Promise<void> | undefined;
    let restoreCallback: (() => void) | undefined;
    let assertBuilder: (() => void) | undefined;
    let phaseWorkDrained = false;
    const errors: unknown[] = [];
    const requireBake = (condition: unknown, message: string) => {
      if (!condition) throw new Error(`Rough-leaf bake: ${message}`);
    };
    try {
      const direction = createOutdoorRoughLeafDirection(uv());
      // PMREMNode performs its own Y flip. Cancel it here and use the bake
      // material's identity environment rotation; NO phase/intensity/π gains.
      pmrem = pmremTexture(
        this.targets[0].texture,
        vec3(direction.x, direction.y.negate(), direction.z),
        float(1),
      );
      material.fragmentNode = vec4(pmrem.toVar("roughLeafBakedRadiance"), 1);
      material.vertexNode = vec4(THREE.TSL.positionGeometry.xy, 0, 1);
      material.name = "OutdoorSky.rough-leaf-bake";
      material.depthTest = material.depthWrite = false;
      material.fog = material.toneMapped = false;
      material.blending = THREE.NoBlending;
      material.premultipliedAlpha = false;
      const quad = new THREE.QuadMesh(material);
      quad.frustumCulled = false;
      const expectedFragment = material.fragmentNode;
      const debug = renderer.debug as unknown as RoughLeafDebug;
      const descriptor = Object.getOwnPropertyDescriptor(
          debug,
          "onNodeBuilderCreated",
        ),
        prior = debug.onNodeBuilderCreated;
      requireBake(
        (prior === null || typeof prior === "function") &&
          (descriptor
            ? descriptor.configurable && "value" in descriptor
            : Object.isExtensible(debug)),
        "safe builder callback",
      );
      const builders: RoughLeafBuilder[] = [];
      let overflow = false;
      const observe: RoughLeafBuilderCallback = (builder, owner) => {
        prior?.(builder, owner);
        if (owner.object === quad && owner.material === material) {
          if (builders.length < 4) builders.push(builder);
          else overflow = true;
        }
      };
      Object.defineProperty(debug, "onNodeBuilderCreated", {
        value: observe,
        configurable: true,
        writable: true,
        enumerable: descriptor?.enumerable ?? false,
      });
      restoreCallback = () => {
        requireBake(
          debug.onNodeBuilderCreated === observe,
          "foreign callback retained",
        );
        if (descriptor)
          Object.defineProperty(debug, "onNodeBuilderCreated", descriptor);
        else Reflect.deleteProperty(debug, "onNodeBuilderCreated");
        requireBake(
          debug.onNodeBuilderCreated === prior,
          "callback restoration failed",
        );
      };
      assertBuilder = () =>
        requireBake(
          !this.closed &&
            builders.length > 0 &&
            !overflow &&
            debug.onNodeBuilderCreated === observe &&
            material.fragmentNode === expectedFragment &&
            builders.every(
              (builder) =>
                builder.material === material &&
                !!builder.fragmentShader?.includes("roughLeafBakedRadiance"),
            ),
          "owned roughness-one shader required; compiler fallback rejected",
        );
      // Every source has the same PMREM layout and render-target Y convention;
      // only its sampled texture changes. Retain one quad/material/node graph
      // so all twelve phases reuse the first compiled pipeline. PMREMNode.value
      // resets its cached source; its per-render update retargets the binding.
      for (const [index, source] of this.targets.entries()) {
        if (this.closed) throw new Error("Outdoor preparation cancelled");
        phaseWorkDrained = false;
        const timing = new OutdoorPreparationPhaseTiming(
          index,
          OUTDOOR_ENVIRONMENT_PHASES[index],
        );
        this.roughLeafPhaseTimings.push(timing);
        requireBake(
          source.texture.isRenderTargetTexture &&
            source.texture.mapping === THREE.CubeUVReflectionMapping,
          "owned render-target PMREM required",
        );
        pmrem.value = source.texture;
        const target = new THREE.RenderTarget(
          OUTDOOR_ROUGH_LEAF_MAP.width,
          OUTDOOR_ROUGH_LEAF_MAP.height,
          {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            generateMipmaps: false,
            type: THREE.HalfFloatType,
            format: THREE.RGBAFormat,
            colorSpace: THREE.LinearSRGBColorSpace,
            depthBuffer: false,
            stencilBuffer: false,
            samples: 0,
          },
        );
        target.texture.name = `OutdoorSky.rough-leaf-phase-${OUTDOOR_ENVIRONMENT_PHASES[index]}`;
        target.texture.wrapS = target.texture.wrapT = THREE.ClampToEdgeWrapping;
        target.texture.matrixAutoUpdate = false;
        this.roughLeafTargets.push(target); // Own before any compilation/render.
        const phaseErrors: unknown[] = [];
        let scopes = 0;
        try {
          for (const filter of [
            "out-of-memory",
            "internal",
            "validation",
          ] as const) {
            device.pushErrorScope(filter);
            scopes++;
          }
          if (compilation === undefined) {
            await timing.measureAsync("compileMs", async () => {
              this.withCaptureState(
                renderer,
                () => {
                  compilation = renderer.compileAsync(quad, quad.camera);
                },
                target,
              );
              await compilation;
            });
          }
          assertBuilder();
          const issued = timing.measure("drawCpuMs", () =>
            this.withCaptureState(
              renderer,
              () => {
                const before = renderer.info.render.drawCalls;
                // QuadMesh.render temporarily overwrites vertexNode without finally.
                // Use the same explicit fullscreen vertex for compile and draw instead.
                renderer.render(quad, quad.camera);
                return renderer.info.render.drawCalls - before;
              },
              target,
            ),
          );
          requireBake(issued === 1, "one real phase-map draw required");
        } catch (error) {
          phaseErrors.push(error);
        } finally {
          await compilation?.catch((error) => {
            if (!phaseErrors.includes(error)) phaseErrors.push(error);
          });
          // Compilation (including a partial failure) has settled, so every
          // phase command is now submitted. Start its one drain and remove all
          // scopes immediately, then await ALL results before acceptance or
          // retirement. The same boundary also protects failed/partial draws.
          await timing.measureAsync("completionMs", async () => {
            const drain = timing.measureAsync("drainMs", () =>
              device.queue.onSubmittedWorkDone(),
            );
            const pops: Array<() => ReturnType<GPUDevice["popErrorScope"]>> =
              [];
            while (scopes > 0) {
              scopes--;
              pops.push(() => device.popErrorScope());
            }
            const scopeResults = timing.measureAsync("scopePopMs", () =>
              settleOutdoorPreparationOperations(pops),
            );
            const [drained, popped] = await Promise.allSettled([
              drain,
              scopeResults,
            ]);
            if (drained.status === "fulfilled") phaseWorkDrained = true;
            else phaseErrors.push(drained.reason);
            if (popped.status === "rejected") phaseErrors.push(popped.reason);
            else {
              for (const result of popped.value) {
                if (result.status === "rejected")
                  phaseErrors.push(result.reason);
                else if (result.value)
                  phaseErrors.push(new Error(result.value.message));
              }
            }
          });
          cleanupAfter(phaseErrors, [
            assertBuilder,
            () =>
              requireBake(
                renderer.hasInitialized() &&
                  Reflect.get(renderer, "_isDeviceLost") !== true &&
                  (renderer.backend as unknown as { device?: GPUDevice })
                    .device === device,
                "live original WebGPU device required",
              ),
          ]);
        }
        if (this.closed) throw new Error("Outdoor preparation cancelled");
        this.roughLeafCapturesCompleted++;
        timing.finish(true);
      }
    } catch (error) {
      errors.push(error);
    } finally {
      this.roughLeafPhaseTimings.at(-1)?.finish(false);
      await compilation?.catch((error) => {
        if (!errors.includes(error)) errors.push(error);
      });
      if (!phaseWorkDrained) {
        const drainStarted = performance.now();
        await device.queue
          .onSubmittedWorkDone()
          .catch((error) => errors.push(error));
        this.roughLeafCleanupDrainMs = performance.now() - drainStarted;
      }
      cleanupAfter(errors, [
        () => assertBuilder?.(),
        () => restoreCallback?.(),
        () => material.dispose(),
        () => pmrem?.dispose(),
      ]);
    }
  }

  private capture(
    renderer: ClientGraphics["renderer"],
    generator: THREE.PMREMGenerator,
    scene: THREE.Scene,
    target: THREE.RenderTarget,
  ): void {
    this.withCaptureState(renderer, () =>
      generator.fromScene(scene, 0, 0.1, 100, {
        size: OUTDOOR_ENVIRONMENT_FACE_SIZE,
        renderTarget: target,
      }),
    );
  }

  /** Restore borrowed state synchronously, including compile initiation. Never
   * change canvas size, pixel ratio, animation loop or a source environment. */
  private withCaptureState<T>(
    renderer: ClientGraphics["renderer"],
    operation: () => T,
    target?: THREE.RenderTarget,
  ): T {
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
    let value!: T;
    try {
      renderer.setMRT(null);
      renderer.setRenderObjectFunction(null);
      renderer.setScissorTest(false);
      if (target) {
        renderer.setRenderTarget(target);
        renderer.setClearColor(0, 0);
        renderer.autoClear = true;
      }
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      value = operation();
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
    return value;
  }
}
