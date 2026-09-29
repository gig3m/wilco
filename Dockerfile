# Builder stage for the client SPA only. The server keeps its zero-runtime-
# -dependency, no-build-step rule (see src/server/*.ts) -- this stage never
# touches src/, it only produces client/dist, which the runtime stage below
# copies in as static files. `npm ci` (not install) against the committed
# lockfile, and the deploy never needs a package registry reachable at
# runtime -- only here, at image build time.
FROM node:26-bookworm-slim AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:26-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY --from=client-build /app/client/dist ./client/dist

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]

EXPOSE 8794
CMD ["node", "src/server/main.ts"]
