// All API calls go through here. adminToken is passed explicitly (not in a global).

async function req<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

const get = <T>(path: string, token: string) => req<T>("GET", path, token);
const post = <T>(path: string, token: string, body?: unknown) => req<T>("POST", path, token, body);
const del = <T>(path: string, token: string) => req<T>("DELETE", path, token);

export type Workspace = {
  id: string; name: string; created_at: string;
  online_count: number; member_count: number; open_threads: number;
};
export type Member = { id: string; kind: string; online: number };
export type Room = { id: string; name: string; workspace_id: string };
export type Thread = {
  id: string; room_id: string; status: string;
  title: string; created_at: string; waiting_for: string | null; msg_count?: number;
};
export type Message = {
  id: string; room: string; thread: string; from: string;
  to: string; type: string; content: string; ts: string;
};
export type OkfEntry = { thread_id: string; seq: number; ts: string; actor: string; action: string; payload: string };

export const api = {
  // Verify token works (throws on 401)
  ping: (token: string) => get<{ workspaces: Workspace[] }>("/admin/workspaces", token),

  listWorkspaces: (token: string) => get<{ workspaces: Workspace[] }>("/admin/workspaces", token),

  createWorkspace: (token: string, name: string) =>
    post<{ workspace: Workspace; join_token: string; room: Room }>("/admin/workspaces", token, { name }),

  getWorkspace: (token: string, id: string) =>
    get<{ workspace: Workspace; members: Member[]; rooms: Room[]; threads: Thread[] }>(`/admin/workspaces/${id}`, token),

  deleteWorkspace: (token: string, id: string) => del<{ ok: boolean }>(`/admin/workspaces/${id}`, token),

  regenerateToken: (token: string, wsId: string) =>
    post<{ join_token: string }>(`/admin/workspaces/${wsId}/token`, token),

  addMember: (token: string, wsId: string, id: string) =>
    post<{ ok: boolean }>(`/admin/workspaces/${wsId}/members`, token, { id }),

  removeMember: (token: string, wsId: string, id: string) =>
    del<{ ok: boolean }>(`/admin/workspaces/${wsId}/members/${encodeURIComponent(id)}`, token),

  getThread: (token: string, id: string) =>
    get<{ thread: string; messages: Message[]; okf_log: OkfEntry[] }>(`/threads/${id}`, token),

  resolveThread: (token: string, id: string) =>
    post<{ ok: boolean }>(`/threads/${id}/resolve`, token),
};
