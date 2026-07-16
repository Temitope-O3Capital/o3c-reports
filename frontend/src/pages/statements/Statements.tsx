import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { Page, SectionCard, DataTable, Tabs, ErrBanner, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, API } from '../../lib/api'
import { fmtDate, fmtDatetime, monthStart, today } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, BLUE, INTER, SORA, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CustomerResult {
  id?: number
  cif: string
  name: string
  email?: string
  phone?: string
  // raw field names from API
  'CIF Number'?: string; 'First Name'?: string; 'Last Name'?: string; 'Email'?: string
}

interface SentEmail {
  id: number
  cif_number: string
  customer_name: string
  recipient_email: string
  date_from: string
  date_to: string
  subject: string
  status: string
  delivered_at?: string
  opened_at?: string
  bounced_at?: string
  last_error?: string
  sent_by_name?: string
  created_at: string
}

interface BulkRun {
  id: number
  status: string
  date_from: string
  date_to: string
  subject?: string
  requested_limit?: number
  total_recipients: number
  sent_count: number
  failed_count: number
  last_error?: string
  started_at?: string
  completed_at?: string
  created_at: string
}

// ── Status pill ───────────────────────────────────────────────────────────────

const STATUS_META: Record<string, { label: string; bg: string; txt: string }> = {
  queued:    { label: 'Queued',    bg: 'rgba(14,40,65,.1)',   txt: NAVY  },
  active:    { label: 'Sending',   bg: 'rgba(59,130,246,.12)', txt: BLUE  },
  pending:   { label: 'Pending',   bg: 'rgba(14,40,65,.1)',   txt: NAVY  },
  sent:      { label: 'Sent',      bg: 'rgba(22,163,74,.1)',  txt: GREEN },
  delivered: { label: 'Delivered', bg: 'rgba(22,163,74,.1)',  txt: GREEN },
  opened:    { label: 'Opened',    bg: 'rgba(22,163,74,.15)', txt: GREEN },
  clicked:   { label: 'Clicked',   bg: 'rgba(22,163,74,.15)', txt: GREEN },
  failed:    { label: 'Failed',    bg: 'rgba(192,0,0,.1)',    txt: RED   },
  bounced:   { label: 'Bounced',   bg: 'rgba(192,0,0,.1)',    txt: RED   },
  paused:    { label: 'Paused',    bg: 'rgba(217,119,6,.12)', txt: AMBER },
  completed: { label: 'Done',      bg: 'rgba(22,163,74,.1)',  txt: GREEN },
  cancelled: { label: 'Cancelled', bg: 'rgba(107,114,128,.1)', txt: '#6B7280' },
}

function StatusPill({ status }: { status: string }) {
  const m = STATUS_META[status] ?? { label: status, bg: 'var(--chip-bg)', txt: 'var(--chip-txt)' }
  return (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, borderRadius: RADIUS['2xl'], padding: '2px 10px', background: m.bg, color: m.txt, whiteSpace: 'nowrap' }}>
      {m.label}
    </span>
  )
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function RunProgress({ run }: { run: BulkRun }) {
  const total = run.total_recipients || 1
  const sentPct   = Math.round((run.sent_count / total) * 100)
  const failedPct = Math.round((run.failed_count / total) * 100)
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: TEXT.xs, color: 'var(--txt2)', marginBottom: 4, fontFamily: INTER }}>
        <span>{run.sent_count} sent · {run.failed_count} failed · {run.total_recipients} total</span>
        <span style={{ ...NUM }}>{sentPct}%</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: 'var(--bdr)', overflow: 'hidden', display: 'flex' }}>
        <div style={{ width: `${sentPct}%`, background: GREEN, transition: 'width .4s' }} />
        <div style={{ width: `${failedPct}%`, background: RED }} />
      </div>
    </div>
  )
}

// ── Customer typeahead ────────────────────────────────────────────────────────

