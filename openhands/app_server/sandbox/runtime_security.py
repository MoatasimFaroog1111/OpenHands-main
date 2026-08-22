"""Security policy for sandbox runtime selection.

The app server may execute untrusted agent-generated code. Process/local sandboxes
share the app container and therefore are suitable only for explicitly opted-in
local development. Hosted deployments must use an isolated sandbox backend and
must not run the application as root.
"""

from __future__ import annotations

import ipaddress
import os
from collections.abc import Mapping
from urllib.parse import urlparse

_INSECURE_PROCESS_OVERRIDE = 'OH_ALLOW_INSECURE_PROCESS_SANDBOX'
_HOSTED_ENV_MARKERS = (
    'RAILWAY_PUBLIC_DOMAIN',
    'RAILWAY_ENVIRONMENT',
    'RENDER_EXTERNAL_URL',
    'FLY_APP_NAME',
    'K_SERVICE',
    'DYNO',
)
_RAILWAY_ENV_MARKERS = ('RAILWAY_PUBLIC_DOMAIN', 'RAILWAY_ENVIRONMENT')


def _is_truthy(value: str | None) -> bool:
    return (value or '').strip().lower() in {'1', 'true', 'yes', 'on'}


def _host_from_value(value: str) -> str | None:
    candidate = value.strip()
    if not candidate:
        return None

    if '://' not in candidate:
        candidate = f'//{candidate}'

    parsed = urlparse(candidate)
    return parsed.hostname


def _is_loopback_host(host: str | None) -> bool:
    if host is None:
        return True

    normalized = host.strip('[]').lower()
    if normalized == 'localhost' or normalized.endswith('.localhost'):
        return True

    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def _configured_public_endpoints(environ: Mapping[str, str]) -> list[str]:
    values: list[str] = []

    for key in ('OH_WEB_URL', 'WEB_HOST', 'RENDER_EXTERNAL_URL'):
        value = environ.get(key)
        if value:
            values.append(value)

    legacy_cors = environ.get('PERMITTED_CORS_ORIGINS')
    if legacy_cors:
        values.extend(origin.strip() for origin in legacy_cors.split(','))

    for key, value in environ.items():
        if key.startswith('OH_PERMITTED_CORS_ORIGINS_') and value:
            values.append(value)

    return [value for value in values if value]


def is_hosted_deployment(environ: Mapping[str, str] | None = None) -> bool:
    """Return whether configuration indicates a non-local hosted deployment."""

    env = os.environ if environ is None else environ

    if any(env.get(key) for key in _HOSTED_ENV_MARKERS):
        return True

    if 'saas' in env.get('OPENHANDS_CONFIG_CLS', '').lower():
        return True

    for endpoint in _configured_public_endpoints(env):
        if not _is_loopback_host(_host_from_value(endpoint)):
            return True

    return False


def is_railway_deployment(environ: Mapping[str, str] | None = None) -> bool:
    """Return whether the process is running in a Railway deployment."""

    env = os.environ if environ is None else environ
    return any(env.get(key) for key in _RAILWAY_ENV_MARKERS)


def _validate_remote_runtime_configuration(env: Mapping[str, str]) -> None:
    api_url = (env.get('SANDBOX_REMOTE_RUNTIME_API_URL') or '').strip()
    api_key = (env.get('SANDBOX_API_KEY') or '').strip()

    if not api_url or not api_key:
        raise RuntimeError(
            'Hosted RUNTIME=remote requires both '
            'SANDBOX_REMOTE_RUNTIME_API_URL and SANDBOX_API_KEY.'
        )

    if _is_loopback_host(_host_from_value(api_url)):
        raise RuntimeError(
            'Hosted RUNTIME=remote requires a non-loopback remote runtime API URL. '
            'The sandbox execution boundary must be outside the application host.'
        )


def validate_runtime_security(
    environ: Mapping[str, str] | None = None,
    *,
    effective_uid: int | None = None,
) -> None:
    """Validate sandbox/runtime choices before the web application starts.

    Rules:
    - Hosted deployments may not use ``local`` or ``process`` sandboxes because
      those execute agent code inside the application container.
    - Railway deployments must use ``remote`` because the platform does not
      expose the Docker isolation boundary expected by DockerSandboxService.
    - Hosted remote runtimes require an authenticated, non-loopback runtime API.
    - Hosted deployments may not run the application as root.
    - ``RUNTIME=process`` outside a hosted deployment requires an explicit local
      development opt-in, making the unsafe boundary impossible to select by
      accident.

    Docker and remote runtimes remain valid for generic hosted environments when
    the infrastructure provides the required isolation. Docker deployments still
    need the usual Docker daemon/socket hardening at the infrastructure layer.
    """

    env = os.environ if environ is None else environ
    runtime = env.get('RUNTIME', 'docker').strip().lower() or 'docker'
    hosted = is_hosted_deployment(env)
    railway = is_railway_deployment(env)

    if hosted and runtime in {'local', 'process'}:
        raise RuntimeError(
            'Unsafe sandbox configuration: hosted deployments cannot use '
            f'RUNTIME={runtime!r}. Configure RUNTIME=remote with '
            'SANDBOX_REMOTE_RUNTIME_API_URL/SANDBOX_API_KEY, or use an isolated '
            'Docker sandbox deployment.'
        )

    if railway and runtime != 'remote':
        raise RuntimeError(
            'Railway deployments require RUNTIME=remote. Railway does not provide '
            'the Docker socket/isolation boundary required by the Docker sandbox.'
        )

    if (
        runtime == 'process'
        and not hosted
        and not _is_truthy(env.get(_INSECURE_PROCESS_OVERRIDE))
    ):
        raise RuntimeError(
            'RUNTIME=process shares the OpenHands application container. It is '
            'disabled by default. For trusted local development only, set '
            f'{_INSECURE_PROCESS_OVERRIDE}=true explicitly.'
        )

    if not hosted:
        return

    if effective_uid is None and hasattr(os, 'geteuid'):
        effective_uid = os.geteuid()

    sandbox_user_id = env.get('SANDBOX_USER_ID')
    planned_root = sandbox_user_id is not None and sandbox_user_id.strip() == '0'

    # NO_SETUP bypasses the entrypoint's user drop, so in that mode the current
    # effective UID is the security boundary regardless of SANDBOX_USER_ID.
    if _is_truthy(env.get('NO_SETUP')):
        running_as_root = effective_uid == 0
    else:
        running_as_root = planned_root or (
            sandbox_user_id is None and effective_uid == 0
        )

    if running_as_root:
        raise RuntimeError(
            'Unsafe application user: hosted OpenHands deployments must not run '
            'the app server as root. Set SANDBOX_USER_ID to a non-zero UID.'
        )

    if runtime == 'remote':
        _validate_remote_runtime_configuration(env)


def main() -> None:
    """CLI entry point used by container startup as an early security gate."""

    validate_runtime_security()


if __name__ == '__main__':
    main()
