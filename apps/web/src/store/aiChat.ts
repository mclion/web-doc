import { create } from 'zustand'
import { aiGenerate, type AIGenerateParams } from '@/lib/api'

export type ChatRole = 'user' | 'assistant' | 'system'

/** One tool execution made by an AI call */
export interface ToolCallView {
  index: number
  id: string
  name: string
  argsBuf: string         // args string accumulated from the stream
  ok?: boolean
  summary?: string
  error?: string
  done?: boolean          // whether the result has been received
}

export interface ChatMessage {
  id: string
  role: ChatRole
  /** text (user input / model explanation / system prompt) */
  text: string
  /** whether the assistant message is currently streaming */
  streaming?: boolean
  aborted?: boolean
  error?: string
  /** tool calls emitted by the assistant (ordered by index) */
  toolCalls?: ToolCallView[]
  /** whether the assistant used tools mode */
  useTools?: boolean
  /** legacy UI field: HTML character count (only used in create mode with useTools=false) */
  htmlBytes?: number
  isHtml?: boolean
  ts: number
}

interface AIChatState {
  sessions: Record<string, ChatMessage[]>
  panelOpen: boolean
  runningDocId: string | null
  _abort: (() => void) | null

  openPanel: () => void
  closePanel: () => void
  togglePanel: () => void

  getMessages: (docId: string) => ChatMessage[]
  appendUser: (docId: string, text: string) => void
  pushSystem: (docId: string, text: string) => void

  send: (params: AIGenerateParams & { docId: string }, opts?: {
    onMeta?: (m: { docId: string; mode: string; title: string; useTools?: boolean }) => void
    onDone?: () => void
  }) => void

  stop: () => void
  clear: (docId: string) => void
}

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

export const useAIChatStore = create<AIChatState>((set, get) => ({
  sessions: {},
  panelOpen: false,
  runningDocId: null,
  _abort: null,

  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
  togglePanel: () => set({ panelOpen: !get().panelOpen }),

  getMessages: (docId) => get().sessions[docId] ?? [],

  appendUser: (docId, text) => {
    const msgs = get().sessions[docId] ?? []
    set({
      sessions: {
        ...get().sessions,
        [docId]: [...msgs, { id: uid(), role: 'user', text, ts: Date.now() }],
      },
    })
  },

  pushSystem: (docId, text) => {
    const msgs = get().sessions[docId] ?? []
    set({
      sessions: {
        ...get().sessions,
        [docId]: [...msgs, { id: uid(), role: 'system', text, ts: Date.now() }],
      },
    })
  },

  send: (params, opts) => {
    const { docId } = params
    get()._abort?.()

    const assistantId = uid()
    set((s) => ({
      sessions: {
        ...s.sessions,
        [docId]: [
          ...(s.sessions[docId] ?? []),
          {
            id: assistantId, role: 'assistant', text: '',
            streaming: true, toolCalls: [], htmlBytes: 0,
            isHtml: false, ts: Date.now(),
          },
        ],
      },
      runningDocId: docId,
    }))

    const patchAssistant = (fn: (m: ChatMessage) => ChatMessage) => {
      set((s) => ({
        sessions: {
          ...s.sessions,
          [docId]: (s.sessions[docId] ?? []).map((m) =>
            m.id === assistantId ? fn(m) : m,
          ),
        },
      }))
    }

    let textBuf = 0
    const abort = aiGenerate(params, {
      onMeta: (m) => {
        patchAssistant((msg) => ({ ...msg, useTools: !!m.useTools, isHtml: !m.useTools }))
        opts?.onMeta?.(m)
      },
      onDelta: (t) => {
        textBuf += t.length
        patchAssistant((msg) => ({
          ...msg,
          text: msg.text + t,
          htmlBytes: msg.useTools ? msg.htmlBytes : textBuf,
        }))
      },
      onToolCallStart: ({ index, id, name }) => {
        patchAssistant((msg) => {
          const tcs = [...(msg.toolCalls ?? [])]
          tcs[index] = { index, id, name, argsBuf: '' }
          return { ...msg, toolCalls: tcs }
        })
      },
      onToolCallArgs: ({ index, delta }) => {
        patchAssistant((msg) => {
          const tcs = [...(msg.toolCalls ?? [])]
          if (tcs[index]) {
            tcs[index] = { ...tcs[index], argsBuf: tcs[index].argsBuf + delta }
          }
          return { ...msg, toolCalls: tcs }
        })
      },
      onToolResult: ({ id, ok, summary, error }) => {
        patchAssistant((msg) => {
          const tcs = (msg.toolCalls ?? []).map((tc) =>
            tc.id === id ? { ...tc, ok, summary, error, done: true } : tc,
          )
          return { ...msg, toolCalls: tcs }
        })
      },
      onRound: () => { /* optional: show a round badge in the future */ },
      onDone: () => {
        patchAssistant((msg) => ({ ...msg, streaming: false }))
        set({ runningDocId: null, _abort: null })
        opts?.onDone?.()
      },
      onError: (msg) => {
        patchAssistant((m) => ({ ...m, streaming: false, error: msg }))
        set({ runningDocId: null, _abort: null })
      },
    })

    set({ _abort: abort })
  },

  stop: () => {
    const ab = get()._abort
    if (!ab) return
    ab()
    const docId = get().runningDocId
    if (docId) {
      set((s) => ({
        sessions: {
          ...s.sessions,
          [docId]: (s.sessions[docId] ?? []).map((m) =>
            m.streaming ? { ...m, streaming: false, aborted: true } : m,
          ),
        },
      }))
    }
    set({ _abort: null, runningDocId: null })
  },

  clear: (docId) => {
    const next = { ...get().sessions }
    delete next[docId]
    set({ sessions: next })
  },
}))
