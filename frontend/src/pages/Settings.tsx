import { useState, useEffect, useCallback, useRef } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { toast } from 'sonner'
import { Page, SectionCard, Spinner } from '../components/UI'
import { apiFetch, apiPost } from '../lib/api'
import { NAVY, RED, GREEN, AMBER, INTER } from '../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

type SetupStep = 'idle' | 'qr' | 'verify' | 'done'

interface TOTPSetup {
  secret: string
  uri:    string
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
      setSetup(r)
      setStep('qr')
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to start setup')
    } finally {
      setLoading(false)
    }
  }

  async function verifyCode() {
    if (code.length !== 6) { toast.error('Enter the 6-digit code from your app'); return }
    setLoading(true)
    try {
      await apiPost('/api/auth/totp/verify', { code })
      toast.success('Two-factor authentication enabled')
      setEnabled(true)
      setStep('done')
      setSetup(null)
      setCode('')
    } catch (e: any) {
      toast.error(e.message ?? 'Invalid code')
    } finally {
      setLoading(false)
    }
  }

  async function disableTOTP() {
    if (!password.trim() && code.length !== 6) {
      toast.error('Enter your password or a 6-digit code to disable 2FA')
      return
    }
    setLoading(true)
    try {
      await apiPost('/api/auth/totp/disable', {
        password: password.trim() || undefined,
        code:     code.length === 6 ? code : undefined,
      })
      toast.success('Two-factor authentication disabled')
      setEnabled(false)
      setStep('idle')
      setPassword('')
      setCode('')
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to disable 2FA')
    } finally {
      setLoading(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    height: 40, padding: '0 12px', borderRadius: 8,
    border: '1px solid var(--input-bdr)', background: 'var(--input-bg)',
    color: 'var(--txt)', fontSize: 13.5, fontFamily: 'inherit', outline: 'none',
    width: '100%', boxSizing: 'border-box',
  }

  if (enabled === null) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 16, color: 'var(--txt2)', fontSize: 13 }}>
        <Spinner size={16} /> Loading…
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: '4px 0' }}>

      {/* Status row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)' }}>
            Authenticator App (TOTP)
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--txt2)', marginTop: 3 }}>
            Use Google Authenticator, Authy, or any TOTP-compatible app.
          </div>
        </div>
        <span style={{
          flexShrink: 0, fontSize: 11.5, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
          background: enabled ? `${GREEN}18` : 'var(--chip-bg)',
          color: enabled ? GREEN : 'var(--txt2)',
        }}>
          {enabled ? 'Enabled' : 'Not enabled'}
        </span>
      </div>

      {/* Setup flow */}
      {!enabled && step === 'idle' && (
        <button
          onClick={startSetup}
          disabled={loading}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '9px 18px', borderRadius: 9, border: 'none',
            background: NAVY, color: '#fff', fontSize: 13.5, fontWeight: 600,
            cursor: 'pointer', opacity: loading ? 0.7 : 1, alignSelf: 'flex-start',
          }}
        >
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
                  border: '1px solid var(--bdr)', display: 'block', wordBreak: 'break-all',
                  color: 'var(--txt)',
                }}>
                  {setup.secret}
                </code>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', marginBottom: 4 }}>ENTER CODE FROM APP:</div>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000000"
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={e => e.key === 'Enter' && verifyCode()}
                  style={{ ...inputStyle, fontFamily: 'monospace', letterSpacing: '0.25em', fontSize: 20, textAlign: 'center' }}
                />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={verifyCode}
                  disabled={loading || code.length !== 6}
                  style={{
                    flex: 1, padding: '9px 0', borderRadius: 9, border: 'none',
                    background: GREEN, color: '#fff', fontSize: 13.5, fontWeight: 600,
                    cursor: code.length === 6 ? 'pointer' : 'not-allowed',
                    opacity: (loading || code.length !== 6) ? 0.6 : 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  }}
                >
                  {loading && <Spinner size={14} color="#fff" />}
                  Verify &amp; Enable
                </button>
                <button
                  onClick={() => { setStep('idle'); setSetup(null); setCode('') }}
                  style={{
                    padding: '9px 14px', borderRadius: 9, border: '1px solid var(--bdr)',
                    background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer',
                  }}
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
                <div style={{ fontSize: 13, fontWeight: 600, color: RED, marginBottom: 10 }}>
                  Disable Two-Factor Authentication
                </div>
                <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--txt2)', lineHeight: 1.5 }}>
                  Enter your current password or a valid authenticator code to disable 2FA.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 320 }}>
                  <input
                    type="password"
                    placeholder="Current password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    style={inputStyle}
                  />
                  <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--txt2)' }}>— or —</div>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="6-digit code from app"
                    value={code}
                    onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                    style={{ ...inputStyle, fontFamily: 'monospace', letterSpacing: '0.1em', textAlign: 'center' }}
                  />
                  <button
                    onClick={disableTOTP}
                    disabled={loading || (!password.trim() && code.length !== 6)}
                    style={{
                      padding: '9px 0', borderRadius: 9, border: 'none',
                      background: RED, color: '#fff', fontSize: 13.5, fontWeight: 600,
                      cursor: 'pointer', opacity: loading ? 0.7 : 1,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    }}
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

