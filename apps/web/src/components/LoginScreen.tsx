import { useState } from 'react'
import { Sparkles, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react'
import { useAuthStore } from '@/store/auth'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Full-page login/register gate shown at "/" for anonymous visitors — the doc
// tree is per-user now, so there's nothing to show them until they sign in.
export function LoginScreen() {
  const { login, register, loading, registerEnabled } = useAuthStore()

  const [tab, setTab] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    try {
      if (tab === 'login') {
        if (!username.trim() || !password) {
          setError('Please enter your username and password'); return
        }
        await login(username.trim(), password)
      } else {
        if (!username.trim() || !password) {
          setError('Please enter a username and password'); return
        }
        if (password !== confirmPwd) {
          setError('Passwords do not match'); return
        }
        const registeredUsername = username.trim()
        await register({
          username: registeredUsername,
          password,
          email: email.trim() || undefined,
          displayName: displayName.trim() || undefined,
        })
        // Account created but not logged in — switch to the login tab so the
        // user has to authenticate with their new credentials explicitly.
        setTab('login')
        setUsername(registeredUsername)
        setPassword('')
        setConfirmPwd('')
        setEmail('')
        setDisplayName('')
        setNotice('Account created — log in below.')
      }
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Something went wrong')
    }
  }

  return (
    <div className="h-full w-full flex items-center justify-center gradient-bg px-4">
      <div className="w-full max-w-md glass border border-border/60 rounded-xl p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-5">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-blue-500 to-violet-500 flex items-center justify-center shadow-lg shadow-violet-500/30">
            <Sparkles className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">
              Welcome to <span className="text-gradient">Web-Doc</span>
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">Log in to manage your documents</p>
          </div>
        </div>

        <Tabs value={tab} onValueChange={(v) => { setTab(v as any); setError(null); setNotice(null) }}>
          <TabsList className="grid grid-cols-2 mb-4">
            <TabsTrigger value="login">Log in</TabsTrigger>
            <TabsTrigger value="register" disabled={!registerEnabled}>
              Register{!registerEnabled && ' (closed)'}
            </TabsTrigger>
          </TabsList>

          <form onSubmit={onSubmit} className="space-y-3">
            <TabsContent value="login" className="space-y-3 mt-0">
              <Field label="Username / email">
                <Input
                  autoFocus
                  placeholder="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </Field>
              <Field label="Password">
                <Input
                  type="password"
                  placeholder="••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            </TabsContent>

            <TabsContent value="register" className="space-y-3 mt-0">
              <Field label="Username" hint="3-32 letters / digits / underscores">
                <Input
                  autoFocus
                  placeholder="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </Field>
              <Field label="Password" hint="at least 6 characters">
                <Input
                  type="password"
                  placeholder="••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Field label="Confirm password">
                <Input
                  type="password"
                  placeholder="••••••"
                  value={confirmPwd}
                  onChange={(e) => setConfirmPwd(e.target.value)}
                />
              </Field>
              <Field label="Email (optional)">
                <Input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label="Display name (optional)">
                <Input
                  placeholder="My Name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </Field>
            </TabsContent>

            {notice && (
              <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{notice}</span>
              </div>
            )}

            {error && (
              <div className={cn(
                'flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive',
              )}>
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button type="submit" variant="gradient" className="w-full" disabled={loading}>
              {loading && <Loader2 className="animate-spin" />}
              {tab === 'login' ? 'Log in' : 'Create account'}
            </Button>

            <p className="text-center text-xs text-muted-foreground">
              {tab === 'login' ? (
                registerEnabled ? (
                  <>No account yet? <button type="button" className="text-primary hover:underline" onClick={() => setTab('register')}>Register now</button></>
                ) : 'Registration is closed, please contact an admin'
              ) : (
                <>Already have an account? <button type="button" className="text-primary hover:underline" onClick={() => setTab('login')}>Log in</button></>
              )}
            </p>
          </form>
        </Tabs>
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-foreground/80">{label}</span>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </label>
  )
}
