#!/usr/bin/env node

// Explicit static-prop candidates only: never a bulk or in-place asset optimizer.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Logger, NodeIO } from "@gltf-transform/core";
import {
  EXTMeshoptCompression,
  EXTTextureWebP,
  KHRMaterialsUnlit,
  KHRTextureTransform,
} from "@gltf-transform/extensions";
import {
  MeshoptDecoder,
  MeshoptEncoder,
  MeshoptSimplifier,
} from "meshoptimizer";
import { validateBytes, version as validatorVersion } from "gltf-validator";
import { summarizeModelDocument } from "./audit-models.mjs";

const EXTENSIONS = [
  EXTMeshoptCompression,
  EXTTextureWebP,
  KHRMaterialsUnlit,
  KHRTextureTransform,
];
const SAFE_EXTENSIONS = new Set(
  EXTENSIONS.map((extension) => extension.EXTENSION_NAME),
);
const HELP = [
  "Generate one review-only static GLB candidate without modifying its source.",
  "Usage: node scripts/optimize-models-full.mjs --input source.glb --output candidate.glb",
  "       --max-triangles N --max-error E [--compression none|meshopt] [--dry-run] [--json]",
  "",
  "All four named arguments are required; output must not exist, even for dry-run.",
  "E is meshoptimizer relative geometric error (0..1), not pixels or visual parity.",
  "The file budget is max(mesh definitions, all node attachments), not visible draws.",
  "Only embedded static TRIANGLES GLBs are admitted. No Draco, quantization, texture",
  "conversion, welding, vertex compaction, node pruning, manifest changes or deployment.",
  "Dry-run computes and validates the candidate in memory but writes nothing.",
  "VRM, animation, skins, morphs and other extensions require a protected workflow.",
].join("\n");

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}
function digest(value) {
  return sha256(JSON.stringify(canonical(value)));
}
function numericOptions({ maxTriangles, maxError, compression = "none" }) {
  requireCondition(
    Number.isSafeInteger(maxTriangles) && maxTriangles > 0,
    "maxTriangles must be a positive safe integer",
  );
  requireCondition(
    Number.isFinite(maxError) && maxError >= 0 && maxError <= 1,
    "maxError must be a finite relative error between 0 and 1",
  );
  requireCondition(
    compression === "none" || compression === "meshopt",
    "compression must be none or meshopt (Draco is not supported)",
  );
  return { maxTriangles, maxError, compression };
}

export function parseOptions(argv) {
  const options = {
    compression: "none",
    dryRun: false,
    json: false,
    help: false,
  };
  const seen = new Set();
  const values = new Map([
    ["--input", "input"],
    ["--output", "output"],
    ["--max-triangles", "maxTriangles"],
    ["--max-error", "maxError"],
    ["--compression", "compression"],
  ]);
  const flags = new Map([
    ["--dry-run", "dryRun"],
    ["--json", "json"],
    ["--help", "help"],
  ]);
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    requireCondition(!seen.has(argument), "Duplicate option: " + argument);
    seen.add(argument);
    if (flags.has(argument)) options[flags.get(argument)] = true;
    else {
      requireCondition(
        values.has(argument),
        "Unknown option: " + argument + "; use --help",
      );
      const value = argv[++i];
      requireCondition(
        typeof value === "string" &&
          value.length > 0 &&
          !value.startsWith("--"),
        "Missing value for " + argument,
      );
      const key = values.get(argument);
      if (key === "maxTriangles" || key === "maxError") {
        requireCondition(
          /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value),
          "Invalid number for " + argument,
        );
        options[key] = Number(value);
      } else options[key] = value;
    }
  }
  if (options.help) return options;
  for (const name of ["input", "output", "maxTriangles", "maxError"]) {
    requireCondition(
      options[name] !== undefined,
      "Missing required " + name + "; use --help",
    );
  }
  numericOptions(options);
  return options;
}

