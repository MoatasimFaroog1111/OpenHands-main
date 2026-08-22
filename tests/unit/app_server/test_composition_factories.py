"""Regression tests for the app-server composition factories."""

import os
from pathlib import Path
from unittest.mock import patch

import pytest

from openhands.app_server.composition.llm_event_factories import (
    create_default_event_service_injector,
    create_default_llm_model_service_injector,
)
from openhands.app_server.composition.sandbox_factories import (
    create_default_sandbox_service_injector,
)
from openhands.app_server.config_api.default_llm_model_service import (
    DefaultLLMModelServiceInjector,
)
from openhands.app_server.sandbox.docker_sandbox_service import (
    DockerSandboxServiceInjector,
)


def test_docker_factory_preserves_legacy_runtime_options_and_volume_mounts() -> None:
    env = {
        'SANDBOX_HOST_PORT': '4321',
        'SANDBOX_CONTAINER_URL_PATTERN': 'https://sandbox.example/{port}',
        'SANDBOX_STARTUP_GRACE_SECONDS': '45',
        'SANDBOX_VOLUMES': (
            '/host/project:/workspace/project:ro, ,invalid,/host/cache:/workspace/cache'
        ),
    }

    with patch.dict(os.environ, env, clear=True):
        injector = create_default_sandbox_service_injector()

    assert isinstance(injector, DockerSandboxServiceInjector)
    assert injector.host_port == 4321
    assert injector.container_url_pattern == 'https://sandbox.example/{port}'
    assert injector.startup_grace_seconds == 45
    assert [
        (mount.host_path, mount.container_path, mount.mode) for mount in injector.mounts
    ] == [
        ('/host/project', '/workspace/project', 'ro'),
        ('/host/cache', '/workspace/cache', 'rw'),
    ]


def test_docker_factory_ignores_volume_specs_without_container_path() -> None:
    with patch.dict(
        os.environ, {'SANDBOX_VOLUMES': 'invalid, ,also-invalid'}, clear=True
    ):
        injector = create_default_sandbox_service_injector()

    assert isinstance(injector, DockerSandboxServiceInjector)
    assert injector.mounts == []


def test_llm_factory_preserves_aws_and_ollama_environment_settings() -> None:
    env = {
        'AWS_REGION_NAME': 'us-east-1',
        'AWS_ACCESS_KEY_ID': 'test-access-key',
        'AWS_SECRET_ACCESS_KEY': 'test-secret-key',
        'OLLAMA_BASE_URL': 'http://localhost:11434',
    }

    with patch.dict(os.environ, env, clear=True):
        injector = create_default_llm_model_service_injector()

    assert isinstance(injector, DefaultLLMModelServiceInjector)
    assert injector.aws_region_name == 'us-east-1'
    assert injector.aws_access_key_id is not None
    assert injector.aws_access_key_id.get_secret_value() == 'test-access-key'
    assert injector.aws_secret_access_key is not None
    assert injector.aws_secret_access_key.get_secret_value() == 'test-secret-key'
    assert injector.ollama_base_url == 'http://localhost:11434'


def test_gcp_event_factory_requires_bucket_path() -> None:
    with (
        patch.dict(
            os.environ,
            {'SHARED_EVENT_STORAGE_PROVIDER': 'gcp'},
            clear=True,
        ),
        pytest.raises(ValueError, match='FILE_STORE_PATH.*Google Cloud'),
    ):
        create_default_event_service_injector()


def test_composition_factories_do_not_depend_on_config_facade() -> None:
    composition_dir = Path('openhands/app_server/composition')
    factory_paths = [
        composition_dir / 'llm_event_factories.py',
        composition_dir / 'sandbox_factories.py',
        composition_dir / 'app_service_factories.py',
    ]

    for path in factory_paths:
        source = path.read_text(encoding='utf-8')
        assert 'openhands.app_server.config import' not in source
        assert 'from openhands.app_server.config ' not in source
