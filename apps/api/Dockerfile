# syntax=docker/dockerfile:1.7
ARG PYTHON_VERSION=3.12

FROM python:${PYTHON_VERSION}-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/root/.local/bin:$PATH"
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir uv==0.4.15 \
    && groupadd --gid 1000 appuser \
    && useradd --uid 1000 --gid 1000 --no-create-home appuser
# Workspace root — matches repo layout so uv workspace resolution works
WORKDIR /workspace

FROM base AS development
# Copy workspace manifests and package sources
COPY pyproject.toml ./
COPY packages/ ./packages/
COPY apps/api/pyproject.toml ./apps/api/pyproject.toml
RUN uv pip install --system -e "./apps/api[dev]" --no-cache
WORKDIR /workspace/apps/api
USER appuser
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

FROM base AS production
COPY pyproject.toml ./
COPY packages/ ./packages/
COPY apps/api/pyproject.toml ./apps/api/pyproject.toml
RUN uv pip install --system -e "./apps/api" --no-cache
COPY apps/api/app/ ./apps/api/app/
WORKDIR /workspace/apps/api
USER appuser
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