function parseEmbeddedGlb(bytes) {
  requireCondition(
    bytes.length >= 20 &&
      bytes.readUInt32LE(0) === 0x46546c67 &&
      bytes.readUInt32LE(4) === 2 &&
      bytes.readUInt32LE(8) === bytes.length,
    "Input must be a complete glTF 2.0 GLB",
  );
  let offset = 12,
    chunks = 0,
    json;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    requireCondition(
      length % 4 === 0 && offset + 8 + length <= bytes.length,
      "Invalid GLB chunk length",
    );
    requireCondition(
      chunks === 0 ? type === 0x4e4f534a : chunks === 1 && type === 0x004e4942,
      "Only one JSON and one embedded BIN chunk are supported",
    );
    if (chunks === 0)
      json = JSON.parse(
        bytes.subarray(offset + 8, offset + 8 + length).toString("utf8"),
      );
    chunks++;
    offset += length + 8;
  }
  requireCondition(offset === bytes.length && json, "Invalid GLB container");
  for (const entry of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    requireCondition(
      entry.uri === undefined ||
        (typeof entry.uri === "string" && entry.uri.startsWith("data:")),
      "External resources are not supported; supply a self-contained embedded GLB",
    );
  }
  return json;
}

function admitDocument(json) {
  const summary = summarizeModelDocument(json);
  requireCondition(
    !summary.vrm &&
      !summary.animationCount &&
      !summary.hasSkinnedMesh &&
      !summary.morphPrimitiveCount &&
      !json.skins?.length &&
      !json.animations?.length &&
      !(json.nodes ?? []).some((node) => node.weights !== undefined),
    "VRM, animation, skins and morph targets require the protected avatar/animation workflow; this tool only handles static props",
  );
  requireCondition(
    summary.contentKind === "mesh-asset" && summary.triangles > 0,
    "A static mesh asset with triangles is required",
  );
  function checkExtensions(value) {
    if (!value || typeof value !== "object") return;
    if (value.extensions) {
      for (const name of Object.keys(value.extensions)) {
        requireCondition(
          SAFE_EXTENSIONS.has(name),
          "Unsupported extension " +
            name +
            "; add explicit preservation coverage before using this workflow",
        );
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "extras") checkExtensions(child);
    }
  }
  checkExtensions(json);
  for (const name of [
    ...(json.extensionsUsed ?? []),
    ...(json.extensionsRequired ?? []),
  ]) {
    requireCondition(
      SAFE_EXTENSIONS.has(name),
      "Unsupported extension " +
        name +
        "; no Draco, custom or unprotected extension conversion",
    );
  }
  for (const mesh of json.meshes) {
    requireCondition(
      mesh.weights === undefined,
      "Mesh weights require the protected morph workflow",
    );
    for (const primitive of mesh.primitives) {
      requireCondition(
        (primitive.mode ?? 4) === 4,
        "Only TRIANGLES primitives are supported; strip/fan/line conversion is not implicit",
      );
      requireCondition(
        primitive.targets === undefined,
        "Morph targets require a protected workflow",
      );
    }
  }
  return summary;
}

async function validate(bytes, label) {
  const result = await validateBytes(bytes, {
    format: "glb",
    maxIssues: 100,
    writeTimestamp: false,
  });
  requireCondition(
    !result.issues.truncated,
    label + " validation report was truncated; complete validation is required",
  );
  requireCondition(
    result.issues.numErrors === 0,
    label +
      " failed Khronos validation (" +
      result.issues.numErrors +
      " errors): " +
      result.issues.messages
        .filter((issue) => issue.severity === 0)
        .slice(0, 5)
        .map((issue) => issue.code)
        .join(", "),
  );
  return { validator: validatorVersion(), ...result.issues };
}
function createIO() {
  return new NodeIO()
    .setLogger(new Logger(Logger.Verbosity.SILENT))
    .registerExtensions(EXTENSIONS)
    .registerDependencies({
      "meshopt.decoder": MeshoptDecoder,
      "meshopt.encoder": MeshoptEncoder,
    });
}
function removeCompression(document) {
  for (const extension of document.getRoot().listExtensionsUsed()) {
    if (extension.extensionName === "EXT_meshopt_compression")
      extension.dispose();
  }
}

