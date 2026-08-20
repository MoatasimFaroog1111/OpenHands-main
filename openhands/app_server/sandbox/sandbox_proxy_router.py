"""Same origin reverse proxy for process sandboxes.

Process sandboxes run each agent-server as a child process bound to a loopback
port (``http://127.0.0.1:{port}``). That address is perfect for server side
calls made by the app server itself, but it is useless to the browser:

* On a single port PaaS (Railway, Render, Fly, Heroku, ...) only the app
  server's own port is published, so ``https://my-app.example.com:8001`` simply
  does not resolve.
* Even locally, the loopback address of the container is not the loopback
  address of the user's machine.

The result is a web client that renders "Disconnected" forever, because the
event WebSocket points at a port nobody can reach.

This router fixes that by publishing every sandbox port under the app server's
own origin::

    /runtime/{port}/api/conversations/{id}   ->  http://127.0.0.1:{port}/api/conversations/{id}
    /runtime/{port}/sockets/events/{id}      ->  ws://127.0.0.1:{port}/sockets/events/{id}

The web client already understands this ``/runtime/{port}`` prefix (see
``frontend/src/utils/websocket-url.ts``), so exposing it is enough to make
same origin deployments work.

Authentication is unchanged: the agent-server still requires the
``X-Session-API-Key`` that the app server hands to the web client, and this
proxy forwards it verbatim rather than granting any extra access.
"""

import asyncio
import logging
import os
import weakref
from typing import Iterable

import httpx
from fastapi import APIRouter, HTTPException, Request, Response, WebSocket, status
from fastapi.responses import StreamingResponse
from starlette.websockets import WebSocketDisconnect

_logger = logging.getLogger(__name__)

router = APIRouter(tags=['Sandbox Proxy'])

PROXY_PATH_PREFIX = '/runtime'

# Only loopback is ever proxied - the proxy must never become a generic SSRF
# gateway into the private network of the host.
_UPSTREAM_HOST = '127.0.0.1'

# Hop by hop headers must not be forwarded (RFC 7230 section 6.1).
_HOP_BY_HOP_HEADERS = frozenset(
    {
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
    }
)

# Uvicorn / Starlette set these from the actual response body, so copying the
# upstream values corrupts the response.
_STRIPPED_RESPONSE_HEADERS = _HOP_BY_HOP_HEADERS | {
    'content-length',
    'content-encoding',
}

_DEFAULT_MIN_PORT = 8000
_DEFAULT_PORT_RANGE = 10000


def get_allowed_port_range() -> tuple[int, int]:
    """Return the inclusive range of ports this proxy is willing to forward to.

    Mirrors ``ProcessSandboxService._find_unused_port``, which allocates from
    ``base_port`` up to ``base_port + 10000``.
    """
    try:
        base_port = int(os.getenv('OH_SANDBOX_BASE_PORT', _DEFAULT_MIN_PORT))
    except ValueError:
        base_port = _DEFAULT_MIN_PORT
    return base_port, base_port + _DEFAULT_PORT_RANGE


def _env_flag(name: str) -> bool | None:
    """Read a boolean env var, returning None when it is unset."""
    value = os.getenv(name)
    if value is None:
        return None
    return value.strip().lower() in ('1', 'true', 'yes', 'on')


def is_proxy_advertised() -> bool:
    """Whether process sandboxes should hand ``/runtime/{port}`` to the browser.

    A process sandbox only ever listens on loopback, so the proxy path is the
    correct answer in every deployment: same origin works locally too. Set
    ``SANDBOX_PROXY_ENABLED=false`` to fall back to the raw port.
    """
    override = _env_flag('SANDBOX_PROXY_ENABLED')
    return True if override is None else override


def is_proxy_enabled() -> bool:
    """Whether the proxy routes should be mounted on the app.

    Mounted whenever the app is configured to use process sandboxes. This is
    read from the resolved sandbox injector rather than from ``RUNTIME``, so it
    stays correct however the process runtime was selected (environment
    variable, config file, or programmatic config).
    """
    override = _env_flag('SANDBOX_PROXY_ENABLED')
    if override is not None:
        return override

    # Imported lazily: config imports the sandbox services, which import this
    # module for PROXY_PATH_PREFIX.
    try:
        from openhands.app_server.config import get_global_config
        from openhands.app_server.sandbox.process_sandbox_service import (
            ProcessSandboxServiceInjector,
        )

        return isinstance(get_global_config().sandbox, ProcessSandboxServiceInjector)
    except Exception:
        _logger.warning(
            'Could not determine the sandbox type; leaving the sandbox proxy off',
            exc_info=True,
        )
        return False


def _check_port(port: int) -> None:
    min_port, max_port = get_allowed_port_range()
    if not min_port <= port <= max_port or port == _own_port():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f'Port {port} is outside the sandbox port range',
        )


def _own_port() -> int | None:
    """The port this app server listens on, which must never be proxied.

    On single port hosts ``PORT`` often lands inside the sandbox range, and
    forwarding to it would make the app proxy to itself.
    """
    try:
        return int(os.environ['PORT'])
    except (KeyError, ValueError):
        return None


