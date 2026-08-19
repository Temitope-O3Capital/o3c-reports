import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, Spinner, ErrBanner, Modal } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtNum, fmtDatetime } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, NUM, INTER, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'

// Inbound Calls.
//
// Inbound was the module's blind spot: 53% of inbound calls went unanswered and not one
// of 3,226 had ever been linked to a ticket or a follow-up. Over 30 days, 613 were
// missed and only 185 got a return call — 428 people rang and heard nothing back.
//
// "Outstanding" is the number that matters here: missed, not returned within 48h, and
// not already sitting in the call-back queue. Everything else on this page is context.

interface InboundCall {
  id: number
  started_at: string
  customer_phone: string
  customer_name: string | null
  customer_cif: string | null
  outcome: string
  duration_sec: number
  agent_name: string | null
  returned: boolean          // an outbound call to this number followed within 48h
  queued: boolean            // a support call-back is already waiting in the queue
  matched_customer: string | null
}

interface InboundSummary {
  total: number
  missed: number
  answered: number
  outstanding: number
  answer_rate_pct: number | null
}

type Filter = 'outstanding' | 'missed' | 'answered' | 'all'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'outstanding', label: 'Needs Call-back' },
  { key: 'missed',      label: 'Missed' },
  { key: 'answered',    label: 'Answered' },
  { key: 'all',         label: 'All' },
]

function Stat({ label, value, color, hint }: { label: string; value: string; color: string; hint?: string }) {
  return (
    <div style={{
      flex: 1, padding: '12px 14px', borderRadius: RADIUS.md,
      background: `${color}0f`, border: `1px solid ${color}28`,
    }}>
      <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', marginTop: 4, fontWeight: FW.medium }}>{label}</div>
      {hint && <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 2 }}>{hint}</div>}
    </div>
  )
}

function StatusBadge({ call }: { call: InboundCall }) {
  const answered = call.outcome === 'completed'
  if (answered) {
    return <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: GREEN, background: `${GREEN}18`, padding: '2px 8px', borderRadius: RADIUS.full }}>Answered</span>
  }
  if (call.returned) {
    return <span title="An outbound call to this number followed within 48 hours" style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: BLUE, background: `${BLUE}18`, padding: '2px 8px', borderRadius: RADIUS.full }}>Returned</span>
  }
  if (call.queued) {
    return <span title="A call-back is waiting in the outbound queue" style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: AMBER, background: `${AMBER}18`, padding: '2px 8px', borderRadius: RADIUS.full }}>Queued</span>
  }
  return <span title="Missed, never returned, not queued" style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: '#fff', background: RED, padding: '2px 8px', borderRadius: RADIUS.full }}>Owed a call</span>
}

