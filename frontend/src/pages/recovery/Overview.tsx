import { snake } from '../../lib/labels'
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { fmt, fmtNum, fmtPct, fmtDate, n, today, monthStart } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, ErrBanner, StatusBadge,
  NAVY, RED, GREEN, AMBER, BLUE,
} from '../../components/UI'

/* ── Types ── */
interface RecoveryKpi {
  active_cases: number
  recovered_mtd_kobo: number
  recovery_rate_pct: number
  legal_cases: number
}

interface RecoveryCase {
  id: string
  case_ref: string
  account_cif: string
  agent_name?: string
  legal_stage?: string
  outstanding_kobo: number
  recovered_kobo: number
  status: string
  opened_at: string
}

/* ── Stage pipeline colours ── */
const STAGE_COLORS: Record<string, string> = {
  pre_legal:       AMBER,
  letter_of_demand: '#EA580C',
  court_filing:    RED,
  hearing:         '#DC2626',
  garnishee:       '#7C3AED',
  judgment:        '#7F1D1D',
  closed:          '#94A3B8',
}

/* ── Quick-link button ── */
function QuickLink({ label, to, icon }: { label: string; to: string; icon: string }) {
  const nav = useNavigate()
  return (
    <button
      onClick={() => nav(to)}
      className="flex items-center gap-2 px-4 py-2.5 rounded-xl border text-[13px] font-semibold transition-all hover:shadow-sm bg-white"
      style={{ borderColor: 'rgba(15,23,42,0.12)', color: NAVY }}>
      <span className="material-symbols-rounded text-[17px]">{icon}</span>
      {label}
    </button>
  )
}

/* ── Case Pipeline (stage breakdown) ── */
function CasePipeline({ cases, loading }: { cases: RecoveryCase[]; loading: boolean }) {
  const stageMap: Record<string, { count: number; outstanding: number }> = {}
  cases.forEach(c => {
    const s = c.legal_stage ?? 'pre_legal'
    if (!stageMap[s]) stageMap[s] = { count: 0, outstanding: 0 }
    stageMap[s].count++
    stageMap[s].outstanding += n(c.outstanding_kobo)
  })
  const stages = Object.entries(stageMap).sort((a, b) => b[1].count - a[1].count)
  const totalCases = stages.reduce((s, [, v]) => s + v.count, 0)

  return (
    <SectionCard title="Case Pipeline" subtitle="Active cases by legal stage">
      <div className="px-5 py-4 space-y-3">
        {loading
          ? Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="h-3 skeleton w-32 rounded" />
                <div className="h-2 skeleton w-full rounded-full" />
              </div>
            ))
          : stages.length === 0
          ? (
            <div className="flex flex-col items-center py-10 gap-2 text-slate-400">
              <span className="material-symbols-rounded text-[36px]">gavel</span>
              <p className="text-[13px]">No case pipeline data</p>
            </div>
          )
          : stages.map(([stage, v], i) => {
              const share = totalCases > 0 ? (v.count / totalCases) * 100 : 0
              const color = STAGE_COLORS[stage] ?? '#94A3B8'
              const label = snake(stage)
              return (
                <div key={i}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                      <span className="text-[12px] font-semibold text-slate-700">{label}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-[11px] text-slate-400">{fmt(v.outstanding / 100)}</span>
                      <span className="kpi-number text-[13px] font-bold text-slate-800">
                        {v.count.toLocaleString()}
                      </span>
                      <span className="text-[11px] text-slate-400 w-8 text-right">{share.toFixed(1)}%</span>
                    </div>
                  </div>
                  <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(15,23,42,0.06)' }}>
                    <div className="h-full rounded-full transition-all duration-700"
                      style={{ width: `${share}%`, background: color }} />
                  </div>
                </div>
              )
            })}
      </div>
    </SectionCard>
  )
}

/* ── Recent Activity (latest 5 cases) ── */
function RecentActivity({ cases, loading }: { cases: RecoveryCase[]; loading: boolean }) {
  const recent = cases.slice(0, 5)
  return (
    <SectionCard title="Recent Activity" subtitle="Latest 5 cases">
      <div>
        {loading
          ? Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-5 py-3"
                style={{ borderTop: i > 0 ? '1px solid rgba(15,23,42,0.05)' : undefined }}>
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 skeleton w-24 rounded" />
                  <div className="h-2.5 skeleton w-40 rounded" />
                </div>
                <div className="h-5 skeleton w-16 rounded" />
              </div>
            ))
          : recent.length === 0
          ? (
            <div className="flex flex-col items-center py-10 gap-2 text-slate-400">
              <span className="material-symbols-rounded text-[36px]">folder_open</span>
              <p className="text-[13px]">No recent cases</p>
            </div>
          )
          : recent.map((c, i) => (
              <div key={c.id} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50 transition-colors"
                style={{ borderTop: i > 0 ? '1px solid rgba(15,23,42,0.05)' : undefined }}>
                <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ background: 'rgba(14,40,65,0.07)' }}>
                  <span className="material-symbols-rounded text-[16px]" style={{ color: NAVY }}>folder</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-slate-800 truncate">
                    {c.case_ref || c.account_cif}
                  </p>
                  <p className="text-[11px] text-slate-400">
                    {fmtDate(c.opened_at)}
                    {c.agent_name ? ` · ${c.agent_name}` : ''}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="kpi-number text-[13px] font-semibold text-slate-800">
                    {fmt(n(c.outstanding_kobo) / 100)}
                  </p>
                  <StatusBadge status={c.status} />
                </div>
              </div>
            ))}
      </div>
    </SectionCard>
  )
}

