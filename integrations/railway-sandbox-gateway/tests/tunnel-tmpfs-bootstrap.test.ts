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
  readonly records = new Map<string, RuntimeRecord>();

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

class RecordingSandbox implements PlatformSandbox {
  readonly id = 'sandbox-tmpfs-test';
  readonly commands: string[] = [];

  async exec(command: string): Promise<ExecResult> {
    this.commands.push(command);
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  async writeFile(): Promise<void> {}

  async checkpoint(name: string): Promise<PlatformCheckpoint> {
    return { id: `checkpoint-${name}`, key: name };
  }

  async destroy(): Promise<void> {}
}

class RecordingPlatform implements SandboxPlatform {
  readonly sandbox = new RecordingSandbox();

  async create(): Promise<PlatformSandbox> {
    return this.sandbox;
  }

  async restore(): Promise<PlatformSandbox> {
    return this.sandbox;
  }

  async connect(): Promise<PlatformSandbox> {
    return this.sandbox;
  }

  async deleteCheckpoint(): Promise<void> {}
}

class ReadyTunnel implements RuntimeTunnel {
  active = false;

  async register(): Promise<void> {
    this.active = true;
  }

  async waitUntilReady(): Promise<void> {
    assert.equal(this.active, true);
  }

  target(_runtimeId: string, remotePort: number): string | undefined {
    return this.active ? `http://127.0.0.1:${remotePort}` : undefined;
  }

  async remove(): Promise<void> {
    this.active = false;
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
  image: 'ghcr.io/openhands/agent-server:1.29.0-python',
  command: ['/usr/local/bin/openhands-agent-server', '--port', '60000'],
  working_dir: '/workspace',
  environment: {},
  session_id: 'tmpfsBootstrapSession',
  run_as_user: 10001,
  run_as_group: 10001,
};

test('starts read-only tunnel sidecar before copying bootstrap files into writable tmpfs', async () => {
  const registry = new MemoryRegistry();
  const platform = new RecordingPlatform();
  const tunnel = new ReadyTunnel();
  const service = new RuntimeService(
    config,
    registry,
    platform,
    tunnel,
    async () => true,
  );

  await service.start(structuredClone(request));

  const commands = platform.sandbox.commands;
  const createIndex = commands.findIndex(
    (command) =>
      command.startsWith('docker create') &&
      command.includes('--name openhands-sandbox-tunnel'),
  );
  const startIndex = commands.findIndex(
    (command) => command === 'docker start openhands-sandbox-tunnel',
  );
  const copyClientIndex = commands.findIndex(
    (command) =>
      command.startsWith('docker cp ') && command.includes('tunnel-client.mjs'),
  );
  const copyConfigIndex = commands.findIndex(
    (command) =>
      command.startsWith('docker cp ') && command.includes('tunnel-config.json'),
  );

  assert.ok(createIndex >= 0);
  assert.ok(startIndex > createIndex);
  assert.ok(copyClientIndex > startIndex);
  assert.ok(copyConfigIndex > copyClientIndex);

  const createCommand = commands[createIndex];
  assert.match(createCommand, /--read-only/);
  assert.match(
    createCommand,
    /--tmpfs '\/tmp:rw,nosuid,nodev,noexec,size=1m'/,
  );
  assert.match(createCommand, /--entrypoint sh/);
  assert.match(createCommand, /while \[ ! -s/);
  assert.match(createCommand, /exec node/);
});
