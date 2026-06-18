import { useEffect, useState } from 'react'
import { apiFetch } from '../../lib/api'
import { Page, SectionCard, ErrBanner, KpiCard, NAVY, GREEN, RED, AMBER } from '../../components/UI'
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

export default function MailHealth() {
  const [deliverability, setDeliverability] = useState<Deliverability | null>(null)
  const [metrics, setMetrics] = useState<MetricRow[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    async function load() {
      setLoading(true); setError('')
      try {
        const [d, m] = await Promise.all([
          apiFetch('/api/mail/deliverability'),
          apiFetch('/api/mail/metrics'),
        ])
        if (!alive) return
        setDeliverability(d as Deliverability)
        setMetrics(((m as any).data ?? m ?? []) as MetricRow[])
      } catch (e: any) {
        if (alive) setError(e.message)
      } finally {
        if (alive) setLoading(false)
      }
    }
    load()
    return () => { alive = false }
  }, [])

  const count = (status: string) => metrics
    .filter(m => m.status === status)
    .reduce((sum, m) => sum + Number(m.count || 0), 0)

  const sent = metrics.reduce((sum, m) => sum + Number(m.count || 0), 0)
  const delivered = count('delivered')
  const bounced = count('bounced') + count('dropped') + count('spam_report')
  const opened = count('opened')

  return (
    <Page dept="Admin" title="Mail Health" subtitle="Deliverability checks, tracking, and campaign safety">
      <ErrBanner msg={error} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <KpiCard loading={loading} label="Tracked Mail" value={fmtNum(sent)} icon="mail" accent={NAVY} />
        <KpiCard loading={loading} label="Delivered" value={fmtNum(delivered)} icon="mark_email_read" accent={GREEN} />
        <KpiCard loading={loading} label="Opened" value={fmtNum(opened)} icon="drafts" accent={AMBER} />
        <KpiCard loading={loading} label="Problem Events" value={fmtNum(bounced)} icon="report" accent={RED} />
      </div>

      <SectionCard title="Deliverability Checklist" subtitle={deliverability?.domain ? `Domain: ${deliverability.domain}` : 'Mail domain not set'}>
        <div className="divide-y" style={{ borderColor: 'rgba(15,23,42,0.07)' }}>
          {(deliverability?.checks ?? []).map(check => (
            <div key={check.key} className="flex items-start gap-3 px-5 py-4">
              <span className="material-symbols-rounded text-[20px] mt-0.5" style={{ color: check.ok ? GREEN : RED }}>
                {check.ok ? 'check_circle' : 'error'}
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-slate-800">{check.label}</p>
                <p className="text-[12px] text-slate-500 mt-0.5 break-words">{check.detail}</p>
              </div>
            </div>
          ))}
          {!loading && !deliverability?.checks?.length && (
            <div className="px-5 py-8 text-center text-[13px] text-slate-400">No checks available.</div>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Status Breakdown" className="mt-5">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 p-4">
          {metrics.map(row => (
            <div key={`${row.kind}-${row.status}`} className="rounded-lg border px-4 py-3" style={{ borderColor: 'rgba(15,23,42,0.1)' }}>
              <p className="text-[11px] text-slate-400 uppercase font-semibold">{row.kind}</p>
              <div className="flex items-center justify-between mt-1">
                <p className="text-[13px] font-semibold text-slate-700">{row.status}</p>
                <p className="text-[18px] font-bold" style={{ color: NAVY }}>{fmtNum(row.count)}</p>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>
    </Page>
  )
}
