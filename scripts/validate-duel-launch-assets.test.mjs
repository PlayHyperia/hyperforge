import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SOURCE_ASSETS_ROOT = path.join(
  WORKSPACE_ROOT,
  "packages/server/world/assets",
);
const VALIDATOR_PATH = path.join(
  WORKSPACE_ROOT,
  "scripts/validate-duel-launch-assets.mjs",
);
const TERRAIN_SHADER_PATH = path.join(
  WORKSPACE_ROOT,
  "packages/shared/src/systems/shared/world/TerrainShader.ts",
);
const PLAYER_EMOTES_PATH = path.join(
  WORKSPACE_ROOT,
  "packages/shared/src/data/playerEmotes.ts",
);

function createAssetsFixture() {
  const assetsRoot = mkdtempSync(
    path.join(tmpdir(), "hyperia-duel-launch-assets-"),
  );
  for (const entry of readdirSync(SOURCE_ASSETS_ROOT, {
    withFileTypes: true,
  })) {
    const source = path.join(SOURCE_ASSETS_ROOT, entry.name);
    const destination = path.join(assetsRoot, entry.name);
    if (entry.name === "manifests") {
      cpSync(source, destination, { recursive: true });
    } else {
      symlinkSync(source, destination);
    }
  }
  return assetsRoot;
}

