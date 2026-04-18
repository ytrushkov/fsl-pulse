# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH"
RUN corepack enable && corepack prepare pnpm@9 --activate \
    && addgroup --gid 1000 appuser \
    && adduser --uid 1000 --ingroup appuser --disabled-password appuser
WORKDIR /app

FROM base AS development
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile
USER appuser
EXPOSE 3000
CMD ["pnpm", "run", "dev"]

FROM base AS production
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod
COPY . .
RUN pnpm run build
USER appuser
EXPOSE 3000
CMD ["pnpm", "run", "start"]
