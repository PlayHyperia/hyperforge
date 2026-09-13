import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import THREE, { float, vec3 } from "../../../../extras/three/three";
import { World } from "../../../../core/World";
import { ClientLoader } from "../../../client/ClientLoader";
import { modelCache } from "../../../../utils/rendering/ModelCache";
import { Environment } from "../Environment";
import { TerrainSystem } from "../TerrainSystem";
import { WaterSystem } from "../WaterSystem";
import { VegetationSystem } from "../VegetationSystem";
import { createGPUVegetationMaterial } from "../GPUMaterials";
import { FrustumQuadtree } from "../../../../utils/spatial/FrustumQuadtree";

// Actual registered owners and Three CPU objects. No renderer, IndexedDB or
// pixel/shadow quality is impersonated by these lifecycle/selection fixtures.
type AssetData = Parameters<VegetationSystem["getOrCreateChunkedMesh"]>[3];
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

function box(segments = 1) {
  const geometry = new THREE.BoxGeometry(1, 1, 1, segments, segments, segments);
  geometry.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(
      new Float32Array(geometry.getAttribute("position").count * 3).fill(0.5),
      3,
    ),
  );
  geometry.computeBoundingBox();
  return geometry;
}

function fixture(
  ready = true,
  options: { finalView?: boolean; screenSpaceLod?: boolean } = {},
) {
  const world = new World();
  const terrain = world.register("terrain", TerrainSystem) as TerrainSystem;
  const environment = world.register("environment", Environment) as Environment;
  const vegetation = world.register(
    "vegetation",
    VegetationSystem,
  ) as VegetationSystem;
  const water = new WaterSystem(world);
  terrain["waterSystem"] = water;
  water.setReflectionsEnabled(false);
  const sun = new THREE.DirectionalLight();
  sun.castShadow = true;
  sun.position.set(20, 130, 101);
  sun.target.position.set(20, 30, 1);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -250;
  sun.shadow.camera.right = sun.shadow.camera.top = 250;
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = 500;
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.map = new THREE.RenderTarget(1024, 1024);
  environment.sunLight = sun;
  world.stage.scene.add(sun, sun.target, world.rig);
  const group = new THREE.Group();
  world.stage.scene.add(group);
  vegetation["vegetationGroup"] = group;
  if (options.finalView) {
    // The same real spatial owner/configuration used by client init. Starting
    // it directly avoids impersonating a browser merely to bypass init's guard.
    vegetation["chunkQuadtree"] = new FrustumQuadtree({
      centerX: 0,
      centerZ: 0,
      halfSize: 8192,
      maxDepth: 8,
      maxItemsPerNode: 16,
    });
  }
  const material = createGPUVegetationMaterial({ vertexColors: true });
  vegetation["sharedVegetationMaterial"] = material;
  const heroSource = box(2),
    lodSource = box();
  const sourceMaterial = new THREE.MeshStandardMaterial();
  const data: AssetData = {
    geometry: heroSource,
    material: sourceMaterial,
    gpuMaterial: material,
    asset: {
      id: "mushroom",
      category: "mushroom",
      model: "hero.glb",
      lod1Model: "lod.glb",
      baseScale: 1,
      scaleVariation: [1, 1],
      randomRotation: false,
      weight: 1,
      screenSpaceLod: Object.freeze({
        maxSurfaceError: 0.01,
        enterErrorPixels: 0.25,
        exitErrorPixels: 0.5,
        enterExtentPixels: 10,
        exitExtentPixels: 20,
      }),
    },
    modelBaseOffset: 0,
    boundingSize: Math.sqrt(3),
    lod1Geometry: ready ? lodSource : null,
    lod1Material: null,
    lod1ModelBaseOffset: 0,
    hasLOD1: false,
    lod2Geometry: null,
    lod2Material: null,
    lod2ModelBaseOffset: 0,
    hasLOD2: false,
  };
  if (options.screenSpaceLod === false) delete data.asset.screenSpaceLod;
  vegetation["assetData"].set(data.asset.id, data);
  vegetation["assetDefinitions"].set(data.asset.id, data.asset);
  let serial = 0;
  const add = (z = 1, scale = 1) => {
    expect(
      vegetation["addInstanceToChunk"](
        {
          id: `instance-${serial++}`,
          assetId: "mushroom",
          category: "mushroom",
          position: { x: 20, y: 30, z },
          rotation: { x: 0, y: 0, z: 0 },
          scale,
          tileKey: "fixture-tile",
        },
        data,
      ),
    ).toBe(true);
    vegetation["finalizeChunk"]("0_0_mushroom");
  };
  add();
  const chunk = vegetation["chunkedMeshes"].get("0_0_mushroom")!;
  // Projection/ownership cases deliberately isolate the selector from the
  // separate distance/frustum owner. Final-view cases below never force this.
  if (!options.finalView) chunk.mesh.visible = true;
  const state = vegetation["screenSpaceChunks"].get(chunk)!;
  world.camera.fov = 60;
  world.camera.near = 0.2;
  world.camera.updateProjectionMatrix();
  const select = (distance: number) => {
    world.camera.position.set(20, 30, 1 + distance);
    world.camera.lookAt(20, 30, 1);
    if (options.finalView) vegetation.prepareForRender(world.camera, 1280, 720);
    else vegetation["selectScreenSpaceLodForRender"](world.camera, 1280, 720);
    return state.level;
  };
  cleanup.push(() => {
    world.destroy();
    heroSource.dispose();
    lodSource.dispose();
    sourceMaterial.dispose();
  });
  return {
    world,
    terrain,
    environment,
    vegetation,
    water,
    sun,
    group,
    material,
    data,
    heroSource,
    lodSource,
    sourceMaterial,
    chunk,
    state,
    add,
    select,
  };
}

