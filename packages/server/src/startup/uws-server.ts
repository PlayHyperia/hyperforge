/**
 * uWebSockets.js Game WebSocket Server
 *
 * Creates a uWS server that handles game WebSocket connections on a dedicated
 * port (default 5556). All connections feed into the same ServerNetwork.onConnection()
 * as the legacy Fastify WS route, keeping the game logic transport-agnostic.
 *
 * This module is the server-side entry point for the uWS transport layer.
 * The UwsWebSocketAdapter bridges uWS's callback-based API to the
 * EventEmitter-like NodeWebSocket interface that Socket/ConnectionHandler expect.
 */

import * as uWS from "uWebSockets.js";
import type { World } from "@hyperforge/shared";
import {
  UwsWebSocketAdapter,
  type UwsUserData,
} from "./UwsWebSocketAdapter.js";
import type { NodeWebSocket } from "../shared/types/network.types.js";

/** Module-level listen socket for graceful shutdown */
let _listenSocket: uWS.us_listen_socket | null = null;

/** Module-level uWS app reference for pub/sub broadcasting */
let _uwsApp: uWS.TemplatedApp | null = null;

/**
 * Get the uWS app instance for pub/sub operations.
 * Returns null if uWS was never started or has been shut down.
 */
export function getUwsApp(): uWS.TemplatedApp | null {
  return _uwsApp;
}

/**
 * Parse a query string into a key-value record.
 * Handles the simple case of "key=value&key2=value2".
 */
function parseQueryString(qs: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!qs) return result;
  const pairs = qs.split("&");
  for (const pair of pairs) {
    try {
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) {
        result[decodeURIComponent(pair)] = "";
      } else {
        const key = decodeURIComponent(pair.slice(0, eqIdx));
        const value = decodeURIComponent(pair.slice(eqIdx + 1));
        result[key] = value;
      }
    } catch {
      // Skip malformed percent-encoded pairs (e.g. %ZZ)
    }
  }
  return result;
}

/**
 * Create and configure the uWebSockets.js server for game WebSocket traffic.
 *
 * @param world - Game world instance whose `network.onConnection` will be called
 * @param port - Port to listen on (default: 5556 via UWS_PORT env var)
 * @returns Promise that resolves with the uWS listen socket (for shutdown)
 */
export function createUwsServer(
  world: World,
  port: number,
): Promise<uWS.us_listen_socket | null> {
  const app = uWS.App();
  _uwsApp = app;

  app.ws<UwsUserData>("/ws", {
    /* Compression disabled — binary msgpackr payloads don't compress well and
       the CPU cost is not worth it for game traffic */
    compression: uWS.DISABLED,
    maxPayloadLength: 512 * 1024, // 512KB
    // The default 64 KiB ceiling is smaller than a cold world snapshot and can
    // make a healthy spectator silently lose the immediately following combat
    // terminal. Replayable traffic may still be skipped under pressure; exact
    // critical packets use UwsWebSocketAdapter's bounded drain queue.
    maxBackpressure: 2 * 1024 * 1024,
    closeOnBackpressureLimit: false,
    idleTimeout: 120, // 2 min — SocketManager handles faster heartbeat
    sendPingsAutomatically: false, // We manage our own pings for RTT measurement

    upgrade: (res, req, context) => {
      // IMPORTANT: req.getQuery() and res.getRemoteAddressAsText() are only
      // valid during the upgrade callback. Parse and store before res.upgrade().
      const query = parseQueryString(req.getQuery());
      const remoteAddress = Buffer.from(
        res.getRemoteAddressAsText(),
      ).toString();
      const wsId = `SERVER-UWS-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      res.upgrade<UwsUserData>(
        { wsId, remoteAddress, query, adapter: null },
        req.getHeader("sec-websocket-key"),
        req.getHeader("sec-websocket-protocol"),
        req.getHeader("sec-websocket-extensions"),
        context,
      );
    },

    open: (ws) => {
      const userData = ws.getUserData();
      const adapter = new UwsWebSocketAdapter(ws);
      userData.adapter = adapter;

      // Subscribe to global topic for sendToAll() pub/sub fan-out
      ws.subscribe("global");

      console.log(`[uWS] Connection established - ${userData.wsId}`);

      // Feed into the same onConnection handler as the legacy Fastify route.
      // handleConnection is async — catch errors to avoid unhandled rejections
      // that silently drop the connection (no snapshot sent, client hangs).
      if (!world.network.onConnection) {
        console.error("[uWS] onConnection not set — closing socket");
        ws.close();
        return;
      }
      Promise.resolve(
        world.network.onConnection(
          adapter as unknown as NodeWebSocket,
          userData.query,
        ),
      ).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[uWS] onConnection error for ${userData.wsId}: ${msg}`);
      });
    },

    message: (ws, message, _isBinary) => {
      const adapter = ws.getUserData().adapter;
      if (!adapter) return;
      // CRITICAL: uWS invalidates the ArrayBuffer after this callback returns.
      // Copy the buffer before dispatching to listeners.
      const copy = message.slice(0);
      adapter.dispatchMessage(copy);
    },

    pong: (ws) => {
      const adapter = ws.getUserData().adapter;
      if (!adapter) return;
      adapter.dispatchPong();
    },

    close: (ws, code) => {
      const adapter = ws.getUserData().adapter;
      if (adapter) {
        adapter.dispatchClose(code);
      }
      // Release reference to adapter so the socket + its listeners can be GC'd
      ws.getUserData().adapter = null;
    },

    drain: (ws) => {
      ws.getUserData().adapter?.dispatchDrain();
    },
  });

  return new Promise((resolve) => {
    app.listen(port, (listenSocket) => {
      if (listenSocket) {
        _listenSocket = listenSocket;
        console.log(`[uWS] Game WebSocket server listening on :${port}`);
      } else {
        console.error(`[uWS] Failed to listen on port ${port}`);
      }
      resolve(listenSocket);
    });
  });
}

/**
 * Close the uWS listen socket, stopping new connections.
 * Safe to call even if uWS was never started.
 */
export function closeUwsServer(): void {
  if (_listenSocket) {
    uWS.us_listen_socket_close(_listenSocket);
    _listenSocket = null;
    console.log("[uWS] Listen socket closed");
  }
  _uwsApp = null;
}
