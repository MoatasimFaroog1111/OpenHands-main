from unittest.mock import patch

import pytest

from openhands.app_server.utils.docker_utils import (
    replace_localhost_hostname_for_docker,
)


@pytest.mark.parametrize(
    ('url', 'expected'),
    [
        ('http://localhost:8080', 'http://host.docker.internal:8080'),
        ('https://localhost', 'https://host.docker.internal'),
        (
            'http://user:pass@localhost:3000/api?q=localhost#fragment',
            'http://user:pass@host.docker.internal:3000/api?q=localhost#fragment',
        ),
    ],
)
@patch(
    'openhands.app_server.utils.docker_utils.is_running_in_docker',
    return_value=True,
)
def test_replaces_exact_localhost_in_docker(mock_is_docker, url, expected):
    assert replace_localhost_hostname_for_docker(url) == expected


@pytest.mark.parametrize('runtime', ['local', 'process'])
@patch(
    'openhands.app_server.utils.docker_utils.is_running_in_docker',
    return_value=True,
)
def test_runtime_mode_does_not_bypass_docker_routing(
    mock_is_docker, monkeypatch, runtime
):
    monkeypatch.setenv('RUNTIME', runtime)

    result = replace_localhost_hostname_for_docker('http://localhost:8080')

    assert result == 'http://host.docker.internal:8080'


@patch(
    'openhands.app_server.utils.docker_utils.is_running_in_docker',
    return_value=False,
)
def test_keeps_localhost_outside_docker(mock_is_docker):
    assert (
        replace_localhost_hostname_for_docker('http://localhost:8080')
        == 'http://localhost:8080'
    )


@pytest.mark.parametrize(
    'url',
    [
        'http://127.0.0.1:8080',
        'http://api.localhost:8080',
        'http://localhost.example.com:8080',
        'http://example.com:8080',
        'localhost:8080',
        '',
    ],
)
@patch(
    'openhands.app_server.utils.docker_utils.is_running_in_docker',
    return_value=True,
)
def test_keeps_non_exact_localhost_values(mock_is_docker, url):
    assert replace_localhost_hostname_for_docker(url) == url


@patch(
    'openhands.app_server.utils.docker_utils.is_running_in_docker',
    return_value=True,
)
def test_supports_custom_replacement(mock_is_docker):
    assert (
        replace_localhost_hostname_for_docker(
            'http://localhost:11434/api/tags', 'ollama.internal'
        )
        == 'http://ollama.internal:11434/api/tags'
    )
