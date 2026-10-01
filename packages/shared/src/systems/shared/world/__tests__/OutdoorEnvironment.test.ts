import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Browser } from "playwright";
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
  resolveOutdoorCalibration,
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
  it("requires one explicit RGB candidate selector and preserves ordinary startup", () => {
    expect(resolveOutdoorCalibration("")).toBe("luminance-v1");
    expect(resolveOutdoorCalibration("?skyAtmosphere=scattering-v1")).toBe(
      "luminance-v1",
    );
    for (const mode of ["luminance-v1", "rgb-irradiance-v1"] as const) {
      expect(resolveOutdoorCalibration("?outdoorCalibration=" + mode)).toBe(
        mode,
      );
      const owner = new OutdoorEnvironment(new THREE.Scene(), mode);
      expect(owner.getStatus().calibration).toBe(mode);
      expect(owner.getStatus().baseColorBytes).toBe(0);
      owner.dispose();
    }
    for (const search of [
      "?outdoorCalibration=",
      "?outdoorCalibration=rgb",
      "?outdoorCalibration=rgb-irradiance-v1&outdoorCalibration=rgb-irradiance-v1",
    ])
      expect(() => resolveOutdoorCalibration(search)).toThrow("calibration");
  });

  it.each(["gradient-v1", "scattering-v1"] as const)(
    "calibrates actual %s RGB irradiance at every cache phase with independent finer quadrature",
    (mode) => {
      const sky = new SkySystem(new World(), mode);
      const before = Object.values(sky.skyPaletteUniforms).map((u) =>
        u.value.toArray(),
      );
      const capture = sky.createLightingCapture();
      try {
        for (const phase of OUTDOOR_ENVIRONMENT_PHASES) {
          const baseline = calibrateOutdoorCapture(capture, phase);
          expect(baseline.skyColor).toEqual([1, 1, 1]);
          const result = calibrateOutdoorCapture(
            capture,
            phase,
            "rgb-irradiance-v1",
          );
          const expected = color(result.upwardIrradiance);
          const gain = color(result.skyColor).multiplyScalar(result.skyScale);
          expect(
            result.skyColor.every((c) => Number.isFinite(c) && c > 0),
          ).toBe(true);
          expect(result.groundRadiance).toEqual(baseline.groundRadiance);
          expect(result.upwardIrradiance).toEqual(baseline.upwardIrradiance);
          expectColorClose(
            integratedUp(capture, phase, 64, 128).multiply(gain),
            expected,
            10,
          );
          const refined = integratedUp(capture, phase, 128, 256).multiply(gain);
          for (const channel of ["r", "g", "b"] as const) {
            expect(
              Math.abs(refined[channel] / expected[channel] - 1),
            ).toBeLessThan(0.01);
          }
          capture.setPhase(
            phase,
            result.skyScale,
            result.groundRadiance,
            result.skyColor,
          );
        }
        expect(
          Object.values(sky.skyPaletteUniforms).map((u) => u.value.toArray()),
        ).toEqual(before);
      } finally {
        capture.dispose();
      }
    },
  );

  it("rejects a real sky with a missing RGB channel instead of fabricating radiance", () => {
    const sky = new SkySystem(new World(), "gradient-v1");
    for (const palette of Object.values(sky.skyPaletteUniforms))
      palette.value.r = 0;
    const capture = sky.createLightingCapture();
    try {
      expect(() => calibrateOutdoorCapture(capture, 0.5)).not.toThrow();
      expect(() =>
        calibrateOutdoorCapture(capture, 0.5, "rgb-irradiance-v1"),
      ).toThrow("every channel");
    } finally {
      capture.dispose();
    }
  });

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
    const foreign = uniform(new THREE.Color(0.3, 0.4, 0.5)).rgb;
    f.scene.environmentNode = foreign;
    f.scene.environmentIntensity = 7;
    f.owner.dispose();
    expect(f.scene.environmentNode).toBe(foreign);
    expect(f.scene.environmentIntensity).toBe(7);
  });
});

