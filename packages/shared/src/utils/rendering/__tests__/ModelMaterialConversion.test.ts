import { describe, expect, it } from "vitest";
import THREE, {
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  float,
} from "../../../extras/three/three";
import { copyPbrToNodeMaterial } from "../ModelMaterialConversion";

describe("PBR node material copy (CPU state, not rendered qualification)", () => {
  it("preserves precise standard material state and borrowed maps", () => {
    const map = new THREE.DataTexture(new Uint8Array(16), 2, 2);
    const source = new THREE.MeshStandardMaterial({
      name: "authored-standard",
      color: new THREE.Color(0.123456789, 0.234567891, 1.345678912),
      emissive: new THREE.Color(2.123456789, 0.012345678, 0.076543219),
      emissiveIntensity: 0.37,
      roughness: 0.42,
      metalness: 0.73,
      envMapIntensity: 1.75,
      map,
      normalMap: map,
      aoMap: map,
      metalnessMap: map,
      roughnessMap: map,
      alphaMap: map,
      lightMap: map,
      lightMapIntensity: 0.63,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      fog: false,
      toneMapped: false,
    });
    source.normalScale.set(0.7, -0.9);
    source.envMapRotation.set(0.3, -0.2, 0.1);
    source.userData = { asset: { revision: 2 } };
    const result = copyPbrToNodeMaterial(source);
    expect(result).toBeInstanceOf(MeshStandardNodeMaterial);
    expect(result).not.toBe(source);
    expect(result?.uuid).not.toBe(source.uuid);
    expect(result?.type).toBe("MeshStandardNodeMaterial");
    expect(result?.color.toArray()).toEqual(source.color.toArray());
    expect(result?.emissive.toArray()).toEqual(source.emissive.toArray());
    expect(result?.normalScale.toArray()).toEqual([0.7, -0.9]);
    expect(result?.envMapRotation.toArray()).toEqual(
      source.envMapRotation.toArray(),
    );
    for (const key of [
      "name",
      "emissiveIntensity",
      "roughness",
      "metalness",
      "envMapIntensity",
      "lightMapIntensity",
      "alphaTest",
      "side",
      "depthWrite",
      "polygonOffset",
      "polygonOffsetFactor",
      "polygonOffsetUnits",
      "fog",
      "toneMapped",
    ] as const)
      expect(result?.[key]).toEqual(source[key]);
    for (const key of [
      "map",
      "normalMap",
      "aoMap",
      "metalnessMap",
      "roughnessMap",
      "alphaMap",
      "lightMap",
    ] as const)
      expect(result?.[key]).toBe(map);
    expect(result?.userData).toEqual(source.userData);
    expect(result?.userData).not.toBe(source.userData);
    result?.color.setRGB(0, 0, 0);
    result?.normalScale.set(1, 1);
    expect(source.color.toArray()).toEqual([
      0.123456789, 0.234567891, 1.345678912,
    ]);
    expect(source.normalScale.toArray()).toEqual([0.7, -0.9]);
    result?.dispose();
    source.dispose();
    map.dispose();
  });

  it("preserves physical optical properties without quantizing or zeroing metals", () => {
    const source = new THREE.MeshPhysicalMaterial({
      metalness: 0.83,
      roughness: 0.21,
      ior: 1.37,
      specularIntensity: 0.6,
      specularColor: new THREE.Color(1.253919, 1.2, 1.1),
      clearcoat: 0.31,
      clearcoatRoughness: 0.28,
      transmission: 0.17,
      thickness: 0.09,
      attenuationDistance: 8,
      anisotropy: 0.24,
      anisotropyRotation: 0.12,
      sheen: 0.19,
      sheenRoughness: 0.48,
      iridescence: 0.23,
      iridescenceIOR: 1.41,
      iridescenceThicknessRange: [120, 340],
    });
    source.clearcoatNormalScale.set(0.4, 0.6);
    const result = copyPbrToNodeMaterial(source);
    expect(result).toBeInstanceOf(MeshPhysicalNodeMaterial);
    if (!(result instanceof MeshPhysicalNodeMaterial))
      throw new Error("Physical type lost");
    expect(result.type).toBe("MeshPhysicalNodeMaterial");
    for (const key of [
      "metalness",
      "roughness",
      "ior",
      "specularIntensity",
      "clearcoat",
      "clearcoatRoughness",
      "transmission",
      "thickness",
      "attenuationDistance",
      "anisotropy",
      "anisotropyRotation",
      "sheen",
      "sheenRoughness",
      "iridescence",
      "iridescenceIOR",
    ] as const)
      expect(result[key]).toBe(source[key]);
    expect(result.specularColor.toArray()).toEqual(
      source.specularColor.toArray(),
    );
    expect(result.specularColor).not.toBe(source.specularColor);
    expect(result.clearcoatNormalScale.toArray()).toEqual([0.4, 0.6]);
    expect(result.iridescenceThicknessRange).toEqual([120, 340]);
    expect(result.iridescenceThicknessRange).not.toBe(
      source.iridescenceThicknessRange,
    );
    result.iridescenceThicknessRange[0] = 50;
    expect(source.iridescenceThicknessRange[0]).toBe(120);
    result.dispose();
    source.dispose();
  });

  it("copies existing node materials without mutating source or retiring borrowed maps", () => {
    const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    const source = new MeshPhysicalNodeMaterial({ map: texture, ior: 1.6 });
    const graph = float(0.7);
    source.roughnessNode = graph;
    let sourceDisposals = 0,
      mapDisposals = 0;
    source.addEventListener("dispose", () => sourceDisposals++);
    texture.addEventListener("dispose", () => mapDisposals++);
    const first = copyPbrToNodeMaterial(source, true);
    const second = copyPbrToNodeMaterial(source, false);
    expect(first).toBeInstanceOf(MeshPhysicalNodeMaterial);
    expect(second).toBeInstanceOf(MeshPhysicalNodeMaterial);
    expect(first).not.toBe(second);
    expect(first?.map).toBe(texture);
    expect(second?.map).toBe(texture);
    expect(first?.roughnessNode).toBe(graph);
    expect(second?.roughnessNode).toBe(graph);
    expect(first?.vertexColors).toBe(true);
    expect(second?.vertexColors).toBe(false);
    expect(source.vertexColors).toBe(false);
    first?.dispose();
    second?.dispose();
    expect(sourceDisposals).toBe(0);
    expect(mapDisposals).toBe(0);
    source.dispose();
    texture.dispose();
  });

  it("does not silently reinterpret unlit or custom shader materials", () => {
    const unlit = new THREE.MeshBasicMaterial();
    const custom = new THREE.ShaderMaterial();
    expect(copyPbrToNodeMaterial(unlit)).toBeNull();
    expect(copyPbrToNodeMaterial(custom)).toBeNull();
    unlit.dispose();
    custom.dispose();
  });
});
