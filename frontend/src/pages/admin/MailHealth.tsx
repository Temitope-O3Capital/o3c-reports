import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, DateFilter } from '../../components/UI'
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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminMailHealth() {
  const [metrics,       setMetrics]       = useState<MailMetrics | null>(null)
  const [suppressions,  setSuppresions]   = useState<Suppression[]>([])
  const [deliverability, setDeliverability] = useState<Deliverability | null>(null)
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [m, s, d] = await Promise.allSettled([
        apiFetch<MailMetrics>(`/api/mail/metrics?from=${dateFrom}&to=${dateTo}`),
        apiFetch<Suppression[]>(`/api/mail/suppressions?from=${dateFrom}&to=${dateTo}`),
        apiFetch<Deliverability>('/api/mail/deliverability'),
      ])
      if (m.status === 'fulfilled') setMetrics(m.value)
      if (s.status === 'fulfilled') setSuppresions(Array.isArray(s.value) ? s.value : [])
      if (d.status === 'fulfilled') setDeliverability(d.value)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  return (
    <Page back={{ label: 'Admin', to: '/admin' }} title="Mail Health" subtitle="SendGrid delivery metrics, deliverability, and suppressions"
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
      <SectionCard title="Suppressions" badge={suppressions.length} padding={false}>
        <DataTable
          cols={SUP_COLS}
          rows={suppressions}
          keyFn={r => r.email}
          loading={loading}
          emptyText="No suppressions found"
          searchKeys={['email', 'source', 'reason']}
        />
      </SectionCard>
    </Page>
  )
}
