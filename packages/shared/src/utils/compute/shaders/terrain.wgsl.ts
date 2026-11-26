/**
 * Terrain Compute Shaders
 *
 * WGSL compute shaders for terrain-related GPU operations:
 * - Road influence calculation
 * - Vertex color blending
 * - Instance matrix composition
 */

// ============================================================================
// ROAD INFLUENCE COMPUTE SHADER
// ============================================================================

/**
 * Compute road influence for terrain vertices in parallel.
 *
 * Input:
 * - vertices: [localX, localZ, ...] per vertex (2D positions)
 * - roads: Road struct array with start, end, width, resolved fade and peak
 * - uniforms: vertex count, road count, tile offset
 *
 * Output:
 * - influences: float per vertex (0-1, where 1 = fully on road)
 */
export const ROAD_INFLUENCE_SHADER = /* wgsl */ `
const EPS: f32 = 0.001;

struct Road {
  startX: f32,
  startZ: f32,
  endX: f32,
  endZ: f32,
  width: f32,
  blendWidth: f32,
  maxInfluence: f32,
  padding3: f32,
}

struct Uniforms {
  vertexCount: u32,
  roadCount: u32,
  tileOffsetX: f32,
  tileOffsetZ: f32,
}

@group(0) @binding(0) var<storage, read> vertices: array<f32>;
@group(0) @binding(1) var<storage, read> roads: array<Road>;
@group(0) @binding(2) var<storage, read_write> influences: array<f32>;
@group(0) @binding(3) var<uniform> uniforms: Uniforms;

// Distance from point to line segment (2D)
fn distanceToLineSegment(px: f32, pz: f32, ax: f32, az: f32, bx: f32, bz: f32) -> f32 {
  let abx = bx - ax;
  let abz = bz - az;
  let apx = px - ax;
  let apz = pz - az;
  
  let abLenSq = abx * abx + abz * abz;
  
  if (abLenSq < EPS) {
    // Degenerate segment - just distance to point
    return sqrt(apx * apx + apz * apz);
  }
  
  // Project point onto line, clamp to segment
  let t = clamp((apx * abx + apz * abz) / abLenSq, 0.0, 1.0);
  
  // Closest point on segment
  let closestX = ax + t * abx;
  let closestZ = az + t * abz;
  
  let dx = px - closestX;
  let dz = pz - closestZ;
  
  return sqrt(dx * dx + dz * dz);
}

// Smoothstep function for natural blending at road edges
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
  let t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let vi = global_id.x;
  if (vi >= uniforms.vertexCount) {
    return;
  }
  
  // Get vertex position in LOCAL tile coordinates
  // IMPORTANT: Roads are already in local tile coordinates (0 to TILE_SIZE)
  // so vertices must also be in local coordinates for correct distance calculation
  let base = vi * 2u;
  let localX = vertices[base];
  let localZ = vertices[base + 1u];
  
  var maxInfluence = 0.0;
  
  // Check distance to each road segment (both in LOCAL tile coordinates)
  for (var ri = 0u; ri < uniforms.roadCount; ri = ri + 1u) {
    let road = roads[ri];
    
    // Compare LOCAL vertex coords against LOCAL road coords
    let dist = distanceToLineSegment(
      localX, localZ,
      road.startX, road.startZ,
      road.endX, road.endZ
    );
    
    let halfWidth = road.width * 0.5;
    let totalInfluenceWidth = halfWidth + road.blendWidth;
    
    // Skip if beyond influence range
    if (dist >= totalInfluenceWidth) {
      continue;
    }
    
    // Calculate influence with smoothstep blending (matches CPU behavior)
    var influence: f32;
    if (dist <= halfWidth) {
      // Fractional shoulders retain their authored peak, not a new clear core.
      influence = road.maxInfluence;
    } else {
      // Smoothstep blending at edges
      let t = 1.0 - (dist - halfWidth) / road.blendWidth;
      influence = t * t * (3.0 - 2.0 * t) * road.maxInfluence;
    }
    
    maxInfluence = max(maxInfluence, influence);
  }
  
  influences[vi] = maxInfluence;
}
`;