// ── Change Password Section ────────────────────────────────────────────────────

function ChangePasswordSection() {
  const [current, setCurrent] = useState('')
  const [next,    setNext]    = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)

  const inputStyle: React.CSSProperties = {
    height: 40, padding: '0 12px', borderRadius: 8,
    border: '1px solid var(--input-bdr)', background: 'var(--input-bg)',
    color: 'var(--txt)', fontSize: 13.5, fontFamily: 'inherit', outline: 'none',
    width: '100%', boxSizing: 'border-box',
  }

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

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 360 }}>
      <input type="password" placeholder="Current password" value={current} onChange={e => setCurrent(e.target.value)} required style={inputStyle} />
      <input type="password" placeholder="New password (min 12 chars)" value={next} onChange={e => setNext(e.target.value)} required style={inputStyle} />
      <input type="password" placeholder="Confirm new password" value={confirm} onChange={e => setConfirm(e.target.value)} required style={inputStyle} />
      <button
        type="submit"
        disabled={loading}
        style={{
          padding: '9px 0', borderRadius: 9, border: 'none',
          background: NAVY, color: '#fff', fontSize: 13.5, fontWeight: 600,
          cursor: 'pointer', opacity: loading ? 0.7 : 1, alignSelf: 'flex-start',
          display: 'flex', alignItems: 'center', gap: 8,
        } as React.CSSProperties}
      >
        {loading && <Spinner size={14} color="#fff" />}
        Update Password
      </button>
    </form>
  )
}

// ── Notification Preferences Section ─────────────────────────────────────────

interface NotifPref {
  event_type:   string
  channel:      string
  label:        string
  description:  string
  user_enabled: boolean
  has_override: boolean
}

const CHANNEL_ICON: Record<string, string> = {
  in_app: 'notifications', email: 'mail', sms: 'sms',
}

