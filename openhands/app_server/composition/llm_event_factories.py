"""Factories for LLM and event infrastructure injectors."""

import os

from pydantic import SecretStr

from openhands.app_server.config_api.llm_model_service import LLMModelServiceInjector
from openhands.app_server.event.event_service import EventServiceInjector
from openhands.app_server.event_callback.event_callback_service import (
    EventCallbackServiceInjector,
)
from openhands.app_server.utils.environment import StorageProvider, get_storage_provider


def create_default_llm_model_service_injector() -> LLMModelServiceInjector:
    """Build the default LLM model injector from legacy environment settings."""
    from openhands.app_server.config_api.default_llm_model_service import (
        DefaultLLMModelServiceInjector,
    )

    kwargs: dict = {}
    aws_region = os.getenv('AWS_REGION_NAME')
    aws_key = os.getenv('AWS_ACCESS_KEY_ID')
    aws_secret = os.getenv('AWS_SECRET_ACCESS_KEY')
    if aws_region and aws_key and aws_secret:
        kwargs['aws_region_name'] = aws_region
        kwargs['aws_access_key_id'] = SecretStr(aws_key)
        kwargs['aws_secret_access_key'] = SecretStr(aws_secret)

    ollama_url = os.getenv('OLLAMA_BASE_URL')
    if ollama_url:
        kwargs['ollama_base_url'] = ollama_url

    return DefaultLLMModelServiceInjector(**kwargs)


def create_default_event_service_injector() -> EventServiceInjector:
    """Build the event service injector selected by the storage provider."""
    from openhands.app_server.event.aws_event_service import AwsEventServiceInjector
    from openhands.app_server.event.filesystem_event_service import (
        FilesystemEventServiceInjector,
    )
    from openhands.app_server.event.google_cloud_event_service import (
        GoogleCloudEventServiceInjector,
    )

    provider = get_storage_provider()
    if provider == StorageProvider.AWS:
        bucket_name = os.environ.get('FILE_STORE_PATH')
        if not bucket_name:
            raise ValueError(
                'FILE_STORE_PATH environment variable is required for S3 storage'
            )
        return AwsEventServiceInjector(bucket_name=bucket_name)

    if provider == StorageProvider.GCP:
        bucket_name = os.environ.get('FILE_STORE_PATH')
        if not bucket_name:
            raise ValueError(
                'FILE_STORE_PATH environment variable is required for Google Cloud storage'
            )
        return GoogleCloudEventServiceInjector(bucket_name=bucket_name)

    return FilesystemEventServiceInjector()


def create_default_event_callback_service_injector() -> EventCallbackServiceInjector:
    """Build the default SQL-backed event callback injector."""
    from openhands.app_server.event_callback.sql_event_callback_service import (
        SQLEventCallbackServiceInjector,
    )

    return SQLEventCallbackServiceInjector()
