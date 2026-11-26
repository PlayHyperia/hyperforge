/**
 * Stream Capture - RTMPBridge initialization for RTMP fanout streaming.
 *
 * Starts the RTMPBridge WebSocket server that receives video frames
 * from the browser's MediaRecorder capture script running in the
 * StreamingMode client page (?page=stream).
 *
 * Pipeline:
 *   Browser (StreamingMode) → canvas.captureStream() → MediaRecorder
 *   → WebSocket (port 8765) → RTMPBridge → FFmpeg → RTMP destinations
 *   (YouTube/Twitch/Kick/etc.).
 */

import { getRTMPBridge, peekRTMPBridge } from "./rtmp-bridge.js";

const RTMP_BRIDGE_PORT = parseInt(process.env.RTMP_BRIDGE_PORT || "8765", 10);

interface StreamCaptureBridgeAuthority {
  start(port: number): void;
  waitForServerReady(timeoutMs?: number): Promise<void>;
}

interface StreamCaptureInitializationOptions {
  bridge?: StreamCaptureBridgeAuthority;
  port?: number;
  readyTimeoutMs?: number;
}

/**
 * Initialize the stream capture pipeline.
 *
 * Starts the RTMPBridge WebSocket server so that the browser's capture
 * script (injected in StreamingMode) can connect and send video frames.
 */
export async function initStreamCapture(
  options: StreamCaptureInitializationOptions = {},
): Promise<boolean> {
  const enabled = process.env.STREAMING_CAPTURE_ENABLED !== "false";
  if (!enabled) {
    console.log("[StreamCapture] Disabled via STREAMING_CAPTURE_ENABLED=false");
    return false;
  }

  const bridge = options.bridge ?? getRTMPBridge();
  const port = options.port ?? RTMP_BRIDGE_PORT;
  bridge.start(port);
  await bridge.waitForServerReady(options.readyTimeoutMs);
  console.log(
    `[StreamCapture] RTMPBridge WebSocket server started on port ${port}`,
  );
  console.log(
    `[StreamCapture] Waiting for browser capture client to connect...`,
  );
  console.log(
    `[StreamCapture] Open ?page=stream in a browser to start capturing`,
  );

  return true;
}

// Re-export getStreamCapture for shutdown and status compatibility
export function getStreamCapture(): {
  isRunning(): boolean;
  stop(): Promise<void>;
  getStats(): {
    running: boolean;
    bridgeActive: boolean;
    ffmpegRunning: boolean;
    clientConnected: boolean;
  };
} {
  const bridge = peekRTMPBridge();
  if (!bridge) {
    return {
      isRunning: () => false,
      stop: async () => {},
      getStats: () => ({
        running: false,
        bridgeActive: false,
        ffmpegRunning: false,
        clientConnected: false,
      }),
    };
  }

  return {
    isRunning: () => bridge.getStatus().active,
    stop: async () => bridge.stop(),
    getStats: () => {
      const status = bridge.getStatus();
      const stats = bridge.getStats();
      return {
        running: status.active,
        bridgeActive: status.active,
        ffmpegRunning: status.ffmpegRunning,
        clientConnected: status.clientConnected,
        ...stats,
      };
    },
  };
}
