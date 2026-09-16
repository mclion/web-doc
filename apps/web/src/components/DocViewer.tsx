import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Code2, ExternalLink, FileText, Maximize2, Minimize2,
  PanelLeftClose, PanelLeftOpen,
  PanelsTopLeft, RefreshCw, Share2, Sparkles, SplitSquareHorizontal,
} from 'lucide-react'
import { Nodes, type DocNode } from '@/lib/api'
import { DOC_ASSET_BASE, WS_BASE } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { CodeEditor } from '@/components/CodeEditor'
import { AIChatPanel } from '@/components/AIChatPanel'
import { useAIChatStore } from '@/store/aiChat'
import { useAuthStore } from '@/store/auth'
import { cn } from '@/lib/utils'

/** 外层 URL 用来记录 iframe 内部子路径的 search 参数名 */
const INNER_PATH_QS = 'p'

/* -------------------------------------------------------------------------- */
/* base64url 编解码（UTF-8 安全）                                              */
/*                                                                            */
/* 设计目标：                                                                 */
/* - 让外层 URL 上的 ?p= 始终是一段「干净的字符串」，不出现 %23、%2F、%E4 等   */
/*   令人眼花的百分号转义。                                                   */
/* - URL 安全：使用 base64url 字母表（用 -、_ 替换 + 和 /），并去除尾部 = 填充。 */
/* - 完整支持中文 / hash / query 等任意字符。                                 */
/* -------------------------------------------------------------------------- */

/** 将任意字符串（含 UTF-8）编码为 base64url（无 padding） */
function encodeInnerPath(raw: string): string {
  if (!raw) return ''
  try {
    // 1) UTF-8 → 字节序列
    const bytes = new TextEncoder().encode(raw)
    // 2) 字节 → 二进制字符串（btoa 只接受 latin-1）
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    // 3) base64 → base64url：替换 +/ 为 -_，去掉尾部 =
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  } catch (e) {
    console.warn('[DocViewer] encodeInnerPath failed, fallback to raw', e)
    return raw
  }
}

/** 将 base64url 字符串解回原始字符串；解码失败时返回 null */
function decodeInnerPath(encoded: string): string | null {
  if (!encoded) return ''
  try {
    // base64url → base64：补回 padding
    let s = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const pad = s.length % 4
    if (pad === 2) s += '=='
    else if (pad === 3) s += '='
    else if (pad !== 0) return null
    const bin = atob(s)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return null
  }
}

/** 一个字符串是否「看上去像」是 base64url（仅包含合法字母表字符，长度 ≥ 2） */
function looksLikeBase64Url(s: string): boolean {
  return s.length >= 2 && /^[A-Za-z0-9_-]+$/.test(s)
}

/**
 * 计算 iframe 的资源根：DOC_ASSET_BASE/{docId}/
 * 末尾保证有 "/"，方便做前缀去除。
 */
function getDocBase(docId: string) {
  // DOC_ASSET_BASE 可能是相对路径（如 "/api/assets"）也可能是绝对 URL
  let base: string
  if (/^https?:\/\//i.test(DOC_ASSET_BASE)) {
    base = `${DOC_ASSET_BASE.replace(/\/+$/, '')}/${docId}/`
  } else {
    base = `${window.location.origin}${DOC_ASSET_BASE.replace(/\/+$/, '')}/${docId}/`
  }
  return base
}

/**
 * 从外层 URL 的 ?p=... 读出 iframe 当前应当加载的子路径（相对资源根）。
 *
 * 兼容策略：
 * 1) 优先尝试按 base64url 解码（新格式）；
 * 2) 如果解不出来或解出来明显不像路径（含控制字符等），回退把原值当作明文（旧格式 / 手写 URL）。
 */
function readInnerPathFromOuter(): string {
  try {
    const sp = new URLSearchParams(window.location.search)
    const raw = sp.get(INNER_PATH_QS) || ''
    if (!raw) return ''

    // 尝试 base64url 解码
    if (looksLikeBase64Url(raw)) {
      const decoded = decodeInnerPath(raw)
      // 解码出的内容含不可见控制字符则视为不合法，回退明文
      if (decoded != null && !/[\u0000-\u001f\u007f]/.test(decoded)) {
        return decoded.replace(/^\/+/, '')
      }
    }
    // 回退：兼容旧的 encodeURIComponent 格式或手写明文
    return raw.replace(/^\/+/, '')
  } catch {
    return ''
  }
}

