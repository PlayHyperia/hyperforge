import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Browser } from "playwright";
import { describe, expect, it } from "vitest";
import THREE, { uniform } from "../three";
import { ShadowNode } from "three/webgpu";
import {
  UniformDirectionalShadowNode,
  isOwnedUniformDirectionalShadowNode,
} from "../UniformDirectionalShadow";

describe("explicit uniform-frustum single-map shadow owner", () => {
  it("does not attach or change light/shadow settings and inherits the actual resource lifecycle", () => {
    const light = new THREE.DirectionalLight(0xffeedd, 1.7);
    const before = light.toJSON();
    const node = new UniformDirectionalShadowNode(light);
    expect(light.toJSON()).toEqual(before);
    expect(light.shadow.shadowNode).toBeUndefined();
    expect(node).toBeInstanceOf(ShadowNode);
    expect(node.light).toBe(light);
    expect(node.shadow).toBe(light.shadow);
    expect(node.dispose).toBe(ShadowNode.prototype.dispose);
    expect(isOwnedUniformDirectionalShadowNode(node, light)).toBe(true);
    node.dispose();
    // Three can reset/rebuild a shadow node when castShadow changes; ownership
    // does not disappear merely because the inherited resources were disposed.
    expect(isOwnedUniformDirectionalShadowNode(node, light)).toBe(true);
    node.dispose();
  });

  it("rejects unrelated nodes, copied brands, subclasses and changed owners", () => {
    const light = new THREE.DirectionalLight();
    const other = new THREE.DirectionalLight();
    const node = new UniformDirectionalShadowNode(light);
    class UnqualifiedSubclass extends UniformDirectionalShadowNode {}
    const subclass = new UnqualifiedSubclass(light);
    const plain = new ShadowNode(light, light.shadow);
    for (const value of [undefined, null, uniform(1), plain, subclass, {}])
      expect(isOwnedUniformDirectionalShadowNode(value, light)).toBe(false);
    expect(isOwnedUniformDirectionalShadowNode(node, other)).toBe(false);
    node.light = other;
    expect(isOwnedUniformDirectionalShadowNode(node, light)).toBe(false);
    node.light = light;
    const shadow = light.shadow;
    light.shadow = other.shadow;
    expect(isOwnedUniformDirectionalShadowNode(node, light)).toBe(false);
    light.shadow = shadow;
    expect(isOwnedUniformDirectionalShadowNode(node, light)).toBe(true);
    node.dispose();
    plain.dispose();
    subclass.dispose();
  });
});

type StageReceipt = {
  original: string;
  strict: string;
  inserted: boolean;
  messages: { type: string; message: string; lineNum: number }[];
  validationError: string | null;
};
type NativeReceipt = {
  adapter: { vendor: string; architecture: string; description: string };
  nativeBackend: boolean;
  errors: string[];
  baseline: { vertex: StageReceipt; fragment: StageReceipt };
  candidate: { vertex: StageReceipt; fragment: StageReceipt };
  settingsUnchanged: boolean;
};

