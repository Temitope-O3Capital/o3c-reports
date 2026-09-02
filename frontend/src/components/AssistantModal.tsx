import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { API, apiFetch, getCsrfToken, refreshSession, unwrap, unwrapList } from '../lib/api'
import { Spinner } from './UI'
import { NAVY, RED, GREEN, TEXT, FW, SP, SORA } from '../lib/design'
import { EBar, ELine } from './echarts'
import { CHART_SERIES } from './charts'

/**
 * AssistantLauncher — toolbar button that docks the AI assistant to the lower right.
 *
 * Docked panel, not a centred modal, and that is the whole design. Three facts
 * about this deployment drive it:
 *
 *  1. A turn takes ~23 seconds, because the model runs on CPU on this box. A
 *     centred modal with a dimmed backdrop holds the entire screen hostage for
 *     that time. Docked and backdrop-free, you can read the page you were
 *     already on, or start a lookup and carry on working while it answers.
 *
 *  2. The answer streams. Words appear as they are written, so the panel has to
 *     sit somewhere you can watch out of the corner of your eye — which is
 *     exactly what the lower right corner is for.
 *
 *  3. The assistant answers ONLY from tools it is allowed to call, gated by the
 *     same page permissions as the rest of the workspace. Each answer shows
 *     which tools ran. That is not decoration: it is how a reader tells "this
 *     number came out of the database" from "this is just prose".
 *
 * Escape closes, but never mid-request. Clicking away does NOT close, because a
 * docked panel that vanishes when you click the page behind it would be useless
 * for the one thing it is for.
 */

export default function AssistantLauncher() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(o => !o)}
        title="Assistant"
        aria-expanded={open}
        style={{
          position: 'relative', width: 34, height: 34, borderRadius: 5,
          border: `1px solid ${open ? NAVY : 'var(--bdr)'}`,
          background: open ? NAVY : 'var(--card)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: open ? '#fff' : 'var(--txt2)', transition: 'border-color .12s, color .12s, background .12s',
        }}
        onMouseEnter={e => {
          if (open) return
          const el = e.currentTarget as HTMLElement
          el.style.borderColor = 'var(--txt3)'
          el.style.color = 'var(--txt)'
        }}
        onMouseLeave={e => {
          if (open) return
          const el = e.currentTarget as HTMLElement
          el.style.borderColor = 'var(--bdr)'
          el.style.color = 'var(--txt2)'
        }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 18 }}>forum</span>
      </button>
      {open && <AssistantPanel onClose={() => setOpen(false)} />}
    </>
  )
}

/**
 * A chart the BACKEND built from the tool's own rows. The model never sees or
 * authors this: it misquotes figures it can read (137 became 1,370 once), so a
 * chart it wrote could silently contradict the answer printed beside it.
 */
type AssistantChart = {
  title: string
  kind: 'line' | 'bar'
  x_key: string
  series: { key: string; name: string }[]
  rows: Record<string, any>[]
}

type Msg = {
  role: 'user' | 'assistant'
  content: string
  tools?: string[]
  latency_ms?: number
  charts?: AssistantChart[]
  pending?: boolean
  failed?: boolean
}

type Conversation = { id: number; title: string }

const TOOL_LABELS: Record<string, string> = {
  get_current_datetime: 'date & time',
  get_collections_summary: 'collections book',
  get_recovery_summary: 'recovery book',
  get_call_centre_stats: 'call volume',
  get_agent_call_stats: 'agent call activity',
  get_ticket_stats: 'helpdesk tickets',
  get_card_portfolio_summary: 'card portfolio',
  get_sales_pipeline: 'sales pipeline',
  get_lead_ownership: 'lead ownership',
  get_revenue_summary: 'revenue & income',
  get_loan_portfolio_summary: 'loan book',
  get_fixed_deposit_summary: 'fixed deposits',
  get_transaction_volume: 'transaction volume',
  get_settlement_exceptions: 'reconciliation exceptions',
  search_customers: 'customer search',
  get_customer_overview: 'customer record',
  get_customer_transactions: 'customer transactions',
  find_staff: 'staff directory',
}

