/**
 * TerrainComputeContext Tests
 *
 * Tests for GPU-accelerated terrain operations.
 * Note: GPU tests require WebGPU support, which is not available in Node.js.
 * These tests use CPU fallback paths and verify the interface contracts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  TerrainComputeContext,
  isTerrainComputeAvailable,
  packRoadSegments,
  packRoadInfluenceUniforms,
  type GPURoadSegment,
  type GPUBiomeData,
  type GPUInstanceTRS,
} from "../TerrainComputeContext";
import {
  ROAD_INFLUENCE_SHADER,
  ROAD_INFLUENCE_TEXTURE_SHADER,
  TERRAIN_VERTEX_COLOR_SHADER,
  INSTANCE_MATRIX_SHADER,
  BATCH_DISTANCE_SHADER,
  TERRAIN_SHADERS,
} from "../shaders/terrain.wgsl";

describe("TerrainComputeContext", () => {
  describe("actual road upload packets (no GPU execution)", () => {
    it("resolves ordinary defaults and independent shoulder fade/peak in the same eight-float record", () => {
      const ordinary: GPURoadSegment = {
        startX: -0,
        startZ: -100,
        endX: 25,
        endZ: 0,
        width: 6,
      };
      const shoulder: GPURoadSegment = {
        startX: -200,
        startZ: 10,
        endX: -175,
        endZ: 20,
        width: 1.5,
        blendWidth: 2.25,
        maxInfluence: 0.625,
      };
      const before = structuredClone([ordinary, shoulder]);
      const packed = packRoadSegments([ordinary, shoulder]);
      expect(packed).toBeInstanceOf(Float32Array);
      expect(packed.byteLength).toBe(2 * 32);
      expect(Array.from(packed)).toEqual([
        -0, -100, 25, 0, 6, 0.5, 1, 0, -200, 10, -175, 20, 1.5, 2.25, 0.625, 0,
      ]);
      expect(Object.is(packed[0], -0)).toBe(true);
      expect([ordinary, shoulder]).toEqual(before);
      expect(Object.hasOwn(ordinary, "blendWidth")).toBe(false);
      expect(Object.hasOwn(ordinary, "maxInfluence")).toBe(false);
      const otherDefault = packRoadSegments([ordinary, shoulder], 1.75);
      expect(otherDefault[5]).toBe(1.75);
      expect(otherDefault.slice(8)).toEqual(packed.slice(8));
      expect(
        packRoadSegments([
          { ...shoulder, blendWidth: 0, maxInfluence: 0 },
        ]).slice(5, 7),
      ).toEqual(new Float32Array([0, 0]));
      expect(packRoadSegments([]).byteLength).toBe(0);
    });

    it("rejects nonfinite, negative and out-of-range road fields before upload", () => {
      const road: GPURoadSegment = {
        startX: 0,
        startZ: 0,
        endX: 1,
        endZ: 1,
        width: 1,
      };
      for (const overrides of [
        { startX: NaN },
        { endZ: Infinity },
        { startZ: Number.MAX_VALUE },
        { width: -1 },
        { width: Infinity },
        { blendWidth: -0.1 },
        { blendWidth: NaN },
        { maxInfluence: -0.01 },
        { maxInfluence: 1.01 },
        { maxInfluence: Infinity },
      ])
        expect(() => packRoadSegments([{ ...road, ...overrides }])).toThrow();
      for (const blend of [-1, NaN, Infinity])
        expect(() => packRoadSegments([road], blend)).toThrow();
    });

    it("encodes real u32 vertex/road counts and f32 offsets in exactly sixteen uniform bytes", () => {
      const packet = packRoadInfluenceUniforms(17, 3, { x: 125.5, z: -225.25 });
      expect(packet.byteLength).toBe(16);
      expect(packet).toBeInstanceOf(Uint32Array);
      const view = new DataView(
        packet.buffer,
        packet.byteOffset,
        packet.byteLength,
      );
      expect(view.getUint32(0, true)).toBe(17);
      expect(view.getUint32(4, true)).toBe(3);
      expect(view.getFloat32(8, true)).toBe(125.5);
      expect(view.getFloat32(12, true)).toBe(-225.25);
      // The old float upload reinterpreted 17.0 and 3.0 as enormous u32 counts.
      const oldFloatPacket = new Uint32Array(
        new Float32Array([17, 3, 125.5, -225.25]).buffer,
      );
      expect(oldFloatPacket[0]).not.toBe(packet[0]);
      expect(oldFloatPacket[1]).not.toBe(packet[1]);
      expect(oldFloatPacket.slice(2)).toEqual(packet.slice(2));
      for (const count of [-1, 1.5, NaN, Infinity, 0x100000000]) {
        expect(() =>
          packRoadInfluenceUniforms(count, 1, { x: 0, z: 0 }),
        ).toThrow();
        expect(() =>
          packRoadInfluenceUniforms(1, count, { x: 0, z: 0 }),
        ).toThrow();
      }
      expect(() =>
        packRoadInfluenceUniforms(1, 1, { x: Number.MAX_VALUE, z: 0 }),
      ).toThrow();
    });

    it("declares matching 32-byte road layouts and per-record weighted max unions in both real WGSL sources", () => {
      for (const shader of [
        ROAD_INFLUENCE_SHADER,
        ROAD_INFLUENCE_TEXTURE_SHADER,
      ]) {
        const fields = shader.match(/struct Road \{([\s\S]*?)\}/)?.[1];
        expect(fields).toBeDefined();
        expect(
          [...fields!.matchAll(/(\w+):\s*f32/g)].map((match) => match[1]),
        ).toEqual([
          "startX",
          "startZ",
          "endX",
          "endZ",
          "width",
          "blendWidth",
          "maxInfluence",
          "padding3",
        ]);
        expect(shader).toContain(
          "let totalInfluenceWidth = halfWidth + road.blendWidth;",
        );
        expect(shader).toContain("if (dist >= totalInfluenceWidth)");
        expect(shader).toContain("influence = road.maxInfluence;");
        expect(shader).toContain(
          "influence = t * t * (3.0 - 2.0 * t) * road.maxInfluence;",
        );
        expect(shader).toContain(
          "maxInfluence = max(maxInfluence, influence);",
        );
        expect(shader).not.toContain("/ uniforms.blendWidth");
      }
      expect(ROAD_INFLUENCE_SHADER).toMatch(
        /struct Uniforms \{\s*vertexCount: u32,\s*roadCount: u32,\s*tileOffsetX: f32,\s*tileOffsetZ: f32,/,
      );
    });
  });
  describe("shader exports", () => {
    it("should export road influence shader", () => {
      expect(ROAD_INFLUENCE_SHADER).toBeDefined();
      expect(ROAD_INFLUENCE_SHADER).toContain("@compute");
      expect(ROAD_INFLUENCE_SHADER).toContain("distanceToLineSegment");
    });

    it("should export terrain vertex color shader", () => {
      expect(TERRAIN_VERTEX_COLOR_SHADER).toBeDefined();
      expect(TERRAIN_VERTEX_COLOR_SHADER).toContain("@compute");
      expect(TERRAIN_VERTEX_COLOR_SHADER).toContain("BiomeData");
    });

    it("should export instance matrix shader", () => {
      expect(INSTANCE_MATRIX_SHADER).toBeDefined();
      expect(INSTANCE_MATRIX_SHADER).toContain("@compute");
      expect(INSTANCE_MATRIX_SHADER).toContain("InstanceTRS");
    });

    it("should export batch distance shader", () => {
      expect(BATCH_DISTANCE_SHADER).toBeDefined();
      expect(BATCH_DISTANCE_SHADER).toContain("@compute");
      expect(BATCH_DISTANCE_SHADER).toContain("nearestIndices");
    });

    it("should export combined TERRAIN_SHADERS object", () => {
      expect(TERRAIN_SHADERS).toBeDefined();
      expect(TERRAIN_SHADERS.ROAD_INFLUENCE).toBe(ROAD_INFLUENCE_SHADER);
      expect(TERRAIN_SHADERS.VERTEX_COLOR).toBe(TERRAIN_VERTEX_COLOR_SHADER);
      expect(TERRAIN_SHADERS.INSTANCE_MATRIX).toBe(INSTANCE_MATRIX_SHADER);
      expect(TERRAIN_SHADERS.BATCH_DISTANCE).toBe(BATCH_DISTANCE_SHADER);
    });
  });

  describe("isTerrainComputeAvailable", () => {
    it("should return a boolean", () => {
      const result = isTerrainComputeAvailable();
      expect(typeof result).toBe("boolean");
    });

    // In Node.js/Vitest environment, WebGPU is not available
    it("should return false in Node.js environment", () => {
      expect(isTerrainComputeAvailable()).toBe(false);
    });
  });

  describe("TerrainComputeContext construction", () => {
    it("should create a context with default config", () => {
      const ctx = new TerrainComputeContext();
      expect(ctx).toBeDefined();
      expect(ctx.isReady()).toBe(false); // Not initialized yet
      ctx.destroy();
    });

    it("should create a context with custom config", () => {
      const ctx = new TerrainComputeContext({
        minVerticesForGPU: 500,
        minRoadsForGPU: 2,
        minInstancesForGPU: 1000,
      });
      expect(ctx).toBeDefined();
      ctx.destroy();
    });
  });

  describe("shouldUseGPU methods", () => {
    let ctx: TerrainComputeContext;

    beforeEach(() => {
      ctx = new TerrainComputeContext({
        minVerticesForGPU: 100,
        minRoadsForGPU: 2,
        minInstancesForGPU: 50,
      });
    });

    afterEach(() => {
      ctx.destroy();
    });

    it("should return false for road influence when not initialized", () => {
      expect(ctx.shouldUseGPUForRoadInfluence(1000, 5)).toBe(false);
    });

    it("should return false for instance matrices when not initialized", () => {
      expect(ctx.shouldUseGPUForInstanceMatrices(1000)).toBe(false);
    });

    it("should return false for small batches (when initialized)", () => {
      // Even after initialization, small batches should use CPU
      // Since we can't actually initialize GPU in tests, this verifies the threshold logic
      const smallCtx = new TerrainComputeContext({
        minVerticesForGPU: 1000000, // Very high threshold
        minRoadsForGPU: 1000,
        minInstancesForGPU: 1000000,
      });
      expect(smallCtx.shouldUseGPUForRoadInfluence(100, 1)).toBe(false);
      expect(smallCtx.shouldUseGPUForInstanceMatrices(10)).toBe(false);
      smallCtx.destroy();
    });
  });

  describe("getRuntimeContext", () => {
    it("should return the underlying RuntimeComputeContext", () => {
      const ctx = new TerrainComputeContext();
      const runtimeCtx = ctx.getRuntimeContext();
      expect(runtimeCtx).toBeDefined();
      expect(runtimeCtx.isReady()).toBe(false);
      ctx.destroy();
    });
  });

  describe("type interfaces", () => {
    it("should have correct GPURoadSegment interface", () => {
      const road: GPURoadSegment = {
        startX: 0,
        startZ: 0,
        endX: 100,
        endZ: 100,
        width: 5,
      };
      expect(road.startX).toBe(0);
      expect(road.width).toBe(5);
    });

    it("should have correct GPUBiomeData interface", () => {
      const biome: GPUBiomeData = {
        colorR: 0.3,
        colorG: 0.5,
        colorB: 0.2,
        heightScale: 1.0,
      };
      expect(biome.colorR).toBe(0.3);
      expect(biome.heightScale).toBe(1.0);
    });

    it("should have correct GPUInstanceTRS interface", () => {
      const instance: GPUInstanceTRS = {
        posX: 10,
        posY: 20,
        posZ: 30,
        quatX: 0,
        quatY: 0,
        quatZ: 0,
        quatW: 1,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1,
      };
      expect(instance.posX).toBe(10);
      expect(instance.quatW).toBe(1);
    });
  });
});

describe("WGSL Shader Validation", () => {
  describe("Road Influence Shader", () => {
    it("should have correct struct definitions", () => {
      expect(ROAD_INFLUENCE_SHADER).toContain("struct Road {");
      expect(ROAD_INFLUENCE_SHADER).toContain("struct Uniforms {");
    });

    it("should have correct bindings", () => {
      expect(ROAD_INFLUENCE_SHADER).toContain("@group(0) @binding(0)");
      expect(ROAD_INFLUENCE_SHADER).toContain("@group(0) @binding(1)");
      expect(ROAD_INFLUENCE_SHADER).toContain("@group(0) @binding(2)");
      expect(ROAD_INFLUENCE_SHADER).toContain("@group(0) @binding(3)");
    });

    it("should have workgroup size defined", () => {
      expect(ROAD_INFLUENCE_SHADER).toContain("@workgroup_size(64)");
    });

    it("should implement distance calculation", () => {
      expect(ROAD_INFLUENCE_SHADER).toContain("fn distanceToLineSegment");
      expect(ROAD_INFLUENCE_SHADER).toContain("clamp(");
      expect(ROAD_INFLUENCE_SHADER).toContain("sqrt(");
    });
  });

  describe("Terrain Vertex Color Shader", () => {
    it("should have correct struct definitions", () => {
      expect(TERRAIN_VERTEX_COLOR_SHADER).toContain("struct BiomeData {");
      expect(TERRAIN_VERTEX_COLOR_SHADER).toContain("struct Uniforms {");
    });

    it("should have shore color constants", () => {
      expect(TERRAIN_VERTEX_COLOR_SHADER).toContain("SHORE_R");
      expect(TERRAIN_VERTEX_COLOR_SHADER).toContain("SHORE_G");
      expect(TERRAIN_VERTEX_COLOR_SHADER).toContain("SHORE_B");
    });

    it("should have road color constants", () => {
      expect(TERRAIN_VERTEX_COLOR_SHADER).toContain("ROAD_R");
      expect(TERRAIN_VERTEX_COLOR_SHADER).toContain("ROAD_G");
      expect(TERRAIN_VERTEX_COLOR_SHADER).toContain("ROAD_B");
    });

    it("should handle biome blending", () => {
      expect(TERRAIN_VERTEX_COLOR_SHADER).toContain("MAX_BIOME_INFLUENCES");
      expect(TERRAIN_VERTEX_COLOR_SHADER).toContain("biomeInfluences");
    });
  });

  describe("Instance Matrix Shader", () => {
    it("should have correct struct definition", () => {
      expect(INSTANCE_MATRIX_SHADER).toContain("struct InstanceTRS {");
      expect(INSTANCE_MATRIX_SHADER).toContain("posX: f32");
      expect(INSTANCE_MATRIX_SHADER).toContain("quatX: f32");
      expect(INSTANCE_MATRIX_SHADER).toContain("scaleX: f32");
    });

    it("should compute quaternion to rotation matrix", () => {
      expect(INSTANCE_MATRIX_SHADER).toContain("let x2 = x + x");
      expect(INSTANCE_MATRIX_SHADER).toContain("let xx = x * x2");
    });

    it("should output 16 floats per matrix", () => {
      expect(INSTANCE_MATRIX_SHADER).toContain("let base = idx * 16u");
    });

    it("should set translation in column 3", () => {
      expect(INSTANCE_MATRIX_SHADER).toContain(
        "matrices[base + 12u] = inst.posX",
      );
      expect(INSTANCE_MATRIX_SHADER).toContain(
        "matrices[base + 13u] = inst.posY",
      );
      expect(INSTANCE_MATRIX_SHADER).toContain(
        "matrices[base + 14u] = inst.posZ",
      );
      expect(INSTANCE_MATRIX_SHADER).toContain("matrices[base + 15u] = 1.0");
    });
  });

  describe("Batch Distance Shader", () => {
    it("should have distance functions", () => {
      expect(BATCH_DISTANCE_SHADER).toContain("fn distanceSquared3D");
      expect(BATCH_DISTANCE_SHADER).toContain("fn distanceSquaredXZ");
    });

    it("should support XZ-only distance mode", () => {
      expect(BATCH_DISTANCE_SHADER).toContain("useXZDistance");
      expect(BATCH_DISTANCE_SHADER).toContain("uniforms.useXZDistance == 1u");
    });

    it("should track nearest target index", () => {
      expect(BATCH_DISTANCE_SHADER).toContain("nearestIndices");
      expect(BATCH_DISTANCE_SHADER).toContain("nearestIdx");
    });
  });
});

describe("CPU Fallback Logic", () => {
  describe("Road Influence CPU calculation", () => {
    it("should return correct influence at road center", () => {
      // This tests the algorithm we expect to use in CPU fallback
      const roadWidth = 5;
      const halfWidth = roadWidth / 2;
      const blendWidth = 2;

      // At center of road (distance = 0)
      const distance = 0;
      const totalInfluenceWidth = halfWidth + blendWidth;

      let influence: number;
      if (distance >= totalInfluenceWidth) {
        influence = 0;
      } else if (distance <= halfWidth) {
        influence = 1.0;
      } else {
        const t = 1.0 - (distance - halfWidth) / blendWidth;
        influence = t * t * (3 - 2 * t); // smoothstep
      }

      expect(influence).toBe(1.0);
    });

    it("should return zero influence outside road area", () => {
      const roadWidth = 5;
      const halfWidth = roadWidth / 2;
      const blendWidth = 2;

      // Far from road
      const distance = 10;
      const totalInfluenceWidth = halfWidth + blendWidth;

      let influence: number;
      if (distance >= totalInfluenceWidth) {
        influence = 0;
      } else if (distance <= halfWidth) {
        influence = 1.0;
      } else {
        const t = 1.0 - (distance - halfWidth) / blendWidth;
        influence = t * t * (3 - 2 * t);
      }

      expect(influence).toBe(0);
    });

    it("should return smoothstep influence in blend zone", () => {
      const roadWidth = 5;
      const halfWidth = roadWidth / 2;
      const blendWidth = 2;

      // At edge of road (distance = halfWidth + blendWidth/2)
      const distance = halfWidth + blendWidth / 2;
      const totalInfluenceWidth = halfWidth + blendWidth;

      let influence: number;
      if (distance >= totalInfluenceWidth) {
        influence = 0;
      } else if (distance <= halfWidth) {
        influence = 1.0;
      } else {
        const t = 1.0 - (distance - halfWidth) / blendWidth;
        influence = t * t * (3 - 2 * t); // smoothstep
      }

      // At midpoint of blend zone, t = 0.5, smoothstep(0.5) = 0.5
      expect(influence).toBeCloseTo(0.5, 5);
    });
  });

  describe("Distance to line segment", () => {
    function distanceToLineSegment(
      px: number,
      pz: number,
      ax: number,
      az: number,
      bx: number,
      bz: number,
    ): number {
      const abx = bx - ax;
      const abz = bz - az;
      const abLenSq = abx * abx + abz * abz;

      if (abLenSq < 0.001) {
        // Degenerate segment
        return Math.sqrt((px - ax) ** 2 + (pz - az) ** 2);
      }

      const apx = px - ax;
      const apz = pz - az;
      const t = Math.max(0, Math.min(1, (apx * abx + apz * abz) / abLenSq));

      const closestX = ax + t * abx;
      const closestZ = az + t * abz;

      return Math.sqrt((px - closestX) ** 2 + (pz - closestZ) ** 2);
    }

    it("should return 0 for point on segment start", () => {
      const dist = distanceToLineSegment(0, 0, 0, 0, 10, 0);
      expect(dist).toBeCloseTo(0, 5);
    });

    it("should return 0 for point on segment end", () => {
      const dist = distanceToLineSegment(10, 0, 0, 0, 10, 0);
      expect(dist).toBeCloseTo(0, 5);
    });

    it("should return correct perpendicular distance", () => {
      // Point at (5, 5), segment from (0, 0) to (10, 0)
      const dist = distanceToLineSegment(5, 5, 0, 0, 10, 0);
      expect(dist).toBeCloseTo(5, 5);
    });

    it("should clamp to segment endpoints", () => {
      // Point at (-5, 0), segment from (0, 0) to (10, 0)
      // Should be distance to start point
      const dist = distanceToLineSegment(-5, 0, 0, 0, 10, 0);
      expect(dist).toBeCloseTo(5, 5);
    });

    it("should handle degenerate segment (point)", () => {
      const dist = distanceToLineSegment(3, 4, 0, 0, 0, 0);
      expect(dist).toBeCloseTo(5, 5); // 3-4-5 triangle
    });
  });

  describe("Matrix composition", () => {
    it("should produce identity matrix for identity TRS", () => {
      // Identity: position (0,0,0), quaternion (0,0,0,1), scale (1,1,1)
      const pos = { x: 0, y: 0, z: 0 };
      const quat = { x: 0, y: 0, z: 0, w: 1 };
      const scale = { x: 1, y: 1, z: 1 };

      // Compose matrix (simplified algorithm matching shader)
      const x = quat.x,
        y = quat.y,
        z = quat.z,
        w = quat.w;
      const x2 = x + x,
        y2 = y + y,
        z2 = z + z;
      const xx = x * x2,
        xy = x * y2,
        xz = x * z2;
      const yy = y * y2,
        yz = y * z2,
        zz = z * z2;
      const wx = w * x2,
        wy = w * y2,
        wz = w * z2;

      const matrix = new Float32Array(16);
      // Column 0
      matrix[0] = (1 - (yy + zz)) * scale.x;
      matrix[1] = (xy + wz) * scale.x;
      matrix[2] = (xz - wy) * scale.x;
      matrix[3] = 0;
      // Column 1
      matrix[4] = (xy - wz) * scale.y;
      matrix[5] = (1 - (xx + zz)) * scale.y;
      matrix[6] = (yz + wx) * scale.y;
      matrix[7] = 0;
      // Column 2
      matrix[8] = (xz + wy) * scale.z;
      matrix[9] = (yz - wx) * scale.z;
      matrix[10] = (1 - (xx + yy)) * scale.z;
      matrix[11] = 0;
      // Column 3
      matrix[12] = pos.x;
      matrix[13] = pos.y;
      matrix[14] = pos.z;
      matrix[15] = 1;

      // Should be identity matrix
      expect(matrix[0]).toBeCloseTo(1, 5);
      expect(matrix[5]).toBeCloseTo(1, 5);
      expect(matrix[10]).toBeCloseTo(1, 5);
      expect(matrix[15]).toBeCloseTo(1, 5);
      // Off-diagonal should be 0
      expect(matrix[1]).toBeCloseTo(0, 5);
      expect(matrix[4]).toBeCloseTo(0, 5);
    });

    it("should apply translation correctly", () => {
      const pos = { x: 10, y: 20, z: 30 };
      const quat = { x: 0, y: 0, z: 0, w: 1 };
      const scale = { x: 1, y: 1, z: 1 };

      const matrix = new Float32Array(16);
      // ... (same composition as above)
      const x = quat.x,
        y = quat.y,
        z = quat.z,
        w = quat.w;
      const x2 = x + x,
        y2 = y + y,
        z2 = z + z;
      const xx = x * x2,
        xy = x * y2,
        xz = x * z2;
      const yy = y * y2,
        yz = y * z2,
        zz = z * z2;
      const wx = w * x2,
        wy = w * y2,
        wz = w * z2;

      matrix[0] = (1 - (yy + zz)) * scale.x;
      matrix[1] = (xy + wz) * scale.x;
      matrix[2] = (xz - wy) * scale.x;
      matrix[3] = 0;
      matrix[4] = (xy - wz) * scale.y;
      matrix[5] = (1 - (xx + zz)) * scale.y;
      matrix[6] = (yz + wx) * scale.y;
      matrix[7] = 0;
      matrix[8] = (xz + wy) * scale.z;
      matrix[9] = (yz - wx) * scale.z;
      matrix[10] = (1 - (xx + yy)) * scale.z;
      matrix[11] = 0;
      matrix[12] = pos.x;
      matrix[13] = pos.y;
      matrix[14] = pos.z;
      matrix[15] = 1;

      expect(matrix[12]).toBe(10);
      expect(matrix[13]).toBe(20);
      expect(matrix[14]).toBe(30);
    });

    it("should apply scale correctly", () => {
      const quat = { x: 0, y: 0, z: 0, w: 1 };
      const scale = { x: 2, y: 3, z: 4 };

      const x = quat.x,
        y = quat.y,
        z = quat.z;
      const x2 = x + x,
        y2 = y + y,
        z2 = z + z;
      const xx = x * x2;
      const yy = y * y2,
        zz = z * z2;

      const matrix = new Float32Array(16);
      matrix[0] = (1 - (yy + zz)) * scale.x;
      matrix[5] = (1 - (xx + zz)) * scale.y;
      matrix[10] = (1 - (xx + yy)) * scale.z;

      expect(matrix[0]).toBeCloseTo(2, 5);
      expect(matrix[5]).toBeCloseTo(3, 5);
      expect(matrix[10]).toBeCloseTo(4, 5);
    });
  });
});
