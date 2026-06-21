# worko-server 镜像（Bun，尽量轻）
FROM oven/bun:alpine

WORKDIR /app

# 目前零外部依赖（HTTP/WS/SQLite 都是 Bun 内置）；保留这步给以后
COPY package.json ./
COPY server.ts ./

ENV PORT=8080 \
    DB_PATH=/data/worko.db

# SQLite 落在卷上，容器删了数据还在
VOLUME ["/data"]
EXPOSE 8080

CMD ["bun", "run", "server.ts"]
