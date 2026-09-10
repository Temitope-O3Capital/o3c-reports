import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, ErrBanner, ExpandableFilterBar, filterInputStyle, Spinner, KpiCard, DateFilter, NameCell, ActionRow, Modal } from '../../components/UI'
import type { FilterGroupDef } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtKoboExact, fmtKobo, fmtDate, fmtNum, today, monthStart } from '../../lib/fmt'
import { BLUE, AMBER, GREEN, RED, PURPLE, NAVY, NUM, INTER, TEXT, FW, SP, RADIUS } from '../../lib/design'
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
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px',
      borderRadius: RADIUS['2xl'], background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>
      {milestone}
    </span>
  )
}

// ── Shared field style ────────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
  fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "var(--font-sans)", outline: 'none', boxSizing: 'border-box',
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
                    <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm, color: '#fff' }}>check</span>
                  )}
                </div>
                {idx < MILESTONE_ORDER.length - 1 && (
                  <div style={{ width: 2, flex: 1, minHeight: 16, background: 'var(--bdr)', marginTop: 3 }} />
                )}
              </div>
              {/* Content */}
              <div style={{ flex: 1, paddingBottom: idx < MILESTONE_ORDER.length - 1 ? 8 : 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: completed ? 'var(--txt)' : 'var(--txt2)' }}>
                    {ms}
                  </span>
                  {completed?.milestone_date && (
                    <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>
                      {fmtDate(completed.milestone_date)}
                    </span>
                  )}
                </div>
                {completed?.notes && (
                  <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5 }}>{completed.notes}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Add milestone */}
      {!showForm ? (
        <button onClick={() => setShowForm(true)} style={{
          marginTop: 14, fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY,
          background: 'none', border: `1px solid ${NAVY}30`,
          borderRadius: RADIUS.md, padding: '5px 12px', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 5,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>add</span>
          Add Milestone
        </button>
      ) : (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10, padding: '12px', borderRadius: 8, background: 'var(--card)', border: '1px solid var(--bdr)' }}>
          {formErr && (
            <div style={{ fontSize: TEXT.sm, color: RED }}>{formErr}</div>
          )}
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Milestone</label>
            <select value={formMilestone} onChange={e => setFormMilestone(e.target.value)} style={{ ...filterInputStyle, height: 34, width: '100%' }}>
              {MILESTONE_ORDER.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Date</label>
            <input type="date" value={formDate} onChange={e => setFormDate(e.target.value)} style={{ ...fieldStyle, height: 34 }} />
          </div>
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Note</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={formNote} onChange={e => setFormNote(e.target.value)} rows={2} placeholder="Optional note…" style={{ ...fieldStyle, resize: 'vertical' }} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={submitMilestone}
              disabled={!formDate || saving}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '6px 14px', background: NAVY, color: '#fff',
                border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold,
                cursor: !formDate || saving ? 'not-allowed' : 'pointer',
                opacity: !formDate || saving ? 0.6 : 1,
              }}
            >
              {saving && <Spinner size={12} color="#fff" />}
              Save
            </button>
            <button onClick={() => { setShowForm(false); setFormErr(null) }} style={{
              padding: '6px 12px', background: 'none', border: '1px solid var(--bdr)',
              borderRadius: RADIUS.md, fontSize: TEXT.sm, cursor: 'pointer', color: 'var(--txt2)',
            }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}



// ── Solicitor assign modal ────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5,
}

function SolicitorModal({ legalCase, solicitors, onClose, onDone }: {
  legalCase: LegalCase; solicitors: string[]; onClose: () => void; onDone: () => void
}) {
  const [value, setValue]   = useState(legalCase.solicitor ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr]       = useState<string | null>(null)

  async function save() {
    setSaving(true); setErr(null)
    try {
      await apiPut(`/api/recovery/cases/${legalCase.case_id}/solicitor`, { solicitor: value.trim() })
      toast.success(value.trim() ? 'Solicitor assigned' : 'Solicitor cleared')
      onDone()
    } catch (e: any) {
      setErr(e.message ?? 'Failed to assign solicitor')
    } finally { setSaving(false) }
  }

  return (
    <Modal open onClose={onClose} title="Assign Solicitor" width={440}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ErrBanner error={err} />
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
          {legalCase.customer_name ?? legalCase.account_cif} · {fmtKoboExact(legalCase.outstanding_kobo)} outstanding
        </div>
        <div>
          <label style={labelStyle}>Solicitor / Law Firm</label>
          <input
            list="recovery-solicitors"
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="Pick or type a firm…"
            autoFocus
            style={{ ...fieldStyle, height: 38 }}
          />
          <datalist id="recovery-solicitors">
            {solicitors.map(s => <option key={s} value={s} />)}
          </datalist>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={save} disabled={saving} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px',
            borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff',
            fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1,
          }}>
            {saving && <Spinner size={13} color="#fff" />} Save
          </button>
          <button onClick={onClose} style={{
            padding: '8px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)',
            background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer',
          }}>Cancel</button>
        </div>
      </div>
    </Modal>
  )
}

