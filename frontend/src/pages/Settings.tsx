import { useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Page, SectionCard, NAVY } from '../components/UI'
import { roleLabel } from '../lib/roles'
import { apiFetch } from '../lib/api'
import { toast } from 'sonner'

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} role="switch" aria-checked={checked}
      className="relative flex-shrink-0 w-10 h-5 rounded-full transition-colors focus:outline-none"
      style={{ background: checked ? NAVY : 'var(--txt3)' }}>
      <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-[var(--card)] shadow transition-transform"
        style={{ transform: checked ? 'translateX(20px)' : 'none' }} />
    </button>
  )
}

type TOTPStep = 'idle' | 'setup' | 'verify' | 'enabled'

export default function Settings() {
  const user = JSON.parse(localStorage.getItem('o3c_user') || '{}')

  const [notif, setNotif] = useState({
    dailyReport:  true,
    collections:  true,
    reconciliation: false,
    overdue:      true,
    campaigns:    false,
  })

  function toggle(key: keyof typeof notif) {
    setNotif(n => ({ ...n, [key]: !n[key] }))
  }

  // ── TOTP state ────────────────────────────────────────────────────────────
  const [totpStep,    setTotpStep]    = useState<TOTPStep>('idle')
  const [totpSecret,  setTotpSecret]  = useState('')
  const [totpURI,     setTotpURI]     = useState('')
  const [totpCode,    setTotpCode]    = useState('')
  const [totpLoading, setTotpLoading] = useState(false)
  const [totpEnabled, setTotpEnabled] = useState(false)   // derived from server on mount

  // Disable TOTP state
  const [showDisable,   setShowDisable]   = useState(false)
  const [disableCode,   setDisableCode]   = useState('')
  const [disableLoading,setDisableLoading]= useState(false)

  async function startSetup() {
    setTotpLoading(true)
    try {
      const d = await apiFetch('/api/auth/totp/setup', { method: 'POST' })
      setTotpSecret(d.secret)
      setTotpURI(d.uri)
      setTotpStep('setup')
    } catch (e: any) {
      toast.error(e.message || 'Failed to start setup')
    } finally {
      setTotpLoading(false)
    }
  }

  async function verifyCode() {
    if (totpCode.length !== 6) return
    setTotpLoading(true)
    try {
      await apiFetch('/api/auth/totp/verify', {
        method: 'POST',
        body: JSON.stringify({ code: totpCode }),
      })
      setTotpStep('enabled')
      setTotpEnabled(true)
      toast.success('Two-factor authentication enabled')
    } catch (e: any) {
      toast.error(e.message || 'Invalid code — try again')
    } finally {
      setTotpLoading(false)
    }
  }

  async function disableTOTP() {
    setDisableLoading(true)
    try {
      await apiFetch('/api/auth/totp/disable', {
        method: 'POST',
        body: JSON.stringify({ code: disableCode }),
      })
      setTotpEnabled(false)
      setTotpStep('idle')
      setShowDisable(false)
      setDisableCode('')
      toast.success('Two-factor authentication disabled')
    } catch (e: any) {
      toast.error(e.message || 'Invalid code')
    } finally {
      setDisableLoading(false)
    }
  }

  return (
    <Page title="Settings" subtitle="Account and notification preferences">

      {/* Profile */}
      <SectionCard title="Profile" subtitle="Your account information" className="mb-4">
        <div className="px-5 py-4 space-y-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full flex items-center justify-center text-lg font-bold text-white flex-shrink-0"
              style={{ background: NAVY }}>
              {(user.name || 'U').split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()}
            </div>
            <div>
              <p className="text-[15px] font-semibold" style={{ color: 'var(--txt)' }}>{user.name || '—'}</p>
              <p className="text-[13px]" style={{ color: 'var(--txt2)' }}>{user.email || '—'}</p>
              <span className="inline-block mt-1 text-[11px] font-semibold px-2 py-0.5 rounded capitalize"
                style={{ background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>
                {roleLabel(user.role || '')}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t" style={{ borderColor: 'var(--bdr)' }}>
            {[
              { label: 'Full Name',  value: user.name,  icon: 'person' },
              { label: 'Email',      value: user.email, icon: 'mail' },
              { label: 'Role',       value: roleLabel(user.role || ''), icon: 'badge' },
              { label: 'Account ID', value: `#${user.id || '—'}`, icon: 'tag' },
            ].map(f => (
              <div key={f.label} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: 'var(--chip-bg)' }}>
                  <span className="material-symbols-rounded text-[15px]" style={{ color: 'var(--txt2)' }}>{f.icon}</span>
                </div>
                <div>
                  <p className="text-[10.5px] font-semibold uppercase tracking-wider" style={{ color: 'var(--txt2)' }}>{f.label}</p>
                  <p className="text-[13px] font-medium capitalize" style={{ color: 'var(--txt)' }}>{f.value || '—'}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </SectionCard>

      {/* Security / TOTP */}
      <SectionCard title="Security" subtitle="Two-factor authentication" className="mb-4">
        <div className="px-5 py-4">
          {totpEnabled || totpStep === 'enabled' ? (
            /* ── TOTP enabled state ── */
            <div>
              <div className="flex items-center gap-3 p-4 rounded-xl mb-4"
                style={{ background: 'rgba(5,150,105,0.06)', border: '1px solid rgba(5,150,105,0.14)' }}>
                <span className="material-symbols-rounded text-[20px]" style={{ color: '#059669' }}>verified_user</span>
                <div>
                  <p className="text-[13px] font-semibold" style={{ color: '#059669' }}>Two-factor authentication is active</p>
                  <p className="text-[12px] mt-0.5" style={{ color: 'var(--txt2)' }}>Your account requires an authenticator code on every login.</p>
                </div>
              </div>
              {!showDisable ? (
                <button onClick={() => setShowDisable(true)}
                  className="text-[13px] hover:text-red-600 underline underline-offset-2 transition-colors"
                  style={{ color: 'var(--txt2)' }}>
                  Disable two-factor authentication
                </button>
              ) : (
                <div className="space-y-3">
                  <p className="text-[13px]" style={{ color: 'var(--txt)' }}>Enter your authenticator code to confirm disabling 2FA:</p>
                  <input type="text" inputMode="numeric" maxLength={6}
                    value={disableCode}
                    onChange={e => setDisableCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="000000"
                    className="w-40 px-3 py-2 text-center text-lg tracking-widest rounded-lg border outline-none"
                    style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }}
                  />
                  <div className="flex gap-2">
                    <button onClick={disableTOTP} disabled={disableLoading || disableCode.length !== 6}
                      className="px-4 py-2 text-sm font-semibold text-white rounded-lg disabled:opacity-60 transition-colors"
                      style={{ background: '#C00000' }}>
                      {disableLoading ? 'Disabling…' : 'Disable 2FA'}
                    </button>
                    <button onClick={() => { setShowDisable(false); setDisableCode('') }}
                      className="px-4 py-2 text-sm rounded-lg transition-colors"
                      style={{ color: 'var(--txt2)' }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : totpStep === 'idle' ? (
            /* ── Idle: offer to enable ── */
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'var(--chip-bg)' }}>
                <span className="material-symbols-rounded text-[20px]" style={{ color: NAVY }}>phonelink_lock</span>
              </div>
              <div className="flex-1">
                <p className="text-[13px] font-semibold" style={{ color: 'var(--txt)' }}>Authenticator app (TOTP)</p>
                <p className="text-[12px] mt-0.5 mb-3" style={{ color: 'var(--txt2)' }}>
                  Add an extra layer of security. Use Google Authenticator, Authy, or any TOTP app.
                </p>
                <button onClick={startSetup} disabled={totpLoading}
                  className="px-4 py-2 text-sm font-semibold text-white rounded-lg disabled:opacity-60 transition-colors"
                  style={{ background: NAVY }}>
                  {totpLoading ? 'Setting up…' : 'Enable two-factor authentication'}
                </button>
              </div>
            </div>
          ) : totpStep === 'setup' ? (
            /* ── QR code + manual secret ── */
            <div className="space-y-5">
              <p className="text-[13px]" style={{ color: 'var(--txt)' }}>
                Scan this QR code with your authenticator app, then enter the 6-digit code to verify.
              </p>
              <div className="flex flex-col sm:flex-row gap-6 items-start">
                <div className="p-3 border rounded-xl shadow-sm" style={{ background: 'var(--card)', borderColor: 'var(--bdr)' }}>
                  <QRCodeSVG value={totpURI} size={160} level="M" />
                </div>
                <div className="flex-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--txt2)' }}>Manual entry key</p>
                  <code className="block text-[13px] font-mono rounded-lg px-3 py-2 break-all select-all" style={{ background: 'var(--input-bg)', border: '1px solid var(--bdr)', color: 'var(--txt)' }}>
                    {totpSecret}
                  </code>
                  <p className="text-[11.5px] mt-2" style={{ color: 'var(--txt2)' }}>
                    If you can't scan the code, enter this key manually in your authenticator app.
                  </p>
                </div>
              </div>
              <div className="pt-2 border-t" style={{ borderColor: 'var(--bdr)' }}>
                <p className="text-[13px] mb-3" style={{ color: 'var(--txt)' }}>Enter the 6-digit code from your authenticator app:</p>
                <div className="flex items-center gap-3">
                  <input type="text" inputMode="numeric" maxLength={6}
                    value={totpCode}
                    onChange={e => setTotpCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="000000"
                    autoFocus
                    className="w-36 px-3 py-2.5 text-center text-xl tracking-[0.4em] rounded-lg border outline-none transition-all"
                    style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }}
                    onFocus={e => { e.currentTarget.style.borderColor = NAVY; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(14,40,65,0.08)' }}
                    onBlur={e => { e.currentTarget.style.borderColor = 'var(--input-bdr)'; e.currentTarget.style.boxShadow = 'none' }}
                  />
                  <button onClick={verifyCode} disabled={totpLoading || totpCode.length !== 6}
                    className="px-5 py-2.5 text-sm font-semibold text-white rounded-lg disabled:opacity-60 transition-colors"
                    style={{ background: NAVY }}>
                    {totpLoading ? 'Verifying…' : 'Verify & Enable'}
                  </button>
                  <button onClick={() => { setTotpStep('idle'); setTotpCode('') }}
                    className="text-sm transition-colors"
                    style={{ color: 'var(--txt2)' }}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </SectionCard>

      {/* Notifications */}
      <SectionCard title="Notifications" subtitle="Email alert preferences" className="mb-4">
        <div className="px-5 py-2">
          {[
            { key: 'dailyReport' as const,     label: 'Daily Summary Report',          desc: 'Receive a daily KPI summary every morning' },
            { key: 'collections' as const,     label: 'Collections Alerts',            desc: 'Notify when collections agent logs a payment' },
            { key: 'overdue' as const,         label: 'New Overdue Accounts',          desc: 'Alert when accounts become overdue (DPD > 0)' },
            { key: 'reconciliation' as const,  label: 'Reconciliation Exceptions',     desc: 'Alert on unmatched Paystack/Interswitch settlements' },
            { key: 'campaigns' as const,       label: 'Campaign Performance',          desc: 'Receive weekly campaign delivery summaries' },
          ].map(n => (
            <div key={n.key} className="flex items-center justify-between py-3.5"
              style={{ borderBottom: '1px solid var(--bdr)' }}>
              <div className="flex-1 min-w-0 pr-4">
                <p className="text-[13px] font-medium" style={{ color: 'var(--txt)' }}>{n.label}</p>
                <p className="text-[12px] mt-0.5" style={{ color: 'var(--txt2)' }}>{n.desc}</p>
              </div>
              <Toggle checked={notif[n.key]} onChange={() => toggle(n.key)} />
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Data Source */}
      <SectionCard title="Data Source" subtitle="Current data connection status" className="mb-4">
        <div className="px-5 py-4">
          <div className="flex items-start gap-3 p-4 rounded-xl mb-3"
            style={{ background: 'rgba(5,150,105,0.06)', border: '1px solid rgba(5,150,105,0.14)' }}>
            <span className="material-symbols-rounded text-[18px] mt-0.5" style={{ color: '#059669' }}>wifi</span>
            <div>
              <p className="text-[13px] font-semibold" style={{ color: '#059669' }}>MSSQL Live — Cloudflare Tunnel</p>
              <p className="text-[12px] mt-0.5" style={{ color: 'var(--txt2)' }}>Connected via office tunnel. Data refreshes in real time.</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-4 rounded-xl"
            style={{ background: 'rgba(14,40,65,0.04)', border: '1px solid rgba(14,40,65,0.08)' }}>
            <span className="material-symbols-rounded text-[18px] mt-0.5" style={{ color: 'var(--txt2)' }}>cloud</span>
            <div>
              <p className="text-[13px] font-semibold" style={{ color: 'var(--txt)' }}>Supabase Fallback</p>
              <p className="text-[12px] mt-0.5" style={{ color: 'var(--txt2)' }}>Snapshot backup syncs daily at 18:00 WAT. Used when tunnel is offline.</p>
            </div>
          </div>
        </div>
      </SectionCard>

      {/* Help */}
      <SectionCard title="Help & Support">
        <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { icon: 'help', label: 'Documentation', desc: 'Platform usage guides' },
            { icon: 'bug_report', label: 'Report a Bug', desc: 'Let the IT team know' },
            { icon: 'support_agent', label: 'IT Support', desc: 'Contact head_it@o3cards.com' },
          ].map(h => (
            <div key={h.label} className="flex items-center gap-3 p-3.5 rounded-xl cursor-pointer transition-colors"
              style={{ border: '1px solid var(--bdr)' }}>
              <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: 'var(--chip-bg)' }}>
                <span className="material-symbols-rounded text-[17px]" style={{ color: NAVY }}>{h.icon}</span>
              </div>
              <div>
                <p className="text-[13px] font-semibold" style={{ color: 'var(--txt)' }}>{h.label}</p>
                <p className="text-[11.5px]" style={{ color: 'var(--txt2)' }}>{h.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>
    </Page>
  )
}