/* ── Main Page ── */
export default function RecoveryOverview() {
  const [kpis,    setKpis]    = useState<RecoveryKpi | null>(null)
  const [cases,   setCases]   = useState<RecoveryCase[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      // Load cases first — always available
      const casesRes = await apiFetch('/api/recovery-ops/cases?limit=200')
      const caseList: RecoveryCase[] = casesRes.data ?? casesRes ?? []
      setCases(caseList)

      // Try the dashboard endpoint; if absent, compute from cases
      try {
        const kRes = await apiFetch('/api/recovery-ops/dashboard')
        const dv = kRes.data ?? kRes
        // Map dashboard fields: total_open_cases, total_recovered_kobo, pending_write_offs, visits_this_month
        const activeCases   = n(dv.total_open_cases ?? 0)
        const totalRec      = n(dv.total_recovered_kobo ?? 0)
        const totalOut      = n(dv.total_outstanding_kobo ?? 0)
        const totalExp      = totalRec + totalOut
        const recoveryRate  = totalExp > 0 ? (totalRec / totalExp) * 100 : 0
        setKpis({
          active_cases:        activeCases,
          recovered_mtd_kobo:  totalRec,
          recovery_rate_pct:   recoveryRate,
          legal_cases:         n(dv.pending_write_offs ?? 0),
        })
      } catch {
        // Compute KPIs client-side from case list
        const activeCases = caseList.filter(c => c.status !== 'closed').length
        const legalCases  = caseList.filter(c =>
          c.legal_stage && !['pre_legal', 'closed'].includes(c.legal_stage)
        ).length
        const now = new Date()
        const mtdStart = new Date(now.getFullYear(), now.getMonth(), 1)
        const recoveredMtd = caseList
          .filter(c => c.opened_at && new Date(c.opened_at) >= mtdStart)
          .reduce((s, c) => s + n(c.recovered_kobo), 0)
        const totalOutstanding = caseList.reduce((s, c) => s + n(c.outstanding_kobo), 0)
        const totalRecovered   = caseList.reduce((s, c) => s + n(c.recovered_kobo), 0)
        const totalExposure    = totalOutstanding + totalRecovered
        const recoveryRate     = totalExposure > 0 ? (totalRecovered / totalExposure) * 100 : 0

        setKpis({
          active_cases:        activeCases,
          recovered_mtd_kobo:  recoveredMtd,
          recovery_rate_pct:   recoveryRate,
          legal_cases:         legalCases,
        })
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const d = kpis ?? {} as Partial<RecoveryKpi>
  const rateColor = n(d.recovery_rate_pct) >= 70 ? GREEN : n(d.recovery_rate_pct) >= 40 ? AMBER : RED

  return (
    <Page
      dept="Recovery"
      title="Recovery Overview"
      subtitle="Case management and recovery performance">
      <ErrBanner msg={error} />

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label="Active Cases"
          value={fmtNum(d.active_cases)}
          icon="folder_open"
          accent={NAVY}
          loading={loading}
        />
        <KpiCard
          label="Recovered MTD"
          value={fmt(n(d.recovered_mtd_kobo) / 100)}
          icon="payments"
          accent={GREEN}
          loading={loading}
        />
        <KpiCard
          label="Recovery Rate"
          value={fmtPct(d.recovery_rate_pct)}
          icon="trending_up"
          accent={rateColor}
          sub="total recovered / exposure"
          loading={loading}
        />
        <KpiCard
          label="Legal Cases"
          value={fmtNum(d.legal_cases)}
          icon="gavel"
          accent={RED}
          loading={loading}
        />
      </div>

      {/* Case Pipeline + Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">
        <CasePipeline cases={cases} loading={loading} />
        <RecentActivity cases={cases} loading={loading} />
      </div>

      {/* Quick links */}
      <div className="mt-4 flex flex-wrap gap-3">
        <QuickLink label="Case Manager"       to="/recovery/cases"   icon="folder_open" />
        <QuickLink label="Legal Proceedings"  to="/recovery/legal"   icon="gavel" />
        <QuickLink label="Field Visits"       to="/recovery/visits"  icon="directions_car" />
      </div>
    </Page>
  )
}
