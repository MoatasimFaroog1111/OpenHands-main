import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type ProductionGateOptions,
  runProductionGate,
} from '../src/production-gate.js';

const options: ProductionGateOptions = {
  gatewayUrl: 'https://gateway.example.com',
  apiKey: 'gateway-secret-that-is-at-least-32-characters',
  image: 'ghcr.io/openhands/agent-server:1.29.0-python',
  runAsUser: 42421,
  runAsGroup: 42421,
  iterations: 1,
  lifecycleTimeoutMs: 5_000,
  commandTimeoutSeconds: 5,
};

test('production gate verifies start, workspace persistence, key rotation, services and cleanup', async (t) => {
  const originalFetch = globalThis.fetch;
  const fake = new FakeProductionGateway();
  globalThis.fetch = fake.fetch.bind(fake);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await runProductionGate(structuredClone(options));

  assert.equal(fake.stopCalls, 1);
  assert.equal(fake.pauseCalls, 1);
  assert.equal(fake.resumeCalls, 1);
  assert.equal(fake.markerReadsAfterResume, 1);
  assert.equal(fake.oldKeyRejected, true);
  assert.equal(fake.workerOneHits >= 2, true);
  assert.equal(fake.workerTwoHits >= 2, true);
  assert.equal(fake.vscodeHits >= 2, true);
  assert.equal(fake.runtimeStatus, 'stopped');
});

test('production gate stops a runtime when a later assertion fails', async (t) => {
  const originalFetch = globalThis.fetch;
  const fake = new FakeProductionGateway();
  fake.failWorkerTwo = true;
  globalThis.fetch = fake.fetch.bind(fake);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    runProductionGate(structuredClone(options)),
    /work-2 reverse-tunnel route returned HTTP 502/,
  );
  assert.equal(fake.stopCalls >= 1, true);
  assert.equal(fake.runtimeStatus, 'stopped');
});

