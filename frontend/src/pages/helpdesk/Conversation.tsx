import { useState } from 'react'
import { avatarColor, nameInitials } from '../../components/UI'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, AMBER, BLUE, FW, RADIUS, SP, TEXT } from '../../lib/design'

// Shared conversation renderer for the Ticket Queue preview and the full ticket
// page, so both surfaces render messages, media and the opening request identically.

export interface ConvMessage {
  id: number
  direction: 'inbound' | 'outbound'
  channel?: string
  author_name?: string
  author_user_name?: string
  sender_name?: string
  body_text: string
  is_internal_note?: boolean
  created_at: string
  _opening?: boolean
}

export interface ConvTicket {
  subject?: string
  description?: string
  customer_name?: string
  channel?: string
  created_at: string
}

// The customer's opening message is frequently stored only as the ticket subject
// (these Zoho web/social tickets often have an empty message thread). Surface it
// as the first inbound message so the conversation is never blank.
export function withOpening(ticket: ConvTicket, messages: ConvMessage[]): ConvMessage[] {
  const subj = (ticket.subject ?? '').trim()
  const desc = (ticket.description ?? '').trim()
  const body = [subj, desc].filter(Boolean).join('\n\n')
  if (!body) return messages
  const first = messages[0]
  if (subj && first && (first.body_text ?? '').trim().includes(subj)) return messages
  const opening: ConvMessage = {
    id: -1, direction: 'inbound', channel: ticket.channel,
    author_name: ticket.customer_name || 'Customer',
    body_text: body, created_at: ticket.created_at, _opening: true,
  }
  return [opening, ...messages]
}

const isImageUrl = (u: string) => /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(u) || /fbcdn|cdninstagram|scontent/i.test(u)

// Render an image inline; if it fails to load (expired CDN link, hotlink block)
// gracefully fall back to a "View image" link so nothing looks broken.
function InlineImage({ url }: { url: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <a href={url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: BLUE, fontWeight: FW.semibold }}>
        <span className="material-symbols-rounded" style={{ fontSize: 15 }}>image</span>View image
      </a>
    )
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" style={{ display: 'block', marginTop: 6 }}>
      <img src={url} alt="attachment" loading="lazy" onError={() => setFailed(true)}
        style={{ maxWidth: '100%', maxHeight: 260, borderRadius: 12, display: 'block', border: '1px solid var(--bdr)' }} />
    </a>
  )
}

function AttachmentChip({ name }: { name: string }) {
  const isImg = /\.(jpe?g|png|gif|webp|bmp)$/i.test(name)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: RADIUS.md, background: `${BLUE}12`, color: BLUE, fontWeight: FW.semibold, fontSize: TEXT.sm }}>
      <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{isImg ? 'image' : 'attach_file'}</span>{name}
    </span>
  )
}

function MessageBody({ text }: { text: string }) {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return <span style={{ fontStyle: 'italic', color: 'var(--txt3)' }}>— no text (media or attachment) —</span>
  // Bare media/file name (no URL) → attachment chip.
  if (/^[\w .()\-]+\.(jpe?g|png|gif|webp|bmp|pdf|docx?|xlsx?|mp4|mov|mp3|m4a)$/i.test(trimmed)) {
    return <AttachmentChip name={trimmed} />
  }
  const parts = trimmed.split(/(https?:\/\/[^\s]+)/g)
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return p ? <span key={i}>{p}</span> : null
        if (isImageUrl(p)) return <InlineImage key={i} url={p} />
        return (
          <a key={i} href={p} target="_blank" rel="noreferrer" style={{ color: BLUE, fontWeight: FW.semibold, wordBreak: 'break-all' }}>
            {p.length > 60 ? p.slice(0, 60) + '…' : p}
          </a>
        )
      })}
    </>
  )
}

function MessageBubble({ msg, dense }: { msg: ConvMessage; dense?: boolean }) {
  const isAgent = msg.direction === 'outbound'
  const isNote = msg.is_internal_note
  const sender = msg.author_user_name || msg.author_name || msg.sender_name || (isAgent ? 'Agent' : 'Customer')
  const avBg = isNote ? AMBER : isAgent ? NAVY : avatarColor(sender)
  const av = dense ? 26 : 32
  return (
    <div className="hd-msg" style={{ display: 'flex', flexDirection: isAgent ? 'row-reverse' : 'row', gap: SP[2], marginBottom: dense ? 12 : 16 }}>
      <div style={{
        width: av, height: av, borderRadius: '50%', flexShrink: 0, background: avBg, color: '#fff',
        boxShadow: `0 0 0 3px ${avBg}22`, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: dense ? 10 : 11, fontWeight: FW.bold, letterSpacing: '0.3px',
      }}>{nameInitials(sender)}</div>
      <div style={{ maxWidth: '76%', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], flexDirection: isAgent ? 'row-reverse' : 'row', marginBottom: 4 }}>
          <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{sender}</span>
          <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{fmtDatetime(msg.created_at)}</span>
          {msg.channel && !isNote && <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', textTransform: 'capitalize' }}>· {msg.channel}</span>}
          {msg._opening && <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '1px 6px', borderRadius: RADIUS.lg, background: `${BLUE}14`, color: BLUE }}>Original request</span>}
          {isNote && <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '1px 6px', borderRadius: RADIUS.lg, background: `${AMBER}18`, color: AMBER }}>Internal note</span>}
        </div>
        <div style={{
          padding: dense ? '9px 12px' : '11px 14px', borderRadius: 14,
          borderTopLeftRadius: isAgent ? 14 : 3, borderTopRightRadius: isAgent ? 3 : 14,
          background: isNote ? `${AMBER}10` : (isAgent ? `${NAVY}0E` : 'var(--card)'),
          border: `1px solid ${isNote ? `${AMBER}30` : isAgent ? `${NAVY}22` : 'var(--bdr)'}`,
          boxShadow: 'var(--shadow-xs)', fontSize: TEXT.base, color: 'var(--txt)', lineHeight: 1.6,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>
          <MessageBody text={msg.body_text} />
        </div>
      </div>
    </div>
  )
}

export function Conversation({ ticket, messages, dense }: { ticket: ConvTicket; messages: ConvMessage[]; dense?: boolean }) {
  const convo = withOpening(ticket, messages)
  if (convo.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '44px 20px', textAlign: 'center' }}>
        <span className="material-symbols-rounded" style={{ fontSize: 38, color: 'var(--txt3)' }}>forum</span>
        <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>No messages yet</div>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', maxWidth: 260 }}>Start the conversation below, or add an internal note.</div>
      </div>
    )
  }
  return <>{convo.map(m => <MessageBubble key={m.id} msg={m} dense={dense} />)}</>
}
