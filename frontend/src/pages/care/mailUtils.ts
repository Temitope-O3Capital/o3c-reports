import DOMPurify from 'dompurify'
import { NAVY, RED, AMBER, GREEN } from '../../lib/design'

// Shared constants, helpers and types for the Care mail surfaces (the inbox
// reading pane and the full-page mail view). Care handles the 'email' channel of
// the helpdesk; the ticket stays the system of record underneath.

// Inbox subgroups — keep in sync with careSubgroups in backend handlers/helpdesk_care.go.
export const CARE_SUBGROUPS = ['New Registration', 'Support', 'Complaints', 'Transactions', 'Cards', 'Loans', 'Fixed Deposit', 'General']

export const SUBGROUP_ICON: Record<string, string> = {
  'New Registration': 'person_add', 'Support': 'support_agent', 'Complaints': 'sentiment_dissatisfied',
  'Transactions': 'receipt_long', 'Cards': 'credit_card', 'Loans': 'account_balance',
  'Fixed Deposit': 'savings', 'General': 'inbox',
}

// Undo-send window (seconds) — matches careHoldSeconds on the backend.
export const HOLD_SECONDS = 30

export function parseAddrs(raw: string): { Email: string; Name: string }[] {
  return raw.split(/[,;]/).map(s => s.trim()).filter(Boolean).map(Email => ({ Email, Name: '' }))
}

export function htmlToText(html: string): string {
  const d = document.createElement('div')
  d.innerHTML = DOMPurify.sanitize(html)
  return (d.textContent ?? '').trim()
}

export function signatureHtml(s: { signature_text?: string | null; signature_html?: string | null }): string {
  if (s.signature_html && s.signature_html.trim()) return `<br><br><div class="o3c-sig">${s.signature_html}</div>`
  if (s.signature_text && s.signature_text.trim()) {
    const safe = s.signature_text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
    return `<br><br><div class="o3c-sig">-- <br>${safe}</div>`
  }
  return ''
}

export function initials(name?: string) {
  return (name || '?').split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

export function priorityColor(p?: string) {
  return p === 'urgent' || p === 'high' ? RED : p === 'medium' || p === 'normal' ? AMBER : GREEN
}

export const CHANNEL_ICON: Record<string, string> = {
  call: 'call', email: 'mail', sms: 'sms', whatsapp: 'chat', social: 'groups', web: 'language',
}

// Kept for callers that want the brand navy without re-importing design tokens.
export const CARE_ACCENT = NAVY

export interface MailTicket {
  id: number
  ticket_ref: string
  subject: string
  status: string
  priority: string
  customer_name?: string
  customer_email?: string
  customer_cif?: string
  customer_phone?: string
  assigned_to?: number
  assigned_to_name?: string
  created_at: string
  last_message_at?: string
  last_message_preview?: string
  description_preview?: string
  description?: string
  is_flagged?: boolean
  mail_subgroup?: string
  escalated?: boolean
  escalated_at?: string
  escalation_reason?: string
  escalated_to_name?: string
  escalation_resolved_at?: string
  delete_requested?: boolean
}

export interface Message {
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
  cc?: string[]
}

// The people to Cc on a "Reply all": whoever was in copy on the most recent inbound
// message, minus the customer themselves and our own care address.
export function replyAllRecipients(messages: Message[], customerEmail?: string): string[] {
  const lastInbound = [...messages].reverse().find(m => m.direction === 'inbound')
  const cc = lastInbound?.cc ?? []
  const mine = (customerEmail || '').toLowerCase()
  const seen = new Set<string>()
  return cc.filter(e => {
    const k = (e || '').trim().toLowerCase()
    if (!k || k === mine || /@o3cards\.com$/i.test(k) || seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export interface DetailResp {
  ticket: MailTicket
  messages: Message[]
}

export interface CannedResponse {
  id: number
  title?: string
  name?: string
  category?: string
  body?: string
  body_text?: string
  body_html?: string
  subject?: string
}
