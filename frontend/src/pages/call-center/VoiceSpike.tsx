import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../lib/api'
import { NAVY, GREEN, RED, AMBER, FW, RADIUS, SP, TEXT, MONO } from '../../lib/design'

// ── Zoho Voice WebSDK spike ──────────────────────────────────────────────────
// A deliberately minimal, heavily-logged proof that the Zoho Voice browser SDK can
// be embedded in THIS app on THIS domain, authenticate with our per-user OAuth
// token, and place a real outbound call. Not production UI — its only purpose is to
// answer the one thing Zoho's docs don't state: does third-party embedding work?
//
// Prerequisites to actually place a call (see docs/ZOHO_CLICK_TO_CALL_RESEARCH.md):
//   1. Zoho Voice subscription + a number assigned to the agent (org already has this).
//   2. The signed-in user has connected a Zoho Voice refresh token (Settings → Zoho
//      Voice), generated with the Zoho Voice scopes.
// This page surfaces every step so a failure points at exactly which link broke
// (CSP/script load, token, SDK init, or the dial itself).

const SDK_URL = 'https://js.zohostatic.com/zvoice_plugin/latest/js/zohovoice.min.js'

declare global {
  interface Window { zohovoice?: any }
}

export default function VoiceSpike() {
  const [phone, setPhone] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error' | 'no-token'>('idle')
  const [log, setLog] = useState<{ t: string; msg: string; kind: 'info' | 'ok' | 'err' }[]>([])
  const dcRef = useRef('com')
  const startedRef = useRef(false)

  const push = useCallback((msg: string, kind: 'info' | 'ok' | 'err' = 'info') => {
    const t = new Date().toLocaleTimeString()
    setLog(l => [...l, { t, msg, kind }])
    // eslint-disable-next-line no-console
    console[kind === 'err' ? 'error' : 'log'](`[voice-spike] ${msg}`)
  }, [])

  const initSdk = useCallback((dc: string) => {
    const zv = window.zohovoice
    if (!zv) { push('window.zohovoice missing after script load — SDK did not initialise', 'err'); setStatus('error'); return }
    try {
      zv.ajaxOpts = zv.ajaxOpts || {}
      zv.ajaxOpts.isOAuth = true
      // The SDK calls this whenever it needs a fresh token.
      zv.ajaxOpts.oAuthCallBack = (cb: (token: string) => void) => {
        apiFetch<any>('/api/zoho/voice/token')
          .then(d => { push('oAuthCallBack → token delivered to SDK', 'ok'); cb(d.access_token) })
          .catch(e => push('oAuthCallBack token fetch FAILED: ' + (e?.message || e), 'err'))
      }
      zv.ajaxOpts.domain = `https://voice.zoho.${dc}`
      push(`ajaxOpts set (isOAuth, domain=voice.zoho.${dc})`, 'ok')

      // Lifecycle events (names per Zoho Voice SDK docs).
      const on = (ev: string) => { try { zv.on?.(ev, (o: any) => push(`event ${ev}: ${safe(o)}`)) } catch { /* SDK may not expose this event */ } }
      on('callState'); on('timer'); on('updateCallerInfo'); on('ready'); on('error')
      push('event handlers registered — SDK ready', 'ok')
      setStatus('ready')
    } catch (e: any) {
      push('SDK init threw: ' + (e?.message || e), 'err'); setStatus('error')
    }
  }, [push])

  // 1) confirm the user has a Zoho Voice token, 2) load the SDK, 3) init it.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    setStatus('loading')
    push('checking Zoho Voice connection (GET /api/zoho/voice/token)…')
    apiFetch<any>('/api/zoho/voice/token')
      .then(d => {
        dcRef.current = d.dc || 'com'
        push(`token OK — agent_id=${d.agent_id || '(none)'} dc=${dcRef.current}`, 'ok')
        if (window.zohovoice) { push('SDK already loaded'); initSdk(dcRef.current); return }
        push(`loading SDK: ${SDK_URL}`)
        const s = document.createElement('script')
        s.src = SDK_URL; s.async = true
        s.onload = () => { push('SDK script loaded', 'ok'); initSdk(dcRef.current) }
        s.onerror = () => { push('SDK script FAILED to load — check CSP script-src / network to js.zohostatic.com', 'err'); setStatus('error') }
        document.body.appendChild(s)
      })
      .catch(e => {
        const m = e?.message || String(e)
        if (/not connected|403/i.test(m)) { push('Zoho Voice not connected for this user — connect a refresh token in Settings first', 'err'); setStatus('no-token') }
        else { push('token check failed: ' + m, 'err'); setStatus('error') }
      })
  }, [initSdk, push])

  function placeCall() {
    const n = phone.trim()
    if (!n) return
    const zv = window.zohovoice
    if (!zv?.makeCall) { push('zohovoice.makeCall is not available', 'err'); return }
    try {
      push(`makeCall("${n}") …`)
      zv.makeCall(n)
      push('makeCall invoked — watch events above + your headset', 'ok')
    } catch (e: any) {
      push('makeCall threw: ' + (e?.message || e), 'err')
    }
  }

  const dot = status === 'ready' ? GREEN : status === 'error' || status === 'no-token' ? RED : AMBER

  return (
    <div style={{ padding: 24, maxWidth: 760, margin: '0 auto', fontFamily: 'inherit' }}>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--txt)' }}>Zoho Voice — Click-to-Call Spike</h1>
      <p style={{ margin: '6px 0 16px', fontSize: TEXT.sm, color: 'var(--txt2)' }}>
        Proof that the Zoho Voice WebSDK can place a call from this app. Every step is logged below.
      </p>

      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: dot }} />
        <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
          {status === 'ready' ? 'SDK ready — try a call' : status === 'no-token' ? 'Zoho Voice not connected' : status === 'error' ? 'Error — see log' : 'Initialising…'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+234… number to dial"
          style={{ flex: 1, height: 40, padding: '0 12px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)' }} />
        <button onClick={placeCall} disabled={status !== 'ready' || !phone.trim()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 20px', background: status === 'ready' && phone.trim() ? NAVY : 'var(--bdr)', color: '#fff', border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.bold, cursor: status === 'ready' && phone.trim() ? 'pointer' : 'not-allowed' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18 }}>call</span>Place Call
        </button>
      </div>

      <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Live log</div>
      <div style={{ background: 'var(--th-bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: 12, maxHeight: 380, overflowY: 'auto', fontFamily: MONO, fontSize: 12.5, lineHeight: 1.6 }}>
        {log.length === 0 ? <span style={{ color: 'var(--txt3)' }}>…</span> : log.map((l, i) => (
          <div key={i} style={{ color: l.kind === 'err' ? RED : l.kind === 'ok' ? GREEN : 'var(--txt2)', wordBreak: 'break-word' }}>
            <span style={{ color: 'var(--txt3)' }}>{l.t}</span>  {l.msg}
          </div>
        ))}
      </div>
    </div>
  )
}

function safe(o: any): string { try { return typeof o === 'object' ? JSON.stringify(o) : String(o) } catch { return '[unserialisable]' } }