describe("isolated static vegetation LOD selector actual CPU ownership", () => {
  it("swaps only geometry on the original mesh, retaining material, matrices, instance attributes, count and hysteresis", () => {
    const f = fixture(),
      mesh = f.chunk.mesh;
    const matrix = mesh.instanceMatrix,
      matrixBytes = matrix.array.slice(),
      version = matrix.version;
    const attributes = [
      f.chunk.positionAttr,
      f.chunk.scaleAttr,
      f.chunk.rotationAttr,
    ];
    const attributeVersions = attributes.map((a) => a.version);
    expect([10, 100, 60, 25, 60, 100].map(f.select)).toEqual([
      0, 1, 1, 0, 0, 1,
    ]);
    expect(f.chunk.mesh).toBe(mesh);
    expect(mesh.geometry).toBe(f.state.lodGeometry);
    expect(mesh.material).toBe(f.material);
    expect(mesh.instanceMatrix).toBe(matrix);
    expect(matrix.array).toEqual(matrixBytes);
    expect(matrix.version).toBe(version);
    expect(attributes.map((a) => a.version)).toEqual(attributeVersions);
    for (const geometry of [f.state.heroGeometry, f.state.lodGeometry!]) {
      expect(geometry.getAttribute("instancePosition")).toBe(attributes[0]);
      expect(geometry.getAttribute("instanceScale")).toBe(attributes[1]);
      expect(geometry.getAttribute("instanceRotationY")).toBe(attributes[2]);
    }
    expect(mesh.count).toBe(1);
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(false);
    expect(f.group.children).toEqual([mesh]);
    expect(f.vegetation["lod1ChunkedMeshes"].size).toBe(0);
    expect(f.vegetation["lod2ChunkedMeshes"].size).toBe(0);
  });

  it("measures every actual instance, not the chunk center or first matrix", () => {
    const f = fixture();
    f.add(62);
    expect(f.chunk.count).toBe(2);
    expect(f.select(200)).toBe(1);
    // Near the second instance only. The midpoint remains inside the retention
    // band, so a center/first-only implementation would incorrectly retain LOD1.
    expect(f.select(71)).toBe(0);
    expect(f.state.extentPixels).toBeGreaterThan(60);
    expect(f.chunk.mesh.count).toBe(2);
  });

  it("uses final parent/model/light transforms and current viewport scale", () => {
    const f = fixture();
    expect(f.select(100)).toBe(1);
    f.group.scale.setScalar(10);
    f.group.position.set(-180, -270, -9);
    expect(f.select(100)).toBe(0);
    expect(f.state.extentPixels).toBeGreaterThan(60);
    f.group.scale.setScalar(1);
    f.group.position.set(0, 0, 0);
    expect(f.select(100)).toBe(1);
    // A late rig translation brings the actual camera near; no update-phase
    // camera or light matrix refresh is invoked by this fixture.
    f.world.rig.position.z = -90;
    expect(f.select(100)).toBe(0);
    f.world.rig.position.z = 0;
    expect(f.select(100)).toBe(1);
    f.vegetation["selectScreenSpaceLodForRender"](f.world.camera, 5120, 2880);
    expect(f.state.level).toBe(0);
    f.sun.position.set(20, 130, 1);
    f.sun.target.position.set(20, 30, 1);
    f.select(100);
    expect(
      f.sun.shadow.camera.getWorldPosition(new THREE.Vector3()).toArray(),
    ).toEqual([20, 130, 1]);
  });

  it.each(["enabled", "owner-missing"])(
    "returns hero for %s water reflections",
    (mode) => {
      const f = fixture();
      expect(f.select(100)).toBe(1);
      if (mode === "enabled") f.water.setReflectionsEnabled(true);
      else f.terrain["waterSystem"] = undefined;
      try {
        expect(f.select(100)).toBe(0);
      } finally {
        f.terrain["waterSystem"] = f.water;
      }
    },
  );

  it.each([
    "missing",
    "other-light",
    "custom-node",
    "null-node",
    "frozen-map",
    "unallocated",
  ])("returns hero for %s shadow ownership", (mode) => {
    const f = fixture();
    expect(f.select(100)).toBe(1);
    const map = f.sun.shadow.map;
    let other: THREE.SpotLight | null = null;
    if (mode === "missing") f.environment.sunLight = null;
    if (mode === "other-light") {
      other = new THREE.SpotLight();
      other.castShadow = true;
      f.world.stage.scene.add(other);
    }
    if (mode === "custom-node")
      Reflect.set(f.sun.shadow, "shadowNode", float(1));
    if (mode === "null-node") Reflect.set(f.sun.shadow, "shadowNode", null);
    if (mode === "frozen-map") f.sun.shadow.autoUpdate = false;
    if (mode === "unallocated") f.sun.shadow.map = null;
    try {
      expect(f.select(100)).toBe(0);
    } finally {
      f.environment.sunLight = f.sun;
      f.sun.shadow.map = map;
      other?.removeFromParent();
      other?.dispose();
    }
  });

  it("retains hero when shadow texel error alone exceeds the main-view threshold", () => {
    const f = fixture();
    expect(f.select(100)).toBe(1);
    f.sun.shadow.camera.left = f.sun.shadow.camera.bottom = -1;
    f.sun.shadow.camera.right = f.sun.shadow.camera.top = 1;
    f.sun.shadow.camera.updateProjectionMatrix();
    expect(f.select(100)).toBe(0);
    expect(f.state.errorPixels).toBeLessThan(0.25);
    expect(f.state.shadowErrorPixels).toBeGreaterThan(0.5);
  });

  it.each(["allocated", "requested"])(
    "bounds the larger %s shadow target during a resolution change",
    (larger) => {
      const f = fixture();
      f.sun.shadow.camera.left = f.sun.shadow.camera.bottom = -10;
      f.sun.shadow.camera.right = f.sun.shadow.camera.top = 10;
      f.sun.shadow.camera.updateProjectionMatrix();
      f.sun.shadow.map!.setSize(32, 32);
      f.sun.shadow.mapSize.set(32, 32);
      expect(f.select(100)).toBe(1);
      if (larger === "allocated") f.sun.shadow.map!.setSize(1024, 1024);
      else f.sun.shadow.mapSize.set(1024, 1024);
      expect(f.select(100)).toBe(0);
      expect(f.state.shadowErrorPixels).toBeGreaterThan(0.5);
    },
  );

  it.each([
    "material-owner",
    "displacement-map",
    "shadow-position",
    "depth-node",
  ])(
    "fails closed for an unqualified %s while preserving the real binding",
    (mode) => {
      const f = fixture();
      expect(f.select(100)).toBe(1);
      const texture = new THREE.Texture();
      const foreign = new THREE.MeshStandardNodeMaterial();
      try {
        if (mode === "material-owner") f.chunk.mesh.material = foreign;
        if (mode === "displacement-map") f.material.displacementMap = texture;
        if (mode === "shadow-position")
          f.material.castShadowPositionNode = vec3(0);
        if (mode === "depth-node") f.material.depthNode = float(0.5);
        expect(f.select(100)).toBe(0);
        expect(f.chunk.mesh.material).toBe(
          mode === "material-owner" ? foreign : f.material,
        );
      } finally {
        f.chunk.mesh.material = f.material;
        f.material.displacementMap = null;
        foreign.dispose();
        texture.dispose();
      }
    },
  );

  it("retains hero at the near plane, for missing LOD data, and for unqualified vertex displacement", () => {
    const f = fixture(false);
    expect(f.select(100)).toBe(0);
    f.data.lod1Geometry = f.lodSource;
    f.vegetation["installScreenSpaceChunkLod"](f.chunk, f.state);
    expect(f.select(100)).toBe(1);
    expect(f.select(0.7)).toBe(0);
    expect(f.state.errorPixels).toBe(Infinity);
    expect(f.select(100)).toBe(1);
    f.material.positionNode = vec3(0);
    expect(f.select(100)).toBe(0);
  });

  it("keeps the finalized world sphere shared while LOD1 is active without changing borrowed source bounds", () => {
    const f = fixture();
    const sourceBounds = f.heroSource.boundingBox!.clone();
    expect(f.select(200)).toBe(1);
    const selected = f.chunk.mesh.geometry;
    f.add(62);
    expect(f.chunk.mesh.geometry).toBe(selected);
    expect(f.state.heroGeometry.boundingSphere).toBe(selected.boundingSphere);
    expect(selected.boundingSphere!.center.toArray()).toEqual([20, 30, 31.5]);
    expect(selected.boundingSphere!.radius).toBe(50.5);
    expect(f.heroSource.boundingBox!.equals(sourceBounds)).toBe(true);
    expect(f.select(10)).toBe(0);
    expect(f.chunk.mesh.geometry.boundingSphere).toBe(selected.boundingSphere);
  });

  it.each(["tile", "world"])(
    "%s retirement disposes both owned geometries and mesh buffers exactly once, never borrowed model sources",
    (owner) => {
      const f = fixture();
      expect(f.select(100)).toBe(1);
      const objects = [
        f.state.heroGeometry,
        f.state.lodGeometry!,
        f.chunk.mesh,
        f.heroSource,
        f.lodSource,
        f.sourceMaterial,
        f.material,
      ];
      const counts = objects.map(() => 0);
      objects.forEach((object, i) =>
        object.addEventListener("dispose", () => counts[i]++),
      );
      if (owner === "tile")
        f.vegetation["removeTileChunkRelationships"]("fixture-tile");
      else f.vegetation.destroy();
      expect(counts).toEqual([1, 1, 1, 0, 0, 0, owner === "world" ? 1 : 0]);
      f.vegetation.destroy();
      expect(counts).toEqual([1, 1, 1, 0, 0, 0, 1]);
      expect(f.vegetation["screenSpaceChunks"].size).toBe(0);
      expect(f.vegetation["chunkedMeshes"].size).toBe(0);
    },
  );

  it("retires chunk ownership before synchronous geometry disposal can reenter world retirement", () => {
    const f = fixture();
    expect(f.select(100)).toBe(1);
    const objects = [f.state.heroGeometry, f.state.lodGeometry!, f.chunk.mesh];
    const counts = objects.map(() => 0);
    objects.forEach((object, i) =>
      object.addEventListener("dispose", () => counts[i]++),
    );
    let reentered = false;
    f.state.heroGeometry.addEventListener("dispose", () => {
      if (!reentered) {
        reentered = true;
        f.vegetation.destroy();
      }
    });
    f.vegetation["removeTileChunkRelationships"]("fixture-tile");
    expect(reentered).toBe(true);
    expect(counts).toEqual([1, 1, 1]);
    expect(f.vegetation["screenSpaceChunks"].size).toBe(0);
    expect(f.vegetation["chunkedMeshes"].size).toBe(0);
  });
});

