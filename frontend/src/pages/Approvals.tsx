import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, ErrBanner, KpiCard } from '../components/UI'
import type { TableCol } from '../components/UI'
import { apiFetch } from '../lib/api'
import { fmtKobo, fmtNum } from '../lib/fmt'
import { NAVY, RED, AMBER, GREEN, BLUE, PURPLE, NUM } from '../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ApprovalItem {
  module:       string
  item_id:      number
  reference:    string
  title:        string
  description:  string
  stage:        string
  amount_kobo?: number
  requested_by: string
  waiting_days: number
  priority:     string
}

interface Summary {
  los:        number
  write_offs: number
  leave:      number
  compliance: number
  total:      number
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const MODULE_COLOR: Record<string, string> = {
  LOS:        BLUE,
  'Write-off': RED,
  Leave:      PURPLE,
  Compliance: AMBER,
}

const PRIORITY_COLOR: Record<string, string> = {
  high:   RED,
  medium: AMBER,
  normal: '#6B7280',
}

function ModulePill({ module }: { module: string }) {
  const c = MODULE_COLOR[module] ?? NAVY
  return (
    <span style={{ ...NUM, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: `${c}14`, color: c }}>
      {module}
    </span>
  )
}

function PriorityDot({ priority }: { priority: string }) {
  const c = PRIORITY_COLOR[priority] ?? '#6B7280'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: c, fontWeight: 600 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: c, flexShrink: 0 }} />
      {priority.charAt(0).toUpperCase() + priority.slice(1)}
    </span>
  )
}

