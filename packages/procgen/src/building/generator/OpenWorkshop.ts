import * as THREE from "three";
import { createGabledRoof } from "./GabledRoof";
import { applyGeometryAttributes, mergeBufferGeometries } from "./geometry";
import { palette } from "./constants";

/** Geometry recipe only. World placement and terrain support belong to the manifest owner. */
export const OPEN_WORKSHOP_POSTS = Object.freeze([
  Object.freeze({ x: -5, z: -2 }),
  Object.freeze({ x: 5, z: -2 }),
  Object.freeze({ x: -5, z: 3 }),
  Object.freeze({ x: 5, z: 3 }),
]);
export type WorkshopFoot = Readonly<{ bottom: number; top: number }>;
export type OpenWorkshopGeometry = Readonly<{
  timber: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
  footings: THREE.BufferGeometry;
  dispose(): void;
}>;

/** Eight-sided section: broad flat faces and narrow bevels, not a round log.
 * UVs follow the member length before its world transform, keeping grain aligned.
 */
function timberMember(
  a: THREE.Vector3,
  b: THREE.Vector3,
  width: number,
  depth: number,
): THREE.BufferGeometry {
  const x = width / 2,
    y = depth / 2,
    bevel = Math.min(width, depth) * 0.09;
  const points = [
    [-x + bevel, -y],
    [x - bevel, -y],
    [x, -y + bevel],
    [x, y - bevel],
    [x - bevel, y],
    [-x + bevel, y],
    [-x, y - bevel],
    [-x, -y + bevel],
  ];
  const geometry = new THREE.ExtrudeGeometry(
    new THREE.Shape(points.map(([px, py]) => new THREE.Vector2(px, py))),
    { depth: a.distanceTo(b), steps: 1, bevelEnabled: false, curveSegments: 1 },
  );
  applyGeometryAttributes(geometry, palette.trim, "generic", {
    applyUVs: false,
  });
  const position = geometry.getAttribute("position"),
    normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  for (let i = 0; i < position.count; i++) {
    uv.setXY(
      i,
      Math.abs(normal.getZ(i)) > 0.5 ? position.getX(i) : position.getZ(i),
      (Math.abs(normal.getX(i)) > 0.5 ? position.getY(i) : position.getX(i)) +
        0.15,
    );
  }
  geometry.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      b.clone().sub(a).normalize(),
    ),
  );
  geometry.translate(a.x, a.y, a.z);
  return geometry;
}

/** Open 10×6m smithy, eave datum 3.2m. No ground plane or walkable roof.
 * Feet are local Y offsets sampled independently across each 0.30m footprint.
 * All geometries are private, deterministic, uncached and caller-owned.
 */
export function createOpenWorkshop(
  feet: readonly WorkshopFoot[],
): OpenWorkshopGeometry {
  if (
    feet.length !== 4 ||
    feet.some(
      (f) =>
        !f ||
        !Number.isFinite(f.bottom) ||
        !Number.isFinite(f.top) ||
        f.bottom < -1 ||
        f.top > 1 ||
        f.top - f.bottom < 0.2 ||
        f.top - f.bottom > 0.75,
    )
  )
    throw new Error(
      "Open workshop requires four bounded terrain-supported feet",
    );
  const owned = new Set<THREE.BufferGeometry>();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const geometry of owned) geometry.dispose();
    owned.clear();
  };
  const take = (geometry: THREE.BufferGeometry) => {
    owned.add(geometry);
    return geometry;
  };
  const merge = (parts: THREE.BufferGeometry[]) => {
    const geometry = take(mergeBufferGeometries(parts, false));
    for (const part of parts) {
      part.dispose();
      owned.delete(part);
    }
    return geometry;
  };
  try {
    const frame: THREE.BufferGeometry[] = [],
      bases: THREE.BufferGeometry[] = [];
    const member = (a: number[], b: number[], width: number, depth = width) =>
      take(
        timberMember(
          new THREE.Vector3(...a),
          new THREE.Vector3(...b),
          width,
          depth,
        ),
      );
    for (let i = 0; i < 4; i++) {
      const { x, z } = OPEN_WORKSHOP_POSTS[i],
        { bottom, top } = feet[i];
      bases.push(member([x, bottom, z], [x, top, z], 0.3));
      frame.push(member([x, top - 0.035, z], [x, 3.2, z], 0.24));
      // Braces stay high: no low diagonal rail across a passage.
      frame.push(
        member([x, 2.45, z], [x - Math.sign(x) * 0.72, 3.07, z], 0.14),
      );
      frame.push(
        member([x, 2.45, z], [x, 3.07, z + (z < 0 ? 0.72 : -0.72)], 0.14),
      );
    }
    for (const x of [-5, 5])
      frame.push(member([x, 3.06, -3.1], [x, 3.06, 3.15], 0.24, 0.28));
    for (const z of [-2, 3])
      frame.push(member([-5.15, 3.06, z], [5.15, 3.06, z], 0.24, 0.28));
    const gable = createGabledRoof(10, 6, 3.2, "wood");
    for (const geometry of [...gable.roofs, ...gable.walls]) take(geometry);
    frame.push(...gable.walls);
    const permanentFrameEnd = frame.length - gable.walls.length;
    // Visible ridge support and two interior rafter pairs articulate the open underside.
    const peak = 3.2 + 5 * Math.tan((32 * Math.PI) / 180);
    frame.push(member([0, peak - 0.13, -3.2], [0, peak - 0.13, 3.2], 0.18));
    for (const z of [-1, 1.4])
      for (const sign of [-1, 1])
        frame.push(
          member([0, peak - 0.16, z], [sign * 5, 3.04, z], 0.13, 0.18),
        );
    const roofMask = new Float32Array(
      frame.reduce(
        (sum, part) =>
          sum + (part.index?.count ?? part.getAttribute("position").count),
        0,
      ),
    );
    let cornerOffset = 0;
    for (let i = 0; i < frame.length; i++) {
      const corners =
        frame[i].index?.count ?? frame[i].getAttribute("position").count;
      if (i >= permanentFrameEnd)
        roofMask.fill(1, cornerOffset, cornerOffset + corners);
      cornerOffset += corners;
    }
    const timber = merge(frame),
      roof = merge(gable.roofs),
      footings = merge(bases);
    timber.setAttribute("courtRoof", new THREE.BufferAttribute(roofMask, 1));
    for (const geometry of [timber, roof, footings]) {
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
    const triangles = [timber, roof, footings].reduce(
      (sum, geometry) =>
        sum +
        (geometry.index?.count ?? geometry.getAttribute("position").count) / 3,
      0,
    );
    if (triangles > 1000)
      throw new Error("Open workshop geometry exceeded its recipe budget");
    return Object.freeze({ timber, roof, footings, dispose });
  } catch (error) {
    dispose();
    throw error;
  }
}
