import { describe, expect, it } from "vitest";

import type { World } from "../../../../types";
import THREE from "../../../../extras/three/three";
import { WaterSystem, type WaterUniforms } from "../WaterSystem";
import { World as RealWorld } from "../../../../core/World";
import { NodeFrame } from "three/webgpu";
import { NodeUpdateType } from "three/tsl";

type WaterMaterialHarness = {
  normalTex?: THREE.Texture;
  flowTex?: THREE.Texture;
  foamTex?: THREE.Texture;
  oceanMaterial?: THREE.MeshStandardNodeMaterial;
  oceanUniforms: WaterUniforms | null;
  createOceanMaterial(): THREE.MeshStandardNodeMaterial;
};

function createTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    new Uint8Array([128, 128, 255, 255]),
    1,
    1,
    THREE.RGBAFormat,
  );
  texture.needsUpdate = true;
  return texture;
}

function createLakePlaneHarness() {
  const world = new RealWorld();
  const water = new WaterSystem(world);
  water["normalTex"] = createTexture();
  water["flowTex"] = createTexture();
  water["foamTex"] = createTexture();
  const reflection = water["createReflection"]();
  water["reflection"] = reflection;
  water["lakeMaterial"] = water["createLakeMaterial"]();
  const scene = new THREE.Scene();
  water.addToScene(scene);
  const frame = new NodeFrame();
  frame.camera = world.camera;
  frame.scene = scene;
  frame.frameId = 7;
  frame.renderId = 11;
  const addLake = (height: number, parent: THREE.Object3D = scene) => {
    const geometry = new THREE.CircleGeometry(7.5, 45);
    geometry.rotateX(-Math.PI / 2);
    const lake = new THREE.Mesh(geometry, water.getMaterial("lake"));
    lake.position.y = height;
    parent.add(lake);
    scene.updateMatrixWorld(true);
    water.registerWaterMesh(lake);
    return lake;
  };
  return { water, reflection, frame, scene, addLake };
}

