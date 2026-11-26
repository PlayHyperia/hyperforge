/**
 * Three.js Resource Manager
 * Provides safe and comprehensive cleanup of Three.js resources to prevent memory leaks
 */

import { THREE } from "@hyperforge/shared";

/**
 * ThreeResourceManager - Memory management for Three.js resources
 *
 * Provides comprehensive cleanup of Three.js objects to prevent memory leaks.
 * Handles disposal of geometries, materials, textures, and scene objects.
 *
 * @remarks
 * Three.js doesn't automatically garbage collect GPU resources. Manual disposal
 * is required to prevent memory leaks, especially in long-running applications.
 *
 * @public
 */
export class ThreeResourceManager {
  /** Tracks disposed objects to prevent double-disposal */
  private static disposedObjects = new WeakSet();

  /**
   * Safely disposes of a Three.js object and all its children
   *
   * Recursively traverses the object hierarchy and disposes all geometries,
   * materials, and textures. Prevents double-disposal using a WeakSet.
   *
   * @param object - The Three.js object to dispose (mesh, group, scene, etc.)
   * @param options - Disposal configuration options
   *
   * @example
   * ```typescript
   * const mesh = new THREE.Mesh(geometry, material);
   * ThreeResourceManager.disposeObject(mesh, {
   *   disposeGeometry: true,
   *   disposeMaterial: true,
   *   disposeTextures: true,
   *   removeFromParent: true
   * });
   * ```
   *
   * @public
   */
  static disposeObject(
    object: THREE.Object3D,
    options: {
      disposeGeometry?: boolean;
      disposeMaterial?: boolean;
      disposeTextures?: boolean;
      removeFromParent?: boolean;
    } = {},
  ): void {
    const {
      disposeGeometry = true,
      disposeMaterial = true,
      disposeTextures = true,
      removeFromParent = true,
    } = options;

    // Prevent double disposal
    if (this.disposedObjects.has(object)) {
      console.warn("[ThreeResourceManager] Object already disposed:", object);
      return;
    }

    // Traverse all children and dispose recursively
    object.traverse((child) => {
      this.disposeObjectInternal(child, {
        disposeGeometry,
        disposeMaterial,
        disposeTextures,
      });
    });

    // Remove from parent if requested
    if (removeFromParent && object.parent) {
      object.parent.remove(object as never);
    }

    // Mark as disposed
    this.disposedObjects.add(object);
  }

  /**
   * Internal disposal logic for individual objects
   *
   * Handles disposal of specific object types (meshes, lights, cameras).
   * Called recursively by disposeObject for each node in the hierarchy.
   *
   * @param object - Three.js object to dispose
   * @param options - Disposal configuration
   *
   * @internal
   */
  private static disposeObjectInternal(
    object: THREE.Object3D,
    options: {
      disposeGeometry: boolean;
      disposeMaterial: boolean;
      disposeTextures: boolean;
    },
  ): void {
    const { disposeGeometry, disposeMaterial, disposeTextures } = options;

    // Handle mesh objects
    if (object instanceof THREE.Mesh) {
      // Dispose geometry
      if (
        disposeGeometry &&
        object.geometry &&
        !this.disposedObjects.has(object.geometry)
      ) {
        object.geometry.dispose();
        this.disposedObjects.add(object.geometry);
      }

      // Dispose materials
      if (disposeMaterial && object.material) {
        this.disposeMaterial(object.material, disposeTextures);
      }
    }

    // Handle the concrete light classes that own shadow-map render targets.
    // LightShadow.dispose() releases both the primary and variance shadow maps.
    if (
      object instanceof THREE.DirectionalLight ||
      object instanceof THREE.PointLight ||
      object instanceof THREE.SpotLight
    ) {
      object.shadow.dispose();
    }

    // Handle cameras with render targets
    if (object instanceof THREE.Camera) {
      // Cameras themselves don't need disposal, but any attached render targets do
      // This is handled elsewhere, but we clear references
      object.clear();
    }

    // Clear any custom userData that might hold references
    if (object.userData) {
      Object.keys(object.userData).forEach((key) => {
        delete object.userData[key];
      });
    }
  }

  /**
   * Disposes of materials safely
   *
   * Handles both single materials and material arrays (for multi-material meshes).
   * Optionally disposes of all textures referenced by the materials.
   *
   * @param material - Material or array of materials to dispose
   * @param disposeTextures - Whether to also dispose material textures
   *
   * @internal
   */
  private static disposeMaterial(
    material: THREE.Material | THREE.Material[],
    disposeTextures: boolean,
  ): void {
    const materials = Array.isArray(material) ? material : [material];

    materials.forEach((mat) => {
      if (this.disposedObjects.has(mat)) {
        return;
      }

      // Dispose textures if requested
      if (disposeTextures) {
        this.disposeMaterialTextures(mat);
      }

      // Dispose the material itself
      mat.dispose();
      this.disposedObjects.add(mat);
    });
  }