// Canonical NodeIO serialization covers hierarchy, transforms, names/extras, scenes,
// material/texture bindings, samplers and admitted extension payloads. Decoded attribute
// and image bytes replace storage offsets/URIs. Only primitive indices may change.
async function preservationFingerprint(document, io) {
  const { json, resources } = await io.writeJSON(document);
  const meshes = document.getRoot().listMeshes();
  for (const [meshIndex, mesh] of (json.meshes ?? []).entries()) {
    const sourcePrimitives = meshes[meshIndex].listPrimitives();
    for (const [primitiveIndex, primitive] of mesh.primitives.entries()) {
      delete primitive.indices;
      for (const [semantic, index] of Object.entries(primitive.attributes)) {
        // Writer groups/reorders accessors by usage. Its emitted accessor index
        // is not an index into Root.listAccessors(); follow the actual binding.
        const accessor =
          sourcePrimitives[primitiveIndex].getAttribute(semantic);
        const description = { ...json.accessors[index] };
        delete description.bufferView;
        delete description.byteOffset;
        delete description.sparse;
        const array = accessor.getArray();
        description.bytesSha256 = sha256(
          new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
        );
        primitive.attributes[semantic] = description;
      }
    }
  }
  for (const image of json.images ?? []) {
    requireCondition(
      resources[image.uri] instanceof Uint8Array,
      "Missing embedded image during preservation fingerprint",
    );
    image.bytesSha256 = sha256(resources[image.uri]);
    delete image.uri;
  }
  delete json.buffers;
  delete json.bufferViews;
  delete json.accessors;
  return digest(json);
}

function topologyFingerprint(document) {
  return digest(
    document
      .getRoot()
      .listMeshes()
      .map((mesh) =>
        mesh.listPrimitives().map((primitive) => {
          const indices =
            primitive.getIndices()?.getArray() ??
            Uint32Array.from(
              { length: primitive.getAttribute("POSITION").getCount() },
              (_, index) => index,
            );
          const triangles = [];
          for (let i = 0; i < indices.length; i += 3) {
            const a = indices[i],
              b = indices[i + 1],
              c = indices[i + 2];
            // Lossless meshopt may cyclically rotate triangle corners, never their winding.
            triangles.push(
              a <= b && a <= c ? [a, b, c] : b <= c ? [b, c, a] : [c, a, b],
            );
          }
          return triangles;
        }),
      ),
  );
}

