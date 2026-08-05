import { useLiveData } from '../../hooks/useRealtime'
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, Spinner, ErrBanner, StatusBadge } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime, fmtNum } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, BLUE, PURPLE, FW, RADIUS, SP, TEXT, SORA, NUM } from '../../lib/design'

interface CareRecent {
  id: number
  ticket_ref: string
  subject: string
  status: string
  priority?: string
  customer_name?: string
  customer_cif?: string
  created_at: string
  last_message_at?: string
}
interface CareDash {
  open_mails: number
  unassigned: number
  awaiting_reply: number
  resolved_today: number
  sla_at_risk: number
  avg_first_response_mins: number | null
  recent: CareRecent[]
}

function fmtMins(m: number | null | undefined): string {
  if (m == null) return '—'
  if (m < 60) return `${Math.round(m)}m`
  const h = Math.floor(m / 60)
  return `${h}h ${Math.round(m % 60)}m`
}

function Kpi({ label, value, sub, icon, accent }: { label: string; value: string | number; sub?: string; icon: string; accent: string }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.lg, padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontWeight: FW.semibold, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
        <span className="material-symbols-rounded" style={{ fontSize: 18, color: accent }}>{icon}</span>
      </div>
      <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: 'var(--txt)' }}>{value}</div>
      {sub && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

export default function CareDashboard() {
  const navigate = useNavigate()
  const [d, setD] = useState<CareDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const r = await apiFetch<any>('/api/helpdesk/care-dashboard')
      setD((r?.data ?? r) as CareDash)
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['tickets'] })

  return (
    <Page
      title="Care Dashboard"
      subtitle="Customer mail workload"
      actions={
        <button onClick={() => navigate('/care/inbox')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: NAVY, color: '#fff', border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', fontFamily: SORA }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18 }}>mail</span>
          Open Care Inbox
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {loading && !d ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={26} /></div>
      ) : d && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: SP[3], marginBottom: SP[4] }}>
            <Kpi label="Open Mails"      value={fmtNum(d.open_mails)}     icon="mail"            accent={NAVY}   sub="in the inbox" />
            <Kpi label="Awaiting Reply"  value={fmtNum(d.awaiting_reply)} icon="mark_email_unread" accent={AMBER} sub="customer waiting" />
            <Kpi label="Unassigned"      value={fmtNum(d.unassigned)}     icon="person_off"      accent={PURPLE} sub="need an owner" />
            <Kpi label="Resolved Today"  value={fmtNum(d.resolved_today)} icon="check_circle"    accent={GREEN}  sub="closed today" />
            <Kpi label="SLA At Risk"     value={fmtNum(d.sla_at_risk)}    icon="warning"         accent={RED}    sub="due ≤ 2h / overdue" />
            <Kpi label="Avg 1st Response" value={fmtMins(d.avg_first_response_mins)} icon="timer" accent={BLUE} sub="last 30 days" />
          </div>

          <SectionCard title="Recent Mail" subtitle={`${d.recent.length} most recent`}>
            {d.recent.length === 0 ? (
              <div style={{ padding: '30px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>No mail yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {d.recent.map((m, i) => (
                  <div key={m.id}
                    onClick={() => navigate('/care/inbox')}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 4px', borderBottom: i < d.recent.length - 1 ? '1px solid var(--bdr)' : 'none', cursor: 'pointer' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.customer_name || 'Unknown'}</div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.subject || '(no subject)'}</div>
                    </div>
                    <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', flexShrink: 0 }}>{fmtDatetime(m.last_message_at || m.created_at)}</span>
                    <StatusBadge status={m.status} size="sm" />
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </>
      )}
    </Page>
  )
}