  /**
   * Material with optional texture properties for dynamic access
   * Used for disposing textures from various material types
   *
   * IMPORTANT: This list must include ALL texture properties from Three.js materials
   * to prevent GPU memory leaks. When Three.js adds new material types or texture
   * properties, update this list.
   */
  private static readonly TEXTURE_PROPERTIES = [
    // Standard texture maps
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
    // Clearcoat (MeshPhysicalMaterial)
    "clearcoatMap",
    "clearcoatRoughnessMap",
    "clearcoatNormalMap",
    // Transmission/Translucency
    "transmissionMap",
    "thicknessMap",
    // Iridescence (Three.js r149+)
    "iridescenceMap",
    "iridescenceThicknessMap",
    // Sheen (Three.js r140+)
    "sheenColorMap",
    "sheenRoughnessMap",
    // Specular (Three.js r138+)
    "specularColorMap",
    "specularIntensityMap",
    // Anisotropy (Three.js r155+)
    "anisotropyMap",
    // Matcap
    "matcap",
    // Gradient map (MeshToonMaterial)
    "gradientMap",
  ] as const;

  /**
   * Disposes of all textures referenced by a material
   *
   * Checks all standard texture properties (map, normalMap, roughnessMap, etc.)
   * and disposes any textures found. Prevents double-disposal.
   *
   * @param material - Material whose textures should be disposed
   *
   * @internal
   */
  private static disposeMaterialTextures(material: THREE.Material): void {
    // Type for materials with optional texture properties
    // MeshStandardMaterial and similar have these as optional properties
    type MaterialWithTextures = THREE.Material & {
      [
        K in (typeof ThreeResourceManager.TEXTURE_PROPERTIES)[number]
      ]?: THREE.Texture | null;
    };

    const materialWithTextures = material as MaterialWithTextures;

    for (const prop of this.TEXTURE_PROPERTIES) {
      const texture = materialWithTextures[prop];
      if (
        texture &&
        texture instanceof THREE.Texture &&
        !this.disposedObjects.has(texture)
      ) {
        texture.dispose();
        this.disposedObjects.add(texture);
      }
    }
  }

  /**
   * Disposes of a renderer and its resources
   *
   * Cleans up render targets and GPU context.
   * Call this when completely removing a renderer from the application.
   *
   * @param renderer - The renderer to dispose
   *
   * @example
   * ```typescript
   * const renderer = await createRenderer();
   * // ... use renderer ...
   * ThreeResourceManager.disposeRenderer(renderer);
   * ```
   *
   * @public
   */
  static disposeRenderer(renderer: { dispose: () => void }): void {
    // Dispose of render targets
    renderer.dispose();
  }

  /**
   * Disposes of a scene and all its contents
   *
   * Recursively disposes all objects in the scene hierarchy.
   * Useful when switching between different scenes or levels.
   *
   * @param scene - The Three.js scene to dispose
   * @param options - Disposal configuration
   *
   * @example
   * ```typescript
   * const scene = new THREE.Scene();
   * // ... populate scene ...
   * ThreeResourceManager.disposeScene(scene, {
   *   disposeGeometry: true,
   *   disposeMaterial: true,
   *   disposeTextures: true
   * });
   * ```
   *
   * @public
   */
  static disposeScene(
    scene: THREE.Scene,
    options: {
      disposeGeometry?: boolean;
      disposeMaterial?: boolean;
      disposeTextures?: boolean;
    } = {},
  ): void {
    // Clone children array since we'll be modifying it
    const children = [...scene.children];

    children.forEach((child) => {
      this.disposeObject(child as THREE.Object3D, {
        ...options,
        removeFromParent: true,
      });
    });

    // Clear the scene
    scene.clear();
  }

  /**
   * Gets current Three.js memory usage statistics from an existing renderer
   *
   * Returns counts of active geometries, textures, and shader programs.
   * Useful for debugging memory leaks and monitoring resource usage.
   *
   * @param renderer - An existing renderer to query info from
   * @returns Object containing memory statistics
   *
   * @example
   * ```typescript
   * const stats = ThreeResourceManager.getMemoryInfo(renderer);
   * console.log(`Geometries: ${stats.geometries}, Textures: ${stats.textures}`);
   * ```
   *
   * @public
   */
  static getMemoryInfo(renderer?: {
    info: {
      memory: { geometries: number; textures: number };
      programs?: unknown[];
    };
  }): {
    geometries: number;
    textures: number;
    programs: number;
  } {
    if (!renderer) {
      return { geometries: 0, textures: 0, programs: 0 };
    }
    const info = renderer.info;
    return {
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length || 0,
    };
  }

