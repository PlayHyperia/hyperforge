import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import postcss from "postcss";

const testPath = fileURLToPath(import.meta.url);
const clientDir = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const repoDir = path.resolve(clientDir, "../..");
const srcDir = path.join(clientDir, "src");
const cssPath = path.join(srcDir, "index.css");
const require = createRequire(import.meta.url);
const tailwindDir = realpathSync(
  path.resolve(path.dirname(require.resolve("tailwindcss")), ".."),
);
const themeCandidates = "bg-dark-bg border-dark-border backdrop-blur-xs";

function within(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function assertDependencies(messages) {
  const files = new Set();
  let directories = 0;
  for (const row of messages) {
    assert.equal(row.plugin, "@tailwindcss/postcss");
    assert.equal(row.parent, cssPath);
    if (row.type === "dependency") {
      assert.equal(typeof row.file, "string");
      const filename = path.resolve(row.file);
      const tailwindCss =
        within(tailwindDir, filename) && filename.endsWith(".css");
      assert.ok(
        within(srcDir, filename) || tailwindCss,
        `Outside source dependency: ${filename}`,
      );
      files.add(filename);
    } else {
      assert.equal(row.type, "dir-dependency");
      assert.equal(typeof row.dir, "string");
      assert.ok(
        within(srcDir, path.resolve(row.dir)),
        `Outside source scan: ${row.dir}`,
      );
      assert.equal(typeof row.glob, "string");
      assert.ok(
        !path.isAbsolute(row.glob) && !row.glob.split(/[\\/]/).includes(".."),
      );
      directories++;
    }
  }
  assert.ok(files.size > 0);
  assert.ok(directories > 0);
  return files;
}

function productionSources() {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      // Match the current production-source census, not a claim that Tailwind
      // excludes in-src tests/backups. source("./") deliberately retains them.
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") visit(filename);
      } else if (entry.isFile() && /\.(?:tsx?|html)$/.test(entry.name)) {
        if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name))
          files.push(filename);
      }
    }
  }
  visit(srcDir);
  return files.sort();
}

function declarationRows(rule) {
  return rule.nodes
    .filter((node) => node.type === "decl")
    .map((node) => [node.prop, node.value, node.important === true]);
}

function assertCustomCss(input, output) {
  const source = postcss.parse(input);
  const result = postcss.parse(output);
  // All authored rules/keyframes/accessibility media rules must survive with
  // their declarations, independent of extra generated utility rules.
  source.walkRules((rule) => {
    const expected = declarationRows(rule);
    const candidates = [];
    result.walkRules(rule.selector, (candidate) => candidates.push(candidate));
    assert.ok(
      candidates.some((candidate) =>
        expected.every((row) =>
          declarationRows(candidate).some(
            (actual) => JSON.stringify(actual) === JSON.stringify(row),
          ),
        ),
      ),
      `Authored rule lost: ${rule.selector}`,
    );
  });
  for (const feature of [
    "prefers-reduced-motion",
    "data-colorblind",
    "data-contrast",
    "data-keyboard-nav",
    "essential-animation",
  ]) {
    assert.ok(input.includes(feature));
    assert.ok(
      output.includes(feature),
      `Accessibility feature lost: ${feature}`,
    );
  }
}

