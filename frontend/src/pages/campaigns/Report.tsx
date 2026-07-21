import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, KpiCard, ErrBanner, Modal,
  btnPrimary, btnSecondary, filterInputStyle, Spinner,
} from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtNum, fmtPct, fmtDatetime, fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, PURPLE, NUM, INTER, SORA, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import EmailBlockEditor, { exportToHtml } from '../../components/EmailBlockEditor'
import type { EmailBlock, EmailSettings } from '../../components/EmailBlockEditor'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Campaign {
  id: number; name: string; type: string; status: string
  list_id?: number; list_name?: string; total_contacts?: number
  email_subject?: string; email_body_html?: string; email_body_text?: string
  email_blocks_json?: string
  from_name?: string; from_email?: string; sms_body?: string
  scheduled_at?: string; started_at?: string; completed_at?: string
  pause_reason?: string; created_at: string; created_by_name?: string
  emails_sent?: number; emails_delivered?: number; emails_opened?: number
  emails_clicked?: number; sms_sent?: number; sms_delivered?: number
  bounce_count?: number; unsubscribe_count?: number
}

interface Metrics { total_contacts: number; sent: number; sent_pct: number; delivered: number; delivery_rate: number; opened: number; open_rate: number; clicked: number; click_rate: number; bounced: number; bounce_rate: number; spam: number; unsubscribed: number; failed: number }
interface TimelinePoint { hour: string; opened: number; clicked: number; delivered: number }
interface ContactStats { pending: number; sent: number; delivered: number; opened: number; clicked: number; bounced: number; failed: number }
interface ReportResp { campaign: any; metrics: Metrics; timeline: TimelinePoint[]; top_links: { url: string; clicks: number }[]; contact_stats: ContactStats }
interface EditorValue { blocks: EmailBlock[]; settings?: EmailSettings }
interface PreflightResp { total: number; with_email: number; with_phone: number; suppressed: number; duplicates: number; invalid: number; usable: number; warnings: string[] }
interface ContactListItem { id: number; name: string; total?: number }
interface Template { id: number; name: string; channel: string; category: string; sms_body?: string; email_subject?: string; email_blocks?: any[] }
interface CampaignContact { id: number; first_name?: string; last_name?: string; email?: string; phone?: string; sms_status?: string; email_status?: string }

// ── Helpers ────────────────────────────────────────────────────────────────────

function toN(v: any): number { return Number(v) || 0 }

function toDatetimeLocal(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
  } catch { return '' }
}

const STATUS_META: Record<string, { color: string; label: string }> = {
  draft:     { color: '#6B7280', label: 'Draft' },
  scheduled: { color: AMBER,    label: 'Scheduled' },
  active:    { color: GREEN,    label: 'Sending…' },
  paused:    { color: AMBER,    label: 'Paused' },
  completed: { color: NAVY,     label: 'Completed' },
  cancelled: { color: RED,      label: 'Cancelled' },
}

const TYPE_COLOR: Record<string, string> = { email: BLUE, sms: PURPLE, multi: GREEN }
const TYPE_LABEL: Record<string, string> = { email: 'Email', sms: 'SMS', multi: 'Multi-channel' }

const MERGE_TAGS = ['{{first_name}}', '{{last_name}}', '{{phone}}', '{{email}}', '{{cif_number}}']

const fld: React.CSSProperties = { ...filterInputStyle, width: '100%', boxSizing: 'border-box' as const }
const lbl: React.CSSProperties = { fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 5, fontFamily: INTER }

// ── iPhone 15 Pro Mockup ──────────────────────────────────────────────────────

