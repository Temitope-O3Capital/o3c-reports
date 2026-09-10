import { useLiveData } from '../../hooks/useRealtime'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Page, Spinner, ErrBanner, TblSearch, StatusBadge, Modal } from '../../components/UI'
import { useIsMobile } from '../../hooks/useMediaQuery'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime, fmtDate } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, BLUE, PURPLE, FW, RADIUS, TEXT } from '../../lib/design'
import { toast } from 'sonner'
import ReplyComposer from './ReplyComposer'
import CareThread from './CareThread'
import { replyAllRecipients } from './mailUtils'

// Care = customer mail. These are helpdesk tickets on the 'email' channel, shown
// as an email inbox. The ticket stays the system of record underneath.

// Inbox subgroups — keep in sync with careSubgroups in backend handlers/helpdesk_care.go.
const CARE_SUBGROUPS = ['New Registration', 'Support', 'Complaints', 'Transactions', 'Cards', 'Loans', 'Fixed Deposit', 'General']
// Each folder gets a glyph so the rail reads as folders, not a wall of text.
const SUBGROUP_ICON: Record<string, string> = {
  'New Registration': 'person_add', 'Support': 'support_agent', 'Complaints': 'sentiment_dissatisfied',
  'Transactions': 'receipt_long', 'Cards': 'credit_card', 'Loans': 'account_balance',
  'Fixed Deposit': 'savings', 'General': 'inbox',
}
interface MailTicket {
  id: number
  ticket_ref: string
  subject: string
  status: string
  priority: string
  customer_name?: string
  customer_email?: string
  customer_cif?: string
  created_at: string
  last_message_at?: string
  last_message_preview?: string
  description_preview?: string
  description?: string
  is_flagged?: boolean
  mail_subgroup?: string
  escalated?: boolean
  delete_requested?: boolean
}

interface Message {
  id: number
  direction: 'inbound' | 'outbound'
  author_name?: string
  author_user_name?: string
  body_text: string
  body_html?: string
  is_internal_note?: boolean
  created_at: string
  send_state?: 'pending' | 'sending' | 'sent' | 'recalled' | 'failed'
  send_after?: string
}

interface DetailResp {
  ticket: MailTicket & { customer_phone?: string; assigned_to?: number; assigned_to_name?: string }
  messages: Message[]
}

interface CannedResponse {
  id: number
  title?: string
  name?: string
  category?: string
  body?: string
  body_text?: string
  body_html?: string
  subject?: string
}

const STATUS_FILTERS = [
  { key: 'open', label: 'Open' },
  { key: 'pending', label: 'Pending' },
  { key: 'resolved', label: 'Resolved' },
  { key: '', label: 'All' },
] as const

const OWNER_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'mine', label: 'Mine' },
  { key: 'unassigned', label: 'Unassigned' },
] as const

function initials(name?: string) {
  return (name || '?').split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2)
}
function priorityColor(p?: string) {
  return p === 'urgent' || p === 'high' ? RED : p === 'medium' || p === 'normal' ? AMBER : GREEN
}

