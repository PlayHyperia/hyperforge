import assert from "node:assert/strict";
import test from "node:test";
import { Color, REVISION } from "three";
import { uniform, vec3 } from "three/tsl";
import NodeBuilder from "three/src/nodes/core/NodeBuilder.js";

// Real TSL graph/type operations only. No GPU renderer or replacement builder;
// the base builder's type/format utilities do not require a device or canvas.
function unwrapIntent(node) {
  let depth = 0;
  while (node.isVarNode) {
    assert.ok(++depth < 4, "bounded real intent wrapper chain");
    node = node.node;
  }
  return node;
}

test("r186 color conversion and rgb expose the same live linear channels", () => {
  assert.equal(REVISION, "186");
  const palette = uniform(new Color(0.2, 0.4, 0.6));
  // Deliberately exercise the previous runtime expression in JavaScript: r186's
  // declaration overload no longer accepts its color-node argument in TS.
  const previous = unwrapIntent(vec3(palette));
  const current = unwrapIntent(palette.rgb);
  const builder = new NodeBuilder(null, null, null);
  assert.equal(previous.constructor.name, "ConvertNode");
  assert.equal(previous.convertTo, "vec3");
  assert.equal(current.constructor.name, "SplitNode");
  assert.equal(current.components, "xyz");
  assert.equal(previous.node, palette);
  assert.equal(current.node, palette);
  assert.equal(palette.getNodeType(builder), "color");
  assert.equal(previous.getNodeType(builder), "vec3");
  assert.equal(current.getNodeType(builder), "vec3");
  assert.equal(builder.getTypeLength("color"), 3);
  assert.equal(builder.getTypeLength("vec3"), 3);
  // Three's real shader formatter treats color and vec3 as the same vector
  // representation. SplitNode's complete ordered xyz is an unnecessary swizzle.
  assert.equal(
    builder.format("paletteUniform", "color", "vec3"),
    "paletteUniform",
  );
  assert.equal(
    builder.format("paletteUniform", "vec3", "vec3"),
    "paletteUniform",
  );

  for (const channels of [
    [0.17, 0.42, 0.91],
    [-0.75, 1.8, 3.25],
    [2.4, -1.1, 0.004],
  ]) {
    palette.value.setRGB(...channels);
    const originalChannels = previous.node.value.toArray();
    const splitChannels = [...current.components].map(
      (channel) => current.node.value.toArray()["xyz".indexOf(channel)],
    );
    assert.deepEqual(originalChannels, channels);
    assert.deepEqual(splitChannels, originalChannels);
    assert.equal(previous.node.value, current.node.value);
  }
});
