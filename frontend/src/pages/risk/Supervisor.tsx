import { useLiveData } from '../../hooks/useRealtime'
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKoboExact, fmtKobo, fmtNum, fmtPct } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, NAVY, RED, AMBER, GREEN, NUM } from '../../lib/design'
import { DpdBar } from '../../components/DpdBar'
import { bandColor, bandLabel, bandShort, scoreColor, fmtScore, dpdColor } from '../../lib/riskScale'
import { EBar, EDonut } from '../../components/echarts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Snapshot {
  total_active_loans: number; total_book_kobo: number; total_arrears_kobo: number
  avg_credit_score: number; current_loans: number; par30_loans: number; par60_loans: number
  npl_loans: number; par30_kobo: number; npl_kobo: number
  npl_ratio_pct: number; par30_rate_pct: number; worst_dpd: number
}
interface DpdBucketRow { bucket: string; count: number; kobo: number }
interface BandRow { band: string; count: number; pct: number }
interface WatchRow {
  cif: string; name: string; product: string; sector: string
  outstanding_kobo: number; arrears_kobo: number; dpd: number; band: string | null; score: number | null
}
interface ConcRow { cif: string; name: string; loans: number; book_kobo: number; pct_of_total: number }
interface SectorRow { sector: string; loan_count: number; book_kobo: number; book_pct: number }
interface ReviewRow { pending: number; reviewed_today: number; approved_mtd: number; declined_mtd: number; oldest_pending_days: number }
interface Supervisor {
  origination_live?: boolean; concentration_limit_pct?: number
  snapshot?: Snapshot; dpd_buckets?: DpdBucketRow[]; bands?: BandRow[]
  watchlist?: WatchRow[]; concentration?: ConcRow[]; sectors?: SectorRow[]; review?: ReviewRow
}

const N = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

function sectorFill(i: number, total: number) {
  const op = 0.95 - (i / Math.max(total - 1, 1)) * 0.55
  return `rgba(14,40,65,${op.toFixed(2)})`
}