describe("final vegetation camera reconciliation with actual spatial owners", () => {
  const prepare = (f: ReturnType<typeof fixture>) =>
    f.vegetation.prepareForRender(f.world.camera, 1280, 720);
  const cameraPosition = (f: ReturnType<typeof fixture>) =>
    f.material.gpuUniforms.cameraPos.value.toArray();
  const view = (f: ReturnType<typeof fixture>, distance = 100) => {
    f.world.camera.position.set(20, 30, 1 + distance);
    f.world.camera.lookAt(20, 30, 1);
  };

  it("reconciles final distance, frustum and GPU camera position without any screen-space LOD entries", () => {
    const f = fixture(true, { finalView: true, screenSpaceLod: false });
    expect(f.vegetation["screenSpaceChunks"].size).toBe(0);
    expect(f.chunk.mesh.visible).toBe(false);
    view(f, 1000);
    f.vegetation.update(1 / 60);
    expect(f.chunk.mesh.visible).toBe(false);
    expect(cameraPosition(f)).toEqual([20, 30, 1001]);
    view(f);
    prepare(f);
    expect(f.chunk.mesh.visible).toBe(true);
    expect(cameraPosition(f)).toEqual([20, 30, 101]);
    // Same location, but now the whole buffered chunk is behind the camera.
    f.world.camera.lookAt(20, 30, 201);
    prepare(f);
    expect(f.chunk.mesh.visible).toBe(false);
    view(f);
    prepare(f);
    expect(f.chunk.mesh.visible).toBe(true);
  });

  it("uses the supplied final camera rather than the world's earlier camera", () => {
    const f = fixture(true, { finalView: true, screenSpaceLod: false });
    view(f, 1000);
    f.vegetation.update(1 / 60);
    expect(f.chunk.mesh.visible).toBe(false);
    const finalCamera = new THREE.PerspectiveCamera(60, 16 / 9, 0.2, 1000);
    finalCamera.position.set(20, 30, 101);
    finalCamera.lookAt(20, 30, 1);
    f.world.stage.scene.add(finalCamera);
    f.vegetation.prepareForRender(finalCamera, 1280, 720);
    expect(f.chunk.mesh.visible).toBe(true);
    expect(cameraPosition(f)).toEqual([20, 30, 101]);
    expect(f.world.camera.position.toArray()).toEqual([20, 30, 1001]);
    expect(
      f.vegetation["_culledCameraWorld"].equals(finalCamera.matrixWorld),
    ).toBe(true);
  });

  it.each(["translation", "rotation"])(
    "invalidates the actual camera's parent %s with unchanged local pose",
    (change) => {
      const f = fixture(true, { finalView: true, screenSpaceLod: false });
      f.world.rig.position.set(20, 30, 101);
      f.world.camera.position.set(0, 0, 0);
      f.world.camera.quaternion.identity();
      prepare(f);
      expect(f.chunk.mesh.visible).toBe(true);
      const local = f.world.camera.matrix.clone();
      if (change === "translation") f.world.rig.position.x = 320;
      else f.world.rig.rotation.y = Math.PI;
      prepare(f);
      expect(f.world.camera.matrix.equals(local)).toBe(true);
      expect(f.chunk.mesh.visible).toBe(false);
      expect(cameraPosition(f)).toEqual([
        change === "translation" ? 320 : 20,
        30,
        101,
      ]);
      f.world.rig.position.x = 20;
      f.world.rig.rotation.y = 0;
      prepare(f);
      expect(f.chunk.mesh.visible).toBe(true);
    },
  );

  it("invalidates FOV-only changes against real buffered chunk bounds", () => {
    const f = fixture(true, { finalView: true, screenSpaceLod: false });
    view(f);
    f.world.camera.lookAt(100, 30, 1);
    f.world.camera.fov = 90;
    f.world.camera.updateProjectionMatrix();
    prepare(f);
    expect(f.chunk.mesh.visible).toBe(true);
    const pose = f.world.camera.matrixWorld.clone();
    f.world.camera.fov = 20;
    f.world.camera.updateProjectionMatrix();
    prepare(f);
    expect(f.world.camera.matrixWorld.equals(pose)).toBe(true);
    expect(f.chunk.mesh.visible).toBe(false);
    f.world.camera.fov = 90;
    f.world.camera.updateProjectionMatrix();
    prepare(f);
    expect(f.chunk.mesh.visible).toBe(true);
  });

  it("invalidates view-offset-only changes and restores the uncropped view", () => {
    const f = fixture(true, { finalView: true, screenSpaceLod: false });
    view(f);
    prepare(f);
    expect(f.chunk.mesh.visible).toBe(true);
    const pose = f.world.camera.matrixWorld.clone();
    f.world.camera.setViewOffset(1280, 720, 0, 0, 320, 720);
    prepare(f);
    expect(f.world.camera.matrixWorld.equals(pose)).toBe(true);
    expect(f.chunk.mesh.visible).toBe(false);
    f.world.camera.clearViewOffset();
    prepare(f);
    expect(f.chunk.mesh.visible).toBe(true);
  });

  it.each([
    {
      name: "WebGL",
      coordinateSystem: THREE.WebGLCoordinateSystem,
      reversed: false,
    },
    {
      name: "WebGPU",
      coordinateSystem: THREE.WebGPUCoordinateSystem,
      reversed: false,
    },
    {
      name: "reversed WebGPU",
      coordinateSystem: THREE.WebGPUCoordinateSystem,
      reversed: true,
    },
  ])(
    "honors $name near-plane clipping with the real projection",
    ({ coordinateSystem, reversed }) => {
      const f = fixture(true, { finalView: true, screenSpaceLod: false });
      view(f, 30);
      f.world.camera.coordinateSystem = coordinateSystem;
      // Renderer-owned Camera storage; PerspectiveCamera builds its real matrix
      // from this getter, exactly as the r186 renderer does for reverse depth.
      Reflect.set(f.world.camera, "_reversedDepth", reversed);
      f.world.camera.near = 1;
      f.world.camera.far = 500;
      f.world.camera.updateProjectionMatrix();
      prepare(f);
      expect(f.chunk.mesh.visible).toBe(true);
      // Actual sphere occupies depths [10,50], wholly before near=60. Treating
      // this WebGPU matrix as WebGL would incorrectly admit it near depth ~32.
      f.world.camera.near = 60;
      f.world.camera.updateProjectionMatrix();
      prepare(f);
      expect(f.chunk.mesh.visible).toBe(false);
      expect(f.vegetation["_culledCoordinateSystem"]).toBe(coordinateSystem);
      expect(f.vegetation["_culledReversedDepth"]).toBe(reversed);
      f.world.camera.near = 1;
      f.world.camera.updateProjectionMatrix();
      prepare(f);
      expect(f.chunk.mesh.visible).toBe(true);
    },
  );

  it("does not repeat the full cull for the identical post-update world/projection", () => {
    const f = fixture(true, { finalView: true, screenSpaceLod: false });
    view(f);
    f.vegetation.update(1 / 60);
    expect(f.chunk.mesh.visible).toBe(true);
    // A full real cull swaps these two reused owner sets. Observe that actual
    // lifecycle effect without replacing/wrapping a culler or inventing timings.
    const visible = f.vegetation["_lastVisibleChunks"];
    const scratch = f.vegetation["_currentVisibleChunks"];
    const worldMatrix = f.vegetation["_culledCameraWorld"].clone();
    const projection = f.vegetation["_culledCameraProjection"].clone();
    prepare(f);
    expect(f.vegetation["_lastVisibleChunks"]).toBe(visible);
    expect(f.vegetation["_currentVisibleChunks"]).toBe(scratch);
    expect(f.vegetation["_culledCameraWorld"].equals(worldMatrix)).toBe(true);
    expect(f.vegetation["_culledCameraProjection"].equals(projection)).toBe(
      true,
    );
    expect([...visible]).toEqual(["0_0_mushroom"]);
    f.world.camera.lookAt(20, 30, 201);
    prepare(f);
    expect(f.vegetation["_lastVisibleChunks"]).toBe(scratch);
    expect(f.vegetation["_currentVisibleChunks"]).toBe(visible);
    expect(f.chunk.mesh.visible).toBe(false);
  });

  it("reconciles newly finalized chunks before another update despite an unchanged camera", () => {
    const f = fixture(true, { finalView: true, screenSpaceLod: false });
    f.world.camera.position.set(100, 30, 101);
    f.world.camera.lookAt(100, 30, 1);
    f.world.camera.fov = 20;
    f.world.camera.updateProjectionMatrix();
    prepare(f);
    expect(f.chunk.mesh.visible).toBe(false);
    const pose = f.world.camera.matrixWorld.clone();
    expect(
      f.vegetation["addInstanceToChunk"](
        {
          id: "streamed-finalized-instance",
          assetId: "mushroom",
          category: "mushroom",
          position: { x: 100, y: 30, z: 1 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: 1,
          tileKey: "streamed-tile",
        },
        f.data,
      ),
    ).toBe(true);
    f.vegetation["finalizeChunk"]("1_0_mushroom");
    const added = f.vegetation["chunkedMeshes"].get("1_0_mushroom")!;
    expect(added.mesh.visible).toBe(false);
    expect(f.vegetation["_frustumDirty"]).toBe(true);
    prepare(f);
    expect(f.world.camera.matrixWorld.equals(pose)).toBe(true);
    expect(added.mesh.visible).toBe(true);
    expect(f.chunk.mesh.visible).toBe(false);
    expect([...f.vegetation["_lastVisibleChunks"]]).toEqual(["1_0_mushroom"]);
  });

  it("restores late-camera visibility before choosing the original mesh's LOD", () => {
    const f = fixture(true, { finalView: true });
    view(f, 1000);
    f.vegetation.update(1 / 60);
    expect(f.chunk.mesh.visible).toBe(false);
    expect(f.state.level).toBe(0);
    view(f);
    prepare(f);
    expect(f.chunk.mesh.visible).toBe(true);
    expect(f.state.level).toBe(1);
    expect(f.chunk.mesh.geometry).toBe(f.state.lodGeometry);
    expect(cameraPosition(f)).toEqual([20, 30, 101]);
    view(f, 10);
    prepare(f);
    expect(f.chunk.mesh.visible).toBe(true);
    expect(f.state.level).toBe(0);
    expect(f.chunk.mesh.geometry).toBe(f.state.heroGeometry);
  });
});

// A real single-buffer GLB assembled from Three's box attributes. No loader,
// HTTP response, cache result, or asynchronous completion is substituted.
function boxGLB(): Buffer {
  const geometry = box();
  try {
    const attributes = [
      geometry.getAttribute("position"),
      geometry.getAttribute("normal"),
      geometry.getAttribute("color"),
      geometry.index!,
    ];
    let offset = 0;
    const views = attributes.map((a) => {
      const row = {
        buffer: 0,
        byteOffset: offset,
        byteLength: a.array.byteLength,
      };
      offset += Math.ceil(a.array.byteLength / 4) * 4;
      return row;
    });
    const json = Buffer.from(
      JSON.stringify({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [
          {
            primitives: [
              {
                attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 },
                indices: 3,
              },
            ],
          },
        ],
        buffers: [{ byteLength: offset }],
        bufferViews: views,
        accessors: attributes.map((a, i) => ({
          bufferView: i,
          componentType: i === 3 ? 5123 : 5126,
          count: a.count,
          type: i === 3 ? "SCALAR" : "VEC3",
          ...(i === 0 ? { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] } : {}),
        })),
      }),
    );
    const jsonSize = Math.ceil(json.length / 4) * 4;
    const bytes = Buffer.alloc(28 + jsonSize + offset);
    bytes.writeUInt32LE(0x46546c67, 0);
    bytes.writeUInt32LE(2, 4);
    bytes.writeUInt32LE(bytes.length, 8);
    bytes.writeUInt32LE(jsonSize, 12);
    bytes.writeUInt32LE(0x4e4f534a, 16);
    bytes.fill(32, 20, 20 + jsonSize);
    json.copy(bytes, 20);
    bytes.writeUInt32LE(offset, 20 + jsonSize);
    bytes.writeUInt32LE(0x004e4942, 24 + jsonSize);
    attributes.forEach((a, i) =>
      Buffer.from(a.array.buffer, a.array.byteOffset, a.array.byteLength).copy(
        bytes,
        28 + jsonSize + views[i].byteOffset,
      ),
    );
    return bytes;
  } finally {
    geometry.dispose();
  }
}

