import { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Page, Spinner, ErrBanner, StatusBadge } from '../../components/UI'
import { useIsMobile } from '../../hooks/useMediaQuery'
import ReplyComposer from './ReplyComposer'
import CareThread from './CareThread'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime, fmtDate } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, BLUE, PURPLE, FW, RADIUS, TEXT } from '../../lib/design'
import { toast } from 'sonner'
import {
  CARE_SUBGROUPS, SUBGROUP_ICON, CHANNEL_ICON, DetailResp, MailTicket,
  initials, replyAllRecipients,
} from './mailUtils'

// ── Full-page Care mail view ─────────────────────────────────────────────────
// Care is an email desk: this is a purpose-built email client view, distinct from
// the shared call-centre ticket workbench at /helpdesk/:id. The conversation is the
// hero, the reply is the full composer, and the right rail is customer context.

interface HistTicket { id: number; ticket_ref: string; channel: string; status: string; subject: string; created_at: string; last_at?: string; assigned_to_name?: string }
interface HistCall { id: number; direction: string; outcome: string; duration_sec: number; agent_name?: string; started_at: string }

function ContextPanel({ ticket, onOpen }: { ticket: MailTicket; onOpen: (id: number) => void }) {
  const navigate = useNavigate()
  const [data, setData] = useState<{ tickets: HistTicket[]; calls: HistCall[] } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const p = new URLSearchParams()
    if (ticket.customer_cif) p.set('cif', ticket.customer_cif)
    if (ticket.customer_email) p.set('email', ticket.customer_email)
    p.set('exclude', String(ticket.id))
    apiFetch<any>(`/api/helpdesk/customer-history?${p}`)
      .then(r => setData((r?.data ?? r) as { tickets: HistTicket[]; calls: HistCall[] }))
      .catch(() => setData({ tickets: [], calls: [] }))
      .finally(() => setLoading(false))
  }, [ticket.customer_cif, ticket.customer_email, ticket.id])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '16px 16px 28px' }}>
      {/* Identity card */}
      <div style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: 14, background: 'var(--card)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 42, height: 42, borderRadius: '50%', flexShrink: 0, background: `${NAVY}14`, color: NAVY, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT.sm, fontWeight: FW.bold }}>
            {initials(ticket.customer_name)}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ticket.customer_name || 'Unknown customer'}</div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{ticket.customer_cif ? `CIF ${ticket.customer_cif}` : 'No CIF linked'}</div>
          </div>
        </div>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {ticket.customer_email && <Row icon="mail" text={ticket.customer_email} />}
          {ticket.customer_phone && <Row icon="call" text={ticket.customer_phone} />}
        </div>
        {ticket.customer_cif && (
          <button onClick={() => navigate(`/customers/${ticket.customer_cif}`)}
            style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 5, width: '100%', justifyContent: 'center', padding: '8px 12px', border: `1px solid ${NAVY}25`, background: `${NAVY}08`, color: NAVY, borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.bold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>person</span>Open Customer 360
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}><Spinner size={16} /></div>
      ) : (
        <>
          <div>
            <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>Other Mail ({data?.tickets.length ?? 0})</div>
            {(data?.tickets.length ?? 0) === 0 ? (
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>No other tickets.</div>
            ) : data!.tickets.map(t => (
              <button key={t.id} onClick={() => onOpen(t.id)} title="Open this mail"
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 10px', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, marginBottom: 8, background: 'transparent', cursor: 'pointer' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)' }}>{CHANNEL_ICON[t.channel] ?? 'confirmation_number'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.subject || '(no subject)'}</div>
                  <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{t.channel} · {fmtDate(t.last_at || t.created_at)}</div>
                </div>
                <StatusBadge status={t.status} size="sm" />
              </button>
            ))}
          </div>

          <div>
            <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>Recent Calls ({data?.calls.length ?? 0})</div>
            {(data?.calls.length ?? 0) === 0 ? (
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>No calls on record.</div>
            ) : data!.calls.map(c => {
              const inbound = c.direction === 'inbound'
              const dur = c.duration_sec > 0 ? `${Math.floor(c.duration_sec / 60)}m ${c.duration_sec % 60}s` : '—'
              return (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--bdr)' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 16, color: inbound ? BLUE : PURPLE }}>{inbound ? 'call_received' : 'call_made'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt)', fontWeight: FW.medium }}>{c.agent_name || 'Agent'} · {c.outcome}</div>
                    <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{fmtDatetime(c.started_at)}</div>
                  </div>
                  <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)' }}>{dur}</span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function Row({ icon, text }: { icon: string; text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: TEXT.xs, color: 'var(--txt2)', minWidth: 0 }}>
      <span className="material-symbols-rounded" style={{ fontSize: 15, color: 'var(--txt3)', flexShrink: 0 }}>{icon}</span>
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
    </div>
  )
}

