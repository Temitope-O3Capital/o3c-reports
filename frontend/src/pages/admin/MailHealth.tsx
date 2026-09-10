import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, DataTable, ExpandableFilterBar, ErrBanner, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime, fmtNum, monthStart, today } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, INTER, SORA, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface MailMetrics {
  total_sent: number
  total_delivered: number
  total_opened: number
  total_clicked: number
  total_bounced: number
  total_spam: number
  delivery_rate: number
  open_rate: number
  bounce_rate: number
}

interface Suppression {
  email: string
  source: string
  reason: string
  updated_at: string
}

interface DeliverabilityCheck {
  key:    string
  label:  string
  ok:     boolean
  detail: string
}

interface Deliverability {
  domain:  string
  checks:  DeliverabilityCheck[]
}

// ── Metric card ───────────────────────────────────────────────────────────────

function MetricCard({ label, value, pct, color }: { label: string; value: number; pct?: number; color: string }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.xl, padding: '14px 16px' }}>
      <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: 6 }}>{label}</div>
      <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color }}>{fmtNum(value)}</div>
      {pct !== undefined && (
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', marginTop: 3, fontFamily: INTER }}>{pct.toFixed(1)}%</div>
      )}
    </div>
  )
}

// ── Status dot ────────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const ok = status === 'pass' || status === 'good' || status === 'valid' || status === 'ok'
  const warn = status === 'neutral' || status === 'moderate'
  const c = ok ? GREEN : warn ? AMBER : RED
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: SP[1] }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', textTransform: 'capitalize' }}>{status}</span>
    </div>
  )
}

// ── Suppressions table ────────────────────────────────────────────────────────

const SUP_COLS: TableCol<Suppression>[] = [
  { key: 'email', label: 'Email',
    render: r => <span style={{ fontSize: TEXT.sm, fontFamily: 'monospace', color: 'var(--txt)' }}>{r.email}</span> },
  { key: 'source', label: 'Source',
    render: r => <span style={{ fontSize: TEXT.sm, background: 'var(--chip-bg)', color: 'var(--chip-txt)', borderRadius: RADIUS.sm, padding: '2px 9px', fontWeight: FW.semibold, textTransform: 'capitalize' }}>{r.source || '—'}</span> },
  { key: 'reason', label: 'Reason',
    render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.reason || '—'}</span> },
  { key: 'updated_at', label: 'Updated', width: 145,
    render: r => <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtDatetime(r.updated_at)}</span> },
]

// ── Test email ────────────────────────────────────────────────────────────────

