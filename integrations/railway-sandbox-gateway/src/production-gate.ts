import { pathToFileURL } from 'node:url';

interface RuntimeView {
  session_id: string;
  runtime_id: string;
  status: string;
  url: string | null;
  session_api_key: string;
}

interface ListResponse {
  runtimes: RuntimeView[];
}

interface BashEvent {
  id?: string;
  order?: number;
  stdout?: string;
  stderr?: string;
  exit_code?: number | null;
}

interface BashSearchResponse {
  items?: BashEvent[];
}

interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProductionGateOptions {
  gatewayUrl: string;
  apiKey: string;
  image: string;
  runAsUser: number;
  runAsGroup: number;
  iterations: number;
  lifecycleTimeoutMs: number;
  commandTimeoutSeconds: number;
}

const DEFAULT_IMAGE = 'ghcr.io/openhands/agent-server:1.29.0-python';
const MARKER_FILE = '/workspace/railway-production-gate.txt';
const CONTROL_TIMEOUT_MS = 420_000;
const RETRY_INTERVAL_MS = 500;

export async function runProductionGate(options: ProductionGateOptions): Promise<void> {
  validateOptions(options);
  const gatewayUrl = options.gatewayUrl.replace(/\/+$/, '');
  const baseline = await controlJson<ListResponse>(options, '/list', {
    method: 'GET',
  });
  const baselineIds = new Set(baseline.runtimes.map((runtime) => runtime.runtime_id));
  const smokeIds = new Set<string>();

  logStep(`Gateway health: ${gatewayUrl}/healthz`);
  const health = await request(`${gatewayUrl}/healthz`, {
    signal: AbortSignal.timeout(10_000),
  });
  assertStatus(health, [200], 'gateway /healthz');

  try {
    for (let index = 0; index < options.iterations; index += 1) {
      const sessionId = makeSessionId(index);
      smokeIds.add(sessionId);
      await exerciseRuntime(options, sessionId, index + 1);
      smokeIds.delete(sessionId);
    }
  } finally {
    for (const runtimeId of smokeIds) {
      await stopBestEffort(options, runtimeId);
    }
  }

  const finalList = await controlJson<ListResponse>(options, '/list', {
    method: 'GET',
  });
  for (const runtime of finalList.runtimes) {
    if (runtime.runtime_id.startsWith('railwaySmoke')) {
      throw new Error(`smoke runtime leak detected: ${runtime.runtime_id}`);
    }
  }

  for (const baselineId of baselineIds) {
    if (!finalList.runtimes.some((runtime) => runtime.runtime_id === baselineId)) {
      console.warn(`[production-gate] baseline runtime disappeared during smoke: ${baselineId}`);
    }
  }

  console.log('[production-gate] PASS: Railway remote sandbox lifecycle is healthy');
}

