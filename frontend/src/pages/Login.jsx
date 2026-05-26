import { useState } from 'react'

export default function Login({ onLogin }) {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const [showPwd,  setShowPwd]  = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await onLogin(email, password)
    } catch (err) {
      setError(err.message || 'Login failed. Check your credentials.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex bg-slate-50 dark:bg-slate-900">
      {/* Left panel — brand */}
      <div className="hidden lg:flex flex-col justify-between w-[420px] flex-shrink-0 bg-primary p-12">
        <div>
          <div className="text-3xl font-black text-white tracking-tight mb-1">
            O3<span className="text-accent">C</span> Cards
          </div>
          <p className="text-white/40 text-sm font-medium tracking-wider uppercase">Reports Dashboard</p>
        </div>

        <div className="space-y-6">
          {[
            { icon: 'bar_chart',         title: 'Live Analytics',    desc: 'Real-time data direct from MSSQL' },
            { icon: 'credit_card',        title: 'Card Operations',   desc: 'Track issuance, activation & status' },
            { icon: 'manage_accounts',   title: 'Role-based Access', desc: 'Each team sees only what they need' },
          ].map(f => (
            <div key={f.title} className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                <span className="material-symbols-outlined text-white text-[20px]">{f.icon}</span>
              </div>
              <div>
                <p className="text-white font-semibold text-sm">{f.title}</p>
                <p className="text-white/40 text-xs mt-0.5">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <p className="text-white/20 text-xs">© {new Date().getFullYear()} O3C Cards · All rights reserved</p>
      </div>

      {/* Right panel — form */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          {/* Mobile brand */}
          <div className="lg:hidden text-center mb-8">
            <div className="text-2xl font-black text-primary dark:text-white">
              O3<span className="text-accent">C</span> Cards
            </div>
            <p className="text-slate-400 text-xs font-medium tracking-wider uppercase mt-1">Reports Dashboard</p>
          </div>

          <h1 className="text-2xl font-bold text-slate-900 dark:text-white mb-1">Welcome back</h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm mb-8">Sign in to your account to continue</p>

          {error && (
            <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm rounded-lg px-4 py-3 mb-6">
              <span className="material-symbols-outlined text-[18px] flex-shrink-0">error</span>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Email address
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@o3ccards.com"
                required
                autoFocus
                className="w-full px-4 py-2.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary dark:focus:border-primary-light transition"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPwd ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  className="w-full px-4 py-2.5 pr-11 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder-slate-400 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary dark:focus:border-primary-light transition"
                />
                <button
                  type="button"
                  onClick={() => setShowPwd(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    {showPwd ? 'visibility_off' : 'visibility'}
                  </span>
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-primary hover:bg-primary-light text-white font-semibold rounded-lg text-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed shadow-md shadow-primary/20"
            >
              {loading ? (
                <>
                  <div className="spinner !border-white/30 !border-t-white" />
                  Signing in…
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-[18px]">login</span>
                  Sign in
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
