import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2, ChevronDown, ChevronRight, Code2, FileEdit, FilePlus,
  FileSearch, FolderTree, Loader2, Settings2, Sparkles, Square,
  Trash2, Wrench, X, XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { useAIChatStore, type ChatMessage, type ToolCallView } from '@/store/aiChat'
import { AI, type DocNode, type PromptTemplate } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

interface Props {
  doc: DocNode
  onClose: () => void
  onOpenSettings: () => void
}

const SUGGESTIONS_FIRST: string[] = [
  'A product landing page: hero + feature cards + stats + timeline + CTA',
  'This week\'s report: key metric cards / completed-items timeline / next week\'s plan',
  'Team intro: member card grid + skill radar chart + contact info',
  'Meeting notes: topic / attendees / collapsible agenda / to-do list',
]
const SUGGESTIONS_FOLLOWUP: string[] = [
  'Switch the palette to warm tones (orange/ochre/cream), more modern',
  'Bump up the heading size and give paragraphs more breathing room',
  'Add a dark / light mode toggle button',
  'Make the data cards clickable, with a subtle hover animation',
]

export function AIChatPanel({ doc, onClose, onOpenSettings }: Props) {
  const {
    getMessages, appendUser, send, stop, clear, runningDocId,
  } = useAIChatStore()
  const messages = getMessages(doc.id)
  const running = runningDocId === doc.id

  const [prompt, setPrompt] = useState('')
  const [configured, setConfigured] = useState(true)
  const [prompts, setPrompts] = useState<PromptTemplate[]>([])
  const [createPromptId, setCreatePromptId] = useState<string | undefined>()
  const [editPromptId, setEditPromptId] = useState<string | undefined>()
  const [useTools, setUseTools] = useState<boolean | undefined>(undefined)

  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    AI.getSettings().then((r) => setConfigured(r.configured)).catch(() => {})
    AI.listPrompts().then((items) => {
      setPrompts(items)
      const defC = items.find((p) => p.scene === 'create' && p.isDefault)
      const defE = items.find((p) => p.scene === 'edit' && p.isDefault)
      if (defC) setCreatePromptId(defC.id)
      if (defE) setEditPromptId(defE.id)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  })

  const isFirst = messages.length === 0
  const suggestions = isFirst ? SUGGESTIONS_FIRST : SUGGESTIONS_FOLLOWUP
  const isCreateLike = messages.filter((m) => m.role === 'user').length === 0
  const activePromptId = isCreateLike ? createPromptId : editPromptId
  const activePrompt = useMemo(
    () => prompts.find((p) => p.id === activePromptId),
    [prompts, activePromptId],
  )
  const scenePrompts = useMemo(
    () => prompts.filter((p) => p.scene === (isCreateLike ? 'create' : 'edit')),
    [prompts, isCreateLike],
  )

  const submit = () => {
    const t = prompt.trim()
    if (!t || running) return
    appendUser(doc.id, t)
    setPrompt('')
    send({
      prompt: t,
      mode: isCreateLike ? 'create' : 'edit',
      docId: doc.id,
      promptId: activePromptId,
      useTools,
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault(); submit()
    }
  }

  return (
    <div className="h-full w-full flex flex-col bg-background/60">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 glass">
        <div className="h-6 w-6 rounded-md bg-gradient-to-br from-violet-500 to-pink-500 flex items-center justify-center">
          <Sparkles className="h-3.5 w-3.5 text-white" />
        </div>
        <div className="text-sm font-medium flex-1 truncate">AI Assistant</div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onOpenSettings} title="AI settings">
          <Settings2 />
        </Button>
        {messages.length > 0 && (
          <Button
            variant="ghost" size="icon" className="h-7 w-7"
            onClick={() => clear(doc.id)} disabled={running} title="Clear conversation"
          >
            <Trash2 />
          </Button>
        )}
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} title="Close">
          <X />
        </Button>
      </div>

      {/* Skill selector bar (Skill = a preset prompt template) */}
      <div className="px-3 py-2 border-b border-border/60 flex items-center gap-2 text-[11px]">
        <span className="text-muted-foreground shrink-0">
          {isCreateLike ? 'Create' : 'Edit'} · Skill
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="flex-1 inline-flex items-center justify-between gap-1 rounded border border-border/60 px-2 py-1 hover:border-primary/50 transition-colors min-w-0"
              disabled={running}
              title={activePrompt?.content}
            >
              <span className="truncate">
                {activePrompt?.name ?? (isCreateLike ? 'Default create skill' : 'Default edit skill')}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72 max-h-80 overflow-y-auto">
            <DropdownMenuLabel className="text-[11px] text-muted-foreground">
              Choose a Skill template ({isCreateLike ? 'create' : 'edit'} scenario)
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {scenePrompts.length === 0 && (
              <div className="px-2 py-2 text-xs text-muted-foreground">No templates yet</div>
            )}
            {scenePrompts.map((p) => (
              <DropdownMenuItem
                key={p.id}
                onSelect={() => isCreateLike ? setCreatePromptId(p.id) : setEditPromptId(p.id)}
                className={cn(
                  'flex flex-col items-start gap-0.5 py-1.5',
                  p.id === activePromptId && 'bg-accent',
                )}
              >
                <div className="flex items-center gap-1 w-full">
                  <span className="text-xs font-medium">{p.name}</span>
                  {p.builtin && <span className="text-[10px] text-violet-300 ml-auto">Built-in</span>}
                  {p.isDefault && <span className="text-[10px] text-emerald-400">Default</span>}
                </div>
                <span className="text-[10px] text-muted-foreground line-clamp-1 w-full">
                  {p.content.split('\n')[0]}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onOpenSettings}>
              <Settings2 className="h-3 w-3" /> Manage Skill templates…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {!isCreateLike && (
          <button
            onClick={() => setUseTools((v) => v === false ? undefined : false)}
            disabled={running}
            className={cn(
              'shrink-0 inline-flex items-center gap-1 rounded border px-1.5 py-0.5',
              useTools === false
                ? 'border-amber-500/50 text-amber-300'
                : 'border-border/60 text-muted-foreground hover:text-foreground',
            )}
            title={useTools === false
              ? 'Tool calls disabled (click to restore default; AI gets read/write/replace file access)'
              : 'Tool calls enabled by default (AI can read/write and incrementally edit files); click to switch to sending the whole document'}
          >
            <Wrench className="h-3 w-3" /> Tool
          </button>
        )}
      </div>

      {/* Config warning */}
      {!configured && (
        <div className="m-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
          ⚠️ AI is not configured yet.
          <button className="ml-2 underline text-amber-300" onClick={onOpenSettings}>
            Go to settings
          </button>
        </div>
      )}

      {/* Message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-center pt-6 pb-2">
            <div className="mx-auto h-10 w-10 rounded-xl bg-gradient-to-br from-violet-500/30 to-pink-500/30 flex items-center justify-center mb-3">
              <Sparkles className="h-5 w-5 text-violet-300" />
            </div>
            <div className="text-sm font-medium">Tell the AI what you want</div>
            <div className="text-[11px] text-muted-foreground mt-1">
              The first message creates the document; after that the AI edits files incrementally via tools
            </div>
          </div>
        )}

        {messages.map((m) => (
          <MessageBubble key={m.id} msg={m} />
        ))}
      </div>

      {/* Suggestion chips */}
      <div className="px-3 pb-2 flex flex-wrap gap-1.5">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => setPrompt(s)}
            disabled={running}
            className="text-[11px] rounded-full border border-border/60 px-2 py-0.5 hover:border-primary/60 hover:bg-accent/40 transition-colors disabled:opacity-50 max-w-full truncate"
            title={s}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Input area */}
      <div className="border-t border-border/60 p-3 space-y-2">
        <Textarea
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={isFirst
            ? 'Describe the HTML document you want…\ne.g. "A polished single-page site about XYZ"'
            : 'Keep telling the AI what to change…'}
          disabled={running}
          className="resize-none text-sm"
        />
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground flex-1">
            {running
              ? 'Generating…'
              : <>Press <kbd className="px-1 rounded bg-muted/50 border border-border/60">⌘</kbd>/<kbd className="px-1 rounded bg-muted/50 border border-border/60">Ctrl</kbd>+<kbd className="px-1 rounded bg-muted/50 border border-border/60">Enter</kbd> to send</>}
          </span>
          {running ? (
            <Button variant="destructive" size="sm" onClick={stop}>
              <Square /> Stop
            </Button>
          ) : (
            <Button
              variant="gradient" size="sm"
              onClick={submit}
              disabled={!prompt.trim() || !configured}
            >
              <Sparkles /> Send
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-3 py-2 text-sm whitespace-pre-wrap break-words shadow-sm">
          {msg.text}
        </div>
      </div>
    )
  }
  if (msg.role === 'system') {
    return (
      <div className="text-center text-[11px] text-muted-foreground">{msg.text}</div>
    )
  }

  // assistant
  const hasTools = (msg.toolCalls ?? []).length > 0
  const isToolMode = !!msg.useTools

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] rounded-2xl rounded-tl-sm bg-card/80 border border-border/60 px-3 py-2 text-sm shadow-sm w-full">
        <div className="flex items-center gap-2 mb-1.5">
          {msg.streaming ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" />
          ) : msg.error ? (
            <XCircle className="h-3.5 w-3.5 text-destructive" />
          ) : msg.aborted ? (
            <Square className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          )}
          <span className="text-xs font-medium">
            {msg.streaming
              ? (isToolMode ? 'AI is working…' : 'Generating HTML…')
              : msg.error
                ? 'Generation failed'
                : msg.aborted
                  ? 'Stopped'
                  : (isToolMode ? 'Done' : 'Generated')}
          </span>
          {!isToolMode && (
            <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
              {(msg.htmlBytes ?? 0).toLocaleString()} chars
            </span>
          )}
        </div>

        {/* Tool call section */}
        {hasTools && (
          <div className="space-y-1.5 mb-1.5">
            {(msg.toolCalls ?? []).map((tc, i) => (
              <ToolCallCard key={tc.id || i} tc={tc} />
            ))}
          </div>
        )}

        {/* Model explanation text */}
        {isToolMode && msg.text && (
          <div className="text-xs text-foreground/90 whitespace-pre-wrap break-words leading-relaxed">
            {msg.text}
          </div>
        )}

        {msg.error && (
          <div className="text-xs text-destructive break-words">{msg.error}</div>
        )}

        {!hasTools && !isToolMode && !msg.error && (
          <div className="text-[11px] text-muted-foreground rounded-md bg-muted/30 px-2 py-1.5 leading-relaxed">
            {msg.streaming
              ? '✍️ Content is being written to the file — the editor and preview on the left refresh live.'
              : '✅ HTML has been written to the file. Switch between "Code / Split / Preview" on the left to view it.'}
          </div>
        )}
      </div>
    </div>
  )
}

