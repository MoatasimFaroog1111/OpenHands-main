"""Factories for application-service and user-facing injectors."""

from pathlib import Path

from openhands.app_server.app_conversation.app_conversation_info_service import (
    AppConversationInfoServiceInjector,
)
from openhands.app_server.app_conversation.app_conversation_service import (
    AppConversationServiceInjector,
)
from openhands.app_server.app_conversation.app_conversation_start_task_service import (
    AppConversationStartTaskServiceInjector,
)
from openhands.app_server.pending_messages.pending_message_service import (
    PendingMessageServiceInjector,
)
from openhands.app_server.services.jwt_service import JwtServiceInjector
from openhands.app_server.user.user_context import UserContextInjector


def create_default_app_conversation_info_injector() -> AppConversationInfoServiceInjector:
    """Build the SQL-backed conversation-info injector."""
    from openhands.app_server.app_conversation.sql_app_conversation_info_service import (  # noqa: E501
        SQLAppConversationInfoServiceInjector,
    )

    return SQLAppConversationInfoServiceInjector()


def create_default_app_conversation_start_task_injector() -> (
    AppConversationStartTaskServiceInjector
):
    """Build the SQL-backed conversation start-task injector."""
    from openhands.app_server.app_conversation.sql_app_conversation_start_task_service import (  # noqa: E501
        SQLAppConversationStartTaskServiceInjector,
    )

    return SQLAppConversationStartTaskServiceInjector()


def create_default_app_conversation_injector() -> AppConversationServiceInjector:
    """Build the live-status conversation service injector."""
    from openhands.app_server.app_conversation.live_status_app_conversation_service import (  # noqa: E501
        LiveStatusAppConversationServiceInjector,
    )

    return LiveStatusAppConversationServiceInjector()


def create_default_pending_message_injector() -> PendingMessageServiceInjector:
    """Build the SQL-backed pending-message injector."""
    from openhands.app_server.pending_messages.pending_message_service import (
        SQLPendingMessageServiceInjector,
    )

    return SQLPendingMessageServiceInjector()


def create_default_user_context_injector() -> UserContextInjector:
    """Build the authenticated user-context injector."""
    from openhands.app_server.user.auth_user_context import AuthUserContextInjector

    return AuthUserContextInjector()


def create_default_jwt_service_injector(persistence_dir: Path) -> JwtServiceInjector:
    """Build the JWT service injector using the configured persistence path."""
    return JwtServiceInjector(persistence_dir=persistence_dir)