function TestEmailPanel() {
  const [to, setTo]     = useState('')
  const [sending, setSending] = useState(false)

  async function send() {
    if (!to.trim()) { toast.error('Enter a recipient email'); return }
    setSending(true)
    try {
      await apiFetch('/api/mail/test', { method: 'POST', body: JSON.stringify({ to }) })
      toast.success(`Test email sent to ${to}`)
      setTo('')
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={{ display: 'flex', gap: SP[2], alignItems: 'center' }}>
      <input
        value={to} onChange={e => setTo(e.target.value)}
        placeholder="recipient@example.com"
        style={{ flex: 1, padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.base, color: 'var(--txt)', fontFamily: SORA, outline: 'none' }}
      />
      <button onClick={send} disabled={sending} style={{
        padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff',
        fontSize: TEXT.base, fontWeight: FW.bold, cursor: 'pointer', fontFamily: INTER, whiteSpace: 'nowrap',
      }}>
        {sending ? 'Sending…' : 'Send Test'}
      </button>
    </div>
  )
}

// ── SendGrid suppressions (live, provider-side) ────────────────────────────────

interface SGItem { email: string; type: string; reason?: string; status?: string; created?: number }

const SG_TABS = [
  { key: 'unsubscribes', label: 'Unsubscribes' },
  { key: 'bounces',      label: 'Bounces' },
  { key: 'blocks',       label: 'Blocks' },
  { key: 'spam',         label: 'Spam reports' },
  { key: 'invalid',      label: 'Invalid' },
]

function sgCreated(v?: number) {
  if (!v) return '—'
  try { return fmtDatetime(new Date(v * 1000).toISOString()) } catch { return '—' }
}

function SendGridSuppressions() {
  const [type, setType]   = useState('unsubscribes')
  const [items, setItems] = useState<SGItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr]     = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const [lookup, setLookup] = useState('')
  const [lookupRes, setLookupRes] = useState<{ email: string; suppressed: boolean; on: Record<string, boolean> } | null>(null)
  const [lookingUp, setLookingUp] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const r = await apiFetch<any>(`/api/mail/sendgrid/suppressions?type=${type}&limit=500`)
      setItems((r?.data?.items ?? r?.items ?? []) as SGItem[])
    } catch (e: any) { setErr(e.message); setItems([]) }
    finally { setLoading(false) }
  }, [type])

  useEffect(() => { load() }, [load])

  async function remove(email: string) {
    if (!confirm(`Remove ${email} from SendGrid ${type}? They will be eligible to receive mail again.`)) return
    setRemoving(email)
    try {
      await apiFetch(`/api/mail/sendgrid/suppressions/${type}/${encodeURIComponent(email)}`, { method: 'DELETE' })
      toast.success(`Removed ${email}`)
      setItems(prev => prev.filter(i => i.email !== email))
      if (lookupRes?.email?.toLowerCase() === email.toLowerCase()) setLookupRes(null)
    } catch (e: any) { toast.error(e.message) }
    finally { setRemoving(null) }
  }

  async function runLookup() {
    const email = lookup.trim()
    if (!email.includes('@')) { toast.error('Enter a valid email'); return }
    setLookingUp(true); setLookupRes(null)
    try {
      const r = await apiFetch<any>(`/api/mail/sendgrid/suppressions/lookup?email=${encodeURIComponent(email)}`)
      setLookupRes((r?.data ?? r))
    } catch (e: any) { toast.error(e.message) }
    finally { setLookingUp(false) }
  }

  const shown = useMemo(() =>
    search ? items.filter(i => i.email.toLowerCase().includes(search.toLowerCase())) : items
  , [items, search])

  const cols: TableCol<SGItem>[] = [
    { key: 'email', label: 'Email',
      render: r => <span style={{ fontSize: TEXT.sm, fontFamily: 'monospace', color: 'var(--txt)' }}>{r.email}</span> },
    { key: 'reason', label: 'Reason / status',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.reason || r.status || '—'}</span> },
    { key: 'created', label: 'Since', width: 150,
      render: r => <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>{sgCreated(r.created)}</span> },
    { key: 'actions', label: '', width: 96,
      render: r => (
        <button onClick={() => remove(r.email)} disabled={removing === r.email}
          style={{ padding: '4px 12px', borderRadius: RADIUS.md, border: '1px solid var(--card-bdr)', background: 'var(--card)', color: RED, fontSize: TEXT.xs, fontWeight: FW.bold, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          {removing === r.email ? '…' : 'Remove'}
        </button>
      ) },
  ]

  return (
    <SectionCard title="SendGrid suppressions" subtitle="Live from SendGrid — addresses it will not deliver to until removed" badge={shown.length} padding={false}>
      {/* Lookup */}
      <div style={{ display: 'flex', gap: SP[2], alignItems: 'center', padding: `${SP[3]} ${SP[4]}`, borderBottom: '1px solid var(--card-bdr)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Check an address:</span>
        <input value={lookup} onChange={e => setLookup(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') runLookup() }}
          placeholder="customer@example.com"
          style={{ flex: '1 1 220px', minWidth: 180, padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md, border: '1.5px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.sm, color: 'var(--txt)', outline: 'none' }} />
        <button onClick={runLookup} disabled={lookingUp}
          style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.bold, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          {lookingUp ? 'Checking…' : 'Check'}
        </button>
        {lookupRes && (
          <div style={{ flexBasis: '100%', display: 'flex', gap: SP[2], flexWrap: 'wrap', alignItems: 'center', paddingTop: SP[1] }}>
            <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: 'monospace' }}>{lookupRes.email}:</span>
            {!lookupRes.suppressed
              ? <span style={{ fontSize: TEXT.sm, color: GREEN, fontWeight: FW.bold }}>Clear — not suppressed</span>
              : SG_TABS.filter(t => lookupRes.on[t.key]).map(t => (
                  <span key={t.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: TEXT.xs, background: 'var(--chip-bg)', color: RED, borderRadius: RADIUS.sm, padding: '3px 10px', fontWeight: FW.bold }}>
                    {t.label}
                    <button onClick={() => { setType(t.key); remove(lookupRes.email) }} title="Remove"
                      style={{ border: 'none', background: 'transparent', color: RED, cursor: 'pointer', fontWeight: FW.bold, padding: 0, lineHeight: 1 }}>×</button>
                  </span>
                )) }
          </div>
        )}
      </div>

      {/* Type tabs */}
      <div style={{ display: 'flex', gap: SP[1], padding: `${SP[3]} ${SP[4]} 0`, flexWrap: 'wrap' }}>
        {SG_TABS.map(t => {
          const on = t.key === type
          return (
            <button key={t.key} onClick={() => { setType(t.key); setSearch('') }}
              style={{ padding: '6px 14px', borderRadius: RADIUS.md, border: on ? `1.5px solid ${NAVY}` : '1px solid var(--card-bdr)', background: on ? NAVY : 'var(--card)', color: on ? '#fff' : 'var(--txt2)', fontSize: TEXT.sm, fontWeight: FW.bold, cursor: 'pointer' }}>
              {t.label}
            </button>
          )
        })}
      </div>

      {err && <div style={{ padding: `${SP[2]} ${SP[4]}`, color: RED, fontSize: TEXT.sm }}>{err}</div>}

      <ExpandableFilterBar
        search={search} onSearch={setSearch} groups={[]} onReset={() => setSearch('')}
        resultCount={shown.length} totalCount={items.length}
        placeholder="Search email…"
      />
      <DataTable cols={cols} rows={shown} keyFn={r => r.email} loading={loading}
        emptyText={loading ? 'Loading…' : `No ${SG_TABS.find(t => t.key === type)?.label.toLowerCase()} on SendGrid`} />
    </SectionCard>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminMailHealth() {
  const [metrics,       setMetrics]       = useState<MailMetrics | null>(null)
  const [suppressions,  setSuppresions]   = useState<Suppression[]>([])
  const [deliverability, setDeliverability] = useState<Deliverability | null>(null)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())
  const [supSearch, setSupSearch] = useState('')

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [m, s, d] = await Promise.allSettled([
        apiFetch<any>(`/api/mail/metrics?from=${dateFrom}&to=${dateTo}`),
        apiFetch<Suppression[]>(`/api/mail/suppressions?from=${dateFrom}&to=${dateTo}`),
        apiFetch<Deliverability>('/api/mail/deliverability'),
      ])
      // /api/mail/metrics wraps in { data:{...} }; tolerate a bare object too.
      if (m.status === 'fulfilled') { const mv: any = m.value; setMetrics(mv?.data ?? mv) }
      if (s.status === 'fulfilled') setSuppresions(Array.isArray(s.value) ? s.value : [])
      if (d.status === 'fulfilled') setDeliverability(d.value)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['users'] })

  const displayedSups = useMemo(() =>
    supSearch
      ? suppressions.filter(s => s.email.includes(supSearch) || (s.source ?? '').toLowerCase().includes(supSearch.toLowerCase()) || (s.reason ?? '').toLowerCase().includes(supSearch.toLowerCase()))
      : suppressions
  , [suppressions, supSearch])

  return (
    <Page back={{ label: 'Admin', to: '/admin' }} title="Mail Health" subtitle="SendGrid delivery metrics, deliverability, and suppressions"
      loading={loading && !metrics}
      skeletonKpis={6}
      actions={<DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />}
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Metrics strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: SP[3], marginBottom: 20 }}>
        <MetricCard label="Sent"      value={metrics?.total_sent ?? 0}      color="var(--txt)" />
        <MetricCard label="Delivered" value={metrics?.total_delivered ?? 0} color={GREEN} pct={metrics?.delivery_rate} />
        <MetricCard label="Opened"    value={metrics?.total_opened ?? 0}    color={NAVY}  pct={metrics?.open_rate} />
        <MetricCard label="Clicked"   value={metrics?.total_clicked ?? 0}   color={NAVY} />
        <MetricCard label="Bounced"   value={metrics?.total_bounced ?? 0}   color={metrics?.bounce_rate && metrics.bounce_rate > 2 ? RED : AMBER} pct={metrics?.bounce_rate} />
        <MetricCard label="Spam"      value={metrics?.total_spam ?? 0}      color={metrics?.total_spam && metrics.total_spam > 0 ? RED : 'var(--txt)' } />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: SP[4], marginBottom: 16 }}>

        {/* Send test email */}
        <SectionCard title="Send Test Email" subtitle="Verify your sending configuration">
          <TestEmailPanel />
        </SectionCard>

        {/* Deliverability */}
        <SectionCard title="Deliverability" subtitle={deliverability?.domain || undefined}>
          {deliverability?.checks?.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
              {deliverability.checks.map(check => (
                <div key={check.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: SP[2] }}>
                  <div>
                    <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt)', textTransform: 'uppercase' }}>{check.key}</div>
                    {check.detail && <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 1 }}>{check.detail}</div>}
                  </div>
                  <StatusDot status={check.ok ? 'pass' : 'fail'} />
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: 'var(--txt3)', fontSize: TEXT.base, textAlign: 'center', padding: '12px 0' }}>
              {loading ? 'Loading…' : 'No deliverability data'}
            </div>
          )}
        </SectionCard>

      </div>

      {/* Suppressions */}
      <SectionCard title="Suppressions" badge={displayedSups.length} padding={false}>
        <ExpandableFilterBar
          search={supSearch}
          onSearch={setSupSearch}
          groups={[]}
          onReset={() => setSupSearch('')}
          resultCount={displayedSups.length}
          totalCount={suppressions.length}
          placeholder="Search email, source, reason…"
        />
        <DataTable
          cols={SUP_COLS}
          rows={displayedSups}
          keyFn={r => r.email}
          loading={loading}
          emptyText="No suppressions found"
        />
      </SectionCard>

      {/* SendGrid-side suppressions (unsubscribes / bounces / blocks / spam / invalid) */}
      <div style={{ marginTop: 16 }}>
        <SendGridSuppressions />
      </div>
    </Page>
  )
}
