/**
 * RTMP Bridge Server
 *
 * Receives video chunks from browser via WebSocket and pipes them
 * to FFmpeg for encoding and multi-destination RTMP streaming.
 *
 * Architecture:
 *   Browser (MediaRecorder) → WebSocket → This Server → FFmpeg → Multiple RTMP endpoints
 *
 * Uses FFmpeg's tee muxer to send one encoded stream to multiple destinations
 * efficiently (single encode, multiple outputs).
 */

import { spawn, exec, execSync, type ChildProcess } from "child_process";
import fs from "node:fs";
import type { Writable } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type {
  RTMPDestination,
  StreamingConfig,
  StreamingStatus,
  DestinationStatus,
} from "./types.js";
import { DEFAULT_STREAMING_CONFIG } from "./types.js";
import {
  mediaSpawnErrorCode,
  resolveMediaExecutable,
} from "./media-runtime.mjs";
import {
  isStreamDestinationEnabled,
  resolveEnabledStreamDestinations,
} from "./stream-destinations.js";
import {
  redactStreamingDiagnosticArguments,
  StreamingDiagnosticLineRedactor,
} from "./redactStreamingUrl.js";

export const STREAM_AUDIO_SAMPLE_RATE_HZ = 48_000;

function parseEnvInt(
  rawValue: string | undefined,
  fallback: number,
  minValue: number,
): number {
  const parsed = Number.parseInt(rawValue || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minValue, parsed);
}

function toEvenDimension(value: number): number {
  const clamped = Math.max(2, value);
  return clamped % 2 === 0 ? clamped : clamped - 1;
}

export function buildCdpMjpegInputArgs(fps: number): string[] {
  return [
    "-thread_queue_size",
    "1024",
    "-f",
    "mjpeg",
    "-framerate",
    String(fps),
    "-i",
    "pipe:0",
  ];
}