function IPhoneMockup({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ position: 'relative', width: 285 }}>
      <div style={{ position: 'absolute', left: -3, top: 92,  width: 3, height: 28, background: '#3a3a3c', borderRadius: '2px 0 0 2px' }} />
      <div style={{ position: 'absolute', left: -3, top: 130, width: 3, height: 52, background: '#3a3a3c', borderRadius: '2px 0 0 2px' }} />
      <div style={{ position: 'absolute', left: -3, top: 192, width: 3, height: 52, background: '#3a3a3c', borderRadius: '2px 0 0 2px' }} />
      <div style={{ position: 'absolute', right: -3, top: 150, width: 3, height: 72, background: '#3a3a3c', borderRadius: '0 2px 2px 0' }} />
      <div style={{ background: 'linear-gradient(160deg,#2d2d2f 0%,#1c1c1e 100%)', borderRadius: 48, padding: 10, boxShadow: '0 0 0 1px rgba(255,255,255,0.08),0 0 0 2px #0a0a0a,0 50px 100px rgba(0,0,0,0.65),inset 0 1px 0 rgba(255,255,255,0.1)' }}>
        <div style={{ borderRadius: 38, overflow: 'hidden', background: '#fff', height: 598, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <div style={{ position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)', width: 112, height: 32, background: '#000', borderRadius: 20, zIndex: 10, boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.06)' }} />
          <div style={{ height: 54, display: 'flex', alignItems: 'flex-end', padding: '0 22px 8px', justifyContent: 'space-between', flexShrink: 0, fontFamily: '-apple-system,BlinkMacSystemFont,sans-serif' }}>
            <span style={{ fontSize: 13.5, fontWeight: 700, color: '#000', letterSpacing: -0.3 }}>9:41</span>
            <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              <svg width="17" height="12" viewBox="0 0 17 12">
                <rect x="0"    y="8"   width="3" height="4"   rx="1" fill="#000"/>
                <rect x="4.5"  y="5.5" width="3" height="6.5" rx="1" fill="#000"/>
                <rect x="9"    y="2.5" width="3" height="9.5" rx="1" fill="#000"/>
                <rect x="13.5" y="0"   width="3" height="12"  rx="1" fill="#000" opacity="0.25"/>
              </svg>
              <svg width="16" height="12" viewBox="0 0 16 12">
                <path d="M8 9.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" fill="#000"/>
                <path d="M3.2 6.3C4.6 4.9 6.2 4.2 8 4.2s3.4.7 4.8 2.1" stroke="#000" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
                <path d="M.5 3.5C2.4 1.6 5 .5 8 .5s5.6 1.1 7.5 3" stroke="#000" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
              </svg>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <div style={{ width: 23, height: 12, borderRadius: 3.5, border: '1px solid rgba(0,0,0,0.3)', padding: '1.5px', display: 'flex', alignItems: 'center' }}>
                  <div style={{ width: '82%', height: '100%', background: '#34C759', borderRadius: 2 }} />
                </div>
                <div style={{ width: 2, height: 5, background: 'rgba(0,0,0,0.3)', borderRadius: '0 1.5px 1.5px 0', marginLeft: -1 }} />
              </div>
            </div>
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>{children}</div>
        </div>
      </div>
    </div>
  )
}

// ── Messages App Preview ──────────────────────────────────────────────────────

function SmsAppPreview({ text, sender = 'O3 Capital' }: { text: string; sender?: string }) {
  const ff = '-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif'
  const initial = sender.charAt(0).toUpperCase()
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#fff', fontFamily: ff, minHeight: 0 }}>
      <div style={{ background: 'rgba(242,242,247,0.92)', backdropFilter: 'blur(20px)', borderBottom: '0.5px solid rgba(0,0,0,0.15)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px 10px', gap: 6 }}>
          <span style={{ color: '#007AFF', fontSize: 16, fontWeight: 400 }}>‹</span>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ width: 38, height: 38, borderRadius: '50%', background: 'linear-gradient(135deg,#C00000 0%,#8B0000 100%)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, marginBottom: 2 }}>{initial}</div>
            <div style={{ fontSize: 11.5, fontWeight: 500, color: '#000' }}>{sender}</div>
          </div>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="#007AFF"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>
        </div>
      </div>
      <div style={{ flex: 1, padding: '10px 12px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 5, overflow: 'hidden' }}>
        <div style={{ textAlign: 'center', fontSize: 10.5, color: '#8e8e93', fontWeight: 400, marginBottom: 6 }}>Today 9:41 AM</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5 }}>
          <div style={{ width: 24, height: 24, borderRadius: '50%', background: 'linear-gradient(135deg,#C00000,#8B0000)', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{initial}</div>
          <div style={{ background: '#e5e5ea', color: '#000', borderRadius: '16px 16px 16px 4px', padding: '9px 13px', maxWidth: '80%', fontSize: 13, lineHeight: 1.45, wordBreak: 'break-word', boxShadow: '0 1px 1px rgba(0,0,0,0.07)' }}>
            {text || <span style={{ color: '#8e8e93', fontStyle: 'italic' }}>Your message preview…</span>}
          </div>
        </div>
        <div style={{ fontSize: 10, color: '#8e8e93', paddingLeft: 30 }}>Delivered</div>
      </div>
      <div style={{ padding: '6px 10px 10px', borderTop: '0.5px solid rgba(0,0,0,0.12)', display: 'flex', gap: 7, alignItems: 'center', background: '#fff', flexShrink: 0 }}>
        <div style={{ width: 28, height: 28, borderRadius: '50%', border: '1.5px solid #8e8e93', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 16, color: '#8e8e93', lineHeight: 1 }}>+</span>
        </div>
        <div style={{ flex: 1, background: '#f2f2f7', borderRadius: 18, padding: '7px 12px', fontSize: 13, color: '#8e8e93', border: '0.5px solid rgba(0,0,0,0.08)' }}>iMessage</div>
        <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#8e8e93', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 20V4M5 11l7-7 7 7" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </div>
      </div>
    </div>
  )
}

// ── Delivery Funnel ────────────────────────────────────────────────────────────

function PipelineBar({ stats, total }: { stats: ContactStats; total: number }) {
  if (!total) return null
  const sent = toN(stats.sent), delivered = toN(stats.delivered), opened = toN(stats.opened), clicked = toN(stats.clicked)
  const rows = [
    { label: 'Sent',      value: sent,      barW: Math.min(100, (sent / total) * 100),           stagePct: Math.min(100, (sent / total) * 100),           color: BLUE },
    { label: 'Delivered', value: delivered, barW: Math.min(100, (delivered / total) * 100),      stagePct: sent > 0 ? Math.min(100, (delivered / sent) * 100) : 0,      color: GREEN },
    { label: 'Opened',    value: opened,    barW: Math.min(100, (opened / total) * 100),         stagePct: delivered > 0 ? Math.min(100, (opened / delivered) * 100) : 0, color: NAVY },
    { label: 'Clicked',   value: clicked,   barW: Math.min(100, (clicked / total) * 100),        stagePct: opened > 0 ? Math.min(100, (clicked / opened) * 100) : 0,     color: PURPLE },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((row, i) => (
        <div key={row.label}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 3 }}>
            <div style={{ width: 68, fontSize: TEXT.xs, color: 'var(--txt2)', textAlign: 'right', flexShrink: 0 }}>{row.label}</div>
            <div style={{ flex: 1, height: 10, background: 'var(--th-bg)', borderRadius: RADIUS.xs, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${row.barW}%`, background: row.color, borderRadius: 4, transition: 'width .4s' }} />
            </div>
            <div style={{ width: 90, fontSize: TEXT.xs, ...NUM, textAlign: 'right', flexShrink: 0 }}>
              {fmtNum(row.value)} <span style={{ color: 'var(--txt3)' }}>({fmtPct(row.stagePct)})</span>
            </div>
          </div>
          {i > 0 && (
            <div style={{ paddingLeft: 78, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              of {rows[i - 1].label.toLowerCase()} · <span style={{ color: row.stagePct < 50 ? RED : 'var(--txt3)' }}>{fmtPct(100 - row.stagePct)} drop</span>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── SMS Builder ────────────────────────────────────────────────────────────────

function SMSBuilder({ value, onChange, canEdit, senderName }: { value: string; onChange: (v: string) => void; canEdit: boolean; senderName?: string }) {
  const taRef = useRef<HTMLTextAreaElement>(null)

  function insertTag(tag: string) {
    if (!canEdit || !taRef.current) return
    const ta = taRef.current
    const start = ta.selectionStart ?? ta.value.length
    const end   = ta.selectionEnd   ?? ta.value.length
    onChange(ta.value.slice(0, start) + tag + ta.value.slice(end))
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(start + tag.length, start + tag.length) })
  }

  const len  = value.length
  const segs = len === 0 ? 1 : len <= 160 ? 1 : Math.ceil(len / 153)
  const pct  = Math.min(100, (len / 160) * 100)
  const barC = len > 160 ? RED : len > 130 ? AMBER : GREEN

  const previewText = value
    .replace(/{{first_name}}/g, 'John').replace(/{{last_name}}/g, 'Okafor')
    .replace(/{{name}}/g, 'John Okafor').replace(/{{full_name}}/g, 'John Okafor')
    .replace(/{{phone}}/g, '0801 234 5678').replace(/{{email}}/g, 'john@example.com')
    .replace(/{{cif_number}}/g, 'CIF-0001').replace(/{{amount}}/g, '₦5,000')
    .replace(/{{due_date}}/g, '25 Jul 2026').replace(/{{company}}/g, 'O3 Capital')
    .replace(/{{cta_url}}/g, 'https://o3cap.al/pay')

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 24, alignItems: 'start' }}>

      {/* Composer */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {canEdit && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', alignSelf: 'center', marginRight: 4 }}>Insert:</span>
            {MERGE_TAGS.map(tag => (
              <button key={tag} type="button" onClick={() => insertTag(tag)}
                style={{ fontSize: TEXT.xs, padding: '2px 9px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--th-bg)', color: 'var(--txt2)', cursor: 'pointer', fontFamily: 'monospace', transition: 'all .12s' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = PURPLE; e.currentTarget.style.color = PURPLE }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--bdr)'; e.currentTarget.style.color = 'var(--txt2)' }}>
                {tag}
              </button>
            ))}
          </div>
        )}

        <textarea ref={taRef} value={value} onChange={e => onChange(e.target.value)}
          disabled={!canEdit} rows={8} maxLength={480}
          spellCheck={false} data-gramm="false"
          placeholder={canEdit ? 'Hi {{first_name}}, write your SMS here…' : '—'}
          style={{ ...fld, resize: 'vertical', fontFamily: 'monospace', lineHeight: 1.65, fontSize: TEXT.base, opacity: canEdit ? 1 : .85 }}
        />

        {/* Progress bar */}
        <div>
          <div style={{ height: 4, background: 'var(--bdr)', borderRadius: 2, overflow: 'hidden', marginBottom: 5 }}>
            <div style={{ width: `${pct}%`, height: '100%', background: barC, borderRadius: 2, transition: 'width 0.1s, background 0.2s' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: TEXT.xs, color: barC, fontFamily: 'monospace', fontWeight: FW.semibold }}>
              {len} / 160 · {segs} SMS{segs > 1 ? ' credits' : ''}
            </span>
            {len > 130 && (
              <span style={{ fontSize: TEXT.xs, color: len > 160 ? RED : AMBER, display: 'flex', gap: 4, alignItems: 'center' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 13 }}>warning</span>
                {len > 160 ? `${segs} credits per recipient` : 'Tags may push past 160'}
              </span>
            )}
          </div>
        </div>

        {canEdit && (
          <div style={{ padding: '10px 14px', background: 'var(--th-bg)', borderRadius: RADIUS.md, fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.7 }}>
            <strong style={{ color: 'var(--txt2)' }}>Tips:</strong> Keep under 160 chars for a single SMS. Unicode/emoji reduces limit to 70 chars per part. Opt-out text is appended automatically.
          </div>
        )}
      </div>

      {/* Phone preview */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', letterSpacing: '.05em', textTransform: 'uppercase' }}>Live Preview</div>
        <IPhoneMockup>
          <SmsAppPreview text={previewText} sender={senderName || 'O3 Capital'} />
        </IPhoneMockup>
      </div>
    </div>
  )
}

// ── Email read-only preview ────────────────────────────────────────────────────

function EmailReadOnlyPreview({ html, subject }: { html: string; subject: string }) {
  if (!html) return (
    <div style={{ padding: 40, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
      <span className="material-symbols-rounded" style={{ fontSize: 40, display: 'block', marginBottom: 8 }}>mail_outline</span>
      No email content saved yet.
    </div>
  )
  return (
    <div style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.md, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--th-bg)' }}>
        <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)' }}>subject</span>
        <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{subject || '(no subject)'}</span>
      </div>
      <iframe srcDoc={html} style={{ width: '100%', height: 480, border: 'none', display: 'block' }} title="Email preview" sandbox="allow-same-origin" />
    </div>
  )
}

// ── Preflight Modal ────────────────────────────────────────────────────────────

function PreflightModal({ open, onClose, onConfirm, listId, campaignType }: {
  open: boolean; onClose: () => void; onConfirm: () => Promise<void>
  listId?: number | ''; campaignType: string
}) {
  const [loading, setLoading]       = useState(false)
  const [data, setData]             = useState<PreflightResp | null>(null)
  const [fetchErr, setFetchErr]     = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (!open) { setData(null); setFetchErr(null); return }
    setLoading(true)
    const q = listId ? `?list_id=${listId}&type=${campaignType}` : `?type=${campaignType}`
    apiFetch<PreflightResp>(`/api/campaigns/preflight${q}`)
      .then(r => setData(r))
      .catch(ex => setFetchErr(ex.message))
      .finally(() => setLoading(false))
  }, [open, listId, campaignType])

  async function confirm() {
    setConfirming(true)
    try { await onConfirm() }
    catch { /* error toast shown by caller */ }
    finally { setConfirming(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Audience Check" width={480}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={confirm} disabled={confirming || loading}
            style={{ ...btnPrimary, background: GREEN, borderColor: GREEN, gap: 6, opacity: (confirming || loading) ? .7 : 1 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>play_arrow</span>
            {confirming ? 'Starting…' : 'Start Campaign'}
          </button>
        </div>
      }
    >
      {fetchErr && <div style={{ color: RED, fontSize: TEXT.sm, marginBottom: 12 }}>{fetchErr}</div>}
      {loading && <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}><Spinner /></div>}

      {data && !loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
            {([
              ['Total',      data.total,      NAVY],
              ['Usable',     data.usable,     GREEN],
              ['Suppressed', data.suppressed, AMBER],
              ['Duplicates', data.duplicates, AMBER],
              ['Invalid',    data.invalid,    RED],
              ...(campaignType !== 'sms'   ? [['With Email', data.with_email, BLUE]]   as [string,number,string][] : []),
              ...(campaignType !== 'email' ? [['With Phone', data.with_phone, PURPLE]] as [string,number,string][] : []),
            ] as [string, number, string][]).map(([label, val, color]) => (
              <div key={label} style={{ textAlign: 'center', padding: '12px 8px', background: 'var(--th-bg)', borderRadius: RADIUS.md }}>
                <div style={{ fontSize: 20, fontWeight: FW.bold, color, ...NUM }}>{fmtNum(val)}</div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 3 }}>{label}</div>
              </div>
            ))}
          </div>

          {(data.warnings ?? []).length > 0 && (
            <div style={{ padding: '10px 14px', background: `${AMBER}10`, border: `1px solid ${AMBER}40`, borderRadius: RADIUS.md, display: 'flex', flexDirection: 'column', gap: 5 }}>
              {data.warnings.map((w, i) => (
                <div key={i} style={{ fontSize: TEXT.sm, color: '#92400E', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>warning</span>
                  {w}
                </div>
              ))}
            </div>
          )}

          {data.usable === 0 && (
            <div style={{ padding: '10px 14px', background: `${RED}10`, border: `1px solid ${RED}30`, borderRadius: RADIUS.md, fontSize: TEXT.sm, color: RED }}>
              No usable contacts — campaign will not send any messages.
            </div>
          )}

          <p style={{ fontSize: TEXT.sm, color: 'var(--txt3)', margin: 0 }}>
            {data.usable > 0 ? `${fmtNum(data.usable)} contacts will receive this campaign.` : 'You can still start, but no messages will be sent.'}
          </p>
        </div>
      )}
    </Modal>
  )
}

// ── Template Picker Modal ──────────────────────────────────────────────────────

function TemplatePickerModal({ open, onClose, onApply, channel }: {
  open: boolean; onClose: () => void
  onApply: (t: Template) => void; channel: string
}) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading]     = useState(false)
  const [search, setSearch]       = useState('')

  useEffect(() => {
    if (!open) return
    setLoading(true); setSearch('')
    apiFetch<any>('/api/message-templates?limit=100')
      .then(r => setTemplates(Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [open])

  const filtered = templates.filter(t => {
    const matchCh = channel === 'multi' ? true : (t.channel === channel || t.channel === 'multi')
    return matchCh && (!search || t.name.toLowerCase().includes(search.toLowerCase()))
  })

  return (
    <Modal open={open} onClose={onClose} title="Load from Template" width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search templates…" style={fld} autoFocus />

        {loading && <div style={{ textAlign: 'center', padding: 24 }}><Spinner /></div>}
        {!loading && filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: 24, color: 'var(--txt3)', fontSize: TEXT.sm }}>No templates found for this channel.</div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 380, overflowY: 'auto' }}>
          {filtered.map(t => (
            <button key={t.id} onClick={() => { onApply(t); onClose() }}
              style={{ textAlign: 'left', padding: '10px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: 'pointer', transition: 'all .12s' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = BLUE; e.currentTarget.style.background = `${BLUE}08` }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--bdr)'; e.currentTarget.style.background = 'var(--card)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 18, color: t.channel === 'email' ? BLUE : PURPLE }}>
                  {t.channel === 'email' ? 'mail' : 'smartphone'}
                </span>
                <div>
                  <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{t.name}</div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 1 }}>
                    {t.category} · {t.channel}{t.email_subject ? ` · "${t.email_subject}"` : ''}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}

// ── Push to Telemarketers Modal ────────────────────────────────────────────────

const SEGMENTS = [
  { value: 'all',           label: 'All contacts' },
  { value: 'email_opened',  label: 'Email opened only' },
  { value: 'email_clicked', label: 'Email clicked only' },
  { value: 'sms_delivered', label: 'SMS delivered only' },
]

function PushToTelemarketingModal({ campaignId, open, onClose }: { campaignId: string; open: boolean; onClose: () => void }) {
  const [tmCampaigns, setTmCampaigns] = useState<{ id: number; name: string }[]>([])
  const [selectedTmId, setSelectedTmId] = useState('')
  const [newCampaignName, setNewCampaignName] = useState('')
  const [segment, setSegment] = useState('all')
  const [assignedTo, setAssignedTo] = useState('')
  const [agents, setAgents] = useState<{ id: number; full_name: string }[]>([])
  const [pushing, setPushing] = useState(false)
  const [pushErr, setPushErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    apiFetch<any>('/api/telemarketing/campaigns').then(r => setTmCampaigns(Array.isArray(r) ? r : [])).catch(() => {})
    apiFetch<any>('/api/admin/users?role=telemarketing_agent&limit=100').then(r => setAgents(Array.isArray(r) ? r : [])).catch(() => {})
  }, [open])

  async function push() {
    setPushing(true); setPushErr(null)
    try {
      const body: Record<string, any> = { segment }
      if (selectedTmId === 'new') body.new_campaign_name = newCampaignName || undefined
      else if (selectedTmId)      body.telemarketing_campaign_id = Number(selectedTmId)
      if (assignedTo) body.assigned_to = Number(assignedTo)
      const res = await apiPost<{ created: number; skipped_dnc: number }>(`/api/campaigns/${campaignId}/push-to-telemarketing`, body)
      toast.success(`${res.created} lead${res.created !== 1 ? 's' : ''} pushed${res.skipped_dnc > 0 ? ` · ${res.skipped_dnc} skipped (DNC)` : ''}`)
      onClose()
    } catch (ex: any) { setPushErr(ex.message) }
    finally { setPushing(false) }
  }

  function close() { setSelectedTmId(''); setNewCampaignName(''); setSegment('all'); setAssignedTo(''); setPushErr(null); onClose() }

  return (
    <Modal open={open} onClose={close} title="Push to Telemarketers" width={460}
      footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={close} style={btnSecondary}>Cancel</button>
        <button onClick={push} disabled={pushing} style={{ ...btnPrimary, background: '#7C3AED' }}>{pushing ? 'Pushing…' : 'Push Contacts'}</button>
      </div>}
    >
      {pushErr && <div style={{ color: RED, fontSize: TEXT.sm, marginBottom: 10 }}>{pushErr}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={lbl}>Contact Segment</label>
          <select value={segment} onChange={e => setSegment(e.target.value)} style={fld}>
            {SEGMENTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 4 }}>DNC numbers are excluded automatically.</p>
        </div>
        <div>
          <label style={lbl}>Telemarketing Campaign</label>
          <select value={selectedTmId} onChange={e => setSelectedTmId(e.target.value)} style={fld}>
            <option value="">Auto-create from campaign name</option>
            <option value="new">Create new…</option>
            {tmCampaigns.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
          </select>
        </div>
        {selectedTmId === 'new' && (
          <div>
            <label style={lbl}>New Campaign Name</label>
            <input value={newCampaignName} onChange={e => setNewCampaignName(e.target.value)} placeholder="e.g. Q3 Follow-up Calls" style={fld} />
          </div>
        )}
        <div>
          <label style={lbl}>Assign to Agent <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span></label>
          <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)} style={fld}>
            <option value="">Unassigned — pool pickup</option>
            {agents.map(a => <option key={a.id} value={String(a.id)}>{a.full_name}</option>)}
          </select>
        </div>
      </div>
    </Modal>
  )
}

// ── Contacts Section (collapsible) ────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  pending: '#6B7280', sent: BLUE, delivered: GREEN,
  opened: NAVY, clicked: PURPLE, bounced: RED, failed: RED,
}

function ContactsSection({ campaignId }: { campaignId: string }) {
  const [open, setOpen]         = useState(false)
  const [loading, setLoading]   = useState(false)
  const [contacts, setContacts] = useState<CampaignContact[]>([])
  const [total, setTotal]       = useState(0)
  const [loaded, setLoaded]     = useState(false)

  function toggle() {
    if (!open && !loaded) {
      setLoading(true)
      apiFetch<any>(`/api/campaigns/${campaignId}/contacts?limit=50`)
        .then(r => {
          setContacts(Array.isArray(r?.contacts) ? r.contacts : Array.isArray(r) ? r : [])
          setTotal(r?.total ?? 0)
          setLoaded(true)
        })
        .catch(() => setLoaded(true))
        .finally(() => setLoading(false))
    }
    setOpen(o => !o)
  }

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg }}>
      <button onClick={toggle} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '14px 18px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: INTER, color: 'var(--txt)', fontSize: TEXT.base, fontWeight: FW.semibold }}>
        <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)' }}>{open ? 'expand_less' : 'expand_more'}</span>
        Contact Delivery Status
        {total > 0 && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontWeight: FW.normal }}>· {fmtNum(total)} contacts</span>}
      </button>

      {open && (
        <div style={{ borderTop: '1px solid var(--bdr)', padding: 16 }}>
          {loading && <div style={{ textAlign: 'center', padding: 20 }}><Spinner /></div>}
          {!loading && loaded && contacts.length === 0 && (
            <div style={{ textAlign: 'center', padding: 20, color: 'var(--txt3)', fontSize: TEXT.sm }}>No contact data yet.</div>
          )}
          {contacts.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.sm }}>
                <thead>
                  <tr style={{ background: 'var(--th-bg)' }}>
                    {['Name', 'Contact', 'SMS Status', 'Email Status'].map(h => (
                      <th key={h} style={{ padding: '7px 10px', textAlign: 'left', fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', borderBottom: '1px solid var(--bdr)', letterSpacing: '.04em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c, i) => (
                    <tr key={c.id} style={{ borderBottom: '1px solid var(--bdr)', background: i % 2 === 0 ? 'transparent' : 'var(--th-bg)' }}>
                      <td style={{ padding: '7px 10px', fontWeight: FW.semibold }}>{[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}</td>
                      <td style={{ padding: '7px 10px', color: 'var(--txt2)', fontFamily: 'monospace', fontSize: TEXT.xs }}>{c.email || c.phone || '—'}</td>
                      <td style={{ padding: '7px 10px' }}>
                        {c.sms_status && <span style={{ fontSize: TEXT.xs, padding: '2px 8px', borderRadius: RADIUS.xl, background: `${STATUS_COLORS[c.sms_status] ?? '#6B7280'}18`, color: STATUS_COLORS[c.sms_status] ?? '#6B7280', fontWeight: FW.semibold, textTransform: 'capitalize' }}>{c.sms_status}</span>}
                      </td>
                      <td style={{ padding: '7px 10px' }}>
                        {c.email_status && <span style={{ fontSize: TEXT.xs, padding: '2px 8px', borderRadius: RADIUS.xl, background: `${STATUS_COLORS[c.email_status] ?? '#6B7280'}18`, color: STATUS_COLORS[c.email_status] ?? '#6B7280', fontWeight: FW.semibold, textTransform: 'capitalize' }}>{c.email_status}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {total > 50 && <div style={{ padding: '8px 10px', fontSize: TEXT.xs, color: 'var(--txt3)', textAlign: 'center' }}>Showing first 50 of {fmtNum(total)} contacts</div>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Progress {
  status: string; total: number; done: number; pending: number
  sent: number; delivered: number; bounced: number; progress_pct: number
}

type TabKey = 'setup' | 'content' | 'review' | 'results'

export default function CampaignDetail() {
  const { id }   = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [report,   setReport]   = useState<ReportResp | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [err,      setErr]      = useState<string | null>(null)

  // editable fields
  const [name,         setName]         = useState('')
  const [description,  setDescription]  = useState('')
  const [emailBlocks,  setEmailBlocks]  = useState<EditorValue>({ blocks: [] })
  const [emailSubject, setEmailSubject] = useState('')
  const [fromName,     setFromName]     = useState('')
  const [fromEmail,    setFromEmail]    = useState('')
  const [smsBody,      setSmsBody]      = useState('')
  const [scheduledAt,  setScheduledAt]  = useState('')
  const [listId,       setListId]       = useState<number | ''>('')
  const [contactLists, setContactLists] = useState<ContactListItem[]>([])

  // ui
  const [tab,          setTab]          = useState<TabKey>('setup')
  const [saving,       setSaving]       = useState(false)
  const [lastSaved,    setLastSaved]    = useState<Date | null>(null)
  const [starting,     setStarting]     = useState(false)
  const [pausing,      setPausing]      = useState(false)
  const [cancelling,   setCancelling]   = useState(false)
  const [pushOpen,     setPushOpen]     = useState(false)
  const [preflightOpen,setPreflightOpen]= useState(false)
  const [tplOpen,      setTplOpen]      = useState(false)
  const [tplFor,       setTplFor]       = useState<'email' | 'sms'>('sms')

  // test send
  const [testEmail,   setTestEmail]   = useState('')
  const [testPhone,   setTestPhone]   = useState('')
  const [testSending, setTestSending] = useState(false)

  // multi-channel overrides (only relevant for type='multi')
  const [enableSMS,   setEnableSMS]   = useState(true)
  const [enableEmail, setEnableEmail] = useState(true)

  // live progress
  const [progress, setProgress] = useState<Progress | null>(null)

  const autoSaveRef         = useRef<ReturnType<typeof setTimeout> | null>(null)
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const initialLoadRef      = useRef(true)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true); setErr(null)
    try {
      const [camp, rpt] = await Promise.all([
        apiFetch<Campaign>(`/api/campaigns/${id}`),
        apiFetch<ReportResp>(`/api/campaigns/${id}/analytics`).catch(() => null),
      ])
      setCampaign(camp); setReport(rpt)
      setName(camp.name ?? '')
      setDescription((camp as any).description ?? '')
      setSmsBody(camp.sms_body ?? '')
      setEmailSubject(camp.email_subject ?? '')
      setFromName(camp.from_name ?? '')
      setFromEmail(camp.from_email ?? '')
      setScheduledAt(toDatetimeLocal(camp.scheduled_at ?? ''))
      setListId(camp.list_id ?? '')
      let blocks: EmailBlock[] = [], settings: EmailSettings = {}
      const src = camp.email_blocks_json || camp.email_body_text || ''
      if (src) {
        try { const p = JSON.parse(src); if (Array.isArray(p.blocks)) { blocks = p.blocks; settings = p.settings ?? {} } } catch {}
      }
      setEmailBlocks({ blocks, settings })
      if (['active', 'paused', 'completed', 'cancelled'].includes(camp.status)) setTab('results')
      initialLoadRef.current = false
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])

  const canEdit = campaign?.status === 'draft' || campaign?.status === 'scheduled'
  const isSMS   = campaign?.type === 'sms'   || campaign?.type === 'multi'
  const isEmail = campaign?.type === 'email'  || campaign?.type === 'multi'

  useEffect(() => {
    if (!canEdit) return
    apiFetch<any>('/api/contact-lists?limit=200')
      .then(r => setContactLists(Array.isArray(r?.data) ? r.data : Array.isArray(r) ? r : []))
      .catch(() => {})
  }, [canEdit])

  // progress polling for active campaigns
  useEffect(() => {
    if (campaign?.status !== 'active') {
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current)
      return
    }
    const poll = () => apiFetch<Progress>(`/api/campaigns/${id}/progress`).then(r => setProgress(r)).catch(() => {})
    poll()
    progressIntervalRef.current = setInterval(poll, 5000)
    return () => { if (progressIntervalRef.current) clearInterval(progressIntervalRef.current) }
  }, [campaign?.status, id])

  // auto-save (quiet, debounce 2.5s)
  useEffect(() => {
    if (initialLoadRef.current || !canEdit || !id) return
    if (autoSaveRef.current) clearTimeout(autoSaveRef.current)
    autoSaveRef.current = setTimeout(async () => {
      const p: Record<string, any> = { name }
      if (description) p.description = description
      if (scheduledAt) p.scheduled_at = new Date(scheduledAt).toISOString()
      if (listId !== '') p.list_id = Number(listId)
      if (isSMS)   p.sms_body = smsBody
      if (isEmail) {
        p.email_subject     = emailSubject
        p.email_blocks_json = JSON.stringify(emailBlocks)
        const html          = exportToHtml(emailBlocks.blocks, emailBlocks.settings)
        p.email_body_html   = html
        p.email_body_text   = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        if (fromName)  p.from_name  = fromName
        if (fromEmail) p.from_email = fromEmail
      }
      try {
        await apiFetch(`/api/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(p) })
        setLastSaved(new Date())
      } catch { /* silent auto-save failure */ }
    }, 2500)
    return () => { if (autoSaveRef.current) clearTimeout(autoSaveRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, description, emailBlocks, emailSubject, fromName, fromEmail, smsBody, scheduledAt, listId])

  function buildPayload() {
    const p: Record<string, any> = { name }
    if (description) p.description = description
    if (scheduledAt) p.scheduled_at = new Date(scheduledAt).toISOString()
    if (listId !== '') p.list_id = Number(listId)
    if (isSMS)   p.sms_body = smsBody
    if (isEmail) {
      p.email_subject     = emailSubject
      p.email_blocks_json = JSON.stringify(emailBlocks)
      const html = exportToHtml(emailBlocks.blocks, emailBlocks.settings)
      p.email_body_html   = html
      p.email_body_text   = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (fromName)  p.from_name  = fromName
      if (fromEmail) p.from_email = fromEmail
    }
    return p
  }

  async function save() {
    if (!canEdit || !id) return
    setSaving(true)
    try {
      await apiFetch(`/api/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(buildPayload()) })
      setLastSaved(new Date())
      toast.success('Saved')
      load()
    } catch (ex: any) { toast.error(ex.message ?? 'Save failed') }
    finally { setSaving(false) }
  }

  async function sendTest() {
    if (!id) return
    setTestSending(true)
    try {
      const res = await apiPost<{ sent: number; warnings: string[] }>(`/api/campaigns/${id}/test-send`, {
        to_email: testEmail || undefined,
        to_phone: testPhone || undefined,
      })
      toast.success(`Test ${res.sent > 0 ? 'sent' : 'queued'}${res.warnings?.length ? ' — check warnings' : ''}`)
      if (res.warnings?.length) res.warnings.forEach(w => toast.warning(w))
    } catch (ex: any) { toast.error(ex.message ?? 'Test send failed') }
    finally { setTestSending(false) }
  }

  async function startCampaign() {
    if (!id) return
    setStarting(true)
    try {
      if (canEdit) await apiFetch(`/api/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(buildPayload()) })
      const isMulti = campaign?.type === 'multi'
      await apiPost(`/api/campaigns/${id}/start`, {
        skip_sms:   isMulti && !enableSMS,
        skip_email: isMulti && !enableEmail,
      })
      toast.success('Campaign started')
      setPreflightOpen(false)
      load()
    } catch (ex: any) { toast.error(ex.message ?? 'Failed to start'); throw ex }
    finally { setStarting(false) }
  }

  async function pauseCampaign() {
    if (!id) return
    setPausing(true)
    try { await apiPost(`/api/campaigns/${id}/pause`, {}); toast.success('Paused'); load() }
    catch (ex: any) { toast.error(ex.message ?? 'Failed to pause') }
    finally { setPausing(false) }
  }

  async function cancelCampaign() {
    if (!id) return
    setCancelling(true)
    try { await apiPost(`/api/campaigns/${id}/cancel`, {}); toast.success('Cancelled'); load() }
    catch (ex: any) { toast.error(ex.message ?? 'Failed to cancel') }
    finally { setCancelling(false) }
  }

  async function duplicateCampaign() {
    if (!id) return
    try {
      const res = await apiPost<{ id: number; name: string }>(`/api/campaigns/${id}/duplicate`, {})
      toast.success(`Duplicated as "${res.name}"`)
      navigate(`/campaigns/${res.id}/report`)
    } catch (ex: any) { toast.error(ex.message ?? 'Failed to duplicate') }
  }

  async function restartCampaign() {
    if (!id) return
    try {
      await apiPost(`/api/campaigns/${id}/restart`, {})
      toast.success('Campaign reset to draft — edit and start when ready')
      window.scrollTo({ top: 0, behavior: 'smooth' })
      load()
    } catch (ex: any) { toast.error(ex.message ?? 'Failed to restart') }
  }

  function applyTemplate(t: Template) {
    if (tplFor === 'sms') {
      if (t.sms_body) setSmsBody(t.sms_body)
    } else {
      if (t.email_subject) setEmailSubject(t.email_subject)
      if (Array.isArray(t.email_blocks) && t.email_blocks.length > 0) {
        setEmailBlocks({ blocks: t.email_blocks as EmailBlock[] })
      }
    }
    toast.success(`Template "${t.name}" applied`)
  }

  const m           = report?.metrics
  const cs          = report?.contact_stats
  const hasSendData = toN(m?.sent) > 0
  const statusMeta  = STATUS_META[campaign?.status ?? ''] ?? { color: '#6B7280', label: campaign?.status ?? '' }
  const typeColor   = TYPE_COLOR[campaign?.type ?? ''] ?? NAVY
  const typeLabel   = TYPE_LABEL[campaign?.type ?? ''] ?? campaign?.type ?? ''
  const timeline    = (report?.timeline ?? []).map(t => ({
    ...t,
    hour: t.hour ? new Date(t.hour).toLocaleTimeString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '',
  }))
  const sent = toN(m?.sent)

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner /></div>
  if (!campaign) return <ErrBanner error={err ?? 'Campaign not found'} />

  const isMulti      = campaign.type === 'multi'
  const activeSMS    = isSMS   && (!isMulti || enableSMS)
  const activeEmail  = isEmail && (!isMulti || enableEmail)

  const checks = [
    { label: 'Campaign name',   ok: name.trim().length > 0,                   hint: 'Enter a name in Setup' },
    { label: 'Contact list',    ok: listId !== '',                             hint: 'Choose a list in Setup' },
    ...(isMulti && !enableSMS && !enableEmail
      ? [{ label: 'At least one channel enabled', ok: false, hint: 'Enable SMS or Email in Content' }]
      : []),
    ...(activeSMS   ? [{ label: 'SMS body',      ok: smsBody.trim().length > 0,      hint: 'Write your SMS in Content' }]  : []),
    ...(activeEmail ? [
      { label: 'Email subject', ok: emailSubject.trim().length > 0, hint: 'Enter a subject in Content' },
      { label: 'Email body',    ok: emailBlocks.blocks.length > 0,  hint: 'Build your email in Content' },
    ] : []),
  ]
  const allChecksPass = checks.every(c => c.ok)

  const TABS: { key: TabKey; label: string; icon: string }[] = [
    { key: 'setup',   label: 'Setup',          icon: 'settings' },
    { key: 'content', label: 'Content',         icon: 'edit_note' },
    { key: 'review',  label: 'Review & Launch', icon: 'rocket_launch' },
    { key: 'results', label: 'Results',         icon: 'analytics' },
  ]

  return (
    <Page
      title={name || campaign.name}
      back={{ label: 'All Campaigns', to: '/campaigns' }}
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '3px 10px', borderRadius: RADIUS['2xl'], background: `${statusMeta.color}18`, color: statusMeta.color, border: `1px solid ${statusMeta.color}40`, fontFamily: SORA, letterSpacing: '.04em', textTransform: 'uppercase' }}>{statusMeta.label}</span>
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '3px 10px', borderRadius: RADIUS['2xl'], background: `${typeColor}14`, color: typeColor, fontFamily: SORA }}>{typeLabel}</span>
          {lastSaved && canEdit && (
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 13 }}>cloud_done</span>
              {lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {canEdit && (
            <button onClick={save} disabled={saving} style={{ ...btnSecondary, gap: 6, opacity: saving ? .7 : 1 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
          {(campaign.status === 'draft' || campaign.status === 'scheduled') && (
            <button onClick={() => setPreflightOpen(true)} disabled={starting}
              style={{ ...btnPrimary, background: GREEN, borderColor: GREEN, gap: 6, opacity: starting ? .7 : 1 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>play_arrow</span>
              {starting ? 'Starting…' : 'Start'}
            </button>
          )}
          {campaign.status === 'active' && (
            <button onClick={pauseCampaign} disabled={pausing} style={{ ...btnSecondary, gap: 6, opacity: pausing ? .7 : 1 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>pause</span>
              {pausing ? 'Pausing…' : 'Pause'}
            </button>
          )}
          {campaign.status === 'paused' && (
            <button onClick={() => setPreflightOpen(true)} disabled={starting}
              style={{ ...btnPrimary, background: GREEN, borderColor: GREEN, gap: 6, opacity: starting ? .7 : 1 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>play_arrow</span>
              Resume
            </button>
          )}
          {campaign.status !== 'completed' && campaign.status !== 'cancelled' && (
            <button onClick={() => setPushOpen(true)} style={{ ...btnPrimary, background: '#7C3AED', borderColor: '#7C3AED', gap: 6 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>call</span>
              Push to TM
            </button>
          )}
          {campaign.status !== 'completed' && campaign.status !== 'cancelled' && (
            <button onClick={cancelCampaign} disabled={cancelling}
              style={{ ...btnSecondary, gap: 6, color: RED, borderColor: `${RED}40`, opacity: cancelling ? .7 : 1 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>stop_circle</span>
              {cancelling ? 'Stopping…' : 'Stop'}
            </button>
          )}
          {(campaign.status === 'completed' || campaign.status === 'cancelled') && (
            <>
              <button onClick={restartCampaign} style={{ ...btnPrimary, background: GREEN, borderColor: GREEN, gap: 6 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>restart_alt</span>
                Restart
              </button>
              <button onClick={duplicateCampaign} style={{ ...btnSecondary, gap: 6 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>content_copy</span>
                Duplicate
              </button>
            </>
          )}
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* Live progress banner (active only) */}
      {campaign.status === 'active' && (
        <div style={{ marginBottom: 16, background: 'var(--card)', border: `1px solid ${GREEN}40`, borderRadius: RADIUS.lg, padding: '14px 18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: GREEN, display: 'inline-block' }} />
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>Sending live</span>
            </div>
            {progress && (
              <span style={{ fontSize: TEXT.sm, ...NUM, color: 'var(--txt2)' }}>
                {fmtNum(progress.done)} / {fmtNum(progress.total)} · {fmtPct(progress.progress_pct)}
              </span>
            )}
          </div>
          <div style={{ height: 6, background: 'var(--th-bg)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress?.progress_pct ?? 0}%`, background: GREEN, borderRadius: 3, transition: 'width 1s ease' }} />
          </div>
          {progress && (
            <div style={{ display: 'flex', gap: 20, marginTop: 8 }}>
              {([['Sent', progress.sent, BLUE], ['Delivered', progress.delivered, GREEN], ['Bounced', progress.bounced, RED]] as [string, number, string][]).map(([label, val, color]) => (
                <span key={label} style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                  {label}: <span style={{ ...NUM, color, fontWeight: FW.semibold }}>{fmtNum(val)}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--bdr)', marginBottom: 24 }}>
        {TABS.map(t => {
          const isActive = tab === t.key
          // Only "Review & Launch" is locked when campaign isn't editable
          const locked   = !canEdit && t.key === 'review'
          return (
            <button key={t.key}
              onClick={() => !locked && setTab(t.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '10px 18px', border: 'none',
                borderBottom: isActive ? `2px solid ${NAVY}` : '2px solid transparent',
                marginBottom: -1, background: 'none',
                cursor: locked ? 'default' : 'pointer',
                color: isActive ? NAVY : locked ? 'var(--txt3)' : 'var(--txt2)',
                fontWeight: isActive ? FW.semibold : FW.normal,
                fontFamily: INTER, fontSize: TEXT.sm,
                opacity: locked ? .4 : 1,
                transition: 'color .12s',
              }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{t.icon}</span>
              {t.label}
              {t.key === 'review' && canEdit && !allChecksPass && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: AMBER, display: 'inline-block', marginLeft: 2 }} title="Checklist incomplete" />
              )}
              {t.key === 'results' && hasSendData && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: GREEN, display: 'inline-block', marginLeft: 2 }} />
              )}
            </button>
          )
        })}
      </div>

      {/* ── SETUP TAB ── */}
      {tab === 'setup' && (
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <SectionCard title="Campaign Details" padding>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <label style={lbl}>Campaign Name *</label>
                  <input value={name} onChange={e => setName(e.target.value)} disabled={!canEdit}
                    placeholder="e.g. Q3 Customer Re-engagement" style={{ ...fld, opacity: canEdit ? 1 : .85 }} />
                </div>
                <div>
                  <label style={lbl}>Description <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(internal notes)</span></label>
                  <textarea value={description} onChange={e => setDescription(e.target.value)} disabled={!canEdit}
                    placeholder="What is this campaign for?" rows={3}
                    style={{ ...fld, resize: 'vertical', lineHeight: 1.6, opacity: canEdit ? 1 : .85 }} />
                </div>
              </div>
            </SectionCard>

            <SectionCard title="Audience & Timing" padding>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <label style={lbl}>Contact List *</label>
                  {canEdit ? (
                    <select value={String(listId)} onChange={e => setListId(e.target.value ? Number(e.target.value) : '')} style={fld}>
                      <option value="">No list selected</option>
                      {contactLists.map(cl => (
                        <option key={cl.id} value={String(cl.id)}>{cl.name}{cl.total ? ` (${fmtNum(cl.total)})` : ''}</option>
                      ))}
                    </select>
                  ) : (
                    <div style={{ padding: '8px 12px', background: 'var(--th-bg)', borderRadius: RADIUS.md, fontSize: TEXT.base, color: campaign.list_name ? 'var(--txt)' : 'var(--txt3)' }}>
                      {campaign.list_name ?? 'None'}
                    </div>
                  )}
                </div>
                <div>
                  <label style={lbl}>Schedule Date <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional — leave blank to send immediately)</span></label>
                  <input type="datetime-local" value={scheduledAt} onChange={e => setScheduledAt(e.target.value)}
                    disabled={!canEdit} style={{ ...fld, opacity: canEdit ? 1 : .85 }} />
                </div>
              </div>
            </SectionCard>
          </div>

          <SectionCard title="Campaign Info" padding>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {([
                ['Channel',    <span style={{ ...NUM, color: typeColor, fontWeight: FW.bold }}>{typeLabel}</span>],
                ['Status',     <span style={{ color: statusMeta.color, fontWeight: FW.semibold }}>{statusMeta.label}</span>],
                ['Audience',   <span style={NUM}>{fmtNum(toN(campaign.total_contacts))}</span>],
                ...(campaign.started_at   ? [['Started',   fmtDatetime(campaign.started_at)]]   : []),
                ...(campaign.completed_at ? [['Completed', fmtDatetime(campaign.completed_at)]] : []),
                ['Created by', campaign.created_by_name ?? '—'],
                ['Created',    fmtDate(campaign.created_at)],
              ] as [string, React.ReactNode][]).map(([label, value]) => (
                <div key={String(label)} style={{ display: 'flex', justifyContent: 'space-between', gap: SP[3], fontSize: TEXT.sm }}>
                  <span style={{ color: 'var(--txt2)', flexShrink: 0 }}>{label}</span>
                  <span style={{ color: 'var(--txt)', fontWeight: 500, textAlign: 'right' }}>{value}</span>
                </div>
              ))}
              {campaign.pause_reason === 'daily_limit' && campaign.status === 'paused' && (
                <div style={{ marginTop: 4, padding: '8px 10px', background: '#FFF9ED', borderRadius: RADIUS.md, border: `1px solid ${AMBER}40`, fontSize: TEXT.xs, color: '#92400E' }}>
                  Paused — daily limit reached. Auto-resumes at midnight.
                </div>
              )}
            </div>
          </SectionCard>
        </div>
      )}

      {/* ── CONTENT TAB ── */}
      {tab === 'content' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {!canEdit && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: 'var(--th-bg)', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', fontSize: TEXT.sm, color: 'var(--txt2)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)' }}>visibility</span>
              Viewing content — campaign is {campaign.status} (read-only)
            </div>
          )}

          {/* Multi-channel toggles */}
          {isMulti && canEdit && (
            <div style={{ display: 'flex', gap: 10, padding: '10px 14px', background: 'var(--th-bg)', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', alignItems: 'center' }}>
              <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginRight: 4 }}>Send via:</span>
              {([
                { key: 'sms',   label: 'SMS',   icon: 'smartphone', color: PURPLE, enabled: enableSMS,   set: setEnableSMS },
                { key: 'email', label: 'Email', icon: 'mail',       color: BLUE,   enabled: enableEmail, set: setEnableEmail },
              ] as const).map(ch => (
                <button key={ch.key} type="button"
                  onClick={() => ch.set(v => !v)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '5px 12px', borderRadius: RADIUS.xl,
                    border: `1.5px solid ${ch.enabled ? ch.color : 'var(--bdr)'}`,
                    background: ch.enabled ? `${ch.color}12` : 'var(--card)',
                    color: ch.enabled ? ch.color : 'var(--txt3)',
                    fontSize: TEXT.xs, fontWeight: FW.semibold,
                    cursor: 'pointer', transition: 'all .14s',
                  }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{ch.enabled ? 'check_circle' : 'radio_button_unchecked'}</span>
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{ch.icon}</span>
                  {ch.label}
                </button>
              ))}
              {!enableSMS && !enableEmail && (
                <span style={{ fontSize: TEXT.xs, color: RED, marginLeft: 4 }}>At least one channel must be enabled</span>
              )}
            </div>
          )}

          {isSMS && (
            <div style={{ opacity: isMulti && !enableSMS ? .45 : 1, pointerEvents: isMulti && !enableSMS ? 'none' : 'auto', transition: 'opacity .2s' }}>
              <SectionCard padding title={undefined}
                actions={canEdit ? (
                  <button onClick={() => { setTplFor('sms'); setTplOpen(true) }}
                    style={{ ...btnSecondary, fontSize: TEXT.sm, padding: '4px 12px', gap: 5 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>folder_open</span>
                    Load Template
                  </button>
                ) : undefined}
              >
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: PURPLE, letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>smartphone</span>
                  SMS Message
                  {isMulti && !enableSMS && <span style={{ fontSize: TEXT.xs, fontWeight: FW.normal, color: 'var(--txt3)', marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>disabled for this send</span>}
                </div>
                <SMSBuilder value={smsBody} onChange={setSmsBody} canEdit={canEdit} senderName={fromName || campaign.from_name} />
              </SectionCard>
            </div>
          )}

          {isEmail && (
            <div style={{ opacity: isMulti && !enableEmail ? .45 : 1, pointerEvents: isMulti && !enableEmail ? 'none' : 'auto', transition: 'opacity .2s' }}>
              <SectionCard padding title={undefined}
                actions={canEdit ? (
                  <button onClick={() => { setTplFor('email'); setTplOpen(true) }}
                    style={{ ...btnSecondary, fontSize: TEXT.sm, padding: '4px 12px', gap: 5 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>folder_open</span>
                    Load Template
                  </button>
                ) : undefined}
              >
                <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: BLUE, letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>mail</span>
                  Email Content
                  {isMulti && !enableEmail && <span style={{ fontSize: TEXT.xs, fontWeight: FW.normal, color: 'var(--txt3)', marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>disabled for this send</span>}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
                  <div>
                    <label style={lbl}>Subject Line *</label>
                    <input value={emailSubject} onChange={e => setEmailSubject(e.target.value)} disabled={!canEdit}
                      placeholder="e.g. Your O3 Capital statement is ready" style={{ ...fld, opacity: canEdit ? 1 : .85 }} />
                  </div>
                  <div>
                    <label style={lbl}>From Name</label>
                    <input value={fromName} onChange={e => setFromName(e.target.value)} disabled={!canEdit}
                      placeholder="O3 Capital" style={{ ...fld, opacity: canEdit ? 1 : .85 }} />
                  </div>
                  <div>
                    <label style={lbl}>From Email</label>
                    <input value={fromEmail} onChange={e => setFromEmail(e.target.value)} disabled={!canEdit}
                      placeholder="care@o3cards.com" type="email" style={{ ...fld, opacity: canEdit ? 1 : .85 }} />
                  </div>
                </div>
                {canEdit ? (
                  <div style={{ height: 560, border: '1px solid var(--bdr)', borderRadius: RADIUS.md, overflow: 'hidden', background: '#fff' }}>
                    <EmailBlockEditor value={emailBlocks} onChange={setEmailBlocks} previewSubject={emailSubject} suppressAutoTemplate />
                  </div>
                ) : (
                  <EmailReadOnlyPreview html={campaign.email_body_html ?? ''} subject={emailSubject} />
                )}
              </SectionCard>
            </div>
          )}

          {/* Test send — always available */}
          <SectionCard title="Send a Test" padding>
            <p style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 0, marginBottom: 14 }}>
              Sends a single test with sample merge data. Subject/SMS body will be prefixed [TEST].
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: isEmail && isSMS ? '1fr 1fr auto' : '1fr auto', gap: 10, alignItems: 'flex-end' }}>
              {isEmail && (
                <div>
                  <label style={lbl}>Test email address</label>
                  <input type="email" value={testEmail} onChange={e => setTestEmail(e.target.value)} placeholder="you@example.com" style={fld} />
                </div>
              )}
              {isSMS && (
                <div>
                  <label style={lbl}>Test phone number</label>
                  <input type="tel" value={testPhone} onChange={e => setTestPhone(e.target.value)} placeholder="+2348012345678" style={fld} />
                </div>
              )}
              <button onClick={sendTest} disabled={testSending || (!testEmail && !testPhone)}
                style={{ ...btnSecondary, gap: 6, height: 38, alignSelf: 'flex-end', whiteSpace: 'nowrap', opacity: testSending || (!testEmail && !testPhone) ? .55 : 1 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>send</span>
                {testSending ? 'Sending…' : 'Send Test'}
              </button>
            </div>
          </SectionCard>
        </div>
      )}

      {/* ── REVIEW & LAUNCH TAB ── */}
      {tab === 'review' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <SectionCard title="Pre-flight Checklist" padding>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {checks.map(c => (
                  <div key={c.label} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 18, color: c.ok ? GREEN : AMBER, flexShrink: 0, marginTop: 1 }}>
                      {c.ok ? 'check_circle' : 'radio_button_unchecked'}
                    </span>
                    <div>
                      <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: c.ok ? 'var(--txt)' : 'var(--txt2)' }}>{c.label}</div>
                      {!c.ok && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>{c.hint}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>

            {scheduledAt && (
              <div style={{ padding: '12px 16px', background: `${BLUE}08`, border: `1px solid ${BLUE}30`, borderRadius: RADIUS.md, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 18, color: BLUE, flexShrink: 0 }}>schedule</span>
                <div>
                  <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>Scheduled send</div>
                  <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 2 }}>{fmtDatetime(new Date(scheduledAt).toISOString())}</div>
                </div>
              </div>
            )}

            {/* Content summary */}
            <SectionCard title="What will be sent" padding>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {activeSMS && (
                  <div style={{ background: `${PURPLE}08`, border: `1px solid ${PURPLE}25`, borderRadius: RADIUS.md, padding: '10px 14px' }}>
                    <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: PURPLE, letterSpacing: '.05em', textTransform: 'uppercase', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 13 }}>smartphone</span> SMS
                    </div>
                    {smsBody.trim() ? (
                      <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', lineHeight: 1.6, fontFamily: 'monospace', maxHeight: 72, overflow: 'hidden', position: 'relative' }}>
                        {smsBody.slice(0, 160)}{smsBody.length > 160 ? '…' : ''}
                      </div>
                    ) : (
                      <div style={{ fontSize: TEXT.sm, color: RED }}>No SMS body — add one in Content tab</div>
                    )}
                  </div>
                )}
                {activeEmail && (
                  <div style={{ background: `${BLUE}08`, border: `1px solid ${BLUE}25`, borderRadius: RADIUS.md, padding: '10px 14px' }}>
                    <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: BLUE, letterSpacing: '.05em', textTransform: 'uppercase', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 13 }}>mail</span> Email
                    </div>
                    <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
                      From: <span style={{ color: 'var(--txt)', fontWeight: FW.semibold }}>{fromName || '—'}</span>
                      {fromEmail && <span style={{ color: 'var(--txt3)' }}> &lt;{fromEmail}&gt;</span>}
                    </div>
                    <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.semibold, marginTop: 3 }}>
                      {emailSubject || <span style={{ color: RED }}>No subject — add one in Content tab</span>}
                    </div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 3 }}>
                      {emailBlocks.blocks.length} block{emailBlocks.blocks.length !== 1 ? 's' : ''} in email body
                    </div>
                  </div>
                )}
                {isMulti && !enableSMS && !enableEmail && (
                  <div style={{ fontSize: TEXT.sm, color: RED }}>No channels enabled — enable at least one in Content tab.</div>
                )}
              </div>
            </SectionCard>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <SectionCard title="Audience Preview" padding
              actions={
                <button onClick={() => setPreflightOpen(true)}
                  style={{ ...btnSecondary, fontSize: TEXT.sm, padding: '3px 10px', gap: 5 }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 13 }}>group</span>
                  Check Audience
                </button>
              }
            >
              {listId ? (
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>
                  {contactLists.find(cl => cl.id === listId)?.name ?? `List #${listId}`}
                  {(contactLists.find(cl => cl.id === listId)?.total ?? 0) > 0 && (
                    <span style={{ color: 'var(--txt3)' }}> · {fmtNum(contactLists.find(cl => cl.id === listId)!.total!)} contacts</span>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: TEXT.sm, color: RED }}>No contact list selected.</div>
              )}
              <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 0, marginTop: 8 }}>
                Click "Check Audience" to see suppressed, invalid, and usable contact counts before sending.
              </p>
            </SectionCard>

            {isSMS && smsBody && (
              <SectionCard title="SMS Credit Estimate" padding>
                {(() => {
                  const len      = smsBody.length
                  const segs     = len === 0 ? 1 : len <= 160 ? 1 : Math.ceil(len / 153)
                  const listSize = contactLists.find(cl => cl.id === listId)?.total ?? 0
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: TEXT.sm }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--txt2)' }}>Characters</span>
                        <span style={{ ...NUM, color: len > 160 ? RED : 'var(--txt)', fontWeight: FW.semibold }}>{len} / 160</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--txt2)' }}>SMS parts</span>
                        <span style={{ ...NUM, fontWeight: FW.semibold }}>{segs}</span>
                      </div>
                      {listSize > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 8, borderTop: '1px solid var(--bdr)', marginTop: 2 }}>
                          <span style={{ color: 'var(--txt2)' }}>Est. total credits</span>
                          <span style={{ ...NUM, fontWeight: FW.bold, color: NAVY }}>{fmtNum(segs * listSize)}</span>
                        </div>
                      )}
                    </div>
                  )
                })()}
              </SectionCard>
            )}

            <div>
              <button onClick={() => setPreflightOpen(true)} disabled={starting || !allChecksPass}
                style={{ ...btnPrimary, background: allChecksPass ? GREEN : '#9CA3AF', borderColor: allChecksPass ? GREEN : '#9CA3AF', width: '100%', justifyContent: 'center', gap: 8, fontSize: TEXT.base, padding: '12px 20px', opacity: starting ? .7 : 1 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 18 }}>rocket_launch</span>
                {starting ? 'Starting…' : scheduledAt ? 'Schedule Campaign' : 'Launch Campaign'}
              </button>
              {!allChecksPass && (
                <div style={{ textAlign: 'center', fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 6 }}>
                  Complete the checklist to enable launch.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── RESULTS TAB ── */}
      {tab === 'results' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {!hasSendData && (
            <div style={{ padding: 48, textAlign: 'center', background: 'var(--card)', borderRadius: RADIUS.lg, border: '1px solid var(--bdr)', color: 'var(--txt3)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 48, display: 'block', marginBottom: 12 }}>bar_chart</span>
              <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, marginBottom: 4, color: 'var(--txt2)' }}>No send data yet</div>
              <div style={{ fontSize: TEXT.sm }}>
                {canEdit ? 'Launch the campaign to see results here.' : 'No messages were recorded for this campaign.'}
              </div>
            </div>
          )}
          {hasSendData && m && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
                <KpiCard label="Sent"          value={fmtNum(toN(m.sent))} />
                <KpiCard label="Delivery Rate" value={fmtPct(toN(m.delivery_rate))} accent={GREEN} />
                {isSMS
                  ? <KpiCard label="SMS Delivered" value={fmtNum(toN(m.delivered))} accent={GREEN} />
                  : <KpiCard label="Open Rate"     value={fmtPct(toN(m.open_rate))} accent={BLUE}  />
                }
              </div>
              {!isSMS && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
                  <KpiCard label="Click Rate"   value={fmtPct(toN(m.click_rate))} accent={PURPLE} />
                  <KpiCard label="Bounced"      value={fmtNum(toN(m.bounced))} accent={toN(m.bounce_rate) > 2 ? RED : undefined} />
                  <KpiCard label="Unsubscribed" value={fmtNum(toN(m.unsubscribed))} />
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 14 }}>
                <SectionCard title="Delivery Funnel">
                  {cs && <PipelineBar stats={cs} total={toN(m.total_contacts)} />}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 20 }}>
                    {([['Bounced', fmtNum(toN(m.bounced)), RED], ['Spam', fmtNum(toN(m.spam)), RED], ['Unsubscribed', fmtNum(toN(m.unsubscribed)), AMBER], ['Failed', fmtNum(toN(m.failed)), '#6B7280']] as const).map(([label, val, color]) => (
                      <div key={label} style={{ textAlign: 'center', padding: '10px 8px', background: 'var(--th-bg)', borderRadius: RADIUS.md }}>
                        <div style={{ fontSize: 17, fontWeight: FW.bold, color, ...NUM }}>{val}</div>
                        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                </SectionCard>
                <SectionCard title="Engagement Timeline" subtitle="Hourly events">
                  {timeline.length > 0 ? (
                    <ResponsiveContainer width="100%" height={200}>
                      <AreaChart data={timeline} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <defs>
                          <linearGradient id="rg1" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={GREEN} stopOpacity={0.15}/><stop offset="95%" stopColor={GREEN} stopOpacity={0}/></linearGradient>
                          <linearGradient id="rg2" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={BLUE}  stopOpacity={0.18}/><stop offset="95%" stopColor={BLUE}  stopOpacity={0}/></linearGradient>
                          <linearGradient id="rg3" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={NAVY}  stopOpacity={0.15}/><stop offset="95%" stopColor={NAVY}  stopOpacity={0}/></linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
                        <XAxis dataKey="hour" tick={{ fontSize: 9.5, fill: 'var(--txt2)' }} />
                        <YAxis tick={{ fontSize: 9 as any, fill: 'var(--txt2)' }} allowDecimals={false} />
                        <Tooltip contentStyle={{ fontSize: TEXT.sm, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
                        <Legend iconSize={10} wrapperStyle={{ fontSize: TEXT.xs }} />
                        <Area type="monotone" dataKey="delivered" stroke={GREEN} strokeWidth={2} fill="url(#rg1)" name="Delivered" />
                        <Area type="monotone" dataKey="opened"    stroke={BLUE}  strokeWidth={2} fill="url(#rg2)" name="Opened" />
                        <Area type="monotone" dataKey="clicked"   stroke={NAVY}  strokeWidth={2} fill="url(#rg3)" name="Clicked" />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <div style={{ height: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>No timeline data yet.</div>
                  )}
                </SectionCard>
              </div>
              {(report?.top_links ?? []).length > 0 && (
                <SectionCard title="Top Clicked Links">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {report!.top_links.map((link, i) => {
                      const pct = sent > 0 ? (toN(link.clicks) / sent) * 100 : 0
                      return (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div style={{ width: 22, height: 22, borderRadius: '50%', background: `${BLUE}14`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, color: BLUE, flexShrink: 0 }}>{i + 1}</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: TEXT.sm, color: BLUE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{link.url}</div>
                            <div style={{ height: 5, background: 'var(--th-bg)', borderRadius: 3, marginTop: 3, overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${pct}%`, background: BLUE, borderRadius: 3 }} />
                            </div>
                          </div>
                          <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: NAVY, flexShrink: 0 }}>{fmtNum(toN(link.clicks))}</span>
                        </div>
                      )
                    })}
                  </div>
                </SectionCard>
              )}
            </>
          )}
          <ContactsSection campaignId={id!} />
        </div>
      )}

      <PreflightModal
        open={preflightOpen}
        onClose={() => setPreflightOpen(false)}
        onConfirm={startCampaign}
        listId={listId !== '' ? listId : campaign.list_id}
        campaignType={campaign.type}
      />
      <TemplatePickerModal open={tplOpen} onClose={() => setTplOpen(false)} onApply={applyTemplate} channel={tplFor} />
      <PushToTelemarketingModal campaignId={id!} open={pushOpen} onClose={() => setPushOpen(false)} />
    </Page>
  )
}
