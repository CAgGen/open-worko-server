import { useState, useEffect, useCallback } from "react";
import { api, type Workspace } from "./api";
import WorkspaceDetail from "./WorkspaceDetail";
import ThreadDetail from "./ThreadDetail";

type Page =
  | { name: "workspaces" }
  | { name: "workspace"; id: string }
  | { name: "thread"; id: string; wsId: string };

const TOKEN_KEY = "worko_admin_token";

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? "");
  const [authed, setAuthed] = useState(false);
  const [page, setPage] = useState<Page>({ name: "workspaces" });

  // Verify saved token on mount
  useEffect(() => {
    if (!token) return;
    api.ping(token).then(() => setAuthed(true)).catch(() => {
      setAuthed(false);
      localStorage.removeItem(TOKEN_KEY);
    });
  }, []);

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
    setAuthed(false);
    setPage({ name: "workspaces" });
  }

  if (!authed) {
    return <Login onLogin={(t) => { setToken(t); setAuthed(true); localStorage.setItem(TOKEN_KEY, t); }} />;
  }

  return (
    <div className="layout">
      <Header page={page} onNav={setPage} onLogout={logout} />
      <main className="main">
        {page.name === "workspaces" && (
          <WorkspaceList token={token} onSelect={(id) => setPage({ name: "workspace", id })} />
        )}
        {page.name === "workspace" && (
          <WorkspaceDetail
            token={token}
            wsId={page.id}
            onThread={(tid) => setPage({ name: "thread", id: tid, wsId: page.id })}
            onBack={() => setPage({ name: "workspaces" })}
          />
        )}
        {page.name === "thread" && (
          <ThreadDetail
            token={token}
            threadId={page.id}
            onBack={() => setPage({ name: "workspace", id: page.wsId })}
          />
        )}
      </main>
    </div>
  );
}

// ── Login ────────────────────────────────────────────────────────────────────

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [val, setVal] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      await api.ping(val);
      onLogin(val);
    } catch {
      setErr("Token 无效或服务器不可达");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>🔗 Worko</h1>
        <p>输入 Admin Token 登录看板</p>
        <div className="form-group">
          <label>WORKO_ADMIN_TOKEN</label>
          <input
            type="password"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder="输入 token…"
            autoFocus
          />
        </div>
        {err && <div className="error-msg">{err}</div>}
        <button type="submit" className="btn-primary btn-full" style={{ marginTop: 16 }} disabled={!val || loading}>
          {loading ? <span className="spin" /> : "登录"}
        </button>
      </form>
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────

function Header({ page, onNav, onLogout }: {
  page: Page;
  onNav: (p: Page) => void;
  onLogout: () => void;
}) {
  return (
    <header className="header">
      <span className="header-logo">🔗 Worko</span>
      {page.name !== "workspaces" && (
        <>
          <span className="header-sep">/</span>
          <span
            className="header-breadcrumb header-link"
            onClick={() => onNav({ name: "workspaces" })}
          >Workspaces</span>
        </>
      )}
      {page.name === "thread" && (
        <>
          <span className="header-sep">/</span>
          <span
            className="header-breadcrumb header-link"
            onClick={() => onNav({ name: "workspace", id: page.wsId })}
          >Workspace</span>
          <span className="header-sep">/</span>
          <span className="header-breadcrumb">Thread</span>
        </>
      )}
      {page.name === "workspace" && (
        <>
          <span className="header-sep">/</span>
          <span className="header-breadcrumb">Workspace</span>
        </>
      )}
      <div className="header-right">
        <button className="btn-ghost btn-sm" onClick={onLogout}>退出</button>
      </div>
    </header>
  );
}

// ── WorkspaceList ─────────────────────────────────────────────────────────────

function WorkspaceList({ token, onSelect }: { token: string; onSelect: (id: string) => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(() => {
    api.listWorkspaces(token).then((d) => { setWorkspaces(d.workspaces); setLoading(false); });
  }, [token]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <>
      <div className="section-header">
        <h1 className="page-title">Workspaces</h1>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>+ 新建</button>
      </div>
      {loading ? (
        <div className="empty-state"><span className="spin" /></div>
      ) : workspaces.length === 0 ? (
        <div className="empty-state">还没有 workspace — 点「新建」创建第一个</div>
      ) : (
        <div className="ws-grid">
          {workspaces.map((ws) => (
            <div key={ws.id} className="ws-card" onClick={() => onSelect(ws.id)}>
              <div className="ws-card-name">{ws.name}</div>
              <div className="ws-stats">
                <div className="ws-stat">
                  <span className="ws-stat-val" style={{ color: "var(--green)" }}>{ws.online_count}</span>
                  <span className="ws-stat-lbl">在线</span>
                </div>
                <div className="ws-stat">
                  <span className="ws-stat-val">{ws.member_count}</span>
                  <span className="ws-stat-lbl">成员</span>
                </div>
                <div className="ws-stat">
                  <span className="ws-stat-val" style={{ color: ws.open_threads > 0 ? "var(--yellow)" : undefined }}>
                    {ws.open_threads}
                  </span>
                  <span className="ws-stat-lbl">活跃对话</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {showCreate && (
        <CreateWorkspaceModal
          token={token}
          onDone={() => { setShowCreate(false); refresh(); }}
          onClose={() => setShowCreate(false)}
        />
      )}
    </>
  );
}

// ── CreateWorkspaceModal ──────────────────────────────────────────────────────

function CreateWorkspaceModal({ token, onDone, onClose }: {
  token: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ join_token: string; wsName: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const d = await api.createWorkspace(token, name || "Workspace");
      setResult({ join_token: d.join_token, wsName: d.workspace.name });
    } finally {
      setLoading(false);
    }
  }

  function copy() {
    if (!result) return;
    navigator.clipboard.writeText(result.join_token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {!result ? (
          <>
            <h2>新建 Workspace</h2>
            <form onSubmit={create}>
              <div className="form-group">
                <label>名称</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Team Alpha"
                  autoFocus
                />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn-ghost" onClick={onClose}>取消</button>
                <button type="submit" className="btn-primary" disabled={loading}>
                  {loading ? <span className="spin" /> : "创建"}
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            <h2>✅ Workspace 已创建</h2>
            <p style={{ color: "var(--muted)", marginBottom: 12, fontSize: 13 }}>
              把下面的 Join Token 发给团队成员，填入 <code style={{ color: "var(--accent)" }}>~/.worko/config</code> 的 <code style={{ color: "var(--accent)" }}>WORKO_TOKEN</code>。
            </p>
            <label>JOIN TOKEN — {result.wsName}</label>
            <div className="token-box">{result.join_token}</div>
            <div className="token-warn">⚠️ 此 token 只显示一次，请立即复制保存。如丢失可在 workspace 详情页重新生成（旧连接失效）。</div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={copy}>{copied ? "✓ 已复制" : "复制 Token"}</button>
              <button className="btn-primary" onClick={onDone}>完成</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
