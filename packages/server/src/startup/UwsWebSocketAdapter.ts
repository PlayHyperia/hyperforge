/**
 * uWebSockets.js WebSocket Adapter
 *
 * Wraps a uWS.WebSocket to implement the NodeWebSocket interface used by
 * Socket class and connection-handler. This adapter pattern lets the game
 * logic remain transport-agnostic — it sees the same on/removeListener/send/
 * ping/terminate API whether the underlying transport is `ws` or uWS.
 *
 * Key design constraints:
 * - uWS has no EventEmitter; adapter emulates on/removeListener with a Map
 * - uWS invalidates ArrayBuffer after message callback; must copy before dispatch
 * - Must support multiple add/remove cycles for the same event name
 *   (connection-handler removes temp auth listener, then Socket adds permanent one)
 */

import type * as uWS from "uWebSockets.js";

/** Per-connection data stored on the uWS WebSocket via upgrade */
export interface UwsUserData {
  wsId: string;
  remoteAddress: string;
  query: Record<string, string>;
  adapter: UwsWebSocketAdapter | null;
}

type ListenerFn = (...args: unknown[]) => void;

type OutboundPayload = ArrayBuffer | Uint8Array | string;

type ReliablePacket = {
  data: OutboundPayload;
  bytes: number;
  isBinary: boolean;
};

/**
 * Critical game packets are tiny, so reaching either bound means the client is
 * no longer consuming a useful real-time stream. Close it and let the normal
 * reconnect/snapshot path restore one coherent state instead of retaining an
 * unbounded, increasingly stale queue.
 */
const MAX_RELIABLE_QUEUE_PACKETS = 512;
const MAX_RELIABLE_QUEUE_BYTES = 512 * 1024;

/**
 * Adapter that makes a uWS.WebSocket behave like a Node.js `ws` WebSocket.
 *
 * Implements the NodeWebSocket interface (on, removeListener, removeAllListeners,
 * send, ping, terminate, close, __wsId, __remoteAddress) so that Socket,
 * ConnectionHandler, and SocketManager work without modification.
 */
export class UwsWebSocketAdapter {
  /** Event listeners keyed by event name */
  private listeners: Map<string, ListenerFn[]> = new Map();

  /** Whether the underlying uWS socket has been closed */
  private _closed = false;

  /** Critical packets rejected by uWS's native backpressure ceiling. */
  private readonly reliableQueue: ReliablePacket[] = [];
  private reliableQueueBytes = 0;

  /** Unique identifier for this WebSocket */
  __wsId: string;

  /** Remote IP address */
  __remoteAddress: string;

  /** Native plus application-retained backpressure, matching browser/ws semantics. */
  get bufferedAmount(): number {
    if (this._closed) return 0;
    try {
      return this.uwsWs.getBufferedAmount() + this.reliableQueueBytes;
    } catch {
      return this.reliableQueueBytes;
    }
  }

  constructor(private uwsWs: uWS.WebSocket<UwsUserData>) {
    const userData = uwsWs.getUserData();
    this.__wsId = userData.wsId;
    this.__remoteAddress = userData.remoteAddress;
  }

  // ---------------------------------------------------------------------------
  // EventEmitter-like interface
  // ---------------------------------------------------------------------------

  on(event: string, listener: ListenerFn): void {
    let arr = this.listeners.get(event);
    if (!arr) {
      arr = [];
      this.listeners.set(event, arr);
    }
    arr.push(listener);
  }

