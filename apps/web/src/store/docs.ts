import { create } from 'zustand'
import type { DocNode, ReorderItem } from '@/lib/api'
import { Nodes, NodesReorder } from '@/lib/api'

interface DocsState {
  nodes: DocNode[]
  loading: boolean
  selectedId: string | null
  sharedDocIds: string[]
  sidebarOpen: boolean

  loadAll: () => Promise<void>
  selectDoc: (id: string | null) => void
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void

  createNode: (payload: { parentId?: string | null; type: 'folder' | 'doc'; title: string; html?: string }) => Promise<DocNode>
  updateNode: (id: string, patch: Parameters<typeof Nodes.update>[1]) => Promise<void>
  removeNode: (id: string) => Promise<void>
  reorderNodes: (items: ReorderItem[]) => Promise<void>
  upsertFromServer: (n: DocNode, options?: { select?: boolean; shared?: boolean }) => void
  reset: () => void
}

export const useDocsStore = create<DocsState>((set, get) => ({
  nodes: [],
  loading: false,
  selectedId: null,
  sharedDocIds: [],
  // Open by default on normal-sized screens; collapsed on narrow/mobile viewports.
  sidebarOpen: typeof window === 'undefined' || window.innerWidth >= 768,

  loadAll: async () => {
    set({ loading: true })
    try {
      const items = await Nodes.list()
      const existing = get().nodes
      const sharedDocIds = new Set(get().sharedDocIds)
      const itemIds = new Set(items.map((n) => n.id))
      const sharedDocs = existing.filter((n) => sharedDocIds.has(n.id) && !itemIds.has(n.id))
      set({ nodes: [...items, ...sharedDocs] })
    } finally {
      set({ loading: false })
    }
  },

  selectDoc: (id) => set({ selectedId: id }),
  toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  createNode: async (payload) => {
    const node = await Nodes.create(payload)
    set({ nodes: [...get().nodes, node] })
    if (node.type === 'doc') set({ selectedId: node.id })
    return node
  },

  updateNode: async (id, patch) => {
    const node = await Nodes.update(id, patch)
    set({ nodes: get().nodes.map((n) => (n.id === id ? node : n)) })
  },

  removeNode: async (id) => {
    await Nodes.remove(id)
    // remove the subtree in sync
    const idsToRemove = new Set<string>([id])
    let changed = true
    while (changed) {
      changed = false
      for (const n of get().nodes) {
        if (n.parentId && idsToRemove.has(n.parentId) && !idsToRemove.has(n.id)) {
          idsToRemove.add(n.id)
          changed = true
        }
      }
    }
    set({
      nodes: get().nodes.filter((n) => !idsToRemove.has(n.id)),
      selectedId: idsToRemove.has(get().selectedId ?? '') ? null : get().selectedId,
    })
  },

  reorderNodes: async (items) => {
    // optimistic update
    const map = new Map(items.map((i) => [i.id, i]))
    set({
      nodes: get().nodes.map((n) => {
        const it = map.get(n.id)
        if (!it) return n
        return { ...n, parentId: it.parentId ?? null, sortOrder: it.sortOrder }
      }),
    })
    try {
      await NodesReorder.batch(items)
    } catch (e) {
      // roll back on failure (refetch)
      const fresh = await Nodes.list()
      set({ nodes: fresh })
      throw e
    }
  },

  upsertFromServer: (n, options) => {
    const arr = get().nodes
    const i = arr.findIndex((x) => x.id === n.id)
    const patch: Partial<DocsState> = {}
    if (i >= 0) {
      const next = arr.slice()
      next[i] = n
      patch.nodes = next
    } else {
      patch.nodes = [...arr, n]
    }
    if (options?.shared) {
      patch.sharedDocIds = Array.from(new Set([...get().sharedDocIds, n.id]))
    }
    if (options?.select) {
      patch.selectedId = n.id
    }
    set(patch)
  },

  // Clears the in-memory doc tree on logout/401 so a following visitor on the same
  // tab never sees the previous account's docs before the next loadAll() completes.
  reset: () => set({ nodes: [], selectedId: null, sharedDocIds: [] }),
}))
