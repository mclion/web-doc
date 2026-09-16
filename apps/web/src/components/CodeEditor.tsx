import { useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { CheckCircle2, Loader2, Save } from 'lucide-react'
import { Docs, type DocNode } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Props {
  doc: DocNode
  filePath: string
  /** Bump to trigger an external refetch of the file content (e.g. WebSocket reload, AI streaming writes) */
  externalReloadKey?: number
  onSavedExternally?: () => void  // triggers a preview refresh after a successful save
}

type Status = 'idle' | 'loading' | 'dirty' | 'saving' | 'saved' | 'error'

function inferLang(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'html':
    case 'htm': return 'html'
    case 'css': return 'css'
    case 'js':
    case 'mjs': return 'javascript'
    case 'json': return 'json'
    case 'md': return 'markdown'
    case 'svg':
    case 'xml': return 'xml'
    default: return 'plaintext'
  }
}

export function CodeEditor({ doc, filePath, externalReloadKey, onSavedExternally }: Props) {
  const [content, setContent] = useState('')
  const [status, setStatus] = useState<Status>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const dirtyRef = useRef(false)
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)

  // Load the file (reload when doc/filePath changes)
  useEffect(() => {
    setStatus('loading')
    setErrorMsg(null)
    Docs.fileContent(doc.id, filePath)
      .then((r) => {
        setContent(r.content)
        dirtyRef.current = false
        setStatus('saved')
      })
      .catch((e) => {
        setErrorMsg(e?.response?.data?.error ?? 'Failed to load')
        setStatus('error')
      })
  }, [doc.id, filePath])

  // External changes (AI streaming writes, folder hot-reload) trigger a reread.
  // Only overwrites when not dirty, so we don't interrupt the user's edits. dirtyRef is false during AI streaming, so it gets overwritten live.
  useEffect(() => {
    if (externalReloadKey === undefined) return
    if (dirtyRef.current) return
    Docs.fileContent(doc.id, filePath)
      .then((r) => {
        setContent(r.content)
        setStatus('saved')
      })
      .catch(() => { /* ignore */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalReloadKey])

  const save = async () => {
    if (!dirtyRef.current && status !== 'dirty') return
    setStatus('saving')
    try {
      await Docs.saveFile(doc.id, filePath, content)
      dirtyRef.current = false
      setStatus('saved')
      onSavedExternally?.()
    } catch (e: any) {
      setErrorMsg(e?.response?.data?.error ?? e?.message ?? 'Failed to save')
      setStatus('error')
    }
  }

  // Cmd/Ctrl+S to save
  const handleMount: OnMount = (ed, monaco) => {
    editorRef.current = ed
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveRef.current()
    })
  }
  const saveRef = useRef(save)
  saveRef.current = save

  return (
    <div className="flex h-full w-full flex-col bg-[#1e1e1e]">
      <div className="flex items-center justify-between border-b border-border/40 bg-card/40 px-3 py-1.5 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-muted-foreground">{filePath}</span>
          <StatusBadge status={status} error={errorMsg} />
        </div>
        <button
          onClick={save}
          disabled={status === 'saving' || status === 'loading'}
          className={cn(
            'inline-flex items-center gap-1 rounded px-2 py-0.5 transition-colors',
            'hover:bg-accent disabled:opacity-50',
          )}
        >
          <Save className="h-3 w-3" /> Save <kbd className="ml-1 text-[10px] opacity-60">⌘S</kbd>
        </button>
      </div>

      <div className="flex-1 min-h-0">
        <Editor
          height="100%"
          theme="vs-dark"
          language={inferLang(filePath)}
          value={content}
          onChange={(v) => {
            setContent(v ?? '')
            dirtyRef.current = true
            setStatus('dirty')
          }}
          onMount={handleMount}
          options={{
            fontSize: 13,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            automaticLayout: true,
            padding: { top: 8 },
            renderLineHighlight: 'gutter',
            smoothScrolling: true,
            cursorBlinking: 'smooth',
          }}
        />
      </div>
    </div>
  )
}

function StatusBadge({ status, error }: { status: Status; error: string | null }) {
  if (status === 'loading') return <Inline icon={<Loader2 className="h-3 w-3 animate-spin" />} text="Loading" />
  if (status === 'saving')  return <Inline icon={<Loader2 className="h-3 w-3 animate-spin" />} text="Saving" />
  if (status === 'saved')   return <Inline icon={<CheckCircle2 className="h-3 w-3 text-emerald-500" />} text="Saved" />
  if (status === 'dirty')   return <Inline icon={<span className="h-1.5 w-1.5 rounded-full bg-amber-400" />} text="Unsaved" />
  if (status === 'error')   return <span className="text-destructive">{error ?? 'Error'}</span>
  return null
}
function Inline({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <span className="inline-flex items-center gap-1 text-muted-foreground">{icon}{text}</span>
}
