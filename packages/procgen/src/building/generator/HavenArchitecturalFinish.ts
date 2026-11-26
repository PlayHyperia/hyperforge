import * as THREE from "three";
import {
  ARCH_WIDTH,
  CELL_SIZE,
  DOOR_HEIGHT,
  DOOR_WIDTH,
  ENTRANCE_STEP_HEIGHT,
  FOUNDATION_OVERHANG,
  WALL_HEIGHT,
  WALL_THICKNESS,
  WINDOW_HEIGHT,
  WINDOW_SILL_HEIGHT,
  WINDOW_WIDTH,
  palette,
} from "./constants";
import { applyGeometryAttributes } from "./geometry";
import { WALL_MATERIAL_IDS, type BuildingLayout } from "./types";

/** A closed, shallow-bevel member with explicit grain direction. Local U follows
 * its length in metres; V follows its cross-section. No textures or owner state.
 * The reference normal defines roll instead of relying on quaternion ambiguity.
 */
export function createHavenMember(
  start: THREE.Vector3,
  end: THREE.Vector3,
  width: number,
  depth: number,
  referenceNormal: THREE.Vector3,
  stone = false,
): THREE.BufferGeometry {
  const axis = end.clone().sub(start),
    length = axis.length();
  if (
    ![
      ...start.toArray(),
      ...end.toArray(),
      ...referenceNormal.toArray(),
      width,
      depth,
    ].every(Number.isFinite) ||
    !Number.isFinite(length) ||
    length <= 0 ||
    length > 64 ||
    width <= 0 ||
    width > 64 ||
    depth <= 0 ||
    depth > 64 ||
    !Number.isFinite(referenceNormal.lengthSq()) ||
    referenceNormal.lengthSq() === 0
  )
    throw new Error("Haven member requires finite nonzero dimensions");
  axis.normalize();
  const across = referenceNormal.clone().normalize().cross(axis);
  if (across.lengthSq() < 1e-12)
    throw new Error("Haven member reference must not parallel its length");
  across.normalize();
  const normal = axis.clone().cross(across).normalize();
  const x = width / 2,
    y = depth / 2,
    bevel = Math.min(width, depth) * 0.18;
  const geometry = new THREE.ExtrudeGeometry(
    new THREE.Shape(
      [
        [-x + bevel, -y],
        [x - bevel, -y],
        [x, -y + bevel],
        [x, y - bevel],
        [x - bevel, y],
        [-x + bevel, y],
        [-x, y - bevel],
        [-x, -y + bevel],
      ].map(([px, py]) => new THREE.Vector2(px, py)),
    ),
    { depth: length, steps: 1, bevelEnabled: false, curveSegments: 1 },
  );
  applyGeometryAttributes(
    geometry,
    stone ? palette.foundation : palette.trim,
    "generic",
    {
      applyUVs: false,
      materialId: stone ? WALL_MATERIAL_IDS.stone : WALL_MATERIAL_IDS.solid,
    },
  );
  const positions = geometry.getAttribute("position"),
    normals = geometry.getAttribute("normal"),
    uv = geometry.getAttribute("uv");
  for (let i = 0; i < positions.count; i++) {
    const cap = Math.abs(normals.getZ(i)) > 0.5;
    uv.setXY(
      i,
      cap ? positions.getX(i) : positions.getZ(i),
      cap
        ? positions.getY(i)
        : -normals.getY(i) * positions.getX(i) +
            normals.getX(i) * positions.getY(i),
    );
  }
  geometry.setIndex(Array.from({ length: positions.count }, (_, i) => i));
  geometry.applyMatrix4(
    new THREE.Matrix4().makeBasis(across, normal, axis).setPosition(start),
  );
  return geometry;
}

/** Additive facade finish only: no floor, steps, opening edges or layout edits.
 * Every member stays outside the wall and inside the existing foundation's XZ
 * envelope. Opening exclusions include the original frame/step margins.
 */
export function createHavenLodgeFinish(
  layout: BuildingLayout,
): THREE.BufferGeometry[] {
  const width = layout.width * CELL_SIZE,
    depth = layout.depth * CELL_SIZE,
    base = layout.foundationSteps * ENTRANCE_STEP_HEIGHT,
    top = base + WALL_HEIGHT;
  const parts: THREE.BufferGeometry[] = [];
  try {
    for (const side of ["north", "south", "east", "west"] as const) {
      const alongX = side === "north" || side === "south",
        half = (alongX ? width : depth) / 2,
        sign = side === "north" || side === "west" ? -1 : 1,
        face =
          sign * ((alongX ? depth : width) / 2 + WALL_THICKNESS / 2 + 0.018),
        outward = new THREE.Vector3(alongX ? 0 : sign, 0, alongX ? sign : 0);
      const point = (along: number, y: number) =>
        new THREE.Vector3(alongX ? along : face, y, alongX ? face : along);
      const member = (
        a: number,
        ay: number,
        b: number,
        by: number,
        breadth: number,
        stone = false,
      ) =>
        parts.push(
          createHavenMember(
            point(a, ay),
            point(b, by),
            breadth,
            0.04,
            outward,
            stone,
          ),
        );
      // Two corner uprights per face, not a grid of redundant mid-wall bars.
      for (const along of [-half + 0.18, half - 0.18])
        member(along, base + 0.14, along, top - 0.16, 0.22);
      member(-half + 0.06, top - 0.11, half - 0.06, top - 0.11, 0.18);
      const doorGaps: [number, number][] = [];
      for (const [key, opening] of layout.floorPlans[0].externalOpenings) {
        const [col, row, openingSide] = key.split(",");
        if (openingSide !== side) continue;
        const along =
          ((alongX ? Number(col) : Number(row)) + 0.5) * CELL_SIZE - half;
        const openingWidth =
          opening === "window"
            ? WINDOW_WIDTH
            : opening === "arch"
              ? ARCH_WIDTH
              : DOOR_WIDTH;
        const openingTop =
          base +
          (opening === "window"
            ? WINDOW_SILL_HEIGHT + WINDOW_HEIGHT
            : DOOR_HEIGHT);
        // The lintel is above the existing frame, never across its aperture.
        member(
          along - openingWidth / 2 - 0.19,
          openingTop + 0.19,
          along + openingWidth / 2 + 0.19,
          openingTop + 0.19,
          0.16,
        );
        if (opening !== "window")
          doorGaps.push([
            along - openingWidth / 2 - 0.2,
            along + openingWidth / 2 + 0.2,
          ]);
      }
      doorGaps.sort((a, b) => a[0] - b[0]);
      let from = -half - FOUNDATION_OVERHANG + 0.04;
      for (const [lo, hi] of [
        ...doorGaps,
        [half + FOUNDATION_OVERHANG - 0.04, half + FOUNDATION_OVERHANG],
      ]) {
        if (lo - from > 0.05)
          member(from, base + 0.07, lo, base + 0.07, 0.14, true);
        from = Math.max(from, hi);
      }
    }
    return parts;
  } catch (error) {
    for (const geometry of parts) geometry.dispose();
    throw error;
  }
}
