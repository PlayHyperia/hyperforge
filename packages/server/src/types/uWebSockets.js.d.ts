declare module "uWebSockets.js" {
  export interface us_listen_socket {}

  export interface HttpRequest {
    getQuery(): string;
    getHeader(name: string): string;
  }

  export interface HttpResponse<UserData = unknown> {
    getRemoteAddressAsText(): Uint8Array;
    upgrade<T>(
      userData: T,
      secWebSocketKey: string,
      secWebSocketProtocol: string,
      secWebSocketExtensions: string,
      context: unknown,
    ): void;
  }

  export interface WebSocket<UserData = unknown> {
    getUserData(): UserData;
    subscribe(topic: string): boolean;
    unsubscribe(topic: string): boolean;
    publish(
      topic: string,
      message: ArrayBuffer | Uint8Array | string,
      isBinary?: boolean,
      compress?: boolean,
    ): boolean;
    send(
      message: ArrayBuffer | Uint8Array | string,
      isBinary?: boolean,
      compress?: boolean,
    ): number;
    getBufferedAmount(): number;
    ping(message?: ArrayBuffer | string): number;
    close(): void;
    end(code?: number, shortMessage?: string): void;
  }

  export interface WebSocketBehavior<UserData = unknown> {
    compression?: number;
    maxPayloadLength?: number;
    maxBackpressure?: number;
    closeOnBackpressureLimit?: boolean;
    idleTimeout?: number;
    sendPingsAutomatically?: boolean;
    upgrade?: (
      res: HttpResponse<UserData>,
      req: HttpRequest,
      context: unknown,
    ) => void;
    open?: (ws: WebSocket<UserData>) => void;
    message?: (
      ws: WebSocket<UserData>,
      message: ArrayBuffer,
      isBinary: boolean,
    ) => void;
    pong?: (ws: WebSocket<UserData>) => void;
    close?: (
      ws: WebSocket<UserData>,
      code: number,
      message?: ArrayBuffer,
    ) => void;
    drain?: (ws: WebSocket<UserData>) => void;
  }

  export interface TemplatedApp {
    ws<UserData = unknown>(
      pattern: string,
      behavior: WebSocketBehavior<UserData>,
    ): TemplatedApp;
    publish(
      topic: string,
      message: ArrayBuffer | Uint8Array | string,
      isBinary?: boolean,
      compress?: boolean,
    ): boolean;
    listen(
      port: number,
      cb: (listenSocket: us_listen_socket | false) => void,
    ): void;
  }

  export const DISABLED: number;
  export function App(): TemplatedApp;
  export function us_listen_socket_close(socket: us_listen_socket): void;

  const uWS: {
    App: typeof App;
    DISABLED: typeof DISABLED;
    us_listen_socket_close: typeof us_listen_socket_close;
  };

  export default uWS;
}
