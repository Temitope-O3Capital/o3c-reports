import EmailHtml from '../../components/EmailHtml'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, RED, AMBER, BLUE, GREEN, FW, RADIUS, TEXT } from '../../lib/design'
import { MailTicket, Message, initials } from './mailUtils'

// Shared Care conversation renderer. Each message is its own card so mails are
// clearly separated, and incoming (customer) is visually distinct from outgoing
// (agent reply) — a coloured rail + direction chip, so the two never blur together
// even when both are branded HTML emails that look alike inside the frame.
export default function CareThread({ ticket, messages }: { ticket: MailTicket; messages: Message[] }) {
  const displayMsgs: Message[] = messages.length > 0
    ? messages
    : (ticket.description
        ? [{ id: -1, direction: 'inbound', author_name: ticket.customer_name, body_text: ticket.description, created_at: ticket.created_at }]
        : [])

  if (displayMsgs.length === 0) {
    return <div style={{ color: 'var(--txt3)', textAlign: 'center', padding: 44 }}>This mail has no message body: it may be a system notification (e.g. a registration or transaction alert).</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {displayMsgs.map(m => {
        const agent = m.direction === 'outbound'
        const note = !!m.is_internal_note
        const recalled = m.send_state === 'recalled'
        const pending = m.send_state === 'pending' || m.send_state === 'sending'
        const failed = m.send_state === 'failed'
        const accent = note ? AMBER : agent ? NAVY : BLUE
        const who = agent ? (m.author_user_name || m.author_name || 'O3 Care') : (ticket.customer_name || 'Customer')
        const chip = note ? 'Internal note' : agent ? 'Outgoing reply' : 'Incoming'

        return (
          <div key={m.id} style={{
            border: '1px solid var(--bdr)', borderLeft: `3px solid ${accent}`, borderRadius: RADIUS.lg,
            overflow: 'hidden', background: 'var(--card)', opacity: recalled ? 0.6 : 1,
            boxShadow: 'var(--shadow-xs)',
          }}>
            {/* Header strip — who, direction, when, state */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 9, padding: '9px 14px', borderBottom: '1px solid var(--bdr)',
              background: note ? `${AMBER}0a` : agent ? `${NAVY}08` : `${BLUE}08`,
            }}>
              <div style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0, background: `${accent}1e`, color: accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: FW.bold }}>
                {initials(agent ? (m.author_user_name || m.author_name || 'O3') : (ticket.customer_name || '?'))}
              </div>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{who}</span>
              <span style={{ fontSize: 10, fontWeight: FW.bold, color: accent, background: `${accent}16`, borderRadius: RADIUS.full, padding: '2px 9px', textTransform: 'uppercase', letterSpacing: '0.03em', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 12 }}>{note ? 'lock' : agent ? 'reply' : 'south_west'}</span>
                {chip}
              </span>
              <span style={{ flex: 1 }} />
              {pending && <span style={{ fontSize: TEXT['2xs'], color: AMBER, fontWeight: FW.bold }}>sending…</span>}
              {recalled && <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontWeight: FW.bold }}>recalled</span>}
              {failed && <span style={{ fontSize: TEXT['2xs'], color: RED, fontWeight: FW.bold }}>failed to send</span>}
              {!pending && !recalled && !failed && agent && <span className="material-symbols-rounded" title="Sent" style={{ fontSize: 15, color: GREEN }}>done_all</span>}
              <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', whiteSpace: 'nowrap' }}>{fmtDatetime(m.created_at)}</span>
            </div>

            {/* Body */}
            {m.body_html && !note && !recalled ? (
              <EmailHtml html={m.body_html} maxWidth="100%" />
            ) : (
              <div style={{
                padding: '12px 16px', fontSize: TEXT.sm, lineHeight: 1.6, color: 'var(--txt)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', textDecoration: recalled ? 'line-through' : undefined,
                background: note ? `${AMBER}08` : 'var(--card)',
              }}>
                {m.body_text || '(empty)'}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
