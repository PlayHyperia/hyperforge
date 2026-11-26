#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const RAILWAY_DEPLOY_BRANCHES = Object.freeze({
  main: "prod",
  staging: "dev",
  develop: "dev",
  dev: "dev",
  hackathon: "dev",
});

export const RAILWAY_DEPLOY_CLASSIFICATION = "all-successful-ci-pushes-deploy";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const DEPLOYMENT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const PENDING_DEPLOYMENT_STATUSES = new Set([
  "BUILDING",
  "DEPLOYING",
  "INITIALIZING",
  "QUEUED",
  "WAITING",
]);
const FAILED_DEPLOYMENT_STATUSES = new Set([
  "CANCELED",
  "CANCELLED",
  "CRASHED",
  "FAILED",
  "REMOVED",
  "REMOVING",
  "SKIPPED",
  "SLEEPING",
]);

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requirePositiveInteger(value, label) {
  const serialized = requireString(String(value ?? ""), label);
  if (!/^\d+$/.test(serialized) || BigInt(serialized) < 1n) {
    throw new Error(`${label} must be a positive integer`);
  }
  return { serialized, numeric: BigInt(serialized) };
}

function requireSha(value, label = "Commit SHA") {
  const sha = requireString(value, label).toLowerCase();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`${label} must be a full 40-character Git SHA`);
  }
  return sha;
}

function requireDeployBranch(value) {
  const branch = requireString(value, "CI head branch");
  if (!Object.hasOwn(RAILWAY_DEPLOY_BRANCHES, branch)) {
    throw new Error(
      `CI head branch is not authorized for Railway deployment: ${branch}`,
    );
  }
  return branch;
}

function requireSameRepository(run, repository) {
  const runRepository = requireString(
    run.repository?.full_name,
    "CI workflow repository",
  );
  const headRepository = requireString(
    run.head_repository?.full_name,
    "CI head repository",
  );
  if (runRepository !== repository) {
    throw new Error(
      `CI workflow repository is not authorized for Railway deployment: ${runRepository}`,
    );
  }
  if (headRepository !== repository) {
    throw new Error(
      `CI head repository is not authorized for Railway deployment: ${headRepository}`,
    );
  }
}

function requireCanonicalPushCiRun(run, repository) {
  requireRecord(run, "CI workflow run");
  if (run.name !== "CI") {
    throw new Error(`Expected CI workflow, received: ${String(run.name)}`);
  }
  const workflowPathWithRef = requireString(run.path, "CI workflow path");
  const workflowPath = workflowPathWithRef.split("@", 1)[0];
  if (workflowPath !== ".github/workflows/ci.yml") {
    throw new Error(
      `Expected canonical CI workflow path, received: ${workflowPathWithRef}`,
    );
  }
  if (run.event !== "push") {
    throw new Error(
      `Railway deployment requires a push CI run, received: ${String(run.event)}`,
    );
  }

  requireSameRepository(run, repository);
  const branch = requireDeployBranch(run.head_branch);
  const sha = requireSha(run.head_sha, "CI head SHA");
  const id = requirePositiveInteger(run.id, "CI workflow run ID");
  const runNumber = requirePositiveInteger(
    run.run_number,
    "CI workflow run number",
  );
  const runAttempt = requirePositiveInteger(
    run.run_attempt,
    "CI workflow run attempt",
  );
  const url = requireString(run.html_url, "CI workflow run URL");

  return {
    branch,
    sha,
    id: id.serialized,
    idNumber: id.numeric,
    runNumber: runNumber.numeric,
    runAttempt: runAttempt.numeric,
    url,
  };
}

function requireSuccessfulPushCiRun(run, repository) {
  const ci = requireCanonicalPushCiRun(run, repository);
  if (run.status !== "completed") {
    throw new Error(
      `Railway deployment requires completed CI, received: ${String(run.status)}`,
    );
  }
  if (run.conclusion !== "success") {
    throw new Error(
      `Railway deployment requires successful CI, received: ${String(run.conclusion)}`,
    );
  }
  return ci;
}