  /**
   * Forces garbage collection of disposed objects (development only)
   *
   * Calls window.gc() if available (requires --expose-gc flag in Node.js/Chrome).
   * This is a development/debugging tool - production code should not rely on it.
   *
   * @remarks
   * Only works if garbage collection is exposed via --expose-gc flag.
   * Not available in production browsers.
   *
   * @public
   */
  static forceCleanup(): void {
    // Call garbage collection if available
    if (window.gc) {
      window.gc();
    }
  }

  /** Development memory monitoring interval handle */
  private static devMonitorInterval: ReturnType<typeof setInterval> | null =
    null;

  /**
   * Starts development memory monitoring
   *
   * Periodically logs memory statistics to the console in development mode.
   * This helps identify memory leaks and resource usage patterns.
   *
   * @param intervalMs - Interval between memory reports (default: 5000ms)
   * @param renderer - Optional renderer to get detailed stats from
   *
   * @example
   * ```typescript
   * // Start monitoring every 5 seconds
   * ThreeResourceManager.startDevMonitoring(5000, renderer);
   *
   * // Stop monitoring
   * ThreeResourceManager.stopDevMonitoring();
   * ```
   *
   * @public
   */
  static startDevMonitoring(
    intervalMs: number = 5000,
    renderer?: {
      info: {
        memory: { geometries: number; textures: number };
        programs?: unknown[];
        render: {
          calls: number;
          triangles: number;
          points: number;
          lines: number;
        };
      };
    },
  ): void {
    // Only run in development
    if (import.meta.env.PROD) {
      console.warn(
        "[ThreeResourceManager] Memory monitoring is only available in development",
      );
      return;
    }

    // Stop existing monitoring
    this.stopDevMonitoring();

    let lastStats = { geometries: 0, textures: 0, programs: 0 };

    this.devMonitorInterval = setInterval(() => {
      const stats = this.getMemoryInfo(renderer);
      const delta = {
        geometries: stats.geometries - lastStats.geometries,
        textures: stats.textures - lastStats.textures,
        programs: stats.programs - lastStats.programs,
      };

      // Build memory report
      const report = [
        `[Memory Monitor]`,
        `  Geometries: ${stats.geometries} (${delta.geometries >= 0 ? "+" : ""}${delta.geometries})`,
        `  Textures:   ${stats.textures} (${delta.textures >= 0 ? "+" : ""}${delta.textures})`,
        `  Programs:   ${stats.programs} (${delta.programs >= 0 ? "+" : ""}${delta.programs})`,
      ];

      // Add render stats if available
      if (renderer?.info.render) {
        const r = renderer.info.render;
        report.push(
          `  Render:     ${r.calls} calls, ${r.triangles.toLocaleString()} tris`,
        );
      }

      // Add JS heap info if available (Chrome-specific)
      const perfWithMemory = window.performance as typeof window.performance & {
        memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
      };
      if (perfWithMemory.memory) {
        const used = (
          perfWithMemory.memory.usedJSHeapSize /
          1024 /
          1024
        ).toFixed(1);
        const limit = (
          perfWithMemory.memory.jsHeapSizeLimit /
          1024 /
          1024
        ).toFixed(1);
        report.push(`  JS Heap:    ${used}MB / ${limit}MB`);
      }

      // Warn if resources are increasing rapidly
      if (delta.geometries > 10 || delta.textures > 10) {
        console.warn(report.join("\n"));
        console.warn(
          "[Memory Monitor] Rapid resource increase detected - possible leak!",
        );
      } else {
        console.debug(report.join("\n"));
      }

      lastStats = stats;
    }, intervalMs);

    console.log(
      `[ThreeResourceManager] Started memory monitoring (interval: ${intervalMs}ms)`,
    );
  }

  /**
   * Stops development memory monitoring
   *
   * @public
   */
  static stopDevMonitoring(): void {
    if (this.devMonitorInterval) {
      clearInterval(this.devMonitorInterval);
      this.devMonitorInterval = null;
      console.log("[ThreeResourceManager] Stopped memory monitoring");
    }
  }

  /**
   * Full static teardown — stops the dev monitor and resets the disposed-object
   * tracker. Call this when the game world is completely destroyed (e.g. on
   * page unload or hot-reload) so the next world initialization starts clean.
   *
   * @public
   */
  static teardown(): void {
    this.stopDevMonitoring();
    // Reset the WeakSet so a fresh world doesn't see stale "already disposed" marks
    this.disposedObjects = new WeakSet();
  }
}

// NOTE: useThreeCleanup hook moved to @/hooks/useThreeCleanup.ts
// That version is more complete with refs, auto-unmount cleanup, and proper React patterns.
// Import from there instead: import { useThreeCleanup } from "@/hooks/useThreeCleanup";
