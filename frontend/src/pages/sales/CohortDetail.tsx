import { useState, useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Page, SectionCard, DataTable, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, fmtPct } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, RED, BLUE, SORA, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DetailRow {
  id: number
  reference: string | null
  applicant_name: string
  product_type: string
  employer: string
  amount_requested_kobo: number
  outstanding_kobo: number
  dpd: number
  status: string
  stage: string
  created_at: string
}

interface DetailResponse {
  cohort: string
  data: DetailRow[]
  count: number
  total_outstanding: number
  par30_count: number
}

// ── Table columns ─────────────────────────────────────────────────────────────

const COLS: TableCol<DetailRow>[] = [
  {
    key: 'applicant_name', label: 'Applicant', sortable: true,
    render: r => (
      <div>
        <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: SORA }}>{r.applicant_name}</div>
        {r.reference && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: 'monospace' }}>{r.reference}</div>}
      </div>
    ),
  },
  { key: 'product_type', label: 'Product', sortable: true, render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.product_type || '—'}</span> },
  { key: 'employer',     label: 'Employer',  sortable: true, render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.employer || '—'}</span> },
  {
    key: 'amount_requested_kobo', label: 'Amount', sortable: true, align: 'right',
    render: r => <span style={{ ...NUM, fontWeight: FW.semibold, color: 'var(--txt)' }}>{fmtKobo(r.amount_requested_kobo)}</span>,
  },
  {
    key: 'outstanding_kobo', label: 'Outstanding', sortable: true, align: 'right',
    render: r => <span style={{ ...NUM, color: r.outstanding_kobo > 0 ? RED : 'var(--txt3)' }}>{r.outstanding_kobo > 0 ? fmtKobo(r.outstanding_kobo) : '—'}</span>,
  },
  {
    key: 'dpd', label: 'DPD', sortable: true, align: 'right',
    render: r => (
      <span style={{ ...NUM, fontWeight: FW.bold, color: r.dpd > 30 ? RED : r.dpd > 0 ? AMBER : GREEN }}>
        {r.dpd}
      </span>
    ),
  },
  {
    key: 'status', label: 'Status', sortable: true,
    render: r => {
      const s = r.status.toLowerCase()
      const cfg = s === 'active' ? { bg: `${GREEN}18`, txt: GREEN }
        : s === 'rejected' || s === 'defaulted' ? { bg: `${RED}18`, txt: RED }
        : s === 'disbursed' || s === 'booked' ? { bg: `${BLUE}18`, txt: BLUE }
        : { bg: `${NAVY}12`, txt: NAVY }
      return (
        <span style={{
          fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px',
          borderRadius: RADIUS.full, background: cfg.bg, color: cfg.txt,
        }}>
          {r.status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
        </span>
      )
    },
  },
  {
    key: 'created_at', label: 'Booked', sortable: true,
    render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>{fmtDate(r.created_at)}</span>,
  },
]

// ── Main component ─────────────────────────────────────────────────────────────

