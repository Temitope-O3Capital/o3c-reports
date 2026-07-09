import { useState, useEffect, useCallback } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import DOMPurify from 'dompurify'
import { toast } from 'sonner'
import { SectionCard, Spinner } from '../components/UI'
import { apiFetch, apiPost, apiPut } from '../lib/api'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, INTER } from '../lib/design'
import { roleLabel } from '../lib/roles'

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = 'profile' | 'security' | 'notifications' | 'signature' | 'voice'

type SetupStep = 'idle' | 'qr' | 'verify' | 'done'

interface TOTPSetup {
  secret: string
  uri:    string
}

interface MeData {
  sub:        string
  full_name:  string
  department: string
  role:       string
  id:         number
}

interface NotifPref {
  event_type:   string
  channel:      string
  label:        string
  description:  string
  user_enabled: boolean
  has_override: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readLocalUser() {
  try {
    const raw = localStorage.getItem('o3c_user')
    if (!raw) return null
    return JSON.parse(raw) as { id: number; name: string; email: string; role: string; must_change_password?: boolean }
  } catch { return null }
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('')
}

function roleColor(role: string): string {
  const r = role.toLowerCase()
  if (['md', 'coo', 'cfo', 'executive', 'management'].includes(r)) return NAVY
  if (r.includes('sales') || r.includes('bd')) return BLUE
  if (r.includes('collections') || r.includes('recovery')) return AMBER
  if (r.includes('cards') || r.includes('finance')) return PURPLE
  if (r.includes('it') || r.includes('admin')) return '#7C3AED'
  if (r.includes('compliance') || r.includes('risk')) return '#0891B2'
  return NAVY
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const INPUT: React.CSSProperties = {
  height: 40, padding: '0 12px', borderRadius: 8,
  border: '1px solid var(--input-bdr)', background: 'var(--input-bg)',
  color: 'var(--txt)', fontSize: 13.5, fontFamily: "'Sora', sans-serif", outline: 'none',
  width: '100%', boxSizing: 'border-box',
}

const BTN_PRIMARY: React.CSSProperties = {
  padding: '9px 22px', borderRadius: 9, border: 'none',
  background: NAVY, color: '#fff', fontSize: 13.5, fontWeight: 600,
  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8,
  fontFamily: "'Sora', sans-serif",
}

// ── Avatar ────────────────────────────────────────────────────────────────────

function Avatar({ name, role, size = 40 }: { name: string; role: string; size?: number }) {
  const color = roleColor(role)
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: color + '20', border: `2px solid ${color}40`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.36, fontWeight: 700, color, flexShrink: 0,
      fontFamily: "'Sora', sans-serif",
    }}>
      {initials(name) || '?'}
    </div>
  )
}

// ── Nav item ──────────────────────────────────────────────────────────────────

function NavItem({ label, icon, active, onClick }: { label: string; icon: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        width: '100%', padding: '9px 16px',
        border: 'none', borderLeft: `3px solid ${active ? NAVY : 'transparent'}`,
        background: active ? `${NAVY}10` : 'transparent',
        color: active ? NAVY : 'var(--txt2)',
        fontSize: 13, fontWeight: active ? 700 : 500,
        cursor: 'pointer', textAlign: 'left', borderRadius: 0,
        fontFamily: "'Sora', sans-serif",
        transition: 'background .12s, color .12s',
      }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 18, flexShrink: 0 }}>{icon}</span>
      {label}
    </button>
  )
}

// ── Profile Tab ───────────────────────────────────────────────────────────────