export async function optimizeModelCandidate(sourceBuffer, options) {
  const { maxTriangles, maxError, compression } = numericOptions(options);
  requireCondition(
    sourceBuffer instanceof Uint8Array,
    "sourceBuffer must contain GLB bytes",
  );
  const source = Buffer.from(sourceBuffer); // Own bytes; never mutate caller storage.
  const before = admitDocument(parseEmbeddedGlb(source));
  const sourceValidation = await validate(source, "Source");
  await Promise.all([
    MeshoptDecoder.ready,
    MeshoptEncoder.ready,
    MeshoptSimplifier.ready,
  ]);
  requireCondition(
    MeshoptSimplifier.supported,
    "Meshoptimizer WASM simplification is unavailable",
  );
  const io = createIO();
  const document = await io.readBinary(source);
  removeCompression(document);
  // Khronos does not decode EXT_meshopt_compression. Validate the actual decoded
  // streams too, including attributes other than the simplifier's POSITION/index.
  const decodedSourceValidation = await validate(
    await io.writeBinary(document),
    "Decoded source",
  );
  const preservedBefore = await preservationFingerprint(document, io);
  const ratio = Math.min(1, maxTriangles / before.triangles);
  const primitives = [];
  for (const [meshIndex, mesh] of document.getRoot().listMeshes().entries()) {
    for (const [primitiveIndex, primitive] of mesh.listPrimitives().entries()) {
      const position = primitive.getAttribute("POSITION");
      const positions = position.getArray();
      requireCondition(
        positions instanceof Float32Array &&
          position.getElementSize() === 3 &&
          !position.getNormalized() &&
          positions.every(Number.isFinite),
        "POSITION must contain finite unquantized Float32 VEC3 data",
      );
      const previous = primitive.getIndices();
      const sourceIndices =
        previous?.getArray() ??
        Uint32Array.from({ length: position.getCount() }, (_, index) => index);
      const indices = Uint32Array.from(sourceIndices);
      requireCondition(
        indices.length > 0 &&
          indices.length % 3 === 0 &&
          indices.every((index) => index < position.getCount()),
        "Invalid decoded triangle indices",
      );
      const targetTriangles = Math.max(
        1,
        Math.floor((indices.length / 3) * ratio),
      );
      let result = indices;
      let error = 0;
      if (targetTriangles * 3 < indices.length) {
        [result, error] = MeshoptSimplifier.simplify(
          indices,
          positions,
          3,
          targetTriangles * 3,
          maxError,
          ["LockBorder"],
        );
        requireCondition(
          result.length > 0 &&
            result.length % 3 === 0 &&
            result.every((index) => index < position.getCount()),
          "Simplifier returned invalid or empty geometry",
        );
        requireCondition(
          Number.isFinite(error) && error >= 0 && error <= maxError,
          "Simplifier exceeded the requested error bound",
        );
        const outputIndices =
          position.getCount() <= 65535 ? Uint16Array.from(result) : result;
        const accessor = previous
          ? previous.clone()
          : document
              .createAccessor()
              .setType("SCALAR")
              .setBuffer(position.getBuffer());
        primitive.setIndices(accessor.setArray(outputIndices));
      }
      const scale = MeshoptSimplifier.getScale(positions, 3);
      requireCondition(
        Number.isFinite(scale) && scale >= 0,
        "Invalid meshoptimizer geometric error scale",
      );
      primitives.push({
        mesh: meshIndex,
        primitive: primitiveIndex,
        beforeTriangles: indices.length / 3,
        afterTriangles: result.length / 3,
        targetTriangles,
        error,
        scale,
        localError: error * scale,
      });
    }
  }
  const preservedAfter = await preservationFingerprint(document, io);
  requireCondition(
    preservedBefore === preservedAfter,
    "Candidate changed protected attributes, images, hierarchy or material bindings",
  );
  const topology = topologyFingerprint(document);
  if (compression === "meshopt") {
    // Direct extension encoding is lossless here. Never call meshopt(), quantize(),
    // reorder(), FILTER encoding or a texture transform.
    document
      .createExtension(EXTMeshoptCompression)
      .setRequired(true)
      .setEncoderOptions({
        method: EXTMeshoptCompression.EncoderMethod.QUANTIZE,
      });
  }
  const output = Buffer.from(await io.writeBinary(document));
  const after = admitDocument(parseEmbeddedGlb(output));
  requireCondition(
    after.triangles <= maxTriangles,
    "Triangle budget unmet: " +
      after.triangles +
      " > " +
      maxTriangles +
      " at maxError=" +
      maxError +
      "; borders/seams and error bound were retained, nothing was written",
  );
  const candidateValidation = await validate(output, "Candidate");
  const roundTrip = await io.readBinary(output);
  removeCompression(roundTrip);
  const decodedCandidateValidation = await validate(
    await io.writeBinary(roundTrip),
    "Decoded candidate",
  );
  const roundTripFingerprint = await preservationFingerprint(roundTrip, io);
  requireCondition(
    roundTripFingerprint === preservedBefore &&
      topologyFingerprint(roundTrip) === topology,
    "Encoded candidate failed decoded attribute/image/structure/index preservation",
  );
  return {
    output,
    report: {
      status: "candidate",
      scope:
        "Explicit embedded static-prop GLB; review-only, not runtime or visual acceptance",
      before,
      after,
      maxTriangles,
      maxError,
      compression,
      sourceSha256: sha256(source),
      outputSha256: sha256(output),
      sourceBytes: source.length,
      outputBytes: output.length,
      preservation: {
        matched: true,
        beforeSha256: preservedBefore,
        afterSha256: roundTripFingerprint,
        topologySha256: topology,
        scope:
          "Decoded vertex streams and images byte-exact; canonical node/scene/material/texture structure unchanged; only primitive indices simplified",
      },
      simplification: {
        errorMetric:
          "Meshoptimizer relative geometric error; localError = returned error × getScale(POSITION). Not world-space, screen-space, UV/color error or visual parity.",
        primitives,
      },
      validation: {
        source: sourceValidation,
        decodedSource: decodedSourceValidation,
        candidate: candidateValidation,
        decodedCandidate: decodedCandidateValidation,
      },
      limitations: [
        "Vertex buffers are intentionally not compacted; index/triangle reduction does not promise smaller files or faster rendering.",
        "Retained UV/normal/color samples are byte-exact, but interpolation and silhouette can change; native matched-view review is mandatory.",
        "Conservative file totals include alternate/unused mesh definitions and node attachments, not measured visible geometry or draw calls.",
        "No manifest, collision, resource, LOD, runtime or source asset is changed.",
      ],
    },
  };
}

