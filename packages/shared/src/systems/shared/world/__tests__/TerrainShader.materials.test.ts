import { describe, expect, it } from "vitest";

import THREE from "../../../../extras/three/three";
import {
  MAX_VERTEX_LIGHTS,
  TERRAIN_SHADE,
  TerrainShadeUniforms,
  createTerrainMaterial,
  updateTerrainVertexLights,
} from "../TerrainShader";

describe("TerrainShader material graph", () => {
  it("preserves the original palette and shares only an explicitly supplied owner", () => {
    const first = createTerrainMaterial();
    const second = createTerrainMaterial();
    const explicit = new TerrainShadeUniforms();
    const shared = createTerrainMaterial(explicit);
    expect(first.terrainUniforms.shade.tint.value.toArray()).toEqual([
      ...TERRAIN_SHADE.TINT_COLOR,
    ]);
    expect(first.terrainUniforms.shade.strength.value).toBe(
      TERRAIN_SHADE.STRENGTH,
    );
    expect(first.terrainUniforms.shade).not.toBe(second.terrainUniforms.shade);
    expect(first.terrainUniforms.shade.tint.value).not.toBe(
      second.terrainUniforms.shade.tint.value,
    );
    expect(shared.terrainUniforms.shade).toBe(explicit);
    const originalVersion = shared.version;
    explicit.tint.value.setRGB(1, 1, 1);
    explicit.strength.value = 0;
    expect(shared.version).toBe(originalVersion);
    expect(first.terrainUniforms.shade.tint.value.toArray()).toEqual([
      ...TERRAIN_SHADE.TINT_COLOR,
    ]);
    first.dispose();
    second.dispose();
    shared.dispose();
  });
  it("constructs typed runtime uniforms and updates vertex lights", () => {
    const material = createTerrainMaterial();
    const { terrainUniforms } = material;
    const light = {
      position: new THREE.Vector3(2, 3, 4),
      color: new THREE.Color(0xffcc88),
      intensity: 1.5,
      range: 18,
    };

    expect(material.colorNode).toBeTruthy();
    expect(material.outputNode).toBeTruthy();
    expect(terrainUniforms.sunPosition.value).toBeInstanceOf(THREE.Vector3);
    expect(terrainUniforms.sunDirection.value).toBeInstanceOf(THREE.Vector3);
    expect(terrainUniforms.time.value).toBe(0);
    expect(terrainUniforms.vertexLightPositions).toHaveLength(
      MAX_VERTEX_LIGHTS,
    );
    expect(terrainUniforms.vertexLightColors).toHaveLength(MAX_VERTEX_LIGHTS);
    expect(terrainUniforms.vertexLightParams).toHaveLength(MAX_VERTEX_LIGHTS);

    updateTerrainVertexLights(terrainUniforms, [light]);
    expect(terrainUniforms.vertexLightPositions[0].value).toEqual(
      light.position,
    );
    expect(terrainUniforms.vertexLightColors[0].value).toEqual(
      new THREE.Vector3(light.color.r, light.color.g, light.color.b),
    );
    expect(terrainUniforms.vertexLightParams[0].value).toEqual(
      new THREE.Vector2(light.intensity, light.range),
    );
    expect(terrainUniforms.vertexLightParams[1].value).toEqual(
      new THREE.Vector2(0, 1),
    );

    material.dispose();
  });
});
