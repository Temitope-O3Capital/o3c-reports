import { useState } from 'react'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

export default function ChangePassword({ user, onDone }) {
  const [current,  setCurrent]  = useState('')
  const [next,     setNext]     = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [showCur,  setShowCur]  = useState(false)
  const [showNew,  setShowNew]  = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    if (next.length < 8) {
      setError('New password must be at least 8 characters.')
      return
    }
    if (next !== confirm) {
      setError('New passwords do not match.')
      return
    }

    setLoading(true)
    try {
      const token = localStorage.getItem('o3c_token')
      const res = await fetch(`${API}/api/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ current_password: current, new_password: next }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || 'Failed to change password.')
      }
      onDone()
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const strength = next.length === 0 ? null
    : next.length < 8 ? 'weak'
    : /[A-Z]/.test(next) && /[0-9]/.test(next) && /[^A-Za-z0-9]/.test(next) ? 'strong'
    : 'medium'

  const STRENGTH_COLOR = { weak: '#EF4444', medium: '#F59E0B', strong: '#10B981' }
  const STRENGTH_LABEL = { weak: 'Weak', medium: 'Good', strong: 'Strong' }

  return (
    <div className="min-h-screen flex items-center justify-center p-4"
      style={{ background: 'rgb(var(--bg-page))' }}>
      <div className="w-full max-w-md">

        {/* Logo */}
        <div className="flex items-baseline gap-1.5 justify-center mb-8">
          <span className="text-[28px] font-bold tracking-tight" style={{ color: '#0E2841' }}>
            O3<span style={{ color: '#C00000' }}>C</span>
          </span>
          <span style={{ color: '#94A3B8', fontSize: 13, fontWeight: 500 }}>Cards</span>
        </div>

        <div className="card p-8">
          {/* Header */}
          <div className="mb-6">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
              style={{ background: 'rgb(14 40 65 / 0.07)' }}>
              <span className="material-symbols-rounded text-[22px]" style={{ color: '#0E2841' }}>lock_reset</span>
            </div>
            <h1 className="text-[18px] font-semibold text-slate-900 dark:text-white leading-snug">
              Set your password
            </h1>
            <p className="text-sm text-slate-400 mt-1 leading-relaxed">
              Welcome, <span className="font-medium text-slate-600 dark:text-slate-300">{user?.full_name}</span>.
              Your account was created with a temporary password.
              Please set a new one to continue.
            </p>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm rounded-xl px-4 py-3 mb-4"
              style={{ background: 'rgb(239 68 68 / 0.07)', border: '1px solid rgb(239 68 68 / 0.15)', color: '#DC2626' }}>
              <span className="material-symbols-rounded text-[16px] flex-shrink-0">error</span>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Current (temporary) password */}
            <div>
              <label className="form-label">Temporary password</label>
              <div className="relative">
                <input
                  type={showCur ? 'text' : 'password'}
                  value={current}
                  onChange={e => setCurrent(e.target.value)}
                  placeholder="Enter the temporary password you were given"
                  className="form-input pr-10"
                  required
                  autoFocus
                />
                <button type="button" tabIndex={-1}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  onClick={() => setShowCur(v => !v)}>
                  <span className="material-symbols-rounded text-[18px]">
                    {showCur ? 'visibility_off' : 'visibility'}
                  </span>
                </button>
              </div>
            </div>

            {/* New password */}
            <div>
              <label className="form-label">New password</label>
              <div className="relative">
                <input
                  type={showNew ? 'text' : 'password'}
                  value={next}
                  onChange={e => setNext(e.target.value)}
                  placeholder="At least 8 characters"
                  className="form-input pr-10"
                  required
                />
                <button type="button" tabIndex={-1}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  onClick={() => setShowNew(v => !v)}>
                  <span className="material-symbols-rounded text-[18px]">
                    {showNew ? 'visibility_off' : 'visibility'}
                  </span>
                </button>
              </div>
              {strength && (
                <div className="flex items-center gap-2 mt-1.5">
                  <div className="flex gap-1 flex-1">
                    {['weak','medium','strong'].map((s, i) => (
                      <div key={s} className="h-1 flex-1 rounded-full transition-all"
                        style={{
                          background: ['weak','medium','strong'].indexOf(strength) >= i
                            ? STRENGTH_COLOR[strength] : 'rgb(var(--bg-subtle))'
                        }} />
                    ))}
                  </div>
                  <span className="text-xs font-medium" style={{ color: STRENGTH_COLOR[strength] }}>
                    {STRENGTH_LABEL[strength]}
                  </span>
                </div>
              )}
            </div>

            {/* Confirm */}
            <div>
              <label className="form-label">Confirm new password</label>
              <input
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="Repeat your new password"
                className="form-input"
                required
              />
              {confirm && next !== confirm && (
                <p className="text-xs text-red-500 mt-1">Passwords do not match</p>
              )}
            </div>

            <button
              type="submit"
              disabled={loading || !current || !next || !confirm}
              className="btn btn-primary w-full gap-2 mt-2 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loading
                ? <><div className="spinner" style={{ width: 14, height: 14, borderColor: 'rgba(255,255,255,0.25)', borderTopColor: 'white' }} /> Setting password…</>
                : <><span className="material-symbols-rounded text-[17px]">lock</span> Set password &amp; continue</>
              }
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-slate-400 mt-4">
          O3C Cards · Reports Dashboard
        </p>
      </div>
    </div>
  )
}