/** 把 iframe 当前 href 转为相对资源根的相对路径（含 query/hash） */
function toInnerRelative(innerHref: string, docBase: string): string | null {
  try {
    const innerUrl = new URL(innerHref)
    const baseUrl = new URL(docBase)
    // 不同源直接放弃
    if (innerUrl.origin !== baseUrl.origin) return null
    if (!innerUrl.pathname.startsWith(baseUrl.pathname)) return null
    const rel = innerUrl.pathname.slice(baseUrl.pathname.length)
    return rel + innerUrl.search + innerUrl.hash
  } catch {
    return null
  }
}

/** 把外层 URL 的 ?p=... 同步为 next（不污染历史） */
function syncOuterInnerPath(next: string) {
  try {
    const url = new URL(window.location.href)
    const curRaw = url.searchParams.get(INNER_PATH_QS) || ''
    // 把当前 URL 上的值还原成「明文」再比较，避免新旧编码不同导致误判
    const curDecoded = curRaw
      ? (looksLikeBase64Url(curRaw) ? (decodeInnerPath(curRaw) ?? curRaw) : curRaw)
      : ''
    const normalized = next || ''
    if (curDecoded === normalized) return

    // 收集除 p 外的其它参数，按原顺序保留（保留它们既有的编码方式：URLSearchParams 会做标准编码）
    const others: string[] = []
    url.searchParams.forEach((v, k) => {
      if (k === INNER_PATH_QS) return
      others.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    })
    if (normalized) {
      // 用 base64url 编码，整体作为一段「干净的字符串」放进 URL
      others.push(`${INNER_PATH_QS}=${encodeInnerPath(normalized)}`)
    }
    const search = others.length ? `?${others.join('&')}` : ''
    const finalUrl = `${url.origin}${url.pathname}${search}${url.hash}`
    window.history.replaceState(null, '', finalUrl)
  } catch (e) {
    console.warn('[DocViewer] syncOuterInnerPath failed', e)
  }
}

type ViewMode = 'preview' | 'code' | 'split'

