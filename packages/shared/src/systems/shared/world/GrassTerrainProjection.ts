import type {
  RetainedTerrainSurface,
  TerrainGridSample,
} from "./TerrainGridSurface";

export type GrassAnchorData = {
  offsets: Float32Array;
  rotScaleHash: Float32Array;
  groundColors: Float32Array;
  grassTints: Float32Array;
  groundNormals: Float32Array;
  count: number;
};

/** CPU-only evidence; ecological sampling is not overwritten by mesh fitting. */
export type GrassGrounding = {
  schemaVersion: 1;
  surfaceRevision: string;
  computedHeights: Float32Array;
  ecologicalNormals: Float32Array;
};

/** Projects once per bounded install. Never mutates a worker result or raycasts. */
export function projectGrassAnchors<T extends GrassAnchorData>(
  data: T,
  surface: RetainedTerrainSurface,
  getWaterSurfaceAt: (x: number, z: number) => number,
  isGrassExcludedAt: (x: number, z: number) => boolean,
): T & { grounding: GrassGrounding } {
  const { count } = data;
  if (
    !Number.isInteger(count) ||
    count < 0 ||
    data.offsets.length !== count * 3 ||
    data.rotScaleHash.length !== count * 3 ||
    data.groundColors.length !== count * 3 ||
    data.groundNormals.length !== count * 3 ||
    data.grassTints.length !== count * 4
  )
    throw new Error("Invalid grass attribute lengths");
  const offsets = new Float32Array(count * 3);
  const rotScaleHash = new Float32Array(count * 3);
  const groundColors = new Float32Array(count * 3);
  const grassTints = new Float32Array(count * 4);
  const groundNormals = new Float32Array(count * 3);
  const computedHeights = new Float32Array(count);
  const ecologicalNormals = new Float32Array(count * 3);
  const sample: TerrainGridSample = {
    height: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    faceIndex: 0,
  };
  let retained = 0;
  for (let i = 0; i < count; i++) {
    const src = i * 3;
    const localX = data.offsets[src];
    const localZ = data.offsets[src + 2];
    if (!Number.isFinite(data.offsets[src + 1]))
      throw new Error("Invalid computed grass anchor height");
    if (!surface.sample(localX, localZ, sample))
      throw new Error("Grass anchor is outside its retained terrain grid");
    const x = surface.centerX + localX;
    const z = surface.centerZ + localZ;
    const water = getWaterSurfaceAt(x, z);
    if (!Number.isFinite(water))
      throw new Error("Invalid local grass water surface");
    // Quantize before admission: this is the actual installed Float32 height.
    const height = Math.fround(sample.height);
    if (height < water + 0.1 || isGrassExcludedAt(x, z)) continue;
    const dst = retained * 3;
    offsets[dst] = localX;
    offsets[dst + 1] = height;
    offsets[dst + 2] = localZ;
    computedHeights[retained] = data.offsets[src + 1];
    for (let c = 0; c < 3; c++) {
      if (
        !Number.isFinite(data.rotScaleHash[src + c]) ||
        !Number.isFinite(data.groundColors[src + c]) ||
        !Number.isFinite(data.groundNormals[src + c])
      )
        throw new Error("Invalid grass instance attributes");
      rotScaleHash[dst + c] = data.rotScaleHash[src + c];
      groundColors[dst + c] = data.groundColors[src + c];
      ecologicalNormals[dst + c] = data.groundNormals[src + c];
    }
    groundNormals[dst] = sample.nx;
    groundNormals[dst + 1] = sample.ny;
    groundNormals[dst + 2] = sample.nz;
    for (let c = 0; c < 4; c++) {
      if (!Number.isFinite(data.grassTints[i * 4 + c]))
        throw new Error("Invalid grass tint attributes");
      grassTints[retained * 4 + c] = data.grassTints[i * 4 + c];
    }
    retained++;
  }
  return {
    ...data,
    offsets: offsets.subarray(0, retained * 3),
    rotScaleHash: rotScaleHash.subarray(0, retained * 3),
    groundColors: groundColors.subarray(0, retained * 3),
    grassTints: grassTints.subarray(0, retained * 4),
    groundNormals: groundNormals.subarray(0, retained * 3),
    count: retained,
    grounding: {
      schemaVersion: 1,
      surfaceRevision: surface.revision,
      computedHeights: computedHeights.subarray(0, retained),
      ecologicalNormals: ecologicalNormals.subarray(0, retained * 3),
    },
  };
}
