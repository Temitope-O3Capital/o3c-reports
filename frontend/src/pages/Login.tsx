import { useState, useEffect, useRef, useCallback } from 'react'
import { parseToken, type AuthUser } from '../hooks/useAuth'
import { API, storeCsrfToken } from '../lib/api'
import { TEXT, FW, RADIUS, SP, NAVY } from '../lib/design'

// ── Remembered login details ────────────────────────────────────────────────
// Small conveniences that make returning staff feel the app "remembers" them:
// the last work email typed, and their "keep me signed in" preference. Passwords
// are never kept here — that's the browser's password manager's job (see the
// Credential Management call in finalise()).
const LAST_EMAIL_KEY = 'o3c_last_email'
const REMEMBER_KEY    = 'o3c_remember'

function readLastEmail(): string {
  try { return localStorage.getItem(LAST_EMAIL_KEY) ?? '' } catch { return '' }
}
function readRemember(): boolean {
  // Defaults to true so a returning user on their own device gets a 30-day session;
  // only an explicit previous "false" (they unticked it) turns it back off.
  try { return localStorage.getItem(REMEMBER_KEY) !== 'false' } catch { return true }
}


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
  @keyframes o3fade {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  /* Custom "keep me signed in" checkbox — real input, visually hidden for a11y */
  .o3-check {
    position: absolute;
    opacity: 0;
    width: 20px;
    height: 20px;
    margin: 0;
    cursor: pointer;
  }
  .o3-checkbox {
    transition: background 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
  }
  .o3-check:focus-visible + .o3-checkbox {
    box-shadow: 0 0 0 3.5px rgba(14,40,65,0.14);
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
    font-family: 'Roboto Mono', 'Courier New', monospace;
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
  name?: string
  delay?: number
}

function FloatingField({ id, label, type = 'text', value, onChange, autoFocus, autoComplete, name, delay = 0 }: FieldProps) {
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
        borderRadius: RADIUS.xl,
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
            name={name ?? id}
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
      title="Cmd+Enter"
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: '100%', height: 52,
        borderRadius: RADIUS.xl, border: 'none',
        background: '#0E2841',
        color: '#fff',
        fontSize: 15, fontWeight: FW.semibold,
        fontFamily: "'Sora', sans-serif",
        letterSpacing: '-0.15px',
        cursor: loading ? 'not-allowed' : 'pointer',
        opacity: loading ? 0.65 : 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SP[2],
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
      padding: '11px 14px', borderRadius: RADIUS.xl,
      background: 'rgba(192,0,0,0.05)',
      border: '1px solid rgba(192,0,0,0.13)',
      animation: 'o3fade 180ms ease',
    }}>
      <span className="material-symbols-rounded icon-fill" style={{ fontSize: 15, color: '#C00000', flexShrink: 0, marginTop: 1 }}>
        error
      </span>
      <span style={{ fontSize: TEXT.base, color: '#C00000', fontWeight: FW.medium, lineHeight: 1.45 }}>
        {msg}
      </span>
    </div>
  )
}

// ── Left brand panel ──────────────────────────────────────────────────────────

