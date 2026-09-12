// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import {
  diffuseColor,
  float,
  normalView,
  positionLocal,
  uniform,
  vec3,
} from "three/tsl";
import {
  CompactContactAO,
  classifyCompactContactSurface,
  validateCompactContactAOOptions,
  withCompactContactPublicState,
} from "../CompactContactAO";

const library = new THREE.StandardNodeLibrary();

// Real Three classes/CPU graph only. No GPU device, mock renderer, shader compile,
// native frame, rendered normal coverage, color parity or performance claim.
function fixture() {
  const renderer = new THREE.WebGPURenderer({
    canvas: document.createElement("canvas"),
    antialias: true,
  });
  renderer.setSize(1280, 720);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, 1280 / 720, 0.1, 600);
  return { renderer, scene, camera };
}
function make(f: ReturnType<typeof fixture>, denoise = false) {
  return new CompactContactAO(
    f.renderer,
    f.scene,
    f.camera,
    { strength: 0, resolutionScale: 0.5, denoise },
    () => false,
  );
}
function unwrap(node: THREE.Node): THREE.Node {
  for (let depth = 0; depth < 8; depth++) {
    if (node.type !== "VarNode" && node.type !== "ConvertNode") return node;
    const child = Reflect.get(node, "node");
    if (!(child instanceof THREE.Node))
      throw new Error("Missing actual TSL wrapper child");
    node = child;
  }
  throw new Error("Unexpected TSL wrapper depth");
}