def _filter_headers(
    headers: Iterable[tuple[str, str]], stripped: frozenset[str]
) -> list[tuple[str, str]]:
    return [(k, v) for k, v in headers if k.lower() not in stripped]


def _upstream_url(port: int, path: str, query: str) -> str:
    url = f'http://{_UPSTREAM_HOST}:{port}/{path.lstrip("/")}'
    return f'{url}?{query}' if query else url


_clients: 'weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, httpx.AsyncClient]' = (
    weakref.WeakKeyDictionary()
)


async def get_client() -> httpx.AsyncClient:
    """Return the pooled client used for proxied requests.

    A single pooled client keeps connections to the sandboxes warm; building
    one per request would open a fresh TCP connection for every poll the web
    client makes. The client is cached per event loop because an
    ``httpx.AsyncClient`` is bound to the loop that created it.
    """
    loop = asyncio.get_running_loop()
    client = _clients.get(loop)
    if client is None or client.is_closed:
        # No timeout: proxied calls include long polls and streaming responses
        # whose duration the agent-server owns.
        client = httpx.AsyncClient(timeout=None)
        _clients[loop] = client
    return client


async def close_client() -> None:
    """Dispose of the client for the running loop (shutdown and tests)."""
    client = _clients.pop(asyncio.get_running_loop(), None)
    if client is not None and not client.is_closed:
        await client.aclose()


@router.api_route(
    PROXY_PATH_PREFIX + '/{port:int}/{path:path}',
    methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
    include_in_schema=False,
)
async def proxy_http(port: int, path: str, request: Request) -> Response:
    """Forward an HTTP request to the agent-server listening on ``port``."""
    _check_port(port)

    client = await get_client()

    # ``Host`` is dropped so httpx recomputes it for the loopback target.
    headers = _filter_headers(
        request.headers.items(), _HOP_BY_HOP_HEADERS | {'host', 'content-length'}
    )
    body = await request.body()

    try:
        upstream_request = client.build_request(
            request.method,
            _upstream_url(port, path, request.url.query),
            headers=headers,
            content=body,
        )
        upstream_response = await client.send(upstream_request, stream=True)
    except httpx.ConnectError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f'Sandbox on port {port} is not reachable',
        )
    except httpx.HTTPError as e:
        _logger.warning(f'Error proxying request to sandbox port {port}: {e}')
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail='Error communicating with sandbox',
        )

    async def stream_body():
        try:
            async for chunk in upstream_response.aiter_raw():
                yield chunk
        finally:
            await upstream_response.aclose()

    return StreamingResponse(
        stream_body(),
        status_code=upstream_response.status_code,
        headers=dict(
            _filter_headers(
                upstream_response.headers.items(), _STRIPPED_RESPONSE_HEADERS
            )
        ),
    )


@router.websocket(PROXY_PATH_PREFIX + '/{port:int}/{path:path}')
async def proxy_websocket(websocket: WebSocket, port: int, path: str) -> None:
    """Bridge a browser WebSocket to the agent-server listening on ``port``."""
    try:
        _check_port(port)
    except HTTPException:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    # Imported lazily: `websockets` is a transitive runtime dependency, and a
    # broken install should not take down the whole app server on import.
    from websockets.asyncio.client import connect as ws_connect
    from websockets.exceptions import ConnectionClosed

    target = _upstream_url(port, path, websocket.url.query).replace(
        'http://', 'ws://', 1
    )

    # Browsers cannot set WebSocket headers, so the session key normally rides
    # in the query string, but forward it when a non browser client sends one.
    forward_headers = [
        (k, v)
        for k, v in websocket.headers.items()
        if k.lower() in ('x-session-api-key', 'authorization')
    ]

    try:
        upstream = await ws_connect(
            target,
            additional_headers=forward_headers or None,
            open_timeout=30,
            ping_interval=None,
            max_size=None,
        )
    except Exception as e:
        _logger.warning(f'Unable to open sandbox websocket on port {port}: {e}')
        await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        return

    await websocket.accept()

    async def client_to_upstream() -> None:
        try:
            while True:
                message = await websocket.receive()
                if message['type'] == 'websocket.disconnect':
                    return
                text = message.get('text')
                if text is not None:
                    await upstream.send(text)
                    continue
                data = message.get('bytes')
                if data is not None:
                    await upstream.send(data)
        except (WebSocketDisconnect, ConnectionClosed, RuntimeError):
            return

    async def upstream_to_client() -> None:
        try:
            async for message in upstream:
                if isinstance(message, str):
                    await websocket.send_text(message)
                else:
                    await websocket.send_bytes(message)
        except (WebSocketDisconnect, ConnectionClosed, RuntimeError):
            return

    pump_client = asyncio.create_task(client_to_upstream())
    pump_upstream = asyncio.create_task(upstream_to_client())
    try:
        await asyncio.wait(
            (pump_client, pump_upstream), return_when=asyncio.FIRST_COMPLETED
        )
    finally:
        for task in (pump_client, pump_upstream):
            task.cancel()
        await asyncio.gather(pump_client, pump_upstream, return_exceptions=True)
        await upstream.close()
        try:
            await websocket.close()
        except RuntimeError:
            pass
