import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { World } from "../../../../core/World";
import { DataManager } from "../../../../data/DataManager";
import type { FlatZone } from "../../../../types/world/terrain";
import type { CompactPondDockPlacement } from "../../../../types/world/world-types";
import { TerrainSystem } from "../TerrainSystem";
import { ElevatedWaterBody } from "../WaterBodyRegistry";
import {
  groundCompactPondDock,
  POND_DOCK_SURFACE,
} from "../CompactPondDockLayout";
import THREE from "../../../../extras/three/three";
import { getCompactPondDockDirection } from "../DockDefinition";
import { CollisionMatrix } from "../../movement/CollisionMatrix";

// These exact cardinal/tile-aligned positions passed the retained 250-position
// real-basin CPU survey (dock-layout-survey01). They are test placements, not a
// promotion into the live manifest or a claim of scene/navigation acceptance.
const placements: readonly CompactPondDockPlacement[] = Object.freeze([
  Object.freeze({
    id: "haven-fishing-landing",
    x: 390,
    z: 424.5,
    rotation: 90,
    recipeId: "haven-fishing-landing-v1",
  }),
  Object.freeze({
    id: "haven-reed-jetty",
    x: 433,
    z: 415.5,
    rotation: 270,
    recipeId: "haven-reed-jetty-v1",
  }),
]);

const source = readFileSync(
  new URL("../__fixtures__/inland-pond-basin-candidate.json", import.meta.url),
  "utf8",
);
const candidate = JSON.parse(source) as {
  flatZone: FlatZone;
  waterBody: Omit<ElevatedWaterBody, "radiusSq" | "sourceType">;
};

async function fixture() {
  await DataManager.getInstance().initialize();
  const world = new World();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  await terrain.init();
  terrain["loadWaterBodiesFromManifest"]();
  terrain["loadFlatZonesFromManifest"]();
  terrain.unregisterFlatZone("haven_pond_floor");
  terrain.registerFlatZone(candidate.flatZone);
  const body = new ElevatedWaterBody({
    ...candidate.waterBody,
    radiusSq: candidate.waterBody.radius ** 2,
    sourceType: "explicit",
  });
  return {
    world,
    terrain,
    body,
    ground: terrain.captureCanonicalGroundLease(),
  };
}

