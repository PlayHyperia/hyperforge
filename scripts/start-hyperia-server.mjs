import { assertHyperiaNodeVersion } from "./node-runtime-policy.mjs";

assertHyperiaNodeVersion(process.version);

const serverModuleUrl = new URL(
  "../packages/server/dist/index.js",
  import.meta.url,
).href;
const { startVerifiedCompetitiveServer, verifyCompetitiveServerRuntime } =
  await import("../packages/server/dist/competitiveServerBootstrap.js");

const bootstrapInput = {
  serverModuleUrl,
};
const reportVerifiedBuild = (buildId) => {
  console.log(
    `[runtime] Competitive server build ${buildId.slice(0, 12)} verified before gameplay import`,
  );
};

if (process.argv.slice(2).includes("--preflight-only")) {
  reportVerifiedBuild(verifyCompetitiveServerRuntime(bootstrapInput));
} else {
  await startVerifiedCompetitiveServer({
    ...bootstrapInput,
    onVerified: reportVerifiedBuild,
  });
}
