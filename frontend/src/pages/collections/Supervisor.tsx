import { useLiveData } from '../../hooks/useRealtime'
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, KpiCard, DataTable, ErrBanner, Modal, Spinner,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { LiveBadge, relTime } from '../../components/MyWorkspace'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKoboExact, fmtNum } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ───────────────────────────────────────────────────────────────────────

// GET /api/collections-ops/dashboard — flat scalar map (all "today"/"this month").
interface Dash {
  total_assigned:       number
  overdue_promises:     number
  honoured_today:       number
  collected_today_kobo: number
  contacts_today:       number
  target_kobo:          number
  ptp_kept_rate_pct:    number
  contact_rate_pct:     number
  cure_rate_pct:        number
}

// GET /api/collections-ops/agent-dashboard
interface AgentRow {
  id: number
  full_name: string
  assigned: number
  contacts_today: number
  ptps_today: number
  ptps_honoured_today: number
  collected_today_kobo: number
  portfolio_kobo: number
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

// ── Action feed label/colour (subset of the retired Activity Log page) ───────────

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

function pctColour(v: number): string {
  if (v >= 75) return GREEN
  if (v >= 50) return AMBER
  return RED
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
          {has && <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtKoboExact(value)}</span>}
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

export default function CollectionsSupervisor() {
  const navigate = useNavigate()
  const [dash,   setDash]   = useState<Dash | null>(null)
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [feed,   setFeed]   = useState<ActivityEvent[]>([])
  const [pmtCount, setPmtCount] = useState(0); const [pmtValue, setPmtValue] = useState(0)
  const [woReqCount, setWoReqCount] = useState(0); const [woReqValue, setWoReqValue] = useState(0)
  const [woApvCount, setWoApvCount] = useState(0); const [woApvValue, setWoApvValue] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  // Floor controls: generate assignments + distribute the unassigned pool.
  const [genLoading, setGenLoading]   = useState(false)
  const [distOpen, setDistOpen]       = useState(false)
  const [distIds, setDistIds]         = useState<Set<number>>(new Set())
  const [distSaving, setDistSaving]   = useState(false)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [d, a, act, pmts, woReq, woApv] = await Promise.all([
        apiFetch<any>('/api/collections-ops/dashboard'),
        apiFetch<any>('/api/collections-ops/agent-dashboard'),
        apiFetch<any>('/api/collections/activity?module=collections&page=1&size=20'),
        apiFetch<any>('/api/recovery-ops/payments/pending'),
        apiFetch<any>('/api/collections-ops/writeoff-requests?status=pending'),
        apiFetch<any>('/api/collections-ops/writeoffs'),
      ])
      setDash(unwrap<Dash>(d) ?? null)
      setAgents((unwrap<AgentRow[]>(a) as AgentRow[]) ?? [])
      const inner = unwrap<any>(act); setFeed((inner?.data ?? (Array.isArray(inner) ? inner : [])) as ActivityEvent[])
      const pmtRows = (unwrap<any[]>(pmts) as any[]) ?? []
      setPmtCount(pmtRows.length); setPmtValue(pmtRows.reduce((s, r) => s + Number(r.amount_kobo || 0), 0))
      const woReqRows = (unwrap<any[]>(woReq) as any[]) ?? []
      setWoReqCount(woReqRows.length); setWoReqValue(woReqRows.reduce((s, r) => s + Number(r.amount_kobo || r.outstanding_kobo || 0), 0))
      const woApvRows = (unwrap<any[]>(woApv) as any[]) ?? []
      setWoApvCount(woApvRows.length); setWoApvValue(woApvRows.reduce((s, r) => s + Number(r.outstanding_kobo || 0), 0))
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['collections', 'recovery', 'loans'] })

  async function handleGenerate() {
    setGenLoading(true)
    try {
      const r = await apiPost<{ created: number }>('/api/collections/generate-assignments', {})
      toast.success((r.created ?? 0) > 0 ? `${r.created} new assignment(s) created from the delinquency book` : 'Assignments refreshed — no new delinquent accounts')
      load()
    } catch (e: any) { toast.error(e.message || 'Generation failed') } finally { setGenLoading(false) }
  }

  async function handleDistribute() {
    const ids = [...distIds]
    if (!ids.length) { toast.error('Pick at least one officer'); return }
    setDistSaving(true)
    try {
      const r = await apiPost<{ distributed: number }>('/api/collections-ops/distribute', { agent_ids: ids })
      toast.success(`${r.distributed ?? 0} unassigned account(s) distributed across ${ids.length} officer(s)`)
      setDistOpen(false); setDistIds(new Set()); load()
    } catch (e: any) { toast.error(e.message || 'Distribution failed') } finally { setDistSaving(false) }
  }

  const d = dash
  const collected = Number(d?.collected_today_kobo ?? 0)
  const target = Number(d?.target_kobo ?? 0)
  const targetPct = target > 0 ? Math.round((collected / target) * 100) : 0
  const pendingApprovals = pmtCount + woReqCount + woApvCount

  const agentCols: TableCol<AgentRow>[] = [
    {
      key: 'full_name', label: 'Agent',
      render: r => <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>{r.full_name}</span>,
    },
    { key: 'assigned', label: 'Queue', align: 'right', render: r => <span style={NUM}>{fmtNum(r.assigned)}</span> },
    {
      key: 'contacts_today', label: 'Contacts Today', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold, color: Number(r.contacts_today) > 0 ? GREEN : 'var(--txt3)' }}>{fmtNum(r.contacts_today)}</span>,
    },
    { key: 'ptps_today', label: 'PTPs', align: 'right', render: r => <span style={NUM}>{fmtNum(r.ptps_today)}</span> },
    {
      key: 'ptps_honoured_today', label: 'PTPs Kept', align: 'right',
      render: r => <span style={{ ...NUM, color: Number(r.ptps_honoured_today) > 0 ? GREEN : 'var(--txt3)' }}>{fmtNum(r.ptps_honoured_today)}</span>,
    },
    {
      key: 'collected_today_kobo', label: 'Collected Today', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold, color: Number(r.collected_today_kobo) > 0 ? GREEN : 'var(--txt3)' }}>{fmtKoboExact(r.collected_today_kobo)}</span>,
    },
    { key: 'portfolio_kobo', label: 'Portfolio', align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKoboExact(r.portfolio_kobo)}</span> },
    {
      key: 'id', label: '', width: 90,
      render: r => (
        <button onClick={e => { e.stopPropagation(); navigate(`/collections/queue?agent=${r.id}`) }}
          style={{ padding: '4px 11px', borderRadius: RADIUS.sm, border: `1px solid ${NAVY}30`, background: `${NAVY}08`, color: NAVY, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          View queue
        </button>
      ),
    },
  ]

  return (
    <Page
      title="Collections Supervisor"
      subtitle="Live team performance, approvals awaiting you, and floor controls"
      loading={loading && !dash}
      skeletonKpis={4}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <LiveBadge />
          <button onClick={handleGenerate} disabled={genLoading}
            title="Create/refresh collection assignments from the live delinquency book"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: genLoading ? 'wait' : 'pointer' }}>
            {genLoading ? <Spinner size={13} color="#fff" /> : <span className="material-symbols-rounded" style={{ fontSize: 17 }}>sync</span>}
            Generate Assignments
          </button>
          <button onClick={() => { setDistIds(new Set(agents.map(a => a.id))); setDistOpen(true) }}
            title="Round-robin the unassigned accounts across selected officers"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: RADIUS.md, border: `1.5px solid ${NAVY}40`, background: `${NAVY}08`, color: NAVY, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17 }}>shuffle</span>
            Distribute
          </button>
          <button onClick={() => navigate('/collections/queue')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17 }}>format_list_bulleted</span>
            Agent Queue
          </button>
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* ── Team KPIs — a clean 4×2 grid so the eight tiles distribute evenly ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 14, marginBottom: 18 }}>
        <KpiCard label="Collected Today" value={loading && !d ? '—' : fmtKoboExact(collected)}
          sub={target > 0 ? `${targetPct}% of ${fmtKoboExact(target)} target` : 'no target set today'}
          icon="payments" accent={GREEN} loading={loading && !d} />
        <KpiCard label="PTP Kept Rate" value={loading && !d ? '—' : `${Number(d?.ptp_kept_rate_pct ?? 0)}%`}
          sub="promises honoured this month" icon="handshake" accent={pctColour(Number(d?.ptp_kept_rate_pct ?? 0))} loading={loading && !d} />
        <KpiCard label="Contact Rate" value={loading && !d ? '—' : `${Number(d?.contact_rate_pct ?? 0)}%`}
          sub="of active book contacted today" icon="call" accent={pctColour(Number(d?.contact_rate_pct ?? 0))} loading={loading && !d} />
        <KpiCard label="Cure Rate" value={loading && !d ? '—' : `${Number(d?.cure_rate_pct ?? 0)}%`}
          sub="active accounts back to current" icon="healing" accent={pctColour(Number(d?.cure_rate_pct ?? 0))} loading={loading && !d} />
        <KpiCard label="Overdue Promises" value={loading && !d ? '—' : fmtNum(Number(d?.overdue_promises ?? 0))}
          sub="PTPs past due, unresolved" icon="running_with_errors" accent={RED} loading={loading && !d} />
        <KpiCard label="Contacts Today" value={loading && !d ? '—' : fmtNum(Number(d?.contacts_today ?? 0))}
          sub={`${fmtNum(Number(d?.honoured_today ?? 0))} promises kept today`} icon="trending_up" accent={BLUE} loading={loading && !d} />
        <KpiCard label="Accounts in Book" value={loading && !d ? '—' : fmtNum(Number(d?.total_assigned ?? 0))}
          sub="total assignments" icon="account_balance_wallet" accent={NAVY} loading={loading && !d} />
        <KpiCard label="Pending Approvals" value={loading ? '—' : fmtNum(pendingApprovals)}
          sub="payments & write-offs awaiting you" icon="rule" accent={pendingApprovals > 0 ? AMBER : GREEN} loading={loading} />
      </div>

      {/* ── Needs your decision ── */}
      <SectionCard title="Needs Your Decision" subtitle="Approvals waiting on a collections head" badge={pendingApprovals} style={{ marginBottom: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
          <ApprovalCard icon="payments" label="Recovery payments" count={pmtCount} value={pmtValue} accent={GREEN}
            onReview={() => navigate('/collections/recovery-approvals')} />
          <ApprovalCard icon="request_quote" label="Write-off requests" count={woReqCount} value={woReqValue} accent={AMBER}
            onReview={() => navigate('/collections/writeoff-requests')} />
          <ApprovalCard icon="gavel" label="Recovery write-offs" count={woApvCount} value={woApvValue} accent={RED}
            onReview={() => navigate('/collections/writeoffs')} />
        </div>
      </SectionCard>

      {/* ── Team (full width so the wide metric table never scrolls sideways) ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SectionCard title="Team Performance" subtitle="Today's activity and collections across the floor" badge={agents.length} padding={false}>
          <DataTable
            cols={agentCols}
            rows={[...agents].sort((a, b) => Number(b.collected_today_kobo) - Number(a.collected_today_kobo) || Number(b.contacts_today) - Number(a.contacts_today))}
            keyFn={r => r.id}
            loading={loading && agents.length === 0}
            skeletonRows={6}
            emptyText="No agent activity yet"
            searchKeys={['full_name']}
            searchPlaceholder="Search agent…"
            pageSize={12}
          />
        </SectionCard>

        <SectionCard title="Team Activity" subtitle="Latest actions across collections">
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

      {/* Distribute unassigned accounts across officers */}
      <Modal
        open={distOpen}
        onClose={() => setDistOpen(false)}
        title="Distribute unassigned accounts"
        width={460}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setDistOpen(false)} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.medium, cursor: 'pointer' }}>Cancel</button>
            <button onClick={handleDistribute} disabled={distSaving || distIds.size === 0} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: distSaving || distIds.size === 0 ? 'not-allowed' : 'pointer', opacity: distSaving || distIds.size === 0 ? 0.6 : 1 }}>
              {distSaving && <Spinner size={13} color="#fff" />}Distribute
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
          <p style={{ fontSize: TEXT.sm, color: 'var(--txt2)', margin: 0 }}>
            Round-robins every unassigned active account (largest balance first) across the selected officers.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {agents.map(a => {
              const on = distIds.has(a.id)
              return (
                <button key={a.id} onClick={() => setDistIds(prev => { const s = new Set(prev); s.has(a.id) ? s.delete(a.id) : s.add(a.id); return s })}
                  style={{ padding: '5px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
                    border: `1.5px solid ${on ? NAVY : 'var(--bdr)'}`, background: on ? NAVY : 'var(--card)', color: on ? '#fff' : 'var(--txt)' }}>
                  {a.full_name}
                </button>
              )
            })}
          </div>
        </div>
      </Modal>

    </Page>
  )
}
