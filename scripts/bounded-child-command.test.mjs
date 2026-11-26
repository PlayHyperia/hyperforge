import { spawn } from "node:child_process";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getEventListeners } from "node:events";

import {
  runBoundedChildCommand,
  waitForBoundedChildExit,
} from "./bounded-child-command.mjs";

const duelStackSource = readFileSync(
  new URL("./duel-stack.mjs", import.meta.url),
  "utf8",
);

describe("bounded child command", () => {
  it("accepts a clean exit before its deadline", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    await expect(
      waitForBoundedChildExit(child, {
        label: "clean child",
        timeoutMs: 2_000,
      }),
    ).resolves.toMatchObject({ code: 0, signal: null });
  });

  it("rejects a nonzero exit with exact diagnostics", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(7)"], {
      stdio: "ignore",
    });
    await expect(
      waitForBoundedChildExit(child, { label: "failed child" }),
    ).rejects.toThrow("failed child exited with code=7 signal=null");
  });

  it("terminates and rejects a child that exceeds its deadline", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      },
    );
    await expect(
      waitForBoundedChildExit(child, {
        label: "stalled child",
        timeoutMs: 50,
        terminationGraceMs: 100,
      }),
    ).rejects.toThrow("stalled child timed out after 50ms");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("rejects malformed timeout configuration before attaching", () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    expect(() =>
      waitForBoundedChildExit(child, {
        label: "invalid child",
        timeoutMs: 0,
      }),
    ).toThrow("Bounded child timeout must be a positive safe integer");
  });

  it("separates cold runtime materialization from bounded Solana mutations", () => {
    expect(duelStackSource).toContain(
      '"solana-launch-config-runtime-preflight"',
    );
    expect(
      /withHyperbetBunRuntimeArgs\(\[launchConfigScriptPath, "--help"\]\),\s*\{ timeoutMs: Math\.min\(240_000, startupTimeoutMs\) \}/.test(
        duelStackSource,
      ),
    ).toBe(true);
    expect(
      /"solana-launch-config",[\s\S]*timeoutMs: Math\.min\(120_000, startupTimeoutMs\)/.test(
        duelStackSource,
      ),
    ).toBe(true);
  });
});

