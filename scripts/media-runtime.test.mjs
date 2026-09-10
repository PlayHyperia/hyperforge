import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  mediaSpawnErrorCode,
  resolveMediaExecutable,
} from "../packages/server/src/streaming/media-runtime.mjs";
import { resolvePinnedBunRuntime } from "./duel-bun-runtime-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const encoder = resolveMediaExecutable({ tool: "ffmpeg" });
const probe = resolveMediaExecutable({ tool: "ffprobe" });
const gameBun = resolvePinnedBunRuntime({
  label: "Hyperia media integration tests",
  workspaceRoot: root,
  configuredPath: process.env.DUEL_HYPERIA_BUN_PATH,
});

function withDirectory(run) {
  const directory = mkdtempSync(path.join(tmpdir(), "hyperia-media-runtime-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("missing media executable fails instead of returning an unverified command", () => {
  assert.throws(
    () =>
      resolveMediaExecutable({
        tool: "ffmpeg",
        environment: { PATH: "" },
        systemDirectories: [],
        allowBundled: false,
      }),
    /FFMPEG_PATH: no working ffmpeg executable found.*no candidates/u,
  );
});

test("spawn diagnostics retain only the error code, never command arguments or credentials", () => {
  const result = spawnSync("/nonexistent/hyperia/ffmpeg", [
    "rtmp://example.invalid/live/test-only-stream-key",
  ]);
  assert.ok(result.error);
  assert.equal(mediaSpawnErrorCode(result.error), "ENOENT");
  assert.equal(
    mediaSpawnErrorCode({ code: "EIO", spawnargs: ["private"] }),
    "EIO",
  );
  assert.equal(
    mediaSpawnErrorCode({ code: "rtmp://example.invalid/private" }),
    "unknown",
  );
  assert.equal(mediaSpawnErrorCode(null), "unknown");
});

test("an invalid explicit override cannot fall back to the installed encoder", () => {
  assert.throws(
    () =>
      resolveMediaExecutable({
        tool: "ffmpeg",
        environment: {
          ...process.env,
          FFMPEG_PATH: "/nonexistent/hyperia/ffmpeg",
        },
      }),
    /explicit override was rejected; fallback is disabled/u,
  );
});

test("a probe or directory cannot impersonate a working encoder", () => {
  for (const invalidPath of [probe.path, path.dirname(encoder.path)]) {
    assert.throws(
      () =>
        resolveMediaExecutable({
          tool: "ffmpeg",
          environment: { ...process.env, FFMPEG_PATH: invalidPath },
        }),
      /explicit override was rejected/u,
    );
  }
});

test("a non-executable file fails without attempting a shell fallback", () => {
  withDirectory((directory) => {
    const candidate = path.join(directory, "ffmpeg");
    writeFileSync(candidate, "not an executable\n", { mode: 0o600 });
    assert.throws(
      () =>
        resolveMediaExecutable({
          tool: "ffmpeg",
          environment: { ...process.env, FFMPEG_PATH: candidate },
        }),
      /EACCES/u,
    );
  });
});

test("PATH and relative overrides resolve symlinks to the verified absolute executable", () => {
  withDirectory((directory) => {
    symlinkSync(encoder.path, path.join(directory, "ffmpeg"));
    const throughPath = resolveMediaExecutable({
      tool: "ffmpeg",
      environment: { PATH: directory },
      systemDirectories: [],
      allowBundled: false,
    });
    assert.equal(throughPath.path, realpathSync(encoder.path));
    assert.equal(throughPath.source, "PATH");
    const relative = resolveMediaExecutable({
      tool: "ffmpeg",
      cwd: directory,
      environment: { PATH: "", FFMPEG_PATH: "./ffmpeg" },
    });
    assert.equal(relative.path, throughPath.path);
    assert.equal(relative.source, "FFMPEG_PATH");
  });
});

test("system discovery works when the pinned PATH omits the encoder directory", () => {
  const resolved = resolveMediaExecutable({
    tool: "ffmpeg",
    environment: { PATH: "" },
    systemDirectories: [path.dirname(encoder.path)],
    allowBundled: false,
  });
  assert.equal(resolved.path, encoder.path);
  assert.equal(resolved.source, "system");
  if (process.platform === "darwin") {
    assert.equal(
      resolveMediaExecutable({
        tool: "ffmpeg",
        environment: { PATH: "" },
        allowBundled: false,
      }).source,
      "system",
    );
  }
});

test("verified paths encode and probe real H.264/AAC media without PATH lookup", () => {
  withDirectory((directory) => {
    const output = path.join(directory, "media.mp4");
    execFileSync(
      encoder.path,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x180:r=30",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-n",
        output,
      ],
      { env: { ...process.env, PATH: "" }, timeout: 15_000, stdio: "pipe" },
    );
    const result = JSON.parse(
      execFileSync(
        probe.path,
        ["-v", "error", "-show_streams", "-of", "json", output],
        { encoding: "utf8", env: { ...process.env, PATH: "" }, timeout: 5_000 },
      ),
    );
    assert.equal(result.streams[0].codec_name, "h264");
    assert.equal(result.streams[1].codec_name, "aac");
    assert.equal(result.streams[1].sample_rate, "48000");
    assert.equal(result.streams[1].channels, 2);
  });
});

test("the actual smoke launcher rejects a broken encoder before install or service startup", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/smoke-duel-launch.mjs", "--skip-install", "--skip-build"],
    {
      cwd: root,
      env: {
        ...process.env,
        DUEL_HYPERIA_BUN_PATH: gameBun.path,
        FFMPEG_PATH: "/nonexistent/hyperia/ffmpeg",
      },
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /FFMPEG_PATH: no working ffmpeg executable found/u);
  assert.doesNotMatch(
    output,
    /production SOL duel build|frozen dependency|starting.*(?:validator|server|renderer)/iu,
  );
});

test("the actual capture worker exits cleanly before creating a browser when encoder validation fails", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "packages/server/scripts/stream-to-rtmp.ts"],
    {
      cwd: root,
      env: {
        ...process.env,
        FFMPEG_PATH: "/nonexistent/hyperia/ffmpeg",
        STREAM_CAPTURE_MODE: "cdp",
        STREAM_LEAK_DIAGNOSTICS: "false",
      },
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /FFMPEG_PATH: no working ffmpeg executable found/u);
  assert.match(output, /Cleanup complete/u);
  assert.doesNotMatch(
    output,
    /UnhandledPromiseRejection|\[Browser\]|Starting spectator/u,
  );
});
