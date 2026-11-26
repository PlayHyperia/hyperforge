/**
 * RTMP Streaming Types
 *
 * Type definitions for the multi-platform RTMP streaming system.
 */

/** RTMP destination configuration */
export interface RTMPDestination {
  name: string;
  url: string;
  key: string;
  enabled: boolean;
}

/** Streaming configuration */
export interface StreamingConfig {
  /** Video bitrate in kbps */
  videoBitrate: number;
  /** Audio bitrate in kbps */
  audioBitrate: number;
  /** Frames per second */
  fps: number;
  /** Video width */
  width: number;
  /** Video height */
  height: number;
  /** FFmpeg preset (ultrafast, veryfast, fast, medium) */
  preset: "ultrafast" | "veryfast" | "fast" | "medium";
  /** Keyframe interval in frames */
  gopSize: number;
  /** Capture mode: 'cdp' uses Page.startScreencast, 'mediarecorder' uses legacy WebSocket path, 'webcodecs' uses hardware VideoEncoder */
  captureMode: "cdp" | "mediarecorder" | "webcodecs";
  /** JPEG quality for CDP screencast frames (1-100, default 80) */
  jpegQuality: number;
}

/** Stream status for a single destination */
export interface DestinationStatus {
  name: string;
  connected: boolean;
  error?: string;
  bytesWritten: number;
  startedAt?: number;
}

/** Overall streaming status */
export interface StreamingStatus {
  active: boolean;
  startedAt?: number;
  destinations: DestinationStatus[];
  ffmpegRunning: boolean;
  clientConnected: boolean;
  /** Audio input selected for the current encoder process. */
  audioSource: "uninitialized" | "browser" | "pulse" | "silent";
  /** Whether the selected live audio source is currently producing data. */
  audioHealthy: boolean;
  /** Last browser PCM chunk timestamp, when browser capture is selected. */
  audioLastChunkAt: number | null;
  /** Browser PCM chunks accepted by the current bridge lifetime. */
  audioChunks: number;
  /** Browser PCM chunks rejected due to encoder backpressure/unavailability. */
  audioDroppedChunks: number;
  /** Browser PCM chunks intentionally trimmed to bound live audio latency. */
  audioTrimmedChunks: number;
}

/** Default streaming configuration */
export const DEFAULT_STREAMING_CONFIG: StreamingConfig = {
  videoBitrate: 4500,
  audioBitrate: 128,
  fps: 30,
  width: 1280, // Match default capture viewport (720p) to avoid unnecessary upscale
  height: 720,
  preset: "ultrafast", // Use ultrafast for real-time 3D capturing to minimize CPU
  gopSize: 60, // Keyframe every 2 seconds at 30fps — recommended by Twitch/YouTube for stability
  captureMode: "cdp", // CDP screencast is the default (faster, single-encode)
  jpegQuality: 80, // Good balance of quality vs bandwidth for JPEG frames
};