const MODULE_ROUTES: Record<string, (id: number) => string> = {
  LOS:        id => `/los/applications/${id}`,
  'Write-off': id => `/recovery/write-offs/${id}`,
  Leave:      id => `/hr/leaves/${id}`,
  Compliance: id => `/compliance/findings/${id}`,
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Approvals() {
  const navigate = useNavigate()

  const [items, setItems]     = useState<ApprovalItem[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)
  const [moduleFilter, setModuleFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchBusy, setBatchBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [pending, summ] = await Promise.all([
        apiFetch<ApprovalItem[]>('/api/approvals/pending'),
        apiFetch<Summary>('/api/approvals/summary'),
      ])
      setItems(Array.isArray(pending) ? pending : [])
      setSummary(summ)
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = moduleFilter
    ? items.filter(i => i.module === moduleFilter)
    : items

  const modules = Array.from(new Set(items.map(i => i.module)))

  function rowKey(r: ApprovalItem) { return `${r.module}:${r.item_id}` }

  function toggleRow(r: ApprovalItem) {
    const k = rowKey(r)
    setSelected(prev => { const s = new Set(prev); s.has(k) ? s.delete(k) : s.add(k); return s })
  }

  function toggleAll() {
    if (selected.size === filtered.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(filtered.map(rowKey)))
    }
  }

  async function runBatch(action: 'approve' | 'reject') {
    const payload = filtered
      .filter(r => selected.has(rowKey(r)))
      .map(r => ({ module: r.module, item_id: r.item_id }))
    if (!payload.length) return
    setBatchBusy(true)
    try {
      const token = localStorage.getItem('token') ?? ''
      await fetch('/api/approvals/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action, notes: '', items: payload }),
      })
      setSelected(new Set())
      load()
    } catch (e: any) { setErr(e.message) }
    finally { setBatchBusy(false) }
  }

  const allSelected = filtered.length > 0 && selected.size === filtered.length

  const cols: TableCol<ApprovalItem>[] = [
    {
      key: 'module', label: (
        <input type="checkbox" checked={allSelected} onChange={toggleAll}
          style={{ cursor: 'pointer', width: 15, height: 15 }} />
      ) as any,
      render: r => (
        <input type="checkbox" checked={selected.has(rowKey(r))}
          onChange={() => toggleRow(r)}
          onClick={e => e.stopPropagation()}
          style={{ cursor: 'pointer', width: 15, height: 15 }} />
      ),
    },
    {
      key: 'module', label: 'Module',
      render: r => <ModulePill module={r.module} />,
    },
    {
      key: 'reference', label: 'Reference',
      render: r => <span style={{ ...NUM, fontSize: 12, fontWeight: 700, color: NAVY }}>{r.reference}</span>,
    },
    {
      key: 'title', label: 'Item',
      render: r => (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.title}</div>
          <div style={{ fontSize: 11.5, color: 'var(--txt3)' }}>{r.description}</div>
        </div>
      ),
    },
    {
      key: 'requested_by', label: 'Requested By',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.requested_by}</span>,
    },
    {
      key: 'amount_kobo', label: 'Amount', align: 'right',
      render: r => r.amount_kobo != null
        ? <span style={{ ...NUM, fontSize: 12.5, fontWeight: 700, color: NAVY }}>{fmtKobo(r.amount_kobo)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'waiting_days', label: 'Waiting', align: 'right',
      render: r => (
        <span style={{ ...NUM, fontSize: 12.5, color: r.waiting_days > 2 ? RED : 'var(--txt2)' }}>
          {fmtNum(r.waiting_days)}d
        </span>
      ),
    },
    {
      key: 'priority', label: 'Priority',
      render: r => <PriorityDot priority={r.priority} />,
    },
  ]

  return (
    <Page
      title="Approvals"
      subtitle={summary ? `${fmtNum(summary.total)} items awaiting your action` : undefined}
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 20 }}>
        <KpiCard label="Credit Applications" value={fmtNum(summary?.los        ?? 0)} accent={BLUE}   loading={loading} />
        <KpiCard label="Write-off Requests" value={fmtNum(summary?.write_offs ?? 0)} accent={RED}    loading={loading} />
        <KpiCard label="Leave Requests"     value={fmtNum(summary?.leave      ?? 0)} accent={PURPLE} loading={loading} />
        <KpiCard label="Compliance Findings" value={fmtNum(summary?.compliance ?? 0)} accent={AMBER}  loading={loading} />
      </div>

      {/* Module filter tabs */}
      {modules.length > 1 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          <button
            onClick={() => setModuleFilter('')}
            style={{
              padding: '5px 14px', borderRadius: 20, border: '1px solid',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
              borderColor: !moduleFilter ? NAVY : 'var(--bdr)',
              background: !moduleFilter ? `${NAVY}12` : 'transparent',
              color: !moduleFilter ? NAVY : 'var(--txt2)',
            }}>
            All ({items.length})
          </button>
          {modules.map(m => {
            const c = MODULE_COLOR[m] ?? NAVY
            const cnt = items.filter(i => i.module === m).length
            return (
              <button key={m}
                onClick={() => setModuleFilter(moduleFilter === m ? '' : m)}
                style={{
                  padding: '5px 14px', borderRadius: 20, border: '1px solid',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  borderColor: moduleFilter === m ? c : 'var(--bdr)',
                  background: moduleFilter === m ? `${c}12` : 'transparent',
                  color: moduleFilter === m ? c : 'var(--txt2)',
                }}>
                {m} ({cnt})
              </button>
            )
          })}
        </div>
      )}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#F0F4FF', borderRadius: 10, border: `1px solid ${NAVY}20`, marginBottom: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: NAVY }}>{selected.size} selected</span>
          <button onClick={() => runBatch('approve')} disabled={batchBusy}
            style={{ padding: '6px 16px', borderRadius: 7, border: 'none', background: GREEN, color: '#fff', fontSize: 12.5, fontWeight: 700, cursor: batchBusy ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>check_circle</span>Approve ({selected.size})
          </button>
          <button onClick={() => runBatch('reject')} disabled={batchBusy}
            style={{ padding: '6px 16px', borderRadius: 7, border: 'none', background: RED, color: '#fff', fontSize: 12.5, fontWeight: 700, cursor: batchBusy ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>cancel</span>Reject ({selected.size})
          </button>
          <button onClick={() => setSelected(new Set())}
            style={{ marginLeft: 'auto', padding: '4px 10px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'none', fontSize: 12, color: 'var(--txt2)', cursor: 'pointer' }}>
            Clear
          </button>
        </div>
      )}

      <SectionCard title="Pending Actions" badge={filtered.length} padding={false}>
        <DataTable<ApprovalItem>
          cols={cols}
          rows={filtered}
          keyFn={(r, i) => `${r.module}-${r.item_id}-${i}`}
          emptyText={loading ? '' : 'No items pending your approval.'}
          skeletonRows={loading ? 8 : 0}
          onRowClick={r => {
            const route = MODULE_ROUTES[r.module]
            if (route) navigate(route(r.item_id))
          }}
        />
      </SectionCard>
    </Page>
  )
}
