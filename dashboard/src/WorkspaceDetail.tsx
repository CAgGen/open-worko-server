import { useState, useEffect, useCallback } from "react";
import { api, type Member, type Room, type Thread, type Workspace } from "./api";

type Tab = "all" | "open" | "waiting" | "resolved";

export default function WorkspaceDetail({ token, wsId, onThread, onBack }: {
  token: string;
  wsId: string;
  onThread: (id: string) => void;
  onBack: () => void;
}) {
  const [data, setData] = useState<{ workspace: Workspace; members: Member[]; rooms: Room[]; threads: Thread[] } | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [showToken, setShowToken] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [newMember, setNewMember] = useState("");
  const [addingMember, setAddingMember] = useState(false);

  const refresh = useCallback(() => {
    api.getWorkspace(token, wsId).then(setData);
  }, [token, wsId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  async function regenToken() {
    const d = await api.regenerateToken(token, wsId);
    setNewToken(d.join_token);
    setShowToken(true);
  }

  async function addMember(e: React.FormEvent) {
    e.preventDefault();
    const id = newMember.trim();
    if (!id) return;
    setAddingMember(true);
    try { await api.addMember(token, wsId, id); setNewMember(""); refresh(); }
    finally { setAddingMember(false); }
  }

  async function removeMember(id: string) {
    if (!confirm(`移除成员 ${id}？该 id 将无法再连接此 workspace（在线连接会被断开）。`)) return;
    await api.removeMember(token, wsId, id);
    refresh();
  }

  function copy(t: string) {
    navigator.clipboard.writeText(t);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!data) return <div className="empty-state"><span className="spin" /></div>;

  const { workspace, members, threads } = data;
  const online = members.filter((m) => m.online === 1);
  const offline = members.filter((m) => m.online !== 1);
  const filtered = tab === "all" ? threads : threads.filter((t) => t.status === tab);

  return (
    <>
      <div className="section-header" style={{ marginBottom: 20 }}>
        <div>
          <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 4 }}>
            <span className="header-link" onClick={onBack} style={{ cursor: "pointer" }}>← Workspaces</span>
          </div>
          <h1 className="page-title" style={{ margin: 0 }}>{workspace.name}</h1>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-ghost btn-sm" onClick={regenToken}>重新生成 Token</button>
        </div>
      </div>

      <div className="ws-detail">
        {/* Members panel */}
        <div className="panel">
          <div className="panel-head">
            成员
            <span className="badge-online">● {online.length} 在线</span>
          </div>
          <div className="panel-body">
            {online.map((m) => <MemberRow key={m.id} member={m} onRemove={removeMember} />)}
            {offline.map((m) => <MemberRow key={m.id} member={m} onRemove={removeMember} />)}
            {members.length === 0 && <div className="empty-state">暂无成员 — 在下方添加</div>}
          </div>
          <form className="member-add" onSubmit={addMember}>
            <input
              type="text"
              value={newMember}
              onChange={(e) => setNewMember(e.target.value)}
              placeholder="对方 id（如 codex_bob）"
            />
            <button type="submit" className="btn-primary btn-sm" disabled={addingMember || !newMember.trim()}>
              {addingMember ? <span className="spin" /> : "添加"}
            </button>
          </form>
        </div>

        {/* Threads panel */}
        <div className="panel">
          <div className="thread-tabs">
            {(["all", "open", "waiting", "resolved"] as Tab[]).map((t) => (
              <button
                key={t}
                className={`tab-btn ${tab === t ? "active" : ""}`}
                onClick={() => setTab(t)}
              >
                {t === "all" ? "全部" : t === "open" ? "进行中" : t === "waiting" ? "等待中" : "已解决"}
                {t !== "all" && (
                  <span style={{ marginLeft: 6, fontSize: 11, color: "var(--muted)" }}>
                    {threads.filter((x) => x.status === t).length}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div>
            {filtered.length === 0 ? (
              <div className="empty-state">无对话</div>
            ) : filtered.map((th) => (
              <ThreadRow key={th.id} thread={th} onClick={() => onThread(th.id)} />
            ))}
          </div>
        </div>
      </div>

      {/* Regen token modal */}
      {showToken && newToken && (
        <div className="modal-backdrop" onClick={() => { setShowToken(false); setNewToken(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>新 Join Token</h2>
            <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 12 }}>
              旧 token 已失效。使用此 token 的成员需要更新 <code style={{ color: "var(--accent)" }}>~/.worko/config</code> 后重连。
            </p>
            <label>JOIN TOKEN</label>
            <div className="token-box">{newToken}</div>
            <div className="token-warn">⚠️ 只显示一次</div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => copy(newToken)}>{copied ? "✓ 已复制" : "复制"}</button>
              <button className="btn-primary" onClick={() => { setShowToken(false); setNewToken(null); }}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function MemberRow({ member: m, onRemove }: { member: Member; onRemove: (id: string) => void }) {
  return (
    <div className="member-row">
      <div className={`dot ${m.online ? "dot-green" : "dot-gray"}`} />
      <span className="member-name">{m.id}</span>
      {m.kind && <span className="member-kind">{m.kind}</span>}
      <button className="member-remove" title="移除成员" onClick={() => onRemove(m.id)}>×</button>
    </div>
  );
}

function ThreadRow({ thread: t, onClick }: { thread: Thread; onClick: () => void }) {
  const rel = relTime(t.created_at);
  return (
    <div className="thread-row" onClick={onClick}>
      <span className={`thread-status status-${t.status}`}>{t.status}</span>
      <span className="thread-title">{t.title || t.id}</span>
      {t.msg_count !== undefined && (
        <span className="thread-meta">{t.msg_count} 条</span>
      )}
      <span className="thread-meta">{rel}</span>
    </div>
  );
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