// ============================================================================
// ROAD INFLUENCE TEXTURE SHADER
// ============================================================================

/**
 * Compute road influence for a world-space texture (authoritative road mask).
 *
 * Input:
 * - roads: Road struct array in WORLD coordinates
 * - uniforms: pixel count, road count, texture size, world size, center, blend width
 *
 * Output:
 * - influences: float per pixel (0-1)
 */
export const ROAD_INFLUENCE_TEXTURE_SHADER = /* wgsl */ `
const EPS: f32 = 0.001;

struct Road {
  startX: f32,
  startZ: f32,
  endX: f32,
  endZ: f32,
  width: f32,
  blendWidth: f32,
  maxInfluence: f32,
  padding3: f32,
}

struct Uniforms {
  pixelCount: f32,
  roadCount: f32,
  textureSize: f32,
  worldSize: f32,
  centerX: f32,
  centerZ: f32,
  blendWidth: f32,
  padding: f32,
}

@group(0) @binding(0) var<storage, read> roads: array<Road>;
@group(0) @binding(1) var<storage, read_write> influences: array<f32>;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;

fn distanceToLineSegment(px: f32, pz: f32, ax: f32, az: f32, bx: f32, bz: f32) -> f32 {
  let abx = bx - ax;
  let abz = bz - az;
  let apx = px - ax;
  let apz = pz - az;
  
  let abLenSq = abx * abx + abz * abz;
  
  if (abLenSq < EPS) {
    return sqrt(apx * apx + apz * apz);
  }
  
  let t = clamp((apx * abx + apz * abz) / abLenSq, 0.0, 1.0);
  let closestX = ax + t * abx;
  let closestZ = az + t * abz;
  
  let dx = px - closestX;
  let dz = pz - closestZ;
  
  return sqrt(dx * dx + dz * dz);
}

fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
  let t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let idx = global_id.x;
  let pixelCount = u32(uniforms.pixelCount);
  if (idx >= pixelCount) {
    return;
  }
  
  let roadCount = u32(uniforms.roadCount);
  let texSize = u32(uniforms.textureSize);
  let halfWorld = uniforms.worldSize * 0.5;
  
  let x = idx % texSize;
  let y = idx / texSize;
  
  let worldX = (f32(x) / f32(texSize)) * uniforms.worldSize - halfWorld + uniforms.centerX;
  let worldZ = (f32(y) / f32(texSize)) * uniforms.worldSize - halfWorld + uniforms.centerZ;
  
  var maxInfluence = 0.0;
  
  for (var ri = 0u; ri < roadCount; ri = ri + 1u) {
    let road = roads[ri];
    
    let dist = distanceToLineSegment(
      worldX, worldZ,
      road.startX, road.startZ,
      road.endX, road.endZ
    );
    
    let halfWidth = road.width * 0.5;
    let totalInfluenceWidth = halfWidth + road.blendWidth;
    
    if (dist >= totalInfluenceWidth) {
      continue;
    }
    
    var influence: f32;
    if (dist <= halfWidth) {
      influence = road.maxInfluence;
    } else {
      let t = 1.0 - (dist - halfWidth) / road.blendWidth;
      influence = t * t * (3.0 - 2.0 * t) * road.maxInfluence;
    }
    
    maxInfluence = max(maxInfluence, influence);
  }
  
  influences[idx] = maxInfluence;
}
`;

// ============================================================================
// TERRAIN VERTEX COLOR SHADER
// ============================================================================

/**
 * Compute terrain vertex colors with biome blending and road coloring.
 *
 * Input:
 * - heights: height per vertex
 * - biomeInfluences: [biomeId, weight, ...] per vertex (up to 3 biomes)
 * - biomes: BiomeData array with colors
 * - roadInfluences: float per vertex
 *
 * Output:
 * - colors: [r, g, b, ...] per vertex
 */
