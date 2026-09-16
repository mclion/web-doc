import { useEffect, useRef, useState } from 'react'
import { Loader2, Sparkles, Square, Wand2 } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { AI, aiGenerate, type DocNode } from '@/lib/api'
import { useDocsStore } from '@/store/docs'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** parentId is used in 'create' mode; doc is used in 'edit'/'rewrite' mode */
  mode: 'create' | 'edit' | 'rewrite'
  parentId?: string | null
  doc?: DocNode | null
  onOpenSettings: () => void
}

const SUGGESTIONS_CREATE = [
  'A polished single-page product launch site: hero + feature cards + stats + timeline + CTA',
  'A weekly report with key-metric cards, a timeline of this week\'s completed items, and next week\'s plan',
  'A team page: member card grid, skill radar chart, contact info',
  'Meeting notes: topic, attendees, collapsible agenda items, highlighted decisions, a to-do list',
]
const SUGGESTIONS_EDIT = [
  'Switch the overall palette to warm tones (orange/ochre/off-white), keeping a modern look',
  'Increase the heading size and add more paragraph spacing for better readability',
  'Make the data cards clickable, with a subtle hover animation',
  'Add a dark/light mode toggle button',
]

export function AIGenerateDialog({
  open, onOpenChange, mode, parentId, doc, onOpenSettings,
}: Props) {
  const { upsertFromServer, selectDoc, loadAll } = useDocsStore()
  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [received, setReceived] = useState(0)
  const [configured, setConfigured] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<(() => void) | null>(null)

  const isCreate = mode === 'create'

  useEffect(() => {
    if (open) {
      AI.getSettings().then((r) => setConfigured(r.configured))
      setPrompt(''); setReceived(0); setError(null); setRunning(false)
    } else {
      abortRef.current?.()
    }
  }, [open])

  const start = () => {
    if (!prompt.trim()) return
    setRunning(true); setReceived(0); setError(null)

    abortRef.current = aiGenerate(
      {
        prompt: prompt.trim(),
        mode,
        docId: doc?.id,
        parentId: isCreate ? (parentId ?? null) : undefined,
      },
      {
        onMeta: async (m) => {
          // create mode: the server creates the doc immediately, so we select it early for a live preview
          if (isCreate && m.docId) {
            await loadAll()
            selectDoc(m.docId)
          }
        },
        onDelta: (t) => setReceived((n) => n + t.length),
        onDone: async () => {
          setRunning(false)
          await loadAll()
          onOpenChange(false)
        },
        onError: (msg) => {
          setError(msg)
          setRunning(false)
        },
      },
    )
  }

  const stop = () => abortRef.current?.()

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!running) onOpenChange(v) }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-violet-400" />
            {isCreate ? 'Generate a new document with AI' : 'Rewrite current document with AI'}
          </DialogTitle>
          <DialogDescription>
            {isCreate
              ? 'Describe the HTML document you want; AI will stream it out with a live preview.'
              : 'Describe the changes you want; AI will regenerate based on the current content.'}
          </DialogDescription>
        </DialogHeader>

        {!configured && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            ⚠️ AI is not configured yet.
            <button
              className="ml-2 underline text-amber-300"
              onClick={() => { onOpenChange(false); onOpenSettings() }}
            >
              Go to settings
            </button>
          </div>
        )}

        <div className="space-y-3">
          <Textarea
            rows={5}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={isCreate
              ? 'e.g. Build a polished product overview page for the Web-Doc project…'
              : 'e.g. Switch the palette to a dark, tech-inspired theme…'}
            disabled={running}
          />
          <div className="flex flex-wrap gap-1.5">
            {(isCreate ? SUGGESTIONS_CREATE : SUGGESTIONS_EDIT).map((s) => (
              <button
                key={s}
                onClick={() => setPrompt(s)}
                disabled={running}
                className="text-xs rounded-full border border-border/60 px-2.5 py-1 hover:border-primary/60 hover:bg-accent/50 transition-colors disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>

          {running && (
            <div className="rounded-md border border-violet-500/40 bg-violet-500/10 p-3 text-xs flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-300" />
              <span>Generating… {received} characters received (the preview on the left updates live)</span>
            </div>
          )}
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              ❌ {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onOpenSettings} disabled={running}>
            <Wand2 /> AI Settings
          </Button>
          <div className="flex-1" />
          {running ? (
            <Button variant="destructive" onClick={stop}>
              <Square /> Stop
            </Button>
          ) : (
            <Button variant="gradient" onClick={start} disabled={!prompt.trim() || !configured}>
              <Sparkles /> {isCreate ? 'Start generating' : 'Start rewriting'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
