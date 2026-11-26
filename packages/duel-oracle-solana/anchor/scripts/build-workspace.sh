#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROGRAM="fight_oracle"
TOOLS_VERSION="${ANCHOR_SBF_TOOLS_VERSION:-v1.44}"

extract_marker_json() {
  local marker="$1"
  sed -n "/--- IDL begin ${marker} ---/,/--- IDL end ${marker} ---/p" | sed '1d;$d'
}

generate_idl() {
  local program_output
  local address_output
  local program_json
  local address_json
  local address

  echo "[duel-oracle-solana] generating idl"

  program_output="$(
    cargo test -p "${PROGRAM}" --lib __anchor_private_print_idl_program --features idl-build -- --nocapture --test-threads=1 2>/dev/null
  )"
  program_json="$(printf '%s' "${program_output}" | extract_marker_json "program")"
  if [[ -z "${program_json}" ]]; then
    echo "failed to extract fight_oracle IDL" >&2
    exit 1
  fi

  address_output="$(
    cargo test -p "${PROGRAM}" --lib __anchor_private_print_idl_address --features idl-build -- --nocapture --test-threads=1 2>/dev/null
  )"
  address_json="$(printf '%s' "${address_output}" | extract_marker_json "address")"
  if [[ -z "${address_json}" ]]; then
    echo "failed to extract fight_oracle address" >&2
    exit 1
  fi

  address="$(printf '%s' "${address_json}" | jq -r 'fromjson')"
  printf '%s' "${program_json}" | jq --arg addr "${address}" '.address = $addr' >"${ROOT_DIR}/target/idl/${PROGRAM}.json"
}

mkdir -p "${ROOT_DIR}/target/idl"

if command -v anchor >/dev/null 2>&1; then
  # The Solana platform Cargo can lag host Cargo. Keep the audited dependency
  # graph exact so an SBF build cannot silently select a newer Rust edition.
  (
    cd "${ROOT_DIR}"
    anchor build --no-idl -- --tools-version "${TOOLS_VERSION}" -- --locked
    anchor idl build \
      --program-name "${PROGRAM}" \
      --out "${ROOT_DIR}/target/idl/${PROGRAM}.json" \
      --out-ts "${ROOT_DIR}/target/types/${PROGRAM}.ts"
  )
else
  if cargo --list | grep -q "build-sbf"; then
    cargo build-sbf --tools-version "${TOOLS_VERSION}" --manifest-path "${ROOT_DIR}/programs/${PROGRAM}/Cargo.toml" -- --locked
  else
    echo "missing required SBF builder: install anchor or cargo build-sbf" >&2
    exit 1
  fi

  generate_idl
fi
export ROOT_DIR
node <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const rootDir = process.env.ROOT_DIR;
const idlPath = path.join(rootDir, "target", "idl", "fight_oracle.json");
const generatedIdlPath = path.join(
  rootDir,
  "..",
  "src",
  "generated",
  "fightOracleIdl.ts",
);
const targetTypesPath = path.join(
  rootDir,
  "target",
  "types",
  "fight_oracle.ts",
);
const generatedTypesPath = path.join(
  rootDir,
  "..",
  "src",
  "generated",
  "fightOracleTypes.ts",
);

const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
fs.writeFileSync(
  generatedIdlPath,
  `export const FIGHT_ORACLE_IDL = ${JSON.stringify(idl, null, 2)} as const;\n\nexport default FIGHT_ORACLE_IDL;\n`,
);

if (fs.existsSync(targetTypesPath)) {
  fs.copyFileSync(targetTypesPath, generatedTypesPath);
}
EOF
echo "[duel-oracle-solana] build complete"
