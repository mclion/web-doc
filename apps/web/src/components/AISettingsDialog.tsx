import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2, Check, Copy, FilePlus, Plug, Plus, Save, Star, StarOff,
  Trash2, Wand2, Wrench,
} from 'lucide-react'
import { AI, MCP, mcpEndpoint, type AISettings, type MCPToken, type PromptTemplate } from '@/lib/api'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { cn, copyToClipboard } from '@/lib/utils'

const PRESETS = [
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k' },
  { name: 'Zhipu GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { name: 'Alibaba Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.5-sonnet' },
  { name: 'Custom', baseUrl: '', model: '' },
]

export function AISettingsDialog({
  open, onOpenChange,
}: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [s, setS] = useState<AISettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'connection' | 'skills' | 'mcp'>('connection')

  useEffect(() => {
    if (open) AI.getSettings().then((r) => setS(r.settings))
  }, [open])

  if (!s) return null

  const set = <K extends keyof AISettings>(k: K, v: AISettings[K]) => setS({ ...s, [k]: v })
  const applyPreset = (p: typeof PRESETS[number]) => setS({ ...s, baseUrl: p.baseUrl, model: p.model })

  const save = async () => {
    setBusy(true)
    try {
      const apiKey = s.apiKey?.includes('•') ? '' : s.apiKey
      await AI.updateSettings({ ...s, apiKey })
      onOpenChange(false)
    } catch (e: any) {
      alert(e?.response?.data?.error ?? e?.message ?? 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-5 w-5 text-violet-400" /> AI Settings
          </DialogTitle>
          <DialogDescription>
            Compatible with the OpenAI Chat Completions protocol.
            <b className="text-foreground">Skill</b> is a prebuilt prompt (scene template),
            <b className="text-foreground">Tool</b> is the file read/write capability the AI actually calls (list_files / read_file / write_file / replace_in_file).
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
          <TabsList className="w-full justify-start">
            <TabsTrigger value="connection">Connection / Model</TabsTrigger>
            <TabsTrigger value="skills">Skill Management</TabsTrigger>
            <TabsTrigger value="mcp">MCP Access</TabsTrigger>
          </TabsList>

          {/* ---------------- Connection ---------------- */}
          <TabsContent value="connection" className="space-y-4 py-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">Provider presets</label>
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((p) => (
                  <button
                    key={p.name}
                    onClick={() => applyPreset(p)}
                    className="text-xs rounded border border-border/60 px-2 py-1 hover:border-primary/60 hover:bg-accent/50 transition-colors"
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>

            <Field label="Base URL" hint="Base URL of an OpenAI-compatible API">
              <Input value={s.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://api.openai.com/v1" />
            </Field>

            <Field label="API Key" hint="Stored on the local server, never uploaded to a third party">
              <Input type="password" value={s.apiKey} onChange={(e) => set('apiKey', e.target.value)} placeholder="sk-..." />
            </Field>

            <Field label="Model">
              <Input value={s.model} onChange={(e) => set('model', e.target.value)} placeholder="gpt-4o-mini" />
            </Field>

            <div className="grid grid-cols-3 gap-3">
              <Field label="Temperature">
                <Input
                  type="number" step="0.1" min="0" max="2"
                  value={s.temperature}
                  onChange={(e) => set('temperature', Number(e.target.value))}
                />
              </Field>
              <Field label="Max Tokens">
                <Input
                  type="number" min="256"
                  value={s.maxTokens}
                  onChange={(e) => set('maxTokens', Number(e.target.value))}
                />
              </Field>
              <Field label="Tool Rounds">
                <Input
                  type="number" min="1" max="20"
                  value={s.maxToolRounds}
                  onChange={(e) => set('maxToolRounds', Number(e.target.value))}
                />
              </Field>
            </div>

            <div className="rounded-md border border-border/60 p-3 flex items-start gap-3">
              <Wrench className="h-4 w-4 text-violet-400 mt-0.5" />
              <div className="flex-1">
                <div className="text-sm font-medium">Enable Tool Calling (rewrite scene)</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  When enabled, the AI reads and edits files as needed via the list_files / read_file / write_file / replace_in_file
                  tools while rewriting a document, instead of feeding the whole document to the model. Only takes effect with an OpenAI-compatible model that supports function calling.
                </div>
              </div>
              <input
                type="checkbox"
                checked={s.enableTools !== false}
                onChange={(e) => set('enableTools', e.target.checked)}
                className="mt-1 h-4 w-4 accent-violet-500"
              />
            </div>
          </TabsContent>

          {/* ---------------- Skill management (Prompt templates) ---------------- */}
          <TabsContent value="skills" className="py-3">
            <PromptManager />
          </TabsContent>

          {/* ---------------- MCP access ---------------- */}
          <TabsContent value="mcp" className="py-3">
            <MCPPanel />
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          {tab === 'connection' && (
            <Button variant="gradient" onClick={save} disabled={busy}>
              <Save /> {busy ? 'Saving…' : 'Save'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-muted-foreground mb-1.5 block">{label}</label>
      {children}
      {hint && <div className="text-[10px] text-muted-foreground/70 mt-1">{hint}</div>}
    </div>
  )
}

// ===================== Skill management (based on Prompt templates) =====================
// A Skill is a set of prebuilt prompt templates (grouped by scene: create / edit).
// It's a separate concept from Tool: a Tool is the actual file-writing capability the AI calls.

function PromptManager() {
  const [items, setItems] = useState<PromptTemplate[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editing, setEditing] = useState<PromptTemplate | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = async () => {
    const list = await AI.listPrompts()
    setItems(list)
    if (!activeId && list.length) setActiveId(list[0].id)
  }
  useEffect(() => { reload() /* eslint-disable-next-line */ }, [])

  useEffect(() => {
    if (!activeId) { setEditing(null); return }
    const found = items.find((i) => i.id === activeId)
    if (found) setEditing({ ...found })
  }, [activeId, items])

  const grouped = useMemo(() => ({
    create: items.filter((i) => i.scene === 'create'),
    edit: items.filter((i) => i.scene === 'edit'),
  }), [items])

  const newPrompt = (scene: 'create' | 'edit') => {
    setEditing({
      id: '__new__',
      name: scene === 'create' ? 'New create template' : 'New edit template',
      scene,
      content: '',
      builtin: false,
      isDefault: false,
      createdAt: '',
      updatedAt: '',
    })
    setActiveId(null)
  }

  const saveCurrent = async () => {
    if (!editing) return
    setBusy(true)
    try {
      let saved: PromptTemplate
      if (editing.id === '__new__') {
        saved = await AI.createPrompt({
          name: editing.name, scene: editing.scene,
          content: editing.content, isDefault: editing.isDefault,
        })
      } else {
        saved = await AI.updatePrompt(editing.id, {
          name: editing.name, scene: editing.scene,
          content: editing.content, isDefault: editing.isDefault,
        })
      }
      await reload()
      setActiveId(saved.id)
    } catch (e: any) {
      alert(e?.response?.data?.error ?? e?.message ?? 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  const removeCurrent = async () => {
    if (!editing || editing.builtin || editing.id === '__new__') return
    if (!confirm(`Delete Skill "${editing.name}"?`)) return
    setBusy(true)
    try {
      await AI.deletePrompt(editing.id)
      await reload()
      setActiveId(items[0]?.id ?? null)
    } catch (e: any) {
      alert(e?.response?.data?.error ?? e?.message ?? 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-[220px_1fr] gap-3 h-[480px] min-h-0">
      {/* List */}
      <div className="border border-border/60 rounded-md overflow-hidden flex flex-col min-h-0">
        <div className="p-2 border-b border-border/60 flex items-center gap-1">
          <Button variant="ghost" size="sm" className="flex-1 h-7 text-xs" onClick={() => newPrompt('create')}>
            <FilePlus /> New create Skill
          </Button>
          <Button variant="ghost" size="sm" className="flex-1 h-7 text-xs" onClick={() => newPrompt('edit')}>
            <FilePlus /> New edit Skill
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          <Group label="Create-scene Skills" list={grouped.create} activeId={activeId} onSelect={setActiveId} />
          <Group label="Edit-scene Skills" list={grouped.edit} activeId={activeId} onSelect={setActiveId} />
        </div>
      </div>

      {/* Editor */}
      <div className="flex flex-col min-h-0">
        {editing ? (
          <div className="flex-1 flex flex-col gap-2 min-h-0">
            <div className="flex items-center gap-2">
              <Input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                disabled={editing.builtin}
                className="text-sm"
              />
              <select
                value={editing.scene}
                onChange={(e) => setEditing({ ...editing, scene: e.target.value as any })}
                disabled={editing.builtin}
                className="bg-background border border-border/60 rounded h-9 px-2 text-xs"
              >
                <option value="create">Create</option>
                <option value="edit">Edit</option>
              </select>
              <Button
                variant={editing.isDefault ? 'gradient' : 'ghost'}
                size="sm" className="h-9 text-xs"
                onClick={() => setEditing({ ...editing, isDefault: !editing.isDefault })}
                title={editing.isDefault ? 'Currently default' : 'Set as default'}
              >
                {editing.isDefault ? <Star /> : <StarOff />}
                {editing.isDefault ? 'Default' : 'Set default'}
              </Button>
            </div>
            <Textarea
              rows={18}
              value={editing.content}
              onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              className="font-mono text-xs flex-1 resize-none"
              placeholder="Enter prompt content…"
            />
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground flex-1">
                {editing.builtin
                  ? 'Built-in template: name/content can be edited; cannot be deleted.'
                  : 'Custom template'}
              </span>
              {!editing.builtin && editing.id !== '__new__' && (
                <Button variant="ghost" size="sm" onClick={removeCurrent} disabled={busy}>
                  <Trash2 /> Delete
                </Button>
              )}
              <Button variant="gradient" size="sm" onClick={saveCurrent} disabled={busy}>
                <Save /> {busy ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
            Select a template on the left to edit, or click "+ New create / edit" to create one.
          </div>
        )}
      </div>
    </div>
  )
}

function Group({
  label, list, activeId, onSelect,
}: {
  label: string
  list: PromptTemplate[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  if (list.length === 0) return null
  return (
    <div className="px-1.5 py-1">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-1.5 py-1">
        {label}
      </div>
      <div className="space-y-0.5">
        {list.map((p) => (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            className={cn(
              'w-full text-left rounded px-2 py-1.5 transition-colors flex items-center gap-1.5',
              activeId === p.id ? 'bg-accent text-foreground' : 'hover:bg-muted/50',
            )}
          >
            <span className="text-xs truncate flex-1">{p.name}</span>
            {p.isDefault && <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />}
            {p.builtin && <span className="text-[10px] text-violet-300 shrink-0">built-in</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

// ===================== MCP access panel =====================

function MCPPanel() {
  const endpoint = mcpEndpoint()
  const [tokens, setTokens] = useState<MCPToken[]>([])
  const [busy, setBusy] = useState(false)
  const [newName, setNewName] = useState('default')
  // The newly generated plaintext token is only shown once
  const [revealed, setRevealed] = useState<MCPToken | null>(null)
  const [copied, setCopied] = useState<string>('')

  const reload = async () => {
    try {
      const items = await MCP.listTokens()
      setTokens(items)
    } catch (e: any) {
      // ignore
    }
  }
  useEffect(() => { reload() }, [])

  const create = async () => {
    setBusy(true)
    try {
      const t = await MCP.createToken(newName.trim() || 'default')
      setRevealed(t)
      await reload()
    } catch (e: any) {
      alert(e?.response?.data?.error ?? e?.message ?? 'Create failed')
    } finally {
      setBusy(false)
    }
  }
  const remove = async (id: string) => {
    if (!confirm('Delete this token? Any client still using it will stop working.')) return
    setBusy(true)
    try {
      await MCP.deleteToken(id)
      await reload()
    } catch (e: any) {
      alert(e?.response?.data?.error ?? e?.message ?? 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  const copy = async (key: string, text: string) => {
    const ok = await copyToClipboard(text)
    if (ok) {
      setCopied(key)
      setTimeout(() => setCopied(''), 1500)
    } else {
      // Fallback: on HTTP or other environments without Clipboard API access, prompt the user to copy manually
      window.prompt('Copy failed — please copy manually with Ctrl/Cmd+C:', text)
    }
  }

  // Token used in the config example: prefer the just-generated plaintext, otherwise prompt the user to create one first
  const tokenForExample = revealed?.token ?? '<YOUR_TOKEN>'

  // Cursor / Claude Desktop / Cline config example: bridged via mcp-remote
  const remoteJSON = JSON.stringify({
    mcpServers: {
      'web-doc': {
        command: 'npx',
        args: ['-y', 'mcp-remote', endpoint, '--header', `Authorization: Bearer ${tokenForExample}`],
      },
    },
  }, null, 2)

  // Direct connection (some clients natively support Streamable HTTP)
  const directJSON = JSON.stringify({
    mcpServers: {
      'web-doc': {
        url: endpoint,
        headers: { Authorization: `Bearer ${tokenForExample}` },
      },
    },
  }, null, 2)

  return (
    <div className="space-y-4">
      {/* Endpoint info */}
      <div className="rounded-md border border-border/60 p-3">
        <div className="flex items-center gap-2 mb-2">
          <Plug className="h-4 w-4 text-violet-400" />
          <div className="text-sm font-medium">MCP server endpoint</div>
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 bg-muted/40 rounded px-2 py-1.5 text-xs font-mono break-all">
            {endpoint}
          </code>
          <Button variant="ghost" size="sm" onClick={() => copy('ep', endpoint)}>
            {copied === 'ep' ? <Check /> : <Copy />}
          </Button>
        </div>
        <div className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
          Based on the <a className="underline hover:text-foreground" href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer">Model Context Protocol</a>{' '}
          Streamable HTTP transport (JSON-RPC 2.0), so an AI agent can read/create/update documents directly.
          <br />Auth: HTTP header <code className="font-mono">Authorization: Bearer &lt;token&gt;</code>
        </div>
      </div>

      {/* Token management */}
      <div className="rounded-md border border-border/60 p-3">
        <div className="text-sm font-medium mb-2">Access tokens</div>

        <div className="flex items-center gap-2 mb-3">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Give the token a name (e.g. cursor-mac)"
            className="flex-1 h-9 text-xs"
          />
          <Button variant="gradient" size="sm" onClick={create} disabled={busy}>
            <Plus /> Generate token
          </Button>
        </div>

        {/* Plaintext display (only right after creation) */}
        {revealed && (
          <div className="rounded border border-emerald-500/40 bg-emerald-500/5 p-2.5 mb-3">
            <div className="text-[11px] text-emerald-300 mb-1">
              ⚠️ This is the plaintext token, <b>shown only this once</b> — copy and save it now:
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-background/40 rounded px-2 py-1 text-xs font-mono break-all">
                {revealed.token}
              </code>
              <Button variant="ghost" size="sm" onClick={() => copy('plain', revealed.token)}>
                {copied === 'plain' ? <Check /> : <Copy />}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setRevealed(null)}>Close</Button>
            </div>
          </div>
        )}

        {/* List */}
        <div className="space-y-1">
          {tokens.length === 0 && (
            <div className="text-xs text-muted-foreground py-2">No tokens created yet.</div>
          )}
          {tokens.map((t) => (
            <div key={t.id} className="flex items-center gap-2 px-2 py-1.5 rounded bg-muted/30">
              <span className="text-xs flex-1 truncate">{t.name}</span>
              <code className="text-[11px] font-mono text-muted-foreground">{t.token}</code>
              <span className="text-[10px] text-muted-foreground">
                {t.lastUsedAt
                  ? `Used · ${new Date(t.lastUsedAt).toLocaleDateString()}`
                  : 'Unused'}
              </span>
              <Button variant="ghost" size="sm" onClick={() => remove(t.id)} disabled={busy}>
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      </div>

      {/* Client config examples */}
      <div className="rounded-md border border-border/60 p-3 space-y-3">
        <div className="text-sm font-medium">Client configuration</div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-xs">
              Option A: <b>mcp-remote bridge</b> (recommended / works with Claude Desktop · Cursor · Cline)
            </div>
            <Button variant="ghost" size="sm" onClick={() => copy('remote', remoteJSON)}>
              {copied === 'remote' ? <Check /> : <Copy />} Copy
            </Button>
          </div>
          <pre className="bg-muted/40 rounded p-2 text-[11px] font-mono overflow-auto max-h-48 whitespace-pre">
{remoteJSON}
          </pre>
          <div className="text-[10px] text-muted-foreground mt-1">
            Add to Claude Desktop's <code>claude_desktop_config.json</code> or Cursor's <code>~/.cursor/mcp.json</code>. Requires Node.js.
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-xs">
              Option B: <b>Direct connection</b> (clients that support Streamable HTTP)
            </div>
            <Button variant="ghost" size="sm" onClick={() => copy('direct', directJSON)}>
              {copied === 'direct' ? <Check /> : <Copy />} Copy
            </Button>
          </div>
          <pre className="bg-muted/40 rounded p-2 text-[11px] font-mono overflow-auto max-h-40 whitespace-pre">
{directJSON}
          </pre>
        </div>

        {!revealed && (
          <div className="text-[11px] text-amber-400/90">
            Note: replace <code>&lt;YOUR_TOKEN&gt;</code> in the examples above with the plaintext you got when creating a token.
          </div>
        )}
      </div>

      {/* Tool list */}
      <div className="rounded-md border border-border/60 p-3">
        <div className="text-sm font-medium mb-2">Available tools</div>
        <ul className="text-[11px] text-muted-foreground space-y-1 leading-relaxed">
          <li><code className="font-mono text-foreground">list_documents</code> — list all documents/folders</li>
          <li><code className="font-mono text-foreground">get_document</code> — get a document's metadata and file manifest</li>
          <li><code className="font-mono text-foreground">read_document_file</code> — read the text of a file inside a document</li>
          <li><code className="font-mono text-foreground">create_document</code> — create a new document/folder</li>
          <li><code className="font-mono text-foreground">upload_html</code> — write/overwrite a single HTML file</li>
          <li><code className="font-mono text-foreground">upload_zip_base64</code> — upload a base64-encoded zip of the whole site</li>
          <li><code className="font-mono text-foreground">delete_document</code> — delete a document/folder</li>
        </ul>
      </div>
    </div>
  )
}