const SUGGESTIONS = [
  'How many collections cases are open and what is the total outstanding?',
  'How many calls did we handle in the last 7 days?',
  'What revenue did we earn last month?',
  'How much are we holding in fixed deposits?',
]

function AssistantPanel({ onClose }: { onClose: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // What the assistant is doing right now: queue position, or the lookup in
  // flight. A turn takes ~23s on this hardware and cannot be made much faster,
  // so saying what is happening is the difference between "working" and "frozen".
  const [status, setStatus] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [convId, setConvId] = useState<number | null>(null)
  const [convs, setConvs] = useState<Conversation[]>([])
  const [online, setOnline] = useState<boolean | null>(null)
  const [model, setModel] = useState('')
  const [wide, setWide] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  // Drives the entrance transition. Starts false so the first paint is the
  // off-state, then flips on the next tick so the browser has something to
  // animate from.
  const [shown, setShown] = useState(false)

  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Health up front: finding out the assistant is offline by sending a message
  // and waiting a minute for it to fail is a bad way to learn it.
  useEffect(() => {
    apiFetch('/api/assistant/health', { silent: true })
      .then(r => {
        const d = unwrap<{ online: boolean; model: string }>(r)
        setOnline(!!d?.online)
        setModel(d?.model || '')
      })
      .catch(() => setOnline(false))
    loadConversations()
    const raf = requestAnimationFrame(() => setShown(true))
    const t = setTimeout(() => inputRef.current?.focus(), 60)
    return () => { cancelAnimationFrame(raf); clearTimeout(t) }
  }, [])

  // Escape closes — but never mid-request, or the user loses an answer they
  // already waited half a minute for (it is still saved, but they would not see it).
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (showHistory) { setShowHistory(false); return }
      if (!busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, showHistory, onClose])

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs, busy])

  useEffect(() => {
    if (!busy) return
    setElapsed(0)
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [busy])

  function loadConversations() {
    apiFetch('/api/assistant/conversations', { silent: true })
      .then(r => setConvs(unwrapList<Conversation>(r)))
      .catch(() => {})
  }

  async function openConversation(id: number) {
    if (busy) return
    try {
      const r = await apiFetch(`/api/assistant/conversations/${id}`)
      setMsgs(unwrapList<any>(r).map(m => ({ role: m.role, content: m.content })))
      setConvId(id)
      setShowHistory(false)
    } catch { /* keep the current thread on failure */ }
  }

  /**
   * Stream one turn over SSE.
   *
   * Deliberately a raw fetch rather than apiFetch: we need the response body as
   * a stream, and apiFetch resolves only once the whole body has arrived, which
   * is the very thing being fixed here. EventSource is not an option either —
   * it is GET-only and cannot carry the question or the CSRF header.
   *
   * The 401-refresh-and-retry below mirrors apiFetch's, because losing a session
   * mid-question should not throw the user to the login screen when a valid
   * refresh cookie is sitting right there.
   */
  async function send(text?: string) {
    const question = (text ?? input).trim()
    if (!question || busy) return

    setInput('')
    setShowHistory(false)
    setMsgs(m => [...m, { role: 'user', content: question }, { role: 'assistant', content: '', pending: true }])
    setBusy(true)
    setStatus('Thinking')

    const appendToLast = (patch: (prev: Msg) => Msg) =>
      setMsgs(m => { const n = [...m]; n[n.length - 1] = patch(n[n.length - 1]); return n })

    const open = () => fetch(`${API}/api/assistant/chat/stream`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
      body: JSON.stringify({ conversation_id: convId ?? 0, message: question }),
    })

    try {
      let res = await open()
      if (res.status === 401 && await refreshSession()) res = await open()
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as any).detail || `Request failed (${res.status})`)
      }
      if (!res.body) throw new Error('This browser cannot stream responses.')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let streamErr = ''

      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')

        // SSE frames are separated by a blank line.
        let cut: number
        while ((cut = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, cut)
          buf = buf.slice(cut + 2)
          const ev = /^event: *(.+)$/m.exec(frame)?.[1]?.trim()
          const raw = /^data: *(.+)$/m.exec(frame)?.[1]
          if (!ev || !raw) continue

          let d: any
          try { d = JSON.parse(raw) } catch { continue }

          if (ev === 'queued') {
            setStatus(d.ahead === 1
              ? `1 person ahead of you, about ${d.eta_seconds}s`
              : `${d.ahead} people ahead of you, about ${d.eta_seconds}s`)
          } else if (ev === 'tool') {
            setStatus(`Checking ${TOOL_LABELS[d.name] || d.name}`)
          } else if (ev === 'chart') {
            // Arrives as soon as the tool returns, so the chart is on screen
            // while the model is still writing the paragraph about it.
            appendToLast(p => ({ ...p, charts: [...(p.charts ?? []), d as AssistantChart] }))
          } else if (ev === 'token') {
            setStatus('')
            appendToLast(p => ({ ...p, content: p.content + d.t }))
          } else if (ev === 'done') {
            setConvId(d.conversation_id)
            // Carry the charts over: `done` rebuilds the message from the final
            // payload, which has no charts in it, so spreading `p` first would
            // otherwise drop every chart streamed during the turn.
            appendToLast(p => ({
              role: 'assistant', content: d.answer,
              tools: d.tools_used || [], latency_ms: d.latency_ms,
              charts: p.charts,
            }))
          } else if (ev === 'error') {
            streamErr = d.detail || 'The assistant could not answer that.'
          }
        }
      }
      if (streamErr) throw new Error(streamErr)
      loadConversations()
    } catch (e: any) {
      const detail = e?.detail || e?.message || 'The assistant could not answer that.'
      appendToLast(() => ({ role: 'assistant', content: detail, failed: true }))
    } finally {
      setBusy(false)
      setStatus('')
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
  }

  const disabled = busy || online === false
  const reduceMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  return (
    <div
      role="dialog"
      aria-label="Assistant"
      style={{
        ...panel,
        width: wide ? 'min(760px, calc(100vw - 40px))' : 'min(420px, calc(100vw - 40px))',
        height: wide ? 'calc(100vh - 96px)' : 'min(660px, calc(100vh - 96px))',
        opacity: shown ? 1 : 0,
        transform: shown ? 'translateY(0) scale(1)' : 'translateY(12px) scale(0.985)',
        transition: reduceMotion ? 'none' : 'opacity .18s var(--ease-out), transform .18s var(--ease-out), width .18s var(--ease-out), height .18s var(--ease-out)',
      }}
    >
      {/* header — navy action bar, per the design system's dark-bar convention */}
      <div style={header}>
        <span className="material-symbols-rounded" style={{ fontSize: 19, color: '#fff', opacity: 0.9 }}>forum</span>
        <div style={{ minWidth: 0, lineHeight: 1.15 }}>
          <div style={{ fontFamily: SORA, fontSize: TEXT.sm, fontWeight: FW.semibold as any, color: '#fff' }}>
            Assistant
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: TEXT['2xs'], color: 'rgba(255,255,255,.62)' }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: online === false ? RED : online ? GREEN : 'rgba(255,255,255,.4)',
            }} />
            {online === false ? 'Offline' : model || 'Live workspace data'}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 2, alignItems: 'center' }}>
          <HeadBtn icon="history" title="Recent conversations"
            active={showHistory} onClick={() => setShowHistory(h => !h)} />
          <HeadBtn icon="add" title="New conversation" disabled={busy}
            onClick={() => { if (!busy) { setMsgs([]); setConvId(null); setShowHistory(false); inputRef.current?.focus() } }} />
          <HeadBtn icon={wide ? 'close_fullscreen' : 'open_in_full'} title={wide ? 'Shrink' : 'Expand'}
            onClick={() => setWide(w => !w)} />
          <HeadBtn icon="close" title="Close" disabled={busy} onClick={() => { if (!busy) onClose() }} />
        </div>
      </div>

      {online === false && (
        <div style={offlineBar}>
          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>cloud_off</span>
          The assistant service is not running on the server, so questions cannot be answered right now.
        </div>
      )}

      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
        {/* history — a sheet over the thread, because a 420px panel has no room
            for a permanent rail and a hidden-by-default list is the honest trade */}
        {showHistory && (
          <div style={sheet}>
            <div style={sheetHead}>Recent</div>
            {convs.length === 0 && <div style={sheetEmpty}>Nothing yet</div>}
            <div style={{ overflowY: 'auto', minHeight: 0 }}>
              {convs.slice(0, 30).map(c => (
                <button key={c.id} onClick={() => void openConversation(c.id)} title={c.title}
                  style={{
                    ...sheetRow,
                    background: c.id === convId ? 'var(--row-sel)' : 'transparent',
                    borderLeft: `3px solid ${c.id === convId ? RED : 'transparent'}`,
                  }}>
                  {c.title}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={thread}>
          {msgs.length === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                Try one of these
              </div>
              {SUGGESTIONS.map(s => (
                <button key={s} onClick={() => void send(s)} disabled={disabled} style={suggestion}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = NAVY }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--bdr)' }}>
                  {s}
                </button>
              ))}
            </div>
          )}

          {msgs.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div style={m.role === 'user' ? userBubble : (m.failed ? failedBubble : botBubble)}>
                {m.pending && !m.content ? (
                  // Nothing written yet: say what is happening rather than
                  // showing a bare spinner for twenty-odd seconds.
                  <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], color: 'var(--txt2)' }}>
                    <Spinner size={14} />
                    <span style={{ fontSize: TEXT.xs }}>{status || 'Thinking'}… {elapsed}s</span>
                  </div>
                ) : (
                  <>
                    <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                      {m.content}
                      {m.pending && <span style={caret} aria-hidden="true" />}
                    </div>
                    {m.charts?.map((c, ci) => <AssistantChartCard key={ci} chart={c} />)}
                    {m.role === 'assistant' && !m.pending && !m.failed && (
                      <div style={metaRow}>
                        {(m.tools?.length ?? 0) > 0
                          ? m.tools!.map(t => (
                              <span key={t} style={toolChip}>
                                <span className="material-symbols-rounded" style={{ fontSize: 11 }}>database</span>
                                {TOOL_LABELS[t] || t}
                              </span>
                            ))
                          : <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>no data looked up</span>}
                        {typeof m.latency_ms === 'number' && (
                          <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginLeft: 'auto' }}>
                            {(m.latency_ms / 1000).toFixed(1)}s
                          </span>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        <div style={composer}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={disabled}
            rows={1}
            maxLength={4000}
            placeholder={online === false ? 'Assistant offline' : 'Ask about collections, calls, revenue, customers…'}
            style={textarea}
            onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = NAVY }}
            onBlur={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--input-bdr)' }}
          />
          <button onClick={() => void send()} disabled={disabled || !input.trim()} style={sendBtn} title="Send">
            {busy ? <Spinner size={14} color="#fff" />
                  : <span className="material-symbols-rounded" style={{ fontSize: 17 }}>arrow_upward</span>}
          </button>
        </div>

        {/*
          Not boilerplate. The model quotes tool figures faithfully but is
          unreliable at judging which figure matters, so staff must treat it
          as a drafting aid, never as a decision.
        */}
        <div style={disclaimer}>
          Generated from live workspace data. Check anything you act on.
        </div>
      </div>
    </div>
  )
}