// ── Segmented control ─────────────────────────────────────────────────────────
// One compact pill-group replaces stacked rows of loose buttons. Every filter in
// the list header uses this so they read as one system.
function Segmented({ options, value, onChange }: {
  options: readonly { key: string; label: string }[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div style={{ display: 'flex', padding: 2, gap: 2, background: 'var(--th-bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md }}>
      {options.map(o => {
        const on = value === o.key
        return (
          <button key={o.key || 'all'} type="button" onClick={() => onChange(o.key)}
            style={{
              flex: 1, padding: '5px 0', border: 'none', borderRadius: RADIUS.sm, cursor: 'pointer',
              fontSize: TEXT['2xs'], fontWeight: FW.bold, whiteSpace: 'nowrap',
              background: on ? 'var(--card)' : 'transparent',
              color: on ? NAVY : 'var(--txt3)',
              boxShadow: on ? 'var(--card-shadow)' : 'none',
            }}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// ── Customer history (read-only context + internal notes) ─────────────────────

interface HistTicket {
  id: number; ticket_ref: string; channel: string; status: string; priority?: string
  subject: string; created_at: string; last_at?: string; assigned_to_name?: string
}
interface HistCall {
  id: number; direction: string; outcome: string; duration_sec: number
  agent_name?: string; customer_name?: string; started_at: string
}

const CHANNEL_ICON: Record<string, string> = {
  call: 'call', email: 'mail', sms: 'sms', whatsapp: 'chat', social: 'groups', web: 'language',
}

// One prior ticket — a clickable row that opens that ticket in the main reading pane.
function HistoryTicket({ t, onOpen }: { t: HistTicket; onOpen: (id: number) => void }) {
  return (
    <button type="button" onClick={() => onOpen(t.id)} title="Open this mail"
      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 10px', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, marginBottom: 8, background: 'transparent', cursor: 'pointer' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)' }}>{CHANNEL_ICON[t.channel] ?? 'confirmation_number'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.subject || '(no subject)'}</div>
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{t.channel} · {t.assigned_to_name || 'unassigned'} · {fmtDate(t.last_at || t.created_at)}</div>
      </div>
      <StatusBadge status={t.status} size="sm" />
      <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)' }}>chevron_right</span>
    </button>
  )
}

function CustomerHistory({ cif, email, excludeId, onClose, onOpen }: { cif?: string; email?: string; excludeId: number; onClose: () => void; onOpen: (id: number) => void }) {
  const [data, setData] = useState<{ tickets: HistTicket[]; calls: HistCall[] } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const p = new URLSearchParams()
    if (cif) p.set('cif', cif)
    if (email) p.set('email', email)
    p.set('exclude', String(excludeId))
    apiFetch<any>(`/api/helpdesk/customer-history?${p}`)
      .then(r => setData((r?.data ?? r) as { tickets: HistTicket[]; calls: HistCall[] }))
      .catch(() => setData({ tickets: [], calls: [] }))
      .finally(() => setLoading(false))
  }, [cif, email, excludeId])

  return (
    <div style={{ width: 288, minWidth: 288, borderLeft: '1px solid var(--bdr)', background: 'var(--card)', display: 'flex', flexDirection: 'column', flexShrink: 0, overflowY: 'auto' }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--bdr)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)' }}>Customer History</div>
          <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>Tap a mail to open it</div>
        </div>
        <button onClick={onClose} title="Hide context" style={{ display: 'inline-flex', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt3)', padding: 4 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
        </button>
      </div>
      <div style={{ padding: '12px 14px' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 30 }}><Spinner size={16} /></div>
        ) : !cif && !email ? (
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>No CIF or email on this mail. Can't match prior history.</div>
        ) : (
          <>
            <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
              Other Tickets ({data?.tickets.length ?? 0})
            </div>
            {(data?.tickets.length ?? 0) === 0 ? (
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 14 }}>No other tickets.</div>
            ) : (
              <div style={{ marginBottom: 14 }}>{data!.tickets.map(t => <HistoryTicket key={t.id} t={t} onOpen={onOpen} />)}</div>
            )}

            <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>
              Recent Calls ({data?.calls.length ?? 0})
            </div>
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
          </>
        )}
      </div>
    </div>
  )
}


// ── Overflow (⋯) menu for secondary ticket actions ────────────────────────────
function OverflowMenu({ items, onClose }: { items: React.ReactNode; onClose: () => void }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
      <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 31, minWidth: 210, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, boxShadow: '0 12px 34px rgba(0,0,0,0.18)', overflow: 'hidden', padding: 4 }}>
        {items}
      </div>
    </>
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
function MenuLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '8px 10px 4px', fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{children}</div>
}

