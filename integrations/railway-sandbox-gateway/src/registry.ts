import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { RuntimeRecord } from './types.js';

interface EncryptedEnvelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface RuntimeRegistry {
  get(sessionId: string): Promise<RuntimeRecord | undefined>;
  list(): Promise<RuntimeRecord[]>;
  save(record: RuntimeRecord): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export class FileRuntimeRegistry implements RuntimeRegistry {
  readonly #path: string;
  readonly #key: Buffer;
  #records = new Map<string, RuntimeRecord>();
  #loaded = false;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(path: string, encryptionSecret: string) {
    this.#path = path;
    this.#key = createHash('sha256').update(encryptionSecret).digest();
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    try {
      const envelope = JSON.parse(
        await readFile(this.#path, 'utf8'),
      ) as EncryptedEnvelope;
      const payload = JSON.parse(this.#decrypt(envelope)) as RuntimeRecord[];
      if (!Array.isArray(payload)) {
        throw new Error('runtime registry payload must be an array');
      }
      for (const record of payload) this.#records.set(record.sessionId, record);
      this.#loaded = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      this.#loaded = true;
    }
  }

  async get(sessionId: string): Promise<RuntimeRecord | undefined> {
    await this.#load();
    return this.#records.get(sessionId);
  }

  async list(): Promise<RuntimeRecord[]> {
    await this.#load();
    return [...this.#records.values()];
  }

  async save(record: RuntimeRecord): Promise<void> {
    await this.#load();
    this.#records.set(record.sessionId, record);
    await this.#persist();
  }

  async delete(sessionId: string): Promise<void> {
    await this.#load();
    this.#records.delete(sessionId);
    await this.#persist();
  }

  async #persist(): Promise<void> {
    const work = async () => {
      const dir = dirname(this.#path);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.#path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      const plaintext = JSON.stringify([...this.#records.values()]);
      const payload = JSON.stringify(this.#encrypt(plaintext));
      await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.#path);
      await chmod(this.#path, 0o600);
    };
    this.#writeChain = this.#writeChain.then(work, work);
    await this.#writeChain;
  }

  #encrypt(plaintext: string): EncryptedEnvelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return {
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  #decrypt(envelope: EncryptedEnvelope): string {
    if (envelope.version !== 1) {
      throw new Error('unsupported runtime registry encryption version');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.#key,
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
