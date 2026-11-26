import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertHyperiaNodeVersion } from "./node-runtime-policy.mjs";

/** Only the explicit local movement project owns this server entry point. */
export async function preflightNativeMovementServer() {
  assertHyperiaNodeVersion(process.version);
  if (
    process.platform !== "darwin" ||
    process.env.PW_NATIVE_MOVEMENT !== "true"
  )
    throw new Error(
      "Native movement server requires its explicit macOS project",
    );
  if (
    process.cwd() !==
    fileURLToPath(new URL("../packages/server/", import.meta.url)).replace(
      /\/$/,
      "",
    )
  )
    throw new Error("Native movement server requires the packages/server cwd");
  const container = process.env.POSTGRES_CONTAINER;
  if (
    !/^hyperia-native-movement-[a-z0-9][a-z0-9-]{0,63}$/.test(container ?? "")
  )
    throw new Error(
      "A unique POSTGRES_CONTAINER for native movement is required",
    );
  for (const port of [3333, 5555, 5556, 57832])
    await new Promise((resolve, reject) => {
      const probe = createServer();
      const timer = setTimeout(() => {
        probe.close(() => {});
        reject(new Error("Native movement port preflight timed out: " + port));
      }, 5000);
      probe.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      probe.listen({ port, exclusive: true }, () =>
        probe.close((error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        }),
      );
    });
  const existing = execFileSync(
    "docker",
    [
      "container",
      "ls",
      "--all",
      "--filter",
      "name=^/" + container + "$",
      "--format",
      "{{.ID}}",
    ],
    { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  if (existing)
    throw new Error("Refusing to reuse an existing native movement database");
  console.log(
    JSON.stringify({
      event: "native-movement-server-owner",
      pid: process.pid,
      container,
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await preflightNativeMovementServer();
  // A real file entry keeps --input-type out of inherited Worker execArgv.
  // --preflight-only remains the actual verified bootstrap's no-gameplay mode.
  await import("./start-hyperia-server.mjs");
}
