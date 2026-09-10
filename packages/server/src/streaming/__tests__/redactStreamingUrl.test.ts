import { describe, expect, it } from "vitest";
import {
  redactStreamingDiagnosticArguments,
  redactStreamingDiagnosticText,
  redactStreamingSecretsFromUrl,
  STREAMING_DIAGNOSTIC_OMISSION,
  STREAMING_DIAGNOSTIC_REDACTION,
  STREAMING_DIAGNOSTIC_UNTERMINATED_OMISSION,
  StreamingDiagnosticLineRedactor,
} from "../redactStreamingUrl";

function teeEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/\|/g, "\\|");
}

describe("redactStreamingSecretsFromUrl", () => {
  it("removes streamToken from query strings and hash fragments", () => {
    expect(
      redactStreamingSecretsFromUrl(
        "https://example.com/stream?page=1&streamToken=query-secret#streamToken=hash-secret&mode=stream",
      ),
    ).toBe("https://example.com/stream?page=1#mode=stream");
  });

  it("leaves unrelated URL parts untouched", () => {
    expect(
      redactStreamingSecretsFromUrl(
        "https://example.com/stream?page=1#mode=stream",
      ),
    ).toBe("https://example.com/stream?page=1#mode=stream");
  });

  it("removes dangling separators when the raw URL is malformed", () => {
    expect(
      redactStreamingSecretsFromUrl("/stream?streamToken=query-secret"),
    ).toBe("/stream");
    expect(
      redactStreamingSecretsFromUrl("/stream#streamToken=hash-secret"),
    ).toBe("/stream");
  });
});

describe("streaming diagnostic redaction", () => {
  const firstUrl = "rtmps://ingest-one.invalid/live";
  const firstKey = "test-only-stream-key-alpha-123";
  const secondUrl = "rtmp://user:fake-password@ingest-two.invalid/app";
  const secondKey = "test-only-stream-key-beta:456|tail";
  const sensitiveValues = [
    firstUrl,
    firstKey,
    `${firstUrl}/${firstKey}`,
    secondUrl,
    secondKey,
    `${secondUrl}/${secondKey}`,
  ];

  it("redacts every configured RTMP destination in a tee argument", () => {
    const teeArgument = [
      `[f=flv:onfail=ignore]${teeEscape(`${firstUrl}/${firstKey}`)}`,
      `[f=flv:onfail=ignore]${teeEscape(`${secondUrl}/${secondKey}`)}`,
      "[f=hls]/tmp/unit-test-local.m3u8",
    ].join("|");

    const redacted = redactStreamingDiagnosticArguments(
      ["-map", "0:v", "-f", "tee", teeArgument],
      sensitiveValues,
    ).join(" ");

    expect(redacted).toContain("-map 0:v -f tee");
    expect(redacted).toContain("/tmp/unit-test-local.m3u8");
    expect(redacted).toContain(STREAMING_DIAGNOSTIC_REDACTION);
    for (const sensitiveValue of sensitiveValues) {
      expect(redacted).not.toContain(sensitiveValue);
      expect(redacted).not.toContain(teeEscape(sensitiveValue));
      expect(redacted).not.toContain(encodeURIComponent(sensitiveValue));
    }
  });

  it("redacts standalone, URL-encoded, and query-parameter credentials", () => {
    const encodedSecret = "test-only encoded secret/789";
    const configuredEncodedSecret = "test-only%2Fdecoded%20stream-key";
    const redacted = redactStreamingDiagnosticText(
      `key=${firstKey} encoded=${encodeURIComponent(encodedSecret)} ` +
        "decoded=test-only/decoded stream-key " +
        "https://status.invalid/callback?access_token=test-only-query-token",
      [firstKey, encodedSecret, configuredEncodedSecret],
    );

    expect(redacted).not.toContain(firstKey);
    expect(redacted).not.toContain(encodedSecret);
    expect(redacted).not.toContain(encodeURIComponent(encodedSecret));
    expect(redacted).not.toContain("test-only/decoded stream-key");
    expect(redacted).not.toContain("test-only-query-token");
    expect(redacted).toContain(
      `access_token=${STREAMING_DIAGNOSTIC_REDACTION}`,
    );
  });

  it("holds chunk-split UTF-8 credentials until a complete line is safe", () => {
    const splitSecret = "SPLITLEFT_雪_SPLITRIGHT";
    const redactor = new StreamingDiagnosticLineRedactor([splitSecret]);
    const diagnostic = Buffer.from(
      `publisher rejected standalone ${splitSecret} at ${firstUrl}/${firstKey}\n`,
      "utf8",
    );
    const snowBytes = Buffer.from("雪", "utf8");
    const snowStart = diagnostic.indexOf(snowBytes);
    const newlineIndex = diagnostic.length - 1;

    expect(redactor.push(diagnostic.subarray(0, snowStart + 1))).toEqual([]);
    expect(
      redactor.push(diagnostic.subarray(snowStart + 1, newlineIndex)),
    ).toEqual([]);
    const lines = redactor.push(diagnostic.subarray(newlineIndex));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(STREAMING_DIAGNOSTIC_REDACTION);
    expect(lines[0]).not.toContain(splitSecret);
    expect(lines[0]).not.toContain("SPLITLEFT");
    expect(lines[0]).not.toContain("SPLITRIGHT");
    expect(lines[0]).not.toContain(firstUrl);
    expect(lines[0]).not.toContain(firstKey);
    expect(redactor.bufferedChars).toBe(0);
  });

  it("drops oversized and unterminated lines without exposing a prefix", () => {
    const oversized = new StreamingDiagnosticLineRedactor([firstKey], 64);
    expect(oversized.push(`prefix-${firstKey}-${"x".repeat(80)}`)).toEqual([]);
    expect(oversized.bufferedChars).toBe(0);
    expect(oversized.push("\r\n")).toEqual([STREAMING_DIAGNOSTIC_OMISSION]);

    const unterminated = new StreamingDiagnosticLineRedactor([firstKey]);
    expect(unterminated.push(`prefix-${firstKey.slice(0, 12)}`)).toEqual([]);
    expect(unterminated.finish()).toEqual([
      STREAMING_DIAGNOSTIC_UNTERMINATED_OMISSION,
    ]);
  });

  it("neutralizes control-character log injection in arguments", () => {
    const redacted = redactStreamingDiagnosticArguments([
      "safe-prefix\nforged-diagnostic\rsafe-suffix",
    ])[0];

    expect(redacted).toBe("safe-prefix forged-diagnostic safe-suffix");
  });
});
