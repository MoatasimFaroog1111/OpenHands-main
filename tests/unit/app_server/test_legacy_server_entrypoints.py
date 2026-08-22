"""Regression tests for deprecated server entrypoint compatibility shims."""

from pathlib import Path

import pytest


@pytest.mark.parametrize(
    'path',
    [
        Path('Dockerfile'),
        Path('containers/app/Dockerfile'),
        Path('Makefile'),
        Path('openhands/server/__main__.py'),
    ],
)
def test_internal_runtime_launchers_do_not_use_legacy_listen(path: Path):
    assert 'openhands.server.listen:app' not in path.read_text(encoding='utf-8')


def test_legacy_listen_reexports_canonical_app():
    from openhands.app_server.app import app as canonical_app
    from openhands.server.listen import app as legacy_app

    assert legacy_app is canonical_app


def test_legacy_server_app_reexports_canonical_app():
    from openhands.app_server.app import app as canonical_app
    from openhands.server.app import app as legacy_app

    assert legacy_app is canonical_app
