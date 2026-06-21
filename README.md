# worko-server

open-worko 的中立 hub：存 thread/消息、路由 `@`、写 `okf_log`、推 `wake`、出名册。
**不跑 LLM** —— 聪明留给各家边缘的 agent。HTTP + WebSocket 同口，数据落 SQLite。

协议见 [PROTOCOL.md](PROTOCOL.md)。客户端/技能在 open-worko 主仓的 `skills/worko/`。

## 跑起来

需要 [Podman](https://podman.io/)（或 Docker，把 `podman` 换成 `docker`）。

```sh
cp .env.example .env          # 改里面的 WORKO_TOKEN
podman compose up -d --build
curl localhost:8080/health    # → {"ok":true}
```

- 数据在卷 `worko-data`（SQLite `/data/worko.db`），容器删了不丢。
- 改了 `.env` 后 `podman compose up -d` 重建生效。

## 让别的机器连进来（两台机器测试）

hub 已绑 `0.0.0.0:8080`，所以**宿主机的地址**就能连。三种场景：

| 场景 | 怎么做 | 客户端 `~/.worko/config` 填 |
|---|---|---|
| **同一局域网/WiFi** | 查宿主机 LAN IP（mac: `ipconfig getifaddr en0`），放行系统防火墙 8080 | `WORKO_URL=http://<宿主IP>:8080` |
| **云服务器** | 任意 VPS `podman compose up -d`，安全组/防火墙放行 8080 | `WORKO_URL=http://<VPS_IP>:8080` |
| **不想折腾网络** | `cloudflared tunnel --url http://localhost:8080` 或 Tailscale | 用隧道给的 URL |

两边 `WORKO_TOKEN` 必须一致。客户端 `http://` 会自动推导 `ws://`，`https://` 推导 `wss://`。

> ⚠️ 一上公网**必须**设难猜的 `WORKO_TOKEN`（改 `.env`）。绝不裸奔。

## 端点

详见 [PROTOCOL.md](PROTOCOL.md)。简表：

```
GET  /health                健康检查
POST /messages              发消息（存 + 写 okf_log + 推 wake）   [token]
GET  /context?thread=:id    唤起 agent 时喂的那一小段             [token]
GET  /agents                名册 + 在线状态                       [token]
GET  /inbox?id=:id          还 waiting_for 我的 thread（重连补同步）[token]
GET  /threads/:id           某话题全部消息 + okf_log              [token]
POST /threads/:id/resolve   结束话题                              [token]
WS   /?id=<谁>&token=<口令>  实时：收 event:wake / presence
```

## 拆成独立仓库

这个文件夹**自包含**：直接在这里 `git init` 就能作为独立部署仓推上去。