// The original full programs come from Three's initialized native renderer and
// real receiveShadow mesh. Only COPIES have derivative diagnostics made strict.
// This is shader qualification, not a game screenshot or performance approval.
const nativeProbe = String.raw`
globalThis.shadowWgslProbe = async () => {
  if (!navigator.gpu || !isSecureContext) throw new Error("Native WebGPU required");
  const adapter = await navigator.gpu.requestAdapter({powerPreference:"high-performance"});
  if (!adapter || adapter.isFallbackAdapter || adapter.info.isFallbackAdapter ||
      /swiftshader|llvmpipe|software/i.test([adapter.info.vendor,adapter.info.architecture,adapter.info.description].join(" ")))
    throw new Error("Hardware WebGPU required");
  const device = await adapter.requestDevice();
  let renderer, active = true;
  const errors = [], resources = [];
  const onError = event => errors.push(String(event.error.message));
  device.addEventListener("uncapturederror",onError);
  device.lost.then(info => {if(active) errors.push("Device lost: " + info.message);});
  const strict = async (stage,original) => {
    const directives = [...original.matchAll(/diagnostic\s*\([^;]*derivative_uniformity[^;]*\)\s*;/g)];
    const off = "diagnostic( off, derivative_uniformity );";
    const on = "diagnostic( error, derivative_uniformity );";
    let code, inserted = false;
    if (directives.length === 1 && directives[0][0] === off)
      code = original.slice(0,directives[0].index) + on + original.slice(directives[0].index + off.length);
    else if (stage === "vertex" && directives.length === 0) {code = on + "\n" + original; inserted = true;}
    else throw new Error("Unexpected native derivative diagnostic in " + stage);
    device.pushErrorScope("validation");
    let module, validationPromise;
    try {module = device.createShaderModule({label:"strict shadow " + stage,code});}
    finally {validationPromise = device.popErrorScope();}
    const [info,validation] = await Promise.all([module.getCompilationInfo(),validationPromise]);
    return {original,strict:code,inserted,messages:[...info.messages].map(m=>({type:m.type,message:m.message,lineNum:m.lineNum})),
      validationError:validation?.message ?? null};
  };
  try {
    const canvas = document.querySelector("canvas");
    if (!canvas) throw new Error("Missing actual canvas");
    renderer = new THREE.WebGPURenderer({canvas,device});
    await renderer.init();
    if (!renderer.backend.isWebGPUBackend || renderer.backend.device !== device) throw new Error("Wrong native renderer owner");
    renderer.setPixelRatio(1);renderer.setSize(128,128,false);
    renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
    let settingsUnchanged = true;
    const generate = async candidate => {
      const scene=new THREE.Scene(), camera=new THREE.PerspectiveCamera(50,1,.1,30);
      camera.position.set(4,4,6);camera.lookAt(0,0,0);
      const light=new THREE.DirectionalLight(0xffeedd,1.7);
      light.castShadow=true;light.position.set(4,6,4);
      light.shadow.mapSize.set(64,64);light.shadow.bias=.0002;light.shadow.normalBias=.01;light.shadow.radius=1;
      Object.assign(light.shadow.camera,{near:.1,far:20,left:-3,right:3,top:3,bottom:-3});
      light.shadow.camera.updateProjectionMatrix();scene.add(light,light.target);
      if(candidate) {const node=new UniformDirectionalShadowNode(light);light.shadow.shadowNode=node;resources.push(node);}
      const geometry=new THREE.PlaneGeometry(12,12), material=new THREE.MeshStandardNodeMaterial({color:0x99aa88,roughness:.9});
      const soil={albedo:vec3(.25,.21,.13),roughness:float(.9),ao:float(.8),
        worldNormal:createCompactProjectedNormal(vec3(.61,.43,.96),positionWorld.xz.mul(.7),float(.6))};
      const rock={albedo:vec3(.38,.37,.34),roughness:float(.8),ao:float(.9),
        worldNormal:createCompactProjectedNormal(vec3(.42,.58,.98),positionWorld.xz.mul(1.3),float(.5))};
      const bank=applyCompactPondBankMaterials(soil,rock,{
        mineralAppearance:positionWorld.x.sin().mul(.5).add(.5),
        siltAppearance:positionWorld.z.cos().mul(.5).add(.5),
      });
      material.colorNode=bank.soil.albedo.add(bank.rock.albedo).mul(.5);
      material.normalNode=compactTerrainNormalToView(bank.soil.worldNormal.add(bank.rock.worldNormal).normalize());
      material.roughnessNode=bank.soil.roughness;material.aoNode=bank.soil.ao;
      resources.push(geometry,material,light.shadow);
      const receiver=new THREE.Mesh(geometry,material);receiver.rotation.x=-Math.PI/2;receiver.receiveShadow=true;scene.add(receiver);
      const casterGeometry=new THREE.BoxGeometry(1,2,1), casterMaterial=new THREE.MeshStandardNodeMaterial();
      resources.push(casterGeometry,casterMaterial);
      const caster=new THREE.Mesh(casterGeometry,casterMaterial);caster.position.y=1;caster.castShadow=true;scene.add(caster);
      const snapshot=()=>JSON.stringify({color:light.color.toArray(),intensity:light.intensity,position:light.position.toArray(),target:light.target.position.toArray(),
        mapSize:light.shadow.mapSize.toArray(),bias:light.shadow.bias,normalBias:light.shadow.normalBias,radius:light.shadow.radius,
        camera:[light.shadow.camera.near,light.shadow.camera.far,light.shadow.camera.left,light.shadow.camera.right,light.shadow.camera.top,light.shadow.camera.bottom]});
      const before=snapshot();
      const actual=await renderer.debug.getShaderAsync(scene,camera,receiver);
      if(!actual.fragmentShader || !actual.vertexShader)throw new Error("Actual submitted material shaders missing");
      settingsUnchanged &&= before===snapshot();
      return {vertex:await strict("vertex",actual.vertexShader),fragment:await strict("fragment",actual.fragmentShader)};
    };
    const baseline=await generate(false), candidate=await generate(true);
    return {adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,description:adapter.info.description},
      nativeBackend:renderer.backend.isWebGPUBackend,baseline,candidate,settingsUnchanged,errors};
  } finally {
    try {for(const resource of resources)resource.dispose();renderer?.dispose();}
    finally {active=false;device.removeEventListener("uncapturederror",onError);device.destroy();}
  }
};`;

