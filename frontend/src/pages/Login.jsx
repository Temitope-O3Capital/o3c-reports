import { useState } from 'react'

export default function Login({ onLogin }) {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [show,     setShow]     = useState(false)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')

  async function submit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await onLogin(email, password)
    } catch (err) {
      setError(err.message || 'Invalid credentials')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex bg-[#F8FAFC] dark:bg-slate-900">

      {/* ── Brand panel ── */}
      <div className="hidden lg:flex flex-col justify-between w-[420px] bg-primary flex-shrink-0 p-10">
        <div>
          <div className="flex items-baseline gap-2 mb-12">
            <span className="text-3xl font-bold text-white">O3<span className="text-accent">C</span></span>
            <span className="text-white/40 text-sm font-medium">Cards</span>
          </div>
          <h2 className="text-2xl font-semibold text-white leading-snug mb-3">
            Intelligent reporting<br />for your card portfolio
          </h2>
          <p className="text-sm text-white/50 leading-relaxed">
            Real-time insights across transactions, collections, recovery, and growth — all in one place.
          </p>

          <div className="mt-10 space-y-4">
            {[
              { icon: 'bolt',          label: 'Live MSSQL data with Supabase fallback' },
              { icon: 'shield_person', label: 'Role-based access for every team' },
              { icon: 'analytics',     label: 'Cohort analysis and retention heatmaps' },
              { icon: 'sync',          label: 'Automated daily sync engine' },
            ].map(f => (
              <div key={f.label} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-white/[0.08] flex items-center justify-center flex-shrink-0">
                  <span className="material-symbols-rounded text-[18px] text-white/60">{f.icon}</span>
                </div>
                <p className="text-sm text-white/55">{f.label}</p>
              </div>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-white/20">© 2026 O3 Capital · All rights reserved</p>
      </div>

      {/* ── Form panel ── */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-[380px]">

          <div className="flex items-baseline gap-2 mb-8 lg:hidden">
            <span className="text-2xl font-bold text-primary dark:text-white">O3<span className="text-accent">C</span></span>
            <span className="text-slate-400 text-sm font-medium">Cards</span>
          </div>

          <h1 className="text-[22px] font-semibold text-slate-900 dark:text-white mb-1">Sign in</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mb-7">
            Enter your credentials to continue
          </p>

          {error && (
            <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800/40 text-red-600 dark:text-red-400 text-sm rounded-xl px-4 py-3 mb-5">
              <span className="material-symbols-rounded text-[16px] flex-shrink-0">error</span>
              {error}
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="form-label">Email address</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="form-input"
                placeholder="you@o3ccards.com"
                required
                autoFocus
              />
            </div>

            <div>
              <label className="form-label">Password</label>
              <div className="relative">
                <input
                  type={show ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="form-input pr-10"
                  placeholder="••••••••"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShow(s => !s)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                  tabIndex={-1}
                >
                  <span className="material-symbols-rounded text-[18px]">
                    {show ? 'visibility_off' : 'visibility'}
                  </span>
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full py-2.5 mt-1 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loading ? (
                <>
                  <div className="spinner" style={{ borderTopColor: 'rgba(255,255,255,0.8)', borderColor: 'rgba(255,255,255,0.2)', width: 16, height: 16 }} />
                  Signing in…
                </>
              ) : 'Sign in'}
            </button>
          </form>

          <p className="text-xs text-slate-400 text-center mt-6">
            Restricted to authorised O3 Capital personnel
          </p>
        </div>
      </div>
    </div>
  )
}
