"""Coverage for runtime composition and provider URL compatibility in config.py."""

import os
from unittest.mock import patch

import pytest

from openhands.app_server.config import (
    config_from_env,
    get_default_permitted_cors_origins,
    get_default_web_url,
    get_openhands_provider_base_url,
    resolve_provider_llm_base_url,
)
from openhands.app_server.sandbox.docker_sandbox_service import (
    DockerSandboxServiceInjector,
)
from openhands.app_server.sandbox.docker_sandbox_spec_service import (
    DockerSandboxSpecServiceInjector,
)
from openhands.app_server.sandbox.process_sandbox_service import (
    ProcessSandboxServiceInjector,
)
from openhands.app_server.sandbox.process_sandbox_spec_service import (
    ProcessSandboxSpecServiceInjector,
)
from openhands.app_server.sandbox.remote_sandbox_service import (
    RemoteSandboxServiceInjector,
)
from openhands.app_server.sandbox.remote_sandbox_spec_service import (
    RemoteSandboxSpecServiceInjector,
)


def _clean_env() -> dict[str, str]:
    keep = ['PATH', 'HOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'TMPDIR', 'TMP', 'TEMP']
    return {key: os.environ[key] for key in keep if key in os.environ}


def test_legacy_web_host_is_normalized_to_https() -> None:
    with patch.dict(os.environ, {'WEB_HOST': 'openhands.example.com'}, clear=True):
        assert get_default_web_url() == 'https://openhands.example.com'


def test_legacy_cors_origins_are_trimmed_and_empty_values_removed() -> None:
    with patch.dict(
        os.environ,
        {'PERMITTED_CORS_ORIGINS': ' https://a.example , ,https://b.example '},
        clear=True,
    ):
        assert get_default_permitted_cors_origins() == [
            'https://a.example',
            'https://b.example',
        ]


def test_provider_base_url_prefers_new_environment_variable() -> None:
    with patch.dict(
        os.environ,
        {
            'OPENHANDS_PROVIDER_BASE_URL': 'https://new.example/v1',
            'LLM_BASE_URL': 'https://legacy.example/v1',
        },
        clear=True,
    ):
        assert get_openhands_provider_base_url() == 'https://new.example/v1'


def test_provider_base_url_falls_back_to_legacy_llm_base_url() -> None:
    with patch.dict(
        os.environ,
        {'LLM_BASE_URL': 'https://legacy.example/v1'},
        clear=True,
    ):
        assert get_openhands_provider_base_url() == 'https://legacy.example/v1'


def test_openhands_default_proxy_is_replaced_by_deployment_provider_url() -> None:
    result = resolve_provider_llm_base_url(
        'openhands/model',
        'https://llm-proxy.app.all-hands.dev/',
        'https://provider.example/v1',
    )

    assert result == 'https://provider.example/v1'


def test_explicit_user_base_url_is_never_overridden() -> None:
    result = resolve_provider_llm_base_url(
        'openhands/model',
        'https://custom-user.example/v1',
        'https://provider.example/v1',
    )

    assert result == 'https://custom-user.example/v1'


def test_non_openhands_model_keeps_its_base_url() -> None:
    result = resolve_provider_llm_base_url(
        'anthropic/claude',
        'https://custom-user.example/v1',
        'https://provider.example/v1',
    )

    assert result == 'https://custom-user.example/v1'


def test_remote_runtime_composes_remote_sandbox_services() -> None:
    env = _clean_env()
    env.update(
        {
            'RUNTIME': 'remote',
            'SANDBOX_API_KEY': 'test-key',
            'SANDBOX_REMOTE_RUNTIME_API_URL': 'https://sandbox.example/api',
        }
    )

    with patch.dict(os.environ, env, clear=True):
        config = config_from_env()

    assert isinstance(config.sandbox, RemoteSandboxServiceInjector)
    assert isinstance(config.sandbox_spec, RemoteSandboxSpecServiceInjector)


@pytest.mark.parametrize('runtime', ['local', 'process'])
def test_process_backed_runtime_composes_process_services(runtime: str) -> None:
    env = _clean_env()
    env['RUNTIME'] = runtime

    with patch.dict(os.environ, env, clear=True):
        config = config_from_env()

    assert isinstance(config.sandbox, ProcessSandboxServiceInjector)
    assert isinstance(config.sandbox_spec, ProcessSandboxSpecServiceInjector)


def test_default_runtime_composes_docker_services() -> None:
    env = _clean_env()

    with patch.dict(os.environ, env, clear=True):
        config = config_from_env()

    assert isinstance(config.sandbox, DockerSandboxServiceInjector)
    assert isinstance(config.sandbox_spec, DockerSandboxSpecServiceInjector)


def test_remote_runtime_requires_api_credentials() -> None:
    env = _clean_env()
    env['RUNTIME'] = 'remote'

    with patch.dict(os.environ, env, clear=True), pytest.raises(KeyError):
        config_from_env()
