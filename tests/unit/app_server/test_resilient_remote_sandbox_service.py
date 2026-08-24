from unittest.mock import AsyncMock

import httpx
import pytest

from openhands.app_server.sandbox.resilient_remote_sandbox_service import (
    ResilientRemoteSandboxService,
    ResilientRemoteSandboxServiceInjector,
)


def _service(client: AsyncMock, timeout: int = 360) -> ResilientRemoteSandboxService:
    return ResilientRemoteSandboxService(
        sandbox_spec_service=AsyncMock(),
        api_url='https://runtime.example',
        api_key='test-key',
        web_url='https://openhands.example',
        resource_factor=1,
        runtime_class='gvisor',
        start_sandbox_timeout=timeout,
        max_num_sandboxes=10,
        user_context=AsyncMock(),
        httpx_client=client,
        db_session=AsyncMock(),
    )


@pytest.mark.asyncio
async def test_start_request_uses_startup_specific_timeout() -> None:
    client = AsyncMock(spec=httpx.AsyncClient)
    request = httpx.Request('POST', 'https://runtime.example/start')
    client.request.return_value = httpx.Response(
        201,
        request=request,
        json={'status': 'running'},
    )
    service = _service(client, timeout=360)

    response = await service._send_runtime_api_request('POST', '/start', json={})

    assert response.status_code == 201
    client.request.assert_awaited_once_with(
        'POST',
        'https://runtime.example/start',
        headers={'X-API-Key': 'test-key'},
        json={},
        timeout=360,
    )


@pytest.mark.asyncio
async def test_non_start_request_keeps_shared_client_timeout_policy() -> None:
    client = AsyncMock(spec=httpx.AsyncClient)
    request = httpx.Request('GET', 'https://runtime.example/list')
    client.request.return_value = httpx.Response(
        200, request=request, json={'runtimes': []}
    )
    service = _service(client)

    await service._send_runtime_api_request('GET', '/list')

    client.request.assert_awaited_once_with(
        'GET',
        'https://runtime.example/list',
        headers={'X-API-Key': 'test-key'},
    )


@pytest.mark.asyncio
async def test_start_timeout_has_actionable_error_message() -> None:
    client = AsyncMock(spec=httpx.AsyncClient)
    request = httpx.Request('POST', 'https://runtime.example/start')
    client.request.side_effect = httpx.ReadTimeout('', request=request)
    service = _service(client, timeout=360)

    with pytest.raises(
        httpx.TimeoutException,
        match='remote runtime start timed out after 360s',
    ):
        await service._send_runtime_api_request('POST', '/start', json={})


@pytest.mark.asyncio
async def test_start_http_error_surfaces_gateway_diagnostics() -> None:
    client = AsyncMock(spec=httpx.AsyncClient)
    request = httpx.Request('POST', 'https://runtime.example/start')
    diagnostic = (
        'agent-server did not become healthy within 120000ms\n'
        '[startup-diagnostics]\n'
        '[container-state]\nstatus=exited exit=1'
    )
    client.request.return_value = httpx.Response(
        500,
        request=request,
        json={'error': diagnostic},
    )
    service = _service(client)

    with pytest.raises(httpx.HTTPStatusError) as exc_info:
        await service._send_runtime_api_request('POST', '/start', json={})

    message = str(exc_info.value)
    assert 'remote runtime start returned HTTP 500' in message
    assert '[startup-diagnostics]' in message
    assert 'status=exited exit=1' in message


def test_remote_injector_default_start_budget_exceeds_gateway_health_window() -> None:
    injector = ResilientRemoteSandboxServiceInjector(
        api_url='https://runtime.example',
        api_key='test-key',
    )

    assert injector.start_sandbox_timeout == 360
