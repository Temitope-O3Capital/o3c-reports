import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, DataTable, Modal, ErrBanner, btnPrimary, btnSecondary,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDate, fmtDatetime } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Stage {
  id: number
  name: string
  color?: string
  is_won?: boolean
  is_lost?: boolean
  order_index?: number
}

interface Deal {
  id: number
  title: string
  contact_id?: number
  first_name?: string
  last_name?: string
  stage_id?: number
  stage_name?: string
  stage_color?: string
  is_won?: boolean
  is_lost?: boolean
  expected_value?: number
  probability?: number
  assigned_name?: string
  updated_at: string
  expected_close_date?: string
  notes?: string
  product?: string
}

interface PipelineResponse {
  stages: Stage[]
  deals: Record<string, Deal[]>
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function stagePillStyle(color?: string, isWon?: boolean, isLost?: boolean) {
  const c = isWon ? GREEN : isLost ? '#6B7280' : (color || NAVY)
  return { background: `${c}18`, color: c }
}

function StagePill({ name, color, is_won, is_lost }: Pick<Stage, 'name' | 'color' | 'is_won' | 'is_lost'>) {
  const s = stagePillStyle(color, is_won, is_lost)
  return (
    <span style={{ ...NUM, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, ...s }}>
      {name}
    </span>
  )
}

const DAYS_IN_STAGE_MS = 24 * 60 * 60 * 1000

function daysInStage(deal: Deal): number {
  return Math.floor((Date.now() - new Date(deal.updated_at).getTime()) / DAYS_IN_STAGE_MS)
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function CRMPipeline() {
  const navigate = useNavigate()
  const [pipeline, setPipeline] = useState<PipelineResponse | null>(null)
  const [allDeals, setAllDeals] = useState<Deal[]>([])
  const [loading, setLoading]   = useState(true)
  const [err, setErr]           = useState<string | null>(null)
  const [view, setView]         = useState<'table' | 'kanban'>('table')
  const [selected, setSelected] = useState<Deal | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [p, d] = await Promise.all([
        apiFetch<PipelineResponse>('/api/crm/pipeline'),
        apiFetch<Deal[]>('/api/crm/deals'),
      ])
      setPipeline(p)
      setAllDeals(Array.isArray(d) ? d : [])
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const tableCols: TableCol<Deal>[] = [
    {
      key: 'title', label: 'Deal',
      render: r => (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.title}</div>
          {(r.first_name || r.last_name) && (
            <div style={{ fontSize: 11.5, color: 'var(--txt3)' }}>{r.first_name} {r.last_name}</div>
          )}
        </div>
      ),
    },
    {
      key: 'stage_name', label: 'Stage',
      render: r => <StagePill name={r.stage_name ?? '—'} color={r.stage_color} is_won={r.is_won} is_lost={r.is_lost} />,
    },
    {
      key: 'expected_value', label: 'Est. Value', align: 'right',
      render: r => r.expected_value
        ? <span style={NUM}>{fmtKobo(r.expected_value * 100)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    { key: 'assigned_name', label: 'Owner', render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.assigned_name ?? '—'}</span> },
    {
      key: 'expected_close_date', label: 'Close Date',
      render: r => r.expected_close_date
        ? <span style={{ fontSize: 12.5, color: 'var(--txt)' }}>{fmtDate(r.expected_close_date)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'updated_at', label: 'Last Activity',
      render: r => <span style={{ fontSize: 12, color: 'var(--txt3)' }}>{fmtDatetime(r.updated_at)}</span>,
    },
  ]

  const stages = (pipeline?.stages ?? []).slice().sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))

  return (
    <Page
      title="CRM Pipeline"
      subtitle="Deal management and sales pipeline"
      actions={
        <div style={{ display: 'flex', gap: 4, background: 'var(--th-bg)', padding: 3, borderRadius: 8, border: '1px solid var(--bdr)' }}>
          {(['table', 'kanban'] as const).map(v => (
            <button key={v} onClick={() => setView(v)}
              style={{
                padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
                background: view === v ? 'var(--card)' : 'transparent',
                color: view === v ? 'var(--txt)' : 'var(--txt2)',
                boxShadow: view === v ? '0 1px 3px rgba(0,0,0,.08)' : 'none',
              }}>
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {view === 'table' ? (
        <SectionCard title="All Deals" badge={allDeals.length} padding={false}>
          <DataTable<Deal>
            cols={tableCols}
            rows={allDeals}
            keyFn={r => r.id}
            onRowClick={r => setSelected(r)}
            emptyText="No deals found."
            skeletonRows={loading ? 8 : 0}
          />
        </SectionCard>
      ) : (
        <div style={{ overflowX: 'auto', paddingBottom: 8 }}>
          <div style={{ display: 'flex', gap: 12, minWidth: stages.length * 240 }}>
            {stages.map(stage => {
              const deals = pipeline?.deals?.[String(stage.id)] ?? []
              const headerColor = stage.is_won ? GREEN : stage.is_lost ? '#6B7280' : (stage.color || NAVY)
              return (
                <div key={stage.id} style={{ flex: '0 0 230px', minWidth: 230 }}>
                  {/* Stage header */}
                  <div style={{
                    padding: '8px 12px', borderRadius: '10px 10px 0 0', marginBottom: 8,
                    background: `${headerColor}14`, borderBottom: `2px solid ${headerColor}40`,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: headerColor }}>{stage.name}</span>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 12, background: `${headerColor}20`, color: headerColor }}>
                      {deals.length}
                    </span>
                  </div>
                  {/* Deal cards */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {deals.map(deal => (
                      <div key={deal.id} onClick={() => setSelected(deal)}
                        style={{
                          background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 10,
                          padding: '12px 14px', cursor: 'pointer', transition: 'box-shadow .15s',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.boxShadow = 'var(--card-shadow)')}
                        onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
                      >
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--txt)', marginBottom: 5, lineHeight: 1.3 }}>
                          {deal.title}
                        </div>
                        {(deal.first_name || deal.last_name) && (
                          <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginBottom: 5 }}>
                            {deal.first_name} {deal.last_name}
                          </div>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11.5 }}>
                          {deal.expected_value
                            ? <span style={{ ...NUM, color: NAVY, fontWeight: 700 }}>{fmtKobo(deal.expected_value * 100)}</span>
                            : <span style={{ color: 'var(--txt3)' }}>—</span>}
                          <span style={{ color: 'var(--txt3)' }}>{daysInStage(deal)}d</span>
                        </div>
                        {deal.assigned_name && (
                          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--txt2)' }}>{deal.assigned_name}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Deal detail modal */}
      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected?.title ?? 'Deal Detail'} width={500}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
            <button
              onClick={() => { setSelected(null); navigate('/sales/applications/new') }}
              style={{ ...btnPrimary, background: GREEN }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>receipt_long</span>
              Convert to LOS
            </button>
            <button onClick={() => setSelected(null)} style={btnSecondary}>Close</button>
          </div>
        }
      >
        {selected && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <StagePill name={selected.stage_name ?? '—'} color={selected.stage_color} is_won={selected.is_won} is_lost={selected.is_lost} />
              {selected.product && (
                <span style={{ ...NUM, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: `${BLUE}12`, color: BLUE }}>
                  {selected.product}
                </span>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 13 }}>
              {[
                ['Contact',    `${selected.first_name ?? ''} ${selected.last_name ?? ''}`.trim() || '—'],
                ['Est. Value', selected.expected_value ? fmtKobo(selected.expected_value * 100) : '—'],
                ['Owner',      selected.assigned_name ?? '—'],
                ['Probability',selected.probability != null ? `${selected.probability}%` : '—'],
                ['Close Date', selected.expected_close_date ? fmtDate(selected.expected_close_date) : '—'],
                ['Last Update', fmtDatetime(selected.updated_at)],
              ].map(([label, value]) => (
                <div key={label as string}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt2)', marginBottom: 2 }}>{label}</div>
                  <div style={{ color: 'var(--txt)', fontWeight: 500 }}>{value}</div>
                </div>
              ))}
            </div>

            {selected.notes && (
              <div style={{ padding: '10px 12px', background: 'var(--th-bg)', borderRadius: 8, fontSize: 13, color: 'var(--txt)', lineHeight: 1.6 }}>
                {selected.notes}
              </div>
            )}
          </div>
        )}
      </Modal>
    </Page>
  )
}
