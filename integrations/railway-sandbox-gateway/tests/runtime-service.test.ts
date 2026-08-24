import assert from 'node:assert/strict';
import test from 'node:test';

import type { GatewayConfig } from '../src/config.js';
import type {
  PlatformCheckpoint,
  PlatformSandbox,
  SandboxPlatform,
} from '../src/platform.js';
import type { RuntimeRegistry } from '../src/registry.js';
import { RuntimeService } from '../src/runtime-service.js';
import type { RuntimeTunnel } from '../src/tunnel.js';
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

class FakeSandbox implements PlatformSandbox {
  id: string;
  commands: string[] = [];
  files = new Map<string, { data: string; mode?: number }>();
  destroyed = false;
  constructor(id: string) {
    this.id = id;
  }
  async exec(command: string): Promise<ExecResult> {
    this.commands.push(command);
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  async writeFile(path: string, data: string, mode?: number): Promise<void> {
    this.files.set(path, { data, mode });
  }
  async checkpoint(name: string): Promise<PlatformCheckpoint> {
    return { id: `cp-${this.id}`, key: name };
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

class FakePlatform implements SandboxPlatform {
  next = 1;
  created: FakeSandbox[] = [];
  deletedCheckpoints: string[] = [];
  byId = new Map<string, FakeSandbox>();
  async create(): Promise<PlatformSandbox> {
    const sandbox = new FakeSandbox(`sbx-${this.next++}`);
    this.created.push(sandbox);
    this.byId.set(sandbox.id, sandbox);
    return sandbox;
  }
  async restore(): Promise<PlatformSandbox> {
    return this.create();
  }
  async connect(id: string): Promise<PlatformSandbox> {
    const sandbox = this.byId.get(id);
    if (!sandbox) throw new Error('missing sandbox');
    return sandbox;
  }
  async deleteCheckpoint(id: string): Promise<void> {
    this.deletedCheckpoints.push(id);
  }
}

class FakeTunnel implements RuntimeTunnel {
  registered: Array<{ runtimeId: string; token: string }> = [];
  removed: string[] = [];
  active = new Set<string>();

  async register(runtimeId: string, token: string): Promise<void> {
    this.registered.push({ runtimeId, token });
    this.active.add(runtimeId);
  }
  async waitUntilReady(runtimeId: string): Promise<void> {
    assert.ok(this.active.has(runtimeId));
  }
  target(runtimeId: string, remotePort: number): string | undefined {
    if (!this.active.has(runtimeId)) return undefined;
    const ports: Record<number, number> = {
      60000: 46000,
      60001: 46001,
      12000: 42000,
      12001: 42001,
    };
    const port = ports[remotePort];
    return port ? `http://127.0.0.1:${port}` : undefined;
  }
  async remove(runtimeId: string): Promise<void> {
    this.removed.push(runtimeId);
    this.active.delete(runtimeId);
  }
}

const config: GatewayConfig = {
  apiKey: 'gateway-secret-that-is-at-least-32-characters',
  publicBaseUrl: 'https://gateway.example.com',
  tunnelBaseUrl: 'https://gateway.example.com',
  railwayEnvironmentId: 'env-test',
  registryPath: '/tmp/not-used',
  port: 8080,
  startupTimeoutMs: 5_000,
  idleTimeoutMinutes: 60,
  keepAliveSeconds: 240,
};

const request: StartRuntimeRequest = {
  image: 'ghcr.io/openhands/runtime:test',
  command: ['/usr/local/bin/openhands-agent-server', '--port', '60000'],
  working_dir: '/workspace',
  environment: { LOG_JSON: 'true' },
  session_id: 'sessionABC123',
  run_as_user: 10001,
  run_as_group: 10001,
};

test('start, keepalive, pause, resume and stop preserve the remote runtime contract', async () => {
  const registry = new MemoryRegistry();
  const platform = new FakePlatform();
  const tunnel = new FakeTunnel();
  const healthUrls: string[] = [];
  const service = new RuntimeService(
    config,
    registry,
    platform,
    tunnel,
    async (url) => {
      healthUrls.push(url);
      return true;
    },
  );

  const started = await service.start(structuredClone(request));
  assert.equal(started.status, 'running');
  assert.equal(started.runtime_id, request.session_id);
  assert.equal(
    started.url,
    `https://gateway.example.com/${request.session_id}`,
  );
  assert.ok(started.session_api_key.length > 20);
  assert.deepEqual(healthUrls, ['http://127.0.0.1:46000/health']);

  const firstSandbox = platform.created[0];
  const dockerRun = firstSandbox.commands.find(
    (command) =>
      command.startsWith('docker run -d') &&
      command.includes('--name openhands-agent-server'),
  );
  assert.ok(dockerRun);
  assert.ok(
    dockerRun.includes("--entrypoint '/usr/local/bin/openhands-agent-server'"),
  );
  assert.ok(
    dockerRun.includes("'ghcr.io/openhands/runtime:test' '--port' '60000'"),
  );
  assert.ok(
    !dockerRun.includes(
      "'ghcr.io/openhands/runtime:test' '/usr/local/bin/openhands-agent-server'",
    ),
  );
  assert.match(dockerRun, /127\.0\.0\.1:60000:60000/);
  assert.doesNotMatch(dockerRun, /\[::\]:60000:60000/);

  const tunnelRun = firstSandbox.commands.find((command) =>
    command.includes('--name openhands-sandbox-tunnel'),
  );
  assert.ok(tunnelRun);
  assert.match(tunnelRun, /--network host/);
  assert.match(tunnelRun, /--read-only/);
  assert.match(tunnelRun, /--cap-drop ALL/);
  assert.match(tunnelRun, /'node:22-alpine'/);

  const envFile = [...firstSandbox.files.values()].find(({ data }) =>
    data.includes('OH_SESSION_API_KEYS_0='),
  );
  assert.ok(envFile);
  assert.equal(envFile.mode, 0o600);

  const tunnelConfig = [...firstSandbox.files.values()].find(({ data }) =>
    data.includes('wss://gateway.example.com/tunnel/sessionABC123'),
  );
  assert.ok(tunnelConfig);
  assert.equal(tunnelConfig.mode, 0o600);
  assert.doesNotMatch(tunnelConfig.data, new RegExp(config.apiKey));
  assert.equal(tunnel.registered.length, 1);

  const keepalive = await service.keepAlive();
  assert.deepEqual(keepalive, { checked: 1, failed: [] });
  assert.ok(firstSandbox.commands.includes('true'));

  assert.equal(await service.pause(started.runtime_id), true);
  const paused = await service.get(request.session_id);
  assert.equal(paused?.status, 'paused');
  assert.equal(paused?.session_api_key, '');
  assert.ok(tunnel.removed.includes(request.session_id));

  const resumed = await service.resume(started.runtime_id);
  assert.equal(resumed?.status, 'running');
  assert.notEqual(resumed?.session_api_key, started.session_api_key);
  assert.equal(platform.created.length, 2);
  assert.equal(tunnel.registered.length, 2);
  assert.notEqual(tunnel.registered[0].token, tunnel.registered[1].token);

  assert.equal(await service.stop(started.runtime_id), true);
  assert.equal(await service.get(request.session_id), undefined);
});

test('proxy mapping routes agent-server and named services through loopback tunnel listeners', async () => {
  const registry = new MemoryRegistry();
  const platform = new FakePlatform();
  const tunnel = new FakeTunnel();
  const service = new RuntimeService(
    config,
    registry,
    platform,
    tunnel,
    async () => true,
  );
  await service.start(structuredClone(request));

  assert.deepEqual(
    await service.resolveProxy(`/${request.session_id}/api/events`),
    {
      target: 'http://127.0.0.1:46000',
      path: '/api/events',
    },
  );
  assert.deepEqual(
    await service.resolveProxy(`/${request.session_id}/vscode/`),
    {
      target: 'http://127.0.0.1:46001',
      path: '/',
    },
  );
});

test('initialize restores tunnel listeners for persisted running runtimes', async () => {
  const registry = new MemoryRegistry();
  await registry.save({
    sessionId: request.session_id,
    runtimeId: request.session_id,
    status: 'running',
    request: structuredClone(request),
    sandboxId: 'existing-sandbox',
    sessionKeyVersion: 3,
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
  });
  const tunnel = new FakeTunnel();
  const service = new RuntimeService(
    config,
    registry,
    new FakePlatform(),
    tunnel,
    async () => true,
  );

  await service.initialize();
  assert.equal(tunnel.registered.length, 1);
  assert.equal(tunnel.registered[0].runtimeId, request.session_id);
  assert.ok(tunnel.registered[0].token.length > 20);
});
