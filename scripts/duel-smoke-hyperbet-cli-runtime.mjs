import path from "node:path";

import {
  bindPinnedBunToEnvironment,
  resolvePinnedBunRuntime,
} from "./duel-bun-runtime-policy.mjs";

/** Bind a Hyperbet script to its workspace pin, never the smoke's game runtime. */
export function buildDuelSmokeHyperbetCliInvocation({
  workspaceRoot,
  args,
  environment = process.env,
}) {
  if (
    typeof workspaceRoot !== "string" ||
    workspaceRoot.includes("\0") ||
    !path.isAbsolute(workspaceRoot)
  ) {
    throw new TypeError("Hyperbet CLI workspace must be an absolute path");
  }
  if (
    !Array.isArray(args) ||
    args.length === 0 ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    !path.isAbsolute(args[0])
  ) {
    throw new TypeError(
      "Hyperbet CLI arguments must start with an absolute script path",
    );
  }
  const relativeScriptPath = path.relative(workspaceRoot, args[0]);
  if (
    relativeScriptPath === "" ||
    relativeScriptPath === ".." ||
    relativeScriptPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeScriptPath)
  ) {
    throw new TypeError("Hyperbet CLI script must be inside its workspace");
  }
  const configuredPath = environment?.DUEL_HYPERBET_BUN_PATH;
  if (
    typeof configuredPath !== "string" ||
    !configuredPath.trim() ||
    configuredPath.includes("\0") ||
    configuredPath.trim() === "bun"
  ) {
    throw new TypeError(
      "Hyperbet CLI requires an explicit DUEL_HYPERBET_BUN_PATH",
    );
  }
  const runtime = resolvePinnedBunRuntime({
    label: "Hyperbet",
    workspaceRoot,
    configuredPath,
    processPath: "",
    pathCommand: "",
  });
  return {
    command: runtime.path,
    args: ["--config=/dev/null", "--no-install", ...args],
    env: bindPinnedBunToEnvironment(environment, runtime.path),
  };
}
