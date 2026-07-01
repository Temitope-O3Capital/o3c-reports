import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import { fmt, fmtNum, fmtPct, n } from '../lib/fmt'
import {
  Page, KpiCard, SectionCard, AreaChartCard, BarChartCard, DonutCard,
  ProgressList, ErrBanner, ChangeBadge, NAVY, RED, GREEN, AMBER, BLUE,
} from '../components/UI'

/* ── Data source badge ──────────────────────────────────────────── */
function SourceBadge({ source }: { source: string }) {
  const live = source === 'mssql_live'
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium border"
      style={{
        background:  live ? 'rgba(5,150,105,0.05)' : 'rgba(245,158,11,0.05)',
        borderColor: live ? 'rgba(5,150,105,0.2)'  : 'rgba(245,158,11,0.2)',
        color:       live ? '#059669'               : '#D97706',
      }}>
      <span className="relative flex items-center w-2 h-2">
        <span className="w-1.5 h-1.5 rounded-full block flex-shrink-0"
          style={{ background: live ? '#10B981' : '#F59E0B' }} />
        {live && <span className="w-1.5 h-1.5 rounded-full block absolute animate-ping opacity-50"
          style={{ background: '#10B981' }} />}
      </span>
      {live ? 'Live · MSSQL' : 'Snapshot · PG'}
    </span>
  )
}

/* ── Normalise row keys (MSSQL uses underscores, PG uses spaces) ── */
function rk(row: Record<string, any>, ...candidates: string[]): any {
  for (const k of candidates) if (row[k] != null) return row[k]
  return null
}

