"""Regression tests for process-sandbox OS status mapping."""

from datetime import datetime
from unittest.mock import MagicMock, patch

import psutil

from openhands.app_server.sandbox.process_sandbox_service import (
    ProcessInfo,
    ProcessSandboxService,
)
from openhands.app_server.sandbox.sandbox_models import SandboxStatus


def test_idle_sleeping_agent_process_is_running(tmp_path) -> None:
    """An idle Uvicorn process sleeps while waiting for work but is still live."""
    service = ProcessSandboxService(
        user_id='test-user',
        sandbox_spec_service=MagicMock(),
        base_working_dir=str(tmp_path),
        base_port=9000,
        python_executable='python',
        agent_server_module='openhands.agent_server',
        health_check_path='/alive',
        httpx_client=MagicMock(),
    )
    process_info = ProcessInfo(
        pid=1234,
        port=9000,
        user_id='test-user',
        working_dir=str(tmp_path),
        session_api_key='test-key',
        created_at=datetime.now(),
        sandbox_spec_id='test-spec',
    )

    with patch(
        'openhands.app_server.sandbox.process_sandbox_service.psutil.Process'
    ) as process_class:
        process = MagicMock()
        process.is_running.return_value = True
        process.status.return_value = psutil.STATUS_SLEEPING
        process_class.return_value = process

        assert service._get_process_status(process_info) == SandboxStatus.RUNNING
