export type RuntimeStatus =
  | 'starting'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'error';

export interface StartRuntimeRequest {
  image: string;
  command: string[];
  working_dir?: string;
  environment?: Record<string, string>;
  session_id: string;
  resource_factor?: number;
  run_as_user?: number;
  run_as_group?: number;
  fs_group?: number;
  runtime_class?: string;
}

export interface RuntimeRecord {
  sessionId: string;
  runtimeId: string;
  status: RuntimeStatus;
  request: StartRuntimeRequest;
  sandboxId?: string;
  privateIpv6?: string;
  checkpointId?: string;
  checkpointName?: string;
  sessionKeyVersion: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface RuntimeView {
  session_id: string;
  runtime_id: string;
  status: RuntimeStatus;
  url: string | null;
  session_api_key: string;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  truncated?: boolean;
}

export interface ProxyTarget {
  target: string;
  path: string;
}
