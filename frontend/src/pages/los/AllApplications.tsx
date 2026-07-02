import { snake } from '../../lib/labels'
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch, apiPut } from '../../lib/api'
import { fmt, fmtDate } from '../../lib/fmt'
import { Spinner, ErrBanner, KpiCard, Page, Pagination, FilterBar, SectionCard, NAVY, RED, AMBER, GREEN } from '../../components/UI'
import { useAuth } from '../../hooks/useAuth'
import { StageBadge, STAGE_COLORS } from './components'

// ── Types ─────────────────────────────────────────────────────────
interface Application {
  id: string
  reference: string
  applicant_name: string
  product_type: string
  amount_requested_kobo: number
  tenor_months: number
  stage: string
  assigned_to_name?: string
  assigned_to_user_id?: string
  created_at: string
  days_in_stage?: number
}

interface LosStats {
  draft: number
  submitted: number
  risk_review: number
  finance_approval: number
  booking: number
  active: number
  declined: number
}

interface FunnelRow {
  stage: string
  count: number
  pipeline_kobo: number
  avg_days_in_stage: number
}

const FUNNEL_STAGES = [
  'draft','submitted','document_collection','risk_review',
  'risk_head_review','pending_conditions','finance_approval','booking','active',
]

function ConversionFunnel({ rows, loading }: { rows: FunnelRow[]; loading: boolean }) {
  const pipeline = rows.filter(r => FUNNEL_STAGES.includes(r.stage))
  const maxCount = Math.max(...pipeline.map(r => r.count), 1)
  const first = pipeline[0]?.count ?? 0

  return (
    <SectionCard title="Conversion Funnel" subtitle="Applications by pipeline stage">
      {loading ? (
        <div className="px-5 py-8 flex justify-center"><Spinner /></div>
      ) : pipeline.length === 0 ? (
        <p className="px-5 py-8 text-center text-[13px]" style={{ color: 'var(--txt2)' }}>No funnel data</p>
      ) : (
        <div className="px-5 py-4 space-y-2.5">
          {pipeline.map((row, i) => {
            const pct = maxCount > 0 ? (row.count / maxCount) * 100 : 0
            const convRate = first > 0 ? (row.count / first) * 100 : 100
            return (
              <div key={row.stage}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[12px] font-semibold capitalize w-44 truncate" style={{ color: 'var(--txt)' }}>{snake(row.stage)}</span>
                  <div className="flex items-center gap-4 text-[11px]" style={{ color: 'var(--txt2)' }}>
                    <span className="font-mono font-semibold tabular-nums w-8 text-right" style={{ color: 'var(--txt)' }}>{row.count}</span>
                    <span className="tabular-nums w-12 text-right">{convRate.toFixed(0)}%</span>
                    <span className="tabular-nums w-20 text-right font-mono">{fmt(row.pipeline_kobo / 100)}</span>
                    <span className="tabular-nums w-16 text-right">{Number(row.avg_days_in_stage).toFixed(1)}d avg</span>
                  </div>
                </div>
                <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bdr)' }}>
                  <div className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${pct}%`, background: i === 0 ? NAVY : convRate < 40 ? RED : convRate < 70 ? AMBER : GREEN }} />
                </div>
              </div>
            )
          })}
          <div className="flex justify-end gap-4 text-[10px] pt-1" style={{ borderTop: '1px solid var(--bdr)', color: 'var(--txt2)' }}>
            <span className="w-8 text-right">Count</span>
            <span className="w-12 text-right">Conv.</span>
            <span className="w-20 text-right">Pipeline ₦</span>
            <span className="w-16 text-right">Avg days</span>
          </div>
        </div>
      )}
    </SectionCard>
  )
}

const PRODUCT_TYPES = ['prepaid_card', 'credit_card', 'usd_card', 'business_loan', 'personal_loan']
const STAGE_OPTS = Object.keys(STAGE_COLORS)
const TEAM_LEAD_ROLES = [
  'admin', 'management', 'md', 'coo',
  'sales_head', 'risk_head', 'finance_head',
  'cards_ops_head', 'collections_head', 'recovery_head',
  'call_center_head', 'hr_manager', 'compliance_head',
  'internal_control_head', 'it_admin',
  // legacy:
  'head_ops', 'head_sales', 'head_collections',
]

export default function AllApplications() {
  const nav = useNavigate()
  const { user } = useAuth()
  const isTeamLead = TEAM_LEAD_ROLES.includes(user?.role ?? '')

  const [apps, setApps]         = useState<Application[]>([])
  const [stats, setStats]       = useState<LosStats | null>(null)
  const [funnel, setFunnel]     = useState<FunnelRow[]>([])
  const [funnelLoading, setFunnelLoading] = useState(true)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')
  const [search, setSearch]     = useState('')
  const [stageF, setStageF]     = useState('')
  const [productF, setProductF] = useState('')
  const [page, setPage]         = useState(0)
  const limit = 50

  const [hoveredApp, setHoveredApp] = useState<string | null>(null)

  // Assign modal state
  const [assignTarget, setAssignTarget] = useState<string | null>(null)
  const [assignUserId, setAssignUserId] = useState('')
  const [assigning, setAssigning]       = useState(false)
  const [assignErr, setAssignErr]       = useState('')

  // Load funnel once on mount
  useEffect(() => {
    setFunnelLoading(true)
    apiFetch<FunnelRow[]>('/api/los/funnel')
      .then(rows => setFunnel(Array.isArray(rows) ? rows : (rows as any).data ?? []))
      .catch(() => setFunnel([]))
      .finally(() => setFunnelLoading(false))
  }, [])

  // user list for assign dropdown
  const [losUsers, setLosUsers] = useState<{ id: string; full_name: string }[]>([])
  useEffect(() => {
    apiFetch<{ id: string; full_name: string; role: string }[]>('/api/admin/users')
      .then(rows => setLosUsers(rows.filter(u => !u.role?.includes('collection') && !u.role?.includes('recovery'))))
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(page * limit),
        ...(stageF ? { status: stageF } : {}),
      })
      const [rApps, rStats] = await Promise.allSettled([
        apiFetch<{ data: Application[] }>(`/api/los/all?${params}`),
        apiFetch<LosStats>('/api/los/stats'),
      ])
      if (rApps.status === 'fulfilled') setApps(rApps.value.data ?? [])
      if (rStats.status === 'fulfilled') setStats(rStats.value)
      if (rApps.status === 'rejected') setError((rApps as PromiseRejectedResult).reason?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [page, stageF])

  useEffect(() => { load() }, [load])

  const filtered = apps.filter(a => {
    if (productF && a.product_type !== productF) return false
    if (search) {
      const q = search.toLowerCase()
      if (!a.applicant_name?.toLowerCase().includes(q) && !a.reference?.toLowerCase().includes(q)) return false
    }
    return true
  })

  async function doAssign() {
    if (!assignTarget || !assignUserId.trim()) return
    setAssigning(true); setAssignErr('')
    try {
      await apiPut(`/api/los/${assignTarget}/assign`, { assign_to_user_id: assignUserId.trim() })
      setAssignTarget(null); setAssignUserId('')
      load()
    } catch (e: any) {
      setAssignErr(e.message)
    } finally {
      setAssigning(false)
    }
  }

  return (
    <Page
      dept="LOS"
      title="All Applications"
      subtitle="Every application in the system"
      actions={
        <button
          className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white"
          style={{ background: NAVY }}
          onClick={() => nav('/sales/applications/new')}
        >
          <span className="material-symbols-rounded text-[15px] align-middle mr-1">add</span>
          New Application
        </button>
      }
    >
      <ErrBanner msg={error} />

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <KpiCard label="Submitted" value={String(stats?.submitted ?? '—')} icon="send" accent="#2563EB" loading={loading && !stats} />
        <KpiCard label="Risk Review" value={String(stats?.risk_review ?? '—')} icon="rate_review" accent={AMBER} loading={loading && !stats} />
        <KpiCard label="Finance Approval" value={String(stats?.finance_approval ?? '—')} icon="account_balance" accent="#0EA5E9" loading={loading && !stats} />
        <KpiCard label="Active" value={String(stats?.active ?? '—')} icon="check_circle" accent={GREEN} loading={loading && !stats} />
        <KpiCard
          label="Pipeline Value"
          value={funnelLoading ? '—' : fmt(funnel.filter(r => FUNNEL_STAGES.includes(r.stage)).reduce((s, r) => s + r.pipeline_kobo, 0) / 100)}
          sub="Active pipeline ₦"
          icon="account_balance_wallet"
          accent={NAVY}
          loading={funnelLoading}
        />
      </div>

      {/* Conversion funnel */}
      <div className="mb-6">
        <ConversionFunnel rows={funnel} loading={funnelLoading} />
      </div>

      <FilterBar>
        <input
          className="w-full max-w-xs px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
          placeholder="Search name or reference…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          className="px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
          value={stageF}
          onChange={e => { setStageF(e.target.value); setPage(0) }}
        >
          <option value="">All Stages</option>
          {STAGE_OPTS.map(s => <option key={s} value={s}>{snake(s)}</option>)}
        </select>
        <select
          className="px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
          value={productF}
          onChange={e => setProductF(e.target.value)}
        >
          <option value="">All Products</option>
          {PRODUCT_TYPES.map(p => <option key={p} value={p}>{snake(p)}</option>)}
        </select>
        {(search || stageF || productF) && (
          <button
            className="px-3 py-2 rounded-lg text-[13px] font-semibold text-slate-700 bg-black/[0.05] hover:bg-black/[0.08]"
            onClick={() => { setSearch(''); setStageF(''); setProductF(''); setPage(0) }}
          >
            Clear
          </button>
        )}
      </FilterBar>

      {/* Table */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20"><Spinner size={32} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)' }}>
                  {['Reference','Applicant','Product','Amount','Stage','Assigned To','Days', ...(isTeamLead ? ['Assign'] : []), 'Actions'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: 'var(--txt2)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={isTeamLead ? 9 : 8} className="px-4 py-14 text-center text-[13px]" style={{ color: 'var(--txt2)' }}>
                      <span className="material-symbols-rounded text-[36px] block mb-2" style={{ color: 'var(--bdr)' }}>inbox</span>
                      No applications found
                    </td>
                  </tr>
                ) : filtered.map(a => (
                  <tr
                    key={a.id}
                    className="cursor-pointer"
                    onMouseEnter={() => setHoveredApp(a.id)}
                    onMouseLeave={() => setHoveredApp(null)}
                    style={{ borderBottom: '1px solid var(--bdr)', background: hoveredApp === a.id ? 'var(--row-hvr)' : undefined }}
                    onClick={() => nav(`/sales/applications/${a.id}`)}
                  >
                    <td className="px-4 py-3 font-mono text-[12px]" style={{ color: 'var(--txt2)' }}>{a.reference}</td>
                    <td className="px-4 py-3 font-semibold" style={{ color: 'var(--txt)' }}>{a.applicant_name}</td>
                    <td className="px-4 py-3 capitalize" style={{ color: 'var(--txt2)' }}>{snake(a.product_type ?? '')}</td>
                    <td className="px-4 py-3 font-mono" style={{ color: 'var(--txt)' }}>{fmt(a.amount_requested_kobo / 100)}</td>
                    <td className="px-4 py-3"><StageBadge stage={a.stage} /></td>
                    <td className="px-4 py-3" style={{ color: 'var(--txt2)' }}>{a.assigned_to_name ?? '—'}</td>
                    <td className="px-4 py-3" style={{ color: 'var(--txt2)' }}>{a.days_in_stage ?? '—'}</td>
                    {isTeamLead && (
                      <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                        <button
                          className="px-3 py-1 rounded-lg text-[12px] font-semibold text-slate-700 bg-black/[0.05] hover:bg-black/[0.08]"
                          onClick={() => { setAssignTarget(a.id); setAssignUserId(a.assigned_to_user_id ?? '') }}
                        >
                          Assign
                        </button>
                      </td>
                    )}
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      <button
                        className="px-3 py-1 rounded-lg text-[12px] font-semibold text-white"
                        style={{ background: NAVY }}
                        onClick={() => nav(`/sales/applications/${a.id}`)}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} hasMore={apps.length >= limit} onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />
      </div>

      {/* Assign modal */}
      {assignTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="card shadow-xl p-6 w-full max-w-sm">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-[16px] font-bold" style={{ color: 'var(--txt)' }}>Assign Application</h2>
              <button onClick={() => setAssignTarget(null)} style={{ color: 'var(--txt2)' }}>
                <span className="material-symbols-rounded text-[20px]">close</span>
              </button>
            </div>
            <ErrBanner msg={assignErr} />
            <label className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--txt2)' }}>Assign To</label>
            <select
              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20 mb-4"
              value={assignUserId}
              onChange={e => setAssignUserId(e.target.value)}
            >
              <option value="">— Select user —</option>
              {losUsers.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </select>
            <div className="flex gap-2 justify-end">
              <button
                className="px-4 py-2 rounded-lg text-[13px] font-semibold text-slate-700 bg-black/[0.05] hover:bg-black/[0.08]"
                onClick={() => setAssignTarget(null)}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white disabled:opacity-60"
                style={{ background: NAVY }}
                disabled={assigning || !assignUserId.trim()}
                onClick={doAssign}
              >
                {assigning ? 'Assigning…' : 'Assign'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Page>
  )
}
