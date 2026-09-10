import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, KpiCard, DataTable, ExpandableFilterBar,
  Modal, ErrBanner, Spinner, Pill, StatusBadge, filterInputStyle,
} from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtDate, fmtKoboExact, fmtKobo, fmtNum } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface WatchlistEntry {
  id: number
  account_cif: string
  scenario: string
  notes: string | null
  dpd_at_flag: number | null
  outstanding_kobo: number | null
  status: string
  created_at: string
  flagged_by_name: string | null
  resolved_at: string | null
  resolution_notes: string | null
}

// ── Scenario helpers ───────────────────────────────────────────────────────────
// Scenario doubles as the flag reason + severity; red scenarios are the urgent ones.

const SCENARIOS: Record<string, string> = {
  unreachable:         'Unreachable',
  legal_threat:        'Legal Threat',
  dispute:             'Dispute',
  employer_terminated: 'Employer Terminated',
  property_risk:       'Property Risk',
  other:               'Other',
}

const SCENARIO_COLORS: Record<string, string> = {
  unreachable:         AMBER,
  legal_threat:        RED,
  dispute:             AMBER,
  employer_terminated: RED,
  property_risk:       RED,
  other:               'var(--txt3)',
}

// Resolve a scenario code to a display label + accent, tolerant of unknown codes.
function scenarioMeta(code: string): { label: string; color: string; bg: string } {
  const label = SCENARIOS[code] ?? code
  const color = SCENARIO_COLORS[code] ?? 'var(--txt3)'
  const bg = color.startsWith('var(') ? 'var(--chip-bg)' : `${color}18`
  return { label, color, bg }
}

// ── Status helpers ─────────────────────────────────────────────────────────────
// StatusBadge auto-maps by lowercased label — feed it the friendly label so
// 'escalated_to_recovery' lands on the purple "escalated" swatch, not raw grey.

const STATUS_LABELS: Record<string, string> = {
  active:                 'Active',
  resolved:               'Resolved',
  escalated_to_recovery:  'Escalated',
}

const STATUS_FILTERS: { value: string; label: string; color: string }[] = [
  { value: 'active',                label: 'Active',    color: BLUE },
  { value: 'resolved',              label: 'Resolved',  color: GREEN },
  { value: 'escalated_to_recovery', label: 'Escalated', color: PURPLE },
]

// ── Add-to-watchlist modal ─────────────────────────────────────────────────────

