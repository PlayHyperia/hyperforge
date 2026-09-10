import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  authorizeManualDeployment,
  authorizeWorkflowRunDeployment,
  classifyRailwayChangeSet,
  classifyRailwayDeploymentResponse,
  parseRailwayDeployResponse,
  terminalCommitStatus,
  validateCurrentBranchHead,
  validateCommitStatusInput,
} from "./railway-deployment-policy.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const REPOSITORY = "hyperforge-ai/hyperia";
const CI_URL = `https://github.com/${REPOSITORY}/actions/runs/42`;

function successfulCi(overrides = {}) {
  return {
    id: 42,
    name: "CI",
    path: ".github/workflows/ci.yml@main",
    event: "push",
    status: "completed",
    conclusion: "success",
    head_sha: SHA,
    head_branch: "main",
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    html_url: CI_URL,
    run_number: 42,
    run_attempt: 1,
    ...overrides,
  };
}

describe("conservative change classification", () => {
  it("deploys when changed-file input is omitted", () => {
    assert.equal(classifyRailwayChangeSet().deployRequired, true);
  });

  it("deploys a docs-only push rather than fabricating a green skip", () => {
    assert.equal(classifyRailwayChangeSet(["README.md"]).deployRequired, true);
  });

  it("deploys newly introduced runtime paths absent from the old filter", () => {
    assert.equal(
      classifyRailwayChangeSet(["packages/shared/src/procgen/runtime.ts"])
        .deployRequired,
      true,
    );
  });

  it("deploys the complete union from a multi-commit push", () => {
    assert.equal(
      classifyRailwayChangeSet([
        "docs/launch.md",
        "packages/server/src/index.ts",
        "packages/shared/src/procgen/runtime.ts",
      ]).deployRequired,
      true,
    );
  });

  it("rejects malformed changed-file input", () => {
    assert.throws(
      () => classifyRailwayChangeSet("README.md"),
      /must be an array/,
    );
  });
});

describe("exact-SHA CI authorization", () => {
  it("maps main to prod and carries the exact successful CI SHA", () => {
    const authorization = authorizeWorkflowRunDeployment({
      repository: REPOSITORY,
      workflowRun: successfulCi(),
    });
    assert.equal(authorization.sha, SHA);
    assert.equal(authorization.environment, "prod");
    assert.equal(authorization.deployRequired, true);
  });

  for (const branch of ["staging", "develop", "dev", "hackathon"]) {
    it(`maps ${branch} to dev`, () => {
      const authorization = authorizeWorkflowRunDeployment({
        repository: REPOSITORY,
        workflowRun: successfulCi({ head_branch: branch }),
      });
      assert.equal(authorization.environment, "dev");
    });
  }

  for (const [label, overrides] of [
    ["failed CI", { conclusion: "failure" }],
    ["pending CI", { status: "in_progress", conclusion: null }],
    ["pull-request CI", { event: "pull_request" }],
    [
      "same-name noncanonical workflow",
      { path: ".github/workflows/not-ci.yml" },
    ],
    [
      "unauthorized workflow repository",
      { repository: { full_name: "attacker/fork" } },
    ],
    [
      "unauthorized repository",
      { head_repository: { full_name: "attacker/fork" } },
    ],
    ["unauthorized branch", { head_branch: "feature/untrusted" }],
  ]) {
    it(`rejects ${label}`, () => {
      assert.throws(() =>
        authorizeWorkflowRunDeployment({
          repository: REPOSITORY,
          workflowRun: successfulCi(overrides),
        }),
      );
    });
  }

  it("manual dispatch accepts only successful push CI for the resolved exact SHA", () => {
    const authorization = authorizeManualDeployment({
      repository: REPOSITORY,
      resolvedSha: SHA,
      environment: "dev",
      workflowRuns: [
        successfulCi({ id: 41, head_sha: OTHER_SHA }),
        successfulCi({ id: 42, head_branch: "staging" }),
      ],
    });
    assert.equal(authorization.sha, SHA);
    assert.equal(authorization.branch, "staging");
    assert.equal(authorization.environment, "dev");
  });

  it("manual dispatch rejects an older success when the newest exact-SHA run failed", () => {
    assert.throws(
      () =>
        authorizeManualDeployment({
          repository: REPOSITORY,
          resolvedSha: SHA,
          environment: "prod",
          workflowRuns: [
            successfulCi({ id: 100, run_number: 100 }),
            successfulCi({
              id: 101,
              run_number: 101,
              conclusion: "failure",
            }),
          ],
        }),
      /requires successful CI/,
    );
  });

  it("manual dispatch rejects an older success when the newest exact-SHA run is pending", () => {
    assert.throws(
      () =>
        authorizeManualDeployment({
          repository: REPOSITORY,
          resolvedSha: SHA,
          environment: "prod",
          workflowRuns: [
            successfulCi({
              id: 201,
              run_number: 201,
              status: "in_progress",
              conclusion: null,
            }),
            successfulCi({ id: 200, run_number: 200 }),
          ],
        }),
      /requires completed CI/,
    );
  });

  for (const [label, workflowRuns] of [
    ["omitted CI evidence", undefined],
    ["different SHA", [successfulCi({ head_sha: OTHER_SHA })]],
    ["failed CI", [successfulCi({ conclusion: "failure" })]],
    ["pending CI", [successfulCi({ status: "in_progress", conclusion: null })]],
    [
      "unauthorized repository",
      [successfulCi({ head_repository: { full_name: "attacker/fork" } })],
    ],
  ]) {
    it(`manual dispatch rejects ${label}`, () => {
      assert.throws(() =>
        authorizeManualDeployment({
          repository: REPOSITORY,
          resolvedSha: SHA,
          environment: "prod",
          workflowRuns,
        }),
      );
    });
  }
});

