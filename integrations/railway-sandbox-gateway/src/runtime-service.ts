import { createHmac } from 'node:crypto';

import type { GatewayConfig } from './config.js';
import { parsePrivateIpv6, type PlatformSandbox, type SandboxPlatform } from './platform.js';
import type { RuntimeRegistry } from './registry.js';
import type {
  ProxyTarget,
  RuntimeRecord,
  RuntimeView,
  StartRuntimeRequest,
} from './types.js';

const CONTROL_PATHS = new Set([
  'healthz',
  'list',
  'pause',
  'resume',
  'sessions',
  'start',
  'stop',
]);
const AGENT_SERVER_PORT = 60000;
const SERVICE_PORTS: Record<string, number> = {
  vscode: 60001,
  'work-1': 12000,
  'work-2': 12001,
};
const CONTAINER_NAME = 'openhands-agent-server';

export type HealthProbe = (url: string) => Promise<boolean>;

export class RuntimeService {
  readonly #config: GatewayConfig;
  readonly #registry: RuntimeRegistry;
  readonly #platform: SandboxPlatform;
  readonly #probe: HealthProbe;

  constructor(
    config: GatewayConfig,
    registry: RuntimeRegistry,
    platform: SandboxPlatform,
    probe: HealthProbe = defaultHealthProbe,
  ) {
    this.#config = config;
    this.#registry = registry;
    this.#platform = platform;
    this.#probe = probe;
  }

