"""Regression tests for the Railway deployment security contract."""

import json
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]


def test_railway_builds_the_repository_root_dockerfile() -> None:
    config = json.loads((_REPO_ROOT / 'railway.json').read_text(encoding='utf-8'))

    assert config['build'] == {
        'builder': 'DOCKERFILE',
        'dockerfilePath': 'Dockerfile',
    }
    assert config['deploy']['healthcheckPath'] == '/'


def test_railway_entrypoint_requires_isolated_remote_sandbox() -> None:
    source = (_REPO_ROOT / 'containers/app/entrypoint.sh').read_text(encoding='utf-8')

    assert 'export RUNTIME="${RUNTIME:-remote}"' in source
    assert 'Railway deployments require RUNTIME=remote for sandbox isolation' in source
    assert 'SANDBOX_REMOTE_RUNTIME_API_URL' in source
    assert 'SANDBOX_API_KEY' in source
    assert 'Railway deployments require a non-zero SANDBOX_USER_ID' in source


def test_railway_entrypoint_derives_public_url_and_persistent_paths() -> None:
    source = (_REPO_ROOT / 'containers/app/entrypoint.sh').read_text(encoding='utf-8')

    assert 'https://${RAILWAY_PUBLIC_DOMAIN}' in source
    assert 'OH_PERSISTENCE_DIR:-/data/.openhands' in source
    assert 'FILE_STORE_PATH:-${OH_PERSISTENCE_DIR}' in source
    assert 'TMPDIR:-/data/tmp' in source


def test_runtime_security_gate_runs_before_user_setup() -> None:
    source = (_REPO_ROOT / 'containers/app/entrypoint.sh').read_text(encoding='utf-8')

    security_gate = source.index(
        'python -m openhands.app_server.sandbox.runtime_security'
    )
    user_setup = source.index('if [ "$(id -u)" -ne 0 ]')

    assert security_gate < user_setup


def test_azure_deployment_is_retained_until_railway_e2e_cutover() -> None:
    azure_workflow = _REPO_ROOT / '.github/workflows/deploy-openhands-azure-vm.yml'
    railway_docs = (_REPO_ROOT / 'docs/RAILWAY_DEPLOYMENT.md').read_text(
        encoding='utf-8'
    )

    assert azure_workflow.is_file()
    assert 'Do not remove the existing Azure deployment' in railway_docs
    assert 'Azure remains the retained deployment path' in railway_docs
