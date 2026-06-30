import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPut } from '../../lib/api'
import { fmt, fmtNum, fmtPct, fmtDate, n, today, monthStart } from '../../lib/fmt'
import {
  Page, KpiCard, SectionCard, AreaChartCard, BarChartCard,
  ErrBanner, NAVY, RED, GREEN, AMBER, BLUE,
} from '../../components/UI'
import { useAuth } from '../../hooks/useAuth'

/* ── Severity style map ─────────────────────────────────────────── */
const SEV_STYLE: Record<string, { bg: string; text: string; icon: string }> = {
  critical: { bg: 'rgba(220,38,38,0.08)',  text: '#DC2626', icon: 'emergency' },
  warning:  { bg: 'rgba(217,119,6,0.08)',  text: '#D97706', icon: 'warning'   },
  info:     { bg: 'rgba(37,99,235,0.08)',  text: '#2563EB', icon: 'info'      },
}

/* ── Roles that can resolve alerts ─────────────────────────────── */
const ALERT_RESOLVERS = new Set(['md', 'coo', 'head_it', 'admin', 'compliance_head', 'internal_control_head'])

/* ── Role-aware KPI card sets ───────────────────────────────────── */
const BASE_KPI_KEYS = ['open_los', 'portfolio_outstanding', 'collections_today', 'open_alerts']

const ROLE_EXTRA_KEYS: Record<string, string[]> = {
  collections_head:  ['contacts_today', 'ptps_today', 'collection_rate_pct'],
  collections_agent: ['contacts_today', 'ptps_today', 'collection_rate_pct'],
  md:                ['npl_ratio_pct', 'par30_pct', 'writeoff_pending'],
  cfo:               ['npl_ratio_pct', 'par30_pct', 'writeoff_pending'],
  coo:               ['npl_ratio_pct', 'par30_pct', 'writeoff_pending'],
  compliance_head:   ['open_findings', 'overdue_checklists', 'pending_sars'],
  compliance_officer:['open_findings', 'overdue_checklists', 'pending_sars'],
  hr_manager:        ['on_leave_today', 'pending_leave_approvals', 'open_disciplinary'],
  hr_officer:        ['on_leave_today', 'pending_leave_approvals', 'open_disciplinary'],
}

interface KpiCardSpec {
  key: string
  label: string
  icon: string
  accent: string
  format: (v: any) => string
}

const KPI_SPECS: Record<string, KpiCardSpec> = {
  open_los:               { key: 'open_los',               label: 'Open LOS Applications',   icon: 'folder_open',      accent: NAVY,  format: fmtNum },
  portfolio_outstanding:  { key: 'portfolio_outstanding',  label: 'Portfolio Outstanding',   icon: 'account_balance',  accent: BLUE,  format: v => fmt(n(v) / 100) },
  collections_today:      { key: 'collections_today',      label: "Today's Collections",     icon: 'payments',         accent: GREEN, format: v => fmt(n(v) / 100) },
  open_alerts:            { key: 'open_alerts',            label: 'Active Alerts',           icon: 'notifications',    accent: RED,   format: fmtNum },
  contacts_today:         { key: 'contacts_today',         label: 'Contacts Made Today',     icon: 'call',             accent: NAVY,  format: fmtNum },
  ptps_today:             { key: 'ptps_today',             label: 'PTPs Today',              icon: 'handshake',        accent: AMBER, format: fmtNum },
  collection_rate_pct:    { key: 'collection_rate_pct',    label: 'Collection Rate',         icon: 'percent',          accent: GREEN, format: v => fmtPct(v) },
  npl_ratio_pct:          { key: 'npl_ratio_pct',          label: 'NPL Ratio',               icon: 'trending_down',    accent: RED,   format: v => fmtPct(v) },
  par30_pct:              { key: 'par30_pct',              label: 'PAR30',                   icon: 'warning',          accent: AMBER, format: v => fmtPct(v) },
  writeoff_pending:       { key: 'writeoff_pending',       label: 'Write-off Pending',       icon: 'delete_sweep',     accent: '#7C3AED', format: fmtNum },
  open_findings:          { key: 'open_findings',          label: 'Open Findings',           icon: 'policy',           accent: RED,   format: fmtNum },
  overdue_checklists:     { key: 'overdue_checklists',     label: 'Overdue Checklists',      icon: 'checklist',        accent: AMBER, format: fmtNum },
  pending_sars:           { key: 'pending_sars',           label: 'Pending SARs',            icon: 'gavel',            accent: '#7C3AED', format: fmtNum },
  on_leave_today:         { key: 'on_leave_today',         label: 'On Leave Today',          icon: 'beach_access',     accent: AMBER, format: fmtNum },
  pending_leave_approvals:{ key: 'pending_leave_approvals',label: 'Pending Leave Approvals', icon: 'pending_actions',  accent: NAVY,  format: fmtNum },
  open_disciplinary:      { key: 'open_disciplinary',      label: 'Open Disciplinary Cases', icon: 'report',           accent: RED,   format: fmtNum },
}

