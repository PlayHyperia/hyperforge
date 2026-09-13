import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { ConvertNode } from "three/webgpu";
import { materialColor, vec3, vec4 } from "three/tsl";
import WGSLNodeBuilder from "three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js";
import THREE from "../../../../extras/three/three";
import { CompactPondDressingVisuals } from "../CompactPondDressingVisuals";

// Real material setup and WGSL conversion only: no renderer replacement,
// device, browser, GPU compilation or pixel-readback claim.
function unwrapIntent(node) {
  let depth = 0;
  while (node.isVarNode) {
    expect(++depth).toBeLessThan(4);
    node = node.node;
  }
  return node;
}

function installedMaterial(
  source,
  model = "fern",
  geometry = new THREE.BoxGeometry(0.08, 0.04, 0.08).translate(0, 0.02, 0),
) {
  const owner = new CompactPondDressingVisuals(new THREE.Group(), [
    {
      id: `color-contract-${model}`,
      model,
      x: 0,
      z: 0,
      scale: 1,
      yaw: 0,
      burial: 0.04,
    },
  ]);
  try {
    owner.install(model, new THREE.Mesh(geometry, source));
    const mesh = owner.group.children[0];
    expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
    return {
      mesh,
      dispose() {
        owner.destroy();
        geometry.dispose();
      },
    };
  } catch (error) {
    owner.destroy();
    geometry.dispose();
    throw error;
  }
}

function alphaSource(material) {
  const output = unwrapIntent(material.colorNode);
  expect(output.constructor.name).toBe("JoinNode");
  expect(output.nodes).toHaveLength(2);
  const alpha = output.nodes[1];
  expect(alpha.constructor.name).toBe("SplitNode");
  expect(alpha.components).toBe("w");
  return alpha.node;
}