describe("unintegrated compact contact AO, actual r186 CPU ownership", () => {
  it("separates excluded skin groups from admitted coverage and bounds copied diagnostics", async () => {
    const f = fixture(),
      owner = make(f);
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshStandardNodeMaterial({ transparent: true });
    const mesh = new THREE.SkinnedMesh(geometry, material);
    try {
      for (let i = 0; i < 40; i++)
        owner["observeGroup"](
          mesh,
          classifyCompactContactSurface(mesh, material, library),
          material,
        );
      const receipt = owner.getReceipt();
      expect(receipt.groups.skinned).toBe(0);
      expect(receipt.groups.excludedSkinned).toBe(40);
      expect(receipt.groups.skinSurfaces).toHaveLength(32);
      expect(receipt.groups.skinSurfaces[0]).toMatchObject({
        included: false,
        reason: "blended",
        object: mesh.uuid,
        material: material.uuid,
      });
      receipt.groups.skinSurfaces[0].included = true;
      expect(owner.getReceipt().groups.skinSurfaces[0].included).toBe(false);
      material.transparent = false;
      owner["observeGroup"](
        mesh,
        classifyCompactContactSurface(mesh, material, library),
        material,
      );
      expect(owner.getReceipt().groups.skinned).toBe(1);
      expect(owner.getReceipt().groups.excludedSkinned).toBe(40);
    } finally {
      owner.destroy();
      geometry.dispose();
      material.dispose();
      await f.renderer.dispose();
    }
  });

  it("requires exact finite bounded options and never infers an opt-in", () => {
    const value = {
      strength: 0,
      resolutionScale: 0.5 as const,
      denoise: false,
    };
    expect(Object.isFrozen(validateCompactContactAOOptions(value))).toBe(true);
    for (const bad of [
      { ...value, strength: -0.1 },
      { ...value, strength: 1.1 },
      { ...value, strength: NaN },
      { ...value, resolutionScale: 0.25 },
      { ...value, denoise: 1 },
      { ...value, temporal: true },
      Object.create(value),
    ])
      expect(() => validateCompactContactAOOptions(bad)).toThrow();
  });

  it.each([false, true])(
    "owns actual normal/depth, GTAO, optional materialized denoise=%s and full MSAA beauty",
    async (denoise) => {
      const f = fixture(),
        owner = make(f, denoise);
      try {
        const receipt = owner.getReceipt();
        expect(receipt.state).toBe("constructed");
        expect(receipt.renderSucceeded).toBe(false);
        expect(receipt.nativeVisualQualified).toBe(false);
        expect(receipt.privateRendererReuseAfterFailureApproved).toBe(false);
        expect(receipt.outputColorTransform).toBe(true);
        expect(receipt.prepass).toMatchObject({
          width: 1280,
          height: 720,
          samples: 0,
          type: THREE.HalfFloatType,
        });
        expect(receipt.beauty).toMatchObject({
          width: 1280,
          height: 720,
          samples: 4,
          type: THREE.HalfFloatType,
        });
        expect(receipt.ao).toMatchObject({
          width: 640,
          height: 360,
          format: THREE.RedFormat,
          type: THREE.UnsignedByteType,
        });
        const pre = owner["prepass"],
          beauty = owner["beauty"],
          gtao = owner["gtao"];
        // Deep source imports would create a second Node ID/cache universe.
        expect(pre).toBeInstanceOf(THREE.PassNode);
        expect(pre.options.samples).toBe(0);
        expect(beauty.options.samples).toBe(4);
        expect(pre).toBeInstanceOf(THREE.Node);
        expect(beauty).toBeInstanceOf(THREE.PassNode);
        expect(gtao).toBeInstanceOf(THREE.Node);
        expect(pre.overrideMaterial).toBeNull();
        expect(beauty.overrideMaterial).toBeNull();
        expect(pre.scene).toBe(f.scene);
        expect(pre.camera).toBe(f.camera);
        expect(pre.transparent).toBe(true);
        const mrt = pre.getMRT()!;
        expect(mrt.getBlendMode("output").blending).toBe(THREE.NoBlending);
        expect(mrt.getClearColor("output")).toMatchObject({
          r: 0,
          g: 0,
          b: 0,
          a: 0,
        });
        const joined = unwrap(mrt.get("output")) as THREE.Node & {
          nodes: THREE.Node[];
        };
        expect(joined.nodes).toHaveLength(2);
        expect(joined.nodes[0]).toBe(normalView);
        expect(joined.nodes[1]).toBe(diffuseColor.a);
        expect(pre.renderTarget.textures).toHaveLength(1);
        expect(beauty.renderTarget.textures).toHaveLength(1);
        owner.getReceipt(); // Receipt must not accidentally create an unnamed MRT.
        expect(pre.renderTarget.textures).toHaveLength(1);
        expect(beauty.renderTarget.textures).toHaveLength(1);
        expect(gtao.depthNode).toBe(pre.getTextureNode("depth"));
        expect(gtao.normalNode).toBe(pre.getTextureNode("output"));
        expect(gtao.useTemporalFiltering).toBe(false);
        expect([
          gtao.radius.value,
          gtao.thickness.value,
          gtao.scale.value,
          gtao.samples.value,
        ]).toEqual([0.25, 1, 1, 16]);
        if (denoise) {
          expect(receipt.denoise).toMatchObject({
            width: 640,
            height: 360,
            samples: 0,
            depthBuffer: false,
          });
          const target = owner["denoiseTarget"]!;
          expect(target).toBeInstanceOf(THREE.RTTNode);
          expect(target).toBeInstanceOf(THREE.Node);
          expect(target.node).toBe(owner["denoiser"]);
          expect(target.autoResize).toBe(false);
          expect(target.autoUpdate).toBe(true);
          expect(target.updateBeforeType).toBe("frame");
        } else expect(receipt.denoise).toBeNull();
        expect(f.renderer.initialized).toBe(false);
      } finally {
        owner.destroy();
        await f.renderer.dispose();
      }
    },
  );

  it("keeps neutral in the same graph and rounds only AO/denoise at odd drawing-buffer sizes", async () => {
    const f = fixture(),
      owner = make(f, true);
    try {
      const before = owner.getReceipt(),
        output = owner["pipeline"].outputNode;
      owner.setStrength(0.4);
      expect(owner["pipeline"].outputNode).toBe(output);
      owner.setStrength(0);
      expect(owner.getReceipt().options.strength).toBe(0);
      expect(owner.getReceipt().ao.texture).toBe(before.ao.texture);
      f.renderer.setSize(1279, 719);
      owner.resize();
      const after = owner.getReceipt();
      expect(after.prepass).toMatchObject({
        width: 1279,
        height: 719,
        samples: 0,
      });
      expect(after.beauty).toMatchObject({
        width: 1279,
        height: 719,
        samples: 4,
      });
      expect(after.ao).toMatchObject({ width: 640, height: 360 });
      expect(after.denoise).toMatchObject({ width: 640, height: 360 });
      expect(f.renderer.getPixelRatio()).toBe(1);
      expect(f.camera.aspect).toBe(1280 / 720);
      expect(() => owner.setStrength(Infinity)).toThrow();
    } finally {
      owner.destroy();
      await f.renderer.dispose();
    }
  });

  it("classifies actual group materials, excluding depth-writing water without replacing cutout/skin/wind/dissolve nodes", () => {
    const geometry = new THREE.BoxGeometry();
    const opaque = new THREE.MeshStandardMaterial();
    const water = new THREE.MeshStandardNodeMaterial({
      transparent: true,
      depthWrite: true,
      opacity: 0.6,
    });
    const cutout = new THREE.MeshStandardNodeMaterial({
      transparent: true,
      alphaTest: 0.5,
      alphaToCoverage: true,
    });
    const wind = positionLocal.add(vec3(0, 0.1, 0));
    const dissolve = uniform(0.7);
    cutout.positionNode = wind;
    cutout.opacityNode = dissolve;
    cutout.alphaTestNode = float(0.5);
    const mesh = new THREE.SkinnedMesh(geometry, [opaque, water, cutout]);
    try {
      expect(classifyCompactContactSurface(mesh, opaque, library)).toEqual({
        include: true,
        reason: "opaque",
      });
      expect(classifyCompactContactSurface(mesh, water, library)).toEqual({
        include: false,
        reason: "blended",
      });
      expect(classifyCompactContactSurface(mesh, cutout, library)).toEqual({
        include: true,
        reason: "cutout",
      });
      expect(cutout.positionNode).toBe(wind);
      expect(cutout.opacityNode).toBe(dissolve);
      expect(cutout.alphaToCoverage).toBe(true);
      expect(cutout.transparent).toBe(true);
      expect(cutout.blending).toBe(THREE.NormalBlending);
      expect(mesh.material).toEqual([opaque, water, cutout]);
      cutout.fragmentNode = vec3(1);
      expect(() =>
        classifyCompactContactSurface(mesh, cutout, library),
      ).toThrow(/fragment\/MRT/);
      cutout.fragmentNode = null;
      cutout.depthWrite = false;
      expect(classifyCompactContactSurface(mesh, cutout, library).include).toBe(
        false,
      );
      const physical = new THREE.MeshPhysicalMaterial({ transmission: 0.2 });
      expect(
        classifyCompactContactSurface(mesh, physical, library).reason,
      ).toBe("transmissive");
      physical.dispose();
    } finally {
      geometry.dispose();
      opaque.dispose();
      water.dispose();
      cutout.dispose();
    }
  });

  it("uses the actual node library for all supported mesh families, including the live Lambert material", () => {
    const localLibrary = new THREE.StandardNodeLibrary();
    const geometry = new THREE.BoxGeometry();
    const materials = [
      new THREE.MeshLambertMaterial(),
      new THREE.MeshPhongMaterial(),
      new THREE.MeshBasicMaterial(),
      new THREE.MeshToonMaterial(),
      new THREE.MeshNormalMaterial(),
      new THREE.MeshMatcapMaterial(),
      new THREE.MeshStandardMaterial(),
      new THREE.MeshPhysicalMaterial(),
    ];
    const unsupported = new THREE.ShaderMaterial();
    try {
      for (const material of materials) {
        const mesh = new THREE.Mesh(geometry, material);
        const sourceVersion = material.version;
        expect(
          classifyCompactContactSurface(mesh, material, localLibrary),
        ).toEqual({
          include: true,
          reason: "opaque",
        });
        // The renderer performs its own normal conversion; admission must not
        // replace the source material or invoke allocation-producing conversion.
        expect(mesh.material).toBe(material);
        expect(material.version).toBe(sourceVersion);
        const converted = localLibrary.fromMaterial(material)!;
        expect(converted).toBeInstanceOf(THREE.NodeMaterial);
        converted.dispose();
      }
      expect(() =>
        classifyCompactContactSurface(
          new THREE.Mesh(geometry, unsupported),
          unsupported,
          localLibrary,
        ),
      ).toThrow(/unsupported material pipeline/);
    } finally {
      for (const material of [...materials, unsupported]) material.dispose();
      geometry.dispose();
    }
  });

  it("retains builtin AO's authored-AO multiplication and transparent-receiver exception", async () => {
    const f = fixture(),
      owner = make(f);
    const opaque = new THREE.MeshStandardNodeMaterial(),
      transparent = new THREE.MeshStandardNodeMaterial({ transparent: true });
    try {
      const data = owner["beauty"].contextNode!.getFlowContextData() as {
        getAO: (
          input: THREE.Node | null,
          builder: { material: THREE.Material },
        ) => THREE.Node | null;
      };
      const authored = float(0.6);
      expect(data.getAO(authored, { material: transparent })).toBe(authored);
      expect(data.getAO(null, { material: transparent })).toBeNull();
      const multiplied = unwrap(
        data.getAO(authored, {
          material: opaque,
        })!,
      ) as THREE.Node & { op: string; aNode: THREE.Node };
      expect(multiplied.op).toBe("*");
      expect(multiplied.aNode).toBe(authored);
    } finally {
      opaque.dispose();
      transparent.dispose();
      owner.destroy();
      await f.renderer.dispose();
    }
  });

  it("restores actual public renderer/context/scene/camera state after a synchronous callback exception", async () => {
    const f = fixture(),
      borrowed = new THREE.MeshStandardMaterial(),
      target = new THREE.RenderTarget(8, 8);
    const marker = new Error(
      "intentional CPU callback exception; not native GPU failure",
    );
    const prior = () => {};
    f.renderer.setRenderObjectFunction(prior);
    f.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    f.renderer.toneMappingExposure = 1.1;
    f.renderer.setClearColor(0x112233, 0.3);
    f.renderer.setViewport(3, 4, 600, 320);
    f.renderer.setScissor(7, 8, 500, 250);
    f.renderer.setScissorTest(true);
    f.scene.name = "borrowed scene";
    const context = f.renderer.contextNode,
      initial = f.renderer.getClearColor(new THREE.Color()).clone();
    try {
      expect(() =>
        withCompactContactPublicState(f.renderer, f.scene, f.camera, () => {
          f.renderer.toneMapping = THREE.NoToneMapping;
          f.renderer.toneMappingExposure = 99;
          f.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
          f.renderer.setRenderTarget(target);
          f.renderer.setRenderObjectFunction(null);
          f.renderer.setClearColor(0xff0000, 1);
          f.renderer.setViewport(0, 0, 8, 8);
          f.renderer.setScissorTest(false);
          f.renderer.autoClearColor = false;
          f.renderer.transparent = false;
          f.scene.overrideMaterial = borrowed;
          f.scene.name = "temporary pass";
          f.camera.layers.mask = 99;
          throw marker;
        }),
      ).toThrow(marker);
      expect(f.renderer.getRenderTarget()).toBeNull();
      expect(f.renderer.getRenderObjectFunction()).toBe(prior);
      expect(f.renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
      expect(f.renderer.toneMappingExposure).toBe(1.1);
      expect(f.renderer.getClearColor(new THREE.Color())).toEqual(initial);
      expect(f.renderer.getClearAlpha()).toBe(0.3);
      expect(f.renderer.getViewport(new THREE.Vector4()).toArray()).toEqual([
        3, 4, 600, 320,
      ]);
      expect(f.renderer.getScissor(new THREE.Vector4()).toArray()).toEqual([
        7, 8, 500, 250,
      ]);
      expect(f.renderer.getScissorTest()).toBe(true);
      expect(f.renderer.contextNode).toBe(context);
      expect(f.renderer.autoClearColor).toBe(true);
      expect(f.renderer.transparent).toBe(true);
      expect(f.scene.overrideMaterial).toBeNull();
      expect(f.scene.name).toBe("borrowed scene");
      expect(f.camera.layers.mask).toBe(1);
    } finally {
      borrowed.dispose();
      target.dispose();
      await f.renderer.dispose();
    }
  });

  it("fails before GPU initialization and never renders/falls back/reuses a failed owner", async () => {
    const f = fixture(),
      owner = make(f);
    try {
      expect(() => owner.render()).toThrow(/initialize the actual renderer/);
      expect(f.renderer.initialized).toBe(false);
      expect(owner.getReceipt()).toMatchObject({
        state: "failed",
        renderSucceeded: false,
        renderedFrames: 0,
        privateRendererReuseAfterFailureApproved: false,
      });
      expect(() => owner.render()).toThrow(/owner is failed/);
      expect(() => owner.resize()).toThrow(/owner is failed/);
      owner.destroy();
      owner.destroy();
      expect(() => owner.render()).toThrow(/owner is disposed/);
    } finally {
      owner.destroy();
      await f.renderer.dispose();
    }
  });

  it("disposes each actual private pass/effect/noise/material exactly once, never borrowed scene resources or shared fullscreen geometry", async () => {
    const f = fixture();
    const material = new THREE.MeshStandardNodeMaterial(),
      geometry = new THREE.BoxGeometry(),
      texture = new THREE.DataTexture(
        new Uint8Array([255, 255, 255, 255]),
        1,
        1,
      );
    material.map = texture;
    f.scene.add(new THREE.Mesh(geometry, material));
    const borrowed = [material, geometry, texture];
    const borrowedEvents = new Map(borrowed.map((resource) => [resource, 0]));
    for (const resource of borrowed)
      resource.addEventListener("dispose", () =>
        borrowedEvents.set(resource, borrowedEvents.get(resource)! + 1),
      );
    const owner = make(f, true);
    const gtao = owner["gtao"] as unknown as {
      _aoRenderTarget: THREE.RenderTarget;
      _noiseTexture: THREE.Texture;
      _material: THREE.NodeMaterial;
    };
    const denoiser = owner["denoiser"] as unknown as {
      _noiseTexture: THREE.Texture;
    };
    const pipeline = owner["pipeline"] as unknown as { _quadMesh: THREE.Mesh };
    const rtt = owner["denoiseTarget"]! as (typeof owner)["denoiseTarget"] & {
      _quadMesh: THREE.Mesh;
    };
    const privateResources = [
      owner["prepass"].renderTarget,
      owner["beauty"].renderTarget,
      gtao._aoRenderTarget,
      gtao._noiseTexture,
      gtao._material,
      denoiser._noiseTexture,
      rtt!.renderTarget!,
      rtt!._quadMesh.material as THREE.Material,
      pipeline._quadMesh.material as THREE.Material,
    ];
    const events = new Map(privateResources.map((resource) => [resource, 0]));
    for (const resource of privateResources)
      resource.addEventListener("dispose", () =>
        events.set(resource, events.get(resource)! + 1),
      );
    let fullscreenDisposed = 0;
    const fullscreen = pipeline._quadMesh.geometry;
    const onFullscreenDispose = () => fullscreenDisposed++;
    fullscreen.addEventListener("dispose", onFullscreenDispose);
    try {
      owner.destroy();
      owner.destroy();
      expect([...events.values()]).toEqual(privateResources.map(() => 1));
      expect([...borrowedEvents.values()]).toEqual([0, 0, 0]);
      expect(fullscreenDisposed).toBe(0);
      expect(f.scene.children).toHaveLength(1);
      const replacement = make(f, true);
      expect(replacement.getReceipt().ao.texture).not.toBe(
        owner.getReceipt().ao.texture,
      );
      replacement.destroy();
    } finally {
      fullscreen.removeEventListener("dispose", onFullscreenDispose);
      owner.destroy();
      material.dispose();
      geometry.dispose();
      texture.dispose();
      await f.renderer.dispose();
    }
  });

  it("rejects reflection/override/non-HalfFloat/low-MSAA configurations without changing renderer preferences", async () => {
    const f = fixture(),
      options = { strength: 0, resolutionScale: 0.5 as const, denoise: false };
    const override = new THREE.MeshStandardMaterial();
    try {
      expect(
        () =>
          new CompactContactAO(
            f.renderer,
            f.scene,
            f.camera,
            options,
            () => true,
          ),
      ).toThrow(/reflection/);
      f.scene.overrideMaterial = override;
      expect(() => make(f)).toThrow(/override/);
      f.scene.overrideMaterial = null;
      const byteRenderer = new THREE.WebGPURenderer({
        canvas: document.createElement("canvas"),
        antialias: true,
        outputBufferType: THREE.UnsignedByteType,
      });
      expect(
        () =>
          new CompactContactAO(
            byteRenderer,
            f.scene,
            f.camera,
            options,
            () => false,
          ),
      ).toThrow(/HalfFloat/);
      await byteRenderer.dispose();
      const noMSAA = new THREE.WebGPURenderer({
        canvas: document.createElement("canvas"),
      });
      expect(
        () =>
          new CompactContactAO(noMSAA, f.scene, f.camera, options, () => false),
      ).toThrow(/four-sample/);
      await noMSAA.dispose();
      expect(f.renderer.samples).toBe(4);
      expect(f.renderer.initialized).toBe(false);
    } finally {
      override.dispose();
      await f.renderer.dispose();
    }
  });
});
