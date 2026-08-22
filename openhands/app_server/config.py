"""Configuration facade for the OpenHands App Server."""

import os
from pathlib import Path
from typing import AsyncContextManager

import httpx
from fastapi import Depends, Request
from pydantic import Field

# Import the event_callback module to ensure all processors are registered
import openhands.app_server.event_callback  # noqa: F401
from openhands.agent_server.env_parser import from_env
from openhands.app_server.app_conversation.app_conversation_info_service import (
    AppConversationInfoService,
    AppConversationInfoServiceInjector,
)
from openhands.app_server.app_conversation.app_conversation_service import (
    AppConversationService,
    AppConversationServiceInjector,
)
from openhands.app_server.app_conversation.app_conversation_start_task_service import (
    AppConversationStartTaskService,
    AppConversationStartTaskServiceInjector,
)
from openhands.app_server.app_lifespan.app_lifespan_service import AppLifespanService
from openhands.app_server.app_lifespan.oss_app_lifespan_service import (
    OssAppLifespanService,
)
from openhands.app_server.composition.app_service_factories import (
    create_default_app_conversation_info_injector,
    create_default_app_conversation_injector,
    create_default_app_conversation_start_task_injector,
    create_default_jwt_service_injector,
    create_default_pending_message_injector,
    create_default_user_context_injector,
)
from openhands.app_server.composition.llm_event_factories import (
    create_default_event_callback_service_injector,
    create_default_event_service_injector,
    create_default_llm_model_service_injector,
)
from openhands.app_server.composition.sandbox_factories import (
    create_default_sandbox_service_injector,
    create_default_sandbox_spec_service_injector,
)
from openhands.app_server.config_api.config_models import AppMode
from openhands.app_server.config_api.llm_model_service import (
    LLMModelService,
    LLMModelServiceInjector,
)
from openhands.app_server.event.event_service import EventService, EventServiceInjector
from openhands.app_server.event_callback.event_callback_service import (
    EventCallbackService,
    EventCallbackServiceInjector,
)
from openhands.app_server.file_store.files import FileStore
from openhands.app_server.file_store.local import LocalFileStore
from openhands.app_server.pending_messages.pending_message_service import (
    PendingMessageService,
    PendingMessageServiceInjector,
)
from openhands.app_server.sandbox.sandbox_service import (
    SandboxService,
    SandboxServiceInjector,
)
from openhands.app_server.sandbox.sandbox_spec_service import (
    SandboxSpecService,
    SandboxSpecServiceInjector,
)
from openhands.app_server.services.db_session import (  # noqa: F401  (re-exported)
    depends_db_session,
    get_db_session,
)
from openhands.app_server.services.db_session_injector import DbSessionInjector
from openhands.app_server.services.httpx_client_injector import HttpxClientInjector
from openhands.app_server.services.injector import InjectorState
from openhands.app_server.services.jwt_service import JwtService, JwtServiceInjector
from openhands.app_server.user.user_context import UserContext, UserContextInjector
from openhands.app_server.web_client.default_web_client_config_injector import (
    DefaultWebClientConfigInjector,
)
from openhands.app_server.web_client.web_client_config_injector import (
    WebClientConfigInjector,
)
from openhands.sdk.utils.models import OpenHandsModel


def get_default_persistence_dir() -> Path:
    # Recheck env because this function is also used to generate other defaults
    persistence_dir = os.getenv('OH_PERSISTENCE_DIR')

    # Legacy V0 fallback variable
    if persistence_dir is None:
        persistence_dir = os.getenv('FILE_STORE_PATH')

    if persistence_dir:
        result = Path(persistence_dir)
    else:
        result = Path.home() / '.openhands'

    result.mkdir(parents=True, exist_ok=True)
    return result


def get_default_web_url() -> str | None:
    """Get legacy web host parameter.

    If present, we assume we are running under https.
    """
    web_host = os.getenv('WEB_HOST')
    if not web_host:
        return None
    return f'https://{web_host}'


def get_default_permitted_cors_origins() -> list[str]:
    """Get permitted CORS origins, falling back to legacy PERMITTED_CORS_ORIGINS env var.

    The preferred configuration is via OH_PERMITTED_CORS_ORIGINS_0, _1, etc.
    (handled by the pydantic from_env parser). This fallback supports the legacy
    comma-separated PERMITTED_CORS_ORIGINS environment variable.
    """
    legacy = os.getenv('PERMITTED_CORS_ORIGINS', '')
    if legacy:
        return [o.strip() for o in legacy.split(',') if o.strip()]
    return []


def get_openhands_provider_base_url() -> str | None:
    """Return the base URL for the OpenHands provider, if configured.

    Falls back to LLM_BASE_URL for backward compatibility.
    """
    return os.getenv('OPENHANDS_PROVIDER_BASE_URL') or os.getenv('LLM_BASE_URL') or None


