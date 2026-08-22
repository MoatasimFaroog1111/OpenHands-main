# DEPRECATED: This module is deprecated and will be removed in a future release.
# Please use openhands.app_server.app instead.
#
# For backward compatibility, this module re-exports the fully configured app from
# openhands.app_server.app. New internal entrypoints must import that module directly.

from openhands.app_server.app import (
    app,
    authentication_error_handler,
    combine_lifespans,
    mcp_app,
)

__all__ = ['app', 'mcp_app', 'combine_lifespans', 'authentication_error_handler']
