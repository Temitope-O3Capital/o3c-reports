import { useState, FormEvent } from 'react'

type User = { name: string; role: string; email: string }

const DEMO_USERS: Record<string, User> = {
  'admin@o3cards.com':       { name: 'Temitope Opemiposi', role: 'admin',       email: 'admin@o3cards.com' },
  'collections@o3cards.com': { name: 'Amaka Okonkwo',      role: 'collections', email: 'collections@o3cards.com' },
  'sales@o3cards.com':       { name: 'Chidi Nwankwo',      role: 'sales',       email: 'sales@o3cards.com' },
}

export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
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
    await new Promise(r => setTimeout(r, 900))
    const user = DEMO_USERS[email.toLowerCase()]
    if (user && password.length >= 4) {
      onLogin(user)
    } else {
      setError('Invalid credentials. Try admin@o3cards.com with any password.')
      setLoading(false)
    }
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
              { icon: 'bolt',        label: 'Live MSSQL data via Cloudflare Tunnel' },
              { icon: 'shield',      label: 'Role-based access — 7 permission levels' },
              { icon: 'bar_chart',   label: '₦3.1B+ in monthly transaction volume' },
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
                style={{
                  background: '#fff', borderColor: error ? '#DC2626' : 'rgba(15,23,42,0.15)',
                  boxShadow: 'none',
                }}
                onFocus={e => { e.currentTarget.style.borderColor = '#0E2841'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(14,40,65,0.08)' }}
                onBlur={e => { e.currentTarget.style.borderColor = error ? '#DC2626' : 'rgba(15,23,42,0.15)'; e.currentTarget.style.boxShadow = 'none' }}
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-sm font-medium text-slate-700">Password</label>
                <button type="button" className="text-xs font-medium" style={{ color: '#C00000' }}>
                  Forgot password?
                </button>
              </div>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••" autoComplete="current-password"
                  className="w-full px-3.5 py-2.5 pr-10 text-sm rounded-lg border transition-all outline-none"
                  style={{
                    background: '#fff', borderColor: error ? '#DC2626' : 'rgba(15,23,42,0.15)',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = '#0E2841'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(14,40,65,0.08)' }}
                  onBlur={e => { e.currentTarget.style.borderColor = error ? '#DC2626' : 'rgba(15,23,42,0.15)'; e.currentTarget.style.boxShadow = 'none' }}
                />
                <button type="button" onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                  aria-label={showPw ? 'Hide password' : 'Show password'}>
                  <span className="material-symbols-rounded text-[18px]">{showPw ? 'visibility_off' : 'visibility'}</span>
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2.5 p-3 rounded-lg text-sm" style={{ background: 'rgba(220,38,38,0.06)', color: '#B91C1C' }}>
                <span className="material-symbols-rounded text-[16px] flex-shrink-0 mt-px">error</span>
                {error}
              </div>
            )}

            <button type="submit" disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-2.5 text-sm font-semibold text-white rounded-lg transition-all mt-2"
              style={{ background: loading ? '#16374F' : '#0E2841' }}>
              {loading
                ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Signing in…</>
                : 'Sign in'}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-slate-400">
            Demo: use <span className="font-medium text-slate-600">admin@o3cards.com</span> + any password
          </p>
        </div>
      </div>
    </div>
  )
}