// ── Legal milestone timeline modal ────────────────────────────────────────────

function TimelineModal({ legalCase, onClose }: { legalCase: LegalCase; onClose: () => void }) {
  const [ms, setMs] = useState<Milestone[] | 'loading'>('loading')

  const reload = useCallback(async () => {
    setMs('loading')
    try {
      const res = await apiFetch<{ data: Milestone[] }>(`/api/recovery/cases/${legalCase.case_id}/legal-milestones`)
      setMs(res.data ?? [])
    } catch { setMs([]) }
  }, [legalCase.case_id])

  useEffect(() => { reload() }, [reload])

  return (
    <Modal open onClose={onClose} title={`Legal Timeline · ${legalCase.customer_name ?? legalCase.account_cif}`} width={560}>
      {ms === 'loading' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '24px 0', color: 'var(--txt2)', fontSize: TEXT.base }}>
          <Spinner size={14} color={NAVY} /> Loading milestones…
        </div>
      ) : (
        <MilestoneTimeline caseId={legalCase.case_id} milestones={ms} onAdd={reload} />
      )}
    </Modal>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function RecoveryLegal() {
  const [rows, setRows]           = useState<LegalCase[]>([])
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState<string | null>(null)
  const [tlCase, setTlCase]       = useState<LegalCase | null>(null)   // timeline modal
  const [solCase, setSolCase]     = useState<LegalCase | null>(null)   // assign-solicitor modal
  const [solicitors, setSolicitors] = useState<string[]>([])

  const [fMilestones, setFMilestones] = useState(new Set<string>())
  const [search,      setSearch]      = useState('')
  const [dateFrom,    setDateFrom]    = useState(monthStart())
  const [dateTo,      setDateTo]      = useState(today())

  const [kpis, setKpis]         = useState<LegalKPIs | null>(null)
  const [kpiLoading, setKpiLoading] = useState(true)

  const fMilestonesKey = [...fMilestones].join(',')

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setErr(null)
    const params = new URLSearchParams({ limit: '100' })
    if (fMilestonesKey) params.set('milestone', fMilestonesKey)
    if (dateFrom)       params.set('from', dateFrom)
    if (dateTo)         params.set('to',   dateTo)
    try {
      const res = await apiFetch<{ data: LegalCase[] }>(`/api/recovery/legal?${params}`)
      setRows(res.data ?? [])
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load legal cases')
    } finally {
      setLoading(false)
    }
  }, [fMilestonesKey, dateFrom, dateTo])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['recovery'] })

  useEffect(() => {
    setKpiLoading(true)
    apiFetch<{ data: LegalKPIs }>('/api/recovery/legal-kpis')
      .then(r => setKpis(r.data))
      .catch(() => {})
      .finally(() => setKpiLoading(false))
  }, [])

  // Known solicitors for the assign modal's pick-or-type list.
  useEffect(() => {
    apiFetch<{ data: { solicitor: string }[] }>('/api/recovery/solicitors')
      .then(r => setSolicitors((r.data ?? []).map(s => s.solicitor).filter(Boolean)))
      .catch(() => {})
  }, [])

  const todayStr = today()

  const groups: FilterGroupDef[] = [
    {
      key: 'milestone',
      label: 'MILESTONE',
      options: MILESTONE_ORDER.map(m => ({
        value: m,
        color: MILESTONE_COLORS[m]?.hex,
        count: rows.filter(r => r.current_milestone === m).length,
      })),
      selected: fMilestones,
      onChange: setFMilestones,
    },
  ]

  function resetFilters() { setFMilestones(new Set()); setSearch('') }

  const filtered = useMemo(() => {
    if (!search.trim()) return rows
    const q = search.toLowerCase()
    return rows.filter(r =>
      [r.customer_name, r.current_milestone, r.solicitor, r.account_cif].some(v =>
        String(v ?? '').toLowerCase().includes(q)
      )
    )
  }, [rows, search])

  const cols: TableCol<LegalCase>[] = [
    {
      key: 'customer_name',
      label: 'Customer',
      sortable: true,
      render: r => (
        <NameCell
          name={r.customer_name ?? r.account_cif}
          sub={r.account_cif}
        />
      ),
    },
    {
      key: 'outstanding_kobo',
      label: 'Outstanding ₦',
      sortable: true,
      align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKoboExact(r.outstanding_kobo)}</span>,
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
      render: r => r.solicitor
        ? <span style={{ fontSize: TEXT.base, color: 'var(--txt)' }}>{r.solicitor}</span>
        : <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)', fontStyle: 'italic' }}>Unassigned</span>,
    },
    {
      key: 'next_court_date',
      label: 'Next Court Date',
      sortable: true,
      render: r => {
        if (!r.next_court_date) return <span style={{ color: 'var(--txt2)', fontSize: TEXT.base }}>—</span>
        const isPast = r.next_court_date < todayStr
        return (
          <span style={{ ...NUM, fontSize: TEXT.base, fontWeight: isPast ? FW.semibold : FW.normal, color: isPast ? RED : 'var(--txt)' }}>
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
      render: r => <span style={{ ...NUM, fontSize: TEXT.base }}>{fmtNum(r.days_in_legal)}</span>,
    },
  ]

  return (
    <Page
      title="Legal Cases"
      subtitle="Manage accounts in legal proceedings"
      loading={loading && rows.length === 0}
      skeletonKpis={4}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: SP[5] }}>
        <KpiCard label="Total Cases" value={kpis ? fmtNum(kpis.total_cases) : '—'} icon="gavel" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="Active" value={kpis ? fmtNum(kpis.active) : '—'} icon="pending_actions" accent={AMBER} loading={kpiLoading} />
        <KpiCard label="Won" value={kpis ? fmtNum(kpis.won) : '—'} icon="verified" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="Debt Recovered" value={kpis ? fmtKoboExact(kpis.total_debt_recovered_kobo) : '—'} icon="savings" accent={BLUE} loading={kpiLoading} />
      </div>

      <SectionCard
        title="Legal Cases"
        badge={filtered.length}
        padding={false}
      >
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={groups}
          onReset={resetFilters}
          onApply={load}
          resultCount={filtered.length}
          totalCount={rows.length}
          placeholder="Search name, solicitor, CIF…"
        />
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.base }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                {cols.map(col => (
                  <th key={col.key} style={{
                    padding: '10px 14px',
                    textAlign: col.align === 'right' ? 'right' : 'left',
                    fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)',
                    letterSpacing: '0.2px', whiteSpace: 'nowrap',
                    borderBottom: '1px solid var(--bdr)',
                  }}>
                    {col.label}
                  </th>
                ))}
                <th style={{ width: 84, borderBottom: '1px solid var(--bdr)' }} />
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
                  <td colSpan={cols.length + 1} style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>
                    No legal cases found.
                  </td>
                </tr>
              ) : (
                filtered.map(row => (
                  <tr
                    key={row.id}
                    onClick={() => setTlCase(row)}
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
                    <td style={{ padding: '12px 14px' }}>
                      <ActionRow actions={[
                        { icon: 'account_balance', label: 'Assign Solicitor', onClick: () => setSolCase(row) },
                        { icon: 'timeline',        label: 'View Timeline',    onClick: () => setTlCase(row) },
                      ]} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {tlCase && <TimelineModal legalCase={tlCase} onClose={() => setTlCase(null)} />}
      {solCase && (
        <SolicitorModal
          legalCase={solCase}
          solicitors={solicitors}
          onClose={() => setSolCase(null)}
          onDone={() => { setSolCase(null); load(true) }}
        />
      )}
    </Page>
  )
}
