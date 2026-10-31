# syntax=docker/dockerfile:1
FROM node:24-slim

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN node scripts/generate-golden.ts

ENV NO_COLOR=1
EXPOSE 3000
CMD ["node", "src/cli/index.ts", "demo", "--yes"]
