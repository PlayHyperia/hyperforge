import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Browser } from "playwright";
import { describe, expect, it } from "vitest";
import THREE, { uniform } from "../three";
import { ShadowNode } from "three/webgpu";
import { context } from "three/tsl";
import {
  GrassShadowFilterContext,
  UniformDirectionalShadowNode,
  isOwnedUniformDirectionalShadowNode,
} from "../UniformDirectionalShadow";

// Public r186 runtime method missing from the installed declarations.
const contextValues = (node: ReturnType<typeof context>) =>
  (
    node as ReturnType<typeof context> & {
      getFlowContextData(): Record<string, unknown>;
    }
  ).getFlowContextData();

describe("explicit uniform-frustum single-map shadow owner", () => {
  it("makes the opt-in cache-visible, preserves parent context, and intentionally shares controls with clones", () => {
    const source = new THREE.MeshStandardNodeMaterial();
    const originalKey = source.customProgramCacheKey();
    const parent = context({ grassTestContext: "preserved" });
    const first = new GrassShadowFilterContext(parent);
    const second = new GrassShadowFilterContext();
    expect(first.drawMode.value).toBe(0);
    expect(first.drawMode.isUniformNode).toBe(true);
    expect(first.drawMode).not.toBe(second.drawMode);
    expect(contextValues(first.contextNode)).toEqual({
      grassTestContext: "preserved",
    });
    expect(contextValues(parent)).toEqual({
      grassTestContext: "preserved",
    });
    expect(source.contextNode).toBeNull();
    const marked = source.clone();
    marked.contextNode = first.contextNode;
    const clone = marked.clone();
    const other = source.clone();
    other.contextNode = second.contextNode;
    expect(clone.contextNode).toBe(first.contextNode);
    expect(clone.customProgramCacheKey()).toBe(marked.customProgramCacheKey());
    expect(marked.customProgramCacheKey()).not.toBe(originalKey);
    expect(other.customProgramCacheKey()).not.toBe(
      marked.customProgramCacheKey(),
    );
    const markedKey = marked.customProgramCacheKey();
    const version = marked.version;
    first.drawMode.value = 1;
    first.primaryCameraPosition.value.set(10, 20, 30);
    expect(second.drawMode.value).toBe(0);
    expect(second.primaryCameraPosition.value.toArray()).toEqual([0, 0, 0]);
    expect(marked.customProgramCacheKey()).toBe(markedKey);
    expect(marked.version).toBe(version);
    for (const material of [source, marked, clone, other]) material.dispose();
  });

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
  receiverLod: {
    markedFirst: boolean;
    programs: Record<
      "plain" | "marked" | "clone" | "independent" | "plainReturn",
      {
        vertex: StageReceipt;
        fragment: StageReceipt;
      }
    >;
    sharedMap: boolean;
    sharedDepth: boolean;
    contextCloned: boolean;
    distinctKeys: boolean;
    stableVersions: boolean;
    nearParity: boolean;
    transitionNearParity: boolean;
    transitionFarParity: boolean;
    shadowChangesPixels: boolean;
    cloneParity: boolean;
    independentControls: boolean;
    nearFarDiffer: boolean;
    transitionInterior: boolean;
    shadowPasses: number[];
  }[];
  fallback: {
    kind: "basic" | "custom";
    programs: { vertex: StageReceipt; fragment: StageReceipt }[];
    pixelParity: boolean;
    sharedMap: boolean;
  }[];
  sharedDraws: {
    forwardParity: boolean;
    reverseParity: boolean;
    leftDistinguishesModes: boolean;
    rightDistinguishesModes: boolean;
    updates: number[][];
  };
};

function shadowCompareCount(source: string) {
  return [...source.matchAll(/\btextureSampleCompare\s*\(/g)].length;
}

// Inspect complete emitted programs, not a source-level assumption that TSL
// preserves lazy control flow. All comparisons must live in these three arms.
function receiverBranchCounts(source: string) {
  const readBody = (brace: number) => {
    let depth = 1;
    for (let index = brace + 1; index < source.length; index++) {
      if (source[index] === "{") depth++;
      else if (source[index] === "}" && --depth === 0)
        return { body: source.slice(brace + 1, index), end: index + 1 };
    }
    throw new Error("Unterminated actual shadow branch");
  };
  const findMode = (mode: number) => {
    const match = new RegExp(
      `if\\s*\\([^{}]*f32\\(\\s*object\\.grassShadowDrawMode\\s*\\)\\s*==\\s*${mode}\\.0[^{}]*\\)\\s*\\{`,
    ).exec(source);
    if (!match)
      throw new Error(
        `Missing actual uniform shadow branch ${mode}: ${source}`,
      );
    return readBody(match.index + match[0].lastIndexOf("{"));
  };
  const far = findMode(1);
  const transition = findMode(2);
  const remainder = source.slice(transition.end);
  const near = /^\s*else\s*\{/.exec(remainder);
  if (!near) throw new Error("Missing original-PCF fallback branch");
  return {
    far: shadowCompareCount(far.body),
    transition: shadowCompareCount(transition.body),
    near: shadowCompareCount(
      readBody(transition.end + near[0].lastIndexOf("{")).body,
    ),
    total: shadowCompareCount(source),
  };
}

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
    const receiverLod=[];
    // Each ordering must share ONE cold light/node across all receivers: using
    // separate owners for marked/unmarked materials misses first-build leaks.
    for(const markedFirst of [false,true]) {
      const scene=new THREE.Scene(), camera=new THREE.PerspectiveCamera(50,1,.1,30);
      camera.position.set(4,4,6);camera.lookAt(0,0,0);
      const light=new THREE.DirectionalLight(0xffeedd,1.7);
      light.castShadow=true;light.position.set(4,6,4);
      light.shadow.mapSize.set(64,64);light.shadow.bias=.0002;light.shadow.normalBias=.01;light.shadow.radius=1;
      Object.assign(light.shadow.camera,{near:.1,far:20,left:-3,right:3,top:3,bottom:-3});
      light.shadow.camera.updateProjectionMatrix();scene.add(light,light.target);
      const owner=new UniformDirectionalShadowNode(light);light.shadow.shadowNode=owner;
      const control=new GrassShadowFilterContext(),independentControl=new GrassShadowFilterContext();
      const geometry=new THREE.PlaneGeometry(12,12), plainMaterial=new THREE.MeshStandardNodeMaterial({color:0x99aa88,roughness:.9});
      const markedMaterial=plainMaterial.clone();markedMaterial.contextNode=control.contextNode;
      const cloneMaterial=markedMaterial.clone();
      const independentMaterial=plainMaterial.clone();independentMaterial.contextNode=independentControl.contextNode;
      const receivers=[plainMaterial,markedMaterial,cloneMaterial,independentMaterial].map(material=>{
        const mesh=new THREE.Mesh(geometry,material);mesh.rotation.x=-Math.PI/2;mesh.receiveShadow=true;scene.add(mesh);return mesh;
      });
      const casterGeometry=new THREE.BoxGeometry(1,2,1),casterMaterial=new THREE.MeshStandardNodeMaterial();
      const caster=new THREE.Mesh(casterGeometry,casterMaterial);caster.position.y=1;caster.castShadow=true;scene.add(caster);
      const target=new THREE.RenderTarget(64,64);
      resources.push(owner,light.shadow,geometry,plainMaterial,markedMaterial,cloneMaterial,independentMaterial,casterGeometry,casterMaterial,target);
      renderer.setRenderTarget(target);
      const select=index=>{receivers.forEach((mesh,i)=>mesh.visible=i===index);return receivers[index];};
      const getProgram=async index=>{
        const actual=await renderer.debug.getShaderAsync(scene,camera,select(index));
        return {vertex:await strict('vertex',actual.vertexShader),fragment:await strict('fragment',actual.fragmentShader)};
      };
      const first=await getProgram(markedFirst?1:0);
      const map=light.shadow.map,depth=map.depthTexture;
      const second=await getProgram(markedFirst?0:1);
      const programs={plain:markedFirst?second:first,marked:markedFirst?first:second,clone:await getProgram(2),independent:await getProgram(3),plainReturn:await getProgram(0)};
      const versions=[plainMaterial.version,markedMaterial.version,cloneMaterial.version];
      const shadowPasses=[];
      let passCount=0, sharedMap=true,sharedDepth=true;
      scene.onBeforeRender=(_renderer,_scene,view)=>{if(view===light.shadow.camera)passCount++;};
      const pixels=async (index,mode)=>{
        select(index);control.drawMode.value=mode;passCount=0;
        // Let Three advance a real browser frame. Repeated synchronous render()
        // calls share its frame ID and intentionally reuse the first shadow map.
        await new Promise((resolve,reject)=>renderer.setAnimationLoop(()=>{
          renderer.setAnimationLoop(null);
          try {renderer.render(scene,camera);resolve();} catch(error) {reject(error);}
        }));
        await device.queue.onSubmittedWorkDone();
        shadowPasses.push(passCount);
        sharedMap &&= light.shadow.map===map && owner.shadowMap===map;
        sharedDepth &&= light.shadow.map.depthTexture===depth;
        return Array.from(await renderer.readRenderTargetPixelsAsync(target,0,0,64,64));
      };
      const equal=(a,b)=>a.length===b.length && a.every((v,i)=>v===b[i]);
      const plainPixels=await pixels(0,0),nearPixels=await pixels(1,0),farPixels=await pixels(1,1);
      const cloneFar=await pixels(2,1),independentNear=await pixels(3,1);
      independentControl.drawMode.value=1;
      const independentFar=await pixels(3,0),firstStillNear=await pixels(1,0);
      control.transitionStart.value=0;control.transitionEnd.value=4;
      const transitionInterior=await pixels(1,2);
      control.transitionStart.value=100;control.transitionEnd.value=101;
      const transitionNear=await pixels(1,2);
      control.transitionStart.value=-2;control.transitionEnd.value=-1;
      const transitionFar=await pixels(1,2);
      light.shadow.intensity=0;const noShadow=await pixels(0,0);light.shadow.intensity=1;
      receiverLod.push({markedFirst,programs,sharedMap,sharedDepth,
        contextCloned:cloneMaterial.contextNode===control.contextNode,
        distinctKeys:plainMaterial.customProgramCacheKey()!==markedMaterial.customProgramCacheKey(),
        stableVersions:equal(versions,[plainMaterial.version,markedMaterial.version,cloneMaterial.version]),
        nearParity:equal(plainPixels,nearPixels),transitionNearParity:equal(nearPixels,transitionNear),
        transitionFarParity:equal(farPixels,transitionFar),shadowChangesPixels:!equal(plainPixels,noShadow),
        cloneParity:equal(farPixels,cloneFar),
        independentControls:equal(plainPixels,independentNear) && equal(farPixels,independentFar) && equal(plainPixels,firstStillNear),
        nearFarDiffer:!equal(nearPixels,farPixels),
        transitionStats:{
          nearFarChanged:nearPixels.filter((v,i)=>v!==farPixels[i]).length,
          nearChanged:transitionInterior.filter((v,i)=>v!==nearPixels[i]).length,
          farChanged:transitionInterior.filter((v,i)=>v!==farPixels[i]).length,
          outside:transitionInterior.filter((v,i)=>v<Math.min(nearPixels[i],farPixels[i])-1 || v>Math.max(nearPixels[i],farPixels[i])+1).length,
          inside:transitionInterior.filter((v,i)=>v>Math.min(nearPixels[i],farPixels[i])+1 && v<Math.max(nearPixels[i],farPixels[i])-1).length,
        },
        transitionInterior:transitionInterior.every((v,i)=>v>=Math.min(nearPixels[i],farPixels[i])-1 && v<=Math.max(nearPixels[i],farPixels[i])+1) &&
          transitionInterior.some((v,i)=>v>Math.min(nearPixels[i],farPixels[i])+1 && v<Math.max(nearPixels[i],farPixels[i])-1),shadowPasses});
      renderer.setRenderTarget(null);
    }
    const fallback=[];
    for(const kind of ['basic','custom']) {
      renderer.shadowMap.type=kind==='basic'?THREE.BasicShadowMap:THREE.PCFShadowMap;
      const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(50,1,.1,30);
      camera.position.set(4,4,6);camera.lookAt(0,0,0);
      const light=new THREE.DirectionalLight(0xffffff,1.7);light.castShadow=true;light.position.set(4,6,4);
      light.shadow.mapSize.set(64,64);Object.assign(light.shadow.camera,{near:.1,far:20,left:-3,right:3,top:3,bottom:-3});
      if(kind==='custom')light.shadow.filterNode=()=>float(.37);
      const owner=new UniformDirectionalShadowNode(light);light.shadow.shadowNode=owner;scene.add(light,light.target);
      const geometry=new THREE.PlaneGeometry(12,12),plain=new THREE.MeshStandardNodeMaterial({color:0x99aa88,roughness:.9}),marked=plain.clone();
      const control=new GrassShadowFilterContext();control.drawMode.value=1;marked.contextNode=control.contextNode;
      const receiver=new THREE.Mesh(geometry,plain);receiver.rotation.x=-Math.PI/2;receiver.receiveShadow=true;scene.add(receiver);
      const casterGeometry=new THREE.BoxGeometry(1,2,1),casterMaterial=new THREE.MeshStandardNodeMaterial();
      const caster=new THREE.Mesh(casterGeometry,casterMaterial);caster.position.y=1;caster.castShadow=true;scene.add(caster);
      const target=new THREE.RenderTarget(64,64);renderer.setRenderTarget(target);
      resources.push(owner,light.shadow,geometry,plain,marked,casterGeometry,casterMaterial,target);
      const programs=[],images=[];let map=null,sharedMap=true;
      for(const material of [plain,marked]) {
        receiver.material=material;
        const shader=await renderer.debug.getShaderAsync(scene,camera,receiver);
        programs.push({vertex:await strict('vertex',shader.vertexShader),fragment:await strict('fragment',shader.fragmentShader)});
        if(map===null)map=light.shadow.map;
        sharedMap &&= light.shadow.map===map && owner.shadowMap===map;
        await new Promise((resolve,reject)=>renderer.setAnimationLoop(()=>{
          renderer.setAnimationLoop(null);
          try {renderer.render(scene,camera);resolve();} catch(error) {reject(error);}
        }));
        await device.queue.onSubmittedWorkDone();
        images.push(Array.from(await renderer.readRenderTargetPixelsAsync(target,0,0,64,64)));
      }
      fallback.push({kind,programs,sharedMap,pixelParity:images[0].every((v,i)=>v===images[1][i])});
      renderer.setRenderTarget(null);
    }
    renderer.shadowMap.type=THREE.PCFShadowMap;
    // Real same-frame draws sharing ONE context must upload separate object
    // uniforms. Changing values only between frames cannot prove this contract.
    const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-13,13,7,-7,.1,50);
    camera.position.set(0,15,0);camera.up.set(0,0,-1);camera.lookAt(0,0,0);
    const light=new THREE.DirectionalLight(0xffffff,1.7);light.castShadow=true;light.position.set(0,12,4);
    light.shadow.mapSize.set(128,128);light.shadow.radius=2;
    Object.assign(light.shadow.camera,{near:.1,far:40,left:-15,right:15,top:15,bottom:-15});
    const owner=new UniformDirectionalShadowNode(light);light.shadow.shadowNode=owner;scene.add(light,light.target);
    const control=new GrassShadowFilterContext(),material=new THREE.MeshStandardNodeMaterial({color:0x99aa88,roughness:.9});
    material.contextNode=control.contextNode;
    const geometry=new THREE.PlaneGeometry(12,12),casterGeometry=new THREE.BoxGeometry(1,2,1),casterMaterial=new THREE.MeshStandardNodeMaterial();
    const receivers=[-6.1,6.1].map(x=>{
      const mesh=new THREE.Mesh(geometry,material);mesh.position.x=x;mesh.rotation.x=-Math.PI/2;mesh.receiveShadow=true;scene.add(mesh);
      const caster=new THREE.Mesh(casterGeometry,casterMaterial);caster.position.set(x,1,0);caster.castShadow=true;scene.add(caster);return mesh;
    });
    let activeUpdates=[],forcedMode=null;
    control.drawMode.onObjectUpdate(frame=>{const mode=forcedMode??(frame.object===receivers[0]?0:1);activeUpdates.push(mode);return mode;});
    const target=new THREE.RenderTarget(128,64);renderer.setRenderTarget(target);
    resources.push(owner,light.shadow,material,geometry,casterGeometry,casterMaterial,target);
    await renderer.compileAsync(scene,camera);
    const updates=[];
    const draw=async (left,right,reverse=false)=>{
      receivers[0].visible=left;receivers[1].visible=right;
      receivers[0].renderOrder=reverse?1:0;receivers[1].renderOrder=reverse?0:1;
      activeUpdates=[];
      await new Promise((resolve,reject)=>renderer.setAnimationLoop(()=>{
        renderer.setAnimationLoop(null);
        try {renderer.render(scene,camera);resolve();} catch(error) {reject(error);}
      }));
      await device.queue.onSubmittedWorkDone();updates.push(activeUpdates);
      return Array.from(await renderer.readRenderTargetPixelsAsync(target,0,0,128,64));
    };
    const left=await draw(true,false),right=await draw(false,true);
    forcedMode=1;const wrongLeft=await draw(true,false);
    forcedMode=0;const wrongRight=await draw(false,true);
    forcedMode=null;const forward=await draw(true,true),reverse=await draw(true,true,true);
    const parity=image=>image.every((v,i)=>v===(Math.floor(i/4)%128<64?left[i]:right[i]));
    const sharedDraws={forwardParity:parity(forward),reverseParity:parity(reverse),updates,
      leftDistinguishesModes:left.some((v,i)=>Math.floor(i/4)%128<64 && v!==wrongLeft[i]),
      rightDistinguishesModes:right.some((v,i)=>Math.floor(i/4)%128>=64 && v!==wrongRight[i])};
    renderer.setRenderTarget(null);
    return {adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,description:adapter.info.description},
      nativeBackend:renderer.backend.isWebGPUBackend,baseline,candidate,receiverLod,fallback,sharedDraws,settingsUnchanged,errors};
  } finally {
    try {for(const resource of resources)resource.dispose();renderer?.dispose();}
    finally {active=false;device.removeEventListener("uncapturederror",onError);device.destroy();}
  }
};`;

it.skipIf(process.env.HYPERIA_NATIVE_SHADOW_WGSL !== "1")(
  "native shadow programs preserve baseline pixels, isolate receiver LOD branches and share one map",
  async () => {
    let browser: Browser | undefined;
    let server: Server | undefined;
    const errors: string[] = [];
    try {
      const entry = await build({
        stdin: {
          contents: `import THREE,{float,vec3,positionWorld} from ${JSON.stringify(fileURLToPath(new URL("../three.ts", import.meta.url)))};
