import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import test from 'node:test';

import { WebSocket } from 'ws';

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