function ProfileTab({ local, me, onGoSecurity }: {
  local: ReturnType<typeof readLocalUser>
  me: MeData | null
  onGoSecurity: () => void
}) {
  const name       = me?.full_name   ?? local?.name  ?? 'User'
  const email      = me?.sub         ?? local?.email ?? ''
  const role       = me?.role        ?? local?.role  ?? ''
  const department = me?.department  ?? ''
  const userId     = me?.id          ?? local?.id
  const color      = roleColor(role)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {local?.must_change_password && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: `${AMBER}12`, border: `1px solid ${AMBER}30`, borderRadius: 10 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: AMBER }}>warning</span>
          <span style={{ fontSize: 13, color: AMBER, fontWeight: 600 }}>Your temporary password must be changed before you continue.</span>
          <button onClick={onGoSecurity} style={{ marginLeft: 'auto', padding: '5px 14px', borderRadius: 7, border: 'none', background: AMBER, color: '#fff', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
            Change now →
          </button>
        </div>
      )}

      <SectionCard title="Profile Information">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20 }}>
          <Avatar name={name} role={role} size={64} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--txt)', lineHeight: 1.2 }}>{name}</div>
            <div style={{ fontSize: 13, color: 'var(--txt2)', marginTop: 4 }}>{email}</div>
            <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, padding: '3px 10px', borderRadius: 20, background: color + '15', color }}>
                {roleLabel(role)}
              </span>
              {department && (
                <span style={{ fontSize: 11.5, fontWeight: 600, padding: '3px 10px', borderRadius: 20, background: 'var(--chip-bg, #F0F4FF)', color: 'var(--txt2)' }}>
                  {department}
                </span>
              )}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 20, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {[
            { label: 'Full name',   value: name },
            { label: 'Email',       value: email },
            { label: 'Role',        value: roleLabel(role) },
            { label: 'Department',  value: department || '—' },
            { label: 'User ID',     value: userId ? `#${userId}` : '—' },
          ].map(({ label, value }) => (
            <div key={label} style={{ background: 'var(--th-bg)', borderRadius: 8, padding: '10px 14px' }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 13.5, color: 'var(--txt)', fontWeight: 500, wordBreak: 'break-all' }}>{value}</div>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Account Management">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 20, color: 'var(--txt3)', marginTop: 1 }}>info</span>
          <div style={{ fontSize: 13, color: 'var(--txt2)', lineHeight: 1.65 }}>
            Profile details (name, email, role) are managed by the IT Admin.
            To change your password or set up two-factor authentication, go to the{' '}
            <button onClick={onGoSecurity} style={{ background: 'none', border: 'none', color: NAVY, fontWeight: 700, cursor: 'pointer', padding: 0, fontSize: 13, textDecoration: 'underline', fontFamily: 'inherit' }}>
              Security
            </button>{' '}tab.
          </div>
        </div>
      </SectionCard>
    </div>
  )
}

// ── Change Password ───────────────────────────────────────────────────────────

