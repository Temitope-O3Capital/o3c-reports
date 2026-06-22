import { useEffect, useState, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import { Page, SectionCard, ErrBanner, KpiCard, DataTable, NAVY, GREEN, RED, AMBER } from '../../components/UI'
import { fmtNum } from '../../lib/fmt'

interface Check {
  key: string
  label: string
  ok: boolean
  detail: string
}

interface Deliverability {
  domain: string
  checks: Check[]
}

interface MetricRow {
  status: string
  kind: string
  count: number
}

interface MailMessage {
  id: number
  kind: string
  subject: string
  from_email: string
  recipients: Record<string, unknown>
  status: string
  provider_message_id: string
  queued_at: string
  delivered_at: string
  opened_at: string
  clicked_at: string
  bounced_at: string
  last_error: string
  created_at: string
}

interface Suppression {
  email: string
  reason: string
  source: string
  is_active: boolean
  updated_at: string
}

const STATUS_COLOR: Record<string, string> = {
  delivered: GREEN,
  opened:    '#2563EB',
  clicked:   '#7C3AED',
  bounced:   RED,
  dropped:   RED,
  spam_report: '#DC2626',
  sending:   AMBER,
  failed:    RED,
}

function statusBadge(status: string) {
  const color = STATUS_COLOR[status] ?? '#64748B'
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold text-white"
      style={{ background: color }}
    >
      {status}
    </span>
  )
}

function fmtDate(ts: string | null) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('en-NG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function recipientSummary(r: Record<string, unknown> | null): string {
  if (!r) return '—'
  const to = (r.to as { email: string }[] | undefined) ?? []
  if (to.length === 0) return '—'
  if (to.length === 1) return to[0].email
  return `${to[0].email} +${to.length - 1}`
}