function mutateJson(assetsRoot, relativePath, mutate) {
  const filePath = path.join(assetsRoot, "manifests", relativePath);
  const document = JSON.parse(readFileSync(filePath, "utf8"));
  mutate(document);
  writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`);
}

function detachAssetDirectory(assetsRoot, directoryName) {
  const sourceDirectory = path.join(SOURCE_ASSETS_ROOT, directoryName);
  const fixtureDirectory = path.join(assetsRoot, directoryName);
  rmSync(fixtureDirectory);
  mkdirSync(fixtureDirectory);
  for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
    symlinkSync(
      path.join(sourceDirectory, entry.name),
      path.join(fixtureDirectory, entry.name),
      entry.isDirectory() ? "dir" : "file",
    );
  }
  return fixtureDirectory;
}

function runValidator(assetsRoot, environment = {}) {
  return spawnSync(process.execPath, [VALIDATOR_PATH], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, ASSETS_DIR: assetsRoot, ...environment },
    encoding: "utf8",
    // One byte-read probe may legitimately consume the validator's 15-second
    // bounded timeout. The outer harness must leave room for that child to
    // exit and report its explicit failure instead of killing the parent and
    // orphaning the in-flight reader.
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
}

test("accepts the exact active preparation manifest and rectangular campus grade", () => {
  const assetsRoot = createAssetsFixture();
  try {
    const worldConfig = JSON.parse(
      readFileSync(
        path.join(assetsRoot, "manifests/world-config.json"),
        "utf8",
      ),
    );
    assert.equal(worldConfig.version, 2);
    assert.equal(worldConfig.compactResourceGroves.schemaVersion, 2);
    assert.equal(
      worldConfig.compactResourceGroves.layoutId,
      "compact-functional-groves-v2",
    );
    const manifest = JSON.parse(
      readFileSync(path.join(assetsRoot, "manifests/world-areas.json"), "utf8"),
    );
    const area = manifest.specialAreas.duel_arena;
    assert.equal(
      manifest.level1Areas.haven_pond.flatZones.find(
        (zone) => zone.id === "haven_pond_floor",
      ).radialPond.shorelineAmplitude,
      0.9,
    );
    const grade = area.flatZones.find(
      (zone) => zone.id === "duel_arena_campus_grade",
    );
    assert.equal(grade.width, 104);
    assert.equal(grade.depth, 84.5);
    assert.deepEqual(
      {
        minX: grade.centerX - grade.width / 2,
        maxX: grade.centerX + grade.width / 2,
        minZ: grade.centerZ - grade.depth / 2,
        maxZ: grade.centerZ + grade.depth / 2,
      },
      area.bounds,
    );
    const result = runValidator(assetsRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Duel launch asset validation passed/u);
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("accepts supported legacy version 1 without a grove layout", () => {
  const assetsRoot = createAssetsFixture();
  try {
    mutateJson(assetsRoot, "world-config.json", (config) => {
      config.version = 1;
      delete config.compactResourceGroves;
    });
    const result = runValidator(assetsRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Duel launch asset validation passed/u);
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

for (const version of [0, 3, "2"]) {
  test(`rejects unsupported world configuration version ${JSON.stringify(version)}`, () => {
    const assetsRoot = createAssetsFixture();
    try {
      mutateJson(assetsRoot, "world-config.json", (config) => {
        config.version = version;
      });
      const result = runValidator(assetsRoot);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /requires supported version 1 or 2/u);
    } finally {
      rmSync(assetsRoot, { recursive: true, force: true });
    }
  });
}

for (const [label, mutate, expected] of [
  [
    "missing grove",
    (config) => {
      delete config.compactResourceGroves;
    },
    /version 2 requires its explicit grove layout/u,
  ],
  [
    "null grove",
    (config) => {
      config.compactResourceGroves = null;
    },
    /Invalid compactResourceGroves: layout/u,
  ],
  [
    "wrong layout identity",
    (config) => {
      config.compactResourceGroves.layoutId = "other";
    },
    /Invalid compactResourceGroves: layout identity/u,
  ],
  [
    "non-coordinate tree ID",
    (config) => {
      config.compactResourceGroves.regions[0].anchors[0].id = "tree_wrong";
    },
    /Invalid compactResourceGroves: duplicate or non-coordinate ID/u,
  ],
  [
    "unsupported tree species",
    (config) => {
      config.compactResourceGroves.regions[0].anchors[0].subType = "magic";
    },
    /Invalid compactResourceGroves: species/u,
  ],
  [
    "conflicting profile",
    (config) => {
      config.terrainProfile.seed++;
    },
    /World configuration conflicts with its terrain profile/u,
  ],
  [
    "grove under legacy version",
    (config) => {
      config.version = 1;
    },
    /Invalid compactResourceGroves: version\/profile/u,
  ],
]) {
  test(`production DataManager rejects ${label} in an actual validator process`, () => {
    const assetsRoot = createAssetsFixture();
    try {
      mutateJson(assetsRoot, "world-config.json", mutate);
      const result = runValidator(assetsRoot);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /world-config.json production validation failed/u,
      );
      assert.match(result.stderr, expected);
    } finally {
      rmSync(assetsRoot, { recursive: true, force: true });
    }
  });
}

// A running pinned Bun is itself a valid policy candidate. This negative applies
// to the supported Node CLI, which genuinely needs to find a pinned Bun child.
if (!process.versions.bun) {
  test("Node CLI fails closed when no pinned Bun runtime can validate the world", () => {
    const assetsRoot = createAssetsFixture();
    try {
      const result = runValidator(assetsRoot, {
        DUEL_HYPERIA_BUN_PATH: path.join(assetsRoot, "missing-bun"),
        PATH: "",
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /requires Bun .*no exact runtime was found/u);
    } finally {
      rmSync(assetsRoot, { recursive: true, force: true });
    }
  });
}

for (const amplitude of [-0.1, 1.001, "0.9"]) {
  test(`rejects invalid pond shoreline amplitude ${JSON.stringify(amplitude)}`, () => {
    const assetsRoot = createAssetsFixture();
    try {
      mutateJson(assetsRoot, "world-areas.json", (manifest) => {
        manifest.level1Areas.haven_pond.flatZones.find(
          (zone) => zone.id === "haven_pond_floor",
        ).radialPond.shorelineAmplitude = amplitude;
      });
      const result = runValidator(assetsRoot);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /finite radial bed, visible shoreline/u);
    } finally {
      rmSync(assetsRoot, { recursive: true, force: true });
    }
  });
}

test("accepts independent rectangular extents and circular water tangent to every boundary", () => {
  const assetsRoot = createAssetsFixture();
  try {
    mutateJson(assetsRoot, "world-areas.json", (manifest) => {
      const area = manifest.specialAreas.duel_arena;
      const grade = area.flatZones.find(
        (zone) => zone.id === "duel_arena_campus_grade",
      );
      // Exercise a second, narrow rectangular zone.
      area.flatZones.push({
        ...grade,
        id: "wide_rectangle_regression",
        depth: 2,
      });
      const radius = 2;
      area.waterBodies ??= [];
      for (const [side, centerX, centerZ] of [
        ["min_x", area.bounds.minX + radius, grade.centerZ],
        ["max_x", area.bounds.maxX - radius, grade.centerZ],
        ["min_z", grade.centerX, area.bounds.minZ + radius],
        ["max_z", grade.centerX, area.bounds.maxZ - radius],
      ]) {
        area.waterBodies.push({
          id: `tangent_water_${side}`,
          centerX,
          centerZ,
          radius,
          surfaceY: grade.height,
        });
      }
    });
    const result = runValidator(assetsRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Duel launch asset validation passed/u);
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("rejects each rectangular boundary overrun and nonpositive dimensions", () => {
  const assetsRoot = createAssetsFixture();
  try {
    mutateJson(assetsRoot, "world-areas.json", (manifest) => {
      const area = manifest.specialAreas.duel_arena;
      const grade = area.flatZones.find(
        (zone) => zone.id === "duel_arena_campus_grade",
      );
      for (const [side, dx, dz] of [
        ["min_x", -0.000001, 0],
        ["max_x", 0.000001, 0],
        ["min_z", 0, -0.000001],
        ["max_z", 0, 0.000001],
      ]) {
        area.flatZones.push({
          ...grade,
          id: `outside_rectangle_${side}`,
          centerX: grade.centerX + dx,
          centerZ: grade.centerZ + dz,
        });
      }
      area.flatZones.push(
        { ...grade, id: "zero_width_regression", width: 0 },
        { ...grade, id: "negative_depth_regression", depth: -1 },
      );
    });
    const result = runValidator(assetsRoot);
    assert.equal(result.status, 1);
    for (const side of ["min_x", "max_x", "min_z", "max_z"]) {
      assert.match(
        result.stderr,
        new RegExp(
          `flat zone outside_rectangle_${side} .* falls outside duel_arena bounds`,
          "u",
        ),
      );
    }
    assert.match(result.stderr, /invalid flat zone zero_width_regression/u);
    assert.match(result.stderr, /invalid flat zone negative_depth_regression/u);
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("keeps circular water radius containment on both axes and every boundary", () => {
  const assetsRoot = createAssetsFixture();
  try {
    mutateJson(assetsRoot, "world-areas.json", (manifest) => {
      const area = manifest.specialAreas.duel_arena;
      const grade = area.flatZones.find(
        (zone) => zone.id === "duel_arena_campus_grade",
      );
      const radius = 2;
      const overrun = 0.000001;
      area.waterBodies ??= [];
      for (const [side, centerX, centerZ] of [
        ["min_x", area.bounds.minX + radius - overrun, grade.centerZ],
        ["max_x", area.bounds.maxX - radius + overrun, grade.centerZ],
        ["min_z", grade.centerX, area.bounds.minZ + radius - overrun],
        ["max_z", grade.centerX, area.bounds.maxZ - radius + overrun],
      ]) {
        area.waterBodies.push({
          id: `outside_water_${side}`,
          centerX,
          centerZ,
          radius,
          surfaceY: grade.height,
        });
      }
    });
    const result = runValidator(assetsRoot);
    assert.equal(result.status, 1);
    for (const side of ["min_x", "max_x", "min_z", "max_z"]) {
      assert.match(
        result.stderr,
        new RegExp(
          `water body outside_water_${side} .* with radius 2 falls outside duel_arena bounds`,
          "u",
        ),
      );
    }
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("rejects a music manifest path whose audio file is missing", () => {
  const assetsRoot = createAssetsFixture();
  try {
    mutateJson(assetsRoot, "music.json", (music) => {
      music[0].path = "asset://audio/music/intro/missing.mp3";
    });
    const result = runValidator(assetsRoot);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /music\.json\[0\]\.path references a missing asset/u,
    );
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("preflights every terrain-biome texture loaded by the runtime shader", () => {
  const validatorSource = readFileSync(VALIDATOR_PATH, "utf8");
  const terrainShaderSource = readFileSync(TERRAIN_SHADER_PATH, "utf8");
  const runtimeTextureFiles = new Set(
    [...terrainShaderSource.matchAll(/file: "([^"/]+\.png)"/gu)].map(
      (match) => match[1],
    ),
  );

  assert.deepEqual([...runtimeTextureFiles].sort(), [
    "cliff.png",
    "desertDirt.png",
    "desertGrass.png",
    "dirt.png",
    "grass.png",
    "snowdirt.png",
    "snowgrass.png",
  ]);
  for (const file of runtimeTextureFiles) {
    assert.match(
      validatorSource,
      new RegExp(
        `asset://textures/terrain-biomes/${file.replace(".", "\\.")}`,
        "u",
      ),
    );
  }
});

