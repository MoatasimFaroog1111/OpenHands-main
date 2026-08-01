from urllib.parse import urlparse, urlunparse

from openhands.app_server.utils.environment import is_running_in_docker


def replace_localhost_hostname_for_docker(
    url: str, replacement: str = 'host.docker.internal'
) -> str:
    """Replace a localhost hostname when the caller runs inside Docker.

    Network topology is the only concern of this helper. Application runtime
    modes such as ``local`` or ``process`` do not change the fact that
    ``localhost`` inside a container addresses that container. Keeping runtime
    policy out of this utility prevents callers from silently bypassing the
    Docker host route.

    Only the exact ``localhost`` hostname is replaced. The scheme, credentials,
    port, path, query string, and fragment are preserved.

    Args:
        url: URL to normalize.
        replacement: Hostname used to reach the Docker host.

    Returns:
        The normalized URL when running in Docker, otherwise the original URL.
    """
    if not is_running_in_docker():
        return url

    parsed = urlparse(url)
    if parsed.hostname == 'localhost':
        netloc = parsed.netloc.replace('localhost', replacement, 1)
        return urlunparse(parsed._replace(netloc=netloc))
    return url