export default function CohortDetail() {
  const { month } = useParams<{ month: string }>()
  const [searchParams] = useSearchParams()
  const age = searchParams.get('age') ?? ''

  const [detail,  setDetail]  = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState<string | null>(null)

  useEffect(() => {
    if (!month) return
    setLoading(true); setErr(null)
    apiFetch<{ data: DetailResponse }>(`/api/sales/cohort-detail?cohort=${encodeURIComponent(month)}&limit=200`)
      .then(r => setDetail(r.data))
      .catch((e: any) => setErr(e.message ?? 'Failed to load cohort detail'))
      .finally(() => setLoading(false))
  }, [month])

  const par30Rate = detail && detail.count > 0
    ? (detail.par30_count / detail.count) * 100
    : null

  const stageBreakdown = detail
    ? Object.entries(
        detail.data.reduce<Record<string, number>>((acc, r) => {
          acc[r.stage] = (acc[r.stage] ?? 0) + 1
          return acc
        }, {})
      ).sort((a, b) => b[1] - a[1])
    : []

  return (
    <Page
      title={`Cohort: ${month ?? '…'}`}
      subtitle={age ? `Drilling into ${age} retention window` : 'Booking month cohort detail'}
      back={{ label: 'Cohort Analysis', to: '/sales/cohort' }}
    >
      <ErrBanner error={err} />

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: 10, color: 'var(--txt2)' }}>
          <Spinner size={18} color={NAVY} /> Loading cohort data…
        </div>
      )}

      {detail && !loading && (
        <>
          {/* Summary strip */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: SP[3], marginBottom: SP[4] }}>
            {[
              { label: 'Total Accounts',   value: fmtNum(detail.count),                     accent: NAVY  },
              { label: 'Total Outstanding', value: fmtKobo(detail.total_outstanding),        accent: RED   },
              { label: 'PAR30 Count',      value: fmtNum(detail.par30_count),               accent: AMBER },
              { label: 'PAR30 Rate',       value: par30Rate !== null ? fmtPct(par30Rate, 1) : '—', accent: par30Rate !== null && par30Rate > 15 ? RED : GREEN },
            ].map(kpi => (
              <div key={kpi.label} style={{
                background: 'var(--card)', borderRadius: RADIUS.xl, padding: '16px 18px',
                border: '1px solid var(--bdr)', borderTop: `3px solid ${kpi.accent}`,
              }}>
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{kpi.label}</div>
                <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color: 'var(--txt)', marginTop: 6 }}>{kpi.value}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: SP[3], marginBottom: SP[4] }}>
            {/* Stage breakdown */}
            <SectionCard title="Stage Breakdown">
              {stageBreakdown.length === 0 ? (
                <div style={{ color: 'var(--txt3)', fontSize: TEXT.base }}>No data</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {stageBreakdown.map(([stage, count]) => {
                    const pct = (count / detail.count) * 100
                    const cfg =
                      stage === 'active' || stage === 'disbursed' ? { color: GREEN }
                      : stage === 'rejected' || stage === 'cancelled' ? { color: RED }
                      : { color: NAVY }
                    return (
                      <div key={stage}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                          <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', textTransform: 'capitalize' }}>
                            {stage.replace(/_/g, ' ')}
                          </span>
                          <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: cfg.color }}>
                            {fmtNum(count)} ({fmtPct(pct, 1)})
                          </span>
                        </div>
                        <div style={{ height: 6, borderRadius: 3, background: 'var(--bdr)' }}>
                          <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: cfg.color }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </SectionCard>

            {/* DPD distribution */}
            <SectionCard title="DPD Distribution">
              {(() => {
                const buckets: Record<string, number> = { '0': 0, '1-30': 0, '31-60': 0, '61-90': 0, '91+': 0 }
                detail.data.forEach(r => {
                  if (r.dpd === 0)         buckets['0']++
                  else if (r.dpd <= 30)    buckets['1-30']++
                  else if (r.dpd <= 60)    buckets['31-60']++
                  else if (r.dpd <= 90)    buckets['61-90']++
                  else                     buckets['91+']++
                })
                const colors: Record<string, string> = { '0': GREEN, '1-30': AMBER, '31-60': '#F97316', '61-90': RED, '91+': '#7F1D1D' }
                return Object.entries(buckets).map(([label, count]) => {
                  const pct = detail.count > 0 ? (count / detail.count) * 100 : 0
                  return (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                      <div style={{ width: 44, fontSize: TEXT.xs, fontWeight: FW.bold, color: colors[label], textAlign: 'right', fontFamily: 'monospace' }}>
                        {label} DPD
                      </div>
                      <div style={{ flex: 1, height: 20, borderRadius: 3, background: 'var(--bdr)' }}>
                        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: colors[label], minWidth: pct > 0 ? 4 : 0 }} />
                      </div>
                      <div style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', width: 36, textAlign: 'right' }}>
                        {count}
                      </div>
                    </div>
                  )
                })
              })()}
            </SectionCard>
          </div>

          {/* Accounts table */}
          <SectionCard title="Accounts in Cohort" badge={detail.count} padding={false}>
            <DataTable<DetailRow>
              cols={COLS}
              rows={detail.data}
              keyFn={r => r.id}
              emptyText="No accounts in this cohort"
              searchKeys={['applicant_name', 'reference', 'employer', 'product_type']}
              searchPlaceholder="Filter accounts…"
              pageSize={25}
            />
          </SectionCard>
        </>
      )}

      {!loading && !detail && !err && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 0', gap: SP[3], color: 'var(--txt2)' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 52, color: 'var(--txt3)' }}>group_work</span>
          <span style={{ fontSize: TEXT.md }}>No cohort data found for {month}</span>
        </div>
      )}
    </Page>
  )
}