function HeadBtn({ icon, title, onClick, disabled, active }: {
  icon: string; title: string; onClick: () => void; disabled?: boolean; active?: boolean
}) {
  return (
    <button
      onClick={onClick} disabled={disabled} title={title} aria-label={title}
      style={{
        width: 28, height: 28, borderRadius: 6, border: 'none',
        background: active ? 'rgba(255,255,255,.16)' : 'transparent',
        color: '#fff', opacity: disabled ? 0.35 : 0.8,
        cursor: disabled ? 'default' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background .12s, opacity .12s',
      }}
      onMouseEnter={e => { if (!disabled) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,.16)' }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 17 }}>{icon}</span>
    </button>
  )
}

/**
 * Renders one backend-built chart inside a reply.
 *
 * Two details matter. Postgres NUMERIC columns arrive as STRINGS through pgx, so
 * every value is coerced here — handing ECharts "752130643.46" plots nothing and
 * fails silently, which is the worst kind of chart bug. And money is abbreviated
 * on the axis but shown in full in the tooltip: a 420px panel has no room for
 * twelve digits, while a figure someone might act on should never be rounded
 * where they read it.
 */
function AssistantChartCard({ chart }: { chart: AssistantChart }) {
  const num = (v: any) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').trim())
    return Number.isFinite(n) ? n : 0
  }
  const data = chart.rows.map(r => {
    const out: Record<string, any> = { [chart.x_key]: String(r[chart.x_key] ?? '') }
    for (const s of chart.series) out[s.key] = num(r[s.key])
    return out
  })
  const isMoney = chart.series.every(s => s.key.endsWith('_ngn'))
  const abbrev = (v: number) => {
    const a = Math.abs(v)
    if (a >= 1e9) return `${(v / 1e9).toFixed(1)}b`
    if (a >= 1e6) return `${(v / 1e6).toFixed(1)}m`
    if (a >= 1e3) return `${(v / 1e3).toFixed(0)}k`
    return String(Math.round(v))
  }
  const full = (v: number) =>
    (isMoney ? 'NGN ' : '') + v.toLocaleString('en-NG', { maximumFractionDigits: isMoney ? 2 : 0 })
  const series = chart.series.map((s, i) => ({
    key: s.key, name: s.name, color: CHART_SERIES[i % CHART_SERIES.length],
  }))

  return (
    <div style={chartCard}>
      <div style={chartTitleSty}>{chart.title}</div>
      {chart.kind === 'line'
        ? <ELine data={data} xKey={chart.x_key} series={series} height={168} valueFmt={full} axisFmt={abbrev} />
        : <EBar  data={data} xKey={chart.x_key} series={series} height={168} valueFmt={full} axisFmt={abbrev} />}
    </div>
  )
}

