import { useLiveData } from '../../hooks/useRealtime'
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, KpiCard, DataTable, ErrBanner,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { LiveBadge, relTime } from '../../components/MyWorkspace'
import { apiFetch } from '../../lib/api'
import { fmtKoboExact, fmtKobo, fmtNum } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ───────────────────────────────────────────────────────────────────────

// GET /api/recovery-ops/dashboard — flat scalar map.
interface Dash {
  total_open_cases:        number
  total_outstanding_kobo:  number
  total_recovered_kobo:    number
  pending_write_offs:      number
  visits_this_month:       number
}

// GET /api/recovery-ops/cases?limit=200 → { data: CaseRow[] }
interface CaseRow {
  id: number
  case_ref: string
  account_cif: string
  customer_name: string
  product_type: string
  agent_name: string | null
  assigned_agent_id: number | null
  loan_amount_kobo: number
  outstanding_kobo: number
  recovered_kobo: number
  write_off_amount_kobo: number
  status: string
  legal_stage: string
  opened_at: string
}

// Client-side aggregate per agent.
interface CaseloadRow {
  agent_id: number | null
  agent_name: string
  cases: number
  assigned_kobo: number    // balance handed to the agent (Σ outstanding at handoff)
  principal_kobo: number   // Σ loan principal (loan cases; 0 for cards)
  outstanding_kobo: number // current balance, net of what has been recovered
  recovered_kobo: number
}

// GET /api/collections/activity (double-wrapped {data:{data,total}})
interface ActivityEvent {
  id: number
  ts: string
  actor_name: string
  actor_role: string
  action: string
  description: string
  account_cif: string | null
}

// ── Action feed label/colour (recovery + shared collections actions) ──────────────

const ACTION_LABELS: Record<string, string> = {
  contact_logged: 'Contact', promise_created: 'PTP', promise_honoured: 'PTP Kept',
  promise_broken: 'PTP Broken', payment_logged: 'Payment', payment_approved: 'Payment Approved',
  payment_rejected: 'Payment Rejected', writeoff_requested: 'Write-off Requested',
  writeoff_request_approved: 'Write-off Approved', writeoff_request_rejected: 'Write-off Rejected',
  writeoff_approved: 'Write-off Approved', watchlist_flagged: 'Watchlisted',
  watchlist_resolved: 'Watchlist Cleared', sent_to_recovery: 'Sent to Recovery',
  field_visit_logged: 'Field Visit', debt_sale_created: 'Debt Sale',
  plan_created: 'Repayment Plan', instalment_paid: 'Instalment Paid', legal_milestone_added: 'Legal',
  assignments_generated: 'Assignments Generated',
}
const ACTION_COLORS: Record<string, string> = {
  contact_logged: BLUE, promise_created: NAVY, promise_honoured: GREEN, promise_broken: RED,
  payment_logged: BLUE, payment_approved: GREEN, payment_rejected: RED, writeoff_requested: AMBER,
  writeoff_request_approved: RED, writeoff_request_rejected: AMBER, writeoff_approved: RED,
  watchlist_flagged: AMBER, watchlist_resolved: GREEN, sent_to_recovery: RED,
  field_visit_logged: BLUE, debt_sale_created: PURPLE, plan_created: NAVY,
  instalment_paid: GREEN, legal_milestone_added: PURPLE, assignments_generated: NAVY,
}

// respond() wraps as {data:…}; the activity feed double-wraps as {data:{data,total}}.
function unwrap<T>(res: any): T { return (res && typeof res === 'object' && 'data' in res) ? res.data : res }

// ── Approval summary card ────────────────────────────────────────────────────────

