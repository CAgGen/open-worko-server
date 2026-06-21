import { useState, useEffect, useCallback, useRef } from "react";
import { api, type Message, type OkfEntry } from "./api";

export default function ThreadDetail({ token, threadId, onBack }: {
  token: string;
  threadId: string;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [okfLog, setOkfLog] = useState<OkfEntry[]>([]);
  const [resolving, setResolving] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    api.getThread(token, threadId).then((d) => {
      setMessages(d.messages);
      setOkfLog(d.okf_log);
    });
  }, [token, threadId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  // Auto-scroll messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function resolve() {
    setResolving(true);
    try {
      await api.resolveThread(token, threadId);
      refresh();
    } finally {
      setResolving(false);
    }
  }

  const isResolved = messages.some((m) => m.type === "resolve");

  return (
    <>
      <div className="section-header" style={{ marginBottom: 20 }}>
        <div>
          <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 4 }}>
            <span style={{ cursor: "pointer", color: "var(--accent)" }} onClick={onBack}>← Workspace</span>
          </div>
          <h1 className="page-title" style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 15, color: "var(--muted)" }}>
            {threadId}
          </h1>
        </div>
        {!isResolved && (
          <button className="btn-danger btn-sm" onClick={resolve} disabled={resolving}>
            {resolving ? <span className="spin" /> : "标记已解决"}
          </button>
        )}
      </div>

      <div className="thread-detail">
        {/* Messages */}
        <div className="panel" style={{ maxHeight: "calc(100vh - 180px)", overflow: "auto" }}>
          <div className="panel-head">消息</div>
          <div className="messages">
            {messages.length === 0 && <div className="empty-state">暂无消息</div>}
            {messages.map((m) => <MsgBubble key={m.id} msg={m} />)}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* OKF log */}
        <div className="panel" style={{ maxHeight: "calc(100vh - 180px)", overflow: "auto" }}>
          <div className="panel-head">OKF 日志</div>
          <div className="okf-log">
            {okfLog.length === 0 && <div className="empty-state">暂无日志</div>}
            {okfLog.map((e) => <OkfRow key={`${e.thread_id}-${e.seq}`} entry={e} />)}
          </div>
        </div>
      </div>
    </>
  );
}

function MsgBubble({ msg: m }: { msg: Message }) {
  const extraClass = m.type === "ask" ? " msg-ask"
    : m.type === "answer" ? " msg-answer"
    : m.type === "resolve" ? " msg-resolve"
    : "";
  const ts = new Date(m.ts).toLocaleTimeString("zh", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const to: string[] = (() => { try { return JSON.parse(m.to || "[]"); } catch { return []; } })();
  return (
    <div className={`msg${extraClass}`}>
      <div className="msg-head">
        <span className="msg-from">{m.from}</span>
        {to.length > 0 && <span className="msg-type">→ {to.join(", ")}</span>}
        <span className="msg-type">[{m.type}]</span>
        <span className="msg-ts">{ts}</span>
      </div>
      <div className="msg-content">{m.content}</div>
    </div>
  );
}

function OkfRow({ entry: e }: { entry: OkfEntry }) {
  const ts = new Date(e.ts).toLocaleTimeString("zh", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const payload = (() => {
    try { return JSON.parse(e.payload); } catch { return e.payload; }
  })();
  const payloadStr = typeof payload === "string" ? payload
    : typeof payload === "object" ? JSON.stringify(payload).slice(0, 80)
    : String(payload);
  return (
    <div className="okf-row">
      <span className="okf-seq">{e.seq}</span>
      <span>
        <span style={{ color: "var(--muted)", marginRight: 4 }}>{ts}</span>
        <span className="okf-actor">{e.actor}</span>
        <span style={{ color: "var(--border)", margin: "0 4px" }}>·</span>
        <span className="okf-action">{e.action}</span>
        {payloadStr && <span style={{ color: "var(--muted)", marginLeft: 6 }}>{payloadStr}</span>}
      </span>
    </div>
  );
}