function AddModal({ open, onClose, onDone }: {
  open: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [cif,         setCif]         = useState('')
  const [scenario,    setScenario]    = useState('unreachable')
  const [notes,       setNotes]       = useState('')
  const [dpd,         setDpd]         = useState('')
  const [outstanding, setOutstanding] = useState('')
  const [saving,      setSaving]      = useState(false)
  const [addErr,      setAddErr]      = useState<string | null>(null)

  // Wipe the form each time the dialog reopens.
  useEffect(() => {
    if (!open) return
    setCif(''); setScenario('unreachable'); setNotes('')
    setDpd(''); setOutstanding(''); setAddErr(null)
  }, [open])

  async function submit() {
    if (!cif.trim()) { setAddErr('CIF is required'); return }
    setSaving(true)
    setAddErr(null)
    try {
      await apiPost('/api/collections/watchlist', {
        account_cif:      cif.trim(),
        scenario,
        notes,
        dpd_at_flag:      Number(dpd) || 0,
        outstanding_kobo: Number(outstanding) || 0,
      })
      toast.success('Added to watchlist')
      onDone()
    } catch (e: any) {
      setAddErr(e.message ?? 'Failed to add flag')
    } finally {
      setSaving(false)
    }
  }

  const field = { ...filterInputStyle, width: '100%', height: 38, boxSizing: 'border-box' as const }
  const lbl = { fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add to Watchlist"
      width={460}
      footer={
        <>
          <button onClick={onClose} style={{
            padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)',
            background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, fontWeight: FW.medium, cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{
            padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff',
            fontSize: TEXT.base, fontWeight: FW.bold, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1,
            display: 'inline-flex', alignItems: 'center', gap: 8,
          }}>
            {saving && <Spinner size={14} color="#fff" />}
            Add Flag
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
        <ErrBanner error={addErr} />
        <div>
          <label style={lbl}>Account CIF</label>
          <input value={cif} onChange={e => setCif(e.target.value)} placeholder="e.g. 21013" style={field} />
        </div>
        <div>
          <label style={lbl}>Scenario</label>
          <select value={scenario} onChange={e => setScenario(e.target.value)} style={field}>
            {Object.entries(SCENARIOS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
          <div>
            <label style={lbl}>DPD at Flag</label>
            <input type="number" value={dpd} onChange={e => setDpd(e.target.value)} placeholder="0" style={field} />
          </div>
          <div>
            <label style={lbl}>Outstanding (kobo)</label>
            <input type="number" value={outstanding} onChange={e => setOutstanding(e.target.value)} placeholder="0" style={field} />
          </div>
        </div>
        <div>
          <label style={lbl}>Notes</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={3}
            placeholder="Why is this account being flagged?"
            style={{ ...field, height: 'auto', resize: 'vertical' }}
          />
        </div>
      </div>
    </Modal>
  )
}

// ── Resolve modal ──────────────────────────────────────────────────────────────

function ResolveModal({ entry, onClose, onDone }: {
  entry: WatchlistEntry | null
  onClose: () => void
  onDone: () => void
}) {
  const [notes,      setNotes]      = useState('')
  const [saving,     setSaving]     = useState(false)
  const [resolveErr, setResolveErr] = useState<string | null>(null)

  useEffect(() => { if (!entry) { setNotes(''); setResolveErr(null) } }, [entry])

  async function doResolve(status: 'resolved' | 'escalated') {
    if (!entry) return
    setSaving(true)
    setResolveErr(null)
    try {
      await apiPut(`/api/collections/watchlist/${entry.id}/resolve`, { status, resolution_notes: notes })
      toast.success(status === 'resolved' ? 'Marked as resolved' : 'Escalated to Recovery')
      onDone()
    } catch (e: any) {
      setResolveErr(e.message ?? 'Failed to update entry')
    } finally {
      setSaving(false)
    }
  }

  const meta = entry ? scenarioMeta(entry.scenario) : null

  return (
    <Modal open={!!entry} onClose={onClose} title={`Resolve · ${entry?.account_cif ?? ''}`} width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
        <ErrBanner error={resolveErr} />
        {meta && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: TEXT.sm, color: 'var(--txt2)' }}>
            <span>Scenario:</span>
            <Pill label={meta.label} color={meta.color} bg={meta.bg} />
          </div>
        )}
        <div>
          <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
            Resolution Notes
          </label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={3}
            placeholder="Add resolution notes…"
            style={{
              ...filterInputStyle, width: '100%', height: 'auto', padding: '8px 10px',
              boxSizing: 'border-box' as const, resize: 'vertical' as const,
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: SP[2] }}>
          <button
            onClick={() => doResolve('resolved')}
            disabled={saving}
            style={{
              flex: 1, padding: '8px 14px', borderRadius: RADIUS.md, border: 'none',
              background: GREEN, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold,
              cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}
          >
            {saving && <Spinner size={13} color="#fff" />}
            Mark Resolved
          </button>
          <button
            onClick={() => doResolve('escalated')}
            disabled={saving}
            style={{
              flex: 1, padding: '8px 14px', borderRadius: RADIUS.md, border: 'none',
              background: RED, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold,
              cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}
          >
            {saving && <Spinner size={13} color="#fff" />}
            Escalate to Recovery
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Watchlist() {
  const navigate = useNavigate()
  const [entries,      setEntries]      = useState<WatchlistEntry[]>([])
  const [loading,      setLoading]      = useState(true)
  const [err,          setErr]          = useState<string | null>(null)
  const [showAdd,      setShowAdd]      = useState(false)
  const [resolveEntry, setResolveEntry] = useState<WatchlistEntry | null>(null)

  // Filter state (client-side — ExpandableFilterBar drives all three).
  const [search,     setSearch]     = useState('')
  const [fScenarios, setFScenarios] = useState(new Set<string>())
  const [fStatuses,  setFStatuses]  = useState(new Set<string>())

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setErr(null)
    try {
      const res = await apiFetch<{ data: WatchlistEntry[] }>('/api/collections/watchlist?status=all')
      setEntries(res.data ?? [])
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load watchlist')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['collections', 'loans'] })

  // ── KPIs (derived client-side — no dedicated KPI endpoint) ────────────────────

  const kpis = useMemo(() => {
    const now = Date.now()
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()
    const active = entries.filter(e => e.status === 'active')
    const atRiskKobo = active.reduce((s, e) => s + (e.outstanding_kobo ?? 0), 0)
    const resolvedMonth = entries.filter(e =>
      e.status === 'resolved' && e.resolved_at && new Date(e.resolved_at).getTime() >= monthStart
    ).length
    const oldestDays = active.length
      ? Math.max(...active.map(e => Math.floor((now - new Date(e.created_at).getTime()) / 86_400_000)))
      : null
    return { activeCount: active.length, atRiskKobo, resolvedMonth, oldestDays }
  }, [entries])

  // ── Filtering ─────────────────────────────────────────────────────────────────

  const displayed = useMemo(() => entries.filter(e => {
    if (fScenarios.size && !fScenarios.has(e.scenario)) return false
    if (fStatuses.size && !fStatuses.has(e.status)) return false
    if (search.trim()) {
      const q = search.toLowerCase()
      return (e.account_cif ?? '').toLowerCase().includes(q)
        || scenarioMeta(e.scenario).label.toLowerCase().includes(q)
        || (e.flagged_by_name ?? '').toLowerCase().includes(q)
        || (e.notes ?? '').toLowerCase().includes(q)
    }
    return true
  }), [entries, search, fScenarios, fStatuses])

  // ── Columns ───────────────────────────────────────────────────────────────────

  const cols: TableCol<WatchlistEntry>[] = useMemo(() => [
    {
      key: 'account_cif', label: 'CIF',
      render: r => (
        <span style={{ ...NUM, fontWeight: FW.bold, color: NAVY, fontSize: TEXT.sm }}>
          {r.account_cif}
        </span>
      ),
    },
    {
      key: 'scenario', label: 'Reason',
      render: r => { const m = scenarioMeta(r.scenario); return <Pill label={m.label} color={m.color} bg={m.bg} /> },
    },
    {
      key: 'dpd_at_flag', label: 'DPD at Flag', align: 'right',
      render: r => {
        if (r.dpd_at_flag === null) return <span style={{ color: 'var(--txt3)' }}>—</span>
        const color = r.dpd_at_flag <= 30 ? AMBER : RED
        return <span style={{ ...NUM, fontWeight: FW.bold, color, fontSize: TEXT.sm }}>{r.dpd_at_flag}d</span>
      },
    },
    {
      key: 'outstanding_kobo', label: 'Outstanding', align: 'right',
      render: r => (
        <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
          {r.outstanding_kobo !== null ? fmtKoboExact(r.outstanding_kobo) : '—'}
        </span>
      ),
    },
    {
      key: 'status', label: 'Status',
      render: r => <StatusBadge status={STATUS_LABELS[r.status] ?? r.status} />,
    },
    {
      key: 'notes', label: 'Notes', sortable: false,
      render: r => r.notes ? (
        <span style={{
          fontSize: TEXT.sm, color: 'var(--txt2)', maxWidth: 200, display: 'block',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{r.notes}</span>
      ) : <span style={{ color: 'var(--txt3)', fontSize: TEXT.sm }}>—</span>,
    },
    {
      key: 'flagged_by_name', label: 'Flagged By',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.flagged_by_name ?? '—'}</span>,
    },
    {
      key: 'created_at', label: 'Flagged', sortable: true,
      render: r => (
        <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtDate(r.created_at)}</span>
      ),
    },
    {
      key: '_action', label: '', sortable: false,
      render: r => r.status === 'active' ? (
        <button
          onClick={e => { e.stopPropagation(); setResolveEntry(r) }}
          style={{
            padding: '3px 10px', borderRadius: RADIUS.sm,
            border: `1px solid ${NAVY}30`, background: `${NAVY}08`,
            color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold,
            cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >Resolve</button>
      ) : null,
    },
  ], [])

  return (
    <Page
      title="Watchlist"
      subtitle="Accounts flagged for escalation monitoring"
      loading={loading && entries.length === 0}
      skeletonKpis={4}
      actions={
        <button onClick={() => setShowAdd(true)} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: RADIUS.lg,
          border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: 'pointer',
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>add</span>
          Add to Watchlist
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginBottom: 20 }}>
        <KpiCard label="Active Flags"         value={loading ? '—' : fmtNum(kpis.activeCount)}   icon="flag"            accent={RED}   loading={loading} />
        <KpiCard label="At-Risk Value"        value={loading ? '—' : fmtKoboExact(kpis.atRiskKobo)}   icon="payments"        accent={NAVY}  loading={loading} />
        <KpiCard label="Resolved This Month"  value={loading ? '—' : fmtNum(kpis.resolvedMonth)} icon="check_circle"    accent={GREEN} loading={loading} />
        <KpiCard label="Oldest Open Flag"     value={loading ? '—' : (kpis.oldestDays === null ? '—' : `${fmtNum(kpis.oldestDays)}d`)} icon="schedule" accent={AMBER} loading={loading} />
      </div>

      <SectionCard title="Flagged Accounts" badge={displayed.length} padding={false}>
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={[
            {
              key: 'scenario',
              label: 'Reason',
              options: Object.entries(SCENARIOS).map(([v, l]) => ({ value: v, label: l, color: SCENARIO_COLORS[v]?.startsWith('var(') ? undefined : SCENARIO_COLORS[v] })),
              selected: fScenarios,
              onChange: setFScenarios,
            },
            {
              key: 'status',
              label: 'Status',
              options: STATUS_FILTERS.map(s => ({ value: s.value, label: s.label, color: s.color })),
              selected: fStatuses,
              onChange: setFStatuses,
            },
          ] as FilterGroupDef[]}
          onReset={() => { setSearch(''); setFScenarios(new Set()); setFStatuses(new Set()) }}
          resultCount={displayed.length}
          totalCount={entries.length}
          placeholder="Search CIF, reason, agent…"
        />
        <DataTable
          cols={cols}
          rows={displayed}
          keyFn={r => r.id}
          onRowClick={r => { if (r.account_cif) navigate(`/collections/accounts/${r.account_cif}`) }}
          loading={loading}
          skeletonRows={8}
          emptyText="No watchlist entries found"
          pageSize={25}
        />
      </SectionCard>

      <AddModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onDone={() => { setShowAdd(false); load() }}
      />
      <ResolveModal
        entry={resolveEntry}
        onClose={() => setResolveEntry(null)}
        onDone={() => { setResolveEntry(null); load() }}
      />
    </Page>
  )
}
