/** Real filesystem/loadConfig/Fastify HTTP tests; no world or renderer emulation. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const startupDir = fileURLToPath(new URL("../", import.meta.url));
const dependencyRoot = fileURLToPath(
  new URL("../../../node_modules", import.meta.url),
);
const requiredRoots = [
  "npcs.json",
  "world-areas.json",
  "biomes.json",
  "stores.json",
  "world-config.json",
  "duel-arenas.json",
] as const;
const requiredCategories = ["weapons", "tools", "resources", "food", "misc"];
const temporaryRoots: string[] = [];
const cdnServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    cdnServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function manifestSet(root: string, items: "legacy" | "categories") {
  const directory = path.join(root, "manifests");
  await mkdir(directory, { recursive: true });
  for (const filename of requiredRoots) {
    await writeFile(
      path.join(directory, filename),
      JSON.stringify({ source: root, filename }),
    );
  }
  if (items === "legacy") {
    await writeFile(path.join(directory, "items.json"), "[]");
  } else {
    await mkdir(path.join(directory, "items"));
    for (const category of requiredCategories) {
      await writeFile(path.join(directory, "items", `${category}.json`), "[]");
    }
  }
  return directory;
}

async function fixture(items: "legacy" | "categories" = "categories") {
  // Bun canonicalizes the cwd/module location on macOS (/var -> /private/var).
  // Canonicalize only this fixture root, not the supplied ASSETS_DIR aliases.
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "hyperia-config-owner-")),
  );
  temporaryRoots.push(root);
  const workspace = path.join(root, "project");
  const serverRoot = path.join(workspace, "packages", "server");
  const copiedStartup = path.join(serverRoot, "src", "startup");
  const cwd = path.join(workspace, "runtime", "deep", "session");
  const candidate = path.join(root, "candidate-assets");
  const world = path.join(root, "runtime-world");
  await Promise.all([
    mkdir(copiedStartup, { recursive: true }),
    mkdir(path.join(serverRoot, "src", "shared"), { recursive: true }),
    mkdir(path.join(serverRoot, "public", "assets"), { recursive: true }),
    mkdir(cwd, { recursive: true }),
  ]);
  // Relocate the exact production module so its normal import.meta path logic,
  // default cache and all three dotenv probes remain inside this temporary tree.
  await copyFile(
    path.join(startupDir, "config.ts"),
    path.join(copiedStartup, "config.ts"),
  );
  await copyFile(
    path.join(startupDir, "../shared/errMsg.ts"),
    path.join(serverRoot, "src", "shared", "errMsg.ts"),
  );
  await symlink(dependencyRoot, path.join(workspace, "node_modules"), "dir");
  await writeFile(
    path.join(serverRoot, "public", "index.html"),
    "<title>fixture</title>",
  );
  const defaults = await manifestSet(
    path.join(serverRoot, "world", "assets"),
    "legacy",
  );
  await writeFile(path.join(defaults, "default-only.json"), '{"default":true}');
  const manifests = await manifestSet(candidate, items);
  const requests: string[] = [];
  const cdn = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"source":"local-test-cdn"}');
  });
  cdnServers.push(cdn);
  await new Promise<void>((resolve) => cdn.listen(0, "127.0.0.1", resolve));
  const address = cdn.address();
  if (!address || typeof address === "string")
    throw Error("Local CDN address required");
  return {
    root,
    workspace,
    serverRoot,
    copiedStartup,
    cwd,
    candidate,
    world,
    defaults,
    manifests,
    requests,
    cdnUrl: `http://127.0.0.1:${address.port}`,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type ProbeResult = {
  ok: boolean;
  error?: string;
  paths?: {
    manifestsDir: string;
    assetsDir: string;
    worldDir: string;
    iconsDir: string;
  };
  responses?: Array<{ url: string; status: number; body: string }>;
  listening?: boolean;
  closed?: boolean;
};

async function probe(
  input: Fixture,
  explicit: string | undefined,
  options: {
    http?: boolean;
    forceFetch?: boolean;
    skipFetch?: boolean;
    nodeEnv?: string;
  } = {},
) {
  const configUrl = pathToFileURL(
    path.join(input.copiedStartup, "config.ts"),
  ).href;
  const httpUrl = pathToFileURL(path.join(startupDir, "http-server.ts")).href;
  const script = `
    import {loadConfig} from ${JSON.stringify(configUrl)};
    let server, result;
    try {
      const config = await loadConfig();
      result = {ok:true,paths:{manifestsDir:config.manifestsDir,assetsDir:config.assetsDir,worldDir:config.worldDir,iconsDir:config.iconsDir}};
      if (${options.http === true}) {
        const {createHttpServer} = await import(${JSON.stringify(httpUrl)});
        server = await createHttpServer(config);
        await server.listen({port:0,host:'127.0.0.1'});
        result.listening = server.server.listening;
        const base = 'http://127.0.0.1:' + server.server.address().port;
        result.responses = [];
        for (const url of ['/manifests/world-config.json','/game-assets/manifests/world-config.json','/manifests/items/weapons.json','/game-assets/manifests/items/weapons.json','/manifests/default-only.json','/game-assets/manifests/default-only.json']) {
          const response = await fetch(base + url);
          result.responses.push({url,status:response.status,body:await response.text()});
        }
      }
    } catch (error) {
      result = {ok:false,error:error.message}; process.exitCode = 23;
    } finally {
      if (server) { await server.close(); result.closed = !server.server.listening; }
    }
    console.log('MANIFEST_OWNER_RESULT:' + JSON.stringify(result));
  `;
  // Deliberately do not inherit application secrets or .env settings. The cwd's
  // ancestors probed by dotenv are all beneath input.root, not the real repo.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: options.nodeEnv ?? "test",
    WORLD: input.world,
    PUBLIC_CDN_URL: input.cdnUrl,
    USE_LOCAL_POSTGRES: "false",
    FORCE_FETCH_CDN: String(options.forceFetch ?? true),
    SKIP_CDN_MANIFEST_FETCH: String(options.skipFetch ?? false),
    SKIP_MANIFESTS: "true",
    HLS_PUBLIC_DIR: path.join(input.root, "hls"),
  };
  if (explicit !== undefined) env.ASSETS_DIR = explicit;
  const child = await new Promise<{
    exitCode: string | number;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    execFile(
      process.env.BUN_BIN ?? "bun",
      ["--no-install", "--eval", script],
      {
        cwd: input.cwd,
        env,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error?.killed || error?.signal) {
          reject(error);
          return;
        }
        resolve({ exitCode: error?.code ?? 0, stdout, stderr });
      },
    );
  });
  const line = child.stdout
    .split("\n")
    .find((value) => value.startsWith("MANIFEST_OWNER_RESULT:"));
  if (!line)
    throw Error(
      `Configuration subprocess returned no receipt: ${child.stderr}`,
    );
  return {
    ...child,
    result: JSON.parse(
      line.slice("MANIFEST_OWNER_RESULT:".length),
    ) as ProbeResult,
  };
}

async function treeIdentity(root: string): Promise<unknown> {
  const entries: Record<
    string,
    { mode: number; modified: number; bytes: number; hash?: string }
  > = {};
  async function visit(directory: string) {
    const info = await stat(directory);
    entries[path.relative(root, directory)] = {
      mode: info.mode,
      modified: info.mtimeMs,
      bytes: info.size,
    };
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else {
        const item = await stat(filename);
        entries[path.relative(root, filename)] = {
          mode: item.mode,
          modified: item.mtimeMs,
          bytes: item.size,
          hash: createHash("sha256")
            .update(await readFile(filename))
            .digest("hex"),
        };
      }
    }
  }
  await visit(root);
  return entries;
}

describe("explicit HTTP manifest ownership", () => {
  it("uses the explicit directory for both actual HTTP prefixes, with no default-file fallback or CDN writes", async () => {
    const input = await fixture();
    const before = await treeIdentity(input.candidate),
      defaults = await treeIdentity(input.defaults);
    const observed = await probe(input, input.candidate, { http: true });
    expect(observed.exitCode, observed.stderr).toBe(0);
    expect(observed.result.ok).toBe(true);
    expect(observed.result.paths).toEqual({
      manifestsDir: input.manifests,
      assetsDir: path.join(input.workspace, "assets"),
      worldDir: input.world,
      iconsDir: path.join(input.serverRoot, "world", "assets", "icons"),
    });
    expect(observed.result.listening).toBe(true);
    expect(observed.result.closed).toBe(true);
    for (const response of observed.result.responses ?? []) {
      if (response.url.endsWith("default-only.json"))
        expect(response.status).toBe(404);
      else {
        expect(response.status, response.url).toBe(200);
        const filename = response.url.endsWith("world-config.json")
          ? "world-config.json"
          : "items/weapons.json";
        expect(response.body).toBe(
          await readFile(path.join(input.manifests, filename), "utf8"),
        );
      }
    }
    expect(observed.result.responses).toHaveLength(6);
    expect(input.requests).toEqual([]);
    expect(await treeIdentity(input.candidate)).toEqual(before);
    expect(await treeIdentity(input.defaults)).toEqual(defaults);
  });

  it("resolves relative ASSETS_DIR against cwd and keeps symlink path semantics aligned with DataManager", async () => {
    const input = await fixture();
    const alias = path.join(input.root, "candidate-alias");
    await symlink(input.candidate, alias, "dir");
    for (const supplied of [
      path.relative(input.cwd, input.candidate),
      path.relative(input.cwd, alias),
    ]) {
      const observed = await probe(input, supplied);
      expect(observed.exitCode, observed.stderr).toBe(0);
      expect(observed.result.paths?.manifestsDir).toBe(
        path.resolve(input.cwd, supplied, "manifests"),
      );
    }
    expect(input.requests).toEqual([]);
  });

  it("admits the legacy item file without requiring optional manifests or categories", async () => {
    const input = await fixture("legacy");
    const observed = await probe(input, input.candidate, {
      nodeEnv: "production",
    });
    expect(observed.exitCode, observed.stderr).toBe(0);
    expect(input.requests).toEqual([]);
  });

  it.each([
    "missing-assets",
    "assets-file",
    "missing-manifests",
    "manifests-file",
  ])(
    "rejects %s before directory creation, despite test/CDN bypass flags",
    async (kind) => {
      const input = await fixture();
      if (kind === "missing-assets" || kind === "assets-file") {
        await rm(input.candidate, { recursive: true });
        if (kind === "assets-file")
          await writeFile(input.candidate, "not a directory");
      } else {
        await rm(input.manifests, { recursive: true });
        if (kind === "manifests-file")
          await writeFile(input.manifests, "not a directory");
      }
      const observed = await probe(input, input.candidate, { skipFetch: true });
      expect(observed.exitCode).toBe(23);
      expect(observed.result.error).toContain(
        "Explicit ASSETS_DIR requires an existing readable directory",
      );
      expect(input.requests).toEqual([]);
      await expect(stat(input.world)).rejects.toMatchObject({ code: "ENOENT" });
      if (kind === "missing-assets")
        await expect(stat(input.candidate)).rejects.toMatchObject({
          code: "ENOENT",
        });
      if (kind === "missing-manifests")
        await expect(stat(input.manifests)).rejects.toMatchObject({
          code: "ENOENT",
        });
    },
  );

  it.each(requiredRoots)(
    "rejects missing mandatory %s without fetching or modifying the detached/default trees",
    async (filename) => {
      const input = await fixture();
      await rm(path.join(input.manifests, filename));
      const before = await treeIdentity(input.candidate),
        defaults = await treeIdentity(input.defaults);
      const observed = await probe(input, input.candidate, { skipFetch: true });
      expect(observed.exitCode).toBe(23);
      expect(observed.result.error).toContain(filename);
      expect(input.requests).toEqual([]);
      expect(await treeIdentity(input.candidate)).toEqual(before);
      expect(await treeIdentity(input.defaults)).toEqual(defaults);
      await expect(stat(input.world)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects non-file mandatory paths and incomplete core item categories", async () => {
    const input = await fixture();
    await rm(path.join(input.manifests, "world-config.json"));
    await mkdir(path.join(input.manifests, "world-config.json"));
    expect((await probe(input, input.candidate)).result.error).toContain(
      "world-config.json",
    );
    await rm(path.join(input.manifests, "world-config.json"), {
      recursive: true,
    });
    await writeFile(path.join(input.manifests, "world-config.json"), "{}");
    await rm(path.join(input.manifests, "items", "food.json"));
    const observed = await probe(input, input.candidate);
    expect(observed.exitCode).toBe(23);
    expect(observed.result.error).toContain("items.json or items/");
    expect(input.requests).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "rejects unreadable required files without a CDN repair",
    async () => {
      const input = await fixture(),
        filename = path.join(input.manifests, "npcs.json");
      await chmod(filename, 0);
      try {
        const observed = await probe(input, input.candidate);
        expect(observed.exitCode).toBe(23);
        expect(observed.result.error).toContain("npcs.json");
        expect(input.requests).toEqual([]);
      } finally {
        await chmod(filename, 0o600);
      }
    },
  );

  it("preserves absent/empty-env default cache selection and existing local skip behavior", async () => {
    const input = await fixture(),
      before = await treeIdentity(input.defaults);
    for (const supplied of [undefined, ""]) {
      const observed = await probe(input, supplied, { skipFetch: true });
      expect(observed.exitCode, observed.stderr).toBe(0);
      expect(observed.result.paths?.manifestsDir).toBe(input.defaults);
    }
    expect(input.requests).toEqual([]);
    expect(await treeIdentity(input.defaults)).toEqual(before);
  });

  it("preserves forced CDN refresh when ASSETS_DIR is absent, writing only the isolated default cache", async () => {
    const input = await fixture(),
      before = await treeIdentity(input.candidate);
    const observed = await probe(input, undefined, {
      forceFetch: true,
      skipFetch: false,
    });
    expect(observed.exitCode, observed.stderr).toBe(0);
    expect(observed.result.paths?.manifestsDir).toBe(input.defaults);
    expect(input.requests.length).toBeGreaterThan(0);
    expect(
      JSON.parse(
        await readFile(path.join(input.defaults, "world-config.json"), "utf8"),
      ),
    ).toEqual({ source: "local-test-cdn" });
    expect(await treeIdentity(input.candidate)).toEqual(before);
  });
});
