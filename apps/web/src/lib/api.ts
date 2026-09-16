import axios from 'axios'

// Deploy prefix injected at Vite build time, e.g. '/' or '/doc/'. Always ends with '/'.
// Used at runtime as the prefix for all backend paths, to support reverse-proxy subpath deployments.
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '') // strip the trailing slash for easier concatenation

/** Joins an absolute path onto the site prefix, e.g. prefixed('/api') => '/doc/api' */
export function prefixed(p: string): string {
  if (!p.startsWith('/')) p = '/' + p
  return BASE + p
}

// ---------- Auth token storage ----------
const TOKEN_KEY = 'webdoc.token'
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function setToken(t: string | null) {
  if (t) localStorage.setItem(TOKEN_KEY, t)
  else localStorage.removeItem(TOKEN_KEY)
}

export const api = axios.create({
  baseURL: prefixed('/api'),
  timeout: 30_000,
})

// Automatically attach the Bearer token
api.interceptors.request.use((cfg) => {
  const t = getToken()
  if (t) {
    cfg.headers = cfg.headers ?? {}
    ;(cfg.headers as any).Authorization = `Bearer ${t}`
  }
  return cfg
})

// On 401, clear the token and broadcast an event so a higher layer can show the login dialog
api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err?.response?.status === 401) {
      setToken(null)
      window.dispatchEvent(new CustomEvent('webdoc:unauthorized'))
    }
    return Promise.reject(err)
  },
)