export default function Overview() {
  const [kpis,        setKpis]        = useState<Record<string, any> | null>(null)
  const [execKpis,    setExecKpis]    = useState<Record<string, any> | null>(null)
  const [loanKpis,    setLoanKpis]    = useState<Record<string, any> | null>(null)
  const [volume,      setVolume]      = useState<any[]>([])
  const [newAccounts, setNewAccounts] = useState<any[]>([])
  const [byProduct,   setByProduct]   = useState<any[]>([])
  const [byType,      setByType]      = useState<any[]>([])
  const [source,      setSource]      = useState('supabase_snapshot')
  const [dataAsOf,    setDataAsOf]    = useState<string | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [err,         setErr]         = useState('')

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true); setErr('')
      try {
        const [rKpis, rVol, rNa, rBp, rBt, rExec, rLoan] = await Promise.allSettled([
          apiFetch('/api/overview/kpis'),
          apiFetch('/api/overview/monthly-volume'),
          apiFetch('/api/overview/new-accounts-trend'),
          apiFetch('/api/overview/cards-by-product'),
          apiFetch('/api/overview/txn-by-type'),
          apiFetch('/api/executive/summary?period=month'),
          apiFetch('/api/kpi/kpis'),
        ])
        if (cancelled) return
        if (rKpis.status === 'fulfilled') {
          setKpis(rKpis.value.data)
          setSource(rKpis.value.data_source ?? 'supabase_snapshot')
          if (rKpis.value.data_as_of) setDataAsOf(rKpis.value.data_as_of)
        }
        if (rExec.status === 'fulfilled') setExecKpis(rExec.value)
        if (rLoan.status === 'fulfilled') setLoanKpis(rLoan.value.data ?? rLoan.value)
        if (rVol.status === 'fulfilled') setVolume(Array.isArray(rVol.value.data) ? rVol.value.data : [])
        if (rNa.status === 'fulfilled') setNewAccounts(Array.isArray(rNa.value.data) ? rNa.value.data : [])
        if (rBp.status === 'fulfilled') {
          setByProduct((Array.isArray(rBp.value.data) ? rBp.value.data : []).map((r: any) => ({
            name:  rk(r, 'Product_Name', 'Product Name') ?? 'Unknown',
            count: n(rk(r, 'count')),
          })))
        }
        if (rBt.status === 'fulfilled') {
          setByType((Array.isArray(rBt.value.data) ? rBt.value.data : []).map((r: any) => ({
            label:  rk(r, 'Description', 'description') ?? 'Other',
            count:  n(rk(r, 'count')),
            volume: n(rk(r, 'volume')),
          })))
        }
        if ([rKpis, rVol, rNa, rBp, rBt].every(r => r.status === 'rejected')) {
          if (!cancelled) setErr((rKpis as PromiseRejectedResult).reason?.message ?? 'Failed to load data')
        }
      } catch (e: any) {
        if (!cancelled) setErr(e.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [])

  const kpi = (k: string) => (kpis ? n(kpis[k]) : 0)
  const ek = execKpis ?? {}
  const lk = loanKpis ?? {}
  const nplPct = n(lk.npl_ratio_bps) / 100

  // Period change helpers from executive summary
  function execChange(curr: number, prev: number): number | null {
    if (!prev) return null
    return Math.round((curr - prev) / prev * 100)
  }

  return (
    <Page
      title="Executive Dashboard"
      subtitle={`Portfolio snapshot · updated ${dataAsOf ? new Date(dataAsOf).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' }) : '—'}`}
      actions={!loading && kpis ? <SourceBadge source={source} /> : undefined}>

      <ErrBanner msg={err} />

      {/* ── Row 1: Loan portfolio ops ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
        <KpiCard loading={loading} label="Net Portfolio"
          value={fmt(n(lk.total_outstanding_kobo) / 100)}
          sub="Active loans"
          icon="account_balance_wallet" accent={NAVY} />
        <KpiCard loading={loading} label="NPL Ratio"
          value={lk.npl_ratio_bps != null ? `${nplPct.toFixed(2)}%` : '—'}
          sub="Non-performing loans"
          icon="trending_down"
          accent={nplPct > 5 ? RED : nplPct > 2 ? AMBER : GREEN} />
        <KpiCard loading={loading} label="Disbursements MTD"
          value={fmt(n(lk.new_disbursements_kobo) / 100)}
          sub="New loans this month"
          icon="payments" accent={BLUE} />
        <KpiCard loading={loading} label="Repayments MTD"
          value={fmt(n(lk.repayments_kobo) / 100)}
          sub="Collections this month"
          icon="price_check" accent={GREEN} />
      </div>

      {/* ── Row 2: Operations ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <KpiCard loading={loading} label="Collections MTD"
          value={fmt(n(ek.collections_curr))}
          sub="vs prev period"
          icon="savings" accent={GREEN}
          change={execChange(n(ek.collections_curr), n(ek.collections_prev))}
          changePeriod="MoM" />
        <KpiCard loading={loading} label="Recovery MTD"
          value={fmt(n(ek.recovery_curr))}
          sub="vs prev period"
          icon="restore" accent={AMBER}
          change={execChange(n(ek.recovery_curr), n(ek.recovery_prev))}
          changePeriod="MoM" />
        <KpiCard loading={loading} label="New Accounts MTD"
          value={fmtNum(n(ek.new_accounts_curr))}
          sub="vs prev period"
          icon="person_add" accent={NAVY}
          change={execChange(n(ek.new_accounts_curr), n(ek.new_accounts_prev))}
          changePeriod="MoM" />
        <KpiCard loading={loading} label="Txn Volume MTD"
          value={fmt(n(ek.txn_volume_curr))}
          sub="vs prev period"
          icon="swap_vert" accent={BLUE}
          change={execChange(n(ek.txn_volume_curr), n(ek.txn_volume_prev))}
          changePeriod="MoM" />
      </div>

      {/* ── Card portfolio KPIs ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
        <KpiCard loading={loading} label="Total Cardholders"   value={fmtNum(kpi('total_cardholders'))}  sub="All-time"   icon="group"           accent={NAVY}  />
        <KpiCard loading={loading} label="Active Accounts"     value={fmtNum(kpi('active_accounts'))}    sub="Live"       icon="credit_card"     accent={BLUE}  />
        <KpiCard loading={loading} label="Cards Issued"        value={fmtNum(kpi('total_cards_issued'))} sub="All-time"   icon="style"           accent={NAVY}  />
        <KpiCard loading={loading} label="Total Txn Volume"    value={fmt(kpi('total_txn_volume'))}      sub="All-time"   icon="swap_vert"       accent={GREEN} />
        <KpiCard loading={loading} label="New Accounts MTD"    value={fmtNum(kpi('new_accounts_mtd'))}   sub="This month" icon="person_add"      accent={AMBER} />
        <KpiCard loading={loading} label="Collections MTD"     value={fmt(kpi('collections_mtd'))}       sub="This month" icon="payments"        accent={RED}   />
      </div>

      {/* ── Charts row 1: Volume + New Accounts ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <AreaChartCard
          title="Monthly Transaction Volume"
          subtitle="Total transaction value by month"
          data={volume}
          xKey="month"
          areaKey="volume"
          color={NAVY}
          currency
          height={200}
          loading={loading}
        />
        <AreaChartCard
          title="New Account Signups"
          subtitle="New cardholders registered per month"
          data={newAccounts}
          xKey="month"
          areaKey="new_accounts"
          color={GREEN}
          height={200}
          loading={loading}
        />
      </div>

      {/* ── Charts row 2: Products + Transaction Types ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <DonutCard
          title="Cards by Product"
          subtitle="Active card portfolio breakdown"
          data={byProduct}
          nameKey="name"
          valueKey="count"
          loading={loading}
        />
        <BarChartCard
          title="Top Transaction Types"
          subtitle="Transaction count by description"
          data={byType.slice(0, 8)}
          xKey="label"
          barKey="count"
          color={BLUE}
          height={200}
          loading={loading}
        />
      </div>

      {/* ── Bottom row: Summary stats ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SectionCard title="Recovery Summary">
          <div className="p-5 space-y-4">
            {[
              { label: 'Total Collected (all-time)', value: fmt(kpi('total_collected')),  accent: GREEN },
              { label: 'Total Recovered (all-time)', value: fmt(kpi('total_recovered')),  accent: AMBER },
              { label: 'Recovery Rate',               value: `${n(kpis?.recovery_rate ?? 0).toFixed(1)}%`, accent: kpi('recovery_rate') >= 50 ? GREEN : RED },
            ].map(({ label, value, accent }) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-[13px] text-slate-500">{label}</span>
                <span className="text-[14px] font-semibold font-mono" style={{ color: accent }}>{loading ? '—' : value}</span>
              </div>
            ))}
          </div>
        </SectionCard>

        <ProgressList
          title="Transaction Volume by Type"
          subtitle="Top types by total ₦ volume"
          data={byType.slice(0, 6)}
          nameKey="label"
          valueKey="volume"
          currency
          loading={loading}
        />

        <SectionCard title="Account Counts">
          <div className="p-5 space-y-4">
            {[
              { label: 'Total CIF Records',  value: fmtNum(kpi('total_cardholders')),  icon: 'people',        accent: NAVY },
              { label: 'Active Products',     value: fmtNum(kpi('active_accounts')),    icon: 'check_circle',  accent: GREEN },
              { label: 'Cards Issued (total)',value: fmtNum(kpi('total_cards_issued')), icon: 'style',         accent: BLUE },
              { label: 'New MTD',             value: fmtNum(kpi('new_accounts_mtd')),   icon: 'person_add',    accent: AMBER },
            ].map(({ label, value, icon, accent }) => (
              <div key={label} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-rounded text-[15px]" style={{ color: accent }}>{icon}</span>
                  <span className="text-[13px] text-slate-500">{label}</span>
                </div>
                <span className="text-[13px] font-semibold font-mono text-slate-800">{loading ? '—' : value}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>
    </Page>
  )
}