export const TERRAIN_VERTEX_COLOR_SHADER = /* wgsl */ `
const MAX_BIOME_INFLUENCES: u32 = 3u;

struct BiomeData {
  colorR: f32,
  colorG: f32,
  colorB: f32,
  heightScale: f32,
}

struct Uniforms {
  vertexCount: u32,
  biomeCount: u32,
  maxHeight: f32,
  waterLevel: f32,
  shorelineThreshold: f32,
  shorelineStrength: f32,
  padding1: f32,
  padding2: f32,
}

@group(0) @binding(0) var<storage, read> heights: array<f32>;
@group(0) @binding(1) var<storage, read> biomeInfluences: array<f32>;
@group(0) @binding(2) var<storage, read> biomes: array<BiomeData>;
@group(0) @binding(3) var<storage, read> roadInfluences: array<f32>;
@group(0) @binding(4) var<storage, read_write> colors: array<f32>;
@group(0) @binding(5) var<uniform> uniforms: Uniforms;

// Shore color constants (sandy brown 0x8b7355)
const SHORE_R: f32 = 0.545;
const SHORE_G: f32 = 0.451;
const SHORE_B: f32 = 0.333;

// Road colors (0x665544)
const ROAD_R: f32 = 0.4;
const ROAD_G: f32 = 0.333;
const ROAD_B: f32 = 0.267;

// Road edge colors (0x594a3d)
const ROAD_EDGE_R: f32 = 0.349;
const ROAD_EDGE_G: f32 = 0.29;
const ROAD_EDGE_B: f32 = 0.239;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let vi = global_id.x;
  if (vi >= uniforms.vertexCount) {
    return;
  }
  
  let height = heights[vi];
  let normalizedHeight = height / uniforms.maxHeight;
  
  // Blend biome colors based on influences
  var colorR = 0.0;
  var colorG = 0.0;
  var colorB = 0.0;
  
  let influenceBase = vi * MAX_BIOME_INFLUENCES * 2u;
  for (var i = 0u; i < MAX_BIOME_INFLUENCES; i = i + 1u) {
    let biomeId = u32(biomeInfluences[influenceBase + i * 2u]);
    let weight = biomeInfluences[influenceBase + i * 2u + 1u];
    
    if (weight > 0.0 && biomeId < uniforms.biomeCount) {
      let biome = biomes[biomeId];
      colorR = colorR + biome.colorR * weight;
      colorG = colorG + biome.colorG * weight;
      colorB = colorB + biome.colorB * weight;
    }
  }
  
  // Apply shoreline tint
  if (normalizedHeight > uniforms.waterLevel && normalizedHeight < uniforms.shorelineThreshold) {
    let range = uniforms.shorelineThreshold - uniforms.waterLevel;
    let shoreFactor = (1.0 - (normalizedHeight - uniforms.waterLevel) / range) * uniforms.shorelineStrength;
    
    colorR = colorR + (SHORE_R - colorR) * shoreFactor;
    colorG = colorG + (SHORE_G - colorG) * shoreFactor;
    colorB = colorB + (SHORE_B - colorB) * shoreFactor;
  }
  
  // Apply road coloring
  let roadInfluence = roadInfluences[vi];
  if (roadInfluence > 0.0) {
    let edgeFactor = 1.0 - roadInfluence;
    let roadR = ROAD_R * roadInfluence + ROAD_EDGE_R * edgeFactor * 0.3;
    let roadG = ROAD_G * roadInfluence + ROAD_EDGE_G * edgeFactor * 0.3;
    let roadB = ROAD_B * roadInfluence + ROAD_EDGE_B * edgeFactor * 0.3;
    
    colorR = colorR * (1.0 - roadInfluence) + roadR * roadInfluence;
    colorG = colorG * (1.0 - roadInfluence) + roadG * roadInfluence;
    colorB = colorB * (1.0 - roadInfluence) + roadB * roadInfluence;
  }
  
  // Write output
  let colorBase = vi * 3u;
  colors[colorBase] = colorR;
  colors[colorBase + 1u] = colorG;
  colors[colorBase + 2u] = colorB;
}
`;