function BrandPanel() {
  return (
    <div style={{
      flex: '0 0 44%',
      position: 'relative',
      overflow: 'hidden',
      background: 'linear-gradient(180deg, #0E2841 0%, #0A1E31 100%)',
      display: 'flex',
      flexDirection: 'column',
      padding: '52px 56px',
      color: '#fff',
    }}>
      {/* Brand lockup, top-left */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
        <img src="/o3-logo.svg" width={46} height={27} alt="O3 Capital" style={{ display: 'block' }} />
        <div>
          <div style={{ fontWeight: FW.bold, fontSize: 15, letterSpacing: '-0.2px', lineHeight: 1.05 }}>O3 Capital</div>
          <div style={{ marginTop: 3, fontSize: 9.5, fontWeight: FW.bold, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.42)' }}>Workspace</div>
        </div>
      </div>

      {/* Statement */}
      <div style={{ marginTop: 'auto', maxWidth: 400 }}>
        <div style={{ width: 32, height: 2, background: '#C00000', marginBottom: 26 }} />
        <h2 style={{ margin: 0, fontSize: 27, lineHeight: 1.32, fontWeight: FW.semibold, letterSpacing: '-0.3px', color: '#fff' }}>
          The internal workspace for O3 Capital.
        </h2>
        <p style={{ margin: '16px 0 0', fontSize: 14, lineHeight: 1.7, color: 'rgba(255,255,255,0.56)' }}>
          Loans, cards, fixed deposits, collections and compliance, managed by every team in one place.
        </p>
      </div>

      {/* Footer */}
      <div style={{
        marginTop: 44, paddingTop: 22, borderTop: '1px solid rgba(255,255,255,0.12)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontSize: TEXT.xs, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.01em',
      }}>
        <span>© {new Date().getFullYear()} O3 Capital Limited</span>
        <span>Confidential</span>
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
  const [email,        setEmail]        = useState(readLastEmail)
  const [password,     setPassword]     = useState('')
  // Prefill the last-used email and default "keep me signed in" to on, so returning
  // staff land straight on the password field with a 30-day session. The choice is
  // persisted (REMEMBER_KEY), so anyone who unticks it stays unticked next visit.
  const [remember,     setRemember]     = useState(readRemember)
  const [step,         setStep]         = useState<'credentials' | 'totp'>('credentials')
  const [mfaToken,     setMfaToken]     = useState('')
  const [loading,      setLoading]      = useState(false)
  const [err,          setErr]          = useState('')
  const [shake,        setShake]        = useState(false)
  const [wide,         setWide]         = useState(window.innerWidth >= 900)
  const [forgotMode,   setForgotMode]   = useState(false)
  const [forgotEmail,  setForgotEmail]  = useState('')
  const [forgotDone,   setForgotDone]   = useState(false)
  const [forgotLoad,   setForgotLoad]   = useState(false)
  const [forgotErr,    setForgotErr]    = useState('')
  const [regMode,      setRegMode]      = useState(false)
  const [regFirst,     setRegFirst]     = useState('')
  const [regLast,      setRegLast]      = useState('')
  const [regEmail,     setRegEmail]     = useState('')
  const [regDept,      setRegDept]      = useState('')
  const [regDone,      setRegDone]      = useState(false)
  const [regLoad,      setRegLoad]      = useState(false)
  const [regErr,       setRegErr]       = useState('')

  const greeting = (() => {
    // M12: use Intl to resolve the user's OS/browser timezone explicitly,
    // so the greeting reflects their local time even if stored prefs aren't loaded yet.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const h = parseInt(new Date().toLocaleString('en-NG', { hour: 'numeric', hour12: false, timeZone: tz }), 10)
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

  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault()
    if (!forgotEmail.trim()) { setForgotErr('Please enter your work email'); return }
    setForgotLoad(true); setForgotErr('')
    try {
      await fetch(`${API}/api/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail.trim() }),
      })
      setForgotDone(true)
    } catch {
      setForgotErr('Network error. Please try again')
    } finally {
      setForgotLoad(false)
    }
  }

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) { triggerErr('Please enter your work email'); return }
    if (!password)     { triggerErr('Please enter your password');   return }
    setLoading(true); setErr('')
    try {
      const res  = await fetch(`${API}/api/auth/token`, {
        method: 'POST',
        credentials: 'include',
        body: new URLSearchParams({ username: email.trim(), password, remember: remember ? 'true' : 'false' }),
      })
      const data = await res.json()
      if (!res.ok) { triggerErr(data.detail || 'Invalid credentials'); return }
      // Credentials checked out — remember the email for next time (even if MFA is
      // still pending, the identity is confirmed at this point).
      try { localStorage.setItem(LAST_EMAIL_KEY, email.trim()) } catch { /* private mode */ }
      if (data.mfa_required) { setMfaToken(data.mfa_token); setStep('totp'); return }
      finalise(data)
    } catch {
      triggerErr('Network error. Is the backend reachable?')
    } finally {
      setLoading(false)
    }
  }

  async function handleTotp(code: string) {
    setLoading(true); setErr('')
    try {
      const res  = await fetch(`${API}/api/auth/totp/challenge`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mfa_token: mfaToken, code }),
      })
      const data = await res.json()
      if (!res.ok) { triggerErr(data.detail || 'Incorrect code. Try again'); return }
      finalise(data)
    } catch {
      triggerErr('Network error')
    } finally {
      setLoading(false)
    }
  }

  function finalise(data: any) {
    if (data.csrf_token) storeCsrfToken(data.csrf_token)
    // extra_roles: prefer the response field; fall back to the JWT claim so this
    // works even before the backend response change is deployed.
    const claims = parseToken(data.access_token)
    const user: AuthUser = {
      id:                   data.user.id,
      name:                 data.user.name,
      email:                data.user.email,
      role:                 data.user.role,
      extra_roles:          data.user.extra_roles ?? (claims?.extra_roles as string[] | undefined) ?? [],
      pages:                data.user.pages ?? [],
      must_change_password: data.user.must_change_password ?? false,
    }
    localStorage.setItem('o3c_user', JSON.stringify(user))
    // Ask the browser's password manager to store these credentials so autofill
    // works on return visits. Only fires in a secure context (HTTPS / localhost);
    // on a plain-HTTP LAN it simply no-ops, and the form's autocomplete attributes
    // still drive the native "save password?" prompt.
    try {
      const anyWin = window as any
      if (navigator.credentials && anyWin.PasswordCredential && email.trim() && password) {
        const cred = new anyWin.PasswordCredential({ id: email.trim(), password, name: user.name })
        navigator.credentials.store(cred).catch(() => { /* user declined */ })
      }
    } catch { /* unsupported browser */ }
    onLogin(user)
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    if (!regFirst.trim()) { setRegErr('First name is required'); return }
    if (!regEmail.trim()) { setRegErr('Work email is required'); return }
    setRegLoad(true); setRegErr('')
    try {
      await fetch(`${API}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ first_name: regFirst.trim(), last_name: regLast.trim(), email: regEmail.trim(), department: regDept }),
      })
      setRegDone(true)
    } catch {
      setRegErr('Network error — please try again')
    } finally {
      setRegLoad(false)
    }
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
        background: wide ? '#fff' : '#07131F',
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
            <div>
              <img
                src="/o3-logo.svg"
                width={88}
                height={52}
                alt="O3 Capital"
                style={{ display: 'block', filter: 'drop-shadow(0 8px 24px rgba(0,0,0,0.5))' }}
              />
            </div>
            <div style={{ marginTop: 14, color: 'rgba(255,255,255,0.9)', fontWeight: FW.bold, fontSize: TEXT.xl }}>O3 Capital</div>
            <div style={{ marginTop: 3, color: 'rgba(255,255,255,0.2)', fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.22em', textTransform: 'uppercase' }}>Workspace</div>
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
                <div style={{ color: '#0E2841', fontWeight: FW.bold, fontSize: 15, letterSpacing: '-0.25px', lineHeight: 1.1 }}>O3 Capital</div>
                <div style={{ color: '#C0C9D6', fontSize: 9.5, fontWeight: FW.bold, letterSpacing: '0.16em', textTransform: 'uppercase', marginTop: 2 }}>Workspace</div>
              </div>
            </div>
          )}

          {/* ── Credentials step ── */}
          {step === 'credentials' && !forgotMode && !regMode && (
            <>
              <div style={{ marginBottom: 32, animation: 'o3rise 340ms cubic-bezier(0.4,0,0.2,1) both' }}>
                <h1 style={{ fontSize: 26, fontWeight: FW.extrabold, color: txtPrimary, margin: '0 0 7px', letterSpacing: '-0.6px', lineHeight: 1.2 }}>
                  {greeting}.
                </h1>
                <p style={{ fontSize: TEXT.md, color: txtSecondary, margin: 0, lineHeight: 1.65, letterSpacing: '-0.05px' }}>
                  Sign in with your O3 Capital account.
                </p>
              </div>

              <form onSubmit={handleCredentials} noValidate>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                  <FloatingField
                    id="login-email"
                    name="username"
                    label="Work email"
                    type="email"
                    value={email}
                    onChange={setEmail}
                    autoFocus={!email}
                    autoComplete="username"
                    delay={40}
                  />
                  <FloatingField
                    id="login-password"
                    name="password"
                    label="Password"
                    type="password"
                    value={password}
                    onChange={setPassword}
                    autoFocus={!!email}
                    autoComplete="current-password"
                    delay={80}
                  />
                </div>

                <label
                  htmlFor="login-remember"
                  style={{
                    position: 'relative', marginTop: 16, display: 'flex', alignItems: 'center', gap: 11,
                    cursor: 'pointer', userSelect: 'none',
                  }}
                >
                  <input
                    id="login-remember"
                    name="remember"
                    type="checkbox"
                    className="o3-check"
                    checked={remember}
                    onChange={e => {
                      setRemember(e.target.checked)
                      try { localStorage.setItem(REMEMBER_KEY, String(e.target.checked)) } catch { /* private mode */ }
                    }}
                  />
                  <span
                    aria-hidden
                    className="o3-checkbox"
                    style={{
                      width: 20, height: 20, borderRadius: 6, flexShrink: 0,
                      border: `1.5px solid ${remember ? NAVY : 'rgba(14,40,65,0.24)'}`,
                      background: remember ? NAVY : '#fff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    {remember && (
                      <span className="material-symbols-rounded" style={{ fontSize: 15, color: '#fff', fontVariationSettings: "'wght' 600" }}>
                        check
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: TEXT.base, color: 'var(--txt)', fontWeight: FW.medium, lineHeight: 1.4 }}>
                    Keep me signed in for 30 days
                  </span>
                </label>

                <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 11 }}>
                  {err && <ErrorMsg msg={err} />}
                  <PrimaryBtn loading={loading} delay={120}>
                    <span>Sign in</span>
                    <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, fontVariationSettings: "'wght' 500" }}>east</span>
                  </PrimaryBtn>
                </div>

                <div style={{ textAlign: 'center', marginTop: 20, display: 'flex', flexDirection: 'column', gap: SP[2] }}>
                  <button type="button" className="o3-ghost" onClick={() => { setForgotMode(true); setForgotEmail(email); setForgotErr(''); setForgotDone(false) }}>
                    Forgot your password?
                  </button>
                  <button type="button" className="o3-ghost" onClick={() => { setRegMode(true); setRegEmail(email); setRegErr(''); setRegDone(false) }}>
                    New here? Request access
                  </button>
                </div>
              </form>
            </>
          )}

          {/* ── Forgot password step ── */}
          {forgotMode && (
            <>
              <div style={{ marginBottom: 28, animation: 'o3rise 300ms cubic-bezier(0.4,0,0.2,1) both' }}>
                <h1 style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: txtPrimary, margin: '0 0 7px', letterSpacing: '-0.5px' }}>
                  Reset your password
                </h1>
                <p style={{ fontSize: TEXT.base, color: txtSecondary, margin: 0, lineHeight: 1.65 }}>
                  {forgotDone
                    ? "Check your inbox. If that email is registered, a temporary password has been sent. Use it to log in, then change your password in Settings."
                    : "Enter your work email and we'll send you a temporary password."}
                </p>
              </div>

              {!forgotDone && (
                <form onSubmit={handleForgotPassword} noValidate>
                  <FloatingField
                    id="forgot-email"
                    label="Work email"
                    type="email"
                    value={forgotEmail}
                    onChange={setForgotEmail}
                    autoFocus
                    autoComplete="email"
                  />
                  <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 11 }}>
                    {forgotErr && <ErrorMsg msg={forgotErr} />}
                    <PrimaryBtn loading={forgotLoad}>
                      <span>Send temporary password</span>
                    </PrimaryBtn>
                  </div>
                </form>
              )}

              <div style={{ textAlign: 'center', marginTop: 20 }}>
                <button type="button" className="o3-ghost" onClick={() => { setForgotMode(false); setForgotDone(false); setForgotErr('') }}>
                  Back to sign in
                </button>
              </div>
            </>
          )}

          {/* ── Registration step ── */}
          {regMode && !forgotMode && (
            <>
              <div style={{ marginBottom: 28, animation: 'o3rise 300ms cubic-bezier(0.4,0,0.2,1) both' }}>
                <h1 style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: txtPrimary, margin: '0 0 7px', letterSpacing: '-0.5px' }}>
                  Request access
                </h1>
                <p style={{ fontSize: TEXT.base, color: txtSecondary, margin: 0, lineHeight: 1.65 }}>
                  {regDone
                    ? "Request received. The IT Admin will review and send your login credentials by email."
                    : "Fill in your details and the IT Admin will activate your account."}
                </p>
              </div>

              {!regDone && (
                <form onSubmit={handleRegister} noValidate>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11 }}>
                      <FloatingField id="reg-first" label="First name" value={regFirst} onChange={setRegFirst} autoFocus />
                      <FloatingField id="reg-last"  label="Last name"  value={regLast}  onChange={setRegLast} />
                    </div>
                    <FloatingField id="reg-email" label="Work email" type="email" value={regEmail} onChange={setRegEmail} autoComplete="email" />
                    <FloatingField id="reg-dept"  label="Department (optional)" value={regDept} onChange={setRegDept} />
                  </div>
                  <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 11 }}>
                    {regErr && <ErrorMsg msg={regErr} />}
                    <PrimaryBtn loading={regLoad}>
                      <span>Submit request</span>
                    </PrimaryBtn>
                  </div>
                </form>
              )}

              <div style={{ textAlign: 'center', marginTop: 20 }}>
                <button type="button" className="o3-ghost" onClick={() => { setRegMode(false); setRegDone(false); setRegErr('') }}>
                  Back to sign in
                </button>
              </div>
            </>
          )}

          {/* ── TOTP step ── */}
          {step === 'totp' && (
            <>
              <div style={{ marginBottom: 28, animation: 'o3rise 300ms cubic-bezier(0.4,0,0.2,1) both' }}>
                <div style={{
                  width: 44, height: 44, borderRadius: RADIUS.xl,
                  background: wide ? 'rgba(14,40,65,0.06)' : 'rgba(255,255,255,0.07)',
                  border: wide ? 'none' : '1px solid rgba(255,255,255,0.1)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  marginBottom: 20,
                }}>
                  <span className="material-symbols-rounded icon-fill" style={{ fontSize: 21, color: wide ? '#0E2841' : 'rgba(255,255,255,0.8)' }}>
                    shield_lock
                  </span>
                </div>
                <h1 style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: txtPrimary, margin: '0 0 7px', letterSpacing: '-0.5px' }}>
                  Verify your identity
                </h1>
                <p style={{ fontSize: TEXT.base, color: txtSecondary, margin: 0, lineHeight: 1.65 }}>
                  Enter the 6-digit code from your authenticator app.
                </p>
              </div>

              <form onSubmit={e => e.preventDefault()}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: SP[5] }}>
                  <TotpBoxes onComplete={handleTotp} disabled={loading} />

                  {loading && (
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      gap: 9, color: txtSecondary, fontSize: TEXT.base,
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
                    <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>arrow_back</span>
                    Back to sign in
                  </button>
                </div>
              </form>
            </>
          )}
        </div>

        <div style={{
          position: 'absolute', bottom: 24,
          fontSize: TEXT.xs,
          color: wide ? '#D0D8E2' : 'rgba(255,255,255,0.11)',
          letterSpacing: '0.01em',
        }}>
          © {new Date().getFullYear()} O3 Capital Limited
        </div>
      </div>
    </div>
  )
}