  removeListener(event: string, listener: ListenerFn): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx !== -1) {
      arr.splice(idx, 1);
    }
    if (arr.length === 0) {
      this.listeners.delete(event);
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  // ---------------------------------------------------------------------------
  // WebSocket-like interface
  // ---------------------------------------------------------------------------

  send(data: OutboundPayload): void {
    if (this._closed) return;
    try {
      // isBinary = true for ArrayBuffer/Uint8Array, false for string
      const isBinary = typeof data !== "string";
      this.uwsWs.send(data, isBinary);
    } catch {
      // Socket may have closed between check and send
    }
  }

  /**
   * Send an ordering-sensitive packet without treating uWS status 2 (dropped)
   * as success. Status 0 is already accepted into uWS's native buffer and must
   * not be retried; only a genuinely dropped packet enters this FIFO. Once a
   * FIFO exists, later critical packets join it so impact/death/terminal order
   * cannot invert while the socket drains.
   */
  sendReliable(data: OutboundPayload): boolean {
    if (this._closed) return false;
    const packet = this.toReliablePacket(data);
    if (this.reliableQueue.length > 0) {
      return this.enqueueReliable(packet);
    }

    try {
      const status = this.uwsWs.send(packet.data, packet.isBinary);
      if (status !== 2) return true;
      return this.enqueueReliable(packet);
    } catch {
      return false;
    }
  }

  /** Resume the exact critical FIFO after uWS reports native buffer relief. */
  dispatchDrain(): void {
    if (this._closed) return;
    while (this.reliableQueue.length > 0) {
      const packet = this.reliableQueue[0];
      let status: number;
      try {
        status = this.uwsWs.send(packet.data, packet.isBinary);
      } catch {
        return;
      }
      if (status === 2) return;

      this.reliableQueue.shift();
      this.reliableQueueBytes -= packet.bytes;
      // Status 0 means uWS accepted this packet but is backpressured again.
      if (status === 0) return;
    }
  }

  getReliableQueueStats(): { packets: number; bytes: number } {
    return {
      packets: this.reliableQueue.length,
      bytes: this.reliableQueueBytes,
    };
  }

  private toReliablePacket(data: OutboundPayload): ReliablePacket {
    if (typeof data === "string") {
      return {
        data,
        bytes: new TextEncoder().encode(data).byteLength,
        isBinary: false,
      };
    }
    const copy = data instanceof Uint8Array ? data.slice() : data.slice(0);
    return { data: copy, bytes: copy.byteLength, isBinary: true };
  }

  private enqueueReliable(packet: ReliablePacket): boolean {
    if (
      this.reliableQueue.length >= MAX_RELIABLE_QUEUE_PACKETS ||
      this.reliableQueueBytes + packet.bytes > MAX_RELIABLE_QUEUE_BYTES
    ) {
      console.error(
        `[UwsAdapter] Critical outbound queue exceeded its recovery bound for ${this.__wsId}; closing the stale connection`,
      );
      this.terminate();
      return false;
    }
    this.reliableQueue.push(packet);
    this.reliableQueueBytes += packet.bytes;
    return true;
  }

  private clearReliableQueue(): void {
    this.reliableQueue.length = 0;
    this.reliableQueueBytes = 0;
  }

  ping(): void {
    if (this._closed) return;
    try {
      this.uwsWs.ping();
    } catch {
      // Socket may have closed
    }
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.clearReliableQueue();
    try {
      this.uwsWs.close();
    } catch {
      // Already closed
    }
  }

  terminate(): void {
    if (this._closed) return;
    this._closed = true;
    this.clearReliableQueue();
    try {
      this.uwsWs.end(1006, "");
    } catch {
      // Already closed
    }
  }

  // ---------------------------------------------------------------------------
  // Pub/Sub methods — for native uWS topic-based broadcasting
  // ---------------------------------------------------------------------------

  /** Subscribe this socket to a pub/sub topic */
  subscribe(topic: string): void {
    if (this._closed) return;
    try {
      this.uwsWs.subscribe(topic);
    } catch {
      // Socket may have closed
    }
  }

  /** Unsubscribe this socket from a pub/sub topic */
  unsubscribe(topic: string): void {
    if (this._closed) return;
    try {
      this.uwsWs.unsubscribe(topic);
    } catch {
      // Socket may have closed
    }
  }

  /**
   * Publish a message to a topic (fans out to all OTHER subscribers in C++).
   * The publishing socket itself does NOT receive the message.
   */
  publish(
    topic: string,
    message: ArrayBuffer | Uint8Array,
    isBinary: boolean,
  ): void {
    if (this._closed) return;
    try {
      this.uwsWs.publish(topic, message, isBinary);
    } catch {
      // Socket may have closed
    }
  }

  // ---------------------------------------------------------------------------
  // Dispatch methods — called from uws-server.ts callbacks
  // ---------------------------------------------------------------------------

  /**
   * Dispatch a "message" event to registered listeners.
   * The caller MUST pass a copied buffer (message.slice(0)) because uWS
   * invalidates the original ArrayBuffer after the callback returns.
   */
  dispatchMessage(data: ArrayBuffer): void {
    const arr = this.listeners.get("message");
    if (!arr || arr.length === 0) return;
    // Iterate over a snapshot in case a listener modifies the array
    const snapshot = arr.slice();
    for (const fn of snapshot) {
      try {
        fn(data);
      } catch (err) {
        console.error("[UwsAdapter] Error in message listener:", err);
      }
    }
  }

  /** Dispatch a "pong" event to registered listeners. */
  dispatchPong(): void {
    const arr = this.listeners.get("pong");
    if (!arr || arr.length === 0) return;
    const snapshot = arr.slice();
    for (const fn of snapshot) {
      try {
        fn();
      } catch (err) {
        console.error("[UwsAdapter] Error in pong listener:", err);
      }
    }
  }

  /** Dispatch a "close" event to registered listeners. */
  dispatchClose(code: number): void {
    this._closed = true;
    this.clearReliableQueue();
    const arr = this.listeners.get("close");
    if (!arr || arr.length === 0) return;
    const snapshot = arr.slice();
    for (const fn of snapshot) {
      try {
        fn({ code });
      } catch (err) {
        console.error("[UwsAdapter] Error in close listener:", err);
      }
    }
    // Release all listeners after close to help GC
    this.listeners.clear();
  }

  /** Dispatch an "error" event to registered listeners. */
  dispatchError(error: Error): void {
    const arr = this.listeners.get("error");
    if (!arr || arr.length === 0) return;
    const snapshot = arr.slice();
    for (const fn of snapshot) {
      try {
        fn(error);
      } catch (err) {
        console.error("[UwsAdapter] Error in error listener:", err);
      }
    }
  }
}