  async start(request: StartRuntimeRequest): Promise<RuntimeView> {
    validateStartRequest(request);
    if (await this.#registry.get(request.session_id)) {
      throw new Error(`runtime already exists for session ${request.session_id}`);
    }

    const now = new Date().toISOString();
    const record: RuntimeRecord = {
      sessionId: request.session_id,
      runtimeId: request.session_id,
      status: 'starting',
      request,
      sessionKeyVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.#registry.save(record);

    let sandbox: PlatformSandbox | undefined;
    try {
      sandbox = await this.#platform.create();
      record.sandboxId = sandbox.id;
      record.privateIpv6 = await this.#discoverPrivateIpv6(sandbox);
      await this.#launchRuntime(sandbox, record);
      await this.#waitUntilHealthy(record.privateIpv6);
      record.status = 'running';
      record.updatedAt = new Date().toISOString();
      record.lastError = undefined;
      await this.#registry.save(record);
      return this.#toView(record);
    } catch (error) {
      record.status = 'error';
      record.lastError = errorMessage(error);
      record.updatedAt = new Date().toISOString();
      await this.#registry.save(record);
      if (sandbox) await sandbox.destroy().catch(() => undefined);
      throw error;
    }
  }

  async get(sessionId: string): Promise<RuntimeView | undefined> {
    const record = await this.#registry.get(sessionId);
    return record ? this.#toView(record) : undefined;
  }

  async batch(sessionIds: string[]): Promise<RuntimeView[]> {
    const results: RuntimeView[] = [];
    for (const id of sessionIds) {
      const runtime = await this.get(id);
      if (runtime) results.push(runtime);
    }
    return results;
  }

  async listRunning(): Promise<RuntimeView[]> {
    const records = await this.#registry.list();
    return records
      .filter((record) => record.status === 'running' || record.status === 'starting')
      .map((record) => this.#toView(record));
  }

  async pause(runtimeId: string): Promise<boolean> {
    const record = await this.#findByRuntimeId(runtimeId);
    if (!record) return false;
    if (record.status === 'paused') return true;
    if (!record.sandboxId) return false;

    const sandbox = await this.#platform.connect(record.sandboxId);
    await sandbox.exec(`docker rm -f ${CONTAINER_NAME} >/dev/null 2>&1 || true`, {
      timeoutSec: 30,
    });

    const checkpointName = checkpointNameFor(record.sessionId);
    const checkpoint = await sandbox.checkpoint(checkpointName);
    await sandbox.destroy();

    const previousCheckpointId = record.checkpointId;
    record.checkpointId = checkpoint.id;
    record.checkpointName = checkpoint.key;
    record.sandboxId = undefined;
    record.privateIpv6 = undefined;
    record.status = 'paused';
    record.updatedAt = new Date().toISOString();
    await this.#registry.save(record);

    if (previousCheckpointId && previousCheckpointId !== checkpoint.id) {
      await this.#platform.deleteCheckpoint(previousCheckpointId).catch(() => undefined);
    }
    return true;
  }

  async resume(runtimeId: string): Promise<RuntimeView | undefined> {
    const record = await this.#findByRuntimeId(runtimeId);
    if (!record) return undefined;
    if (record.status === 'running') return this.#toView(record);
    if (!record.checkpointName) throw new Error('paused runtime has no checkpoint');

    let sandbox: PlatformSandbox | undefined;
    try {
      record.status = 'starting';
      record.sessionKeyVersion += 1;
      record.updatedAt = new Date().toISOString();
      await this.#registry.save(record);

      sandbox = await this.#platform.restore(record.checkpointName);
      record.sandboxId = sandbox.id;
      record.privateIpv6 = await this.#discoverPrivateIpv6(sandbox);
      await this.#launchRuntime(sandbox, record);
      await this.#waitUntilHealthy(record.privateIpv6);
      record.status = 'running';
      record.lastError = undefined;
      record.updatedAt = new Date().toISOString();
      await this.#registry.save(record);
      return this.#toView(record);
    } catch (error) {
      record.status = 'error';
      record.lastError = errorMessage(error);
      record.updatedAt = new Date().toISOString();
      await this.#registry.save(record);
      if (sandbox) await sandbox.destroy().catch(() => undefined);
      throw error;
    }
  }

  async stop(runtimeId: string): Promise<boolean> {
    const record = await this.#findByRuntimeId(runtimeId);
    if (!record) return false;

    if (record.sandboxId) {
      try {
        const sandbox = await this.#platform.connect(record.sandboxId);
        await sandbox.destroy();
      } catch {
        // The sandbox may already have expired; registry cleanup still must complete.
      }
    }
    if (record.checkpointId) {
      await this.#platform.deleteCheckpoint(record.checkpointId).catch(() => undefined);
    }
    await this.#registry.delete(record.sessionId);
    return true;
  }

  async resolveProxy(pathname: string): Promise<ProxyTarget | undefined> {
    const parts = pathname.split('/').filter(Boolean);
    const runtimeId = parts.shift();
    if (!runtimeId || CONTROL_PATHS.has(runtimeId)) return undefined;
    const record = await this.#findByRuntimeId(runtimeId);
    if (!record || record.status !== 'running' || !record.privateIpv6) return undefined;

    let port = AGENT_SERVER_PORT;
    if (parts[0] && SERVICE_PORTS[parts[0]]) {
      port = SERVICE_PORTS[parts.shift()!];
    }
    const path = `/${parts.join('/')}` || '/';
    return {
      target: `http://[${record.privateIpv6}]:${port}`,
      path,
    };
  }

  async #findByRuntimeId(runtimeId: string): Promise<RuntimeRecord | undefined> {
    const direct = await this.#registry.get(runtimeId);
    if (direct?.runtimeId === runtimeId) return direct;
    return (await this.#registry.list()).find((record) => record.runtimeId === runtimeId);
  }

  async #discoverPrivateIpv6(sandbox: PlatformSandbox): Promise<string> {
    const result = await sandbox.exec('cat /proc/net/if_inet6', { timeoutSec: 10 });
    if (result.exitCode !== 0) {
      throw new Error(`failed to inspect Railway private network: ${result.stderr}`);
    }
    return parsePrivateIpv6(result.stdout);
  }

  async #launchRuntime(sandbox: PlatformSandbox, record: RuntimeRecord): Promise<void> {
    const request = record.request;
    const uid = request.run_as_user ?? 10001;
    const gid = request.run_as_group ?? 10001;
    const workingDir = request.working_dir || '/workspace';
    const env = {
      ...(request.environment || {}),
      OH_SESSION_API_KEYS_0: this.#sessionKey(record),
    };
    validateEnvironment(env);

    const envPath = `/tmp/openhands-runtime-${record.sessionId}.env`;
    await sandbox.writeFile(
      envPath,
      `${Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
      0o600,
    );

    const setup = await sandbox.exec(
      `mkdir -p /workspace && chown -R ${uid}:${gid} /workspace`,
      { timeoutSec: 30 },
    );
    ensureExecSuccess(setup, 'prepare workspace');

    await sandbox.exec(`docker rm -f ${CONTAINER_NAME} >/dev/null 2>&1 || true`, {
      timeoutSec: 30,
    });

    const command = [
      'docker run -d',
      `--name ${CONTAINER_NAME}`,
      '--pull=missing',
      '--init',
      `--user ${shellQuote(`${uid}:${gid}`)}`,
      `--workdir ${shellQuote(workingDir)}`,
      `--env-file ${shellQuote(envPath)}`,
      '--volume /workspace:/workspace',
      '-p "[::]:60000:60000"',
      '-p "[::]:60001:60001"',
      '-p "[::]:12000:12000"',
      '-p "[::]:12001:12001"',
      shellQuote(request.image),
      ...request.command.map(shellQuote),
    ].join(' ');

    const launched = await sandbox.exec(command, { timeoutSec: 120 });
    await sandbox.exec(`rm -f ${shellQuote(envPath)}`, { timeoutSec: 10 });
    ensureExecSuccess(launched, 'launch OpenHands agent-server container');
  }

  async #waitUntilHealthy(ipv6: string): Promise<void> {
    const deadline = Date.now() + this.#config.startupTimeoutMs;
    const url = `http://[${ipv6}]:${AGENT_SERVER_PORT}/health`;
    while (Date.now() < deadline) {
      if (await this.#probe(url)) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`agent-server did not become healthy within ${this.#config.startupTimeoutMs}ms`);
  }

  #sessionKey(record: RuntimeRecord): string {
    return createHmac('sha256', this.#config.apiKey)
      .update(`${record.sessionId}:${record.sessionKeyVersion}`)
      .digest('base64url');
  }

  #toView(record: RuntimeRecord): RuntimeView {
    return {
      session_id: record.sessionId,
      runtime_id: record.runtimeId,
      status: record.status,
      url:
        record.status === 'running'
          ? `${this.#config.publicBaseUrl}/${record.runtimeId}`
          : null,
      session_api_key:
        record.status === 'running' ? this.#sessionKey(record) : '',
    };
  }
}

async function defaultHealthProbe(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function validateStartRequest(request: StartRuntimeRequest): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.session_id)) {
    throw new Error('session_id must contain only letters, numbers, underscore, or dash');
  }
  if (CONTROL_PATHS.has(request.session_id)) {
    throw new Error('session_id collides with a reserved gateway route');
  }
  if (!request.image?.trim()) throw new Error('image is required');
  if (!Array.isArray(request.command) || request.command.length === 0) {
    throw new Error('command must contain at least one argument');
  }
}

function validateEnvironment(environment: Record<string, string>): void {
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`invalid environment variable name: ${key}`);
    }
    if (value.includes('\n') || value.includes('\0')) {
      throw new Error(`environment variable ${key} contains an unsupported newline or NUL`);
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function checkpointNameFor(sessionId: string): string {
  return `oh-${sessionId.slice(0, 24)}-${Date.now().toString(36)}`;
}

function ensureExecSuccess(result: { exitCode: number | null; stderr: string }, action: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`${action} failed (${result.exitCode}): ${result.stderr}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
