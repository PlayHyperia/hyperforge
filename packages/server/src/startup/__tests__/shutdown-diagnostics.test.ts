import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createShutdownDiagnostics } from "../shutdown-diagnostics.js";
import { observePostgresStopChild } from "../../infrastructure/docker/docker-manager.js";

type Row = Record<string, unknown>;
async function subprocess(body: string): Promise<Row[]> {
  const source = `import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    import assert from 'node:assert/strict';
    const createShutdownDiagnostics = ${createShutdownDiagnostics.toString()};
    const observePostgresStopChild = ${observePostgresStopChild.toString()};
    ${body}`;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", source],
      { timeout: 5_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(error);
        try {
          expect(stderr).toBe("");
          expect(stdout).not.toContain("PRIVATE_DIAGNOSTIC_SENTINEL");
          resolve(
            stdout
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line) as Row),
          );
        } catch (error) {
          reject(error);
        }
      },
    );
  });
}

describe("real owned-subprocess shutdown diagnostics", () => {
  for (const exitCode of [0, 7]) {
    it(`observes actual child spawn/exit/close without changing exit ${exitCode} or exposing output`, async () => {
      const rows = await subprocess(`
        const operation = promisify(execFile)(process.execPath, ['-e', 'process.stdout.write("PRIVATE_DIAGNOSTIC_SENTINEL");process.stderr.write("PRIVATE_DIAGNOSTIC_SENTINEL");process.exit(${exitCode})']);
        observePostgresStopChild(operation.child);
        await operation.then(()=>assert.equal(${exitCode},0),error=>assert.equal(error.code,${exitCode}));
      `);
      expect(rows.map((row) => row.phase)).toEqual([
        "created",
        "spawn",
        "exit",
        "close",
      ]);
      expect(
        rows
          .slice(-2)
          .every((row) => row.code === exitCode && row.signal === null),
      ).toBe(true);
      expect(
        rows.every(
          (row) =>
            row.event === "server-postgres-stop-child" &&
            Number.isSafeInteger(row.childPid),
        ),
      ).toBe(true);
      expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3, 4]);
    });
  }

  it("retains the actual spawn error and bounded error code without leaking path or arguments", async () => {
    const rows = await subprocess(`
      const child = execFile('/definitely-absent-PRIVATE_DIAGNOSTIC_SENTINEL', ['PRIVATE_DIAGNOSTIC_SENTINEL'], error => assert.equal(error.code, 'ENOENT'));
      observePostgresStopChild(child);
    `);
    expect(rows.map((row) => row.phase)).toEqual(["created", "error", "close"]);
    expect(rows[1].errorCode).toBe("ENOENT");
    expect(rows.every((row) => row.childPid === null)).toBe(true);
  });

  it("does not signal or resolve a retained live child; only the test owner terminates it", async () => {
    const rows = await subprocess(`
      const child = execFile(process.execPath, ['-e', 'setInterval(()=>{},1000)'], error => assert.equal(error.signal, 'SIGTERM'));
      observePostgresStopChild(child);
      const timer = setTimeout(() => {
        try {
          assert.equal(child.exitCode, null);assert.equal(child.signalCode, null);
          process.stdout.write(JSON.stringify({event:'owner-check',alive:true})+'\\n');
        } finally {child.kill('SIGTERM');}
      }, 150);
      child.once('close', () => clearTimeout(timer));
    `);
    expect(rows.map((row) => row.phase ?? row.event)).toEqual([
      "created",
      "spawn",
      "owner-check",
      "exit",
      "close",
    ]);
    expect(rows[rows.length - 1]?.signal).toBe("SIGTERM");
    expect(Number(rows[rows.length - 1]?.elapsedMs)).toBeGreaterThanOrEqual(
      100,
    );
  });

  it("records an actual HTTP drain entering before its pending response closes", async () => {
    const rows = await subprocess(`
      const http = await import('node:http');
      const diagnostics = createShutdownDiagnostics();
      let response;
      const server = http.createServer((request, reply) => {response=reply;reply.write('pending');});
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      const request=http.get({host:'127.0.0.1',port:server.address().port,agent:false});
      await new Promise(resolve=>request.once('response',incoming=>{incoming.resume();incoming.once('data',resolve);}));
      const closing=diagnostics.run('http-close',()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
      await new Promise(resolve=>setTimeout(resolve,100));
      process.stdout.write(JSON.stringify({event:'owner-check',responseEnded:response.writableEnded})+'\\n');
      response.end();await closing;
    `);
    expect(rows.map((row) => row.phase ?? row.event)).toEqual([
      "enter",
      "owner-check",
      "returned",
    ]);
    expect(rows[1].responseEnded).toBe(false);
    expect(rows[0].stage).toBe("http-close");
    expect(Number(rows[2].elapsedMs)).toBeGreaterThanOrEqual(100);
  });

  it("preserves thrown identity, caps output, and never records arbitrary error text", async () => {
    const rows = await subprocess(`
      const diagnostics=createShutdownDiagnostics(),error=new Error('PRIVATE_DIAGNOSTIC_SENTINEL');
      await assert.rejects(diagnostics.run('world',()=>{throw error;}),actual=>actual===error);
      assert.equal(await diagnostics.run('database-close',()=>37),37);
      for(let i=0;i<100;i++)diagnostics.record('exit-timer','scheduled');
    `);
    expect(rows.length).toBe(40);
    expect(rows.slice(0, 4).map((row) => row.phase)).toEqual([
      "enter",
      "threw",
      "enter",
      "returned",
    ]);
    expect(
      rows.every(
        (row) =>
          Object.keys(row).sort().join(",") ===
          "at,elapsedMs,event,phase,pid,schemaVersion,sequence,stage",
      ),
    ).toBe(true);
  });

  it("diagnostic writes throwing cannot change stage results or child closure", async () => {
    const rows = await subprocess(`
      const write=process.stdout.write;
      process.stdout.write=()=>{throw new Error('PRIVATE_DIAGNOSTIC_SENTINEL');};
      assert.equal(await createShutdownDiagnostics().run('world',()=>19),19);
      const child=execFile(process.execPath,['-e','process.exit(0)'],error=>assert.equal(error,null));
      observePostgresStopChild(child);
      child.once('close',()=>{process.stdout.write=write;process.stdout.write(JSON.stringify({event:'owner-check',closed:true})+'\\n');});
    `);
    expect(rows).toEqual([{ event: "owner-check", closed: true }]);
  });

  it("wires every actual lifecycle stage without changing terminal ACK or exit delay", () => {
    const source = readFileSync(
      new URL("../shutdown.ts", import.meta.url),
      "utf8",
    );
    const stages = [
      ...source.matchAll(/diagnostics\.run\("([a-z0-9-]+)"/g),
    ].map((match) => match[1]);
    expect(stages).toEqual([
      "alert",
      "websocket-ingress",
      "duel-terminal-barrier",
      "stream-capture",
      "http-close",
      "agents",
      "agent-thoughts",
      "web3",
      "oracle",
      "player-persistence",
      "database-pending",
      "global-services",
      "world",
      "database-close",
      "postgres-stop",
      "memory-monitor",
      "startup-flag",
    ]);
    expect(source).toContain('diagnostics.record("exit-timer", "scheduled")');
    expect(source).toContain('diagnostics.record("exit-timer", "fired")');
    expect(source).toContain(
      "process.exit(streamingShutdownExitCode);\n    }, 100)",
    );
    expect(source).toContain("timeoutMs: 5_000");
    const docker = readFileSync(
      new URL("../../infrastructure/docker/docker-manager.ts", import.meta.url),
      "utf8",
    );
    expect(docker).toContain('args.length === 2 && args[0] === "stop"');
    expect(docker).toContain("observePostgresStopChild(operation.child)");
    expect(docker).toContain("return operation;");
  });
});
