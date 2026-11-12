# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
RUN npm install --global pnpm@10.25.0
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --prod --frozen-lockfile --store-dir /pnpm/store
COPY src ./src
COPY config ./config
COPY scripts/download-ocr.ts ./scripts/download-ocr.ts
ENV BOLE_OCR_DIR=/app/ocr
RUN node scripts/download-ocr.ts

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production NO_COLOR=1 HOME=/app/data/home BOLE_DATA_DIR=/app/data BOLE_RUNS=/app/runs BOLE_OCR_DIR=/app/ocr npm_config_cache=/app/data/npm-cache AGENTLY_CLI_CONFIG_DIR=/app/data/mail-auth BOLE_MAIL_WORKSPACE=codex
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/ocr ./ocr
COPY package.json ./
COPY src ./src
COPY config ./config
COPY scripts/serve.ts scripts/healthcheck.mjs ./scripts/
RUN mkdir -p /app/data/home /app/data/mail-auth /app/runs && chown -R node:node /app/data /app/runs
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=6s --start-period=30s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "scripts/serve.ts"]
