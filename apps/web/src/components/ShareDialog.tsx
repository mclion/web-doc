import { useEffect, useState } from 'react'
import { Check, Copy, Link } from 'lucide-react'
import { Shares, type DocNode } from '@/lib/api'
import { copyToClipboard } from '@/lib/utils'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ShareDialog({
  doc, open, onOpenChange,
}: {
  doc: DocNode | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [token, setToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (open && doc) {
      Shares.create(doc.id).then((s) => setToken(s.token))
    } else {
      setToken(null); setCopied(false)
    }
  }, [open, doc])

  // Default share link: opening /s/:token redirects automatically to /v/:docId (with the full main-site shell).
  // Visitors who want the top bar and left menu hidden can use the ?fullscreen link (still React shell + iframe, just visually hides the menu).
  // Note: must be prefixed with Vite's build-time BASE_URL (e.g. /doc/), otherwise the link 404s behind a reverse proxy (nginx exposing /doc/).
  const baseUrl = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '')
  const url = token ? `${location.origin}${baseUrl}/s/${token}` : ''
  const fullscreenUrl = token ? `${location.origin}${baseUrl}/s/${token}?fullscreen=1` : ''

  const copy = async (target: string) => {
    if (!target) return
    const ok = await copyToClipboard(target)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } else {
      // Fallback: prompt the user to copy manually when clipboard write fails (common on non-HTTPS sites where the browser disables execCommand)
      window.prompt('Copy failed — press Ctrl/Cmd+C to copy manually:', target)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link className="h-5 w-5 text-primary" />
            Share "{doc?.title}"
          </DialogTitle>
          <DialogDescription>
            Share this document via link; visitors can view it without logging in.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 pt-2">
          <Input value={url} readOnly placeholder="Generating…" className="font-mono text-xs" />
          <Button onClick={() => copy(url)} disabled={!url} variant={copied ? 'default' : 'gradient'}>
            {copied ? <><Check /> Copied</> : <><Copy /> Copy</>}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground pt-1">
          Default link: visitors see the full document site (top bar + left menu).
        </p>
        <div className="flex items-center gap-2 pt-2">
          <Input value={fullscreenUrl} readOnly placeholder="Generating…" className="font-mono text-xs" />
          <Button onClick={() => copy(fullscreenUrl)} disabled={!fullscreenUrl} variant="outline">
            <Copy /> Copy
          </Button>
        </div>
        <p className="text-xs text-muted-foreground pt-1">
          Fullscreen link (?fullscreen): hides the top bar and left menu, showing only the document content (iframe isolation is preserved).
        </p>
      </DialogContent>
    </Dialog>
  )
}