// ── Reading pane ──────────────────────────────────────────────────────────────
function MailThread({ ticketId, onReplied, onBack, onOpenTicket, isMobile }: { ticketId: number; onReplied: () => void; onBack?: () => void; onOpenTicket: (id: number) => void; isMobile: boolean }) {
  const navigate = useNavigate()
  const [data, setData] = useState<DetailResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [flagBusy, setFlagBusy] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    apiFetch<DetailResp>(`/api/helpdesk/tickets/${ticketId}`)
      .then(d => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [ticketId])

  useEffect(() => { load() }, [load])

  async function claim() {
    try {
      await apiPost(`/api/helpdesk/tickets/${ticketId}/claim`, {})
      toast.success('Assigned to you')
      load(); onReplied()
    } catch (e: any) { toast.error(e.message ?? 'Failed to assign') }
  }

  async function setStatus(status: string) {
    try {
      await apiFetch(`/api/helpdesk/tickets/${ticketId}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      toast.success(status === 'resolved' ? 'Marked resolved' : 'Reopened')
      load(); onReplied()
    } catch (e: any) { toast.error(e.message ?? 'Failed to update') }
  }

  async function toggleFlag() {
    const t = data?.ticket
    if (!t) return
    setFlagBusy(true); setMenuOpen(false)
    try {
      await apiPost(`/api/helpdesk/tickets/${ticketId}/flag`, { flagged: !t.is_flagged })
      load(); onReplied()
    } catch (e: any) { toast.error(e.message ?? 'Could not flag') }
    finally { setFlagBusy(false) }
  }

  async function changeSubgroup(sg: string) {
    setMenuOpen(false)
    try {
      await apiPost(`/api/helpdesk/tickets/${ticketId}/subgroup`, { subgroup: sg })
      load(); onReplied()
    } catch (e: any) { toast.error(e.message ?? 'Could not set subgroup') }
  }

  async function requestDelete() {
    setMenuOpen(false)
    const reason = window.prompt('Why should this mail be deleted? A colleague has to approve it before it is removed.')
    if (reason === null) return
    try {
      await apiPost(`/api/helpdesk/tickets/${ticketId}/delete-request`, { reason })
      toast.success('Deletion request sent for a team member to approve')
      load(); onReplied()
    } catch (e: any) { toast.error(e.message ?? 'Could not request deletion') }
  }

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={22} /></div>
  if (!data) return <div style={{ padding: 40, color: 'var(--txt2)' }}>Could not load this mail.</div>

  const t = data.ticket
  const terminal = ['resolved', 'closed'].includes(t.status)

  const ghostBtn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, fontWeight: FW.semibold,
    color: 'var(--txt2)', background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: '6px 11px', cursor: 'pointer',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header — subject + status + primary actions + overflow menu */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--bdr)', background: 'var(--card)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          {isMobile && onBack && (
            <button onClick={onBack} title="Back to inbox" style={{ ...ghostBtn, padding: '6px 8px', flexShrink: 0 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 18 }}>arrow_back</span>
            </button>
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {t.is_flagged && <span className="material-symbols-rounded" style={{ fontSize: 18, color: AMBER, fontVariationSettings: "'FILL' 1", flexShrink: 0 }}>flag</span>}
              <div style={{ fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.subject || '(no subject)'}</div>
            </div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {t.customer_name || 'Unknown'}{t.customer_email ? ` · ${t.customer_email}` : ''}
            </div>
            {/* Compact context chips */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              <StatusBadge status={t.status} size="sm" />
              <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)' }}>{t.assigned_to_name ? `Assigned to ${t.assigned_to_name}` : 'Unassigned'}</span>
              {t.mail_subgroup && <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: NAVY, background: `${NAVY}0f`, padding: '2px 8px', borderRadius: RADIUS.full }}>{t.mail_subgroup}</span>}
              {t.delete_requested && <span style={{ fontSize: TEXT['2xs'], color: RED, background: `${RED}12`, border: `1px solid ${RED}30`, borderRadius: RADIUS.full, padding: '2px 8px', fontWeight: FW.bold }}>Deletion pending approval</span>}
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, position: 'relative' }}>
            {!isMobile && (
              <button onClick={() => setHistoryOpen(o => !o)} title="Customer context"
                style={{ ...ghostBtn, ...(historyOpen ? { color: NAVY, borderColor: `${NAVY}30`, background: `${NAVY}0c` } : {}) }}>
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>history</span>Context
              </button>
            )}
            {!t.assigned_to && (
              <button onClick={claim} style={{ ...ghostBtn, color: NAVY, borderColor: `${NAVY}30` }}>
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>person_add</span>Assign to me
              </button>
            )}
            {terminal ? (
              <button onClick={() => setStatus('open')} style={ghostBtn}>
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>replay</span>Reopen
              </button>
            ) : (
              <button onClick={() => setStatus('resolved')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, fontWeight: FW.bold, color: '#fff', background: GREEN, border: 'none', borderRadius: RADIUS.md, padding: '7px 14px', cursor: 'pointer' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 16 }}>check</span>Resolve
              </button>
            )}
            <button onClick={() => setMenuOpen(o => !o)} title="More actions" style={{ ...ghostBtn, padding: '6px 8px' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 18 }}>more_vert</span>
            </button>
            {menuOpen && (
              <OverflowMenu onClose={() => setMenuOpen(false)} items={
                <>
                  <MenuItem icon="flag" label={t.is_flagged ? 'Remove flag' : 'Flag this mail'} onClick={toggleFlag} />
                  {isMobile && <MenuItem icon="history" label="Customer context" onClick={() => { setHistoryOpen(o => !o); setMenuOpen(false) }} />}
                  {t.customer_cif && <MenuItem icon="person" label="Open Customer 360" onClick={() => { setMenuOpen(false); navigate(`/customers/${t.customer_cif}`) }} />}
                  <MenuItem icon="open_in_full" label="Open full page" onClick={() => { setMenuOpen(false); navigate(`/care/mail/${t.id}`) }} />
                  <MenuLabel>Move to folder</MenuLabel>
                  <MenuItem icon="inbox" label="Unsorted" onClick={() => changeSubgroup('')} checked={!t.mail_subgroup} />
                  {CARE_SUBGROUPS.map(s => (
                    <MenuItem key={s} icon={SUBGROUP_ICON[s] || 'label'} label={s} onClick={() => changeSubgroup(s)} checked={t.mail_subgroup === s} />
                  ))}
                  {!t.delete_requested && t.status !== 'closed' && (
                    <>
                      <div style={{ height: 1, background: 'var(--bdr)', margin: '4px 0' }} />
                      <MenuItem icon="delete" label="Request deletion" onClick={requestDelete} danger />
                    </>
                  )}
                </>
              } />
            )}
          </div>
        </div>
        {flagBusy && <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 4 }}>Updating…</div>}
      </div>

      {/* Body: conversation + reply on the left, customer history rail on the right */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
          {/* Conversation */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '18px 22px', background: 'var(--bg)' }}>
            <CareThread ticket={t} messages={data.messages ?? []} />
          </div>

          <ReplyComposer ticketId={ticketId} customerName={t.customer_name} customerEmail={t.customer_email}
            ccRecipients={replyAllRecipients(data.messages ?? [], t.customer_email)}
            onSent={() => { load(); onReplied() }} />
        </div>
        {historyOpen && !isMobile && <CustomerHistory cif={t.customer_cif} email={t.customer_email} excludeId={t.id} onClose={() => setHistoryOpen(false)} onOpen={onOpenTicket} />}
      </div>
    </div>
  )
}

// ── Filter chips + modal helpers ──────────────────────────────────────────────
function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: TEXT['2xs'], fontWeight: FW.bold, color: NAVY, background: `${NAVY}0f`, border: `1px solid ${NAVY}22`, borderRadius: RADIUS.full, padding: '3px 5px 3px 10px' }}>
      {label}
      <button onClick={onClear} title="Remove filter" style={{ display: 'inline-flex', border: 'none', background: 'none', cursor: 'pointer', color: NAVY, padding: 0 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span>
      </button>
    </span>
  )
}

function FilterSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  )
}

function FolderOption({ icon, label, count, active, onClick }: { icon: string; label: string; count?: number; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', borderRadius: RADIUS.full, cursor: 'pointer',
        border: `1px solid ${active ? NAVY : 'var(--bdr)'}`, background: active ? `${NAVY}12` : 'transparent', color: active ? NAVY : 'var(--txt2)', fontSize: TEXT.xs, fontWeight: FW.semibold }}>
      <span className="material-symbols-rounded" style={{ fontSize: 15, fontVariationSettings: active ? "'FILL' 1" : undefined }}>{icon}</span>
      {label}
      {count !== undefined && count > 0 && <span style={{ fontSize: TEXT['2xs'], color: active ? NAVY : 'var(--txt3)' }}>· {count}</span>}
    </button>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function CareInbox() {
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [searchParams, setSearchParams] = useSearchParams()
  const [items, setItems] = useState<MailTicket[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // Selection is pure state — the reading pane always follows a click. The URL is
  // synced from it (deep links + back/forward) but never gates what renders.
  const mailParam = searchParams.get('mail')
  const [selected, setSelected] = useState<number | null>(mailParam ? Number(mailParam) : null)
  const selectMail = useCallback((id: number) => setSelected(id), [])
  useEffect(() => {
    setSearchParams(prev => {
      const p = new URLSearchParams(prev)
      if (selected) p.set('mail', String(selected)); else p.delete('mail')
      return p
    }, { replace: true })
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const m = mailParam ? Number(mailParam) : null
    setSelected(prev => (prev === m ? prev : m))
  }, [mailParam])

  // Every filter lives in the pop-up modal; the active ones surface as removable chips.
  const [status, setStatus] = useState('open')
  const [owner, setOwner] = useState<'all' | 'mine' | 'unassigned'>('all')
  const [subgroup, setSubgroup] = useState('')
  const [flagged, setFlagged] = useState(false)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [sgCounts, setSgCounts] = useState<Record<string, number>>({})
  const [flaggedCount, setFlaggedCount] = useState(0)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setErr(null)
    try {
      const params = new URLSearchParams({ channel: 'email', per_page: '100' })
      if (status) params.set('status', status)
      if (owner === 'mine') params.set('assigned_to', 'me')
      else if (owner === 'unassigned') params.set('assigned_to', 'unassigned')
      if (subgroup) params.set('subgroup', subgroup)
      if (flagged) params.set('flagged', '1')
      if (debounced) params.set('search', debounced)
      const resp = await apiFetch<{ tickets: MailTicket[]; total: number }>(`/api/helpdesk/tickets?${params}`)
      setItems(resp.tickets ?? [])
      setTotal(resp.total ?? 0)
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [status, owner, subgroup, flagged, debounced])

  const loadCounts = useCallback(() => {
    apiFetch<any>('/api/helpdesk/subgroups')
      .then(r => {
        const rows = (r?.counts ?? r?.data?.counts ?? []) as { subgroup: string; n: number }[]
        const map: Record<string, number> = {}
        rows.forEach(x => { map[x.subgroup] = Number(x.n) || 0 })
        setSgCounts(map)
        const fc = (r?.flagged ?? r?.data?.flagged)
        if (typeof fc === 'number') setFlaggedCount(fc)
      })
      .catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadCounts() }, [loadCounts])
  useLiveData(() => { load(true); loadCounts() }, { topics: ['tickets'] })
  useEffect(() => {
    const h = setTimeout(() => setDebounced(search.trim()), 350)
    return () => clearTimeout(h)
  }, [search])

  // Active filters → chips shown above the list (and the count on the Filters button).
  const activeFilters: { key: string; label: string; onClear: () => void }[] = []
  if (status) activeFilters.push({ key: 'status', label: `Status: ${STATUS_FILTERS.find(s => s.key === status)?.label ?? status}`, onClear: () => setStatus('') })
  if (owner !== 'all') activeFilters.push({ key: 'owner', label: owner === 'mine' ? 'Assigned to me' : 'Unassigned', onClear: () => setOwner('all') })
  if (subgroup) activeFilters.push({ key: 'subgroup', label: subgroup, onClear: () => setSubgroup('') })
  if (flagged) activeFilters.push({ key: 'flagged', label: 'Flagged only', onClear: () => setFlagged(false) })

  function resetFilters() { setStatus('open'); setOwner('all'); setSubgroup(''); setFlagged(false); setSearch('') }

  return (
    <Page title="Care Inbox" subtitle="Customer mail, handled as tickets" noPad
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => navigate('/care/outbox')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: '7px 12px', cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>outbox</span>Outbox
          </button>
          <button onClick={() => navigate('/care/approvals')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: '7px 12px', cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>approval</span>Approvals
          </button>
        </div>
      }>
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden', position: 'relative' }}>
        {/* Mail list — hidden on mobile when a mail is open */}
        {!(isMobile && selected) && (
          <div style={{ width: isMobile ? '100%' : 340, minWidth: isMobile ? 0 : 300, maxWidth: isMobile ? undefined : 400, borderRight: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', background: 'var(--card)', flexShrink: 0 }}>
            <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>Inbox</span>
                <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', flexShrink: 0 }}>{total} mail{total !== 1 ? 's' : ''}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <TblSearch value={search} onChange={setSearch} placeholder="Search sender, subject, ref…" width={0} />
                </div>
                <button onClick={() => setFilterOpen(true)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, fontWeight: FW.semibold, color: activeFilters.length ? NAVY : 'var(--txt2)', background: activeFilters.length ? `${NAVY}0c` : 'var(--card)', border: `1px solid ${activeFilters.length ? NAVY + '30' : 'var(--bdr)'}`, borderRadius: RADIUS.md, padding: '7px 12px', cursor: 'pointer', flexShrink: 0 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>tune</span>Filters
                  {activeFilters.length > 0 && <span style={{ fontSize: 10, fontWeight: FW.bold, color: '#fff', background: NAVY, borderRadius: RADIUS.full, minWidth: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px' }}>{activeFilters.length}</span>}
                </button>
              </div>
              {activeFilters.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
                  {activeFilters.map(f => <FilterChip key={f.key} label={f.label} onClear={f.onClear} />)}
                  <button onClick={resetFilters} style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>Clear all</button>
                </div>
              )}
            </div>

            {err && <div style={{ padding: '10px 14px' }}><ErrBanner error={err} onRetry={load} /></div>}

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {loading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={16} /></div>
              ) : items.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--txt2)' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 40, color: 'var(--txt3)' }}>mark_email_read</span>
                  <div style={{ fontSize: TEXT.base, marginTop: 8 }}>No mail in this view.</div>
                </div>
              ) : items.map(m => {
                const on = selected === m.id
                const pColor = priorityColor(m.priority)
                return (
                  <div key={m.id} onClick={() => selectMail(m.id)}
                    style={{ display: 'flex', gap: 11, padding: '11px 14px', borderBottom: '1px solid var(--bdr)', cursor: 'pointer', background: on ? `${NAVY}0a` : undefined, borderLeft: `3px solid ${on ? NAVY : 'transparent'}` }}
                    onMouseEnter={e => { if (!on) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                    onMouseLeave={e => { if (!on) (e.currentTarget as HTMLElement).style.background = '' }}>
                    <div style={{ width: 34, height: 34, borderRadius: '50%', flexShrink: 0, background: `${pColor}18`, color: pColor, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT.xs, fontWeight: FW.bold }}>
                      {initials(m.customer_name)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                        <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 4 }}>
                          {m.is_flagged && <span className="material-symbols-rounded" style={{ fontSize: 13, color: AMBER, fontVariationSettings: "'FILL' 1" }}>flag</span>}
                          {m.customer_name || 'Unknown'}
                        </span>
                        <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', flexShrink: 0 }}>{fmtDate(m.last_message_at || m.created_at)}</span>
                      </div>
                      <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>{m.subject || '(no subject)'}</div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>{m.last_message_preview || m.description_preview || m.customer_email || m.ticket_ref}</div>
                      {(m.escalated || m.delete_requested || (!subgroup && m.mail_subgroup)) && (
                        <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                          {!subgroup && m.mail_subgroup && <span style={{ fontSize: 9, fontWeight: FW.bold, color: NAVY, background: `${NAVY}0f`, padding: '1px 6px', borderRadius: RADIUS.full }}>{m.mail_subgroup}</span>}
                          {m.escalated && <span style={{ fontSize: 9, fontWeight: FW.bold, color: RED, background: `${RED}12`, padding: '1px 6px', borderRadius: RADIUS.full }}>Escalated</span>}
                          {m.delete_requested && <span style={{ fontSize: 9, fontWeight: FW.bold, color: RED, background: `${RED}12`, padding: '1px 6px', borderRadius: RADIUS.full }}>Delete pending</span>}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Reading pane */}
        {!(isMobile && !selected) && (
          <div style={{ flex: 1, minWidth: 0, background: 'var(--bg)' }}>
            {selected ? (
              <MailThread key={selected} ticketId={selected} onReplied={() => load(true)} onBack={() => setSelected(null)} onOpenTicket={selectMail} isMobile={isMobile} />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--txt2)' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 52, color: 'var(--txt3)' }}>drafts</span>
                <span style={{ fontSize: TEXT.md }}>Select a mail to read and reply</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Filter modal — every filter lives here; the active ones show as chips above the list */}
      <Modal open={filterOpen} onClose={() => setFilterOpen(false)} title="Filter mail" width={460}
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', gap: 8 }}>
            <button onClick={resetFilters} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>Reset</button>
            <button onClick={() => setFilterOpen(false)} style={{ padding: '8px 20px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.bold, cursor: 'pointer' }}>Done</button>
          </div>
        }>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <FilterSection label="Status">
            <Segmented options={STATUS_FILTERS} value={status} onChange={setStatus} />
          </FilterSection>
          <FilterSection label="Assignment">
            <Segmented options={OWNER_FILTERS} value={owner} onChange={setOwner as (v: string) => void} />
          </FilterSection>
          <FilterSection label="Flagged">
            <button onClick={() => setFlagged(f => !f)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: RADIUS.md, border: `1px solid ${flagged ? AMBER : 'var(--bdr)'}`, background: flagged ? `${AMBER}10` : 'transparent', cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 20, color: flagged ? AMBER : 'var(--txt3)', fontVariationSettings: flagged ? "'FILL' 1" : undefined }}>flag</span>
              <span style={{ flex: 1, fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)' }}>Only show flagged mail{flaggedCount ? ` (${flaggedCount})` : ''}</span>
              <span className="material-symbols-rounded" style={{ fontSize: 22, color: flagged ? AMBER : 'var(--txt3)' }}>{flagged ? 'toggle_on' : 'toggle_off'}</span>
            </button>
          </FilterSection>
          <FilterSection label="Folder">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <FolderOption icon="all_inbox" label="All folders" active={!subgroup} onClick={() => setSubgroup('')} />
              {CARE_SUBGROUPS.map(s => (
                <FolderOption key={s} icon={SUBGROUP_ICON[s] || 'label'} label={s} count={sgCounts[s]} active={subgroup === s} onClick={() => setSubgroup(subgroup === s ? '' : s)} />
              ))}
            </div>
          </FilterSection>
        </div>
      </Modal>
    </Page>
  )
}
