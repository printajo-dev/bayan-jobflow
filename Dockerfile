# syntax=docker/dockerfile:1
# One Dockerfile, two images:
#   --target api  -> NestJS API, worker and CLI tools (migrate, seed, create-admin)
#   --target web  -> Caddy serving the built React app and proxying /api
ARG NODE_IMAGE=node:26.13.1-bookworm-slim
ARG CADDY_IMAGE=caddy:2.11.9-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Prisma's schema engine needs OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .nvmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
RUN npm run build -w @jobflow/shared \
 && npm run build -w @jobflow/api \
 && npm run build -w @jobflow/web \
 && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS api
RUN apt-get update && apt-get install -y --no-install-recommends openssl tini && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json /app/apps/api/prisma.config.ts apps/api/
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/apps/api/dist apps/api/dist
WORKDIR /app/apps/api
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

FROM ${CADDY_IMAGE} AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv/www