function ChangePasswordSection() {
  const [current,  setCurrent]  = useState('')
  const [next,     setNext]     = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [showCurr, setShowCurr] = useState(false)
  const [showNew,  setShowNew]  = useState(false)
  const [loading,  setLoading]  = useState(false)

  function strength(pw: string): { score: 0 | 1 | 2 | 3; label: string; color: string } {
    if (pw.length === 0) return { score: 0, label: '', color: 'transparent' }
    if (pw.length < 8)   return { score: 1, label: 'Too short', color: RED }
    const passed = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(pw)).length
    if (pw.length < 12 || passed < 2) return { score: 1, label: 'Weak', color: RED }
    if (passed < 3)                   return { score: 2, label: 'Fair', color: AMBER }
    return { score: 3, label: 'Strong', color: GREEN }
  }

  const str = strength(next)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (next !== confirm) { toast.error('Passwords do not match'); return }
    if (next.length < 12) { toast.error('Password must be at least 12 characters'); return }
    setLoading(true)
    try {
      await apiPost('/api/auth/change-password', { current_password: current, new_password: next })
      toast.success('Password updated')
      setCurrent(''); setNext(''); setConfirm('')
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to update password')
    } finally {
      setLoading(false)
    }
  }

  function PwField({ value, onChange, placeholder, show, onToggle }: {
    value: string; onChange: (v: string) => void; placeholder: string; show: boolean; onToggle: () => void
  }) {
    return (
      <div style={{ position: 'relative' }}>
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          style={{ ...INPUT, paddingRight: 40 }}
          required
        />
        <button
          type="button"
          onClick={onToggle}
          style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--txt3)', padding: 0 }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 18 }}>{show ? 'visibility_off' : 'visibility'}</span>
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 380 }}>
      <PwField value={current} onChange={setCurrent} placeholder="Current password" show={showCurr} onToggle={() => setShowCurr(v => !v)} />
      <div>
        <PwField value={next} onChange={setNext} placeholder="New password (min 12 chars)" show={showNew} onToggle={() => setShowNew(v => !v)} />
        {next && (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', gap: 4 }}>
              {[1, 2, 3].map(i => (
                <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: i <= str.score ? str.color : 'var(--bdr)', transition: 'background .2s' }} />
              ))}
            </div>
            {str.label && <div style={{ fontSize: 11, color: str.color, fontWeight: 600, marginTop: 4 }}>{str.label}</div>}
          </div>
        )}
      </div>
      <PwField value={confirm} onChange={setConfirm} placeholder="Confirm new password" show={showNew} onToggle={() => setShowNew(v => !v)} />
      {next && confirm && next !== confirm && (
        <div style={{ fontSize: 12, color: RED, display: 'flex', alignItems: 'center', gap: 4 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>error</span> Passwords do not match
        </div>
      )}
      <button type="submit" disabled={loading} style={{ ...BTN_PRIMARY, opacity: loading ? 0.7 : 1, marginTop: 4 }}>
        {loading && <Spinner size={14} color="#fff" />}
        Update Password
      </button>
    </form>
  )
}

// ── TOTP Section ──────────────────────────────────────────────────────────────

