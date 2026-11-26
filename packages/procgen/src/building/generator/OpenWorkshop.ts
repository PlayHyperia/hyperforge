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
/** Fixed local support coordinates; the eventual world owner must ground these
 * exact feet and register their real footprints, never a closed building floor.
 */
export const BANK_PAVILION_POSTS = Object.freeze([
  Object.freeze({ x: -3.5, z: -3.5 }),
  Object.freeze({ x: 3.5, z: -3.5 }),
  Object.freeze({ x: -3.5, z: 3.5 }),
  Object.freeze({ x: 3.5, z: 3.5 }),
]);
export const BANK_PAVILION_RECIPE = Object.freeze({
  id: "bank-pavilion-v1" as const,
  width: 8,
  depth: 8,
  eaveHeight: 3.2,
  pitchDegrees: 30,
  posts: BANK_PAVILION_POSTS,
});
/** Lakeward is local -Z. Fixed asymmetry fits the existing 10m court envelope. */
export const POND_BANK_PAVILION_RECIPE = Object.freeze({
  id: "pond-bank-pavilion-v1" as const,
  width: 8,
  depth: 8,
  eaveHeight: 3.2,
  pitchDegrees: 22,
  roofOffsetZ: -0.35,
  frontBeamZ: -4.75,
  backBeamZ: 3.85,
  frontPurlinZ: -4.95,
  backPurlinZ: 3.95,
  posts: BANK_PAVILION_POSTS,
});
export type OpenWorkshopRecipe =
  "smithy-v1" | "bank-pavilion-v1" | "pond-bank-pavilion-v1";
export type WorkshopFoot = Readonly<{ bottom: number; top: number }>;
export type OpenWorkshopGeometry = Readonly<{
  timber: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
  /** Stone batch: four feet, plus the bank's post-mounted key reliefs. */
  footings: THREE.BufferGeometry;
  dispose(): void;
}>;

/** Eight-sided section: broad flat faces and narrow bevels, not a round log.
 * UVs follow the member length before its world transform, keeping grain aligned.
 * New bank end-grain caps use both section axes; the legacy smithy UV mapping
 * remains byte-for-byte unchanged, including its original end-cap projection.
 */
