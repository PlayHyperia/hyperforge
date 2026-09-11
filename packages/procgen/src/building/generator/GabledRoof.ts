import * as THREE from "three";
import { WALL_THICKNESS, palette } from "./constants";
import { applyGeometryAttributes, applyRoofAttributes } from "./geometry";
import { WALL_MATERIAL_IDS, type WallMaterialType } from "./types";
import { UV_SCALE_PRESETS } from "./uvUtils";

/** One closed, pitched shell with solid end walls and timber verge/eave trim.
 * Geometry only: no materials, textures, collision, caches or scene ownership.
 * Caller owns every returned geometry. Ridge runs along local Z.
 */
export function createGabledRoof(
  width: number,
  depth: number,
  wallTop: number,
  wallMaterial: WallMaterialType,
): { roofs: THREE.BufferGeometry[]; walls: THREE.BufferGeometry[] } {
  if (
    ![width, depth, wallTop].every(Number.isFinite) ||
    width < 4 ||
    width > 32 ||
    depth < 4 ||
    depth > 32 ||
    wallTop <= 0 ||
    wallTop > 256 ||
    !Object.hasOwn(WALL_MATERIAL_IDS, wallMaterial)
  )
    throw new Error(
      "Gabled roof requires finite 4–32m rectangular dimensions and a known wall material",
    );

  const pitch = (Math.PI * 32) / 180;
  const slope = Math.tan(pitch);
  const half = width / 2;
  const overhang = 0.45;
  const extent = half + overhang;
  const roofDepth = depth + overhang * 2;
  const peak = wallTop + half * slope;
  const eave = wallTop - overhang * slope;
  const thickness = 0.18;
  const walls: THREE.BufferGeometry[] = [];

  const extrude = (points: number[][], length: number, z: number) => {
    const shape = new THREE.Shape(
      points.map(([x, y]) => new THREE.Vector2(x, y)),
    );
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: length,
      steps: 1,
      bevelEnabled: false,
      curveSegments: 1,
    });
    // The generator's wall batch is indexed. Preserve the hard per-face normals
    // and UV seams while giving this extrusion the same merge contract.
    geometry.setIndex(
      Array.from(
        { length: geometry.getAttribute("position").count },
        (_, i) => i,
      ),
    );
    geometry.translate(0, 0, z);
    return geometry;
  };
  // A single six-sided cross-section closes the ridge without coincident slope faces.
  const shell = extrude(
    [
      [-extent, eave],
      [0, peak],
      [extent, eave],
      [extent, eave + thickness],
      [0, peak + thickness],
      [-extent, eave + thickness],
    ],
    roofDepth,
    -roofDepth / 2,
  );
  applyRoofAttributes(shell, palette.roof, UV_SCALE_PRESETS.shingle);
  // Meters along the ridge and actual slope distance: no stretched horizontal projection.
  const positions = shell.getAttribute("position"),
    normals = shell.getAttribute("normal"),
    uv = shell.getAttribute("uv");
  for (let i = 0; i < positions.count; i++) {
    const scale = UV_SCALE_PRESETS.shingle;
    if (Math.abs(normals.getZ(i)) > 0.5) {
      // Front/back caps have no Z extent; project their actual XY plane.
      uv.setXY(i, positions.getX(i) * scale, positions.getY(i) * scale);
    } else if (Math.abs(normals.getY(i)) < 0.1) {
      // Vertical eave edges need thickness in V, not the constant X coordinate.
      uv.setXY(i, positions.getZ(i) * scale, positions.getY(i) * scale);
    } else {
      uv.setXY(
        i,
        positions.getZ(i) * scale,
        (Math.abs(positions.getX(i)) / Math.cos(pitch)) * scale,
      );
    }
  }
  const style = (g: THREE.BufferGeometry, trim = false) => {
    applyGeometryAttributes(
      g,
      trim ? palette.trim : palette.wallOuter,
      "generic",
      {
        uvScale: trim
          ? UV_SCALE_PRESETS.woodPlank
          : UV_SCALE_PRESETS.stoneMedium,
        materialId: trim
          ? WALL_MATERIAL_IDS.solid
          : WALL_MATERIAL_IDS[wallMaterial],
      },
    );
    walls.push(g);
  };
  for (const side of [-1, 1]) {
    const z = (side * depth) / 2 - WALL_THICKNESS / 2;
    style(
      extrude(
        [
          [-half, wallTop - 0.02],
          [half, wallTop - 0.02],
          [half, wallTop],
          [0, peak],
          [-half, wallTop],
        ],
        WALL_THICKNESS,
        z,
      ),
    );
    const front = side * (roofDepth / 2 - 0.06);
    for (const sign of [-1, 1]) {
      const start = new THREE.Vector3(0, peak - 0.09, front);
      const end = new THREE.Vector3(sign * extent, eave - 0.09, front);
      const delta = end.clone().sub(start);
      const beam = new THREE.BoxGeometry(delta.length(), 0.18, 0.12);
      beam.applyQuaternion(
        new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(1, 0, 0),
          delta.normalize(),
        ),
      );
      beam.translate(...start.add(end).multiplyScalar(0.5).toArray());
      style(beam, true);
    }
    const eaveBeam = new THREE.BoxGeometry(0.14, 0.18, roofDepth);
    eaveBeam.translate(side * (extent - 0.07), eave - 0.09, 0);
    style(eaveBeam, true);
  }
  return { roofs: [shell], walls };
}