export default function CallCenterInbound() {
  const navigate = useNavigate()
  const [calls, setCalls] = useState<InboundCall[]>([])
  const [summary, setSummary] = useState<InboundSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('outstanding')
  const [days, setDays] = useState(7)
  const [queueing, setQueueing] = useState(false)
  const [ticketFor, setTicketFor] = useState<InboundCall | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    const params = new URLSearchParams({ days: String(days) })
    if (filter === 'outstanding') params.set('outstanding', '1')
    else if (filter !== 'all') params.set('status', filter)
    try {
      const r = await apiFetch<{ data: InboundCall[]; summary: InboundSummary }>(`/api/call-center/inbound?${params}`)
      setCalls(r.data ?? [])
      setSummary(r.summary ?? null)
    } catch (e: any) { setErr(e.message ?? 'Failed to load inbound calls') }
    finally { setLoading(false) }
  }, [filter, days])

  useEffect(() => { load() }, [load])

  async function queueCallbacks() {
    setQueueing(true)
    try {
      const r = await apiPost<{ queued: number }>(`/api/call-center/inbound/queue-callbacks?days=${days}`, {})
      const n = r?.queued ?? 0
      toast.success(n === 0
        ? 'Nothing to queue: every missed call has been returned or is already queued'
        : `${fmtNum(n)} call-back${n === 1 ? '' : 's'} added to the outbound queue`)
      await load()
    } catch (e: any) { toast.error(e?.message || 'Could not queue call-backs') }
    finally { setQueueing(false) }
  }

  const outstanding = summary?.outstanding ?? 0

  return (
    <Page
      title="Inbound Calls"
      subtitle="Who rang us, who we answered, and who is still owed a call back"
    >
      <ErrBanner error={err} onRetry={load} />

      {/* Health strip */}
      <div style={{ display: 'flex', gap: SP[2], marginBottom: SP[4] }}>
        <Stat label="Inbound calls" value={fmtNum(summary?.total ?? 0)} color={NAVY} hint={`last ${days} days`} />
        <Stat label="Answered" value={fmtNum(summary?.answered ?? 0)} color={GREEN}
              hint={summary?.answer_rate_pct != null ? `${summary.answer_rate_pct}% answer rate` : undefined} />
        <Stat label="Missed" value={fmtNum(summary?.missed ?? 0)} color={AMBER} />
        <Stat label="Owed a call back" value={fmtNum(outstanding)} color={outstanding > 0 ? RED : GREEN}
              hint="missed, not returned, not queued" />
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: SP[3], flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 3, background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: 3 }}>
          {FILTERS.map(f => {
            const on = filter === f.key
            return (
              <button key={f.key} onClick={() => setFilter(f.key)} style={{
                padding: '5px 12px', borderRadius: RADIUS.sm, border: 'none', cursor: 'pointer',
                fontSize: TEXT.xs, fontWeight: FW.bold,
                background: on ? 'var(--card)' : 'transparent',
                color: on ? NAVY : 'var(--txt2)',
                boxShadow: on ? '0 1px 2px rgba(0,0,0,.10)' : 'none',
              }}>{f.label}</button>
            )
          })}
        </div>

        <select
          value={days}
          onChange={e => setDays(Number(e.target.value))}
          style={{ padding: '6px 8px', borderRadius: RADIUS.sm, border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', color: 'var(--txt)', fontSize: TEXT.sm }}
        >
          {[1, 7, 14, 30, 90].map(d => <option key={d} value={d}>Last {d} day{d === 1 ? '' : 's'}</option>)}
        </select>

        <button
          onClick={queueCallbacks}
          disabled={queueing || outstanding === 0}
          title={outstanding === 0 ? 'Nothing outstanding to queue' : 'Add a High-priority support call-back for each unreturned missed call'}
          style={{
            marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 14px', borderRadius: RADIUS.md, border: 'none',
            background: outstanding === 0 ? 'var(--chip-bg)' : NAVY,
            color: outstanding === 0 ? 'var(--txt3)' : '#fff',
            fontSize: TEXT.sm, fontWeight: FW.bold,
            cursor: queueing || outstanding === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          {queueing ? <Spinner size={13} color="#fff" /> : <span className="material-symbols-rounded" style={{ fontSize: 16 }}>phone_forwarded</span>}
          Queue {outstanding > 0 ? fmtNum(outstanding) : ''} call-back{outstanding === 1 ? '' : 's'}
        </button>
      </div>

      <SectionCard
        title={FILTERS.find(f => f.key === filter)?.label ?? 'Inbound'}
        subtitle="A missed call counts as returned once an outbound call reaches the same number within 48 hours"
      >
        {loading && calls.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={26} /></div>
        ) : calls.length === 0 ? (
          <div style={{ padding: '34px 0', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
            {filter === 'outstanding'
              ? 'Every missed call has been returned or queued.'
              : 'No inbound calls in this window.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.sm }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--txt3)', fontSize: TEXT.xs }}>
                  <th style={{ padding: '7px 8px', fontWeight: FW.semibold }}>Caller</th>
                  <th style={{ padding: '7px 8px', fontWeight: FW.semibold }}>When</th>
                  <th style={{ padding: '7px 8px', fontWeight: FW.semibold }}>Status</th>
                  <th style={{ padding: '7px 8px', fontWeight: FW.semibold }}>Handled by</th>
                  <th style={{ padding: '7px 8px', fontWeight: FW.semibold, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {calls.map(c => (
                  <tr key={c.id} style={{ borderTop: '1px solid var(--bdr)' }}>
                    <td style={{ padding: '8px' }}>
                      <div style={{ fontWeight: FW.semibold, color: 'var(--txt)' }}>
                        {c.matched_customer || c.customer_name || 'Unknown caller'}
                      </div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>
                        {c.customer_phone || '—'}
                        {c.customer_cif && <span style={{ marginLeft: 6, color: BLUE }}>CIF {c.customer_cif}</span>}
                      </div>
                    </td>
                    <td style={{ padding: '8px', color: 'var(--txt2)', fontFamily: INTER, fontSize: TEXT.xs, whiteSpace: 'nowrap' }}>
                      {fmtDatetime(c.started_at)}
                    </td>
                    <td style={{ padding: '8px' }}><StatusBadge call={c} /></td>
                    <td style={{ padding: '8px', color: 'var(--txt2)', fontSize: TEXT.xs }}>
                      {c.agent_name || <span style={{ color: 'var(--txt3)' }}>—</span>}
                      {c.outcome === 'completed' && c.duration_sec > 0 && (
                        <span style={{ ...NUM, color: 'var(--txt3)', marginLeft: 6 }}>
                          {Math.floor(c.duration_sec / 60)}m {c.duration_sec % 60}s
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        onClick={() => setTicketFor(c)}
                        style={{
                          fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '3px 9px',
                          borderRadius: RADIUS.full, border: '1px solid var(--bdr)',
                          background: 'transparent', color: 'var(--txt2)', cursor: 'pointer',
                        }}
                      >Raise ticket</button>
                      {c.customer_cif && (
                        <button
                          onClick={() => navigate(`/customers/${c.customer_cif}`)}
                          style={{
                            marginLeft: 6, fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '3px 9px',
                            borderRadius: RADIUS.full, border: '1px solid var(--bdr)',
                            background: 'transparent', color: BLUE, cursor: 'pointer',
                          }}
                        >View 360</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <RaiseTicketModal call={ticketFor} onClose={() => setTicketFor(null)} onDone={load} />
    </Page>
  )
}

function RaiseTicketModal({ call, onClose, onDone }: {
  call: InboundCall | null; onClose: () => void; onDone: () => void
}) {
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (call) {
      setSubject(`Inbound call — ${call.matched_customer || call.customer_name || call.customer_phone || 'unknown caller'}`)
      setBody('')
    }
  }, [call])

  async function submit() {
    if (!call) return
    setSaving(true)
    try {
      const r = await apiPost<{ ticket_id: number }>(`/api/call-center/inbound/${call.id}/ticket`, { subject, body })
      toast.success(`Ticket #${r.ticket_id} raised and linked to the call`)
      onClose()
      onDone()
    } catch (e: any) { toast.error(e?.message || 'Could not raise ticket') }
    finally { setSaving(false) }
  }

  const field: React.CSSProperties = {
    width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)',
    borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)',
    color: 'var(--txt)', fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box',
  }

  return (
    <Modal open={!!call} onClose={onClose} title="Raise a ticket from this call" width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        <div>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Subject</label>
          <input value={subject} onChange={e => setSubject(e.target.value)} style={field} />
        </div>
        <div>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>What did they call about?</label>
          <textarea
            spellCheck={false} rows={4} value={body} onChange={e => setBody(e.target.value)}
            placeholder="Optional: context for whoever picks this up"
            style={{ ...field, resize: 'vertical' }}
          />
        </div>
        <button
          onClick={submit}
          disabled={saving || !subject.trim()}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            padding: '10px 0', background: saving || !subject.trim() ? `${NAVY}80` : NAVY,
            color: '#fff', border: 'none', borderRadius: RADIUS.md,
            fontSize: TEXT.md, fontWeight: FW.bold,
            cursor: saving || !subject.trim() ? 'not-allowed' : 'pointer', width: '100%',
          }}
        >
          {saving ? <Spinner size={14} color="#fff" /> : <span className="material-symbols-rounded" style={{ fontSize: 18 }}>confirmation_number</span>}
          {saving ? 'Raising…' : 'Raise ticket'}
        </button>
      </div>
    </Modal>
  )
}