function detachCompactTerrainKit(assetsRoot) {
  // Each operation removes only a fixture symlink, never the source directory.
  detachAssetDirectory(assetsRoot, "terrain");
  detachAssetDirectory(assetsRoot, "terrain/textures");
  return detachAssetDirectory(assetsRoot, "terrain/textures/compact-pbr");
}

for (const mode of ["missing", "stale"]) {
  test(`rejects every ${mode} compact pond model`, () => {
    const assetsRoot = createAssetsFixture();
    const contract = JSON.parse(
      readFileSync(
        path.join(
          WORKSPACE_ROOT,
          "packages/shared/src/data/compact-pond-models.json",
        ),
        "utf8",
      ),
    );
    assert.equal(Object.keys(contract).length, 5);
    try {
      detachAssetDirectory(assetsRoot, "vegetation");
      const kit = detachAssetDirectory(
        assetsRoot,
        "vegetation/compact-pond-v1",
      );
      for (const file of Object.keys(contract)) {
        const destination = path.join(kit, file);
        rmSync(destination); // Remove the isolated fixture link, never its target.
        if (mode === "stale") writeFileSync(destination, Buffer.from("stale"));
      }
      const result = runValidator(assetsRoot);
      assert.equal(result.status, 1, result.stderr);
      for (const [file, hash] of Object.entries(contract)) {
        assert(
          result.stderr.includes(
            `compact pond ${file} ` +
              (mode === "missing"
                ? "references a missing asset"
                : `drifted from SHA-256 ${hash}`),
          ),
          result.stderr,
        );
      }
    } finally {
      rmSync(assetsRoot, { recursive: true, force: true });
    }
  });
}

