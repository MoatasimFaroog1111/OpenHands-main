import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import {
  createConnection,
  createServer as createNetServer,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { buildSandboxTunnelClientSource } from '../src/tunnel-client.js';
import { SandboxTunnelManager } from '../src/tunnel.js';

const token = 'runtime-tunnel-token-that-is-long-enough-for-testing';

test('reverse tunnel authenticates and relays TCP bytes through a multiplexed websocket', async (t) => {
  const manager = new SandboxTunnelManager();
  await manager.register('runtimeA', token);

  const server = createServer();
  server.on('upgrade', (request, socket, head) => {
    manager.handleUpgrade(request, socket, head);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const ws = new WebSocket(
    `ws://127.0.0.1:${address.port}/tunnel/runtimeA`,
  );

  t.after(async () => {
    ws.close();
    await manager.close();
    server.close();
  });

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'auth', token }));
  });
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as {
      type: string;
      streamId?: string;
      data?: string;
    };
    if (frame.type === 'data' && frame.streamId && frame.data) {
      ws.send(
        JSON.stringify({
          type: 'data',
          streamId: frame.streamId,
          data: frame.data,
        }),
      );
    }
  });

  await manager.waitUntilReady('runtimeA', 2_000);
  const target = manager.target('runtimeA', 60000);
  assert.ok(target);
  const localPort = Number(new URL(target).port);
  assert.ok(localPort > 0);

  const socket = createConnection({ host: '127.0.0.1', port: localPort });
  await once(socket, 'connect');
  const received = once(socket, 'data');
  socket.write('RAILWAY_TUNNEL_OK');
  const [chunk] = await received;
  assert.equal(chunk.toString(), 'RAILWAY_TUNNEL_OK');
  socket.destroy();
});

test('generated sandbox tunnel client runs end to end against the gateway transport', async (t) => {
  const echoServer = createNetServer((socket) => socket.pipe(socket));
  echoServer.listen(60000, '127.0.0.1');
  await once(echoServer, 'listening');

  const manager = new SandboxTunnelManager();
  await manager.register('runtimeClient', token);
  const gateway = createServer();
  gateway.on('upgrade', (request, socket, head) => {
    manager.handleUpgrade(request, socket, head);
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const address = gateway.address();
  assert.ok(address && typeof address === 'object');

  const temp = await mkdtemp(join(tmpdir(), 'openhands-tunnel-test-'));
  const scriptPath = join(temp, 'client.mjs');
  const configPath = join(temp, 'config.json');
  await writeFile(scriptPath, buildSandboxTunnelClientSource(), { mode: 0o600 });
  await writeFile(
    configPath,
    JSON.stringify({
      url: `ws://127.0.0.1:${address.port}/tunnel/runtimeClient`,
      token,
    }),
    { mode: 0o600 },
  );

  const child = spawn(process.execPath, [scriptPath, configPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let childStderr = '';
  child.stderr.on('data', (chunk) => {
    childStderr += chunk.toString();
  });

  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit').catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    await manager.close();
    gateway.close();
    echoServer.close();
    await rm(temp, { recursive: true, force: true });
  });

  await Promise.race([
    manager.waitUntilReady('runtimeClient', 5_000),
    once(child, 'exit').then(([code]) => {
      throw new Error(
        `generated tunnel client exited before authentication (${String(code)}): ${childStderr}`,
      );
    }),
  ]);

  const target = manager.target('runtimeClient', 60000);
  assert.ok(target);
  const socket = createConnection({
    host: '127.0.0.1',
    port: Number(new URL(target).port),
  });
  await once(socket, 'connect');
  const received = once(socket, 'data');
  socket.write('SANDBOX_CLIENT_E2E_OK');
  const [chunk] = await received;
  assert.equal(chunk.toString(), 'SANDBOX_CLIENT_E2E_OK');
  socket.destroy();
});

test('reverse tunnel rejects an invalid per-runtime credential', async (t) => {
  const manager = new SandboxTunnelManager();
  await manager.register('runtimeB', token);

  const server = createServer();
  server.on('upgrade', (request, socket, head) => {
    manager.handleUpgrade(request, socket, head);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const ws = new WebSocket(
    `ws://127.0.0.1:${address.port}/tunnel/runtimeB`,
  );
  t.after(async () => {
    ws.close();
    await manager.close();
    server.close();
  });

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'auth', token: 'wrong-token' }));
  });
  const [code] = await once(ws, 'close');
  assert.equal(code, 1008);
});
