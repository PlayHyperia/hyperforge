import { describe, expect, it } from "vitest";
import THREE from "../../../../extras/three/three";
import { mix, pmremTexture, uniform } from "three/tsl";
import { World } from "../../../../core/World";
import { ClientGraphics } from "../../../client/ClientGraphics";
import { AMBIENT_LIGHT, HEMISPHERE_LIGHT } from "../LightingConfig";
import {
  OutdoorEnvironment,
  OUTDOOR_ENVIRONMENT_PHASES,
  calibrateOutdoorCapture,
  sampleOutdoorFill,
  sampleOutdoorInterval,
} from "../OutdoorEnvironment";
import {
  SkySystem,
  sampleSkyCycle,
  type SkyLightingCapture,
} from "../SkySystem";

const luminance = (c: THREE.Color) =>
  0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const color = (rgb: readonly [number, number, number]) =>
  new THREE.Color(...rgb);
function expectColorClose(
  actual: THREE.Color,
  expected: THREE.Color,
  precision = 12,
) {
  for (const channel of ["r", "g", "b"] as const)
    expect(actual[channel]).toBeCloseTo(expected[channel], precision);
}
function integratedUp(
  capture: SkyLightingCapture,
  phase: number,
  rows: number,
  columns: number,
) {
  const sum = new THREE.Color(0, 0, 0),
    sample = new THREE.Color(),
    direction = new THREE.Vector3();
  for (let row = 0; row < rows; row++) {
    const y = Math.sqrt((row + 0.5) / rows),
      radius = Math.sqrt(1 - y * y);
    for (let col = 0; col < columns; col++) {
      const angle = ((col + 0.5) / columns) * Math.PI * 2;
      direction.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
      capture.sampleRadiance(phase, direction, sample);
      sum.add(sample);
    }
  }
  return sum.multiplyScalar(Math.PI / (rows * columns));
}

// The seeded fixture exercises actual owner update/disposal and real Three
// texture/node identities. It does NOT exercise initialization or GPU filtering.
function cpuOwnedGraph() {
  const scene = new THREE.Scene();
  const priorNode = uniform(new THREE.Color(0.1, 0.2, 0.3));
  const targets = OUTDOOR_ENVIRONMENT_PHASES.map(
    () =>
      new THREE.RenderTarget(384, 512, {
        type: THREE.HalfFloatType,
        depthBuffer: false,
      }),
  );
  const nodeA = pmremTexture(targets[0].texture),
    nodeB = pmremTexture(targets[1].texture),
    weight = uniform(0);
  const graph = mix(nodeA, nodeB, weight);
  const owner = new OutdoorEnvironment(scene);
  const fixture = owner as unknown as {
    state: "ready";
    targets: THREE.RenderTarget[];
    nodeA: typeof nodeA;
    nodeB: typeof nodeB;
    weight: typeof weight;
    environmentNode: THREE.Scene["environmentNode"];
    previousNode: THREE.Scene["environmentNode"];
    previousIntensity: number;
  };
  Object.assign(fixture, {
    state: "ready",
    targets,
    nodeA,
    nodeB,
    weight,
    environmentNode: graph,
    previousNode: priorNode,
    previousIntensity: 2.5,
  });
  scene.environmentNode = graph;
  scene.environmentIntensity = 1;
  return { scene, owner, targets, nodeA, nodeB, weight, graph, priorNode };
}