type NativeGrassEnvironmentProgram = {
  vertex: string;
  fragment: string;
  compilationErrors: string[];
};
type NativeGrassEnvironmentReceipt = {
  adapter: { vendor: string; architecture: string; description: string };
  nativeBackend: boolean;
  captureCount: number;
  errors: string[];
  orders: {
    candidateFirst: boolean;
    programs: {
      baseline: NativeGrassEnvironmentProgram;
      candidate: NativeGrassEnvironmentProgram;
      clone: NativeGrassEnvironmentProgram;
      baselineReturn: NativeGrassEnvironmentProgram;
    };
    cases: {
      phase: number;
      intensity: number;
      rotation: number;
      mirrorLike: boolean;
      maxError: number;
      meanError: number;
      changedChannels: number;
      alphaExact: boolean;
      coveredPixels: number;
      finite: boolean;
    }[];
    cloneMaxError: number;
    baselineReturnMaxError: number;
    environmentSignal: number;
    shadowSignal: number;
    phaseSignal: number;
    sharedMap: boolean;
    sharedDepth: boolean;
    stableOwners: boolean;
    cloneSharesNode: boolean;
  }[];
  cleanup: {
    resourcesCreated: number;
    resourcesDisposed: number;
    outdoorDisposed: boolean;
    outdoorBytes: number;
    sceneRestored: boolean;
    rendererDisposed: boolean;
    deviceDestroyed: boolean;
    errors: string[];
  };
};

