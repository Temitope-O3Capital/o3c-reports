import { useState, useEffect, useCallback } from 'react'
import { apiFetch, apiPut } from '../../lib/api'
import { fmt, fmtDate } from '../../lib/fmt'
import {
  Spinner, ErrBanner, StatusBadge, Page, SectionCard, ColDef, DataTable,
  NAVY, RED, GREEN,
} from '../../components/UI'

// ── Types ──────────────────────────────────────────────────────────
interface QueueItem {
  id: string
  account_cif: string
  agent_name: string
  assignment_date: string
  dpd_bucket: string
}

interface PromiseRow {
  _assignmentId: string
  _promiseId: string
  account_cif: string
  agent_name: string
  promise_date: string
  amount_kobo: number
  status: string
}

// The queue endpoint returns assignments; each may carry a `promises` array in
// the full detail response. Since the queue list endpoint doesn't return promises
// directly, we load assignments and their promises by fetching each detail, or
// we rely on whatever the backend exposes. The spec says "fetches the queue then
// shows all promises per assignment" — we use the queue list and assume each row
// may have a `promises` sub-array (backend may embed it), falling back to empty.
interface QueueItemWithPromises extends QueueItem {
  promises?: Array<{
    id: string
    promise_date: string
    amount_kobo: number
    status: string
  }>
}

