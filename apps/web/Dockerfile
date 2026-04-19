# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH"
RUN corepack enable && corepack prepare pnpm@9 --activate \
    && addgroup --gid 1001 appuser \
    && adduser --uid 1001 --ingroup appuser --disabled-password appuser
WORKDIR /app

FROM base AS development
# Copy root workspace manifests + lockfile, then the web app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile --filter "./apps/web..."
WORKDIR /app/apps/web
USER appuser
EXPOSE 3000
CMD ["pnpm", "run", "dev"]

FROM base AS production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile --prod --filter "./apps/web..."
COPY apps/web/ ./apps/web/
WORKDIR /app/apps/web
RUN pnpm run build
USER appuser
EXPOSE 3000
CMD ["pnpm", "run", "start"]
