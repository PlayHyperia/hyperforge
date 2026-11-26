import { describe, expect, it } from "vitest";
import { NodeSampledTexture } from "three/src/renderers/common/nodes/NodeSampledTexture.js";
import NodeSampler from "three/src/renderers/common/nodes/NodeSampler.js";
import UniformGroupNode from "three/src/nodes/core/UniformGroupNode.js";
import THREE, { texture, vec2 } from "../../../../extras/three/three";
import {
  clearRoadInfluenceTexture,
  getRoadInfluenceTexture,
  getRoadInfluenceTextureState,
  setRoadInfluenceTextureData,
} from "../RoadInfluenceMask";

describe("shared road-mask ownership", () => {
  it("keeps the shader base node stable and prevents an old world's disposal from clearing a replacement", () => {
    const firstOwner = {},
      secondOwner = {};
    const node = getRoadInfluenceTextureState().textureNode;
    const first = new Float32Array([0, 1, 1, 0]);
    const second = new Float32Array([0.25]);
    try {
      setRoadInfluenceTextureData(first, 2, 2, 80, 345, 350, firstOwner);
      expect(getRoadInfluenceTextureState().textureNode).toBe(node);
      expect(node.value).toBe(getRoadInfluenceTexture());
      expect(getRoadInfluenceTexture().image.data).toBe(first);
      expect(getRoadInfluenceTextureState().uCenterX.value).toBe(345);
      setRoadInfluenceTextureData(second, 1, 1, 20, 350, 370, secondOwner);
      const current = getRoadInfluenceTexture();
      const version = current.version;
      clearRoadInfluenceTexture(firstOwner);
      expect(getRoadInfluenceTexture()).toBe(current);
      expect(current.version).toBe(version);
      expect(current.image.data).toBe(second);
      expect(getRoadInfluenceTextureState().uWorldSize.value).toBe(20);
      clearRoadInfluenceTexture(secondOwner);
      expect(Array.from(getRoadInfluenceTexture().image.data)).toEqual([0]);
      expect(getRoadInfluenceTextureState().uWorldSize.value).toBe(1);
      clearRoadInfluenceTexture(secondOwner);
      expect(getRoadInfluenceTexture()).toBe(current);
    } finally {
      clearRoadInfluenceTexture();
    }
  });

  it("replaces 1→256→1 resources, updates actual sampled clones/bindings and disposes each old resource once", () => {
    clearRoadInfluenceTexture();
    const state = getRoadInfluenceTextureState();
    const base = state.textureNode;
    const initial = getRoadInfluenceTexture();
    const sample = base.sample(vec2(0.25, 0.75));
    const alias = texture(base);
    const nested = sample.sample(vec2(0.75, 0.25));
    const group = new UniformGroupNode("road-mask-test");
    const sampledBinding = new NodeSampledTexture("road-mask", sample, group);
    const samplerBinding = new NodeSampler("road-mask-sampler", nested, group);
    let initialDisposals = 0;
    let largeDisposals = 0;
    initial.addEventListener("dispose", () => {
      initialDisposals++;
      expect(getRoadInfluenceTexture()).not.toBe(initial);
      expect(base.value).toBe(getRoadInfluenceTexture());
      expect(state.uWorldSize.value).toBe(85.5);
      expect(state.uCenterX.value).toBe(360.85);
      expect(state.uCenterZ.value).toBe(351.5);
    });
    const owner = {};
    try {
      const data = new Float32Array(256 * 256);
      data[0] = 0.25;
      data[data.length - 1] = 1;
      setRoadInfluenceTextureData(data, 256, 256, 85.5, 360.85, 351.5, owner);
      const large = getRoadInfluenceTexture();
      expect(large).not.toBe(initial);
      expect(initialDisposals).toBe(1);
      expect(large.image).toEqual({ data, width: 256, height: 256 });
      expect(large.version).toBeGreaterThan(0);
      for (const node of [base, sample, alias, nested]) {
        expect(node.value).toBe(large);
      }
      // These are installed Three binding classes, not GPU/backend doubles.
      expect(sampledBinding.update()).toBe(true);
      expect(samplerBinding.update()).toBe(true);
      expect(sampledBinding.texture).toBe(large);
      expect(samplerBinding.texture).toBe(large);
      expect(sampledBinding.generation).toBeNull();
      large.addEventListener("dispose", () => {
        largeDisposals++;
        expect(base.value).toBe(getRoadInfluenceTexture());
        expect(getRoadInfluenceTexture().image.width).toBe(1);
        expect(state.uWorldSize.value).toBe(1);
      });
      clearRoadInfluenceTexture(owner);
      const reset = getRoadInfluenceTexture();
      expect(reset).not.toBe(large);
      expect(reset).not.toBe(initial);
      expect(largeDisposals).toBe(1);
      expect(initialDisposals).toBe(1);
      for (const node of [base, sample, alias, nested]) {
        expect(node.value).toBe(reset);
      }
      expect(sampledBinding.update()).toBe(true);
      expect(samplerBinding.update()).toBe(true);
      expect(sampledBinding.texture).toBe(reset);
      expect(samplerBinding.texture).toBe(reset);
      expect(Array.from(reset.image.data)).toEqual([0]);
      for (const image of [initial, large, reset]) {
        expect(image.format).toBe(THREE.RedFormat);
        expect(image.type).toBe(THREE.FloatType);
        expect(image.minFilter).toBe(THREE.LinearFilter);
        expect(image.magFilter).toBe(THREE.LinearFilter);
        expect(image.wrapS).toBe(THREE.ClampToEdgeWrapping);
        expect(image.wrapT).toBe(THREE.ClampToEdgeWrapping);
        expect(image.flipY).toBe(false);
        expect(image.generateMipmaps).toBe(false);
      }
    } finally {
      sampledBinding.texture = null;
      samplerBinding.texture = null;
      clearRoadInfluenceTexture();
    }
  });

  it("keeps same-size updates allocation-stable and replaces either changed dimension", () => {
    clearRoadInfluenceTexture();
    const owner = {};
    try {
      setRoadInfluenceTextureData(new Float32Array(8), 2, 4, 40, 10, 20, owner);
      const first = getRoadInfluenceTexture();
      let disposals = 0;
      first.addEventListener("dispose", () => disposals++);
      const version = first.version;
      const updated = new Float32Array(8).fill(0.5);
      setRoadInfluenceTextureData(updated, 2, 4, 60, 30, 40, owner);
      expect(getRoadInfluenceTexture()).toBe(first);
      expect(first.version).toBe(version + 1);
      expect(first.image.data).toBe(updated);
      expect(disposals).toBe(0);
      // Same pixel count is not the same allocation shape.
      setRoadInfluenceTextureData(new Float32Array(8), 4, 2, 60, 30, 40, owner);
      expect(getRoadInfluenceTexture()).not.toBe(first);
      expect(disposals).toBe(1);
      const second = getRoadInfluenceTexture();
      setRoadInfluenceTextureData(
        new Float32Array(12),
        4,
        3,
        60,
        30,
        40,
        owner,
      );
      expect(getRoadInfluenceTexture()).not.toBe(second);
      expect(getRoadInfluenceTexture().image.height).toBe(3);
    } finally {
      clearRoadInfluenceTexture(owner);
    }
  });
});
