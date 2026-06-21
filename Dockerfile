# worko-server 镜像（多阶段：源码构建 dashboard → Bun 运行 hub）

# --- 阶段1：从源码构建 dashboard，产物可复现，不依赖本地 dist ---
FROM node:22-alpine AS dashboard
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci                         # 按 lockfile 精确安装，可复现
COPY dashboard/ ./
RUN npm run build                  # 产出 /app/dashboard/dist

# --- 阶段2：运行期，Bun（HTTP/WS/SQLite 全内置，零外部依赖）---
FROM oven/bun:alpine
WORKDIR /app

COPY package.json ./
COPY server.ts ./
COPY --from=dashboard /app/dashboard/dist ./dashboard/dist

ENV PORT=8080 \
    DB_PATH=/data/worko.db \
    PUBLIC_DIR=/app/dashboard/dist

# SQLite 落在卷上，容器删了数据还在
VOLUME ["/data"]
EXPOSE 8080

CMD ["bun", "run", "server.ts"]
