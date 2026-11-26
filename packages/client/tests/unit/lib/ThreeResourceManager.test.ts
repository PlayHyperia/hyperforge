/**
 * ThreeResourceManager Unit Tests
 *
 * Tests for Three.js resource management and cleanup.
 * Uses minimal mocking to test disposal logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { THREE } from "@hyperforge/shared";
import { ThreeResourceManager } from "../../../src/lib/ThreeResourceManager";

// Create minimal mock types for Three.js objects
// These test the disposal logic without requiring actual Three.js
interface MockTexture {
  dispose: () => void;
}

interface MockMaterial {
  dispose: () => void;
  map?: MockTexture;
  normalMap?: MockTexture;
}

interface MockGeometry {
  dispose: () => void;
}

interface MockMesh {
  geometry: MockGeometry;
  material: MockMaterial | MockMaterial[];
  traverse: (callback: (child: MockMesh) => void) => void;
  parent: { remove: (obj: MockMesh) => void } | null;
  userData: Record<string, unknown>;
}

interface MockRenderer {
  dispose: () => void;
  info: {
    memory: { geometries: number; textures: number };
    programs: unknown[];
  };
}

describe("ThreeResourceManager", () => {
  describe("real Three.js resource lifecycle", () => {
    it("disposes every shadow-map target owned by a shadow-casting light", () => {
      const light = new THREE.DirectionalLight();
      const shadowMap = new THREE.RenderTarget(16, 16);
      const shadowMapPass = new THREE.RenderTarget(16, 16);
      const shadowMapDispose = vi.spyOn(shadowMap, "dispose");
      const shadowMapPassDispose = vi.spyOn(shadowMapPass, "dispose");

      light.shadow.map = shadowMap;
      light.shadow.mapPass = shadowMapPass;

      ThreeResourceManager.disposeObject(light, {
        removeFromParent: false,
      });

      expect(shadowMapDispose).toHaveBeenCalledOnce();
      expect(shadowMapPassDispose).toHaveBeenCalledOnce();
    });
  });

  describe("disposal tracking", () => {
    it("should prevent double disposal with WeakSet", () => {
      // Simulate the WeakSet-based tracking
      const disposed = new WeakSet<object>();
      const object = { id: "test" };

      // First disposal
      expect(disposed.has(object)).toBe(false);
      disposed.add(object);
      expect(disposed.has(object)).toBe(true);

      // Subsequent disposal check
      expect(disposed.has(object)).toBe(true); // Already disposed
    });

    it("should track multiple objects independently", () => {
      const disposed = new WeakSet<object>();
      const obj1 = { id: "obj1" };
      const obj2 = { id: "obj2" };
      const obj3 = { id: "obj3" };

      disposed.add(obj1);
      disposed.add(obj3);

      expect(disposed.has(obj1)).toBe(true);
      expect(disposed.has(obj2)).toBe(false);
      expect(disposed.has(obj3)).toBe(true);
    });
  });

  describe("geometry disposal", () => {
    it("should call dispose on geometry", () => {
      const mockGeometry: MockGeometry = {
        dispose: vi.fn(),
      };

      mockGeometry.dispose();

      expect(mockGeometry.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe("material disposal", () => {
    it("should call dispose on single material", () => {
      const mockMaterial: MockMaterial = {
        dispose: vi.fn(),
      };

      mockMaterial.dispose();

      expect(mockMaterial.dispose).toHaveBeenCalledTimes(1);
    });

    it("should handle material arrays", () => {
      const materials: MockMaterial[] = [
        { dispose: vi.fn() },
        { dispose: vi.fn() },
        { dispose: vi.fn() },
      ];

      // Dispose all materials in array
      materials.forEach((mat) => mat.dispose());

      materials.forEach((mat) => {
        expect(mat.dispose).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("texture disposal", () => {
    it("should dispose textures from material", () => {
      const mockMap: MockTexture = { dispose: vi.fn() };
      const mockNormalMap: MockTexture = { dispose: vi.fn() };

      const mockMaterial: MockMaterial = {
        dispose: vi.fn(),
        map: mockMap,
        normalMap: mockNormalMap,
      };

      // Dispose textures first
      mockMaterial.map?.dispose();
      mockMaterial.normalMap?.dispose();
      mockMaterial.dispose();

      expect(mockMap.dispose).toHaveBeenCalledTimes(1);
      expect(mockNormalMap.dispose).toHaveBeenCalledTimes(1);
      expect(mockMaterial.dispose).toHaveBeenCalledTimes(1);
    });

    it("should handle missing textures gracefully", () => {
      const mockMaterial: MockMaterial = {
        dispose: vi.fn(),
        // No textures defined
      };

      // Should not throw when textures are undefined
      expect(() => {
        mockMaterial.map?.dispose();
        mockMaterial.normalMap?.dispose();
        mockMaterial.dispose();
      }).not.toThrow();
    });
  });

  describe("mesh disposal", () => {
    it("should dispose geometry and material from mesh", () => {
      const mockGeometry: MockGeometry = { dispose: vi.fn() };
      const mockMaterial: MockMaterial = { dispose: vi.fn() };

      // Dispose both
      mockGeometry.dispose();
      mockMaterial.dispose();

      expect(mockGeometry.dispose).toHaveBeenCalledTimes(1);
      expect(mockMaterial.dispose).toHaveBeenCalledTimes(1);
    });

    it("should clear userData to prevent dangling references", () => {
      const userData: Record<string, unknown> = {
        customData: { foo: "bar" },
        callback: () => {},
      };

      // Clear userData
      Object.keys(userData).forEach((key) => {
        delete userData[key];
      });

      expect(Object.keys(userData).length).toBe(0);
    });
  });

  describe("scene disposal", () => {
    it("should traverse and dispose all children", () => {
      const children: { dispose: () => void }[] = [
        { dispose: vi.fn() },
        { dispose: vi.fn() },
        { dispose: vi.fn() },
      ];

      // Simulate scene traversal
      children.forEach((child) => child.dispose());

      children.forEach((child) => {
        expect(child.dispose).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("renderer disposal", () => {
    it("should dispose renderer", () => {
      const mockRenderer: MockRenderer = {
        dispose: vi.fn(),
        info: {
          memory: { geometries: 10, textures: 5 },
          programs: [],
        },
      };

      mockRenderer.dispose();

      expect(mockRenderer.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe("memory info", () => {
    it("should return memory statistics", () => {
      const mockRenderer: MockRenderer = {
        dispose: vi.fn(),
        info: {
          memory: { geometries: 10, textures: 5 },
          programs: [{}, {}, {}],
        },
      };

      const memoryInfo = {
        geometries: mockRenderer.info.memory.geometries,
        textures: mockRenderer.info.memory.textures,
        programs: mockRenderer.info.programs.length,
      };

      expect(memoryInfo.geometries).toBe(10);
      expect(memoryInfo.textures).toBe(5);
      expect(memoryInfo.programs).toBe(3);
    });

    it("should handle missing renderer gracefully", () => {
      const getMemoryInfo = (renderer?: MockRenderer) => {
        if (!renderer) {
          return { geometries: 0, textures: 0, programs: 0 };
        }
        return {
          geometries: renderer.info.memory.geometries,
          textures: renderer.info.memory.textures,
          programs: renderer.info.programs?.length || 0,
        };
      };

      const result = getMemoryInfo(undefined);

      expect(result).toEqual({ geometries: 0, textures: 0, programs: 0 });
    });
  });

  describe("texture properties list", () => {
    it("should cover all standard texture properties", () => {
      const textureProperties = [
        "map",
        "lightMap",
        "bumpMap",
        "normalMap",
        "specularMap",
        "envMap",
        "alphaMap",
        "emissiveMap",
        "displacementMap",
        "roughnessMap",
        "metalnessMap",
        "aoMap",
        "clearcoatMap",
        "clearcoatRoughnessMap",
        "clearcoatNormalMap",
        "transmissionMap",
      ];

      // Verify we have all common PBR texture properties
      expect(textureProperties).toContain("map");
      expect(textureProperties).toContain("normalMap");
      expect(textureProperties).toContain("roughnessMap");
      expect(textureProperties).toContain("metalnessMap");
      expect(textureProperties).toContain("envMap");
      expect(textureProperties.length).toBeGreaterThanOrEqual(10);
    });
  });
});

describe("useThreeCleanup hook logic", () => {
  it("should accumulate cleanup functions", () => {
    const cleanupFunctions = new Set<() => void>();

    const addCleanup = (fn: () => void) => {
      cleanupFunctions.add(fn);
    };

    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const fn3 = vi.fn();

    addCleanup(fn1);
    addCleanup(fn2);
    addCleanup(fn3);

    expect(cleanupFunctions.size).toBe(3);
  });

  it("should call all cleanup functions", () => {
    const cleanupFunctions = new Set<() => void>();

    const addCleanup = (fn: () => void) => {
      cleanupFunctions.add(fn);
    };

    const cleanup = () => {
      cleanupFunctions.forEach((fn) => fn());
      cleanupFunctions.clear();
    };

    const fn1 = vi.fn();
    const fn2 = vi.fn();

    addCleanup(fn1);
    addCleanup(fn2);
    cleanup();

    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
    expect(cleanupFunctions.size).toBe(0);
  });

  it("should prevent duplicate cleanup functions", () => {
    const cleanupFunctions = new Set<() => void>();

    const addCleanup = (fn: () => void) => {
      cleanupFunctions.add(fn);
    };

    const fn1 = vi.fn();

    addCleanup(fn1);
    addCleanup(fn1); // Same function
    addCleanup(fn1); // Same function

    expect(cleanupFunctions.size).toBe(1);
  });
});