export function DocViewer({
  doc, onShare, onOpenAISettings, chromeless = false,
  sidebarOpen, onToggleSidebar,
}: {
  doc: DocNode
  onShare: (doc: DocNode) => void
  onOpenAISettings: () => void
  /** 仅渲染纯文档预览（无顶部工具栏、无 AI 面板、无切换 Tab）。用于分享/全屏模式。 */
  chromeless?: boolean
  /** 当前主站左侧侧栏是否打开（仅非 chromeless 模式下使用） */
  sidebarOpen?: boolean
  /** 切换侧栏显隐的回调（仅非 chromeless 模式下使用） */
  onToggleSidebar?: () => void
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [connected, setConnected] = useState(false)

  const [mode, setMode] = useState<ViewMode>('preview')
  const [files, setFiles] = useState<string[]>([])
  const [activeFile, setActiveFile] = useState<string>(doc.entryFile || 'index.html')

  const { panelOpen, openPanel, closePanel, togglePanel, runningDocId } = useAIChatStore()
  const { user, openLogin } = useAuthStore()
  const aiOpen = panelOpen
  const aiRunning = runningDocId === doc.id

  // [debug] 渲染日志
  console.log('[DocViewer] render', {
    docId: doc.id,
    title: doc.title,
    entryFile: doc.entryFile,
    mode,
    activeFile,
    reloadKey,
    chromeless,
    aiOpen,
    aiRunning,
  })

  // AI 运行时强制进入 split 模式，方便看左侧编辑器流式写入
  useEffect(() => {
    if (aiRunning && mode !== 'split') setMode('split')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiRunning])

  // 切换文档时同步 activeFile
  useEffect(() => {
    console.log('[DocViewer] doc changed → reset activeFile', { docId: doc.id, entryFile: doc.entryFile })
    setActiveFile(doc.entryFile || 'index.html')
  }, [doc.id, doc.entryFile])

  /**
   * iframe 初始要加载的子路径（相对资源根），来自外层 URL 的 ?p=...
   *
   * 关键时序：useMemo 在 render 阶段执行，useEffect 在 commit 之后执行；
   * 因此 ref 必须在「render 阶段」就完成赋值，否则首次 useMemo(src) 拿不到 ?p= 值，
   * iframe 会先用 entryFile 加载，随后 onLoad 回调又把空值写回外层 URL，导致 ?p= 被抹掉。
   *
   * 解决：用一个「绑定到当前 docId」的同步引用，render 阶段发现 docId 变化就立即重读 ?p=。
   */
  const initialInnerPathRef = useRef<{ docId: string; value: string }>({ docId: '', value: '' })
  if (initialInnerPathRef.current.docId !== doc.id) {
    initialInnerPathRef.current = {
      docId: doc.id,
      value: readInnerPathFromOuter(),
    }
    console.log('[DocViewer] init innerPath from outer (sync)', {
      docId: doc.id,
      innerPath: initialInnerPathRef.current.value,
    })
  }

  // 上一次已同步到外层 URL 的内部路径，用作环路抑制
  const lastSyncedInnerPathRef = useRef<string>(initialInnerPathRef.current.value)
  // hydrated：iframe 是否已加载到「目标 inner path」一次。在此之前禁止把空值写回外层 URL，
  // 避免首次 onLoad（此时 iframe 内部仍是 entryFile，hash/query 还没生效）抹掉 ?p=。
  const hydratedRef = useRef<boolean>(false)

  // 文档切换时重置：lastSynced 与 initial 对齐，hydrated 重置
  useEffect(() => {
    lastSyncedInnerPathRef.current = initialInnerPathRef.current.value
    hydratedRef.current = false
  }, [doc.id])

  const src = useMemo(() => {
    const inner = initialInnerPathRef.current.value || (doc.entryFile || 'index.html')
    // inner 可能已经带 query/hash，需要正确合并 cache-bust 的 v=reloadKey
    const [pathAndQuery, hash] = inner.split('#')
    const sep = pathAndQuery.includes('?') ? '&' : '?'
    const url = `${DOC_ASSET_BASE}/${doc.id}/${pathAndQuery}${sep}v=${reloadKey}${hash ? `#${hash}` : ''}`
    console.log('[DocViewer] src recomputed', {
      docId: doc.id,
      entryFile: doc.entryFile,
      innerPath: initialInnerPathRef.current.value,
      reloadKey,
      DOC_ASSET_BASE,
      url,
    })
    return url
  }, [doc.id, doc.entryFile, reloadKey])

  // 加载文件列表
  useEffect(() => {
    console.log('[DocViewer] fetch files start', { docId: doc.id, reloadKey })
    Nodes.get(doc.id)
      .then((r) => {
        const f = r.files ?? []
        console.log('[DocViewer] fetch files ok', {
          docId: doc.id,
          entryFileFromServer: r.node?.entryFile,
          nodeTitle: r.node?.title,
          files: f,
        })
        setFiles(f)
        if (!f.includes(activeFile)) {
          setActiveFile(doc.entryFile || 'index.html')
        }
      })
      .catch((err) => {
        console.error('[DocViewer] fetch files FAILED', { docId: doc.id, err })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, reloadKey])

  // WebSocket 监听：服务端文件变动 → 触发预览 + 编辑器重读
  useEffect(() => {
    const wsUrl = `${WS_BASE}/docs/${doc.id}`
    console.log('[DocViewer] WS connecting', wsUrl)
    const ws = new WebSocket(wsUrl)
    ws.onopen = () => {
      console.log('[DocViewer] WS open', { docId: doc.id })
      setConnected(true)
    }
    ws.onclose = (ev) => {
      console.log('[DocViewer] WS close', { docId: doc.id, code: ev.code, reason: ev.reason })
      setConnected(false)
    }
    ws.onerror = (ev) => {
      console.warn('[DocViewer] WS error', { docId: doc.id, ev })
    }
    ws.onmessage = (ev) => {
      console.log('[DocViewer] WS message', { docId: doc.id, data: ev.data })
      try {
        const data = JSON.parse(ev.data)
        if (data.type === 'reload') {
          console.log('[DocViewer] WS reload → bump reloadKey', { docId: doc.id })
          setReloadKey((k) => k + 1)
        }
      } catch (e) {
        console.warn('[DocViewer] WS parse failed', e)
      }
    }
    return () => {
      console.log('[DocViewer] WS cleanup → close', { docId: doc.id })
      ws.close()
    }
  }, [doc.id])

  const handleManualReload = () => {
    console.log('[DocViewer] manual reload clicked', { docId: doc.id, reloadKey })
    setReloadKey((k) => k + 1)
    requestAnimationFrame(() => {
      try {
        console.log('[DocViewer] manual reload → iframe.reload()', {
          hasIframe: !!iframeRef.current,
          src: iframeRef.current?.src,
        })
        iframeRef.current?.contentWindow?.location?.reload()
      } catch (e) {
        console.warn('[DocViewer] manual reload iframe failed', e)
      }
    })
  }

  const onClickAI = () => {
    if (!user) {
      openLogin('login')
      return
    }
    if (!aiOpen) {
      // 打开面板时自动切到 split，便于流式可视
      if (mode !== 'split') setMode('split')
      openPanel()
    } else {
      togglePanel()
    }
  }

  /**
   * iframe 内部路径变化时回写到外层 URL 的 ?p= 参数
   * - 自动剥离 cache-bust 用的 v 参数
   * - 如果就是入口文件，不写参数（保持外层 URL 整洁）
   *
   * 关键：iframe 第一次 onLoad 时 contentWindow.location 通常还停留在 entryFile（hash 尚未触发），
   *      此时如果直接把「空值」写回外层 URL，就会抹掉用户带进来的 ?p=...。
   *      所以引入 hydratedRef：只有当我们至少观察到一次「与初始目标 inner path 相同的 location」之后，
   *      才允许后续以任意值（包括空）覆盖。
   */
  const handleInnerNavigate = useCallback((innerHref: string) => {
    const docBase = getDocBase(doc.id)
    const rel = toInnerRelative(innerHref, docBase)
    if (rel == null) {
      console.log('[DocViewer] handleInnerNavigate: not under docBase, skip', { innerHref, docBase })
      return
    }
    // 解析并去掉 v=xxx 这个 cache-bust 参数
    let cleaned = rel
    try {
      // 借助一个虚拟 base 来解析相对 URL
      const u = new URL(rel, 'http://__local__/')
      u.searchParams.delete('v')
      const q = u.searchParams.toString()
      cleaned = `${u.pathname.replace(/^\//, '')}${q ? `?${q}` : ''}${u.hash}`
    } catch {
      // 解析失败就用原值
    }
    // 与入口文件等价的情况 → 视为空，外层 URL 不带 ?p
    const entry = doc.entryFile || 'index.html'
    let normalized = cleaned
    if (normalized === entry || normalized === '' || normalized === '/') {
      normalized = ''
    }

    // hydrated 判断：
    // - 若 hydrated 已为 true，正常透传
    // - 若 hydrated 仍为 false：
    //     · 当 normalized 与初始目标一致 → 标记为 hydrated（说明 iframe 已经成功定位到目标）
    //     · 否则跳过本次同步，避免空值覆盖外层 URL（hash 路由的情况，hash 还没生效）
    const initial = initialInnerPathRef.current.value
    if (!hydratedRef.current) {
      if (initial && normalized !== initial) {
        // 也允许 path 部分一致、仅 hash 缺失的情况：iframe 已加载到目标页面，hash 触发是异步的
        const initialPath = initial.split('#')[0]
        const normalizedPath = normalized.split('#')[0] || entry
        if (initialPath === normalizedPath || (initialPath === '' && normalizedPath === entry)) {
          // path 已对齐，等 hashchange 再同步——本次跳过，但不算错
          console.log('[DocViewer] handleInnerNavigate: not yet hydrated (path matched, waiting hash)', {
            innerHref, normalized, initial,
          })
          return
        }
        console.log('[DocViewer] handleInnerNavigate: not yet hydrated (path mismatch), skip write-back', {
          innerHref, normalized, initial,
        })
        return
      }
      // initial 为空，或 normalized 与 initial 一致 → 此后可以正常同步
      hydratedRef.current = true
      console.log('[DocViewer] handleInnerNavigate: hydrated', { initial, normalized })
    }

    if (lastSyncedInnerPathRef.current === normalized) return
    lastSyncedInnerPathRef.current = normalized
    console.log('[DocViewer] handleInnerNavigate → sync outer URL', { innerHref, normalized })
    syncOuterInnerPath(normalized)
  }, [doc.id, doc.entryFile])

  // chromeless：仅渲染一个全屏预览 iframe，无任何主站 UI
  if (chromeless) {
    return (
      <div className="relative h-full w-full bg-white">
        <PreviewFrame
          ref={iframeRef}
          src={src}
          title={doc.title}
          tag="chromeless"
          docId={doc.id}
          onInnerNavigate={handleInnerNavigate}
        />
      </div>
    )
  }

  return (
    <div className={cn(
      'relative h-full w-full bg-background flex flex-col',
      fullscreen && 'fixed inset-0 z-50',
    )}>
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 glass">
        <div className="flex items-center gap-3 min-w-0">
          {onToggleSidebar && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={onToggleSidebar}>
                  {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{sidebarOpen ? 'Close sidebar' : 'Open sidebar'}</TooltipContent>
            </Tooltip>
          )}
          <span className={cn(
            'h-2 w-2 rounded-full shrink-0',
            connected ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground/40',
          )} />
          <span className="text-sm font-medium truncate">{doc.title}</span>
          {files.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded border border-border/60 px-2 py-0.5">
                  <FileText className="h-3 w-3" />
                  {activeFile}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                {files.map((f) => (
                  <DropdownMenuItem key={f} onSelect={() => setActiveFile(f)}>
                    <FileText className="h-3.5 w-3.5" /> {f}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Tabs value={mode} onValueChange={(v) => setMode(v as ViewMode)}>
            <TabsList>
              <TabsTrigger value="preview"><PanelsTopLeft className="h-3 w-3" />Preview</TabsTrigger>
              <TabsTrigger value="split"><SplitSquareHorizontal className="h-3 w-3" />Split</TabsTrigger>
              <TabsTrigger value="code"><Code2 className="h-3 w-3" />Code</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="mx-1 h-5 w-px bg-border/60" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={aiOpen ? 'gradient' : 'ghost'}
                size={aiOpen ? 'sm' : 'icon'}
                onClick={onClickAI}
                className={cn(aiRunning && 'animate-pulse')}
              >
                <Sparkles className={cn(!aiOpen && 'text-violet-400')} />
                {aiOpen && <span>AI</span>}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{aiOpen ? 'Close AI assistant' : 'Open AI assistant'}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={handleManualReload}>
                <RefreshCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh preview</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" asChild>
                <a href={src} target="_blank" rel="noreferrer">
                  <ExternalLink />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open in new tab</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={() => setFullscreen((f) => !f)}>
                {fullscreen ? <Minimize2 /> : <Maximize2 />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</TooltipContent>
          </Tooltip>

          <Button variant="gradient" size="sm" onClick={() => onShare(doc)}>
            <Share2 /> Share
          </Button>
        </div>
      </div>

      {/* 主内容：左侧 = 编辑/预览/分屏；右侧 = AI 面板 */}
      <div className="relative flex-1 min-h-0 flex">
        {/* 左侧主区 */}
        <div className="relative flex-1 min-w-0 overflow-hidden">
          {/* 预览模式 */}
          <div className={cn('absolute inset-0', mode === 'preview' ? 'block' : 'hidden')}>
            <PreviewFrame
              ref={iframeRef}
              src={src}
              title={doc.title}
              tag="preview"
              docId={doc.id}
              onInnerNavigate={handleInnerNavigate}
            />
          </div>

          {/* 代码模式 */}
          <div className={cn('absolute inset-0', mode === 'code' ? 'block' : 'hidden')}>
            <CodeEditor
              doc={doc}
              filePath={activeFile}
              externalReloadKey={reloadKey}
              onSavedExternally={() => setReloadKey((k) => k + 1)}
            />
          </div>

          {/* 分屏模式 */}
          <div className={cn('absolute inset-0', mode === 'split' ? 'grid grid-cols-2' : 'hidden')}>
            <div className="border-r border-border/60 min-w-0 h-full overflow-hidden">
              <CodeEditor
                doc={doc}
                filePath={activeFile}
                externalReloadKey={reloadKey}
                onSavedExternally={() => setReloadKey((k) => k + 1)}
              />
            </div>
            <div className="bg-white min-w-0 h-full relative overflow-hidden">
              <PreviewFrame
                src={src}
                title={`${doc.title} (split)`}
                tag="split"
                docId={doc.id}
                onInnerNavigate={handleInnerNavigate}
              />
            </div>
          </div>
        </div>

        {/* 右侧 AI 面板 */}
        {aiOpen && (
          <div className="w-[380px] shrink-0 border-l border-border/60 h-full">
            <AIChatPanel doc={doc} onClose={closePanel} onOpenSettings={onOpenAISettings} />
          </div>
        )}
      </div>
    </div>
  )
}

const PreviewFrame = forwardRef<
  HTMLIFrameElement,
  {
    src: string
    title: string
    tag?: string
    docId?: string
    onInnerNavigate?: (innerHref: string) => void
  }
>(function PreviewFrame({ src, title, tag = 'unknown', docId, onInnerNavigate }, ref) {
  const innerRef = useRef<HTMLIFrameElement | null>(null)
  const loadStartRef = useRef<number>(0)
  const lastInnerHrefRef = useRef<string>('')
  const pollTimerRef = useRef<number | null>(null)

  useEffect(() => {
    console.log(`[PreviewFrame:${tag}] mount`, { src, title })
    return () => {
      console.log(`[PreviewFrame:${tag}] unmount`, { src, title })
      if (pollTimerRef.current != null) {
        window.clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    loadStartRef.current = performance.now()
    console.log(`[PreviewFrame:${tag}] src changed → start load`, { src })
  }, [src, tag])

  // 用 useCallback 稳定 ref，避免每次 render 都 detach/reattach iframe（会白屏）
  const setRefs = useCallback((node: HTMLIFrameElement | null) => {
    innerRef.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) (ref as React.MutableRefObject<HTMLIFrameElement | null>).current = node
    console.log(`[PreviewFrame:${tag}] iframe ref set`, { hasNode: !!node })
  }, [ref, tag])

  /** 安全读取 iframe 当前 href（同源时才可读） */
  const readInnerHref = useCallback((): string | null => {
    try {
      return innerRef.current?.contentWindow?.location?.href ?? null
    } catch {
      return null
    }
  }, [])

  /** 检查是否变化并通知上层 */
  const checkAndNotify = useCallback(() => {
    if (!onInnerNavigate) return
    const href = readInnerHref()
    if (!href) return
    if (href === lastInnerHrefRef.current) return
    lastInnerHrefRef.current = href
    onInnerNavigate(href)
  }, [onInnerNavigate, readInnerHref])

  return (
    <iframe
      ref={setRefs}
      src={src}
      className="absolute inset-0 h-full w-full border-0 bg-white"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
      referrerPolicy="no-referrer"
      title={title}
      onLoad={(e) => {
        const cost = performance.now() - loadStartRef.current
        const target = e.currentTarget
        let innerLocation = '<inaccessible>'
        let innerReady = '<inaccessible>'
        let bodyText = '<inaccessible>'
        try {
          innerLocation = target.contentWindow?.location?.href ?? '<no-window>'
        } catch (err) {
          innerLocation = `<err:${(err as Error).message}>`
        }
        try {
          innerReady = target.contentDocument?.readyState ?? '<no-doc>'
        } catch (err) {
          innerReady = `<err:${(err as Error).message}>`
        }
        try {
          const bodyHTML = target.contentDocument?.body?.innerHTML ?? ''
          bodyText = `${bodyHTML.length}chars: ${bodyHTML.slice(0, 120)}`
        } catch (err) {
          bodyText = `<err:${(err as Error).message}>`
        }
        console.log(`[PreviewFrame:${tag}] onLoad`, {
          src,
          costMs: Math.round(cost),
          innerLocation,
          innerReady,
          bodyText,
        })

        // ★ 同步 iframe 内部 URL 到上层（每次新文档加载、表单提交、链接跳转都会触发）
        checkAndNotify()

        // ★ 启动轻量轮询，捕获 SPA 内部的 pushState / replaceState 变化
        // （iframe 内若是 React/Vue/Hash 路由，不会触发 onLoad，也不易跨上下文 hook）
        if (pollTimerRef.current != null) {
          window.clearInterval(pollTimerRef.current)
        }
        pollTimerRef.current = window.setInterval(() => {
          checkAndNotify()
        }, 500)

        // ★ 监听 iframe 内 popstate / hashchange，立即同步
        try {
          const win = target.contentWindow
          if (win) {
            const onPop = () => checkAndNotify()
            win.addEventListener('popstate', onPop)
            win.addEventListener('hashchange', onPop)
            // 注：iframe 重载时整个 window 会被替换，事件监听自动失效，无需手动清理
          }
        } catch (err) {
          console.warn(`[PreviewFrame:${tag}] add inner listeners failed`, err)
        }
      }}
      onError={(e) => {
        console.error(`[PreviewFrame:${tag}] onError`, { src, e, docId })
      }}
    />
  )
})
