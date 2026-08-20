"""Regression tests for process sandbox loopback routing."""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from openhands.app_server.sandbox.process_sandbox_service import (
    ProcessInfo,
    ProcessSandboxService,
)
from openhands.app_server.sandbox.sandbox_models import SandboxStatus


def _make_service(
    *, health_check_path: str = '/alive', proxy_enabled: bool = True
) -> ProcessSandboxService:
    return ProcessSandboxService(
        user_id='test-user',
        sandbox_spec_service=MagicMock(),
        base_working_dir='/tmp/openhands-process-loopback-tests',
        base_port=9000,
        python_executable='python',
        agent_server_module='openhands.agent_server',
        health_check_path=health_check_path,
        httpx_client=AsyncMock(spec=httpx.AsyncClient),
        proxy_enabled=proxy_enabled,
    )


def test_process_agent_urls_are_owned_by_process_runtime() -> None:
    """Process sandboxes must use loopback, not Docker host translation."""
    service = _make_service(health_check_path='alive')

    assert service._agent_server_base_url(9000) == 'http://127.0.0.1:9000'
    assert service._agent_server_health_url(9000) == 'http://127.0.0.1:9000/alive'


@pytest.mark.asyncio
async def test_readiness_probe_uses_loopback_url() -> None:
    """The readiness probe must target the child process in this container."""
    service = _make_service()
    response = MagicMock()
    response.status_code = 200
    response.json.return_value = {'status': 'ok'}
    service.httpx_client.get.return_value = response

    assert await service._wait_for_server_ready(9000, timeout=1) is True
    service.httpx_client.get.assert_awaited_once_with(
        'http://127.0.0.1:9000/alive', timeout=5.0
    )


@pytest.mark.asyncio
async def test_running_process_exposes_loopback_agent_url() -> None:
    """Sandbox metadata must advertise the same reachable process endpoint."""
    service = _make_service()
    response = MagicMock()
    response.status_code = 200
    service.httpx_client.get.return_value = response

    process_info = ProcessInfo(
        pid=1234,
        port=9000,
        user_id='test-user',
        working_dir='/tmp/test-sandbox',
        session_api_key='session-key',
        created_at=datetime.now(),
        sandbox_spec_id='test-spec',
    )

    with patch.object(
        service, '_get_process_status', return_value=SandboxStatus.RUNNING
    ):
        sandbox = await service._process_to_sandbox_info('sandbox-id', process_info)

    assert sandbox.status == SandboxStatus.RUNNING
    assert sandbox.session_api_key == 'session-key'
    assert sandbox.exposed_urls is not None
    assert sandbox.exposed_urls[0].url == 'http://127.0.0.1:9000'
    service.httpx_client.get.assert_awaited_once_with(
        'http://127.0.0.1:9000/alive', timeout=5.0
    )


def test_public_url_points_at_the_same_origin_proxy() -> None:
    """Browsers cannot reach the loopback port, so advertise the proxy path.

    On a single port host (Railway, Render, Fly, ...) only the app server port
    is published, so handing the web client `http://127.0.0.1:9000` left the
    event socket permanently "Disconnected".
    """
    service = _make_service()

    assert service._agent_server_base_url(9000) == 'http://127.0.0.1:9000'
    assert service._agent_server_public_url(9000) == '/runtime/9000'


def test_public_url_is_omitted_when_the_proxy_is_disabled() -> None:
    """Opting out keeps the historic behavior of exposing the raw port."""
    service = _make_service(proxy_enabled=False)

    assert service._agent_server_public_url(9000) is None


@pytest.mark.asyncio
async def test_running_process_advertises_the_proxy_public_url() -> None:
    """Sandbox metadata keeps the internal URL and adds a browser facing one."""
    service = _make_service()
    response = MagicMock()
    response.status_code = 200
    service.httpx_client.get.return_value = response

    process_info = ProcessInfo(
        pid=1234,
        port=9000,
        user_id='test-user',
        working_dir='/tmp/test-sandbox',
        session_api_key='session-key',
        created_at=datetime.now(),
        sandbox_spec_id='test-spec',
    )

    with patch.object(
        service, '_get_process_status', return_value=SandboxStatus.RUNNING
    ):
        sandbox = await service._process_to_sandbox_info('sandbox-id', process_info)

    assert sandbox.exposed_urls is not None
    exposed_url = sandbox.exposed_urls[0]
    # The app server still talks to the child process over loopback...
    assert exposed_url.url == 'http://127.0.0.1:9000'
    # ...while the browser is routed through this origin.
    assert exposed_url.public_url == '/runtime/9000'
    assert exposed_url.browser_url() == '/runtime/9000'


@pytest.mark.asyncio
async def test_running_process_falls_back_to_loopback_without_proxy() -> None:
    service = _make_service(proxy_enabled=False)
    response = MagicMock()
    response.status_code = 200
    service.httpx_client.get.return_value = response

    process_info = ProcessInfo(
        pid=1234,
        port=9000,
        user_id='test-user',
        working_dir='/tmp/test-sandbox',
        session_api_key='session-key',
        created_at=datetime.now(),
        sandbox_spec_id='test-spec',
    )

    with patch.object(
        service, '_get_process_status', return_value=SandboxStatus.RUNNING
    ):
        sandbox = await service._process_to_sandbox_info('sandbox-id', process_info)

    assert sandbox.exposed_urls is not None
    assert sandbox.exposed_urls[0].public_url is None
    assert sandbox.exposed_urls[0].browser_url() == 'http://127.0.0.1:9000'
