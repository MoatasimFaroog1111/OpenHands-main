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
  readonly id = 'sandbox-env-test';
  readonly commands: string[] = [];
  readonly files = new Map<string, { data: string; mode?: number }>();

  async exec(command: string): Promise<ExecResult> {
    this.commands.push(command);
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  async writeFile(path: string, data: string, mode?: number): Promise<void> {
    this.files.set(path, { data, mode });
  }

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
  session_id: 'envBootstrapSession',
  run_as_user: 10001,
  run_as_group: 10001,
};

test('launches read-only tunnel without copying or writing inside sidecar', async () => {
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
  const tunnelRunIndex = commands.findIndex(
    (command) =>
      command.startsWith('docker run -d') &&
      command.includes('--name openhands-sandbox-tunnel'),
  );
  assert.ok(tunnelRunIndex >= 0);

  const tunnelRun = commands[tunnelRunIndex];
  assert.match(tunnelRun, /--network host/);
  assert.match(tunnelRun, /--read-only/);
  assert.match(tunnelRun, /--security-opt no-new-privileges/);
  assert.match(tunnelRun, /--cap-drop ALL/);
  assert.match(tunnelRun, /--env-file/);
  assert.match(tunnelRun, /--entrypoint node/);
  assert.match(tunnelRun, /'node:22-alpine'/);
  assert.match(tunnelRun, /'--input-type=module'/);
  assert.match(tunnelRun, /'-e'/);
  assert.doesNotMatch(tunnelRun, /--tmpfs/);
  assert.doesNotMatch(tunnelRun, /OPENHANDS_TUNNEL_TOKEN=/);
  assert.doesNotMatch(tunnelRun, new RegExp(config.apiKey));

  assert.equal(commands.some((command) => command.startsWith('docker cp ')), false);
  assert.equal(commands.some((command) => command.includes('docker exec -i')), false);
  assert.equal(
    commands.some(
      (command) =>
        command.startsWith('docker create') &&
        command.includes('openhands-sandbox-tunnel'),
    ),
    false,
  );

  const tunnelEnvEntry = [...platform.sandbox.files.entries()].find(([, file]) =>
    file.data.includes('OPENHANDS_TUNNEL_URL='),
  );
  assert.ok(tunnelEnvEntry);
  const [envPath, tunnelEnvFile] = tunnelEnvEntry;
  assert.equal(tunnelEnvFile.mode, 0o600);
  assert.match(
    tunnelEnvFile.data,
    /OPENHANDS_TUNNEL_URL=wss:\/\/gateway\.example\.com\/tunnel\/envBootstrapSession/,
  );
  assert.match(tunnelEnvFile.data, /OPENHANDS_TUNNEL_TOKEN=[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(tunnelEnvFile.data, new RegExp(config.apiKey));

  const cleanupIndex = commands.findIndex((command) =>
    command.includes(`rm -f '${envPath}'`),
  );
  assert.ok(cleanupIndex > tunnelRunIndex);
});
