import { useEffect, useMemo, useState, useCallback } from 'react'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, EmptyState } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import CommissionRatesModal from '../../components/CommissionRatesModal'
import { EBar, EDonut } from '../../components/echarts'
import { apiFetch, unwrapList } from '../../lib/api'
import { fmtKoboExact, fmtKobo, fmtNum } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, BLUE, NUM, TEXT, FW, SP } from '../../lib/design'

// Sales Commissions — Finance-owned view of what each sales officer earned in a
// period. Loans and Fixed Deposits pay a percentage of booked value; cards pay a
// fixed naira amount per card issued. Finance owns the RATES themselves, exposed
// here through CommissionRatesModal.
//
// Every *_kobo field is a minor-unit integer → format with fmtKobo. Counts (loans,
// FDs, cards, officers) are plain integers → fmtNum.

interface CommissionRow {
  user_id: number
  full_name: string
  actual_loans: number
  actual_kobo: number       // loans booked + disbursed value (kobo)
  actual_fds: number
  actual_fd_kobo: number    // FDs booked + principal (kobo)
  actual_cards: number
  commission_kobo: number   // cards sold + commission payable (kobo)
}

// Rows fed to the top-earners bar chart.
interface EarnerBar { name: string; commission_kobo: number }
// Rows fed to the booked-composition donut.
interface CompSlice { name: string; value: number; color: string }

function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// First name / short label for the chart x-axis so ticks stay legible.
function shortName(full: string): string {
  const parts = (full || '—').trim().split(/\s+/)
  return parts[0] || full || '—'
}

const COLS: TableCol<CommissionRow>[] = [
  { key: 'full_name', label: 'Officer', render: r => <span style={{ fontWeight: FW.medium }}>{r.full_name || '—'}</span> },
  { key: 'actual_loans', label: 'Loans', align: 'right', sortable: true, render: r => <span style={NUM}>{fmtNum(r.actual_loans)}</span> },
  { key: 'actual_kobo', label: 'Disbursed', align: 'right', sortable: true, render: r => <span style={NUM}>{fmtKoboExact(r.actual_kobo)}</span> },
  { key: 'actual_fds', label: 'FDs', align: 'right', sortable: true, render: r => <span style={NUM}>{fmtNum(r.actual_fds)}</span> },
  { key: 'actual_fd_kobo', label: 'FD Amount', align: 'right', sortable: true, render: r => <span style={NUM}>{fmtKoboExact(r.actual_fd_kobo)}</span> },
  { key: 'actual_cards', label: 'Cards', align: 'right', sortable: true, render: r => <span style={NUM}>{fmtNum(r.actual_cards)}</span> },
  { key: 'commission_kobo', label: 'Commission', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: GREEN }}>{fmtKoboExact(r.commission_kobo)}</span> },
]

