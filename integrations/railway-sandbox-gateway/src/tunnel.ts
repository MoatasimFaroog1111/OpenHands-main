import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';

import { WebSocket, WebSocketServer } from 'ws';

export const TUNNEL_PORTS = [60000, 60001, 12000, 12001] as const;

type TunnelPort = (typeof TUNNEL_PORTS)[number];

type TunnelFrame =
  | { type: 'auth'; token: string }
  | { type: 'ready' }
  | { type: 'open'; streamId: string; port: number }
  | { type: 'data'; streamId: string; data: string }
  | { type: 'close'; streamId: string }
  | { type: 'error'; streamId: string; message?: string }
  | { type: 'ping' }
  | { type: 'pong' };

interface ReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface TunnelState {
  token: string;
  control?: WebSocket;
  listeners: Map<TunnelPort, Server>;
  localPorts: Map<TunnelPort, number>;
  streams: Map<string, Socket>;
  waiters: Set<ReadyWaiter>;
}

export interface RuntimeTunnel {
  register(runtimeId: string, token: string): Promise<void>;
  waitUntilReady(runtimeId: string, timeoutMs: number): Promise<void>;
  target(runtimeId: string, remotePort: number): string | undefined;
  remove(runtimeId: string): Promise<void>;
}

export interface TunnelUpgradeHandler {
  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): boolean;
  close(): Promise<void>;
}

export class SandboxTunnelManager implements RuntimeTunnel, TunnelUpgradeHandler {
  readonly #states = new Map<string, TunnelState>();
  readonly #wss = new WebSocketServer({ noServer: true, clientTracking: false });

  async register(runtimeId: string, token: string): Promise<void> {
    if (!runtimeId || !token) throw new Error('runtime tunnel identity is required');
    await this.remove(runtimeId);

    const state: TunnelState = {
      token,
      listeners: new Map(),
      localPorts: new Map(),
      streams: new Map(),
      waiters: new Set(),
    };
    this.#states.set(runtimeId, state);

    try {
      for (const remotePort of TUNNEL_PORTS) {
        const server = createServer((socket) => this.#openStream(state, remotePort, socket));
        const localPort = await listenLoopback(server);
        state.listeners.set(remotePort, server);
        state.localPorts.set(remotePort, localPort);
      }
    } catch (error) {
      await this.remove(runtimeId);
      throw error;
    }
  }

  async waitUntilReady(runtimeId: string, timeoutMs: number): Promise<void> {
    const state = this.#states.get(runtimeId);
    if (!state) throw new Error(`runtime tunnel is not registered: ${runtimeId}`);
    if (state.control?.readyState === WebSocket.OPEN) return;

    await new Promise<void>((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve: () => {
          clearTimeout(waiter.timer);
          state.waiters.delete(waiter);
          resolve();
        },
        reject: (error) => {
          clearTimeout(waiter.timer);
          state.waiters.delete(waiter);
          reject(error);
        },
        timer: setTimeout(() => {
          waiter.reject(new Error(`runtime reverse tunnel did not connect within ${timeoutMs}ms`));
        }, timeoutMs),
      };
      state.waiters.add(waiter);
    });
  }

  target(runtimeId: string, remotePort: number): string | undefined {
    const state = this.#states.get(runtimeId);
    if (!state || !isTunnelPort(remotePort)) return undefined;
    const localPort = state.localPorts.get(remotePort);
    return localPort ? `http://127.0.0.1:${localPort}` : undefined;
  }

