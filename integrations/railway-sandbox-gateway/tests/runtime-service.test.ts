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
    if (this.destroyed) throw new Error('cannot execute command after sandbox destruction');
    this.commands.push(command);
    if (command === 'cat /proc/net/if_inet6') {
      return {
        exitCode: 0,
        stdout: 'fd12632d7c8b0001d00001bafa2e7917 02 40 00 80 eth0\n00000000000000000000000000000001 01 80 10 80 lo\n',
        stderr: '',
      };
    }
    if (command.startsWith('docker logs --tail')) {
      return {
        exitCode: 0,
        stdout: [
          'agent boot failed before health became ready',
          'TOKEN=super-secret-token',
          'OPENAI_API_KEY=sk-test-secret-value',
          'Authorization: Bearer hidden-bearer-token',
        ].join('\n'),
        stderr: '',
      };
    }
    if (command.startsWith('docker ps -a')) {
      return {
        exitCode: 0,
        stdout: 'openhands-agent-server\tghcr.io/openhands/runtime:test\tExited (1)\t',
        stderr: '',
      };
    }
    if (command.startsWith('docker inspect --format')) {
      return {
        exitCode: 0,
        stdout: 'status=exited exit=1 oom=false error=""',
        stderr: '',
      };
    }
    if (command.startsWith('docker exec')) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'container is not running',
      };
    }
    if (command.includes('command -v curl')) {
      return {
        exitCode: 0,
        stdout: 'URL=http://127.0.0.1:60000/health\nHTTP=000\nCURL_EXIT=7',
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
  apiKey: 'gateway-secret-that-is-at-least-32-characters',
  publicBaseUrl: 'https://gateway.example.com',
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

test('parsePrivateIpv6 extracts Railway ULA address', () => {
  assert.equal(
    parsePrivateIpv6('fd12632d7c8b0001d00001bafa2e7917 02 40 00 80 eth0\n'),
    'fd12:632d:7c8b:1:d000:1ba:fa2e:7917',
  );
});

test('start, keepalive, pause, resume and stop preserve the remote runtime contract', async () => {
  const registry = new MemoryRegistry();
  const platform = new FakePlatform();
  const service = new RuntimeService(config, registry, platform, async () => true);

  const started = await service.start(structuredClone(request));
  assert.equal(started.status, 'running');
  assert.equal(started.runtime_id, request.session_id);
  assert.equal(started.url, `https://gateway.example.com/${request.session_id}`);
  assert.ok(started.session_api_key.length > 20);

  const dockerRun = platform.created[0].commands.find((command) => command.startsWith('docker run -d'));
  assert.ok(dockerRun);
  assert.ok(dockerRun.includes("--entrypoint '/usr/local/bin/openhands-agent-server'"));
  assert.ok(dockerRun.includes("'ghcr.io/openhands/runtime:test' '--port' '60000'"));
  assert.ok(!dockerRun.includes("'ghcr.io/openhands/runtime:test' '/usr/local/bin/openhands-agent-server'"));

  const envFile = [...platform.created[0].files.values()][0];
  assert.match(envFile, /OH_SESSION_API_KEYS_0=/);

  const keepalive = await service.keepAlive();
  assert.deepEqual(keepalive, { checked: 1, failed: [] });
  assert.ok(platform.created[0].commands.includes('true'));

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

test('health timeout captures sanitized diagnostics before destroying the sandbox', async () => {
  const registry = new MemoryRegistry();
  const platform = new FakePlatform();
  const service = new RuntimeService(
    { ...config, startupTimeoutMs: 0 },
    registry,
    platform,
    async () => false,
  );

  await assert.rejects(
    () => service.start(structuredClone(request)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /agent-server did not become healthy within 0ms/);
      assert.match(error.message, /\[startup-diagnostics\]/);
      assert.match(error.message, /\[sandbox-health\]/);
      assert.match(error.message, /\[container-health\]/);
      assert.match(error.message, /\[container-state\]/);
      assert.match(error.message, /\[docker-ps\]/);
      assert.match(error.message, /\[docker-logs\]/);
      assert.match(error.message, /agent boot failed before health became ready/);
      assert.match(error.message, /\[REDACTED/);
      assert.doesNotMatch(error.message, /super-secret-token/);
      assert.doesNotMatch(error.message, /sk-test-secret-value/);
      assert.doesNotMatch(error.message, /hidden-bearer-token/);
      return true;
    },
  );

  const sandbox = platform.created[0];
  assert.equal(sandbox.destroyed, true);
  assert.ok(sandbox.commands.some((command) => command.includes('command -v curl')));
  assert.ok(sandbox.commands.some((command) => command.startsWith('docker logs --tail')));

  const failed = registry.records.get(request.session_id);
  assert.equal(failed?.status, 'error');
  assert.match(failed?.lastError || '', /\[startup-diagnostics\]/);
  assert.doesNotMatch(failed?.lastError || '', /super-secret-token/);
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