function absent(filename) {
  try {
    lstatSync(filename);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    "Output already exists (including symlink/hardlink): " + filename,
  );
}
function identity(stat) {
  return stat.dev + ":" + stat.ino;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) return { help: HELP };
  const input = path.resolve(options.input);
  const requestedOutput = path.resolve(options.output);
  requireCondition(
    path.extname(input).toLowerCase() === ".glb" &&
      path.extname(requestedOutput).toLowerCase() === ".glb",
    "Input and output must be .glb files",
  );
  requireCondition(
    input !== requestedOutput,
    "Input and output must be different paths",
  );
  const inputStat = lstatSync(input);
  requireCondition(
    inputStat.isFile() && !inputStat.isSymbolicLink() && inputStat.nlink === 1,
    "Input must be a regular non-symlink file with no hardlinks",
  );
  absent(requestedOutput);
  const requestedParent = path.dirname(requestedOutput);
  requireCondition(
    !lstatSync(requestedParent).isSymbolicLink(),
    "Output parent must not be a symlink",
  );
  const parent = realpathSync(requestedParent);
  const parentStat = lstatSync(parent);
  requireCondition(
    parentStat.isDirectory(),
    "Output parent must be an existing directory",
  );
  const outputPath = path.join(parent, path.basename(requestedOutput));
  requireCondition(
    realpathSync(input) !== outputPath,
    "Input and output resolve to the same path",
  );
  absent(outputPath);
  const sourceFd = openSync(input, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source;
  try {
    requireCondition(
      identity(fstatSync(sourceFd)) === identity(inputStat),
      "Input changed while opening",
    );
    source = readFileSync(sourceFd);
  } finally {
    closeSync(sourceFd);
  }
  const { output, report } = await optimizeModelCandidate(source, options);
  const finalInputStat = lstatSync(input);
  requireCondition(
    finalInputStat.isFile() &&
      !finalInputStat.isSymbolicLink() &&
      finalInputStat.nlink === 1 &&
      identity(finalInputStat) === identity(inputStat) &&
      sha256(readFileSync(input)) === report.sourceSha256,
    "Input changed during candidate preparation; output not written",
  );
  requireCondition(
    !lstatSync(requestedParent).isSymbolicLink() &&
      realpathSync(requestedParent) === parent &&
      identity(lstatSync(parent)) === identity(parentStat),
    "Output parent changed during candidate preparation",
  );
  absent(outputPath);
  if (!options.dryRun) {
    let fd, createdIdentity;
    try {
      fd = openSync(
        outputPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o644,
      );
      createdIdentity = identity(fstatSync(fd));
      writeFileSync(fd, output);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (
        createdIdentity &&
        identity(lstatSync(outputPath)) === createdIdentity
      )
        unlinkSync(outputPath);
      throw error;
    }
  }
  return {
    ...report,
    input,
    output: outputPath,
    dryRun: options.dryRun,
    written: !options.dryRun,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
    .then((report) => {
      if (process.argv.includes("--json")) console.log(JSON.stringify(report));
      else if (report.help) console.log(report.help);
      else
        console.log(
          (report.written ? "Candidate written" : "Dry-run validated") +
            ": " +
            report.before.triangles +
            " → " +
            report.after.triangles +
            " triangles. Source unchanged; native visual review still required.\n" +
            report.output,
        );
    })
    .catch((error) => {
      if (process.argv.includes("--json"))
        console.log(JSON.stringify({ status: "error", error: error.message }));
      else console.error("Candidate rejected: " + error.message);
      process.exitCode = 1;
    });
}
