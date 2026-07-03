import { useState, useEffect, useRef, useCallback } from 'react'
import type { AuthUser } from '../hooks/useAuth'
import { API } from '../lib/api'

// ── CSS (pseudo-selectors + keyframes must live outside inline styles) ─────────

const LOGIN_CSS = `
  @keyframes o3spin {
    to { transform: rotate(360deg); }
  }
  @keyframes o3rise {
    from { opacity: 0; transform: translateY(16px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes o3shake {
    0%,100% { transform: translateX(0); }
    16%,48% { transform: translateX(-8px); }
    32%,64% { transform: translateX(8px); }
  }
  @keyframes o3float {
    0%,100% { transform: translateY(0); }
    50%     { transform: translateY(-9px); }
  }
  @keyframes o3fade {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .o3-input {
    width: 100%;
    height: 100%;
    border: none;
    outline: none;
    background: transparent;
    font-family: 'Sora', sans-serif;
    font-size: 15px;
    color: #0A1929;
    box-sizing: border-box;
    padding: 26px 16px 10px;
  }
  .o3-input.idle { padding: 0 16px; }
  .o3-input::placeholder { color: transparent; }
  .o3-input::-webkit-autofill {
    -webkit-box-shadow: 0 0 0 60px #F9FAFC inset;
    -webkit-text-fill-color: #0A1929;
    border-radius: 13px;
  }
  .o3-input::-webkit-autofill:focus {
    -webkit-box-shadow: 0 0 0 60px #fff inset;
  }

  .o3-digit {
    width: 48px;
    height: 58px;
    text-align: center;
    font-family: 'DM Mono', 'Courier New', monospace;
    font-size: 22px;
    font-weight: 700;
    color: #0A1929;
    border-radius: 12px;
    border: 1.5px solid rgba(10,25,41,0.12);
    background: #F9FAFC;
    outline: none;
    transition: border-color 140ms ease, background 140ms ease, box-shadow 140ms ease;
    caret-color: transparent;
  }
  .o3-digit:focus {
    border-color: #0E2841;
    background: #fff;
    box-shadow: 0 0 0 3.5px rgba(14,40,65,0.08);
  }
  .o3-digit.filled {
    border-color: rgba(14,40,65,0.22);
    background: #fff;
  }

  .o3-ghost {
    background: none;
    border: none;
    font-family: 'Sora', sans-serif;
    font-size: 13px;
    font-weight: 500;
    color: #9BA8B8;
    cursor: pointer;
    padding: 0;
    transition: color 140ms ease;
  }
  .o3-ghost:hover { color: #0E2841; }
`

// ── Floating-label input ───────────────────────────────────────────────────────

interface FieldProps {
  id: string
  label: string
  type?: string
  value: string
  onChange: (v: string) => void
  autoFocus?: boolean
  autoComplete?: string
  delay?: number
}

