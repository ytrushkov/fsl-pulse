# Production image for the Pulse API server.
# Build context is the REPO ROOT (pnpm workspace):
#   docker build -f artifacts/api-server/Dockerfile -t pulse-api .
# syntax=docker/dockerfile:1

# ---- builder: install workspace, bundle, and produce a prod deployment ----
FROM node:24-slim AS builder
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# esbuild bundle -> artifacts/api-server/dist (externals like @aws-sdk, pdfkit
# stay in node_modules). Then pnpm deploy flattens a self-contained prod tree
# (real node_modules, no workspace symlinks) into /app.
RUN pnpm --filter @workspace/api-server run build \
 && pnpm --filter @workspace/api-server --prod deploy /app

# ---- runtime: just node + the deployed app ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
COPY --from=builder /app ./
EXPOSE 8080
# Health: GET /api/healthz
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
