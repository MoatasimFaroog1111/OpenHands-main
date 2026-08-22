"""Factories for sandbox infrastructure injectors."""

import os

from openhands.app_server.sandbox.sandbox_service import SandboxServiceInjector
from openhands.app_server.sandbox.sandbox_spec_service import SandboxSpecServiceInjector


def create_default_sandbox_service_injector() -> SandboxServiceInjector:
    """Build the sandbox injector selected by the legacy RUNTIME setting."""
    from openhands.app_server.sandbox.docker_sandbox_service import (
        DockerSandboxServiceInjector,
        VolumeMount,
    )
    from openhands.app_server.sandbox.process_sandbox_service import (
        ProcessSandboxServiceInjector,
    )
    from openhands.app_server.sandbox.remote_sandbox_service import (
        RemoteSandboxServiceInjector,
    )

    runtime = os.getenv('RUNTIME')
    if runtime == 'remote':
        return RemoteSandboxServiceInjector(
            api_key=os.environ['SANDBOX_API_KEY'],
            api_url=os.environ['SANDBOX_REMOTE_RUNTIME_API_URL'],
        )

    if runtime in ('local', 'process'):
        return ProcessSandboxServiceInjector()

    docker_kwargs: dict = {}
    if os.getenv('SANDBOX_HOST_PORT'):
        docker_kwargs['host_port'] = int(os.environ['SANDBOX_HOST_PORT'])
    if os.getenv('SANDBOX_CONTAINER_URL_PATTERN'):
        docker_kwargs['container_url_pattern'] = os.environ[
            'SANDBOX_CONTAINER_URL_PATTERN'
        ]
    if os.getenv('SANDBOX_STARTUP_GRACE_SECONDS'):
        docker_kwargs['startup_grace_seconds'] = int(
            os.environ['SANDBOX_STARTUP_GRACE_SECONDS']
        )

    sandbox_volumes = os.getenv('SANDBOX_VOLUMES')
    if sandbox_volumes:
        mounts: list[VolumeMount] = []
        for mount_spec in sandbox_volumes.split(','):
            mount_spec = mount_spec.strip()
            if not mount_spec:
                continue
            parts = mount_spec.split(':')
            if len(parts) >= 2:
                mounts.append(
                    VolumeMount(
                        host_path=parts[0],
                        container_path=parts[1],
                        mode=parts[2] if len(parts) > 2 else 'rw',
                    )
                )
        if mounts:
            docker_kwargs['mounts'] = mounts

    return DockerSandboxServiceInjector(**docker_kwargs)


def create_default_sandbox_spec_service_injector() -> SandboxSpecServiceInjector:
    """Build the sandbox-spec injector matching the selected runtime."""
    from openhands.app_server.sandbox.docker_sandbox_spec_service import (
        DockerSandboxSpecServiceInjector,
    )
    from openhands.app_server.sandbox.process_sandbox_spec_service import (
        ProcessSandboxSpecServiceInjector,
    )
    from openhands.app_server.sandbox.remote_sandbox_spec_service import (
        RemoteSandboxSpecServiceInjector,
    )

    runtime = os.getenv('RUNTIME')
    if runtime == 'remote':
        return RemoteSandboxSpecServiceInjector()
    if runtime in ('local', 'process'):
        return ProcessSandboxSpecServiceInjector()
    return DockerSandboxSpecServiceInjector()
