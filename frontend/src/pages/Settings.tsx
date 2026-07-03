import { useState, useEffect } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { toast } from 'sonner'
import { Page, SectionCard, Spinner } from '../components/UI'
import { apiFetch, apiPost } from '../lib/api'
import { NAVY, RED, GREEN, AMBER } from '../lib/design'

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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Settings() {
  return (
    <Page title="Security Settings" subtitle="Manage your password and two-factor authentication">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 680 }}>

        <SectionCard title="Two-Factor Authentication">
          <TOTPSection />
        </SectionCard>

        <SectionCard title="Change Password">
          <ChangePasswordSection />
        </SectionCard>

      </div>
    </Page>
  )
}
