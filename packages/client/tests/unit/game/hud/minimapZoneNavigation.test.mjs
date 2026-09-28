import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Matrix4, OrthographicCamera, Vector3 } from "three";
import {
  getMinimapZoneKind,
  MINIMAP_ZONE_INSET,
  MinimapViewportMetrics,
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

  it("uses one arena POI for the overlapping duel campus and safe grounds", () => {
    // Actual current island centers; their glyphs otherwise paint over each other.
    const areas = {
      arena: area("duel_arena", 368, 390.75),
      grounds: area("arena_grounds", 367.75, 390.5),
    };
    const before = structuredClone(areas);
    for (const ordered of [
      areas,
      { grounds: areas.grounds, arena: areas.arena },
    ]) {
      const state = layout(
        ordered,
        camera(64.9, 0, 367.875, 390.625),
        298,
        170,
      );
      assert.deepEqual(
        active(state).map((marker) => [marker.id, marker.kind, marker.offMap]),
        [["duel_arena", "arena", false]],
      );
    }
    assert.equal(getMinimapZoneKind(areas.grounds), null);
    assert.equal(areas.grounds.safeZone, true);
    assert.deepEqual(areas, before);
  });

  it("does not hide other safe destinations even when their centers overlap", () => {
    const state = layout({
      arena: area("duel_arena", 0, 0),
      safe: area("other_safe_area", 0, 0),
      pond: area("haven_pond", 10, 10),
    });
    assert.deepEqual(
      active(state).map((marker) => [marker.id, marker.kind]),
      [
        ["duel_arena", "arena"],
        ["other_safe_area", "safe"],
        ["haven_pond", "safe"],
      ],
    );
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

describe("minimap viewport fit: real camera math, not browser layout", () => {
  function fit(width, height, extent, yaw = 0, x = 0, z = 0) {
    const metrics = new MinimapViewportMetrics();
    metrics.update(width, height, extent);
    const cam = camera(extent, yaw, x, z);
    cam.left = -metrics.halfWidth;
    cam.right = metrics.halfWidth;
    cam.top = metrics.halfHeight;
    cam.bottom = -metrics.halfHeight;
    cam.updateProjectionMatrix();
    return { metrics, cam };
  }

  function pixel(cam, width, height, x, z) {
    const ndc = new Vector3(x, 0, z).project(cam);
    return [((ndc.x + 1) * width) / 2, ((1 - ndc.y) * height) / 2];
  }

  it("retains square half-extents and pixel scale exactly", () => {
    const metrics = new MinimapViewportMetrics();
    for (const width of [100, 200, 298, 512]) {
      for (const extent of [7, 14.9, 37.125, 100]) {
        metrics.update(width, width, extent);
        assert.equal(metrics.halfWidth, extent);
        assert.equal(metrics.halfHeight, extent);
        assert.equal(metrics.pixelsPerWorld, width / (2 * extent));
        const fitted = fit(width, width, extent).cam;
        assert.deepEqual(
          fitted.projectionMatrix.elements,
          camera(extent).projectionMatrix.elements,
        );
      }
    }
  });

  it("uses one world scale in short and tall viewports at every camera yaw", () => {
    for (const [width, height] of [
      [298, 170],
      [170, 298],
      [400, 80],
    ]) {
      for (const yaw of [0, 0.37, 1.2, -2.1]) {
        const { metrics, cam } = fit(width, height, 30, yaw, 350, 420);
        const origin = pixel(cam, width, height, 350, 420);
        close(origin[0], width / 2);
        close(origin[1], height / 2);
        for (const [x, z] of [
          [354, 420],
          [350, 424],
        ]) {
          const p = pixel(cam, width, height, x, z);
          close(
            Math.hypot(p[0] - origin[0], p[1] - origin[1]),
            4 * metrics.pixelsPerWorld,
          );
        }
      }
    }
  });

  it("round-trips rectangular minimap clicks through the real camera", () => {
    for (const [width, height] of [
      [298, 170],
      [170, 298],
      [200, 200],
    ]) {
      for (const yaw of [0, 0.61, -1.3]) {
        const { cam } = fit(width, height, 35, yaw, 335.5, 420.5);
        for (const [x, y] of [
          [13, 13],
          [width / 2, height / 2],
          [width - 13, height - 13],
        ]) {
          const point = new Vector3(
            (x / width) * 2 - 1,
            1 - (y / height) * 2,
            0,
          ).unproject(cam);
          const projected = pixel(cam, width, height, point.x, point.z);
          close(projected[0], x);
          close(projected[1], y);
        }
      }
    }
  });

  it("keeps a rotated and translated cached square terrain image aligned with overlays", () => {
    for (const [width, height] of [
      [298, 170],
      [170, 298],
      [200, 200],
    ]) {
      for (const [cachedYaw, yaw] of [
        [0, 0.4],
        [0.8, -1.2],
        [-1.7, 2.2],
      ]) {
        const { metrics, cam } = fit(width, height, 30, yaw, 378, 417);
        const cachedX = 377,
          cachedZ = 421;
        const cachedUpX = Math.sin(cachedYaw),
          cachedUpZ = -Math.cos(cachedYaw);
        const rightX = -cachedUpZ,
          rightZ = cachedUpX;
        const deltaX = 378 - cachedX,
          deltaZ = 417 - cachedZ;
        const offsetX =
          -(deltaX * rightX + deltaZ * rightZ) * metrics.pixelsPerWorld;
        const offsetY =
          (deltaX * cachedUpX + deltaZ * cachedUpZ) * metrics.pixelsPerWorld;
        const deltaYaw = yaw - cachedYaw;
        for (const [x, z] of [
          [378, 417],
          [383, 425],
          [371, 409],
        ]) {
          const dx = x - cachedX,
            dz = z - cachedZ;
          const px =
            (dx * rightX + dz * rightZ) * metrics.pixelsPerWorld + offsetX;
          const py =
            -(dx * cachedUpX + dz * cachedUpZ) * metrics.pixelsPerWorld +
            offsetY;
          const drawnX =
            width / 2 + px * Math.cos(deltaYaw) + py * Math.sin(deltaYaw);
          const drawnY =
            height / 2 - px * Math.sin(deltaYaw) + py * Math.cos(deltaYaw);
          const projected = pixel(cam, width, height, x, z);
          close(drawnX, projected[0]);
          close(drawnY, projected[1]);
        }
      }
    }
  });

  it("clamps discovery cues to the actual short viewport instead of the cropped square", () => {
    const { cam, metrics } = fit(298, 170, 14.9);
    assert.equal(metrics.halfWidth, 14.9);
    close(metrics.halfHeight, 8.5);
    const state = layout({ safe: area("safe", 0, 12) }, cam, 298, 170);
    assert.equal(state.count, 1);
    assert.equal(state.markers[0].offMap, true);
    close(state.markers[0].x, 149);
    close(state.markers[0].y, 170 - MINIMAP_ZONE_INSET);
  });

  it("rejects unusable viewport inputs before publishing new metrics", () => {
    const metrics = new MinimapViewportMetrics();
    metrics.update(298, 170, 14.9);
    const before = { ...metrics };
    for (const values of [
      [0, 170, 10],
      [298, 0, 10],
      [-1, 170, 10],
      [NaN, 170, 10],
      [298, Infinity, 10],
      [298, 170, 0],
    ]) {
      assert.throws(() => metrics.update(...values), /Positive finite/);
      assert.deepEqual({ ...metrics }, before);
    }
  });
});
