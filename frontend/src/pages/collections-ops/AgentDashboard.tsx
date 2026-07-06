import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, MONO, SORA } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentRow {
  id: number
  full_name: string
  assigned: number
  contacts_today: number
  ptps_today: number
  ptps_honoured_today: number
  portfolio_kobo: number
}

interface TeamDash {
  total_assigned: number
  overdue_promises: number
  honoured_today: number
  collected_today_kobo: number
  contacts_today: number
  target_kobo: number
  ptp_kept_rate_pct: number
  contact_rate_pct: number
  cure_rate_pct: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCurrentUser(): { id?: number; full_name?: string; role?: string } {
  try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}') }
  catch { return {} }
}

function isHead(role?: string) {
  return role === 'collections_head' || role === 'admin'
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function Stat({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 130 }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: 5, fontFamily: MONO }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 28, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: accent ?? 'var(--txt)', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--txt2)', marginTop: 4, fontFamily: SORA }}>{sub}</div>}
    </div>
  )
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12, fontFamily: MONO, fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ color: 'var(--txt)', fontWeight: 600 }}>{fmtNum(value)}</span>
        <span style={{ color: 'var(--txt3)' }}>target {fmtNum(max)}</span>
      </div>
      <div style={{ height: 8, borderRadius: 99, background: 'var(--bdr)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 99, transition: 'width .5s ease' }} />
      </div>
      <div style={{ marginTop: 5, fontSize: 11, color, fontFamily: MONO, fontWeight: 600 }}>{pct}%</div>
    </div>
  )
}

// ── Agent performance row ─────────────────────────────────────────────────────

const COL: React.CSSProperties = { padding: '0 14px', height: 40, fontSize: 12.5, borderBottom: '1px solid var(--bdr)', verticalAlign: 'middle' }

