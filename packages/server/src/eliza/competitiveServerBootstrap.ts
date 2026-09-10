import { resolveCompetitiveExecutableBuildId } from "./competitiveBuildIdentity.js";

export type CompetitiveServerBootstrapInput = {
  serverModuleUrl: string;
  resolvedSharedFrameworkUrl?: string;
  serverPhysxAssetsDirectory?: string;
  onVerified?: (buildId: string) => void;
};

/**
 * Attest every competitive runtime artifact before evaluating the gameplay
 * server bundle. Keep this bootstrap free of gameplay imports: its import graph
 * is the trust boundary that must execute before server-side module evaluation.
 */
export function verifyCompetitiveServerRuntime(
  input: Omit<CompetitiveServerBootstrapInput, "onVerified">,
): string {
  return resolveCompetitiveExecutableBuildId({
    moduleUrl: input.serverModuleUrl,
    // This entrypoint only launches built server artifacts. It must never use
    // the source-mode identity fallback, even if NODE_ENV is unset or wrong.
    nodeEnv: "production",
    resolvedSharedFrameworkUrl: input.resolvedSharedFrameworkUrl,
    serverPhysxAssetsDirectory: input.serverPhysxAssetsDirectory,
  });
}

export async function startVerifiedCompetitiveServer(
  input: CompetitiveServerBootstrapInput,
): Promise<string> {
  const buildId = verifyCompetitiveServerRuntime(input);
  input.onVerified?.(buildId);
  await import(input.serverModuleUrl);
  return buildId;
}
