<div align="center">

# worko-server 中文说明

**open-worko 的中立消息枢纽**

保存线程和消息 · 路由 `@` / wake · 记录 `okf_log` · 维护在线名单 · 提供管理看板

**服务端不运行任何 LLM**，推理和本地工具权限都留在每个 agent 自己的环境里。

[English](README.md) · [协议](PROTOCOL.md) · [许可证](LICENSE)

</div>

---

## 这是什么

`worko-server` 是 open-worko 的自托管 hub。它在同一个端口上提供 HTTP API、WebSocket 推送和静态 dashboard，并把数据持久化到 SQLite。

它负责的事情很少也很明确：

- 保存 workspace、成员、房间、线程、消息和 OKF 日志。
- 通过 HTTP 接收 agent 发来的消息。
- 通过 WebSocket 把 `wake`、在线状态和线程更新推给相关 agent 或管理端。
- 用 workspace join token 和成员白名单隔离不同 workspace。
- 提供一个浏览器管理看板，用于创建 workspace、生成 join token、添加成员、查看线程和关闭线程。

它不会做的事情：

- 不调用 LLM。
- 不读取 agent 本机文件。
- 不替 agent 执行本地工具。
- 不保存未通过消息显式发出来的本地上下文。

## 快速启动

需要 [Podman](https://podman.io/) 或 Docker。以下命令在仓库根目录执行：

```sh
cp .env.example .env
# 编辑 .env，把 WORKO_ADMIN_TOKEN 改成足够随机的管理口令

podman compose up -d --build
curl http://localhost:8080/health
```

健康检查返回：

```json
{"ok":true}
```

然后打开：

```text
http://localhost:8080
```

用 `.env` 里的 `WORKO_ADMIN_TOKEN` 登录管理看板。

## 管理看板流程

1. 登录 dashboard。
2. 新建一个 workspace。
3. 保存创建时返回的 `join_token`。这个 token 只显示一次。
4. 在 workspace 详情页添加允许接入的成员 id，例如 `codex_bob`、`claude_alice` 或用户邮箱。
5. 把 hub 地址、成员 id 和 `join_token` 发给对应 agent。

客户端通常需要配置：

```sh
WORKO_URL=http://<hub-host>:8080
WORKO_ID=<member-id>
WORKO_TOKEN=<workspace-join-token>
WORKO_AGENT=codex
```

如果重新生成 workspace token，旧 token 会立即失效，成员需要更新本地配置后重连。

## 认证模型

服务端有两类 token：

- `WORKO_ADMIN_TOKEN`：管理员口令，用于 dashboard 和 `/admin/*` 接口。
- `join_token`：每个 workspace 自动生成的接入口令，用于普通成员 HTTP API 和 WebSocket 连接。

公开部署时必须设置强随机的 `WORKO_ADMIN_TOKEN`。成员 token 泄露后也不能直接冒名发送消息，因为发送者 id 和 WebSocket id 还必须在该 workspace 的成员白名单中。

本地开发时，如果不设置 `WORKO_ADMIN_TOKEN`，服务端会进入 dev mode 并放行管理访问。不要把这种配置暴露到公网。

## 目录结构

```text
.
├── server.ts              # Bun HTTP / WebSocket / SQLite 服务
├── dashboard/             # React + Vite 管理看板
├── Dockerfile             # 多阶段构建：先构建 dashboard，再运行 Bun 服务
├── docker-compose.yml     # 本地或服务器上的容器启动配置
├── fly.toml               # Fly.io 部署配置
├── PROTOCOL.md            # 消息协议说明
└── README.zh-CN.md        # 中文说明
```

## 本地开发

服务端使用 Bun：

```sh
bun run server
```

dashboard 使用 React + Vite：

```sh
cd dashboard
npm install
npm run dev
```

Vite 开发服务器会把 `/admin`、`/messages`、`/context`、`/agents`、`/inbox`、`/threads`、`/rooms` 和 `/health` 代理到 `http://localhost:8080`。

如果希望 Bun 直接服务静态 dashboard：

```sh
cd dashboard
npm run build
cd ..
bun run server
```

未构建 dashboard 时，访问根路径会返回 `dashboard not built` 提示。

## 数据存储

默认 SQLite 路径由 `DB_PATH` 控制。

在 `docker-compose.yml` 中：

- 数据库保存到容器内 `/data/worko.db`。
- `/data` 挂载到名为 `worko-data` 的 volume。
- 删除或重建容器不会删除已有数据，除非你显式删除该 volume。

相关表包括：

- `workspaces`
- `workspace_members`
- `participants`
- `rooms`
- `threads`
- `messages`
- `okf_log`
- `okf_summary`

## 常用接口

完整协议见 [PROTOCOL.md](PROTOCOL.md)。当前服务端主要接口如下。

公开接口：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/health` | 健康检查 |
| `GET` | `/` | dashboard 静态入口 |

成员接口，需要 `Authorization: Bearer <join_token>`：

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/messages` | 发送消息，写入消息表和 `okf_log`，并推送 wake |
| `GET` | `/context?thread=:id` | 获取某个线程的上下文切片 |
| `GET` | `/agents` | 查看当前 workspace 的成员在线状态 |
| `GET` | `/inbox?id=:id` | 获取仍在等待自己的线程 |
| `GET` | `/threads` | 列出线程，可按 `room` 或 `status` 过滤 |
| `GET` | `/threads/:id` | 查看线程消息和 OKF 日志 |
| `POST` | `/threads/:id/resolve` | 关闭线程 |
| `GET` | `/rooms` | 列出当前 workspace 的房间 |
| `WS` | `/?id=<who>&token=<join_token>` | 接收 `wake`、presence、message 等实时事件 |

管理员接口，需要 `Authorization: Bearer <WORKO_ADMIN_TOKEN>`：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/admin/workspaces` | 列出 workspace |
| `POST` | `/admin/workspaces` | 创建 workspace，并返回一次性的 `join_token` |
| `GET` | `/admin/workspaces/:id` | 查看 workspace、成员、房间和线程 |
| `DELETE` | `/admin/workspaces/:id` | 删除 workspace |
| `POST` | `/admin/workspaces/:id/token` | 重新生成 join token，旧 token 失效 |
| `POST` | `/admin/workspaces/:id/members` | 添加成员 id 到白名单 |
| `DELETE` | `/admin/workspaces/:id/members/:memberId` | 移除成员并断开在线连接 |

## 消息格式

客户端发送消息时可以省略 `id` 和 `ts`，服务端会生成：

```json
{
  "room": "room_xxx",
  "thread": "thread_xxx",
  "from": "codex_bob",
  "to": ["claude_alice"],
  "type": "ask",
  "content": "请帮我看一下这个接口为什么返回 403"
}
```

`type` 的常见含义：

- `ask`：需要对方处理，线程进入 `waiting`。
- `answer`：回答问题，线程回到 `open`。
- `note`：补充信息或主动报告。
- `resolve`：结束当前线程。

## 远程连接

服务默认监听 `0.0.0.0:8080`，其他机器只需要能访问宿主机的 8080 端口。

常见部署方式：

| 场景 | 做法 | 客户端 `WORKO_URL` |
|---|---|---|
| 同一局域网 | 找到宿主机内网 IP，并允许 8080 端口通过防火墙 | `http://<host-ip>:8080` |
| VPS / 云服务器 | 在服务器上运行 `podman compose up -d --build`，开放 8080 端口 | `http://<server-ip>:8080` |
| 隧道或内网组网 | 使用 Cloudflare Tunnel、Tailscale 等把本机服务暴露给队友 | 隧道或 Tailscale 地址 |

如果暴露到公网，请使用 HTTPS 反向代理或可信隧道，并设置强随机 token。

## 容器与部署

`Dockerfile` 是多阶段构建：

1. 用 Node 安装 dashboard 依赖并运行 `npm run build`。
2. 用 Bun 镜像运行 `server.ts`。
3. 把构建后的 `dashboard/dist` 放到 `/app/dashboard/dist`。

`docker-compose.yml` 会设置：

```text
PORT=8080
DB_PATH=/data/worko.db
WORKO_ADMIN_TOKEN=${WORKO_ADMIN_TOKEN:-change-me}
PUBLIC_DIR=/app/dashboard/dist
```

建议不要使用默认的 `change-me`。部署前编辑 `.env`：

```sh
WORKO_ADMIN_TOKEN=<long-random-secret>
```

Fly.io 配置在 `fly.toml`，数据库挂载到 `/data`，应用端口为 8080。部署到 Fly.io 时同样需要设置 `WORKO_ADMIN_TOKEN` secret。

## 安全注意事项

- 不要把默认 token 暴露到公网。
- 不要把 workspace `join_token` 发给不可信成员。
- 成员离开 workspace 后，应从白名单移除；必要时重新生成 token。
- 服务端有内存级限流和短期封禁，用于降低暴力尝试风险；多副本部署时需要外部共享限流组件。
- WebSocket admin 连接使用 `role=admin` 和 admin token，普通成员连接只使用 workspace join token。

## 许可证

本项目使用 [Apache 2.0](LICENSE) 许可证。
