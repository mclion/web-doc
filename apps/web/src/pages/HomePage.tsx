import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { FilePlus2, PanelLeftOpen, Sparkles, Wand2, X } from 'lucide-react'
import { useDocsStore } from '@/store/docs'
import { useAIChatStore } from '@/store/aiChat'
import { useAuthStore } from '@/store/auth'
import { Nodes, type DocNode } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DocTree } from '@/components/DocTree'
import { DocViewer } from '@/components/DocViewer'
import { CreateDocDialog } from '@/components/CreateDocDialog'
import { ShareDialog } from '@/components/ShareDialog'
import { AISettingsDialog } from '@/components/AISettingsDialog'
import { AuthDialog } from '@/components/AuthDialog'
import { LoginScreen } from '@/components/LoginScreen'
import { UserMenu } from '@/components/UserMenu'

export default function HomePage() {
  const { nodes, loadAll, selectedId, sidebarOpen, toggleSidebar, selectDoc, createNode, upsertFromServer } = useDocsStore()
  const { openPanel } = useAIChatStore()
  const { user, bootstrap, openLogin, checkingSession } = useAuthStore()
  const [createOpen, setCreateOpen] = useState(false)
  const [createParent, setCreateParent] = useState<string | null>(null)
  const [shareDoc, setShareDoc] = useState<DocNode | null>(null)
  const [aiSettingsOpen, setAISettingsOpen] = useState(false)

  const { docId: routeDocId } = useParams<{ docId?: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const fullscreen = searchParams.get('fullscreen') !== null
    && searchParams.get('fullscreen') !== '0'
    && searchParams.get('fullscreen') !== 'false'

  // Only fetch the doc tree once we know who's logged in — it's per-user now,
  // and an anonymous visitor has no tree of their own to fetch.
  useEffect(() => { if (user) loadAll() }, [user, loadAll])
  useEffect(() => { bootstrap() }, [bootstrap])

  // URL -> store
  useEffect(() => {
    console.debug('[web-doc route] URL -> store', {
      pathname: location.pathname,
      search: location.search,
      routeDocId,
      selectedId,
    })
    if (routeDocId && routeDocId !== selectedId) {
      console.debug('[web-doc route] select doc from URL', { routeDocId, selectedId })
      selectDoc(routeDocId)
    }
    if (!routeDocId && selectedId) {
      console.debug('[web-doc route] clear selected doc because URL has no doc id', { selectedId })
      selectDoc(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeDocId])

  // store -> URL (keep query params, e.g. fullscreen)
  useEffect(() => {
    if (routeDocId && !selectedId) {
      console.debug('[web-doc route] skip store -> URL while URL doc is being synced to store', {
        routeDocId,
        selectedId,
        pathname: location.pathname,
        search: location.search,
      })
      return
    }

    const search = location.search || ''
    const target = (selectedId ? `/v/${selectedId}` : '/') + search
    const current = (routeDocId ? `/v/${routeDocId}` : '/') + search
    if (target !== current) {
      console.debug('[web-doc route] store -> URL navigate', {
        selectedId,
        routeDocId,
        current,
        target,
      })
      navigate(target, { replace: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const selectedDoc = useMemo<DocNode | null>(
    () => nodes.find((n) => n.id === selectedId && n.type === 'doc') ?? null,
    [nodes, selectedId],
  )

  // A direct /v/:docId link (bookmarked, opened fresh, or reached outside the
  // /s/:token share redirect — e.g. a fullscreen link) points at a doc that isn't
  // in the local node list yet. Fetch it directly instead of just waiting on
  // loadAll(): GetNode already allows the owner or any public doc, anonymous
  // included, so this covers every case share-flow-only fetching didn't.
  const [docFetchFailed, setDocFetchFailed] = useState(false)
  useEffect(() => {
    setDocFetchFailed(false)
    if (!routeDocId) return
    if (nodes.some((n) => n.id === routeDocId)) return
    let cancelled = false
    Nodes.get(routeDocId)
      .then((r) => { if (!cancelled) upsertFromServer(r.node, { select: true }) })
      .catch(() => {
        if (cancelled) return
        if (user) {
          selectDoc(null)
          navigate('/', { replace: true })
        } else {
          setDocFetchFailed(true)
        }
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeDocId, nodes, user])

  // URL points to a doc that doesn't exist: clear it (only validated for logged-in
  // users outside fullscreen mode, so anonymous share visitors aren't wrongly
  // redirected home just because the shared doc isn't in their local node list).
  useEffect(() => {
    if (!routeDocId || nodes.length === 0) return
    if (!user) {
      console.debug('[web-doc route] skip missing-doc validation for anonymous visitor', {
        routeDocId,
        nodesCount: nodes.length,
        fullscreen,
      })
      return
    }
    if (fullscreen) {
      console.debug('[web-doc route] skip missing-doc validation in fullscreen mode', {
        routeDocId,
        nodesCount: nodes.length,
        userId: user.id,
        username: user.username,
      })
      return
    }
    const exists = nodes.some((n) => n.id === routeDocId && n.type === 'doc')
    console.debug('[web-doc route] validate route doc against node list', {
      routeDocId,
      exists,
      nodesCount: nodes.length,
      userId: user.id,
      username: user.username,
      visibleDocIds: nodes.filter((n) => n.type === 'doc').map((n) => n.id),
    })
    if (!exists) {
      console.warn('[web-doc route] route doc is missing from current node list, navigate to home', {
        routeDocId,
        nodesCount: nodes.length,
        userId: user.id,
        username: user.username,
      })
      selectDoc(null)
      navigate('/', { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, routeDocId, user])

  const handleCreate = (parentId: string | null) => {
    if (!user) {
      openLogin('login')
      return
    }
    setCreateParent(parentId)
    setCreateOpen(true)
  }

  // Entry point for "Generate with AI": create a placeholder empty doc, open it, and auto-open the AI panel
  const handleStartAI = async (parentId: string | null) => {
    if (!user) {
      openLogin('login')
      return
    }
    const node = await createNode({
      parentId,
      type: 'doc',
      title: 'AI New Document',
    })
    selectDoc(node.id)
    openPanel()
  }

  // ========== Fullscreen mode: show only the bare doc preview (no chrome) ==========
  if (fullscreen) {
    return (
      <div className="relative h-full w-full overflow-hidden bg-background">
        {selectedDoc ? (
          <DocViewer
            doc={selectedDoc}
            onShare={setShareDoc}
            onOpenAISettings={() => setAISettingsOpen(true)}
            chromeless
          />
        ) : (
          <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
            {docFetchFailed ? "This document isn't available." : 'Loading…'}
          </div>
        )}
        <ShareDialog doc={shareDoc} open={!!shareDoc} onOpenChange={(v) => !v && setShareDoc(null)} />
      </div>
    )
  }

  // While a stored token is still being verified, render nothing rather than
  // guessing — showing the login page and then swapping to the app a moment
  // later (once the session turns out valid) is the flash we're avoiding here.
  if (checkingSession) {
    return <div className="h-full w-full bg-background" />
  }

  // ========== Anonymous, no shared doc open: show a real login page, not a teaser ==========
  // (A shared doc reached via /s/:token still renders normally below — selectedDoc is
  // already populated for it before this component ever mounts, see SharePage.)
  if (!user && !selectedDoc) {
    return <LoginScreen />
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-background flex">
      {/* Sidebar: visibility controlled by sidebarOpen */}
      {sidebarOpen && (
        <aside className="h-full w-72 shrink-0 bg-card border-r border-border/60 shadow-xl flex flex-col">
          <SidebarHeader
            onToggle={toggleSidebar}
            onNew={() => handleCreate(null)}
            onAISettings={() => { if (!user) { openLogin('login'); return } setAISettingsOpen(true) }}
          />
          <div className="flex-1 overflow-y-auto py-2">
            <DocTree onCreateInFolder={handleCreate} />
          </div>
          <SidebarFooter count={nodes.filter((n) => n.type === 'doc').length} />
        </aside>
      )}

      {/* Main preview area */}
      <main className="relative flex-1 min-w-0 h-full">
        {selectedDoc ? (
          <DocViewer
            doc={selectedDoc}
            onShare={setShareDoc}
            onOpenAISettings={() => setAISettingsOpen(true)}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={toggleSidebar}
          />
        ) : (
          <EmptyState
            sidebarOpen={sidebarOpen}
            onToggleSidebar={toggleSidebar}
            onCreate={() => handleCreate(null)}
            onAI={() => handleStartAI(null)}
          />
        )}
      </main>

      {/* Dialogs */}
      <CreateDocDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        parentId={createParent}
        onAITrigger={(pid) => { setCreateOpen(false); setTimeout(() => handleStartAI(pid), 150) }}
      />
      <ShareDialog doc={shareDoc} open={!!shareDoc} onOpenChange={(v) => !v && setShareDoc(null)} />
      <AISettingsDialog open={aiSettingsOpen} onOpenChange={setAISettingsOpen} />
      <AuthDialog />
    </div>
  )
}

function SidebarHeader({
  onToggle, onNew, onAISettings,
}: {
  onToggle: () => void
  onNew: () => void
  onAISettings: () => void
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-3 border-b border-border/60">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <div className="h-7 w-7 rounded-md bg-gradient-to-br from-blue-500 to-violet-500 flex items-center justify-center shadow-md">
          <Sparkles className="h-4 w-4 text-white" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gradient leading-none">Web-Doc</div>
          <div className="text-[10px] text-muted-foreground mt-0.5">HTML Document Site</div>
        </div>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onAISettings}>
            <Wand2 className="text-violet-400" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>AI Settings</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onNew}>
            <FilePlus2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent>New</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onToggle}>
            <X />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Close sidebar</TooltipContent>
      </Tooltip>
    </div>
  )
}

function SidebarFooter({ count }: { count: number }) {
  return (
    <div className="px-3 py-2 border-t border-border/60 text-[11px] text-muted-foreground flex items-center justify-between gap-2">
      <span className="truncate">{count} documents total</span>
      <UserMenu />
    </div>
  )
}

function EmptyState({
  sidebarOpen, onToggleSidebar, onCreate, onAI,
}: {
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onCreate: () => void
  onAI: () => void
}) {
  return (
    <div className="relative h-full w-full flex items-center justify-center gradient-bg">
      {/* Top-left open button, shown only while the sidebar is closed */}
      {!sidebarOpen && (
        <div className="absolute left-0 top-0 z-10 px-3 py-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={onToggleSidebar}>
                <PanelLeftOpen />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open sidebar</TooltipContent>
          </Tooltip>
        </div>
      )}
      <div className="text-center max-w-md px-8">
        <div className="mx-auto h-16 w-16 rounded-2xl bg-gradient-to-br from-blue-500 to-violet-500 flex items-center justify-center shadow-xl shadow-violet-500/30 mb-6">
          <Sparkles className="h-8 w-8 text-white" />
        </div>
        <h1 className="text-3xl font-bold tracking-tight mb-3">
          Welcome to <span className="text-gradient">Web-Doc</span>
        </h1>
        <p className="text-muted-foreground mb-8 leading-relaxed">
          Manage AI-generated HTML documents like Markdown notes.<br />
          Sandboxed preview, folder hot-reload, one-click sharing.
        </p>
        <div className="flex items-center justify-center gap-3">
          <Button variant="gradient" size="lg" onClick={onAI}>
            <Sparkles /> Generate with AI
          </Button>
          <Button variant="outline" size="lg" onClick={onCreate}>
            <FilePlus2 /> Create manually
          </Button>
        </div>
      </div>
    </div>
  )
}
