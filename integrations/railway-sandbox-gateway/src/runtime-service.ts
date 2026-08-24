import { createHmac } from 'node:crypto';

import type { GatewayConfig } from './config.js';
import type { PlatformSandbox, SandboxPlatform } from './platform.js';
import type { RuntimeRegistry } from './registry.js';
import { collectStartupDiagnostics } from './startup-diagnostics.js';
import { buildSandboxTunnelClientSource } from './tunnel-client.js';
import type { RuntimeTunnel } from './tunnel.js';
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
  'tunnel',
]);
const AGENT_SERVER_PORT = 60000;
const SERVICE_PORTS: Record<string, number> = {
  vscode: 60001,
  'work-1': 12000,
  'work-2': 12001,
};
const CONTAINER_NAME = 'openhands-agent-server';
const TUNNEL_CONTAINER_NAME = 'openhands-sandbox-tunnel';
const TUNNEL_IMAGE = 'node:22-alpine';
const TUNNEL_CLIENT_CONTAINER_PATH = '/tmp/openhands-tunnel-client.mjs';
const TUNNEL_CONFIG_CONTAINER_PATH = '/tmp/openhands-tunnel-config.json';
const TUNNEL_TMPFS = '/tmp:rw,nosuid,nodev,noexec,size=1m';
const TUNNEL_BOOTSTRAP =
  'while [ ! -s "$1" ] || [ ! -s "$2" ]; do sleep 0.1; done; exec node "$1" "$2"';

export type HealthProbe = (url: string) => Promise<boolean>;

export class RuntimeService {
  readonly #config: GatewayConfig;
  readonly #registry: RuntimeRegistry;
  readonly #platform: SandboxPlatform;
  readonly #tunnel: RuntimeTunnel;
  readonly #probe: HealthProbe;

  constructor(
    config: GatewayConfig,
    registry: RuntimeRegistry,
    platform: SandboxPlatform,
    tunnel: RuntimeTunnel,
    probe: HealthProbe = defaultHealthProbe,
  ) {
    this.#config = config;
    this.#registry = registry;
    this.#platform = platform;
    this.#tunnel = tunnel;
    this.#probe = probe;
  }

