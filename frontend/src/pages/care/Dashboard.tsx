import { useLiveData } from '../../hooks/useRealtime'
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { SectionCard, Spinner, ErrBanner, StatusBadge } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { toast } from 'sonner'
import { fmtDatetime, fmtNum } from '../../lib/fmt'
import { RED, AMBER, GREEN, BLUE, PURPLE, FW, TEXT } from '../../lib/design'
import { WorkspaceHero, MyDaySection, MyDayTile, PresenceControl, HeroButton, myUserId } from '../../components/MyWorkspace'

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

export default function CareDashboard() {
  const navigate = useNavigate()
  const [d, setD] = useState<CareDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [status, setStatus] = useState('available')

  const load = useCallback(async (silent = false) => {
    setErr(null)
    try {
      const r = await apiFetch<any>('/api/helpdesk/care-dashboard')
      setD((r?.data ?? r) as CareDash)
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['tickets'] })
  useEffect(() => { const id = setInterval(load, 45000); return () => clearInterval(id) }, [load])

  const changeStatus = useCallback(async (s: string) => {
    setStatus(s)
    const uid = myUserId()
    if (!uid) return
    try { await apiFetch(`/api/helpdesk/agents/${uid}/status`, { method: 'PUT', body: JSON.stringify({ status: s }) }) }
    catch (e: any) { toast.error(e?.message || 'Could not update status') }
  }, [])

  if (loading && !d) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={26} /></div>
  if (!d) return <ErrBanner error={err} onRetry={load} />

  const clearMax = Math.max(1, d.resolved_today + d.awaiting_reply)

  return (
    <>
      <ErrBanner error={err} onRetry={load} />

      <WorkspaceHero
        presence={<PresenceControl status={status} onChange={changeStatus} />}
        subline={d.awaiting_reply > 0
          ? <><strong style={{ color: '#fff' }}>{fmtNum(d.awaiting_reply)}</strong> customer{d.awaiting_reply === 1 ? '' : 's'} waiting on a reply{d.sla_at_risk > 0 ? <> · <strong style={{ color: '#FCA5A5' }}>{fmtNum(d.sla_at_risk)}</strong> at SLA risk</> : ''}</>
          : "Inbox is under control. Nothing awaiting a reply right now."}
        ring={{ value: d.resolved_today, max: clearMax, unit: 'mails' }}
        stats={[
          { label: 'Open Mails', value: fmtNum(d.open_mails) },
          { label: 'Awaiting Reply', value: fmtNum(d.awaiting_reply), color: d.awaiting_reply > 0 ? '#FCA5A5' : '#fff' },
          { label: 'Unassigned', value: fmtNum(d.unassigned) },
          { label: 'Resolved Today', value: fmtNum(d.resolved_today), color: '#4ADE80' },
          { label: 'SLA At Risk', value: fmtNum(d.sla_at_risk), color: d.sla_at_risk > 0 ? '#FCA5A5' : '#fff' },
          { label: 'Avg 1st Response', value: fmtMins(d.avg_first_response_mins) },
        ]}
        actions={<>
          <HeroButton icon="mail" label="Open Inbox" primary onClick={() => navigate('/care/inbox')} />
          <HeroButton icon="group" label="Customer Directory" onClick={() => navigate('/care/customers')} />
          <HeroButton icon="menu_book" label="Knowledge Base" onClick={() => navigate('/care/knowledge-base')} />
          <HeroButton icon="description" label="Templates" onClick={() => navigate('/care/canned')} />
        </>}
      />

      {/* ── My Day ── */}
      <MyDaySection hint="mail that needs you now">
        <MyDayTile icon="mark_email_unread" count={fmtNum(d.awaiting_reply)} label="Awaiting reply"
          sub={d.awaiting_reply > 0 ? 'customers waiting on us' : 'all replied'}
          color={AMBER} urgent={d.awaiting_reply > 0} onClick={() => navigate('/care/inbox')} />
        <MyDayTile icon="warning" count={fmtNum(d.sla_at_risk)} label="SLA at risk"
          sub={d.sla_at_risk > 0 ? 'due ≤ 2h or overdue' : 'all within SLA'}
          color={d.sla_at_risk > 0 ? RED : GREEN} urgent={d.sla_at_risk > 0} onClick={() => navigate('/care/inbox')} />
        <MyDayTile icon="person_off" count={fmtNum(d.unassigned)} label="Unassigned"
          sub="grab one to own it" color={PURPLE} urgent={d.unassigned > 0} onClick={() => navigate('/care/inbox')} />
        <MyDayTile icon="check_circle" count={fmtNum(d.resolved_today)} label="Resolved today"
          sub="closed by the desk today" color={BLUE} />
      </MyDaySection>

      <SectionCard title="Recent Mail" subtitle={`${d.recent.length} most recent`}>
        {d.recent.length === 0 ? (
          <div style={{ padding: '30px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>No mail yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {d.recent.map((m, i) => (
              <div key={m.id}
                onClick={() => navigate(`/care/inbox?mail=${m.id}`)}
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
  )
}