// A finite native experiment, not a production optimization or FPS test. Both
// paths use the real OutdoorEnvironment capture/update lifecycle and the same
// initialized renderer. Only the candidate material's envNode differs. This
// intentionally has no approximate fallback, material override or relaxed
// assertion if the global Var fails to share the two stock isolate scopes.
const nativeGrassEnvironmentProbe = String.raw`
globalThis.grassEnvironmentProbe = async () => {
  if (!navigator.gpu || !isSecureContext) throw new Error('Native WebGPU required');
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
  if(!adapter || adapter.isFallbackAdapter || adapter.info.isFallbackAdapter ||
    /swiftshader|llvmpipe|software/i.test([adapter.info.vendor,adapter.info.architecture,adapter.info.description].join(' ')))
    throw new Error('Hardware WebGPU required');
  const device=await adapter.requestDevice();
  const errors=[],resources=[],cleanup={resourcesCreated:0,resourcesDisposed:0,outdoorDisposed:false,outdoorBytes:-1,
    sceneRestored:false,rendererDisposed:false,deviceDestroyed:false,errors:[]};
  const own=resource=>{resources.push(resource);cleanup.resourcesCreated++;return resource;};
  let active=true,renderer,outdoor,scene,priorEnvironment,priorIntensity;
  const onError=event=>errors.push(String(event.error.message));
  device.addEventListener('uncapturederror',onError);
  device.lost.then(info=>{if(active)errors.push('Device lost: '+info.message);});
  const difference=(a,b)=>{
    if(a.length!==b.length || !(a instanceof Float32Array) || !(b instanceof Float32Array))
      throw new Error('Actual linear RGBA32F readbacks required');
    let maxError=0,total=0,changedChannels=0,coveredPixels=0,finite=true,alphaExact=true;
    for(let i=0;i<a.length;i++) {
      finite &&= Number.isFinite(a[i]) && Number.isFinite(b[i]);
      const error=Math.abs(a[i]-b[i]);maxError=Math.max(maxError,error);total+=error;
      if(error!==0)changedChannels++;
      if(i%4===3){alphaExact &&= a[i]===b[i];if(a[i]>.5)coveredPixels++;}
    }
    return {maxError,meanError:total/a.length,changedChannels,alphaExact,coveredPixels,finite};
  };
  try {
    const canvas=document.querySelector('canvas');if(!canvas)throw new Error('Missing native canvas');
    renderer=new THREE.WebGPURenderer({canvas,device});await renderer.init();
    if(!renderer.backend.isWebGPUBackend || renderer.backend.device!==device)throw new Error('Wrong renderer owner');
    renderer.setPixelRatio(1);renderer.setSize(96,96,false);renderer.setClearColor(0,0);
    renderer.toneMapping=THREE.NoToneMapping;renderer.outputColorSpace=THREE.LinearSRGBColorSpace;
    renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
    const world=new World(),graphics=new ClientGraphics(world);
    // Attach the real initialized renderer to the real preparation-queue owner;
    // neither its queue nor the outdoor capture is substituted by a fixture.
    graphics.renderer=renderer;scene=world.stage.scene;
    priorEnvironment=scene.environmentNode;priorIntensity=scene.environmentIntensity;
    outdoor=new OutdoorEnvironment(scene,'rgb-irradiance-v1');
    const sky=new SkySystem(world,'scattering-v1');
    await outdoor.initialize(graphics,sky.createLightingCapture(),.56);
    const captureCount=outdoor.getStatus().capturesCompleted;
    if(!outdoor.ready || captureCount!==12 || !graphics.isPrecompileIdle())throw new Error('Actual outdoor capture incomplete');
    const source=scene.environmentNode;
    if(!source)throw new Error('Missing actual outdoor graph');
    const target=own(new THREE.RenderTarget(96,96,{type:THREE.FloatType,colorSpace:THREE.LinearSRGBColorSpace}));
    renderer.setRenderTarget(target);
    const camera=new THREE.PerspectiveCamera(48,1,.1,30);
    const light=new THREE.DirectionalLight(0xffeedd,1.7);light.castShadow=true;light.position.set(3,5,4);
    light.shadow.mapSize.set(128,128);light.shadow.bias=.0002;light.shadow.normalBias=.01;
    Object.assign(light.shadow.camera,{near:.1,far:20,left:-3,right:3,top:3,bottom:-3});
    light.shadow.camera.updateProjectionMatrix();scene.add(light,light.target);own(light.shadow);
    const geometry=own(new THREE.SphereGeometry(1,32,20));
    const casterGeometry=own(new THREE.BoxGeometry(.65,.8,.65)),casterMaterial=own(new THREE.MeshStandardNodeMaterial());
    const caster=new THREE.Mesh(casterGeometry,casterMaterial);caster.position.set(.25,1.25,.35);caster.castShadow=true;scene.add(caster);
    const orders=[];
    const draw=async receiver=>{
      await new Promise((resolve,reject)=>renderer.setAnimationLoop(()=>{
        renderer.setAnimationLoop(null);
        try {renderer.render(scene,camera);resolve();}catch(error){reject(error);}
      }));
      await device.queue.onSubmittedWorkDone();
      if(receiver.geometry!==geometry || !receiver.receiveShadow)throw new Error('Receiver geometry/shadow changed');
      return renderer.readRenderTargetPixelsAsync(target,0,0,96,96);
    };
    const program=async receiver=>{
      const emitted=await renderer.debug.getShaderAsync(scene,camera,receiver);
      if(!emitted.vertexShader || !emitted.fragmentShader)throw new Error('Missing actual material program');
      const compilationErrors=[];
      for(const code of [emitted.vertexShader,emitted.fragmentShader]){
        device.pushErrorScope('validation');
        let module,scope;
        try {module=device.createShaderModule({code});}finally{scope=device.popErrorScope();}
        const [info,error]=await Promise.all([module.getCompilationInfo(),scope]);
        compilationErrors.push(...[...info.messages].filter(m=>m.type==='error').map(m=>m.message));
        if(error)compilationErrors.push(error.message);
      }
      return {vertex:emitted.vertexShader,fragment:emitted.fragmentShader,compilationErrors};
    };
    for(const candidateFirst of [false,true]){
      const baseline=own(new THREE.MeshSSSNodeMaterial({color:0x729b45,roughness:1,metalness:0,side:THREE.DoubleSide}));
      baseline.thicknessColorNode=vec3(.12,.18,.04);baseline.thicknessDistortionNode=float(.1);
      baseline.thicknessAmbientNode=float(.5);baseline.thicknessAttenuationNode=float(.8);
      baseline.thicknessPowerNode=float(2);baseline.thicknessScaleNode=float(1);
      const candidate=own(baseline.clone());
      candidate.envNode=source.context({getUV:()=>normalWorld,getTextureLevel:()=>float(1)}).toVar('grassMaxRoughnessEnvironment');
      const clone=own(candidate.clone());
      const receiver=new THREE.Mesh(geometry,baseline);receiver.receiveShadow=true;scene.add(receiver);
      camera.position.set(3,2.5,4);camera.lookAt(0,0,0);scene.environmentRotation.set(0,0,0);scene.environmentIntensity=1;outdoor.update(.56);
      const programs={};
      for(const key of candidateFirst?['candidate','baseline']:['baseline','candidate']){
        receiver.material=key==='baseline'?baseline:candidate;programs[key]=await program(receiver);
      }
      receiver.material=clone;programs.clone=await program(receiver);
      receiver.material=baseline;programs.baselineReturn=await program(receiver);
      const map=light.shadow.map,depth=map?.depthTexture,versions=[baseline.version,candidate.version,clone.version];
      if(!map || !depth)throw new Error('Missing actual shadow map');
      let sharedMap=true,sharedDepth=true,stableOwners=true;
      const snapshots=[];
      const cases=[];
      for(const [phase,intensity,rotation,mirrorLike] of [[.21,.65,0,false],[.27,1,.71,false],[.56,1.35,-.43,false],[.74,.9,1.2,true]]){
        outdoor.update(phase);scene.environmentIntensity=intensity;scene.environmentRotation.set(.13,rotation,-.07);
        camera.position.set(mirrorLike?-3:3,mirrorLike?-2.5:2.5,mirrorLike?-4:4);camera.lookAt(0,0,0);
        receiver.material=baseline;const a=await draw(receiver);receiver.material=candidate;const b=await draw(receiver);
        cases.push({phase,intensity,rotation,mirrorLike,...difference(a,b)});snapshots.push(a);
        sharedMap &&= light.shadow.map===map;sharedDepth &&= light.shadow.map.depthTexture===depth;
        stableOwners &&= scene.environmentNode===source && receiver.geometry===geometry &&
          baseline.roughness===1 && candidate.roughness===1 && baseline.envNode===null && baseline.envMap===null && candidate.envMap===null &&
          versions.every((v,i)=>v===[baseline,candidate,clone][i].version);
      }
      receiver.material=candidate;const candidatePixels=await draw(receiver);
      receiver.material=clone;const clonePixels=await draw(receiver);
      receiver.material=baseline;const returned=await draw(receiver);
      const baselineReturnMaxError=difference(snapshots.at(-1),returned).maxError;
      // Sensitivity checks each change one control at a fixed above-ground view.
      camera.position.set(3,2.5,4);camera.lookAt(0,0,0);scene.environmentRotation.set(0,0,0);
      outdoor.update(.56);scene.environmentIntensity=1;
      const diagnostic=await draw(receiver);
      scene.environmentIntensity=0;const noEnvironment=await draw(receiver);scene.environmentIntensity=1;
      light.shadow.intensity=0;const noShadow=await draw(receiver);light.shadow.intensity=1;
      outdoor.update(.21);const otherPhase=await draw(receiver);
      orders.push({candidateFirst,programs,cases,cloneMaxError:difference(candidatePixels,clonePixels).maxError,
        baselineReturnMaxError,environmentSignal:difference(diagnostic,noEnvironment).maxError,
        shadowSignal:difference(diagnostic,noShadow).maxError,phaseSignal:difference(diagnostic,otherPhase).maxError,
        sharedMap,sharedDepth,stableOwners,cloneSharesNode:clone.envNode===candidate.envNode});
      scene.remove(receiver);
    }
    await device.queue.onSubmittedWorkDone();
    return {adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,description:adapter.info.description},
      nativeBackend:renderer.backend.isWebGPUBackend,captureCount,orders,errors,cleanup};
  }finally{
    const retire=operation=>{try{operation();}catch(error){cleanup.errors.push(String(error));}};
    retire(()=>renderer?.setAnimationLoop(null));retire(()=>renderer?.setRenderTarget(null));
    retire(()=>{outdoor?.dispose();cleanup.outdoorDisposed=outdoor?.getStatus().state==='disposed';
      cleanup.outdoorBytes=outdoor?.getStatus().baseColorBytes??0;
      cleanup.sceneRestored=!!scene && scene.environmentNode===priorEnvironment && scene.environmentIntensity===priorIntensity;});
    for(const resource of resources)retire(()=>{resource.dispose();cleanup.resourcesDisposed++;});
    retire(()=>{renderer?.dispose();cleanup.rendererDisposed=!!renderer;});
    active=false;device.removeEventListener('uncapturederror',onError);
    retire(()=>{device.destroy();cleanup.deviceDestroyed=true;});
  }
};`;

