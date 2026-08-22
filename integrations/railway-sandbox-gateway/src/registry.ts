import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { RuntimeRecord } from './types.js';

export interface RuntimeRegistry {
  get(sessionId: string): Promise<RuntimeRecord | undefined>;
  list(): Promise<RuntimeRecord[]>;
  save(record: RuntimeRecord): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export class FileRuntimeRegistry implements RuntimeRegistry {
  readonly #path: string;
  #records = new Map<string, RuntimeRecord>();
  #loaded = false;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const payload = JSON.parse(await readFile(this.#path, 'utf8')) as RuntimeRecord[];
      for (const record of payload) this.#records.set(record.sessionId, record);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
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
      const tmp = `${this.#path}.${process.pid}.tmp`;
      const payload = JSON.stringify([...this.#records.values()], null, 2);
      await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.#path);
      await chmod(this.#path, 0o600);
    };
    this.#writeChain = this.#writeChain.then(work, work);
    await this.#writeChain;
  }
}
