import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Page, SectionCard, KpiCard, DataTable, ErrBanner, Modal, Spinner,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPut } from '../../lib/api'
import { fmtDate, fmtKobo } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, TEXT, FW, RADIUS, NUM } from '../../lib/design'
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

function ScenarioBadge({ scenario }: { scenario: string }) {
  const label = SCENARIOS[scenario] ?? scenario
  const color = SCENARIO_COLORS[scenario] ?? 'var(--txt3)'
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.semibold,
      padding: '2px 8px', borderRadius: RADIUS['2xl'],
      background: color === 'var(--txt3)' ? 'var(--chip-bg)' : `${color}18`,
      color, whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

// ── Action badge / module badge (copied from spec) ────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  watchlist_flagged:   'Watchlist Flagged',
  watchlist_resolved:  'Watchlist Resolved',
  sent_to_recovery:    'Sent to Recovery',
}

// ── Status tab bar ─────────────────────────────────────────────────────────────

const STATUS_TABS = [
  { key: 'all',       label: 'All' },
  { key: 'active',    label: 'Active' },
  { key: 'resolved',  label: 'Resolved' },
  { key: 'escalated', label: 'Escalated' },
]

// ── Resolve modal ──────────────────────────────────────────────────────────────

function ResolveModal({
  entry, onClose, onDone,
}: {
  entry: WatchlistEntry | null
  onClose: () => void
  onDone: () => void
}) {
  const [notes,    setNotes]    = useState('')
  const [saving,   setSaving]   = useState(false)
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

  const fieldStyle = {
    width: '100%', padding: '8px 10px',
    border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
    fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box' as const,
    resize: 'vertical' as const,
  }

  return (
    <Modal open={!!entry} onClose={onClose} title={`Resolve — ${entry?.account_cif ?? ''}`} width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ErrBanner error={resolveErr} />
        {entry && (
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', display: 'flex', gap: 8 }}>
            <span>Scenario:</span>
            <ScenarioBadge scenario={entry.scenario} />
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
            style={fieldStyle}
          />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
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
  const [entries,    setEntries]    = useState<WatchlistEntry[]>([])
  const [loading,    setLoading]    = useState(true)
  const [err,        setErr]        = useState<string | null>(null)
  const [statusTab,  setStatusTab]  = useState('all')
  const [resolveEntry, setResolveEntry] = useState<WatchlistEntry | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
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
  useLiveData(load, { topics: ['collections','loans'] })

  // ── KPIs ──────────────────────────────────────────────────────────────────────

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()

  const activeCount    = entries.filter(e => e.status === 'active').length
  const resolvedMonth  = entries.filter(e =>
    e.status === 'resolved' && e.resolved_at && new Date(e.resolved_at).getTime() >= monthStart
  ).length
  const escalatedCount = entries.filter(e => e.status === 'escalated_to_recovery').length

  // ── Filter ────────────────────────────────────────────────────────────────────

  const displayed = useMemo(() => {
    if (statusTab === 'all') return entries
    return entries.filter(e => e.status === statusTab)
  }, [entries, statusTab])

  // ── Columns ───────────────────────────────────────────────────────────────────

  const cols: TableCol<WatchlistEntry>[] = [
    {
      key: 'account_cif', label: 'CIF',
      render: r => (
        <span style={{ ...NUM, fontWeight: FW.bold, color: NAVY, fontSize: TEXT.sm }}>
          {r.account_cif}
        </span>
      ),
    },
    {
      key: 'scenario', label: 'Scenario',
      render: r => <ScenarioBadge scenario={r.scenario} />,
    },
    {
      key: 'dpd_at_flag', label: 'DPD at Flag',
      render: r => {
        if (r.dpd_at_flag === null) return <span style={{ color: 'var(--txt3)' }}>—</span>
        const color = r.dpd_at_flag <= 30 ? AMBER : RED
        return <span style={{ ...NUM, fontWeight: FW.bold, color, fontSize: TEXT.sm }}>{r.dpd_at_flag}d</span>
      },
    },
    {
      key: 'outstanding_kobo', label: 'Outstanding',
      render: r => (
        <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
          {r.outstanding_kobo !== null ? fmtKobo(r.outstanding_kobo) : '—'}
        </span>
      ),
    },
    {
      key: 'notes', label: 'Notes',
      render: r => r.notes ? (
        <span style={{
          fontSize: TEXT.sm, color: 'var(--txt2)',
          maxWidth: 200, display: 'block',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {r.notes}
        </span>
      ) : <span style={{ color: 'var(--txt3)', fontSize: TEXT.sm }}>—</span>,
    },
    {
      key: 'flagged_by_name', label: 'Flagged By',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.flagged_by_name ?? '—'}</span>,
    },
    {
      key: 'created_at', label: 'Date Flagged',
      render: r => (
        <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>
          {fmtDate(r.created_at)}
        </span>
      ),
    },
    {
      key: '_action', label: '',
      render: r => r.status === 'active' ? (
        <button
          onClick={e => { e.stopPropagation(); setResolveEntry(r) }}
          style={{
            padding: '3px 10px', borderRadius: RADIUS.sm,
            border: `1px solid ${NAVY}30`, background: `${NAVY}08`,
            color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold,
            cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          Resolve
        </button>
      ) : null,
    },
  ]

  return (
    <Page title="Watchlist" subtitle="Accounts flagged for escalation monitoring">

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 20 }}>
        <KpiCard label="Active Flags"         value={loading ? '—' : activeCount}    icon="flag"             accent={RED}   loading={loading} />
        <KpiCard label="Resolved This Month"  value={loading ? '—' : resolvedMonth}  icon="check_circle"     accent={GREEN} loading={loading} />
        <KpiCard label="Escalated to Recovery" value={loading ? '—' : escalatedCount} icon="assignment_late" accent={AMBER} loading={loading} />
      </div>

      <SectionCard padding={false}>

        {/* Status tabs */}
        <div style={{ display: 'flex', gap: 2, padding: '0 18px', borderBottom: '1px solid var(--bdr)' }}>
          {STATUS_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setStatusTab(tab.key)}
              style={{
                padding: '10px 14px', fontSize: TEXT.sm,
                fontWeight: statusTab === tab.key ? FW.semibold : FW.normal,
                color: statusTab === tab.key ? 'var(--txt)' : 'var(--txt2)',
                background: 'none', border: 'none', cursor: 'pointer',
                borderBottom: statusTab === tab.key ? `2px solid ${RED}` : '2px solid transparent',
                marginBottom: -1, transition: 'color 120ms, border-color 120ms',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {err && (
          <div style={{ padding: '12px 18px' }}>
            <ErrBanner error={err} onRetry={load} />
          </div>
        )}

        <DataTable
          cols={cols}
          rows={displayed}
          keyFn={r => r.id}
          loading={loading}
          skeletonRows={8}
          emptyText="No watchlist entries found"
          searchKeys={['account_cif', 'scenario', 'flagged_by_name', 'notes']}
          searchPlaceholder="Search CIF, scenario, agent…"
          pageSize={25}
        />
      </SectionCard>

      {/* Resolve modal */}
      <ResolveModal
        entry={resolveEntry}
        onClose={() => setResolveEntry(null)}
        onDone={() => { setResolveEntry(null); load() }}
      />
    </Page>
  )
}
