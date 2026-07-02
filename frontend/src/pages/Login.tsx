import { useState, FormEvent } from 'react'
import { AuthUser } from '../hooks/useAuth'
import { API } from '../lib/api'


export default function Login({ onLogin }: { onLogin: (u: AuthUser) => void }) {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [showPw,   setShowPw]   = useState(false)
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  const [showForgot, setShowForgot] = useState(false)
  const [forgotEmail, setForgotEmail] = useState('')
  const [forgotLoading, setForgotLoading] = useState(false)
  const [forgotDone, setForgotDone] = useState(false)

  // MFA step
  const [mfaToken,  setMfaToken]  = useState('')
  const [mfaCode,   setMfaCode]   = useState('')
  const [mfaLoading,setMfaLoading]= useState(false)
  const [mfaError,  setMfaError]  = useState('')

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
        credentials: 'include',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as any).detail || 'Invalid credentials')
      }
      const data = await res.json()

      // TOTP required — move to step 2
      if (data.mfa_required) {
        setMfaToken(data.mfa_token)
        setLoading(false)
        return
      }

      const user = data.user
      if (!user || typeof user.id === 'undefined' || !user.email || !user.role) {
        throw new Error('Unexpected response from server. Please try again.')
      }
      localStorage.setItem('o3c_token', data.access_token)
      localStorage.setItem('o3c_user', JSON.stringify(user))
      onLogin(user)
    } catch (err: any) {
      setError(err.message || 'Login failed. Please try again.')
      setLoading(false)
    }
  }

  async function submitMFA(e: FormEvent) {
    e.preventDefault()
    setMfaError('')
    if (!mfaCode || mfaCode.length !== 6) { setMfaError('Enter the 6-digit code from your authenticator app.'); return }
    setMfaLoading(true)
    try {
      const res = await fetch(`${API}/api/auth/totp/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mfa_token: mfaToken, code: mfaCode }),
        credentials: 'include',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as any).detail || 'Invalid code')
      }
      const data = await res.json()
      localStorage.setItem('o3c_token', data.access_token)
      localStorage.setItem('o3c_user', JSON.stringify(data.user))
      onLogin(data.user)
    } catch (err: any) {
      setMfaError(err.message || 'Verification failed.')
      setMfaLoading(false)
    }
  }

  const inputBase = {
    background: '#fff',
    borderColor: error ? '#C00000' : 'rgba(15,23,42,0.15)',
  }

  function focusStyle(e: React.FocusEvent<HTMLInputElement>) {
    e.currentTarget.style.borderColor = '#0E2841'
    e.currentTarget.style.boxShadow   = '0 0 0 3px rgba(14,40,65,0.08)'
  }
  function blurStyle(e: React.FocusEvent<HTMLInputElement>) {
    e.currentTarget.style.borderColor = error ? '#C00000' : 'rgba(15,23,42,0.15)'
    e.currentTarget.style.boxShadow   = 'none'
  }

  async function submitForgot(e: React.FormEvent) {
    e.preventDefault()
    if (!forgotEmail) return
    setForgotLoading(true)
    await fetch(`${API}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: forgotEmail }),
    }).catch(() => {})
    setForgotLoading(false)
    setForgotDone(true)
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

          {/* ── Step 2: TOTP challenge ── */}
          {mfaToken ? (
            <>
              <div className="flex items-center gap-2 mb-6">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: 'rgba(14,40,65,0.07)' }}>
                  <span className="material-symbols-rounded text-[18px]" style={{ color: '#0E2841' }}>lock</span>
                </div>
                <div>
                  <h1 className="text-xl font-bold text-slate-900">Two-factor authentication</h1>
                  <p className="text-sm text-slate-500">Enter the code from your authenticator app</p>
                </div>
              </div>

              <form onSubmit={submitMFA} className="space-y-4">
                <div>
                  <label htmlFor="mfa-code" className="block text-sm font-medium text-slate-700 mb-1.5">
                    6-digit code
                  </label>
                  <input
                    id="mfa-code"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={mfaCode}
                    onChange={e => setMfaCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="000000"
                    autoFocus
                    autoComplete="one-time-code"
                    className="w-full px-3.5 py-2.5 text-center text-xl tracking-[0.5em] rounded-lg border transition-all outline-none"
                    style={{ background: '#fff', borderColor: mfaError ? '#C00000' : 'rgba(15,23,42,0.15)' }}
                    onFocus={focusStyle}
                    onBlur={blurStyle}
                  />
                </div>

                {mfaError && (
                  <div className="flex items-start gap-2.5 p-3 rounded-lg text-sm"
                    style={{ background: 'rgba(220,38,38,0.06)', color: '#B91C1C' }}>
                    <span className="material-symbols-rounded text-[16px] flex-shrink-0 mt-px">error</span>
                    {mfaError}
                  </div>
                )}

                <button type="submit" disabled={mfaLoading || mfaCode.length !== 6}
                  className="w-full flex items-center justify-center gap-2 py-2.5 text-sm font-semibold text-white rounded-lg transition-all disabled:opacity-60"
                  style={{ background: '#0E2841' }}>
                  {mfaLoading
                    ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Verifying…</>
                    : 'Verify'}
                </button>

                <button type="button" onClick={() => { setMfaToken(''); setMfaCode(''); setMfaError('') }}
                  className="w-full text-sm text-slate-500 hover:text-slate-800 transition-colors text-center">
                  ← Back to sign in
                </button>
              </form>
            </>
          ) : (
            /* ── Step 1: password ── */
            <>
              <h1 className="text-2xl font-bold text-slate-900 mb-1">Sign in</h1>
              <p className="text-sm text-slate-500 mb-8">Access your reporting dashboard</p>

              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label htmlFor="login-email" className="block text-sm font-medium text-slate-700 mb-1.5">Email address</label>
                  <input
                    id="login-email"
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
                    <label htmlFor="login-password" className="block text-sm font-medium text-slate-700">Password</label>
                  </div>
                  <div className="relative">
                    <input
                      id="login-password"
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

              <div className="mt-5 text-center">
                <button
                  type="button"
                  onClick={() => { setShowForgot(!showForgot); setForgotDone(false); setForgotEmail('') }}
                  className="text-sm text-slate-500 hover:text-slate-800 underline underline-offset-2 transition-colors">
                  Forgot password?
                </button>
              </div>

              {showForgot && (
                <div className="mt-4 p-4 rounded-xl border border-slate-200 bg-white">
                  {forgotDone ? (
                    <p className="text-sm text-slate-600">
                      If your email is on record, you'll receive a temporary password shortly. Check your inbox and log in, then change your password immediately.
                    </p>
                  ) : (
                    <form onSubmit={submitForgot} className="space-y-3">
                      <p className="text-sm font-medium text-slate-700">Enter your work email to receive a temporary password.</p>
                      <input
                        type="email"
                        value={forgotEmail}
                        onChange={e => setForgotEmail(e.target.value)}
                        placeholder="you@o3cards.com"
                        className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-200 outline-none transition-all"
                        required
                      />
                      <button type="submit" disabled={forgotLoading}
                        className="w-full py-2.5 text-sm font-semibold text-white rounded-lg transition-all disabled:opacity-60"
                        style={{ background: '#0E2841' }}>
                        {forgotLoading ? 'Sending…' : 'Send temporary password'}
                      </button>
                    </form>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
