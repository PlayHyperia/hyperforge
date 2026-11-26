import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RTMPBridge } from "../rtmp-bridge";
import { STREAMING_DIAGNOSTIC_REDACTION } from "../redactStreamingUrl";

function teeEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/\|/g, "\\|");
}

describe("RTMP bridge diagnostic redaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never exposes configured destinations through arguments, chunks, tails, or status", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const destinationUrl = "rtmps://diagnostic-ingest.invalid/live";
    const destinationKey = "BRIDGE_SPLITLEFT_雪_BRIDGE_SPLITRIGHT";
    const destinationName = "Diagnostic test destination";
    const credentialedUrl = `${destinationUrl}/${destinationKey}`;
    const bridge = new RTMPBridge();
    bridge.addDestination({
      name: destinationName,
      url: destinationUrl,
      key: destinationKey,
      enabled: true,
    });
    log.mockClear();

    const redactedArguments = (
      bridge as unknown as {
        redactFFmpegArgumentsForLog(args: readonly string[]): string[];
      }
    ).redactFFmpegArgumentsForLog([
      "-f",
      "tee",
      `[f=flv:onfail=ignore]${teeEscape(credentialedUrl)}`,
    ]);
    expect(redactedArguments.join(" ")).toContain(
      STREAMING_DIAGNOSTIC_REDACTION,
    );
    expect(redactedArguments.join(" ")).not.toContain(destinationUrl);
    expect(redactedArguments.join(" ")).not.toContain(destinationKey);
    expect(redactedArguments.join(" ")).not.toContain(
      teeEscape(credentialedUrl),
    );

    const videoPipe = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const audioPipe = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin: videoPipe,
      stdout,
      stderr,
      stdio: [videoPipe, null, null, audioPipe],
      kill: vi.fn(),
    });
    (bridge as any).ffmpeg = child;
    (bridge as any).setupFFmpegHandlers("diagnostic-test", () => false);

    const stderrDiagnostic = Buffer.from(
      `${destinationName} failed at ${credentialedUrl}: test-only error\n`,
      "utf8",
    );
    const splitMarker = Buffer.from("雪", "utf8");
    const splitAt = stderrDiagnostic.indexOf(splitMarker) + 1;
    stderr.write(stderrDiagnostic.subarray(0, splitAt));

    expect(log).not.toHaveBeenCalled();
    expect((bridge as any).status.destinations[0].error).toBe(
      "FFmpeg reported a destination delivery failure",
    );

    stderr.write(stderrDiagnostic.subarray(splitAt));
    const stdoutDiagnostic = Buffer.from(
      `publishing ${credentialedUrl}\n`,
      "utf8",
    );
    const stdoutSplitAt = stdoutDiagnostic.indexOf(splitMarker) + 1;
    stdout.write(stdoutDiagnostic.subarray(0, stdoutSplitAt));
    stdout.write(stdoutDiagnostic.subarray(stdoutSplitAt));
    child.emit("close", 1, null);
    (bridge as any).stopHealthMonitoring();

    const retainedTail = ((bridge as any).ffmpegLogTail as string[]).join("\n");
    const publicStatus = JSON.stringify((bridge as any).status);
    const emittedDiagnostics = [...log.mock.calls, ...warn.mock.calls]
      .flat()
      .map(String)
      .join("\n");
    for (const exposedSurface of [
      retainedTail,
      publicStatus,
      emittedDiagnostics,
    ]) {
      expect(exposedSurface).not.toContain(destinationUrl);
      expect(exposedSurface).not.toContain(destinationKey);
      expect(exposedSurface).not.toContain("BRIDGE_SPLITLEFT");
      expect(exposedSurface).not.toContain("BRIDGE_SPLITRIGHT");
    }
    expect(retainedTail).toContain(STREAMING_DIAGNOSTIC_REDACTION);
    expect(emittedDiagnostics).toContain(STREAMING_DIAGNOSTIC_REDACTION);

    stdout.destroy();
    stderr.destroy();
    videoPipe.destroy();
    audioPipe.destroy();
  });
});
