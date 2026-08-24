import type { PlatformSandbox } from './platform.js';

const MAX_SECTION_CHARS = 4_000;
const MAX_TOTAL_CHARS = 12_000;
const LOG_TAIL_LINES = 120;

export interface StartupDiagnosticTarget {
  containerName: string;
  privateIpv6?: string;
  port: number;
}

export async function collectStartupDiagnostics(
  sandbox: PlatformSandbox,
  target: StartupDiagnosticTarget,
): Promise<string> {
  const commands: Array<[label: string, command: string]> = [
    [
      'sandbox-health',
      sandboxHealthCommand(target.privateIpv6, target.port),
    ],
    [
      'container-health',
      containerHealthCommand(target.containerName, target.port),
    ],
    [
      'container-state',
      `docker inspect --format ${shellQuote(
        'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{json .State.Error}} started={{.State.StartedAt}} finished={{.State.FinishedAt}}',
      )} ${shellQuote(target.containerName)}`,
    ],
    [
      'docker-ps',
      `docker ps -a --filter ${shellQuote(`name=^/${target.containerName}$`)} --format ${shellQuote(
        '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}',
      )}`,
    ],
    [
      'docker-logs',
      `docker logs --tail ${LOG_TAIL_LINES} ${shellQuote(target.containerName)} 2>&1`,
    ],
  ];

  const sections: string[] = [];
  for (const [label, command] of commands) {
    sections.push(await runDiagnostic(sandbox, label, command));
  }

  const header = [
    '[startup-diagnostics]',
    `sandbox_id=${sanitizeDiagnosticText(sandbox.id)}`,
    `private_ipv6=${target.privateIpv6 || 'unavailable'}`,
    `agent_server_port=${target.port}`,
  ].join('\n');

  return truncateDiagnosticText(`${header}\n${sections.join('\n')}`, MAX_TOTAL_CHARS);
}

async function runDiagnostic(
  sandbox: PlatformSandbox,
  label: string,
  command: string,
): Promise<string> {
  try {
    const result = await sandbox.exec(command, { timeoutSec: 10 });
    const details = [
      `exit_code=${result.exitCode ?? 'null'}`,
      result.stdout ? `stdout:\n${result.stdout}` : '',
      result.stderr ? `stderr:\n${result.stderr}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return `[${label}]\n${truncateDiagnosticText(
      sanitizeDiagnosticText(details),
      MAX_SECTION_CHARS,
    )}`;
  } catch (error) {
    return `[${label}]\nexec_error=${truncateDiagnosticText(
      sanitizeDiagnosticText(errorMessage(error)),
      MAX_SECTION_CHARS,
    )}`;
  }
}

function sandboxHealthCommand(privateIpv6: string | undefined, port: number): string {
  const urls = [
    `http://127.0.0.1:${port}/health`,
    `http://[::1]:${port}/health`,
  ];
  if (privateIpv6) urls.push(`http://[${privateIpv6}]:${port}/health`);

  return [
    'if ! command -v curl >/dev/null 2>&1; then echo "curl unavailable in sandbox"; exit 127; fi',
    ...urls.flatMap((url) => [
      `printf '%s\\n' ${shellQuote(`URL=${url}`)}`,
      `curl --noproxy '*' -g -sS -m 5 -o /tmp/openhands-health-body -w 'HTTP=%{http_code}\\n' ${shellQuote(
        url,
      )}; rc=$?; head -c 2048 /tmp/openhands-health-body 2>/dev/null || true; printf '\\nCURL_EXIT=%s\\n' "$rc"`,
    ]),
    'rm -f /tmp/openhands-health-body',
    'exit 0',
  ].join('; ');
}

function containerHealthCommand(containerName: string, port: number): string {
  const python = [
    'import urllib.request',
    `r=urllib.request.urlopen('http://127.0.0.1:${port}/health', timeout=5)`,
    "print(f'HTTP={r.status}')",
    "print(r.read(2048).decode('utf-8', 'replace'))",
  ].join('; ');
  return `docker exec ${shellQuote(containerName)} python -c ${shellQuote(python)}`;
}

export function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(
      /((?:OH_SESSION_API_KEYS_0|OPENAI_API_KEY|ANTHROPIC_API_KEY|XAI_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|API_KEY|AUTHORIZATION|TOKEN|SECRET|PASSWORD)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    );
}

function truncateDiagnosticText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n...[truncated ${omitted} chars]`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
