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

function runValidator(assetsRoot) {
  return spawnSync(process.execPath, [VALIDATOR_PATH], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, ASSETS_DIR: assetsRoot },
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
    const manifest = JSON.parse(
      readFileSync(path.join(assetsRoot, "manifests/world-areas.json"), "utf8"),
    );
    const area = manifest.specialAreas.duel_arena;
    const grade = area.flatZones.find(
      (zone) => zone.id === "duel_arena_campus_grade",
    );
    assert.equal(grade.width, 104);
    assert.equal(grade.depth, 140.5);
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

test("accepts independent rectangular extents and circular water tangent to every boundary", () => {
  const assetsRoot = createAssetsFixture();
  try {
    mutateJson(assetsRoot, "world-areas.json", (manifest) => {
      const area = manifest.specialAreas.duel_arena;
      const grade = area.flatZones.find(
        (zone) => zone.id === "duel_arena_campus_grade",
      );
      // The active grade is Z-long; this second rectangle is X-long.
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
