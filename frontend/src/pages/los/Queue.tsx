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
  const [sortKey, setSortKey]   = useState<string | null>(null)
  const [sortDir, setSortDir]   = useState<'asc' | 'desc'>('asc')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

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

  const toggleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const filtered = apps.filter(a => {
    if (stageF && a.stage !== stageF) return false
    if (productF && a.product_type !== productF) return false
    if (search) {
      const q = search.toLowerCase()
      if (!a.applicant_name?.toLowerCase().includes(q) && !a.reference?.toLowerCase().includes(q)) return false
    }
    return true
  })

  const sorted = [...filtered].sort((a, b) => {
    if (!sortKey) return 0
    const va = (a as any)[sortKey] ?? ''
    const vb = (b as any)[sortKey] ?? ''
    const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))
    return sortDir === 'asc' ? cmp : -cmp
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
          className="w-full max-w-xs px-3 py-2 rounded-lg border border-[var(--bdr)] text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
          placeholder="Search name or reference…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select
          className="px-3 py-2 rounded-lg border border-[var(--bdr)] text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
          value={stageF}
          onChange={e => setStageF(e.target.value)}
        >
          <option value="">All Stages</option>
          {STAGE_OPTS.map(s => <option key={s} value={s}>{snake(s)}</option>)}
        </select>
        <select
          className="px-3 py-2 rounded-lg border border-[var(--bdr)] text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E2841]/20"
          value={productF}
          onChange={e => setProductF(e.target.value)}
        >
          <option value="">All Products</option>
          {PRODUCT_TYPES.map(p => <option key={p} value={p}>{snake(p)}</option>)}
        </select>
        {(search || stageF || productF) && (
          <button
            className="px-3 py-2 rounded-lg text-[13px] font-semibold text-[color:var(--txt)] bg-black/[0.05] hover:bg-black/[0.08]"
            onClick={() => { setSearch(''); setStageF(''); setProductF('') }}
          >
            Clear
          </button>
        )}
      </FilterBar>

      {/* Table */}
      <div className="card overflow-hidden">
        {selectedIds.size > 0 && (
          <div style={{ padding: '10px 14px', background: '#F0F4FF', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#0E2841' }}>{selectedIds.size} selected</span>
            <button style={{ padding: '5px 12px', border: '1px solid var(--bdr)', borderRadius: 7, fontSize: 12, fontWeight: 600, background: '#fff', color: '#0E2841', cursor: 'pointer' }}>Export</button>
            <button onClick={() => setSelectedIds(new Set())} style={{ marginLeft: 'auto', padding: '5px 12px', border: '1px solid var(--bdr)', borderRadius: 7, fontSize: 12, background: 'transparent', color: 'var(--txt2)', cursor: 'pointer' }}>Clear</button>
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-20"><Spinner size={32} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)' }}>
                  <th className="px-4 py-3 w-10">
                    <input type="checkbox" checked={selectedIds.size === sorted.length && sorted.length > 0}
                      onChange={e => setSelectedIds(e.target.checked ? new Set(sorted.map(a => a.id)) : new Set())}
                      style={{ cursor: 'pointer' }} />
                  </th>
                  {([['Reference','reference'],['Applicant','applicant_name'],['Product','product_type'],['Amount','amount_requested_kobo'],['Stage','stage'],['Assigned To','assigned_to_name'],['Days','days_in_stage'],['',null]] as [string, string|null][]).map(([h, k]) => (
                    <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.06em] whitespace-nowrap"
                      style={{ color: sortKey === k ? 'var(--txt)' : 'var(--txt2)', cursor: k ? 'pointer' : undefined }}
                      onClick={k ? () => toggleSort(k) : undefined}>
                      {h}{k && <span style={{ marginLeft: 3, color: '#C00000', opacity: sortKey === k ? 1 : 0.3 }}>{sortKey === k ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-14 text-center text-[color:var(--txt2)] text-[13px]">
                      <span className="material-symbols-rounded text-[36px] block mb-2 text-[color:var(--txt3)]">inbox</span>
                      No applications found
                    </td>
                  </tr>
                ) : sorted.map(a => (
                  <tr
                    key={a.id}
                    className="border-b border-[var(--bdr)] hover:bg-[var(--row-hvr)] cursor-pointer"
                    style={{ background: selectedIds.has(a.id) ? 'var(--row-sel)' : undefined }}
                    onClick={() => nav(`/los/${a.id}`)}
                  >
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={selectedIds.has(a.id)}
                        onChange={() => setSelectedIds(s => { const n = new Set(s); n.has(a.id) ? n.delete(a.id) : n.add(a.id); return n })}
                        style={{ cursor: 'pointer' }} />
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px] text-[color:var(--txt2)]">{a.reference}</td>
                    <td className="px-4 py-3 font-semibold text-[color:var(--txt)]">{a.applicant_name}</td>
                    <td className="px-4 py-3 text-[color:var(--txt2)] capitalize">{snake(a.product_type ?? '')}</td>
                    <td className="px-4 py-3 font-mono text-[color:var(--txt)]">{fmt(a.amount_requested_kobo / 100)}</td>
                    <td className="px-4 py-3"><StageBadge stage={a.stage} /></td>
                    <td className="px-4 py-3 text-[color:var(--txt2)]">{a.assigned_to_name ?? '—'}</td>
                    <td className="px-4 py-3 text-[color:var(--txt2)]">{a.days_in_stage ?? '—'}</td>
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