describe("captured bounded child command", () => {
  const childOptions = {
    label: "owned evidence test child",
    timeoutMs: 2_000,
    terminationGraceMs: 100,
    killGraceMs: 1_000,
  };
  const run = (source, options = {}) =>
    runBoundedChildCommand(process.execPath, ["-e", source], {
      ...childOptions,
      ...options,
    });
  const assertGone = (result) => {
    expect(result.closed).toBe(true);
    expect(result.processGroupGone).toBe(true);
    expect(result.cleanupComplete).toBe(true);
    expect(Number.isSafeInteger(result.ownedPid)).toBe(true);
    for (const pid of [result.ownedPid, -result.ownedPid]) {
      let code = null;
      try {
        process.kill(pid, 0);
      } catch (error) {
        code = error.code;
      }
      expect(code).toBe("ESRCH");
    }
  };
  const rejected = async (operation) => {
    const outcome = await operation.then(
      () => ({ succeeded: true }),
      (error) => ({ error }),
    );
    expect(outcome.succeeded).not.toBe(true);
    return outcome.error;
  };

  it("captures output only after a clean close and removes the abort listener", async () => {
    const controller = new AbortController();
    const result = await run(
      'console.log("exact output"); console.error("diagnostic output")',
      { signal: controller.signal },
    );
    expect(result.stdout).toBe("exact output\n");
    expect(result.stderr).toBe("diagnostic output\n");
    expect(result.exitCode).toBe(0);
    expect(result.forcedCleanup).toBe(false);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    assertGone(result);
  });

  it("preserves bounded nonzero output without putting it in the error message", async () => {
    const result = await rejected(
      run(
        'console.log("diagnostic-A"); console.error("diagnostic-B"); process.exit(7)',
      ),
    );
    expect(result.code).toBe("CHILD_EXIT_NONZERO");
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("diagnostic-A\n");
    expect(result.stderr).toBe("diagnostic-B\n");
    expect(result.message).not.toContain("diagnostic-");
    assertGone(result);
  });

  it("rejects pre-abort without launching a child", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await rejected(
      run("process.exit(23)", { signal: controller.signal }),
    );
    expect(result.code).toBe("CHILD_ABORTED");
    expect(result.ownedPid).toBe(null);
    expect(result.cleanupComplete).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("escalates a real SIGTERM-ignoring child and waits for close on timeout", async () => {
    const startedAt = Date.now();
    const result = await rejected(
      run(
        'process.on("SIGTERM", () => console.error("term observed")); console.log(process.pid); setInterval(() => {}, 1000)',
        {
          timeoutMs: 400,
        },
      ),
    );
    expect(result.code).toBe("CHILD_TIMEOUT");
    expect(result.forcedCleanup).toBe(true);
    expect(result.stderr).toContain("term observed");
    expect(Number(result.stdout.trim())).toBe(result.ownedPid);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    assertGone(result);
  });

  it("escalates on abort and removes listeners before returning the failure", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 400);
    try {
      const result = await rejected(
        run(
          'process.on("SIGTERM", () => console.error("term observed")); setInterval(() => {}, 1000)',
          {
            signal: controller.signal,
          },
        ),
      );
      expect(result.code).toBe("CHILD_ABORTED");
      expect(result.forcedCleanup).toBe(true);
      expect(result.stderr).toContain("term observed");
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      assertGone(result);
    } finally {
      clearTimeout(timer);
    }
  });

  it("never treats exit zero after a timeout signal as success", async () => {
    const result = await rejected(
      run(
        'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)',
        {
          timeoutMs: 400,
        },
      ),
    );
    expect(result.code).toBe("CHILD_TIMEOUT");
    expect(result.exitCode).toBe(0);
    expect(result.forcedCleanup).toBe(false);
    assertGone(result);
  });

  for (const { inheritedPipes, parentExit } of [
    { inheritedPipes: true, parentExit: 0 },
    { inheritedPipes: false, parentExit: 0 },
    { inheritedPipes: false, parentExit: 7 },
  ]) {
    it(`removes an orphan descendant with ${inheritedPipes ? "inherited" : "closed"} output pipes after exit ${parentExit}`, async () => {
      const descendant =
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)';
      const result = await rejected(
        run(
          `const { spawn } = require("node:child_process");
          const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
            stdio: ${JSON.stringify(inheritedPipes ? "inherit" : "ignore")}
          });
          console.log(child.pid);
          setTimeout(() => process.exit(${parentExit}), 150);`,
          {
            timeoutMs: 500,
          },
        ),
      );
      expect(result.code).toBe(
        inheritedPipes
          ? "CHILD_TIMEOUT"
          : parentExit === 0
            ? "CHILD_DESCENDANT_REMAINED"
            : "CHILD_EXIT_NONZERO",
      );
      expect(result.forcedCleanup).toBe(true);
      assertGone(result);
      let descendantCode = null;
      try {
        process.kill(Number(result.stdout.trim()), 0);
      } catch (error) {
        descendantCode = error.code;
      }
      expect(descendantCode).toBe("ESRCH");
    });
  }

  it("caps combined output and terminates instead of returning truncated success", async () => {
    const result = await rejected(
      run(
        'process.stdout.write("x".repeat(8192)); setInterval(() => {}, 1000)',
        {
          maxBuffer: 512,
        },
      ),
    );
    expect(result.code).toBe("CHILD_OUTPUT_LIMIT");
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBeLessThanOrEqual(512);
    assertGone(result);
  });

  it("settles an actual failed spawn without inventing an owned PID", async () => {
    const result = await rejected(
      runBoundedChildCommand(
        "/nonexistent-hyperia-bounded-command",
        [],
        childOptions,
      ),
    );
    expect(result.code).toBe("CHILD_PROCESS_ERROR");
    expect(result.ownedPid).toBe(null);
    expect(result.closed).toBe(true);
    expect(result.cleanupComplete).toBe(true);
  });

  it("keeps malformed or truncated UTF-8 diagnostics within the output byte cap", async () => {
    const result = await rejected(
      run(
        "process.stdout.write(Buffer.from([255, 255, 240, 159, 152, 128])); setInterval(() => {}, 1000)",
        {
          maxBuffer: 5,
        },
      ),
    );
    expect(result.code).toBe("CHILD_OUTPUT_LIMIT");
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBeLessThanOrEqual(5);
    assertGone(result);
  });

  it("rejects malformed deadlines and arguments before launch", () => {
    for (const timeoutMs of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) {
      expect(() => run("process.exit(0)", { timeoutMs })).toThrow();
    }
    expect(() =>
      runBoundedChildCommand(process.execPath, [null], childOptions),
    ).toThrow();
    expect(() => run("process.exit(0)", { signal: {} })).toThrow();
    expect(() =>
      run("process.exit(0)", {
        terminationGraceMs: 2_147_483_647,
        killGraceMs: 1,
      }),
    ).toThrow("combined cleanup grace");
  });

  it("bounds and cancels exact terminal/dispute commands and downstream drain without changing identity gates", () => {
    const source = readFileSync(
      new URL("./smoke-duel-launch.mjs", import.meta.url),
      "utf8",
    );
    const section = (start, end) =>
      source.slice(source.indexOf(start), source.indexOf(end));
    const terminal = section(
      "async function readTerminalSuccess",
      "async function readProgramAccount",
    );
    const dispute = section(
      "async function captureDuelDisputeEvidence",
      "async function monitorFullTopologyContinuity",
    );
    const postSoak = section(
      "async function capturePostSoakTerminalEvidence",
      "async function waitForExactSoakBoundaryEvidence",
    );
    const boundary = section(
      "async function waitForExactSoakBoundaryEvidence",
      "async function waitForDrainedPostSoakTerminalEvidence",
    );
    const drain = section(
      "async function waitForDrainedPostSoakTerminalEvidence",
      "async function waitForFreshSoakAnnouncementBoundary",
    );
    for (const scoped of [terminal, dispute]) {
      expect(scoped).toContain("runBoundedChildCommand(");
      expect(scoped).not.toContain("execFileAsync(");
      expect(scoped).toContain("signal,");
      expect(scoped).toContain("remainingEvidenceCommandTime(");
    }
    expect(dispute).toMatch(
      /error\?\.code !== "CHILD_EXIT_NONZERO" \|\|\s*!error\.cleanupComplete \|\|\s*error\.forcedCleanup/,
    );
    expect(dispute).toContain("result.duelId !== duelId");
    expect(dispute).toContain("path.resolve(outputPath)");
    expect(dispute).toContain(
      "(await sha256File(outputPath)) !== result.artifactSha256",
    );
    expect(postSoak).toContain(
      "readTerminalSuccess(workspace, { signal, deadlineMs })",
    );
    expect(postSoak).toContain("selectExactResolvedTerminalEvidence(");
    expect(boundary).toContain("{ signal, deadlineMs: deadline }");
    expect(boundary).toMatch(
      /capturePostSoakTerminalEvidence\(expectedDuel,\s*\{\s*signal,\s*deadlineMs: deadline/,
    );
    expect(drain).toMatch(
      /capturePostSoakTerminalEvidence\(\s*\{\},\s*\{\s*deadlineMs: deadline/,
    );
  });
});
