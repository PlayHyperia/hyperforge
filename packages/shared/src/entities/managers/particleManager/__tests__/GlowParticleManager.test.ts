import { afterEach, describe, expect, it, vi } from "vitest";

import * as THREE from "../../../../extras/three/three";
import { GlowParticleManager } from "../GlowParticleManager";

describe("GlowParticleManager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs all five typed TSL particle pools", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scene = new THREE.Scene();
    const manager = new GlowParticleManager(scene);
    const meshes = scene.children.filter(
      (child): child is THREE.InstancedMesh =>
        child instanceof THREE.InstancedMesh,
    );

    expect(meshes).toHaveLength(5);
    for (const mesh of meshes) {
      const material = mesh.material as THREE.Material & {
        positionNode?: unknown;
        colorNode?: unknown;
        opacityNode?: unknown;
      };
      expect(material.positionNode).toBeTruthy();
      expect(material.colorNode).toBeTruthy();
      expect(material.opacityNode).toBeTruthy();
      expect(mesh.frustumCulled).toBe(false);
    }

    manager.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it("registers, updates, moves, unregisters, and disposes both presets", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const manager = new GlowParticleManager(scene);

    manager.registerGlow("altar", {
      preset: "altar",
      position: { x: 1, y: 2, z: 3 },
    });
    manager.registerGlow("fire", {
      preset: "fire",
      position: { x: -1, y: 0, z: 4 },
    });

    expect(() => manager.update(1 / 60, camera)).not.toThrow();
    expect(() => manager.moveGlow("fire", { x: 8, y: 1, z: -2 })).not.toThrow();
    expect(() => manager.unregisterGlow("altar")).not.toThrow();
    expect(() => manager.unregisterGlow("fire")).not.toThrow();

    manager.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