export default function Promises() {
  const [rows, setRows]       = useState<PromiseRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [statusF, setStatusF] = useState('')

  // action state: id = promise id
  const [acting, setActing]   = useState<Record<string, boolean>>({})
  const [actErr, setActErr]   = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const res = await apiFetch<{ data: QueueItemWithPromises[] } | QueueItemWithPromises[]>(
        '/api/collections-ops/queue?limit=200'
      )
      const items: QueueItemWithPromises[] = Array.isArray(res) ? res : (res.data ?? [])
      const flat: PromiseRow[] = []
      for (const item of items) {
        for (const p of item.promises ?? []) {
          flat.push({
            _assignmentId: item.id,
            _promiseId: p.id,
            account_cif: item.account_cif,
            agent_name: item.agent_name,
            promise_date: p.promise_date,
            amount_kobo: p.amount_kobo,
            status: p.status,
          })
        }
      }
      setRows(flat)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function markHonoured(pid: string) {
    setActing(prev => ({ ...prev, [pid]: true }))
    setActErr(prev => { const next = { ...prev }; delete next[pid]; return next })
    try {
      await apiPut(`/api/collections-ops/promises/${pid}/honour`, {})
      load()
    } catch (e: any) {
      setActErr(prev => ({ ...prev, [pid]: e.message }))
    } finally {
      setActing(prev => { const next = { ...prev }; delete next[pid]; return next })
    }
  }

  async function markBroken(pid: string) {
    setActing(prev => ({ ...prev, [pid]: true }))
    setActErr(prev => { const next = { ...prev }; delete next[pid]; return next })
    try {
      await apiPut(`/api/collections-ops/promises/${pid}/broken`, {})
      load()
    } catch (e: any) {
      setActErr(prev => ({ ...prev, [pid]: e.message }))
    } finally {
      setActing(prev => { const next = { ...prev }; delete next[pid]; return next })
    }
  }

  const todayIso = new Date().toISOString().slice(0, 10)

  const filtered = (statusF ? rows.filter(r => r.status === statusF) : rows)
    .slice()
    .sort((a, b) => (a.promise_date < b.promise_date ? -1 : 1))

  function rowBg(r: PromiseRow): string | undefined {
    if (r.status === 'honoured') return 'rgba(5,150,105,0.05)'
    if (r.status === 'broken') return 'rgba(220,38,38,0.05)'
    if (r.status === 'pending' && r.promise_date < todayIso) return 'rgba(220,38,38,0.07)'
    if (r.status === 'pending' && r.promise_date === todayIso) return 'rgba(245,158,11,0.07)'
    return undefined
  }

  const cols: ColDef<PromiseRow>[] = [
    { key: 'account_cif',   label: 'CIF',     render: r => <span className="font-mono text-[12px] text-slate-500">{r.account_cif}</span> },
    { key: 'agent_name',    label: 'Agent' },
    { key: 'promise_date',  label: 'Promise Date', render: r => {
      const overdue = r.status === 'pending' && r.promise_date < todayIso
      const dueToday = r.status === 'pending' && r.promise_date === todayIso
      return (
        <span className="flex items-center gap-1.5">
          {fmtDate(r.promise_date)}
          {overdue && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(220,38,38,0.1)', color: RED }}>OVERDUE</span>}
          {dueToday && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(245,158,11,0.1)', color: '#D97706' }}>TODAY</span>}
        </span>
      )
    }},
    { key: 'amount_kobo',   label: 'Amount', right: true, render: r => <span className="font-mono font-semibold">{fmt(r.amount_kobo / 100)}</span> },
    { key: 'status',        label: 'Status', render: r => <StatusBadge status={r.status} /> },
    {
      key: '_actions', label: '', sortable: false,
      render: r => {
        if (r.status !== 'pending') return null
        const busy = acting[r._promiseId]
        const err = actErr[r._promiseId]
        return (
          <div>
            <div className="flex items-center gap-1.5">
              <button
                disabled={busy}
                onClick={() => markHonoured(r._promiseId)}
                className="px-2 py-1 rounded text-[11px] font-semibold text-white disabled:opacity-60"
                style={{ background: GREEN }}>
                {busy ? '…' : 'Honour'}
              </button>
              <button
                disabled={busy}
                onClick={() => markBroken(r._promiseId)}
                className="px-2 py-1 rounded text-[11px] font-semibold text-white disabled:opacity-60"
                style={{ background: NAVY }}>
                {busy ? '…' : 'Mark Broken'}
              </button>
            </div>
            {err && <p className="text-[11px] text-red-600 mt-0.5">{err}</p>}
          </div>
        )
      },
    },
  ]

  const counts = {
    pending:  rows.filter(r => r.status === 'pending').length,
    honoured: rows.filter(r => r.status === 'honoured').length,
    broken:   rows.filter(r => r.status === 'broken').length,
  }

  return (
    <Page
      dept="Collections Ops"
      title="Promise-to-Pay Tracker"
      subtitle="Track and action customer payment commitments"
    >
      <ErrBanner msg={error} />

      {/* Summary pills */}
      <div className="flex flex-wrap gap-3 mb-5">
        {([
          ['All', '', rows.length, '#475569', 'rgba(14,40,65,0.06)'],
          ['Pending', 'pending', counts.pending, '#D97706', 'rgba(245,158,11,0.08)'],
          ['Honoured', 'honoured', counts.honoured, GREEN, 'rgba(5,150,105,0.08)'],
          ['Broken', 'broken', counts.broken, RED, 'rgba(220,38,38,0.07)'],
        ] as [string, string, number, string, string][]).map(([label, val, count, color, bg]) => (
          <button key={val}
            onClick={() => setStatusF(val)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-semibold border transition-all"
            style={{
              background: statusF === val ? bg : 'white',
              borderColor: statusF === val ? color : 'rgba(15,23,42,0.1)',
              color: statusF === val ? color : '#64748B',
            }}>
            {label}
            <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full"
              style={{ background: bg, color }}>
              {count}
            </span>
          </button>
        ))}
      </div>

      <SectionCard title="Promises" badge={filtered.length}>
        {loading ? (
          <div className="flex items-center justify-center py-20"><Spinner size={32} /></div>
        ) : (
          <DataTable
            cols={cols}
            rows={filtered}
            rowBg={rowBg}
            emptyIcon="handshake"
            emptyMsg="No promises found"
          />
        )}
      </SectionCard>
    </Page>
  )
}
