import { useEffect, useState, useCallback } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, FilterBar, filterInputStyle, Spinner, KpiCard } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDate, fmtNum, today } from '../../lib/fmt'
import { BLUE, AMBER, GREEN, RED, PURPLE, NAVY, NUM, INTER } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface LegalCase {
  id: number
  case_id: number
  account_cif: string
  customer_name: string | null
  outstanding_kobo: number
  current_milestone: string
  solicitor: string | null
  next_court_date: string | null
  days_in_legal: number
}

interface LegalKPIs {
  total_cases: number
  active: number
  won: number
  total_debt_recovered_kobo: number
}

interface Milestone {
  id: number
  milestone_type: string
  milestone_date: string | null
  notes: string | null
  completed: boolean
}

// ── Milestone pill colours ────────────────────────────────────────────────────

const MILESTONE_COLORS: Record<string, { bg: string; txt: string; hex: string }> = {
  'Demand Letter':        { bg: `rgba(37,99,235,.12)`,  txt: BLUE,   hex: BLUE },
  'Pre-Litigation':       { bg: `rgba(217,119,6,.12)`,  txt: AMBER,  hex: AMBER },
  'Court Filing':         { bg: `rgba(124,58,237,.12)`, txt: PURPLE, hex: PURPLE },
  'Hearing':              { bg: `rgba(217,119,6,.12)`,  txt: AMBER,  hex: AMBER },
  'Judgment':             { bg: `rgba(22,163,74,.12)`,  txt: GREEN,  hex: GREEN },
  'Enforcement':          { bg: `rgba(192,0,0,.1)`,     txt: RED,    hex: RED },
}

