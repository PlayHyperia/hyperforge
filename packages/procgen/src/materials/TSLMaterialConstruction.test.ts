import { describe, expect, it } from "vitest";

import {
  DEFAULT_MATERIAL_CONFIGS,
  createBuildingMaterial,
  type BuildingMaterialType,
} from "../building/materials/BuildingMaterialTSL";
import { createWindowGlassMaterial } from "../building/materials/WindowGlassMaterialTSL";
import { createFlowerMaterial } from "../flowers/FlowerMaterialTSL";
import {
  createGrassCardMaterial,
  createGrassMaterial,
  updateGrassTime,
} from "../grass/GrassMaterialTSL";
import {
  createGameGrassMaterial,
  createGameGrassUniforms,
} from "../grass/GrassShaderTSL";
import { createInstancedLeafMaterialTSL } from "../geometry/LeafMaterialTSL";
import { createDockMaterial } from "../items/dock/DockMaterialTSL";
import { WoodType } from "../items/types";
import { createRockMaterial } from "../rock/RockMaterialTSL";
import { DEFAULT_PARAMS } from "../rock/presets";
import { TexturePattern } from "../rock/types";
import { createTerrainMaterial } from "../terrain/TerrainShaderTSL";

describe("procgen TSL material construction", () => {
  it("constructs sprite grass graphs with both owned and shared uniforms", () => {
    const sharedUniforms = createGameGrassUniforms();
    const owned = createGameGrassMaterial();
    const shared = createGameGrassMaterial({ uniforms: sharedUniforms });

    expect(shared.uniforms).toBe(sharedUniforms);
    expect(owned.uniforms).not.toBe(sharedUniforms);
    sharedUniforms.uDayNightMix.value = 0.4;
    expect(shared.uniforms.uDayNightMix.value).toBe(0.4);
    expect(owned.uniforms.uDayNightMix.value).toBe(1);

    for (const { material } of [owned, shared]) {
      expect(material.colorNode).toBeTruthy();
      expect(material.opacityNode).toBeTruthy();
      expect(material.scaleNode).toBeTruthy();
      material.dispose();
    }
  });

  it("constructs animated vegetation graphs with typed runtime uniforms", () => {
    const flower = createFlowerMaterial();
    const grass = createGrassMaterial();
    const grassCard = createGrassCardMaterial();
    const leaf = createInstancedLeafMaterialTSL({
      leafShape: "maple",
      windStrength: 0.4,
    });

    updateGrassTime(grass.uniforms, 12.5);
    leaf.updateTime(8.25);
    leaf.updateLighting(leaf.leafUniforms.sunDirection.value, 0.6);

    expect(flower.material.positionNode).toBeTruthy();
    expect(flower.material.colorNode).toBeTruthy();
    expect(grass.material.positionNode).toBeTruthy();
    expect(grass.material.colorNode).toBeTruthy();
    expect(grass.uniforms.time.value).toBe(12.5);
    expect(grassCard.material.positionNode).toBeTruthy();
    expect(leaf.positionNode).toBeTruthy();
    expect(leaf.colorNode).toBeTruthy();
    expect(leaf.emissiveNode).toBeTruthy();
    expect(leaf.leafUniforms.time.value).toBe(8.25);
    expect(leaf.leafUniforms.dayNightMix.value).toBe(0.6);

    flower.material.dispose();
    grass.material.dispose();
    grassCard.material.dispose();
    leaf.dispose();
  });

  it("constructs every static surface-material branch", () => {
    const buildingTypes = Object.keys(
      DEFAULT_MATERIAL_CONFIGS,
    ) as BuildingMaterialType[];
    const buildingMaterials = buildingTypes.map((type) =>
      createBuildingMaterial({ type }),
    );
    const windowMaterials = [
      createWindowGlassMaterial(),
      createWindowGlassMaterial({
        use8x8Dither: true,
        useVertexColors: true,
      }),
    ];
    const dockMaterials = Object.values(WoodType).map(
      (woodType) => createDockMaterial(woodType).material,
    );

    for (const material of [
      ...buildingMaterials,
      ...windowMaterials,
      ...dockMaterials,
    ]) {
      expect(material.colorNode).toBeTruthy();
      material.dispose();
    }
  });

  it("constructs every rock pattern and both terrain road branches", () => {
    const rockMaterials = Object.values(TexturePattern).map(
      (pattern) =>
        createRockMaterial({
          ...DEFAULT_PARAMS,
          texture: { ...DEFAULT_PARAMS.texture, pattern },
        }).material,
    );
    const terrainMaterials = [
      createTerrainMaterial({ includeRoadOverlay: true }),
      createTerrainMaterial({ includeRoadOverlay: false }),
    ];

    for (const material of [...rockMaterials, ...terrainMaterials]) {
      expect(material.colorNode).toBeTruthy();
      material.dispose();
    }
  });
});