describe("WaterSystem material graph", () => {
  it("does not consume native render admission for non-lake precompile objects", () => {
    const { water, reflection, frame, scene } = createLakePlaneHarness();
    const unregistered = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      water.getMaterial("lake"),
    );
    scene.add(unregistered);
    try {
      // Use installed NodeFrame's real scheduling map; no replacement callback
      // or renderer is supplied. Entering the GPU path would fail this test.
      const actualFrame = frame as NodeFrame & {
        updateBeforeMap: WeakMap<object, { renderId: number; frameId: number }>;
      };
      for (const object of [null, new THREE.Object3D(), unregistered]) {
        frame.object = object;
        frame.updateBeforeNode(reflection.reflector);
        expect(
          actualFrame.updateBeforeMap.get(reflection.reflector)?.renderId,
        ).toBe(0);
        expect(water["lastLakeReflectionOwner"]).toBeNull();
      }
      expect(reflection.reflector.renderTargets.size).toBe(0);
      expect(reflection.reflector.virtualCameras.has(frame.camera!)).toBe(
        false,
      );
    } finally {
      unregistered.geometry.dispose();
      water.destroy();
    }
  });
  it("binds the actual elevated lake plane without changing ocean-level ownership", () => {
    const { water, reflection, frame, addLake } = createLakePlaneHarness();
    try {
      water.setWaterLevel(16);
      const lake = addLake(27.8);
      frame.object = lake;
      const owner = water["bindLakeReflectionPlane"](frame, reflection.target);
      expect(owner?.mesh).toBe(lake);
      expect(owner?.plane.normal.toArray()).toEqual([0, 1, 0]);
      expect(owner?.plane.constant).toBeCloseTo(-27.8, 12);
      expect(water["waterLevel"]).toBe(16);
      expect(
        new THREE.Vector3().setFromMatrixPosition(reflection.target.matrixWorld)
          .y,
      ).toBeCloseTo(27.8, 12);
      const reflectedEye = new THREE.Vector3(346, 34, 305);
      reflectedEye.addScaledVector(
        owner!.plane.normal,
        -2 * owner!.plane.distanceToPoint(reflectedEye),
      );
      expect(reflectedEye.y).toBeCloseTo(21.6, 12);
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(true);
      // Plane mathematics/admission is not a fake GPU capture: before native
      // ReflectorNode has completed, the actual object uniform stays disabled.
      frame.updateNode(water["lakeReflectionPlaneUniform"]!);
      expect(water["lakeReflectionPlaneUniform"]!.value).toBe(0);
      expect(owner?.captured).toBe(false);
      expect(reflection.reflector.renderTargets.size).toBe(0);
      expect(reflection.reflector.virtualCameras.has(frame.camera!)).toBe(
        false,
      );
    } finally {
      water.destroy();
    }
  });

  it("shares only coplanar lake draws in the same real NodeFrame camera and render", () => {
    const { water, reflection, frame, addLake } = createLakePlaneHarness();
    try {
      const first = addLake(27.8);
      const samePlane = addLake(27.8);
      samePlane.position.x = 20;
      samePlane.updateMatrixWorld(true);
      const otherHeight = addLake(31);
      frame.object = first;
      const owner = water["bindLakeReflectionPlane"](frame, reflection.target);
      frame.object = samePlane;
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(true);
      frame.object = otherHeight;
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
      expect(
        water["bindLakeReflectionPlane"](frame, reflection.target),
      ).toBeNull();
      expect(water["lastLakeReflectionOwner"]).toBe(owner);
      frame.object = samePlane;
      const camera = frame.camera;
      frame.camera = new THREE.PerspectiveCamera();
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
      frame.camera = camera;
      frame.renderId++;
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
      frame.object = otherHeight;
      expect(
        water["bindLakeReflectionPlane"](frame, reflection.target)?.plane
          .constant,
      ).toBeCloseTo(-31, 12);
      frame.frameId++;
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
      const otherFrame = new NodeFrame();
      Object.assign(otherFrame, {
        camera,
        scene: frame.scene,
        object: otherHeight,
        frameId: frame.frameId,
        renderId: frame.renderId,
      });
      expect(water["matchesLakeReflectionPlane"](otherFrame)).toBe(false);
    } finally {
      water.destroy();
    }
  });

  it("uses inverse-transpose world planes under rotated, nonuniform parent transforms", () => {
    const { water, reflection, frame, scene, addLake } =
      createLakePlaneHarness();
    try {
      const parent = new THREE.Group();
      parent.position.set(12, 9, -8);
      parent.rotation.set(0.2, 0.6, -0.13);
      parent.scale.set(1.7, 0.8, 1.2);
      scene.add(parent);
      const lake = addLake(4, parent);
      lake.rotation.set(0.14, 0.3, 0.05);
      scene.updateMatrixWorld(true);
      frame.object = lake;
      const owner = water["bindLakeReflectionPlane"](frame, reflection.target)!;
      const a = new THREE.Vector3(-2, 0, 1).applyMatrix4(lake.matrixWorld);
      const b = new THREE.Vector3(3, 0, 1).applyMatrix4(lake.matrixWorld);
      const c = new THREE.Vector3(-2, 0, -3).applyMatrix4(lake.matrixWorld);
      const expected = new THREE.Plane().setFromCoplanarPoints(a, b, c);
      expect(owner.plane.normal.distanceTo(expected.normal)).toBeLessThan(
        1e-12,
      );
      expect(Math.abs(owner.plane.constant - expected.constant)).toBeLessThan(
        1e-12,
      );
      const targetNormal = new THREE.Vector3(0, 0, 1).transformDirection(
        reflection.target.matrixWorld,
      );
      expect(targetNormal.distanceTo(expected.normal)).toBeLessThan(1e-12);
      for (const point of [a, b, c])
        expect(Math.abs(owner.plane.distanceToPoint(point))).toBeLessThan(
          1e-12,
        );
      // Exactly the native nested-render protection; the parent scene may be
      // transformed and forced to update, but cannot replace the bound plane.
      const bound = reflection.target.matrixWorld.clone();
      reflection.target.matrixWorldAutoUpdate = false;
      scene.updateMatrixWorld(true);
      expect(reflection.target.matrixWorld.equals(bound)).toBe(true);
      reflection.target.matrixWorldAutoUpdate = true;
    } finally {
      water.destroy();
    }
  });

  it("rejects ocean, changed/nonplanar geometry, retired and stale owners without allocating captures", () => {
    const { water, reflection, frame, scene, addLake } =
      createLakePlaneHarness();
    const oceanMaterial = new THREE.MeshStandardNodeMaterial();
    try {
      const ocean = new THREE.Mesh(
        new THREE.PlaneGeometry(10, 10),
        oceanMaterial,
      );
      scene.add(ocean);
      water.registerWaterMesh(ocean);
      frame.object = ocean;
      expect(
        water["bindLakeReflectionPlane"](frame, reflection.target),
      ).toBeNull();
      const lake = addLake(27.8);
      frame.object = lake;
      water["bindLakeReflectionPlane"](frame, reflection.target);
      water.unregisterWaterMesh(lake);
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
      expect(water["lastLakeReflectionOwner"]).toBeNull();
      water.registerWaterMesh(lake);
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
      const position = lake.geometry.getAttribute("position");
      position.needsUpdate = true;
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
      frame.renderId++;
      expect(
        water["bindLakeReflectionPlane"](frame, reflection.target),
      ).toBeNull();
      position.setY(0, 1);
      water.unregisterWaterMesh(lake);
      water.registerWaterMesh(lake);
      expect(
        water["bindLakeReflectionPlane"](frame, reflection.target),
      ).toBeNull();
      expect(reflection.reflector.renderTargets.size).toBe(0);
    } finally {
      water.destroy();
      oceanMaterial.dispose();
    }
  });

  it("invalidates plane leases across reflection preferences and disposal while preserving the native gate", () => {
    const { water, reflection, frame, addLake } = createLakePlaneHarness();
    const lake = addLake(27.8);
    frame.object = lake;
    const update = reflection.reflector.updateBefore;
    try {
      water["bindLakeReflectionPlane"](frame, reflection.target);
      water.setReflectionsEnabled(false);
      frame.updateBeforeNode(reflection.reflector);
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
      expect(water.waterUniforms?.reflectionIntensity.value).toBe(0);
      expect(reflection.reflector.renderTargets.size).toBe(0);
      water.setReflectionsEnabled(true);
      expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
      expect(water.waterUniforms?.reflectionIntensity.value).toBe(0.4);
      expect(reflection.reflector.updateBefore).toBe(update);
      expect(reflection.reflector.getUpdateBeforeType()).toBe(
        NodeUpdateType.RENDER,
      );
    } finally {
      water.destroy();
    }
    expect(water["lakePlaneSources"].size).toBe(0);
    expect(water["lastLakeReflectionOwner"]).toBeNull();
    expect(water["lakeReflectionPlaneUniform"]).toBeNull();
  });

  it("rejects singular and non-finite actual world transforms before capture admission", () => {
    const { water, reflection, frame, addLake } = createLakePlaneHarness();
    try {
      const lake = addLake(27.8);
      frame.object = lake;
      expect(
        water["bindLakeReflectionPlane"](frame, reflection.target),
      ).not.toBeNull();
      const original = lake.matrixWorld.clone();
      const singular = original.clone().scale(new THREE.Vector3(0, 1, 1));
      const infinite = original.clone();
      infinite.elements[0] = Infinity;
      const notANumber = original.clone();
      notANumber.elements[13] = NaN;
      for (const matrix of [singular, infinite, notANumber]) {
        lake.matrixWorld.copy(matrix);
        expect(water["matchesLakeReflectionPlane"](frame)).toBe(false);
        frame.renderId++;
        expect(
          water["bindLakeReflectionPlane"](frame, reflection.target),
        ).toBeNull();
        // Exercise the real native scheduling entry, not only the math helper.
        // It must return before attempting GPU camera/target allocation.
        frame.updateBeforeNode(reflection.reflector);
        frame.updateNode(water["lakeReflectionPlaneUniform"]!);
        expect(water["lakeReflectionPlaneUniform"]!.value).toBe(0);
        expect(reflection.reflector.renderTargets.size).toBe(0);
        expect(reflection.reflector.virtualCameras.has(frame.camera!)).toBe(
          false,
        );
      }
    } finally {
      water.destroy();
    }
  });

  it("skips real NodeFrame reflection scheduling when disabled before initialization", () => {
    const world = new RealWorld();
    const water = new WaterSystem(world);
    water.setReflectionsEnabled(false);
    const node = water["createReflection"]();
    const reflection = node.reflector;
    try {
      // A real NodeFrame without a GPU renderer: a disabled node must never
      // enter the native draw or allocate any camera/target. Not a GPU test.
      const frame = new NodeFrame();
      frame.camera = world.camera;
      frame.renderId = 1;
      expect(reflection.updateBeforeType).toBe(NodeUpdateType.RENDER);
      expect(reflection.getUpdateBeforeType(frame)).toBe(NodeUpdateType.NONE);
      frame.updateBeforeNode(reflection);
      expect(reflection.virtualCameras.has(world.camera)).toBe(false);
      expect(reflection.renderTargets.size).toBe(0);
      expect(reflection.resolutionScale).toBe(0.5);
    } finally {
      node.dispose();
      water.destroy();
    }
  });

  it("retains the registered node and native update policy across preference toggles", () => {
    const water = new WaterSystem(new RealWorld());
    const node = water["createReflection"]();
    const reflection = node.reflector;
    const update = reflection.updateBefore;
    const gate = reflection.getUpdateBeforeType;
    try {
      for (const enabled of [true, false, true, false, true]) {
        water.setReflectionsEnabled(enabled);
        expect(reflection.getUpdateBeforeType()).toBe(
          enabled ? NodeUpdateType.RENDER : NodeUpdateType.NONE,
        );
        // NodeBuilder registers by the property, NodeFrame dispatches by the
        // method. Keeping registration permits re-enable without a recompile.
        expect(reflection.updateBeforeType).toBe(NodeUpdateType.RENDER);
        expect(reflection.updateBefore).toBe(update);
        expect(reflection.getUpdateBeforeType).toBe(gate);
        expect(node.reflector).toBe(reflection);
      }
      reflection.updateBeforeType = NodeUpdateType.FRAME;
      expect(reflection.getUpdateBeforeType()).toBe(NodeUpdateType.FRAME);
    } finally {
      node.dispose();
      water.destroy();
    }
  });

  it("constructs the ocean graph with updateable runtime uniform values", () => {
    const world = {
      isServer: false,
      camera: null,
      getSystem: () => null,
    } as unknown as World;
    const system = new WaterSystem(world);
    const harness = system as unknown as WaterMaterialHarness;
    harness.normalTex = createTexture();
    harness.flowTex = createTexture();
    harness.foamTex = createTexture();

    const material = harness.createOceanMaterial();
    harness.oceanMaterial = material;

    expect(material.positionNode).toBeTruthy();
    expect(material.opacityNode).toBeTruthy();
    expect(material.outputNode).toBeTruthy();
    expect(harness.oceanUniforms?.time.value).toBe(0);
    expect(harness.oceanUniforms?.windStrength.value).toBe(1.2);
    expect(harness.oceanUniforms?.sunDirection.value).toBeInstanceOf(
      THREE.Vector3,
    );

    system.update(0.25);
    expect(harness.oceanUniforms?.time.value).toBe(0.25);
    expect(typeof harness.oceanUniforms?.windStrength.value).toBe("number");

    system.destroy();
  });
});
