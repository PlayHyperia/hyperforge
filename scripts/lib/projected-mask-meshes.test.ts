import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { Mesh as SourceMesh } from "three/src/objects/Mesh.js";
import Color4 from "three/src/renderers/common/Color4.js";

import { collectProjectedMaskMeshes } from "./projected-mask-meshes";

describe("projected mask mesh ownership", () => {
  it("collects real meshes from distinct Three constructors without changing visibility", () => {
    const root = new THREE.Group();
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial();
    const bundled = new THREE.Mesh(geometry, material);
    const separatelyLoaded = new SourceMesh(geometry, material);
    separatelyLoaded.visible = false;
    const nested = new THREE.Group();
    nested.add(separatelyLoaded);
    root.add(bundled, nested);
    expect(bundled instanceof THREE.Mesh).toBe(true);
    expect(separatelyLoaded instanceof THREE.Mesh).toBe(false);
    expect(collectProjectedMaskMeshes(root)).toEqual([
      bundled,
      separatelyLoaded,
    ]);
    expect(bundled.visible).toBe(true);
    expect(separatelyLoaded.visible).toBe(false);
    expect(separatelyLoaded.parent).toBe(nested);
    geometry.dispose();
    material.dispose();
  });

  it("includes skinned and instanced meshes but does not misclassify groups or bones", () => {
    const root = new THREE.Group();
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial();
    const skinned = new THREE.SkinnedMesh(geometry, material);
    const instanced = new THREE.InstancedMesh(geometry, material, 1);
    root.add(new THREE.Bone(), new THREE.Group(), skinned, instanced);
    expect(collectProjectedMaskMeshes(root)).toEqual([skinned, instanced]);
    instanced.dispose();
    geometry.dispose();
    material.dispose();
  });

  it("uses the renderer's four-channel clear-color type without changing RGB conversion", () => {
    const source = new Color4(0.123, 0.456, 0.789, 0.375);
    const previous = new THREE.Color().copy(source);
    const snapshot = new Color4().copy(source);
    expect(snapshot.getHex()).toBe(previous.getHex());
    expect(snapshot.a).toBe(0.375);
    expect(source.a).toBe(0.375);
    expect([snapshot.r, snapshot.g, snapshot.b]).toEqual([
      source.r,
      source.g,
      source.b,
    ]);
  });
});
