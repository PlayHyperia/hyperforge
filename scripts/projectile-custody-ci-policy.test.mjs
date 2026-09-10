import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rootUrl = new URL("../", import.meta.url);

test("keeps fired-projectile process and database crash custody in CI", () => {
  const serverPackage = JSON.parse(
    readFileSync(new URL("packages/server/package.json", rootUrl), "utf8"),
  );
  const workflow = readFileSync(
    new URL(".github/workflows/ci.yml", rootUrl),
    "utf8",
  );
  const harness = readFileSync(
    new URL(
      "packages/server/scripts/test-projectile-cost-host-loss-process-kill.ts",
      rootUrl,
    ),
    "utf8",
  );

  assert.equal(
    serverPackage.scripts["test:projectile-cost-host-loss-chaos"],
    "bun scripts/test-projectile-cost-host-loss-process-kill.ts",
  );

  const command = "bun run test:projectile-cost-host-loss-chaos";
  const testJobStart = workflow.indexOf("\n  test:\n");
  const buildJobStart = workflow.indexOf("\n  build:\n");
  assert.ok(testJobStart >= 0 && buildJobStart > testJobStart);
  const testJob = workflow.slice(testJobStart, buildJobStart);
  assert.equal(
    testJob.split(command).length - 1,
    1,
    "the database-backed CI test job must run projectile custody chaos exactly once",
  );
  assert.ok(
    testJob.indexOf(command) >
      testJob.indexOf("bun run test:processing-action-chaos"),
    "projectile custody chaos must remain in the database-backed test job",
  );
  const commandLine = testJob
    .split("\n")
    .findIndex((line) => line.trim() === `run: ${command}`);
  assert.ok(commandLine >= 2, "projectile custody CI step is missing");
  const stepLines = testJob.split("\n").slice(commandLine - 2, commandLine + 1);
  assert.deepEqual(stepLines, [
    "      - name: Verify fired projectile process and database crash custody",
    "        working-directory: packages/server",
    `        run: ${command}`,
  ]);
  assert.doesNotMatch(
    workflow,
    /PROJECTILE_COST_HOST_LOSS_TEST_DATABASE_URL/u,
    "CI must use the harness-owned database so the crash/restart path executes",
  );

  assert.match(harness, /"kill",\s*"--signal=KILL"/u);
  assert.match(
    harness,
    /docker\(\["start", authority\.ownedContainerName!\]\)/u,
  );
  assert.match(
    harness,
    /docker\(\[\s*"port",\s*authority\.ownedContainerName!,\s*"5432\/tcp",?\s*\]\)/u,
  );
  assert.match(
    harness,
    /databaseProcessRestarted:\s*restartDatabaseProcess !== null/u,
  );
  assert.match(harness, /const UNFINISHED_CHILD = "--unfinished-child"/u);
  assert.match(harness, /PERFORM pg_sleep\(60\)/u);
  assert.match(harness, /BEFORE INSERT ON operations_log/u);
  assert.match(harness, /databaseProcessRestarts:\s*restartDatabaseProcess/u);
  assert.match(
    harness,
    /unfinishedTransactionRollbacks:\s*unfinishedEvents\.length/u,
  );
});
