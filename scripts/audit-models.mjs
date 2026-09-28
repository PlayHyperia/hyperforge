#!/usr/bin/env node
/**
 * Read-only glTF/GLB/VRM geometry census and provisional budget gate.
 *
 * Counts declared topology, not decoded/visible triangles or measured draw calls.
 * Does not validate buffers, rig quality, textures, visual fidelity or runtime LOD.
 * Includes every mesh/primitive and all LOD files. Never edits model assets.
 * Topology and instancing references:
 * https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#meshes
 * https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_mesh_gpu_instancing/README.md
 *
 * node scripts/audit-models.mjs [--json] [--verbose] [--max-triangles N]
 *   [--assets-dir DIR ...] [FILE ...]
 */
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseGlbJson } from "./audit-avatar-lods.mjs";

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFAULT_DIRS = [
  "packages/server/world/assets/models",
  "packages/server/world/assets/avatars",
];
const MODEL_EXTENSIONS = new Set([".glb", ".gltf", ".vrm"]);
// Existing limits retained as provisional regression guards, not frame-time proof.
const ITEM_NAMES =
  /sword|scimitar|dagger|bow|mace|shield|armor|armour|platebody|platelegs|chainbody|helmet|pickaxe|hatchet|fishing|rod|arrow|logs|boots|gauntlet|hammer/;

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive safe integer`);
  return value;
}
function safeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} exceeds the supported count range`);
  return value;
}
function referenced(array, index, label) {
  if (!Number.isSafeInteger(index) || index < 0 || !array?.[index])
    throw new Error(`${label} references an absent entry: ${index}`);
  return array[index];
}
function arrayField(object, key) {
  const value = object[key] ?? [];
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  return value;
}

export function categorizeModel(filepath) {
  if (path.extname(filepath).toLowerCase() === ".vrm")
    return { category: "avatar", limit: 20_000 };
  const name = path.basename(filepath).toLowerCase();
  return ITEM_NAMES.test(name)
    ? { category: "equipment", limit: 10_000 }
    : { category: "world-or-character", limit: 20_000 };
}

/** Metadata-only counts work for compressed accessors without decoding geometry.
 * Triangle strips/fans count assembled slots, including possible degenerates.
 * Separate definition and instance counts prevent a shared mesh hiding its cost.
 */