/* ── Component ──────────────────────────────────────────────────── */
export default function KpiDashboard() {
  const { user } = useAuth()
  const role = user?.role ?? ''

  const [dash,     setDash]     = useState<any>(null)
  const [trend,    setTrend]    = useState<any[]>([])
  const [colData,  setColData]  = useState<any>(null)
  const [alerts,   setAlerts]   = useState<any[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')
  const [resolving, setResolving] = useState<number | null>(null)
  const [lastUpdated, setLastUpdated] = useState<string>('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [rD, rT, rC, rA] = await Promise.allSettled([
        apiFetch('/api/kpi/dashboard'),
        apiFetch('/api/kpi/portfolio/trend'),
        apiFetch('/api/kpi/collections'),
        apiFetch('/api/kpi/alerts'),
      ])
      if (rD.status === 'fulfilled') setDash(rD.value.data ?? rD.value)
      if (rT.status === 'fulfilled') setTrend(rT.value.data ?? rT.value ?? [])
      if (rC.status === 'fulfilled') setColData(rC.value.data ?? rC.value)
      if (rA.status === 'fulfilled') setAlerts((rA.value.data ?? rA.value ?? []).filter((x: any) => !x.is_resolved))
      setLastUpdated(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))
      if ([rD, rT, rC, rA].every(r => r.status === 'rejected')) setError((rD as PromiseRejectedResult).reason?.message ?? 'Failed to load')
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function resolveAlert(id: number) {
    setResolving(id)
    try {
      await apiPut(`/api/kpi/alerts/${id}/resolve`, {})
      setAlerts(prev => prev.filter(a => a.id !== id))
    } catch (e: any) { setError(e.message) }
    finally { setResolving(null) }
  }

  /* KPI keys for this role */
  const kpiKeys = [...BASE_KPI_KEYS, ...(ROLE_EXTRA_KEYS[role] ?? [])]
  const d = dash || {}

  /* Collections daily chart — map daily array from colData */
  const dailyCollections = (colData?.daily ?? []).map((x: any) => ({
    date: x.date ? x.date.slice(5) : x.label ?? '',
    amount: n(x.amount_collected_kobo) / 100,
  }))

  /* Portfolio trend — convert kobo */
  const portfolioTrend = trend.map((x: any) => ({
    date: x.snapshot_date ? x.snapshot_date.slice(5) : '',
    outstanding: n(x.total_outstanding_kobo) / 100,
    npl: n(x.npl_ratio_bps) / 100,
  }))

  const showNplTrend   = ['md', 'cfo', 'coo'].includes(role)
  const canResolve     = ALERT_RESOLVERS.has(role)

  return (
    <Page
      dept="KPI"
      title="KPI Dashboard"
      subtitle={lastUpdated ? `Last updated ${lastUpdated}` : undefined}
    >
      <ErrBanner msg={error} />

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        {kpiKeys.slice(0, 8).map(key => {
          const spec = KPI_SPECS[key]
          if (!spec) return null
          const raw = d[spec.key]
          return (
            <KpiCard
              key={key}
              loading={loading}
              label={spec.label}
              value={raw != null ? spec.format(raw) : '—'}
              icon={spec.icon}
              accent={spec.accent}
            />
          )
        })}
      </div>

      {/* ── Charts Row ── */}
      <div className={`grid gap-4 mb-5 ${showNplTrend ? 'grid-cols-1 lg:grid-cols-3' : 'grid-cols-1 lg:grid-cols-2'}`}>
        <div className={showNplTrend ? 'lg:col-span-1' : 'lg:col-span-1'}>
          <AreaChartCard
            title="Portfolio Outstanding"
            subtitle="30-day trend"
            data={portfolioTrend}
            xKey="date"
            areaKey="outstanding"
            color={NAVY}
            currency
            height={220}
            loading={loading}
          />
        </div>

        {showNplTrend && (
          <AreaChartCard
            title="NPL Ratio"
            subtitle="30-day trend (%)"
            data={portfolioTrend}
            xKey="date"
            areaKey="npl"
            color={RED}
            height={220}
            loading={loading}
          />
        )}

        <BarChartCard
          title="Daily Collections"
          subtitle={`${monthStart()} – ${today()}`}
          data={dailyCollections}
          xKey="date"
          barKey="amount"
          color={GREEN}
          currency
          height={220}
          loading={loading}
        />
      </div>

      {/* ── Active Alerts ── */}
      <SectionCard
        title="Active Alerts"
        badge={alerts.length}
        subtitle="Unresolved system and risk alerts"
      >
        {loading ? (
          <div className="px-5 py-4 space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-14 skeleton rounded-xl" />
            ))}
          </div>
        ) : alerts.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <span className="material-symbols-rounded text-[36px] text-slate-300 block mb-2">check_circle</span>
            <p className="text-[13px] text-slate-400">No active alerts</p>
          </div>
        ) : (
          <div className="px-5 py-4 space-y-2.5">
            {alerts.map(alert => {
              const sev = (alert.severity || 'info').toLowerCase()
              const style = SEV_STYLE[sev] ?? SEV_STYLE.info
              return (
                <div key={alert.id} className="flex items-start gap-3 px-4 py-3 rounded-xl"
                  style={{ background: style.bg, border: `1px solid ${style.text}22` }}>
                  <span className="material-symbols-rounded text-[18px] flex-shrink-0 mt-0.5"
                    style={{ color: style.text }}>
                    {style.icon}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-[13px] font-semibold" style={{ color: style.text }}>
                        {alert.rule_name}
                      </p>
                      <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded capitalize"
                        style={{ background: `${style.text}18`, color: style.text }}>
                        {sev}
                      </span>
                    </div>
                    <p className="text-[12px] text-slate-600 mt-0.5">{alert.details}</p>
                    <p className="text-[11px] text-slate-400 mt-1">{fmtDate(alert.triggered_at)}</p>
                  </div>
                  {canResolve && (
                    <button
                      onClick={() => resolveAlert(alert.id)}
                      disabled={resolving === alert.id}
                      className="flex-shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-60"
                      style={{ background: `${style.text}15`, color: style.text }}>
                      {resolving === alert.id ? 'Resolving…' : 'Resolve'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </SectionCard>
    </Page>
  )
}
