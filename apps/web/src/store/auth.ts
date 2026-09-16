import { create } from 'zustand'
import { Auth, getToken, setToken, type AuthUser } from '@/lib/api'
import { useDocsStore } from '@/store/docs'

interface AuthState {
  user: AuthUser | null
  token: string | null
  loading: boolean
  // True while a stored token is being verified against the server. Only starts
  // true when there's a token to check — a visitor with no token at all is known
  // to be anonymous immediately, no flash needed.
  checkingSession: boolean
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
  checkingSession: !!getToken(),
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
      set({ user: u, checkingSession: false })
    } catch {
      setToken(null)
      set({ user: null, token: null, checkingSession: false })
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

  // Deliberately does not log the new account in — registering only creates the
  // account, the caller (AuthDialog/LoginScreen) switches to the login tab after.
  register: async (p) => {
    set({ loading: true })
    try {
      await Auth.register(p)
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
    // Only wipe the doc tree if a session actually just expired — an anonymous
    // visitor's 401 (e.g. an incidental call while viewing a public share) must
    // not clear the shared doc that's already loaded.
    if (user) {
      useDocsStore.getState().reset()
      openLogin('login')
    }
  })
}
