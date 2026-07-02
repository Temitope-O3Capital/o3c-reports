import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiFetch, apiPost } from '../../lib/api'
import { today, monthStart, fmtDate } from '../../lib/fmt'
import { ConfirmModal, DataTable, DateFilter, ErrBanner, NAVY, Page, SectionCard, type ColDef } from '../../components/UI'

interface StatementLog {
  id: string
  cif_number: string
  customer_name?: string
  recipient_email: string
  date_from: string
  date_to: string
  subject: string
  status: string
  delivered_at?: string | null
  opened_at?: string | null
  bounced_at?: string | null
  last_error?: string | null
  created_at: string
  sent_by_name?: string
}

interface StatementRun {
  id: string
  status: string
  date_from: string
  date_to: string
  subject?: string | null
  requested_limit?: number | null
  total_recipients: number
  sent_count: number
  failed_count: number
  last_error?: string | null
  started_at?: string | null
  completed_at?: string | null
  created_at: string
}

const DEFAULT_MESSAGE = 'Please find your account statement attached to this email.'

function statusClass(status: string) {
  if (['delivered', 'opened', 'clicked'].includes(status)) return 'bg-green-50 text-green-700'
  if (['failed', 'bounced', 'dropped', 'spam_report'].includes(status)) return 'bg-red-50 text-red-700'
  return 'bg-[var(--chip-bg)] text-[color:var(--txt2)]'
}

