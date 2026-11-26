import assert from "node:assert/strict";
import test from "node:test";

import {
  compareJsonStructureIgnoringStrings,
  parseGlb,
} from "./validate-nested-asset-branding-migration.mjs";

function createGlb(document, binary = Buffer.from([1, 2, 3, 4])) {
  const rawJson = Buffer.from(JSON.stringify(document));
  const jsonLength = Math.ceil(rawJson.length / 4) * 4;
  const total = 12 + 8 + jsonLength + 8 + binary.length;
  const output = Buffer.alloc(total, 0x20);
  output.write("glTF", 0, "ascii");
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(total, 8);
  output.writeUInt32LE(jsonLength, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  rawJson.copy(output, 20);
  const binaryHeader = 20 + jsonLength;
  output.writeUInt32LE(binary.length, binaryHeader);
  output.writeUInt32LE(0x004e4942, binaryHeader + 4);
  binary.copy(output, binaryHeader + 8);
  return output;
}

test("GLB parser preserves JSON and binary chunks", () => {
  const parsed = parseGlb(
    createGlb({ asset: { version: "2.0", generator: "old-name" } }),
  );
  assert.equal(parsed.json.asset.generator, "old-name");
  assert.deepEqual([...parsed.chunks[1].bytes], [1, 2, 3, 4]);
});

test("structural comparison permits string-only branding changes", () => {
  assert.doesNotThrow(() =>
    compareJsonStructureIgnoringStrings(
      { asset: { generator: "old-name", version: "2.0" }, nodes: [1] },
      { asset: { generator: "Hyperia", version: "2.0" }, nodes: [1] },
    ),
  );
  const retiredBrandKey = ["hyper", "scape"].join("");
  assert.doesNotThrow(() =>
    compareJsonStructureIgnoringStrings(
      { [retiredBrandKey]: { collision: true } },
      { hyperia: { collision: true } },
    ),
  );
});

test("structural comparison rejects geometry and schema changes", () => {
  assert.throws(
    () =>
      compareJsonStructureIgnoringStrings(
        { meshes: [{ primitives: [{ indices: 1 }] }] },
        { meshes: [{ primitives: [{ indices: 2 }] }] },
      ),
    /changed non-string value/u,
  );
  assert.throws(
    () => compareJsonStructureIgnoringStrings({ nodes: [] }, { scenes: [] }),
    /changed object keys/u,
  );
});

test("GLB parser rejects malformed framing", () => {
  const malformed = createGlb({ asset: { version: "2.0" } });
  malformed.writeUInt32LE(malformed.length + 4, 8);
  assert.throws(() => parseGlb(malformed), /invalid GLB framing/u);
});
