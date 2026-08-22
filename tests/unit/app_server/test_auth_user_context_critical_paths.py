"""Critical-path unit tests for AuthUserContext and its injector."""

from collections import abc
from types import MappingProxyType, SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest
from pydantic import SecretStr

from openhands.app_server.errors import AuthError
from openhands.app_server.integrations.provider import CustomSecret, ProviderToken
from openhands.app_server.integrations.service_types import ProviderType
from openhands.app_server.services.injector import InjectorState
from openhands.app_server.user.auth_user_context import (
    AuthUserContext,
    AuthUserContextInjector,
)
from openhands.app_server.user.specifiy_user_context import USER_CONTEXT_ATTR
from openhands.sdk.secret import StaticSecret


@pytest.mark.asyncio
async def test_provider_tokens_raw_mode_is_passthrough() -> None:
    tokens = {
        ProviderType.GITHUB: ProviderToken(token=SecretStr('github-static')),
    }
    user_auth = AsyncMock()
    user_auth.get_provider_tokens.return_value = tokens
    context = AuthUserContext(user_auth=user_auth)

    result = await context.get_provider_tokens()

    assert result is tokens
    user_auth.get_provider_tokens.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_provider_tokens_env_mode_prefers_refreshed_azure_token() -> None:
    tokens = {
        ProviderType.GITHUB: ProviderToken(token=SecretStr('github-static')),
        ProviderType.AZURE_DEVOPS: ProviderToken(token=SecretStr('azure-static')),
    }
    user_auth = AsyncMock()
    user_auth.get_provider_tokens.return_value = tokens
    context = AuthUserContext(user_auth=user_auth)
    context.get_latest_token = AsyncMock(return_value='azure-refreshed')

    result = await context.get_provider_tokens(as_env_vars=True)

    assert isinstance(result, abc.Mapping)
    assert set(result.values()) == {'github-static', 'azure-refreshed'}
    context.get_latest_token.assert_awaited_once_with(ProviderType.AZURE_DEVOPS)


@pytest.mark.asyncio
async def test_provider_tokens_env_mode_falls_back_when_refresh_fails() -> None:
    tokens = {
        ProviderType.AZURE_DEVOPS: ProviderToken(token=SecretStr('azure-static')),
    }
    user_auth = AsyncMock()
    user_auth.get_provider_tokens.return_value = tokens
    context = AuthUserContext(user_auth=user_auth)
    context.get_latest_token = AsyncMock(side_effect=RuntimeError('refresh failed'))

    result = await context.get_provider_tokens(as_env_vars=True)

    assert isinstance(result, abc.Mapping)
    assert list(result.values()) == ['azure-static']


@pytest.mark.asyncio
async def test_provider_handler_is_cached_and_uses_read_only_tokens() -> None:
    tokens = {
        ProviderType.GITHUB: ProviderToken(token=SecretStr('github-static')),
    }
    user_auth = AsyncMock()
    user_auth.get_provider_tokens.return_value = tokens
    user_auth.get_user_id.return_value = 'user-1'
    context = AuthUserContext(user_auth=user_auth)

    first = await context.get_provider_handler()
    second = await context.get_provider_handler()

    assert first is second
    assert isinstance(first.provider_tokens, MappingProxyType)
    user_auth.get_provider_tokens.assert_awaited_once_with()
    user_auth.get_user_id.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_custom_secrets_are_converted_to_static_secret_sources() -> None:
    user_auth = AsyncMock()
    user_auth.get_secrets.return_value = SimpleNamespace(
        custom_secrets={
            'SERVICE_TOKEN': CustomSecret(
                secret=SecretStr('secret-value'),
                description='service credential',
            )
        }
    )
    context = AuthUserContext(user_auth=user_auth)

    result = await context.get_secrets()

    secret = result['SERVICE_TOKEN']
    assert isinstance(secret, StaticSecret)
    assert secret.value.get_secret_value() == 'secret-value'
    assert secret.description == 'service credential'


@pytest.mark.asyncio
async def test_injector_rejects_missing_request_without_cached_context() -> None:
    injector = AuthUserContextInjector()
    state = InjectorState()
    generator = injector.inject(state, request=None)

    with pytest.raises(AuthError):
        await anext(generator)


@pytest.mark.asyncio
async def test_injector_reuses_context_already_present_on_state() -> None:
    injector = AuthUserContextInjector()
    state = InjectorState()
    existing = Mock()
    setattr(state, USER_CONTEXT_ATTR, existing)
    generator = injector.inject(state, request=None)

    result = await anext(generator)
    await generator.aclose()

    assert result is existing


@pytest.mark.asyncio
async def test_injector_builds_and_caches_context_from_request() -> None:
    injector = AuthUserContextInjector()
    state = InjectorState()
    request = Mock()
    user_auth = AsyncMock()

    with patch(
        'openhands.app_server.user.auth_user_context.get_user_auth',
        new=AsyncMock(return_value=user_auth),
    ) as get_user_auth:
        generator = injector.inject(state, request=request)
        result = await anext(generator)
        await generator.aclose()

    assert isinstance(result, AuthUserContext)
    assert result.user_auth is user_auth
    assert getattr(state, USER_CONTEXT_ATTR) is result
    get_user_auth.assert_awaited_once_with(request)