const chartCard: CSSProperties = {
  marginTop: SP[3], padding: SP[2], borderRadius: 10,
  border: '1px solid var(--bdr)', background: 'var(--bg)',
}

const chartTitleSty: CSSProperties = {
  fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'var(--txt2)',
  textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: SP[1], paddingLeft: SP[1],
}

// ── styles ──────────────────────────────────────────────────────────────────
// Neutrals come from tokens so both themes work; NAVY and RED are brand and are
// intentionally fixed across themes, per the design system.

const panel: CSSProperties = {
  position: 'fixed', right: 20, bottom: 20, zIndex: 60,
  display: 'flex', flexDirection: 'column',
  background: 'var(--card)',
  border: '1px solid var(--bdr)',
  borderRadius: 14,
  boxShadow: 'var(--shadow-xl)',
  overflow: 'hidden',
}

const header: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: SP[2],
  padding: `10px ${SP[3]} 10px ${SP[3]}`,
  background: NAVY, flexShrink: 0,
}

const offlineBar: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: SP[2],
  padding: `${SP[2]} ${SP[3]}`, fontSize: TEXT['2xs'],
  color: RED, background: 'var(--row-sel)', borderBottom: '1px solid var(--bdr)',
}

const sheet: CSSProperties = {
  position: 'absolute', inset: 0, zIndex: 2,
  background: 'var(--card)', display: 'flex', flexDirection: 'column',
  borderBottom: '1px solid var(--bdr)',
}

