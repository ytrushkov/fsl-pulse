# Production image for the Pulse web SPA (nginx static + /api proxy).
# Build context is the REPO ROOT (pnpm workspace):
#   docker build -f artifacts/pulse/Dockerfile -t pulse-web .
# syntax=docker/dockerfile:1

# ---- builder: vite build -> static assets ----
FROM node:24-slim AS builder
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# vite.config.ts requires PORT + BASE_PATH even for a production build.
# BASE_PATH=/ for a root deployment; PORT is unused by `build` but must be set.
RUN PORT=4173 BASE_PATH=/ pnpm --filter @workspace/pulse run build

# ---- runtime: nginx serving the SPA + proxying /api ----
FROM nginx:1.27-alpine AS runtime
COPY artifacts/pulse/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/artifacts/pulse/dist/public /usr/share/nginx/html
EXPOSE 80
