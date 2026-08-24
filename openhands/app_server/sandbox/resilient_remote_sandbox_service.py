"""Remote sandbox transport policy for slow startup operations.

Remote runtime startup is intentionally much slower than ordinary app-server HTTP
traffic: a backend may need to provision a sandbox, pull an image, launch the agent
server, wait for readiness, and collect bounded diagnostics before replying.

This adapter changes only POST /start. All other RemoteSandboxService requests keep
the shared HTTP client's existing timeout behavior.
"""

from dataclasses import fields
from typing import Any, AsyncGenerator

import httpx
from fastapi import Request
from pydantic import Field

from openhands.app_server.sandbox.remote_sandbox_service import (
    RemoteSandboxService,
    RemoteSandboxServiceInjector,
)
from openhands.app_server.sandbox.sandbox_service import SandboxService
from openhands.app_server.services.injector import InjectorState

_START_PATH = '/start'
_START_METHOD = 'POST'
_MAX_REMOTE_ERROR_CHARS = 12_000


class ResilientRemoteSandboxService(RemoteSandboxService):
    """Remote sandbox service with startup-specific HTTP behavior."""

    async def _send_runtime_api_request(
        self, method: str, path: str, **kwargs: Any
    ) -> httpx.Response:
        is_start = method.upper() == _START_METHOD and path == _START_PATH
        if is_start:
            kwargs.setdefault('timeout', self.start_sandbox_timeout)

        try:
            response = await super()._send_runtime_api_request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            if not is_start:
                raise
            request = getattr(exc, 'request', None)
            raise httpx.TimeoutException(
                f'remote runtime start timed out after {self.start_sandbox_timeout}s',
                request=request,
            ) from exc

        if is_start and response.is_error:
            detail = _remote_error_detail(response)
            raise httpx.HTTPStatusError(
                f'remote runtime start returned HTTP {response.status_code}: {detail}',
                request=response.request,
                response=response,
            )

        return response


class ResilientRemoteSandboxServiceInjector(RemoteSandboxServiceInjector):
    """Inject the startup-aware RemoteSandboxService implementation."""

    start_sandbox_timeout: int = Field(
        default=360,
        description=(
            'Total HTTP wait budget for remote sandbox startup. This must be longer '
            'than the remote provisioning backend readiness/diagnostic window.'
        ),
    )

    async def inject(
        self, state: InjectorState, request: Request | None = None
    ) -> AsyncGenerator[SandboxService, None]:
        async for service in super().inject(state, request):
            init_values = {
                field.name: getattr(service, field.name)
                for field in fields(RemoteSandboxService)
                if field.init
            }
            yield ResilientRemoteSandboxService(**init_values)


def _remote_error_detail(response: httpx.Response) -> str:
    detail = ''
    try:
        payload = response.json()
        if isinstance(payload, dict) and isinstance(payload.get('error'), str):
            detail = payload['error']
    except ValueError:
        pass

    if not detail:
        detail = response.text
    if not detail:
        detail = response.reason_phrase or 'remote runtime returned an error'

    if len(detail) <= _MAX_REMOTE_ERROR_CHARS:
        return detail.strip()
    omitted = len(detail) - _MAX_REMOTE_ERROR_CHARS
    return f'{detail[:_MAX_REMOTE_ERROR_CHARS].strip()}\n...[truncated {omitted} chars]'
