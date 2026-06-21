// open-worko server v2 — workspace-isolated auth
// 每个 workspace 有自己的 join_token；token 哈希后存 DB，请求时同步校验。

import { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "crypto";
import { join } from "path";
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.PORT ?? 8080);
const DB_PATH = process.env.DB_PATH ?? "./worko.db";
const ADMIN_TOKEN = process.env.WORKO_ADMIN_TOKEN ?? ""; // 空 = dev 模式放行
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? "./dashboard/dist";

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT, join_token_hash TEXT UNIQUE, created_at TEXT
);
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY, name TEXT, kind TEXT, online INTEGER DEFAULT 0, workspace_id TEXT
);
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, name TEXT, workspace_id TEXT
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
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT, participant_id TEXT, added_at TEXT,
  PRIMARY KEY (workspace_id, participant_id)
);
`);
// 兼容旧 DB：加字段忽略 "already exists" 错误
try { db.exec("ALTER TABLE participants ADD COLUMN workspace_id TEXT"); } catch {}
try { db.exec("ALTER TABLE rooms ADD COLUMN workspace_id TEXT"); } catch {}

const now = () => new Date().toISOString();
const genId = (p: string) => `${p}_${crypto.randomUUID().slice(0, 8)}`;
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const kindOf = (id: string) =>
  id.startsWith("claude") ? "claude"
  : id.startsWith("codex") ? "codex"
  : id.startsWith("human") || id.startsWith("user") ? "human"
  : "agent";

// ponytail: in-memory cache token_hash→workspaceId，避免每次请求查 DB
const tokenCache = new Map<string, string>();
function loadTokenCache() {
  const rows = db.query("SELECT id, join_token_hash FROM workspaces WHERE join_token_hash IS NOT NULL").all() as Array<{ id: string; join_token_hash: string }>;
  for (const r of rows) tokenCache.set(r.join_token_hash, r.id);
}
loadTokenCache();

// 常量时间比较，防 admin token 时序侧信道
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

type Auth = { role: "admin" } | { role: "member"; workspaceId: string } | null;

function authenticate(req: Request): Auth {
  if (!ADMIN_TOKEN) return { role: "admin" }; // dev 模式
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/, "");
  if (!bearer) return null;
  if (safeEqual(bearer, ADMIN_TOKEN)) return { role: "admin" };
  const wsId = tokenCache.get(hashToken(bearer));
  if (wsId) return { role: "member", workspaceId: wsId };
  return null;
}

// 是否本 workspace 注册成员（白名单）。dev 模式（无 workspaceId）一律放行。
const isMember = (workspaceId: string, id: string): boolean =>
  !workspaceId || !!db.query("SELECT 1 FROM workspace_members WHERE workspace_id=? AND participant_id=?").get(workspaceId, id);

// —— Phase A: 限流 + 封禁（纯内存，单机够用）——
// ponytail: 多副本部署再换 Redis；当前自托管单机 Map 就够
function clientIP(req: Request, srv: Bun.Server): string {
  // 反代后真实 IP 在 X-Forwarded-For（部署时只信任自己的代理）
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return srv.requestIP(req)?.address ?? "unknown";
}

const hits = new Map<string, number[]>();          // ip -> 请求时间戳[]
function rateLimit(ip: string, max: number, windowMs: number): boolean {
  const t = Date.now();
  const arr = (hits.get(ip) ?? []).filter((x) => t - x < windowMs);
  arr.push(t); hits.set(ip, arr);
  return arr.length <= max;
}

const bans = new Map<string, { fails: number; until: number }>();
const BAN_THRESHOLD = 10, BAN_MS = 15 * 60_000;
function isBanned(ip: string): boolean {
  const b = bans.get(ip);
  return !!b && b.until > Date.now();
}
function recordAuthFail(ip: string) {
  const b = bans.get(ip) ?? { fails: 0, until: 0 };
  b.fails++;
  if (b.fails >= BAN_THRESHOLD) b.until = Date.now() + BAN_MS;
  bans.set(ip, b);
}
const clearAuthFail = (ip: string) => bans.delete(ip);

// 每分钟清一遍：未封的失败计数（until=0）整条清掉 → 需 1 分钟内 10 次才封；
// 已封条目到期（until<now）后也整条删除 → 完全复位，不会永久封。
setInterval(() => {
  const t = Date.now();
  for (const [ip, arr] of hits) {
    const f = arr.filter((x) => t - x < 60_000);
    if (f.length) hits.set(ip, f); else hits.delete(ip);
  }
  for (const [ip, b] of bans) if (b.until < t) bans.delete(ip);
}, 60_000);

function logStep(threadId: string, actor: string, action: string, payload: unknown = "") {
  const row = db.query("SELECT COALESCE(MAX(seq),0) AS m FROM okf_log WHERE thread_id=?").get(threadId) as { m: number };
  const seq = (row?.m ?? 0) + 1;
  const p = typeof payload === "string" ? payload : JSON.stringify(payload);
  db.run("INSERT INTO okf_log (thread_id,seq,ts,actor,action,payload) VALUES (?,?,?,?,?,?)",
    [threadId, seq, now(), actor, action, p]);
}

type WSData = { id: string; workspaceId: string; isAdmin?: boolean };
const liveConns = new Map<string, ServerWebSocket<WSData>>();

const server = Bun.serve({
  port: PORT,
  maxRequestBodySize: 1024 * 1024, // 1MB，防超大 payload
  async fetch(req, server) {
    const url = new URL(req.url);

    // health 完全放行（docker healthcheck，不计限流/封禁）
    if (url.pathname === "/health") return Response.json({ ok: true });

    // Phase A: 封禁中直接拒；再按路径限流
    const ip = clientIP(req, server);
    if (isBanned(ip)) return new Response("too many requests", { status: 429 });
    const limit = url.pathname.startsWith("/admin") ? 30 : 120;
    if (!rateLimit(ip, limit, 60_000)) return new Response("rate limited", { status: 429 });

    // WebSocket 升级
    if (req.headers.get("upgrade") === "websocket") {
      const token = url.searchParams.get("token") ?? "";
      const id = url.searchParams.get("id") ?? "";
      const role = url.searchParams.get("role") ?? "";

      if (role === "admin") {
        if (ADMIN_TOKEN && !safeEqual(token, ADMIN_TOKEN)) { recordAuthFail(ip); return new Response("unauthorized", { status: 401 }); }
        if (server.upgrade(req, { data: { id: "_admin_ws", workspaceId: "", isAdmin: true } })) return undefined;
        return new Response("upgrade failed", { status: 500 });
      }
      if (!id) return new Response("missing id", { status: 400 });
      let workspaceId = "";
      if (ADMIN_TOKEN) {
        const wsId = tokenCache.get(hashToken(token));
        if (!wsId) { recordAuthFail(ip); return new Response("unauthorized", { status: 401 }); }
        // Phase B: token 有效还不够，id 必须在白名单
        if (!isMember(wsId, id)) { recordAuthFail(ip); return new Response("not a registered member", { status: 403 }); }
        clearAuthFail(ip);
        workspaceId = wsId;
      }
      if (server.upgrade(req, { data: { id, workspaceId } })) return undefined;
      return new Response("upgrade failed", { status: 500 });
    }

    // 管理端点
    if (url.pathname.startsWith("/admin")) {
      const auth = authenticate(req);
      if (!auth || auth.role !== "admin") { recordAuthFail(ip); return new Response("unauthorized", { status: 401 }); }
      clearAuthFail(ip);
      return handleAdmin(req, url, server);
    }

    // 静态文件（dashboard）
    const isApiPath = ["/messages", "/context", "/agents", "/inbox", "/threads", "/rooms"].some(p => url.pathname.startsWith(p));
    if (req.method === "GET" && !isApiPath) return serveStatic(url.pathname);

    // 成员端点
    const auth = authenticate(req);
    if (!auth) { recordAuthFail(ip); return new Response("unauthorized", { status: 401 }); }
    clearAuthFail(ip);
    const workspaceId = auth.role === "admin" ? "" : auth.workspaceId;

    if (req.method === "POST" && url.pathname === "/messages") {
      return handlePostMessage(await req.json(), workspaceId, server);
    }
    if (req.method === "GET" && url.pathname === "/context") {
      return handleGetContext(url.searchParams.get("thread") ?? "", workspaceId);
    }
    if (req.method === "GET" && url.pathname === "/agents") {
      const agents = workspaceId
        ? db.query("SELECT id, kind, online FROM participants WHERE workspace_id=? ORDER BY online DESC, id").all(workspaceId)
        : db.query("SELECT id, kind, online FROM participants ORDER BY id").all();
      return Response.json({ agents });
    }
    if (req.method === "GET" && url.pathname === "/inbox") {
      const id = url.searchParams.get("id") ?? "";
      if (!id) return new Response("missing id", { status: 400 });
      const rows = workspaceId
        ? db.query(`SELECT t.id FROM threads t JOIN rooms r ON t.room_id=r.id
            WHERE t.status='waiting' AND t.waiting_for LIKE ? AND r.workspace_id=?`)
            .all(`%"${id}"%`, workspaceId) as Array<{ id: string }>
        : db.query("SELECT id FROM threads WHERE status='waiting' AND waiting_for LIKE ?")
            .all(`%"${id}"%`) as Array<{ id: string }>;
      return Response.json({ threads: rows.map((r) => r.id) });
    }
    if (req.method === "GET" && url.pathname === "/threads") {
      const room = url.searchParams.get("room") ?? "";
      const status = url.searchParams.get("status") ?? "";
      let q = "SELECT t.* FROM threads t JOIN rooms r ON t.room_id=r.id WHERE 1=1";
      const params: string[] = [];
      if (workspaceId) { q += " AND r.workspace_id=?"; params.push(workspaceId); }
      if (room) { q += " AND t.room_id=?"; params.push(room); }
      if (status) { q += " AND t.status=?"; params.push(status); }
      q += " ORDER BY t.created_at DESC LIMIT 100";
      return Response.json({ threads: db.query(q).all(...params) });
    }
    if (req.method === "GET" && url.pathname === "/rooms") {
      const rooms = workspaceId
        ? db.query("SELECT * FROM rooms WHERE workspace_id=? ORDER BY name").all(workspaceId)
        : db.query("SELECT * FROM rooms ORDER BY name").all();
      return Response.json({ rooms });
    }
    if (url.pathname.startsWith("/threads/")) {
      const parts = url.pathname.split("/");
      const tid = parts[2];
      const action = parts[3];
      if (req.method === "POST" && action === "resolve") {
        db.run("UPDATE threads SET status='resolved', waiting_for=NULL WHERE id=?", [tid]);
        logStep(tid, "server", "resolve", "");
        broadcastThreadUpdate(tid, "resolved", server);
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
      const { id, workspaceId, isAdmin } = ws.data as WSData;
      if (isAdmin) { ws.subscribe("admin"); return; }
      const prev = liveConns.get(id);
      liveConns.set(id, ws);
      if (prev && prev !== ws) { try { prev.close(4000, "replaced"); } catch {} }
      ws.subscribe(id);
      if (workspaceId) ws.subscribe(`ws:${workspaceId}`);
      db.run(
        `INSERT INTO participants (id,name,kind,online,workspace_id) VALUES (?,?,?,1,?)
         ON CONFLICT(id) DO UPDATE SET online=1, workspace_id=?`,
        [id, id, kindOf(id), workspaceId, workspaceId],
      );
      const ev = JSON.stringify({ type: "event", event: "presence", payload: { id, online: true } });
      if (workspaceId) server.publish(`ws:${workspaceId}`, ev);
      server.publish("admin", JSON.stringify({ type: "event", event: "presence", payload: { id, workspaceId, online: true } }));
      console.log(`[ws] ${id} online (ws=${workspaceId || "dev"})`);
    },
    close(ws) {
      const { id, workspaceId, isAdmin } = ws.data as WSData;
      if (isAdmin) return;
      if (liveConns.get(id) !== ws) return;
      liveConns.delete(id);
      db.run("UPDATE participants SET online=0 WHERE id=?", [id]);
      const ev = JSON.stringify({ type: "event", event: "presence", payload: { id, online: false } });
      if (workspaceId) server.publish(`ws:${workspaceId}`, ev);
      server.publish("admin", JSON.stringify({ type: "event", event: "presence", payload: { id, workspaceId, online: false } }));
      console.log(`[ws] ${id} offline`);
    },
    message() {},
  },
});

function broadcastThreadUpdate(tid: string, status: string, srv: Bun.Server) {
  const t = db.query("SELECT room_id FROM threads WHERE id=?").get(tid) as { room_id: string } | null;
  if (!t) return;
  const r = db.query("SELECT workspace_id FROM rooms WHERE id=?").get(t.room_id) as { workspace_id: string } | null;
  if (r?.workspace_id) {
    srv.publish(`ws:${r.workspace_id}`, JSON.stringify({ type: "event", event: "thread_update", payload: { thread: tid, status } }));
  }
  srv.publish("admin", JSON.stringify({ type: "event", event: "thread_update", payload: { thread: tid, status } }));
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = Bun.file(join(PUBLIC_DIR, rel));
  if (await file.exists()) return new Response(file);
  const index = Bun.file(join(PUBLIC_DIR, "index.html"));
  if (await index.exists()) return new Response(index, { headers: { "content-type": "text/html" } });
  return new Response("dashboard not built — cd dashboard && npm run build", { status: 503 });
}

async function handleAdmin(req: Request, url: URL, srv: Bun.Server): Promise<Response> {
  const seg = url.pathname.replace(/^\/admin\/?/, ""); // e.g. "workspaces" or "workspaces/ws_abc"

  // GET /admin/workspaces
  if (req.method === "GET" && seg === "workspaces") {
    const rows = db.query(`
      SELECT w.id, w.name, w.created_at,
        (SELECT COUNT(*) FROM participants p WHERE p.workspace_id=w.id AND p.online=1) AS online_count,
        (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id=w.id) AS member_count,
        (SELECT COUNT(*) FROM threads t JOIN rooms r ON t.room_id=r.id WHERE r.workspace_id=w.id AND t.status!='resolved') AS open_threads
      FROM workspaces w ORDER BY w.created_at DESC
    `).all();
    return Response.json({ workspaces: rows });
  }

  // POST /admin/workspaces
  if (req.method === "POST" && seg === "workspaces") {
    const body = await req.json() as { name?: string };
    const name = (body.name ?? "").trim() || "Workspace";
    const id = genId("ws");
    const join_token = crypto.randomUUID();
    const hash = hashToken(join_token);
    const created_at = now();
    db.run("INSERT INTO workspaces (id,name,join_token_hash,created_at) VALUES (?,?,?,?)", [id, name, hash, created_at]);
    tokenCache.set(hash, id);
    const roomId = genId("room");
    db.run("INSERT INTO rooms (id,name,workspace_id) VALUES (?,?,?)", [roomId, "general", id]);
    srv.publish("admin", JSON.stringify({ type: "event", event: "workspace_created", payload: { id, name } }));
    return Response.json({ workspace: { id, name, created_at }, join_token, room: { id: roomId, name: "general" } });
  }

  // GET /admin/workspaces/:id
  if (req.method === "GET" && seg.startsWith("workspaces/") && !seg.includes("/token")) {
    const wsId = seg.replace("workspaces/", "");
    const ws = db.query("SELECT id, name, created_at FROM workspaces WHERE id=?").get(wsId);
    if (!ws) return new Response("not found", { status: 404 });
    // 白名单成员 + 在线状态（注册了但没连过的 online=0）
    const members = db.query(`
      SELECT m.participant_id AS id, COALESCE(p.kind,'') AS kind, COALESCE(p.online,0) AS online
      FROM workspace_members m
      LEFT JOIN participants p ON p.id=m.participant_id AND p.workspace_id=m.workspace_id
      WHERE m.workspace_id=? ORDER BY online DESC, id
    `).all(wsId);
    const rooms = db.query("SELECT * FROM rooms WHERE workspace_id=?").all(wsId);
    const threads = db.query(`
      SELECT t.id, t.room_id, t.status, t.title, t.created_at, t.waiting_for,
        (SELECT COUNT(*) FROM messages m WHERE m.thread=t.id) AS msg_count
      FROM threads t JOIN rooms r ON t.room_id=r.id
      WHERE r.workspace_id=? ORDER BY t.created_at DESC LIMIT 100
    `).all(wsId);
    return Response.json({ workspace: ws, members, rooms, threads });
  }

  // POST /admin/workspaces/:id/token  (生成新 join_token，旧 token 失效)
  if (req.method === "POST" && seg.endsWith("/token")) {
    const wsId = seg.replace(/\/token$/, "").replace("workspaces/", "");
    const old = db.query("SELECT join_token_hash FROM workspaces WHERE id=?").get(wsId) as { join_token_hash: string } | null;
    if (!old) return new Response("not found", { status: 404 });
    tokenCache.delete(old.join_token_hash);
    const join_token = crypto.randomUUID();
    const hash = hashToken(join_token);
    db.run("UPDATE workspaces SET join_token_hash=? WHERE id=?", [hash, wsId]);
    tokenCache.set(hash, wsId);
    return Response.json({ join_token });
  }

  // POST /admin/workspaces/:id/members  (注册成员到白名单)
  if (req.method === "POST" && seg.endsWith("/members")) {
    const wsId = seg.replace(/^workspaces\//, "").replace(/\/members$/, "");
    if (!db.query("SELECT 1 FROM workspaces WHERE id=?").get(wsId)) return new Response("not found", { status: 404 });
    const body = await req.json() as { id?: string };
    const mid = (body.id ?? "").trim();
    if (!mid) return new Response("missing id", { status: 400 });
    db.run("INSERT OR IGNORE INTO workspace_members (workspace_id,participant_id,added_at) VALUES (?,?,?)", [wsId, mid, now()]);
    return Response.json({ ok: true });
  }

  // DELETE /admin/workspaces/:id/members/:mid  (踢出白名单 + 断开在线连接)
  if (req.method === "DELETE" && seg.includes("/members/")) {
    const parts = seg.split("/"); // workspaces / :id / members / :mid
    const wsId = parts[1];
    const mid = decodeURIComponent(parts[3] ?? "");
    db.run("DELETE FROM workspace_members WHERE workspace_id=? AND participant_id=?", [wsId, mid]);
    db.run("UPDATE participants SET online=0 WHERE id=? AND workspace_id=?", [mid, wsId]);
    const conn = liveConns.get(mid);
    if (conn) { try { conn.close(4001, "removed from workspace"); } catch {} }
    return Response.json({ ok: true });
  }

  // DELETE /admin/workspaces/:id
  if (req.method === "DELETE" && seg.startsWith("workspaces/")) {
    const wsId = seg.replace("workspaces/", "");
    const old = db.query("SELECT join_token_hash FROM workspaces WHERE id=?").get(wsId) as { join_token_hash: string } | null;
    if (old) tokenCache.delete(old.join_token_hash);
    db.run("DELETE FROM workspaces WHERE id=?", [wsId]);
    db.run("DELETE FROM workspace_members WHERE workspace_id=?", [wsId]);
    return Response.json({ ok: true });
  }

  return new Response("not found", { status: 404 });
}

type IncomingMsg = {
  room?: string; thread?: string; from?: string;
  to?: string[]; type?: string; content?: string;
};

function handlePostMessage(body: IncomingMsg, workspaceId: string, srv: Bun.Server): Response {
  const from = body.from;
  const to = body.to ?? [];
  const type = body.type ?? "note";
  const content = body.content ?? "";
  if (!from) return new Response("missing from", { status: 400 });
  // Phase B: 发送者 id 必须在白名单（防 token 泄露后冒名灌消息）
  if (!isMember(workspaceId, from)) return new Response("sender not a registered member", { status: 403 });

  // 定位 room：若有 workspaceId 则校验归属
  let room: string;
  if (body.room) {
    if (workspaceId) {
      const r = db.query("SELECT id FROM rooms WHERE id=? AND workspace_id=?").get(body.room, workspaceId);
      if (!r) return new Response("room not in workspace", { status: 403 });
    }
    room = body.room;
  } else {
    const r = workspaceId
      ? db.query("SELECT id FROM rooms WHERE workspace_id=? LIMIT 1").get(workspaceId) as { id: string } | null
      : null;
    room = r?.id ?? "room_dev";
  }

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

  logStep(thread, from, type, content);
  if (to.length) logStep(thread, "server", "route", { to });

  if (type === "ask") db.run("UPDATE threads SET status='waiting', waiting_for=? WHERE id=?", [JSON.stringify(to), thread]);
  else if (type === "answer") db.run("UPDATE threads SET status='open', waiting_for=NULL WHERE id=?", [thread]);
  else if (type === "resolve") db.run("UPDATE threads SET status='resolved', waiting_for=NULL WHERE id=?", [thread]);

  for (const target of to) {
    srv.publish(target, JSON.stringify({ type: "event", event: "wake", payload: { thread, msgId: id, from, type } }));
  }
  if (workspaceId) {
    srv.publish(`ws:${workspaceId}`, JSON.stringify({ type: "event", event: "message", payload: { thread, room, from, type } }));
  }
  srv.publish("admin", JSON.stringify({ type: "event", event: "message", payload: { thread, room, workspaceId, from, type } }));

  return Response.json({ ok: true, id, thread });
}

function handleGetContext(thread: string, workspaceId: string): Response {
  if (!thread) return new Response("missing thread", { status: 400 });
  const t = db.query("SELECT * FROM threads WHERE id=?").get(thread) as { status?: string; room_id?: string } | null;
  if (workspaceId && t?.room_id) {
    const r = db.query("SELECT workspace_id FROM rooms WHERE id=?").get(t.room_id) as { workspace_id: string } | null;
    if (r && r.workspace_id !== workspaceId) return new Response("forbidden", { status: 403 });
  }
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

console.log(`[worko] :${PORT}  db=${DB_PATH}  admin=${ADMIN_TOKEN ? "auth ON" : "dev mode (no auth)"}`);
