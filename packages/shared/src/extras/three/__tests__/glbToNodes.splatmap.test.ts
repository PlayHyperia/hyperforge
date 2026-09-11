import { describe, expect, it } from "vitest";
import THREE, { type Node as TSLNode } from "../three";
import { glbToNodes } from "../glbToNodes";
import { World } from "../../../core/World";
import { ClientNetwork } from "../../../systems/client/ClientNetwork";
import { Mesh as MeshNode } from "../../../nodes/Mesh";

// Actual GLB scene/material conversion and real TSL closure expansion. No
// renderer, network connection, mocked sampler, shader or GPU/pixel claim.
function graphNodes(root: TSLNode, builder: THREE.NodeBuilder): Set<TSLNode> {
  const seen = new Set<TSLNode>();
  const visit = (node: TSLNode) => {
    if (seen.has(node)) return;
    seen.add(node);
    if (Reflect.get(node, "isShaderCallNodeInternal") === true) {
      const expand: unknown = Reflect.get(node, "getOutputNode");
      if (typeof expand !== "function")
        throw new Error("Missing real TSL closure expansion");
      const output: unknown = expand.call(node, builder);
      if (!(output instanceof THREE.Node))
        throw new Error("Invalid real TSL output");
      visit(output);
    }
    for (const child of node.getChildren()) visit(child);
  };
  visit(root);
  return seen;
}

describe("GLB splatmap UV extras (actual material conversion)", () => {
  it.each([
    { label: "positive", value: 2.75, expected: 2.75 },
    { label: "negative", value: -0.125, expected: -0.125 },
    { label: "zero", value: 0, expected: 1 },
    { label: "negative zero", value: -0, expected: 1 },
    { label: "NaN", value: Number.NaN, expected: 1 },
    { label: "Infinity", value: Infinity, expected: 1 },
    { label: "negative Infinity", value: -Infinity, expected: 1 },
    { label: "numeric string", value: "2.75", expected: 1 },
    { label: "nonnumeric string", value: "invalid", expected: 1 },
    { label: "absent", value: undefined, expected: 1 },
    {
      label: "mixed independent channels",
      value: [2.75, -0.125, "3", Number.NaN],
      expected: [2.75, -0.125, 1, 1],
    },
  ])(
    "admits $label extras in all four real texture channels",
    ({ value, expected }) => {
      const world = new World();
      world.register("network", ClientNetwork); // Construct only; never init/start.
      const scene = new THREE.Group();
      const geometry = new THREE.PlaneGeometry(2, 2);
      const textures = Array.from(
        { length: 5 },
        () => new THREE.DataTexture(new Uint8Array([64, 128, 192, 255]), 1, 1),
      );
      const original = new THREE.MeshPhysicalMaterial({
        map: textures[0],
        specularIntensityMap: textures[1],
        emissiveMap: textures[2],
        normalMap: textures[3],
        transmissionMap: textures[4],
      });
      const mesh = new THREE.Mesh(geometry, original);
      mesh.name = "splatmap-fixture";
      const values = Array.isArray(value)
        ? value
        : [value, value, value, value];
      const expectedValues = Array.isArray(expected)
        ? expected
        : [expected, expected, expected, expected];
      mesh.userData = {
        exp_splatmap: true,
        red_scale: values[0],
        green_scale: values[1],
        blue_scale: values[2],
        alpha_scale: values[3],
      };
      scene.add(mesh);
      let converted: THREE.MeshStandardNodeMaterial | undefined;
      try {
        const root = glbToNodes({ scene, animations: [] }, world);
        expect(root.children).toHaveLength(1);
        const node = root.children[0];
        expect(node).toBeInstanceOf(MeshNode);
        if (!(node instanceof MeshNode))
          throw new Error("Not a real mesh node");
        if (!(mesh.material instanceof THREE.MeshStandardNodeMaterial))
          throw new Error("Splat conversion did not create the node material");
        converted = mesh.material;
        expect(node.material).toBe(converted);
        expect(node.geometry).toBe(geometry);
        expect(converted).not.toBe(original);
        if (!converted.colorNode) throw new Error("Missing real splat graph");
        const builder = new THREE.NodeBuilder(mesh, null);
        const graph = graphNodes(converted.colorNode, builder);
        const scaleUniforms = new Set<TSLNode>();
        for (const [channel, texture] of textures.slice(1).entries()) {
          const samples = [...graph].filter(
            (entry) =>
              Reflect.get(entry, "isTextureNode") === true &&
              Reflect.get(entry, "value") === texture,
          );
          expect(samples).toHaveLength(3); // All X/Y/Z triplanar projections.
          const channelUniforms = new Set<TSLNode>();
          for (const sample of samples) {
            const uv: unknown = Reflect.get(sample, "uvNode");
            if (!(uv instanceof THREE.Node))
              throw new Error("Missing actual UV");
            const uniforms = [...graphNodes(uv, builder)].filter(
              (entry) => Reflect.get(entry, "isUniformNode") === true,
            );
            expect(uniforms).toHaveLength(1);
            expect(uniforms[0].getNodeType(builder)).toBe("float");
            expect(Reflect.get(uniforms[0], "value")).toBe(
              expectedValues[channel],
            );
            channelUniforms.add(uniforms[0]);
            scaleUniforms.add(uniforms[0]);
          }
          expect(channelUniforms.size).toBe(1);
        }
        expect(scaleUniforms.size).toBe(4); // No accidental cross-channel sharing.
        root.deactivate();
      } finally {
        converted?.dispose();
        original.dispose();
        geometry.dispose();
        for (const texture of textures) texture.dispose();
        scene.clear();
      }
    },
  );
});
