import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Standalone: node --test tests/integration/source-map-packaging.test.mjs
// Exercise the installed compiler and real package source, not Vite/browser
// performance. Only the compiler output sink is redirected; dist stays intact.
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourcePath = path.join(packageRoot, "src/math/Random.ts");
const configPath = path.join(packageRoot, "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
assert.equal(config.error, undefined);
const converted = ts.convertCompilerOptionsFromJson(
  config.config.compilerOptions,
  packageRoot,
  configPath,
);
assert.deepEqual(converted.errors, []);

function compile(inlineSources) {
  const options = {
    ...converted.options,
    inlineSources,
    noEmitOnError: true,
  };
  const outputs = new Map();
  const host = ts.createCompilerHost(options);
  host.writeFile = (filename, content) => {
    const relative = path.relative(options.outDir, filename);
    assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative));
    assert.equal(outputs.has(relative), false, `Duplicate output: ${relative}`);
    outputs.set(relative, content);
  };
  const program = ts.createProgram([sourcePath], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(
    diagnostics.map((row) =>
      ts.flattenDiagnosticMessageText(row.messageText, "\n"),
    ),
    [],
  );
  const emitted = program.emit();
  assert.equal(emitted.emitSkipped, false);
  assert.deepEqual(emitted.diagnostics, []);
  assert.deepEqual([...outputs.keys()].sort(), [
    "math/Random.d.ts",
    "math/Random.d.ts.map",
    "math/Random.js",
    "math/Random.js.map",
  ]);
  return outputs;
}

test("procgen embeds exact original JS-map sources without changing runtime or declarations", () => {
  assert.equal(config.config.compilerOptions.sourceMap, true);
  assert.equal(config.config.compilerOptions.inlineSources, true);
  assert.equal(config.config.compilerOptions.inlineSourceMap, undefined);
  assert.equal(config.config.compilerOptions.declaration, true);
  assert.equal(config.config.compilerOptions.declarationMap, true);

  const sourceBytes = readFileSync(sourcePath);
  const external = compile(false);
  const embedded = compile(true);
  assert.deepEqual(readFileSync(sourcePath), sourceBytes);

  // Byte comparisons include the unchanged external sourceMappingURL comment.
  for (const name of [
    "math/Random.js",
    "math/Random.d.ts",
    "math/Random.d.ts.map",
  ]) {
    assert.deepEqual(
      Buffer.from(embedded.get(name)),
      Buffer.from(external.get(name)),
      `${name} must not change with inlineSources`,
    );
  }
  const oldMap = JSON.parse(external.get("math/Random.js.map"));
  const newMap = JSON.parse(embedded.get("math/Random.js.map"));
  assert.equal(oldMap.sourcesContent, undefined);
  assert.equal(newMap.sources.length, 1);
  assert.equal(newMap.sourcesContent.length, newMap.sources.length);
  assert.equal(typeof newMap.sourcesContent[0], "string");
  assert.deepEqual(Buffer.from(newMap.sourcesContent[0], "utf8"), sourceBytes);
  const { sourcesContent, ...unchangedMap } = newMap;
  assert.deepEqual(unchangedMap, oldMap);
  assert.ok(sourcesContent[0].includes("export class SeededRandom"));
  assert.equal(
    path.resolve(
      converted.options.outDir,
      "math",
      newMap.sourceRoot,
      newMap.sources[0],
    ),
    sourcePath,
  );

  // Installed TypeScript 6 passes inlineSources to its JS printer, not its
  // declaration printer. Do not claim declaration maps are self-contained.
  const declarationMap = JSON.parse(embedded.get("math/Random.d.ts.map"));
  assert.equal(declarationMap.sourcesContent, undefined);
  assert.deepEqual(declarationMap.sources, newMap.sources);
});