export function resolveBrowserAudioMaxBufferMs(
  rawValue: string | undefined,
): number {
  const parsed = Number.parseInt(rawValue || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 2_000;
  return Math.min(10_000, Math.max(50, parsed));
}

const SPECTATOR_MAX_BUFFERED_BYTES = parseEnvInt(
  process.env.STREAM_SPECTATOR_MAX_BUFFERED_BYTES,
  8 * 1024 * 1024,
  128 * 1024,
);

export class RTMPBridge {
  private wss: WebSocketServer | null = null;
  private spectatorWss: WebSocketServer | null = null;
  private ffmpeg: ChildProcess | null = null;
  private client: WebSocket | null = null;
  private spectatorClients: Set<WebSocket> = new Set();
  /** Cached fMP4 init segment (moov atom) — required for late joiners */
  private fmp4InitSegment: Buffer | null = null;
  private destinations: RTMPDestination[] = [];
  private config: StreamingConfig;
  private status: StreamingStatus;
  private readonly ffmpegCommand: string;
  private bytesReceived: number = 0;
  private startTime: number = 0;

  /** FFmpeg crash recovery state */
  private ffmpegRestartAttempts: number = 0;
  private lastFFmpegCrash: number = 0;
  private ffmpegRestartTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Health monitoring interval */
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  /** Last data received timestamp for health monitoring */
  private lastDataReceived: number = 0;
  /** Whether outputs have been loaded from environment */
  private outputsInitialized = false;
  /** Whether this bridge is in CDP direct mode (no WebSocket) */
  private cdpDirectMode = false;
  /** Frame counter for CDP direct mode */
  private directFrameCount = 0;
  /** Number of frames dropped due to FFmpeg backpressure (CDP direct mode) */
  private droppedFrameCount = 0;
  /** Recent FFmpeg log lines for post-crash diagnostics */
  private ffmpegLogTail: string[] = [];
  /** Whether FFmpeg stdin is currently backpressured */
  private ffmpegBackpressured = false;
  /** Whether the dedicated browser PCM pipe is currently backpressured. */
  private browserAudioBackpressured = false;
  private browserAudioInput: { sampleRate: number; channels: 2 } | null = null;
  private lastBrowserAudioData = 0;
  private browserAudioChunkCount = 0;
  private browserAudioDroppedChunkCount = 0;
  private browserAudioTrimmedChunkCount = 0;
  private browserAudioWriteChain: Promise<void> = Promise.resolve();
  /** Stable origin used to keep local HLS timestamps monotonic across FFmpeg respawns. */
  private hlsTimelineStartedAt: number | null = null;
  private encoderCrashExitScheduled = false;
  private encoderReadyWaiters = new Set<(ready: boolean) => void>();
  private directEncoderRestartHandler: (() => void) | null = null;
  /** Whether client socket reads are paused due to FFmpeg backpressure */
  private clientSocketPaused = false;

  /** Placeholder frame buffer (JPEG) for idle periods */
  private placeholderFrame: Buffer | null = null;
  /** Timer for feeding placeholder frames */
  private placeholderInterval: ReturnType<typeof setInterval> | null = null;
  /** Whether we're currently in placeholder mode (no live frames) */
  private inPlaceholderMode = false;
  /** Timeout before switching to placeholder mode (ms) */
  private static readonly PLACEHOLDER_TIMEOUT = 5000;
  /** Whether placeholder mode is enabled */
  private placeholderEnabled = false;

  /** Maximum restart attempts before giving up */
  private static readonly MAX_RESTART_ATTEMPTS = 8;

  /** Base delay for exponential backoff (ms) */
  private static readonly BASE_RESTART_DELAY = 1000;

  /** Maximum delay between restart attempts (ms) */
  private static readonly MAX_RESTART_DELAY = 60000;

  /** Health check interval (ms) - check every 5s for faster detection */
  private static readonly HEALTH_CHECK_INTERVAL = 5000;

  /** Timeout for no data before considering unhealthy (ms) - reduced to 15s */
  private static readonly DATA_TIMEOUT = 15000;
  /** Number of FFmpeg log lines to keep in memory */
  private static readonly FFMPEG_LOG_TAIL_LINES = 40;

  constructor(config: Partial<StreamingConfig> = {}) {
    const envConfig: Partial<StreamingConfig> = {
      width: toEvenDimension(
        parseEnvInt(
          process.env.STREAM_OUTPUT_WIDTH || process.env.STREAM_CAPTURE_WIDTH,
          DEFAULT_STREAMING_CONFIG.width,
          2,
        ),
      ),
      height: toEvenDimension(
        parseEnvInt(
          process.env.STREAM_OUTPUT_HEIGHT || process.env.STREAM_CAPTURE_HEIGHT,
          DEFAULT_STREAMING_CONFIG.height,
          2,
        ),
      ),
      fps: parseEnvInt(process.env.STREAM_FPS, DEFAULT_STREAMING_CONFIG.fps, 1),
      videoBitrate: parseEnvInt(
        process.env.STREAM_VIDEO_BITRATE_KBPS ||
          process.env.STREAM_VIDEO_BITRATE,
        DEFAULT_STREAMING_CONFIG.videoBitrate,
        250,
      ),
      audioBitrate: parseEnvInt(
        process.env.STREAM_AUDIO_BITRATE_KBPS ||
          process.env.STREAM_AUDIO_BITRATE,
        DEFAULT_STREAMING_CONFIG.audioBitrate,
        32,
      ),
      gopSize: parseEnvInt(
        process.env.STREAM_GOP_SIZE,
        DEFAULT_STREAMING_CONFIG.gopSize,
        15,
      ),
    };

    this.config = { ...DEFAULT_STREAMING_CONFIG, ...envConfig, ...config };
    this.config.width = toEvenDimension(this.config.width);
    this.config.height = toEvenDimension(this.config.height);
    this.status = {
      active: false,
      destinations: [],
      ffmpegRunning: false,
      clientConnected: false,
      audioSource: "uninitialized",
      audioHealthy: false,
      audioLastChunkAt: null,
      audioChunks: 0,
      audioDroppedChunks: 0,
      audioTrimmedChunks: 0,
    };
    this.ffmpegCommand = resolveMediaExecutable({ tool: "ffmpeg" }).path;
    console.log(`[RTMPBridge] Using FFmpeg command: ${this.ffmpegCommand}`);
    console.log(
      `[RTMPBridge] Stream profile: ${this.config.width}x${this.config.height}@${this.config.fps}fps, GOP=${this.config.gopSize}, ${this.config.videoBitrate}k video / ${this.config.audioBitrate}k audio`,
    );

    // Initialize placeholder mode from environment
    this.placeholderEnabled = RTMPBridge.parseEnvBool(
      process.env.STREAM_PLACEHOLDER_ENABLED,
      false,
    );
    if (this.placeholderEnabled) {
      this.initializePlaceholderFrame();
      console.log("[RTMPBridge] Placeholder mode enabled for idle periods");
    }
  }

  /**
   * Initialize the placeholder frame buffer.
   * Creates a simple dark gray JPEG image to send during idle periods.
   */
  private initializePlaceholderFrame(): void {
    // Create a minimal valid JPEG image (dark gray)
    // This is a hand-crafted minimal JPEG that's ~300 bytes
    // Using a procedural approach to avoid external dependencies
    this.placeholderFrame = this.generatePlaceholderJpeg();
    console.log(
      `[RTMPBridge] Placeholder frame initialized (${this.placeholderFrame?.length || 0} bytes)`,
    );
  }

  /**
   * Generate a minimal placeholder JPEG image.
   * Creates a solid dark gray frame to keep the stream alive.
   */
  private generatePlaceholderJpeg(): Buffer {
    // Minimal JPEG header for a 16x16 dark gray image
    // This is much smaller than generating a full-size frame
    // FFmpeg will scale it to the output size
    const minimalJpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
      0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
      0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
      0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
      0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
      0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
      0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10,
      0x00, 0x10, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
      0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
      0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
      0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d,
      0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
      0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
      0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
      0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
      0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
      0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
      0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
      0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
      0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
      0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
      0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
      0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
      0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
      0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01,
      0x00, 0x00, 0x3f, 0x00, 0xfb, 0xd5, 0xdb, 0x20, 0xa8, 0xaa, 0x1e, 0xc9,
      0x19, 0x52, 0x47, 0x0c, 0x8a, 0xb8, 0xf4, 0xeb, 0x99, 0x86, 0x00, 0x70,
      0xcd, 0x9a, 0x00, 0xff, 0xd9,
    ]);
    return minimalJpeg;
  }

  /**
   * Start the placeholder frame interval.
   * Sends placeholder frames at the configured FPS when in placeholder mode.
   */
  private startPlaceholderMode(): void {
    if (!this.placeholderEnabled || !this.placeholderFrame) return;
    if (this.placeholderInterval) return; // Already running

    this.inPlaceholderMode = true;
    const frameInterval = Math.round(1000 / this.config.fps);

    console.log(
      `[RTMPBridge] Entering placeholder mode (${this.config.fps}fps)`,
    );

    this.placeholderInterval = setInterval(() => {
      if (this.placeholderFrame && this.ffmpeg?.stdin?.writable) {
        this.writeToFfmpeg(this.placeholderFrame);
      }
    }, frameInterval);
  }

  /**
   * Stop the placeholder frame interval.
   * Called when live frames resume.
   */
  private stopPlaceholderMode(): void {
    if (this.placeholderInterval) {
      clearInterval(this.placeholderInterval);
      this.placeholderInterval = null;
    }
    if (this.inPlaceholderMode) {
      console.log(
        "[RTMPBridge] Exiting placeholder mode (live frames resumed)",
      );
      this.inPlaceholderMode = false;
    }
  }

  private static parseEnvBool(
    raw: string | undefined,
    defaultValue: boolean = true,
  ): boolean {
    if (raw == null || raw === "") return defaultValue;
    return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
  }

  private static toRtmpUrl(input: string): string {
    const trimmed = input.trim();
    if (/^rtmps?:\/\//i.test(trimmed)) {
      return trimmed;
    }
    return `rtmp://${trimmed}`;
  }

  private static normalizeKickRtmpUrl(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) {
      return "rtmps://fa723fc1b171.global-contribute.live-video.net/app";
    }

    const legacyKickPattern =
      /^(?:rtmps?:\/\/)?ingest\.kick\.com\/live(?:\/([^/?#]+))?\/?$/i;
    const legacyMatch = trimmed.match(legacyKickPattern);
    if (legacyMatch) {
      const embeddedKey = legacyMatch[1]?.trim();
      const baseUrl =
        "rtmps://fa723fc1b171.global-contribute.live-video.net/app";
      return embeddedKey ? `${baseUrl}/${embeddedKey}` : baseUrl;
    }

    return RTMPBridge.toRtmpUrl(trimmed);
  }

  private static teeEscape(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/:/g, "\\:")
      .replace(/\|/g, "\\|");
  }

  private buildBridgeAudioInputArgs(
    browserAudioInput: { sampleRate: number; channels: 2 } | null = null,
  ): string[] {
    if (browserAudioInput) {
      this.status.audioSource = "browser";
      this.status.audioHealthy = false;
      console.log(
        `[RTMPBridge] Audio capture from browser master mix: ${browserAudioInput.sampleRate}Hz stereo PCM`,
      );
      return [
        "-thread_queue_size",
        "1024",
        "-use_wallclock_as_timestamps",
        "1",
        "-f",
        "f32le",
        "-ac",
        String(browserAudioInput.channels),
        "-ar",
        String(browserAudioInput.sampleRate),
        "-i",
        "pipe:3",
      ];
    }

    const audioEnabled = process.env.STREAM_AUDIO_ENABLED !== "false";
    const pulseDevice =
      process.env.PULSE_AUDIO_DEVICE || "chrome_audio.monitor";
    let usePulseAudio = audioEnabled && process.platform === "linux";

    if (usePulseAudio) {
      try {
        execSync("pactl info", { timeout: 2000, stdio: "pipe" });
        const sinks = execSync("pactl list short sinks", {
          timeout: 2000,
          stdio: "pipe",
        }).toString();
        if (!sinks.includes("chrome_audio")) {
          console.log(
            "[RTMPBridge] PulseAudio accessible but chrome_audio sink not found, falling back to silent audio",
          );
          usePulseAudio = false;
        }
      } catch {
        console.log(
          "[RTMPBridge] PulseAudio not accessible, falling back to silent audio",
        );
        usePulseAudio = false;
      }
    }

    if (usePulseAudio) {
      this.status.audioSource = "pulse";
      this.status.audioHealthy = true;
      console.log(`[RTMPBridge] Audio capture from PulseAudio: ${pulseDevice}`);
      return [
        "-thread_queue_size",
        "1024",
        "-use_wallclock_as_timestamps",
        "1",
        "-f",
        "pulse",
        "-ac",
        "2",
        "-ar",
        String(STREAM_AUDIO_SAMPLE_RATE_HZ),
        "-i",
        pulseDevice,
      ];
    }

    this.status.audioSource = "silent";
    this.status.audioHealthy = false;
    console.log(
      "[RTMPBridge] Audio: using bridge-managed silent source (anullsrc)",
    );
    return [
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=${STREAM_AUDIO_SAMPLE_RATE_HZ}:cl=stereo`,
    ];
  }

  private toBuffer(data: RawData): Buffer | null {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (Array.isArray(data)) {
      return Buffer.concat(data.map((chunk) => Buffer.from(chunk)));
    }
    if (typeof data === "string") return Buffer.from(data);
    return null;
  }

  private setClientBackpressurePaused(
    paused: boolean,
    ws: WebSocket | null = this.client,
  ): void {
    if (!ws) return;
    const socket = (
      ws as unknown as {
        _socket?: { pause?: () => void; resume?: () => void };
      }
    )._socket;
    if (!socket) return;

    if (paused && !this.clientSocketPaused) {
      socket.pause?.();
      this.clientSocketPaused = true;
    } else if (!paused && this.clientSocketPaused) {
      socket.resume?.();
      this.clientSocketPaused = false;
    }
  }

  private waitForDrain(stream: Writable, timeoutMs = 10_000): Promise<boolean> {
    if (
      !stream.writable ||
      stream.destroyed ||
      stream.writableEnded ||
      stream.writableFinished ||
      !stream.writableNeedDrain
    ) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        stream.off("drain", onDrain);
        stream.off("error", onError);
        stream.off("close", onClose);
        resolve(ready);
      };
      const onDrain = () => finish(true);
      const onError = () => finish(false);
      const onClose = () => finish(false);
      const timeoutId = setTimeout(() => finish(false), timeoutMs);
      timeoutId.unref?.();
      stream.once("drain", onDrain);
      stream.once("error", onError);
      stream.once("close", onClose);
      if (!stream.writableNeedDrain) void Promise.resolve().then(onDrain);
    });
  }

  private waitForEncoderReady(timeoutMs = 15_000): Promise<boolean> {
    const activeInput = this.ffmpeg?.stdin;
    if (activeInput?.writable && !activeInput.destroyed) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        this.encoderReadyWaiters.delete(finish);
        resolve(ready);
      };
      const timeoutId = setTimeout(() => finish(false), timeoutMs);
      timeoutId.unref?.();
      this.encoderReadyWaiters.add(finish);
    });
  }

  private resolveEncoderReadyWaiters(ready: boolean): void {
    for (const waiter of [...this.encoderReadyWaiters]) waiter(ready);
  }

  /** Register CDP-owned recovery work that must run after FFmpeg respawns. */
  setDirectEncoderRestartHandler(handler: (() => void) | null): void {
    this.directEncoderRestartHandler = handler;
  }

  /**
   * Write encoded media into FFmpeg stdin with backpressure handling.
   * In CDP direct mode we drop frames when backpressured to preserve low latency.
   */
  private writeToFfmpeg(data: Buffer, sourceWs?: WebSocket): boolean {
    if (!this.ffmpeg?.stdin?.writable) return false;

    // CDP direct mode has no transport-level pause control, so drop when backed up.
    if (this.ffmpegBackpressured && !sourceWs) {
      this.droppedFrameCount++;
      return false;
    }

    if (this.ffmpegBackpressured && sourceWs) {
      this.setClientBackpressurePaused(true, sourceWs);
    }

    try {
      const writable = this.ffmpeg.stdin.write(data);
      if (!writable) {
        this.ffmpegBackpressured = true;
        this.setClientBackpressurePaused(true, sourceWs);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load RTMP destinations from environment variables
   * Adds to any manually configured destinations
   */
  loadDestinationsFromEnv(): void {
    // Keep any manually added destinations, just add from env
    const existingNames = new Set(this.destinations.map((d) => d.name));
    const enabledDestinations = resolveEnabledStreamDestinations(
      process.env.STREAM_ENABLED_DESTINATIONS ||
        process.env.DUEL_STREAM_DESTINATIONS,
    );
    const twitchStreamKey = (
      process.env.TWITCH_STREAM_KEY ||
      process.env.TWITCH_RTMP_STREAM_KEY ||
      ""
    ).trim();
    const youtubeStreamKey = (
      process.env.YOUTUBE_STREAM_KEY ||
      process.env.YOUTUBE_RTMP_STREAM_KEY ||
      ""
    ).trim();
    const addDestination = (
      name: string,
      url: string,
      key: string = "",
      enabled: boolean = true,
    ) => {
      if (!url || existingNames.has(name)) return;
      this.destinations.push({ name, url, key, enabled });
      existingNames.add(name);
    };

    // Optional external multiplexer (Restream/livepeer/etc.)
    if (
      isStreamDestinationEnabled(enabledDestinations, "multiplexer") &&
      process.env.RTMP_MULTIPLEXER_URL &&
      !existingNames.has(
        process.env.RTMP_MULTIPLEXER_NAME || "RTMP Multiplexer",
      )
    ) {
      addDestination(
        process.env.RTMP_MULTIPLEXER_NAME || "RTMP Multiplexer",
        RTMPBridge.toRtmpUrl(process.env.RTMP_MULTIPLEXER_URL),
        process.env.RTMP_MULTIPLEXER_STREAM_KEY || "",
      );
    }

    // Twitch
    if (
      isStreamDestinationEnabled(enabledDestinations, "twitch") &&
      twitchStreamKey &&
      !existingNames.has("Twitch")
    ) {
      const server =
        process.env.TWITCH_STREAM_URL ||
        process.env.TWITCH_RTMP_URL ||
        process.env.TWITCH_RTMP_SERVER ||
        "live.twitch.tv/app";
      addDestination("Twitch", RTMPBridge.toRtmpUrl(server), twitchStreamKey);
    }

    // YouTube
    if (
      isStreamDestinationEnabled(enabledDestinations, "youtube") &&
      youtubeStreamKey &&
      !existingNames.has("YouTube")
    ) {
      const server =
        process.env.YOUTUBE_STREAM_URL ||
        process.env.YOUTUBE_RTMP_URL ||
        "rtmp://a.rtmp.youtube.com/live2";
      addDestination("YouTube", RTMPBridge.toRtmpUrl(server), youtubeStreamKey);
    }

    // Kick (uses RTMPS with regional ingest)
    const kickServer = RTMPBridge.normalizeKickRtmpUrl(
      process.env.KICK_RTMP_URL ||
        "rtmps://fa723fc1b171.global-contribute.live-video.net/app",
    );
    const kickStreamKey = process.env.KICK_STREAM_KEY?.trim() || "";
    const kickUrlHasEmbeddedKey = /\/(?:live|app)\/[^/]+/.test(kickServer);
    if (
      isStreamDestinationEnabled(enabledDestinations, "kick") &&
      (kickStreamKey || kickUrlHasEmbeddedKey) &&
      !existingNames.has("Kick")
    ) {
      addDestination("Kick", kickServer, kickStreamKey);
    }

    // Pump.fun (full URL provided)
    if (
      isStreamDestinationEnabled(enabledDestinations, "pumpfun") &&
      process.env.PUMPFUN_RTMP_URL &&
      !existingNames.has("Pump.fun")
    ) {
      addDestination(
        "Pump.fun",
        process.env.PUMPFUN_RTMP_URL,
        process.env.PUMPFUN_STREAM_KEY || "",
      );
    }

    // X/Twitter (full URL provided via Media Studio)
    if (
      isStreamDestinationEnabled(enabledDestinations, "x") &&
      process.env.X_RTMP_URL &&
      !existingNames.has("X/Twitter")
    ) {
      addDestination(
        "X/Twitter",
        process.env.X_RTMP_URL,
        process.env.X_STREAM_KEY || "",
      );
    }

    // Generic custom destination
    if (
      isStreamDestinationEnabled(enabledDestinations, "custom") &&
      process.env.CUSTOM_RTMP_URL &&
      !existingNames.has(process.env.CUSTOM_RTMP_NAME || "Custom")
    ) {
      addDestination(
        process.env.CUSTOM_RTMP_NAME || "Custom",
        process.env.CUSTOM_RTMP_URL,
        process.env.CUSTOM_STREAM_KEY || "",
      );
    }

    // Arbitrary fanout list (JSON array of { name, url, key?, enabled? })
    const destinationsJson = process.env.RTMP_DESTINATIONS_JSON;
    if (destinationsJson) {
      try {
        const parsed = JSON.parse(destinationsJson) as Array<{
          name?: string;
          url?: string;
          key?: string;
          enabled?: boolean | string;
        }>;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (!item?.name || !item?.url) continue;
            addDestination(
              item.name,
              RTMPBridge.toRtmpUrl(item.url),
              item.key || "",
              RTMPBridge.parseEnvBool(
                typeof item.enabled === "string"
                  ? item.enabled
                  : item.enabled == null
                    ? undefined
                    : String(item.enabled),
                true,
              ),
            );
          }
        }
      } catch (err) {
        console.warn(
          "[RTMPBridge] Failed to parse RTMP_DESTINATIONS_JSON:",
          err,
        );
      }
    }

    console.log(
      `[RTMPBridge] Loaded ${this.destinations.length} destinations:`,
      this.destinations.map((d) => d.name).join(", "),
    );
  }

  private enabledOutputCount(): number {
    return this.destinations.filter((d) => d.enabled).length;
  }

  private logFFmpegSpawnError(err: unknown): void {
    const code = mediaSpawnErrorCode(err);
    if (code === "ENOENT") {
      console.error(
        `[RTMPBridge] FFmpeg command not found: ${this.ffmpegCommand}. ` +
          "Install ffmpeg, set FFMPEG_PATH, or install optional dependency ffmpeg-static.",
      );
      return;
    }
    if (code === "EACCES") {
      console.error(
        `[RTMPBridge] FFmpeg is not executable: ${this.ffmpegCommand}. ` +
          "Fix file permissions or set FFMPEG_PATH to a valid ffmpeg binary.",
      );
      return;
    }
    // Spawn errors may contain the complete RTMP tee arguments and stream keys.
    console.error(`[RTMPBridge] FFmpeg spawn error: ${code}`);
  }

  private streamingDiagnosticSensitiveValues(): string[] {
    return this.destinations.flatMap((destination) => [
      destination.url,
      destination.key,
      destination.key ? `${destination.url}/${destination.key}` : "",
    ]);
  }

  private redactFFmpegArgumentsForLog(args: readonly string[]): string[] {
    return redactStreamingDiagnosticArguments(
      args,
      this.streamingDiagnosticSensitiveValues(),
    );
  }

  /**
   * Add a destination manually
   */
  addDestination(dest: RTMPDestination): void {
    this.destinations.push(dest);
  }

  /**
   * Initialize output destinations from environment
   * Called automatically by start() and startFFmpegDirect(), or manually.
   */
  initOutputs(): void {
    if (this.outputsInitialized) return;
    this.loadDestinationsFromEnv();
    this.outputsInitialized = true;

    if (this.enabledOutputCount() === 0) {
      console.warn(
        "[RTMPBridge] No RTMP outputs configured. Set environment variables.",
      );
    }
  }

  /**
   * Start the WebSocket server (legacy MediaRecorder mode)
   */
  start(port: number = 8765): void {
    if (this.wss) {
      console.warn("[RTMPBridge] Server already running");
      return;
    }

    this.initOutputs();

    // Graceful port handling to avoid EADDRINUSE
    const tryListen = (retries: number = 1) => {
      this.wss = new WebSocketServer({ port });

      this.wss.on("listening", () => {
        console.log(`[RTMPBridge] WebSocket server started on port ${port}`);
      });

      this.wss.on("connection", this.handleConnection.bind(this));

      this.wss.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && retries > 0) {
          console.warn(
            `[RTMPBridge] Port ${port} in use, killing stale process...`,
          );
          try {
            // Fire-and-forget port cleanup — does NOT block the event loop
            exec(`lsof -ti :${port} | xargs kill -9 2>/dev/null || true`, {
              timeout: 3000,
            });
          } catch {
            // Ignore — process may already be dead
          }
          this.wss?.close();
          this.wss = null;
          setTimeout(() => tryListen(retries - 1), 1500);
        } else {
          console.error("[RTMPBridge] WebSocket server error:", err);
        }
      });
    };

    tryListen();
  }

  /**
   * Await the actual WebSocket listener rather than treating construction as
   * startup success. This also observes the existing bounded EADDRINUSE retry.
   */
  async waitForServerReady(timeoutMs: number = 5_000): Promise<void> {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 60_000
    ) {
      throw new Error("rtmp_bridge_ready_timeout_invalid");
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (this.wss?.address() != null) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `RTMP bridge WebSocket listener did not become ready within ${timeoutMs}ms`,
    );
  }

  /**
   * Start the WebSocket server for WebCodecs mode
   * Expects raw H.264 NAL units (Annex B) and pipes them using -c:v copy
   */
  startWebCodecs(port: number = 8765): void {
    if (this.wss) {
      console.warn("[RTMPBridge] Server already running");
      return;
    }

    this.initOutputs();

    const tryListen = (retries: number = 1) => {
      this.wss = new WebSocketServer({ port });

      this.wss.on("listening", () => {
        console.log(
          `[RTMPBridge] WebSocket server started (WebCodecs mode) on port ${port}`,
        );
      });

      this.wss.on("connection", this.handleWebCodecsConnection.bind(this));

      this.wss.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && retries > 0) {
          console.warn(
            `[RTMPBridge] Port ${port} in use, killing stale process...`,
          );
          try {
            exec(`lsof -ti :${port} | xargs kill -9 2>/dev/null || true`, {
              timeout: 3000,
            });
          } catch {}
          this.wss?.close();
          this.wss = null;
          setTimeout(() => tryListen(retries - 1), 1500);
        } else {
          console.error("[RTMPBridge] WebSocket server error:", err);
        }
      });
    };

    tryListen();
  }

  /**
   * Build video encoder args based on FFMPEG_HWACCEL env var.
   * Shared by startFFmpeg, startFFmpegDirect, and startFFmpegWebCodecs.
   */
  private buildVideoEncoderArgs(): string[] {
    const hwAccel = process.env.FFMPEG_HWACCEL || "auto";
    let encoder = "libx264";

    if (
      hwAccel === "mac" ||
      (hwAccel === "auto" && process.platform === "darwin")
    ) {
      encoder = "h264_videotoolbox";
    } else if (hwAccel === "nvidia") {
      encoder = "h264_nvenc";
    }

    const maxrate = Math.floor(this.config.videoBitrate * 1.1); // 10% overhead for VBR spikes
    const bufsize = this.config.videoBitrate * 2; // 2 seconds of buffering to absorb network jitter

    if (encoder === "h264_videotoolbox") {
      return [
        "-c:v",
        "h264_videotoolbox",
        "-realtime",
        "1",
        "-b:v",
        `${this.config.videoBitrate}k`,
        "-maxrate",
        `${maxrate}k`,
        "-bufsize",
        `${bufsize}k`,
        "-pix_fmt",
        "yuv420p",
        "-g",
        String(this.config.gopSize),
      ];
    } else if (encoder === "h264_nvenc") {
      return [
        "-c:v",
        "h264_nvenc",
        "-preset",
        "p3",
        "-tune",
        "ll",
        "-b:v",
        `${this.config.videoBitrate}k`,
        "-maxrate",
        `${maxrate}k`,
        "-bufsize",
        `${bufsize}k`,
        "-pix_fmt",
        "yuv420p",
        "-g",
        String(this.config.gopSize),
      ];
    }

    // Default to zerolatency for live streaming — eliminates B-frame buffering
    // delay and encoder lookahead that cause visible judder. Use film only when
    // STREAM_LOW_LATENCY=false is explicitly set (e.g. for VOD recording).
    const useHighLatency = /^(0|false|no)$/i.test(
      process.env.STREAM_LOW_LATENCY || "",
    );
    const tune = useHighLatency ? "film" : "zerolatency";

    return [
      "-c:v",
      "libx264",
      "-preset",
      this.config.preset,
      "-tune",
      tune,
      "-b:v",
      `${this.config.videoBitrate}k`,
      "-maxrate",
      `${maxrate}k`,
      "-bufsize",
      `${bufsize}k`,
      "-pix_fmt",
      "yuv420p",
      "-g",
      String(this.config.gopSize),
      // B-frames add latency — only use for VOD/recording mode
      ...(useHighLatency ? ["-bf", "2"] : []),
    ];
  }

  /**
   * Build common audio codec + global_header args.
   */
  private buildAudioArgs(): string[] {
    return [
      // Audio filter: async resample to recover from timing drift
      // async=1000 means resample if audio drifts more than 1000 samples
      // (20.8ms at 48kHz).
      // This prevents audio dropouts when video/audio streams desync
      "-af",
      "aresample=async=1000:first_pts=0",
      "-c:a",
      "aac",
      "-b:a",
      `${this.config.audioBitrate}k`,
      "-ar",
      String(STREAM_AUDIO_SAMPLE_RATE_HZ),
      "-flags",
      "+global_header",
    ];
  }

  private buildOutputVideoFilter(resetPts: boolean = false): string {
    const outputWidth = Math.max(
      2,
      this.config.width - (this.config.width % 2),
    );
    const outputHeight = Math.max(
      2,
      this.config.height - (this.config.height % 2),
    );
    const filters = resetPts ? ["setpts=PTS-STARTPTS"] : [];
    filters.push(
      `scale=${outputWidth}:${outputHeight}:flags=lanczos`,
      "format=yuv420p",
    );
    return filters.join(",");
  }

  /**
   * Common FFmpeg post-spawn setup: status init, event handlers, health monitoring.
   * @param label - Log label for this FFmpeg mode (e.g. "CDP direct", "WebCodecs")
   * @param shouldRestartOnCrash - Called on non-zero exit to decide whether to restart
   */
  private setupFFmpegHandlers(
    label: string,
    shouldRestartOnCrash: () => boolean,
  ): void {
    if (!this.ffmpeg) return;

    this.ffmpegBackpressured = false;
    this.setClientBackpressurePaused(false);
    this.ffmpegLogTail = [];

    this.startTime = Date.now();
    this.status.active = true;
    this.status.ffmpegRunning = true;
    this.resolveEncoderReadyWaiters(true);
    this.status.startedAt = this.startTime;

    this.status.destinations = this.destinations
      .filter((d) => d.enabled)
      .map((d) => ({
        name: d.name,
        connected: true,
        bytesWritten: 0,
        startedAt: this.startTime,
      }));

    const diagnosticSensitiveValues = this.streamingDiagnosticSensitiveValues();
    const stdoutDiagnostics = new StreamingDiagnosticLineRedactor(
      diagnosticSensitiveValues,
    );
    const stderrDiagnostics = new StreamingDiagnosticLineRedactor(
      diagnosticSensitiveValues,
    );
    let diagnosticsFinished = false;
    const recordStderrLine = (line: string) => {
      this.ffmpegLogTail.push(line);
      if (this.ffmpegLogTail.length > RTMPBridge.FFMPEG_LOG_TAIL_LINES) {
        this.ffmpegLogTail = this.ffmpegLogTail.slice(
          -RTMPBridge.FFMPEG_LOG_TAIL_LINES,
        );
      }
      if (!line.includes("frame=") && !line.includes("fps=")) {
        console.log("[FFmpeg]", line);
      }
    };
    const finishDiagnostics = () => {
      if (diagnosticsFinished) return;
      diagnosticsFinished = true;
      for (const line of stdoutDiagnostics.finish()) {
        console.log("[FFmpeg stdout]", line);
      }
      for (const line of stderrDiagnostics.finish()) {
        recordStderrLine(line);
      }
    };

    this.ffmpeg.stdout?.on("data", (data) => {
      for (const line of stdoutDiagnostics.push(data)) {
        console.log("[FFmpeg stdout]", line);
      }
    });

    this.ffmpeg.stderr?.on("data", (data) => {
      const msg = data.toString();
      for (const line of stderrDiagnostics.push(data)) recordStderrLine(line);
      // Internal progress/destination parsing intentionally receives the raw
      // bytes. Only redacted, complete lines may reach logs, retained tails,
      // or public status.
      this.parseFFmpegOutput(msg);
    });

    this.ffmpeg.on("close", (code, signal) => {
      finishDiagnostics();
      console.log(
        `[RTMPBridge] FFmpeg${label ? ` (${label})` : ""} exited with code=${code ?? "null"} signal=${signal ?? "null"}`,
      );
      this.ffmpeg = null;
      this.status.ffmpegRunning = false;
      this.status.active = false;

      if ((code !== 0 || signal != null) && this.ffmpegLogTail.length > 0) {
        console.warn(
          `[RTMPBridge] FFmpeg error tail before exit: ${this.ffmpegLogTail.join(" | ")}`,
        );
      }

      if ((code !== 0 || signal != null) && shouldRestartOnCrash()) {
        this.handleEncoderFailure(code);
      }
    });

    this.ffmpeg.on("error", (err) => {
      finishDiagnostics();
      this.logFFmpegSpawnError(err);
      this.ffmpeg = null;
      this.status.ffmpegRunning = false;

      if (shouldRestartOnCrash()) {
        this.handleEncoderFailure(-1);
      }
    });

    this.startHealthMonitoring();

    this.ffmpeg.stdin?.on("drain", () => {
      this.ffmpegBackpressured = false;
      this.setClientBackpressurePaused(false);
    });

    this.ffmpeg.stdin?.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "EPIPE") {
        console.error("[RTMPBridge] FFmpeg stdin error:", err);
      }
    });
  }

  /**
   * Start FFmpeg in CDP direct mode (JPEG frame piping, no WebSocket required)
   *
   * Use `feedFrame(buffer)` to send individual JPEG frames.
   * This is much faster than the legacy MediaRecorder→WebSocket path
   * because there's only one encode step (JPEG→H.264) instead of two
   * (VP8/VP9→H.264).
   */
  startFFmpegDirect(options?: {
    browserAudioInput?: { sampleRate: number; channels: 2 } | null;
  }): void {
    if (this.ffmpeg) {
      console.warn("[RTMPBridge] FFmpeg already running");
      return;
    }

    this.initOutputs();
    this.cdpDirectMode = true;
    this.directFrameCount = 0;
    this.droppedFrameCount = 0;
    if (options && "browserAudioInput" in options) {
      this.browserAudioInput = options.browserAudioInput ?? null;
    }
    this.lastBrowserAudioData = 0;
    this.browserAudioChunkCount = 0;
    this.browserAudioDroppedChunkCount = 0;
    this.browserAudioTrimmedChunkCount = 0;
    this.browserAudioBackpressured = false;

    const outputString = this.buildOutputString();
    const isNullOutput = outputString === "-f null -";

    // Default to low-latency for live streaming. Only use high-latency buffered
    // mode when STREAM_LOW_LATENCY=false is explicitly set.
    const useHighLatency = /^(0|false|no)$/i.test(
      process.env.STREAM_LOW_LATENCY || "",
    );

    // FFmpeg args for JPEG frame piping (mjpeg → H.264)
    const args: string[] = useHighLatency
      ? [
          // Buffered input flags for VOD/recording
          "-fflags",
          "+genpts+discardcorrupt",
          "-thread_queue_size",
          "512",
        ]
      : [
          // Low-latency input flags for live streaming
          "-fflags",
          "nobuffer",
          "-flags",
          "low_delay",
        ];

    // Input: JPEG frames piped via stdin. The MJPEG demuxer's declared
    // framerate is the canonical video clock. Applying wall-clock timestamps
    // here converts harmless arrival jitter into FFmpeg duplicate/drop churn;
    // browser audio keeps its independent wall-clock input and bounded async
    // resampling below.
    args.push(...buildCdpMjpegInputArgs(this.config.fps));
    args.push(...this.buildBridgeAudioInputArgs(this.browserAudioInput));

    // Map video from pipe and audio from PulseAudio/anullsrc
    args.push("-map", "0:v:0", "-map", "1:a:0");

    // Force output frame rate
    args.push("-r", String(this.config.fps));

    args.push("-vf", this.buildOutputVideoFilter(true));

    // Video encoder
    args.push(...this.buildVideoEncoderArgs());

    args.push(...this.buildAudioArgs());

    if (isNullOutput) {
      args.push("-f", "null", "-");
    } else {
      args.push("-f", "tee", outputString);
    }

    const redactedCdpArgs = this.redactFFmpegArgumentsForLog(args);
    console.log(
      "[RTMPBridge] Starting FFmpeg (CDP direct mode) with args:",
      redactedCdpArgs.join(" "),
    );

    this.ffmpeg = spawn(this.ffmpegCommand, args, {
      stdio: this.browserAudioInput
        ? ["pipe", "pipe", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe"],
    });

    this.ffmpegBackpressured = false;
    this.setClientBackpressurePaused(false);

    this.startTime = Date.now();
    this.status.active = true;
    this.status.ffmpegRunning = true;
    this.status.clientConnected = true; // CDP mode is always "connected"

    this.setupFFmpegHandlers("CDP direct", () => this.cdpDirectMode);

    const browserAudioPipe = this.ffmpeg.stdio[3];
    if (browserAudioPipe && "on" in browserAudioPipe) {
      browserAudioPipe.on("drain", () => {
        this.browserAudioBackpressured = false;
      });
      browserAudioPipe.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code !== "EPIPE") {
          console.error("[RTMPBridge] Browser audio pipe error:", err);
        }
      });
    }
  }

  /** Feed interleaved Float32 PCM from the canonical browser master mix. */
  async feedBrowserAudioPcm(pcmBuffer: Buffer): Promise<boolean> {
    const requestedAudioPipe = this.ffmpeg?.stdio[3] as
      Writable | null | undefined;
    let accepted = false;
    const write = this.browserAudioWriteChain.then(async () => {
      accepted = await this.writeBrowserAudioPcm(pcmBuffer, requestedAudioPipe);
    });
    this.browserAudioWriteChain = write.catch(() => undefined);
    await write;
    return accepted;
  }

  private async writeBrowserAudioPcm(
    pcmBuffer: Buffer,
    requestedAudioPipe: Writable | null | undefined,
  ): Promise<boolean> {
    let audioPipe = this.ffmpeg?.stdio[3] as Writable | null | undefined;
    if (
      audioPipe !== requestedAudioPipe ||
      !audioPipe?.writable ||
      audioPipe.destroyed ||
      audioPipe.writableEnded
    ) {
      // Do not retain PCM captured while the encoder is down. Replaying that
      // backlog into a replacement process compresses old samples into its new
      // wall-clock timeline and can stall FFmpeg's audio scheduler. The HLS
      // discontinuity already represents the outage; resume with the first
      // current sample after the new pipe exists.
      this.browserAudioDroppedChunkCount++;
      return false;
    }
    if (!this.browserAudioInput || typeof audioPipe.write !== "function") {
      return false;
    }
    const maxBufferedMs = resolveBrowserAudioMaxBufferMs(
      process.env.STREAM_BROWSER_AUDIO_MAX_BUFFER_MS,
    );
    // Respect Node's stream backpressure before accepting the next packet.
    // Browser binding calls and startup-buffer replay both enter through the
    // FIFO above, so this wait propagates naturally to the producer instead of
    // filling the child-process pipe until samples must be discarded. The
    // latency budget remains bounded: a pipe that cannot drain in time still
    // fails closed, and audio queued for an old encoder is never replayed into
    // its replacement.
    if (audioPipe.writableNeedDrain) {
      const drained = await this.waitForDrain(audioPipe, maxBufferedMs);
      const currentAudioPipe = this.ffmpeg?.stdio[3] as
        Writable | null | undefined;
      if (currentAudioPipe !== audioPipe) {
        this.browserAudioDroppedChunkCount++;
        return false;
      }
      if (!drained) {
        this.browserAudioTrimmedChunkCount++;
        return false;
      }
      audioPipe = currentAudioPipe;
      this.browserAudioBackpressured = false;
    }

    const bytesPerSecond =
      this.browserAudioInput.sampleRate *
      this.browserAudioInput.channels *
      Float32Array.BYTES_PER_ELEMENT;
    const maxBufferedBytes = Math.ceil((bytesPerSecond * maxBufferedMs) / 1000);
    if (audioPipe.writableLength + pcmBuffer.byteLength > maxBufferedBytes) {
      this.browserAudioTrimmedChunkCount++;
      return false;
    }
    try {
      const writable = audioPipe.write(pcmBuffer);
      this.lastBrowserAudioData = Date.now();
      this.browserAudioChunkCount++;
      this.browserAudioBackpressured = !writable;
      return true;
    } catch {
      this.browserAudioDroppedChunkCount++;
      return false;
    }
  }

  /**
   * Feed a single JPEG frame to FFmpeg (CDP direct mode)
   *
   * @param jpegBuffer - Raw JPEG image data
   * @returns true if frame was written, false if dropped
   */
  async feedFrame(jpegBuffer: Buffer): Promise<boolean> {
    let videoPipe = this.ffmpeg?.stdin;
    if (!videoPipe?.writable || videoPipe.destroyed) {
      const ready = await this.waitForEncoderReady();
      videoPipe = this.ffmpeg?.stdin;
      if (!ready || !videoPipe?.writable || videoPipe.destroyed) {
        this.droppedFrameCount++;
        return false;
      }
    }

    if (this.ffmpegBackpressured) {
      const ready = await this.waitForDrain(videoPipe);
      if (!ready) {
        const encoderReady = await this.waitForEncoderReady();
        videoPipe = this.ffmpeg?.stdin;
        if (!encoderReady || !videoPipe?.writable || videoPipe.destroyed) {
          this.droppedFrameCount++;
          return false;
        }
      }
      this.ffmpegBackpressured = false;
    }

    // Exit placeholder mode when live frames resume
    if (this.inPlaceholderMode) {
      this.stopPlaceholderMode();
    }

    this.bytesReceived += jpegBuffer.length;
    this.lastDataReceived = Date.now();
    this.directFrameCount++;

    return this.writeToFfmpeg(jpegBuffer);
  }

  /**
   * Get the current frame count (CDP direct mode)
   */
  getDirectFrameCount(): number {
    return this.directFrameCount;
  }

  /**
   * Stop processing (FFmpeg only) for browser rotation
   */
  stopProcessing(): void {
    if (this.ffmpegRestartTimeout) {
      clearTimeout(this.ffmpegRestartTimeout);
      this.ffmpegRestartTimeout = null;
    }
    this.stopHealthMonitoring();
    this.resolveEncoderReadyWaiters(false);
    this.stopFFmpeg();
  }

  /**
   * Stop the server and clean up
   */
  stop(): void {
    // Clear any pending restart timeout
    if (this.ffmpegRestartTimeout) {
      clearTimeout(this.ffmpegRestartTimeout);
      this.ffmpegRestartTimeout = null;
    }

    // Stop health monitoring
    this.stopHealthMonitoring();
    this.resolveEncoderReadyWaiters(false);

    this.stopFFmpeg();
    this.ffmpegBackpressured = false;
    this.setClientBackpressurePaused(false);

    if (this.client) {
      this.client.close();
      this.client = null;
    }

    if (this.wss) {
      // Remove all listeners before closing to prevent memory leaks
      this.wss.removeAllListeners("listening");
      this.wss.removeAllListeners("connection");
      this.wss.removeAllListeners("error");
      this.wss.close();
      this.wss = null;
    }

    if (this.spectatorWss) {
      // Remove all listeners before closing to prevent memory leaks
      this.spectatorWss.removeAllListeners("listening");
      this.spectatorWss.removeAllListeners("connection");
      this.spectatorWss.removeAllListeners("error");
      this.spectatorWss.close();
      this.spectatorWss = null;
    }
    // Clean up individual spectator WebSocket listeners
    for (const client of this.spectatorClients) {
      client.removeAllListeners("close");
      client.removeAllListeners("error");
      try {
        client.close();
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.spectatorClients.clear();
    this.fmp4InitSegment = null;
    this.ffmpegLogTail = [];

    // Reset restart state
    this.ffmpegRestartAttempts = 0;
    this.lastFFmpegCrash = 0;

    this.status.active = false;
    console.log("[RTMPBridge] Server stopped");
  }

  /**
   * Start the Spectator WebSocket Server for MSE zero-latency streaming
   */
  startSpectatorServer(port: number = 4180): void {
    if (this.spectatorWss) {
      console.warn("[RTMPBridge] Spectator server already running");
      return;
    }

    const tryListen = (retries: number = 1) => {
      this.spectatorWss = new WebSocketServer({ port });

      this.spectatorWss.on("listening", () => {
        console.log(
          `[RTMPBridge] Spectator WebSocket server started on port ${port} (MSE fMP4)`,
        );
      });

      this.spectatorWss.on("connection", (ws: WebSocket) => {
        console.log("[RTMPBridge] Spectator connected");
        this.spectatorClients.add(ws);

        // Send cached init segment so the browser can immediately start decoding
        if (this.fmp4InitSegment) {
          ws.send(this.fmp4InitSegment, { binary: true });
          console.log(
            `[RTMPBridge] Sent cached init segment (${this.fmp4InitSegment.length} bytes) to new spectator`,
          );
        }

        ws.on("close", () => {
          this.spectatorClients.delete(ws);
          console.log("[RTMPBridge] Spectator disconnected");
        });

        ws.on("error", (err) => {
          console.error("[RTMPBridge] Spectator error:", err);
          this.spectatorClients.delete(ws);
        });
      });

      this.spectatorWss.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && retries > 0) {
          console.warn(
            `[RTMPBridge] Spectator Port ${port} in use, killing stale process...`,
          );
          try {
            exec(`lsof -ti :${port} | xargs kill -9 2>/dev/null || true`, {
              timeout: 3000,
            });
          } catch {}
          this.spectatorWss?.close();
          this.spectatorWss = null;
          setTimeout(() => tryListen(retries - 1), 1500);
        } else {
          console.error("[RTMPBridge] Spectator server error:", err);
        }
      });
    };

    tryListen();
  }

  /**
   * Broadcast binary fMP4 chunks to all connected spectators.
   * Detects and caches the init segment (ftyp+moov) for late joiners.
   */
  private broadcastToSpectators(data: Buffer): void {
    // Detect init segment: fMP4 always starts with an 'ftyp' box
    // ftyp box signature: bytes 4-7 are "ftyp" (0x66747970)
    if (!this.fmp4InitSegment && data.length >= 8) {
      const boxType = data.toString("ascii", 4, 8);
      if (boxType === "ftyp") {
        this.fmp4InitSegment = Buffer.from(data);
        console.log(
          `[RTMPBridge] Cached fMP4 init segment (${data.length} bytes)`,
        );
      }
    }

    for (const client of [...this.spectatorClients]) {
      if (client.readyState !== WebSocket.OPEN) {
        this.spectatorClients.delete(client);
        continue;
      }
      if (client.bufferedAmount > SPECTATOR_MAX_BUFFERED_BYTES) {
        console.warn(
          `[RTMPBridge] Dropping slow spectator (buffered=${client.bufferedAmount} bytes)`,
        );
        this.spectatorClients.delete(client);
        try {
          client.terminate();
        } catch {}
        continue;
      }
      try {
        client.send(data, { binary: true });
      } catch {
        this.spectatorClients.delete(client);
        try {
          client.terminate();
        } catch {}
      }
    }
  }

  /**
   * Handle incoming WebSocket connection
   */
  private handleConnection(ws: WebSocket): void {
    if (this.client) {
      console.warn("[RTMPBridge] Rejecting connection - already have a client");
      ws.close(1013, "Already streaming");
      return;
    }

    console.log("[RTMPBridge] Client connected");
    this.client = ws;
    this.status.clientConnected = true;
    this.bytesReceived = 0;
    this.droppedFrameCount = 0;

    // Start FFmpeg when client connects
    this.startFFmpeg();

    ws.on("message", (raw: RawData) => {
      const data = this.toBuffer(raw);
      if (!data) return;

      this.bytesReceived += data.length;
      this.lastDataReceived = Date.now();
      this.writeToFfmpeg(data, ws);
    });

    ws.on("close", () => {
      console.log("[RTMPBridge] Client disconnected");
      this.client = null;
      this.status.clientConnected = false;
      this.stopFFmpeg();
    });

    ws.on("error", (err) => {
      console.error("[RTMPBridge] Client WebSocket error:", err);
    });
  }

  /**
   * Handle incoming WebSocket connection for WebCodecs mode
   * Expects raw H.264 NAL units (Annex B format)
   */
  private handleWebCodecsConnection(ws: WebSocket): void {
    if (this.client) {
      console.warn("[RTMPBridge] Rejecting connection - already have a client");
      ws.close(1013, "Already streaming");
      return;
    }

    console.log("[RTMPBridge] Client connected (WebCodecs mode)");
    this.client = ws;
    (this.client as any)._isWebCodecs = true;
    this.status.clientConnected = true;
    this.bytesReceived = 0;
    this.droppedFrameCount = 0;

    // Start FFmpeg in stream-copy mode
    this.startFFmpegWebCodecs();

    ws.on("message", (raw: RawData) => {
      const data = this.toBuffer(raw);
      if (!data) return;

      this.bytesReceived += data.length;
      this.lastDataReceived = Date.now();
      this.writeToFfmpeg(data, ws);
    });

    ws.on("close", () => {
      console.log("[RTMPBridge] Client disconnected");
      this.client = null;
      this.status.clientConnected = false;
      this.stopFFmpeg();
    });

    ws.on("error", (err) => {
      console.error("[RTMPBridge] Client WebSocket error:", err);
    });
  }

  /**
   * Build FFmpeg tee muxer output string
   */
  private buildOutputString(): string {
    const enabledDests = this.destinations.filter((d) => d.enabled);
    const outputs = enabledDests.map((dest) => {
      const fullUrl = dest.key ? `${dest.url}/${dest.key}` : dest.url;
      // Wrap each RTMP endpoint in a fifo muxer to absorb network stalls without blocking the encoder
      return `[f=fifo:fifo_format=flv:drop_pkts_on_overflow=1:attempt_recovery=1:recovery_wait_time=1]${fullUrl}`;
    });

    const hlsOutputPath = process.env.HLS_OUTPUT_PATH?.trim();
    if (hlsOutputPath) {
      const hlsBuildTime = Date.now();
      const configuredTimelineOrigin = Number.parseInt(
        process.env.HLS_TIMELINE_ORIGIN_MS || "",
        10,
      );
      this.hlsTimelineStartedAt ??=
        Number.isFinite(configuredTimelineOrigin) &&
        configuredTimelineOrigin > 0
          ? Math.min(configuredTimelineOrigin, hlsBuildTime)
          : hlsBuildTime;
      const hlsTimelineOffsetSeconds = Math.max(
        0,
        (hlsBuildTime - this.hlsTimelineStartedAt) / 1000,
      );
      const hlsTime = parseEnvInt(process.env.HLS_TIME_SECONDS, 1, 1);
      const hlsListSize = parseEnvInt(process.env.HLS_LIST_SIZE, 30, 2);
      const hlsDeleteThreshold = parseEnvInt(
        process.env.HLS_DELETE_THRESHOLD,
        120,
        1,
      );
      const configuredHlsStartNumber = parseEnvInt(
        process.env.HLS_START_NUMBER,
        Math.floor(Date.now() / 1000),
        0,
      );
      // Keep the configured sequence stable across supervised worker restarts.
      // `append_list` reads the current manifest and advances from its tail;
      // changing start_number per process creates artificial sequence gaps that
      // make attached readers skip otherwise valid segments.
      const hlsStartNumber = configuredHlsStartNumber;
      const hlsFlags =
        process.env.HLS_FLAGS ||
        "delete_segments+append_list+independent_segments+program_date_time+omit_endlist+temp_file";
      const hlsAllowCache = parseEnvInt(process.env.HLS_ALLOW_CACHE, 1, 0);
      const hlsSegmentPattern =
        process.env.HLS_SEGMENT_PATTERN?.trim() ||
        `${hlsOutputPath.replace(/\.[^./]+$/, "") || "stream"}-%09d.ts`;

      const hlsOptions = [
        "f=hls",
        "onfail=ignore",
        `hls_time=${hlsTime}`,
        `hls_list_size=${hlsListSize}`,
        `hls_delete_threshold=${hlsDeleteThreshold}`,
        `hls_flags=${hlsFlags}`,
        "hls_segment_options=mpegts_flags=+initial_discontinuity",
        `output_ts_offset=${hlsTimelineOffsetSeconds.toFixed(3)}`,
        `start_number=${hlsStartNumber}`,
        `hls_allow_cache=${hlsAllowCache}`,
        `hls_segment_filename=${RTMPBridge.teeEscape(hlsSegmentPattern)}`,
      ].join(":");

      outputs.push(`[${hlsOptions}]${RTMPBridge.teeEscape(hlsOutputPath)}`);
    }

    if (outputs.length === 0) {
      // No outputs - just discard (useful for testing)
      return "-f null -";
    }

    return outputs.join("|");
  }

  /**
   * Start FFmpeg process
   */
  private startFFmpeg(): void {
    if (this.ffmpeg) {
      console.warn("[RTMPBridge] FFmpeg already running");
      return;
    }

    const outputString = this.buildOutputString();
    const isNullOutput = outputString === "-f null -";

    // Build FFmpeg arguments
    const args = [
      "-fflags",
      "+genpts+discardcorrupt+nobuffer",
      "-thread_queue_size",
      "256",
      // Input: pipe from stdin (WebM from MediaRecorder)
      "-i",
      "pipe:0",
      ...this.buildBridgeAudioInputArgs(),

      // Explicitly map input streams for tee outputs.
      // Ignore MediaRecorder's synthetic audio and let the bridge own A/V timing.
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",

      // Force constant frame rate output for strict RTMP ingestion (Twitch/YouTube)
      "-r",
      String(this.config.fps),
    ];
    args.push("-vf", this.buildOutputVideoFilter(true));

    // Video codec settings
    args.push(...this.buildVideoEncoderArgs());

    args.push(...this.buildAudioArgs());

    if (isNullOutput) {
      // No destinations - discard output (for testing)
      args.push("-f", "null", "-");
    } else {
      // Use tee muxer for multiple outputs
      args.push("-f", "tee", outputString);
    }

    const redactedArgs = this.redactFFmpegArgumentsForLog(args);
    console.log(
      "[RTMPBridge] Starting FFmpeg with args:",
      redactedArgs.join(" "),
    );

    this.ffmpeg = spawn(this.ffmpegCommand, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.setupFFmpegHandlers("", () => !!this.client);
  }

  /**
   * Start FFmpeg process for WebCodecs mode
   * Reads raw H.264 NAL units from stdin and muxes them (-c:v copy) to destinations.
   * Zero CPU encoding overhead.
   */
  private startFFmpegWebCodecs(): void {
    if (this.ffmpeg) {
      console.warn("[RTMPBridge] FFmpeg already running");
      return;
    }

    const outputString = this.buildOutputString();
    const isNullOutput = outputString === "-f null -";

    const args = [
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      // Important: read the raw h264 byte stream directly
      "-f",
      "h264",
      "-framerate",
      String(this.config.fps),
      "-i",
      "pipe:0",
      ...this.buildBridgeAudioInputArgs(),

      "-map",
      "0:v:0",
      "-map",
      "1:a:0",

      "-r",
      String(this.config.fps),

      // Zero CPU encoding: just copy the H.264 stream into the RTMP muxer.
      "-c:v",
      "copy",

      // Encode audio to AAC
      "-c:a",
      "aac",
      "-b:a",
      `${this.config.audioBitrate}k`,
      "-ar",
      String(STREAM_AUDIO_SAMPLE_RATE_HZ),
      "-flags",
      "+global_header",
    ];

    if (isNullOutput) {
      args.push("-f", "null", "-");
    } else {
      args.push("-f", "tee", outputString);
    }

    const redactedWcArgs = this.redactFFmpegArgumentsForLog(args);
    console.log(
      "[RTMPBridge] Starting FFmpeg (WebCodecs mode/Stream Copy) with args:",
      redactedWcArgs.join(" "),
    );

    this.ffmpeg = spawn(this.ffmpegCommand, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.setupFFmpegHandlers("WebCodecs", () => !!this.client);
  }

  /**
   * Parse FFmpeg output for connection status
   */
  private parseFFmpegOutput(msg: string): void {
    const destinationFailure = "FFmpeg reported a destination delivery failure";
    const slaveMuxerFailureMatch = msg.match(/Slave muxer #(\d+) failed/i);
    if (slaveMuxerFailureMatch) {
      const destIndex = Number.parseInt(slaveMuxerFailureMatch[1] || "", 10);
      if (Number.isFinite(destIndex)) {
        const destination = this.status.destinations[destIndex];
        if (destination) {
          destination.connected = false;
          destination.error = destinationFailure;
        }
      }
    }

    // Check for RTMP connection errors
    for (const dest of this.status.destinations) {
      if (
        msg.includes(dest.name) ||
        msg.toLowerCase().includes(dest.name.toLowerCase())
      ) {
        if (msg.includes("error") || msg.includes("failed")) {
          dest.connected = false;
          dest.error = destinationFailure;
        }
      }
    }
  }

  /**
   * Stop FFmpeg process
   */
  private stopFFmpeg(): void {
    if (!this.ffmpeg) return;

    console.log("[RTMPBridge] Stopping FFmpeg");
    this.stopHealthMonitoring();
    this.stopPlaceholderMode();
    this.ffmpegBackpressured = false;
    this.setClientBackpressurePaused(false);

    const oldFfmpeg = this.ffmpeg;
    this.ffmpeg = null;
    this.status.ffmpegRunning = false;

    // Remove event listeners so old process close events don't nullify a newly started current process
    oldFfmpeg.removeAllListeners("close");
    oldFfmpeg.removeAllListeners("error");
    oldFfmpeg.stdout?.removeAllListeners("data");
    oldFfmpeg.stderr?.removeAllListeners("data");
    oldFfmpeg.stdin?.removeAllListeners("drain");
    const oldBrowserAudioPipe = oldFfmpeg.stdio[3];
    if (oldBrowserAudioPipe && "removeAllListeners" in oldBrowserAudioPipe) {
      oldBrowserAudioPipe.removeAllListeners("drain");
    }

    // Close stdin first to signal end of input
    oldFfmpeg.stdin?.end();
    if (oldBrowserAudioPipe && "end" in oldBrowserAudioPipe) {
      oldBrowserAudioPipe.end();
    }

    // Give it a moment to finish, then kill
    const killTimer = setTimeout(() => {
      try {
        oldFfmpeg.kill("SIGKILL"); // Force kill to prevent zombie FFmpeg processes taking up GPU/CPU
      } catch {}
    }, 2000);
    killTimer.unref?.();
  }

  /**
   * Get current streaming status
   */
  getStatus(): StreamingStatus {
    // In duel-stack mode the RTMP publisher can run as an external process.
    // Surface configured destinations even when this in-process bridge is idle
    // so health endpoints can still verify fanout wiring.
    this.initOutputs();
    const idleConfiguredDestinations =
      this.status.destinations.length > 0
        ? this.status.destinations
        : this.destinations
            .filter((destination) => destination.enabled)
            .map((destination) => ({
              name: destination.name,
              connected: false,
              bytesWritten: 0,
              startedAt: this.status.startedAt,
            }));

    const now = Date.now();
    const browserAudioHealthy =
      this.status.audioSource === "browser" &&
      this.lastBrowserAudioData > 0 &&
      now - this.lastBrowserAudioData < RTMPBridge.DATA_TIMEOUT;
    return {
      ...this.status,
      audioHealthy:
        this.status.audioSource === "pulse"
          ? true
          : this.status.audioSource === "browser"
            ? browserAudioHealthy
            : false,
      audioLastChunkAt:
        this.lastBrowserAudioData > 0 ? this.lastBrowserAudioData : null,
      audioChunks: this.browserAudioChunkCount,
      audioDroppedChunks: this.browserAudioDroppedChunkCount,
      audioTrimmedChunks: this.browserAudioTrimmedChunkCount,
      destinations: idleConfiguredDestinations.map((d) => ({ ...d })),
    };
  }

  /**
   * Get streaming statistics
   */
  getStats(): {
    bytesReceived: number;
    uptime: number;
    destinations: number;
    restartAttempts: number;
    lastCrash: number;
    healthy: boolean;
    droppedFrames: number;
    backpressured: boolean;
    spectators: number;
    processMemory: {
      rssBytes: number;
      heapTotalBytes: number;
      heapUsedBytes: number;
      externalBytes: number;
      arrayBuffersBytes: number;
    };
  } {
    const now = Date.now();
    const healthy =
      this.status.ffmpegRunning &&
      (this.cdpDirectMode || this.status.clientConnected) &&
      (this.lastDataReceived === 0 ||
        now - this.lastDataReceived < RTMPBridge.DATA_TIMEOUT);
    const usage = process.memoryUsage();

    return {
      bytesReceived: this.bytesReceived,
      uptime: this.startTime ? now - this.startTime : 0,
      destinations: this.enabledOutputCount(),
      restartAttempts: this.ffmpegRestartAttempts,
      lastCrash: this.lastFFmpegCrash,
      healthy,
      droppedFrames: this.droppedFrameCount,
      backpressured: this.ffmpegBackpressured,
      spectators: this.spectatorClients.size,
      processMemory: {
        rssBytes: usage.rss,
        heapTotalBytes: usage.heapTotal,
        heapUsedBytes: usage.heapUsed,
        externalBytes: usage.external,
        arrayBuffersBytes: usage.arrayBuffers,
      },
    };
  }

  /**
   * Recover from an encoder failure at the safest process boundary.
   *
   * Bun's extra child-process stdio pipe can stop draining after an in-process
   * FFmpeg respawn. The dedicated capture worker is already supervised by the
   * duel stack, so its opt-in policy exits the worker and lets the supervisor
   * recreate every encoder pipe from a clean process. The production duel
   * launcher keeps its WebGPU renderer in a separately supervised host, so
   * the replacement worker can reuse the warm page. Other bridge consumers
   * retain the legacy in-process retry behavior by default.
   */
  private handleEncoderFailure(exitCode: number | null): void {
    const exitWorker = RTMPBridge.parseEnvBool(
      process.env.STREAM_EXIT_ON_ENCODER_CRASH,
      false,
    );
    if (!exitWorker) {
      this.handleFFmpegCrash(exitCode);
      return;
    }
    if (this.encoderCrashExitScheduled) return;
    this.encoderCrashExitScheduled = true;
    this.resolveEncoderReadyWaiters(false);
    console.error(
      `[RTMPBridge] FFmpeg encoder failure (${exitCode ?? "signal"}); exiting the supervised capture worker for a clean restart`,
    );
    setTimeout(() => process.exit(1), 0);
  }

  /**
   * Handle FFmpeg crash with exponential backoff restart
   */
  private handleFFmpegCrash(exitCode: number | null): void {
    const now = Date.now();
    this.lastFFmpegCrash = now;

    // Clear any existing restart timeout
    if (this.ffmpegRestartTimeout) {
      clearTimeout(this.ffmpegRestartTimeout);
      this.ffmpegRestartTimeout = null;
    }

    // Check if we've exceeded max restart attempts
    if (this.ffmpegRestartAttempts >= RTMPBridge.MAX_RESTART_ATTEMPTS) {
      console.error(
        `[RTMPBridge] FFmpeg crashed ${this.ffmpegRestartAttempts} times. ` +
          `Giving up. Manual intervention required.`,
      );
      this.status.active = false;
      return;
    }

    this.ffmpegRestartAttempts++;

    // Calculate delay with exponential backoff and jitter
    const baseDelay =
      RTMPBridge.BASE_RESTART_DELAY *
      Math.pow(2, this.ffmpegRestartAttempts - 1);
    const jitter = Math.random() * 1000; // Add up to 1s jitter
    const delay = Math.min(baseDelay + jitter, RTMPBridge.MAX_RESTART_DELAY);

    console.warn(
      `[RTMPBridge] FFmpeg crashed with code ${exitCode}. ` +
        `Restart attempt ${this.ffmpegRestartAttempts}/${RTMPBridge.MAX_RESTART_ATTEMPTS} ` +
        `in ${Math.round(delay)}ms`,
    );

    this.ffmpegRestartTimeout = setTimeout(() => {
      this.ffmpegRestartTimeout = null;

      // Only restart if client is still connected
      if (this.client || this.cdpDirectMode) {
        console.log("[RTMPBridge] Attempting FFmpeg restart...");
        if (this.cdpDirectMode) {
          this.startFFmpegDirect();
          this.directEncoderRestartHandler?.();
        } else if (this.client && (this.client as any)._isWebCodecs) {
          this.startFFmpegWebCodecs();
        } else {
          this.startFFmpeg();
        }

        // Reset restart counter after successful restart (if still running after 5s)
        setTimeout(() => {
          if (this.ffmpeg && this.status.ffmpegRunning) {
            console.log("[RTMPBridge] FFmpeg restart appears successful");
            // Gradually reduce restart counter on success
            this.ffmpegRestartAttempts = Math.max(
              0,
              this.ffmpegRestartAttempts - 1,
            );
          }
        }, 5000);
      } else {
        console.log(
          "[RTMPBridge] Client disconnected, skipping FFmpeg restart",
        );
        this.ffmpegRestartAttempts = 0;
      }
    }, delay);
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    // Stop any existing monitoring
    this.stopHealthMonitoring();

    this.healthCheckInterval = setInterval(() => {
      this.checkHealth();
    }, RTMPBridge.HEALTH_CHECK_INTERVAL);
  }

  /**
   * Stop health monitoring
   */
  private stopHealthMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Check streaming health and log warnings
   */
  private checkHealth(): void {
    const now = Date.now();
    const stats = this.getStats();

    // Check for data timeout and enter placeholder mode if enabled
    if (
      this.lastDataReceived > 0 &&
      now - this.lastDataReceived > RTMPBridge.PLACEHOLDER_TIMEOUT
    ) {
      // Enter placeholder mode to keep stream alive
      if (this.placeholderEnabled && !this.inPlaceholderMode) {
        this.startPlaceholderMode();
      }

      // Only warn if we're past the longer DATA_TIMEOUT
      if (now - this.lastDataReceived > RTMPBridge.DATA_TIMEOUT) {
        console.warn(
          `[RTMPBridge] No data received for ${Math.round((now - this.lastDataReceived) / 1000)}s. ` +
            `${this.inPlaceholderMode ? "(placeholder mode active)" : "Stream may be stalled."}`,
        );
      }
    }

    // Check destination health
    for (const dest of this.status.destinations) {
      if (!dest.connected && dest.error) {
        console.warn(
          `[RTMPBridge] Destination ${dest.name} unhealthy: ${dest.error}`,
        );
      }
    }

    // Log periodic health status (every 5 health checks = ~50s)
    if (Math.random() < 0.2) {
      const healthyDests = this.status.destinations.filter(
        (d) => d.connected,
      ).length;
      console.log(
        `[RTMPBridge] Health check: ${stats.healthy ? "HEALTHY" : "UNHEALTHY"} | ` +
          `Uptime: ${Math.round(stats.uptime / 1000)}s | ` +
          `Received: ${Math.round(stats.bytesReceived / 1024)}KB | ` +
          `Destinations: ${healthyDests}/${this.status.destinations.length}`,
      );
    }
  }

  /**
   * Reset bytes received counter (call periodically to prevent overflow)
   */
  resetBytesReceived(): void {
    this.bytesReceived = 0;
  }

  /**
   * Reset FFmpeg restart attempt counter.
   * Call after a successful soft recovery to prevent premature give-up.
   */
  resetRestartAttempts(): void {
    this.ffmpegRestartAttempts = 0;
  }
}

// Singleton instance
let bridgeInstance: RTMPBridge | null = null;

/**
 * Get or create the RTMP bridge instance
 */
export function getRTMPBridge(): RTMPBridge {
  if (!bridgeInstance) {
    bridgeInstance = new RTMPBridge();
  }
  return bridgeInstance;
}

/**
 * Return the existing bridge instance without creating one.
 */
export function peekRTMPBridge(): RTMPBridge | null {
  return bridgeInstance;
}

/**
 * Start the RTMP bridge server
 */
export function startRTMPBridge(port: number = 8765): RTMPBridge {
  const bridge = getRTMPBridge();
  bridge.start(port);
  return bridge;
}
