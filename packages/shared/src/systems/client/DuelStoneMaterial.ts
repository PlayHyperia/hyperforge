import type { MeshStandardNodeMaterial, Node } from "three/webgpu";
import {
  Fn,
  color,
  float,
  vec2,
  floor,
  fract,
  sin,
  dot,
  mix,
  smoothstep,
  min,
  max,
  positionWorld,
  positionView,
  normalView,
  normalWorldGeometry,
  faceDirection,
} from "three/tsl";

/** One shared opaque surface: no displacement, textures, lights or extra passes. */
export const DUEL_STONE_SURFACE = Object.freeze({
  id: "weathered-limestone-ashlar-v1",
  blockWidth: 0.62,
  blockLength: 0.38,
  courseWidthVariation: 0.1,
  courseOffsetVariation: 0.2,
  grainWarpMeters: 0.006,
  jointWidth: 0.005,
  bevelWidth: 0.01,
  reliefMeters: 0.0035,
  detailFadeStart: 0.025,
  detailFadeEnd: 0.14,
  textureCount: 0,
});

type StoneLayoutOperations<T> = {
  add(a: T, b: T | number): T;
  sub(a: T | number, b: T | number): T;
  mul(a: T, b: T | number): T;
  div(a: T, b: T | number): T;
  floor(a: T): T;
  fract(a: T): T;
  min(a: T, b: T): T;
};

/** Shared arithmetic for the material and numeric seam checks. Course widths
 * vary without gaps: every stone in a course uses the same world-space grid.
 * The borrowed grain is continuous and unfaded, so seams never swim with LOD. */
export function createDuelStoneLayout<T>(
  op: StoneLayoutOperations<T>,
  x: T,
  z: T,
  grain: T,
) {
  const c = DUEL_STONE_SURFACE;
  const warp = op.mul(grain, c.grainWarpMeters);
  const course = op.div(op.add(z, op.mul(warp, 0.5)), c.blockLength);
  const row = op.floor(course);
  const variation = op.sub(op.fract(op.mul(row, 0.61803398875)), 0.5);
  const width = op.mul(
    op.add(op.mul(variation, 2 * c.courseWidthVariation), 1),
    c.blockWidth,
  );
  const offset = op.add(
    op.fract(op.mul(row, 0.5)),
    op.mul(variation, c.courseOffsetVariation),
  );
  const bond = op.add(op.div(op.add(x, warp), width), offset);
  const u = op.fract(bond),
    v = op.fract(course);
  return {
    column: op.floor(bond),
    row,
    width,
    offset,
    edge: op.min(
      op.mul(op.min(u, op.sub(1, u)), width),
      op.mul(op.min(v, op.sub(1, v)), c.blockLength),
    ),
  };
}

const stoneLayoutOperations: StoneLayoutOperations<Node<"float">> = {
  add: (a, b) => a.add(b),
  sub: (a, b) => (typeof a === "number" ? float(a) : a).sub(b),
  mul: (a, b) => a.mul(b),
  div: (a, b) => a.div(b),
  floor,
  fract,
  min,
};

const hash = Fn(([p]: [Node<"vec2">]) =>
  fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453123)),
);
const noise = Fn(([p]: [Node<"vec2">]) => {
  const cell = floor(p),
    f = fract(p);
  const t = f.mul(f).mul(float(3).sub(f.mul(2)));
  return mix(
    mix(hash(cell), hash(cell.add(vec2(1, 0))), t.x),
    mix(hash(cell.add(vec2(0, 1))), hash(cell.add(vec2(1, 1))), t.x),
    t.y,
  );
});

/**
 * Recessed running-bond joints, varied limestone and restrained surface wear.
 * Screen derivatives fade detail before it becomes a distant moire grid.
 * Hex colors are converted by TSL color() into the renderer's linear space.
 */
export function applyDuelStoneSurface(material: MeshStandardNodeMaterial) {
  const c = DUEL_STONE_SURFACE;
  const xz = positionWorld.xz;
  const rawGrain = noise(xz.mul(4.2)).sub(0.5);
  const layout = createDuelStoneLayout(
    stoneLayoutOperations,
    xz.x,
    xz.y,
    rawGrain,
  );
  const cell = vec2(layout.column, layout.row);
  const footprint = max(xz.dFdx().length(), xz.dFdy().length()).max(0.00001);
  const detail = float(1).sub(
    smoothstep(c.detailFadeStart, c.detailFadeEnd, footprint),
  );
  const bevel = smoothstep(
    float(c.jointWidth).sub(footprint.mul(0.5)),
    float(c.jointWidth + c.bevelWidth).add(footprint.mul(0.5)),
    layout.edge,
  );
  const stone = mix(float(0.96), bevel, detail);
  const tileVariation = mix(float(0.5), hash(cell), detail);
  const grain = rawGrain.mul(detail);
  const patina = noise(xz.mul(0.13));
  const limestone = mix(color(0x96968b), color(0xb0a99b), tileVariation).mul(
    float(0.87).add(patina.mul(0.19)).add(grain.mul(0.075)),
  );
  const top = smoothstep(0.7, 0.95, normalWorldGeometry.y.abs());
  material.colorNode = mix(
    color(0x85867a),
    mix(color(0x77786c), limestone, stone),
    top,
  );
  material.roughnessNode = mix(
    float(0.94),
    float(0.82).add(patina.mul(0.1)),
    stone,
  );
  material.metalness = 0;

  // Surface-gradient bump changes lighting only, never physical foot support.
  // Unnormalized position derivatives retain world-unit relief. This follows
  // the surface-gradient construction also used by Three's BumpMapNode.
  material.normalNode = Fn(() => {
    const height = bevel
      .mul(c.reliefMeters)
      .add(grain.mul(0.0015))
      .mul(detail)
      .mul(top);
    const dx = positionView.dFdx(),
      dy = positionView.dFdy();
    const r1 = dy.cross(normalView),
      r2 = normalView.cross(dx);
    const determinant = dx.dot(r1).mul(faceDirection);
    const gradient = r1
      .mul(height.dFdx())
      .add(r2.mul(height.dFdy()))
      .mul(determinant.sign())
      .div(determinant.abs().max(1e-8));
    return normalView.sub(gradient).normalize();
  })();
  material.userData.duelStoneSurface = { ...c };
  return material;
}
