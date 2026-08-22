"""Focused coverage for sandbox session-key security boundaries."""

import contextlib
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from openhands.app_server.config_api.config_models import AppMode
from openhands.app_server.sandbox.sandbox_models import SandboxInfo, SandboxStatus
from openhands.app_server.sandbox.session_auth import (
    validate_session_key,
    validate_session_key_ownership,
)


def _sandbox(*, user_id: str | None) -> SandboxInfo:
    return SandboxInfo(
        id='sandbox-1',
        created_by_user_id=user_id,
        sandbox_spec_id='spec-1',
        status=SandboxStatus.RUNNING,
        session_api_key='session-key',
    )


def _sandbox_service_context(service):
    @contextlib.asynccontextmanager
    async def _context(state, request=None):
        yield service

    return _context


@pytest.mark.asyncio
async def test_oss_accepts_running_sandbox_without_owner() -> None:
    """Owner-less legacy OSS sandboxes stay compatible outside SaaS mode."""
    service = AsyncMock()
    service.get_sandbox_by_session_api_key.return_value = _sandbox(user_id=None)

    with (
        patch(
            'openhands.app_server.sandbox.session_auth.get_sandbox_service',
            new=_sandbox_service_context(service),
        ),
        patch(
            'openhands.app_server.sandbox.session_auth.get_global_config',
            return_value=SimpleNamespace(app_mode=AppMode.OPENHANDS),
        ),
    ):
        result = await validate_session_key('session-key')

    assert result.id == 'sandbox-1'
    assert result.created_by_user_id is None
    service.get_sandbox_by_session_api_key.assert_awaited_once_with('session-key')


@pytest.mark.asyncio
async def test_ownership_accepts_matching_authenticated_user() -> None:
    service = AsyncMock()
    service.get_sandbox_by_session_api_key.return_value = _sandbox(user_id='user-1')
    user_context = AsyncMock()
    user_context.get_user_id.return_value = 'user-1'

    with patch(
        'openhands.app_server.sandbox.session_auth.get_sandbox_service',
        new=_sandbox_service_context(service),
    ):
        await validate_session_key_ownership(user_context, 'session-key')

    user_context.get_user_id.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_ownership_checks_session_before_reading_user_identity() -> None:
    """An invalid session key must fail before caller identity is consulted."""
    service = AsyncMock()
    service.get_sandbox_by_session_api_key.return_value = None
    user_context = AsyncMock()

    with (
        patch(
            'openhands.app_server.sandbox.session_auth.get_sandbox_service',
            new=_sandbox_service_context(service),
        ),
        pytest.raises(Exception) as exc_info,
    ):
        await validate_session_key_ownership(user_context, 'invalid-key')

    assert getattr(exc_info.value, 'status_code', None) == 401
    user_context.get_user_id.assert_not_awaited()