describe("screen-space LOD deferred real HTTP publication", () => {
  it.each([false, true])(
    "retired=%s admits or ignores the actual late model without replacing the instance owner",
    async (retired) => {
      const f = fixture(false);
      f.world.register("loader", ClientLoader);
      let response: ServerResponse | undefined;
      const server = createServer((_req, res) => {
        response = res;
      });
      let pending: Promise<void> | undefined,
        url = "";
      try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string")
          throw Error("Actual loopback address required");
        f.world.assetsUrl = `http://127.0.0.1:${address.port}`;
        url = `${f.world.assetsUrl}/lod.glb`;
        const request = once(server, "request");
        pending = f.vegetation["loadLODForAsset"]("mushroom", 1);
        await request;
        expect(f.select(100)).toBe(0);
        if (retired) f.vegetation.destroy();
        response!.writeHead(200, { "Content-Type": "model/gltf-binary" });
        response!.end(boxGLB());
        await pending;
        if (retired) {
          expect(f.data.lod1Geometry).toBeNull();
          expect(f.state.lodGeometry).toBeNull();
          expect(f.vegetation["screenSpaceChunks"].size).toBe(0);
          expect(f.group.parent).toBeNull();
        } else {
          expect(f.data.lod1Geometry).toBeInstanceOf(THREE.BufferGeometry);
          expect(f.state.lodGeometry).not.toBe(f.data.lod1Geometry);
          expect(f.select(100)).toBe(1);
          expect(f.group.children).toEqual([f.chunk.mesh]);
          expect(f.chunk.mesh.material).toBe(f.material);
          expect(f.chunk.mesh.count).toBe(1);
          expect(f.vegetation["lod1ChunkedMeshes"].size).toBe(0);
        }
      } finally {
        server.closeAllConnections();
        await pending;
        const cached = modelCache.has(url)
          ? await modelCache.loadModel(url, f.world)
          : null;
        modelCache.remove(url);
        if (cached)
          cached.scene.traverse((node) => {
            if (node instanceof THREE.Mesh)
              for (const m of Array.isArray(node.material)
                ? node.material
                : [node.material])
                m.dispose();
          });
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
