# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY apps ./apps
COPY packages ./packages
RUN pnpm --filter @glasstrack/web build && pnpm --filter @glasstrack/server build

# Runtime: the server is a self-contained bundle, so no node_modules ship.
FROM node:22-alpine
RUN apk add --no-cache postgresql17-client tini
WORKDIR /app
# dist/ includes dist/site/public: the public website's scripts, font, screenshots and OG images.
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/web/dist ./web
RUN mkdir -p /data/files && chown -R node:node /data
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST_DIR=./web \
    STORAGE_LOCAL_DIR=/data/files
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