export function summarizeModelDocument(document) {
  if (document?.asset?.version !== "2.0")
    throw new Error("Expected a glTF 2.0 document");
  const meshes = arrayField(document, "meshes");
  const accessors = arrayField(document, "accessors");
  const nodes = arrayField(document, "nodes");
  const scenes = arrayField(document, "scenes");
  const animationCount = arrayField(document, "animations").length;
  if (!meshes.length && !animationCount)
    throw new Error("Model contains no meshes or animations");
  const positions = new Set();
  const usedMaterials = new Set();
  const extensions = new Set([
    ...arrayField(document, "extensionsUsed"),
    ...arrayField(document, "extensionsRequired"),
  ]);
  let primitiveCount = 0,
    skinnedPrimitiveCount = 0,
    morphPrimitiveCount = 0;
  const meshTriangles = meshes.map((mesh, meshIndex) => {
    const primitives = arrayField(mesh, "primitives");
    if (!primitives.length)
      throw new Error(`Mesh ${meshIndex} has no primitives`);
    return primitives.reduce((sum, primitive, primitiveIndex) => {
      const label = `Mesh ${meshIndex} primitive ${primitiveIndex}`;
      const positionIndex = primitive.attributes?.POSITION;
      const position = referenced(
        accessors,
        positionIndex,
        `${label} POSITION`,
      );
      positiveInteger(position.count, `${label} vertex count`);
      if (position.type !== "VEC3")
        throw new Error(`${label} POSITION must be VEC3`);
      positions.add(positionIndex);
      let count = position.count;
      if (primitive.indices !== undefined) {
        const indices = referenced(
          accessors,
          primitive.indices,
          `${label} indices`,
        );
        count = positiveInteger(indices.count, `${label} index count`);
        if (
          indices.type !== "SCALAR" ||
          ![5121, 5123, 5125].includes(indices.componentType)
        )
          throw new Error(`${label} indices must be unsigned SCALAR`);
      }
      const mode = primitive.mode ?? 4;
      if (![4, 5, 6].includes(mode))
        throw new Error(
          `${label} topology ${mode} is not covered by triangle budgets`,
        );
      if (count < 3 || (mode === 4 && count % 3 !== 0))
        throw new Error(`${label} has invalid topology count ${count}`);
      primitiveCount++;
      if (
        primitive.attributes?.JOINTS_0 !== undefined ||
        primitive.attributes?.WEIGHTS_0 !== undefined
      )
        skinnedPrimitiveCount++;
      if (arrayField(primitive, "targets").length) morphPrimitiveCount++;
      if (primitive.material !== undefined) {
        referenced(document.materials, primitive.material, `${label} material`);
        usedMaterials.add(primitive.material);
      }
      for (const extension of Object.keys(primitive.extensions ?? {}))
        extensions.add(extension);
      return safeCount(sum + (mode === 4 ? count / 3 : count - 2), label);
    }, 0);
  });
  for (const view of arrayField(document, "bufferViews"))
    for (const extension of Object.keys(view.extensions ?? {}))
      extensions.add(extension);
  const children = nodes.map((node) => arrayField(node, "children"));
  const parents = new Map();
  for (let i = 0; i < nodes.length; i++) {
    for (const child of children[i]) {
      referenced(nodes, child, `Node ${i} child`);
      if (parents.has(child))
        throw new Error(`Node ${child} has multiple parents`);
      parents.set(child, i);
    }
  }
  const nodeTriangles = nodes.map((node, index) => {
    const instancing = node.extensions?.EXT_mesh_gpu_instancing;
    if (instancing && node.mesh === undefined)
      throw new Error(`Instanced node ${index} has no mesh`);
    if (node.mesh === undefined) return 0;
    referenced(meshes, node.mesh, `Node ${index} mesh`);
    let instances = 1;
    if (instancing) {
      extensions.add("EXT_mesh_gpu_instancing");
      const attributes = Object.values(instancing.attributes ?? {});
      if (!attributes.length)
        throw new Error(`Instanced node ${index} has no attributes`);
      const counts = attributes.map((accessorIndex) =>
        positiveInteger(
          referenced(
            accessors,
            accessorIndex,
            `Node ${index} instance attribute`,
          ).count,
          `Node ${index} instance count`,
        ),
      );
      if (counts.some((count) => count !== counts[0]))
        throw new Error(`Instanced node ${index} has unequal attribute counts`);
      instances = counts[0];
    }
    return safeCount(meshTriangles[node.mesh] * instances, `Node ${index}`);
  });
  // Validate all nodes, including unreachable ones; never silently skip a cycle.
  const colors = new Uint8Array(nodes.length);
  const visit = (index) => {
    if (colors[index] === 1) throw new Error("Node hierarchy contains a cycle");
    if (colors[index] === 2) return;
    colors[index] = 1;
    for (const child of children[index]) visit(child);
    colors[index] = 2;
  };
  for (let i = 0; i < nodes.length; i++) visit(i);
  const countScene = (roots) => {
    const seen = new Set();
    let triangles = 0;
    const stack = [...roots];
    while (stack.length) {
      const index = stack.pop();
      referenced(nodes, index, "Scene node");
      if (seen.has(index))
        throw new Error(`Scene references node ${index} more than once`);
      seen.add(index);
      triangles = safeCount(
        triangles + nodeTriangles[index],
        "Scene triangles",
      );
      stack.push(...children[index]);
    }
    return triangles;
  };
  const sceneTriangles = scenes.map((scene) =>
    countScene(arrayField(scene, "nodes")),
  );
  if (document.scene !== undefined)
    referenced(scenes, document.scene, "Default scene");
  const sum = (values) =>
    values.reduce((total, value) => safeCount(total + value, "Total"), 0);
  const definitionTriangles = sum(meshTriangles);
  const allNodeTriangles = sum(nodeTriangles);
  const maxSceneTriangles = sceneTriangles.length
    ? Math.max(...sceneTriangles)
    : null;
  return {
    contentKind: meshes.length ? "mesh-asset" : "animation-only",
    animationCount,
    // Conservative file-level gate includes unused definitions and alternate nodes.
    // These are NOT summed across files to claim an in-game visible scene budget.
    triangles: Math.max(definitionTriangles, allNodeTriangles),
    definitionTriangles,
    allNodeTriangles,
    sceneTriangles,
    maxSceneTriangles,
    defaultSceneTriangles:
      document.scene === undefined ? null : sceneTriangles[document.scene],
    meshes: meshes.map((mesh, index) => ({
      index,
      name: mesh.name ?? null,
      triangles: meshTriangles[index],
      primitiveCount: mesh.primitives.length,
    })),
    vertices: sum([...positions].map((index) => accessors[index].count)),
    meshCount: meshes.length,
    primitiveCount,
    nodeCount: nodes.length,
    materialCount: usedMaterials.size,
    skinnedPrimitiveCount,
    morphPrimitiveCount,
    hasSkinnedMesh:
      skinnedPrimitiveCount > 0 || arrayField(document, "skins").length > 0,
    vrm: !!(document.extensions?.VRMC_vrm || document.extensions?.VRM),
    extensions: [...extensions].sort(),
    textureFormats: [
      ...new Set(
        arrayField(document, "images").map(
          (image) =>
            image.mimeType ||
            /^data:([^;,]+)/.exec(image.uri ?? "")?.[1] ||
            path.extname((image.uri ?? "").split("?")[0]).toLowerCase() ||
            "unknown",
        ),
      ),
    ].sort(),
    declaredBufferBytes: sum(
      arrayField(document, "buffers").map((buffer) =>
        positiveInteger(buffer.byteLength, "Buffer byteLength"),
      ),
    ),
  };
}

