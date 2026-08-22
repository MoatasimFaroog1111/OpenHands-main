"""Tests for the hosted sandbox/runtime security boundary."""

import pytest

from openhands.app_server.sandbox.runtime_security import (
    is_hosted_deployment,
    is_railway_deployment,
    validate_runtime_security,
)

_REMOTE_ENV = {
    'SANDBOX_REMOTE_RUNTIME_API_URL': 'https://runtime.example.com',
    'SANDBOX_API_KEY': 'test-runtime-key',
}


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
    assert is_railway_deployment(env) is True


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


def test_no_setup_cannot_bypass_hosted_root_restriction():
    env = {
        'RUNTIME': 'remote',
        'RAILWAY_PUBLIC_DOMAIN': 'openhands.example.com',
        'SANDBOX_USER_ID': '42421',
        'NO_SETUP': 'true',
        **_REMOTE_ENV,
    }

    with pytest.raises(RuntimeError, match='must not run the app server as root'):
        validate_runtime_security(env, effective_uid=0)


def test_no_setup_allows_hosted_non_root_process():
    env = {
        'RUNTIME': 'remote',
        'RAILWAY_PUBLIC_DOMAIN': 'openhands.example.com',
        'SANDBOX_USER_ID': '42421',
        'NO_SETUP': 'true',
        **_REMOTE_ENV,
    }

    validate_runtime_security(env, effective_uid=42421)


def test_hosted_remote_runtime_allows_non_root_app_user():
    env = {
        'RUNTIME': 'remote',
        'OH_WEB_URL': 'https://openhands.example.com',
        'SANDBOX_USER_ID': '42421',
        **_REMOTE_ENV,
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


def test_railway_rejects_docker_runtime_even_with_non_root_app_user():
    env = {
        'RAILWAY_ENVIRONMENT': 'production',
        'RUNTIME': 'docker',
        'SANDBOX_USER_ID': '42421',
    }

    with pytest.raises(RuntimeError, match='Railway deployments require RUNTIME=remote'):
        validate_runtime_security(env, effective_uid=0)


def test_railway_remote_requires_runtime_credentials():
    env = {
        'RAILWAY_ENVIRONMENT': 'production',
        'RUNTIME': 'remote',
        'SANDBOX_USER_ID': '42421',
    }

    with pytest.raises(RuntimeError, match='requires both'):
        validate_runtime_security(env, effective_uid=0)


def test_railway_remote_rejects_loopback_runtime_api():
    env = {
        'RAILWAY_ENVIRONMENT': 'production',
        'RUNTIME': 'remote',
        'SANDBOX_USER_ID': '42421',
        'SANDBOX_REMOTE_RUNTIME_API_URL': 'http://127.0.0.1:9000',
        'SANDBOX_API_KEY': 'test-runtime-key',
    }

    with pytest.raises(RuntimeError, match='non-loopback remote runtime API URL'):
        validate_runtime_security(env, effective_uid=0)


def test_railway_remote_allows_private_external_runtime_hostname():
    env = {
        'RAILWAY_ENVIRONMENT': 'production',
        'RUNTIME': 'remote',
        'SANDBOX_USER_ID': '42421',
        'SANDBOX_REMOTE_RUNTIME_API_URL': 'http://runtime.railway.internal:9000',
        'SANDBOX_API_KEY': 'test-runtime-key',
    }

    validate_runtime_security(env, effective_uid=0)
