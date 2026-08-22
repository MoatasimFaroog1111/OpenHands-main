import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FileRuntimeRegistry } from '../src/registry.js';
import type { RuntimeRecord } from '../src/types.js';

const secret = 'registry-encryption-secret-at-least-32-chars';

function record(): RuntimeRecord {
  return {
    sessionId: 'encrypted-session',
    runtimeId: 'encrypted-session',
    status: 'paused',
    request: {
      image: 'example/image:latest',
      command: ['agent-server'],
      session_id: 'encrypted-session',
      environment: { LMNR_PROJECT_API_KEY: 'highly-sensitive-value' },
    },
    sessionKeyVersion: 2,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  };
}

test('file registry encrypts persisted runtime request secrets at rest', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oh-gateway-registry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'runtimes.json');
  const registry = new FileRuntimeRegistry(path, secret);
  await registry.save(record());

  const raw = await readFile(path, 'utf8');
  assert.doesNotMatch(raw, /highly-sensitive-value/);
  assert.doesNotMatch(raw, /LMNR_PROJECT_API_KEY/);

  const reopened = new FileRuntimeRegistry(path, secret);
  assert.deepEqual(await reopened.get('encrypted-session'), record());
});

test('file registry rejects decryption with a different secret', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'oh-gateway-registry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'runtimes.json');
  await new FileRuntimeRegistry(path, secret).save(record());

  const wrong = new FileRuntimeRegistry(
    path,
    'different-registry-secret-at-least-32-chars',
  );
  await assert.rejects(() => wrong.list());
});