  async initialize(): Promise<void> {
    const recoverable = (await this.#registry.list()).filter(
      (record) =>
        (record.status === 'running' || record.status === 'starting') &&
        record.sandboxId,
    );
    for (const record of recoverable) {
      await this.#tunnel.register(record.runtimeId, this.#tunnelKey(record));
    }
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
      record.privateIpv6 = undefined;
      await this.#launchRuntime(sandbox, record);
      await this.#tunnel.register(record.runtimeId, this.#tunnelKey(record));
      await this.#launchTunnel(sandbox, record);
      await this.#tunnel.waitUntilReady(
        record.runtimeId,
        this.#config.startupTimeoutMs,
      );
      await this.#waitUntilHealthy(record.runtimeId);
      record.status = 'running';
      record.updatedAt = new Date().toISOString();
      record.lastError = undefined;
      await this.#registry.save(record);
      return this.#toView(record);
    } catch (error) {
      const failure = sandbox
        ? await this.#startupFailureWithDiagnostics(sandbox, error)
        : error;
      await this.#tunnel.remove(record.runtimeId).catch(() => undefined);
      record.status = 'error';
      record.lastError = errorMessage(failure);
      record.updatedAt = new Date().toISOString();
      await this.#registry.save(record);
      if (sandbox) await sandbox.destroy().catch(() => undefined);
      throw failure;
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
      .filter(
        (record) => record.status === 'running' || record.status === 'starting',
      )
      .map((record) => this.#toView(record));
  }

  async keepAlive(): Promise<{ checked: number; failed: string[] }> {
    const records = (await this.#registry.list()).filter(
      (record) => record.status === 'running' && record.sandboxId,
    );
    const failed: string[] = [];
    for (const record of records) {
      try {
        const sandbox = await this.#platform.connect(record.sandboxId!);
        const result = await sandbox.exec('true', { timeoutSec: 10 });
        ensureExecSuccess(result, 'keep Railway sandbox active');
      } catch (error) {
        await this.#tunnel.remove(record.runtimeId).catch(() => undefined);
        record.status = 'error';
        record.lastError = `sandbox keepalive failed: ${errorMessage(error)}`;
        record.updatedAt = new Date().toISOString();
        await this.#registry.save(record);
        failed.push(record.sessionId);
      }
    }
    return { checked: records.length, failed };
  }

  async pause(runtimeId: string): Promise<boolean> {
    const record = await this.#findByRuntimeId(runtimeId);
    if (!record) return false;
    if (record.status === 'paused') return true;
    if (!record.sandboxId) return false;

    await this.#tunnel.remove(record.runtimeId);
    const sandbox = await this.#platform.connect(record.sandboxId);
    await sandbox.exec(
      `docker rm -f ${TUNNEL_CONTAINER_NAME} ${CONTAINER_NAME} >/dev/null 2>&1 || true`,
      { timeoutSec: 30 },
    );
    await this.#removeTunnelFiles(sandbox, record);

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
      await this.#platform
        .deleteCheckpoint(previousCheckpointId)
        .catch(() => undefined);
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
      record.privateIpv6 = undefined;
      await this.#launchRuntime(sandbox, record);
      await this.#tunnel.register(record.runtimeId, this.#tunnelKey(record));
      await this.#launchTunnel(sandbox, record);
      await this.#tunnel.waitUntilReady(
        record.runtimeId,
        this.#config.startupTimeoutMs,
      );
      await this.#waitUntilHealthy(record.runtimeId);
      record.status = 'running';
      record.lastError = undefined;
      record.updatedAt = new Date().toISOString();
      await this.#registry.save(record);
      return this.#toView(record);
    } catch (error) {
      const failure = sandbox
        ? await this.#startupFailureWithDiagnostics(sandbox, error)
        : error;
      await this.#tunnel.remove(record.runtimeId).catch(() => undefined);
      record.status = 'error';
      record.lastError = errorMessage(failure);
      record.updatedAt = new Date().toISOString();
      await this.#registry.save(record);
      if (sandbox) await sandbox.destroy().catch(() => undefined);
      throw failure;
    }
  }

  async stop(runtimeId: string): Promise<boolean> {
    const record = await this.#findByRuntimeId(runtimeId);
    if (!record) return false;

    await this.#tunnel.remove(record.runtimeId).catch(() => undefined);
    if (record.sandboxId) {
      try {
        const sandbox = await this.#platform.connect(record.sandboxId);
        await sandbox.destroy();
      } catch {
        // The sandbox may already have expired; registry cleanup still must complete.
      }
    }
    if (record.checkpointId) {
      await this.#platform
        .deleteCheckpoint(record.checkpointId)
        .catch(() => undefined);
    }
    await this.#registry.delete(record.sessionId);
    return true;
  }

  async resolveProxy(pathname: string): Promise<ProxyTarget | undefined> {
    const parts = pathname.split('/').filter(Boolean);
    const runtimeId = parts.shift();
    if (!runtimeId || CONTROL_PATHS.has(runtimeId)) return undefined;
    const record = await this.#findByRuntimeId(runtimeId);
    if (!record || record.status !== 'running') return undefined;

    let port = AGENT_SERVER_PORT;
    if (parts[0] && SERVICE_PORTS[parts[0]]) {
      port = SERVICE_PORTS[parts.shift()!];
    }
    const target = this.#tunnel.target(record.runtimeId, port);
    if (!target) return undefined;
    const path = `/${parts.join('/')}` || '/';
    return { target, path };
  }

  async #findByRuntimeId(runtimeId: string): Promise<RuntimeRecord | undefined> {
    const direct = await this.#registry.get(runtimeId);
    if (direct?.runtimeId === runtimeId) return direct;
    return (await this.#registry.list()).find(
      (record) => record.runtimeId === runtimeId,
    );
  }

  async #launchRuntime(
    sandbox: PlatformSandbox,
    record: RuntimeRecord,
  ): Promise<void> {
    const request = record.request;
    const uid = positiveId(request.run_as_user, 10001, 'run_as_user');
    const gid = positiveId(request.run_as_group, 10001, 'run_as_group');
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

    await sandbox.exec(
      `docker rm -f ${CONTAINER_NAME} >/dev/null 2>&1 || true`,
      { timeoutSec: 30 },
    );

    // RemoteRuntime sends an executable followed by argv. Preserve that contract
    // by overriding the image entrypoint and passing only argv after the image.
    const [entrypoint, ...commandArgs] = request.command;
    if (!entrypoint) throw new Error('command must contain executable');

    const command = [
      'docker run -d',
      `--name ${CONTAINER_NAME}`,
      '--pull=missing',
      '--init',
      `--user ${shellQuote(`${uid}:${gid}`)}`,
      `--workdir ${shellQuote(workingDir)}`,
      `--env-file ${shellQuote(envPath)}`,
      '--volume /workspace:/workspace',
      '-p "127.0.0.1:60000:60000"',
      '-p "127.0.0.1:60001:60001"',
      '-p "127.0.0.1:12000:12000"',
      '-p "127.0.0.1:12001:12001"',
      `--entrypoint ${shellQuote(entrypoint)}`,
      shellQuote(request.image),
      ...commandArgs.map(shellQuote),
    ].join(' ');

    const launched = await sandbox.exec(command, { timeoutSec: 120 });
    await sandbox.exec(`rm -f ${shellQuote(envPath)}`, { timeoutSec: 10 });
    ensureExecSuccess(launched, 'launch OpenHands agent-server container');
  }

  async #launchTunnel(
    sandbox: PlatformSandbox,
    record: RuntimeRecord,
  ): Promise<void> {
    const scriptPath = this.#tunnelScriptPath(record);
    const configPath = this.#tunnelConfigPath(record);
    await sandbox.writeFile(scriptPath, buildSandboxTunnelClientSource(), 0o400);
    await sandbox.writeFile(
      configPath,
      `${JSON.stringify({
        url: this.#tunnelUrl(record),
        token: this.#tunnelKey(record),
      })}\n`,
      0o400,
    );

    await sandbox.exec(
      `docker rm -f ${TUNNEL_CONTAINER_NAME} >/dev/null 2>&1 || true`,
      { timeoutSec: 30 },
    );

    // Docker rejects `docker cp` whenever ReadonlyRootfs=true, even when the
    // destination itself is a writable tmpfs. Keep the sidecar root filesystem
    // read-only and stream the bootstrap files over stdin into the live /tmp
    // tmpfs with `docker exec -i`. File contents and the tunnel credential never
    // appear in the command line, image layer, or a persistent Docker volume.
    const createCommand = [
      'docker create',
      `--name ${TUNNEL_CONTAINER_NAME}`,
      '--pull=missing',
      '--init',
      '--network host',
      '--read-only',
      `--tmpfs ${shellQuote(TUNNEL_TMPFS)}`,
      '--security-opt no-new-privileges',
      '--cap-drop ALL',
      '--entrypoint sh',
      shellQuote(TUNNEL_IMAGE),
      "'-c'",
      shellQuote(TUNNEL_BOOTSTRAP),
      "'openhands-tunnel-bootstrap'",
      shellQuote(TUNNEL_CLIENT_CONTAINER_PATH),
      shellQuote(TUNNEL_CONFIG_CONTAINER_PATH),
    ].join(' ');

    const created = await sandbox.exec(createCommand, { timeoutSec: 120 });
    ensureExecSuccess(created, 'create sandbox reverse tunnel container');

    try {
      const started = await sandbox.exec(`docker start ${TUNNEL_CONTAINER_NAME}`, {
        timeoutSec: 30,
      });
      ensureExecSuccess(started, 'start sandbox reverse tunnel bootstrap');

      const streamedClient = await sandbox.exec(
        streamFileIntoContainerCommand(
          TUNNEL_CONTAINER_NAME,
          scriptPath,
          TUNNEL_CLIENT_CONTAINER_PATH,
        ),
        { timeoutSec: 30 },
      );
      ensureExecSuccess(streamedClient, 'stream sandbox reverse tunnel client');

      const streamedConfig = await sandbox.exec(
        streamFileIntoContainerCommand(
          TUNNEL_CONTAINER_NAME,
          configPath,
          TUNNEL_CONFIG_CONTAINER_PATH,
        ),
        { timeoutSec: 30 },
      );
      ensureExecSuccess(streamedConfig, 'stream sandbox reverse tunnel config');
    } finally {
      await this.#removeTunnelFiles(sandbox, record);
    }
  }

  async #removeTunnelFiles(
    sandbox: PlatformSandbox,
    record: RuntimeRecord,
  ): Promise<void> {
    const command = `rm -f ${shellQuote(this.#tunnelScriptPath(record))} ${shellQuote(
      this.#tunnelConfigPath(record),
    )}`;
    await sandbox.exec(command, { timeoutSec: 10 }).catch(() => undefined);
  }

  async #waitUntilHealthy(runtimeId: string): Promise<void> {
    const deadline = Date.now() + this.#config.startupTimeoutMs;
    const target = this.#tunnel.target(runtimeId, AGENT_SERVER_PORT);
    if (!target) throw new Error(`agent-server tunnel target unavailable: ${runtimeId}`);
    const url = `${target}/health`;
    while (Date.now() < deadline) {
      if (await this.#probe(url)) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(
      `agent-server did not become healthy through reverse tunnel within ${this.#config.startupTimeoutMs}ms`,
    );
  }

  async #startupFailureWithDiagnostics(
    sandbox: PlatformSandbox,
    error: unknown,
  ): Promise<Error> {
    try {
      const diagnostics = await collectStartupDiagnostics(sandbox, {
        containerName: CONTAINER_NAME,
        relatedContainers: [TUNNEL_CONTAINER_NAME],
        port: AGENT_SERVER_PORT,
      });
      return new Error(`${errorMessage(error)}\n${diagnostics}`);
    } catch (diagnosticError) {
      return new Error(
        `${errorMessage(error)}\n[startup-diagnostics]\ncollector_error=${errorMessage(diagnosticError)}`,
      );
    }
  }

  #sessionKey(record: RuntimeRecord): string {
    return createHmac('sha256', this.#config.apiKey)
      .update(`${record.sessionId}:${record.sessionKeyVersion}`)
      .digest('base64url');
  }

  #tunnelKey(record: RuntimeRecord): string {
    return createHmac('sha256', this.#config.apiKey)
      .update(`tunnel:${record.sessionId}:${record.sessionKeyVersion}`)
      .digest('base64url');
  }

  #tunnelUrl(record: RuntimeRecord): string {
    const url = new URL(this.#config.tunnelBaseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `/tunnel/${record.runtimeId}`;
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  #tunnelScriptPath(record: RuntimeRecord): string {
    return `/tmp/openhands-tunnel-${record.sessionId}.mjs`;
  }

  #tunnelConfigPath(record: RuntimeRecord): string {
    return `/tmp/openhands-tunnel-${record.sessionId}.json`;
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
  if (!request || typeof request !== 'object') {
    throw new Error('start request must be an object');
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.session_id)) {
    throw new Error(
      'session_id must contain only letters, numbers, underscore, or dash',
    );
  }
  if (CONTROL_PATHS.has(request.session_id)) {
    throw new Error('session_id collides with a reserved gateway route');
  }
  if (typeof request.image !== 'string' || !request.image.trim()) {
    throw new Error('image is required');
  }
  if (
    !Array.isArray(request.command) ||
    request.command.length === 0 ||
    request.command.some((argument) => typeof argument !== 'string')
  ) {
    throw new Error('command must contain string arguments');
  }
  positiveId(request.run_as_user, 10001, 'run_as_user');
  positiveId(request.run_as_group, 10001, 'run_as_group');
  if (
    request.environment !== undefined &&
    (request.environment === null ||
      Array.isArray(request.environment) ||
      typeof request.environment !== 'object')
  ) {
    throw new Error('environment must be an object');
  }
  validateEnvironment(request.environment || {});
}