function NotificationPrefsSection() {
  const [prefs,   setPrefs]   = useState<NotifPref[]>([])
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [dirty,   setDirty]   = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch<NotifPref[]>('/api/user/notification-preferences')
      setPrefs(data ?? [])
    } catch { /* silently ignore — table may not exist yet */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  function toggle(eventType: string, channel: string) {
    const key = `${eventType}:${channel}`
    setPrefs(prev => prev.map(p =>
      p.event_type === eventType && p.channel === channel
        ? { ...p, user_enabled: !p.user_enabled }
        : p
    ))
    setDirty(d => ({ ...d, [key]: true }))
  }

  async function save() {
    setSaving(true)
    try {
      const changes = prefs
        .filter(p => dirty[`${p.event_type}:${p.channel}`])
        .map(p => ({ event_type: p.event_type, channel: p.channel, enabled: p.user_enabled }))
      const token = localStorage.getItem('token') ?? ''
      await fetch('/api/user/notification-preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(changes),
      })
      toast.success('Preferences saved')
      setDirty({})
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  if (loading) return <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner size={22} /></div>
  if (prefs.length === 0) return <div style={{ padding: '16px 0', color: 'var(--txt3)', fontSize: 13 }}>No notification events configured yet.</div>

  // Group by event_type
  const grouped: Record<string, NotifPref[]> = {}
  prefs.forEach(p => { if (!grouped[p.event_type]) grouped[p.event_type] = []; grouped[p.event_type].push(p) })
  const channels = ['in_app', 'email', 'sms']

  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--th-bg)' }}>
              <th style={{ padding: '9px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', width: '55%' }}>Event</th>
              {channels.map(ch => (
                <th key={ch} style={{ padding: '9px 12px', textAlign: 'center', fontSize: 11, fontWeight: 700, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 15, verticalAlign: 'middle' }}>{CHANNEL_ICON[ch] ?? ch}</span>
                  <span style={{ marginLeft: 4 }}>{ch.replace('_', ' ')}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(grouped).map(([eventType, eventPrefs]) => {
              const first = eventPrefs[0]
              return (
                <tr key={eventType} style={{ borderBottom: '1px solid var(--bdr)' }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background='var(--row-hvr)'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background='transparent'}
                >
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ fontWeight: 600, color: 'var(--txt)' }}>{first.label || eventType.replace(/_/g,' ')}</div>
                    {first.description && <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 2 }}>{first.description}</div>}
                  </td>
                  {channels.map(ch => {
                    const pref = eventPrefs.find(p => p.channel === ch)
                    if (!pref) return <td key={ch} style={{ padding: '10px 12px', textAlign: 'center', color: 'var(--txt3)' }}>—</td>
                    return (
                      <td key={ch} style={{ padding: '10px 12px', textAlign: 'center' }}>
                        <button
                          onClick={() => toggle(eventType, ch)}
                          style={{ width: 38, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer', background: pref.user_enabled ? NAVY : '#D1D5DB', position: 'relative', transition: 'background .2s', padding: 0 }}
                        >
                          <span style={{ position: 'absolute', top: 3, left: pref.user_enabled ? 19 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left .2s', display: 'block' }} />
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
        <div style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
          <button onClick={save} disabled={saving}
            style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: INTER }}>
            {saving && <Spinner size={13} color="#fff" />}Save Preferences
          </button>
          <span style={{ fontSize: 12, color: 'var(--txt3)' }}>{Object.keys(dirty).length} unsaved change{Object.keys(dirty).length !== 1 ? 's' : ''}</span>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

// ── Zoho Voice Section ────────────────────────────────────────────────────────

function ZohoVoiceSection() {
  const [connected,    setConnected]    = useState<boolean | null>(null)
  const [connectedAt,  setConnectedAt]  = useState<string | null>(null)
  const [loading,      setLoading]      = useState(false)
  const justConnected  = useRef(false)

  useEffect(() => {
    justConnected.current = new URLSearchParams(window.location.search).has('voice_connected')
    apiFetch<{ connected: boolean; connected_at: string }>('/api/voice/status', { silent: true })
      .then(r => { setConnected(r.connected ?? false); setConnectedAt(r.connected_at ?? null) })
      .catch(() => setConnected(false))
  }, [])

  async function handleConnect() {
    setLoading(true)
    try {
      const r = await apiFetch<{ auth_url: string }>('/api/voice/connect')
      window.location.href = r.auth_url
    } catch (e: any) {
      toast.error(e.message ?? 'Could not get OAuth URL')
      setLoading(false)
    }
  }

  async function handleDisconnect() {
    setLoading(true)
    try {
      await apiFetch('/api/voice/disconnect', { method: 'DELETE' })
      setConnected(false); setConnectedAt(null)
      toast.success('Zoho Voice disconnected')
    } catch (e: any) {
      toast.error(e.message ?? 'Disconnect failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {justConnected.current && connected && (
        <div style={{ background: `${GREEN}12`, border: `1px solid ${GREEN}40`, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: GREEN, fontWeight: 500 }}>
          Zoho Voice connected successfully. You can now make and receive calls from the dial pad.
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)' }}>Zoho Voice</div>
          <div style={{ fontSize: 12.5, color: 'var(--txt2)', marginTop: 3 }}>
            {connected === null
              ? 'Checking status…'
              : connected
                ? connectedAt
                  ? `Connected since ${new Date(connectedAt).toLocaleDateString()}`
                  : 'Connected'
                : 'Connect your Zoho Voice account to make and receive calls from the workspace.'}
          </div>
        </div>
        <span style={{
          flexShrink: 0, fontSize: 11.5, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
          background: connected ? `${GREEN}18` : 'var(--chip-bg)',
          color: connected ? GREEN : 'var(--txt2)',
        }}>
          {connected === null ? '…' : connected ? 'Connected' : 'Not connected'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        {!connected && (
          <button
            onClick={handleConnect}
            disabled={loading || connected === null}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '9px 18px', borderRadius: 9, border: 'none',
              background: NAVY, color: '#fff', fontSize: 13.5, fontWeight: 600,
              cursor: 'pointer', opacity: loading || connected === null ? 0.7 : 1,
            }}
          >
            {loading && <Spinner size={14} color="#fff" />}
            <span className="material-symbols-rounded" style={{ fontSize: 17 }}>phone_in_talk</span>
            Connect Zoho Voice
          </button>
        )}
        {connected && (
          <button
            onClick={handleDisconnect}
            disabled={loading}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '9px 18px', borderRadius: 9, border: `1px solid ${RED}40`,
              background: 'transparent', color: RED, fontSize: 13.5, fontWeight: 600,
              cursor: 'pointer', opacity: loading ? 0.7 : 1,
            }}
          >
            {loading && <Spinner size={14} color={RED} />}
            Disconnect
          </button>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--txt3)', lineHeight: 1.6 }}>
        After connecting, use the phone icon in the bottom-right corner to dial. Your Zoho Voice account must be set up in <strong>Zoho Desk → Setup → Telephony</strong> for calls to route correctly.
      </div>
    </div>
  )
}

export default function Settings() {
  return (
    <Page title="Settings" subtitle="Manage your security, integrations, and notification preferences">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 680 }}>

        <SectionCard title="Two-Factor Authentication">
          <TOTPSection />
        </SectionCard>

        <SectionCard title="Change Password">
          <ChangePasswordSection />
        </SectionCard>

        <SectionCard title="Zoho Voice" subtitle="Make and receive calls directly from the workspace">
          <ZohoVoiceSection />
        </SectionCard>

        <SectionCard title="Notification Preferences" subtitle="Choose how you receive each type of notification">
          <NotificationPrefsSection />
        </SectionCard>

      </div>
    </Page>
  )
}
