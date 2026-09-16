import { useState } from 'react'
import { Code2, FileText, FileUp, Folder, Sparkles, Upload } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { useDocsStore } from '@/store/docs'
import { Docs } from '@/lib/api'
import { cn } from '@/lib/utils'

type Mode = 'choose' | 'paste' | 'upload-html' | 'upload-zip' | 'folder' | 'pick-entry'

export function CreateDocDialog({
  open, onOpenChange, parentId, onAITrigger,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  parentId: string | null
  onAITrigger?: (parentId: string | null) => void
}) {
  const { createNode, updateNode, selectDoc } = useDocsStore()
  const [mode, setMode] = useState<Mode>('choose')
  const [title, setTitle] = useState('')
  const [html, setHtml] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)

  // Entry-file picker state
  const [pickFiles, setPickFiles] = useState<string[]>([])
  const [pickDocId, setPickDocId] = useState<string | null>(null)
  const [pickValue, setPickValue] = useState<string>('')

  const reset = () => {
    setMode('choose'); setTitle(''); setHtml(''); setFile(null); setBusy(false)
    setPickFiles([]); setPickDocId(null); setPickValue('')
  }

  const submit = async () => {
    setBusy(true)
    try {
      if (mode === 'folder') {
        await createNode({ parentId, type: 'folder', title: title || 'New Folder' })
      } else if (mode === 'paste') {
        await createNode({ parentId, type: 'doc', title: title || 'Untitled Document', html })
      } else if (mode === 'upload-html' && file) {
        const text = await file.text()
        await createNode({
          parentId,
          type: 'doc',
          title: title || file.name.replace(/\.html?$/i, ''),
          html: text,
        })
      } else if (mode === 'upload-zip' && file) {
        const node = await createNode({
          parentId,
          type: 'doc',
          title: title || file.name.replace(/\.zip$/i, ''),
        })
        const res = await Docs.uploadZip(node.id, file)
        if (res.needsEntry && res.files && res.files.length > 0) {
          // Let the user pick an entry file, stay in the dialog for now
          // Sort .html / .htm to the front
          const sorted = [...res.files].sort((a, b) => {
            const ah = /\.html?$/i.test(a) ? 0 : 1
            const bh = /\.html?$/i.test(b) ? 0 : 1
            if (ah !== bh) return ah - bh
            return a.localeCompare(b)
          })
          const firstHTML = sorted.find((f) => /\.html?$/i.test(f)) ?? sorted[0]
          setPickFiles(sorted)
          setPickDocId(node.id)
          setPickValue(firstHTML)
          setMode('pick-entry')
          setBusy(false)
          return
        }
      } else if (mode === 'pick-entry' && pickDocId && pickValue) {
        await updateNode(pickDocId, { entryFile: pickValue })
        selectDoc(pickDocId)
      }
      onOpenChange(false)
      setTimeout(reset, 200)
    } catch (e: any) {
      alert(e?.response?.data?.error ?? e?.message ?? 'Operation failed')
    } finally {
      setBusy(false)
    }
  }

  // Cancel entry-file pick: keep the document but return to the choose view and close the dialog
  const cancelPickEntry = async () => {
    if (pickDocId) {
      // Make sure the user has at least one previewable entry (use the first in the list)
      if (pickFiles.length > 0) {
        await updateNode(pickDocId, { entryFile: pickFiles[0] }).catch(() => {})
      }
      selectDoc(pickDocId)
    }
    onOpenChange(false)
    setTimeout(reset, 200)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setTimeout(reset, 200) }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {mode === 'pick-entry' ? 'Choose entry file' : 'Create new content'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'pick-entry'
              ? 'No index.html was found in the uploaded archive — pick a file below to use as the preview entry.'
              : (parentId ? 'Will be created in the current folder' : 'Will be created at the root')}
          </DialogDescription>
        </DialogHeader>

        {mode === 'choose' && (
          <div className="grid grid-cols-2 gap-3 pt-1">
            <ModeCard icon={<Folder />} title="New folder" desc="Organize the document tree" onClick={() => setMode('folder')} />
            <ModeCard icon={<Code2 />} title="Paste HTML" desc="Create by pasting source directly" onClick={() => setMode('paste')} />
            <ModeCard icon={<FileUp />} title="Upload .html" desc="A single HTML file" onClick={() => setMode('upload-html')} />
            <ModeCard icon={<Upload />} title="Upload .zip" desc="Multi-file HTML project" onClick={() => setMode('upload-zip')} />
            <ModeCard
              icon={<Sparkles />} title="AI generate" desc="Stream-generate polished HTML"
              accent
              onClick={() => {
                onOpenChange(false)
                setTimeout(() => onAITrigger?.(parentId), 150)
              }}
            />
          </div>
        )}

        {mode === 'folder' && (
          <div className="space-y-3">
            <label className="text-sm">Folder name</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New Folder" autoFocus />
          </div>
        )}

        {mode === 'paste' && (
          <div className="space-y-3">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Document title" />
            <Textarea
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              rows={10}
              placeholder={'<!doctype html>\n<html>...</html>'}
              className="font-mono text-xs"
            />
          </div>
        )}

        {mode === 'upload-html' && (
          <div className="space-y-3">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Document title (optional, defaults to the file name)" />
            <FilePicker accept=".html,.htm" file={file} onFile={setFile} hint="Choose an HTML file" />
          </div>
        )}

        {mode === 'upload-zip' && (
          <div className="space-y-3">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Document title (optional, defaults to the file name)" />
            <FilePicker accept=".zip" file={file} onFile={setFile} hint="Choose a ZIP (must contain an index.html entry)" />
          </div>
        )}

        {mode === 'pick-entry' && (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">
              {pickFiles.length} files total, HTML files sorted first:
            </div>
            <div className="max-h-72 overflow-y-auto rounded-md border border-border/60 divide-y divide-border/40">
              {pickFiles.map((f) => {
                const isHtml = /\.html?$/i.test(f)
                const active = f === pickValue
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setPickValue(f)}
                    className={cn(
                      'w-full flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
                      active ? 'bg-primary/10 text-primary' : 'hover:bg-accent/40',
                    )}
                  >
                    <FileText className={cn('h-3.5 w-3.5 shrink-0', isHtml ? 'text-primary' : 'text-muted-foreground')} />
                    <span className="truncate">{f}</span>
                    {isHtml && <span className="ml-auto text-[10px] rounded bg-primary/10 text-primary px-1.5 py-0.5">HTML</span>}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <DialogFooter>
          {mode === 'pick-entry' ? (
            <>
              <Button variant="ghost" onClick={cancelPickEntry} disabled={busy}>Skip</Button>
              <Button variant="gradient" onClick={submit} disabled={busy || !pickValue}>
                {busy ? 'Saving…' : 'Use this file as entry'}
              </Button>
            </>
          ) : (
            <>
              {mode !== 'choose' && (
                <Button variant="ghost" onClick={() => setMode('choose')} disabled={busy}>Back</Button>
              )}
              {mode !== 'choose' && (
                <Button
                  variant="gradient"
                  onClick={submit}
                  disabled={
                    busy ||
                    (mode === 'upload-html' && !file) ||
                    (mode === 'upload-zip' && !file)
                  }
                >
                  {busy ? 'Processing…' : 'Create'}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ModeCard({
  icon, title, desc, onClick, disabled, accent,
}: {
  icon: React.ReactNode; title: string; desc: string
  onClick: () => void; disabled?: boolean; accent?: boolean
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={cn(
        'group relative flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-all',
        'border-border/60 hover:border-primary/60 hover:bg-accent/50',
        disabled && 'opacity-50 cursor-not-allowed hover:border-border/60 hover:bg-transparent',
        accent && 'border-violet-500/40 bg-violet-500/5 hover:border-violet-500 hover:bg-violet-500/10',
      )}
    >
      <div className={cn(
        'rounded-md p-2 [&>svg]:h-4 [&>svg]:w-4',
        accent ? 'bg-gradient-to-br from-blue-500 to-violet-500 text-white' : 'bg-primary/10 text-primary',
      )}>
        {icon}
      </div>
      <div className="font-medium text-sm">{title}</div>
      <div className="text-xs text-muted-foreground">{desc}</div>
      {disabled && (
        <span className="absolute right-2 top-2 text-[10px] rounded bg-muted px-1.5 py-0.5">
          Soon
        </span>
      )}
      {accent && (
        <span className="absolute right-2 top-2 text-[10px] rounded bg-violet-500/20 text-violet-300 px-1.5 py-0.5">
          NEW
        </span>
      )}
    </button>
  )
}

function FilePicker({
  accept, file, onFile, hint,
}: { accept: string; file: File | null; onFile: (f: File | null) => void; hint: string }) {
  return (
    <label
      className={cn(
        'block cursor-pointer rounded-lg border-2 border-dashed border-border/60 p-6 text-center transition-colors',
        'hover:border-primary/60 hover:bg-accent/30',
      )}
    >
      <input
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
      />
      {file ? (
        <div className="text-sm">
          <div className="font-medium">{file.name}</div>
          <div className="text-xs text-muted-foreground mt-1">{(file.size / 1024).toFixed(1)} KB · click to choose a different file</div>
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">
          <Upload className="mx-auto h-6 w-6 mb-2 opacity-60" />
          {hint}
        </div>
      )}
    </label>
  )
}
