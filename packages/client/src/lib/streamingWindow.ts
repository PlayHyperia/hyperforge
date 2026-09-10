import type {
  StreamingPerformanceSnapshot,
  StreamingRenderProfile,
} from "@hyperforge/shared";
import type {
  StreamingSceneDiagnostics,
  StreamingSceneReadinessEvidence,
} from "./streamingSceneDiagnostics";

export type PublicRuntimeEnv = {
  PUBLIC_CDN_URL?: string;
  PUBLIC_WS_URL?: string;
  PUBLIC_API_URL?: string;
  PUBLIC_APP_URL?: string;
  PUBLIC_EMBED_ALLOWED_ORIGINS?: string;
  PUBLIC_PRIVY_APP_ID?: string;
  PUBLIC_SOLANA_NETWORK?: string;
  PUBLIC_SOLANA_RPC_URL?: string;
  PUBLIC_SOLANA_WS_URL?: string;
};

export type StreamingWindowRendererHealth = {
  ready: boolean;
  degradedReason: string | null;
  updatedAt: number;
  phase: string | null;
};

export type StreamingWindowRenderProfile = StreamingRenderProfile & {
  explicit: true;
};

export type CaptureControlStatus = {
  recording?: boolean;
  wsConnected?: boolean;
  chunkCount?: number;
  bytesSent?: number;
  uptime?: number;
  lastChunkMs?: number | null;
  wsBufferedAmount?: number;
  heapUsedBytes?: number | null;
  heapLimitBytes?: number | null;
};

export type StreamingAudioCaptureBridge = {
  /** The final game-master mix. The game owns this track for the page lifetime. */
  stream: MediaStream;
  /** Source context retained in-page so the capture worker can unlock it. */
  context: AudioContext;
  /** Direct read-only tap of the final post-group game master bus. */
  node: GainNode;
  /** Idempotent activation for the isolated autoplay-enabled capture page. */
  activate: () => Promise<void>;
};

export type StreamingWindow = Window & {
  env?: PublicRuntimeEnv;
  __CDN_URL?: string;
  __HYPERIA_STREAM_READY__?: boolean;
  __HYPERIA_STREAM_RENDERER_HEALTH__?: StreamingWindowRendererHealth | null;
  __HYPERIA_STREAM_RENDER_PROFILE__?: StreamingWindowRenderProfile | null;
  __HYPERIA_STREAM_PERFORMANCE__?: StreamingPerformanceSnapshot | null;
  /** Public duel projection currently rendered by the canonical stream page. */
  __HYPERIA_STREAM_STATE__?: unknown | null;
  /** Sanitized scene/camera evidence used by the local visual capture gate. */
  __HYPERIA_STREAM_SCENE_DIAGNOSTICS__?: StreamingSceneDiagnostics | null;
  /** Structured explanation for every visual capture-readiness gate. */
  __HYPERIA_STREAM_SCENE_READINESS__?: StreamingSceneReadinessEvidence | null;
  /** Final game-master mix exposed only to the canonical capture process. */
  __HYPERIA_STREAM_AUDIO_CAPTURE__?: StreamingAudioCaptureBridge;
  /**
   * Boot/loading phase indicator read by the capture pipeline's renderer
   * health probe. Set during the loading overlay lifecycle and cleared once
   * the stream is fully ready. Values match the probe's detection categories:
   * - "connecting" | "initializing" | "loading_assets" | "finalizing"
   * - "error:webgpu_required" | "error:init_failed" | "error:http"
   * - null when boot is complete
   */
  __HYPERIA_STREAM_BOOT_STATUS__?: string | null;
  /** In-page capture control exposed for deduplication and status queries. */
  __captureControl__?: {
    stop?: () => void;
    getStatus?: () => CaptureControlStatus;
  };
  __captureStatus__?: CaptureControlStatus;
};
