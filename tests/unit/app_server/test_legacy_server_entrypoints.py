"""Regression tests for deprecated server entrypoint compatibility shims."""


def test_legacy_listen_reexports_canonical_app():
    from openhands.app_server.app import app as canonical_app
    from openhands.server.listen import app as legacy_app

    assert legacy_app is canonical_app


def test_legacy_server_app_reexports_canonical_app():
    from openhands.app_server.app import app as canonical_app
    from openhands.server.app import app as legacy_app

    assert legacy_app is canonical_app
