// sandbox-service.types.ts
// This file contains types for Sandbox API.

export type V1SandboxStatus =
  | "MISSING"
  | "STARTING"
  | "RUNNING"
  | "PAUSED"
  | "ERROR";

export interface V1ExposedUrl {
  name: string;
  url: string;
  /**
   * Browser facing URL, set when `url` is not reachable from the end user
   * (loopback address, or a port the hosting platform does not publish).
   * May be root relative, e.g. "/runtime/8000".
   */
  public_url?: string | null;
}

export interface V1SandboxInfo {
  id: string;
  created_by_user_id: string | null;
  sandbox_spec_id: string;
  status: V1SandboxStatus;
  session_api_key: string | null;
  exposed_urls: V1ExposedUrl[] | null;
  created_at: string;
}