def get_default_tavily_api_key() -> str | None:
    """Return the Tavily API key from environment, if configured.

    Falls back to SEARCH_API_KEY for backward compatibility.
    """
    return os.getenv('TAVILY_API_KEY') or os.getenv('SEARCH_API_KEY') or None


# OpenHands provider models use this proxy at the SDK transport boundary.
# Deployments (e.g. staging) may use a different LLM proxy, configured via
# OPENHANDS_PROVIDER_BASE_URL.
_SDK_DEFAULT_PROXY = 'https://llm-proxy.app.all-hands.dev/'


def resolve_provider_llm_base_url(
    model: str | None,
    base_url: str | None,
    provider_base_url: str | None = None,
) -> str | None:
    """Apply deployment-specific LLM proxy override when needed.

    When the model uses the public ``openhands/`` prefix and the stored
    ``base_url`` is the SDK default, replace it with the deployment's provider
    URL.

    Priority: user-explicit URL > deployment provider URL > SDK default.

    Args:
        model: LLM model name (e.g. ``openhands/gpt-5.5``).
        base_url: The base URL from user/org settings.
        provider_base_url: Deployment provider URL. Falls back to
            ``get_openhands_provider_base_url()`` when *None*.
    """
    if not model or not model.startswith('openhands/'):
        return base_url

    user_set_custom = base_url and base_url.rstrip('/') != _SDK_DEFAULT_PROXY.rstrip(
        '/'
    )
    if user_set_custom:
        return base_url

    if provider_base_url is None:
        provider_base_url = get_openhands_provider_base_url()
    if provider_base_url:
        return provider_base_url

    return base_url


def _get_default_lifespan():
    # Check legacy parameters for saas mode. If we are in SAAS mode use
    # SaasAppLifespanService to initialize PostHog analytics
    if 'saas' in (os.getenv('OPENHANDS_CONFIG_CLS') or '').lower():
        from server.app_lifespan.saas_app_lifespan_service import (
            SaasAppLifespanService,
        )

        return SaasAppLifespanService()
    return OssAppLifespanService()


def _get_default_file_store() -> FileStore:
    """Create a default LocalFileStore using the default persistence directory."""
    return LocalFileStore(root=str(get_default_persistence_dir()))


class AppServerConfig(OpenHandsModel):
    persistence_dir: Path = Field(default_factory=get_default_persistence_dir)
    file_store: FileStore = Field(default_factory=_get_default_file_store)
    web_url: str | None = Field(
        default_factory=get_default_web_url,
        description='The URL where OpenHands is running (e.g., http://localhost:3000)',
    )
    permitted_cors_origins: list[str] = Field(
        default_factory=get_default_permitted_cors_origins,
        description=(
            'Additional permitted CORS origins for both the app server and agent '
            'server containers. Configure via OH_PERMITTED_CORS_ORIGINS_0, _1, etc. '
            'Falls back to legacy PERMITTED_CORS_ORIGINS env var.'
        ),
    )
    openhands_provider_base_url: str | None = Field(
        default_factory=get_openhands_provider_base_url,
        description='Base URL for the OpenHands provider',
    )
    tavily_api_key: str | None = Field(
        default_factory=get_default_tavily_api_key,
        description='Tavily API key for search integration (proxied via MCP server)',
    )
    # Dependency Injection Injectors
    llm_model: LLMModelServiceInjector | None = None
    event: EventServiceInjector | None = None
    event_callback: EventCallbackServiceInjector | None = None
    sandbox: SandboxServiceInjector | None = None
    sandbox_spec: SandboxSpecServiceInjector | None = None
    app_conversation_info: AppConversationInfoServiceInjector | None = None
    app_conversation_start_task: AppConversationStartTaskServiceInjector | None = None
    app_conversation: AppConversationServiceInjector | None = None
    pending_message: PendingMessageServiceInjector | None = None
    user: UserContextInjector | None = None
    jwt: JwtServiceInjector | None = None
    httpx: HttpxClientInjector = Field(default_factory=HttpxClientInjector)
    db_session: DbSessionInjector = Field(
        default_factory=lambda: DbSessionInjector(
            persistence_dir=get_default_persistence_dir()
        )
    )
    # Services
    lifespan: AppLifespanService | None = Field(default_factory=_get_default_lifespan)
    app_mode: AppMode = AppMode.OPENHANDS
    web_client: WebClientConfigInjector = Field(
        default_factory=DefaultWebClientConfigInjector
    )


def config_from_env() -> AppServerConfig:
    """Load app-server settings, then compose any dependency defaults."""
    config: AppServerConfig = from_env(AppServerConfig, 'OH')  # type: ignore

    if config.llm_model is None:
        config.llm_model = create_default_llm_model_service_injector()
    if config.event is None:
        config.event = create_default_event_service_injector()
    if config.event_callback is None:
        config.event_callback = create_default_event_callback_service_injector()
    if config.sandbox is None:
        config.sandbox = create_default_sandbox_service_injector()
    if config.sandbox_spec is None:
        config.sandbox_spec = create_default_sandbox_spec_service_injector()
    if config.app_conversation_info is None:
        config.app_conversation_info = create_default_app_conversation_info_injector()
    if config.app_conversation_start_task is None:
        config.app_conversation_start_task = (
            create_default_app_conversation_start_task_injector()
        )
    if config.app_conversation is None:
        config.app_conversation = create_default_app_conversation_injector()
    if config.pending_message is None:
        config.pending_message = create_default_pending_message_injector()
    if config.user is None:
        config.user = create_default_user_context_injector()
    if config.jwt is None:
        config.jwt = create_default_jwt_service_injector(config.persistence_dir)

    return config