function ToolCallCard({ tc }: { tc: ToolCallView }) {
  const [expanded, setExpanded] = useState(false)

  // Parse args (attempt even if incomplete)
  const parsed = useMemo(() => {
    try { return JSON.parse(tc.argsBuf || '{}') } catch { return null }
  }, [tc.argsBuf])

  const Icon = (() => {
    switch (tc.name) {
      case 'list_files': return FolderTree
      case 'read_file': return FileSearch
      case 'write_file': return FilePlus
      case 'replace_in_file': return FileEdit
      default: return Code2
    }
  })()

  const status = tc.error ? 'error' : tc.done ? 'ok' : 'running'
  const StatusIcon = status === 'running'
    ? Loader2 : status === 'ok' ? CheckCircle2 : XCircle
  const statusCls = status === 'running'
    ? 'text-violet-400 animate-spin'
    : status === 'ok' ? 'text-emerald-400' : 'text-destructive'

  // One-line summary
  const oneLine = (() => {
    if (tc.summary) return tc.summary
    if (parsed?.path) return parsed.path
    return tc.argsBuf.slice(0, 60)
  })()

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-muted/40 transition-colors text-left"
      >
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <Icon className="h-3.5 w-3.5 text-violet-300 shrink-0" />
        <span className="text-[11px] font-mono text-violet-200 shrink-0">{tc.name}</span>
        <span className="text-[11px] text-muted-foreground truncate flex-1" title={oneLine}>
          {oneLine}
        </span>
        <StatusIcon className={cn('h-3.5 w-3.5 shrink-0', statusCls)} />
      </button>
      {expanded && (
        <div className="px-2 pb-2 space-y-1.5">
          {/* Args */}
          <Field label="Args">
            <pre className="text-[10px] whitespace-pre-wrap break-all bg-background/60 rounded px-2 py-1 max-h-40 overflow-y-auto leading-relaxed">
              {parsed ? JSON.stringify(parsed, null, 2) : tc.argsBuf}
            </pre>
          </Field>
          {/* Result */}
          {tc.done && (
            <Field label="Result">
              <div className={cn(
                'text-[11px] rounded px-2 py-1 break-words',
                tc.error
                  ? 'bg-destructive/15 text-destructive border border-destructive/30'
                  : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20',
              )}>
                {tc.error ?? tc.summary ?? 'ok'}
              </div>
            </Field>
          )}
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      {children}
    </div>
  )
}