const sheetHead: CSSProperties = {
  padding: `${SP[3]} ${SP[3]} ${SP[2]}`, fontSize: TEXT['2xs'],
  textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--txt3)', flexShrink: 0,
}

const sheetEmpty: CSSProperties = { padding: `0 ${SP[3]}`, fontSize: TEXT['2xs'], color: 'var(--txt3)' }

const sheetRow: CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', border: 'none',
  padding: `${SP[2]} ${SP[3]}`, fontSize: TEXT.xs, color: 'var(--txt2)',
  cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
}

const thread: CSSProperties = {
  flex: 1, minHeight: 0, overflowY: 'auto',
  padding: SP[3], display: 'flex', flexDirection: 'column', gap: SP[3],
}

const bubbleBase: CSSProperties = {
  maxWidth: '86%', padding: `9px 12px`, borderRadius: 12,
  fontSize: TEXT.sm, wordBreak: 'break-word',
}

const userBubble: CSSProperties = {
  ...bubbleBase, background: NAVY, color: '#fff', borderBottomRightRadius: 4,
}

const botBubble: CSSProperties = {
  ...bubbleBase, background: 'var(--bg)', color: 'var(--txt)',
  border: '1px solid var(--bdr)', borderBottomLeftRadius: 4,
}

const failedBubble: CSSProperties = { ...botBubble, borderColor: RED, color: RED }

