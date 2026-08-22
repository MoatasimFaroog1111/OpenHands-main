"""Tests for the hosted sandbox/runtime security boundary."""

import pytest

from openhands.app_server.sandbox.runtime_security import (
    is_hosted_deployment,
    validate_runtime_security,
)


def test_localhost_url_is_not_hosted():
    env = {'OH_WEB_URL': 'http://127.0.0.1:3000'}

    assert is_hosted_deployment(env) is False


def test_public_web_url_is_hosted():
    env = {'OH_WEB_URL': 'https://openhands.example.com'}

    assert is_hosted_deployment(env) is True


def test_public_cors_origin_is_hosted():
    env = {'OH_PERMITTED_CORS_ORIGINS_0': 'https://openhands.example.com'}

    assert is_hosted_deployment(env) is True


def test_railway_environment_is_hosted_without_web_url():
    env = {'RAILWAY_ENVIRONMENT': 'production'}

    assert is_hosted_deployment(env) is True


@pytest.mark.parametrize('runtime', ['local', 'process'])
def test_hosted_deployment_rejects_process_backed_runtime(runtime):
    env = {
        'RUNTIME': runtime,
        'OH_WEB_URL': 'https://openhands.example.com',
        'SANDBOX_USER_ID': '42421',
    }

    with pytest.raises(RuntimeError, match='hosted deployments cannot use'):
        validate_runtime_security(env, effective_uid=42421)


def test_hosted_process_runtime_cannot_be_overridden():
    env = {
        'RUNTIME': 'process',
        'OH_WEB_URL': 'https://openhands.example.com',
        'OH_ALLOW_INSECURE_PROCESS_SANDBOX': 'true',
        'SANDBOX_USER_ID': '42421',
    }

    with pytest.raises(RuntimeError, match='hosted deployments cannot use'):
        validate_runtime_security(env, effective_uid=42421)


def test_local_process_runtime_requires_explicit_opt_in():
    env = {'RUNTIME': 'process'}

    with pytest.raises(RuntimeError, match='disabled by default'):
        validate_runtime_security(env, effective_uid=1000)


def test_local_process_runtime_allows_explicit_development_opt_in():
    env = {
        'RUNTIME': 'process',
        'OH_ALLOW_INSECURE_PROCESS_SANDBOX': 'true',
    }

    validate_runtime_security(env, effective_uid=1000)


def test_local_runtime_remains_available_for_local_development():
    env = {
        'RUNTIME': 'local',
        'OH_WEB_URL': 'http://localhost:3000',
    }

    validate_runtime_security(env, effective_uid=1000)


def test_hosted_deployment_rejects_planned_root_user():
    env = {
        'RUNTIME': 'docker',
        'OH_WEB_URL': 'https://openhands.example.com',
        'SANDBOX_USER_ID': '0',
    }

    with pytest.raises(RuntimeError, match='must not run the app server as root'):
        validate_runtime_security(env, effective_uid=0)


def test_hosted_deployment_rejects_effective_root_when_uid_not_configured():
    env = {
        'RUNTIME': 'remote',
        'RAILWAY_PUBLIC_DOMAIN': 'openhands.example.com',
    }

    with pytest.raises(RuntimeError, match='must not run the app server as root'):
        validate_runtime_security(env, effective_uid=0)


def test_hosted_remote_runtime_allows_non_root_app_user():
    env = {
        'RUNTIME': 'remote',
        'RAILWAY_PUBLIC_DOMAIN': 'openhands.example.com',
        'SANDBOX_USER_ID': '42421',
    }

    validate_runtime_security(env, effective_uid=0)


def test_hosted_docker_runtime_allows_non_root_app_user():
    env = {
        'RUNTIME': 'docker',
        'OH_WEB_URL': 'https://openhands.example.com',
        'SANDBOX_USER_ID': '42421',
    }

    validate_runtime_security(env, effective_uid=0)


def test_unhosted_docker_keeps_legacy_root_compatibility():
    env = {
        'RUNTIME': 'docker',
        'SANDBOX_USER_ID': '0',
    }

    validate_runtime_security(env, effective_uid=0)
