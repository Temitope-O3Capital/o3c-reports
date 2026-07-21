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

export default function CampaignDetail() {
  const { id }   = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [campaign, setCampaign] = useState<Campaign | null>(null)
  const [report,   setReport]   = useState<ReportResp | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [err,      setErr]      = useState<string | null>(null)

  const [emailBlocks,  setEmailBlocks]  = useState<EditorValue>({ blocks: [] })
  const [emailSubject, setEmailSubject] = useState('')
  const [fromName,     setFromName]     = useState('')
  const [fromEmail,    setFromEmail]    = useState('')
  const [smsBody,      setSmsBody]      = useState('')
  const [scheduledAt,  setScheduledAt]  = useState('')
  const [listId,       setListId]       = useState<number | ''>('')
  const [contactLists, setContactLists] = useState<ContactListItem[]>([])

  const [saving,       setSaving]       = useState(false)
  const [starting,     setStarting]     = useState(false)
  const [pausing,      setPausing]      = useState(false)
  const [cancelling,   setCancelling]   = useState(false)
  const [pushOpen,     setPushOpen]     = useState(false)
  const [preflightOpen,setPreflightOpen]= useState(false)
  const [tplOpen,      setTplOpen]      = useState(false)
  const [tplFor,       setTplFor]       = useState<'email' | 'sms'>('sms')

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true); setErr(null)
    try {
      const [camp, rpt] = await Promise.all([
        apiFetch<Campaign>(`/api/campaigns/${id}`),
        apiFetch<ReportResp>(`/api/campaigns/${id}/analytics`).catch(() => null),
      ])
      setCampaign(camp); setReport(rpt)
      setSmsBody(camp.sms_body ?? '')
      setEmailSubject(camp.email_subject ?? '')
      setFromName(camp.from_name ?? '')
      setFromEmail(camp.from_email ?? '')
      setScheduledAt(toDatetimeLocal(camp.scheduled_at ?? ''))
      setListId(camp.list_id ?? '')

      // email_blocks_json is the canonical store; email_body_text may have legacy JSON
      let blocks: EmailBlock[] = [], settings: EmailSettings = {}
      const src = camp.email_blocks_json || camp.email_body_text || ''
      if (src) {
        try {
          const parsed = JSON.parse(src)
          if (Array.isArray(parsed.blocks)) { blocks = parsed.blocks; settings = parsed.settings ?? {} }
        } catch {}
      }
      setEmailBlocks({ blocks, settings })
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

  function buildPayload() {
    const p: Record<string, any> = {}
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
      toast.success('Campaign saved')
      load()
    } catch (ex: any) { toast.error(ex.message ?? 'Save failed') }
    finally { setSaving(false) }
  }

  async function startCampaign() {
    if (!id) return
    setStarting(true)
    try {
      if (canEdit) await apiFetch(`/api/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(buildPayload()) })
      await apiPost(`/api/campaigns/${id}/start`, {})
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

  const m   = report?.metrics
  const cs  = report?.contact_stats
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

  return (
    <Page
      title={campaign.name}
      subtitle={`${typeLabel} campaign · ${statusMeta.label}${campaign.started_at ? ' · Started ' + fmtDatetime(campaign.started_at) : ''}`}
      actions={
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '3px 10px', borderRadius: RADIUS['2xl'], background: `${statusMeta.color}18`, color: statusMeta.color, border: `1px solid ${statusMeta.color}40`, fontFamily: SORA, letterSpacing: '.04em', textTransform: 'uppercase' }}>{statusMeta.label}</span>
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '3px 10px', borderRadius: RADIUS['2xl'], background: `${typeColor}14`, color: typeColor, fontFamily: SORA }}>{typeLabel}</span>
          <button onClick={() => navigate('/campaigns')} style={{ padding: '7px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>arrow_back</span>
            All Campaigns
          </button>
          {canEdit && (
            <button onClick={save} disabled={saving} style={{ ...btnSecondary, gap: 6, opacity: saving ? .7 : 1 }}>
              {saving ? 'Saving…' : 'Save Draft'}
            </button>
          )}
          {(campaign.status === 'draft' || campaign.status === 'scheduled') && (
            <button onClick={() => setPreflightOpen(true)} disabled={starting}
              style={{ ...btnPrimary, background: GREEN, borderColor: GREEN, gap: 6, opacity: starting ? .7 : 1 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>play_arrow</span>
              Save & Start
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
        </div>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16, alignItems: 'start' }}>

        {/* ── LEFT column ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {!canEdit && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: 'var(--th-bg)', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', fontSize: TEXT.sm, color: 'var(--txt2)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)' }}>lock</span>
              Content is locked — campaign is {campaign.status}
            </div>
          )}

          {/* SMS */}
          {isSMS && (
            <SectionCard padding title={undefined}
              actions={canEdit ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => { setTplFor('sms'); setTplOpen(true) }}
                    style={{ ...btnSecondary, fontSize: TEXT.sm, padding: '4px 12px', gap: 5 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>folder_open</span>
                    Load Template
                  </button>
                  <button onClick={save} disabled={saving} style={{ ...btnSecondary, fontSize: TEXT.sm, padding: '4px 12px', opacity: saving ? .7 : 1 }}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              ) : undefined}
            >
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: PURPLE, letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>smartphone</span>
                SMS Message
              </div>
              <SMSBuilder value={smsBody} onChange={setSmsBody} canEdit={canEdit} senderName={fromName || campaign.from_name} />
            </SectionCard>
          )}

          {/* Email */}
          {isEmail && (
            <SectionCard padding title={undefined}
              actions={canEdit ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => { setTplFor('email'); setTplOpen(true) }}
                    style={{ ...btnSecondary, fontSize: TEXT.sm, padding: '4px 12px', gap: 5 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>folder_open</span>
                    Load Template
                  </button>
                  <button onClick={save} disabled={saving} style={{ ...btnSecondary, fontSize: TEXT.sm, padding: '4px 12px', opacity: saving ? .7 : 1 }}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              ) : undefined}
            >
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: BLUE, letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>mail</span>
                Email Content
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
                <div>
                  <label style={lbl}>Subject Line *</label>
                  <input value={emailSubject} onChange={e => setEmailSubject(e.target.value)} disabled={!canEdit} placeholder="e.g. Your O3 Capital statement is ready" style={{ ...fld, opacity: canEdit ? 1 : .85 }} />
                </div>
                <div>
                  <label style={lbl}>From Name</label>
                  <input value={fromName} onChange={e => setFromName(e.target.value)} disabled={!canEdit} placeholder="O3 Capital" style={{ ...fld, opacity: canEdit ? 1 : .85 }} />
                </div>
                <div>
                  <label style={lbl}>From Email</label>
                  <input value={fromEmail} onChange={e => setFromEmail(e.target.value)} disabled={!canEdit} placeholder="care@o3cards.com" type="email" style={{ ...fld, opacity: canEdit ? 1 : .85 }} />
                </div>
              </div>
              {canEdit ? (
                <div style={{ height: 560, border: '1px solid var(--bdr)', borderRadius: RADIUS.md, overflow: 'hidden', background: '#fff' }}>
                  <EmailBlockEditor value={emailBlocks} onChange={setEmailBlocks} previewSubject={emailSubject} />
                </div>
              ) : (
                <EmailReadOnlyPreview html={campaign.email_body_html ?? ''} subject={emailSubject} />
              )}
            </SectionCard>
          )}

          {/* Analytics */}
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

          {!hasSendData && (campaign.status === 'completed' || campaign.status === 'cancelled') && (
            <div style={{ padding: 32, textAlign: 'center', background: 'var(--card)', borderRadius: RADIUS.lg, border: '1px solid var(--bdr)', color: 'var(--txt3)', fontSize: TEXT.base }}>
              <span className="material-symbols-rounded" style={{ fontSize: 40, display: 'block', marginBottom: 8 }}>analytics</span>
              No send data recorded for this campaign.
            </div>
          )}

          <ContactsSection campaignId={id!} />
        </div>

        {/* ── RIGHT column ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          <SectionCard title="Campaign Info" padding>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {([
                ['Channel',  <span style={{ ...NUM, color: typeColor, fontWeight: FW.bold }}>{typeLabel}</span>],
                ['Status',   <span style={{ color: statusMeta.color, fontWeight: FW.semibold }}>{statusMeta.label}</span>],
                ['Audience', <span style={NUM}>{fmtNum(toN(campaign.total_contacts))}</span>],
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

              {/* Read-only list + schedule */}
              {!canEdit && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: SP[3], fontSize: TEXT.sm }}>
                    <span style={{ color: 'var(--txt2)', flexShrink: 0 }}>Contact list</span>
                    <span style={{ color: campaign.list_name ? 'var(--txt)' : 'var(--txt3)', fontWeight: 500 }}>{campaign.list_name ?? 'None'}</span>
                  </div>
                  {campaign.scheduled_at && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: SP[3], fontSize: TEXT.sm }}>
                      <span style={{ color: 'var(--txt2)', flexShrink: 0 }}>Scheduled</span>
                      <span style={{ color: 'var(--txt)', fontWeight: 500 }}>{fmtDatetime(campaign.scheduled_at)}</span>
                    </div>
                  )}
                </>
              )}

              {campaign.pause_reason === 'daily_limit' && campaign.status === 'paused' && (
                <div style={{ marginTop: 4, padding: '8px 10px', background: '#FFF9ED', borderRadius: RADIUS.md, border: `1px solid ${AMBER}40`, fontSize: TEXT.xs, color: '#92400E' }}>
                  Paused — daily limit reached. Auto-resumes at midnight.
                </div>
              )}

              {/* Editable sidebar fields */}
              {canEdit && (
                <div style={{ marginTop: 8, paddingTop: 10, borderTop: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div>
                    <label style={lbl}>Contact List</label>
                    <select value={String(listId)} onChange={e => setListId(e.target.value ? Number(e.target.value) : '')} style={fld}>
                      <option value="">No list selected</option>
                      {contactLists.map(cl => (
                        <option key={cl.id} value={String(cl.id)}>{cl.name}{cl.total ? ` (${fmtNum(cl.total)})` : ''}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={lbl}>Schedule Date <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span></label>
                    <input type="datetime-local" value={scheduledAt} onChange={e => setScheduledAt(e.target.value)} style={fld} />
                    <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 4, marginBottom: 0 }}>Leave blank to send immediately on Start.</p>
                  </div>
                </div>
              )}
            </div>
          </SectionCard>

          {/* Actions */}
          {campaign.status !== 'completed' && campaign.status !== 'cancelled' && (
            <SectionCard title="Actions" padding>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {canEdit && (
                  <button onClick={save} disabled={saving} style={{ ...btnSecondary, width: '100%', justifyContent: 'center', gap: 6, opacity: saving ? .7 : 1 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 16 }}>save</span>
                    {saving ? 'Saving…' : 'Save Draft'}
                  </button>
                )}
                {(campaign.status === 'draft' || campaign.status === 'scheduled') && (
                  <button onClick={() => setPreflightOpen(true)} disabled={starting} style={{ ...btnPrimary, background: GREEN, borderColor: GREEN, width: '100%', justifyContent: 'center', gap: 6, opacity: starting ? .7 : 1 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 16 }}>play_arrow</span>
                    Save & Start Campaign
                  </button>
                )}
                {campaign.status === 'active' && (
                  <button onClick={pauseCampaign} disabled={pausing} style={{ ...btnSecondary, width: '100%', justifyContent: 'center', gap: 6, opacity: pausing ? .7 : 1 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 16 }}>pause</span>
                    {pausing ? 'Pausing…' : 'Pause Campaign'}
                  </button>
                )}
                {campaign.status === 'paused' && (
                  <button onClick={() => setPreflightOpen(true)} disabled={starting} style={{ ...btnPrimary, background: GREEN, borderColor: GREEN, width: '100%', justifyContent: 'center', gap: 6, opacity: starting ? .7 : 1 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 16 }}>play_arrow</span>
                    Resume Campaign
                  </button>
                )}
                <button onClick={() => setPushOpen(true)} style={{ ...btnSecondary, width: '100%', justifyContent: 'center', gap: 6, color: '#7C3AED', borderColor: '#7C3AED40' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>call</span>
                  Push to Telemarketers
                </button>
                <button onClick={cancelCampaign} disabled={cancelling} style={{ ...btnSecondary, width: '100%', justifyContent: 'center', gap: 6, color: RED, borderColor: `${RED}40`, opacity: cancelling ? .7 : 1 }}>
                  {cancelling ? 'Cancelling…' : 'Cancel Campaign'}
                </button>
              </div>
            </SectionCard>
          )}

          {hasSendData && m && (
            <SectionCard title="Send Summary" padding>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: TEXT.sm }}>
                {([
                  ['Sent', fmtNum(toN(m.sent))], ['Delivered', fmtNum(toN(m.delivered))],
                  ...(isEmail ? [['Opened', fmtNum(toN(m.opened))], ['Clicked', fmtNum(toN(m.clicked))], ['Bounced', fmtNum(toN(m.bounced))], ['Unsubscribed', fmtNum(toN(m.unsubscribed))]] : [['Failed', fmtNum(toN(m.failed))]]),
                ] as [string, string][]).map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--txt2)' }}>{label}</span>
                    <span style={{ ...NUM, fontWeight: FW.semibold }}>{value}</span>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}
        </div>
      </div>

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