function validateEnvironment(environment: Record<string, string>): void {
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`invalid environment variable name: ${key}`);
    }
    if (typeof value !== 'string') {
      throw new Error(`environment variable ${key} must be a string`);
    }
    if (value.includes('\n') || value.includes('\0')) {
      throw new Error(
        `environment variable ${key} contains an unsupported newline or NUL`,
      );
    }
  }
}

function positiveId(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isInteger(resolved) ||
    resolved <= 0 ||
    resolved > 2_147_483_647
  ) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function streamFileIntoContainerCommand(
  containerName: string,
  sourcePath: string,
  destinationPath: string,
): string {
  const writer = [
    'umask 077',
    `cat > ${shellQuote(destinationPath)}`,
    `chmod 0400 ${shellQuote(destinationPath)}`,
    `test -s ${shellQuote(destinationPath)}`,
  ].join('; ');
  return `cat ${shellQuote(sourcePath)} | docker exec -i ${shellQuote(containerName)} sh -c ${shellQuote(writer)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function checkpointNameFor(sessionId: string): string {
  return `oh-${sessionId.slice(0, 24)}-${Date.now().toString(36)}`;
}

function ensureExecSuccess(
  result: { exitCode: number | null; stderr: string },
  action: string,
): void {
  if (result.exitCode !== 0) {
    throw new Error(`${action} failed (${result.exitCode}): ${result.stderr}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
