import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import path from "node:path";

const EXACT_BUN_PACKAGE_MANAGER = /^bun@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u;

export function parsePinnedBunVersion(packageManager, label) {
  const match = EXACT_BUN_PACKAGE_MANAGER.exec(String(packageManager ?? ""));
  if (!match) {
    throw new Error(
      `${label} package.json must declare one exact packageManager bun version`,
    );
  }
  return match[1];
}

export function readPinnedBunVersion(workspaceRoot, label) {
  const manifestPath = path.join(workspaceRoot, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `${label} package.json is unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parsePinnedBunVersion(manifest.packageManager, label);
}

export function bindPinnedBunToEnvironment(environment, runtimePath) {
  const boundEnvironment = { ...environment };
  if (!path.isAbsolute(runtimePath)) return boundEnvironment;

  const runtimeDirectory = path.dirname(runtimePath);
  const inheritedPath = String(boundEnvironment.PATH ?? process.env.PATH ?? "");
  const pathEntries = inheritedPath
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  boundEnvironment.PATH = [
    runtimeDirectory,
    ...pathEntries.filter((entry) => entry !== runtimeDirectory),
  ].join(path.delimiter);
  return boundEnvironment;
}

function normalizeCandidate(candidate, workspaceRoot) {
  const value = String(candidate ?? "").trim();
  if (!value) return null;
  if (value === "bun" || path.isAbsolute(value)) return value;
  return path.resolve(workspaceRoot, value);
}

function resolveExecutableCandidate(candidate) {
  if (path.isAbsolute(candidate)) return candidate;

  // Match subprocess PATH lookup before any caller changes PATH. Empty and
  // relative entries refer to the subprocess cwd, not the package workspace.
  const directories = (process.env.PATH ?? "/usr/bin:/bin").split(
    path.delimiter,
  );
  const names =
    process.platform === "win32"
      ? [candidate, `${candidate}.com`, `${candidate}.exe`]
      : [candidate];
  for (const directory of directories) {
    for (const name of names) {
      const executable = path.resolve(directory, name);
      try {
        if (!statSync(executable).isFile()) continue;
        accessSync(executable, constants.X_OK);
        return executable;
      } catch {
        // A missing or non-executable earlier entry does not shadow PATH.
      }
    }
  }
  throw new Error(`executable ${candidate} is unavailable in PATH`);
}

function defaultProbe(candidate) {
  return String(
    execFileSync(candidate, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    }),
  ).trim();
}

export function resolvePinnedBunRuntime({
  label,
  workspaceRoot,
  configuredPath,
  processPath = process.execPath,
  pathCommand = "bun",
}) {
  const expectedVersion = readPinnedBunVersion(workspaceRoot, label);
  const candidates = [];
  for (const candidate of [configuredPath, processPath, pathCommand]) {
    const normalized = normalizeCandidate(candidate, workspaceRoot);
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  }

  const observations = [];
  for (const candidate of candidates) {
    try {
      const executable = resolveExecutableCandidate(candidate);
      const version = defaultProbe(executable);
      observations.push({ candidate, version: version || "no version" });
      if (version === expectedVersion) {
        return { path: executable, version, expectedVersion };
      }
    } catch (error) {
      observations.push({
        candidate,
        version: `unavailable (${error instanceof Error ? error.message : String(error)})`,
      });
    }
  }

  const observed = observations
    .map(({ candidate, version }) => `${candidate}=${version}`)
    .join(", ");
  throw new Error(
    `${label} requires Bun ${expectedVersion}, but no exact runtime was found${observed ? ` (${observed})` : ""}. Configure its explicit Bun path before launch.`,
  );
}
