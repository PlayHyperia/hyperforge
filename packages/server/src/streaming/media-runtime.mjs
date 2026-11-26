import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/** @param {unknown} error */
export function mediaSpawnErrorCode(error) {
  const code =
    error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)
    ? code
    : "unknown";
}

/**
 * Resolve and probe an absolute executable before starting capture services.
 * An explicit override is authoritative: an invalid override never falls back.
 * System builds remain preferred over the optional bundled FFmpeg build.
 *
 * @param {{
 *   tool: "ffmpeg" | "ffprobe",
 *   environment?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   systemDirectories?: string[],
 *   allowBundled?: boolean,
 * }} input
 * @returns {{ path: string, version: string, source: string }}
 */
export function resolveMediaExecutable({
  tool,
  environment = process.env,
  cwd = process.cwd(),
  systemDirectories = process.platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
    : ["/usr/local/bin", "/usr/bin"],
  allowBundled = true,
}) {
  if (tool !== "ffmpeg" && tool !== "ffprobe") {
    throw new Error("Unsupported stream media executable");
  }
  const variable = tool === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
  const configured = environment[variable]?.trim();
  const pathDirectories = (environment.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.resolve(cwd, directory));
  /** @type {{ path: string, source: string }[]} */
  const candidates = [];
  if (configured) {
    if (configured.includes("\0")) {
      throw new Error(`${variable} contains an invalid null byte`);
    }
    if (path.isAbsolute(configured) || /[/\\]/u.test(configured)) {
      candidates.push({
        path: path.resolve(cwd, configured),
        source: variable,
      });
    } else {
      candidates.push(
        ...pathDirectories.map((directory) => ({
          path: path.join(directory, configured),
          source: variable,
        })),
      );
    }
  } else {
    candidates.push(
      ...pathDirectories.map((directory) => ({
        path: path.join(directory, tool),
        source: "PATH",
      })),
      ...systemDirectories.map((directory) => ({
        path: path.resolve(cwd, directory, tool),
        source: "system",
      })),
    );
    if (allowBundled && tool === "ffmpeg") {
      try {
        const bundled = require("ffmpeg-static");
        if (typeof bundled === "string" && path.isAbsolute(bundled)) {
          candidates.push({ path: bundled, source: "ffmpeg-static" });
        }
      } catch {
        // Optional dependency; missing executables are rejected below.
      }
    }
  }

  const visited = new Set();
  const failures = [];
  for (const candidate of candidates) {
    if (visited.has(candidate.path)) continue;
    visited.add(candidate.path);
    try {
      const executable = realpathSync(candidate.path);
      if (!statSync(executable).isFile()) {
        throw new Error("not a regular executable file");
      }
      accessSync(executable, constants.X_OK);
      const output = execFileSync(executable, ["-version"], {
        cwd,
        env: environment,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 128 * 1024,
      });
      const version = output.split(/\r?\n/u)[0].trim();
      if (!version.startsWith(`${tool} version `)) {
        throw new Error(`unexpected ${tool} version response`);
      }
      return { path: executable, version, source: candidate.source };
    } catch (error) {
      // Do not relay child stderr/environment into launch diagnostics.
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "probe failed";
      failures.push(`${candidate.path} (${code})`);
    }
  }

  throw new Error(
    `${variable}: no working ${tool} executable found. ` +
      `Install ${tool} or set ${variable} to its executable path. ` +
      `${configured ? "The explicit override was rejected; fallback is disabled. " : ""}` +
      `Checked: ${failures.join(", ") || "no candidates"}`,
  );
}