describe("Railway response policy", () => {
  describe("automatic branch freshness", () => {
    it("accepts only the current authorized branch head", () => {
      assert.deepEqual(
        validateCurrentBranchHead({
          branch: "main",
          expectedSha: SHA,
          payload: { name: "main", commit: { sha: SHA } },
        }),
        { branch: "main", sha: SHA },
      );
    });

    it("rejects an older CI SHA after the branch advances", () => {
      assert.throws(
        () =>
          validateCurrentBranchHead({
            branch: "main",
            expectedSha: SHA,
            payload: { name: "main", commit: { sha: OTHER_SHA } },
          }),
        /Refusing stale Railway deployment/,
      );
    });

    it("rejects missing and malformed branch-head evidence", () => {
      assert.throws(() =>
        validateCurrentBranchHead({
          branch: "main",
          expectedSha: SHA,
          payload: { name: "main" },
        }),
      );
      assert.throws(() =>
        validateCurrentBranchHead({
          branch: "main",
          expectedSha: SHA,
          payload: { name: "main", commit: { sha: "main" } },
        }),
      );
      assert.throws(() =>
        validateCurrentBranchHead({
          branch: "main",
          expectedSha: SHA,
          payload: { name: "develop", commit: { sha: SHA } },
        }),
      );
    });

    it("places the automatic head check immediately before mutation construction", () => {
      const workflow = readFileSync(
        new URL("../.github/workflows/deploy-railway.yml", import.meta.url),
        "utf8",
      );
      const triggerStep = workflow.indexOf(
        "- name: Trigger exact-commit Railway deployment",
      );
      const headCheck = workflow.indexOf(
        "verify-current-branch-head",
        triggerStep,
      );
      const requestConstruction = workflow.indexOf("jq -n", triggerStep);
      const railwayMutation = workflow.indexOf(
        "--url https://backboard.railway.com/graphql/v2",
        triggerStep,
      );

      assert.ok(triggerStep >= 0);
      assert.ok(headCheck > triggerStep);
      assert.ok(requestConstruction > headCheck);
      assert.ok(railwayMutation > requestConstruction);
    });
  });

  it("accepts an exact deployment ID from the exact-commit mutation", () => {
    assert.equal(
      parseRailwayDeployResponse({
        data: { serviceInstanceDeployV2: "deployment-123" },
      }),
      "deployment-123",
    );
  });

  it("fails closed on unauthorized and malformed mutation responses", () => {
    assert.throws(
      () =>
        parseRailwayDeployResponse({
          errors: [
            { message: "Not Authorized", extensions: { traceId: "trace-1" } },
          ],
          data: null,
        }),
      /Not Authorized/,
    );
    assert.throws(
      () => parseRailwayDeployResponse({ data: {} }),
      /deployment ID/,
    );
    assert.throws(
      () =>
        parseRailwayDeployResponse({
          errors: { message: "Not Authorized" },
          data: { serviceInstanceDeployV2: "deployment-123" },
        }),
      /errors must be an array/,
    );
  });

  it("accepts success only for the exact returned deployment", () => {
    assert.deepEqual(
      classifyRailwayDeploymentResponse(
        { data: { deployment: { id: "deployment-123", status: "SUCCESS" } } },
        "deployment-123",
      ),
      { classification: "success", status: "SUCCESS" },
    );
  });

  for (const status of [
    "BUILDING",
    "DEPLOYING",
    "INITIALIZING",
    "QUEUED",
    "WAITING",
  ]) {
    it(`classifies ${status} as pending`, () => {
      assert.equal(
        classifyRailwayDeploymentResponse(
          { data: { deployment: { id: "deployment-123", status } } },
          "deployment-123",
        ).classification,
        "pending",
      );
    });
  }

  for (const status of [
    "FAILED",
    "CRASHED",
    "REMOVED",
    "SKIPPED",
    "SLEEPING",
  ]) {
    it(`classifies ${status} as failure`, () => {
      assert.equal(
        classifyRailwayDeploymentResponse(
          { data: { deployment: { id: "deployment-123", status } } },
          "deployment-123",
        ).classification,
        "failure",
      );
    });
  }

  it("fails closed on mismatched IDs, unknown statuses, and GraphQL failures", () => {
    assert.throws(() =>
      classifyRailwayDeploymentResponse(
        { data: { deployment: { id: "other-deployment", status: "SUCCESS" } } },
        "deployment-123",
      ),
    );
    assert.throws(() =>
      classifyRailwayDeploymentResponse(
        { data: { deployment: { id: "deployment-123", status: "MYSTERY" } } },
        "deployment-123",
      ),
    );
    assert.throws(() =>
      classifyRailwayDeploymentResponse(
        { errors: [{ message: "Not Authorized" }], data: null },
        "deployment-123",
      ),
    );
  });
});