function installDiagnosticReedFixture(assetsRoot) {
  detachAssetDirectory(assetsRoot, "vegetation");
  const kit = detachAssetDirectory(assetsRoot, "vegetation/compact-pond-v1");
  const reedPath = path.join(kit, "pond_reed_clump.glb");
  const source = readFileSync(reedPath);
  assert.equal(source.readUInt32LE(0), 0x46546c67);
  assert.equal(source.readUInt32LE(4), 2);
  const jsonLength = source.readUInt32LE(12);
  const document = JSON.parse(source.subarray(20, 20 + jsonLength));
  // Actual exported GLB geometry/material/attributes stay intact. Only its
  // optional JSON metadata differs, supplying real different bytes for the gate.
  document.extras = {
    ...document.extras,
    diagnosticReedIntegrityFixture: true,
  };
  const json = Buffer.from(JSON.stringify(document));
  const paddedJson = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(paddedJson);
  const otherChunks = source.subarray(20 + jsonLength);
  const header = Buffer.from(source.subarray(0, 20));
  header.writeUInt32LE(20 + paddedJson.length + otherChunks.length, 8);
  header.writeUInt32LE(paddedJson.length, 12);
  const candidate = Buffer.concat([header, paddedJson, otherChunks]);
  rmSync(reedPath); // Isolated fixture symlink only; original remains unchanged.
  writeFileSync(reedPath, candidate, { flag: "wx" });
  return {
    kit,
    reedPath,
    source,
    sha256: createHash("sha256").update(candidate).digest("hex"),
  };
}

function diagnosticReedEnvironment(sha256) {
  return {
    DUEL_DIAGNOSTIC_POND_REED_SHA256: sha256,
    NODE_ENV: "production",
    DUEL_LOCAL_SMOKE_MODE: "true",
    LOAD_TEST_MODE: "true",
    STREAMING_DUEL_DIAGNOSTIC_ASSET_TESTS: "true",
    STREAMING_DUEL_MAINTENANCE_MODE: "true",
    STREAMING_DUEL_SCHEDULER_ROLE: "authority",
    DUEL_BETTING_ENABLED: "false",
    DUEL_WITH_HYPERBET: "false",
    PUBLIC_API_URL: "http://127.0.0.1:5555",
    PUBLIC_WS_URL: "ws://127.0.0.1:5556/ws",
    DUEL_LOCAL_BROWSER_ORIGIN: "http://localhost:3333",
    PUBLIC_CDN_URL: "http://127.0.0.1:5555/game-assets",
  };
}

