/**
 * The terrain's quantized, repeating 256² noise field. CPU grass placement and
 * emitted workers sample the same base-level bilinear field, independent of
 * whether a THREE texture has been created. GPU implicit mip selection may
 * filter differently at distance; this is not a per-fragment GPU equality claim.
 */
export function createTerrainNoiseSampler(seed: number = 12345) {
  // Keep this factory self-contained: GrassWorker embeds its emitted toString().
  // Object methods avoid keepNames bundlers capturing external __name helpers.
  if (!Number.isFinite(seed))
    throw new RangeError("Terrain noise seed is finite");
  const size = 256;
  let texels: Uint8Array | null = null;
  const math = {
    fade(t: number): number {
      return t * t * t * (t * (t * 6 - 15) + 10);
    },
    lerp(a: number, b: number, t: number): number {
      return a + t * (b - a);
    },
    grad(hash: number, x: number, y: number): number {
      const h = hash & 3;
      const u = h < 2 ? x : y;
      const v = h < 2 ? y : x;
      return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
    },
    perlin(x: number, y: number, perm: number[]): number {
      const X = Math.floor(x) & 255;
      const Y = Math.floor(y) & 255;
      const xf = x - Math.floor(x);
      const yf = y - Math.floor(y);
      const u = math.fade(xf);
      const v = math.fade(yf);
      const aa = perm[perm[X] + Y];
      const ab = perm[perm[X] + Y + 1];
      const ba = perm[perm[X + 1] + Y];
      const bb = perm[perm[X + 1] + Y + 1];
      const x1 = math.lerp(math.grad(aa, xf, yf), math.grad(ba, xf - 1, yf), u);
      const x2 = math.lerp(
        math.grad(ab, xf, yf - 1),
        math.grad(bb, xf - 1, yf - 1),
        u,
      );
      return math.lerp(x1, x2, v);
    },
    seamless(x: number, y: number, perm: number[]): number {
      const angleX = x * (Math.PI * 2);
      const angleY = y * (Math.PI * 2);
      const nx = Math.cos(angleX);
      const ny = Math.sin(angleX);
      const nz = Math.cos(angleY);
      const nw = Math.sin(angleY);
      const n1 = math.perlin(nx * 4 + 100, nz * 4 + 100, perm);
      const n2 = math.perlin(ny * 4 + 200, nw * 4 + 200, perm);
      const n3 = math.perlin(
        nx * 4 + ny * 4 + 300,
        nz * 4 + nw * 4 + 300,
        perm,
      );
      return (n1 + n2 + n3) / 3;
    },
    fbm(x: number, y: number, perm: number[]): number {
      let value = 0;
      let amplitude = 0.5;
      let maxValue = 0;
      for (let i = 0; i < 4; i++) {
        const ox = x + i * 17.3;
        const oy = y + i * 31.7;
        value += amplitude * math.seamless(ox, oy, perm);
        maxValue += amplitude;
        amplitude *= 0.5;
      }
      return value / maxValue;
    },
    data(): Uint8Array {
      if (texels) return texels;
      const p: number[] = [];
      for (let i = 0; i < size; i++) p[i] = i;
      let s = seed;
      for (let i = size - 1; i > 0; i--) {
        // Deliberately retain the original Number arithmetic, not Math.imul.
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const j = s % (i + 1);
        [p[i], p[j]] = [p[j], p[i]];
      }
      const perm = [...p, ...p];
      const data = new Uint8Array(size * size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const noise = math.fbm(x / size, y / size, perm);
          const value = (noise + 1) * 0.5;
          data[y * size + x] = Math.floor(
            Math.max(0, Math.min(255, value * 255)),
          );
        }
      }
      texels = data;
      return data;
    },
  };
  return Object.freeze({
    seed,
    size,
    sample(worldX: number, worldZ: number, scale: number): number {
      const u = worldX * scale;
      const v = worldZ * scale;
      if (!Number.isFinite(u) || !Number.isFinite(v))
        throw new RangeError("Terrain noise coordinates must be finite");
      const data = math.data();
      // Match the existing texture-backed CPU sampler's exact operation order.
      const px = (((u % 1) + 1) % 1) * size - 0.5;
      const py = (((v % 1) + 1) % 1) * size - 0.5;
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const fx = px - x0;
      const fy = py - y0;
      const ix0 = ((x0 % size) + size) % size;
      const iy0 = ((y0 % size) + size) % size;
      const ix1 = (ix0 + 1) % size;
      const iy1 = (iy0 + 1) % size;
      const v00 = data[iy0 * size + ix0] / 255;
      const v10 = data[iy0 * size + ix1] / 255;
      const v01 = data[iy1 * size + ix0] / 255;
      const v11 = data[iy1 * size + ix1] / 255;
      return (
        v00 * (1 - fx) * (1 - fy) +
        v10 * fx * (1 - fy) +
        v01 * (1 - fx) * fy +
        v11 * fx * fy
      );
    },
    /** Detached RGBA upload data; callers cannot mutate the cached scalar field. */
    copyRGBA(): Uint8Array {
      const data = math.data();
      const rgba = new Uint8Array(size * size * 4);
      for (let i = 0; i < data.length; i++) {
        const j = i * 4;
        rgba[j] = rgba[j + 1] = rgba[j + 2] = data[i];
        rgba[j + 3] = 255;
      }
      return rgba;
    },
  });
}