function timberMember(
  a: THREE.Vector3,
  b: THREE.Vector3,
  width: number,
  depth: number,
  planarEndGrain = false,
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
      ((planarEndGrain && Math.abs(normal.getZ(i)) > 0.5) ||
      Math.abs(normal.getX(i)) > 0.5
        ? position.getY(i)
        : position.getX(i)) + 0.15,
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

/** Open 10×6m smithy by default, or fixed 8×8m bank pavilion; eave datum 3.2m.
 * Neither recipe creates a ground plane, enclosed walls or walkable roof.
 * Feet are local Y offsets sampled independently across each 0.30m footprint.
 * All geometries are private, deterministic, uncached and caller-owned.
 */
export function createOpenWorkshop(
  feet: readonly WorkshopFoot[],
  options: {
    architecturalFinish?: "haven-v1";
    recipe?: OpenWorkshopRecipe;
  } = {},
): OpenWorkshopGeometry {
  if (
    (options.recipe !== undefined &&
      options.recipe !== "smithy-v1" &&
      options.recipe !== BANK_PAVILION_RECIPE.id &&
      options.recipe !== POND_BANK_PAVILION_RECIPE.id) ||
    (options.architecturalFinish !== undefined &&
      options.architecturalFinish !== "haven-v1") ||
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
  const pondBank = options.recipe === POND_BANK_PAVILION_RECIPE.id;
  const bank = pondBank || options.recipe === BANK_PAVILION_RECIPE.id;
  const posts = bank ? BANK_PAVILION_POSTS : OPEN_WORKSHOP_POSTS;
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
    const cutawayBraces = new Set<THREE.BufferGeometry>();
    const permanentBadges = new Set<THREE.BufferGeometry>();
    const member = (a: number[], b: number[], width: number, depth = width) =>
      take(
        timberMember(
          new THREE.Vector3(...a),
          new THREE.Vector3(...b),
          width,
          depth,
          bank,
        ),
      );
    const pitchDegrees = pondBank
      ? POND_BANK_PAVILION_RECIPE.pitchDegrees
      : bank
        ? BANK_PAVILION_RECIPE.pitchDegrees
        : 24;
    const slope = Math.tan((pitchDegrees * Math.PI) / 180);
    const roofHalfWidth = bank ? BANK_PAVILION_RECIPE.width / 2 : 5;
    const postHalfWidth = bank ? 3.5 : 5;
    const frontZ = bank ? -3.5 : -2;
    const backZ = bank ? 3.5 : 3;
    // The bank posts sit 0.5m inboard of the nominal roof eave. Bring their
    // bearings up to the actual pitched underside instead of floating rafters
    // above short posts; the nominal eave datum remains 3.2m and the existing
    // 0.45m roof overhang continues down the same pitch.
    const postTop = bank
      ? BANK_PAVILION_RECIPE.eaveHeight +
        (roofHalfWidth - postHalfWidth) * slope
      : 3.2;
    const tieY = bank ? postTop - 0.14 : 3.06;
    for (let i = 0; i < 4; i++) {
      const { x, z } = posts[i],
        { bottom, top } = feet[i];
      bases.push(member([x, bottom, z], [x, top, z], 0.3));
      frame.push(member([x, top - 0.035, z], [x, postTop, z], 0.24));
      // Braces stay high: no low diagonal rail across a passage.
      frame.push(
        member(
          [x, bank ? postTop - 0.75 : 2.45, z],
          [x - Math.sign(x) * 0.72, bank ? postTop - 0.13 : 3.07, z],
          0.14,
        ),
      );
      frame.push(
        member(
          [x, bank ? postTop - 0.75 : 2.45, z],
          [x, bank ? postTop - 0.13 : 3.07, z + (z < 0 ? 0.72 : -0.72)],
          0.14,
        ),
      );
      if (bank) {
        cutawayBraces.add(frame[frame.length - 2]);
        cutawayBraces.add(frame[frame.length - 1]);
      }
    }
    // The bank's knee braces fade with the beams they support, avoiding orphan
    // Y silhouettes. Four posts remain; historical smithy braces stay visible.
    // The high ring beams also belong to the upper cutaway.
    // Only the visibility label changes: all physical vertices stay identical.
    const permanentFrameEnd = frame.length;
    for (const x of [-postHalfWidth, postHalfWidth])
      frame.push(
        member(
          [
            x,
            tieY,
            pondBank
              ? POND_BANK_PAVILION_RECIPE.frontBeamZ
              : bank
                ? -4.1
                : -3.1,
          ],
          [
            x,
            tieY,
            pondBank ? POND_BANK_PAVILION_RECIPE.backBeamZ : bank ? 4.15 : 3.15,
          ],
          0.24,
          0.28,
        ),
      );
    for (const z of [frontZ, backZ])
      frame.push(
        member(
          [bank ? -3.65 : -5.15, tieY, z],
          [bank ? 3.65 : 5.15, tieY, z],
          0.24,
          0.28,
        ),
      );
    // Open king-post framing replaces the solid triangular gable. The lower
    // pitch reduces the top-heavy silhouette without changing ground access.
    const gable = createGabledRoof(
      bank ? BANK_PAVILION_RECIPE.width : 10,
      bank ? BANK_PAVILION_RECIPE.depth : 6,
      3.2,
      "wood",
      {
        pitchDegrees,
        openEnds: true,
        architecturalFinish: options.architecturalFinish,
      },
    );
    for (const geometry of [...gable.roofs, ...gable.walls]) take(geometry);
    if (pondBank && options.architecturalFinish === "haven-v1") {
      // The closed shell has distinct, hard-normal underside faces. Route
      // those existing triangles to timber, not an extra coincident deck or
      // material pass. The ridge cap and every exterior triangle stay shingles.
      const shell = gable.roofs[0];
      const normal = shell.getAttribute("normal");
      const exterior: number[] = [],
        underside: number[] = [];
      const corners = shell.index?.count ?? normal.count;
      for (let corner = 0; corner < corners; corner += 3) {
        const a = shell.index?.getX(corner) ?? corner,
          b = shell.index?.getX(corner + 1) ?? corner + 1,
          c = shell.index?.getX(corner + 2) ?? corner + 2;
        const down = [a, b, c].map((index) => normal.getY(index) < -0.5);
        if (down.some(Boolean) && !down.every(Boolean))
          throw new Error("Pavilion roof contains a mixed underside face");
        (down[0] ? underside : exterior).push(a, b, c);
      }
      if (underside.length !== 12 || exterior.length === 0)
        throw new Error("Pavilion roof requires two closed deck slopes");
      const skin = take(shell.clone()),
        deck = take(shell.clone());
      skin.setIndex(exterior);
      deck.setIndex(underside);
      const positions = deck.getAttribute("position"),
        uv = deck.getAttribute("uv");
      const pitchCos = Math.cos((pitchDegrees * Math.PI) / 180);
      for (const index of underside)
        uv.setXY(
          index,
          positions.getZ(index),
          Math.abs(positions.getX(index)) / pitchCos,
        );
      // Assign metre-scale grain along the ridge before translating the roof.
      // Appending after the permanent frame gives the deck the same courtRoof
      // cutaway/pointer policy as the shell, including unfaded shadow passes.
      gable.roofs[0] = skin;
      gable.walls.push(deck);
      owned.delete(shell);
      shell.dispose();
    }
    if (pondBank) {
      // Shift the closed roof and its trim together; supports stay on their
      // exact canonical feet. Longer exposed lakeward beams carry this eave.
      for (const geometry of [...gable.roofs, ...gable.walls])
        geometry.translate(0, 0, POND_BANK_PAVILION_RECIPE.roofOffsetZ);
    }
    frame.push(...gable.walls);
    // Three explicit trusses carry the ridge and longitudinal purlins. Their
    // lower tie/strut ends stay in the existing upper-cutaway/clearance band.
    const peak = 3.2 + roofHalfWidth * slope;
    const frameDepth = bank ? 4.2 : 3.2;
    const frameFront = pondBank
      ? POND_BANK_PAVILION_RECIPE.frontPurlinZ
      : -frameDepth;
    const frameBack = pondBank
      ? POND_BANK_PAVILION_RECIPE.backPurlinZ
      : frameDepth;
    const purlinX = bank ? 2 : 2.55;
    frame.push(
      member([0, peak - 0.13, frameFront], [0, peak - 0.13, frameBack], 0.18),
    );
    for (const x of [-purlinX, purlinX]) {
      const y = peak - Math.abs(x) * slope - 0.16;
      frame.push(member([x, y, frameFront], [x, y, frameBack], 0.16, 0.2));
    }
    const middleZ = bank ? 0 : 0.5;
    for (const z of [frontZ, middleZ, backZ]) {
      if (z === middleZ)
        frame.push(
          member(
            [-postHalfWidth, tieY, z],
            [postHalfWidth, tieY, z],
            0.24,
            0.28,
          ),
        );
      frame.push(
        member([0, bank ? tieY + 0.1 : 3.16, z], [0, peak - 0.16, z], 0.22),
      );
      for (const sign of [-1, 1])
        frame.push(
          member(
            [0, peak - 0.16, z],
            [sign * roofHalfWidth, 3.04, z],
            0.18,
            0.22,
          ),
          member(
            [sign * 0.12, bank ? tieY + 0.16 : 3.22, z],
            [sign * purlinX, peak - purlinX * slope - 0.2, z],
            0.14,
            0.18,
          ),
        );
    }
    if (bank) {
      // Town: two south (+Z) plaques. Pond: one lakeward (-Z) plaque,
      // replacing rather than accumulating ornament. Both retain the same
      // bank-service key and use the existing post's blocked tile.
      // Both plaque and shallow stone key stay within the post's blocked tile;
      // neither becomes a gable-height orphan when the roof is cut away.
      const sign = pondBank ? -1 : 1;
      for (const { x, z } of posts.filter((post) =>
        pondBank ? post.z < 0 && post.x < 0 : post.z > 0,
      )) {
        const plaque = member(
          [x, 1.75, z + sign * 0.115],
          [x, 1.75, z + sign * 0.2],
          0.52,
          0.66,
        );
        frame.push(plaque);
        permanentBadges.add(plaque);
        const hexagon = (radius: number) =>
          Array.from({ length: 6 }, (_, i) => {
            const angle = (i * Math.PI) / 3;
            return new THREE.Vector2(
              Math.cos(angle) * radius,
              Math.sin(angle) * radius,
            );
          });
        const bow = new THREE.Shape(hexagon(0.105));
        bow.holes.push(new THREE.Path(hexagon(0.055).reverse()));
        const shaft = new THREE.Shape(
          [
            [-0.026, -0.3],
            [0.1, -0.3],
            [0.1, -0.245],
            [0.026, -0.245],
            [0.026, -0.075],
            [-0.026, -0.075],
          ].map(([px, py]) => new THREE.Vector2(px, py)),
        );
        for (const shape of [bow, shaft]) {
          const relief = take(
            new THREE.ExtrudeGeometry(shape, {
              depth: 0.018,
              steps: 1,
              bevelEnabled: false,
              curveSegments: 1,
            }),
          );
          applyGeometryAttributes(relief, palette.trim, "generic", {
            applyUVs: false,
          });
          if (pondBank) relief.rotateY(Math.PI);
          relief.translate(x, 1.9, z + sign * 0.198);
          bases.push(relief);
        }
      }
    }
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
      if (
        !permanentBadges.has(frame[i]) &&
        (i >= permanentFrameEnd || cutawayBraces.has(frame[i]))
      )
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
    // Three existing material/collision batches; bounded additional framing,
    // not a new prop population or per-frame geometry path.
    if (triangles > 1500)
      throw new Error("Open workshop geometry exceeded its recipe budget");
    return Object.freeze({ timber, roof, footings, dispose });
  } catch (error) {
    dispose();
    throw error;
  }
}
