"""Unit coverage for optional conversation hook loading."""

from unittest.mock import AsyncMock, Mock, patch

import httpx
import pytest

from openhands.app_server.app_conversation.hook_loader import (
    fetch_hooks_from_agent_server,
    get_project_dir_for_hooks,
    load_hooks_from_agent_server,
)


def test_project_dir_uses_selected_repository_name() -> None:
    assert (
        get_project_dir_for_hooks('/workspace', 'OpenHands/software-agent-sdk')
        == '/workspace/software-agent-sdk'
    )


def test_project_dir_without_repository_is_working_dir() -> None:
    assert get_project_dir_for_hooks('/workspace') == '/workspace'


@pytest.mark.asyncio
async def test_fetch_hooks_sends_session_key_and_project_dir() -> None:
    client = AsyncMock(spec=httpx.AsyncClient)
    response = Mock()
    response.raise_for_status = Mock()
    response.json.return_value = {'hook_config': None}
    client.post.return_value = response

    result = await fetch_hooks_from_agent_server(
        'http://agent:8000',
        'session-key',
        '/workspace/project',
        client,
    )

    assert result is None
    client.post.assert_awaited_once_with(
        'http://agent:8000/api/hooks',
        json={'project_dir': '/workspace/project'},
        headers={
            'Content-Type': 'application/json',
            'X-Session-API-Key': 'session-key',
        },
        timeout=30.0,
    )
    response.raise_for_status.assert_called_once_with()


@pytest.mark.asyncio
async def test_fetch_hooks_omits_session_header_when_key_is_missing() -> None:
    client = AsyncMock(spec=httpx.AsyncClient)
    response = Mock()
    response.raise_for_status = Mock()
    response.json.return_value = {'hook_config': None}
    client.post.return_value = response

    await fetch_hooks_from_agent_server(
        'http://agent:8000',
        None,
        '/workspace/project',
        client,
    )

    headers = client.post.await_args.kwargs['headers']
    assert headers == {'Content-Type': 'application/json'}


@pytest.mark.asyncio
async def test_fetch_hooks_returns_none_for_empty_hook_config() -> None:
    client = AsyncMock(spec=httpx.AsyncClient)
    response = Mock()
    response.raise_for_status = Mock()
    response.json.return_value = {'hook_config': {'version': 1}}
    client.post.return_value = response
    hook_config = Mock()
    hook_config.is_empty.return_value = True

    with patch(
        'openhands.app_server.app_conversation.hook_loader.HookConfig.from_dict',
        return_value=hook_config,
    ) as from_dict:
        result = await fetch_hooks_from_agent_server(
            'http://agent:8000',
            'session-key',
            '/workspace/project',
            client,
        )

    assert result is None
    from_dict.assert_called_once_with({'version': 1})


@pytest.mark.asyncio
async def test_fetch_hooks_returns_parsed_non_empty_config() -> None:
    client = AsyncMock(spec=httpx.AsyncClient)
    response = Mock()
    response.raise_for_status = Mock()
    response.json.return_value = {'hook_config': {'version': 1}}
    client.post.return_value = response
    hook_config = Mock()
    hook_config.is_empty.return_value = False

    with patch(
        'openhands.app_server.app_conversation.hook_loader.HookConfig.from_dict',
        return_value=hook_config,
    ):
        result = await fetch_hooks_from_agent_server(
            'http://agent:8000',
            'session-key',
            '/workspace/project',
            client,
        )

    assert result is hook_config


@pytest.mark.asyncio
async def test_load_hooks_swallows_http_status_error() -> None:
    client = AsyncMock(spec=httpx.AsyncClient)
    request = httpx.Request('POST', 'http://agent:8000/api/hooks')
    response = httpx.Response(500, request=request, text='failure')
    error = httpx.HTTPStatusError('failure', request=request, response=response)

    with patch(
        'openhands.app_server.app_conversation.hook_loader.fetch_hooks_from_agent_server',
        new=AsyncMock(side_effect=error),
    ):
        result = await load_hooks_from_agent_server(
            'http://agent:8000', 'session-key', '/workspace/project', client
        )

    assert result is None


@pytest.mark.asyncio
async def test_load_hooks_swallows_request_error() -> None:
    client = AsyncMock(spec=httpx.AsyncClient)
    request = httpx.Request('POST', 'http://agent:8000/api/hooks')
    error = httpx.ConnectError('unreachable', request=request)

    with patch(
        'openhands.app_server.app_conversation.hook_loader.fetch_hooks_from_agent_server',
        new=AsyncMock(side_effect=error),
    ):
        result = await load_hooks_from_agent_server(
            'http://agent:8000', 'session-key', '/workspace/project', client
        )

    assert result is None


@pytest.mark.asyncio
async def test_load_hooks_swallows_unexpected_error() -> None:
    client = AsyncMock(spec=httpx.AsyncClient)

    with patch(
        'openhands.app_server.app_conversation.hook_loader.fetch_hooks_from_agent_server',
        new=AsyncMock(side_effect=RuntimeError('bad hook payload')),
    ):
        result = await load_hooks_from_agent_server(
            'http://agent:8000', 'session-key', '/workspace/project', client
        )

    assert result is None
