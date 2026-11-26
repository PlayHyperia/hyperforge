import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return extname(entry.name) === ".ts" ? [path] : [];
  });
}

describe("PostgreSQL transaction policy", () => {
  it("forbids direct Drizzle pool transaction wrappers in server source", () => {
    const violations = listTypeScriptFiles(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return source
        .split("\n")
        .map((line, index) => ({ line, lineNumber: index + 1 }))
        .filter(({ line }) => /\.\s*transaction\s*\(/u.test(line))
        .map(
          ({ line, lineNumber }) =>
            `${relative(sourceRoot, path)}:${lineNumber}: ${line.trim()}`,
        );
    });

    expect(violations).toEqual([]);
  });

  it("never gives the pool-backed database to Drizzle's migrator", () => {
    const clientSource = readFileSync(
      join(sourceRoot, "database/client.ts"),
      "utf8",
    );

    expect(clientSource).not.toMatch(/migrate\(db\s*,/u);
    expect(clientSource).toContain(
      "migrateWithDedicatedClient(pool, migrationsFolder)",
    );
  });
});