async function exerciseRuntime(
  options: ProductionGateOptions,
  sessionId: string,
  ordinal: number,
): Promise<void> {
  let runtimeId: string | undefined;
  let stopped = false;

  try {
    logStep(`Runtime ${ordinal}: start ${sessionId}`);
    const started = await controlJson<RuntimeView>(options, '/start', {
      method: 'POST',
      timeoutMs: options.lifecycleTimeoutMs,
      body: {
        image: options.image,
        command: ['/usr/local/bin/openhands-agent-server', '--port', '60000'],
        working_dir: '/workspace/project',
        environment: {
          OPENVSCODE_SERVER_ROOT: '/openhands/.openvscode-server',
          LOG_JSON: 'true',
          OH_ENABLE_VNC: '0',
          OH_CONVERSATIONS_PATH: '/workspace/conversations',
          OH_BASH_EVENTS_DIR: '/workspace/bash_events',
          OH_VSCODE_PORT: '60001',
        },
        session_id: sessionId,
        run_as_user: options.runAsUser,
        run_as_group: options.runAsGroup,
      },
      expectedStatuses: [201],
    });
    assertRunningRuntime(started, sessionId);
    runtimeId = started.runtime_id;

    await assertAgentHealth(started);
    await assertProtectedApiAccepts(started);

    const marker = `RAILWAY_REMOTE_SANDBOX_LIFECYCLE_OK_${sessionId}`;
    const writeResult = await runBash(
      started,
      `printf %s ${shellQuote(marker)} > ${shellQuote(MARKER_FILE)} && cat ${shellQuote(MARKER_FILE)}`,
      options.commandTimeoutSeconds,
    );
    assertBashSuccess(writeResult, 'write/read workspace marker');
    assertEqual(writeResult.stdout.trim(), marker, 'workspace marker before pause');

    await assertNoGatewaySecrets(started, options.commandTimeoutSeconds);
    await startWorkerProbes(started, options.commandTimeoutSeconds);
    await assertWorkerRoute(started, 'work-1');
    await assertWorkerRoute(started, 'work-2');
    await assertVscodeRoute(started);

    logStep(`Runtime ${ordinal}: pause ${runtimeId}`);
    await controlJson(options, '/pause', {
      method: 'POST',
      timeoutMs: options.lifecycleTimeoutMs,
      body: { runtime_id: runtimeId },
      expectedStatuses: [200],
    });
    const paused = await controlJson<RuntimeView>(
      options,
      `/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'GET' },
    );
    assertEqual(paused.status, 'paused', 'paused runtime status');
    assertEqual(paused.session_api_key, '', 'paused runtime session key exposure');

    logStep(`Runtime ${ordinal}: resume ${runtimeId}`);
    const resumed = await controlJson<RuntimeView>(options, '/resume', {
      method: 'POST',
      timeoutMs: options.lifecycleTimeoutMs,
      body: { runtime_id: runtimeId },
      expectedStatuses: [200],
    });
    assertRunningRuntime(resumed, sessionId);
    if (resumed.session_api_key === started.session_api_key) {
      throw new Error('session API key did not rotate after resume');
    }

    await assertAgentHealth(resumed);
    await assertOldSessionKeyRejected(resumed, started.session_api_key);
    await assertProtectedApiAccepts(resumed);

    const readResult = await runBash(
      resumed,
      `cat ${shellQuote(MARKER_FILE)}`,
      options.commandTimeoutSeconds,
    );
    assertBashSuccess(readResult, 'read workspace marker after resume');
    assertEqual(readResult.stdout.trim(), marker, 'workspace marker after resume');

    await startWorkerProbes(resumed, options.commandTimeoutSeconds);
    await assertWorkerRoute(resumed, 'work-1');
    await assertWorkerRoute(resumed, 'work-2');
    await assertVscodeRoute(resumed);

    logStep(`Runtime ${ordinal}: stop ${runtimeId}`);
    await controlJson(options, '/stop', {
      method: 'POST',
      timeoutMs: options.lifecycleTimeoutMs,
      body: { runtime_id: runtimeId },
      expectedStatuses: [200],
    });
    stopped = true;

    const afterStop = await controlRequest(
      options,
      `/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'GET' },
    );
    assertStatus(afterStop, [404], 'session lookup after stop');

    const list = await controlJson<ListResponse>(options, '/list', { method: 'GET' });
    if (list.runtimes.some((runtime) => runtime.runtime_id === runtimeId)) {
      throw new Error(`runtime remains in /list after stop: ${runtimeId}`);
    }
  } finally {
    if (runtimeId && !stopped) {
      await stopBestEffort(options, runtimeId);
    }
  }
}

async function assertAgentHealth(runtime: RuntimeView): Promise<void> {
  const url = requireRuntimeUrl(runtime);
  const response = await agentRequest(runtime, `${url}/health`, {
    method: 'GET',
    timeoutMs: 15_000,
  });
  assertStatus(response, [200], 'agent-server /health through reverse tunnel');
  const body = (await response.json()) as { status?: string };
  assertEqual(body.status, 'ok', 'agent-server health body');
}