function MilestonePill({ milestone }: { milestone: string }) {
  const s = MILESTONE_COLORS[milestone] ?? { bg: 'rgba(75,85,99,.1)', txt: '#6B7280', hex: '#6B7280' }
  return (
    <span style={{
      ...NUM, display: 'inline-flex', alignItems: 'center',
      fontSize: 11.5, fontWeight: 600, padding: '2px 8px',
      borderRadius: 20, background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>
      {milestone}
    </span>
  )
}

// ── Shared field style ────────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--input-bdr)', borderRadius: 7,
  fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box',
}

// ── Ordered milestone list ────────────────────────────────────────────────────

const MILESTONE_ORDER = [
  'Demand Letter',
  'Pre-Litigation',
  'Court Filing',
  'Hearing',
  'Judgment',
  'Enforcement',
]

// ── Inline milestone timeline ─────────────────────────────────────────────────

function MilestoneTimeline({
  caseId,
  milestones,
  onAdd,
}: {
  caseId: number
  milestones: Milestone[]
  onAdd: (caseId: number) => void
}) {
  const [showForm, setShowForm] = useState(false)
  const [formMilestone, setFormMilestone] = useState(MILESTONE_ORDER[0])
  const [formDate, setFormDate] = useState('')
  const [formNote, setFormNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [formErr, setFormErr] = useState<string | null>(null)

  async function submitMilestone() {
    if (!formDate) return
    setSaving(true); setFormErr(null)
    try {
      await apiPost(`/api/recovery/cases/${caseId}/legal-milestone`, {
        milestone_type: formMilestone,
        milestone_date: formDate,
        notes: formNote,
      })
      toast.success('Milestone added')
      setFormDate(''); setFormNote(''); setShowForm(false)
      onAdd(caseId)
    } catch (e: any) {
      setFormErr(e.message ?? 'Failed to add milestone')
    } finally { setSaving(false) }
  }

  const completedMap: Record<string, Milestone> = {}
  milestones.forEach(m => { completedMap[m.milestone_type] = m })

  return (
    <div style={{ padding: '14px 18px', background: 'var(--th-bg)', borderRadius: 10, margin: '8px 4px' }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)', marginBottom: 14 }}>
        Legal Milestone Timeline
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {MILESTONE_ORDER.map((ms, idx) => {
          const completed = completedMap[ms]
          const color = MILESTONE_COLORS[ms]?.hex ?? '#6B7280'
          return (
            <div key={ms} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              {/* Timeline connector */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, width: 20 }}>
                <div style={{
                  width: 18, height: 18, borderRadius: '50%',
                  background: completed ? color : 'var(--bdr)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  {completed && (
                    <span className="material-symbols-rounded" style={{ fontSize: 12, color: '#fff' }}>check</span>
                  )}
                </div>
                {idx < MILESTONE_ORDER.length - 1 && (
                  <div style={{ width: 2, flex: 1, minHeight: 16, background: 'var(--bdr)', marginTop: 3 }} />
                )}
              </div>
              {/* Content */}
              <div style={{ flex: 1, paddingBottom: idx < MILESTONE_ORDER.length - 1 ? 8 : 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: completed ? 'var(--txt)' : 'var(--txt2)' }}>
                    {ms}
                  </span>
                  {completed?.milestone_date && (
                    <span style={{ fontSize: 11, color: 'var(--txt2)', fontFamily: INTER }}>
                      {fmtDate(completed.milestone_date)}
                    </span>
                  )}
                </div>
                {completed?.notes && (
                  <div style={{ fontSize: 12, color: 'var(--txt2)', lineHeight: 1.5 }}>{completed.notes}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Add milestone */}
      {!showForm ? (
        <button onClick={() => setShowForm(true)} style={{
          marginTop: 14, fontSize: 12.5, fontWeight: 600, color: NAVY,
          background: 'none', border: `1px solid ${NAVY}30`,
          borderRadius: 7, padding: '5px 12px', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 5,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>add</span>
          Add Milestone
        </button>
      ) : (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10, padding: '12px', borderRadius: 8, background: 'var(--card)', border: '1px solid var(--bdr)' }}>
          {formErr && (
            <div style={{ fontSize: 12.5, color: RED }}>{formErr}</div>
          )}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Milestone</label>
            <select value={formMilestone} onChange={e => setFormMilestone(e.target.value)} style={{ ...filterInputStyle, height: 34, width: '100%' }}>
              {MILESTONE_ORDER.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Date</label>
            <input type="date" value={formDate} onChange={e => setFormDate(e.target.value)} style={{ ...fieldStyle, height: 34 }} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Note</label>
            <textarea value={formNote} onChange={e => setFormNote(e.target.value)} rows={2} placeholder="Optional note…" style={{ ...fieldStyle, resize: 'vertical' }} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={submitMilestone}
              disabled={!formDate || saving}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '6px 14px', background: NAVY, color: '#fff',
                border: 'none', borderRadius: 7, fontSize: 12.5, fontWeight: 600,
                cursor: !formDate || saving ? 'not-allowed' : 'pointer',
                opacity: !formDate || saving ? 0.6 : 1,
              }}
            >
              {saving && <Spinner size={12} color="#fff" />}
              Save
            </button>
            <button onClick={() => { setShowForm(false); setFormErr(null) }} style={{
              padding: '6px 12px', background: 'none', border: '1px solid var(--bdr)',
              borderRadius: 7, fontSize: 12.5, cursor: 'pointer', color: 'var(--txt2)',
            }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Export CSV ────────────────────────────────────────────────────────────────

function exportLegalCsv(rows: LegalCase[]) {
  const header = ['CIF', 'Customer Name', 'Outstanding (₦)', 'Milestone', 'Solicitor', 'Next Court Date', 'Days in Legal']
  const lines = rows.map(r => [
    r.account_cif ?? '',
    `"${String(r.customer_name ?? '').replace(/"/g, '""')}"`,
    (r.outstanding_kobo / 100).toFixed(2),
    `"${String(r.current_milestone ?? '').replace(/"/g, '""')}"`,
    `"${String(r.solicitor ?? '').replace(/"/g, '""')}"`,
    r.next_court_date ?? '',
    r.days_in_legal ?? '',
  ].join(','))
  const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url
  a.download = `legal-cases-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

// ── Main component ────────────────────────────────────────────────────────────

export default function RecoveryLegal() {
  const [rows, setRows]           = useState<LegalCase[]>([])
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [expandedData, setExpandedData] = useState<Record<number, Milestone[] | 'loading'>>({})

  const [milestoneFilter, setMilestoneFilter] = useState('')
  const [solicitorFilter, setSolicitorFilter] = useState('')

  const [kpis, setKpis]         = useState<LegalKPIs | null>(null)
  const [kpiLoading, setKpiLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    const params = new URLSearchParams({ limit: '100' })
    if (milestoneFilter) params.set('milestone', milestoneFilter)
    if (solicitorFilter.trim()) params.set('q', solicitorFilter.trim())
    try {
      const res = await apiFetch<{ data: LegalCase[] }>(`/api/recovery/legal?${params}`)
      setRows(res.data ?? [])
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load legal cases')
    } finally {
      setLoading(false)
    }
  }, [milestoneFilter, solicitorFilter])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    setKpiLoading(true)
    apiFetch<{ data: LegalKPIs }>('/api/recovery/legal-kpis')
      .then(r => setKpis(r.data))
      .catch(() => {})
      .finally(() => setKpiLoading(false))
  }, [])

  async function loadMilestones(caseId: number) {
    if (expandedData[caseId] && expandedData[caseId] !== 'loading') return
    setExpandedData(prev => ({ ...prev, [caseId]: 'loading' }))
    try {
      const res = await apiFetch<{ data: Milestone[] }>(`/api/recovery/cases/${caseId}/legal-milestones`)
      setExpandedData(prev => ({ ...prev, [caseId]: res.data ?? [] }))
    } catch {
      setExpandedData(prev => ({ ...prev, [caseId]: [] }))
    }
  }

  function toggleExpand(row: LegalCase) {
    if (expandedId === row.id) {
      setExpandedId(null)
    } else {
      setExpandedId(row.id)
      loadMilestones(row.case_id)
    }
  }

  function refreshMilestones(caseId: number) {
    setExpandedData(prev => {
      const next = { ...prev }
      delete next[caseId]
      return next
    })
    loadMilestones(caseId)
  }

  const todayStr = today()

  const cols: TableCol<LegalCase>[] = [
    {
      key: 'customer_name',
      label: 'Customer',
      sortable: true,
      render: r => (
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>
            {r.customer_name ?? '—'}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--txt2)' }}>{r.account_cif}</div>
        </div>
      ),
    },
    {
      key: 'outstanding_kobo',
      label: 'Outstanding ₦',
      sortable: true,
      align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.outstanding_kobo)}</span>,
    },
    {
      key: 'current_milestone',
      label: 'Milestone',
      sortable: true,
      render: r => <MilestonePill milestone={r.current_milestone} />,
    },
    {
      key: 'solicitor',
      label: 'Solicitor',
      sortable: true,
      render: r => <span style={{ fontSize: 13, color: 'var(--txt)' }}>{r.solicitor ?? '—'}</span>,
    },
    {
      key: 'next_court_date',
      label: 'Next Court Date',
      sortable: true,
      render: r => {
        if (!r.next_court_date) return <span style={{ color: 'var(--txt2)', fontSize: 13 }}>—</span>
        const isPast = r.next_court_date < todayStr
        return (
          <span style={{ ...NUM, fontSize: 13, fontWeight: isPast ? 600 : 400, color: isPast ? RED : 'var(--txt)' }}>
            {fmtDate(r.next_court_date)}
          </span>
        )
      },
    },
    {
      key: 'days_in_legal',
      label: 'Days in Legal',
      sortable: true,
      align: 'right',
      render: r => <span style={{ ...NUM, fontSize: 13 }}>{fmtNum(r.days_in_legal)}</span>,
    },
  ]

  // Custom render with inline expand — we build the table manually to inject expanded rows
  const filtered = rows

  return (
    <Page
      title="Legal Cases"
      subtitle="Manage accounts in legal proceedings"
      actions={
        <button
          onClick={() => exportLegalCsv(rows)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 14px', borderRadius: 8, border: '1.5px solid var(--bdr)',
            background: 'var(--card)', color: 'var(--txt)',
            fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>download</span>
          Export CSV
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* Page-level filter */}
      <FilterBar onReset={() => { setMilestoneFilter(''); setSolicitorFilter('') }}>
        <select value={milestoneFilter} onChange={e => setMilestoneFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Milestones</option>
          {MILESTONE_ORDER.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <input
          value={solicitorFilter}
          onChange={e => setSolicitorFilter(e.target.value)}
          placeholder="Search solicitor…"
          style={{ ...filterInputStyle, minWidth: 200 }}
        />
        <button onClick={() => load()} style={{
          height: 32, padding: '0 14px', borderRadius: 7, border: '1px solid var(--bdr)',
          background: 'var(--card)', color: 'var(--txt)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
        }}>Apply</button>
      </FilterBar>

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 20 }}>
        <KpiCard label="Total Cases" value={kpis ? fmtNum(kpis.total_cases) : '—'} icon="gavel" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="Active" value={kpis ? fmtNum(kpis.active) : '—'} icon="pending_actions" accent={AMBER} loading={kpiLoading} />
        <KpiCard label="Won" value={kpis ? fmtNum(kpis.won) : '—'} icon="verified" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="Debt Recovered" value={kpis ? fmtKobo(kpis.total_debt_recovered_kobo) : '—'} icon="savings" accent={BLUE} loading={kpiLoading} />
      </div>

      <SectionCard
        title="Legal Cases"
        badge={filtered.length}
        padding={false}
      >
        {/* Table with inline expand */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                {cols.map(col => (
                  <th key={col.key} style={{
                    padding: '10px 14px',
                    textAlign: col.align === 'right' ? 'right' : 'left',
                    fontSize: 11.5, fontWeight: 600, color: 'var(--txt2)',
                    letterSpacing: '0.2px', whiteSpace: 'nowrap',
                    borderBottom: '1px solid var(--bdr)',
                  }}>
                    {col.label}
                  </th>
                ))}
                <th style={{ width: 40, borderBottom: '1px solid var(--bdr)' }} />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {cols.map(col => (
                      <td key={col.key} style={{ padding: '12px 14px', borderBottom: '1px solid var(--bdr)' }}>
                        <div style={{ height: 14, background: 'var(--bdr)', borderRadius: 4, width: '80%', opacity: 0.5 }} />
                      </td>
                    ))}
                    <td style={{ borderBottom: '1px solid var(--bdr)' }} />
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={cols.length + 1} style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--txt2)', fontSize: 13 }}>
                    No legal cases found.
                  </td>
                </tr>
              ) : (
                filtered.map(row => (
                  <>
                    <tr
                      key={row.id}
                      onClick={() => toggleExpand(row)}
                      style={{ cursor: 'pointer', borderBottom: '1px solid var(--bdr)' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '' }}
                    >
                      {cols.map(col => (
                        <td key={col.key} style={{
                          padding: '12px 14px',
                          textAlign: col.align === 'right' ? 'right' : 'left',
                        }}>
                          {col.render ? col.render(row, 0) : row[col.key as keyof LegalCase] as React.ReactNode}
                        </td>
                      ))}
                      <td style={{ padding: '12px 14px', textAlign: 'center' }}>
                        <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt2)' }}>
                          {expandedId === row.id ? 'expand_less' : 'expand_more'}
                        </span>
                      </td>
                    </tr>
                    {expandedId === row.id && (
                      <tr key={`${row.id}-expand`} style={{ background: 'var(--bg)' }}>
                        <td colSpan={cols.length + 1} style={{ padding: '0 16px 16px', borderBottom: '1px solid var(--bdr)' }}>
                          {expandedData[row.case_id] === 'loading' ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '20px 0', color: 'var(--txt2)', fontSize: 13 }}>
                              <Spinner size={14} color={NAVY} /> Loading milestones…
                            </div>
                          ) : (
                            <MilestoneTimeline
                              caseId={row.case_id}
                              milestones={(expandedData[row.case_id] as Milestone[]) ?? []}
                              onAdd={refreshMilestones}
                            />
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                ))
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </Page>
  )
}