export default function Commissions() {
  const [period, setPeriod] = useState<string>(currentMonth)
  const [rows, setRows] = useState<CommissionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [ratesOpen, setRatesOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch(`/api/sales/commission-summary?period=${period}`)
      setRows(unwrapList<CommissionRow>(r))
    } catch (e: any) {
      setError(e?.message || 'Failed to load commissions')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => { load() }, [load])

  // ── Derived aggregates ──────────────────────────────────────────────────────
  const totalCommission = rows.reduce((s, r) => s + Number(r.commission_kobo || 0), 0)
  const earners = rows.filter(r => Number(r.commission_kobo || 0) > 0).length
  const loansKobo = rows.reduce((s, r) => s + Number(r.actual_kobo || 0), 0)
  const fdKobo = rows.reduce((s, r) => s + Number(r.actual_fd_kobo || 0), 0)
  const bookedKobo = loansKobo + fdKobo
  const avgPerEarner = earners > 0 ? totalCommission / earners : 0

  // Sorted by commission desc — used by both the table and the top-earners chart.
  const sorted = useMemo(
    () => [...rows].sort((a, b) => Number(b.commission_kobo || 0) - Number(a.commission_kobo || 0)),
    [rows],
  )

  const topEarners: EarnerBar[] = useMemo(
    () => sorted
      .filter(r => Number(r.commission_kobo || 0) > 0)
      .slice(0, 10)
      .map(r => ({ name: shortName(r.full_name), commission_kobo: Number(r.commission_kobo || 0) })),
    [sorted],
  )

  const composition: CompSlice[] = useMemo(() => [
    { name: 'Loans', value: loansKobo, color: NAVY },
    { name: 'Fixed Deposits', value: fdKobo, color: AMBER },
  ], [loansKobo, fdKobo])

  const hasComposition = bookedKobo > 0

  return (
    <Page
      title="Sales Commissions"
      loading={loading && rows.length === 0}
      skeletonKpis={4}
      subtitle="Officer commission earned per period"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="month"
            value={period}
            onChange={e => setPeriod(e.target.value)}
            aria-label="Commission period"
            style={{
              height: 34, padding: '0 10px', borderRadius: 8,
              border: '1px solid var(--input-bdr)', background: 'var(--input-bg)',
              color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold,
            }}
          />
          <button
            onClick={() => setRatesOpen(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              height: 34, padding: '0 13px', borderRadius: 8,
              border: '1px solid var(--bdr)', background: 'var(--card)',
              color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 17 }}>percent</span>
            Commission Rates
          </button>
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: SP[4], marginBottom: SP[5] }}>
        <KpiCard label="Total Commission" value={fmtKoboExact(totalCommission)} sub={`payable · ${period}`} icon="payments" accent={GREEN} loading={loading} />
        <KpiCard label="Earning Officers" value={fmtNum(earners)} sub={`of ${fmtNum(rows.length)} on book`} icon="groups" accent={NAVY} loading={loading} />
        <KpiCard label="Booked Value" value={fmtKoboExact(bookedKobo)} sub="loans + FD principal" icon="account_balance" accent={BLUE} loading={loading} />
        <KpiCard label="Avg per Earner" value={fmtKoboExact(avgPerEarner)} sub="commission per earning officer" icon="functions" accent={AMBER} loading={loading} />
      </div>

      {/* Top earners + Booked composition */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: SP[4], marginBottom: SP[5] }}>
        <SectionCard title="Top earners" subtitle="Highest commission payable this period" badge={topEarners.length || undefined}>
          {topEarners.length === 0
            ? <EmptyState icon="leaderboard" title="No commission earned" description="No officer earned commission in this period." />
            : (
              <EBar<EarnerBar>
                data={topEarners}
                xKey="name"
                series={[{ key: 'commission_kobo', name: 'Commission', color: GREEN }]}
                valueFmt={fmtKobo}
                axisFmt={fmtKobo}
                legend={false}
                height={260}
              />
            )}
        </SectionCard>

        <SectionCard title="Booked composition" subtitle="Loans vs Fixed Deposits">
          {!hasComposition
            ? <EmptyState icon="donut_large" title="Nothing booked" description="No loans or fixed deposits booked in this period." />
            : (
              <div style={{ display: 'flex', alignItems: 'center', gap: SP[4], flexWrap: 'wrap' }}>
                <EDonut<CompSlice>
                  data={composition}
                  valueKey="value"
                  nameKey="name"
                  colorFn={row => row.color}
                  valueFmt={fmtKobo}
                  centerValue={fmtKoboExact(bookedKobo)}
                  centerLabel="Booked"
                  size={168}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minWidth: 130 }}>
                  {composition.map(s => (
                    <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontWeight: FW.semibold, textTransform: 'uppercase', letterSpacing: 0.3 }}>{s.name}</div>
                        <div style={{ ...NUM, fontSize: 15, fontWeight: FW.bold, color: 'var(--txt)' }}>{fmtKoboExact(s.value)}</div>
                        <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                          {bookedKobo > 0 ? `${Math.round((s.value / bookedKobo) * 100)}%` : '—'}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
        </SectionCard>
      </div>

      {/* Commission by officer */}
      <SectionCard
        title="Commission by officer"
        subtitle={`Loans & Fixed Deposits pay a % of booked value; cards a fixed ₦ per card · ${period}`}
        badge={rows.length || undefined}
        padding={false}
      >
        <DataTable<CommissionRow>
          cols={COLS}
          rows={sorted}
          keyFn={r => r.user_id}
          loading={loading}
          emptyText="No commission recorded for this period"
          pageSize={20}
        />
      </SectionCard>

      <CommissionRatesModal open={ratesOpen} onClose={() => setRatesOpen(false)} />
    </Page>
  )
}