function compareCiRunRecency(left, right) {
  for (const key of ["runNumber", "runAttempt", "idNumber"]) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
}

/**
 * Railway deploys conservatively after every successful push CI run on an
 * authorized branch. Deliberately ignoring path lists avoids false negatives
 * from multi-commit pushes, force-pushes, API truncation, and new runtime paths.
 */
export function classifyRailwayChangeSet(changedFiles) {
  if (changedFiles !== undefined && changedFiles !== null) {
    if (!Array.isArray(changedFiles)) {
      throw new Error("Changed files must be an array when supplied");
    }
    for (const file of changedFiles) {
      requireString(file, "Changed file");
    }
  }

  return {
    deployRequired: true,
    classification: RAILWAY_DEPLOY_CLASSIFICATION,
  };
}

export function authorizeWorkflowRunDeployment({ repository, workflowRun }) {
  const expectedRepository = requireString(repository, "Repository");
  const run = requireRecord(workflowRun, "workflow_run payload");
  const ci = requireSuccessfulPushCiRun(run, expectedRepository);
  const changeSet = classifyRailwayChangeSet();

  return {
    ...changeSet,
    sha: ci.sha,
    branch: ci.branch,
    environment: RAILWAY_DEPLOY_BRANCHES[ci.branch],
    ciRunId: ci.id,
    ciRunUrl: ci.url,
  };
}

export function authorizeManualDeployment({
  repository,
  resolvedSha,
  environment,
  workflowRuns,
}) {
  const expectedRepository = requireString(repository, "Repository");
  const sha = requireSha(resolvedSha, "Resolved deployment SHA");
  const targetEnvironment = requireString(
    environment,
    "Deployment environment",
  );
  if (targetEnvironment !== "prod" && targetEnvironment !== "dev") {
    throw new Error(
      `Unsupported Railway deployment environment: ${targetEnvironment}`,
    );
  }
  if (!Array.isArray(workflowRuns)) {
    throw new Error("CI workflow runs must be an array");
  }

  const exactShaRuns = [];
  for (const candidate of workflowRuns) {
    try {
      const ci = requireCanonicalPushCiRun(candidate, expectedRepository);
      if (ci.sha === sha) exactShaRuns.push({ ...ci, source: candidate });
    } catch {
      // Noncanonical, malformed, pull-request, fork, and unauthorized-branch
      // runs can never establish deployment authority.
    }
  }

  if (exactShaRuns.length === 0) {
    throw new Error(`No canonical push CI run exists for exact SHA ${sha}`);
  }

  // Do not let an older success mask a newer failed, pending, or canceled run
  // for the same commit. GitHub provides monotonic run numbers and attempts.
  exactShaRuns.sort(compareCiRunRecency);
  const latestRun = exactShaRuns.at(-1);
  const ci = requireSuccessfulPushCiRun(latestRun.source, expectedRepository);
  const changeSet = classifyRailwayChangeSet();
  return {
    ...changeSet,
    sha,
    branch: ci.branch,
    environment: targetEnvironment,
    ciRunId: ci.id,
    ciRunUrl: ci.url,
  };
}

export function validateCurrentBranchHead({ branch, expectedSha, payload }) {
  const authorizedBranch = requireDeployBranch(branch);
  const authorizedSha = requireSha(expectedSha, "Authorized CI SHA");
  const response = requireRecord(payload, "GitHub branch response");
  const currentBranch = requireString(
    response.name,
    "Current GitHub branch name",
  );
  if (currentBranch !== authorizedBranch) {
    throw new Error(
      `GitHub returned branch ${currentBranch}, expected ${authorizedBranch}`,
    );
  }
  const commit = requireRecord(response.commit, "Current GitHub branch commit");
  const currentSha = requireSha(commit.sha, "Current GitHub branch SHA");
  if (currentSha !== authorizedSha) {
    throw new Error(
      `Refusing stale Railway deployment: ${authorizedBranch} is at ${currentSha}, CI authorized ${authorizedSha}`,
    );
  }
  return { branch: authorizedBranch, sha: currentSha };
}