// ============================================================================
// INSTANCE MATRIX COMPOSITION SHADER
// ============================================================================

/**
 * Compose instance matrices from position, quaternion, and scale.
 *
 * Input:
 * - instances: [posX, posY, posZ, quatX, quatY, quatZ, quatW, scaleX, scaleY, scaleZ, pad, pad]
 *
 * Output:
 * - matrices: [16 floats per matrix, column-major]
 */
export const INSTANCE_MATRIX_SHADER = /* wgsl */ `
struct InstanceTRS {
  posX: f32,
  posY: f32,
  posZ: f32,
  quatX: f32,
  quatY: f32,
  quatZ: f32,
  quatW: f32,
  scaleX: f32,
  scaleY: f32,
  scaleZ: f32,
  padding1: f32,
  padding2: f32,
}

struct Uniforms {
  instanceCount: u32,
  padding1: u32,
  padding2: u32,
  padding3: u32,
}

@group(0) @binding(0) var<storage, read> instances: array<InstanceTRS>;
@group(0) @binding(1) var<storage, read_write> matrices: array<f32>;
@group(0) @binding(2) var<uniform> uniforms: Uniforms;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let idx = global_id.x;
  if (idx >= uniforms.instanceCount) {
    return;
  }
  
  let inst = instances[idx];
  let base = idx * 16u;
  
  // Quaternion to rotation matrix components
  let x = inst.quatX;
  let y = inst.quatY;
  let z = inst.quatZ;
  let w = inst.quatW;
  
  let x2 = x + x;
  let y2 = y + y;
  let z2 = z + z;
  
  let xx = x * x2;
  let xy = x * y2;
  let xz = x * z2;
  let yy = y * y2;
  let yz = y * z2;
  let zz = z * z2;
  let wx = w * x2;
  let wy = w * y2;
  let wz = w * z2;
  
  // Column 0 (scaled)
  matrices[base + 0u] = (1.0 - (yy + zz)) * inst.scaleX;
  matrices[base + 1u] = (xy + wz) * inst.scaleX;
  matrices[base + 2u] = (xz - wy) * inst.scaleX;
  matrices[base + 3u] = 0.0;
  
  // Column 1 (scaled)
  matrices[base + 4u] = (xy - wz) * inst.scaleY;
  matrices[base + 5u] = (1.0 - (xx + zz)) * inst.scaleY;
  matrices[base + 6u] = (yz + wx) * inst.scaleY;
  matrices[base + 7u] = 0.0;
  
  // Column 2 (scaled)
  matrices[base + 8u] = (xz + wy) * inst.scaleZ;
  matrices[base + 9u] = (yz - wx) * inst.scaleZ;
  matrices[base + 10u] = (1.0 - (xx + yy)) * inst.scaleZ;
  matrices[base + 11u] = 0.0;
  
  // Column 3 (translation)
  matrices[base + 12u] = inst.posX;
  matrices[base + 13u] = inst.posY;
  matrices[base + 14u] = inst.posZ;
  matrices[base + 15u] = 1.0;
}
`;

// ============================================================================
// BATCH DISTANCE CALCULATION SHADER
// ============================================================================

/**
 * Compute distances between points and targets in parallel.
 * Useful for finding nearest resources, NPCs, etc.
 *
 * Input:
 * - points: [x, y, z, ...] source points
 * - targets: [x, y, z, ...] target points
 *
 * Output:
 * - distances: distance from each point to nearest target
 * - nearestIndices: index of nearest target for each point
 */