  async remove(runtimeId: string): Promise<void> {
    const state = this.#states.get(runtimeId);
    if (!state) return;
    this.#states.delete(runtimeId);

    for (const waiter of state.waiters) {
      waiter.reject(new Error(`runtime tunnel removed: ${runtimeId}`));
    }
    state.waiters.clear();

    if (state.control && state.control.readyState < WebSocket.CLOSING) {
      state.control.close(1001, 'runtime tunnel removed');
    }
    this.#destroyStreams(state);

    await Promise.all([...state.listeners.values()].map(closeServer));
    state.listeners.clear();
    state.localPorts.clear();
  }

  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): boolean {
    const runtimeId = runtimeIdFromTunnelPath(request.url || '/');
    if (!runtimeId) return false;

    const state = this.#states.get(runtimeId);
    if (!state) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }

    this.#wss.handleUpgrade(request, socket, head, (ws) => {
      this.#attachControl(runtimeId, state, ws);
    });
    return true;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#states.keys()].map((runtimeId) => this.remove(runtimeId)));
    this.#wss.close();
  }

  #attachControl(runtimeId: string, state: TunnelState, ws: WebSocket): void {
    let authenticated = false;
    const authTimer = setTimeout(() => {
      if (!authenticated) ws.close(1008, 'tunnel authentication timeout');
    }, 5_000);

    ws.on('message', (data) => {
      let frame: TunnelFrame;
      try {
        frame = JSON.parse(data.toString()) as TunnelFrame;
      } catch {
        ws.close(1003, 'invalid tunnel frame');
        return;
      }

      if (!authenticated) {
        if (frame.type !== 'auth' || !constantTimeEqual(frame.token, state.token)) {
          ws.close(1008, 'unauthorized tunnel');
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);

        if (state.control && state.control !== ws && state.control.readyState < WebSocket.CLOSING) {
          state.control.close(1012, 'replaced by reconnected tunnel');
        }
        this.#destroyStreams(state);
        state.control = ws;
        sendFrame(ws, { type: 'ready' });
        for (const waiter of [...state.waiters]) waiter.resolve();
        return;
      }

      this.#handleFrame(state, frame);
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (state.control === ws) {
        state.control = undefined;
        this.#destroyStreams(state);
      }
    });

    ws.on('error', () => {
      // close handles state cleanup; errors are intentionally not echoed to clients.
    });

    // The runtime may have been removed while the HTTP upgrade was in flight.
    if (this.#states.get(runtimeId) !== state) ws.close(1001, 'runtime removed');
  }

  #openStream(state: TunnelState, port: TunnelPort, socket: Socket): void {
    const control = state.control;
    if (!control || control.readyState !== WebSocket.OPEN) {
      socket.destroy();
      return;
    }

    const streamId = randomUUID();
    state.streams.set(streamId, socket);
    let closed = false;

    const notifyClose = () => {
      if (closed) return;
      closed = true;
      state.streams.delete(streamId);
      sendFrame(control, { type: 'close', streamId });
    };

    socket.on('data', (chunk) => {
      if (control.readyState !== WebSocket.OPEN) {
        socket.destroy();
        return;
      }
      sendFrame(control, { type: 'data', streamId, data: chunk.toString('base64') });
    });
    socket.on('end', notifyClose);
    socket.on('close', notifyClose);
    socket.on('error', notifyClose);

    sendFrame(control, { type: 'open', streamId, port });
  }

  #handleFrame(state: TunnelState, frame: TunnelFrame): void {
    if (frame.type === 'ping') {
      if (state.control) sendFrame(state.control, { type: 'pong' });
      return;
    }
    if (frame.type !== 'data' && frame.type !== 'close' && frame.type !== 'error') return;

    const socket = state.streams.get(frame.streamId);
    if (!socket) return;

    if (frame.type === 'data') {
      socket.write(Buffer.from(frame.data, 'base64'));
      return;
    }

    state.streams.delete(frame.streamId);
    socket.destroy();
  }

  #destroyStreams(state: TunnelState): void {
    for (const socket of state.streams.values()) socket.destroy();
    state.streams.clear();
  }
}

function isTunnelPort(port: number): port is TunnelPort {
  return (TUNNEL_PORTS as readonly number[]).includes(port);
}

function runtimeIdFromTunnelPath(rawUrl: string): string | undefined {
  const pathname = new URL(rawUrl, 'http://gateway.local').pathname;
  const match = /^\/tunnel\/([A-Za-z0-9_-]{1,128})$/.exec(pathname);
  return match?.[1];
}

function sendFrame(ws: WebSocket, frame: TunnelFrame): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function constantTimeEqual(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function listenLoopback(server: Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to allocate tunnel listener'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