function ApprovalCard({ icon, label, count, value, accent, onReview }: {
  icon: string; label: string; count: number; value: number; accent: string; onReview: () => void
}) {
  const has = count > 0
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: `${SP[3]} ${SP[4]}`, display: 'flex', alignItems: 'center', gap: SP[3] }}>
      <div style={{ width: 40, height: 40, flexShrink: 0, borderRadius: RADIUS.md, background: `${accent}14`, color: accent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span className="material-symbols-rounded" style={{ fontSize: 22 }}>{icon}</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)' }}>{label}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: has ? accent : 'var(--txt3)', lineHeight: 1.1 }}>{count}</span>
          {has && value > 0 && <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtKoboExact(value)}</span>}
        </div>
      </div>
      <button onClick={onReview} disabled={!has}
        style={{ padding: '6px 13px', borderRadius: RADIUS.md, border: `1px solid ${has ? accent : 'var(--bdr)'}`, background: has ? `${accent}0E` : 'transparent', color: has ? accent : 'var(--txt3)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: has ? 'pointer' : 'default', whiteSpace: 'nowrap' }}>
        Review
      </button>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────────

export default function RecoverySupervisor() {
  const navigate = useNavigate()
  const [dash,      setDash]      = useState<Dash | null>(null)
  const [caseloads, setCaseloads] = useState<CaseloadRow[]>([])
  const [feed,      setFeed]      = useState<ActivityEvent[]>([])
  const [pmtCount,  setPmtCount]  = useState(0); const [pmtValue, setPmtValue] = useState(0)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [d, c, act, pmts] = await Promise.all([
        apiFetch<any>('/api/recovery-ops/dashboard'),
        apiFetch<any>('/api/recovery-ops/cases?limit=200'),
        apiFetch<any>('/api/collections/activity?module=recovery&page=1&size=20'),
        apiFetch<any>('/api/recovery-ops/payments/pending'),
      ])
      setDash(unwrap<Dash>(d) ?? null)

      // Group cases client-side by agent (null → "Unassigned").
      const rows = (unwrap<CaseRow[]>(c) as CaseRow[]) ?? []
      const buckets = new Map<string, CaseloadRow>()
      for (const r of rows) {
        const key = r.assigned_agent_id != null ? String(r.assigned_agent_id) : 'unassigned'
        let b = buckets.get(key)
        if (!b) {
          b = {
            agent_id: r.assigned_agent_id ?? null,
            agent_name: r.agent_name ?? 'Unassigned',
            cases: 0, assigned_kobo: 0, principal_kobo: 0, outstanding_kobo: 0, recovered_kobo: 0,
          }
          buckets.set(key, b)
        }
        const outstanding = Number(r.outstanding_kobo || 0)
        const recovered = Number(r.recovered_kobo || 0)
        b.cases += 1
        b.assigned_kobo += outstanding                          // handoff snapshot
        b.principal_kobo += Number(r.loan_amount_kobo || 0)
        b.outstanding_kobo += Math.max(outstanding - recovered, 0) // net, matches Overview
        b.recovered_kobo += recovered
      }
      setCaseloads([...buckets.values()].sort((a, b) => b.outstanding_kobo - a.outstanding_kobo))

      const inner = unwrap<any>(act); setFeed((inner?.data ?? (Array.isArray(inner) ? inner : [])) as ActivityEvent[])

      const pmtRows = (unwrap<any[]>(pmts) as any[]) ?? []
      setPmtCount(pmtRows.length); setPmtValue(pmtRows.reduce((s, r) => s + Number(r.amount_kobo || 0), 0))
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['recovery', 'collections'] })

  const d = dash
  const pendingWriteOffs = Number(d?.pending_write_offs ?? 0)

  const caseloadCols: TableCol<CaseloadRow>[] = [
    {
      key: 'agent_name', label: 'Agent',
      render: r => <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: r.agent_id == null ? 'var(--txt3)' : 'var(--txt)' }}>{r.agent_name}</span>,
    },
    { key: 'cases', label: 'Cases', align: 'right', render: r => <span style={NUM}>{fmtNum(r.cases)}</span> },
    { key: 'assigned_kobo', label: 'Assigned', align: 'right', render: r => <span style={NUM}>{fmtKoboExact(r.assigned_kobo)}</span> },
    { key: 'principal_kobo', label: 'Principal', align: 'right', render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{fmtKoboExact(r.principal_kobo)}</span> },
    { key: 'outstanding_kobo', label: 'Outstanding', align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKoboExact(r.outstanding_kobo)}</span> },
    { key: 'recovered_kobo', label: 'Recovered', align: 'right', render: r => <span style={{ ...NUM, color: r.recovered_kobo > 0 ? GREEN : 'var(--txt3)' }}>{fmtKoboExact(r.recovered_kobo)}</span> },
    {
      key: 'agent_id', label: '', width: 100,
      render: r => (
        <button onClick={e => { e.stopPropagation(); navigate(r.agent_id != null ? `/recovery/cases?agent=${r.agent_id}` : '/recovery/cases') }}
          style={{ padding: '4px 11px', borderRadius: RADIUS.sm, border: `1px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          View cases
        </button>
      ),
    },
  ]

  return (
    <Page
      title="Recovery Supervisor"
      subtitle="Live recovery performance, agent caseloads and approvals"
      loading={loading && !dash}
      skeletonKpis={5}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <LiveBadge />
          <button onClick={() => navigate('/recovery/cases')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17 }}>gavel</span>
            Recovery Cases
          </button>
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* ── KPI strip ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginBottom: 18 }}>
        <KpiCard label="Open Cases" value={loading && !d ? '—' : fmtNum(Number(d?.total_open_cases ?? 0))}
          sub="active recovery cases" icon="folder_open" accent={NAVY} loading={loading && !d} />
        <KpiCard label="Total Outstanding" value={loading && !d ? '—' : fmtKoboExact(Number(d?.total_outstanding_kobo ?? 0))}
          sub="balance under recovery" icon="account_balance_wallet" accent={RED} loading={loading && !d} />
        <KpiCard label="Recovered" value={loading && !d ? '—' : fmtKoboExact(Number(d?.total_recovered_kobo ?? 0))}
          sub="collected on recovery cases" icon="savings" accent={GREEN} loading={loading && !d} />
        <KpiCard label="Pending Write-offs" value={loading && !d ? '—' : fmtNum(pendingWriteOffs)}
          sub="awaiting your decision" icon="request_quote" accent={pendingWriteOffs > 0 ? AMBER : GREEN} loading={loading && !d} />
        <KpiCard label="Visits This Month" value={loading && !d ? '—' : fmtNum(Number(d?.visits_this_month ?? 0))}
          sub="field visits logged" icon="pin_drop" accent={BLUE} loading={loading && !d} />
      </div>

      {/* ── Needs your decision ── */}
      <SectionCard title="Needs Your Decision" subtitle="Approvals waiting on a recovery head" badge={pmtCount + pendingWriteOffs} style={{ marginBottom: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
          <ApprovalCard icon="payments" label="Recovery payments" count={pmtCount} value={pmtValue} accent={GREEN}
            onReview={() => navigate('/collections/recovery-approvals')} />
          <ApprovalCard icon="gavel" label="Write-offs pending" count={pendingWriteOffs} value={0} accent={RED}
            onReview={() => navigate('/collections/writeoffs')} />
        </div>
      </SectionCard>

      {/* ── Caseloads + activity ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(300px, 1fr)', gap: 16, alignItems: 'start' }}>
        <SectionCard title="Agent Caseloads" subtitle="Open cases grouped by recovery agent" badge={caseloads.length} padding={false}>
          <DataTable
            cols={caseloadCols}
            rows={caseloads}
            keyFn={r => (r.agent_id != null ? String(r.agent_id) : 'unassigned')}
            loading={loading && caseloads.length === 0}
            skeletonRows={6}
            emptyText="No open cases yet"
            searchKeys={['agent_name']}
            searchPlaceholder="Search agent…"
            pageSize={12}
          />
        </SectionCard>

        <SectionCard title="Team Activity" subtitle="Latest actions across recovery">
          {loading && feed.length === 0 ? (
            <div style={{ color: 'var(--txt3)', fontSize: TEXT.sm, padding: '10px 0' }}>Loading…</div>
          ) : feed.length === 0 ? (
            <div style={{ color: 'var(--txt3)', fontSize: TEXT.sm, padding: '10px 0' }}>No recent activity.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 460, overflowY: 'auto' }}>
              {feed.map(e => {
                const color = ACTION_COLORS[e.action] ?? 'var(--txt2)'
                return (
                  <div key={e.id} style={{ display: 'flex', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--bdr)' }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0, marginTop: 6 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{ACTION_LABELS[e.action] ?? e.action}</span>
                        {e.account_cif && <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, color: NAVY }}>{e.account_cif}</span>}
                        <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginLeft: 'auto' }}>{relTime(e.ts)}</span>
                      </div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.45, marginTop: 2 }}>{e.description}</div>
                      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 1 }}>{e.actor_name}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </SectionCard>
      </div>

    </Page>
  )
}
