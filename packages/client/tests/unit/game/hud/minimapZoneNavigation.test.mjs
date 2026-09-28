import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Matrix4, OrthographicCamera, Vector3 } from "three";
import {
  getMinimapZoneKind,
  MINIMAP_ZONE_INSET,
  MinimapZoneNavigationState,
  updateMinimapZoneNavigation,
} from "../../../../src/game/hud/minimapZoneNavigation.ts";

function area(id, x, z, safeZone = true, pvpEnabled = false) {
  return {
    id,
    safeZone,
    pvpEnabled,
    bounds: { minX: x - 1, maxX: x + 1, minZ: z - 1, maxZ: z + 1 },
  };
}

function camera(extent = 100, yaw = 0, x = 0, z = 0) {
  const value = new OrthographicCamera(
    -extent,
    extent,
    extent,
    -extent,
    0.1,
    2000,
  );
  value.position.set(x, 500, z);
  value.up.set(Math.sin(yaw), 0, -Math.cos(yaw));
  value.lookAt(x, 0, z);
  value.updateMatrixWorld();
  return value;
}

function layout(
  areas,
  cam = camera(),
  width = 200,
  height = 200,
  state = new MinimapZoneNavigationState(),
) {
  const matrix = new Matrix4().multiplyMatrices(
    cam.projectionMatrix,
    cam.matrixWorldInverse,
  );
  updateMinimapZoneNavigation(
    state,
    areas,
    matrix.elements,
    cam.position.x,
    cam.position.z,
    width,
    height,
  );
  return state;
}

const active = (state) => state.markers.slice(0, state.count);
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

