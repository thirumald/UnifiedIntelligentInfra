# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# Shared multi-stage build for every Node.js backend service in the monorepo.
#   docker build --build-arg APP=api -f infra/docker/node-service.Dockerfile .
# APP ∈ { api, worker, ingest-bridge, simulator }  →  package "@dt/${APP}"
# Each app compiles to dist/main.js.
# -----------------------------------------------------------------------------
ARG NODE_VERSION=22.11.0

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable
WORKDIR /repo

# --- 1. Fetch deps from the lockfile only (max layer-cache reuse) -------------
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile

# --- 2. Build the target app and its workspace dependencies ------------------
FROM fetch AS build
ARG APP
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/${APP} ./apps/${APP}
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@dt/${APP}..."
RUN pnpm --filter "@dt/${APP}..." run build
# Produce a self-contained, prod-only bundle (workspace deps resolved in place)
RUN pnpm --filter "@dt/${APP}" deploy --prod /out

# --- 3. Minimal runtime ------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
ARG APP
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps --max-old-space-size=384"
RUN apk add --no-cache tini \
 && mkdir -p /data/ifc && chown node:node /data/ifc   # named volume inherits this ownership
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
LABEL org.opencontainers.image.title="dt-platform/${APP}"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