const metaRow: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: SP[2], flexWrap: 'wrap',
  marginTop: SP[2], paddingTop: SP[2], borderTop: '1px solid var(--bdr)',
}

const toolChip: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '2px 7px', borderRadius: 999, background: 'var(--chip-bg)',
  fontSize: TEXT['2xs'], color: 'var(--txt2)',
}

// Typing caret shown while tokens are still arriving. An element, not a text
// glyph, so it never lands in copied text or a screen reader.
const caret: CSSProperties = {
  display: 'inline-block', width: 2, height: '1em', marginLeft: 2,
  verticalAlign: 'text-bottom', background: RED, opacity: 0.75,
}

const composer: CSSProperties = {
  display: 'flex', alignItems: 'flex-end', gap: SP[2],
  padding: `${SP[2]} ${SP[3]}`, borderTop: '1px solid var(--bdr)', flexShrink: 0,
}

const textarea: CSSProperties = {
  flex: 1, resize: 'none', maxHeight: 120,
  padding: '9px 12px', borderRadius: 10,
  border: '1px solid var(--input-bdr)', background: 'var(--input-bg)',
  color: 'var(--txt)', fontSize: TEXT.sm, fontFamily: 'inherit', lineHeight: 1.5,
  outline: 'none', transition: 'border-color .12s',
}

const sendBtn: CSSProperties = {
  width: 34, height: 34, flexShrink: 0, borderRadius: '50%', border: 'none',
  background: NAVY, color: '#fff', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}

const suggestion: CSSProperties = {
  textAlign: 'left', padding: `9px 11px`, borderRadius: 10,
  border: '1px solid var(--bdr)', background: 'var(--bg)',
  color: 'var(--txt2)', fontSize: TEXT.xs, cursor: 'pointer', lineHeight: 1.45,
  transition: 'border-color .12s',
}

const disclaimer: CSSProperties = {
  padding: `0 ${SP[3]} ${SP[2]}`, fontSize: TEXT['2xs'],
  color: 'var(--txt3)', lineHeight: 1.4, flexShrink: 0,
}
