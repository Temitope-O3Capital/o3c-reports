import { useEffect, useState, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import {
  Page, SectionCard, DataTable, ErrBanner, Spinner, Modal,
  ExpandableFilterBar, NameCell,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { RED, AMBER, GREEN, NAVY, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PortfolioRow {
  loan_id: number
  applicant_cif: string
  loan_status: string
  dpd_bucket: string | null
  dpd_lower: number
  outstanding_kobo: number
  current_stage: string | null
  agent_name: string | null
  watchlist_id: number | null
  watchlist_scenario: string | null
}

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

type WatchlistModal =
  | { type: 'add'; row: PortfolioRow }
  | { type: 'resolve'; entry: WatchlistEntry }
  | null

const SCENARIOS = [
  { value: 'unreachable',          label: 'Unreachable' },
  { value: 'legal_threat',         label: 'Legal Threat' },
  { value: 'dispute',              label: 'Dispute' },
  { value: 'employer_terminated',  label: 'Employer Terminated' },
  { value: 'property_risk',        label: 'Property Risk' },
  { value: 'other',                label: 'Other' },
]

const RESOLVE_STATUSES = [
  { value: 'resolved',               label: 'Mark Resolved' },
  { value: 'escalated_to_recovery',  label: 'Escalate to Recovery' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function dpdColor(dpd: number): string {
  if (dpd > 90) return RED
  if (dpd > 60) return '#EA580C'
  if (dpd > 30) return AMBER
  return GREEN
}

function DpdBadge({ dpd, bucket }: { dpd: number; bucket: string | null }) {
  const color = dpdColor(dpd)
  return (
    <span style={{
      ...NUM, fontSize: TEXT.xs, fontWeight: FW.bold,
      padding: '2px 8px', borderRadius: RADIUS['2xl'],
      background: `${color}18`, color, whiteSpace: 'nowrap',
    }}>
      {bucket ?? '0d'}
    </span>
  )
}

function TerritoryBadge({ dpd }: { dpd: number }) {
  const isRecovery = dpd > 90
  const color = isRecovery ? RED : NAVY
  const label = isRecovery ? 'Recovery' : 'Collections'
  return (
    <span style={{
      fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.03em',
      padding: '2px 7px', borderRadius: RADIUS['2xl'],
      background: `${color}12`, color, whiteSpace: 'nowrap',
      textTransform: 'uppercase',
    }}>
      {label}
    </span>
  )
}

function WatchlistBadge({ scenario }: { scenario: string | null }) {
  if (!scenario) return null
  const label = SCENARIOS.find(s => s.value === scenario)?.label ?? scenario
  return (
    <span style={{
      fontSize: TEXT['2xs'], fontWeight: FW.semibold,
      padding: '2px 8px', borderRadius: RADIUS['2xl'],
      background: `${AMBER}18`, color: AMBER,
      display: 'inline-flex', alignItems: 'center', gap: 4,
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: 11 }}>flag</span>
      {label}
    </span>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CollectionsPortfolio() {
  const [rows, setRows]           = useState<PortfolioRow[]>([])
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [tab, setTab]             = useState<'all' | 'collections' | 'recovery' | 'watchlist'>('all')
  const [search, setSearch]       = useState('')
  const [modal, setModal]         = useState<WatchlistModal>(null)

  // Add-to-watchlist form state
  const [wlScenario, setWlScenario]   = useState('unreachable')
  const [wlNotes, setWlNotes]         = useState('')
  const [wlSaving, setWlSaving]       = useState(false)

  // Resolve-watchlist form state
  const [rvStatus, setRvStatus]       = useState('resolved')
  const [rvNotes, setRvNotes]         = useState('')
  const [rvSaving, setRvSaving]       = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [portRes, wlRes] = await Promise.all([
        apiFetch<{ data: PortfolioRow[] }>('/api/collections/portfolio'),
        apiFetch<{ data: WatchlistEntry[] }>('/api/collections/watchlist?status=active'),
      ])
      setRows(portRes.data ?? [])
      setWatchlist(wlRes.data ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const displayed = useMemo(() => {
    let base = rows
    if (tab === 'collections') base = rows.filter(r => r.dpd_lower <= 90)
    if (tab === 'recovery')    base = rows.filter(r => r.dpd_lower > 90)
    if (tab === 'watchlist')   base = rows.filter(r => r.watchlist_id != null)
    if (!search.trim()) return base
    const q = search.toLowerCase()
    return base.filter(r =>
      [r.applicant_cif, r.agent_name, r.dpd_bucket, r.current_stage].some(
        v => v != null && String(v).toLowerCase().includes(q)
      )
    )
  }, [rows, tab, search])

  const collCount = rows.filter(r => r.dpd_lower <= 90).length
  const recCount  = rows.filter(r => r.dpd_lower > 90).length
  const wlCount   = rows.filter(r => r.watchlist_id != null).length

  async function handleAddWatchlist() {
    if (!modal || modal.type !== 'add') return
    setWlSaving(true)
    try {
      await apiPost('/api/collections/watchlist', {
        account_cif: modal.row.applicant_cif,
        scenario: wlScenario,
        notes: wlNotes,
        dpd_at_flag: modal.row.dpd_lower,
        outstanding_kobo: modal.row.outstanding_kobo,
      })
      toast.success('Added to watchlist')
      setModal(null)
      setWlNotes('')
      setWlScenario('unreachable')
      load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setWlSaving(false)
    }
  }

  async function handleResolve() {
    if (!modal || modal.type !== 'resolve') return
    setRvSaving(true)
    try {
      await apiPut(`/api/collections/watchlist/${modal.entry.id}/resolve`, {
        status: rvStatus,
        resolution_notes: rvNotes,
      })
      toast.success(rvStatus === 'resolved' ? 'Marked resolved' : 'Escalated to recovery')
      setModal(null)
      setRvNotes('')
      setRvStatus('resolved')
      load()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setRvSaving(false)
    }
  }

  const TABS: { key: typeof tab; label: string; count: number }[] = [
    { key: 'all',         label: 'All',         count: rows.length },
    { key: 'collections', label: 'Collections', count: collCount },
    { key: 'recovery',    label: 'Recovery',    count: recCount },
    { key: 'watchlist',   label: 'Watchlist',   count: wlCount },
  ]

  const portfolioCols: TableCol<PortfolioRow>[] = [
    {
      key: 'applicant_cif', label: 'CIF',
      render: r => (
        <NameCell
          name={r.applicant_cif}
          sub={r.watchlist_scenario ? <WatchlistBadge scenario={r.watchlist_scenario} /> as any : null}
        />
      ),
    },
    {
      key: 'dpd_bucket', label: 'DPD',
      render: r => <DpdBadge dpd={r.dpd_lower} bucket={r.dpd_bucket} />,
    },
    {
      key: 'outstanding_kobo', label: 'Outstanding', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: r.dpd_lower > 90 ? RED : 'var(--txt)' }}>{fmtKobo(r.outstanding_kobo)}</span>,
    },
    {
      key: 'current_stage', label: 'Stage',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.current_stage ?? '—'}</span>,
    },
    {
      key: 'agent_name', label: 'Agent',
      render: r => <span style={{ fontSize: TEXT.sm }}>{r.agent_name ?? '—'}</span>,
    },
    {
      key: 'loan_status', label: 'Territory',
      render: r => <TerritoryBadge dpd={r.dpd_lower} />,
    },
    {
      key: 'loan_id', label: '',
      render: r => (
        r.watchlist_id ? (
          <button
            onClick={e => {
              e.stopPropagation()
              const entry = watchlist.find(w => w.account_cif === r.applicant_cif)
              if (entry) { setModal({ type: 'resolve', entry }); setRvStatus('resolved'); setRvNotes('') }
              else { toast.error('Watchlist entry not found — try refreshing') }
            }}
            style={{
              padding: '4px 10px', borderRadius: RADIUS.sm, cursor: 'pointer',
              border: `1.5px solid ${AMBER}50`, background: `${AMBER}0C`, color: AMBER,
              fontSize: TEXT.xs, fontWeight: FW.semibold, whiteSpace: 'nowrap',
            }}
          >
            Resolve Flag
          </button>
        ) : (
          <button
            onClick={e => {
              e.stopPropagation()
              setModal({ type: 'add', row: r }); setWlScenario('unreachable'); setWlNotes('')
            }}
            style={{
              padding: '4px 10px', borderRadius: RADIUS.sm, cursor: 'pointer',
              border: `1.5px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY,
              fontSize: TEXT.xs, fontWeight: FW.semibold, whiteSpace: 'nowrap',
            }}
          >
            Add to Watchlist
          </button>
        )
      ),
    },
  ]

  const wlCols: TableCol<WatchlistEntry>[] = [
    {
      key: 'account_cif', label: 'CIF',
      render: r => <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.sm, fontWeight: FW.bold, color: NAVY }}>{r.account_cif}</span>,
    },
    {
      key: 'scenario', label: 'Scenario',
      render: r => <WatchlistBadge scenario={r.scenario} />,
    },
    {
      key: 'dpd_at_flag', label: 'DPD at Flag', align: 'right',
      render: r => r.dpd_at_flag != null ? <span style={{ ...NUM, color: dpdColor(r.dpd_at_flag) }}>{r.dpd_at_flag}d</span> : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'outstanding_kobo', label: 'Outstanding', align: 'right',
      render: r => <span style={NUM}>{r.outstanding_kobo != null ? fmtKobo(r.outstanding_kobo) : '—'}</span>,
    },
    {
      key: 'notes', label: 'Notes',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.notes ?? '—'}</span>,
    },
    {
      key: 'flagged_by_name', label: 'Flagged By',
      render: r => <span style={{ fontSize: TEXT.sm }}>{r.flagged_by_name ?? '—'}</span>,
    },
    {
      key: 'created_at', label: 'Date',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.created_at)}</span>,
    },
    {
      key: 'id', label: '',
      render: r => (
        <button
          onClick={e => { e.stopPropagation(); setModal({ type: 'resolve', entry: r }); setRvStatus('resolved'); setRvNotes('') }}
          style={{
            padding: '4px 10px', borderRadius: RADIUS.sm, cursor: 'pointer',
            border: `1.5px solid ${AMBER}50`, background: `${AMBER}0C`, color: AMBER,
            fontSize: TEXT.xs, fontWeight: FW.semibold, whiteSpace: 'nowrap',
          }}
        >
          Resolve
        </button>
      ),
    },
  ]

  const tabBar = (
    <div style={{ display: 'flex', gap: 2, padding: '8px 16px', borderBottom: '1px solid var(--bdr)' }}>
      {TABS.map(t => (
        <button
          key={t.key}
          onClick={() => setTab(t.key)}
          style={{
            padding: '5px 14px', borderRadius: RADIUS.md, cursor: 'pointer', fontFamily: 'inherit',
            fontSize: TEXT.sm, fontWeight: tab === t.key ? FW.semibold : FW.normal,
            border: tab === t.key ? `1.5px solid ${NAVY}` : '1.5px solid transparent',
            background: tab === t.key ? NAVY : 'transparent',
            color: tab === t.key ? '#fff' : 'var(--txt2)',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        >
          {t.label}
          <span style={{
            padding: '1px 6px', borderRadius: RADIUS.full, fontSize: TEXT.xs,
            background: tab === t.key ? 'rgba(255,255,255,0.2)' : 'var(--badge-bg)',
            color: tab === t.key ? '#fff' : 'var(--txt3)',
          }}>
            {t.count}
          </span>
        </button>
      ))}
    </div>
  )

  if (loading && rows.length === 0) return (
    <Page title="Collections Portfolio">
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
    </Page>
  )

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px',
    border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
    boxSizing: 'border-box',
  }

  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold,
    color: 'var(--txt2)', marginBottom: 6,
  }

  return (
    <Page
      title="Collections Portfolio"
      subtitle="All active loan accounts sorted by DPD — 0–90 days is Collections territory, 90+ is Recovery"
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Territory summary strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: SP[3], marginBottom: SP[4] }}>
        {[
          { label: 'Total Accounts',   value: rows.length,  color: NAVY, icon: 'people' },
          { label: 'Collections (0–90d)', value: collCount, color: GREEN, icon: 'collections_bookmark' },
          { label: 'Recovery (90d+)',   value: recCount,    color: RED,  icon: 'gavel' },
          { label: 'On Watchlist',      value: wlCount,     color: AMBER, icon: 'flag' },
        ].map(s => (
          <div key={s.label} style={{
            background: 'var(--card)', border: '1px solid var(--bdr)',
            borderRadius: RADIUS.lg, padding: `${SP[3]} ${SP[4]}`,
            display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: s.color }}>{s.icon}</span>
              <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)' }}>{s.label}</span>
            </div>
            <div style={{ fontSize: TEXT['3xl'], fontWeight: FW.extrabold, color: s.color, lineHeight: 1 }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Recovery territory separator when showing all */}
      {tab === 'all' && recCount > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, marginBottom: SP[3],
          padding: `${SP[2]} ${SP[3]}`, background: `${RED}08`,
          border: `1px solid ${RED}20`, borderRadius: RADIUS.md,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: RED }}>gavel</span>
          <span style={{ fontSize: TEXT.sm, color: RED, fontWeight: FW.semibold }}>
            {recCount} account{recCount !== 1 ? 's' : ''} above 90 DPD — in Recovery territory
          </span>
        </div>
      )}

      <SectionCard
        title={tab === 'watchlist' ? 'Watchlist' : 'Portfolio Accounts'}
        badge={tab === 'watchlist' ? watchlist.length : displayed.length}
        padding={false}
      >
        {tabBar}
        {tab !== 'watchlist' ? (
          <>
            <ExpandableFilterBar
              search={search}
              onSearch={setSearch}
              groups={[]}
              onReset={() => setSearch('')}
              resultCount={displayed.length}
              totalCount={tab === 'all' ? rows.length : tab === 'collections' ? collCount : recCount}
              placeholder="Search CIF, agent, stage…"
            />
            <DataTable
              cols={portfolioCols}
              rows={displayed}
              keyFn={r => r.loan_id}
              loading={loading}
              skeletonRows={10}
              pageSize={25}
              emptyText="No active loan accounts"
            />
          </>
        ) : (
          <DataTable
            cols={wlCols}
            rows={watchlist}
            keyFn={r => r.id}
            loading={loading}
            skeletonRows={5}
            pageSize={20}
            searchKeys={['account_cif', 'scenario', 'notes', 'flagged_by_name']}
            searchPlaceholder="Search CIF, scenario, notes…"
            emptyText="No accounts on watchlist"
          />
        )}
      </SectionCard>

      {/* Add to Watchlist Modal */}
      <Modal
        open={modal?.type === 'add'}
        onClose={() => setModal(null)}
        title={`Flag for Watchlist — ${modal?.type === 'add' ? modal.row.applicant_cif : ''}`}
        width={460}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleAddWatchlist}
              disabled={wlSaving}
              style={{
                padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none',
                background: AMBER, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold,
                cursor: wlSaving ? 'wait' : 'pointer', opacity: wlSaving ? 0.7 : 1,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              {wlSaving && <Spinner size={13} color="#fff" />}
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>flag</span>
              Add to Watchlist
            </button>
            <button
              onClick={() => setModal(null)}
              style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>Scenario</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {SCENARIOS.map(s => (
                <button
                  key={s.value}
                  onClick={() => setWlScenario(s.value)}
                  style={{
                    padding: '5px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
                    border: `1.5px solid ${wlScenario === s.value ? AMBER : 'var(--bdr)'}`,
                    background: wlScenario === s.value ? AMBER : 'var(--card)',
                    color: wlScenario === s.value ? '#fff' : 'var(--txt)',
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={labelStyle}>Notes <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span></label>
            <textarea
              value={wlNotes}
              onChange={e => setWlNotes(e.target.value)}
              rows={3}
              placeholder="Describe why this account is being flagged…"
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </div>
        </div>
      </Modal>

      {/* Resolve Watchlist Modal */}
      <Modal
        open={modal?.type === 'resolve'}
        onClose={() => setModal(null)}
        title={`Resolve Flag — ${modal?.type === 'resolve' ? modal.entry.account_cif : ''}`}
        width={440}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleResolve}
              disabled={rvSaving}
              style={{
                padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none',
                background: rvStatus === 'resolved' ? GREEN : RED,
                color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold,
                cursor: rvSaving ? 'wait' : 'pointer', opacity: rvSaving ? 0.7 : 1,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              {rvSaving && <Spinner size={13} color="#fff" />}
              Confirm
            </button>
            <button
              onClick={() => setModal(null)}
              style={{ padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>Action</label>
            <div style={{ display: 'flex', gap: 7 }}>
              {RESOLVE_STATUSES.map(s => (
                <button
                  key={s.value}
                  onClick={() => setRvStatus(s.value)}
                  style={{
                    flex: 1, padding: '8px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
                    border: `1.5px solid ${rvStatus === s.value ? (s.value === 'resolved' ? GREEN : RED) : 'var(--bdr)'}`,
                    background: rvStatus === s.value ? (s.value === 'resolved' ? GREEN : RED) : 'var(--card)',
                    color: rvStatus === s.value ? '#fff' : 'var(--txt)',
                  }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={labelStyle}>Notes <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span></label>
            <textarea
              value={rvNotes}
              onChange={e => setRvNotes(e.target.value)}
              rows={3}
              placeholder="Resolution notes…"
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </div>
        </div>
      </Modal>
    </Page>
  )
}
