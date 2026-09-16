import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, ArrowLeft, Loader2, Plus, ShieldCheck, Trash2, UserCog } from 'lucide-react'
import { useAuthStore } from '@/store/auth'
import { Admin, type AuthUser } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export default function AdminPage() {
  const { user, bootstrap } = useAuthStore()
  const navigate = useNavigate()
  const [checking, setChecking] = useState(true)
  const [users, setUsers] = useState<AuthUser[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<AuthUser | 'new' | null>(null)

  useEffect(() => {
    bootstrap().finally(() => setChecking(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refresh = () => {
    setLoading(true)
    Admin.listUsers()
      .then(setUsers)
      .catch((e) => setError(e?.response?.data?.error || e?.message || 'Failed to load users'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (user?.role === 'admin') refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.role])

  if (checking) {
    return <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">Loading…</div>
  }
  if (!user || user.role !== 'admin') {
    navigate('/', { replace: true })
    return null
  }

  const onDelete = async (u: AuthUser) => {
    if (!confirm(`Delete user "${u.username}"? This also deletes every document they own. This cannot be undone.`)) return
    setError(null)
    try {
      await Admin.deleteUser(u.id)
      refresh()
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Delete failed')
    }
  }

  const onToggleRole = async (u: AuthUser) => {
    if (u.id === user.id) return
    setError(null)
    try {
      await Admin.updateUser(u.id, { role: u.role === 'admin' ? 'user' : 'admin' })
      refresh()
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Update failed')
    }
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-background">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="flex items-center gap-3 mb-6">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
            <ArrowLeft />
          </Button>
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-violet-400" /> Admin · Users
            </h1>
            <p className="text-sm text-muted-foreground">Manage accounts — role, profile, password, deletion.</p>
          </div>
          <div className="flex-1" />
          <Button variant="gradient" size="sm" onClick={() => setEditing('new')}>
            <Plus className="h-3.5 w-3.5" /> New user
          </Button>
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="rounded-lg border border-border/60 divide-y divide-border/40 overflow-hidden">
          {loading && (
            <div className="px-4 py-6 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
          {!loading && users.length === 0 && (
            <div className="px-4 py-6 text-sm text-muted-foreground">No users yet.</div>
          )}
          {users.map((u) => (
            <div key={u.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{u.displayName || u.username}</span>
                  <span className="text-xs text-muted-foreground truncate">@{u.username}</span>
                  {u.id === user.id && <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-accent-foreground">you</span>}
                </div>
                {u.email && <div className="text-xs text-muted-foreground truncate mt-0.5">{u.email}</div>}
              </div>
              <button
                className={cn(
                  'text-xs px-2 py-1 rounded-md border transition',
                  u.role === 'admin'
                    ? 'border-violet-400/40 bg-violet-400/10 text-violet-300'
                    : 'border-border/60 text-muted-foreground hover:bg-accent',
                  u.id === user.id && 'opacity-50 cursor-not-allowed',
                )}
                disabled={u.id === user.id}
                onClick={() => onToggleRole(u)}
                title={u.id === user.id ? "You can't change your own role" : 'Toggle role'}
              >
                {u.role === 'admin' ? 'Admin' : 'User'}
              </button>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditing(u)}>
                <UserCog className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive hover:text-destructive"
                disabled={u.id === user.id}
                onClick={() => onDelete(u)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      <UserFormDialog
        target={editing}
        onOpenChange={(v) => !v && setEditing(null)}
        onSaved={() => { setEditing(null); refresh() }}
      />
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

function UserFormDialog({
  target, onOpenChange, onSaved,
}: {
  target: AuthUser | 'new' | null
  onOpenChange: (v: boolean) => void
  onSaved: () => void
}) {
  const isNew = target === 'new'
  const editingUser = target && target !== 'new' ? target : null

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<'admin' | 'user'>('user')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
    setPassword('')
    if (editingUser) {
      setUsername(editingUser.username)
      setEmail(editingUser.email || '')
      setDisplayName(editingUser.displayName || '')
      setRole(editingUser.role)
    } else {
      setUsername('')
      setEmail('')
      setDisplayName('')
      setRole('user')
    }
  }, [target, editingUser])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSaving(true)
    try {
      if (isNew) {
        if (!username.trim() || !password) {
          setError('Username and password are required'); setSaving(false); return
        }
        await Admin.createUser({
          username: username.trim(), password,
          email: email.trim() || undefined,
          displayName: displayName.trim() || undefined,
          role,
        })
      } else if (editingUser) {
        await Admin.updateUser(editingUser.id, {
          displayName: displayName.trim(),
          email: email.trim(),
          ...(password ? { password } : {}),
        })
      }
      onSaved()
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isNew ? 'New user' : editingUser ? `Edit ${editingUser.username}` : ''}</DialogTitle>
          <DialogDescription>
            {isNew ? 'Create an account directly, bypassing the public registration switch.' : 'Update profile or reset password.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          {isNew && (
            <Field label="Username" hint="3-32 letters / digits / underscores">
              <Input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" />
            </Field>
          )}
          <Field label={isNew ? 'Password' : 'New password (optional)'} hint="at least 6 characters">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••" />
          </Field>
          <Field label="Display name (optional)">
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display name" />
          </Field>
          <Field label="Email (optional)">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </Field>
          {isNew && (
            <Field label="Role">
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={role}
                onChange={(e) => setRole(e.target.value as 'admin' | 'user')}
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <DialogFooter>
            <Button type="submit" variant="gradient" disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}
              {isNew ? 'Create' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