function requireGraphQlSuccess(payload, operationName) {
  const response = requireRecord(payload, `${operationName} response`);
  if (response.errors !== undefined && !Array.isArray(response.errors)) {
    throw new Error(`${operationName} response errors must be an array`);
  }
  if (response.errors?.length > 0) {
    const firstError = response.errors[0];
    const message =
      firstError && typeof firstError.message === "string"
        ? firstError.message
        : "unknown GraphQL error";
    const traceId = firstError?.extensions?.traceId;
    throw new Error(
      `${operationName} failed: ${message}${traceId ? ` (trace ${traceId})` : ""}`,
    );
  }
  return requireRecord(response.data, `${operationName} response data`);
}

export function parseRailwayDeployResponse(payload) {
  const data = requireGraphQlSuccess(payload, "Railway deployment mutation");
  const deploymentId = requireString(
    data.serviceInstanceDeployV2,
    "Railway deployment ID",
  );
  if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
    throw new Error("Railway deployment ID has an invalid format");
  }
  return deploymentId;
}

export function classifyRailwayDeploymentResponse(
  payload,
  expectedDeploymentId,
) {
  const deploymentId = requireString(
    expectedDeploymentId,
    "Expected deployment ID",
  );
  const data = requireGraphQlSuccess(payload, "Railway deployment query");
  const deployment = requireRecord(data.deployment, "Railway deployment");
  const actualDeploymentId = requireString(
    deployment.id,
    "Railway deployment ID",
  );
  if (actualDeploymentId !== deploymentId) {
    throw new Error(
      `Railway returned deployment ${actualDeploymentId}, expected ${deploymentId}`,
    );
  }

  const status = requireString(
    deployment.status,
    "Railway deployment status",
  ).toUpperCase();
  if (status === "SUCCESS") return { classification: "success", status };
  if (PENDING_DEPLOYMENT_STATUSES.has(status)) {
    return { classification: "pending", status };
  }
  if (FAILED_DEPLOYMENT_STATUSES.has(status)) {
    return { classification: "failure", status };
  }
  throw new Error(`Unknown Railway deployment status: ${status}`);
}

export function terminalCommitStatus({
  authorityResult,
  pendingResult,
  deployResult,
}) {
  if (
    authorityResult === "success" &&
    pendingResult === "success" &&
    deployResult === "success"
  ) {
    return {
      state: "success",
      description: "Railway deployed the exact CI-tested commit",
    };
  }

  const pending = String(pendingResult || "unknown").slice(0, 24);
  const deploy = String(deployResult || "unknown").slice(0, 24);
  return {
    state: "failure",
    description: `Railway deployment failed closed (status: ${pending}, deploy: ${deploy})`,
  };
}

export function validateCommitStatusInput({
  repository,
  serverUrl,
  sha,
  state,
  description,
  targetUrl,
}) {
  const expectedRepository = requireString(repository, "Repository");
  const commitSha = requireSha(sha);
  const commitState = requireString(state, "Commit status state");
  if (!["pending", "success", "failure"].includes(commitState)) {
    throw new Error(`Unsupported commit status state: ${commitState}`);
  }

  const commitDescription = requireString(
    description,
    "Commit status description",
  );
  if (commitDescription.length > 140 || /[\r\n\0]/.test(commitDescription)) {
    throw new Error(
      "Commit status description must be one line and at most 140 characters",
    );
  }

  const expectedServer = new URL(requireString(serverUrl, "GitHub server URL"));
  const statusTarget = new URL(
    requireString(targetUrl, "Commit status target URL"),
  );
  if (statusTarget.origin !== expectedServer.origin) {
    throw new Error(
      "Commit status target URL must use the configured GitHub server",
    );
  }
  const expectedPath = `/${expectedRepository}/actions/runs/`;
  if (
    !statusTarget.pathname.startsWith(expectedPath) ||
    !/^\d+$/.test(statusTarget.pathname.slice(expectedPath.length)) ||
    statusTarget.search !== "" ||
    statusTarget.hash !== ""
  ) {
    throw new Error(
      "Commit status target URL must identify this repository workflow run",
    );
  }

  return {
    repository: expectedRepository,
    sha: commitSha,
    state: commitState,
    description: commitDescription,
    targetUrl: statusTarget.toString(),
  };
}

