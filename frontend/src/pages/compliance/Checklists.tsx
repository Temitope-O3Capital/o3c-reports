import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch, apiPut } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChecklistItem {
  id: number
  description: string
  status: string
  completed_by?: string
  completed_at?: string
  notes?: string
}

interface Checklist {
  id: number
  name: string
  checklist_type?: string
  period?: string
  total_items: number
  done_items: number
  items?: ChecklistItem[]
}

// ── Progress bar ───────────────────────────────────────────────────────────────

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const color = pct === 100 ? GREEN : pct >= 50 ? AMBER : 'var(--chart-lbl)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, height: 6, background: 'var(--bdr)', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 10, transition: 'width 300ms' }} />
      </div>
      <span style={{ ...NUM, fontSize: 12, fontWeight: 700, color, minWidth: 34 }}>{pct}%</span>
    </div>
  )
}

// ── Checklist row ──────────────────────────────────────────────────────────────

function ChecklistRow({ checklist, onRefresh }: { checklist: Checklist; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [items, setItems] = useState<ChecklistItem[]>(checklist.items ?? [])
  const [loadingItems, setLoadingItems] = useState(false)
  const [checking, setChecking] = useState<number | null>(null)

  async function expand() {
    if (!expanded && items.length === 0) {
      setLoadingItems(true)
      try {
        const data = await apiFetch<Checklist>(`/api/compliance/checklists/${checklist.id}`)
        setItems(data.items ?? [])
      } catch { /* keep empty */ }
      finally { setLoadingItems(false) }
    }
    setExpanded(e => !e)
  }

  async function toggle(item: ChecklistItem) {
    const newStatus = item.status === 'done' ? 'pending' : 'done'
    setChecking(item.id)
    try {
      await apiPut(`/api/compliance/checklists/${checklist.id}/respond`, {
        item_id: item.id, status: newStatus,
      })
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, status: newStatus } : i))
      toast.success(newStatus === 'done' ? 'Item checked' : 'Item unchecked')
      onRefresh()
    } catch (e: any) { toast.error(e.message) }
    finally { setChecking(null) }
  }

  const doneCount = items.filter(i => i.status === 'done').length

  return (
    <div style={{ borderBottom: '1px solid var(--bdr)' }}>
      <div
        onClick={expand}
        style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', cursor: 'pointer', background: expanded ? 'var(--row-sel)' : 'transparent' }}
        onMouseEnter={e => { if (!expanded) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
        onMouseLeave={e => { if (!expanded) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 18, color: 'var(--txt3)', transition: 'transform 200ms', transform: expanded ? 'rotate(90deg)' : 'none' }}>
          chevron_right
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--txt)', marginBottom: 2 }}>{checklist.name}</div>
          <div style={{ display: 'flex', gap: 12, fontSize: 12, color: 'var(--txt2)' }}>
            {checklist.checklist_type && <span>{checklist.checklist_type}</span>}
            {checklist.period && <span>Period: {checklist.period}</span>}
          </div>
        </div>

        <div style={{ width: 160 }}>
          <ProgressBar done={doneCount > 0 ? doneCount : checklist.done_items} total={checklist.total_items} />
        </div>

        <div style={{ flexShrink: 0, minWidth: 60, textAlign: 'right' }}>
          <span style={{ ...NUM, fontSize: 12.5, fontWeight: 600, color: 'var(--txt2)' }}>
            {doneCount > 0 ? doneCount : checklist.done_items} / {checklist.total_items}
          </span>
        </div>
      </div>

      {/* Expanded items */}
      {expanded && (
        <div style={{ background: 'var(--th-bg)', padding: '0 18px 12px 50px' }}>
          {loadingItems ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}>
              <Spinner size={20} />
            </div>
          ) : items.length === 0 ? (
            <div style={{ padding: '16px 0', color: 'var(--txt2)', fontSize: 13 }}>No items found.</div>
          ) : (
            items.map(item => (
              <div key={item.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--bdr)' }}>
                <button
                  onClick={() => toggle(item)}
                  disabled={checking === item.id}
                  style={{
                    width: 20, height: 20, borderRadius: 5, flexShrink: 0, marginTop: 2, cursor: 'pointer',
                    border: `2px solid ${item.status === 'done' ? GREEN : 'var(--input-bdr)'}`,
                    background: item.status === 'done' ? GREEN : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  {item.status === 'done' && (
                    <span className="material-symbols-rounded" style={{ fontSize: 13, color: '#fff' }}>check</span>
                  )}
                </button>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, color: item.status === 'done' ? 'var(--txt3)' : 'var(--txt)', textDecoration: item.status === 'done' ? 'line-through' : 'none' }}>
                    {item.description}
                  </div>
                  {item.completed_by && item.completed_at && (
                    <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 2 }}>
                      Completed by {item.completed_by} on {fmtDate(item.completed_at)}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Checklists() {
  const [checklists, setChecklists] = useState<Checklist[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const data = await apiFetch<Checklist[]>('/api/compliance/checklists')
      setChecklists(Array.isArray(data) ? data : [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <Page title="Compliance Checklists" subtitle="Periodic compliance verification checklists">
      <ErrBanner error={err} onRetry={load} />

      <SectionCard title="Checklists" badge={checklists.length} padding={false}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
            <Spinner size={28} />
          </div>
        ) : checklists.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--txt2)', fontSize: 13 }}>No checklists found.</div>
        ) : (
          <div>
            {/* Table header */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 14, padding: '8px 18px',
              background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)',
              fontSize: 11, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.06em',
            }}>
              <div style={{ width: 18 }} />
              <div style={{ flex: 1 }}>Checklist</div>
              <div style={{ width: 160 }}>Completion</div>
              <div style={{ minWidth: 60, textAlign: 'right' }}>Items</div>
            </div>
            {checklists.map(c => (
              <ChecklistRow key={c.id} checklist={c} onRefresh={load} />
            ))}
          </div>
        )}
      </SectionCard>
    </Page>
  )
}