export const BATCH_DISTANCE_SHADER = /* wgsl */ `
const INF: f32 = 1e30;

struct Uniforms {
  pointCount: u32,
  targetCount: u32,
  useXZDistance: u32,  // 1 = XZ plane only, 0 = full 3D
  padding: u32,
}

@group(0) @binding(0) var<storage, read> points: array<f32>;
@group(0) @binding(1) var<storage, read> targets: array<f32>;
@group(0) @binding(2) var<storage, read_write> distances: array<f32>;
@group(0) @binding(3) var<storage, read_write> nearestIndices: array<u32>;
@group(0) @binding(4) var<uniform> uniforms: Uniforms;

fn distanceSquared3D(ax: f32, ay: f32, az: f32, bx: f32, by: f32, bz: f32) -> f32 {
  let dx = ax - bx;
  let dy = ay - by;
  let dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}

fn distanceSquaredXZ(ax: f32, az: f32, bx: f32, bz: f32) -> f32 {
  let dx = ax - bx;
  let dz = az - bz;
  return dx * dx + dz * dz;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let pi = global_id.x;
  if (pi >= uniforms.pointCount) {
    return;
  }
  
  let pBase = pi * 3u;
  let px = points[pBase];
  let py = points[pBase + 1u];
  let pz = points[pBase + 2u];
  
  var minDistSq = INF;
  var nearestIdx = 0u;
  
  for (var ti = 0u; ti < uniforms.targetCount; ti = ti + 1u) {
    let tBase = ti * 3u;
    let tx = targets[tBase];
    let ty = targets[tBase + 1u];
    let tz = targets[tBase + 2u];
    
    var distSq: f32;
    if (uniforms.useXZDistance == 1u) {
      distSq = distanceSquaredXZ(px, pz, tx, tz);
    } else {
      distSq = distanceSquared3D(px, py, pz, tx, ty, tz);
    }
    
    if (distSq < minDistSq) {
      minDistSq = distSq;
      nearestIdx = ti;
    }
  }
  
  distances[pi] = sqrt(minDistSq);
  nearestIndices[pi] = nearestIdx;
}
`;

// ============================================================================
// HEIGHTMAP SHADERS (for GPU terrain generation)
// ============================================================================

/**
 * Common terrain structs for heightmap shaders.
 */
export const WGSL_TERRAIN_STRUCTS = /* wgsl */ `
struct TerrainUniforms {
  tileX: f32,
  tileZ: f32,
  tileSize: f32,
  resolution: u32,
  maxHeight: f32,
  waterLevel: f32,
  seed: u32,
  padding: u32,
}

struct HeightOutput {
  height: f32,
  biomeId: u32,
  moisture: f32,
  temperature: f32,
}
`;

/**
 * GPU terrain heightmap generation shader.
 */
