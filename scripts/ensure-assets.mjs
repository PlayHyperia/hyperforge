#!/usr/bin/env node
/**
 * Ensure Assets Script
 *
 * Clones the PlayHyperia/assets repo into packages/server/world/assets/
 * so the server has access to manifests, models, audio, and textures.
 *
 * Behavior:
 * - CI/Production: Shallow clone without LFS (manifests only, ~fast)
 * - Development: Full clone with LFS pull (~200MB binary assets)
 *
 * The assets directory is gitignored — this script is the sole mechanism
 * for populating it.
 */

import { existsSync, readdirSync, rmSync, mkdirSync } from "fs";
import { execFileSync, execSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const assetsDir = path.join(rootDir, "packages/server/world/assets");
const assetsRepo = "https://github.com/PlayHyperia/assets.git";
const requestedRevision = process.env.HYPERIA_ASSETS_REV?.trim();

if (requestedRevision && !/^[0-9a-f]{40}$/i.test(requestedRevision)) {
  console.error(
    "❌ HYPERIA_ASSETS_REV must be a full 40-character Git commit SHA",
  );
  process.exit(1);
}

// Local CDN URL for development
const LOCAL_CDN_URL = "http://localhost:8080";

function dirHasNonHiddenFiles(dir) {
  if (!existsSync(dir)) return false;
  try {
    const files = readdirSync(dir);
    return files.some((f) => !f.startsWith("."));
  } catch {
    return false;
  }
}

function hasManifests(dir) {
  return dirHasNonHiddenFiles(path.join(dir, "manifests"));
}

function hasFullAssets(dir) {
  // Local development needs the full binary assets (world/, models/, audio/, etc).
  // Manifests-only is treated as "missing" so we auto-download real assets.
  const hasWorld = dirHasNonHiddenFiles(path.join(dir, "world"));
  const hasModels = dirHasNonHiddenFiles(path.join(dir, "models"));
  return hasWorld && hasModels;
}

function isGitRepo(dir) {
  return existsSync(path.join(dir, ".git"));
}

function checkGitLfs() {
  try {
    execSync("git lfs version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function printLfsInstallInstructions() {
  console.error(`
⚠️  Git LFS is required for game assets (local development only)

Install it for your platform:
  macOS:   brew install git-lfs
  Ubuntu:  sudo apt install git-lfs
  Windows: Download from https://git-lfs.com

Then re-run:
  bun install

Note: In CI/production, manifests are committed to the repo.
`);
}

function isCI() {
  // Check for common CI/deployment environment variables
  return !!(
    process.env.CI ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_SERVICE_ID ||
    process.env.VERCEL ||
    process.env.NETLIFY ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.CIRCLECI ||
    process.env.DOCKER_BUILD ||
    process.env.SKIP_ASSETS
  );
}

async function main() {
  console.log("📦 Checking game assets...");

  const requireFullAssets = process.env.HYPERIA_REQUIRE_FULL_ASSETS === "true";
  const ci = isCI() && !requireFullAssets;

  // In CI: only need manifests (no binary assets), but still must clone
  if (ci && hasManifests(assetsDir) && !requestedRevision) {
    console.log("✅ Assets manifests already present (CI)");
    return;
  }

  // In dev: check for full assets (models, world data, etc.)
  if (!ci && hasFullAssets(assetsDir)) {
    console.log("✅ Assets already present (full asset pack found)");
    // Ensure LFS objects are present if this is a git repo (safe no-op if up-to-date)
    if (isGitRepo(assetsDir)) {
      try {
        execSync(`git -C "${assetsDir}" lfs pull`, { stdio: "ignore" });
      } catch {
        // Non-fatal: some environments may not have LFS filters configured
      }
    }
    return;
  }

  // Dev environments need git-lfs for binary assets
  if (!ci) {
    if (!checkGitLfs()) {
      printLfsInstallInstructions();
      process.exit(1);
    }

    // Initialize git-lfs (safe to run multiple times, ignore errors if already set up)
    try {
      execSync("git lfs install", { stdio: "ignore" });
    } catch {
      // May fail if already initialized - that's ok
    }
  }

  const label = ci ? "manifests" : "full asset pack (~200MB)";
  console.log(`📥 Downloading game assets (${label})...`);
  console.log(`   From: ${assetsRepo}`);
  console.log(`   To: ${assetsDir}`);

  try {
    // Ensure parent directory exists
    const parentDir = path.dirname(assetsDir);
    mkdirSync(parentDir, { recursive: true });

    // If we have a partial/manifest-only directory, remove it so clone succeeds.
    if (existsSync(assetsDir) && !isGitRepo(assetsDir)) {
      console.log("🧹 Removing partial assets directory...");
      rmSync(assetsDir, { recursive: true, force: true });
    }

    if (!existsSync(assetsDir) || !isGitRepo(assetsDir)) {
      const gitEnvironment = ci
        ? { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" }
        : process.env;

      if (requestedRevision) {
        // A production image must resolve an immutable commit, never a moving
        // branch head. Argument-array execution also prevents shell injection.
        mkdirSync(assetsDir, { recursive: true });
        execFileSync("git", ["init", assetsDir], {
          stdio: "inherit",
          cwd: rootDir,
          env: gitEnvironment,
        });
        execFileSync(
          "git",
          ["-C", assetsDir, "remote", "add", "origin", assetsRepo],
          {
            stdio: "inherit",
            cwd: rootDir,
            env: gitEnvironment,
          },
        );
        execFileSync(
          "git",
          [
            "-C",
            assetsDir,
            "fetch",
            "--depth",
            "1",
            "origin",
            requestedRevision,
          ],
          {
            stdio: "inherit",
            cwd: rootDir,
            env: gitEnvironment,
          },
        );
        execFileSync(
          "git",
          ["-C", assetsDir, "checkout", "--detach", "FETCH_HEAD"],
          {
            stdio: "inherit",
            cwd: rootDir,
            env: gitEnvironment,
          },
        );
      } else {
        // Clone with depth 1 for faster download.
        // CI skips binary LFS objects because only manifests are required.
        execFileSync("git", ["clone", "--depth", "1", assetsRepo, assetsDir], {
          stdio: "inherit",
          cwd: rootDir,
          env: gitEnvironment,
        });
      }
    }

    // Dev: pull LFS binary assets (models, audio, textures)
    if (!ci) {
      execSync(`git -C "${assetsDir}" lfs pull`, { stdio: "inherit" });
    }

    console.log("✅ Assets downloaded successfully!");
    if (!ci) {
      console.log("   Run 'bun run assets:sync' to update assets later");
    }
  } catch (error) {
    console.error("❌ Failed to download assets:", error);
    console.error("   You can manually clone:");
    console.error(`   git clone ${assetsRepo} ${assetsDir}`);
    process.exit(1);
  }
}

main();