import {UniformDirectionalShadowNode,GrassShadowFilterContext} from ${JSON.stringify(fileURLToPath(new URL("../UniformDirectionalShadow.ts", import.meta.url)))};
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
            sharedDraws: receipt.sharedDraws,
            fallback: receipt.fallback.map(({ programs, ...row }) => ({
              ...row,
              comparisonSites: programs.map((program) =>
                shadowCompareCount(program.fragment.original),
              ),
            })),
            receiverLod: receipt.receiverLod.map(({ programs, ...row }) => ({
              ...row,
              programs: Object.fromEntries(
                Object.entries(programs).map(([name, stages]) => [
                  name,
                  {
                    fragmentSha256: sha(stages.fragment.original),
                    comparisonSites: shadowCompareCount(
                      stages.fragment.original,
                    ),
                    ...(name === "marked" ||
                    name === "clone" ||
                    name === "independent"
                      ? {
                          branches: receiverBranchCounts(
                            stages.fragment.original,
                          ),
                        }
                      : {}),
                    fragmentMessages: stages.fragment.messages,
                    fragmentValidationError: stages.fragment.validationError,
                  },
                ]),
              ),
            })),
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
      expect(receipt.sharedDraws).toEqual({
        forwardParity: true,
        reverseParity: true,
        leftDistinguishesModes: true,
        rightDistinguishesModes: true,
        updates: [[0], [1], [1], [0], [0, 1], [1, 0]],
      });
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
      expect(receipt.receiverLod).toHaveLength(2);
      for (const row of receipt.receiverLod) {
        for (const key of [
          "sharedMap",
          "sharedDepth",
          "contextCloned",
          "distinctKeys",
          "stableVersions",
          "nearParity",
          "transitionNearParity",
          "transitionFarParity",
          "shadowChangesPixels",
          "cloneParity",
          "independentControls",
          "nearFarDiffer",
          "transitionInterior",
        ] as const)
          expect(
            row[key],
            `${row.markedFirst ? "marked" : "plain"}-first ${key}`,
          ).toBe(true);
        expect(row.shadowPasses).toEqual(Array(11).fill(1));
        for (const name of ["plain", "plainReturn"] as const) {
          expect(shadowCompareCount(row.programs[name].fragment.original)).toBe(
            5,
          );
          expect(row.programs[name].fragment.original).not.toContain(
            "grassShadowDrawMode",
          );
        }
        expect(row.programs.plainReturn.fragment.original).toBe(
          row.programs.plain.fragment.original,
        );
        for (const name of ["marked", "clone", "independent"] as const)
          expect(
            receiverBranchCounts(row.programs[name].fragment.original),
          ).toEqual({ far: 1, transition: 6, near: 5, total: 12 });
        for (const stages of Object.values(row.programs))
          for (const stage of Object.values(stages)) {
            expect(
              stage.messages.filter((message) => message.type === "error"),
            ).toEqual([]);
            expect(stage.validationError).toBeNull();
          }
      }
      expect(receipt.fallback.map((row) => row.kind)).toEqual([
        "basic",
        "custom",
      ]);
      for (const row of receipt.fallback) {
        expect(row.sharedMap).toBe(true);
        expect(row.pixelParity).toBe(true);
        expect(row.programs).toHaveLength(2);
        for (const programs of row.programs) {
          expect(shadowCompareCount(programs.fragment.original)).toBe(
            row.kind === "basic" ? 1 : 0,
          );
          expect(programs.fragment.original).not.toContain(
            "grassShadowDrawMode",
          );
          for (const stage of Object.values(programs)) {
            expect(
              stage.messages.filter((message) => message.type === "error"),
            ).toEqual([]);
            expect(stage.validationError).toBeNull();
          }
        }
      }
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
