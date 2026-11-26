import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

type WalletSummary = {
  generatedAt: string;
  solana: {
    authority: {
      address: string;
      keypairPath: string;
    };
    reporter: {
      address: string;
      keypairPath: string;
    };
    clusters: Array<{
      key: string;
      cluster: string;
      network: string;
    }>;
  };
  envFiles: {
    serverEnv: string;
  };
};

const SHARED_SOLANA_CLUSTERS = [
  { key: "solanaDevnet", cluster: "devnet", network: "testnet" },
  { key: "solanaMainnet", cluster: "mainnet-beta", network: "mainnet" },
] as const;

function formatSection(
  marker: string,
  lines: string[],
  existing: string,
): string {
  const start = `# BEGIN ${marker}`;
  const end = `# END ${marker}`;
  const body = `${start}\n${lines.join("\n")}\n${end}`;
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`, "m");
  if (pattern.test(existing)) {
    return existing.replace(pattern, body);
  }
  const trimmed = existing.trimEnd();
  return trimmed.length > 0 ? `${trimmed}\n\n${body}\n` : `${body}\n`;
}

async function readEnvFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: string }).code === "string"
        ? (error as { code: string }).code
        : null;
    if (code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function main() {
  const currentFile = fileURLToPath(import.meta.url);
  const serverDir = path.resolve(path.dirname(currentFile), "..");
  const workspaceRoot = path.resolve(serverDir, "../..");
  const serverEnvPath = path.resolve(serverDir, ".env");
  const generatedDir = path.resolve(
    workspaceRoot,
    ".codex-artifacts/duel-arena-oracle-wallets",
  );
  await fs.mkdir(generatedDir, { recursive: true });

  const solanaLinesForServer: string[] = [
    "# Separate duel arena oracle Solana authority and reporter signers",
  ];
  const authorityKeypairPath = path.resolve(
    generatedDir,
    "solana-authority.json",
  );
  const reporterKeypairPath = path.resolve(
    generatedDir,
    "solana-reporter.json",
  );
  const summary: WalletSummary = {
    generatedAt: new Date().toISOString(),
    solana: {
      authority: {
        address: "",
        keypairPath: authorityKeypairPath,
      },
      reporter: {
        address: "",
        keypairPath: reporterKeypairPath,
      },
      clusters: SHARED_SOLANA_CLUSTERS.map((cluster) => ({ ...cluster })),
    },
    envFiles: {
      serverEnv: serverEnvPath,
    },
  };

  const authorityKeypair = Keypair.generate();
  const reporterKeypair = Keypair.generate();
  const authoritySecretBase64 = Buffer.from(
    authorityKeypair.secretKey,
  ).toString("base64");
  const reporterSecretBase64 = Buffer.from(reporterKeypair.secretKey).toString(
    "base64",
  );
  await Promise.all([
    fs.writeFile(
      authorityKeypairPath,
      JSON.stringify(Array.from(authorityKeypair.secretKey), null, 2) + "\n",
      { mode: 0o600 },
    ),
    fs.writeFile(
      reporterKeypairPath,
      JSON.stringify(Array.from(reporterKeypair.secretKey), null, 2) + "\n",
      { mode: 0o600 },
    ),
  ]);
  solanaLinesForServer.push(
    `DUEL_ARENA_ORACLE_SOLANA_AUTHORITY_SECRET=base64:${authoritySecretBase64}`,
  );
  solanaLinesForServer.push(
    `DUEL_ARENA_ORACLE_SOLANA_REPORTER_SECRET=base64:${reporterSecretBase64}`,
  );
  summary.solana.authority.address = authorityKeypair.publicKey.toBase58();
  summary.solana.reporter.address = reporterKeypair.publicKey.toBase58();

  let serverEnv = await readEnvFile(serverEnvPath);

  serverEnv = formatSection(
    "DUEL_ARENA_ORACLE_WALLETS",
    [
      "DUEL_ARENA_ORACLE_ENABLED=false",
      "DUEL_ARENA_ORACLE_PROFILE=testnet",
      ...solanaLinesForServer,
    ],
    serverEnv,
  );
  await fs.writeFile(serverEnvPath, serverEnv, { mode: 0o600 });

  const summaryPath = path.resolve(generatedDir, "public-addresses.json");
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n", {
    mode: 0o600,
  });

  console.log(JSON.stringify({ summaryPath, summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
