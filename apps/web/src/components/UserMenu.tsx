import { LogIn, LogOut, ShieldCheck, Settings, User as UserIcon, UserPlus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/store/auth'

export function UserMenu() {
  const { user, openLogin, logout, registerEnabled } = useAuthStore()
  const navigate = useNavigate()

  if (!user) {
    return (
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => openLogin('login')}>
          <LogIn className="h-3.5 w-3.5" /> Log in
        </Button>
        {registerEnabled && (
          <Button size="sm" variant="gradient" className="h-7 px-2 text-xs" onClick={() => openLogin('register')}>
            Sign up
          </Button>
        )}
      </div>
    )
  }

  const initial = (user.displayName || user.username).slice(0, 1).toUpperCase()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent transition">
          <div className="h-7 w-7 rounded-full bg-gradient-to-br from-blue-500 to-violet-500 flex items-center justify-center text-white text-xs font-semibold shadow">
            {initial}
          </div>
          <span className="text-xs text-foreground/90 max-w-[80px] truncate">
            {user.displayName || user.username}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        <DropdownMenuLabel className="flex items-center gap-2 py-2">
          <UserIcon className="h-3.5 w-3.5" />
          <div className="min-w-0">
            <div className="text-xs text-foreground/90 truncate">{user.username}</div>
            {user.email && <div className="text-[10px] text-muted-foreground truncate">{user.email}</div>}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>
          <ShieldCheck className="h-3.5 w-3.5" />
          {user.role === 'admin' ? 'Admin' : 'User'}
        </DropdownMenuItem>
        {user.role === 'admin' && (
          <DropdownMenuItem onSelect={() => navigate('/admin')}>
            <Settings className="h-3.5 w-3.5" /> Admin panel
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={() => logout()}>
          <LogOut className="h-3.5 w-3.5" /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Used only when logged out; compact style
export function GuestQuickActions() {
  const { openLogin, registerEnabled } = useAuthStore()
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => openLogin('login')}>
        <LogIn /> Log in
      </Button>
      {registerEnabled && (
        <Button variant="gradient" size="sm" onClick={() => openLogin('register')}>
          <UserPlus /> Sign up
        </Button>
      )}
    </div>
  )
}
