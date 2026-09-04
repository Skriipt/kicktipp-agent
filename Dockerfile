FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    KICKTIPP_CONFIG_DIR=/config \
    KICKTIPP_DATA_DIR=/data

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

RUN chmod 755 /app/dist/index.js \
    && ln -s /app/dist/index.js /usr/local/bin/kicktipp \
    && install -d -o node -g node /config /data

USER node

HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD ["kicktipp", "service", "health"]

CMD ["kicktipp", "serve"]
