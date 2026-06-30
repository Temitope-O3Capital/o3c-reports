import { snake } from '../../lib/labels'
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { fmt, fmtDate } from '../../lib/fmt'
import { Spinner, ErrBanner, KpiCard, Page, FilterBar, NAVY, RED, AMBER, GREEN } from '../../components/UI'
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
  created_at: string
  days_in_stage?: number
}

interface QueueStats {
  total_mine: number
  submitted: number
  in_review: number
  pending_conditions: number
}

const PRODUCT_TYPES = ['prepaid_card', 'credit_card', 'usd_card', 'business_loan', 'personal_loan']
const STAGE_OPTS = Object.keys(STAGE_COLORS)

export default function Queue() {
  const nav = useNavigate()
  const [apps, setApps]       = useState<Application[]>([])
  const [stats, setStats]     = useState<QueueStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [search, setSearch]   = useState('')
  const [stageF, setStageF]   = useState('')
  const [productF, setProductF] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [rQ, rS] = await Promise.allSettled([
        apiFetch<{ data: Application[] }>('/api/los/queue'),
        apiFetch<QueueStats>('/api/los/stats'),
      ])
      if (rQ.status === 'fulfilled') setApps(rQ.value.data ?? [])
      if (rS.status === 'fulfilled') setStats(rS.value)
      if (rQ.status === 'rejected') setError((rQ as PromiseRejectedResult).reason?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = apps.filter(a => {
    if (stageF && a.stage !== stageF) return false
    if (productF && a.product_type !== productF) return false
    if (search) {
      const q = search.toLowerCase()
      if (!a.applicant_name?.toLowerCase().includes(q) && !a.reference?.toLowerCase().includes(q)) return false
    }
    return true
  })

  return (
    <Page
      dept="LOS"
      title="My Queue"
      subtitle="Applications assigned to you"
      actions={
        <button
          className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white"
          style={{ background: NAVY }}
          onClick={() => nav('/los/new')}
        >
          <span className="material-symbols-rounded text-[15px] align-middle mr-1">add</span>
          New Application
        </button>
      }
    >
      <ErrBanner msg={error} />

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <KpiCard label="My Total" value={String(stats?.total_mine ?? '—')} icon="inbox" loading={loading && !stats} />
        <KpiCard label="Submitted" value={String(stats?.submitted ?? '—')} icon="send" accent="#2563EB" loading={loading && !stats} />
        <KpiCard label="In Review" value={String(stats?.in_review ?? '—')} icon="rate_review" accent={AMBER} loading={loading && !stats} />
        <KpiCard label="Pending Conditions" value={String(stats?.pending_conditions ?? '—')} icon="pending_actions" accent="#4F46E5" loading={loading && !stats} />
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
          onChange={e => setStageF(e.target.value)}
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
            onClick={() => { setSearch(''); setStageF(''); setProductF('') }}
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
                <tr style={{ background: 'rgba(14,40,65,0.04)', borderBottom: '1px solid rgba(15,23,42,0.08)' }}>
                  {['Reference','Applicant','Product','Amount','Stage','Assigned To','Days','Actions'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-400">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-14 text-center text-slate-400 text-[13px]">
                      <span className="material-symbols-rounded text-[36px] block mb-2 text-slate-300">inbox</span>
                      No applications found
                    </td>
                  </tr>
                ) : filtered.map(a => (
                  <tr
                    key={a.id}
                    className="border-b border-slate-100 hover:bg-slate-50/60 cursor-pointer"
                    onClick={() => nav(`/los/${a.id}`)}
                  >
                    <td className="px-4 py-3 font-mono text-[12px] text-slate-600">{a.reference}</td>
                    <td className="px-4 py-3 font-semibold text-slate-800">{a.applicant_name}</td>
                    <td className="px-4 py-3 text-slate-600 capitalize">{snake(a.product_type ?? '')}</td>
                    <td className="px-4 py-3 font-mono text-slate-700">{fmt(a.amount_requested_kobo / 100)}</td>
                    <td className="px-4 py-3"><StageBadge stage={a.stage} /></td>
                    <td className="px-4 py-3 text-slate-500">{a.assigned_to_name ?? '—'}</td>
                    <td className="px-4 py-3 text-slate-500">{a.days_in_stage ?? '—'}</td>
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      <button
                        className="px-3 py-1 rounded-lg text-[12px] font-semibold text-white"
                        style={{ background: NAVY }}
                        onClick={() => nav(`/los/${a.id}`)}
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
      </div>
    </Page>
  )
}
