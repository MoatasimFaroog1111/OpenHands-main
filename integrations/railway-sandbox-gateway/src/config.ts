export interface GatewayConfig {
  apiKey: string;
  publicBaseUrl: string;
  railwayEnvironmentId: string;
  registryPath: string;
  port: number;
  startupTimeoutMs: number;
  idleTimeoutMinutes: number;
  keepAliveSeconds: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredSecret(name: string): string {
  const value = required(name);
  if (value.length < 32) {
    throw new Error(`${name} must be at least 32 characters`);
  }
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function normalizePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
    throw new Error('GATEWAY_PUBLIC_BASE_URL must use https outside localhost');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function loadConfig(): GatewayConfig {
  if (!process.env.RAILWAY_TOKEN && !process.env.RAILWAY_API_TOKEN) {
    throw new Error('RAILWAY_TOKEN or RAILWAY_API_TOKEN is required');
  }

  const publicBaseUrl =
    process.env.GATEWAY_PUBLIC_BASE_URL?.trim() ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : '');

  if (!publicBaseUrl) {
    throw new Error(
      'GATEWAY_PUBLIC_BASE_URL or RAILWAY_PUBLIC_DOMAIN is required',
    );
  }

  const idleTimeoutMinutes = positiveInt('SANDBOX_IDLE_TIMEOUT_MINUTES', 60);
  const keepAliveSeconds = positiveInt('SANDBOX_KEEPALIVE_SECONDS', 240);
  if (keepAliveSeconds >= idleTimeoutMinutes * 60) {
    throw new Error(
      'SANDBOX_KEEPALIVE_SECONDS must be shorter than SANDBOX_IDLE_TIMEOUT_MINUTES',
    );
  }

  return {
    apiKey: requiredSecret('GATEWAY_API_KEY'),
    publicBaseUrl: normalizePublicBaseUrl(publicBaseUrl),
    railwayEnvironmentId: required('RAILWAY_ENVIRONMENT_ID'),
    registryPath:
      process.env.RUNTIME_REGISTRY_PATH ||
      '/data/railway-sandbox-gateway/runtimes.json',
    port: positiveInt('PORT', 8080),
    startupTimeoutMs: positiveInt('SANDBOX_STARTUP_TIMEOUT_MS', 120_000),
    idleTimeoutMinutes,
    keepAliveSeconds,
  };
}