function CustomerSearch({ onSelect }: { onSelect: (c: CustomerResult) => void }) {
  const [q,           setQ]           = useState('')
  const [results,     setResults]     = useState<CustomerResult[]>([])
  const [showDrop,    setShowDrop]    = useState(false)
  const [selected,    setSelected]    = useState<CustomerResult | null>(null)
  const timer    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapRef  = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (q.length < 3) { setResults([]); setShowDrop(false); return }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      try {
        const res = await apiFetch<{ data: CustomerResult[] }>(`/api/customer360/search?q=${encodeURIComponent(q)}&limit=10`)
        setResults(res.data ?? [])
        setShowDrop(true)
      } catch { setResults([]) }
    }, 300)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [q])

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setShowDrop(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  function pick(c: CustomerResult) {
    setSelected(c)
    setQ('')
    setResults([])
    setShowDrop(false)
    onSelect(c)
  }

  function clear() {
    setSelected(null)
    setQ('')
  }

  if (selected) {
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: `${SP[2]} ${SP[3]}`, background: `${NAVY}08`, border: `1.5px solid ${NAVY}20`, borderRadius: RADIUS.lg }}>
        <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: NAVY }}>person</span>
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{selected.name}</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>
            CIF: {selected.cif}{selected.email ? ` · ${selected.email}` : ''}
          </div>
        </div>
        <button onClick={clear} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt3)', display: 'flex', padding: 2 }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>close</span>
        </button>
      </div>
    )
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', maxWidth: 420 }}>
      <div style={{ position: 'relative' }}>
        <span className="material-symbols-rounded" style={{ position: 'absolute', left: SP[3], top: '50%', transform: 'translateY(-50%)', fontSize: TEXT.xl, color: 'var(--txt3)' }}>search</span>
        <input
          value={q} onChange={e => setQ(e.target.value)}
          onFocus={() => results.length > 0 && setShowDrop(true)}
          placeholder="Search customer name, CIF, or phone…"
          style={{ width: '100%', padding: `${SP[2]} ${SP[3]} ${SP[2]} 38px`, borderRadius: RADIUS.lg, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.base, color: 'var(--txt)', fontFamily: SORA, outline: 'none', boxSizing: 'border-box' }}
        />
      </div>
      {showDrop && results.length > 0 && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, boxShadow: '0 6px 24px rgba(0,0,0,.12)', marginTop: 4, overflow: 'hidden' }}>
          {results.map((c, i) => (
            <div key={i} onClick={() => pick(c)}
              style={{ padding: `${SP[2]} ${SP[4]}`, cursor: 'pointer' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{c.name}</div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER, marginTop: 2 }}>
                CIF: {c.cif}{c.email ? ` · ${c.email}` : ''}{c.phone ? ` · ${c.phone}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Field ─────────────────────────────────────────────────────────────────────

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 5, fontFamily: INTER }}>{hint}</div>}
    </div>
  )
}

const INPUT: React.CSSProperties = {
  display: 'block', width: '100%', padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md,
  border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)',
  fontSize: TEXT.base, color: 'var(--txt)', fontFamily: SORA, outline: 'none', boxSizing: 'border-box',
}

const TEXTAREA: React.CSSProperties = {
  ...INPUT, resize: 'vertical', minHeight: 80, fontFamily: INTER,
}

// ── Single send tab ───────────────────────────────────────────────────────────

function SingleSendTab({ onSent }: { onSent: () => void }) {
  const [customer,    setCustomer]    = useState<CustomerResult | null>(null)
  const [dateFrom,    setDateFrom]    = useState(monthStart())
  const [dateTo,      setDateTo]      = useState(today())
  const [stmtType,    setStmtType]    = useState<'account' | 'credit_card'>('account')
  const [email,       setEmail]       = useState('')
  const [subject,     setSubject]     = useState('')
  const [message,     setMessage]     = useState('')
  const [pwHint,      setPwHint]      = useState('')
  const [sending,     setSending]     = useState(false)
  const [previewing,  setPreviewing]  = useState(false)
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)
  const [showOpts,    setShowOpts]    = useState(false)

  async function preview() {
    if (!customer) { toast.error('Select a customer first'); return }
    setPreviewing(true)
    try {
      const res = await fetch(
        `${API}/api/statements/preview?cif=${encodeURIComponent(customer.cif)}&from=${dateFrom}&to=${dateTo}&type=${stmtType}`,
        { credentials: 'include' },
      )
      if (!res.ok) { toast.error('Failed to generate preview'); return }
      setPreviewHtml(await res.text())
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setPreviewing(false)
    }
  }

  async function send() {
    if (!customer) { toast.error('Select a customer first'); return }
    setSending(true)
    try {
      await apiFetch('/api/statements/send', {
        method: 'POST',
        body: JSON.stringify({
          cif: customer.cif,
          date_from: dateFrom,
          date_to:   dateTo,
          type:      stmtType,
          recipient_email: email.trim() || undefined,
          subject:  subject.trim() || undefined,
          message:  message.trim() || undefined,
          password_hint: pwHint.trim() || undefined,
        }),
      })
      toast.success(`Statement sent to ${email.trim() || customer.email || customer.cif}`)
      setCustomer(null)
      setEmail('')
      setSubject('')
      setMessage('')
      setPwHint('')
      setPreviewHtml(null)
      onSent()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSending(false)
    }
  }

  const typeLabel = stmtType === 'credit_card' ? 'Credit Card Statement' : 'Account Statement'

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '400px 1fr', gap: 20, alignItems: 'start' }}>

      {/* ── Left: form ── */}
      <SectionCard title="Send Statement" subtitle="Generate a PDF statement and email it to the customer">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

          <Field label="Customer">
            <CustomerSearch onSelect={c => { setCustomer(c); if (c.email) setEmail(c.email); setPreviewHtml(null) }} />
          </Field>

          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t); setPreviewHtml(null) }} />

          <Field label="Statement Type">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[2] }}>
              {([
                { key: 'account',     icon: 'receipt_long',  label: 'Account Statement'     },
                { key: 'credit_card', icon: 'credit_card',   label: 'Credit Card Statement' },
              ] as const).map(t => (
                <button key={t.key} onClick={() => { setStmtType(t.key); setPreviewHtml(null) }}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                    padding: `${SP[3]} ${SP[2]}`, borderRadius: RADIUS.lg, cursor: 'pointer', fontFamily: INTER,
                    border: `1.5px solid ${stmtType === t.key ? NAVY : 'var(--bdr)'}`,
                    background: stmtType === t.key ? `${NAVY}0d` : 'transparent',
                    color: stmtType === t.key ? NAVY : 'var(--txt2)',
                    transition: 'all .15s',
                  }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT['2xl'], opacity: stmtType === t.key ? 1 : .5 }}>{t.icon}</span>
                  <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold }}>{t.label}</span>
                </button>
              ))}
            </div>
          </Field>

          {/* Optional fields */}
          <button onClick={() => setShowOpts(o => !o)}
            style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--txt2)', fontSize: TEXT.sm, fontWeight: FW.semibold, padding: 0, fontFamily: INTER, width: 'fit-content' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md, transition: 'transform .15s', transform: showOpts ? 'rotate(90deg)' : 'none' }}>chevron_right</span>
            {showOpts ? 'Hide' : 'Show'} optional fields
          </button>

          {showOpts && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3], padding: SP[4], background: 'var(--input-bg)', borderRadius: RADIUS.lg, border: '1px solid var(--bdr)' }}>
              <Field label="Recipient Email Override" hint="Leave blank to use the customer's email on file">
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="customer@email.com" style={INPUT} />
              </Field>
              <Field label="Custom Subject">
                <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Your account statement" style={INPUT} />
              </Field>
              <Field label="Message">
                <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={message} onChange={e => setMessage(e.target.value)} placeholder="Please find your account statement attached." style={TEXTAREA} />
              </Field>
              <Field label="Password Hint" hint="Appended to message if the PDF is password-protected">
                <input value={pwHint} onChange={e => setPwHint(e.target.value)} placeholder="e.g. Last 4 digits of your phone number" style={INPUT} />
              </Field>
            </div>
          )}

          <div style={{ display: 'flex', gap: SP[2] }}>
            <button
              onClick={preview} disabled={!customer || previewing}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                padding: `${SP[2]} 0`, borderRadius: RADIUS.lg,
                border: `1.5px solid ${customer ? NAVY : 'var(--bdr)'}`,
                background: 'transparent',
                color: customer ? NAVY : 'var(--txt3)',
                fontSize: TEXT.base, fontWeight: FW.bold, cursor: customer ? 'pointer' : 'not-allowed', fontFamily: INTER,
              }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>preview</span>
              {previewing ? 'Loading…' : 'Preview'}
            </button>
            <button
              onClick={send} disabled={!customer || sending}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                padding: `${SP[2]} 0`, borderRadius: RADIUS.lg,
                border: 'none', background: customer ? NAVY : 'var(--bdr)',
                color: customer ? '#fff' : 'var(--txt3)',
                fontSize: TEXT.base, fontWeight: FW.bold, cursor: customer ? 'pointer' : 'not-allowed', fontFamily: INTER,
                transition: 'background .15s',
              }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>send</span>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>

        </div>
      </SectionCard>

      {/* ── Right: preview panel ── */}
      <div style={{
        display: 'flex', flexDirection: 'column',
        height: 'calc(100vh - 220px)', minHeight: 520,
        border: '1.5px solid var(--bdr)', borderRadius: RADIUS.xl, overflow: 'hidden',
        background: 'var(--card)',
      }}>
        {previewHtml ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `9px ${SP[4]}`, background: NAVY, flexShrink: 0 }}>
              <span style={{ color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, fontFamily: INTER }}>
                {customer?.name} — {typeLabel}
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => { const f = document.getElementById('stmt-frame') as HTMLIFrameElement; f?.contentWindow?.print() }}
                  style={{ display: 'flex', alignItems: 'center', gap: 5, padding: `5px ${SP[3]}`, borderRadius: RADIUS.sm, border: '1.5px solid rgba(255,255,255,.3)', background: 'transparent', color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: INTER }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>print</span>
                  Print / PDF
                </button>
                <button
                  onClick={() => setPreviewHtml(null)}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, padding: `5px ${SP[2]}`, borderRadius: RADIUS.sm, border: '1.5px solid rgba(255,255,255,.25)', background: 'transparent', color: 'rgba(255,255,255,.7)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>close</span>
                </button>
              </div>
            </div>
            <iframe
              id="stmt-frame"
              srcDoc={previewHtml}
              style={{ flex: 1, border: 'none', background: '#fff' }}
              title="Statement Preview"
            />
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, color: 'var(--txt3)', padding: SP[8] }}>
            <span className="material-symbols-rounded" style={{ fontSize: 52, opacity: .2 }}>description</span>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 6 }}>Statement Preview</div>
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', fontFamily: INTER, maxWidth: 260 }}>
                {customer
                  ? 'Click Preview to generate a statement for ' + customer.name
                  : 'Select a customer to get started'}
              </div>
            </div>
            {customer && (
              <button
                onClick={preview} disabled={previewing}
                style={{ display: 'flex', alignItems: 'center', gap: 7, padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.lg, border: `1.5px solid ${NAVY}`, background: 'transparent', color: NAVY, fontSize: TEXT.base, fontWeight: FW.bold, cursor: 'pointer', fontFamily: INTER }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>preview</span>
                {previewing ? 'Loading…' : 'Preview Statement'}
              </button>
            )}
          </div>
        )}
      </div>

    </div>
  )
}

// ── Bulk send tab ─────────────────────────────────────────────────────────────

function BulkSendTab({ onLaunched }: { onLaunched: () => void }) {
  const [dateFrom,  setDateFrom]  = useState(monthStart())
  const [dateTo,    setDateTo]    = useState(today())
  const [subject,   setSubject]   = useState('')
  const [message,   setMessage]   = useState('')
  const [pwHint,    setPwHint]    = useState('')
  const [limit,     setLimit]     = useState('')
  const [runs,      setRuns]      = useState<BulkRun[]>([])
  const [loadingRuns, setLoadingRuns] = useState(true)
  const [preview,   setPreview]   = useState<{ count: number; eligible: number; sample: any[] } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [launching,  setLaunching]  = useState(false)

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true)
    try {
      const data = await apiFetch<BulkRun[]>('/api/statements/runs')
      setRuns(Array.isArray(data) ? data : [])
    } catch { /* non-fatal */ }
    finally { setLoadingRuns(false) }
  }, [])

  useEffect(() => { loadRuns() }, [loadRuns])

  async function dryRun() {
    setPreviewing(true)
    setPreview(null)
    try {
      const res = await apiFetch<{ count: number; eligible: number; sample: any[] }>('/api/statements/bulk-send', {
        method: 'POST',
        body: JSON.stringify({ date_from: dateFrom, date_to: dateTo, limit: Number(limit) || 0, dry_run: true }),
      })
      setPreview(res)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setPreviewing(false)
    }
  }

  async function launch() {
    if (!confirm(`Send statements to ${preview ? preview.count : 'all eligible'} customers?`)) return
    setLaunching(true)
    try {
      const res = await apiFetch<{ total: number; eligible: number }>('/api/statements/bulk-send', {
        method: 'POST',
        body: JSON.stringify({
          date_from: dateFrom, date_to: dateTo,
          subject: subject.trim() || undefined,
          message: message.trim() || undefined,
          password_hint: pwHint.trim() || undefined,
          limit: Number(limit) || 0,
          dry_run: false,
        }),
      })
      toast.success(`Bulk send queued for ${res.total} customers`)
      setPreview(null)
      onLaunched()
      loadRuns()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setLaunching(false)
    }
  }

  async function runAction(id: number, action: 'pause' | 'resume' | 'cancel') {
    try {
      await apiFetch(`/api/statements/runs/${id}/${action}`, { method: 'POST' })
      toast.success(`Run ${action}d`)
      loadRuns()
    } catch (e: any) {
      toast.error(e.message)
    }
  }

  const RUN_COLS: TableCol<BulkRun>[] = [
    { key: 'created_at', label: 'Started', sortable: true,
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', ...NUM }}>{fmtDatetime(r.created_at)}</span> },
    { key: 'status', label: 'Status', render: r => <StatusPill status={r.status} /> },
    { key: 'period', label: 'Period',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{fmtDate(r.date_from)} – {fmtDate(r.date_to)}</span> },
    { key: '_progress', label: 'Progress',
      render: r => <RunProgress run={r} /> },
    { key: '_actions', label: '',
      render: r => (
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          {(r.status === 'queued' || r.status === 'active') && (
            <button onClick={() => runAction(r.id, 'pause')} style={{ padding: `3px ${SP[2]}`, borderRadius: RADIUS.sm, border: 'none', background: `${AMBER}15`, color: AMBER, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>Pause</button>
          )}
          {r.status === 'paused' && (
            <button onClick={() => runAction(r.id, 'resume')} style={{ padding: `3px ${SP[2]}`, borderRadius: RADIUS.sm, border: 'none', background: `${GREEN}12`, color: GREEN, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>Resume</button>
          )}
          {(r.status === 'queued' || r.status === 'active' || r.status === 'paused') && (
            <button onClick={() => runAction(r.id, 'cancel')} style={{ padding: `3px ${SP[2]}`, borderRadius: RADIUS.sm, border: 'none', background: 'rgba(192,0,0,.1)', color: RED, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>Cancel</button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>

      <SectionCard title="Configure Bulk Send" subtitle="Sends a statement PDF to every customer who has an email address on file">
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} />
            <Field label="Limit" hint="Max customers to include. Leave blank for all.">
              <input type="number" value={limit} onChange={e => setLimit(e.target.value)} placeholder="All eligible" min={1} style={INPUT} />
            </Field>
          </div>
          <Field label="Custom Subject" hint="Leave blank for default">
            <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Your O3 Cards statement: {dates}" style={INPUT} />
          </Field>
          <Field label="Message">
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={message} onChange={e => setMessage(e.target.value)} placeholder="Please find your account statement attached." style={TEXTAREA} />
          </Field>
          <Field label="Password Hint" hint="Shown in the email body if PDFs are password-protected">
            <input value={pwHint} onChange={e => setPwHint(e.target.value)} placeholder="e.g. Last 4 digits of phone number" style={INPUT} />
          </Field>

          {/* Preview box */}
          {preview && (
            <div style={{ background: `${NAVY}06`, border: `1.5px solid ${NAVY}20`, borderRadius: RADIUS.lg, padding: `${SP[4]} ${SP[4]}` }}>
              <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: NAVY, marginBottom: SP[2] }}>
                Dry Run Preview
              </div>
              <div style={{ display: 'flex', gap: 24, marginBottom: SP[3] }}>
                <div>
                  <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Will send to</div>
                  <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color: NAVY }}>{preview.count}</div>
                </div>
                <div>
                  <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>Total eligible</div>
                  <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color: 'var(--txt)' }}>{preview.eligible}</div>
                </div>
              </div>
              {preview.sample && preview.sample.length > 0 && (
                <div>
                  <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 6 }}>Sample recipients (first {preview.sample.length}):</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflow: 'auto' }}>
                    {preview.sample.map((r: any, i: number) => {
                      const name = [r['First Name'] ?? r.first_name ?? '', r['Last Name'] ?? r.last_name ?? ''].join(' ').trim() || r.name || 'Unknown'
                      const email = r['Email'] ?? r.email ?? ''
                      const cif   = r['CIF Number'] ?? r.cif_number ?? r.cif ?? ''
                      return (
                        <div key={i} style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
                          {name} · CIF {cif} · {email}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={dryRun} disabled={previewing} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: `${SP[2]} 18px`, borderRadius: RADIUS.lg, border: `1.5px solid ${NAVY}`, background: 'transparent', color: NAVY, fontSize: TEXT.base, fontWeight: FW.bold, cursor: 'pointer', fontFamily: INTER }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>preview</span>
              {previewing ? 'Checking…' : 'Dry Run (Preview)'}
            </button>
            <button onClick={launch} disabled={launching || !preview} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.lg, border: 'none', background: preview ? NAVY : 'var(--bdr)', color: preview ? '#fff' : 'var(--txt3)', fontSize: TEXT.base, fontWeight: FW.bold, cursor: preview ? 'pointer' : 'not-allowed', fontFamily: INTER }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>rocket_launch</span>
              {launching ? 'Launching…' : 'Launch Bulk Send'}
            </button>
          </div>
          {!preview && (
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', fontFamily: INTER }}>
              Run a Dry Run first to preview recipients before launching.
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Bulk Send Runs" badge={runs.length} padding={false}
        actions={
          <button onClick={loadRuns} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--txt2)', fontSize: TEXT.sm, fontFamily: INTER }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>refresh</span>
            Refresh
          </button>
        }
      >
        <DataTable cols={RUN_COLS} rows={runs} keyFn={r => r.id} loading={loadingRuns} emptyText="No bulk runs yet" />
      </SectionCard>

    </div>
  )
}

// ── History tab ───────────────────────────────────────────────────────────────

function HistoryTab() {
  const [rows,    setRows]    = useState<SentEmail[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [search,  setSearch]  = useState('')
  const [limit,   setLimit]   = useState(100)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<SentEmail[]>(`/api/statements/emails?limit=${limit}`)
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [limit])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    if (!search) return rows
    const q = search.toLowerCase()
    return rows.filter(r =>
      r.cif_number.toLowerCase().includes(q) ||
      r.customer_name?.toLowerCase().includes(q) ||
      r.recipient_email.toLowerCase().includes(q)
    )
  }, [rows, search])

  const COLS: TableCol<SentEmail>[] = [
    { key: 'created_at', label: 'Sent', sortable: true,
      render: r => <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtDatetime(r.created_at)}</span> },
    { key: 'customer_name', label: 'Customer',
      render: r => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.medium, color: 'var(--txt)' }}>{r.customer_name || '—'}</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>CIF: {r.cif_number}</div>
        </div>
      ),
    },
    { key: 'recipient_email', label: 'Sent To',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>{r.recipient_email}</span> },
    { key: 'period', label: 'Period',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.date_from)} – {fmtDate(r.date_to)}</span> },
    { key: 'status', label: 'Status', render: r => <StatusPill status={r.status} /> },
    { key: 'delivery', label: 'Delivery',
      render: r => (
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>
          {r.opened_at ? <span style={{ color: GREEN }}>Opened {fmtDate(r.opened_at)}</span>
            : r.delivered_at ? <span style={{ color: GREEN }}>Delivered {fmtDate(r.delivered_at)}</span>
            : r.bounced_at  ? <span style={{ color: RED   }}>Bounced {fmtDate(r.bounced_at)}</span>
            : r.last_error  ? <span style={{ color: RED   }} title={r.last_error}>Error</span>
            : '—'}
        </div>
      ),
    },
    { key: 'sent_by_name', label: 'Sent By',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.sent_by_name || 'System'}</span> },
  ]

  return (
    <SectionCard title="Statement Delivery History" badge={filtered.length} padding={false}
      actions={
        <div style={{ display: 'flex', gap: SP[2], alignItems: 'center' }}>
          <select value={limit} onChange={e => setLimit(Number(e.target.value))}
            style={{ padding: `5px ${SP[2]}`, borderRadius: 7, border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.sm, color: 'var(--txt)', outline: 'none' }}>
            {[100, 250, 500, 1000].map(n => <option key={n} value={n}>Last {n}</option>)}
          </select>
          <button onClick={load} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--txt2)', fontSize: TEXT.sm, fontFamily: INTER }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>refresh</span>
          </button>
        </div>
      }
    >
      <div style={{ padding: `${SP[2]} ${SP[4]}`, borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'var(--input-bg)', border: '1.5px solid var(--input-bdr)', borderRadius: RADIUS.md, padding: `7px ${SP[3]}`, maxWidth: 320 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 15, color: 'var(--txt3)' }}>search</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search CIF, name, email…"
            style={{ border: 'none', background: 'transparent', fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA, outline: 'none', width: '100%' }} />
          {search && (
            <button onClick={() => setSearch('')} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt3)', padding: 0, display: 'flex' }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.base }}>close</span>
            </button>
          )}
        </div>
      </div>
      <ErrBanner error={error} onRetry={load} />
      <DataTable cols={COLS} rows={filtered} keyFn={r => r.id} loading={loading} emptyText="No statements sent yet" />
    </SectionCard>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Statements() {
  const [tab, setTab] = useState('single')

  const TABS = [
    { key: 'single', label: 'Send to Customer' },
    { key: 'bulk',   label: 'Bulk Send'        },
    { key: 'history', label: 'History'         },
  ]

  return (
    <Page title="Statement Delivery" subtitle="Send account statement PDFs to customers — individually or in bulk">
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      <div style={{ marginTop: SP[5] }}>
        {tab === 'single'  && <SingleSendTab onSent={() => setTab('history')} />}
        {tab === 'bulk'    && <BulkSendTab   onLaunched={() => {}} />}
        {tab === 'history' && <HistoryTab />}
      </div>
    </Page>
  )
}
