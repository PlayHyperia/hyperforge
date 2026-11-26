import { afterEach, describe, expect, it, vi } from "vitest";

import * as THREE from "../../../../extras/three/three";
import {
  WaterParticleManager,
  getFishingSpotVariant,
} from "../WaterParticleManager";

describe("WaterParticleManager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs all four typed TSL water-effect pools", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scene = new THREE.Scene();
    const manager = new WaterParticleManager(scene);
    const meshes = scene.children.filter(
      (child): child is THREE.InstancedMesh =>
        child instanceof THREE.InstancedMesh,
    );

    expect(meshes).toHaveLength(4);
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

  it("runs the fishing-spot lifecycle for every resource variant", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const manager = new WaterParticleManager(scene);
    const resourceIds = ["fishing_net", "fishing_fly", "fishing_bait"];

    resourceIds.forEach((resourceId, index) => {
      manager.registerSpot({
        entityId: `spot-${index}`,
        position: { x: index, y: 2, z: -index },
        resourceId,
      });
    });

    expect(() => manager.update(1 / 30, camera)).not.toThrow();
    expect(() =>
      manager.moveSpot("spot-1", { x: 7, y: 3, z: -4 }),
    ).not.toThrow();
    resourceIds.forEach((_, index) => manager.unregisterSpot(`spot-${index}`));

    manager.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it("keeps faster fly-fishing effects denser than net effects", () => {
    const net = getFishingSpotVariant("fishing_net");
    const fly = getFishingSpotVariant("fishing_fly");

    expect(fly.rippleSpeed).toBeGreaterThan(net.rippleSpeed);
    expect(fly.splashCount).toBeGreaterThan(net.splashCount);
    expect(fly.bubbleCount).toBeGreaterThan(net.bubbleCount);
    expect(fly.burstIntervalMax).toBeLessThan(net.burstIntervalMax);
  });
});