describe("outdoor environment CPU contracts (not GPU radiometry or art approval)", () => {
  it("owns exact cache endpoints and wraps cyclic indices", () => {
    const out = { a: -1, b: -1, blend: -1 };
    expect(Object.isFrozen(OUTDOOR_ENVIRONMENT_PHASES)).toBe(true);
    for (const [index, phase] of OUTDOOR_ENVIRONMENT_PHASES.entries()) {
      sampleOutdoorInterval(phase, out);
      expect(out).toEqual({
        a: index,
        b: (index + 1) % OUTDOOR_ENVIRONMENT_PHASES.length,
        blend: 0,
      });
    }
    sampleOutdoorInterval(1, out);
    expect(out).toEqual({ a: 0, b: 1, blend: 0 });
    sampleOutdoorInterval(-0.0625, out);
    expect(out).toEqual({ a: 11, b: 0, blend: 0.5 });
    sampleOutdoorInterval(2.0625, out);
    expect(out).toEqual({ a: 0, b: 1, blend: 0.5 });
  });

  it("has bounded continuous cyclic interpolation through every seam", () => {
    const out = { a: 0, b: 0, blend: 0 };
    const value = (phase: number) => {
      sampleOutdoorInterval(phase, out);
      expect(out.blend).toBeGreaterThanOrEqual(0);
      expect(out.blend).toBeLessThanOrEqual(1);
      const a = Math.sin(2 * Math.PI * OUTDOOR_ENVIRONMENT_PHASES[out.a]);
      const b = Math.sin(2 * Math.PI * OUTDOOR_ENVIRONMENT_PHASES[out.b]);
      return a + (b - a) * out.blend;
    };
    for (const phase of OUTDOOR_ENVIRONMENT_PHASES) {
      expect(value(phase - 1e-8)).toBeCloseTo(value(phase + 1e-8), 6);
    }
    for (let i = -500; i <= 500; i++)
      expect(Number.isFinite(value(i / 100))).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects nonfinite phase %s without writing interval",
    (phase) => {
      const out = { a: 1, b: 2, blend: 0.25 };
      expect(() => sampleOutdoorInterval(phase, out)).toThrow("finite");
      expect(out).toEqual({ a: 1, b: 2, blend: 0.25 });
    },
  );

  it.each([0, 0.25, 0.5, 0.75, 1])(
    "matches the analytic irradiance Color budget at day intensity %s",
    (t) => {
      const ambient = new THREE.AmbientLight();
      const hemisphere = new THREE.HemisphereLight();
      ambient.color
        .copy(color(AMBIENT_LIGHT.NIGHT_COLOR))
        .lerp(color(AMBIENT_LIGHT.DAY_COLOR), t);
      ambient.intensity =
        AMBIENT_LIGHT.INTENSITY_BASE + t * AMBIENT_LIGHT.INTENSITY_DAY_ADD;
      hemisphere.color
        .copy(color(HEMISPHERE_LIGHT.NIGHT_SKY_COLOR))
        .lerp(color(HEMISPHERE_LIGHT.DAY_SKY_COLOR), t);
      hemisphere.groundColor
        .copy(color(HEMISPHERE_LIGHT.NIGHT_GROUND_COLOR))
        .lerp(color(HEMISPHERE_LIGHT.DAY_GROUND_COLOR), t);
      hemisphere.intensity =
        HEMISPHERE_LIGHT.INTENSITY_BASE +
        t * HEMISPHERE_LIGHT.INTENSITY_DAY_ADD;
      const up = new THREE.Color(),
        down = new THREE.Color();
      sampleOutdoorFill(t, up, down);
      const fill = ambient.color.clone().multiplyScalar(ambient.intensity);
      expectColorClose(
        up,
        hemisphere.color.clone().multiplyScalar(hemisphere.intensity).add(fill),
      );
      expectColorClose(
        down,
        hemisphere.groundColor
          .clone()
          .multiplyScalar(hemisphere.intensity)
          .add(fill),
      );
      // HemisphereLightNode mixes these directions before adding AmbientLightNode.
      expectColorClose(
        up.clone().lerp(down, 0.5),
        hemisphere.color
          .clone()
          .lerp(hemisphere.groundColor, 0.5)
          .multiplyScalar(hemisphere.intensity)
          .add(fill),
      );
    },
  );

  it.each([-1, 1.001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid fill intensity %s without changing colors",
    (t) => {
      const up = new THREE.Color(0.2, 0.3, 0.4),
        down = up.clone();
      expect(() => sampleOutdoorFill(t, up, down)).toThrow("intensity");
      expectColorClose(up, down);
    },
  );

  it("calibrates every actual sky snapshot to up luminance and down RGB, not full-sphere RGB equivalence", () => {
    const sky = new SkySystem(new World());
    const capture = sky.createLightingCapture();
    const originalPalette = Object.values(sky.skyPaletteUniforms).map((u) =>
      u.value.toArray(),
    );
    try {
      for (const phase of OUTDOOR_ENVIRONMENT_PHASES) {
        const result = calibrateOutdoorCapture(capture, phase);
        const up = new THREE.Color(),
          down = new THREE.Color();
        sampleOutdoorFill(sampleSkyCycle(phase, new THREE.Vector3()), up, down);
        expect(Number.isFinite(result.skyScale)).toBe(true);
        expect(result.skyScale).toBeGreaterThan(0);
        expect(
          result.groundRadiance.every((x) => Number.isFinite(x) && x >= 0),
        ).toBe(true);
        expectColorClose(color(result.upwardIrradiance), up);
        expectColorClose(
          color(result.groundRadiance).multiplyScalar(Math.PI),
          down,
        );
        const integral = integratedUp(capture, phase, 16, 32).multiplyScalar(
          result.skyScale,
        );
        expect(luminance(integral)).toBeCloseTo(luminance(up), 12);
        const refined = integratedUp(capture, phase, 64, 128).multiplyScalar(
          result.skyScale,
        );
        expect(Math.abs(luminance(refined) / luminance(up) - 1)).toBeLessThan(
          0.025,
        );
        capture.setPhase(phase, result.skyScale, result.groundRadiance);
      }
      expect(
        Object.values(sky.skyPaletteUniforms).map((u) => u.value.toArray()),
      ).toEqual(originalPalette);
    } finally {
      capture.dispose();
    }
  });

  it("rejects a real zero-radiance sky and invalid capture phases", () => {
    const sky = new SkySystem(new World());
    for (const u of Object.values(sky.skyPaletteUniforms))
      u.value.setRGB(0, 0, 0);
    const capture = sky.createLightingCapture();
    try {
      expect(() => calibrateOutdoorCapture(capture, 0.5)).toThrow(
        "positive radiance",
      );
      for (const phase of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1])
        expect(() => calibrateOutdoorCapture(capture, phase)).toThrow();
    } finally {
      capture.dispose();
    }
  });

  it("rejects invalid initialization before acquiring the real graphics queue", async () => {
    const world = new World(),
      graphics = new ClientGraphics(world),
      owner = new OutdoorEnvironment(world.stage.scene);
    const capture = new SkySystem(world).createLightingCapture();
    const previousNode = world.stage.scene.environmentNode;
    await expect(
      owner.initialize(graphics, capture, Number.NaN),
    ).rejects.toThrow("finite");
    expect(graphics.isPrecompileIdle()).toBe(true);
    expect(world.stage.scene.environmentNode).toBe(previousNode);
    expect(capture.scene.children).toHaveLength(0);
    expect(owner.ready).toBe(false);
    owner.dispose();
  });

  it("refuses initialization after disposal and retires the supplied real capture", async () => {
    const world = new World(),
      owner = new OutdoorEnvironment(world.stage.scene);
    const capture = new SkySystem(world).createLightingCapture();
    const previousNode = world.stage.scene.environmentNode;
    owner.dispose();
    await expect(
      owner.initialize(new ClientGraphics(world), capture, 0.5),
    ).rejects.toThrow("initialized");
    expect(capture.scene.children).toHaveLength(0);
    expect(world.stage.scene.environmentNode).toBe(previousNode);
    expect(owner.getStatus().state).toBe("disposed");
  });

  it("keeps the real node graph and target set stable across repeated full cycles", () => {
    const f = cpuOwnedGraph();
    try {
      for (let i = -100; i <= 300; i++) {
        const phase = i / 100;
        f.owner.update(phase);
        const interval = { a: 0, b: 0, blend: 0 };
        sampleOutdoorInterval(phase, interval);
        expect(f.scene.environmentNode).toBe(f.graph);
        expect(f.nodeA.value).toBe(f.targets[interval.a].texture);
        expect(f.nodeB.value).toBe(f.targets[interval.b].texture);
        expect(f.weight.value).toBe(interval.blend);
        expect(f.owner.getStatus().baseColorBytes).toBe(12 * 384 * 512 * 8);
      }
      const before = f.owner.getStatus();
      expect(() => f.owner.update(Number.NaN)).toThrow("finite");
      expect(f.owner.getStatus()).toEqual(before);
    } finally {
      f.owner.dispose();
    }
    expect(f.scene.environmentNode).toBe(f.priorNode);
    expect(f.scene.environmentIntensity).toBe(2.5);
  });

  it("cleans a real capture when the actual graphics instance has no initialized renderer", async () => {
    const world = new World(),
      graphics = new ClientGraphics(world);
    const owner = new OutdoorEnvironment(world.stage.scene);
    const previousNode = world.stage.scene.environmentNode;
    const capture = new SkySystem(world).createLightingCapture();
    let disposals = 0;
    for (const mesh of capture.scene.children as THREE.Mesh[]) {
      mesh.geometry.addEventListener("dispose", () => {
        disposals++;
      });
      (mesh.material as THREE.Material).addEventListener("dispose", () => {
        disposals++;
      });
    }
    await expect(owner.initialize(graphics, capture, 0.5)).rejects.toThrow(
      "initialized WebGPU",
    );
    expect(disposals).toBe(4);
    expect(graphics.isPrecompileIdle()).toBe(true);
    expect(owner.getStatus().state).toBe("failed");
    expect(owner.getStatus().baseColorBytes).toBe(0);
    expect(world.stage.scene.environmentNode).toBe(previousNode);
    owner.dispose();
    expect(disposals).toBe(4);
  });

  it("cancels queued initialization before touching any renderer after disposal", async () => {
    const world = new World(),
      graphics = new ClientGraphics(world);
    const owner = new OutdoorEnvironment(world.stage.scene);
    const capture = new SkySystem(world).createLightingCapture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = graphics.prepareRenderer(() => pending);
    const initialization = owner.initialize(graphics, capture, 0.5);
    const outcome = initialization.catch((error: Error) => error.message);
    owner.dispose();
    release();
    await blocker;
    expect(await outcome).toBe("Outdoor preparation cancelled");
    expect(capture.scene.children).toHaveLength(0);
    expect(graphics.isPrecompileIdle()).toBe(true);
    expect(owner.getStatus().state).toBe("disposed");
    expect(owner.getStatus().capturesCompleted).toBe(0);
  });

  it("retires every real target once even if one disposal listener throws", () => {
    const f = cpuOwnedGraph();
    const disposed: number[] = [];
    const listenerError = new Error("listener failure");
    for (const [i, target] of f.targets.entries())
      target.addEventListener("dispose", () => {
        disposed.push(i);
        if (i === 0) throw listenerError;
      });
    let failure: unknown;
    try {
      f.owner.dispose();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([listenerError]);
    expect(disposed).toEqual([...OUTDOOR_ENVIRONMENT_PHASES.keys()]);
    expect(f.scene.environmentNode).toBe(f.priorNode);
    expect(f.owner.getStatus().baseColorBytes).toBe(0);
    f.owner.dispose();
    expect(disposed).toHaveLength(12);
  });

  it("does not overwrite a later scene owner during disposal", () => {
    const f = cpuOwnedGraph();
    const foreign = uniform(new THREE.Color(0.3, 0.4, 0.5));
    f.scene.environmentNode = foreign;
    f.scene.environmentIntensity = 7;
    f.owner.dispose();
    expect(f.scene.environmentNode).toBe(foreign);
    expect(f.scene.environmentIntensity).toBe(7);
  });
});