function AgentRow({ a }: { a: AgentRow }) {
  const contactPct = a.assigned > 0 ? Math.round((a.contacts_today / a.assigned) * 100) : 0
  const keptPct    = a.ptps_today > 0 ? Math.round((a.ptps_honoured_today / a.ptps_today) * 100) : 0
  return (
    <tr
      onMouseEnter={e => { const cells = (e.currentTarget as HTMLElement).querySelectorAll('td'); cells.forEach(td => { (td as HTMLElement).style.background = 'var(--row-hvr)' }) }}
      onMouseLeave={e => { const cells = (e.currentTarget as HTMLElement).querySelectorAll('td'); cells.forEach(td => { (td as HTMLElement).style.background = '' }) }}
    >
      <td style={{ ...COL, paddingLeft: 24, fontWeight: 600, color: 'var(--txt)' }}>{a.full_name}</td>
      <td style={{ ...COL, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{fmtNum(a.assigned)}</td>
      <td style={{ ...COL, fontFamily: MONO, textAlign: 'right' }}>
        <span style={{ fontWeight: 600, color: a.contacts_today > 0 ? GREEN : 'var(--txt2)' }}>{fmtNum(a.contacts_today)}</span>
        {a.assigned > 0 && <span style={{ color: 'var(--txt3)', fontSize: 11, marginLeft: 4 }}>{contactPct}%</span>}
      </td>
      <td style={{ ...COL, fontFamily: MONO, textAlign: 'right' }}>
        <span style={{ fontWeight: 600, color: a.ptps_today > 0 ? AMBER : 'var(--txt2)' }}>{fmtNum(a.ptps_today)}</span>
      </td>
      <td style={{ ...COL, fontFamily: MONO, textAlign: 'right' }}>
        <span style={{ fontWeight: 600, color: keptPct >= 70 ? GREEN : keptPct >= 40 ? AMBER : RED }}>{fmtNum(a.ptps_honoured_today)}</span>
        {a.ptps_today > 0 && <span style={{ color: 'var(--txt3)', fontSize: 11, marginLeft: 4 }}>{keptPct}%</span>}
      </td>
      <td style={{ ...COL, fontFamily: MONO, textAlign: 'right', paddingRight: 24 }}>{fmtKobo(a.portfolio_kobo)}</td>
    </tr>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

const AGENT_PAGE_SIZE = 25

export default function AgentDashboard() {
  const [agents, setAgents]   = useState<AgentRow[]>([])
  const [team,   setTeam]     = useState<TeamDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [agentPage, setAgentPage] = useState(1)

  const user = getCurrentUser()
  const head = isHead(user.role)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [agentRes, teamRes] = await Promise.all([
        apiFetch<{ data: AgentRow[] } | AgentRow[]>('/api/collections-ops/agent-dashboard'),
        apiFetch<TeamDash | { data: TeamDash }>('/api/collections-ops/dashboard'),
      ])
      // Handle both array-direct and {data: ...} wrapper
      const agentArr = Array.isArray(agentRes)
        ? agentRes as AgentRow[]
        : (agentRes as { data: AgentRow[] }).data ?? []
      setAgents(agentArr)

      const teamData = (teamRes as { data?: TeamDash }).data ?? teamRes as TeamDash
      setTeam(teamData)
    } catch { /* silent — show empty state */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  // Personal stats — for agents: first (only) row; for heads: find own row
  const me = head
    ? agents.find(a => a.id === user.id) ?? agents[0]
    : agents[0]

  const contactTarget = team?.total_assigned ?? 0
  const collectedPct  = team && team.target_kobo > 0
    ? Math.min(100, Math.round((team.collected_today_kobo / team.target_kobo) * 100))
    : 0
  const collectedColor = collectedPct >= 100 ? GREEN : collectedPct >= 60 ? AMBER : RED

  const TH: React.CSSProperties = {
    padding: '8px 14px', textAlign: 'left', fontSize: 10, fontWeight: 700,
    letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--txt3)',
    borderTop: '1px solid var(--bdr)', borderBottom: '1px solid var(--bdr)',
    background: 'var(--bg)', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1,
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, fontFamily: SORA }}>

      {/* ── Personal hero ── */}
      <section style={{ padding: '26px 28px 24px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: 6, fontFamily: MONO }}>
          My Dashboard · Today
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--txt)', marginBottom: 20 }}>
          {loading ? '—' : (me?.full_name ?? user.full_name ?? 'Collections Agent')}
        </div>

        <div style={{ display: 'flex', gap: 44, flexWrap: 'wrap' }}>
          <Stat label="Assigned" value={loading ? '—' : fmtNum(me?.assigned ?? 0)} sub="active accounts" />
          <Stat label="Contacts Today" value={loading ? '—' : fmtNum(me?.contacts_today ?? 0)} sub="calls & messages logged" accent={me?.contacts_today ? GREEN : undefined} />
          <Stat label="Promises Today" value={loading ? '—' : fmtNum(me?.ptps_today ?? 0)} sub="recorded today" accent={me?.ptps_today ? AMBER : undefined} />
          <Stat label="Promises Kept" value={loading ? '—' : fmtNum(me?.ptps_honoured_today ?? 0)} sub="honoured today" accent={me?.ptps_honoured_today ? GREEN : undefined} />
          <div style={{ flex: 1, minWidth: 180 }}>
            <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: 5, fontFamily: MONO }}>Portfolio</div>
            <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--txt)', lineHeight: 1 }}>
              {loading ? '—' : fmtKobo(me?.portfolio_kobo ?? 0)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--txt2)', marginTop: 4 }}>total outstanding in queue</div>
          </div>
        </div>
      </section>

      {/* ── Team-level KPIs (visible to all, context for agents) ── */}
      <section style={{ padding: '20px 28px', borderBottom: '1px solid var(--bdr)', background: 'var(--bg)' }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: 16, fontFamily: MONO }}>
          {head ? 'Team Performance · Today' : 'Team Targets · Today'}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 20 }}>
          {[
            { label: 'Total Assigned',    val: team ? fmtNum(team.total_assigned)                   : '—', sub: 'active accounts' },
            { label: 'Contacts Today',    val: team ? fmtNum(team.contacts_today)                  : '—', sub: `${team?.contact_rate_pct?.toFixed(1) ?? '—'}% contact rate` },
            { label: 'Overdue Promises',  val: team ? fmtNum(team.overdue_promises)                : '—', sub: 'past due date',    accent: (team?.overdue_promises ?? 0) > 0 ? AMBER : undefined },
            { label: 'Honoured Today',    val: team ? fmtNum(team.honoured_today)                  : '—', sub: `${team?.ptp_kept_rate_pct?.toFixed(1) ?? '—'}% kept rate`,  accent: GREEN },
            { label: 'Collected Today',   val: team ? fmtKobo(team.collected_today_kobo)           : '—', sub: `vs ₦${team ? (team.target_kobo/100).toLocaleString('en-NG',{maximumFractionDigits:0}) : '—'} target`, accent: collectedColor },
            { label: 'Cure Rate',         val: team ? `${team.cure_rate_pct?.toFixed(1) ?? 0}%`   : '—', sub: 'moved to current bucket' },
          ].map(({ label, val, sub, accent }) => (
            <div key={label}>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: 5, fontFamily: MONO }}>{label}</div>
              <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: accent ?? 'var(--txt)' }}>{loading ? '—' : val}</div>
              <div style={{ fontSize: 11, color: 'var(--txt2)', marginTop: 3 }}>{sub}</div>
            </div>
          ))}
        </div>

        {/* Collection target progress */}
        {team && team.target_kobo > 0 && (
          <div style={{ marginTop: 20, maxWidth: 480 }}>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: 8, fontFamily: MONO }}>Collection target progress</div>
            <ProgressBar value={team.collected_today_kobo / 100} max={team.target_kobo / 100} color={collectedColor} />
          </div>
        )}
      </section>

      {/* ── Agent performance table (heads only) ── */}
      {head && (
        <section style={{ paddingBottom: 40 }}>
          <div style={{ padding: '14px 24px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)' }}>Agent Performance</span>
            <span style={{ fontFamily: MONO, fontSize: 12, color: 'var(--txt3)' }}>{agents.length} agents</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {[
                    { label: 'Agent',            pl: 24 },
                    { label: 'Assigned',         r: true },
                    { label: 'Contacts Today',   r: true },
                    { label: 'Promises Today',   r: true },
                    { label: 'Kept Today',       r: true },
                    { label: 'Portfolio',        r: true, pr: 24 },
                  ].map(col => (
                    <th key={col.label} style={{ ...TH, ...(col.r ? { textAlign: 'right' } : {}), ...(col.pl ? { paddingLeft: col.pl } : {}), ...((col as any).pr ? { paddingRight: (col as any).pr } : {}) }}>
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>{Array.from({ length: 6 }).map((_, j) => (
                      <td key={j} style={COL}><div style={{ height: 12, borderRadius: 4, background: 'var(--bdr)', width: '70%' }} /></td>
                    ))}</tr>
                  ))
                ) : agents.length === 0 ? (
                  <tr><td colSpan={6} style={{ ...COL, textAlign: 'center', padding: 32, color: 'var(--txt3)' }}>No agent data available</td></tr>
                ) : (
                  agents.slice((agentPage - 1) * AGENT_PAGE_SIZE, agentPage * AGENT_PAGE_SIZE).map(a => <AgentRow key={a.id} a={a} />)
                )}
              </tbody>
            </table>
          </div>
          {agents.length > AGENT_PAGE_SIZE && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--bdr)' }}>
              <span style={{ fontSize: 12, color: 'var(--txt3)', fontFamily: MONO }}>
                {(agentPage - 1) * AGENT_PAGE_SIZE + 1}–{Math.min(agentPage * AGENT_PAGE_SIZE, agents.length)} of {agents.length}
              </span>
              <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                <button onClick={() => setAgentPage(p => Math.max(1, p - 1))} disabled={agentPage === 1}
                  style={{ padding: '5px 12px', borderRadius: 7, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt)', fontSize: 12, fontWeight: 600, cursor: agentPage === 1 ? 'default' : 'pointer', fontFamily: SORA, opacity: agentPage === 1 ? 0.4 : 1 }}>
                  ← Prev
                </button>
                <span style={{ fontSize: 12, fontFamily: MONO, fontWeight: 600, color: 'var(--txt)', minWidth: 64, textAlign: 'center' }}>
                  {agentPage} / {Math.ceil(agents.length / AGENT_PAGE_SIZE)}
                </span>
                <button onClick={() => setAgentPage(p => Math.min(Math.ceil(agents.length / AGENT_PAGE_SIZE), p + 1))} disabled={agentPage >= Math.ceil(agents.length / AGENT_PAGE_SIZE)}
                  style={{ padding: '5px 12px', borderRadius: 7, border: '1.5px solid var(--bdr)', background: 'transparent', color: 'var(--txt)', fontSize: 12, fontWeight: 600, cursor: agentPage >= Math.ceil(agents.length / AGENT_PAGE_SIZE) ? 'default' : 'pointer', fontFamily: SORA, opacity: agentPage >= Math.ceil(agents.length / AGENT_PAGE_SIZE) ? 0.4 : 1 }}>
                  Next →
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── Non-head: contact prompt ── */}
      {!head && !loading && (
        <section style={{ padding: '28px', borderTop: '1px solid var(--bdr)' }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: 12, fontFamily: MONO }}>
            Contact Rate Breakdown
          </div>
          <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: 6, fontFamily: MONO }}>Contacts vs Assigned</div>
              <ProgressBar
                value={me?.contacts_today ?? 0}
                max={Math.max(me?.assigned ?? 0, 1)}
                color={contactTarget > 0 ? GREEN : AMBER}
              />
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: 6, fontFamily: MONO }}>Promises Kept Today</div>
              <ProgressBar
                value={me?.ptps_honoured_today ?? 0}
                max={Math.max(me?.ptps_today ?? 0, 1)}
                color={me?.ptps_today ? GREEN : AMBER}
              />
            </div>
          </div>
          <div style={{ marginTop: 20, padding: '14px 16px', background: `${NAVY}08`, borderRadius: 8, border: `1px solid ${NAVY}18`, fontSize: 13, color: 'var(--txt)', lineHeight: 1.6 }}>
            <strong>Quick tip:</strong> Head to <a href="/collections/queue" style={{ color: NAVY, fontWeight: 600 }}>Agent Queue</a> to view and action your assigned accounts, or <a href="/collections/promises" style={{ color: NAVY, fontWeight: 600 }}>Promises to Pay</a> to update promise statuses.
          </div>
        </section>
      )}
    </div>
  )
}