it.skipIf(process.env.HYPERIA_NATIVE_SHADOW_WGSL !== "1")(
  "native PCF keeps five comparisons and passes strict full-program derivative checks with uniform frustum selection",
  async () => {
    let browser: Browser | undefined;
    let server: Server | undefined;
    const errors: string[] = [];
    try {
      const entry = await build({
        stdin: {
          contents: `import THREE,{float,vec3,positionWorld} from ${JSON.stringify(fileURLToPath(new URL("../three.ts", import.meta.url)))};
import {UniformDirectionalShadowNode} from ${JSON.stringify(fileURLToPath(new URL("../UniformDirectionalShadow.ts", import.meta.url)))};
import {applyCompactPondBankMaterials,createCompactProjectedNormal,compactTerrainNormalToView} from ${JSON.stringify(fileURLToPath(new URL("../../../systems/shared/world/CompactTerrainMaterial.ts", import.meta.url)))};
${nativeProbe}`,
          resolveDir: fileURLToPath(new URL(".", import.meta.url)),
          loader: "js",
        },
        bundle: true,
        write: false,
        metafile: true,
        platform: "browser",
        format: "esm",
        target: "es2022",
        minify: false,
        keepNames: true,
      });
      expect(entry.outputFiles).toHaveLength(1);
      expect(
        Object.keys(entry.metafile.inputs).filter((path) =>
          /__tests__|vitest|playwright|node:/.test(path),
        ),
      ).toEqual([]);
      expect(
        Object.keys(entry.metafile.inputs).some((path) =>
          path.endsWith("UniformDirectionalShadow.ts"),
        ),
      ).toBe(true);
      expect(
        Object.keys(entry.metafile.inputs).some((path) =>
          path.endsWith("CompactTerrainMaterial.ts"),
        ),
      ).toBe(true);
      server = createServer((request, response) => {
        response.setHeader("Cache-Control", "no-store");
        if (request.url === "/") {
          response.setHeader("Content-Type", "text/html");
          response.end(
            '<!doctype html><title>Hyperia native shadow qualification</title><canvas></canvas><script type="module" src="/entry.js"></script>',
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
      page.on("pageerror", (error) => errors.push(error.message));
      const origin = `http://127.0.0.1:${address.port}`;
      await page.route("**/*", (route) => {
        if (new URL(route.request().url()).origin === origin)
          return route.continue();
        errors.push("Unexpected nonlocal request");
        return route.abort();
      });
      await page.goto(origin, { waitUntil: "load" });
      await page.waitForFunction(
        () => typeof Reflect.get(globalThis, "shadowWgslProbe") === "function",
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const receipt = await Promise.race([
        page.evaluate(async () => {
          const actual = window as unknown as Window & {
            shadowWgslProbe(): Promise<NativeReceipt>;
          };
          return actual.shadowWgslProbe();
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error("Native shadow qualification exceeded 45 seconds"),
              ),
            45_000,
          );
        }),
      ]).finally(() => clearTimeout(timeout));
      const sha = (code: string) =>
        createHash("sha256").update(code).digest("hex");
      process.stdout.write(
        `Native shadow shader qualification (not visual/performance approval): ${JSON.stringify(
          {
            adapter: receipt.adapter,
            settingsUnchanged: receipt.settingsUnchanged,
            programs: Object.fromEntries(
              ["baseline", "candidate"].map((key) => {
                const programs = receipt[key as "baseline" | "candidate"];
                return [
                  key,
                  Object.fromEntries(
                    ["vertex", "fragment"].map((stage) => {
                      const row = programs[stage as "vertex" | "fragment"];
                      return [
                        stage,
                        {
                          sha256: sha(row.original),
                          strictSha256: sha(row.strict),
                          messages: row.messages,
                          validationError: row.validationError,
                        },
                      ];
                    }),
                  ),
                ];
              }),
            ),
          },
        )}\n`,
      );
      expect(errors).toEqual([]);
      expect(receipt.errors).toEqual([]);
      expect(receipt.nativeBackend).toBe(true);
      expect(receipt.settingsUnchanged).toBe(true);
      for (const programs of [receipt.baseline, receipt.candidate]) {
        expect([
          ...programs.fragment.original.matchAll(
            /\btextureSampleCompare\s*\(/g,
          ),
        ]).toHaveLength(5);
        for (const stage of ["vertex", "fragment"] as const) {
          const row = programs[stage];
          expect(row.strict).toBe(
            row.inserted
              ? `diagnostic( error, derivative_uniformity );\n${row.original}`
              : row.original.replace(
                  "diagnostic( off, derivative_uniformity );",
                  "diagnostic( error, derivative_uniformity );",
                ),
          );
        }
        expect(
          programs.vertex.messages.filter(
            (message) => message.type === "error",
          ),
        ).toEqual([]);
        expect(programs.vertex.validationError).toBeNull();
      }
      expect(
        receipt.baseline.fragment.messages.some(
          (message) =>
            message.type === "error" &&
            /textureSampleCompare|uniform control flow/.test(message.message),
        ),
      ).toBe(true);
      expect(
        receipt.candidate.fragment.messages.filter(
          (message) => message.type === "error",
        ),
      ).toEqual([]);
      expect(receipt.candidate.fragment.validationError).toBeNull();
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
  90_000,
);
