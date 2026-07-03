import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Page, SectionCard, ErrBanner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, RED, NUM, INTER } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface MailMessage {
  id:                  number
  kind:                string
  related_type:        string | null
  related_id:          number | null
  subject:             string | null
  from_email:          string | null
  from_name:           string | null
  recipients:          any
  status:              string
  provider_message_id: string | null
  queued_at:           string | null
  delivered_at:        string | null
  opened_at:           string | null
  clicked_at:          string | null
  bounced_at:          string | null
  last_error:          string | null
  created_at:          string
  updated_at:          string
  html_body:           string | null
  text_body:           string | null
  thread_id:           string | null
  parent_id:           number | null
  send_at:             string | null
  attachments:         any
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  delivered: GREEN,
  opened:    '#10B981',
  clicked:   GREEN,
  sent:      NAVY,
  queued:    '#6B7280',
  processing: AMBER,
  failed:    RED,
  bounced:   RED,
  spam_report: RED,
  unsubscribed: AMBER,
}

function StatusPill({ status }: { status: string }) {
  const c = STATUS_COLOR[status] ?? '#6B7280'
  const label = status.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
  return (
    <span style={{ ...NUM, fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20, background: `${c}14`, color: c }}>
      {label}
    </span>
  )
}

function MetaRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null
  return (
    <div style={{ display: 'flex', gap: 12, fontSize: 12.5 }}>
      <span style={{ color: 'var(--txt3)', minWidth: 80, flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--txt)', fontWeight: 500 }}>{value}</span>
    </div>
  )
}

function recipientList(recipients: any): string {
  if (!recipients) return '—'
  if (Array.isArray(recipients)) {
    return recipients.map((r: any) => {
      if (typeof r === 'string') return r
      return r.Name ? `${r.Name} <${r.Email}>` : r.Email
    }).join(', ')
  }
  if (typeof recipients === 'string') return recipients
  return JSON.stringify(recipients)
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function MailThreadDetail() {
  const { id }   = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [msg, setMsg]     = useState<MailMessage | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]     = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true); setErr(null)
    try {
      const res = await apiFetch<MailMessage>(`/api/mail/messages/${id}`)
      setMsg(res)
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])

  const m = msg

  const subtitle = m
    ? `${m.kind.charAt(0).toUpperCase() + m.kind.slice(1)} · ${m.status}`
    : 'Loading…'

  return (
    <Page
      title={m?.subject ?? 'Message'}
      subtitle={subtitle}
      actions={
        <button
          onClick={() => navigate('/mail/inbox')}
          style={{
            padding: '7px 14px', borderRadius: 8, border: '1px solid var(--bdr)',
            background: 'var(--card)', color: 'var(--txt)', fontSize: 13,
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
            fontFamily: INTER,
          }}>
          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>arrow_back</span>
          Mail
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {!loading && m && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 860 }}>
          {/* Header card */}
          <SectionCard title="Message Details">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <StatusPill status={m.status} />
                {m.delivered_at && (
                  <span style={{ fontSize: 12, color: GREEN }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 13, verticalAlign: 'middle' }}>check_circle</span>
                    {' '}Delivered {fmtDatetime(m.delivered_at)}
                  </span>
                )}
                {m.opened_at && (
                  <span style={{ fontSize: 12, color: '#10B981' }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 13, verticalAlign: 'middle' }}>mail_open</span>
                    {' '}Opened {fmtDatetime(m.opened_at)}
                  </span>
                )}
                {m.clicked_at && (
                  <span style={{ fontSize: 12, color: NAVY }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 13, verticalAlign: 'middle' }}>touch_app</span>
                    {' '}Clicked {fmtDatetime(m.clicked_at)}
                  </span>
                )}
              </div>

              <MetaRow label="From"    value={m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email} />
              <MetaRow label="To"      value={recipientList(m.recipients)} />
              <MetaRow label="Subject" value={m.subject} />
              <MetaRow label="Sent"    value={m.created_at ? fmtDatetime(m.created_at) : null} />
              {m.last_error && <MetaRow label="Error" value={m.last_error} />}
            </div>
          </SectionCard>

          {/* Body */}
          {(m.text_body || m.html_body) && (
            <SectionCard title="Message Body">
              {m.html_body ? (
                <div
                  style={{ fontSize: 13.5, lineHeight: 1.7, color: 'var(--txt)', fontFamily: INTER }}
                  dangerouslySetInnerHTML={{ __html: m.html_body }}
                />
              ) : (
                <pre style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--txt)', fontFamily: INTER, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
                  {m.text_body}
                </pre>
              )}
            </SectionCard>
          )}

          {/* Delivery timeline */}
          <SectionCard title="Delivery Timeline">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { label: 'Queued',    time: m.queued_at,    color: '#6B7280' },
                { label: 'Delivered', time: m.delivered_at, color: GREEN },
                { label: 'Opened',    time: m.opened_at,    color: '#10B981' },
                { label: 'Clicked',   time: m.clicked_at,   color: NAVY },
                { label: 'Bounced',   time: m.bounced_at,   color: RED },
              ].map(e => (
                <div key={e.label} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: e.time ? e.color : 'var(--bdr)',
                  }} />
                  <span style={{ fontSize: 12.5, color: e.time ? 'var(--txt)' : 'var(--txt3)', fontWeight: e.time ? 600 : 400, minWidth: 80 }}>
                    {e.label}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--txt3)', ...NUM }}>
                    {e.time ? fmtDatetime(e.time) : '—'}
                  </span>
                </div>
              ))}
            </div>
          </SectionCard>
        </div>
      )}

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--txt3)', fontSize: 13 }}>
          Loading message…
        </div>
      )}
    </Page>
  )
}