function FloatingField({ id, label, type = 'text', value, onChange, autoFocus, autoComplete, delay = 0 }: FieldProps) {
  const [focused, setFocused] = useState(false)
  const [reveal,  setReveal]  = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const isPw     = type === 'password'
  const active   = focused || value.length > 0

  return (
    <div
      style={{ animation: `o3rise 360ms cubic-bezier(0.4,0,0.2,1) ${delay}ms both` }}
      onClick={() => inputRef.current?.focus()}
    >
      <div style={{
        position: 'relative',
        height: 58,
        borderRadius: 14,
        border: `1.5px solid ${focused ? '#0E2841' : active ? 'rgba(14,40,65,0.18)' : 'rgba(14,40,65,0.1)'}`,
        background: focused ? '#fff' : '#F9FAFC',
        boxShadow: focused ? '0 0 0 4px rgba(14,40,65,0.06)' : 'none',
        transition: 'border-color 160ms ease, box-shadow 160ms ease, background 160ms ease',
        cursor: 'text',
        overflow: 'hidden',
      }}>
        <label
          htmlFor={id}
          style={{
            position: 'absolute', left: 16, pointerEvents: 'none', zIndex: 2,
            fontFamily: "'Sora', sans-serif",
            top: active ? 9 : '50%',
            transform: active ? 'none' : 'translateY(-50%)',
            fontSize: active ? 10 : 15,
            fontWeight: active ? 700 : 400,
            letterSpacing: active ? '0.08em' : '-0.1px',
            textTransform: active ? 'uppercase' : 'none',
            color: active ? (focused ? '#0E2841' : 'rgba(14,40,65,0.38)') : '#B0B9C8',
            transition: 'top 160ms cubic-bezier(0.4,0,0.2,1), transform 160ms cubic-bezier(0.4,0,0.2,1), font-size 160ms cubic-bezier(0.4,0,0.2,1), color 160ms ease, letter-spacing 160ms ease',
          }}
        >
          {label}
        </label>

        <div style={{ display: 'flex', alignItems: 'stretch', height: '100%' }}>
          <input
            ref={inputRef}
            id={id}
            type={isPw ? (reveal ? 'text' : 'password') : type}
            className={`o3-input${active ? '' : ' idle'}`}
            value={value}
            autoFocus={autoFocus}
            autoComplete={autoComplete}
            placeholder={label}
            onChange={e => onChange(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
          {isPw && value.length > 0 && (
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={e => { e.preventDefault(); setReveal(r => !r) }}
              style={{
                flexShrink: 0, padding: '0 15px 0 6px',
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#C0C9D6', display: 'flex', alignItems: 'center',
                transition: 'color 140ms',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = '#0E2841')}
              onMouseLeave={e => (e.currentTarget.style.color = '#C0C9D6')}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 17, lineHeight: 1 }}>
                {reveal ? 'visibility_off' : 'visibility'}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── TOTP 6-digit boxes ────────────────────────────────────────────────────────

function TotpBoxes({ onComplete, disabled }: { onComplete: (code: string) => void; disabled?: boolean }) {
  const [vals, setVals] = useState(['', '', '', '', '', ''])
  const refsArr = useRef<Array<HTMLInputElement | null>>([null, null, null, null, null, null])

  useEffect(() => { requestAnimationFrame(() => refsArr.current[0]?.focus()) }, [])

  const complete = useCallback((digits: string[]) => {
    if (digits.every(Boolean)) onComplete(digits.join(''))
  }, [onComplete])

  function handleChange(i: number, raw: string) {
    const d = raw.replace(/\D/g, '')
    if (!d) return
    const ch = d[d.length - 1]
    const next = [...vals]; next[i] = ch; setVals(next)
    if (i < 5) refsArr.current[i + 1]?.focus()
    complete(next)
  }

  function handleKey(i: number, e: React.KeyboardEvent) {
    if (e.key === 'Backspace') {
      e.preventDefault()
      if (vals[i]) {
        const n = [...vals]; n[i] = ''; setVals(n)
      } else if (i > 0) {
        refsArr.current[i - 1]?.focus()
        const n = [...vals]; n[i - 1] = ''; setVals(n)
      }
    }
    if (e.key === 'ArrowLeft'  && i > 0) { e.preventDefault(); refsArr.current[i - 1]?.focus() }
    if (e.key === 'ArrowRight' && i < 5) { e.preventDefault(); refsArr.current[i + 1]?.focus() }
  }

  function handlePaste(e: React.ClipboardEvent) {
    e.preventDefault()
    const code = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (code.length === 6) {
      const arr = code.split('')
      setVals(arr)
      refsArr.current[5]?.focus()
      complete(arr)
    }
  }

  return (
    <div style={{ display: 'flex', gap: 9, justifyContent: 'center' }}>
      {vals.map((v, i) => (
        <input
          key={i}
          ref={el => { refsArr.current[i] = el }}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={v}
          disabled={disabled}
          onChange={e => handleChange(i, e.target.value)}
          onKeyDown={e => handleKey(i, e)}
          onPaste={handlePaste}
          className={`o3-digit${v ? ' filled' : ''}`}
          style={{ opacity: disabled ? 0.5 : 1 }}
        />
      ))}
    </div>
  )
}

// ── Primary button ────────────────────────────────────────────────────────────

function PrimaryBtn({
  loading, children, onClick, delay = 0,
}: {
  loading: boolean; children: React.ReactNode; onClick?: () => void; delay?: number
}) {
  const [hov, setHov] = useState(false)
  return (
    <button
      type="submit"
      disabled={loading}
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: '100%', height: 52,
        borderRadius: 14, border: 'none',
        background: '#0E2841',
        color: '#fff',
        fontSize: 15, fontWeight: 600,
        fontFamily: "'Sora', sans-serif",
        letterSpacing: '-0.15px',
        cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.65 : 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        transition: 'background 160ms ease, transform 120ms ease, box-shadow 180ms ease, opacity 180ms ease',
        transform: hov && !loading ? 'translateY(-1.5px)' : 'none',
        boxShadow: hov && !loading ? '0 12px 32px rgba(14,40,65,0.32)' : '0 2px 10px rgba(14,40,65,0.18)',
        animation: `o3rise 360ms cubic-bezier(0.4,0,0.2,1) ${delay}ms both`,
      }}
    >
      {loading ? (
        <>
          <span style={{
            width: 16, height: 16,
            border: '2px solid rgba(255,255,255,0.25)',
            borderTopColor: '#fff',
            borderRadius: '50%',
            animation: 'o3spin 0.7s linear infinite',
            flexShrink: 0,
          }} />
          <span>Verifying…</span>
        </>
      ) : children}
    </button>
  )
}

// ── Error message ─────────────────────────────────────────────────────────────

function ErrorMsg({ msg }: { msg: string }) {
  if (!msg) return null
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 9,
      padding: '11px 14px', borderRadius: 12,
      background: 'rgba(192,0,0,0.05)',
      border: '1px solid rgba(192,0,0,0.13)',
      animation: 'o3fade 180ms ease',
    }}>
      <span className="material-symbols-rounded icon-fill" style={{ fontSize: 15, color: '#C00000', flexShrink: 0, marginTop: 1 }}>
        error
      </span>
      <span style={{ fontSize: 13, color: '#C00000', fontWeight: 500, lineHeight: 1.45 }}>
        {msg}
      </span>
    </div>
  )
}

