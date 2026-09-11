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
  mod,
  positionWorld,
  positionView,
  normalView,
  normalWorldGeometry,
  faceDirection,
} from "three/tsl";

/** One shared opaque surface: no displacement, textures, lights or extra passes. */
export const DUEL_STONE_SURFACE = Object.freeze({
  id: "weathered-limestone-ashlar-v1",
  blockWidth: 1.6,
  blockLength: 0.9,
  jointWidth: 0.018,
  bevelWidth: 0.025,
  reliefMeters: 0.006,
  detailFadeStart: 0.06,
  detailFadeEnd: 0.32,
  textureCount: 0,
});

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
  const scaled = xz.div(vec2(c.blockWidth, c.blockLength));
  const bond = vec2(scaled.x.add(mod(floor(scaled.y), 2).mul(0.5)), scaled.y);
  const cell = floor(bond),
    local = fract(bond);
  const edge = min(
    min(local.x, float(1).sub(local.x)).mul(c.blockWidth),
    min(local.y, float(1).sub(local.y)).mul(c.blockLength),
  );
  const footprint = max(xz.dFdx().length(), xz.dFdy().length()).max(0.00001);
  const detail = float(1).sub(
    smoothstep(c.detailFadeStart, c.detailFadeEnd, footprint),
  );
  const bevel = smoothstep(
    float(c.jointWidth).sub(footprint.mul(0.5)),
    float(c.jointWidth + c.bevelWidth).add(footprint.mul(0.5)),
    edge,
  );
  const stone = mix(float(0.96), bevel, detail);
  const tileVariation = mix(float(0.5), hash(cell), detail);
  const grain = noise(xz.mul(4.2)).sub(0.5).mul(detail);
  const patina = noise(xz.mul(0.13));
  const limestone = mix(color(0x949889), color(0xb2ab97), tileVariation).mul(
    float(0.87).add(patina.mul(0.19)).add(grain.mul(0.075)),
  );
  const top = smoothstep(0.7, 0.95, normalWorldGeometry.y.abs());
  material.colorNode = mix(
    color(0x898b7c),
    mix(color(0x656957), limestone, stone),
    top,
  );
  material.roughnessNode = mix(
    float(0.94),
    float(0.76).add(patina.mul(0.12)),
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