if (process.argv[2] === "--compile-tailwind") {
  const base = process.argv[3];
  assert.ok(base === clientDir || base === repoDir);
  assert.equal(process.cwd(), base);
  const { default: tailwindcss } = await import("@tailwindcss/postcss");
  const { default: autoprefixer } = await import("autoprefixer");
  const css = readFileSync(cssPath, "utf8");
  assert.match(css, /@import\s+"tailwindcss"\s+source\("\.\/"\);/);
  const compile = (input) =>
    postcss([tailwindcss({ base, optimize: false }), autoprefixer()]).process(
      input,
      { from: cssPath },
    );
  const result = await compile(css);
  const themeProbe =
    base === clientDir
      ? (await compile(`${css}\n@source inline("${themeCandidates}");\n`)).css
      : null;
  process.stdout.write(
    JSON.stringify({ css: result.css, messages: result.messages, themeProbe }),
  );
} else {
  const { test } = await import("node:test");
  test(
    "actual Tailwind source scope is complete, bounded and independent of launch cwd",
    { timeout: 75_000 },
    async (t) => {
      const css = readFileSync(cssPath, "utf8");
      const expectedSources = productionSources();
      assert.ok(expectedSources.length > 0);
      const run = promisify(execFile);
      const outputs = [];
      for (const base of [clientDir, repoDir]) {
        // The native scanner can block its own event loop. A separate host-owned
        // process enforces the deadline even then; no source/dist/temp writes.
        const child = await run(
          process.execPath,
          [testPath, "--compile-tailwind", base],
          {
            cwd: base,
            timeout: 30_000,
            killSignal: "SIGKILL",
            maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, NODE_ENV: "development", DEBUG: "" },
          },
        );
        assert.equal(child.stderr, "");
        outputs.push(JSON.parse(child.stdout));
      }
      assert.equal(readFileSync(cssPath, "utf8"), css);
      assert.deepEqual(
        Buffer.from(outputs[0].css),
        Buffer.from(outputs[1].css),
      );
      for (const output of outputs) {
        const dependencies = assertDependencies(output.messages);
        for (const filename of expectedSources) {
          assert.ok(
            dependencies.has(filename),
            `Production source not scanned: ${path.relative(srcDir, filename)}`,
          );
        }
        assertCustomCss(css, output.css);
      }

      const representatives = [
        [
          "screens/LoadingScreen.tsx",
          ["absolute", "inset-0", "bg-black", "flex", "pointer-events-auto"],
        ],
        ["screens/CharacterEditorScreen.tsx", ["bg-[#0b0a15]"]],
        ["game/panels/InventoryPanel.tsx", ["group-hover:scale-110"]],
        ["ui/components/ToggleSwitch.tsx", ["focus-visible:ring-2"]],
      ];
      const selectors = new Set();
      postcss
        .parse(outputs[0].css)
        .walkRules((rule) => selectors.add(rule.selector));
      for (const [filename, classes] of representatives) {
        const source = readFileSync(path.join(srcDir, filename), "utf8");
        for (const candidate of classes) {
          assert.ok(
            source.includes(candidate),
            `Representative no longer authored: ${candidate}`,
          );
          const selector = `.${candidate.replace(/[^a-zA-Z0-9_-]/g, (value) => `\\${value}`)}`;
          const condition = candidate.startsWith("group-hover:")
            ? ":is(:where(.group):hover *)"
            : candidate.startsWith("focus-visible:")
              ? ":focus-visible"
              : "";
          assert.ok(
            selectors.has(selector + condition),
            `Utility lost: ${candidate}`,
          );
        }
      }

      // The actual unused custom theme tokens are tested through explicit test
      // candidates, not presented as classes used by current production markup.
      const probe = outputs[0].themeProbe;
      for (const token of [
        "--color-dark-bg",
        "--color-dark-border",
        "--backdrop-blur-xs",
      ]) {
        assert.ok(css.includes(token));
        assert.ok(probe.includes(token), `Custom theme token lost: ${token}`);
      }
      for (const utility of themeCandidates.split(" "))
        assert.ok(probe.includes(`.${utility}`));

      for (const forbidden of [
        path.join(clientDir, "tests"),
        path.join(clientDir, "public"),
        clientDir,
        repoDir,
      ]) {
        assert.throws(
          () =>
            assertDependencies([
              ...outputs[0].messages,
              {
                type: "dir-dependency",
                plugin: "@tailwindcss/postcss",
                parent: cssPath,
                dir: forbidden,
                glob: "**/*",
              },
            ]),
          /Outside source scan/,
        );
        assert.throws(
          () =>
            assertDependencies([
              ...outputs[0].messages,
              {
                type: "dependency",
                plugin: "@tailwindcss/postcss",
                parent: cssPath,
                file: path.join(forbidden, "scope-negative.tsx"),
              },
            ]),
          /Outside source dependency/,
        );
      }
      t.diagnostic(
        JSON.stringify({
          productionSources: expectedSources.length,
          dependencyMessages: outputs[0].messages.length,
          cssBytes: Buffer.byteLength(outputs[0].css),
          cwdInvariant: true,
          themeProbe: "explicit test candidates; not production usage",
        }),
      );
    },
  );
}
