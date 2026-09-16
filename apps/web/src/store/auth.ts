import { create } from 'zustand'
import { Auth, getToken, setToken, type AuthUser } from '@/lib/api'
import { useDocsStore } from '@/store/docs'

interface AuthState {
  user: AuthUser | null
  token: string | null
  loading: boolean
  registerEnabled: boolean
  loginOpen: boolean
  loginMode: 'login' | 'register'

  bootstrap: () => Promise<void>
  openLogin: (mode?: 'login' | 'register') => void
  closeLogin: () => void
  login: (username: string, password: string) => Promise<void>
  register: (p: { username: string; password: string; email?: string; displayName?: string }) => Promise<void>
  logout: () => void
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: getToken(),
  loading: false,
  registerEnabled: true,
  loginOpen: false,
  loginMode: 'login',

  bootstrap: async () => {
    try {
      const info = await Auth.publicInfo()
      set({ registerEnabled: info.registerEnabled })
    } catch {/* ignore */}
    if (!getToken()) return
    try {
      const u = await Auth.me()
      set({ user: u })
    } catch {
      setToken(null)
      set({ user: null, token: null })
    }
  },

  openLogin: (mode = 'login') => set({ loginOpen: true, loginMode: mode }),
  closeLogin: () => set({ loginOpen: false }),

  login: async (username, password) => {
    set({ loading: true })
    try {
      const { user, token } = await Auth.login({ username, password })
      setToken(token)
      set({ user, token, loginOpen: false })
    } finally {
      set({ loading: false })
    }
  },

  register: async (p) => {
    set({ loading: true })
    try {
      const { user, token } = await Auth.register(p)
      setToken(token)
      set({ user, token, loginOpen: false })
    } finally {
      set({ loading: false })
    }
  },

  logout: () => {
    setToken(null)
    set({ user: null, token: null })
    useDocsStore.getState().reset()
  },
}))

// Global 401 listener
if (typeof window !== 'undefined') {
  window.addEventListener('webdoc:unauthorized', () => {
    const { user, openLogin } = useAuthStore.getState()
    useAuthStore.setState({ user: null, token: null })
    useDocsStore.getState().reset()
    if (user) openLogin('login')
  })
}
