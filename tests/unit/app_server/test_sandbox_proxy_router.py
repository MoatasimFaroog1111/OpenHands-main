"""Tests for the same origin sandbox reverse proxy.

Process sandboxes listen on loopback ports that a browser cannot reach when
OpenHands is deployed behind a single published port (Railway, Render, Fly,
Heroku, ...). These tests cover the proxy that republishes those ports under
the app server's own origin at ``/runtime/{port}``.
"""

import asyncio
import socket
import threading
import time

import pytest
import uvicorn
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.testclient import TestClient

from openhands.app_server.sandbox import sandbox_proxy_router
from openhands.app_server.sandbox.sandbox_proxy_router import (
    get_allowed_port_range,
    is_proxy_enabled,
    router,
)


def _free_port_in_range() -> int:
    """Pick a free port that the proxy is allowed to forward to."""
    min_port, max_port = get_allowed_port_range()
    for port in range(min_port, min(min_port + 500, max_port)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(('127.0.0.1', port))
            except OSError:
                continue
            return port
    raise RuntimeError('No free port available in the sandbox range')


@pytest.fixture
def upstream_server():
    """Run a tiny stand-in agent-server on a loopback port."""
    upstream = FastAPI()

    @upstream.get('/api/echo')
    async def echo(request: Request):
        return JSONResponse(
            {
                'query': request.url.query,
                'session_key': request.headers.get('x-session-api-key'),
            }
        )

    @upstream.post('/api/body')
    async def body(request: Request):
        return PlainTextResponse((await request.body()).decode())

    @upstream.get('/api/teapot')
    async def teapot():
        return PlainTextResponse('nope', status_code=418)

    @upstream.websocket('/sockets/events/{conversation_id}')
    async def events(websocket: WebSocket, conversation_id: str):
        await websocket.accept()
        await websocket.send_text(f'hello {conversation_id} {websocket.url.query}')
        while True:
            try:
                message = await websocket.receive_text()
            except Exception:
                return
            await websocket.send_text(f'echo:{message}')

    port = _free_port_in_range()
    config = uvicorn.Config(
        upstream, host='127.0.0.1', port=port, log_level='error', lifespan='off'
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    deadline = time.monotonic() + 20
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.05)
    if not server.started:  # pragma: no cover - startup failure
        raise RuntimeError('Upstream test server did not start')

    try:
        yield port
    finally:
        server.should_exit = True
        thread.join(timeout=10)


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as test_client:
        yield test_client


class TestProxyEnabled:
    def test_disabled_by_default_for_docker_runtime(self, monkeypatch):
        """Docker sandboxes publish reachable ports, so no proxy is needed."""
        monkeypatch.delenv('SANDBOX_PROXY_ENABLED', raising=False)
        monkeypatch.delenv('RUNTIME', raising=False)
        assert is_proxy_enabled() is False

    @pytest.mark.parametrize('runtime', ['local', 'process', 'PROCESS'])
    def test_enabled_by_default_for_process_runtime(self, monkeypatch, runtime):
        """Process sandboxes are loopback only and always need the proxy."""
        monkeypatch.delenv('SANDBOX_PROXY_ENABLED', raising=False)
        monkeypatch.setenv('RUNTIME', runtime)
        assert is_proxy_enabled() is True

    @pytest.mark.parametrize(
        'value,expected',
        [('1', True), ('true', True), ('on', True), ('0', False), ('false', False)],
    )
    def test_env_override_wins(self, monkeypatch, value, expected):
        monkeypatch.setenv('RUNTIME', 'docker')
        monkeypatch.setenv('SANDBOX_PROXY_ENABLED', value)
        assert is_proxy_enabled() is expected

    def test_port_range_follows_sandbox_base_port(self, monkeypatch):
        monkeypatch.setenv('OH_SANDBOX_BASE_PORT', '9000')
        assert get_allowed_port_range() == (9000, 19000)


class TestHttpProxy:
    def test_forwards_query_and_session_key(self, client, upstream_server):
        response = client.get(
            f'/runtime/{upstream_server}/api/echo?a=1&b=2',
            headers={'X-Session-API-Key': 'secret-key'},
        )
        assert response.status_code == 200
        assert response.json() == {'query': 'a=1&b=2', 'session_key': 'secret-key'}

    def test_forwards_request_body(self, client, upstream_server):
        response = client.post(
            f'/runtime/{upstream_server}/api/body', content=b'payload'
        )
        assert response.status_code == 200
        assert response.text == 'payload'

    def test_preserves_upstream_status_code(self, client, upstream_server):
        response = client.get(f'/runtime/{upstream_server}/api/teapot')
        assert response.status_code == 418
        assert response.text == 'nope'

    def test_rejects_ports_outside_the_sandbox_range(self, client):
        min_port, _ = get_allowed_port_range()
        response = client.get(f'/runtime/{min_port - 1}/api/echo')
        assert response.status_code == 403

    def test_bad_gateway_when_sandbox_is_gone(self, client):
        response = client.get(f'/runtime/{_free_port_in_range()}/api/echo')
        assert response.status_code == 502


class TestWebSocketProxy:
    def test_bridges_messages_both_ways(self, client, upstream_server):
        """The event socket is what the UI needs; a break shows 'Disconnected'."""
        url = f'/runtime/{upstream_server}/sockets/events/conv-1?session_api_key=k'
        with client.websocket_connect(url) as websocket:
            assert websocket.receive_text() == 'hello conv-1 session_api_key=k'
            websocket.send_text('ping')
            assert websocket.receive_text() == 'echo:ping'

    def test_rejects_ports_outside_the_sandbox_range(self, client):
        from starlette.websockets import WebSocketDisconnect

        min_port, _ = get_allowed_port_range()
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                f'/runtime/{min_port - 1}/sockets/events/conv-1'
            ) as websocket:
                websocket.receive_text()


def test_upstream_url_never_leaves_loopback():
    """The proxy must not become a generic SSRF gateway."""
    url = sandbox_proxy_router._upstream_url(8123, 'api/echo', 'a=1')
    assert url == 'http://127.0.0.1:8123/api/echo?a=1'


@pytest.mark.asyncio
async def test_event_loop_is_available():
    """Guard against pytest-asyncio misconfiguration in this module."""
    assert asyncio.get_running_loop() is not None
