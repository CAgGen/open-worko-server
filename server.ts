// open-worko 中立服务器
// 职责：存 thread/消息、路由 @、每步写 okf_log、推 wake。
// 故意不跑 LLM —— 聪明留给边缘的 agent，服务器只做一条谁都不锁定的公共线。

import { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.PORT ?? 8080);
const DB_PATH = process.env.DB_PATH ?? "./worko.db";
const TOKEN = process.env.WORKO_TOKEN ?? ""; // 空 = 本地开发放行；上公网必须设

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY, name TEXT, kind TEXT, online INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, name TEXT
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, room_id TEXT, status TEXT DEFAULT 'open',
  waiting_for TEXT, title TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, room TEXT, thread TEXT, "from" TEXT,
  "to" TEXT, type TEXT, content TEXT, ts TEXT
);
CREATE TABLE IF NOT EXISTS okf_log (
  thread_id TEXT, seq INTEGER, ts TEXT, actor TEXT, action TEXT, payload TEXT
);
CREATE TABLE IF NOT EXISTS okf_summary (
  thread_id TEXT PRIMARY KEY, okf_head TEXT, okf_body TEXT, updated_at TEXT
);
`);

const now = () => new Date().toISOString();
const genId = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const kindOf = (id: string) =>
  id.startsWith("claude") ? "claude"
  : id.startsWith("codex") ? "codex"
  : id.startsWith("human") || id.startsWith("user") ? "human"
  : "agent";

// 每步往 okf_log 追加一条（OKF 正文）
function logStep(threadId: string, actor: string, action: string, payload: unknown = "") {
  const row = db.query("SELECT COALESCE(MAX(seq),0) AS m FROM okf_log WHERE thread_id=?").get(threadId) as { m: number };
  const seq = (row?.m ?? 0) + 1;
  const p = typeof payload === "string" ? payload : JSON.stringify(payload);
  db.run("INSERT INTO okf_log (thread_id,seq,ts,actor,action,payload) VALUES (?,?,?,?,?,?)",
    [threadId, seq, now(), actor, action, p]);
}

function authOK(req: Request): boolean {
  if (!TOKEN) return true;
  return (req.headers.get("authorization") ?? "") === `Bearer ${TOKEN}`;
}

// 同一 ID 同一时间只允许一个活 WS 连接（新连接挤掉旧的），避免同 ID 多应答方抢答。
type WSData = { id: string };
const liveConns = new Map<string, ServerWebSocket<WSData>>();

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // —— WebSocket 升级（推 wake 的那条线）——
    if (url.pathname === "/" && req.headers.get("upgrade") === "websocket") {
      const id = url.searchParams.get("id") ?? "";
      const token = url.searchParams.get("token") ?? "";
      if (TOKEN && token !== TOKEN) return new Response("unauthorized", { status: 401 });
      if (!id) return new Response("missing id", { status: 400 });
      if (server.upgrade(req, { data: { id } })) return undefined;
      return new Response("upgrade failed", { status: 500 });
    }

    if (url.pathname === "/health") return Response.json({ ok: true });

    // —— 其余口子都要鉴权 ——
    if (!authOK(req)) return new Response("unauthorized", { status: 401 });

    if (req.method === "POST" && url.pathname === "/messages") {
      return handlePostMessage(await req.json(), server);
    }
    if (req.method === "GET" && url.pathname === "/context") {
      return handleGetContext(url.searchParams.get("thread") ?? "");
    }
    // 名册：worko list 用
    if (req.method === "GET" && url.pathname === "/agents") {
      const agents = db.query("SELECT id, kind, online FROM participants ORDER BY id").all();
      return Response.json({ agents });
    }
    // 收件箱：gateway 重连补同步用——还 waiting_for 我、且没答的 thread
    if (req.method === "GET" && url.pathname === "/inbox") {
      const id = url.searchParams.get("id") ?? "";
      if (!id) return new Response("missing id", { status: 400 });
      const rows = db.query("SELECT id FROM threads WHERE status='waiting' AND waiting_for LIKE ?")
        .all(`%"${id}"%`) as Array<{ id: string }>;
      return Response.json({ threads: rows.map((r) => r.id) });
    }
    if (url.pathname.startsWith("/threads/")) {
      const [, , tid, action] = url.pathname.split("/");
      if (req.method === "POST" && action === "resolve") {
        db.run("UPDATE threads SET status='resolved', waiting_for=NULL WHERE id=?", [tid]);
        logStep(tid, "server", "resolve", "");
        return Response.json({ ok: true });
      }
      if (req.method === "GET") {
        const messages = db.query("SELECT * FROM messages WHERE thread=? ORDER BY ts ASC").all(tid);
        const okf_log = db.query("SELECT * FROM okf_log WHERE thread_id=? ORDER BY seq ASC").all(tid);
        return Response.json({ thread: tid, messages, okf_log });
      }
    }
    return new Response("not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      const id = (ws.data as WSData).id;
      // 同 ID 只留一个活连接：先占住槽位，再挤掉旧的（旧连接的 close 守卫据此跳过）。
      const prev = liveConns.get(id);
      liveConns.set(id, ws);
      if (prev && prev !== ws) {
        try { prev.close(4000, "replaced by newer connection"); } catch {}
        console.log(`[ws] ${id} 旧连接被挤掉`);
      }
      ws.subscribe(id);          // 订阅"发给我"的 wake
      ws.subscribe("presence");
      db.run(
        `INSERT INTO participants (id,name,kind,online) VALUES (?,?,?,1)
         ON CONFLICT(id) DO UPDATE SET online=1`,
        [id, id, kindOf(id)],
      );
      server.publish("presence", JSON.stringify({ type: "event", event: "presence", payload: { id, online: true } }));
      console.log(`[ws] ${id} online`);
    },
    close(ws) {
      const id = (ws.data as WSData).id;
      // 只有"当前活连接"下线才算 offline；被挤掉的旧连接在这里跳过，避免把新连接误标离线。
      if (liveConns.get(id) !== ws) return;
      liveConns.delete(id);
      db.run("UPDATE participants SET online=0 WHERE id=?", [id]);
      server.publish("presence", JSON.stringify({ type: "event", event: "presence", payload: { id, online: false } }));
      console.log(`[ws] ${id} offline`);
    },
    message() { /* P0：客户端发消息走 HTTP POST /messages，这里先不处理入站帧 */ },
  },
});

type IncomingMsg = {
  room?: string; thread?: string; from?: string;
  to?: string[]; type?: string; content?: string;
};

function handlePostMessage(body: IncomingMsg, server: Bun.Server): Response {
  const room = body.room ?? "room_dev";
  const from = body.from;
  const to = body.to ?? [];
  const type = body.type ?? "note";
  const content = body.content ?? "";
  if (!from) return new Response("missing from", { status: 400 });

  // 没带 thread = 开一条新的
  let thread = body.thread;
  if (!thread) {
    thread = genId("thread");
    db.run("INSERT INTO threads (id,room_id,status,title,created_at) VALUES (?,?,?,?,?)",
      [thread, room, "open", content.slice(0, 60), now()]);
    logStep(thread, "server", "thread_open", { room, title: content.slice(0, 60) });
  } else if (!db.query("SELECT id FROM threads WHERE id=?").get(thread)) {
    db.run("INSERT INTO threads (id,room_id,status,title,created_at) VALUES (?,?,?,?,?)",
      [thread, room, "open", content.slice(0, 60), now()]);
  }

  const id = genId("msg");
  const ts = now();
  db.run(`INSERT INTO messages (id,room,thread,"from","to",type,content,ts) VALUES (?,?,?,?,?,?,?,?)`,
    [id, room, thread, from, JSON.stringify(to), type, content, ts]);

  // 每步写 log：消息本身 + 路由
  logStep(thread, from, type, content);
  if (to.length) logStep(thread, "server", "route", { to });

  // thread 状态机
  if (type === "ask") db.run("UPDATE threads SET status='waiting', waiting_for=? WHERE id=?", [JSON.stringify(to), thread]);
  else if (type === "answer") db.run("UPDATE threads SET status='open', waiting_for=NULL WHERE id=?", [thread]);
  else if (type === "resolve") db.run("UPDATE threads SET status='resolved', waiting_for=NULL WHERE id=?", [thread]);

  // 推 wake 给每个收件人（命门）
  for (const target of to) {
    server.publish(target, JSON.stringify({
      type: "event", event: "wake",
      payload: { thread, msgId: id, from, type },
    }));
  }
  return Response.json({ ok: true, id, thread });
}

function handleGetContext(thread: string): Response {
  if (!thread) return new Response("missing thread", { status: 400 });
  const t = db.query("SELECT * FROM threads WHERE id=?").get(thread) as { status?: string } | null;
  const msgs = db.query("SELECT * FROM messages WHERE thread=? ORDER BY ts ASC").all(thread) as Array<{
    from: string; type: string; content: string; to: string;
  }>;
  const head = db.query("SELECT okf_head FROM okf_summary WHERE thread_id=?").get(thread) as { okf_head?: string } | null;
  const asker = msgs.find((m) => m.type === "ask")?.from ?? null;
  const recent = msgs.slice(-8).map((m) => ({
    from: m.from, type: m.type, content: m.content, to: JSON.parse(m.to || "[]"),
  }));
  return Response.json({ thread, status: t?.status ?? null, asker, head: head?.okf_head ?? null, recent });
}

console.log(`[worko] server on :${PORT}  db=${DB_PATH}  auth=${TOKEN ? "on" : "OFF (dev)"}`);