export function inspectModel(filepath) {
  const buffer = readFileSync(filepath);
  const extension = path.extname(filepath).toLowerCase();
  if (!MODEL_EXTENSIONS.has(extension))
    throw new Error(`Unsupported model extension: ${extension}`);
  if (extension !== ".gltf") {
    // Validate the whole container, not just its first JSON chunk.
    let offset = 12,
      chunks = 0;
    while (offset + 8 <= buffer.length) {
      const length = buffer.readUInt32LE(offset);
      if (length % 4 !== 0 || offset + 8 + length > buffer.length)
        throw new Error("Invalid or truncated GLB chunk");
      const type = buffer.readUInt32LE(offset + 4);
      if (chunks === 0 && type !== 0x4e4f534a)
        throw new Error("GLB must begin with its JSON chunk");
      if (chunks > 0 && type === 0x4e4f534a)
        throw new Error("GLB cannot contain multiple JSON chunks");
      offset += 8 + length;
      chunks++;
    }
    if (offset !== buffer.length || !chunks)
      throw new Error("Invalid GLB container");
  }
  const document =
    extension === ".gltf"
      ? JSON.parse(buffer.toString("utf8"))
      : parseGlbJson(buffer, filepath);
  return {
    ...summarizeModelDocument(document),
    fileSize: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

export function collectModels(roots) {
  const models = new Set(),
    directories = new Set();
  const walk = (input) => {
    const resolved = realpathSync(input);
    const entry = statSync(resolved);
    if (entry.isDirectory()) {
      if (directories.has(resolved)) return;
      directories.add(resolved);
      for (const child of readdirSync(resolved).sort()) {
        if (["node_modules", ".git"].includes(child)) continue;
        const filename = path.join(resolved, child);
        // Explicit symlink roots are allowed. Do not traverse links nested in an
        // asset tree, which could silently include assets from another checkout.
        if (lstatSync(filename).isSymbolicLink())
          throw new Error(
            `Nested asset symlink requires an explicit input: ${filename}`,
          );
        if (
          statSync(filename).isDirectory() ||
          MODEL_EXTENSIONS.has(path.extname(child).toLowerCase())
        )
          walk(filename);
      }
    } else if (
      entry.isFile() &&
      MODEL_EXTENSIONS.has(path.extname(resolved).toLowerCase())
    ) {
      models.add(resolved);
    } else
      throw new Error(`Not a supported model or asset directory: ${input}`);
  };
  for (const root of roots) walk(root);
  if (!models.size)
    throw new Error("No model files found; empty coverage cannot pass");
  return [...models].sort();
}

export function auditModels(files, { maxTriangles } = {}) {
  if (maxTriangles !== undefined) positiveInteger(maxTriangles, "maxTriangles");
  const models = files.map((filepath) => {
    const category = categorizeModel(filepath);
    const limit = maxTriangles ?? category.limit;
    try {
      const info = inspectModel(filepath);
      return {
        filepath,
        ...category,
        limit,
        ...info,
        budgetApplicable: info.contentKind !== "animation-only",
        passed: info.triangles <= limit,
      };
    } catch (error) {
      return {
        filepath,
        ...category,
        limit,
        passed: false,
        error: error.message,
      };
    }
  });
  if (!models.length) throw new Error("Empty model audit cannot pass");
  return {
    policy: "provisional-file-inventory-v1",
    scope:
      "Declared topology only; not decoded asset validation, visible scene cost or frame-time acceptance.",
    summary: {
      total: models.length,
      passed: models.filter((row) => row.passed).length,
      failed: models.filter((row) => !row.passed).length,
      inspectionErrors: models.filter((row) => row.error).length,
    },
    models,
  };
}

export function parseOptions(args) {
  const options = { inputs: [], json: false, verbose: false, fix: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--json", "--verbose", "--fix", "--help"].includes(arg))
      options[arg.slice(2)] = true;
    else if (arg === "--assets-dir" || arg === "--max-triangles") {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${arg}`);
      if (arg === "--assets-dir") options.inputs.push(path.resolve(value));
      else
        options.maxTriangles = positiveInteger(
          Number(value),
          "--max-triangles",
        );
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else options.inputs.push(path.resolve(arg));
  }
  options.defaultRoots = options.inputs.length === 0;
  if (options.defaultRoots)
    options.inputs = DEFAULT_DIRS.map((dir) => path.join(ROOT_DIR, dir));
  return options;
}

function main(args) {
  const options = parseOptions(args);
  if (options.help) {
    console.log(
      "Usage: node scripts/audit-models.mjs [--json] [--verbose] [--max-triangles N] [--assets-dir DIR ...] [FILE ...]",
    );
    return;
  }
  const report = auditModels(collectModels(options.inputs), options);
  report.coverage = {
    inputRoots: options.inputs,
    mode: options.defaultRoots
      ? "legacy-model-and-avatar-directories"
      : "explicit-inputs",
    wholeLaunchCoverage: false,
    budgetBasis:
      "Maximum of mesh-definition and all-node inventories; stored LOD alternatives may not render together.",
  };
  if (options.fix)
    report.optimizationGuidance =
      "No files changed. Create derived LODs with error-bounded simplification; preserve originals and validate rig, morphs, UVs, fit and native appearance. Compression alone does not reduce triangles.";
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(report.scope);
    for (const row of report.models) {
      if (!row.passed || options.verbose)
        console.log(
          `${row.budgetApplicable === false ? "ANIMATION-ONLY" : row.passed ? "PASS" : "FAIL"} ${path.relative(ROOT_DIR, row.filepath)}: ${row.error ?? `${row.triangles} triangles / ${row.limit} provisional limit; ${row.primitiveCount} primitives`}`,
        );
    }
    console.log(JSON.stringify(report.summary));
    if (options.fix) console.log(report.optimizationGuidance);
  }
  process.exitCode = report.summary.failed ? 1 : 0;
}
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (process.argv.includes("--json"))
      console.log(
        JSON.stringify({
          summary: { failed: 1, inspectionErrors: 1 },
          error: error.message,
        }),
      );
    else console.error(error.message);
    process.exitCode = 1;
  }
}