function TOTPSection() {
  const [enabled,  setEnabled]  = useState<boolean | null>(null)
  const [step,     setStep]     = useState<SetupStep>('idle')
  const [setup,    setSetup]    = useState<TOTPSetup | null>(null)
  const [code,     setCode]     = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)

  useEffect(() => {
    apiFetch<{ totp_enabled: boolean }>('/api/auth/totp/status')
      .then(r => setEnabled(r.totp_enabled))
      .catch(() => setEnabled(false))
  }, [])

  async function startSetup() {
    setLoading(true)
    try {
      const r = await apiPost<TOTPSetup>('/api/auth/totp/setup', {})
      setSetup(r); setStep('qr')
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to start setup')
    } finally { setLoading(false) }
  }

  async function verifyCode() {
    if (code.length !== 6) { toast.error('Enter the 6-digit code from your app'); return }
    setLoading(true)
    try {
      await apiPost('/api/auth/totp/verify', { code })
      toast.success('Two-factor authentication enabled')
      setEnabled(true); setStep('done'); setSetup(null); setCode('')
    } catch (e: any) {
      toast.error(e.message ?? 'Invalid code')
    } finally { setLoading(false) }
  }

  async function disableTOTP() {
    if (!password.trim() && code.length !== 6) {
      toast.error('Enter your password or a 6-digit code to disable 2FA'); return
    }
    setLoading(true)
    try {
      await apiPost('/api/auth/totp/disable', {
        password: password.trim() || undefined,
        code: code.length === 6 ? code : undefined,
      })
      toast.success('Two-factor authentication disabled')
      setEnabled(false); setStep('idle'); setPassword(''); setCode('')
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to disable 2FA')
    } finally { setLoading(false) }
  }

  if (enabled === null) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--txt2)', fontSize: 13 }}>
        <Spinner size={16} /> Loading…
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)' }}>Authenticator App (TOTP)</div>
          <div style={{ fontSize: 12.5, color: 'var(--txt2)', marginTop: 3 }}>
            Use Google Authenticator, Authy, or any TOTP-compatible app.
          </div>
        </div>
        <span style={{
          flexShrink: 0, fontSize: 11.5, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
          background: enabled ? `${GREEN}18` : 'var(--chip-bg, #F0F4FF)',
          color: enabled ? GREEN : 'var(--txt2)',
        }}>
          {enabled ? 'Enabled' : 'Not enabled'}
        </span>
      </div>

      {!enabled && step === 'idle' && (
        <button onClick={startSetup} disabled={loading} style={{ ...BTN_PRIMARY, opacity: loading ? 0.7 : 1, alignSelf: 'flex-start' }}>
          {loading && <Spinner size={14} color="#fff" />}
          <span className="material-symbols-rounded" style={{ fontSize: 17 }}>security</span>
          Set up Two-Factor Authentication
        </button>
      )}

      {!enabled && step === 'qr' && setup && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--txt2)', lineHeight: 1.6 }}>
            1. Open your authenticator app and scan the QR code below.<br />
            2. Enter the 6-digit code to confirm and activate.
          </p>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ padding: 12, background: '#fff', borderRadius: 12, border: '1px solid var(--bdr)', flexShrink: 0 }}>
              <QRCodeSVG value={setup.uri} size={160} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minWidth: 220 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', marginBottom: 4 }}>CAN'T SCAN? ENTER MANUALLY:</div>
                <code style={{
                  fontSize: 12, fontFamily: 'monospace', letterSpacing: '0.1em',
                  background: 'var(--th-bg)', padding: '6px 10px', borderRadius: 6,
                  border: '1px solid var(--bdr)', display: 'block', wordBreak: 'break-all', color: 'var(--txt)',
                }}>
                  {setup.secret}
                </code>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', marginBottom: 4 }}>ENTER CODE FROM APP:</div>
                <input
                  type="text" inputMode="numeric" maxLength={6} placeholder="000000"
                  value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={e => e.key === 'Enter' && verifyCode()}
                  style={{ ...INPUT, fontFamily: 'monospace', letterSpacing: '0.25em', fontSize: 20, textAlign: 'center' }}
                />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={verifyCode}
                  disabled={loading || code.length !== 6}
                  style={{ flex: 1, padding: '9px 0', borderRadius: 9, border: 'none', background: GREEN, color: '#fff', fontSize: 13.5, fontWeight: 600, cursor: code.length === 6 ? 'pointer' : 'not-allowed', opacity: (loading || code.length !== 6) ? 0.6 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'inherit' }}
                >
                  {loading && <Spinner size={14} color="#fff" />}
                  Verify &amp; Enable
                </button>
                <button
                  onClick={() => { setStep('idle'); setSetup(null); setCode('') }}
                  style={{ padding: '9px 14px', borderRadius: 9, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {(enabled || step === 'done') && step !== 'qr' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {step !== 'done' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: `${GREEN}10`, borderRadius: 10, border: `1px solid ${GREEN}25` }}>
                <span className="material-symbols-rounded" style={{ fontSize: 18, color: GREEN }}>verified_user</span>
                <span style={{ fontSize: 13, color: 'var(--txt)', fontWeight: 500 }}>
                  Your account is protected with two-factor authentication.
                </span>
              </div>

              <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: RED, marginBottom: 10 }}>Disable Two-Factor Authentication</div>
                <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--txt2)', lineHeight: 1.5 }}>
                  Enter your current password or a valid authenticator code to disable 2FA.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 320 }}>
                  <input type="password" placeholder="Current password" value={password} onChange={e => setPassword(e.target.value)} style={INPUT} />
                  <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--txt2)' }}>— or —</div>
                  <input type="text" inputMode="numeric" maxLength={6} placeholder="6-digit code from app" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} style={{ ...INPUT, fontFamily: 'monospace', letterSpacing: '0.1em', textAlign: 'center' }} />
                  <button
                    onClick={disableTOTP}
                    disabled={loading || (!password.trim() && code.length !== 6)}
                    style={{ padding: '9px 0', borderRadius: 9, border: 'none', background: RED, color: '#fff', fontSize: 13.5, fontWeight: 600, cursor: 'pointer', opacity: loading ? 0.7 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'inherit' }}
                  >
                    {loading && <Spinner size={14} color="#fff" />}
                    Disable 2FA
                  </button>
                </div>
              </div>
            </>
          )}
          {step === 'done' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: `${GREEN}10`, borderRadius: 10, border: `1px solid ${GREEN}25` }}>
              <span className="material-symbols-rounded" style={{ fontSize: 18, color: GREEN }}>verified_user</span>
              <span style={{ fontSize: 13, color: 'var(--txt)', fontWeight: 500 }}>
                Two-factor authentication is now active on your account.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Security Tab ──────────────────────────────────────────────────────────────

function SecurityTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SectionCard title="Change Password" subtitle="Minimum 12 characters — use a mix of letters, numbers, and symbols">
        <ChangePasswordSection />
      </SectionCard>
      <SectionCard title="Two-Factor Authentication" subtitle="Add an extra layer of security with a TOTP authenticator app">
        <TOTPSection />
      </SectionCard>
    </div>
  )
}

// ── Notifications Tab ─────────────────────────────────────────────────────────

const CHANNEL_ICON: Record<string, string> = { in_app: 'notifications', email: 'mail', sms: 'sms', push: 'phone_iphone' }
const CHANNEL_LABEL: Record<string, string> = { in_app: 'In-app', email: 'Email', sms: 'SMS', push: 'Push' }
const PREF_CHANNELS = ['in_app', 'email', 'sms']

function NotificationsTab() {
  const [prefs,   setPrefs]   = useState<NotifPref[]>([])
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [dirty,   setDirty]   = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch<NotifPref[]>('/api/user/notification-preferences')
      setPrefs(data ?? [])
    } catch { /* table may not exist yet */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  function toggle(eventType: string, channel: string) {
    setPrefs(prev => prev.map(p =>
      p.event_type === eventType && p.channel === channel ? { ...p, user_enabled: !p.user_enabled } : p
    ))
    setDirty(d => ({ ...d, [`${eventType}:${channel}`]: true }))
  }

  async function save() {
    setSaving(true)
    try {
      const changes = prefs
        .filter(p => dirty[`${p.event_type}:${p.channel}`])
        .map(p => ({ event_type: p.event_type, channel: p.channel, enabled: p.user_enabled }))
      await apiPut('/api/user/notification-preferences', changes)
      toast.success('Preferences saved')
      setDirty({})
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={22} /></div>

  if (prefs.length === 0) {
    return (
      <SectionCard title="Notification Preferences">
        <div style={{ color: 'var(--txt3)', fontSize: 13 }}>No notification events configured for your account yet.</div>
      </SectionCard>
    )
  }

  const grouped: Record<string, NotifPref[]> = {}
  prefs.forEach(p => { if (!grouped[p.event_type]) grouped[p.event_type] = []; grouped[p.event_type].push(p) })

  return (
    <SectionCard title="Notification Preferences" subtitle="Choose how you receive each type of notification" padding={false}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--th-bg)' }}>
              <th style={{ padding: '10px 18px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', width: '55%' }}>Event</th>
              {PREF_CHANNELS.map(ch => (
                <th key={ch} style={{ padding: '10px 18px', textAlign: 'center', fontSize: 11, fontWeight: 700, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{CHANNEL_ICON[ch]}</span>
                    {CHANNEL_LABEL[ch] ?? ch}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(grouped).map(([eventType, eventPrefs]) => {
              const first = eventPrefs[0]
              return (
                <tr key={eventType} style={{ borderBottom: '1px solid var(--bdr)' }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                >
                  <td style={{ padding: '11px 18px' }}>
                    <div style={{ fontWeight: 600, color: 'var(--txt)' }}>{first.label || eventType.replace(/_/g, ' ')}</div>
                    {first.description && <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 2 }}>{first.description}</div>}
                  </td>
                  {PREF_CHANNELS.map(ch => {
                    const pref = eventPrefs.find(p => p.channel === ch)
                    if (!pref) return <td key={ch} style={{ padding: '11px 18px', textAlign: 'center', color: 'var(--txt3)' }}>—</td>
                    return (
                      <td key={ch} style={{ padding: '11px 18px', textAlign: 'center' }}>
                        <button
                          onClick={() => toggle(eventType, ch)}
                          aria-label={`Toggle ${ch} for ${eventType}`}
                          style={{ width: 38, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', background: pref.user_enabled ? NAVY : '#D1D5DB', position: 'relative', transition: 'background .2s', padding: 0 }}
                        >
                          <span style={{ position: 'absolute', top: 3, left: pref.user_enabled ? 19 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left .2s', display: 'block', boxShadow: '0 1px 2px rgba(0,0,0,.15)' }} />
                        </button>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {Object.keys(dirty).length > 0 && (
        <div style={{ padding: '14px 18px', borderTop: '1px solid var(--bdr)', display: 'flex', gap: 10, alignItems: 'center' }}>
          <button onClick={save} disabled={saving} style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: INTER }}>
            {saving && <Spinner size={13} color="#fff" />} Save Preferences
          </button>
          <span style={{ fontSize: 12, color: 'var(--txt3)' }}>{Object.keys(dirty).length} unsaved change{Object.keys(dirty).length !== 1 ? 's' : ''}</span>
        </div>
      )}
    </SectionCard>
  )
}

// ── Email Signature Tab ────────────────────────────────────────────────────────

function SignatureTab() {
  const [html,    setHtml]    = useState('')
  const [text,    setText]    = useState('')
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)

  useEffect(() => {
    apiFetch<{ signature_html: string; signature_text: string }>('/api/mail/signature')
      .then(r => { setHtml(r.signature_html ?? ''); setText(r.signature_text ?? '') })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function save() {
    setSaving(true)
    try {
      await apiPut('/api/mail/signature', { signature_html: html, signature_text: text })
      toast.success('Signature saved')
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to save signature')
    } finally { setSaving(false) }
  }

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={22} /></div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SectionCard title="Email Signature" subtitle="Appended to outbound messages you send from the Mail module">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.4px' }}>HTML Signature</div>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
              value={html}
              onChange={e => setHtml(e.target.value)}
              placeholder={'<p>Best regards,<br/><strong>Your Name</strong><br/>O3 Capital</p>'}
              rows={6}
              style={{ ...INPUT, height: 'auto', padding: '10px 12px', resize: 'vertical', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5 }}
            />
          </div>

          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.4px' }}>Plain Text Signature</div>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder={'Best regards,\nYour Name\nO3 Capital'}
              rows={4}
              style={{ ...INPUT, height: 'auto', padding: '10px 12px', resize: 'vertical', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5 }}
            />
          </div>

          {html.trim() && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.4px' }}>Preview</div>
              <div
                style={{ padding: '14px 16px', border: '1px solid var(--bdr)', borderRadius: 10, background: 'var(--th-bg)', fontSize: 13, color: 'var(--txt)', lineHeight: 1.65 }}
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }}
              />
            </div>
          )}

          <div>
            <button onClick={save} disabled={saving} style={{ ...BTN_PRIMARY, opacity: saving ? 0.7 : 1 }}>
              {saving && <Spinner size={14} color="#fff" />}
              Save Signature
            </button>
          </div>
        </div>
      </SectionCard>
    </div>
  )
}

// ── Voice Tab ─────────────────────────────────────────────────────────────────

function VoiceTab() {
  const [configured, setConfigured] = useState<boolean | null>(null)

  useEffect(() => {
    apiFetch<{ configured: boolean }>('/api/voice/status', { silent: true } as any)
      .then(r => setConfigured(r.configured ?? false))
      .catch(() => setConfigured(false))
  }, [])

  return (
    <SectionCard title="Voice & Calling" subtitle="Make and receive calls directly from the workspace">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 42, height: 42, borderRadius: 10, background: configured ? `${GREEN}15` : 'var(--th-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 22, color: configured ? GREEN : 'var(--txt3)' }}>phone_in_talk</span>
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)' }}>Telnyx WebRTC</div>
              <div style={{ fontSize: 12.5, color: 'var(--txt2)', marginTop: 2 }}>
                {configured === null
                  ? 'Checking configuration…'
                  : configured
                    ? 'SIP credentials configured. Use the phone widget (bottom-right) to call.'
                    : 'SIP credentials not set. Contact your IT admin to enable calling.'}
              </div>
            </div>
          </div>
          <span style={{
            flexShrink: 0, fontSize: 11.5, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
            background: configured ? `${GREEN}18` : 'var(--chip-bg, #F0F4FF)',
            color: configured ? GREEN : 'var(--txt2)',
          }}>
            {configured === null ? '…' : configured ? 'Configured' : 'Not configured'}
          </span>
        </div>

        <div style={{ background: 'var(--th-bg)', borderRadius: 10, padding: '12px 16px', fontSize: 12.5, color: 'var(--txt2)', lineHeight: 1.65 }}>
          <div style={{ fontWeight: 700, color: 'var(--txt)', marginBottom: 4 }}>How calling works</div>
          SIP credentials are provisioned by the IT Admin via <strong>Admin → Users</strong>. Once configured, the call widget appears in the bottom-right corner of the workspace. Contact IT if calling is not working for your account.
        </div>
      </div>
    </SectionCard>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'profile',       label: 'Profile',         icon: 'person'        },
  { id: 'security',      label: 'Security',         icon: 'lock'          },
  { id: 'notifications', label: 'Notifications',    icon: 'notifications' },
  { id: 'signature',     label: 'Email Signature',  icon: 'edit_note'     },
  { id: 'voice',         label: 'Voice & Calling',  icon: 'call'          },
]

export default function Settings() {
  const [tab, setTab] = useState<Tab>('profile')
  const [me,  setMe]  = useState<MeData | null>(null)
  const local = readLocalUser()

  useEffect(() => {
    apiFetch<MeData>('/api/auth/me').then(setMe).catch(() => {})
  }, [])

  const displayName = me?.full_name ?? local?.name ?? 'User'
  const displayEmail = me?.sub ?? local?.email ?? ''
  const displayRole  = me?.role ?? local?.role ?? ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--bg)', fontFamily: "'Sora', sans-serif" }}>

      {/* Page header */}
      <div style={{ padding: '20px 28px 16px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--txt)' }}>Settings</div>
        <div style={{ fontSize: 12.5, color: 'var(--txt2)', marginTop: 2 }}>Manage your profile, security, and preferences</div>
      </div>

      {/* Split layout */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>

        {/* Left sidebar */}
        <div style={{ width: 220, flexShrink: 0, borderRight: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>

          {/* User identity block */}
          <div style={{ padding: '16px 16px 14px', borderBottom: '1px solid var(--bdr)' }}>
            <Avatar name={displayName} role={displayRole} size={40} />
            <div style={{ marginTop: 10, fontSize: 13, fontWeight: 700, color: 'var(--txt)', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {displayName}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {displayEmail}
            </div>
            {displayRole && (
              <div style={{ marginTop: 7, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: roleColor(displayRole) + '15', color: roleColor(displayRole), display: 'inline-block' }}>
                {roleLabel(displayRole)}
              </div>
            )}
          </div>

          {/* Nav items */}
          <div style={{ flex: 1, paddingTop: 6, paddingBottom: 8 }}>
            {TABS.map(t => (
              <NavItem key={t.id} label={t.label} icon={t.icon} active={tab === t.id} onClick={() => setTab(t.id)} />
            ))}
          </div>
        </div>

        {/* Right content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', minWidth: 0 }}>
          {tab === 'profile'       && <ProfileTab local={local} me={me} onGoSecurity={() => setTab('security')} />}
          {tab === 'security'      && <SecurityTab />}
          {tab === 'notifications' && <NotificationsTab />}
          {tab === 'signature'     && <SignatureTab />}
          {tab === 'voice'         && <VoiceTab />}
        </div>
      </div>
    </div>
  )
}
