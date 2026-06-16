import { useState, FormEvent } from 'react'
import { AuthUser } from '../hooks/useAuth'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

export default function Login({ onLogin }: { onLogin: (u: AuthUser) => void }) {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [showPw,   setShowPw]   = useState(false)
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (!email || !password) { setError('Please enter your email and password.'); return }
    setLoading(true)
    try {
      const res = await fetch(`${API}/api/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: email, password }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as any).detail || 'Invalid credentials')
      }
      const data = await res.json()
      localStorage.setItem('o3c_token', data.access_token)
      localStorage.setItem('o3c_user', JSON.stringify(data.user))
      onLogin(data.user)
    } catch (err: any) {
      setError(err.message || 'Login failed. Please try again.')
      setLoading(false)
    }
  }

  const inputBase = {
    background: '#fff',
    borderColor: error ? '#DC2626' : 'rgba(15,23,42,0.15)',
  }

  function focusStyle(e: React.FocusEvent<HTMLInputElement>) {
    e.currentTarget.style.borderColor = '#0E2841'
    e.currentTarget.style.boxShadow   = '0 0 0 3px rgba(14,40,65,0.08)'
  }
  function blurStyle(e: React.FocusEvent<HTMLInputElement>) {
    e.currentTarget.style.borderColor = error ? '#DC2626' : 'rgba(15,23,42,0.15)'
    e.currentTarget.style.boxShadow   = 'none'
  }

  return (
    <div className="min-h-screen flex">
      {/* Left — brand panel */}
      <div className="hidden lg:flex flex-col justify-between w-[44%] p-12" style={{ background: '#0E2841' }}>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: '#C00000' }}>
            <span className="text-white font-bold text-sm">O3</span>
          </div>
          <span className="text-white font-bold text-lg tracking-tight">O3 Capital</span>
        </div>

        <div>
          <p className="text-4xl font-bold text-white leading-tight mb-4">
            One dashboard.<br />Every insight.
          </p>
          <p className="text-base leading-relaxed" style={{ color: 'rgba(255,255,255,0.55)' }}>
            Live card portfolio data, collections tracking, recovery analytics,
            and CRM — all in one place. Powered by your MSSQL source of truth.
          </p>

          <div className="mt-10 space-y-4">
            {[
              { icon: 'bolt',      label: 'Live MSSQL data via Cloudflare Tunnel' },
              { icon: 'shield',    label: 'Role-based access — 17 permission levels' },
              { icon: 'bar_chart', label: '₦3.1B+ in monthly transaction volume' },
            ].map(({ icon, label }) => (
              <div key={label} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: 'rgba(192,0,0,0.18)' }}>
                  <span className="material-symbols-rounded text-[16px]" style={{ color: '#C00000' }}>{icon}</span>
                </div>
                <span className="text-sm" style={{ color: 'rgba(255,255,255,0.65)' }}>{label}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="text-xs" style={{ color: 'rgba(255,255,255,0.25)' }}>
          © 2026 O3 Capital. All rights reserved.
        </p>
      </div>

      {/* Right — form */}
      <div className="flex-1 flex items-center justify-center p-8 bg-[#F6F5F2]">
        <div className="w-full max-w-[380px] animate-fadeIn">
          {/* Mobile logo */}
          <div className="flex items-center gap-2.5 mb-8 lg:hidden">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: '#C00000' }}>
              <span className="text-white font-bold text-sm">O3</span>
            </div>
            <span className="font-bold text-lg" style={{ color: '#0E2841' }}>O3 Capital</span>
          </div>

          <h1 className="text-2xl font-bold text-slate-900 mb-1">Sign in</h1>
          <p className="text-sm text-slate-500 mb-8">Access your reporting dashboard</p>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Email address</label>
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@o3cards.com" autoComplete="email"
                className="w-full px-3.5 py-2.5 text-sm rounded-lg border transition-all outline-none"
                style={inputBase}
                onFocus={focusStyle}
                onBlur={blurStyle}
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-sm font-medium text-slate-700">Password</label>
              </div>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'} value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••" autoComplete="current-password"
                  className="w-full px-3.5 py-2.5 pr-10 text-sm rounded-lg border transition-all outline-none"
                  style={inputBase}
                  onFocus={focusStyle}
                  onBlur={blurStyle}
                />
                <button type="button" onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                  aria-label={showPw ? 'Hide password' : 'Show password'}>
                  <span className="material-symbols-rounded text-[18px]">{showPw ? 'visibility_off' : 'visibility'}</span>
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2.5 p-3 rounded-lg text-sm"
                style={{ background: 'rgba(220,38,38,0.06)', color: '#B91C1C' }}>
                <span className="material-symbols-rounded text-[16px] flex-shrink-0 mt-px">error</span>
                {error}
              </div>
            )}

            <button type="submit" disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-2.5 text-sm font-semibold text-white rounded-lg transition-all mt-2 disabled:opacity-60"
              style={{ background: '#0E2841' }}>
              {loading
                ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Signing in…</>
                : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