it.skipIf(process.env.HYPERIA_NATIVE_GRASS_ENVIRONMENT !== "1")(
  "native max-roughness environment sharing removes duplicate samples with bounded linear pixel error",
  async () => {
    let browser: Browser | undefined;
    let server: Server | undefined;
    const errors: string[] = [];
    try {
      const path = (relative: string) =>
        JSON.stringify(fileURLToPath(new URL(relative, import.meta.url)));
      const entry = await build({
        stdin: {
          contents: `import THREE,{float,vec3,normalWorld} from ${path("../../../../extras/three/three.ts")};
import {World} from ${path("../../../../core/World.ts")};
import {ClientGraphics} from ${path("../../../client/ClientGraphics.ts")};
import {OutdoorEnvironment} from ${path("../OutdoorEnvironment.ts")};
import {SkySystem} from ${path("../SkySystem.ts")};
${nativeGrassEnvironmentProbe}`,
          resolveDir: fileURLToPath(new URL(".", import.meta.url)),
          loader: "js",
        },
        bundle: true,
        write: false,
        metafile: true,
        platform: "browser",
        // PhysX retains a Node-only fs require behind its environment guard.
        // Leave it external, not replaced: executing that branch in this real
        // browser is an error. No physics module is initialized by this proof.
        external: ["fs"],
        // A browser entry has no server environment. This compile-time empty
        // configuration does not create a process shim or enable PhysX's Node
        // branch, and never embeds the host environment in the served bundle.
        define: { "process.env": "{}" },
        format: "esm",
        target: "es2022",
        minify: false,
        keepNames: true,
      });
      expect(entry.outputFiles).toHaveLength(1);
      const inputs = Object.keys(entry.metafile.inputs);
      expect(
        inputs.filter((p) => /__tests__|vitest|playwright|node:/.test(p)),
      ).toEqual([]);
      for (const name of [
        "OutdoorEnvironment.ts",
        "SkySystem.ts",
        "ClientGraphics.ts",
        "World.ts",
      ])
        expect(inputs.some((p) => p.endsWith("/" + name))).toBe(true);
      expect(
        inputs.filter((p) => p.endsWith("/build/three.webgpu.js")),
      ).toHaveLength(1);
      server = createServer((request, response) => {
        response.setHeader("Cache-Control", "no-store");
        if (request.url === "/") {
          response.setHeader("Content-Type", "text/html");
          response.end(
            '<!doctype html><title>Hyperia native grass environment qualification</title><canvas></canvas><script type="module" src="/entry.js"></script>',
          );
        } else if (request.url === "/entry.js") {
          response.setHeader("Content-Type", "text/javascript");
          response.end(entry.outputFiles[0].contents);
        } else if (request.url === "/favicon.ico")
          response.writeHead(204).end();
        else {
          errors.push(`Unexpected request ${request.url}`);
          response.writeHead(404).end();
        }
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => {
          server!.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing private port");
      const { chromium } = await import("playwright");
      browser = await chromium.launch({
        channel: "chrome",
        headless: false,
        timeout: 20_000,
        args: ["--use-angle=metal", "--enable-features=WebGPU,UnsafeWebGPU"],
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(20_000);
      page.on("pageerror", (error) => {
        errors.push(error.message);
        process.stdout.write(
          `Native grass environment page error: ${error.stack ?? error.message}\n`,
        );
      });
      const origin = `http://127.0.0.1:${address.port}`;
      await page.route("**/*", (route) => {
        if (new URL(route.request().url()).origin === origin)
          return route.continue();
        errors.push("Unexpected nonlocal request");
        return route.abort();
      });
      await page.goto(origin, { waitUntil: "load" });
      await page
        .waitForFunction(
          () =>
            typeof Reflect.get(globalThis, "grassEnvironmentProbe") ===
            "function",
        )
        .catch((error: unknown) => {
          throw new AggregateError(
            [error, ...errors],
            "Native grass environment entry did not initialize",
          );
        });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const receipt = await Promise.race([
        page.evaluate(async () => {
          const actual = window as unknown as Window & {
            grassEnvironmentProbe(): Promise<NativeGrassEnvironmentReceipt>;
          };
          return actual.grassEnvironmentProbe();
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error("Native grass environment proof exceeded 60 seconds"),
              ),
            60_000,
          );
        }),
      ]).finally(() => clearTimeout(timeout));
      const samples = (source: string) =>
        [...source.matchAll(/\btextureSampleGrad\s*\(/g)].length;
      const sha = (source: string) =>
        createHash("sha256").update(source).digest("hex");
      process.stdout.write(
        `Native grass environment proof (not game pixels or performance acceptance): ${JSON.stringify(
          {
            ...receipt,
            orders: receipt.orders.map(({ programs, ...row }) => ({
              ...row,
              programs: Object.fromEntries(
                Object.entries(programs).map(([key, value]) => [
                  key,
                  {
                    vertexSha256: sha(value.vertex),
                    fragmentSha256: sha(value.fragment),
                    sampleSites: samples(value.fragment),
                    sharedInitializations: [
                      ...value.fragment.matchAll(
                        /grassMaxRoughnessEnvironment\s*=/g,
                      ),
                    ].length,
                    compilationErrors: value.compilationErrors,
                  },
                ]),
              ),
            })),
          },
        )}\n`,
      );
      expect(errors).toEqual([]);
      expect(receipt.errors).toEqual([]);
      expect(receipt.nativeBackend).toBe(true);
      expect(receipt.captureCount).toBe(12);
      expect(receipt.orders).toHaveLength(2);
      for (const row of receipt.orders) {
        expect(row.cases).toHaveLength(4);
        for (const pixels of row.cases) {
          expect(pixels.finite).toBe(true);
          expect(pixels.alphaExact).toBe(true);
          expect(pixels.coveredPixels).toBeGreaterThan(500);
          // Fixed before the first run: linear RGBA32F, not a screenshot/image
          // quantization tolerance. Do not increase this on candidate failure.
          expect(pixels.maxError).toBeLessThanOrEqual(0.00002);
        }
        expect(row.cloneMaxError).toBe(0);
        expect(row.baselineReturnMaxError).toBe(0);
        expect(row.environmentSignal).toBeGreaterThan(0.001);
        expect(row.shadowSignal).toBeGreaterThan(0.001);
        expect(row.phaseSignal).toBeGreaterThan(0.001);
        expect(row.sharedMap).toBe(true);
        expect(row.sharedDepth).toBe(true);
        expect(row.stableOwners).toBe(true);
        expect(row.cloneSharesNode).toBe(true);
        for (const [key, program] of Object.entries(row.programs)) {
          expect(program.compilationErrors).toEqual([]);
          expect(samples(program.fragment)).toBe(
            key === "candidate" || key === "clone" ? 4 : 8,
          );
          if (key === "candidate" || key === "clone")
            expect([
              ...program.fragment.matchAll(/grassMaxRoughnessEnvironment\s*=/g),
            ]).toHaveLength(1);
        }
        expect(row.programs.baselineReturn.fragment).toBe(
          row.programs.baseline.fragment,
        );
      }
      expect(receipt.cleanup.errors).toEqual([]);
      expect(receipt.cleanup.resourcesDisposed).toBe(
        receipt.cleanup.resourcesCreated,
      );
      expect(receipt.cleanup.outdoorDisposed).toBe(true);
      expect(receipt.cleanup.outdoorBytes).toBe(0);
      expect(receipt.cleanup.sceneRestored).toBe(true);
      expect(receipt.cleanup.rendererDisposed).toBe(true);
      expect(receipt.cleanup.deviceDestroyed).toBe(true);
    } finally {
      try {
        await browser?.close();
      } finally {
        if (server?.listening)
          await new Promise<void>((resolve, reject) => {
            server!.close((error) => (error ? reject(error) : resolve()));
            server!.closeAllConnections();
          });
      }
    }
  },
  120_000,
);
