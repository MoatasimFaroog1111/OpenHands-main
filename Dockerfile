# Railway builds the complete OpenHands application from this root Dockerfile.
#
# Railway services cannot run Docker-in-Docker or mount the host Docker socket,
# so this image defaults to the process sandbox. Set RUNTIME=remote and provide
# SANDBOX_REMOTE_RUNTIME_API_URL plus SANDBOX_API_KEY to use an isolated remote
# sandbox provider instead.
ARG OPENHANDS_BUILD_VERSION=dev
FROM node:25.9-trixie-slim AS frontend-builder

WORKDIR /app

COPY frontend/package.json frontend/package-lock.json frontend/.npmrc ./
RUN npm ci

COPY frontend ./
RUN npm run build

FROM python:3.13.7-slim-trixie AS base
FROM base AS backend-builder

WORKDIR /app
ENV PYTHONPATH='/app'

ENV POETRY_NO_INTERACTION=1 \
    POETRY_VIRTUALENVS_IN_PROJECT=1 \
    POETRY_VIRTUALENVS_CREATE=1 \
    POETRY_CACHE_DIR=/tmp/poetry_cache

ARG POETRY_VERSION=2.3.4
RUN apt-get update -y \
    && apt-get install -y curl make git build-essential jq gettext \
    && python3 -m pip install "poetry==${POETRY_VERSION}" --break-system-packages

COPY pyproject.toml poetry.lock ./
RUN touch README.md
RUN export POETRY_CACHE_DIR && poetry install --no-root && rm -rf $POETRY_CACHE_DIR

FROM base AS openhands-app

WORKDIR /app
ARG OPENHANDS_BUILD_VERSION

ENV RUN_AS_OPENHANDS=true
ENV OPENHANDS_USER_ID=42420
ENV RUNTIME=process
ENV OH_PERSISTENCE_DIR=/data/.openhands
ENV FILE_STORE=local
ENV FILE_STORE_PATH=/data/.openhands
ENV TMPDIR=/data/tmp
ENV WORKSPACE_BASE=/opt/workspace_base
ENV OPENHANDS_BUILD_VERSION=$OPENHANDS_BUILD_VERSION
ENV SANDBOX_USER_ID=0
ENV INIT_GIT_IN_EMPTY_WORKSPACE=1

RUN mkdir -p \
    "$OH_PERSISTENCE_DIR" \
    "$TMPDIR" \
    "$WORKSPACE_BASE"

RUN apt-get update -y \
    && apt-get install -y \
        build-essential \
        curl \
        git \
        jq \
        nodejs \
        npm \
        openssh-client \
        sudo \
    && rm -rf /var/lib/apt/lists/*

RUN sed -i 's/^UID_MIN.*/UID_MIN 499/' /etc/login.defs
RUN sed -i 's/^UID_MAX.*/UID_MAX 1000000/' /etc/login.defs

RUN groupadd --gid $OPENHANDS_USER_ID openhands
RUN useradd -l -m -u $OPENHANDS_USER_ID --gid $OPENHANDS_USER_ID -s /bin/bash openhands && \
    usermod -aG openhands openhands && \
    usermod -aG sudo openhands && \
    echo '%sudo ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers
RUN chown -R openhands:openhands /app /data && chmod -R 770 /app /data
RUN chown -R openhands:openhands "$WORKSPACE_BASE" && chmod -R 770 "$WORKSPACE_BASE"
USER openhands

ENV VIRTUAL_ENV=/app/.venv \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH='/app'

COPY --chown=openhands:openhands --chmod=770 --from=backend-builder ${VIRTUAL_ENV} ${VIRTUAL_ENV}

ARG PIP_VERSION=26.0.1
RUN python -m pip install --no-cache-dir "pip==${PIP_VERSION}"

USER root
RUN /usr/local/bin/python3 -m pip install --no-cache-dir "pip==${PIP_VERSION}" --break-system-packages
USER openhands

COPY --chown=openhands:openhands --chmod=770 ./skills ./skills
COPY --chown=openhands:openhands --chmod=770 ./openhands ./openhands
COPY --chown=openhands:openhands pyproject.toml poetry.lock README.md MANIFEST.in LICENSE ./
RUN find /app \! -group openhands -exec chgrp openhands {} +

COPY --chown=openhands:openhands --chmod=770 --from=frontend-builder /app/build ./frontend/build
COPY --chown=openhands:openhands --chmod=770 ./containers/app/entrypoint.sh /app/entrypoint.sh

USER root
WORKDIR /app

EXPOSE 3000
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["sh", "-c", "exec uvicorn openhands.server.listen:app --host 0.0.0.0 --port ${PORT:-3000}"]