export default function CareMailView() {
  const { id } = useParams<{ id: string }>()
  const ticketId = Number(id)
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [data, setData] = useState<DetailResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const load = useCallback((silent = false) => {
    if (!silent) setLoading(true)
    apiFetch<DetailResp>(`/api/helpdesk/tickets/${ticketId}`)
      .then(d => setData(d)).catch(e => setErr(e.message)).finally(() => setLoading(false))
  }, [ticketId])

  useEffect(() => { load() }, [load])

  async function setStatus(status: string) {
    try { await apiFetch(`/api/helpdesk/tickets/${ticketId}`, { method: 'PATCH', body: JSON.stringify({ status }) }); toast.success(status === 'resolved' ? 'Marked resolved' : 'Reopened'); load(true) }
    catch (e: any) { toast.error(e.message ?? 'Failed to update') }
  }
  async function claim() {
    try { await apiPost(`/api/helpdesk/tickets/${ticketId}/claim`, {}); toast.success('Assigned to you'); load(true) }
    catch (e: any) { toast.error(e.message ?? 'Failed to assign') }
  }
  async function toggleFlag() {
    if (!data) return
    setMenuOpen(false)
    try { await apiPost(`/api/helpdesk/tickets/${ticketId}/flag`, { flagged: !data.ticket.is_flagged }); load(true) }
    catch (e: any) { toast.error(e.message ?? 'Could not flag') }
  }
  async function changeSubgroup(sg: string) {
    setMenuOpen(false)
    try { await apiPost(`/api/helpdesk/tickets/${ticketId}/subgroup`, { subgroup: sg }); load(true) }
    catch (e: any) { toast.error(e.message ?? 'Could not set folder') }
  }
  async function requestDelete() {
    setMenuOpen(false)
    const reason = window.prompt('Why should this mail be deleted? A colleague has to approve it before it is removed.')
    if (reason === null) return
    try { await apiPost(`/api/helpdesk/tickets/${ticketId}/delete-request`, { reason }); toast.success('Deletion request sent for approval'); load(true) }
    catch (e: any) { toast.error(e.message ?? 'Could not request deletion') }
  }
  async function escalate() {
    const reason = window.prompt('Escalate this mail to a supervisor. What is the reason?')
    if (!reason) return
    try {
      await apiPost(`/api/helpdesk/tickets/${ticketId}/escalate`, { reason, to_user_id: 0 })
      toast.success('Escalated. A supervisor has been notified')
      load(true)
    } catch (e: any) { toast.error(e.message ?? 'Could not escalate') }
  }
  async function clearEscalation() {
    try { await apiPost(`/api/helpdesk/tickets/${ticketId}/escalation/resolve`, {}); toast.success('Escalation cleared'); load(true) }
    catch (e: any) { toast.error(e.message ?? 'Could not clear') }
  }

  if (loading) return <Page title="Mail" back={{ label: 'Care Inbox', to: '/care/inbox' }}><div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={26} /></div></Page>
  if (err || !data) return <Page title="Mail" back={{ label: 'Care Inbox', to: '/care/inbox' }}><ErrBanner error={err ?? 'Could not load this mail'} onRetry={load} /></Page>

  const t = data.ticket
  const terminal = ['resolved', 'closed'].includes(t.status)
  const escalated = !!t.escalated_at && !t.escalation_resolved_at
  const ccRecipients = replyAllRecipients(data.messages ?? [], t.customer_email)

  const ghostBtn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, fontWeight: FW.semibold,
    color: 'var(--txt2)', background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: '7px 12px', cursor: 'pointer',
  }

  return (
    <Page noPad back={{ label: 'Care Inbox', to: '/care/inbox' }}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ padding: '14px 22px', borderBottom: '1px solid var(--bdr)', background: 'var(--card)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {t.is_flagged && <span className="material-symbols-rounded" style={{ fontSize: 20, color: AMBER, fontVariationSettings: "'FILL' 1", flexShrink: 0 }}>flag</span>}
                <div style={{ fontSize: TEXT.xl, fontWeight: FW.bold, color: 'var(--txt)', lineHeight: 1.25 }}>{t.subject || '(no subject)'}</div>
              </div>
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 4 }}>
                {t.customer_name || 'Unknown'}{t.customer_email ? ` · ${t.customer_email}` : ''}
              </div>
              {ccRecipients.length > 0 && (
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>group</span>
                  Cc: {ccRecipients.join(', ')}
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <StatusBadge status={t.status} size="sm" />
                <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)' }}>{t.assigned_to_name ? `Assigned to ${t.assigned_to_name}` : 'Unassigned'}</span>
                {t.mail_subgroup && <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: NAVY, background: `${NAVY}0f`, padding: '2px 8px', borderRadius: RADIUS.full }}>{t.mail_subgroup}</span>}
                {t.delete_requested && <span style={{ fontSize: TEXT['2xs'], color: RED, background: `${RED}12`, border: `1px solid ${RED}30`, borderRadius: RADIUS.full, padding: '2px 8px', fontWeight: FW.bold }}>Deletion pending approval</span>}
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, position: 'relative', flexWrap: 'wrap' }}>
              {!t.assigned_to && <button onClick={claim} style={{ ...ghostBtn, color: NAVY, borderColor: `${NAVY}30` }}><span className="material-symbols-rounded" style={{ fontSize: 16 }}>person_add</span>Assign to me</button>}
              {escalated
                ? <button onClick={clearEscalation} style={{ ...ghostBtn, color: RED, borderColor: `${RED}30` }}><span className="material-symbols-rounded" style={{ fontSize: 16 }}>check</span>Clear escalation</button>
                : <button onClick={escalate} style={{ ...ghostBtn, color: AMBER, borderColor: `${AMBER}40` }}><span className="material-symbols-rounded" style={{ fontSize: 16 }}>priority_high</span>Escalate</button>}
              {terminal
                ? <button onClick={() => setStatus('open')} style={ghostBtn}><span className="material-symbols-rounded" style={{ fontSize: 16 }}>replay</span>Reopen</button>
                : <button onClick={() => setStatus('resolved')} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, fontWeight: FW.bold, color: '#fff', background: GREEN, border: 'none', borderRadius: RADIUS.md, padding: '7px 14px', cursor: 'pointer' }}><span className="material-symbols-rounded" style={{ fontSize: 16 }}>check</span>Resolve</button>}
              <button onClick={() => setMenuOpen(o => !o)} title="More actions" style={{ ...ghostBtn, padding: '7px 9px' }}><span className="material-symbols-rounded" style={{ fontSize: 18 }}>more_vert</span></button>
              {menuOpen && (
                <>
                  <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
                  <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 31, minWidth: 220, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, boxShadow: '0 12px 34px rgba(0,0,0,0.18)', overflow: 'hidden', padding: 4 }}>
                    <MenuItem icon="flag" label={t.is_flagged ? 'Remove flag' : 'Flag this mail'} onClick={toggleFlag} />
                    <div style={{ padding: '8px 10px 4px', fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Move to folder</div>
                    <MenuItem icon="inbox" label="Unsorted" onClick={() => changeSubgroup('')} checked={!t.mail_subgroup} />
                    {CARE_SUBGROUPS.map(s => <MenuItem key={s} icon={SUBGROUP_ICON[s] || 'label'} label={s} onClick={() => changeSubgroup(s)} checked={t.mail_subgroup === s} />)}
                    {!t.delete_requested && t.status !== 'closed' && (
                      <>
                        <div style={{ height: 1, background: 'var(--bdr)', margin: '4px 0' }} />
                        <MenuItem icon="delete" label="Request deletion" onClick={requestDelete} danger />
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          {escalated && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, padding: '9px 14px', background: `${RED}0d`, border: `1px solid ${RED}40`, borderRadius: RADIUS.md }}>
              <span className="material-symbols-rounded" style={{ fontSize: 18, color: RED }}>priority_high</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>Escalated{t.escalated_to_name ? ` to ${t.escalated_to_name}` : ' to supervisors'}</div>
                {t.escalation_reason && <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{t.escalation_reason}</div>}
              </div>
            </div>
          )}
        </div>

        {/* Body: conversation + composer | context */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 14, background: 'var(--bg)' }}>
              <div style={{ width: '100%', maxWidth: 900, margin: '0 auto' }}>
                <CareThread ticket={t} messages={data.messages ?? []} />
              </div>
            </div>
            <ReplyComposer ticketId={ticketId} customerName={t.customer_name} customerEmail={t.customer_email} ccRecipients={replyAllRecipients(data.messages ?? [], t.customer_email)} onSent={() => load(true)} />
          </div>
          {!isMobile && (
            <div style={{ width: 320, minWidth: 320, borderLeft: '1px solid var(--bdr)', background: 'var(--card)', overflowY: 'auto', flexShrink: 0 }}>
              <ContextPanel ticket={t} onOpen={(tid) => navigate(`/care/mail/${tid}`)} />
            </div>
          )}
        </div>
      </div>
    </Page>
  )
}

function MenuItem({ icon, label, onClick, danger, checked }: { icon: string; label: string; onClick: () => void; danger?: boolean; checked?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', borderRadius: RADIUS.md, background: 'transparent', cursor: 'pointer', fontSize: TEXT.sm, fontWeight: FW.medium, color: danger ? RED : 'var(--txt)' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 18, color: danger ? RED : 'var(--txt3)' }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {checked && <span className="material-symbols-rounded" style={{ fontSize: 17, color: NAVY }}>check</span>}
    </button>
  )
}
