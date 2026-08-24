import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import test from 'node:test';

import type { GatewayConfig } from '../src/config.js';
import { createGatewayServer } from '../src/http-server.js';
import type { PlatformSandbox, SandboxPlatform } from '../src/platform.js';
import type { RuntimeRegistry } from '../src/registry.js';
import { RuntimeService } from '../src/runtime-service.js';
import type {
  RuntimeTunnel,
  TunnelUpgradeHandler,
} from '../src/tunnel.js';
import type {
  ExecResult,
  RuntimeRecord,
  StartRuntimeRequest,
} from '../src/types.js';

class MemoryRegistry implements RuntimeRegistry {
  records = new Map<string, RuntimeRecord>();
  async get(id: string) {
    return this.records.get(id);
  }
  async list() {
    return [...this.records.values()];
  }
  async save(record: RuntimeRecord) {
    this.records.set(record.sessionId, structuredClone(record));
  }
  async delete(id: string) {
    this.records.delete(id);
  }
}

class SandboxStub implements PlatformSandbox {
  id = 'sbx-http';
  async exec(): Promise<ExecResult> {
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  async writeFile(): Promise<void> {}
  async checkpoint(name: string) {
    return { id: 'cp-http', key: name };
  }
  async destroy(): Promise<void> {}
}

class PlatformStub implements SandboxPlatform {
  sandbox = new SandboxStub();
  async create() {
    return this.sandbox;
  }
  async restore() {
    return this.sandbox;
  }
  async connect() {
    return this.sandbox;
  }
  async deleteCheckpoint(): Promise<void> {}
}

class TunnelStub implements RuntimeTunnel, TunnelUpgradeHandler {
  active = new Set<string>();
  async register(runtimeId: string): Promise<void> {
    this.active.add(runtimeId);
  }
  async waitUntilReady(): Promise<void> {}
  target(runtimeId: string, remotePort: number): string | undefined {
    return this.active.has(runtimeId)
      ? `http://127.0.0.1:${remotePort}`
      : undefined;
  }
  async remove(runtimeId: string): Promise<void> {
    this.active.delete(runtimeId);
  }
  handleUpgrade(
    _request: IncomingMessage,
    _socket: Socket,
    _head: Buffer,
  ): boolean {
    return false;
  }
  async close(): Promise<void> {}
}

const config: GatewayConfig = {
  apiKey: 'control-secret-that-is-at-least-32-characters',
  publicBaseUrl: 'https://gateway.example.com',
  tunnelBaseUrl: 'https://gateway.example.com',
  railwayEnvironmentId: 'env-test',
  registryPath: '/tmp/not-used',
  port: 8080,
  startupTimeoutMs: 5_000,
  idleTimeoutMinutes: 60,
  keepAliveSeconds: 240,
};

const body: StartRuntimeRequest = {
  image: 'ghcr.io/openhands/runtime:test',
  command: ['/usr/local/bin/openhands-agent-server', '--port', '60000'],
  session_id: 'httpSession1',
  environment: {},
};

test('control API authenticates, clears stale failed starts, and exposes RemoteRuntime endpoints', async (t) => {
  const registry = new MemoryRegistry();
  await registry.save({
    sessionId: body.session_id,
    runtimeId: body.session_id,
    status: 'error',
    request: structuredClone(body),
    sessionKeyVersion: 1,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    lastError: 'simulated previous provisioning failure',
  });

  const tunnel = new TunnelStub();
  const service = new RuntimeService(
    config,
    registry,
    new PlatformStub(),
    tunnel,
    async () => true,
  );
  const server = createGatewayServer(service, config.apiKey, tunnel);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/list`)).status, 401);
  assert.equal((await fetch(`${base}/tunnel/anything`)).status, 426);

  const headers = {
    'content-type': 'application/json',
    'x-api-key': config.apiKey,
  };
  const start = await fetch(`${base}/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(start.status, 201);
  const started = (await start.json()) as {
    runtime_id: string;
    status: string;
  };
  assert.equal(started.runtime_id, body.session_id);
  assert.equal(started.status, 'running');

  const session = await fetch(`${base}/sessions/${body.session_id}`, {
    headers,
  });
  assert.equal(session.status, 200);
  const list = await fetch(`${base}/list`, { headers });
  assert.equal(list.status, 200);
  const listed = (await list.json()) as { runtimes: unknown[] };
  assert.equal(listed.runtimes.length, 1);

  const batch = await fetch(
    `${base}/sessions/batch?ids=${body.session_id}`,
    { headers },
  );
  assert.equal(batch.status, 200);
  assert.equal(((await batch.json()) as unknown[]).length, 1);
});
