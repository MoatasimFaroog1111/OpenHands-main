import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import httpProxy from 'http-proxy';

import type { RuntimeService } from './runtime-service.js';
import type { StartRuntimeRequest } from './types.js';

const MAX_BODY_BYTES = 1_048_576;

export function createGatewayServer(service: RuntimeService, apiKey: string) {
  const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });
  proxy.on('error', (_error, _req, response) => {
    if ('writeHead' in response && !response.headersSent) {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'sandbox proxy unavailable' }));
    }
  });

  const server = createServer((request, response) => {
    void handleHttp(service, proxy, apiKey, request, response);
  });

  server.on('upgrade', (request, socket, head) => {
    void handleUpgrade(service, proxy, request, socket, head);
  });

  return server;
}

async function handleHttp(
  service: RuntimeService,
  proxy: httpProxy,
  apiKey: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(request.url || '/', 'http://gateway.local');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (isControlPath(url.pathname)) {
      if (!authorized(request, apiKey)) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      await handleControl(service, request, response, url);
      return;
    }

    const target = await service.resolveProxy(url.pathname);
    if (!target) {
      sendJson(response, 404, { error: 'runtime not found' });
      return;
    }
    request.url = `${target.path}${url.search}`;
    proxy.web(request, response, { target: target.target });
  } catch (error) {
    sendJson(response, statusForError(error), { error: errorMessage(error) });
  }
}

async function handleControl(
  service: RuntimeService,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  if (request.method === 'POST' && url.pathname === '/start') {
    const runtime = await service.start(await readJson<StartRuntimeRequest>(request));
    sendJson(response, 201, runtime);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/list') {
    sendJson(response, 200, { runtimes: await service.listRunning() });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/sessions/batch') {
    sendJson(response, 200, await service.batch(url.searchParams.getAll('ids')));
    return;
  }
  if (request.method === 'GET' && url.pathname.startsWith('/sessions/')) {
    const id = decodeURIComponent(url.pathname.slice('/sessions/'.length));
    const runtime = await service.get(id);
    if (!runtime) sendJson(response, 404, { error: 'runtime not found' });
    else sendJson(response, 200, runtime);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/pause') {
    const body = await readJson<{ runtime_id: string }>(request);
    const ok = await service.pause(body.runtime_id);
    sendJson(response, ok ? 200 : 404, ok ? { status: 'paused' } : { error: 'runtime not found' });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/resume') {
    const body = await readJson<{ runtime_id: string }>(request);
    const runtime = await service.resume(body.runtime_id);
    if (!runtime) sendJson(response, 404, { error: 'runtime not found' });
    else sendJson(response, 200, runtime);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/stop') {
    const body = await readJson<{ runtime_id: string }>(request);
    const ok = await service.stop(body.runtime_id);
    sendJson(response, ok ? 200 : 404, ok ? { status: 'stopped' } : { error: 'runtime not found' });
    return;
  }
  sendJson(response, 404, { error: 'not found' });
}

async function handleUpgrade(
  service: RuntimeService,
  proxy: httpProxy,
  request: IncomingMessage,
  socket: Socket,
  head: Buffer,
): Promise<void> {
  try {
    const url = new URL(request.url || '/', 'http://gateway.local');
    const target = await service.resolveProxy(url.pathname);
    if (!target) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    request.url = `${target.path}${url.search}`;
    proxy.ws(request, socket, head, { target: target.target });
  } catch {
    socket.destroy();
  }
}

function isControlPath(pathname: string): boolean {
  return (
    pathname === '/start' ||
    pathname === '/list' ||
    pathname === '/pause' ||
    pathname === '/resume' ||
    pathname === '/stop' ||
    pathname === '/sessions/batch' ||
    pathname.startsWith('/sessions/')
  );
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const received = request.headers['x-api-key'];
  if (typeof received !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function statusForError(error: unknown): number {
  const message = errorMessage(error);
  if (message.includes('already exists')) return 409;
  if (
    message.includes('required') ||
    message.includes('must ') ||
    message.includes('invalid ') ||
    message.includes('unsupported') ||
    message.includes('collides')
  ) {
    return 400;
  }
  return 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