export default function Statements() {
  const [tab, setTab] = useState<'single' | 'monthly'>('single')
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [cif, setCif] = useState('')
  const [recipient, setRecipient] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState(DEFAULT_MESSAGE)
  const [passwordHint, setPasswordHint] = useState('')
  const [month, setMonth] = useState(today().slice(0, 7))
  const [limit, setLimit] = useState('')
  const [preview, setPreview] = useState<any | null>(null)
  const [logs, setLogs] = useState<StatementLog[]>([])
  const [runs, setRuns] = useState<StatementRun[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null)

  async function loadLogs(cifFilter = '') {
    const url = cifFilter ? `/api/statements/emails?limit=100&cif=${encodeURIComponent(cifFilter)}` : '/api/statements/emails?limit=100'
    const res: any = await apiFetch(url)
    setLogs(Array.isArray(res) ? res : (res.data ?? []))
  }

  async function loadRuns() {
    const res: any = await apiFetch('/api/statements/runs?limit=50')
    setRuns(Array.isArray(res) ? res : (res.data ?? []))
  }

  useEffect(() => {
    loadLogs().catch(() => {})
    loadRuns().catch(() => {})
    const t = window.setInterval(() => {
      loadRuns().catch(() => {})
      loadLogs().catch(() => {})
    }, 15000)
    return () => window.clearInterval(t)
  }, [])

  async function sendSingle() {
    if (!cif.trim()) { toast.error('Enter CIF number'); return }
    if (!recipient.trim()) { toast.error('Enter recipient email'); return }
    setLoading(true); setError('')
    try {
      await apiPost('/api/statements/send', {
        cif: cif.trim(), date_from: from, date_to: to, recipient_email: recipient.trim(),
        subject: subject.trim() || undefined, message: message.trim() || undefined, password_hint: passwordHint.trim() || undefined,
      })
      toast.success('Statement email queued')
      await loadLogs(cif.trim())
    } catch (e: any) {
      setError(e.message); toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  function monthRange() {
    const start = `${month}-01`
    const end = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).toISOString().slice(0, 10)
    return { start, end }
  }

  async function previewBulk() {
    const { start, end } = monthRange()
    const parsedLimit = Number(limit) || 0
    setLoading(true); setError('')
    try {
      const res: any = await apiPost('/api/statements/bulk-send', { date_from: start, date_to: end, limit: parsedLimit, dry_run: true })
      setPreview(res.data ?? res)
      toast.success('Monthly recipient preview loaded')
    } catch (e: any) {
      setError(e.message); toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function sendBulk() {
    const { start, end } = monthRange()
    const parsedLimit = Number(limit) || 0
    const countLabel = parsedLimit > 0 ? `up to ${parsedLimit} customers` : 'all eligible customers'
    setConfirm({
      title: 'Queue Statement Run',
      message: `Queue monthly statements for ${start} to ${end} to ${countLabel}?`,
      onConfirm: async () => {
        setLoading(true); setError('')
        try {
          const res: any = await apiPost('/api/statements/bulk-send', {
            date_from: start, date_to: end, limit: parsedLimit, dry_run: false,
            subject: subject.trim() || undefined, message: message.trim() || undefined, password_hint: passwordHint.trim() || undefined,
          })
          const data = res.data ?? res
          toast.success(`Statement run queued for ${data.total ?? 0} customer(s)`)
          setPreview(data)
          await loadRuns()
          await loadLogs()
        } catch (e: any) {
          setError(e.message); toast.error(e.message)
        } finally {
          setLoading(false)
        }
      },
    })
  }

  async function runAction(id: string, action: 'pause' | 'resume' | 'cancel') {
    if (action === 'cancel') {
      setConfirm({
        title: 'Cancel Statement Run',
        message: 'Cancel this statement run? Pending recipients will not be sent.',
        onConfirm: () => doRunAction(id, action),
      })
      return
    }
    doRunAction(id, action)
  }

  async function doRunAction(id: string, action: 'pause' | 'resume' | 'cancel') {
    setLoading(true); setError('')
    try {
      await apiPost(`/api/statements/runs/${id}/${action}`, {})
      toast.success(`Statement run ${action === 'resume' ? 'resumed' : action + 'd'}`)
      await loadRuns()
    } catch (e: any) {
      setError(e.message); toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  const cols: ColDef<StatementLog>[] = [
    { key: 'created_at', label: 'Sent', render: r => <span className="text-[11px] text-[color:var(--txt2)] whitespace-nowrap">{fmtDate(r.created_at)}</span> },
    { key: 'customer', label: 'Customer', render: r => <div><p className="text-[12px] font-semibold text-[color:var(--txt)]">{r.customer_name || 'Customer'}</p><p className="font-mono text-[11px] text-[color:var(--txt2)]">{r.cif_number}</p></div> },
    { key: 'recipient_email', label: 'Recipient', render: r => <span className="text-[12px] text-[color:var(--txt2)]">{r.recipient_email}</span> },
    { key: 'period', label: 'Period', render: r => <span className="text-[12px] text-[color:var(--txt2)] whitespace-nowrap">{r.date_from} to {r.date_to}</span> },
    { key: 'status', label: 'Status', render: r => <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold ${statusClass(r.status)}`}>{r.status}</span> },
    { key: 'tracking', label: 'Tracking', render: r => <span className="text-[11px] text-[color:var(--txt2)]">{r.opened_at ? 'Opened' : r.delivered_at ? 'Delivered' : r.bounced_at ? 'Bounced' : r.last_error ? r.last_error : 'Pending'}</span> },
  ]

  const runCols: ColDef<StatementRun>[] = [
    { key: 'created_at', label: 'Started', render: r => <span className="text-[11px] text-[color:var(--txt2)] whitespace-nowrap">{fmtDate(r.created_at)}</span> },
    { key: 'period', label: 'Period', render: r => <span className="text-[12px] text-[color:var(--txt2)] whitespace-nowrap">{r.date_from} to {r.date_to}</span> },
    { key: 'status', label: 'Status', render: r => <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold ${statusClass(r.status)}`}>{r.status}</span> },
    { key: 'progress', label: 'Progress', render: r => <Progress sent={Number(r.sent_count || 0)} failed={Number(r.failed_count || 0)} total={Number(r.total_recipients || 0)} /> },
    { key: 'last_error', label: 'Last Note', render: r => <span className="text-[11px] text-[color:var(--txt2)]">{r.last_error || '—'}</span> },
    { key: 'actions', label: '', render: r => <div className="flex justify-end gap-1">
      {['queued', 'active'].includes(r.status) && <IconBtn icon="pause" label="Pause" onClick={() => runAction(r.id, 'pause')} />}
      {r.status === 'paused' && <IconBtn icon="play_arrow" label="Resume" onClick={() => runAction(r.id, 'resume')} />}
      {!['completed', 'cancelled'].includes(r.status) && <IconBtn icon="cancel" label="Cancel" onClick={() => runAction(r.id, 'cancel')} />}
    </div> },
  ]

  return (
    <Page dept="Customer Communications" title="Statements" subtitle="Send one-off and monthly PDF account statements to customers">
      <ErrBanner msg={error} />

      <div className="flex gap-2 mb-4">
        {(['single', 'monthly'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className="px-4 py-2 rounded-lg text-[13px] font-semibold border" style={{ background: tab === t ? NAVY : '#fff', color: tab === t ? '#fff' : '#475569', borderColor: 'rgba(15,23,42,0.12)' }}>
            {t === 'single' ? 'Single Customer' : 'Monthly Batch'}
          </button>
        ))}
      </div>

      {tab === 'single' ? (
        <SectionCard title="Send Single Statement" subtitle="Generate a PDF statement for one CIF and email it">
          <div className="p-5 space-y-4">
            <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="CIF Number" value={cif} onChange={setCif} placeholder="e.g. 0001234" />
              <Field label="Recipient Email" value={recipient} onChange={setRecipient} placeholder="customer@email.com" type="email" />
              <Field label="Subject" value={subject} onChange={setSubject} placeholder={`Your O3 Cards statement: ${from} to ${to}`} />
              <Field label="Password Hint" value={passwordHint} onChange={setPasswordHint} placeholder="Optional. Do not enter the actual password." />
            </div>
            <TextArea label="Message" value={message} onChange={setMessage} />
            <button onClick={sendSingle} disabled={loading} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60" style={{ background: NAVY }}>
              <span className="material-symbols-rounded text-[16px]">outgoing_mail</span>
              {loading ? 'Sending...' : 'Send Statement'}
            </button>
          </div>
        </SectionCard>
      ) : (
        <SectionCard title="Monthly Statement Batch" subtitle="Preview and send monthly statements to customers with email addresses">
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Field label="Statement Month" value={month} onChange={setMonth} type="month" />
              <Field label="Batch Limit" value={limit} onChange={setLimit} placeholder="Blank means all eligible" type="number" />
              <Field label="Password Hint" value={passwordHint} onChange={setPasswordHint} placeholder="Optional hint only" />
            </div>
            <Field label="Subject" value={subject} onChange={setSubject} placeholder="Leave blank for default subject" />
            <TextArea label="Message" value={message} onChange={setMessage} />
            <div className="flex flex-wrap gap-2">
              <button onClick={previewBulk} disabled={loading} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold border disabled:opacity-60" style={{ borderColor: 'rgba(15,23,42,0.14)', color: NAVY }}>
                <span className="material-symbols-rounded text-[16px]">manage_search</span> Preview Recipients
              </button>
              <button onClick={sendBulk} disabled={loading} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60" style={{ background: '#059669' }}>
                <span className="material-symbols-rounded text-[16px]">mark_email_read</span> Send Monthly Batch
              </button>
            </div>
            {preview && (
              <div className="rounded-lg border border-[var(--bdr)] bg-[var(--bg)] px-4 py-3 text-[12px] text-[color:var(--txt2)]">
                <strong>{preview.count ?? preview.total ?? 0}</strong> recipient(s) in scope. Sent: <strong>{preview.sent ?? 0}</strong>. Failed: <strong>{preview.failed ?? 0}</strong>.
                {preview.eligible != null && <span> Eligible total: <strong>{preview.eligible}</strong>.</span>}
              </div>
            )}
          </div>
        </SectionCard>
      )}

      <SectionCard title="Monthly Statement Runs" subtitle={`${runs.length} recent runs`} className="mt-5">
        <DataTable cols={runCols} rows={runs} loading={loading && runs.length === 0} emptyIcon="schedule_send" emptyMsg="No monthly statement runs yet" />
      </SectionCard>

      <SectionCard title="Statement Email History" subtitle={`${logs.length} recent sends`} className="mt-5">
        <DataTable cols={cols} rows={logs} loading={loading && logs.length === 0} emptyIcon="receipt_long" emptyMsg="No statement emails yet" />
      </SectionCard>

      {confirm && (
        <ConfirmModal
          title={confirm.title}
          message={confirm.message}
          confirmLabel="Yes, proceed"
          onConfirm={() => { confirm.onConfirm(); setConfirm(null) }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </Page>
  )
}

function Progress({ sent, failed, total }: { sent: number; failed: number; total: number }) {
  const done = sent + failed
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div className="min-w-[150px]">
      <div className="flex justify-between text-[11px] text-[color:var(--txt2)] mb-1"><span>{done}/{total}</span><span>{pct}%</span></div>
      <div className="h-1.5 rounded-full bg-[var(--chip-bg)] overflow-hidden"><div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
      <p className="mt-1 text-[11px] text-[color:var(--txt2)]">Sent {sent} · Failed {failed}</p>
    </div>
  )
}

function IconBtn({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className="w-8 h-8 inline-flex items-center justify-center rounded-lg border border-[var(--bdr)] text-[color:var(--txt2)] hover:bg-[var(--bg)]">
      <span className="material-symbols-rounded text-[17px]">{icon}</span>
    </button>
  )
}

function Field({ label, value, onChange, placeholder = '', type = 'text' }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-bold uppercase text-[color:var(--txt2)] mb-1">{label}</span>
      <input value={value} onChange={e => onChange(e.target.value)} type={type} placeholder={placeholder} className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none" style={{ borderColor: 'var(--bdr)' }} />
    </label>
  )
}

function TextArea({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-bold uppercase text-[color:var(--txt2)] mb-1">{label}</span>
      <textarea value={value} onChange={e => onChange(e.target.value)} rows={4} className="w-full px-3 py-2 rounded-lg border text-[13px] outline-none resize-y" style={{ borderColor: 'var(--bdr)' }} />
    </label>
  )
}