async function assertProtectedApiAccepts(runtime: RuntimeView): Promise<void> {
  const url = requireRuntimeUrl(runtime);
  const response = await agentRequest(runtime, `${url}/api/bash/bash_events/search?limit=1`, {
    method: 'GET',
    timeoutMs: 15_000,
  });
  assertStatus(response, [200], 'protected agent API with current session key');
}

async function assertOldSessionKeyRejected(
  runtime: RuntimeView,
  oldSessionKey: string,
): Promise<void> {
  const url = requireRuntimeUrl(runtime);
  const response = await request(`${url}/api/bash/start_bash_command`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-session-api-key': oldSessionKey,
    },
    body: JSON.stringify({ command: 'true', timeout: 5 }),
    signal: AbortSignal.timeout(15_000),
  });
  assertStatus(response, [401, 403], 'old session key after resume');
}

async function assertNoGatewaySecrets(
  runtime: RuntimeView,
  commandTimeoutSeconds: number,
): Promise<void> {
  const command = [
    'for name in RAILWAY_TOKEN RAILWAY_API_TOKEN GATEWAY_API_KEY; do',
    '  eval "value=\\${$name-}";',
    '  if [ -n "$value" ]; then echo "FORBIDDEN_ENV:$name"; exit 41; fi;',
    'done;',
    'echo SECURITY_BOUNDARY_OK',
  ].join(' ');
  const result = await runBash(runtime, command, commandTimeoutSeconds);
  assertBashSuccess(result, 'sandbox secret boundary');
  assertEqual(result.stdout.trim(), 'SECURITY_BOUNDARY_OK', 'sandbox secret boundary');
}

async function startWorkerProbes(
  runtime: RuntimeView,
  commandTimeoutSeconds: number,
): Promise<void> {
  const command = [
    'PY="$(command -v python3 || command -v python || true)";',
    'test -n "$PY" || { echo PYTHON_NOT_FOUND; exit 42; };',
    'for port in 12000 12001; do',
    '  (nohup "$PY" -m http.server "$port" --bind 127.0.0.1 --directory /workspace',
    '    >"/tmp/railway-worker-$port.log" 2>&1 </dev/null &) ;',
    'done;',
    'sleep 1;',
    'echo WORKER_PROBES_READY',
  ].join(' ');
  const result = await runBash(runtime, command, commandTimeoutSeconds);
  assertBashSuccess(result, 'start worker probes');
  if (!result.stdout.includes('WORKER_PROBES_READY')) {
    throw new Error(`worker probes did not report ready: ${safeSnippet(result.stdout)}`);
  }
}

async function assertWorkerRoute(runtime: RuntimeView, service: 'work-1' | 'work-2') {
  const url = `${requireRuntimeUrl(runtime)}/${service}/`;
  const response = await agentRequest(runtime, url, {
    method: 'GET',
    timeoutMs: 15_000,
  });
  assertStatus(response, [200], `${service} reverse-tunnel route`);
}

