import { describe, expect, it } from "vitest";

import THREE, { uniform } from "../../../../extras/three/three";
import {
  addLODCrossFade,
  createBranchCardMaterial,
  createInstancedLeafMaterial,
  createLeafShadowMaterial,
} from "../TreeLODMaterials";

describe("TreeLODMaterials", () => {
  it("constructs and updates the branch-card shader graph", () => {
    const atlas = new THREE.DataTexture(
      new Uint8Array([255, 255, 255, 255]),
      1,
      1,
      THREE.RGBAFormat,
    );
    atlas.needsUpdate = true;

    const material = createBranchCardMaterial(atlas);
    const windDirection = new THREE.Vector3(0, 0, -1);
    material.updateWind(2.5, 0.75, windDirection);
    material.updateLODFade(0.4);

    expect(material.positionNode).toBeTruthy();
    expect(material.colorNode).toBeTruthy();
    expect(material.opacityNode).toBeTruthy();
    expect(material.uniforms.time.value).toBe(2.5);
    expect(material.uniforms.windStrength.value).toBe(0.75);
    expect(material.uniforms.windDirection.value).toEqual(windDirection);
    expect(material.uniforms.cardAtlas.value).toBe(atlas);
    expect(material.uniforms.lodFade.value).toBe(0.4);

    material.dispose();
    atlas.dispose();
  });

  it("constructs and updates the instanced-leaf shader graph", () => {
    const material = createInstancedLeafMaterial();
    const windDirection = new THREE.Vector3(1, 0, 1).normalize();
    const sunDirection = new THREE.Vector3(-1, 2, 0.5);
    material.updateWind(3, 0.6, windDirection);
    material.updateLighting(sunDirection, 0.25);
    material.updateLODFade(0.8);

    expect(material.positionNode).toBeTruthy();
    expect(material.colorNode).toBeTruthy();
    expect(material.opacityNode).toBeTruthy();
    expect(material.emissiveNode).toBeTruthy();
    expect(material.alphaTestNode).toBeTruthy();
    expect(material.uniforms.time.value).toBe(3);
    expect(material.uniforms.windStrength.value).toBe(0.6);
    expect(material.uniforms.windDirection.value).toEqual(windDirection);
    expect(material.uniforms.sunDirection.value.length()).toBeCloseTo(1);
    expect(material.uniforms.dayNightMix.value).toBe(0.25);
    expect(material.uniforms.lodFade.value).toBe(0.8);

    material.dispose();
  });

  it("constructs shadow and cross-fade nodes without a renderer", () => {
    const shadowMaterial = createLeafShadowMaterial();
    const standardMaterial = new THREE.MeshStandardNodeMaterial();
    const fade = uniform(0.5);

    addLODCrossFade(standardMaterial, fade);
    expect(shadowMaterial.opacityNode).toBeTruthy();
    expect(standardMaterial.opacityNode).toBeTruthy();

    addLODCrossFade(standardMaterial, fade);
    expect(standardMaterial.opacityNode).toBeTruthy();

    shadowMaterial.dispose();
    standardMaterial.dispose();
  });
});
