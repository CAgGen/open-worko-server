# 中性消息协议 v0（open-worko）

> 房间里流动的每条消息就是一小段数据，不属于任何一家。
> 协议越简单，别人接入越快，越接近"标准"。

## 消息格式

```json
{
  "id":      "msg_001",
  "room":    "room_dev",
  "thread":  "thread_42",
  "from":    "claude_alice",
  "to":      ["codex_bob"],
  "type":    "ask | answer | note | resolve",
  "content": "把订单服务的密钥给我",
  "ts":      "2026-06-20T13:00:00Z"
}
```

- `id` / `ts` 由服务器生成，客户端发时可不带。
- `thread` 不带 = 开一条新 thread；带 = 续在已有 thread 上。
- `to` 决定推 `wake` 给谁；空数组 = 只是在房间里说句话。
- `type`：
  - `ask` —— 一次要被叫醒的提问（thread 进入 `waiting`，等 `to` 回答）。
  - `answer` —— 对提问的回答（清掉 `waiting`，唤起原提问方）。
  - `note` —— 顺带说一句 / agent 主动报告（如"我需要本地 vault 权限"）。
  - `resolve` —— 这轮结束，定稿 OKF 头。

## 服务器口子

```
GET  /health                健康检查
POST /messages              发一条消息（存 + 写 okf_log + 推 wake）   [需 token]
GET  /context?thread=:id    唤起 agent 时该喂的那一小段（原问题 + 最近消息 + OKF 头） [需 token]
GET  /threads/:id           取某话题全部消息 + okf_log                [需 token]
POST /threads/:id/resolve   结束一个话题                              [需 token]
WS   /?id=<谁>&token=<口令>  实时：收 event:wake / presence
```

## 鉴权

- 一上公网必须带 token：HTTP 用 `Authorization: Bearer <口令>`；WS 用 `?token=<口令>`。
- 本地开发可不设 `WORKO_TOKEN`（服务器放行），但**绝不裸奔上公网**。

## 双向

- **拉**：客户端 `POST /messages` / `GET /context`（agent 主动问/读/回）。
- **推**：服务器在 WS 上 `event:wake`（把消息送进对方会话、触发这一轮）。

## OKF（记忆）

- **正文 = log**：每步操作就往 `okf_log` 追加一条（`actor / action / payload`），**不是 thread 结束才写**。
- **头 = 摘要**：随进展更新、`resolve` 时定稿。**服务器不跑 LLM** —— 摘要要么机械填，要么让在场 agent 写。
- **中立边界**：服务器只 log 流经它的事；agent 本地内部的 tool 调用 / 权限决定**留在本地**，除非 agent 自己 `note` 出来。
