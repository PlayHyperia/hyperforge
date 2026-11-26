import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const buildScriptPath = fileURLToPath(
  new URL("../anchor/scripts/build-workspace.sh", import.meta.url),
);
const cargoLockPath = fileURLToPath(
  new URL("../anchor/Cargo.lock", import.meta.url),
);
const deployScriptPath = fileURLToPath(
  new URL("../anchor/scripts/deploy-fight-oracle.sh", import.meta.url),
);

describe("duel oracle SBF build policy", () => {
  test("locks both supported SBF build paths to the audited dependency graph", () => {
    const script = readFileSync(buildScriptPath, "utf8");

    expect(script).toContain(
      'anchor build --no-idl -- --tools-version "${TOOLS_VERSION}" -- --locked',
    );
    expect(script).toContain(
      'cargo build-sbf --tools-version "${TOOLS_VERSION}" --manifest-path "${ROOT_DIR}/programs/${PROGRAM}/Cargo.toml" -- --locked',
    );
  });

  test("generates canonical IDL and TypeScript artifacts outside the SBF command", () => {
    const script = readFileSync(buildScriptPath, "utf8");

    expect(script).toContain("anchor idl build");
    expect(script).toContain('--program-name "${PROGRAM}"');
    expect(script).toContain(
      '--out-ts "${ROOT_DIR}/target/types/${PROGRAM}.ts"',
    );
  });

  test("fails closed when no SBF builder is installed", () => {
    const script = readFileSync(buildScriptPath, "utf8");

    expect(script).toContain(
      "missing required SBF builder: install anchor or cargo build-sbf",
    );
    expect(script).toMatch(
      /missing required SBF builder:[\s\S]*?exit 1[\s\S]*?generate_idl/,
    );
  });

  test("pins the last SBF-compatible blake3 dependency family", () => {
    const lockfile = readFileSync(cargoLockPath, "utf8");

    expect(lockfile).toMatch(
      /name = "blake3"\nversion = "1\.8\.2"[\s\S]*?"constant_time_eq"/,
    );
    expect(lockfile).toMatch(/name = "constant_time_eq"\nversion = "0\.3\.1"/);
    expect(lockfile).not.toContain(
      'name = "constant_time_eq"\nversion = "0.4.2"',
    );
  });

  test("refuses deployment unless keypair, compiled, and IDL identities match", () => {
    const script = readFileSync(deployScriptPath, "utf8");

    expect(script).toContain(
      'PROGRAM_ID="$(solana-keygen pubkey "$KEYPAIR_PATH")"',
    );
    expect(script).toContain("DECLARED_PROGRAM_ID=");
    expect(script).toContain("IDL_PROGRAM_ID=");
    expect(script).toContain("program identity mismatch; refusing deployment");
    expect(script.indexOf("program identity mismatch")).toBeLessThan(
      script.indexOf("solana program deploy"),
    );
  });
});
