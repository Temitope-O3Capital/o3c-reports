import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, DataTable, ErrBanner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { NAVY, GREEN, NUM, INTER } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface InboundMessage {
  id:                  number
  mail_message_id:     number | null
  from_email:          string
  from_name:           string | null
  to_email:            string | null
  subject:             string | null
  body_text:           string | null
  body_html:           string | null
  is_read:             boolean
  received_at:         string
  original_subject:    string | null
  original_from_email: string | null
}

interface SentMessage {
  id:          number
  kind:        string
  subject:     string | null
  from_email:  string | null
  from_name:   string | null
  recipients:  any
  status:      string
  created_at:  string
  delivered_at: string | null
  opened_at:   string | null
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  delivered: GREEN,
  opened:    '#10B981',
  clicked:   GREEN,
  sent:      NAVY,
  queued:    '#6B7280',
  failed:    '#EF4444',
  bounced:   '#EF4444',
}

function StatusPill({ status }: { status: string }) {
  const c = STATUS_COLOR[status] ?? '#6B7280'
  const label = status.charAt(0).toUpperCase() + status.slice(1)
  return (
    <span style={{ ...NUM, fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: `${c}14`, color: c }}>
      {label}
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

type Tab = 'inbox' | 'sent'

export default function MailInbox() {
  const navigate = useNavigate()
  const [tab, setTab]           = useState<Tab>('inbox')
  const [inbox, setInbox]       = useState<InboundMessage[]>([])
  const [sent, setSent]         = useState<SentMessage[]>([])
  const [loading, setLoading]   = useState(true)
  const [err, setErr]           = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      if (tab === 'inbox') {
        const res = await apiFetch<InboundMessage[]>('/api/mail/inbox')
        setInbox(Array.isArray(res) ? res : [])
      } else {
        const res = await apiFetch<SentMessage[]>('/api/mail/messages')
        setSent(Array.isArray(res) ? res : [])
      }
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [tab])

  useEffect(() => { load() }, [load])

  const inboxCols: TableCol<InboundMessage>[] = [
    {
      key: 'from_email', label: 'From',
      render: r => (
        <div>
          <div style={{ fontSize: 13, fontWeight: r.is_read ? 400 : 700, color: 'var(--txt)' }}>
            {r.from_name ?? r.from_email}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--txt3)' }}>{r.from_email}</div>
        </div>
      ),
    },
    {
      key: 'subject', label: 'Subject',
      render: r => (
        <div>
          <div style={{ fontSize: 13, fontWeight: r.is_read ? 400 : 600, color: 'var(--txt)' }}>
            {r.subject ?? '(no subject)'}
          </div>
          {r.body_text && (
            <div style={{ fontSize: 11.5, color: 'var(--txt3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }}>
              {r.body_text.slice(0, 120)}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'received_at', label: 'Received', align: 'right',
      render: r => (
        <span style={{ fontSize: 12, color: 'var(--txt3)', ...NUM }}>
          {fmtDatetime(r.received_at)}
        </span>
      ),
    },
  ]

  const sentCols: TableCol<SentMessage>[] = [
    {
      key: 'subject', label: 'Subject',
      render: r => (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.subject ?? '(no subject)'}</div>
          {r.from_name && <div style={{ fontSize: 11.5, color: 'var(--txt3)' }}>From: {r.from_name}</div>}
        </div>
      ),
    },
    {
      key: 'status', label: 'Status',
      render: r => <StatusPill status={r.status} />,
    },
    {
      key: 'delivered_at', label: 'Delivered',
      render: r => <span style={{ fontSize: 12, color: 'var(--txt3)' }}>{r.delivered_at ? fmtDatetime(r.delivered_at) : '—'}</span>,
    },
    {
      key: 'opened_at', label: 'Opened',
      render: r => <span style={{ fontSize: 12, color: r.opened_at ? GREEN : 'var(--txt3)' }}>{r.opened_at ? fmtDatetime(r.opened_at) : '—'}</span>,
    },
    {
      key: 'created_at', label: 'Sent At', align: 'right',
      render: r => <span style={{ fontSize: 12, color: 'var(--txt3)', ...NUM }}>{fmtDatetime(r.created_at)}</span>,
    },
  ]

  const TAB_STYLE = (active: boolean) => ({
    padding: '6px 18px', borderRadius: 8, border: 'none',
    fontSize: 13, fontWeight: 600, cursor: 'pointer',
    background: active ? NAVY : 'transparent',
    color: active ? '#fff' : 'var(--txt2)',
    fontFamily: INTER,
  })

  return (
    <Page
      title="Mail"
      subtitle="Inbox and sent messages"
      actions={
        <button
          onClick={() => navigate('/mail/compose')}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '7px 16px', borderRadius: 8, border: 'none',
            background: NAVY, color: '#fff', fontSize: 13,
            fontWeight: 600, cursor: 'pointer', fontFamily: INTER,
          }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>edit</span>
          Compose
        </button>
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, background: 'var(--th-bg)', padding: 4, borderRadius: 10, width: 'fit-content' }}>
        <button style={TAB_STYLE(tab === 'inbox')} onClick={() => setTab('inbox')}>
          <span className="material-symbols-rounded" style={{ fontSize: 14, verticalAlign: 'middle', marginRight: 4 }}>inbox</span>
          Inbox
        </button>
        <button style={TAB_STYLE(tab === 'sent')} onClick={() => setTab('sent')}>
          <span className="material-symbols-rounded" style={{ fontSize: 14, verticalAlign: 'middle', marginRight: 4 }}>send</span>
          Sent
        </button>
      </div>

      {tab === 'inbox' ? (
        <SectionCard title="Inbox" badge={inbox.length} padding={false}>
          <DataTable<InboundMessage>
            cols={inboxCols}
            rows={inbox}
            keyFn={r => r.id}
            emptyText={loading ? '' : 'Your inbox is empty.'}
            skeletonRows={loading ? 8 : 0}
            onRowClick={r => {
              if (r.mail_message_id) navigate(`/mail/${r.mail_message_id}`)
            }}
          />
        </SectionCard>
      ) : (
        <SectionCard title="Sent" badge={sent.length} padding={false}>
          <DataTable<SentMessage>
            cols={sentCols}
            rows={sent}
            keyFn={r => r.id}
            emptyText={loading ? '' : 'No sent messages.'}
            skeletonRows={loading ? 8 : 0}
            onRowClick={r => navigate(`/mail/${r.id}`)}
          />
        </SectionCard>
      )}
    </Page>
  )
}