_global_config: AppServerConfig | None = None


def get_global_config() -> AppServerConfig:
    """Get the default local server config shared across the server."""
    global _global_config
    if _global_config is None:
        # Load configuration from environment...
        _global_config = config_from_env()

    return _global_config  # type: ignore


def get_event_service(
    state: InjectorState, request: Request | None = None
) -> AsyncContextManager[EventService]:
    injector = get_global_config().event
    assert injector is not None
    return injector.context(state, request)


def get_event_callback_service(
    state: InjectorState, request: Request | None = None
) -> AsyncContextManager[EventCallbackService]:
    injector = get_global_config().event_callback
    assert injector is not None
    return injector.context(state, request)


def get_sandbox_service(
    state: InjectorState, request: Request | None = None
) -> AsyncContextManager[SandboxService]:
    injector = get_global_config().sandbox
    assert injector is not None
    return injector.context(state, request)


def get_sandbox_spec_service(
    state: InjectorState, request: Request | None = None
) -> AsyncContextManager[SandboxSpecService]:
    injector = get_global_config().sandbox_spec
    assert injector is not None
    return injector.context(state, request)


def get_app_conversation_info_service(
    state: InjectorState, request: Request | None = None
) -> AsyncContextManager[AppConversationInfoService]:
    injector = get_global_config().app_conversation_info
    assert injector is not None
    return injector.context(state, request)


def get_app_conversation_start_task_service(
    state: InjectorState, request: Request | None = None
) -> AsyncContextManager[AppConversationStartTaskService]:
    injector = get_global_config().app_conversation_start_task
    assert injector is not None
    return injector.context(state, request)


def get_app_conversation_service(
    state: InjectorState, request: Request | None = None
) -> AsyncContextManager[AppConversationService]:
    injector = get_global_config().app_conversation
    assert injector is not None
    return injector.context(state, request)


def get_pending_message_service(
    state: InjectorState, request: Request | None = None
) -> AsyncContextManager[PendingMessageService]:
    injector = get_global_config().pending_message
    assert injector is not None
    return injector.context(state, request)


def get_user_context(
    state: InjectorState, request: Request | None = None
) -> AsyncContextManager[UserContext]:
    injector = get_global_config().user
    assert injector is not None
    return injector.context(state, request)


def get_httpx_client(
    state: InjectorState, request: Request | None = None
) -> AsyncContextManager[httpx.AsyncClient]:
    return get_global_config().httpx.context(state, request)


def get_jwt_service(
    state: InjectorState, request: Request | None = None
) -> AsyncContextManager[JwtService]:
    injector = get_global_config().jwt
    assert injector is not None
    return injector.context(state, request)


def get_app_lifespan_service() -> AppLifespanService | None:
    config = get_global_config()
    return config.lifespan


def depends_event_service():
    injector = get_global_config().event
    assert injector is not None
    return Depends(injector.depends)


def depends_event_callback_service():
    injector = get_global_config().event_callback
    assert injector is not None
    return Depends(injector.depends)


def depends_sandbox_service():
    injector = get_global_config().sandbox
    assert injector is not None
    return Depends(injector.depends)


def depends_sandbox_spec_service():
    injector = get_global_config().sandbox_spec
    assert injector is not None
    return Depends(injector.depends)


def depends_app_conversation_info_service():
    injector = get_global_config().app_conversation_info
    assert injector is not None
    return Depends(injector.depends)


def depends_app_conversation_start_task_service():
    injector = get_global_config().app_conversation_start_task
    assert injector is not None
    return Depends(injector.depends)


def depends_app_conversation_service():
    injector = get_global_config().app_conversation
    assert injector is not None
    return Depends(injector.depends)


def depends_pending_message_service():
    injector = get_global_config().pending_message
    assert injector is not None
    return Depends(injector.depends)


def depends_user_context():
    injector = get_global_config().user
    assert injector is not None
    return Depends(injector.depends)


def depends_httpx_client():
    return Depends(get_global_config().httpx.depends)


def depends_jwt_service():
    injector = get_global_config().jwt
    assert injector is not None
    return Depends(injector.depends)


def get_llm_model_service(
    state: InjectorState, request: Request | None = None
) -> AsyncContextManager[LLMModelService]:
    injector = get_global_config().llm_model
    assert injector is not None
    return injector.context(state, request)


def depends_llm_model_service():
    injector = get_global_config().llm_model
    assert injector is not None
    return Depends(injector.depends)