test("diagnostic reed audition requires the exact approved bytes without changing canonical locks", () => {
  const assetsRoot = createAssetsFixture();
  const contractPath = path.join(
    WORKSPACE_ROOT,
    "packages/shared/src/data/compact-pond-models.json",
  );
  const originalContract = readFileSync(contractPath);
  try {
    const fixture = installDiagnosticReedFixture(assetsRoot);
    const originalReedPath = path.join(
      SOURCE_ASSETS_ROOT,
      "vegetation/compact-pond-v1/pond_reed_clump.glb",
    );
    const unselected = runValidator(assetsRoot, {
      DUEL_DIAGNOSTIC_POND_REED_SHA256: undefined,
    });
    assert.equal(unselected.status, 1, unselected.stderr);
    assert.match(
      unselected.stderr,
      /compact pond pond_reed_clump\.glb drifted/u,
    );
    const selected = runValidator(
      assetsRoot,
      diagnosticReedEnvironment(fixture.sha256),
    );
    assert.equal(selected.status, 0, selected.stderr);
    const receipt = selected.stdout
      .split("\n")
      .filter(Boolean)
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .find((row) => row.event === "duel-diagnostic-pond-reed-validated");
    assert.equal(receipt?.file, "pond_reed_clump.glb");
    assert.equal(receipt?.candidateSha256, fixture.sha256);
    assert.equal(
      receipt?.canonicalSha256,
      createHash("sha256").update(fixture.source).digest("hex"),
    );
    const wrong = runValidator(
      assetsRoot,
      diagnosticReedEnvironment("0".repeat(64)),
    );
    assert.equal(wrong.status, 1, wrong.stderr);
    assert.match(wrong.stderr, /compact pond pond_reed_clump\.glb drifted/u);
    assert.doesNotMatch(wrong.stdout, /duel-diagnostic-pond-reed-validated/u);
    assert.deepEqual(readFileSync(contractPath), originalContract);
    assert.deepEqual(readFileSync(originalReedPath), fixture.source);
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("diagnostic reed audition cannot bypass another kit hash or a canonical symlink", () => {
  const assetsRoot = createAssetsFixture();
  try {
    const fixture = installDiagnosticReedFixture(assetsRoot);
    const fernPath = path.join(fixture.kit, "pond_fern.glb");
    rmSync(fernPath); // Isolated fixture symlink, never the source asset.
    writeFileSync(fernPath, Buffer.from("unapproved fern"), { flag: "wx" });
    const otherAsset = runValidator(
      assetsRoot,
      diagnosticReedEnvironment(fixture.sha256),
    );
    assert.equal(otherAsset.status, 1, otherAsset.stderr);
    assert.match(otherAsset.stderr, /compact pond pond_fern\.glb drifted/u);
    assert.doesNotMatch(
      otherAsset.stdout,
      /duel-diagnostic-pond-reed-validated/u,
    );
    rmSync(fixture.reedPath); // Exact detached fixture file.
    symlinkSync(
      path.join(
        SOURCE_ASSETS_ROOT,
        "vegetation/compact-pond-v1/pond_reed_clump.glb",
      ),
      fixture.reedPath,
    );
    const symlinked = runValidator(
      assetsRoot,
      diagnosticReedEnvironment(fixture.sha256),
    );
    assert.equal(symlinked.status, 1, symlinked.stderr);
    assert.match(
      symlinked.stderr,
      /audition rejected: the audition reed must be detached/u,
    );
    assert.doesNotMatch(
      symlinked.stdout,
      /Duel launch asset validation passed|duel-diagnostic-pond-reed-validated/u,
    );
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

function installDiagnosticBoulderFixture(assetsRoot) {
  detachAssetDirectory(assetsRoot, "vegetation");
  const kit = detachAssetDirectory(assetsRoot, "vegetation/compact-pond-v1");
  const boulderPath = path.join(kit, "pond_boulder.glb");
  const source = readFileSync(boulderPath);
  assert.equal(source.readUInt32LE(0), 0x46546c67);
  assert.equal(source.readUInt32LE(4), 2);
  const jsonLength = source.readUInt32LE(12);
  const document = JSON.parse(source.subarray(20, 20 + jsonLength));
  const pbr = document.materials[0].pbrMetallicRoughness;
  assert.ok(pbr.metallicRoughnessTexture);
  assert.equal(pbr.metallicFactor, 0);
  // Real asset-local correction: geometry, embedded images, and all other GLB
  // chunks remain byte-identical. Admission still checks the whole new file.
  delete pbr.metallicRoughnessTexture;
  pbr.roughnessFactor = 1;
  const json = Buffer.from(JSON.stringify(document));
  const paddedJson = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(paddedJson);
  const otherChunks = source.subarray(20 + jsonLength);
  const header = Buffer.from(source.subarray(0, 20));
  header.writeUInt32LE(20 + paddedJson.length + otherChunks.length, 8);
  header.writeUInt32LE(paddedJson.length, 12);
  const candidate = Buffer.concat([header, paddedJson, otherChunks]);
  rmSync(boulderPath); // Exact isolated fixture link, never the source asset.
  writeFileSync(boulderPath, candidate, { flag: "wx" });
  assert.deepEqual(candidate.subarray(20 + paddedJson.length), otherChunks);
  return {
    kit,
    boulderPath,
    source,
    sha256: createHash("sha256").update(candidate).digest("hex"),
  };
}

function diagnosticBoulderEnvironment(sha256) {
  return {
    ...diagnosticReedEnvironment(undefined),
    DUEL_DIAGNOSTIC_POND_BOULDER_SHA256: sha256,
  };
}

test("diagnostic boulder audition validates exact corrected GLB bytes and preserves canonical locks", () => {
  const assetsRoot = createAssetsFixture();
  const contractPath = path.join(
    WORKSPACE_ROOT,
    "packages/shared/src/data/compact-pond-models.json",
  );
  const originalContract = readFileSync(contractPath);
  try {
    const fixture = installDiagnosticBoulderFixture(assetsRoot);
    const originalBoulderPath = path.join(
      SOURCE_ASSETS_ROOT,
      "vegetation/compact-pond-v1/pond_boulder.glb",
    );
    const unselected = runValidator(assetsRoot, {
      DUEL_DIAGNOSTIC_POND_REED_SHA256: undefined,
      DUEL_DIAGNOSTIC_POND_BOULDER_SHA256: undefined,
    });
    assert.equal(unselected.status, 1, unselected.stderr);
    assert.match(unselected.stderr, /compact pond pond_boulder\.glb drifted/u);
    const selected = runValidator(
      assetsRoot,
      diagnosticBoulderEnvironment(fixture.sha256),
    );
    assert.equal(selected.status, 0, selected.stderr);
    const receipt = selected.stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      .find((row) => row.event === "duel-diagnostic-pond-boulder-validated");
    assert.equal(receipt?.file, "pond_boulder.glb");
    assert.equal(receipt?.candidateSha256, fixture.sha256);
    assert.equal(
      receipt?.canonicalSha256,
      createHash("sha256").update(fixture.source).digest("hex"),
    );
    assert.match(receipt?.scope, /^local-no-money-maintenance-only;/u);
    assert.doesNotMatch(
      selected.stdout,
      /duel-diagnostic-pond-reed-validated/u,
    );
    const wrong = runValidator(
      assetsRoot,
      diagnosticBoulderEnvironment("0".repeat(64)),
    );
    assert.equal(wrong.status, 1, wrong.stderr);
    assert.match(wrong.stderr, /compact pond pond_boulder\.glb drifted/u);
    assert.doesNotMatch(
      wrong.stdout,
      /duel-diagnostic-pond-boulder-validated/u,
    );
    assert.deepEqual(readFileSync(contractPath), originalContract);
    assert.deepEqual(readFileSync(originalBoulderPath), fixture.source);
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("diagnostic boulder validator rejects unsafe policy and malformed selection before admission", () => {
  const assetsRoot = createAssetsFixture();
  try {
    const fixture = installDiagnosticBoulderFixture(assetsRoot);
    for (const override of [
      { NODE_ENV: "development" },
      { DUEL_BETTING_ENABLED: "true" },
      { STREAMING_DUEL_MAINTENANCE_MODE: "false" },
      { PUBLIC_CDN_URL: "https://assets.example.test/game-assets" },
      { DUEL_DIAGNOSTIC_POND_BOULDER_SHA256: "" },
    ]) {
      const rejected = runValidator(assetsRoot, {
        ...diagnosticBoulderEnvironment(fixture.sha256),
        ...override,
      });
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.match(
        rejected.stderr,
        /Diagnostic pond boulder audition rejected:/u,
      );
      assert.doesNotMatch(
        rejected.stdout,
        /Duel launch asset validation passed|duel-diagnostic-pond-boulder-validated/u,
      );
    }
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("diagnostic boulder audition cannot bypass sibling hashes or canonical realpath aliases", () => {
  const assetsRoot = createAssetsFixture();
  try {
    const fixture = installDiagnosticBoulderFixture(assetsRoot);
    const fernPath = path.join(fixture.kit, "pond_fern.glb");
    rmSync(fernPath); // Exact fixture symlink only.
    writeFileSync(fernPath, Buffer.from("unapproved fern"), { flag: "wx" });
    const sibling = runValidator(
      assetsRoot,
      diagnosticBoulderEnvironment(fixture.sha256),
    );
    assert.equal(sibling.status, 1, sibling.stderr);
    assert.match(sibling.stderr, /compact pond pond_fern\.glb drifted/u);
    assert.doesNotMatch(
      sibling.stdout,
      /duel-diagnostic-pond-boulder-validated/u,
    );
    rmSync(fixture.boulderPath); // Exact detached fixture file.
    symlinkSync(
      path.join(
        SOURCE_ASSETS_ROOT,
        "vegetation/compact-pond-v1/pond_boulder.glb",
      ),
      fixture.boulderPath,
    );
    const symlinked = runValidator(
      assetsRoot,
      diagnosticBoulderEnvironment(fixture.sha256),
    );
    assert.equal(symlinked.status, 1, symlinked.stderr);
    assert.match(
      symlinked.stderr,
      /audition rejected: the audition boulder must be detached/u,
    );
    const canonical = runValidator(
      SOURCE_ASSETS_ROOT,
      diagnosticBoulderEnvironment(fixture.sha256),
    );
    assert.equal(canonical.status, 1, canonical.stderr);
    assert.match(canonical.stderr, /ASSETS_DIR must be isolated/u);
    for (const rejected of [symlinked, canonical])
      assert.doesNotMatch(
        rejected.stdout,
        /Duel launch asset validation passed|duel-diagnostic-pond-boulder-validated/u,
      );
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("rejects every missing packed compact terrain map", () => {
  const assetsRoot = createAssetsFixture();
  const contract = JSON.parse(
    readFileSync(
      path.join(
        WORKSPACE_ROOT,
        "packages/shared/src/data/compact-terrain-textures.json",
      ),
      "utf8",
    ),
  );
  assert.equal(Object.keys(contract).length, 6);
  try {
    const kit = detachCompactTerrainKit(assetsRoot);
    for (const key of Object.keys(contract))
      rmSync(path.join(kit, `${key}.png`));
    const result = runValidator(assetsRoot);
    assert.equal(result.status, 1, result.stderr);
    for (const key of Object.keys(contract)) {
      assert(
        result.stderr.includes(
          `compact terrain ${key} references a missing asset`,
        ),
        result.stderr,
      );
    }
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("rejects stale bytes in every packed compact terrain map", () => {
  const assetsRoot = createAssetsFixture();
  const contract = JSON.parse(
    readFileSync(
      path.join(
        WORKSPACE_ROOT,
        "packages/shared/src/data/compact-terrain-textures.json",
      ),
      "utf8",
    ),
  );
  try {
    const kit = detachCompactTerrainKit(assetsRoot);
    for (const key of Object.keys(contract)) {
      const file = path.join(kit, `${key}.png`);
      const stale = Buffer.from(readFileSync(file));
      stale[stale.length - 1] ^= 1;
      rmSync(file);
      writeFileSync(file, stale);
    }
    const result = runValidator(assetsRoot);
    assert.equal(result.status, 1, result.stderr);
    for (const [key, digest] of Object.entries(contract)) {
      assert(
        result.stderr.includes(
          `compact terrain ${key} drifted from SHA-256 ${digest}`,
        ),
        result.stderr,
      );
    }
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("preflights every emote unconditionally loaded by ClientNetwork", () => {
  const validatorSource = readFileSync(VALIDATOR_PATH, "utf8");
  const playerEmotesSource = readFileSync(PLAYER_EMOTES_PATH, "utf8");
  const essentialAssetBlock = validatorSource.match(
    /const essentialDuelAssetUrls = \[([\s\S]*?)\n\];/u,
  )?.[1];
  assert.ok(essentialAssetBlock, "essential duel asset list must be readable");

  const emoteUrlsBlock = playerEmotesSource.match(
    /export const emoteUrls = \[([\s\S]*?)\n\];/u,
  )?.[1];
  assert.ok(emoteUrlsBlock, "runtime emote preload list must be readable");
  const runtimeKeys = [
    ...emoteUrlsBlock.matchAll(/Emotes\.([A-Z0-9_]+)/gu),
  ].map((match) => match[1]);
  const emoteUrlsByKey = new Map(
    [...playerEmotesSource.matchAll(/\n\s{2}([A-Z0-9_]+):\s*"([^"]+)"/gu)].map(
      (match) => [match[1], match[2].split("?")[0]],
    ),
  );

  assert.equal(runtimeKeys.length, 34);
  assert.equal(new Set(runtimeKeys).size, runtimeKeys.length);
  for (const key of runtimeKeys) {
    const assetUrl = emoteUrlsByKey.get(key);
    assert.ok(assetUrl, `runtime emote ${key} must resolve to an asset URL`);
    assert.match(essentialAssetBlock, new RegExp(assetUrl, "u"));
  }
});

test("rejects a missing fishing authority instead of accepting a new count", () => {
  const assetsRoot = createAssetsFixture();
  try {
    mutateJson(assetsRoot, "duel-presentation-assets.json", (manifest) => {
      manifest.activations = manifest.activations.filter(
        (activation) =>
          activation.activationId !== "steve-small-fishing-net-v1",
      );
    });
    const result = runValidator(assetsRoot);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /must contain exactly the 17 certified Steve preparation authorities/u,
    );
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("rejects an undefined gathering reward in the launch preparation loop", () => {
  const assetsRoot = createAssetsFixture();
  try {
    mutateJson(assetsRoot, "world-areas.json", (manifest) => {
      manifest.level1Areas.preparation_training_grounds.resources.push({
        type: "ore",
        position: { x: -2, y: 0, z: 27 },
        resourceId: "ore_gold",
      });
    });
    const result = runValidator(assetsRoot);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /preparation_training_grounds resource ore_gold yields undefined item gold_ore/u,
    );
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("rejects deployment timing drift in an active fishing authority", () => {
  const assetsRoot = createAssetsFixture();
  try {
    mutateJson(assetsRoot, "duel-presentation-assets.json", (manifest) => {
      const activation = manifest.activations.find(
        (candidate) => candidate.activationId === "steve-lobster-pot-v1",
      );
      activation.motion.presentationTiming.releaseSeconds = 0.5;
    });
    const result = runValidator(assetsRoot);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /steve-lobster-pot-v1 does not match its certified runtime authority/u,
    );
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("rejects an item manifest that bypasses its certified Steve fit", () => {
  const assetsRoot = createAssetsFixture();
  try {
    mutateJson(assetsRoot, "items/tools.json", (items) => {
      const item = items.find(
        (candidate) => candidate.id === "fly_fishing_rod",
      );
      item.gatheringModelPathsByAvatar.steve =
        "asset://models/fishing-rods/bait-fishing-rod/bait-fishing-rod.glb";
    });
    const result = runValidator(assetsRoot);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /fly_fishing_rod must select its active exact Steve gathering fit/u,
    );
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("rejects a stale canonical bow-duel motion", () => {
  const assetsRoot = createAssetsFixture();
  try {
    const emotesPath = detachAssetDirectory(assetsRoot, "emotes");
    const staleMotionPath = path.join(
      emotesPath,
      "emote-bow-duel-walk-steve.glb",
    );
    rmSync(staleMotionPath);
    writeFileSync(staleMotionPath, Buffer.from("stale"));
    const result = runValidator(assetsRoot);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /steve-bow-duel-natural-v1\.walk drifted from SHA-256/u,
    );
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});

test("rejects an empty essential duel asset without a hash lock", () => {
  const assetsRoot = createAssetsFixture();
  try {
    const emotesPath = detachAssetDirectory(assetsRoot, "emotes");
    const emptyMotionPath = path.join(emotesPath, "emote-idle.glb");
    rmSync(emptyMotionPath);
    writeFileSync(emptyMotionPath, Buffer.alloc(0));

    const result = runValidator(assetsRoot);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /essential duel asset asset:\/\/emotes\/emote-idle\.glb asset is empty/u,
    );
  } finally {
    rmSync(assetsRoot, { recursive: true, force: true });
  }
});