// A coordination hand-off tile: a cross-team action the head routes work into.
function HandoffTile({ icon, color, label, value, sub, onClick }: {
  icon: string; color: string; label: string; value: string; sub: string; onClick: () => void
}) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
      borderRadius: RADIUS.lg, border: '1px solid var(--card-bdr)', background: 'var(--card)', cursor: 'pointer',
    }}>
      <div style={{ width: 34, height: 34, borderRadius: RADIUS.md, background: `${color}14`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 18, color }}>{icon}</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{label}</div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value} · {sub}</div>
      </div>
      <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)', flexShrink: 0 }}>chevron_right</span>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function RiskSupervisor() {
  const navigate = useNavigate()
  const [d, setD] = useState<Supervisor | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const r = await apiFetch<{ data: Supervisor }>('/api/risk/supervisor')
      setD(r.data ?? {})
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(), { topics: ['loans'] })

  if (loading && !d) return (
    <Page title="Supervisor"><div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div></Page>
  )
  if (!d) return <Page title="Supervisor"><ErrBanner error={error} onRetry={load} /></Page>

  const s = d.snapshot
  const limit = N(d.concentration_limit_pct) || 20
  const bands = d.bands ?? []
  const conc = d.concentration ?? []
  const sectors = d.sectors ?? []
  const watchlist = d.watchlist ?? []
  const buckets = d.dpd_buckets ?? []
  const review = d.review
  const live = d.origination_live === true

  const topObligor = conc[0]
  const breaches = conc.filter(c => N(c.pct_of_total) > limit)
  const totalBandCount = bands.reduce((a, b) => a + N(b.count), 0)
  const nplRatio = N(s?.npl_ratio_pct)

  // Prioritised things the head must action or coordinate, worst first.
  const actionItems: { icon: string; color: string; title: string; detail: string; onClick?: () => void }[] = []
  breaches.forEach(b => actionItems.push({
    icon: 'corporate_fare', color: RED,
    title: `${b.name} — ${fmtPct(b.pct_of_total)} of book`,
    detail: `Single obligor over the ${limit}% policy limit; review the exposure`,
  }))
  if (nplRatio > 5) actionItems.push({
    icon: 'trending_down', color: RED,
    title: `NPL ratio ${fmtPct(nplRatio)} above tolerance`,
    detail: 'Over the 5% limit — review the 90+ book to escalate to Recovery',
    onClick: () => navigate('/operations/risk/portfolio?dpd=npl'),
  })
  if (N(s?.npl_loans) > 0) actionItems.push({
    icon: 'block', color: RED,
    title: `${fmtNum(N(s?.npl_loans))} loans over 90 DPD`,
    detail: `${fmtKoboExact(N(s?.npl_kobo))} at risk — review to hand off to Recovery`,
    onClick: () => navigate('/operations/risk/portfolio?dpd=npl'),
  })
  if (N(s?.par30_loans) > 0) actionItems.push({
    icon: 'schedule', color: AMBER,
    title: `${fmtNum(N(s?.par30_loans))} loans past 30 DPD`,
    detail: 'Follow up before they roll to NPL',
    onClick: () => navigate('/operations/risk/portfolio?dpd=par30,par60,par90,npl'),
  })
  if (live && N(review?.oldest_pending_days) >= 3) actionItems.push({
    icon: 'hourglass_bottom', color: AMBER,
    title: 'Review turnaround breach',
    detail: `Oldest application waiting ${fmtNum(review?.oldest_pending_days)}d — reassign or decide`,
    onClick: () => navigate('/operations/risk/applications'),
  })

  const concCols: TableCol<ConcRow>[] = [
    { key: 'name', label: 'Borrower', render: r => (
      <div>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.name || 'Unknown'}</div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: 'var(--font-mono)' }}>{r.cif}</div>
      </div>
    )},
    { key: 'loans', label: 'Loans', align: 'right', render: r => <span style={NUM}>{fmtNum(r.loans)}</span> },
    { key: 'book_kobo', label: 'Exposure', align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKoboExact(r.book_kobo)}</span> },
    { key: 'pct_of_total', label: '% of Book', align: 'right', render: r => {
      const pct = N(r.pct_of_total)
      const breach = pct > limit
      const color = breach ? RED : pct > limit / 2 ? AMBER : NAVY
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
          <div style={{ width: 56, height: 6, borderRadius: 3, background: 'var(--bdr)', overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 3, width: `${Math.min(100, pct)}%`, background: color }} />
          </div>
          <span style={{ ...NUM, fontSize: TEXT.sm, minWidth: 42, textAlign: 'right', color, fontWeight: breach ? FW.bold : FW.normal }}>{fmtPct(pct)}</span>
        </div>
      )
    }},
  ]

  const watchCols: TableCol<WatchRow>[] = [
    { key: 'name', label: 'Borrower', render: r => (
      <div>
        <div style={{ fontWeight: FW.semibold }}>{r.name || 'Unknown'}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: 'var(--font-mono)' }}>{r.cif}</div>
      </div>
    )},
    { key: 'product', label: 'Product', render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{r.product || '—'}</span> },
    { key: 'outstanding_kobo', label: 'Outstanding', align: 'right', render: r => <span style={NUM}>{fmtKoboExact(r.outstanding_kobo)}</span> },
    { key: 'arrears_kobo', label: 'Arrears', align: 'right', render: r => <span style={{ ...NUM, color: N(r.arrears_kobo) > 0 ? RED : 'var(--txt3)' }}>{N(r.arrears_kobo) > 0 ? fmtKoboExact(r.arrears_kobo) : '—'}</span> },
    { key: 'dpd', label: 'DPD', align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: dpdColor(r.dpd) }}>{fmtNum(r.dpd)}</span> },
    { key: 'band', label: 'Band', render: r => r.band ? <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 9px', borderRadius: RADIUS['2xl'], background: `${bandColor(r.band)}18`, color: bandColor(r.band) }}>{bandShort(r.band)}</span> : <span style={{ color: 'var(--txt3)' }}>—</span> },
  ]

  return (
    <Page title="Supervisor" subtitle="Risk head oversight: portfolio quality, delinquency, concentration and the team's queue">
      <ErrBanner error={error} onRetry={load} />

      {/* Breach + NPL alerts */}
      {breaches.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: SP[3], padding: `${SP[2]} ${SP[4]}`, background: `${RED}08`, border: `1px solid ${RED}30`, borderRadius: RADIUS.md }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: RED, flexShrink: 0, marginTop: 1 }}>corporate_fare</span>
          <div>
            <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: RED }}>Single-obligor concentration breach{breaches.length > 1 ? 'es' : ''}</span>
            {breaches.map(b => (
              <div key={b.cif} style={{ fontSize: TEXT.xs, color: RED, marginTop: 2 }}>{b.name}: {fmtPct(b.pct_of_total)} of book · policy limit {limit}%</div>
            ))}
          </div>
        </div>
      )}
      {nplRatio > 5 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: SP[3], padding: `${SP[2]} ${SP[4]}`, background: `${RED}08`, border: `1px solid ${RED}30`, borderRadius: RADIUS.md }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: RED }}>trending_down</span>
          <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: RED }}>NPL ratio {fmtPct(nplRatio)} is above the 5% tolerance</span>
        </div>
      )}

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Active Book" value={s ? fmtKoboExact(s.total_book_kobo) : '—'} sub={s ? `${fmtNum(s.total_active_loans)} loans` : undefined} icon="account_balance_wallet" accent={NAVY} />
        <KpiCard label="NPL Ratio" value={s ? fmtPct(s.npl_ratio_pct) : '—'} sub="DPD > 90" icon="trending_down" accent={nplRatio > 5 ? RED : nplRatio > 2 ? AMBER : GREEN} />
        <KpiCard label="PAR 30" value={s ? fmtPct(s.par30_rate_pct) : '—'} sub={s ? `${fmtNum(s.par30_loans)} loans` : undefined} icon="schedule" accent={N(s?.par30_rate_pct) > 10 ? RED : N(s?.par30_rate_pct) > 5 ? AMBER : GREEN} />
        <KpiCard label="Arrears" value={s ? fmtKoboExact(s.total_arrears_kobo) : '—'} sub="behind schedule" icon="warning_amber" accent={N(s?.total_arrears_kobo) > 0 ? AMBER : GREEN} />
        <KpiCard label="Avg Score" value={fmtScore(s?.avg_credit_score)} sub="active book · 0-100" icon="psychology" accent={scoreColor(s?.avg_credit_score)} />
        <KpiCard label="Top Obligor" value={topObligor ? fmtPct(topObligor.pct_of_total) : '—'} sub={topObligor ? topObligor.name : `limit ${limit}%`} icon="corporate_fare" accent={topObligor && N(topObligor.pct_of_total) > limit ? RED : NAVY} />
      </div>

      {/* Operations & Coordination — what the head must action or hand off today */}
      <SectionCard title="Operations & Coordination" subtitle="Decisions to take and hand-offs to coordinate across teams" style={{ marginBottom: SP[4] }}>
        <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: SP[4] }}>
          {/* Action items */}
          <div>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 10 }}>Action Items</div>
            {actionItems.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '18px 0', color: GREEN, fontSize: TEXT.sm }}>
                <span className="material-symbols-rounded" style={{ fontSize: 18 }}>check_circle</span>
                Nothing needs escalation — portfolio within tolerances.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {actionItems.map((a, i) => (
                  <div key={i} onClick={a.onClick} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
                    borderRadius: RADIUS.md, border: `1px solid ${a.color}30`, background: `${a.color}0A`,
                    cursor: a.onClick ? 'pointer' : 'default',
                  }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 18, color: a.color, flexShrink: 0, marginTop: 1 }}>{a.icon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{a.title}</div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 1 }}>{a.detail}</div>
                    </div>
                    {a.onClick && <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)', flexShrink: 0 }}>chevron_right</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Hand-offs / coordination */}
          <div>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 10 }}>Hand-offs</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
              <HandoffTile icon="collections_bookmark" color={AMBER} label="Collections book"
                value={`${fmtNum(N(s?.par30_loans))} loans past 30 DPD`}
                sub={`${fmtKoboExact(N(s?.par30_kobo))} outstanding`}
                onClick={() => navigate('/operations/risk/portfolio?dpd=par30,par60,par90,npl')} />
              <HandoffTile icon="gavel" color={RED} label="Recovery candidates"
                value={`${fmtNum(N(s?.npl_loans))} loans over 90 DPD`}
                sub={`${fmtKoboExact(N(s?.npl_kobo))} at risk`}
                onClick={() => navigate('/operations/risk/portfolio?dpd=npl')} />
              <HandoffTile icon={live ? 'fact_check' : 'schedule'} color={NAVY}
                label={live ? 'Review queue' : 'Review queue (idle)'}
                value={live ? `${fmtNum(N(review?.pending))} pending` : 'No applications yet'}
                sub={live && N(review?.oldest_pending_days) > 0 ? `oldest ${fmtNum(review?.oldest_pending_days)}d` : 'origination via Phoenix'}
                onClick={() => navigate('/operations/risk/applications')} />
            </div>
          </div>
        </div>
      </SectionCard>

      {/* Delinquency distribution */}
      <SectionCard title="Delinquency Distribution" subtitle="Whole book by days past due (schedule-derived DPD)" style={{ marginBottom: SP[4] }}>
        {N(s?.total_active_loans) === 0
          ? <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>No active loans</div>
          : <DpdBar buckets={buckets} />}
      </SectionCard>

      {/* Band donut + Sector bar */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[4] }}>
        <SectionCard title="Risk Band Distribution" subtitle="Active book, A (Prime) to E (High-Risk)">
          {bands.length === 0 ? (
            <div style={{ padding: `${SP[6]} 0`, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>No scored loans</div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[4] }}>
              <div style={{ flexShrink: 0 }}>
                <EDonut
                  data={bands}
                  valueKey="count"
                  nameKey="band"
                  colorFn={(b) => bandColor(b.band)}
                  size={148}
                  inner={42}
                  outer={66}
                  centerValue={fmtNum(totalBandCount)}
                  centerLabel="loans"
                  valueFmt={fmtNum}
                />
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {bands.map(b => (
                  <div key={b.band} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 10, height: 10, borderRadius: RADIUS.xs, background: bandColor(b.band), flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium }}>{bandLabel(b.band)}</span>
                    <span style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.bold, color: bandColor(b.band) }}>{fmtPct(b.pct)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Sector Concentration" subtitle="Top sectors by share of active book">
          {sectors.length === 0 ? (
            <div style={{ padding: `${SP[6]} 0`, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>No sector data</div>
          ) : (
            <EBar
              data={sectors.map(s => ({ ...s, book_pct: Number(s.book_pct) }))}
              xKey="sector"
              height={190}
              legend={false}
              xTickSize={9.5}
              valueFmt={(v) => `${Number(v).toFixed(1)}%`}
              axisFmt={(v) => `${v}%`}
              series={[{ key: 'book_pct', name: '% of Book', colorFn: (_, i) => sectorFill(i, sectors.length) }]}
            />
          )}
        </SectionCard>
      </div>

      {/* Concentration table */}
      <SectionCard title="Single-Obligor Concentration" subtitle={`No single borrower to exceed ${limit}% of the active book`} badge={conc.length} style={{ marginBottom: SP[4] }}>
        <DataTable cols={concCols} rows={conc} keyFn={r => r.cif} pageSize={10} emptyText="No obligor data" />
      </SectionCard>

      {/* Watchlist */}
      <SectionCard title="Watchlist" subtitle="Most delinquent loans across the book, worst first" badge={watchlist.length} style={{ marginBottom: live ? SP[4] : 0 }}>
        <DataTable cols={watchCols} rows={watchlist} keyFn={r => r.cif + r.product} onRowClick={r => navigate(`/customers/${encodeURIComponent(r.cif)}`)} pageSize={10} emptyText="Nothing past due" />
      </SectionCard>

      {/* Team review throughput — only when origination is live */}
      {live && review && (
        <SectionCard title="Team Review Queue" subtitle="Origination decisions the team is working">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: SP[3] }}>
            {[
              { label: 'Pending', value: fmtNum(N(review.pending)), accent: N(review.pending) > 0 ? AMBER : GREEN },
              { label: 'Oldest Waiting', value: N(review.oldest_pending_days) > 0 ? `${fmtNum(review.oldest_pending_days)}d` : '—', accent: N(review.oldest_pending_days) >= 3 ? RED : NAVY },
              { label: 'Reviewed Today', value: fmtNum(N(review.reviewed_today)), accent: GREEN },
              { label: 'Approved MTD', value: fmtNum(N(review.approved_mtd)), accent: GREEN },
              { label: 'Declined MTD', value: fmtNum(N(review.declined_mtd)), accent: NAVY },
            ].map(k => (
              <div key={k.label} style={{ padding: '14px 16px', background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg }}>
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>{k.label}</div>
                <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color: k.accent }}>{k.value}</div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}
    </Page>
  )
}