// Document static-asset root path (can be swapped for a dedicated subdomain in production)
export const DOC_ASSET_BASE = prefixed('/d')
// WebSocket path
export const WS_BASE =
  (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + prefixed('/ws')

export type NodeType = 'folder' | 'doc'

export interface DocNode {
  id: string
  ownerId?: string
  parentId?: string | null
  type: NodeType
  title: string
  entryFile?: string
  sortOrder: number
  visibility: 'private' | 'public'
  sizeBytes: number
  createdAt: string
  updatedAt: string
}

export interface ShareInfo {
  id: string
  docId: string
  token: string
  createdAt: string
}

export const Nodes = {
  list: () => api.get<{ items: DocNode[] }>('/nodes').then(r => r.data.items),
  create: (payload: { parentId?: string | null; type: NodeType; title: string; html?: string }) =>
    api.post<DocNode>('/nodes', payload).then(r => r.data),
  get: (id: string) =>
    api.get<{ node: DocNode; files?: string[] }>(`/nodes/${id}`).then(r => r.data),
  update: (id: string, payload: Partial<{ title: string; parentId: string | null; visibility: string; entryFile: string }>) =>
    api.patch<DocNode>(`/nodes/${id}`, payload).then(r => r.data),
  remove: (id: string) => api.delete(`/nodes/${id}`).then(r => r.data),
}

export interface UploadZipResult {
  ok: boolean
  size: number
  hasIndex: boolean
  needsEntry: boolean
  files: string[]
}

export const Docs = {
  uploadHTML: (id: string, html: string, file = 'index.html') =>
    api.post(`/docs/${id}/html`, { html, file }).then(r => r.data),
  uploadZip: (id: string, file: File): Promise<UploadZipResult> => {
    const fd = new FormData()
    fd.append('file', file)
    return api.post<UploadZipResult>(`/docs/${id}/zip`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)
  },
  fileContent: (id: string, path = 'index.html') =>
    api.get<{ path: string; content: string }>(`/docs/${id}/file`, { params: { path } }).then(r => r.data),
  saveFile: (id: string, path: string, content: string) =>
    api.post(`/docs/${id}/file`, { path, content }).then(r => r.data),
}

export const Shares = {
  create: (docId: string) => api.post<ShareInfo>(`/docs/${docId}/share`).then(r => r.data),
  info: (token: string) =>
    api.get<{ share: ShareInfo; doc: DocNode }>(`/shares/${token}`).then(r => r.data),
}

// ---------- AI ----------

export interface AISettings {
  id: number
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  systemPrompt: string
  systemPromptCreate: string
  systemPromptEdit: string
  enableTools?: boolean | null
  maxToolRounds: number
  temperature: number
  maxTokens: number
}

export interface PromptTemplate {
  id: string
  name: string
  scene: 'create' | 'edit'
  content: string
  builtin: boolean
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

export const AI = {
  getSettings: () =>
    api.get<{ settings: AISettings; configured: boolean }>('/ai/settings').then(r => r.data),
  updateSettings: (patch: Partial<AISettings>) =>
    api.patch<AISettings>('/ai/settings', patch).then(r => r.data),
  listPrompts: (scene?: 'create' | 'edit') =>
    api.get<{ items: PromptTemplate[] }>('/ai/prompts', { params: scene ? { scene } : {} })
      .then(r => r.data.items),
  createPrompt: (p: { name: string; scene: 'create' | 'edit'; content: string; isDefault?: boolean }) =>
    api.post<PromptTemplate>('/ai/prompts', p).then(r => r.data),
  updatePrompt: (id: string, p: Partial<{ name: string; scene: 'create' | 'edit'; content: string; isDefault: boolean }>) =>
    api.patch<PromptTemplate>(`/ai/prompts/${id}`, p).then(r => r.data),
  deletePrompt: (id: string) => api.delete(`/ai/prompts/${id}`).then(r => r.data),
}

export interface AIGenerateParams {
  prompt: string
  mode: 'create' | 'rewrite' | 'edit'
  docId?: string
  parentId?: string | null
  title?: string
  promptId?: string  // optional: select a prompt template
  useTools?: boolean // optional: override the global setting
}

export interface AIToolCallView {
  id: string
  name: string
  argsBuf: string  // accumulated args string (appended live)
  ok?: boolean
  summary?: string
  error?: string
  done?: boolean
}

export interface AIGenerateHandlers {
  onMeta?: (meta: { docId: string; mode: string; title: string; useTools?: boolean }) => void
  onDelta?: (text: string) => void
  onToolCallStart?: (call: { index: number; id: string; name: string }) => void
  onToolCallArgs?: (delta: { index: number; delta: string }) => void
  onToolResult?: (r: { id: string; name: string; ok: boolean; summary: string; error?: string }) => void
  onRound?: (r: { round: number; finishReason: string; toolCalls: number }) => void
  onDone?: (data: { docId: string; bytes: number }) => void
  onError?: (msg: string) => void
}

/**
 * Parses SSE via fetch + ReadableStream.
 * Returns an abort function.
 */
export function aiGenerate(params: AIGenerateParams, handlers: AIGenerateHandlers): () => void {
  const ctrl = new AbortController()
  ;(async () => {
    try {
      const tk = getToken()
      const res = await fetch(prefixed('/api/ai/generate'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
        },
        body: JSON.stringify(params),
        signal: ctrl.signal,
      })
      if (res.status === 401) {
        setToken(null)
        window.dispatchEvent(new CustomEvent('webdoc:unauthorized'))
        handlers.onError?.('Please log in first')
        return
      }
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        handlers.onError?.(t || `HTTP ${res.status}`)
        return
      }
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // Parse SSE: events are separated by \n\n
        let idx
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const lines = raw.split('\n')
          let event = 'message'
          let data = ''
          for (const ln of lines) {
            if (ln.startsWith('event:')) event = ln.slice(6).trim()
            else if (ln.startsWith('data:')) data += ln.slice(5).trim()
          }
          if (!data) continue
          try {
            const obj = JSON.parse(data)
            if (event === 'meta') handlers.onMeta?.(obj)
            else if (event === 'delta') handlers.onDelta?.(obj.text ?? '')
            else if (event === 'tool_call_start') handlers.onToolCallStart?.(obj)
            else if (event === 'tool_call_args') handlers.onToolCallArgs?.(obj)
            else if (event === 'tool_result') handlers.onToolResult?.(obj)
            else if (event === 'round') handlers.onRound?.(obj)
            else if (event === 'done') handlers.onDone?.(obj)
            else if (event === 'error') handlers.onError?.(obj.message || 'Generation failed')
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') handlers.onError?.(e?.message ?? String(e))
    }
  })()
  return () => ctrl.abort()
}

// ---------- Drag-and-drop reorder ----------

export interface ReorderItem {
  id: string
  parentId: string | null
  sortOrder: number
}
export const NodesReorder = {
  batch: (items: ReorderItem[]) =>
    api.patch('/nodes/reorder/batch', { items }).then(r => r.data),
}

// ---------- MCP ----------

export interface MCPToken {
  id: string
  name: string
  token: string // masked in list responses; the create endpoint returns the full plaintext token
  lastUsedAt?: string | null
  createdAt: string
}

export const MCP = {
  listTokens: () =>
    api.get<{ items: MCPToken[] }>('/mcp/tokens').then(r => r.data.items),
  createToken: (name?: string) =>
    api.post<MCPToken>('/mcp/tokens', { name: name ?? 'default' }).then(r => r.data),
  deleteToken: (id: string) =>
    api.delete(`/mcp/tokens/${id}`).then(r => r.data),
}

/** MCP server endpoint (same-origin as the current site by default, with the deploy prefix applied automatically) */
export function mcpEndpoint(): string {
  return location.origin + prefixed('/mcp')
}

// ---------- Auth ----------

export interface AuthUser {
  id: string
  username: string
  email?: string
  displayName?: string
  role: 'admin' | 'user'
  createdAt?: string
}

export const Auth = {
  publicInfo: () =>
    api.get<{ registerEnabled: boolean }>('/auth/public-info').then(r => r.data),
  register: (p: { username: string; password: string; email?: string; displayName?: string }) =>
    api.post<{ user: AuthUser; token: string }>('/auth/register', p).then(r => r.data),
  login: (p: { username: string; password: string }) =>
    api.post<{ user: AuthUser; token: string }>('/auth/login', p).then(r => r.data),
  me: () => api.get<{ user: AuthUser }>('/auth/me').then(r => r.data.user),
}

// ---------- Admin ----------

export const Admin = {
  listUsers: () =>
    api.get<{ items: AuthUser[] }>('/admin/users').then(r => r.data.items),
  createUser: (p: { username: string; password: string; email?: string; displayName?: string; role?: 'admin' | 'user' }) =>
    api.post<{ user: AuthUser }>('/admin/users', p).then(r => r.data.user),
  updateUser: (id: string, patch: Partial<{ role: 'admin' | 'user'; displayName: string; email: string; password: string }>) =>
    api.patch<{ user: AuthUser }>(`/admin/users/${id}`, patch).then(r => r.data.user),
  deleteUser: (id: string) => api.delete(`/admin/users/${id}`).then(r => r.data),
}