async function assertVscodeRoute(runtime: RuntimeView): Promise<void> {
  const url = new URL(`${requireRuntimeUrl(runtime)}/vscode/`);
  url.searchParams.set('tkn', runtime.session_api_key);
  url.searchParams.set('folder', '/workspace/project');
  const response = await request(url.toString(), {
    method: 'GET',
    headers: { 'x-session-api-key': runtime.session_api_key },
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status < 200 || response.status >= 400) {
    throw new Error(`VS Code reverse-tunnel route returned HTTP ${response.status}`);
  }
}

async function runBash(
  runtime: RuntimeView,
  command: string,
  timeoutSeconds: number,
): Promise<BashResult> {
  const url = requireRuntimeUrl(runtime);
  const startedResponse = await agentRequest(runtime, `${url}/api/bash/start_bash_command`, {
    method: 'POST',
    timeoutMs: (timeoutSeconds + 10) * 1_000,
    body: { command, timeout: timeoutSeconds },
  });
  assertStatus(startedResponse, [200, 201], 'start bash command');
  const started = (await startedResponse.json()) as { id?: string };
  if (!started.id) throw new Error('bash start response did not contain command id');

  const deadline = Date.now() + timeoutSeconds * 1_000;
  const seen = new Set<string>();
  let lastOrder = -1;
  let stdout = '';
  let stderr = '';

  while (Date.now() < deadline) {
    const params = new URLSearchParams({
      command_id__eq: started.id,
      sort_order: 'TIMESTAMP',
      limit: '100',
      kind__eq: 'BashOutput',
    });
    if (lastOrder >= 0) params.set('order__gt', String(lastOrder));

    const response = await agentRequest(
      runtime,
      `${url}/api/bash/bash_events/search?${params.toString()}`,
      { method: 'GET', timeoutMs: Math.min(15_000, timeoutSeconds * 1_000) },
    );
    assertStatus(response, [200], 'poll bash command');
    const search = (await response.json()) as BashSearchResponse;

    for (const event of search.items ?? []) {
      if (event.id && seen.has(event.id)) continue;
      if (event.id) seen.add(event.id);
      if (typeof event.order === 'number' && event.order > lastOrder) {
        lastOrder = event.order;
      }
      if (event.stdout) stdout += event.stdout;
      if (event.stderr) stderr += event.stderr;
      if (event.exit_code !== null && event.exit_code !== undefined) {
        return { stdout, stderr, exitCode: event.exit_code };
      }
    }

    await sleep(100);
  }

  throw new Error(`bash command timed out after ${timeoutSeconds}s`);
}

async function agentRequest(
  runtime: RuntimeView,
  url: string,
  options: {
    method: string;
    timeoutMs: number;
    body?: unknown;
  },
): Promise<Response> {
  const headers: Record<string, string> = {
    'x-session-api-key': runtime.session_api_key,
  };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  return request(url, {
    method: options.method,
    headers,
    body,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
}

async function controlJson<T = unknown>(
  options: ProductionGateOptions,
  path: string,
  requestOptions: {
    method: string;
    timeoutMs?: number;
    body?: unknown;
    expectedStatuses?: number[];
  },
): Promise<T> {
  const response = await controlRequest(options, path, requestOptions);
  assertStatus(
    response,
    requestOptions.expectedStatuses ?? [200],
    `gateway ${requestOptions.method} ${path}`,
  );
  return (await response.json()) as T;
}

async function controlRequest(
  options: ProductionGateOptions,
  path: string,
  requestOptions: {
    method: string;
    timeoutMs?: number;
    body?: unknown;
  },
): Promise<Response> {
  const headers: Record<string, string> = { 'x-api-key': options.apiKey };
  let body: string | undefined;
  if (requestOptions.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(requestOptions.body);
  }
  return request(`${options.gatewayUrl.replace(/\/+$/, '')}${path}`, {
    method: requestOptions.method,
    headers,
    body,
    signal: AbortSignal.timeout(requestOptions.timeoutMs ?? CONTROL_TIMEOUT_MS),
  });
}

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw new Error(`request failed for ${safeUrl(url)}: ${errorMessage(error)}`);
  }
}

function assertRunningRuntime(runtime: RuntimeView, sessionId: string): void {
  assertEqual(runtime.status, 'running', 'runtime status');
  assertEqual(runtime.session_id, sessionId, 'runtime session id');
  if (!runtime.runtime_id) throw new Error('runtime_id is missing');
  if (!runtime.url) throw new Error('runtime public URL is missing');
  if (!runtime.session_api_key || runtime.session_api_key.length < 16) {
    throw new Error('runtime session API key is missing or unexpectedly short');
  }
}

function assertBashSuccess(result: BashResult, label: string): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit ${result.exitCode}: ${safeSnippet(result.stderr || result.stdout)}`,
    );
  }
}

function assertStatus(response: Response, expected: number[], label: string): void {
  if (!expected.includes(response.status)) {
    throw new Error(`${label} returned HTTP ${response.status}; expected ${expected.join('/')}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function requireRuntimeUrl(runtime: RuntimeView): string {
  if (!runtime.url) throw new Error(`runtime ${runtime.runtime_id} has no public URL`);
  return runtime.url.replace(/\/+$/, '');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function safeSnippet(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function safeUrl(value: string): string {
  const url = new URL(value);
  url.search = url.searchParams.has('tkn') ? '?tkn=[REDACTED]' : url.search;
  return url.toString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSessionId(index: number): string {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `railwaySmoke${index + 1}_${suffix}`;
}

function logStep(message: string): void {
  console.log(`[production-gate] ${message}`);
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function validateOptions(options: ProductionGateOptions): void {
  if (!/^https?:\/\//.test(options.gatewayUrl)) {
    throw new Error('gatewayUrl must be an absolute HTTP(S) URL');
  }
  if (options.apiKey.length < 32) throw new Error('gateway API key is missing or too short');
  if (!options.image.trim()) throw new Error('smoke image is required');
  for (const [name, value] of [
    ['runAsUser', options.runAsUser],
    ['runAsGroup', options.runAsGroup],
    ['iterations', options.iterations],
    ['commandTimeoutSeconds', options.commandTimeoutSeconds],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  }
}

export function optionsFromEnvironment(): ProductionGateOptions {
  const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : undefined;
  const gatewayUrl =
    process.env.RAILWAY_SMOKE_GATEWAY_URL ||
    process.env.GATEWAY_PUBLIC_BASE_URL ||
    publicDomain;
  const apiKey =
    process.env.RAILWAY_SMOKE_GATEWAY_API_KEY || process.env.GATEWAY_API_KEY;
  if (!gatewayUrl) {
    throw new Error(
      'Set RAILWAY_SMOKE_GATEWAY_URL or GATEWAY_PUBLIC_BASE_URL before running the production gate',
    );
  }
  if (!apiKey) {
    throw new Error(
      'Set RAILWAY_SMOKE_GATEWAY_API_KEY or GATEWAY_API_KEY before running the production gate',
    );
  }

  return {
    gatewayUrl,
    apiKey,
    image: process.env.RAILWAY_SMOKE_IMAGE || DEFAULT_IMAGE,
    runAsUser: positiveInteger('RAILWAY_SMOKE_RUN_AS_USER', 42_421),
    runAsGroup: positiveInteger('RAILWAY_SMOKE_RUN_AS_GROUP', 42_421),
    iterations: positiveInteger('RAILWAY_SMOKE_ITERATIONS', 2),
    lifecycleTimeoutMs: positiveInteger(
      'RAILWAY_SMOKE_LIFECYCLE_TIMEOUT_MS',
      CONTROL_TIMEOUT_MS,
    ),
    commandTimeoutSeconds: positiveInteger('RAILWAY_SMOKE_COMMAND_TIMEOUT_SECONDS', 30),
  };
}

async function stopBestEffort(
  options: ProductionGateOptions,
  runtimeId: string,
): Promise<void> {
  try {
    const response = await controlRequest(options, '/stop', {
      method: 'POST',
      timeoutMs: options.lifecycleTimeoutMs,
      body: { runtime_id: runtimeId },
    });
    if (![200, 404].includes(response.status)) {
      console.warn(`[production-gate] cleanup stop returned HTTP ${response.status} for ${runtimeId}`);
    }
  } catch (error) {
    console.warn(`[production-gate] cleanup failed for ${runtimeId}: ${errorMessage(error)}`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  runProductionGate(optionsFromEnvironment()).catch((error) => {
    console.error(`[production-gate] FAIL: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