class FakeProductionGateway {
  runtimeId = '';
  sessionId = '';
  runtimeStatus: 'missing' | 'running' | 'paused' | 'stopped' = 'missing';
  currentKey = '';
  firstKey = '';
  marker = '';
  commandCounter = 0;
  commandResults = new Map<string, { stdout: string; stderr: string; exitCode: number }>();
  pauseCalls = 0;
  resumeCalls = 0;
  stopCalls = 0;
  markerReadsAfterResume = 0;
  oldKeyRejected = false;
  workerOneHits = 0;
  workerTwoHits = 0;
  vscodeHits = 0;
  failWorkerTwo = false;

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);

    if (url.pathname === '/healthz') return json(200, { status: 'ok' });
    if (url.pathname === '/list') {
      this.assertControlKey(headers);
      return json(200, {
        runtimes:
          this.runtimeStatus === 'running' || this.runtimeStatus === 'paused'
            ? [this.runtimeView()]
            : [],
      });
    }

    if (url.pathname === '/start' && method === 'POST') {
      this.assertControlKey(headers);
      const body = parseBody(init) as { session_id: string };
      this.sessionId = body.session_id;
      this.runtimeId = body.session_id;
      this.runtimeStatus = 'running';
      this.firstKey = 'session-key-version-one-long-enough';
      this.currentKey = this.firstKey;
      return json(201, this.runtimeView());
    }

    if (url.pathname === '/pause' && method === 'POST') {
      this.assertControlKey(headers);
      this.pauseCalls += 1;
      this.runtimeStatus = 'paused';
      this.currentKey = '';
      return json(200, { status: 'paused' });
    }

    if (url.pathname === '/resume' && method === 'POST') {
      this.assertControlKey(headers);
      this.resumeCalls += 1;
      this.runtimeStatus = 'running';
      this.currentKey = 'session-key-version-two-long-enough';
      return json(200, this.runtimeView());
    }

    if (url.pathname === '/stop' && method === 'POST') {
      this.assertControlKey(headers);
      this.stopCalls += 1;
      this.runtimeStatus = 'stopped';
      this.currentKey = '';
      return json(200, { status: 'stopped' });
    }

    if (url.pathname.startsWith('/sessions/')) {
      this.assertControlKey(headers);
      if (this.runtimeStatus === 'stopped' || this.runtimeStatus === 'missing') {
        return json(404, { error: 'runtime not found' });
      }
      return json(200, this.runtimeView());
    }

    if (!this.runtimeId || !url.pathname.startsWith(`/${this.runtimeId}/`)) {
      return json(404, { error: 'runtime not found' });
    }

    const agentPath = url.pathname.slice(this.runtimeId.length + 1);
    if (agentPath === '/health') return json(200, { status: 'ok' });

    if (agentPath.startsWith('/vscode/')) {
      this.vscodeHits += 1;
      return new Response('<html>vscode</html>', { status: 200 });
    }
    if (agentPath.startsWith('/work-1/')) {
      this.workerOneHits += 1;
      return new Response('worker-one', { status: 200 });
    }
    if (agentPath.startsWith('/work-2/')) {
      this.workerTwoHits += 1;
      return new Response('worker-two', { status: this.failWorkerTwo ? 502 : 200 });
    }

    if (agentPath === '/api/bash/start_bash_command' && method === 'POST') {
      const suppliedKey = headers.get('x-session-api-key') ?? '';
      if (suppliedKey !== this.currentKey) {
        if (suppliedKey === this.firstKey && this.resumeCalls > 0) this.oldKeyRejected = true;
        return json(401, { detail: 'invalid session key' });
      }
      const body = parseBody(init) as { command: string };
      const id = `command-${++this.commandCounter}`;
      const result = this.executeCommand(body.command);
      this.commandResults.set(id, result);
      return json(200, { id });
    }

    if (agentPath === '/api/bash/bash_events/search' && method === 'GET') {
      const suppliedKey = headers.get('x-session-api-key') ?? '';
      if (suppliedKey !== this.currentKey) return json(401, { detail: 'invalid session key' });
      const commandId = url.searchParams.get('command_id__eq');
      if (!commandId) return json(200, { items: [] });
      const result = this.commandResults.get(commandId);
      if (!result) return json(200, { items: [] });
      return json(200, {
        items: [
          {
            id: `${commandId}-event`,
            order: 1,
            kind: 'BashOutput',
            stdout: result.stdout,
            stderr: result.stderr,
            exit_code: result.exitCode,
          },
        ],
      });
    }

    return json(404, { error: `unhandled ${method} ${agentPath}` });
  }

  private executeCommand(command: string) {
    if (command.includes('railway-production-gate.txt') && command.includes('printf %s')) {
      const match = command.match(/RAILWAY_REMOTE_SANDBOX_LIFECYCLE_OK_[A-Za-z0-9_]+/);
      this.marker = match?.[0] ?? 'missing-marker';
      return { stdout: this.marker, stderr: '', exitCode: 0 };
    }
    if (command.includes('railway-production-gate.txt') && command.includes('cat ')) {
      if (this.resumeCalls > 0) this.markerReadsAfterResume += 1;
      return { stdout: this.marker, stderr: '', exitCode: this.marker ? 0 : 1 };
    }
    if (command.includes('RAILWAY_TOKEN') && command.includes('SECURITY_BOUNDARY_OK')) {
      return { stdout: 'SECURITY_BOUNDARY_OK\n', stderr: '', exitCode: 0 };
    }
    if (command.includes('WORKER_PROBES_READY')) {
      return { stdout: 'WORKER_PROBES_READY\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private runtimeView() {
    return {
      session_id: this.sessionId,
      runtime_id: this.runtimeId,
      status: this.runtimeStatus,
      url:
        this.runtimeStatus === 'running'
          ? `https://gateway.example.com/${this.runtimeId}`
          : null,
      session_api_key: this.runtimeStatus === 'running' ? this.currentKey : '',
    };
  }

  private assertControlKey(headers: Headers) {
    assert.equal(headers.get('x-api-key'), options.apiKey);
  }
}

function parseBody(init?: RequestInit): unknown {
  assert.equal(typeof init?.body, 'string');
  return JSON.parse(init.body as string) as unknown;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