export const TERRAIN_HEIGHTMAP_SHADER = /* wgsl */ `
${WGSL_TERRAIN_STRUCTS}

@group(0) @binding(0) var<uniform> uniforms: TerrainUniforms;
@group(0) @binding(1) var<storage, read_write> heights: array<f32>;

// Simple noise function (placeholder - use proper noise in production)
fn noise2D(x: f32, y: f32, seed: u32) -> f32 {
  let ix = u32(floor(x)) + seed;
  let iy = u32(floor(y));
  let fx = fract(x);
  let fy = fract(y);
  
  // Simple hash-based noise
  let h00 = f32((ix * 374761393u + iy * 668265263u) & 0xFFFFFFu) / 16777216.0;
  let h10 = f32(((ix + 1u) * 374761393u + iy * 668265263u) & 0xFFFFFFu) / 16777216.0;
  let h01 = f32((ix * 374761393u + (iy + 1u) * 668265263u) & 0xFFFFFFu) / 16777216.0;
  let h11 = f32(((ix + 1u) * 374761393u + (iy + 1u) * 668265263u) & 0xFFFFFFu) / 16777216.0;
  
  // Bilinear interpolation with smoothstep
  let sx = fx * fx * (3.0 - 2.0 * fx);
  let sy = fy * fy * (3.0 - 2.0 * fy);
  
  return mix(mix(h00, h10, sx), mix(h01, h11, sx), sy);
}

fn fbm(x: f32, y: f32, octaves: u32, seed: u32) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var frequency = 1.0;
  
  for (var i = 0u; i < octaves; i = i + 1u) {
    value += amplitude * noise2D(x * frequency, y * frequency, seed + i * 1000u);
    amplitude *= 0.5;
    frequency *= 2.0;
  }
  
  return value;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let x = global_id.x;
  let y = global_id.y;
  
  if (x >= uniforms.resolution || y >= uniforms.resolution) {
    return;
  }
  
  let step = uniforms.tileSize / f32(uniforms.resolution - 1u);
  let worldX = uniforms.tileX * uniforms.tileSize + f32(x) * step;
  let worldZ = uniforms.tileZ * uniforms.tileSize + f32(y) * step;
  
  // Multi-octave noise for natural terrain
  let height = fbm(worldX * 0.01, worldZ * 0.01, 6u, uniforms.seed) * uniforms.maxHeight;
  
  let idx = x + y * uniforms.resolution;
  heights[idx] = height;
}
`;

/**
 * GPU terrain heightmap with color generation shader.
 */
export const TERRAIN_HEIGHTMAP_COLOR_SHADER = /* wgsl */ `
${WGSL_TERRAIN_STRUCTS}

struct ColorUniforms {
  tileX: f32,
  tileZ: f32,
  tileSize: f32,
  resolution: u32,
  maxHeight: f32,
  waterLevel: f32,
  seed: u32,
  biomeCount: u32,
}

@group(0) @binding(0) var<uniform> uniforms: ColorUniforms;
@group(0) @binding(1) var<storage, read> heights: array<f32>;
@group(0) @binding(2) var<storage, read_write> colors: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let x = global_id.x;
  let y = global_id.y;
  
  if (x >= uniforms.resolution || y >= uniforms.resolution) {
    return;
  }
  
  let idx = x + y * uniforms.resolution;
  let height = heights[idx];
  let normalizedHeight = height / uniforms.maxHeight;
  
  // Simple height-based coloring
  var r = 0.3;
  var g = 0.5;
  var b = 0.2;
  
  if (normalizedHeight < uniforms.waterLevel) {
    // Water
    r = 0.2; g = 0.4; b = 0.6;
  } else if (normalizedHeight < 0.3) {
    // Beach/sand
    r = 0.76; g = 0.7; b = 0.5;
  } else if (normalizedHeight < 0.6) {
    // Grass
    r = 0.3; g = 0.5 + normalizedHeight * 0.3; b = 0.2;
  } else if (normalizedHeight < 0.8) {
    // Rock
    r = 0.5; g = 0.5; b = 0.5;
  } else {
    // Snow
    r = 0.95; g = 0.95; b = 0.95;
  }
  
  let colorIdx = idx * 3u;
  colors[colorIdx] = r;
  colors[colorIdx + 1u] = g;
  colors[colorIdx + 2u] = b;
}
`;

// ============================================================================
// COMBINED EXPORTS
// ============================================================================

/**
 * All terrain-related compute shaders.
 */
export const TERRAIN_SHADERS = {
  // New shaders
  ROAD_INFLUENCE: ROAD_INFLUENCE_SHADER,
  VERTEX_COLOR: TERRAIN_VERTEX_COLOR_SHADER,
  INSTANCE_MATRIX: INSTANCE_MATRIX_SHADER,
  BATCH_DISTANCE: BATCH_DISTANCE_SHADER,
  // Legacy heightmap shaders
  HEIGHTMAP: TERRAIN_HEIGHTMAP_SHADER,
  HEIGHTMAP_COLOR: TERRAIN_HEIGHTMAP_COLOR_SHADER,
};
