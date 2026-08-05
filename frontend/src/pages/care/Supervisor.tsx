import { useLiveData } from '../../hooks/useRealtime'
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, Spinner, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime, fmtNum } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, BLUE, PURPLE, FW, RADIUS, SP, TEXT, NUM } from '../../lib/design'

interface AgentRow {
  agent_name: string
  open: number
  resolved_today: number
  avg_first_response_mins: number | null
  sla_at_risk: number
}
interface UnassignedTicket {
  id: number
  ticket_ref: string
  subject: string
  customer_name?: string
  created_at: string
  last_at?: string
  priority?: string
}
interface CareSup {
  open: number
  unassigned: number
  awaiting_reply: number
  resolved_today: number
  sla_at_risk: number
  agents: AgentRow[]
  unassigned_tickets: UnassignedTicket[]
}

function fmtMins(m: number | null | undefined): string {
  if (m == null) return '—'
  if (m < 60) return `${Math.round(m)}m`
  return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`
}

function Kpi({ label, value, icon, accent }: { label: string; value: string | number; icon: string; accent: string }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.lg, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontWeight: FW.semibold, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
        <span className="material-symbols-rounded" style={{ fontSize: 17, color: accent }}>{icon}</span>
      </div>
      <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.extrabold, color: 'var(--txt)' }}>{value}</div>
    </div>
  )
}

export default function CareSupervisor() {
  const navigate = useNavigate()
  const [d, setD] = useState<CareSup | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const r = await apiFetch<any>('/api/helpdesk/care-supervisor')
      setD((r?.data ?? r) as CareSup)
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['tickets'] })

  return (
    <Page
      title="Care Supervisor"
      subtitle="Team mail load & SLA"
      actions={
        <button onClick={() => navigate('/care/inbox')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: NAVY, color: '#fff', border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18 }}>mail</span>Open Inbox
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {loading && !d ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={26} /></div>
      ) : d && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: SP[3], marginBottom: SP[4] }}>
            <Kpi label="Open Mails"     value={fmtNum(d.open)}           icon="mail"            accent={NAVY} />
            <Kpi label="Unassigned"     value={fmtNum(d.unassigned)}     icon="person_off"      accent={PURPLE} />
            <Kpi label="Awaiting Reply" value={fmtNum(d.awaiting_reply)} icon="mark_email_unread" accent={AMBER} />
            <Kpi label="SLA At Risk"    value={fmtNum(d.sla_at_risk)}    icon="warning"         accent={RED} />
            <Kpi label="Resolved Today" value={fmtNum(d.resolved_today)} icon="check_circle"    accent={GREEN} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 16, alignItems: 'start' }}>
            {/* Agent load */}
            <SectionCard title="Agent Load" subtitle={`${d.agents.length} agent${d.agents.length === 1 ? '' : 's'} with mail`}>
              {d.agents.length === 0 ? (
                <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>No mail is assigned to agents yet.</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.sm }}>
                    <thead>
                      <tr style={{ textAlign: 'left', color: 'var(--txt3)', fontSize: TEXT.xs }}>
                        <th style={{ padding: '6px 8px', fontWeight: FW.semibold }}>Agent</th>
                        <th style={{ padding: '6px 8px', fontWeight: FW.semibold, textAlign: 'right' }}>Open</th>
                        <th style={{ padding: '6px 8px', fontWeight: FW.semibold, textAlign: 'right' }}>Resolved Today</th>
                        <th style={{ padding: '6px 8px', fontWeight: FW.semibold, textAlign: 'right' }}>Avg 1st Reply</th>
                        <th style={{ padding: '6px 8px', fontWeight: FW.semibold, textAlign: 'right' }}>SLA Risk</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.agents.map((a, i) => (
                        <tr key={i} style={{ borderTop: '1px solid var(--bdr)' }}>
                          <td style={{ padding: '8px', fontWeight: FW.semibold, color: 'var(--txt)' }}>{a.agent_name}</td>
                          <td style={{ ...NUM, padding: '8px', textAlign: 'right', color: 'var(--txt)' }}>{fmtNum(a.open)}</td>
                          <td style={{ ...NUM, padding: '8px', textAlign: 'right', color: 'var(--txt2)' }}>{fmtNum(a.resolved_today)}</td>
                          <td style={{ ...NUM, padding: '8px', textAlign: 'right', color: 'var(--txt2)' }}>{fmtMins(a.avg_first_response_mins)}</td>
                          <td style={{ ...NUM, padding: '8px', textAlign: 'right', fontWeight: FW.bold, color: a.sla_at_risk > 0 ? RED : 'var(--txt3)' }}>{fmtNum(a.sla_at_risk)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>

            {/* Unassigned pool */}
            <SectionCard title="Unassigned Pool" badge={d.unassigned}>
              {d.unassigned_tickets.length === 0 ? (
                <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>Nothing waiting — all mail is owned.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {d.unassigned_tickets.map((t, i) => {
                    const pColor = t.priority === 'urgent' || t.priority === 'high' ? RED : t.priority === 'medium' || t.priority === 'normal' ? AMBER : BLUE
                    return (
                      <div key={t.id}
                        onClick={() => navigate('/care/inbox')}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 2px', borderBottom: i < d.unassigned_tickets.length - 1 ? '1px solid var(--bdr)' : 'none', cursor: 'pointer' }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                        <div style={{ width: 3, alignSelf: 'stretch', background: pColor, borderRadius: 2, flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.customer_name || 'Unknown'}</div>
                          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.subject || '(no subject)'}</div>
                        </div>
                        <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', flexShrink: 0 }}>{fmtDatetime(t.last_at || t.created_at)}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </SectionCard>
          </div>
        </>
      )}
    </Page>
  )
}