describe("canonical inland pond dock layout (CPU geometry, not native qualification)", () => {
  it.each(placements)(
    "retains +Y triangles, actual ray/height agreement, safe shore entry and ground posts for $id",
    async (descriptor) => {
      const f = await fixture();
      const geometry = new THREE.BufferGeometry();
      const material = new THREE.MeshBasicMaterial();
      try {
        const layout = groundCompactPondDock(descriptor, f.body, f.ground);
        const direction = getCompactPondDockDirection(descriptor.rotation);
        const point = (forward: number, across: number) => ({
          x: descriptor.x + direction.x * forward - direction.z * across,
          z: descriptor.z + direction.z * forward + direction.x * across,
        });
        geometry.setAttribute(
          "position",
          new THREE.BufferAttribute(layout.positions, 3),
        );
        geometry.setIndex(new THREE.BufferAttribute(layout.indices, 1));
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, material);
        mesh.updateMatrixWorld(true);
        const beforePositions = layout.positions.slice(),
          beforeIndices = layout.indices.slice();
        const ray = new THREE.Raycaster(
          new THREE.Vector3(),
          new THREE.Vector3(0, -1, 0),
        );
        const a = new THREE.Vector3(),
          b = new THREE.Vector3(),
          c = new THREE.Vector3();
        for (let i = 0; i < layout.indices.length; i += 3) {
          a.fromBufferAttribute(
            geometry.getAttribute("position"),
            layout.indices[i],
          );
          b.fromBufferAttribute(
            geometry.getAttribute("position"),
            layout.indices[i + 1],
          );
          c.fromBufferAttribute(
            geometry.getAttribute("position"),
            layout.indices[i + 2],
          );
          expect(b.sub(a).cross(c.sub(a)).y).toBeGreaterThan(0);
        }
        let rays = 0,
          maxRayDifference = 0,
          minApronClearance = Infinity,
          minDeckClearance = Infinity;
        for (let forward = -2; forward <= 6; forward += 0.125)
          for (let across = -1.5; across <= 1.5; across += 0.125) {
            const p = point(forward, across),
              y = layout.heightAt(p.x, p.z)!;
            ray.ray.origin.set(p.x, 40, p.z);
            const hits = ray.intersectObject(mesh, false);
            expect(hits.length).toBeGreaterThan(0);
            const difference = Math.abs(hits[0].point.y - y);
            expect(difference).toBeLessThan(1e-10);
            maxRayDifference = Math.max(maxRayDifference, difference);
            const clearance = y - f.ground.sampleHeight(p.x, p.z);
            if (forward < 0) {
              minApronClearance = Math.min(minApronClearance, clearance);
              expect(clearance).toBeGreaterThanOrEqual(0.003);
            } else {
              minDeckClearance = Math.min(minDeckClearance, clearance);
              expect(clearance).toBeGreaterThanOrEqual(
                POND_DOCK_SURFACE.boardThickness - 1e-6,
              );
            }
            rays++;
          }
        for (const [forward, across] of [
          [-2.001, 0],
          [6.001, 0],
          [2, -1.501],
          [2, 1.501],
        ]) {
          const p = point(forward, across);
          expect(layout.heightAt(p.x, p.z)).toBeNull();
        }
        expect(() => layout.heightAt(NaN, descriptor.z)).toThrow(/finite/);
        expect(layout.positions).toEqual(beforePositions);
        expect(layout.indices).toEqual(beforeIndices);
        expect(layout.positions.length / 3).toBe(119);
        expect(layout.indices.length / 3).toBe(192);
        expect(layout.tiles).toHaveLength(24);
        expect(new Set(layout.tiles.map((t) => `${t.x},${t.z}`)).size).toBe(24);
        for (const tile of layout.tiles) {
          expect(Number.isInteger(tile.x) && Number.isInteger(tile.z)).toBe(
            true,
          );
          expect(layout.heightAt(tile.x + 0.5, tile.z + 0.5)).not.toBeNull();
        }
        let maxEntryStep = 0;
        for (let across = -1.5; across <= 1.5; across += 0.5) {
          const start = point(-2, across),
            approach = point(-2.25, across);
          const groundY = f.ground.sampleHeight(start.x, start.z);
          expect(groundY).toBeGreaterThanOrEqual(f.body.surfaceY + 0.04);
          expect(
            Math.abs(
              layout.heightAt(start.x, start.z)! -
                groundY -
                POND_DOCK_SURFACE.groundClearance,
            ),
          ).toBeLessThan(2e-6);
          const step = Math.abs(
            f.ground.sampleHeight(approach.x, approach.z) - groundY,
          );
          expect(step).toBeLessThanOrEqual(0.12);
          maxEntryStep = Math.max(maxEntryStep, step);
        }
        expect(layout.posts).toHaveLength(8);
        expect(layout.posts.map(({ x, z }) => ({ x, z }))).toEqual(
          [0.5, 2, 4, 5.5].flatMap((forward) =>
            [-1.14, 1.14].map((across) => point(forward, across)),
          ),
        );
        // Current compact recipe: 0.18m post half-width plus 0.05m cap
        // overhang. The full cap, not only its centre, must be on the flat
        // retained platform, never above the apron or beyond the waterward tip.
        const capHalfExtent = 0.18 + 0.05;
        let minCapCoreMargin = Infinity;
        for (const post of layout.posts) {
          expect(post.bottomY).toBe(
            f.ground.sampleHeight(post.x, post.z) - 0.15,
          );
          expect(layout.deckY - post.bottomY).toBeGreaterThanOrEqual(0.2);
          expect(layout.deckY - post.bottomY).toBeLessThanOrEqual(5);
          const dx = post.x - descriptor.x;
          const dz = post.z - descriptor.z;
          const forward = dx * direction.x + dz * direction.z;
          const across = -dx * direction.z + dz * direction.x;
          for (const df of [-capHalfExtent, capHalfExtent]) {
            for (const da of [-capHalfExtent, capHalfExtent]) {
              const capForward = forward + df;
              const capAcross = across + da;
              expect(capForward).toBeGreaterThan(0);
              expect(capForward).toBeLessThan(POND_DOCK_SURFACE.length);
              expect(Math.abs(capAcross)).toBeLessThan(
                POND_DOCK_SURFACE.width / 2,
              );
              const corner = point(capForward, capAcross);
              expect(layout.heightAt(corner.x, corner.z)).toBe(layout.deckY);
              minCapCoreMargin = Math.min(
                minCapCoreMargin,
                capForward,
                POND_DOCK_SURFACE.length - capForward,
                POND_DOCK_SURFACE.width / 2 - Math.abs(capAcross),
              );
            }
          }
        }
        console.info(
          "dock-layout-ground-proof",
          JSON.stringify({
            id: descriptor.id,
            descriptor,
            fixtureSha256: createHash("sha256").update(source).digest("hex"),
            rays,
            vertices: 119,
            triangles: 192,
            tiles: 24,
            bounds: layout.bounds,
            deckY: layout.deckY,
            maxRayDifference,
            maxEntryStep,
            minApronClearance,
            minDeckClearance,
            capCornersOnFlatCore: layout.posts.length * 4,
            minCapCoreMargin,
            postHeightRange: [
              Math.min(
                ...layout.posts.map((post) => layout.deckY - post.bottomY),
              ),
              Math.max(
                ...layout.posts.map((post) => layout.deckY - post.bottomY),
              ),
            ],
            nativeOrNavigationApproval: false,
          }),
        );
      } finally {
        geometry.dispose();
        material.dispose();
        f.world.destroy();
      }
    },
  );

  it.each(placements)(
    "matches each authored rail to dual-tile walls without sealing shore entry or casting bays: $id",
    async (descriptor) => {
      const f = await fixture();
      try {
        const layout = groundCompactPondDock(descriptor, f.body, f.ground);
        const d = getCompactPondDockDirection(descriptor.rotation),
          perp = { x: -d.z, z: d.x };
        const point = (forward: number, across: number) => ({
          x: descriptor.x + d.x * forward + perp.x * across,
          z: descriptor.z + d.z * forward + perp.z * across,
        });
        const collision = new CollisionMatrix();
        for (const wall of layout.walls)
          collision.addFlags(wall.x, wall.z, wall.flags);
        expect(layout.rails).toHaveLength(
          descriptor.recipeId === "haven-fishing-landing-v1" ? 2 : 3,
        );
        expect(layout.walls).toHaveLength(
          descriptor.recipeId === "haven-fishing-landing-v1" ? 16 : 20,
        );
        for (let forward = 0.5; forward < 6; forward++)
          for (const side of [-1, 1]) {
            const railExpected =
              descriptor.recipeId === "haven-fishing-landing-v1"
                ? forward < 4
                : side === -1 || forward < 2 || forward > 4;
            const inside = point(forward, side),
              outside = point(forward, side * 2);
            expect(
              collision.isBlocked(
                Math.floor(inside.x),
                Math.floor(inside.z),
                Math.floor(outside.x),
                Math.floor(outside.z),
              ),
            ).toBe(railExpected);
            expect(
              collision.isBlocked(
                Math.floor(outside.x),
                Math.floor(outside.z),
                Math.floor(inside.x),
                Math.floor(inside.z),
              ),
            ).toBe(railExpected);
          }
        for (const across of [-1, 0, 1]) {
          const shore = point(-2.5, across),
            entry = point(-1.5, across),
            end = point(5.5, across),
            water = point(6.5, across);
          expect(
            collision.isBlocked(
              Math.floor(shore.x),
              Math.floor(shore.z),
              Math.floor(entry.x),
              Math.floor(entry.z),
            ),
          ).toBe(false);
          expect(
            collision.isBlocked(
              Math.floor(end.x),
              Math.floor(end.z),
              Math.floor(water.x),
              Math.floor(water.z),
            ),
          ).toBe(false);
        }
        // This proves edge ownership only. The real owner's surrounding WATER
        // flags remain responsible for preventing a walk into open water.
      } finally {
        f.world.destroy();
      }
    },
  );

  it("rejects actual dry, bank-clipping and overdeep support locations and stale canonical leases", async () => {
    const f = await fixture();
    try {
      const jetty = placements[1];
      expect(() =>
        groundCompactPondDock({ ...jetty, x: 410 }, f.body, f.ground),
      ).toThrow(/dry, gently graded/);
      expect(() =>
        groundCompactPondDock({ ...jetty, x: 435 }, f.body, f.ground),
      ).toThrow(/dry, gently graded/);
      // A real registered mound below a retained deck vertex isolates clipping
      // without depending on the surrounding historical/candidate outer grade.
      f.terrain.registerFlatZone({
        id: "dock-clipping-negative-control",
        centerX: jetty.x - 1,
        centerZ: jetty.z,
        width: 0.1,
        depth: 0.1,
        height: 25,
        blendRadius: 0.01,
        radialPond: {
          bedRadius: 0.02,
          bankInnerRadius: 0.03,
          bankOuterRadius: 0.04,
          bankHeight: 25.1,
        },
      });
      const clippedGround = f.terrain.captureCanonicalGroundLease();
      expect(clippedGround.sampleHeight(jetty.x - 1, jetty.z)).toBe(25);
      expect(() => groundCompactPondDock(jetty, f.body, clippedGround)).toThrow(
        /underside intersects/,
      );
      f.terrain.unregisterFlatZone("dock-clipping-negative-control");
      const old = f.terrain.captureCanonicalGroundLease();
      const original = groundCompactPondDock(jetty, f.body, old);
      const deepest = original.posts[original.posts.length - 1];
      // A genuine small registered radial depression at the last off-grid
      // post exercises the depth guard without substituting a sampler/mock.
      // A rectangular zone is only an underlying grade beneath a radial pond,
      // so this negative control deliberately uses the real radial authority.
      f.terrain.registerFlatZone({
        id: "dock-depth-negative-control",
        centerX: deepest.x,
        centerZ: deepest.z,
        width: 0.1,
        depth: 0.1,
        height: 10,
        blendRadius: 0.01,
        radialPond: {
          bedRadius: 0.02,
          bankInnerRadius: 0.03,
          bankOuterRadius: 0.04,
          bankHeight: 25.7,
        },
      });
      expect(old.isCurrent()).toBe(false);
      expect(() => groundCompactPondDock(jetty, f.body, old)).toThrow(
        /current canonical ground/,
      );
      const fresh = f.terrain.captureCanonicalGroundLease();
      expect(fresh.sampleHeight(deepest.x, deepest.z)).toBe(10);
      expect(() => groundCompactPondDock(jetty, f.body, fresh)).toThrow(
        /post.*depth/,
      );
    } finally {
      f.world.destroy();
    }
  });
});
