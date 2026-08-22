import assert from 'node:assert/strict';
import test from 'node:test';

import type { GatewayConfig } from '../src/config.js';
import type {
  PlatformCheckpoint,
  PlatformSandbox,
  SandboxPlatform,
} from '../src/platform.js';
import { parsePrivateIpv6 } from '../src/platform.js';
import type { RuntimeRegistry } from '../src/registry.js';
import { RuntimeService } from '../src/runtime-service.js';
import type { ExecResult, RuntimeRecord, StartRuntimeRequest } from '../src/types.js';

class MemoryRegistry implements RuntimeRegistry {
  records = new Map<string, RuntimeRecord>();
  async get(id: string) { return this.records.get(id); }
  async list() { return [...this.records.values()]; }
  async save(record: RuntimeRecord) { this.records.set(record.sessionId, structuredClone(record)); }
  async delete(id: string) { this.records.delete(id); }
}

class FakeSandbox implements PlatformSandbox {
  id: string;
  commands: string[] = [];
  files = new Map<string, string>();
  destroyed = false;
  constructor(id: string) { this.id = id; }
  async exec(command: string): Promise<ExecResult> {
    this.commands.push(command);
    if (command === 'cat /proc/net/if_inet6') {
      return {
        exitCode: 0,
        stdout: 'fd12632d7c8b0001d00001bafa2e7917 02 40 00 80 eth0\n00000000000000000000000000000001 01 80 10 80 lo\n',
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  async writeFile(path: string, data: string): Promise<void> { this.files.set(path, data); }
  async checkpoint(name: string): Promise<PlatformCheckpoint> { return { id: `cp-${this.id}`, key: name }; }
  async destroy(): Promise<void> { this.destroyed = true; }
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
  async restore(): Promise<PlatformSandbox> { return this.create(); }
  async connect(id: string): Promise<PlatformSandbox> {
    const sandbox = this.byId.get(id);
    if (!sandbox) throw new Error('missing sandbox');
    return sandbox;
  }
  async deleteCheckpoint(id: string): Promise<void> { this.deletedCheckpoints.push(id); }
}

const config: GatewayConfig = {
  apiKey: 'gateway-secret',
  publicBaseUrl: 'https://gateway.example.com',
  railwayEnvironmentId: 'env-test',
  registryPath: '/tmp/not-used',
  port: 8080,
  startupTimeoutMs: 5_000,
  idleTimeoutMinutes: 60,
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

test('parsePrivateIpv6 extracts Railway ULA address', () => {
  assert.equal(
    parsePrivateIpv6('fd12632d7c8b0001d00001bafa2e7917 02 40 00 80 eth0\n'),
    'fd12:632d:7c8b:1:d000:1ba:fa2e:7917',
  );
});

test('start, pause, resume and stop preserve the remote runtime contract', async () => {
  const registry = new MemoryRegistry();
  const platform = new FakePlatform();
  const service = new RuntimeService(config, registry, platform, async () => true);

  const started = await service.start(structuredClone(request));
  assert.equal(started.status, 'running');
  assert.equal(started.runtime_id, request.session_id);
  assert.equal(started.url, `https://gateway.example.com/${request.session_id}`);
  assert.ok(started.session_api_key.length > 20);
  assert.match(platform.created[0].commands.join('\n'), /docker run -d/);
  const envFile = [...platform.created[0].files.values()][0];
  assert.match(envFile, /OH_SESSION_API_KEYS_0=/);

  assert.equal(await service.pause(started.runtime_id), true);
  const paused = await service.get(request.session_id);
  assert.equal(paused?.status, 'paused');
  assert.equal(paused?.session_api_key, '');

  const resumed = await service.resume(started.runtime_id);
  assert.equal(resumed?.status, 'running');
  assert.notEqual(resumed?.session_api_key, started.session_api_key);
  assert.equal(platform.created.length, 2);

  assert.equal(await service.stop(started.runtime_id), true);
  assert.equal(await service.get(request.session_id), undefined);
});

test('proxy mapping routes agent-server and named services to private IPv6 ports', async () => {
  const registry = new MemoryRegistry();
  const platform = new FakePlatform();
  const service = new RuntimeService(config, registry, platform, async () => true);
  await service.start(structuredClone(request));

  assert.deepEqual(await service.resolveProxy(`/${request.session_id}/api/events`), {
    target: 'http://[fd12:632d:7c8b:1:d000:1ba:fa2e:7917]:60000',
    path: '/api/events',
  });
  assert.deepEqual(await service.resolveProxy(`/${request.session_id}/vscode/`), {
    target: 'http://[fd12:632d:7c8b:1:d000:1ba:fa2e:7917]:60001',
    path: '/',
  });
});