describe("terminal commit status policy", () => {
  it("publishes success only after authority, pending status, and deployment succeed", () => {
    assert.equal(
      terminalCommitStatus({
        authorityResult: "success",
        pendingResult: "success",
        deployResult: "success",
      }).state,
      "success",
    );
  });

  for (const deployResult of [
    "failure",
    "cancelled",
    "pending",
    "skipped",
    "unknown",
  ]) {
    it(`fails closed for ${deployResult} deployment result`, () => {
      assert.equal(
        terminalCommitStatus({
          authorityResult: "success",
          pendingResult: "success",
          deployResult,
        }).state,
        "failure",
      );
    });
  }

  it("fails closed when pending status publication did not succeed", () => {
    assert.equal(
      terminalCommitStatus({
        authorityResult: "success",
        pendingResult: "failure",
        deployResult: "skipped",
      }).state,
      "failure",
    );
  });
});

describe("commit status input validation", () => {
  it("accepts an exact SHA and this workflow run URL", () => {
    assert.equal(
      validateCommitStatusInput({
        repository: REPOSITORY,
        serverUrl: "https://github.com",
        sha: SHA,
        state: "pending",
        description: "Railway deployment pending",
        targetUrl: CI_URL,
      }).sha,
      SHA,
    );
  });

  it("rejects malformed SHAs, success-like unknown states, and external URLs", () => {
    assert.throws(() =>
      validateCommitStatusInput({
        repository: REPOSITORY,
        serverUrl: "https://github.com",
        sha: "main",
        state: "success",
        description: "invalid",
        targetUrl: CI_URL,
      }),
    );
    assert.throws(() =>
      validateCommitStatusInput({
        repository: REPOSITORY,
        serverUrl: "https://github.com",
        sha: SHA,
        state: "unknown",
        description: "invalid",
        targetUrl: CI_URL,
      }),
    );
    assert.throws(() =>
      validateCommitStatusInput({
        repository: REPOSITORY,
        serverUrl: "https://github.com",
        sha: SHA,
        state: "success",
        description: "invalid",
        targetUrl: "https://example.com/actions/runs/42",
      }),
    );
  });
});
