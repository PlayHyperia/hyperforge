import { StringDecoder } from "node:string_decoder";

function stripTokenFromSegment(segment: string): string {
  return segment
    .split("&")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith("streamToken="))
    .join("&");
}

export const STREAMING_DIAGNOSTIC_REDACTION = "***REDACTED***";
export const STREAMING_DIAGNOSTIC_OMISSION =
  "[streaming diagnostic omitted: line exceeded the safe buffer]";
export const STREAMING_DIAGNOSTIC_UNTERMINATED_OMISSION =
  "[streaming diagnostic omitted: unterminated line]";
export const DEFAULT_STREAMING_DIAGNOSTIC_BUFFER_CHARS = 8 * 1024;

const RTMP_URL_PATTERN = /\brtmps?:\/\/[^\s|'"<>]+/giu;
const ESCAPED_RTMP_URL_PATTERN = /\brtmps?\\:\/\/[^\s|'"<>]+/giu;
const SENSITIVE_PARAMETER_PATTERN =
  /([?&#](?:access[_-]?token|key|sig|signature|stream[_-]?key|streamToken|token)=)[^&#\s|'"<>]+/giu;

function normalizeDiagnosticLimit(rawLimit: number): number {
  return Number.isFinite(rawLimit)
    ? Math.max(64, Math.floor(rawLimit))
    : DEFAULT_STREAMING_DIAGNOSTIC_BUFFER_CHARS;
}

function replaceAllLiteral(
  value: string,
  needle: string,
  replacement: string,
): string {
  return needle ? value.split(needle).join(replacement) : value;
}

function addSensitiveVariant(variants: Set<string>, rawValue: string): void {
  if (!rawValue) return;
  variants.add(rawValue);
  variants.add(
    rawValue.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/\|/g, "\\|"),
  );
  try {
    variants.add(encodeURIComponent(rawValue));
  } catch {
    // Invalid surrogate input cannot be URI encoded; its literal form remains covered.
  }
}

function sensitiveVariants(sensitiveValues: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const value of sensitiveValues) {
    const rawValue = String(value ?? "");
    addSensitiveVariant(variants, rawValue);
    try {
      // FFmpeg may report a configured percent-encoded key in decoded form.
      addSensitiveVariant(
        variants,
        decodeURIComponent(rawValue.replace(/\+/g, " ")),
      );
    } catch {
      // Invalid percent encoding remains covered by its literal form.
    }
    for (const line of rawValue.split(/\r?\n|\r/u)) {
      addSensitiveVariant(variants, line);
    }
  }
  return [...variants].filter(Boolean).sort((a, b) => b.length - a.length);
}

/**
 * Redact credentials from one complete diagnostic value. Known values cover
 * keys echoed without a URL; the protocol/parameter passes cover normalized
 * forms emitted by FFmpeg itself.
 */
export function redactStreamingDiagnosticText(
  rawText: string,
  sensitiveValues: readonly string[] = [],
  maxOutputChars: number = DEFAULT_STREAMING_DIAGNOSTIC_BUFFER_CHARS,
): string {
  const boundedMax = normalizeDiagnosticLimit(maxOutputChars);
  let redacted = String(rawText ?? "");
  for (const sensitiveValue of sensitiveVariants(sensitiveValues)) {
    redacted = replaceAllLiteral(
      redacted,
      sensitiveValue,
      STREAMING_DIAGNOSTIC_REDACTION,
    );
  }
  redacted = redacted
    .replace(RTMP_URL_PATTERN, `rtmp://${STREAMING_DIAGNOSTIC_REDACTION}`)
    .replace(
      ESCAPED_RTMP_URL_PATTERN,
      `rtmp\\://${STREAMING_DIAGNOSTIC_REDACTION}`,
    )
    .replace(SENSITIVE_PARAMETER_PATTERN, `$1${STREAMING_DIAGNOSTIC_REDACTION}`)
    // Arguments are joined into one log line, so remove control characters
    // (including CR/LF) that could otherwise forge a separate unredacted line.
    .replace(/[\u0000-\u001f\u007f]/gu, " ");

  if (redacted.length <= boundedMax) return redacted;
  return `${redacted.slice(0, boundedMax)}...[streaming diagnostic truncated]`;
}

export function redactStreamingDiagnosticArguments(
  args: readonly string[],
  sensitiveValues: readonly string[] = [],
): string[] {
  return args.map((arg) => redactStreamingDiagnosticText(arg, sensitiveValues));
}

/**
 * Holds incomplete FFmpeg lines until a CR/LF boundary is available. Nothing
 * from an incomplete line is returned to callers, so a credential split across
 * arbitrary child-process chunks cannot be logged. Oversized and unterminated
 * lines are replaced by fixed messages rather than partially emitted.
 */
export class StreamingDiagnosticLineRedactor {
  private pending = "";
  private droppingOversizedLine = false;
  private readonly maxBufferedChars: number;
  private readonly decoder = new StringDecoder("utf8");

  constructor(
    private readonly sensitiveValues: readonly string[] = [],
    maxBufferedChars: number = DEFAULT_STREAMING_DIAGNOSTIC_BUFFER_CHARS,
  ) {
    this.maxBufferedChars = normalizeDiagnosticLimit(maxBufferedChars);
  }

  get bufferedChars(): number {
    return this.pending.length;
  }

  push(rawChunk: string | Uint8Array): string[] {
    const chunk =
      typeof rawChunk === "string"
        ? rawChunk
        : this.decoder.write(Buffer.from(rawChunk));
    const lines: string[] = [];
    let cursor = 0;

    while (cursor < chunk.length) {
      let delimiterIndex = -1;
      for (let index = cursor; index < chunk.length; index += 1) {
        const code = chunk.charCodeAt(index);
        if (code === 10 || code === 13) {
          delimiterIndex = index;
          break;
        }
      }
      const pieceEnd = delimiterIndex < 0 ? chunk.length : delimiterIndex;
      const piece = chunk.slice(cursor, pieceEnd);

      if (!this.droppingOversizedLine) {
        if (this.pending.length + piece.length > this.maxBufferedChars) {
          this.pending = "";
          this.droppingOversizedLine = true;
        } else {
          this.pending += piece;
        }
      }

      if (delimiterIndex < 0) break;
      if (this.droppingOversizedLine) {
        lines.push(STREAMING_DIAGNOSTIC_OMISSION);
      } else if (this.pending.trim()) {
        lines.push(
          redactStreamingDiagnosticText(
            this.pending.trim(),
            this.sensitiveValues,
            this.maxBufferedChars,
          ),
        );
      }
      this.pending = "";
      this.droppingOversizedLine = false;

      cursor = delimiterIndex + 1;
      if (
        chunk.charCodeAt(delimiterIndex) === 13 &&
        chunk.charCodeAt(cursor) === 10
      ) {
        cursor += 1;
      }
    }

    return lines;
  }

  finish(): string[] {
    const decoderRemainder = this.decoder.end();
    const hadTrailingData =
      this.droppingOversizedLine ||
      this.pending.length > 0 ||
      decoderRemainder.length > 0;
    this.pending = "";
    this.droppingOversizedLine = false;
    return hadTrailingData ? [STREAMING_DIAGNOSTIC_UNTERMINATED_OMISSION] : [];
  }
}

export function redactStreamingSecretsFromUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.delete("streamToken");
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
    hashParams.delete("streamToken");
    const normalizedHash = hashParams.toString();
    url.hash = normalizedHash ? `#${normalizedHash}` : "";
    return url.toString();
  } catch {
    const hashIndex = rawUrl.indexOf("#");
    const baseWithQuery = hashIndex >= 0 ? rawUrl.slice(0, hashIndex) : rawUrl;
    const rawHash = hashIndex >= 0 ? rawUrl.slice(hashIndex + 1) : "";
    const queryIndex = baseWithQuery.indexOf("?");
    const base =
      queryIndex >= 0 ? baseWithQuery.slice(0, queryIndex) : baseWithQuery;
    const rawQuery = queryIndex >= 0 ? baseWithQuery.slice(queryIndex + 1) : "";
    const sanitizedQuery = stripTokenFromSegment(rawQuery);
    const sanitizedHash = stripTokenFromSegment(rawHash);

    return `${base}${sanitizedQuery ? `?${sanitizedQuery}` : ""}${sanitizedHash ? `#${sanitizedHash}` : ""}`;
  }
}
