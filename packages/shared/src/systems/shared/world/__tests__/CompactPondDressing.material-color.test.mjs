import { describe, expect, it } from "vitest";
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

function installedMaterial(source) {
  const geometry = new THREE.BoxGeometry(0.08, 0.04, 0.08).translate(
    0,
    0.02,
    0,
  );
  const owner = new CompactPondDressingVisuals(new THREE.Group(), [
    {
      id: "color-contract-fern",
      model: "fern",
      x: 0,
      z: 0,
      scale: 1,
      yaw: 0,
      burial: 0.04,
    },
  ]);
  try {
    owner.install("fern", new THREE.Mesh(geometry, source));
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
