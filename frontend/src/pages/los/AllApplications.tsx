import { snake } from '../../lib/labels'
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch, apiPut } from '../../lib/api'
import { fmt, fmtDate } from '../../lib/fmt'
import { Spinner, ErrBanner, KpiCard, Page, NAVY, RED, AMBER, GREEN } from '../../components/UI'
import { useAuth } from '../../hooks/useAuth'

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

// ── Stage badge ───────────────────────────────────────────────────
const STAGE_COLORS: Record<string, { bg: string; text: string }> = {
  draft:              { bg: 'rgba(107,114,128,0.12)', text: '#6B7280' },
  submitted:          { bg: 'rgba(37,99,235,0.10)',   text: '#2563EB' },
  document_collection:{ bg: 'rgba(124,58,237,0.10)',  text: '#7C3AED' },
  risk_review:        { bg: 'rgba(217,119,6,0.12)',   text: '#D97706' },
  risk_head_review:   { bg: 'rgba(234,88,12,0.12)',   text: '#EA580C' },
  pending_conditions: { bg: 'rgba(79,70,229,0.10)',   text: '#4F46E5' },
  finance_approval:   { bg: 'rgba(14,165,233,0.10)',  text: '#0EA5E9' },
  booking:            { bg: 'rgba(16,185,129,0.12)',  text: '#10B981' },
  active:             { bg: 'rgba(5,150,105,0.10)',   text: '#059669' },
  declined:           { bg: 'rgba(220,38,38,0.09)',   text: '#DC2626' },
}

function StageBadge({ stage }: { stage: string }) {
  const c = STAGE_COLORS[stage] ?? { bg: 'rgba(14,40,65,0.07)', text: '#475569' }
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap"
      style={{ background: c.bg, color: c.text }}
    >
      {snake(stage)}
    </span>
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

  const [apps, setApps]       = useState<Application[]>([])
  const [stats, setStats]     = useState<LosStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [search, setSearch]   = useState('')
  const [stageF, setStageF]   = useState('')
  const [productF, setProductF] = useState('')
  const [page, setPage]       = useState(0)
  const limit = 50

  // Assign modal state
  const [assignTarget, setAssignTarget] = useState<string | null>(null)
  const [assignUserId, setAssignUserId] = useState('')
  const [assigning, setAssigning]       = useState(false)
  const [assignErr, setAssignErr]       = useState('')

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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <KpiCard label="Submitted" value={String(stats?.submitted ?? '—')} icon="send" accent="#2563EB" loading={loading && !stats} />
        <KpiCard label="Risk Review" value={String(stats?.risk_review ?? '—')} icon="rate_review" accent={AMBER} loading={loading && !stats} />
        <KpiCard label="Finance Approval" value={String(stats?.finance_approval ?? '—')} icon="account_balance" accent="#0EA5E9" loading={loading && !stats} />
        <KpiCard label="Active" value={String(stats?.active ?? '—')} icon="check_circle" accent={GREEN} loading={loading && !stats} />
      </div>

      {/* Filter bar */}
      <div className="bg-white rounded-2xl border border-black/[0.06] p-4 shadow-sm mb-4">
        <div className="flex flex-wrap gap-3 items-center">
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
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-black/[0.06] shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20"><Spinner size={32} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ background: 'rgba(14,40,65,0.04)', borderBottom: '1px solid rgba(15,23,42,0.08)' }}>
                  {['Reference','Applicant','Product','Amount','Stage','Assigned To','Days', ...(isTeamLead ? ['Assign'] : []), 'Actions'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={isTeamLead ? 9 : 8} className="px-4 py-14 text-center text-slate-400 text-[13px]">
                      <span className="material-symbols-rounded text-[36px] block mb-2 text-slate-300">inbox</span>
                      No applications found
                    </td>
                  </tr>
                ) : filtered.map(a => (
                  <tr
                    key={a.id}
                    className="border-b border-slate-100 hover:bg-slate-50/60 cursor-pointer"
                    onClick={() => nav(`/sales/applications/${a.id}`)}
                  >
                    <td className="px-4 py-3 font-mono text-[12px] text-slate-600">{a.reference}</td>
                    <td className="px-4 py-3 font-semibold text-slate-800">{a.applicant_name}</td>
                    <td className="px-4 py-3 text-slate-600 capitalize">{snake(a.product_type ?? '')}</td>
                    <td className="px-4 py-3 font-mono text-slate-700">{fmt(a.amount_requested_kobo / 100)}</td>
                    <td className="px-4 py-3"><StageBadge stage={a.stage} /></td>
                    <td className="px-4 py-3 text-slate-500">{a.assigned_to_name ?? '—'}</td>
                    <td className="px-4 py-3 text-slate-500">{a.days_in_stage ?? '—'}</td>
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
        {/* Pagination */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100">
          <span className="text-[12px] text-slate-400">Page {page + 1}</span>
          <div className="flex gap-2">
            <button
              disabled={page === 0}
              onClick={() => setPage(p => p - 1)}
              className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-slate-700 bg-black/[0.05] hover:bg-black/[0.08] disabled:opacity-40"
            >
              Previous
            </button>
            <button
              disabled={apps.length < limit}
              onClick={() => setPage(p => p + 1)}
              className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-slate-700 bg-black/[0.05] hover:bg-black/[0.08] disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {/* Assign modal */}
      {assignTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-[16px] font-bold text-slate-800">Assign Application</h2>
              <button onClick={() => setAssignTarget(null)} className="text-slate-400 hover:text-slate-700">
                <span className="material-symbols-rounded text-[20px]">close</span>
              </button>
            </div>
            <ErrBanner msg={assignErr} />
            <label className="block text-[12px] font-semibold text-slate-500 mb-1">Assign To</label>
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
