import { createContext, useContext, useEffect, useState, useCallback, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'

type User = { id: string; email: string }
type AuthState = { user: User | null; csrf: string; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void> }
const AuthContext = createContext<AuthState | null>(null)
export function useAuth() { const state = useContext(AuthContext); if (!state) throw new Error('Auth provider missing'); return state }
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null), [csrf, setCsrf] = useState(''), [loading, setLoading] = useState(true)
  const refresh = useCallback(async () => {
    try { const response = await fetch('/api/session'); if (!response.ok) throw new Error(); const data = await response.json(); setUser(data.user); setCsrf(data.csrfToken) }
    catch { setUser(null); setCsrf('') } finally { setLoading(false) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  async function logout() {
    const response = await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf } })
    if (!response.ok) throw new Error('Could not sign out. Try again.')
    setUser(null); setCsrf(''); localStorage.removeItem('devguard-run-id')
  }
  return <AuthContext.Provider value={{ user, csrf, loading, refresh, logout }}>{children}</AuthContext.Provider>
}
export function SignInPage() {
  const { user, refresh } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [register, setRegister] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const response = await fetch(`/api/auth/${register ? 'register' : 'login'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error?.message ?? 'Unable to sign in.')
      await refresh(); setPassword(''); navigate('/analysis')
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to sign in.') } finally { setBusy(false) }
  }
  if (user) return <div className="panel analysis-form"><h2>Signed in as {user.email}</h2><Link className="text-link" to="/analysis">Go to analysis</Link></div>
  return <><div className="eyebrow">DEVGUARD / ACCOUNT</div><h1 className="analysis-title">{register ? 'Create your account' : 'Sign in'}</h1><p className="analysis-subtitle">Access your saved projects and analysis runs.</p><form className="panel analysis-form auth-form" onSubmit={submit}><label htmlFor="auth-email">Email</label><input id="auth-email" type="email" required maxLength={254} autoComplete="email" value={email} onChange={e => setEmail(e.target.value)}/><label htmlFor="auth-password">Password</label><input id="auth-password" type="password" required minLength={12} maxLength={128} autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)}/><p>Use at least 12 characters. Do not reuse a password.</p><button type="submit" className="button button-primary" disabled={busy}>{busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}</button>{error && <p role="alert" className="form-error">{error}</p>}</form><button type="button" className="auth-switch text-link" onClick={() => { setRegister(!register); setError('') }}>{register ? 'Already have an account? Sign in' : 'New here? Create an account'}</button></>
}
