import { describe, expect, it } from "vitest";
import type { Node } from "three/webgpu";
import THREE from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import { ResourceEntity } from "../../ResourceEntity";
import { EntityType, ResourceType } from "../../../../types/entities";
import { TerrainSystem } from "../../../../systems/shared/world/TerrainSystem";
import { ParticleSystem } from "../../../../systems/shared/presentation/ParticleSystem";
import {
  validateWorldTerrainProfile,
  type WorldTerrainProfile,
} from "../../../../systems/shared/world/WorldTerrainProfile";

function profile(candidate: boolean, id = "compact-duel-island-v6") {
  const { southernMeadow: _existingCandidate, ...existing } =
    DataManager.getWorldTerrainProfile();
  return validateWorldTerrainProfile({
    ...existing,
    id,
    ...(candidate
      ? {
          southernMeadow: {
            schemaVersion: 1,
            minX: 304,
            maxX: 500,
            minZ: 345,
            maxZ: 535,
            featherX: 24,
            featherZ: 24,
            northHeight: 26.8,
            southHeight: 25.3,
            crossFall: 1,
            rollAmplitude: 0.65,
            rollWavelength: 100,
          },
        }
      : {}),
  });
}

async function scene(selected: WorldTerrainProfile | null) {
  const world = new World();
  const terrain = selected ? new TerrainSystem(world) : undefined;
  if (terrain) {
    // Admitted fixture data in the actual owner, not a mocked profile getter or
    // replacement system. Global startup manifests/identity are left untouched.
    (
      terrain as unknown as { activeTerrainProfile: WorldTerrainProfile }
    ).activeTerrainProfile = selected!;
    world.addSystem("terrain", terrain);
    expect(terrain.getWorldTerrainProfile()).toBe(selected);
  }
  const particles = new ParticleSystem(world);
  world.addSystem("particle", particles);
  await particles.init();
  const entity = new ResourceEntity(world, {
    id: "fish-material-lifecycle",
    name: "Net Fishing Spot",
    type: EntityType.RESOURCE,
    position: { x: 340.5, y: 27.8, z: 307.5 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    visible: true,
    interactable: true,
    interactionType: null,
    interactionDistance: 2,
    description: "Real fishing visual lifecycle fixture",
    model: null,
    resourceType: ResourceType.FISHING_SPOT,
    resourceId: "fishing_spot_net",
    harvestSkill: "fishing",
    requiredLevel: 1,
    harvestTime: 3000,
    respawnTime: 0,
    harvestYield: [],
    depleted: false,
    lastHarvestTime: 0,
    properties: {
      movementComponent: null,
      combatComponent: null,
      healthComponent: null,
      visualComponent: null,
      health: { current: 0, max: 0 },
      level: 1,
      resourceType: ResourceType.FISHING_SPOT,
      harvestable: true,
      respawnTime: 0,
      toolRequired: "small_fishing_net",
      skillRequired: "fishing",
      xpReward: 0,
    },
  });
  world.stage.scene.add(entity.node);
  await entity.init();
  const mesh = entity.node.getObjectByName("FishingSpotGlow");
  if (
    !(mesh instanceof THREE.Mesh) ||
    !(mesh.geometry instanceof THREE.CircleGeometry) ||
    !(mesh.material instanceof THREE.MeshBasicNodeMaterial)
  )
    throw new Error("Missing actual fishing visual");
  const material = mesh.material;
  return {
    world,
    entity,
    mesh,
    material,
    particles,
    dispose() {
      entity.destroy();
      particles.destroy();
      terrain?.destroy();
    },
  };
}

function graph(root: Node): Set<Node> {
  const result = new Set<Node>();
  const visit = (node: Node) => {
    if (result.has(node)) return;
    result.add(node);
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return result;
}

// Inspect the actual numeric TSL graph. This is not a renderer/GPU substitute;
// unknown operations fail rather than silently passing a fake shader result.
function evaluate(
  node: Node,
  coordinates: readonly number[],
  opacity: number,
): number[] {
  if (node === THREE.TSL.materialOpacity) return [opacity];
  if (
    node.type === "AttributeNode" &&
    Reflect.get(node, "_attributeName") === "uv"
  )
    return [...coordinates];
  const literal: unknown = Reflect.get(node, "value");
  if (typeof literal === "number") return [literal];
  const child = (key: string) => {
    const value: unknown = Reflect.get(node, key);
    if (!(value instanceof THREE.Node))
      throw new Error(`Missing actual ${key}`);
    return evaluate(value, coordinates, opacity);
  };
  if (node.type === "ConvertNode" || node.type === "VarNode")
    return child("node");
  const pair = (fn: (a: number, b: number) => number) => {
    const a = child("aNode"),
      b = child("bNode");
    return Array.from({ length: Math.max(a.length, b.length) }, (_, i) =>
      fn(a[a.length === 1 ? 0 : i], b[b.length === 1 ? 0 : i]),
    );
  };
  if (Reflect.get(node, "op") === "-") return pair((a, b) => a - b);
  if (Reflect.get(node, "op") === "*") return pair((a, b) => a * b);
  if (Reflect.get(node, "method") === "length")
    return [Math.hypot(...child("aNode"))];
  if (Reflect.get(node, "method") === "pow") return pair(Math.pow);
  if (Reflect.get(node, "method") === "smoothstep") {
    const a = child("aNode")[0],
      b = child("bNode")[0],
      x = child("cNode")[0];
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return [t * t * (3 - 2 * t)];
  }
  throw new Error(`Unsupported actual node ${node.type}`);
}

describe("actual fishing spot visual candidate", () => {
  it("feathers one desaturated non-depth-writing disturbance while preserving the complete picking disk", async () => {
    const fixture = await scene(profile(true));
    const { world, entity, mesh, material } = fixture;
    try {
      expect(material.color.getHex()).toBe(0x92aaa7);
      expect(material.opacity).toBe(0.07);
      expect(material.transparent).toBe(true);
      expect(material.depthWrite).toBe(false);
      expect(material.depthTest).toBe(true);
      expect(material.side).toBe(THREE.DoubleSide);
      expect(material.blending).toBe(THREE.NormalBlending);
      expect(material.premultipliedAlpha).toBe(false);
      expect(material.map).toBeNull();
      const alpha = material.opacityNode;
      expect(alpha).toBeInstanceOf(THREE.Node);
      const nodes = graph(alpha!);
      expect(nodes.has(THREE.TSL.materialOpacity)).toBe(true);
      expect(
        [...nodes].some((n) => Reflect.get(n, "isTextureNode") === true),
      ).toBe(false);
      let previous = 1;
      for (let i = 0; i <= 100; i++) {
        const radius = i / 100;
        const t = Math.max(0, Math.min(1, (radius - 0.12) / 0.88));
        const expected = Math.pow(1 - t * t * (3 - 2 * t), 1.5) * 0.07;
        const value = evaluate(alpha!, [0.5 + radius / 2, 0.5], 0.07)[0];
        expect(value).toBeCloseTo(expected, 13);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(previous);
        previous = value;
      }
      expect(previous).toBe(0);
      expect(evaluate(alpha!, [0.5, 0.5], 0.07)).toEqual([0.07]);
      expect(evaluate(alpha!, [1, 1], 0.07)).toEqual([0]);
      world.time += 1 / 60;
      entity.update(1 / 60);
      expect(material.opacity).toBeGreaterThanOrEqual(0.05);
      expect(material.opacity).toBeLessThanOrEqual(0.09);
      expect(evaluate(alpha!, [0.5, 0.5], material.opacity)).toEqual([
        material.opacity,
      ]);
      expect(mesh.geometry.parameters).toMatchObject({
        radius: 0.6,
        segments: 16,
      });
      expect(mesh.position.y).toBe(0.05);
      expect(mesh.rotation.x).toBe(-Math.PI / 2);
      expect(mesh.userData).toEqual({
        type: "resource",
        entityId: entity.id,
        name: "Net Fishing Spot",
        interactable: true,
        resourceType: ResourceType.FISHING_SPOT,
        depleted: false,
      });
      world.stage.scene.updateMatrixWorld(true);
      for (const offset of [0, 0.55]) {
        const ray = new THREE.Raycaster(
          new THREE.Vector3(entity.position.x + offset, 30, entity.position.z),
          new THREE.Vector3(0, -1, 0),
        );
        expect(ray.intersectObject(mesh).length).toBeGreaterThan(0);
      }
    } finally {
      fixture.dispose();
    }
  });

  it("preserves the historical material for missing terrain, missing selection, and a different layout", async () => {
    for (const selected of [
      null,
      profile(false),
      profile(true, "unrelated-meadow-layout"),
    ]) {
      const fixture = await scene(selected);
      try {
        expect(fixture.material.color.getHex()).toBe(0x4488ff);
        expect(fixture.material.opacity).toBe(0.3);
        expect(fixture.material.opacityNode).toBeNull();
        expect(fixture.material.depthWrite).toBe(true);
        fixture.world.time += 1 / 60;
        fixture.entity.update(1 / 60);
        expect(fixture.material.opacity).toBeGreaterThanOrEqual(0.12);
        expect(fixture.material.opacity).toBeLessThanOrEqual(0.24);
      } finally {
        fixture.dispose();
      }
    }
  });

  for (const candidate of [false, true])
    it(`preserves actual particle ownership, depletion, respawn and disposal (candidate ${candidate})`, async () => {
      const fixture = await scene(profile(candidate));
      const { world, entity, mesh, material, particles } = fixture;
      try {
        const manager = particles.manager!;
        const ownership = Reflect.get(manager, "ownership") as ReadonlyMap<
          string,
          string
        >;
        const water = Reflect.get(manager, "waterManager") as object;
        const spots = Reflect.get(water, "activeSpots") as ReadonlyMap<
          string,
          object
        >;
        expect(ownership.get(entity.id)).toBe("water");
        expect(spots.size).toBe(1);
        const owner = spots.get(entity.id);
        world.time += 1 / 60;
        entity.update(1 / 60);
        expect(spots.get(entity.id)).toBe(owner);
        const ripple = world.stage.scene.children.find(
          (child) =>
            child instanceof THREE.InstancedMesh &&
            child.geometry.hasAttribute("rippleParams"),
        );
        if (!(ripple instanceof THREE.InstancedMesh))
          throw new Error("Missing real ripple pool");
        const params = ripple.geometry.getAttribute("rippleParams");
        const activeRipples = () =>
          Array.from({ length: params.count }, (_, i) => params.getY(i)).filter(
            (v) => v > 0,
          ).length;
        expect(activeRipples()).toBe(2);
        let geometryDisposed = 0,
          materialDisposed = 0;
        mesh.geometry.addEventListener("dispose", () => geometryDisposed++);
        material.addEventListener("dispose", () => materialDisposed++);
        entity.updateFromNetwork({ depleted: true });
        await Promise.resolve();
        await Promise.resolve();
        expect(mesh.visible).toBe(false);
        expect(ownership.has(entity.id)).toBe(false);
        expect(spots.size).toBe(0);
        expect(activeRipples()).toBe(0);
        world.time += 1 / 60;
        entity.update(1 / 60);
        expect(spots.size).toBe(0);
        entity.updateFromNetwork({ depleted: false });
        await Promise.resolve();
        await Promise.resolve();
        expect(entity.node.getObjectByName("FishingSpotGlow")).toBe(mesh);
        expect(mesh.visible).toBe(true);
        expect(ownership.get(entity.id)).toBe("water");
        expect(spots.size).toBe(1);
        expect(activeRipples()).toBe(2);
        entity.destroy();
        expect(geometryDisposed).toBe(1);
        expect(materialDisposed).toBe(1);
        expect(mesh.parent).toBeNull();
        expect(ownership.size).toBe(0);
        expect(spots.size).toBe(0);
        expect(activeRipples()).toBe(0);
        expect(world.hot.has(entity)).toBe(false);
        entity.destroy();
        expect(geometryDisposed).toBe(1);
        expect(materialDisposed).toBe(1);
      } finally {
        fixture.dispose();
      }
    });
});