function readJson(path, label) {
  const filePath = requireString(path, `${label} path`);
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function writeOutputs(outputs) {
  const outputPath = requireString(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT");
  for (const [key, value] of Object.entries(outputs)) {
    const serialized = String(value);
    if (/[\r\n\0]/.test(serialized)) {
      throw new Error(`Unsafe multiline GitHub output: ${key}`);
    }
    appendFileSync(outputPath, `${key}=${serialized}\n`);
  }
}

function writeAuthorizationOutputs(authorization) {
  if (!authorization.deployRequired) {
    throw new Error(
      "Railway deployment authorization unexpectedly skipped deployment",
    );
  }
  writeOutputs({
    sha: authorization.sha,
    branch: authorization.branch,
    environment: authorization.environment,
    ci_run_id: authorization.ciRunId,
    ci_run_url: authorization.ciRunUrl,
    classification: authorization.classification,
  });
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  switch (command) {
    case "authorize-workflow-run": {
      const event = readJson(argument, "GitHub event payload");
      writeAuthorizationOutputs(
        authorizeWorkflowRunDeployment({
          repository: process.env.GITHUB_REPOSITORY,
          workflowRun: event.workflow_run,
        }),
      );
      return;
    }
    case "authorize-manual": {
      const response = readJson(argument, "GitHub CI runs response");
      writeAuthorizationOutputs(
        authorizeManualDeployment({
          repository: process.env.GITHUB_REPOSITORY,
          resolvedSha: process.env.RESOLVED_SHA,
          environment: process.env.DEPLOYMENT_ENVIRONMENT,
          workflowRuns: response.workflow_runs,
        }),
      );
      return;
    }
    case "parse-deploy": {
      const response = readJson(argument, "Railway deployment response");
      writeOutputs({ deployment_id: parseRailwayDeployResponse(response) });
      return;
    }
    case "verify-current-branch-head": {
      const response = readJson(argument, "GitHub branch response");
      validateCurrentBranchHead({
        branch: process.env.CI_BRANCH,
        expectedSha: process.env.COMMIT_SHA,
        payload: response,
      });
      return;
    }
    case "inspect-deployment": {
      const response = readJson(argument, "Railway deployment status response");
      const result = classifyRailwayDeploymentResponse(
        response,
        process.env.DEPLOYMENT_ID,
      );
      process.stdout.write(`${result.classification}\t${result.status}\n`);
      return;
    }
    case "terminal-status": {
      writeOutputs(
        terminalCommitStatus({
          authorityResult: process.env.AUTHORITY_RESULT,
          pendingResult: process.env.PENDING_RESULT,
          deployResult: process.env.DEPLOY_RESULT,
        }),
      );
      return;
    }
    case "validate-commit-status": {
      validateCommitStatusInput({
        repository: process.env.GITHUB_REPOSITORY,
        serverUrl: process.env.GITHUB_SERVER_URL,
        sha: process.env.COMMIT_SHA,
        state: process.env.COMMIT_STATE,
        description: process.env.COMMIT_DESCRIPTION,
        targetUrl: process.env.COMMIT_TARGET_URL,
      });
      return;
    }
    default:
      throw new Error(
        `Unknown Railway deployment policy command: ${String(command)}`,
      );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`Railway deployment policy error: ${error.message}`);
    process.exitCode = 1;
  });
}