describe("minimap zone navigation: pure CPU layout, not render verification", () => {
  it("uses a shield for safe non-PvP areas, arena precedence and no hazard labels", () => {
    assert.equal(getMinimapZoneKind(area("haven_pond", 0, 0)), "safe");
    const unspecifiedPvP = area("safe_default", 0, 0);
    delete unspecifiedPvP.pvpEnabled;
    assert.equal(getMinimapZoneKind(unspecifiedPvP), "safe");
    assert.equal(getMinimapZoneKind(area("duel_arena", 0, 0)), "arena");
    assert.equal(
      getMinimapZoneKind(area("duel_arena", 0, 0, false, true)),
      "arena",
    );
    assert.equal(getMinimapZoneKind(area("wilderness", 0, 0, false)), null);
    assert.equal(getMinimapZoneKind(area("pvp", 0, 0, true, true)), null);
  });

  it("projects actual bounds centers, not record keys or guessed town locations", () => {
    const state = layout({ arbitraryKey: area("haven_pond", 30, -20) });
    assert.equal(state.count, 1);
    assert.equal(state.markers[0].id, "haven_pond");
    close(state.markers[0].x, 130);
    close(state.markers[0].y, 80);
    assert.equal(state.markers[0].offMap, false);
  });

  it("agrees with actual Three projection through zoom, yaw, translation and rectangular sizes", () => {
    for (const extent of [20, 60, 500]) {
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 3]) {
        for (const [width, height] of [
          [200, 200],
          [320, 96],
          [80, 240],
        ]) {
          const cam = camera(extent, yaw, 385, 374);
          const x = 385 + extent * 0.15;
          const z = 374 - extent * 0.1;
          const expected = new Vector3(x, 0, z).project(cam);
          const marker = layout(
            { pond: area("haven_pond", x, z) },
            cam,
            width,
            height,
          ).markers[0];
          close(marker.x, (expected.x * 0.5 + 0.5) * width);
          close(marker.y, (-expected.y * 0.5 + 0.5) * height);
          assert.equal(marker.offMap, false);
        }
      }
    }
  });

  it("keeps exact inset-edge destinations in place and clamps the next point", () => {
    const x = 100 - MINIMAP_ZONE_INSET;
    const inside = layout({ a: area("a", x, 0) }).markers[0];
    assert.equal(inside.offMap, false);
    close(inside.x, 200 - MINIMAP_ZONE_INSET);
    const outside = layout({ a: area("a", x + 0.01, 0) }).markers[0];
    assert.equal(outside.offMap, true);
    close(outside.x, 200 - MINIMAP_ZONE_INSET);
  });

  it("clamps all edge directions without clipping glyph or chevron, including non-square maps", () => {
    for (const [width, height] of [
      [200, 200],
      [320, 80],
      [80, 320],
    ]) {
      for (let step = 0; step < 64; step++) {
        const a = (step * Math.PI) / 32;
        const marker = layout(
          { a: area("a", Math.cos(a) * 1000, Math.sin(a) * 1000) },
          camera(),
          width,
          height,
        ).markers[0];
        assert.equal(marker.offMap, true);
        assert.ok(marker.x >= MINIMAP_ZONE_INSET - 1e-8);
        assert.ok(marker.x <= width - MINIMAP_ZONE_INSET + 1e-8);
        assert.ok(marker.y >= MINIMAP_ZONE_INSET - 1e-8);
        assert.ok(marker.y <= height - MINIMAP_ZONE_INSET + 1e-8);
        close(Math.hypot(marker.directionX, marker.directionY), 1);
        for (const [along, across] of [
          [11, 0],
          [8, 3],
          [8, -3],
        ]) {
          const x =
            marker.x + marker.directionX * along - marker.directionY * across;
          const y =
            marker.y + marker.directionY * along + marker.directionX * across;
          // Includes 1.5px half-width of the outline stroke.
          assert.ok(x >= 1.5 && x <= width - 1.5);
          assert.ok(y >= 1.5 && y <= height - 1.5);
        }
      }
    }
  });

  it("preserves the projected direction under rotation when clamping", () => {
    const cam = camera(20, Math.PI / 3, 80, -20);
    const x = -500;
    const z = 330;
    const projected = new Vector3(x, 0, z).project(cam);
    const dx = projected.x * 160;
    const dy = -projected.y * 40;
    const length = Math.hypot(dx, dy);
    const marker = layout({ a: area("a", x, z) }, cam, 320, 80).markers[0];
    close(marker.directionX, dx / length);
    close(marker.directionY, dy / length);
    close((marker.x - 160) * dy, (marker.y - 40) * dx);
  });

  it("keeps all in-bounds POIs and a single nearest off-map kind not already visible", () => {
    const areas = {
      safeA: area("safe_a", 10, 10),
      safeB: area("safe_b", -10, 10),
      closerSafe: area("closer_safe", 100, 0),
      arena: area("duel_arena", 200, 0),
    };
    assert.deepEqual(
      active(layout(areas)).map((m) => [m.id, m.offMap]),
      [
        ["safe_a", false],
        ["safe_b", false],
        ["duel_arena", true],
      ],
    );
  });

  it("does not produce redundant edge cues when both kinds are visible", () => {
    const state = layout({
      safe: area("safe", 0, 0),
      arena: area("duel_arena", 20, 0),
      remote: area("remote", 500, 0),
    });
    assert.equal(state.count, 2);
    assert.ok(active(state).every((marker) => !marker.offMap));
  });

  it("selects by world distance rather than stretched pixel distance", () => {
    const state = layout(
      { near: area("safe", 110, 0), far: area("duel_arena", 0, 150) },
      camera(),
      400,
      80,
    );
    assert.equal(state.count, 1);
    assert.equal(state.markers[0].id, "safe");
  });

  it("breaks equal-distance ties by stable area ID independent of insertion order", () => {
    const a = area("a_safe", 200, 0);
    const b = area("b_safe", -200, 0);
    const arena = area("duel_arena", 0, 200);
    for (const areas of [
      { b, arena, a },
      { a, b, arena },
      { arena, a, b },
    ]) {
      assert.equal(layout(areas).markers[0].id, "a_safe");
    }
  });

  it("clears stale layout and reuses storage after actual manifest replacement/removal", () => {
    const state = layout({ a: area("a", 0, 0), b: area("b", 10, 0) });
    const first = state.markers[0];
    const areas = { changed: area("changed", 20, 0) };
    layout(areas, camera(), 200, 200, state);
    assert.equal(state.count, 1);
    assert.equal(state.markers[0], first);
    assert.equal(first.id, "changed");
    close(first.x, 120);
    layout({}, camera(), 200, 200, state);
    assert.equal(state.count, 0);
  });

  it("ignores inherited areas and invalid bounds without hiding valid POIs", () => {
    const areas = Object.assign(
      Object.create({ inherited: area("inherited", 0, 0) }),
      {
        valid: area("valid", 20, 0),
        inverted: {
          ...area("inverted", 0, 0),
          bounds: { minX: 3, maxX: 2, minZ: 0, maxZ: 1 },
        },
        nan: area("nan", NaN, 0),
        infinite: area("infinite", Infinity, 0),
      },
    );
    assert.deepEqual(
      active(layout(areas)).map((marker) => marker.id),
      ["valid"],
    );
  });

  it("clears stale state for invalid dimensions, origin or projection", () => {
    const areas = { valid: area("valid", 0, 0) };
    const identity = new Matrix4().elements;
    for (const [matrix, x, z, width, height] of [
      [identity, 0, 0, 26, 200],
      [identity, 0, 0, 200, 0],
      [identity, 0, 0, NaN, 200],
      [identity, Infinity, 0, 200, 200],
      [identity, 0, NaN, 200, 200],
      [[], 0, 0, 200, 200],
      [identity.map((v, i) => (i === 0 ? NaN : v)), 0, 0, 200, 200],
    ]) {
      const state = layout(areas);
      updateMinimapZoneNavigation(state, areas, matrix, x, z, width, height);
      assert.equal(state.count, 0);
    }
  });

  it("rejects zero or negative projection W instead of reversing a cue", () => {
    for (const w of [0, -1]) {
      const state = new MinimapZoneNavigationState();
      const matrix = new Matrix4();
      matrix.elements[15] = w;
      updateMinimapZoneNavigation(
        state,
        { a: area("a", 0, 0) },
        matrix.elements,
        0,
        0,
        200,
        200,
      );
      assert.equal(state.count, 0);
    }
  });
});
