import { Sandbox } from 'railway';

import type { ExecResult } from './types.js';

export interface PlatformCheckpoint {
  id: string;
  key: string;
}

export interface PlatformSandbox {
  id: string;
  exec(command: string, options?: { timeoutSec?: number }): Promise<ExecResult>;
  writeFile(path: string, data: string, mode?: number): Promise<void>;
  checkpoint(name: string): Promise<PlatformCheckpoint>;
  destroy(): Promise<void>;
}

export interface SandboxPlatform {
  create(): Promise<PlatformSandbox>;
  restore(checkpointName: string): Promise<PlatformSandbox>;
  connect(id: string): Promise<PlatformSandbox>;
  deleteCheckpoint(id: string): Promise<void>;
}

class RailwaySandboxHandle implements PlatformSandbox {
  readonly #sandbox: Sandbox;

  constructor(sandbox: Sandbox) {
    this.#sandbox = sandbox;
  }

  get id(): string {
    return this.#sandbox.id;
  }

  async exec(command: string, options?: { timeoutSec?: number }): Promise<ExecResult> {
    return await this.#sandbox.exec(command, options);
  }

  async writeFile(path: string, data: string, mode = 0o600): Promise<void> {
    await this.#sandbox.files.write(path, data, { mode });
  }

  async checkpoint(name: string): Promise<PlatformCheckpoint> {
    const checkpoint = await this.#sandbox.checkpoint(name);
    return { id: checkpoint.id, key: checkpoint.key };
  }

  async destroy(): Promise<void> {
    await this.#sandbox.destroy();
  }
}

export class RailwaySandboxPlatform implements SandboxPlatform {
  readonly #environmentId: string;
  readonly #idleTimeoutMinutes: number;

  constructor(environmentId: string, idleTimeoutMinutes: number) {
    this.#environmentId = environmentId;
    this.#idleTimeoutMinutes = idleTimeoutMinutes;
  }

  async create(): Promise<PlatformSandbox> {
    return new RailwaySandboxHandle(
      await Sandbox.create({
        environmentId: this.#environmentId,
        idleTimeoutMinutes: this.#idleTimeoutMinutes,
        networkIsolation: 'PRIVATE',
      }),
    );
  }

  async restore(checkpointName: string): Promise<PlatformSandbox> {
    return new RailwaySandboxHandle(
      await Sandbox.create(checkpointName, {
        environmentId: this.#environmentId,
        idleTimeoutMinutes: this.#idleTimeoutMinutes,
        networkIsolation: 'PRIVATE',
      }),
    );
  }

  async connect(id: string): Promise<PlatformSandbox> {
    return new RailwaySandboxHandle(
      await Sandbox.connect(id, { environmentId: this.#environmentId }),
    );
  }

  async deleteCheckpoint(id: string): Promise<void> {
    await Sandbox.deleteCheckpoint(id, { environmentId: this.#environmentId });
  }
}

export function parsePrivateIpv6(procNetIfInet6: string): string {
  for (const rawLine of procNetIfInet6.split(/\r?\n/)) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [hex, , , , , iface] = parts;
    if (iface === 'lo' || !/^[0-9a-fA-F]{32}$/.test(hex)) continue;
    if (!hex.toLowerCase().startsWith('fd')) continue;
    return hex.match(/.{1,4}/g)!.join(':').replace(/(^|:)0{1,3}/g, '$1');
  }
  throw new Error('Railway private IPv6 address was not found in /proc/net/if_inet6');
}
