/**
 * WebSocket Connection Wrapper
 *
 * This class wraps a Node.js WebSocket connection and provides a unified interface for
 * both client and server networking. It handles binary packet encoding/decoding via msgpackr
 * and manages connection lifecycle (open, close, ping/pong heartbeat).
 *
 * **Key Features**:
 * - Binary packet protocol using msgpackr for efficient serialization
 * - Automatic heartbeat/keepalive via ping/pong
 * - Connection state tracking (alive, closed, disconnected)
 * - Associated player entity reference for game logic
 * - Graceful error handling with fallback no-op WebSocket stub
 *
 * **Packet Protocol**:
 * All messages are sent as binary ArrayBuffers encoded with msgpackr:
 * - Format: [packet_id, data]
 * - packet_id is an integer mapped to a method name (see packets.ts)
 * - data is arbitrary game state (positions, inventory, chat messages, etc.)
 *
 * **Heartbeat Mechanism**:
 * - Server sends periodic pings to detect dead connections
 * - Socket marks itself as not alive on ping
 * - Pong from client marks it alive again
 * - Sockets that don't respond to pings are disconnected
 *
 * **Connection States**:
 * - `alive`: Responded to last ping (true by default)
 * - `closed`: WebSocket connection has been closed
 * - `disconnected`: Disconnect handler has been called
 *
 * **Referenced by**: ServerNetwork (server), ClientNetwork (client)
 */

import { readPacket, writePacket } from "./packets";
import type {
  NodeWebSocket,
  NetworkWithSocket,
  SocketOptions,
} from "../../types/network/networking";

import type { Entity } from "../../entities/Entity";

/**
 * Socket class - wraps a WebSocket connection with game-specific functionality
 */
export class Socket {
  id: string;
  ws: NodeWebSocket;
  network: NetworkWithSocket;
  player?: Entity;
  alive: boolean;
  closed: boolean;
  disconnected: boolean;

  // Handler references for cleanup
  private _messageHandler: ((arg?: unknown) => void) | null = null;
  private _pongHandler: (() => void) | null = null;
  private _closeHandler: ((arg?: unknown) => void) | null = null;

  constructor({ id, ws, network, player }: SocketOptions) {
    this.id = id;
    this.ws = ws;
    this.network = network;

    this.player = player;

    this.alive = true;
    this.closed = false;
    this.disconnected = false;

    // If ws is unexpectedly undefined, install a minimal no-op stub to prevent hard crashes
    if (!this.ws) {
      this.ws = {
        on: () => {},
        ping: () => {},
        terminate: () => {},
        send: () => {},
        close: () => {},
      } as unknown as NodeWebSocket;
    }

    // Use Node.js WebSocket event handling (store refs for cleanup)
    this._messageHandler = (arg?: unknown) => {
      // Strong type assumption - message is always ArrayBuffer or Uint8Array
      const data = arg as ArrayBuffer | Uint8Array;
      this.onMessage(data);
    };
    this._pongHandler = () => {
      this.onPong();
    };
    this._closeHandler = (arg?: unknown) => {
      // Strong type assumption - close event has code property
      const closeEvent = arg as { code?: number | string } | undefined;
      this.onClose({ code: closeEvent?.code });
    };
    this.ws.on("message", this._messageHandler);
    this.ws.on("pong", this._pongHandler);
    this.ws.on("close", this._closeHandler);
  }

  /**
   * Remove all event listeners from the WebSocket
   * Called during disconnect to prevent memory leaks
   */
  private cleanup(): void {
    if (this._messageHandler) {
      this.ws.removeListener?.("message", this._messageHandler);
      this._messageHandler = null;
    }
    if (this._pongHandler) {
      this.ws.removeListener?.("pong", this._pongHandler);
      this._pongHandler = null;
    }
    if (this._closeHandler) {
      this.ws.removeListener?.("close", this._closeHandler);
      this._closeHandler = null;
    }
  }

  send<T>(name: string, data: T): void {
    const packet = writePacket(name, data);
    this.ws.send(packet);
  }

  sendPacket(packet: ArrayBuffer | Uint8Array): void {
    const payload =
      packet instanceof Uint8Array ? new Uint8Array(packet).buffer : packet;
    this.ws.send(payload);
  }

  ping(): void {
    this.alive = false;
    // Use Node.js WebSocket ping method
    this.ws.ping();
  }

  // end(code) {
  //   this.send('end', code)
  //   this.disconnect()
  // }

  onPong = (): void => {
    this.alive = true;
  };

  onMessage = (packet: ArrayBuffer | Uint8Array): void => {
    // Receiving any packet is proof of life; keeps connection alive
    // even if proxies (like Cloudflare) drop protocol-level pongs.
    this.alive = true;

    const result = readPacket(packet);

    if (result && result.length === 2) {
      const [method, data] = result;
      this.network.enqueue(this, method, data);
    } else {
      // Unknown packet or deserialization error - already logged in readPacket
      // Silently ignore to prevent spam, but the warning was already logged
    }
  };

  onClose = (e: { code?: number | string }): void => {
    this.closed = true;
    this.disconnect(e?.code);
  };

  disconnect(code?: number | string): void {
    // Clean up event listeners to prevent memory leaks
    this.cleanup();

    if (!this.closed) {
      // Use Node.js WebSocket terminate method
      this.ws.terminate();
    }
    if (this.disconnected) return;
    this.disconnected = true;
    this.network.onDisconnect(this, code);
  }

  close = (): void => {
    if (!this.closed) {
      this.closed = true;
      this.alive = false;
      this.ws.close();
    }
  };
}