// ── Left brand panel ──────────────────────────────────────────────────────────

function BrandPanel() {
  return (
    <div style={{
      flex: '0 0 46%',
      position: 'relative',
      overflow: 'hidden',
      background: '#050C18',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      {/* Depth gradient */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: 'radial-gradient(ellipse 70% 55% at 50% 46%, rgba(18,52,100,0.5) 0%, transparent 100%)',
      }} />

      {/* Noise grain */}
      <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden>
        <filter id="o3-noise">
          <feTurbulence type="fractalNoise" baseFrequency="0.72" numOctaves="4" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </svg>
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        filter: 'url(#o3-noise)', opacity: 0.032, mixBlendMode: 'overlay',
      }} />

      {/* Accent glow */}
      <div style={{
        position: 'absolute',
        width: 440, height: 440, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(192,0,0,0.05) 0%, rgba(14,165,233,0.03) 40%, transparent 70%)',
        pointerEvents: 'none',
      }} />

      {/* Content */}
      <div style={{
        position: 'relative', zIndex: 1,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', textAlign: 'center',
        padding: '0 52px', gap: 0,
      }}>
        {/* Hero logo */}
        <div style={{ animation: 'o3float 7s ease-in-out infinite', marginBottom: 28 }}>
          <img
            src="/o3-logo.svg"
            width={156}
            height={92}
            alt="O3 Capital"
            style={{
              display: 'block',
              filter: 'drop-shadow(0 14px 44px rgba(0,0,0,0.55)) drop-shadow(0 4px 14px rgba(0,0,0,0.35))',
            }}
          />
        </div>

        {/* Wordmark */}
        <div style={{ color: 'rgba(255,255,255,0.94)', fontWeight: 700, fontSize: 20, letterSpacing: '-0.3px', lineHeight: 1 }}>
          O3 Capital
        </div>
        <div style={{ marginTop: 5, color: 'rgba(255,255,255,0.2)', fontSize: 10, fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase' }}>
          Workspace
        </div>

        {/* Rule */}
        <div style={{ marginTop: 40, width: 28, height: 1, background: 'rgba(255,255,255,0.1)' }} />

        {/* Tagline */}
        <p style={{ marginTop: 32, color: 'rgba(255,255,255,0.35)', fontSize: 14, lineHeight: 1.8, maxWidth: 260, letterSpacing: '-0.05px' }}>
          The nerve centre of O3 Capital — loans, cards, collections, compliance, and everything in between.
        </p>

        {/* Stats */}
        <div style={{ display: 'flex', gap: 32, marginTop: 40 }}>
          {[['14', 'Depts'], ['24', 'Roles'], ['74+', 'Modules']].map(([n, l]) => (
            <div key={l} style={{ textAlign: 'center' }}>
              <div style={{ color: 'rgba(255,255,255,0.84)', fontWeight: 800, fontSize: 19, letterSpacing: '-0.5px' }}>{n}</div>
              <div style={{ color: 'rgba(255,255,255,0.22)', fontSize: 9.5, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 3 }}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ position: 'absolute', bottom: 28, color: 'rgba(255,255,255,0.12)', fontSize: 11, letterSpacing: '0.04em' }}>
        Internal platform · Confidential
      </div>
    </div>
  )
}

// ── Panel divider ─────────────────────────────────────────────────────────────

function PanelDivider() {
  return (
    <div style={{
      width: 1, flexShrink: 0,
      background: 'linear-gradient(to bottom, transparent, rgba(14,40,65,0.1) 20%, rgba(14,40,65,0.1) 80%, transparent)',
    }} />
  )
}

// ── Main Login ────────────────────────────────────────────────────────────────

interface LoginProps { onLogin: (u: AuthUser) => void }

export default function Login({ onLogin }: LoginProps) {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [step,     setStep]     = useState<'credentials' | 'totp'>('credentials')
  const [loading,  setLoading]  = useState(false)
  const [err,      setErr]      = useState('')
  const [shake,    setShake]    = useState(false)
  const [wide,     setWide]     = useState(window.innerWidth >= 900)

  const greeting = (() => {
    const h = new Date().getHours()
    if (h < 12) return 'Good morning'
    if (h < 17) return 'Good afternoon'
    return 'Good evening'
  })()

  useEffect(() => {
    const el = document.createElement('style')
    el.id = 'o3-login-css'
    el.textContent = LOGIN_CSS
    document.head.appendChild(el)
    return () => document.getElementById('o3-login-css')?.remove()
  }, [])

  useEffect(() => {
    const fn = () => setWide(window.innerWidth >= 900)
    window.addEventListener('resize', fn, { passive: true })
    return () => window.removeEventListener('resize', fn)
  }, [])

  function triggerErr(msg: string) {
    setErr(msg)
    setShake(true)
    setTimeout(() => setShake(false), 560)
  }

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) { triggerErr('Please enter your work email'); return }
    if (!password)     { triggerErr('Please enter your password');   return }
    setLoading(true); setErr('')
    try {
      const res  = await fetch(`${API}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      })
      const data = await res.json()
      if (!res.ok) { triggerErr(data.detail || 'Invalid credentials'); return }
      if (data.totp_required) { setStep('totp'); return }
      finalise(data)
    } catch {
      triggerErr('Network error — is the backend reachable?')
    } finally {
      setLoading(false)
    }
  }

  async function handleTotp(code: string) {
    setLoading(true); setErr('')
    try {
      const res  = await fetch(`${API}/api/auth/totp-verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, code }),
      })
      const data = await res.json()
      if (!res.ok) { triggerErr(data.detail || 'Incorrect code — try again'); return }
      finalise(data)
    } catch {
      triggerErr('Network error')
    } finally {
      setLoading(false)
    }
  }

  function finalise(data: any) {
    localStorage.setItem('o3c_token', data.access_token)
    const user: AuthUser = {
      id:                   data.user.id,
      name:                 data.user.name,
      email:                data.user.email,
      role:                 data.user.role,
      pages:                data.user.pages ?? [],
      must_change_password: data.user.must_change_password ?? false,
    }
    localStorage.setItem('o3c_user', JSON.stringify(user))
    onLogin(user)
  }

  const txtPrimary   = wide ? '#0A1929' : 'rgba(255,255,255,0.94)'
  const txtSecondary = wide ? '#8C9CAD' : 'rgba(255,255,255,0.36)'

  return (
    <div style={{ display: 'flex', minHeight: '100vh', fontFamily: "'Sora', sans-serif" }}>

      {wide && <BrandPanel />}
      {wide && <PanelDivider />}

      {/* Right: form panel */}
      <div style={{
        flex: 1,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: wide ? '#fff' : '#050C18',
        padding: '40px 24px',
        minHeight: '100vh',
        position: 'relative',
      }}>

        {/* Mobile: logo above form */}
        {!wide && (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            marginBottom: 44,
            animation: 'o3rise 400ms cubic-bezier(0.4,0,0.2,1) both',
          }}>
            <div style={{ animation: 'o3float 7s ease-in-out infinite' }}>
              <img
                src="/o3-logo.svg"
                width={88}
                height={52}
                alt="O3 Capital"
                style={{ display: 'block', filter: 'drop-shadow(0 8px 24px rgba(0,0,0,0.5))' }}
              />
            </div>
            <div style={{ marginTop: 14, color: 'rgba(255,255,255,0.9)', fontWeight: 700, fontSize: 18 }}>O3 Capital</div>
            <div style={{ marginTop: 3, color: 'rgba(255,255,255,0.2)', fontSize: 10, fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase' }}>Workspace</div>
          </div>
        )}

        {/* Form container */}
        <div style={{
          width: '100%',
          maxWidth: 374,
          animation: shake ? 'o3shake 540ms cubic-bezier(0.4,0,0.2,1)' : undefined,
        }}>
          {/* Desktop: mini wordmark above form */}
          {wide && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 11,
              marginBottom: 44,
              animation: 'o3rise 340ms cubic-bezier(0.4,0,0.2,1) both',
            }}>
              <img src="/o3-logo.svg" width={46} height={27} alt="O3 Capital" style={{ display: 'block' }} />
              <div>
                <div style={{ color: '#0E2841', fontWeight: 700, fontSize: 15, letterSpacing: '-0.25px', lineHeight: 1.1 }}>O3 Capital</div>
                <div style={{ color: '#C0C9D6', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', marginTop: 2 }}>Workspace</div>
              </div>
            </div>
          )}

          {/* ── Credentials step ── */}
          {step === 'credentials' && (
            <>
              <div style={{ marginBottom: 32, animation: 'o3rise 340ms cubic-bezier(0.4,0,0.2,1) both' }}>
                <h1 style={{ fontSize: 26, fontWeight: 800, color: txtPrimary, margin: '0 0 7px', letterSpacing: '-0.6px', lineHeight: 1.2 }}>
                  {greeting}.
                </h1>
                <p style={{ fontSize: 14, color: txtSecondary, margin: 0, lineHeight: 1.65, letterSpacing: '-0.05px' }}>
                  Sign in with your O3 Capital account.
                </p>
              </div>

              <form onSubmit={handleCredentials} noValidate>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                  <FloatingField
                    id="login-email"
                    label="Work email"
                    type="email"
                    value={email}
                    onChange={setEmail}
                    autoFocus
                    autoComplete="email"
                    delay={40}
                  />
                  <FloatingField
                    id="login-password"
                    label="Password"
                    type="password"
                    value={password}
                    onChange={setPassword}
                    autoComplete="current-password"
                    delay={80}
                  />
                </div>

                <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 11 }}>
                  {err && <ErrorMsg msg={err} />}
                  <PrimaryBtn loading={loading} delay={120}>
                    <span>Sign in</span>
                    <span className="material-symbols-rounded" style={{ fontSize: 18, fontVariationSettings: "'wght' 500" }}>east</span>
                  </PrimaryBtn>
                </div>

                <div style={{ textAlign: 'center', marginTop: 20 }}>
                  <button type="button" className="o3-ghost">
                    Forgot your password?
                  </button>
                </div>
              </form>
            </>
          )}

          {/* ── TOTP step ── */}
          {step === 'totp' && (
            <>
              <div style={{ marginBottom: 28, animation: 'o3rise 300ms cubic-bezier(0.4,0,0.2,1) both' }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 13,
                  background: wide ? 'rgba(14,40,65,0.06)' : 'rgba(255,255,255,0.07)',
                  border: wide ? 'none' : '1px solid rgba(255,255,255,0.1)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  marginBottom: 20,
                }}>
                  <span className="material-symbols-rounded icon-fill" style={{ fontSize: 21, color: wide ? '#0E2841' : 'rgba(255,255,255,0.8)' }}>
                    shield_lock
                  </span>
                </div>
                <h1 style={{ fontSize: 22, fontWeight: 800, color: txtPrimary, margin: '0 0 7px', letterSpacing: '-0.5px' }}>
                  Verify your identity
                </h1>
                <p style={{ fontSize: 13.5, color: txtSecondary, margin: 0, lineHeight: 1.65 }}>
                  Enter the 6-digit code from your authenticator app.
                </p>
              </div>

              <form onSubmit={e => e.preventDefault()}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  <TotpBoxes onComplete={handleTotp} disabled={loading} />

                  {loading && (
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      gap: 9, color: txtSecondary, fontSize: 13,
                    }}>
                      <span style={{
                        width: 14, height: 14,
                        border: '2px solid currentColor', borderTopColor: 'transparent',
                        borderRadius: '50%', opacity: 0.5,
                        animation: 'o3spin 0.7s linear infinite',
                      }} />
                      Verifying…
                    </div>
                  )}

                  {err && <ErrorMsg msg={err} />}

                  <button
                    type="button"
                    className="o3-ghost"
                    onClick={() => { setStep('credentials'); setErr('') }}
                    style={{ display: 'flex', alignItems: 'center', gap: 5 }}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>arrow_back</span>
                    Back to sign in
                  </button>
                </div>
              </form>
            </>
          )}
        </div>

        <div style={{
          position: 'absolute', bottom: 24,
          fontSize: 11.5,
          color: wide ? '#D0D8E2' : 'rgba(255,255,255,0.11)',
          letterSpacing: '0.01em',
        }}>
          © {new Date().getFullYear()} O3 Capital Limited
        </div>
      </div>
    </div>
  )
}