/* ── Test Email Modal ── */
function TestModal({ onClose }: { onClose: () => void }) {
  const [to, setTo]           = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult]   = useState<{ ok?: boolean; error?: string } | null>(null)

  async function send() {
    if (!to.includes('@')) return
    setLoading(true)
    try {
      await apiFetch('/api/mail/test', { method: 'POST', body: JSON.stringify({ to }) })
      setResult({ ok: true })
    } catch (e: any) {
      setResult({ error: e.message })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/30">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-[15px] font-semibold text-slate-800">Send Test Email</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-100">
            <span className="material-symbols-rounded text-[18px] text-slate-400">close</span>
          </button>
        </div>

        {result?.ok ? (
          <div className="text-center py-6">
            <span className="material-symbols-rounded text-[40px] mb-2 block" style={{ color: GREEN }}>check_circle</span>
            <p className="text-[14px] font-semibold text-slate-700 mb-1">Test email sent!</p>
            <p className="text-[12px] text-slate-400">Check your inbox — delivery may take up to 2 minutes.</p>
            <button onClick={onClose} className="mt-4 px-4 py-2 rounded-lg text-[13px] text-white" style={{ background: NAVY }}>
              Close
            </button>
          </div>
        ) : (
          <>
            <p className="text-[13px] text-slate-500 mb-4">
              Sends a test email through your SendGrid configuration to verify the integration is working.
            </p>
            <label className="block text-[12px] font-medium text-slate-600 mb-1">Recipient email</label>
            <input
              type="email"
              value={to}
              onChange={e => setTo(e.target.value)}
              placeholder="you@example.com"
              className="w-full px-3 py-2 rounded-lg border text-[13px] focus:outline-none mb-4"
              style={{ borderColor: 'rgba(15,23,42,0.15)' }}
            />
            {result?.error && <p className="text-[12px] text-red-600 mb-3">{result.error}</p>}
            <div className="flex gap-2">
              <button onClick={onClose} className="flex-1 py-2 rounded-lg text-[13px] border" style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
                Cancel
              </button>
              <button
                onClick={send}
                disabled={loading || !to.includes('@')}
                className="flex-1 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-40"
                style={{ background: NAVY }}
              >
                {loading ? 'Sending…' : 'Send Test'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ── Main ── */
export default function MailHealth() {
  const [deliverability, setDeliverability] = useState<Deliverability | null>(null)
  const [metrics, setMetrics]               = useState<MetricRow[]>([])
  const [messages, setMessages]             = useState<MailMessage[]>([])
  const [suppressions, setSuppressions]     = useState<Suppression[]>([])
  const [error, setError]                   = useState('')
  const [loading, setLoading]               = useState(true)
  const [testOpen, setTestOpen]             = useState(false)
  const [removing, setRemoving]             = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [d, m, msgs, sups] = await Promise.all([
        apiFetch('/api/mail/deliverability'),
        apiFetch('/api/mail/metrics'),
        apiFetch('/api/mail/messages'),
        apiFetch('/api/mail/suppressions'),
      ])
      setDeliverability(d as Deliverability)
      setMetrics(((m as any).data ?? m ?? []) as MetricRow[])
      setMessages(((msgs as any).data ?? msgs ?? []) as MailMessage[])
      setSuppressions(((sups as any).data ?? sups ?? []) as Suppression[])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function removeSuppression(email: string) {
    setRemoving(email)
    try {
      await apiFetch(`/api/mail/suppressions/${encodeURIComponent(email)}`, { method: 'DELETE' })
      setSuppressions(s => s.filter(x => x.email !== email))
    } catch {
      // leave in list on error
    } finally {
      setRemoving(null)
    }
  }

  const count = (status: string) => metrics
    .filter(m => m.status === status)
    .reduce((sum, m) => sum + Number(m.count || 0), 0)

  const sent      = metrics.reduce((sum, m) => sum + Number(m.count || 0), 0)
  const delivered = count('delivered')
  const opened    = count('opened')
  const problems  = count('bounced') + count('dropped') + count('spam_report')
  const activeSups = suppressions.filter(s => s.is_active).length

  const msgCols = [
    { key: 'status',     label: 'Status',    render: (r: MailMessage) => statusBadge(r.status) },
    { key: 'subject',    label: 'Subject',   render: (r: MailMessage) => <span className="truncate max-w-[220px] block">{r.subject}</span> },
    { key: 'recipients', label: 'To',        render: (r: MailMessage) => <span className="text-slate-500">{recipientSummary(r.recipients as any)}</span> },
    { key: 'kind',       label: 'Kind',      render: (r: MailMessage) => <span className="text-[11px] text-slate-400">{r.kind}</span> },
    { key: 'created_at', label: 'Sent',      render: (r: MailMessage) => fmtDate(r.created_at) },
    { key: 'delivered_at', label: 'Delivered', render: (r: MailMessage) => fmtDate(r.delivered_at) },
    { key: 'opened_at', label: 'Opened',    render: (r: MailMessage) => fmtDate(r.opened_at) },
    { key: 'last_error', label: 'Error',     render: (r: MailMessage) => r.last_error
        ? <span className="text-[11px] text-red-500 truncate max-w-[180px] block">{r.last_error}</span>
        : <span className="text-slate-300">—</span> },
  ]

  const supCols = [
    { key: 'email',      label: 'Email',    render: (r: Suppression) => <span className="font-mono text-[12px]">{r.email}</span> },
    { key: 'reason',     label: 'Reason' },
    { key: 'source',     label: 'Source' },
    { key: 'is_active',  label: 'Active',   render: (r: Suppression) => (
      <span className="text-[11px] font-semibold" style={{ color: r.is_active ? RED : GREEN }}>
        {r.is_active ? 'Suppressed' : 'Removed'}
      </span>
    )},
    { key: 'updated_at', label: 'Updated',  render: (r: Suppression) => fmtDate(r.updated_at) },
    { key: '_action',    label: '',         render: (r: Suppression) => r.is_active ? (
      <button
        onClick={() => removeSuppression(r.email)}
        disabled={removing === r.email}
        className="text-[11px] text-blue-600 hover:text-blue-800 font-medium disabled:opacity-40"
      >
        {removing === r.email ? 'Removing…' : 'Remove'}
      </button>
    ) : null },
  ]

  return (
    <Page dept="Admin" title="Mail Health"
      subtitle="Deliverability checks, message log, suppressions, and test tools"
      actions={
        <div className="flex items-center gap-2">
          <button onClick={() => load()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[12px] font-medium"
            style={{ borderColor: 'rgba(15,23,42,0.15)' }}>
            <span className="material-symbols-rounded text-[14px]">refresh</span>Refresh
          </button>
          <button onClick={() => setTestOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white"
            style={{ background: NAVY }}>
            <span className="material-symbols-rounded text-[14px]">send</span>Send Test Email
          </button>
        </div>
      }
    >
      {testOpen && <TestModal onClose={() => setTestOpen(false)} />}
      <ErrBanner msg={error} />

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-5">
        <KpiCard loading={loading} label="Total Sent"      value={fmtNum(sent)}      icon="mail"            accent={NAVY}    />
        <KpiCard loading={loading} label="Delivered"       value={fmtNum(delivered)} icon="mark_email_read" accent={GREEN}   />
        <KpiCard loading={loading} label="Opened"          value={fmtNum(opened)}    icon="drafts"          accent="#2563EB" />
        <KpiCard loading={loading} label="Problem Events"  value={fmtNum(problems)}  icon="report"          accent={RED}     />
        <KpiCard loading={loading} label="Suppressions"    value={fmtNum(activeSups)} icon="block"          accent={AMBER}   />
      </div>

      {/* Deliverability checklist */}
      <SectionCard title="Deliverability Checklist"
        subtitle={deliverability?.domain ? `Domain: ${deliverability.domain}` : 'Mail domain not configured'}>
        <div className="divide-y" style={{ borderColor: 'rgba(15,23,42,0.07)' }}>
          {(deliverability?.checks ?? []).map(check => (
            <div key={check.key} className="flex items-start gap-3 px-5 py-4">
              <span
                className="material-symbols-rounded text-[20px] mt-0.5 flex-shrink-0"
                style={{ color: check.ok ? GREEN : RED }}
              >
                {check.ok ? 'check_circle' : 'error'}
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-slate-800">{check.label}</p>
                <p className="text-[12px] text-slate-500 mt-0.5 break-words">{check.detail}</p>
              </div>
            </div>
          ))}
          {!loading && !deliverability?.checks?.length && (
            <div className="px-5 py-8 text-center text-[13px] text-slate-400">
              No checks available — configure SENDGRID_FROM_EMAIL to begin.
            </div>
          )}
        </div>
      </SectionCard>

      {/* Status breakdown */}
      {metrics.length > 0 && (
        <SectionCard title="Status Breakdown" className="mt-5">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 p-4">
            {metrics.map(row => (
              <div key={`${row.kind}-${row.status}`}
                className="rounded-lg border px-4 py-3"
                style={{ borderColor: 'rgba(15,23,42,0.1)' }}>
                <p className="text-[11px] text-slate-400 uppercase font-semibold">{row.kind}</p>
                <div className="flex items-center justify-between mt-1">
                  <span>{statusBadge(row.status)}</span>
                  <p className="text-[18px] font-bold tabular-nums" style={{ color: NAVY }}>{fmtNum(row.count)}</p>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Message log */}
      <SectionCard title="Message Log" subtitle="Last 100 outbound emails across all users" className="mt-5">
        <DataTable
          loading={loading}
          cols={msgCols as any}
          rows={messages}
          emptyMsg="No messages recorded yet"
          emptyIcon="mail"
        />
      </SectionCard>

      {/* Suppression list */}
      <SectionCard
        title="Suppression List"
        subtitle={`${activeSups} active suppression${activeSups !== 1 ? 's' : ''} — emails on this list will not be sent campaign mail`}
        className="mt-5"
      >
        <DataTable
          loading={loading}
          cols={supCols as any}
          rows={suppressions}
          emptyMsg="No suppressions — great!"
          emptyIcon="check_circle"
        />
      </SectionCard>
    </Page>
  )
}
