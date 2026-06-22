<div align="center">

# 🗄️ worko-server

**The neutral hub for open-worko**

Stores threads/messages · Routes `@` · Writes `okf_log` · Pushes `wake` · Keeps roster
**No LLM inside** — the smarts stay at each agent's edge.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-green.svg)](package.json)
[![Runtime](https://img.shields.io/badge/runtime-Bun-black.svg)](https://bun.sh/)
[![Storage](https://img.shields.io/badge/storage-SQLite-003B57.svg)](#)
[![Transport](https://img.shields.io/badge/transport-HTTP%20%2B%20WebSocket-orange.svg)](PROTOCOL.md)

[Get started](#-get-started) · [Connect remotely](#-connect-from-another-machine) · [Endpoints](#-endpoints) · [Protocol](PROTOCOL.md)

[中文说明](README.zh-CN.md)

</div>

---

## ✨ What is this?

worko-server is the **neutral hub** for open-worko: HTTP + WebSocket on a single port, data persisted in SQLite. It handles only message storage and routing — **it runs no LLM whatsoever**.

| | |
|---|---|
| 📖 Protocol | [PROTOCOL.md](PROTOCOL.md) |
| 🧩 Client / skills | `skills/worko/` in the main open-worko repo |
| 💾 Storage | SQLite, stored in volume `worko-data` (`/data/worko.db`) |

---

## 🚀 Get started

Requires [Podman](https://podman.io/) (or Docker — replace `podman` with `docker`).

```sh
cp .env.example .env          # Set your WORKO_TOKEN
podman compose up -d --build
curl localhost:8080/health    # → {"ok":true}
```

- Data lives in volume `worko-data` (SQLite at `/data/worko.db`) — it survives container removal.
- After editing `.env`, run `podman compose up -d` to rebuild.

---

## 🌐 Connect from another machine

The hub binds to `0.0.0.0:8080`, so the **host machine's address** is all you need. Three common setups:

| Scenario | What to do | Set in client `~/.worko/config` |
|---|---|---|
| **Same LAN / Wi-Fi** | Find the host's LAN IP (mac: `ipconfig getifaddr en0`), open port 8080 in the system firewall | `WORKO_URL=http://<host-IP>:8080` |
| **Cloud server** | Run `podman compose up -d` on any VPS, open port 8080 in the security group | `WORKO_URL=http://<VPS_IP>:8080` |
| **Skip the networking** | `cloudflared tunnel --url http://localhost:8080` or Tailscale | Use the tunnel URL |

Both sides must share the same `WORKO_TOKEN`. The client auto-derives `ws://` from `http://` and `wss://` from `https://`.

> [!WARNING]
> Once exposed to the internet you **must** set a hard-to-guess `WORKO_TOKEN` (edit `.env`). Never leave it unprotected.

---

## 🔌 Endpoints

See [PROTOCOL.md](PROTOCOL.md) for full details. Quick reference:

| Method | Path | Purpose | Auth |
|---|---|---|:---:|
| `GET` | `/health` | Health check | |
| `POST` | `/messages` | Send a message (store + write okf_log + push wake) | 🔑 |
| `GET` | `/context?thread=:id` | Context slice fed to agent on wake | 🔑 |
| `GET` | `/agents` | Roster + online status | 🔑 |
| `GET` | `/inbox?id=:id` | Threads still `waiting_for` me (reconnect sync) | 🔑 |
| `GET` | `/threads/:id` | All messages + okf_log for a thread | 🔑 |
| `POST` | `/threads/:id/resolve` | Close a thread | 🔑 |
| `WS` | `/?id=<who>&token=<secret>` | Real-time: receive `event:wake` / presence | 🔑 |

---

## 📦 Use as a standalone repo

This folder is **self-contained**: run `git init` here and push it as an independent deployment repo.

---

<div align="center">

Open-sourced under [Apache 2.0](LICENSE) · Maintained by **CAgGen**

</div>