describe("pond material RGBA conversion", () => {
  it("preserves the canonical bush's green chroma, mapped alpha and borrowed PBR maps", () => {
    const bytes = readFileSync(
      new URL(
        "../../../../../../server/world/assets/vegetation/compact-pond-v1/pond_bush.glb",
        import.meta.url,
      ),
    );
    // Qualify the actual source asset, not a replacement texture or mask.
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "c1a66e5b7b28d1c940e0a3186bf70e5eb08bbfa6fd4bd71350ae5c68accbd4d2",
    );
    const jsonLength = bytes.readUInt32LE(12);
    const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
    const binStart = 28 + jsonLength;
    expect(gltf.meshes).toHaveLength(1);
    expect(gltf.meshes[0].primitives).toHaveLength(1);
    const primitive = gltf.meshes[0].primitives[0];
    expect(primitive.attributes.COLOR_0).toBeUndefined();
    const descriptor = gltf.materials[primitive.material];
    expect(descriptor.alphaMode).toBe("MASK");
    expect(descriptor.doubleSided).toBe(true);
    const readTexture = (index, colorSpace) => {
      const image = gltf.images[gltf.textures[index].source];
      expect(image.mimeType).toBe("image/png");
      const view = gltf.bufferViews[image.bufferView];
      const start = binStart + (view.byteOffset ?? 0);
      const decoded = PNG.sync.read(
        bytes.subarray(start, start + view.byteLength),
      );
      const texture = new THREE.DataTexture(
        new Uint8Array(decoded.data),
        decoded.width,
        decoded.height,
      );
      texture.colorSpace = colorSpace;
      texture.flipY = false;
      return texture;
    };
    const map = readTexture(
      descriptor.pbrMetallicRoughness.baseColorTexture.index,
      THREE.SRGBColorSpace,
    );
    const normalMap = readTexture(
      descriptor.normalTexture.index,
      THREE.NoColorSpace,
    );
    const accessor = gltf.accessors[primitive.attributes.POSITION];
    const view = gltf.bufferViews[accessor.bufferView];
    expect(accessor.componentType).toBe(5126);
    expect(accessor.type).toBe("VEC3");
    const positions = new Float32Array(accessor.count * 3);
    for (let i = 0; i < accessor.count; i++)
      for (let axis = 0; axis < 3; axis++)
        positions[i * 3 + axis] = bytes.readFloatLE(
          binStart +
            (view.byteOffset ?? 0) +
            (accessor.byteOffset ?? 0) +
            i * (view.byteStride ?? 12) +
            axis * 4,
        );
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const source = new THREE.MeshStandardNodeMaterial({
      map,
      normalMap,
      color: 0xffffff,
      roughness: descriptor.pbrMetallicRoughness.roughnessFactor ?? 1,
      metalness: descriptor.pbrMetallicRoughness.metallicFactor ?? 1,
      alphaTest: descriptor.alphaCutoff ?? 0.5,
      side: THREE.DoubleSide,
    });
    const sourceBytes = new Uint8Array(map.image.data);
    const normalBytes = new Uint8Array(normalMap.image.data);
    let borrowedDisposals = 0;
    for (const resource of [source, map, normalMap])
      resource.addEventListener("dispose", () => borrowedDisposals++);
    const installed = installedMaterial(source, "bush", geometry);
    try {
      const material = installed.mesh.material;
      expect(material.map).toBe(map);
      expect(material.normalMap).toBe(normalMap);
      expect(material.map.colorSpace).toBe(THREE.SRGBColorSpace);
      expect(material.normalMap.colorSpace).toBe(THREE.NoColorSpace);
      expect(material.map.flipY).toBe(false);
      expect(material.normalScale.toArray()).toEqual([1, 1]);
      expect(material.color).not.toBe(source.color);
      expect(material.color.toArray()).toEqual([1, 1, 1]);
      expect(material.roughness).toBe(1);
      expect(material.metalness).toBe(0);
      expect(material.alphaTest).toBe(0.5);
      expect(material.side).toBe(THREE.DoubleSide);
      expect(material.vertexColors).toBe(false);
      expect(material.userData.compactPondPalette).toEqual({
        tint: [0.94, 1.1, 0.63],
        blend: 0,
        gain: 0.85,
      });

      // Inspect the actual installed TSL graph: zero luminance blend, scalar
      // gain on RGB only, and exactly the original map/material alpha input.
      const output = unwrapIntent(material.colorNode);
      const gain = unwrapIntent(output.nodes[0]);
      expect(gain.op).toBe("*");
      expect(gain.bNode.value).toBe(0.85);
      const blend = unwrapIntent(gain.aNode);
      expect(blend.method).toBe("mix");
      expect(blend.cNode.value).toBe(0);
      expect(blend.aNode.components).toBe("xyz");
      expect(blend.aNode.node).toBe(alphaSource(material));
      const conversion = unwrapIntent(alphaSource(material));
      expect(conversion).toBeInstanceOf(ConvertNode);
      expect(conversion.node).toBe(materialColor);
      const builder = new WGSLNodeBuilder(installed.mesh, null);
      const mappedColor = unwrapIntent(materialColor.setup(builder));
      expect(mappedColor.op).toBe("*");
      expect(mappedColor.bNode.property).toBe("map");

      // CPU source-texel audit in Three's actual linear working color space;
      // this verifies chroma preservation, not rendered pixels or GPU timing.
      const sample = new THREE.Color();
      const sum = [0, 0, 0];
      const tintedSum = [0, 0, 0];
      let visible = 0;
      let maximumChromaError = 0;
      for (let i = 0; i < sourceBytes.length; i += 4) {
        if (sourceBytes[i + 3] < 128) continue;
        visible++;
        sample.setRGB(
          sourceBytes[i] / 255,
          sourceBytes[i + 1] / 255,
          sourceBytes[i + 2] / 255,
          THREE.SRGBColorSpace,
        );
        const rgb = sample.toArray();
        const tinted = rgb.map((channel) => channel * gain.bNode.value);
        for (let channel = 0; channel < 3; channel++) {
          sum[channel] += rgb[channel];
          tintedSum[channel] += tinted[channel];
          maximumChromaError = Math.max(
            maximumChromaError,
            Math.abs(tinted[channel] * rgb[1] - rgb[channel] * tinted[1]),
          );
        }
      }
      expect(visible).toBe(228792);
      expect(maximumChromaError).toBeLessThan(1e-15);
      const means = sum.map((channel) => channel / visible);
      const tintedMeans = tintedSum.map((channel) => channel / visible);
      for (const [channel, expected] of [
        [0, 0.02811301682639583],
        [1, 0.23707272807218954],
        [2, 0.021592469787938665],
      ]) {
        expect(means[channel]).toBeCloseTo(expected, 12);
        expect(tintedMeans[channel]).toBeCloseTo(expected * 0.85, 12);
      }
      expect(tintedMeans[2] / tintedMeans[1]).toBeCloseTo(
        means[2] / means[1],
        12,
      );
      expect(source.colorNode).toBeNull();
      expect(source.color.toArray()).toEqual([1, 1, 1]);
      expect(Buffer.from(map.image.data).equals(sourceBytes)).toBe(true);
      expect(Buffer.from(normalMap.image.data).equals(normalBytes)).toBe(true);
    } finally {
      installed.dispose();
      const retainedBorrowedResources = borrowedDisposals === 0;
      source.dispose();
      map.dispose();
      normalMap.dispose();
      expect(retainedBorrowedResources).toBe(true);
    }
  });

  it.each([false, true])(
    "preserves the historical conversion and mapped alpha (mapped=%s)",
    (mapped) => {
      const texture = new THREE.DataTexture(
        new Uint8Array([64, 128, 192, 87]),
        1,
        1,
      );
      const source = new THREE.MeshStandardNodeMaterial();
      source.color.setRGB(0.2, 0.4, 0.6);
      source.map = mapped ? texture : null;
      source.alphaTest = 0.4;
      source.side = THREE.DoubleSide;
      const installed = installedMaterial(source);
      try {
        const material = installed.mesh.material;
        expect(material).not.toBe(source);
        expect(material.map).toBe(source.map);
        expect(material.color).not.toBe(source.color);
        expect(material.color.toArray()).toEqual([0.2, 0.4, 0.6]);
        expect(material.alphaTest).toBe(source.alphaTest);
        expect(material.side).toBe(source.side);
        expect(source.colorNode).toBeNull();
        expect([...texture.image.data]).toEqual([64, 128, 192, 87]);

        const original = alphaSource(material);
        // JavaScript intentionally exercises the historical single-argument
        // constructor, whose r186 declaration excludes a declared vec3 input.
        const historical = vec4(materialColor);
        expect(original.constructor).toBe(historical.constructor);
        expect(original.intent).toBe(historical.intent);
        const conversion = unwrapIntent(original);
        expect(conversion).toBeInstanceOf(ConvertNode);
        expect(conversion.convertTo).toBe("vec4");
        expect(conversion.node).toBe(materialColor);
        expect(conversion.node).toBe(unwrapIntent(historical).node);

        const builder = new WGSLNodeBuilder(installed.mesh, null);
        const actualSetup = materialColor.setup(builder);
        const type = actualSetup.getNodeType(builder);
        expect(type).toBe(mapped ? "vec4" : "color");
        expect(conversion.getNodeType(builder)).toBe("vec4");
        expect(builder.format("actualMaterialColor", type, "vec4")).toBe(
          mapped
            ? "actualMaterialColor"
            : "vec4<f32>( actualMaterialColor, 1.0 )",
        );
        if (mapped) {
          const multiply = unwrapIntent(actualSetup);
          expect(multiply.op).toBe("*");
          expect(multiply.aNode.property).toBe("color");
          expect(multiply.bNode.property).toBe("map");
          // Appending 1 to this actual RGBA input requests five channels.
          expect(builder.getTypeLength(type) + 1).toBe(5);
        }
      } finally {
        installed.dispose();
        source.dispose();
        texture.dispose();
      }
    },
  );

  it("preserves an authored source color node's alpha without replacing it", () => {
    const source = new THREE.MeshStandardNodeMaterial();
    source.colorNode = vec4(-0.2, 0.4, 1.5, 0.37);
    const installed = installedMaterial(source);
    try {
      const conversion = unwrapIntent(alphaSource(installed.mesh.material));
      expect(conversion).toBeInstanceOf(ConvertNode);
      expect(conversion.node).toBe(source.colorNode);
      expect(conversion.convertTo).toBe("vec4");
    } finally {
      installed.dispose();
      source.dispose();
    }
  });

  it.each([false, true])(
    "generates identical actual WGSL for RGBA preservation/RGB promotion (alpha=%s)",
    (alpha) => {
      const input = alpha ? vec4(-0.2, 0.4, 1.5, 0.37) : vec3(-0.2, 0.4, 1.5);
      const previous = vec4(input);
      const current = new ConvertNode(input, "vec4").toVarIntent();
      const generate = (node) => {
        const builder = new WGSLNodeBuilder(null, null);
        builder.shaderStage = "fragment";
        return builder.flowStagesNode(node, "vec4");
      };
      const actual = generate(current);
      expect(actual).toEqual(generate(previous));
      expect(actual.code).toBe("");
      expect(actual.result).toBe(
        alpha
          ? "vec4<f32>( -0.2, 0.4, 1.5, 0.37 )"
          : "vec4<f32>( vec3<f32>( -0.2, 0.4, 1.5 ), 1.0 )",
      );
    },
  );
});
