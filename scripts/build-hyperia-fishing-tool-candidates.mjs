#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import validator from "gltf-validator";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

import { buildRigidDuelEquipment } from "./build-steve-rigid-duel-equipment.mjs";

const EXPECTED_ITEM_IDS = Object.freeze([
  "small_fishing_net",
  "harpoon",
  "lobster_pot",
]);
const SAFE_ID = /^[a-z0-9][a-z0-9_-]*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeWorkspacePath(workspaceRoot, relativePath, label) {
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.startsWith("../")
  ) {
    throw new Error(`${label} must be a normalized workspace-relative path`);
  }
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes the workspace`);
  }
  return resolved;
}

function assertFiniteTuple(value, length, label) {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some((entry) => !Number.isFinite(entry))
  ) {
    throw new Error(`${label} must contain ${length} finite numbers`);
  }
}

function writeAtomic(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, contents, { flag: "wx" });
    renameSync(temporary, filePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function installFileReaderPolyfill() {
  if (typeof globalThis.FileReader === "function") return;
  globalThis.FileReader = class FileReader {
    result = null;
    error = null;
    onloadend = null;
    onerror = null;

    readAsArrayBuffer(blob) {
      blob
        .arrayBuffer()
        .then((value) => {
          this.result = value;
          this.onloadend?.();
        })
        .catch((error) => {
          this.error = error;
          this.onerror?.(error);
        });
    }
  };
}

function material(name, color, { metalness = 0, roughness = 0.78 } = {}) {
  return new THREE.MeshStandardMaterial({
    name,
    color,
    metalness,
    roughness,
    flatShading: true,
  });
}

function addMesh(parent, name, geometry, surface) {
  // These candidates use authored flat colors only. Removing generated UVs
  // keeps the GLB free of unused-accessor findings and avoids implying a
  // texture dependency that does not exist.
  geometry.deleteAttribute("uv");
  geometry.deleteAttribute("uv1");
  const mesh = new THREE.Mesh(geometry, surface);
  mesh.name = name;
  parent.add(mesh);
  return mesh;
}

function addCylinder(
  parent,
  name,
  start,
  end,
  radius,
  surface,
  radialSegments = 8,
) {
  const from = new THREE.Vector3(...start);
  const to = new THREE.Vector3(...end);
  const direction = to.clone().sub(from);
  const length = direction.length();
  if (!Number.isFinite(length) || length <= 0) {
    throw new Error(`${name} cylinder has invalid endpoints`);
  }
  const mesh = addMesh(
    parent,
    name,
    new THREE.CylinderGeometry(
      radius,
      radius,
      length,
      radialSegments,
      1,
      false,
    ),
    surface,
  );
  mesh.position.copy(from.add(to).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.normalize(),
  );
  return mesh;
}

function addCone(parent, name, base, tip, radius, surface, radialSegments = 6) {
  const from = new THREE.Vector3(...base);
  const to = new THREE.Vector3(...tip);
  const direction = to.clone().sub(from);
  const length = direction.length();
  if (!Number.isFinite(length) || length <= 0) {
    throw new Error(`${name} cone has invalid endpoints`);
  }
  const mesh = addMesh(
    parent,
    name,
    new THREE.ConeGeometry(radius, length, radialSegments, 1, false),
    surface,
  );
  mesh.position.copy(from.add(to).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.normalize(),
  );
  return mesh;
}

function addBox(parent, name, size, position, surface) {
  const mesh = addMesh(parent, name, new THREE.BoxGeometry(...size), surface);
  mesh.position.set(...position);
  return mesh;
}

function buildSmallFishingNet(root) {
  const wood = material("net-handle", 0x6e4326, { roughness: 0.86 });
  const rope = material("net-rope", 0xd5b873, { roughness: 0.92 });
  const weights = material("net-weights", 0x5d6872, {
    metalness: 0.32,
    roughness: 0.52,
  });
  addCylinder(root, "Handle", [0, 0, 0], [0, 0.31, 0], 0.032, wood, 8);
  addCylinder(
    root,
    "HandleShoulderLeft",
    [0, 0.28, 0],
    [-0.12, 0.38, 0],
    0.024,
    wood,
    8,
  );
  addCylinder(
    root,
    "HandleShoulderRight",
    [0, 0.28, 0],
    [0.12, 0.38, 0],
    0.024,
    wood,
    8,
  );
  const rim = addMesh(
    root,
    "WeightedRim",
    new THREE.TorusGeometry(0.36, 0.024, 6, 24),
    weights,
  );
  rim.position.set(0, 0.66, 0);
  rim.scale.set(1, 0.78, 1);

  const segments = 12;
  const rimPoints = Array.from({ length: segments }, (_, index) => {
    const angle = (index / segments) * Math.PI * 2;
    return [Math.cos(angle) * 0.36, 0.66 + Math.sin(angle) * 0.281, 0];
  });
  const innerPoints = rimPoints.map(([x, y]) => [
    x * 0.52,
    y * 0.52 + 0.317,
    -0.24,
  ]);
  const pocket = [0, 0.66, -0.42];
  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    addCylinder(
      root,
      `NetRadial${index}`,
      rimPoints[index],
      innerPoints[index],
      0.0065,
      rope,
      6,
    );
    addCylinder(
      root,
      `NetPocket${index}`,
      innerPoints[index],
      pocket,
      0.0065,
      rope,
      6,
    );
    addCylinder(
      root,
      `NetInnerRing${index}`,
      innerPoints[index],
      innerPoints[next],
      0.0065,
      rope,
      6,
    );
    if (index % 2 === 0) {
      const weight = addMesh(
        root,
        `RimWeight${index}`,
        new THREE.SphereGeometry(0.034, 6, 4),
        weights,
      );
      weight.position.set(...rimPoints[index]);
    }
  }
}

function buildHarpoon(root) {
  const shaft = material("harpoon-shaft", 0x744524, { roughness: 0.84 });
  const grip = material("harpoon-grip", 0xb89052, { roughness: 0.92 });
  const metal = material("harpoon-head", 0xb9c5ce, {
    metalness: 0.42,
    roughness: 0.38,
  });
  addCylinder(root, "Shaft", [0, 0, 0], [0, 1.56, 0], 0.032, shaft, 8);
  addCone(root, "Head", [0, 1.52, 0], [0, 1.84, 0], 0.092, metal, 6);
  for (let index = 0; index < 3; index += 1) {
    const angle = (index / 3) * Math.PI * 2;
    addCone(
      root,
      `Barb${index}`,
      [Math.cos(angle) * 0.018, 1.66, Math.sin(angle) * 0.018],
      [Math.cos(angle) * 0.145, 1.44, Math.sin(angle) * 0.145],
      0.052,
      metal,
      5,
    );
  }
  for (let index = 0; index < 4; index += 1) {
    addCylinder(
      root,
      `GripBand${index}`,
      [0, 0.19 + index * 0.055, 0],
      [0, 0.225 + index * 0.055, 0],
      0.043,
      grip,
      8,
    );
  }
  const ropeLoop = addMesh(
    root,
    "RetrievalLoop",
    new THREE.TorusGeometry(0.09, 0.012, 6, 16),
    grip,
  );
  ropeLoop.position.set(0, -0.04, 0);
  ropeLoop.rotation.x = Math.PI / 2;
}

function addCagePanelGrid(root, frame, rope) {
  const xMinimum = -0.425;
  const xMaximum = 0.425;
  const yTop = -0.13;
  const yBottom = -0.68;
  const zFront = 0.3;
  const zBack = -0.3;
  for (const z of [zFront, zBack]) {
    for (let index = 1; index < 6; index += 1) {
      const x = xMinimum + ((xMaximum - xMinimum) * index) / 6;
      addCylinder(
        root,
        `CageVertical${z > 0 ? "Front" : "Back"}${index}`,
        [x, yTop, z],
        [x, yBottom, z],
        0.008,
        rope,
        5,
      );
    }
    for (let index = 1; index < 4; index += 1) {
      const y = yTop + ((yBottom - yTop) * index) / 4;
      addCylinder(
        root,
        `CageHorizontal${z > 0 ? "Front" : "Back"}${index}`,
        [xMinimum, y, z],
        [xMaximum, y, z],
        0.008,
        rope,
        5,
      );
    }
  }
  for (const x of [xMinimum, xMaximum]) {
    for (let index = 1; index < 5; index += 1) {
      const z = zBack + ((zFront - zBack) * index) / 5;
      addCylinder(
        root,
        `CageSide${x > 0 ? "Right" : "Left"}${index}`,
        [x, yTop, z],
        [x, yBottom, z],
        0.008,
        rope,
        5,
      );
    }
  }
  for (const y of [yTop, yBottom]) {
    for (let index = 1; index < 6; index += 1) {
      const x = xMinimum + ((xMaximum - xMinimum) * index) / 6;
      addCylinder(
        root,
        `CageDeckX${y === yTop ? "Top" : "Bottom"}${index}`,
        [x, y, zBack],
        [x, y, zFront],
        0.008,
        rope,
        5,
      );
    }
  }
  const corners = [
    [xMinimum, yTop, zBack],
    [xMaximum, yTop, zBack],
    [xMinimum, yTop, zFront],
    [xMaximum, yTop, zFront],
    [xMinimum, yBottom, zBack],
    [xMaximum, yBottom, zBack],
    [xMinimum, yBottom, zFront],
    [xMaximum, yBottom, zFront],
  ];
  const edges = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  for (const [index, [start, end]] of edges.entries()) {
    addCylinder(
      root,
      `CageFrame${index}`,
      corners[start],
      corners[end],
      0.025,
      frame,
      7,
    );
  }
}

function buildLobsterPot(root) {
  const frame = material("pot-frame", 0x684128, { roughness: 0.86 });
  const rope = material("pot-netting", 0xc7aa69, { roughness: 0.94 });
  const buoy = material("pot-buoy", 0xe66b2f, { roughness: 0.68 });
  const metal = material("pot-fasteners", 0x66717b, {
    metalness: 0.3,
    roughness: 0.5,
  });
  addCagePanelGrid(root, frame, rope);
  addCylinder(
    root,
    "CarryHandleLeft",
    [0, 0, 0],
    [-0.3, -0.13, 0],
    0.022,
    rope,
    7,
  );
  addCylinder(
    root,
    "CarryHandleRight",
    [0, 0, 0],
    [0.3, -0.13, 0],
    0.022,
    rope,
    7,
  );

  const outerRadius = 0.2;
  const innerRadius = 0.075;
  const funnelY = -0.41;
  const segments = 10;
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    const nextAngle = ((index + 1) / segments) * Math.PI * 2;
    const outer = [
      Math.cos(angle) * outerRadius,
      funnelY + Math.sin(angle) * outerRadius,
      0.315,
    ];
    const outerNext = [
      Math.cos(nextAngle) * outerRadius,
      funnelY + Math.sin(nextAngle) * outerRadius,
      0.315,
    ];
    const inner = [
      Math.cos(angle) * innerRadius,
      funnelY + Math.sin(angle) * innerRadius,
      0.08,
    ];
    const innerNext = [
      Math.cos(nextAngle) * innerRadius,
      funnelY + Math.sin(nextAngle) * innerRadius,
      0.08,
    ];
    addCylinder(root, `FunnelSpoke${index}`, outer, inner, 0.009, rope, 5);
    addCylinder(root, `FunnelOuter${index}`, outer, outerNext, 0.009, rope, 5);
    addCylinder(root, `FunnelInner${index}`, inner, innerNext, 0.009, rope, 5);
  }
  const float = addMesh(
    root,
    "MarkerBuoy",
    new THREE.SphereGeometry(0.09, 8, 6),
    buoy,
  );
  float.position.set(0.31, -0.02, -0.18);
  addCylinder(
    root,
    "BuoyLine",
    [0.31, -0.08, -0.18],
    [0.33, -0.32, -0.29],
    0.01,
    rope,
    5,
  );
  for (const x of [-0.34, 0.34]) {
    addBox(
      root,
      `BaseWeight${x < 0 ? "Left" : "Right"}`,
      [0.12, 0.055, 0.12],
      [x, -0.7, 0],
      metal,
    );
  }
}

export function createFishingToolCandidateScene(itemId) {
  if (!EXPECTED_ITEM_IDS.includes(itemId)) {
    throw new Error(`Unsupported fishing-tool candidate: ${itemId}`);
  }
  const root = new THREE.Group();
  root.name = `${itemId}-technical-candidate`;
  if (itemId === "small_fishing_net") buildSmallFishingNet(root);
  else if (itemId === "harpoon") buildHarpoon(root);
  else buildLobsterPot(root);
  root.userData.hyperia = {
    schemaVersion: 1,
    itemId,
    source: "deterministic-repository-authored-geometry",
    externalGeometry: false,
    externalTextures: false,
    activationStatus: "not-activated",
    fishingWorld: {
      schemaVersion: 1,
      itemId,
      placement:
        itemId === "small_fishing_net"
          ? {
              positionOffset: [0, 0.02, 0.66],
              rotationEulerDegrees: [-90, 0, 0],
              scale: 1,
            }
          : itemId === "lobster_pot"
            ? {
                positionOffset: [0, 0, 0],
                rotationEulerDegrees: [0, 0, 0],
                scale: 1,
              }
            : null,
    },
  };
  return root;
}

export function inspectFishingToolCandidate(root) {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root, true);
  const size = bounds.getSize(new THREE.Vector3());
  let meshCount = 0;
  let materialCount = 0;
  let vertices = 0;
  let triangles = 0;
  const materialIds = new Set();
  root.traverse((object) => {
    if (!object.isMesh || !object.geometry) return;
    meshCount += 1;
    const position = object.geometry.attributes.position;
    if (!position || position.itemSize !== 3 || position.count < 3) {
      throw new Error(`${object.name} has invalid positions`);
    }
    vertices += position.count;
    triangles += object.geometry.index
      ? object.geometry.index.count / 3
      : position.count / 3;
    const surfaces = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const surface of surfaces) {
      if (!surface?.uuid) throw new Error(`${object.name} has no material`);
      materialIds.add(surface.uuid);
    }
  });
  materialCount = materialIds.size;
  if (
    meshCount < 1 ||
    materialCount < 1 ||
    vertices < 3 ||
    !Number.isInteger(triangles) ||
    triangles < 1 ||
    [size.x, size.y, size.z].some(
      (value) => !Number.isFinite(value) || value <= 0,
    )
  ) {
    throw new Error("Fishing-tool candidate geometry is invalid");
  }
  return {
    meshCount,
    materialCount,
    vertices,
    triangles,
    bounds: {
      minimum: bounds.min.toArray(),
      maximum: bounds.max.toArray(),
      size: size.toArray(),
    },
  };
}

export async function exportFishingToolCandidate(itemId) {
  const root = createFishingToolCandidateScene(itemId);
  const sourceInspection = inspectFishingToolCandidate(root);
  installFileReaderPolyfill();
  const exported = await new GLTFExporter().parseAsync(root, {
    binary: true,
    trs: true,
    onlyVisible: false,
  });
  const output = Buffer.from(exported);
  const validation = await validator.validateBytes(new Uint8Array(output), {
    uri: `${itemId}.glb`,
    format: "glb",
    writeTimestamp: false,
    maxIssues: 0,
  });
  const validatorSummary = {
    errors: validation.issues.numErrors,
    warnings: validation.issues.numWarnings,
    infos: validation.issues.numInfos,
    hints: validation.issues.numHints,
  };
  if (Object.values(validatorSummary).some((count) => count !== 0)) {
    throw new Error(
      `${itemId} produced validator findings: ${JSON.stringify(validatorSummary)}; ${validation.issues.messages
        .map(
          (issue) =>
            `${issue.code}${issue.pointer ? ` ${issue.pointer}` : ""}: ${issue.message}`,
        )
        .join("; ")}`,
    );
  }
  return { output, sourceInspection, validator: validatorSummary };
}

export function validateFishingToolCandidateManifest(manifest, workspaceRoot) {
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.exportedAt !== "string" ||
    !isRecord(manifest.avatar) ||
    manifest.avatar.id !== "kaykit-knight" ||
    manifest.avatar.legacyAttachmentId !== "kaykit-knight" ||
    !SHA256.test(manifest.avatar.sha256 ?? "") ||
    !Number.isFinite(manifest.avatar.normalizedHeight) ||
    manifest.avatar.normalizedHeight <= 0 ||
    !isRecord(manifest.runtimeItemManifest) ||
    !SHA256.test(manifest.runtimeItemManifest.sha256 ?? "") ||
    !isRecord(manifest.authorship) ||
    manifest.authorship.method !==
      "deterministic-repository-authored-geometry" ||
    manifest.authorship.externalGeometry !== false ||
    manifest.authorship.externalTextures !== false ||
    manifest.authorship.activationStatus !== "not-activated" ||
    !Array.isArray(manifest.candidates) ||
    manifest.candidates.length !== EXPECTED_ITEM_IDS.length
  ) {
    throw new Error("Fishing-tool candidate manifest is invalid");
  }
  for (const field of [
    "sourceOutputDirectory",
    "fitOutputDirectory",
    "reportPath",
  ]) {
    safeWorkspacePath(workspaceRoot, manifest[field], field);
  }
  for (const source of [manifest.avatar, manifest.runtimeItemManifest]) {
    const sourcePath = safeWorkspacePath(
      workspaceRoot,
      source.path,
      "source.path",
    );
    if (sha256(readFileSync(sourcePath)) !== source.sha256) {
      throw new Error(`${source.path} hash drifted`);
    }
  }
  const seen = new Set();
  for (const [index, candidate] of manifest.candidates.entries()) {
    if (
      !isRecord(candidate) ||
      candidate.itemId !== EXPECTED_ITEM_IDS[index] ||
      !SAFE_ID.test(candidate.itemId) ||
      typeof candidate.displayName !== "string" ||
      !candidate.displayName ||
      !["one-hand", "two-hand"].includes(candidate.grip) ||
      candidate.attachmentBone !== "rightHand" ||
      typeof candidate.weaponType !== "string" ||
      !candidate.weaponType ||
      !Number.isFinite(candidate.targetLengthMetres) ||
      candidate.targetLengthMetres <= 0 ||
      !isRecord(candidate.referenceMotion) ||
      !SHA256.test(candidate.referenceMotion.sha256 ?? "") ||
      !Number.isFinite(candidate.referenceMotion.sampleRatio) ||
      candidate.referenceMotion.sampleRatio < 0 ||
      candidate.referenceMotion.sampleRatio > 1 ||
      (candidate.grip === "two-hand") !==
        isRecord(candidate.alignHandleToSecondaryHand)
    ) {
      throw new Error(`Fishing-tool candidate ${index} is invalid`);
    }
    assertFiniteTuple(
      candidate.desiredWorldEulerDegrees,
      3,
      `${candidate.itemId}.desiredWorldEulerDegrees`,
    );
    assertFiniteTuple(
      candidate.desiredWorldOffsetMetres,
      3,
      `${candidate.itemId}.desiredWorldOffsetMetres`,
    );
    if (candidate.alignHandleToSecondaryHand) {
      assertFiniteTuple(
        candidate.alignHandleToSecondaryHand.sourceHandleAxis,
        3,
        `${candidate.itemId}.sourceHandleAxis`,
      );
    }
    if (seen.has(candidate.itemId)) {
      throw new Error(`Duplicate fishing-tool candidate: ${candidate.itemId}`);
    }
    seen.add(candidate.itemId);
    const motionPath = safeWorkspacePath(
      workspaceRoot,
      candidate.referenceMotion.path,
      `${candidate.itemId}.referenceMotion.path`,
    );
    if (sha256(readFileSync(motionPath)) !== candidate.referenceMotion.sha256) {
      throw new Error(`${candidate.itemId} reference motion hash drifted`);
    }
  }
  return manifest.candidates;
}

export async function buildFishingToolCandidates({
  workspaceRoot,
  manifest,
  check,
}) {
  const candidates = validateFishingToolCandidateManifest(
    manifest,
    workspaceRoot,
  );
  const sourceDirectory = safeWorkspacePath(
    workspaceRoot,
    manifest.sourceOutputDirectory,
    "sourceOutputDirectory",
  );
  const fitDirectory = safeWorkspacePath(
    workspaceRoot,
    manifest.fitOutputDirectory,
    "fitOutputDirectory",
  );
  const sourceOutputs = [];
  for (const candidate of candidates) {
    const built = await exportFishingToolCandidate(candidate.itemId);
    const outputPath = path.join(sourceDirectory, `${candidate.itemId}.glb`);
    if (check) {
      if (
        !existsSync(outputPath) ||
        !readFileSync(outputPath).equals(built.output)
      ) {
        throw new Error(`${candidate.itemId} source candidate is stale`);
      }
    } else {
      writeAtomic(outputPath, built.output);
    }
    sourceOutputs.push({
      itemId: candidate.itemId,
      outputPath: path
        .relative(workspaceRoot, outputPath)
        .split(path.sep)
        .join("/"),
      outputBytes: built.output.length,
      outputSha256: sha256(built.output),
      sourceInspection: built.sourceInspection,
      validator: built.validator,
    });
  }

  const sourceByItemId = new Map(
    sourceOutputs.map((output) => [output.itemId, output]),
  );
  const fitManifest = {
    schemaVersion: 1,
    exportedAt: manifest.exportedAt,
    avatar: manifest.avatar,
    fits: candidates.map((candidate) => {
      const source = sourceByItemId.get(candidate.itemId);
      const fit = {
        itemId: candidate.itemId,
        slot: "gatheringtool",
        grip: candidate.grip,
        weaponType: candidate.weaponType,
        attachmentBone: candidate.attachmentBone,
        sourcePath: source.outputPath,
        sourceSha256: source.outputSha256,
        outputPath: path.posix.join(
          path.relative(workspaceRoot, fitDirectory).split(path.sep).join("/"),
          `${candidate.itemId}-fitted.glb`,
        ),
        targetLengthMetres: candidate.targetLengthMetres,
        desiredWorldEulerDegrees: candidate.desiredWorldEulerDegrees,
        desiredWorldOffsetMetres: candidate.desiredWorldOffsetMetres,
        referenceMotion: candidate.referenceMotion,
      };
      if (candidate.alignHandleToSecondaryHand) {
        fit.alignHandleToSecondaryHand = candidate.alignHandleToSecondaryHand;
      }
      return fit;
    }),
  };
  const fitReport = await buildRigidDuelEquipment({
    workspaceRoot,
    assetsRoot: workspaceRoot,
    manifest: fitManifest,
    check,
  });
  const fitByItemId = new Map(
    fitReport.outputs.map((output) => [output.itemId, output]),
  );
  const scriptPath = fileURLToPath(import.meta.url);
  const outputs = sourceOutputs.map((source) => {
    const fit = fitByItemId.get(source.itemId);
    if (!fit) throw new Error(`Missing fitted output for ${source.itemId}`);
    return {
      itemId: source.itemId,
      activationStatus: "not-activated",
      activeRuntimePath: false,
      sourcePath: source.outputPath,
      sourceBytes: source.outputBytes,
      sourceSha256: source.outputSha256,
      sourceInspection: source.sourceInspection,
      outputPath: fit.outputPath,
      outputBytes: fit.outputBytes,
      outputSha256: fit.outputSha256,
      grip: fitManifest.fits.find((entry) => entry.itemId === source.itemId)
        .grip,
      attachmentBone: fit.attachmentBone,
      targetLengthMetres: fit.targetLengthMetres,
      referenceMotionDurationSeconds: fit.referenceMotionDurationSeconds,
      referenceMotionSampleSeconds: fit.referenceMotionSampleSeconds,
      referenceHandSeparationMetres: fit.referenceHandSeparationMetres,
      fittedWorldPositionErrorMetres: fit.fittedWorldPositionErrorMetres,
      fittedWorldRotationErrorDegrees: fit.fittedWorldRotationErrorDegrees,
      validator: fit.validator,
    };
  });
  return {
    schemaVersion: 1,
    generator: {
      path: path.relative(workspaceRoot, scriptPath).split(path.sep).join("/"),
      sha256: sha256(readFileSync(scriptPath)),
    },
    authorship: manifest.authorship,
    avatar: manifest.avatar,
    activeRuntimePathsChanged: false,
    summary: {
      candidateCount: outputs.length,
      approvedForRuntimeActivation: false,
      sourceValidatorFindingCount: sourceOutputs.reduce(
        (sum, output) =>
          sum +
          Object.values(output.validator).reduce(
            (total, count) => total + count,
            0,
          ),
        0,
      ),
      fittedValidatorFindingCount: outputs.reduce(
        (sum, output) =>
          sum +
          Object.values(output.validator).reduce(
            (total, count) => total + count,
            0,
          ),
        0,
      ),
    },
    browserVerification: fitReport.browserVerification,
    outputs,
  };
}

function parseArguments(argv) {
  const options = { check: false, write: false };
  for (const argument of argv) {
    if (argument === "--check") options.check = true;
    else if (argument === "--write") options.write = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.check === options.write) {
    throw new Error("Specify exactly one of --write or --check");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const manifestPath = path.join(
    workspaceRoot,
    "scripts/hyperia-fishing-tool-candidates.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const report = await buildFishingToolCandidates({
    workspaceRoot,
    manifest,
    check: options.check,
  });
  const reportPath = safeWorkspacePath(
    workspaceRoot,
    manifest.reportPath,
    "reportPath",
  );
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.check) {
    if (
      !existsSync(reportPath) ||
      readFileSync(reportPath, "utf8") !== serialized
    ) {
      throw new Error("Fishing-tool candidate report is stale");
    }
  } else {
    writeAtomic(reportPath, serialized);
  }
  process.stdout.write(
    `${options.check ? "Verified" : "Built"} ${report.outputs.length} isolated fishing-tool candidates\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
