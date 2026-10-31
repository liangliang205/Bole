# syntax=docker/dockerfile:1
FROM node:24-slim

WORKDIR /app
RUN npm install -g pnpm@10.25.0

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# OCR 语言数据放到独立目录，避免被 /app/data 数据卷覆盖
ENV BOLE_OCR_DIR=/app/ocr
RUN pnpm ocr:download

ENV NO_COLOR=1
EXPOSE 8787
CMD ["node", "src/cli/index.ts", "web", "--host", "0.0.0.0", "--port", "8787"]
