import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Shares, type DocNode } from '@/lib/api'
import { useDocsStore } from '@/store/docs'

export default function SharePage() {
  const { token } = useParams<{ token: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const upsertFromServer = useDocsStore((s) => s.upsertFromServer)
  const [doc, setDoc] = useState<DocNode | null>(null)
  const [error, setError] = useState<string | null>(null)

  // fullscreen param: carried along on redirect to the main site so the shell hides the top bar and left menu (iframe nesting unchanged)
  const fullscreen = searchParams.get('fullscreen') !== null
    && searchParams.get('fullscreen') !== '0'
    && searchParams.get('fullscreen') !== 'false'

  useEffect(() => {
    if (!token) return
    console.debug('[web-doc share] load share token', {
      token,
      pathname: location.pathname,
      search: location.search,
      fullscreen,
    })
    Shares.info(token)
      .then((r) => {
        console.debug('[web-doc share] share token resolved', {
          token,
          docId: r.doc.id,
          title: r.doc.title,
          visibility: r.doc.visibility,
          fullscreen,
        })
        setDoc(r.doc)
      })
      .catch((err) => {
        console.warn('[web-doc share] share token lookup failed', {
          token,
          status: err?.response?.status,
          message: err?.message,
        })
        setError('Link is invalid or has expired')
      })
  }, [token, fullscreen])

  // Always redirect to the main doc page (/v/:docId), keeping the full React shell + iframe two-layer structure.
  // - Default: show top bar + left menu
  // - With ?fullscreen: hide top bar + left menu (iframe still nested, routing unaffected)
  // Upsert the doc into the store before redirecting, so HomePage doesn't wrongly
  // think it's missing (because it's not in the local nodes list) and bounce back
  // to the home page — typical case: an anonymous visitor opening a share link.
  useEffect(() => {
    if (!doc) return
    console.debug('[web-doc share] upsert shared doc before redirect', {
      docId: doc.id,
      title: doc.title,
      fullscreen,
    })
    upsertFromServer(doc, { shared: true, select: true })
    const suffix = fullscreen ? '?fullscreen=1' : ''
    const target = `/v/${doc.id}${suffix}`
    console.debug('[web-doc share] navigate to shared doc', {
      from: location.pathname + location.search,
      target,
      replace: true,
    })
    navigate(target, { replace: true })
  }, [doc, fullscreen, navigate, upsertFromServer])

  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center gradient-bg">
        <div className="glass border border-border/60 rounded-xl px-8 py-6 text-center">
          <h1 className="text-lg font-semibold mb-2">😕 {error}</h1>
          <p className="text-sm text-muted-foreground">Please contact the sharer for a new link.</p>
        </div>
      </div>
    )
  }
  return (
    <div className="h-full w-full flex items-center justify-center text-muted-foreground text-sm">
      {doc ? 'Redirecting…' : 'Loading…'}
    </div>
  )
}
