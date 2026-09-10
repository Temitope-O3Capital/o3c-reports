import { useLiveData } from "../../hooks/useRealtime"
import { useDebouncedValue } from '../../hooks/useDebounce'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Page, SectionCard, KpiCard, DataTable, ErrBanner, Spinner,
  Modal, ExpandableFilterBar, NameCell,
} from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKoboExact, fmtNum, fmtPct, fmtDate } from '../../lib/fmt'
import { RED, AMBER, GREEN, NAVY, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { TierBadge, PctBar } from '../../components/TierBadge'
import { isInternalId } from '../../components/CreditFile'

function getStoredRole(): string {
  try { return (JSON.parse(localStorage.getItem('o3c_user') ?? 'null') as { role?: string } | null)?.role ?? '' } catch { return '' }
}

// ── Types ─────────────────────────────────────────────────────────────────────
// One row per FACILITY (each card / each loan), so the credit terms are exact.
interface PortfolioRow {
  applicant_cif: string
  reference: string
  source: 'card' | 'loan'
  origin: string                       // 'Udara' (core) | 'Uploaded' (manual)
  customer_name: string | null
  product_name: string | null
  facility_status: string | null      // the card/loan status on its own system
  superseded: boolean                 // same debt also booked in Udara — do not double-count
  dpd_bucket: string | null
  dpd_lower: number
  outstanding_kobo: number
  loc_kobo: number
  min_repayment_kobo: number
  amount_paid_kobo: number
  pct_paid: number
  tier: string
  assignment_id: number | null
  agent_name: string | null            // assigned collections officer
  current_stage: string | null
  last_call_agent: string | null       // last call-centre agent to dial this customer
  last_call_at: string | null
  last_call_disposition: string | null
}

// PAR-based snapshot from /api/collections/portfolio-kpis (as-of-now, no date filter).
interface PortfolioKpis {
  par30_kobo: number
  par60_kobo: number
  par90_kobo: number
  total_outstanding_kobo: number
  total_accounts: number
  delinquent_accounts: number
  current_rate_pct: number
}

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
    <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${color}18`, color, whiteSpace: 'nowrap' }}>
      {bucket ?? '0d'}
    </span>
  )
}

function TerritoryBadge({ dpd }: { dpd: number }) {
  const isRecovery = dpd > 90
  const color = isRecovery ? RED : NAVY
  return (
    <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.04em', padding: '2px 7px', borderRadius: RADIUS['2xl'], background: `${color}12`, color, whiteSpace: 'nowrap', textTransform: 'uppercase' }}>
      {isRecovery ? 'Recovery' : 'Collections'}
    </span>
  )
}

function SourceChip({ source }: { source: string }) {
  const isCard = source === 'card'
  const color = isCard ? PURPLE : NAVY
  return (
    <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '1px 6px', borderRadius: RADIUS.sm, background: `${color}14`, color, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
      {isCard ? 'Card' : 'Loan'}
    </span>
  )
}

// Provenance: which system the facility came from — CCS (cards), Udara (loans) or a
// manual spreadsheet upload.
const ORIGIN_META: Record<string, { color: string; title: string }> = {
  CCS:      { color: BLUE,  title: 'From the CCS card system' },
  Udara:    { color: GREEN, title: 'From the Udara core banking system' },
  Uploaded: { color: AMBER, title: 'Uploaded from a spreadsheet' },
}
// Statuses that mean the facility is no longer live on its own system. A balance can
// still sit behind one, which is why they stay in the book — but an officer needs to
// know the card is dead before promising the customer anything.
const DEAD_STATUS = new Set(['TERMINATED', 'CLOSED', 'LEGAL ACTION', 'HOT', 'SUSPENDED', 'INACTIVE'])

function OriginChip({ origin }: { origin: string }) {
  const meta = ORIGIN_META[origin] ?? { color: NAVY, title: origin }
  return (
    <span title={meta.title}
      style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '1px 7px', borderRadius: RADIUS['2xl'], background: `${meta.color}18`, color: meta.color, whiteSpace: 'nowrap' }}>
      {origin || '—'}
    </span>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CollectionsPortfolio() {
  const navigate = useNavigate()
  const role = getStoredRole()
  const isHead = ['collections_head', 'head_collections', 'admin', 'management', 'md', 'coo'].includes(role)

  const [rows, setRows]           = useState<PortfolioRow[]>([])
  const [kpis, setKpis]           = useState<PortfolioKpis | null>(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)
  const [search, setSearch]       = useState('')
  const [checkedIds, setCheckedIds] = useState<Set<string | number>>(new Set())

  // Client-side refinement on top of the server search: book segment, product line,
  // DPD bucket + stage — all four live side by side in the filter bar.
  const [fBook, setFBook]   = useState<Set<string>>(new Set())
  const [fDpd, setFDpd]     = useState<Set<string>>(new Set())
  const [fStage, setFStage] = useState<Set<string>>(new Set())
  const [fProduct, setFProduct] = useState<Set<string>>(new Set())
  const [fSource, setFSource] = useState<Set<string>>(new Set())
  // The work list is what is owed. Settled and closed facilities are still one
  // click away — 5,076 of 6,487 card rows owe nothing and used to bury the list.
  const [scope, setScope] = useState<'owing' | 'all'>('owing')

  // Bulk actions (head only)
  const [agents, setAgents]         = useState<{ id: number; full_name: string; role: string }[]>([])
  const [bulkModal, setBulkModal]   = useState<'assign' | null>(null)
  const [bulkAgentId, setBulkAgentId] = useState('')
  const [bulkSaving, setBulkSaving] = useState(false)

  const dq = useDebouncedValue(search, 300)
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setError(null)
    try {
      const qs = new URLSearchParams()
      if (dq.trim()) qs.set('q', dq.trim())
      if (scope === 'all') qs.set('scope', 'all')
      const portUrl = qs.toString() ? `/api/collections/portfolio?${qs}` : '/api/collections/portfolio'
      const [portRes, kpiRes] = await Promise.all([
        apiFetch<{ data: PortfolioRow[] }>(portUrl),
        apiFetch<PortfolioKpis>('/api/collections/portfolio-kpis'),
      ])
      setRows(portRes.data ?? [])
      setKpis(kpiRes ?? null)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dq, scope])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['collections','loans'] })

  // Collection agents for the bulk-assign picker.
  useEffect(() => {
    if (!isHead) return
    apiFetch<{ data: { id: number; full_name: string; role: string }[] }>('/api/admin/users')
      .then(r => setAgents((r.data ?? []).filter(u =>
        u.role.includes('collection') || u.role.includes('call_center') || ['admin', 'management', 'head_ops'].includes(u.role))))
      .catch(() => {})
  }, [isHead])

  const rowKey = (r: PortfolioRow) => `${r.source}-${r.applicant_cif}-${r.reference}`

  // Bulk actions operate on the underlying CIF; dedupe multiple facilities of one CIF.
  const selectedAccounts = useCallback(() => {
    const seen = new Map<string, { cif: string; outstanding_kobo: number; dpd_bucket: string }>()
    for (const r of rows) {
      if (!checkedIds.has(rowKey(r))) continue
      const cur = seen.get(r.applicant_cif)
      if (cur) cur.outstanding_kobo += r.outstanding_kobo
      else seen.set(r.applicant_cif, { cif: r.applicant_cif, outstanding_kobo: r.outstanding_kobo, dpd_bucket: r.dpd_bucket ?? '' })
    }
    return [...seen.values()]
  }, [rows, checkedIds])

  async function handleBulkEscalate() {
    const accounts = selectedAccounts()
    if (!accounts.length) return
    if (!window.confirm(`Escalate ${accounts.length} customer(s) to Recovery? A recovery case will be opened for each.`)) return
    setBulkSaving(true)
    try {
      const r = await apiPost<{ escalated: number }>('/api/collections-ops/bulk/escalate-by-cif', { accounts })
      toast.success(`${r.escalated ?? accounts.length} customer(s) escalated to recovery`)
      setCheckedIds(new Set()); load()
    } catch (e: any) { toast.error(e.message || 'Escalation failed') } finally { setBulkSaving(false) }
  }

  async function handleBulkAssign() {
    const accounts = selectedAccounts()
    if (!accounts.length || !bulkAgentId) { toast.error('Pick an agent'); return }
    setBulkSaving(true)
    try {
      const r = await apiPost<{ assigned: number }>('/api/collections-ops/bulk/assign-by-cif', { agent_user_id: Number(bulkAgentId), accounts })
      toast.success(`${r.assigned ?? accounts.length} customer(s) assigned`)
      setBulkModal(null); setBulkAgentId(''); setCheckedIds(new Set()); load()
    } catch (e: any) { toast.error(e.message || 'Assignment failed') } finally { setBulkSaving(false) }
  }

  // Client-side filter groups refine the server-searched rows.
  const displayed = useMemo(() => rows.filter(r => {
    if (fBook.size) {
      const seg = r.dpd_lower > 90 ? 'recovery' : 'collections'
      if (!fBook.has(seg)) return false
    }
    if (fProduct.size && !fProduct.has(r.source === 'card' ? 'cards' : 'loans')) return false
    if (fSource.size && !fSource.has((r.origin || '').toLowerCase())) return false
    if (fDpd.size && !fDpd.has(r.dpd_bucket ?? '—')) return false
    if (fStage.size && !fStage.has(r.current_stage ?? '—')) return false
    return true
  }), [rows, fBook, fProduct, fSource, fDpd, fStage])

  const collCount = rows.filter(r => r.dpd_lower <= 90).length
  const recCount  = rows.filter(r => r.dpd_lower > 90).length
  const cardCount = rows.filter(r => r.source === 'card').length
  const loanCount = rows.filter(r => r.source === 'loan').length
  const ccsCount      = rows.filter(r => r.origin === 'CCS').length
  const udaraCount    = rows.filter(r => r.origin === 'Udara').length
  const uploadedCount = rows.filter(r => r.origin === 'Uploaded').length

  const dpdOptions = useMemo(() => {
    const seen = new Map<string, number>()
    for (const r of rows) { const b = r.dpd_bucket ?? '—'; if (!seen.has(b)) seen.set(b, r.dpd_lower) }
    return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([value, dpd]) => ({ value, label: value, color: dpdColor(dpd) }))
  }, [rows])

  const stageOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) if (r.current_stage) set.add(r.current_stage)
    return [...set].sort().map(value => ({ value, label: value.replace(/_/g, ' ') }))
  }, [rows])

  const portfolioCols: TableCol<PortfolioRow>[] = [
    {
      key: 'applicant_cif', label: 'Account / CIF', sortable: true,
      render: r => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SourceChip source={r.source} />
          <NameCell name={r.customer_name || r.applicant_cif} sub={isInternalId(r.applicant_cif) ? r.reference : `CIF ${r.applicant_cif} · ${r.reference}`} />
          {r.superseded && (
            <span
              title="This debt is also booked in Udara core banking. Shown for completeness — do not count it twice."
              style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '1px 6px', borderRadius: RADIUS.sm, background: `${AMBER}18`, color: AMBER, whiteSpace: 'nowrap' }}
            >Also in Udara</span>
          )}
          {DEAD_STATUS.has((r.facility_status ?? '').toUpperCase()) && (
            <span
              title={`Facility status on its own system: ${r.facility_status}`}
              style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '1px 6px', borderRadius: RADIUS.sm, background: `${RED}14`, color: RED, whiteSpace: 'nowrap', textTransform: 'capitalize' }}
            >{(r.facility_status ?? '').toLowerCase()}</span>
          )}
        </div>
      ),
    },
    { key: 'origin', label: 'Source', sortable: true, render: r => <OriginChip origin={r.origin} /> },
    { key: 'dpd_bucket', label: 'DPD', sortable: true, render: r => <DpdBadge dpd={r.dpd_lower} bucket={r.dpd_bucket} /> },
    { key: 'source', label: 'Territory', sortable: true, render: r => <TerritoryBadge dpd={r.dpd_lower} /> },
    {
      key: 'current_stage', label: 'Stage', sortable: true,
      render: r => <span style={{ fontSize: TEXT.sm, color: r.current_stage && r.current_stage !== 'unassigned' ? 'var(--txt2)' : 'var(--txt3)', textTransform: 'capitalize' }}>{r.current_stage ? r.current_stage.replace(/_/g, ' ') : '—'}</span>,
    },
    { key: 'loc_kobo', label: 'LOC / Principal', align: 'right', sortable: true, render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtKoboExact(r.loc_kobo)}</span> },
    {
      key: 'outstanding_kobo', label: 'Outstanding', align: 'right', sortable: true,
      render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: r.dpd_lower > 90 ? RED : r.dpd_lower > 30 ? AMBER : 'var(--txt)' }}>{fmtKoboExact(r.outstanding_kobo)}</span>,
    },
    {
      key: 'min_repayment_kobo', label: 'Min Repayment', align: 'right', sortable: true,
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtKoboExact(r.min_repayment_kobo)}</span>,
    },
    {
      // Cumulative money received — cards over the last 12 months, loans over the
      // life of the facility. It used to show the single last payment.
      key: 'amount_paid_kobo', label: 'Repaid', align: 'right', sortable: true,
      render: r => (
        <span
          title={r.source === 'card' ? 'Repayments received on this card in the last 12 months' : 'Repayments received against this loan'}
          style={{ ...NUM, fontSize: TEXT.sm, color: r.amount_paid_kobo > 0 ? GREEN : 'var(--txt3)' }}
        >{fmtKoboExact(r.amount_paid_kobo)}</span>
      ),
    },
    {
      // Repaid ÷ (repaid + still outstanding): the share of the credit that has come
      // back. One definition across cards, Udara loans and uploaded loans.
      key: 'pct_paid', label: '% Recovered', align: 'right', sortable: true,
      render: r => <PctBar pct={r.pct_paid} tier={r.tier} />,
    },
    { key: 'tier', label: 'Tier', render: r => <TierBadge tier={r.tier} /> },
    {
      key: 'agent_name', label: 'Collections Officer', sortable: true,
      render: r => <span style={{ fontSize: TEXT.sm, color: r.agent_name ? 'var(--txt)' : 'var(--txt3)' }}>{r.agent_name ?? 'Unassigned'}</span>,
    },
    {
      key: 'last_call_agent', label: 'Call Centre', sortable: true,
      render: r => r.last_call_agent
        ? (
          <div style={{ lineHeight: 1.25 }}>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.last_call_agent}</div>
            <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{r.last_call_at ? fmtDate(r.last_call_at) : ''}{r.last_call_disposition ? ` · ${r.last_call_disposition}` : ''}</div>
          </div>
        )
        : <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>No calls</span>,
    },
    {
      key: 'reference', label: '', sortable: false,
      render: r => (
        <button
          onClick={e => { e.stopPropagation(); navigate(`/collections/accounts/${r.applicant_cif}`) }}
          title="Open this account's activity timeline"
          style={{ padding: '3px 9px', borderRadius: RADIUS.sm, cursor: 'pointer', border: `1.5px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, whiteSpace: 'nowrap' }}
        >
          Activity
        </button>
      ),
    },
  ]

  if (loading && rows.length === 0) return (
    <Page title="Credit Portfolio">
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
    </Page>
  )

  const totalOut = Number(kpis?.total_outstanding_kobo ?? 0)
  const parShare = (kobo: number | undefined) => totalOut > 0 ? `${fmtPct((Number(kobo ?? 0) / totalOut) * 100)} of book` : undefined

  const kpiStrip = [
    { label: 'Delinquent Accounts', value: fmtNum(kpis?.delinquent_accounts ?? 0), icon: 'groups', accent: NAVY, sub: `${fmtNum(kpis?.total_accounts ?? 0)} in book` },
    { label: 'Total Outstanding',   value: fmtKoboExact(kpis?.total_outstanding_kobo ?? 0), icon: 'account_balance_wallet', accent: NAVY },
    { label: 'PAR 30',              value: fmtKoboExact(kpis?.par30_kobo ?? 0), icon: 'trending_up', accent: AMBER,     sub: parShare(kpis?.par30_kobo) },
    { label: 'PAR 60',              value: fmtKoboExact(kpis?.par60_kobo ?? 0), icon: 'warning',     accent: '#EA580C', sub: parShare(kpis?.par60_kobo) },
    { label: 'PAR 90+ (Recovery)',  value: fmtKoboExact(kpis?.par90_kobo ?? 0), icon: 'gavel',       accent: RED,       sub: parShare(kpis?.par90_kobo) },
  ]

  return (
    <Page
      title="Credit Portfolio"
      subtitle="Every loan and credit card — CCS cards, Udara loans and uploaded loans. 0–90 DPD is Collections, 90d+ is Recovery territory"
    >
      <ErrBanner error={error} onRetry={load} />

      {/* PAR snapshot — from /api/collections/portfolio-kpis (whole book, as-of-now) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginBottom: SP[4] }}>
        {kpiStrip.map(k => (
          <KpiCard key={k.label} label={k.label} value={k.value} sub={k.sub} icon={k.icon} accent={k.accent} loading={kpis === null} />
        ))}
      </div>

      {/* Recovery territory notice */}
      {fBook.size === 0 && recCount > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: SP[3], padding: `${SP[2]} ${SP[4]}`, background: `${RED}08`, border: `1px solid ${RED}22`, borderRadius: RADIUS.lg }}>
          <span className="material-symbols-rounded" style={{ fontSize: 20, color: RED }}>gavel</span>
          <div style={{ lineHeight: 1.3 }}>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.semibold }}>{fmtNum(recCount)} facilit{recCount !== 1 ? 'ies are' : 'y is'} 90+ DPD — Recovery territory</div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>These are worked by the Recovery team. Filter to see them here, or open the Recovery workspace.</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={() => setFBook(new Set(['recovery']))} style={{ padding: '5px 12px', borderRadius: RADIUS.md, cursor: 'pointer', border: `1.5px solid ${RED}40`, background: 'transparent', color: RED, fontSize: TEXT.xs, fontWeight: FW.semibold }}>Filter to recovery</button>
            <button onClick={() => navigate('/recovery/overview')} style={{ padding: '5px 12px', borderRadius: RADIUS.md, cursor: 'pointer', border: 'none', background: RED, color: '#fff', fontSize: TEXT.xs, fontWeight: FW.semibold }}>Open Recovery</button>
          </div>
        </div>
      )}

      <SectionCard
        title="Portfolio Accounts"
        badge={displayed.length}
        padding={false}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Show</span>
            <div style={{ display: 'flex', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, overflow: 'hidden' }}>
              {([
                ['owing', 'Owing now', 'Facilities carrying a balance — the collections work list'],
                ['all',   'Whole book', 'Every card and loan, including settled and closed facilities'],
              ] as const).map(([k, label, title]) => (
                <button
                  key={k}
                  onClick={() => setScope(k)}
                  title={title}
                  style={{
                    padding: '5px 12px', cursor: 'pointer', fontFamily: 'inherit', border: 'none',
                    fontSize: TEXT.xs, fontWeight: FW.semibold,
                    background: scope === k ? NAVY : 'transparent',
                    color: scope === k ? '#fff' : 'var(--txt2)',
                  }}
                >{label}</button>
              ))}
            </div>
          </div>
        }
      >
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          maxCols={4}
          groups={[
            { key: 'book',  label: 'Book', options: [
              { value: 'collections', label: 'Collections (0–90 DPD)', count: collCount, color: NAVY },
              { value: 'recovery',    label: 'Recovery (90+)',         count: recCount,  color: RED },
            ], selected: fBook, onChange: setFBook },
            { key: 'product', label: 'Product', options: [
              { value: 'cards', label: 'Cards', count: cardCount, color: PURPLE },
              { value: 'loans', label: 'Loans', count: loanCount, color: NAVY },
            ], selected: fProduct, onChange: setFProduct },
            { key: 'source', label: 'Source', options: [
              { value: 'ccs',      label: 'CCS (cards)',   count: ccsCount,      color: BLUE },
              { value: 'udara',    label: 'Udara (loans)', count: udaraCount,    color: GREEN },
              { value: 'uploaded', label: 'Uploaded',      count: uploadedCount, color: AMBER },
            ], selected: fSource, onChange: setFSource },
            { key: 'dpd',   label: 'DPD Bucket', options: dpdOptions,   selected: fDpd,   onChange: setFDpd },
            { key: 'stage', label: 'Stage',      options: stageOptions, selected: fStage, onChange: setFStage },
          ] as FilterGroupDef[]}
          onReset={() => { setSearch(''); setFBook(new Set()); setFDpd(new Set()); setFStage(new Set()); setFProduct(new Set()); setFSource(new Set()) }}
          resultCount={displayed.length}
          totalCount={rows.length}
          placeholder="Search CIF or customer name…"
        />
        <DataTable
          cols={portfolioCols}
          rows={displayed}
          keyFn={rowKey}
          loading={loading}
          skeletonRows={10}
          pageSize={25}
          emptyText="No accounts found"
          onRowClick={r => navigate(`/collections/accounts/${r.applicant_cif}`)}
          selectable={isHead}
          selectedIds={checkedIds}
          onSelect={setCheckedIds}
          bulkBar={isHead && checkedIds.size > 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{checkedIds.size} selected</span>
              <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                <button onClick={() => setBulkModal('assign')} disabled={bulkSaving} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: RADIUS.md, border: `1.5px solid ${NAVY}40`, background: `${NAVY}08`, color: NAVY, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: bulkSaving ? 'wait' : 'pointer' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>person_add</span>Assign to officer
                </button>
                <button onClick={handleBulkEscalate} disabled={bulkSaving} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: RADIUS.md, border: `1.5px solid ${RED}40`, background: `${RED}08`, color: RED, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: bulkSaving ? 'wait' : 'pointer' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>gavel</span>Escalate to recovery
                </button>
              </div>
            </div>
          ) : undefined}
        />
      </SectionCard>

      {/* Bulk-assign to officer modal */}
      <Modal
        open={bulkModal === 'assign'}
        onClose={() => setBulkModal(null)}
        title={`Assign ${selectedAccounts().length} customer(s) to an officer`}
        width={440}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setBulkModal(null)} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.medium, cursor: 'pointer' }}>Cancel</button>
            <button onClick={handleBulkAssign} disabled={bulkSaving || !bulkAgentId} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: bulkSaving || !bulkAgentId ? 'not-allowed' : 'pointer', opacity: bulkSaving || !bulkAgentId ? 0.6 : 1 }}>
              {bulkSaving && <Spinner size={13} color="#fff" />}Assign
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.03em' }}>Collections Officer</label>
          <select value={bulkAgentId} onChange={e => setBulkAgentId(e.target.value)} style={{ width: '100%', height: 40, padding: '0 11px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)' }}>
            <option value="">Select an officer…</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </select>
          <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', margin: 0 }}>
            Creates or reassigns the collection assignment for each selected customer and notifies the officer.
          </p>
        </div>
      </Modal>
    </Page>
  )
}
