import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, Spinner, ErrBanner, Modal, DataTable, DateFilter } from '../../components/UI'
import type { TableCol, FilterDef } from '../../components/UI'
import LogCallModal from '../../components/LogCallModal'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtNum, fmtDatetime } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, NUM, INTER, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'

// Dial a number through the WebRTC softphone (CallWidget listens for 'o3c:dial').
// This is what makes "Call back" work from the inbound list — the widget expands and
// starts the call. The outbound call it places lands in the same helpdesk_calls ledger,
// so it counts as the return call for this missed inbound.
function dialNumber(phone: string) {
  const n = (phone || '').trim()
  if (!n) { toast.error('No number to call back'); return }
  window.dispatchEvent(new CustomEvent('o3c:dial', { detail: { phoneNumber: n, autoStart: true } }))
}

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
  // Provider-neutral telephony facts (Zoho today, our own telephony later)
  wait_sec: number | null        // ring/wait before answer, or before the caller hung up
  answered_at: string | null
  abandoned: boolean             // caller hung up before any agent answered
  disconnected_by: string | null // 'agent' | 'caller' | 'system'
  queue_name: string | null      // the ring group / queue the call came through
  ring_legs: number              // how many agents it rang (0 = no ring detail captured)
}

// One agent's turn in a queued call's ring sequence (GET /inbound/{id}/ring-legs).
interface RingLeg {
  position: number
  agent_name: string | null
  agent_full_name: string | null
  rang_at: string | null
  ring_sec: number | null
  outcome: string | null
}

interface InboundSummary {
  total: number
  missed: number
  answered: number
  outstanding: number
  answer_rate_pct: number | null
  abandoned: number
  avg_wait_sec: number | null
}

// Default date window: the last 7 days (YYYY-MM-DD, local).
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const TODAY = ymd(new Date())
const WEEK_AGO = ymd(new Date(Date.now() - 6 * 864e5))

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
  if (call.abandoned) {
    return <span title="Caller hung up before any agent answered" style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: '#fff', background: RED, padding: '2px 8px', borderRadius: RADIUS.full }}>Abandoned</span>
  }
  return <span title="Missed, never returned, not queued" style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: '#fff', background: RED, padding: '2px 8px', borderRadius: RADIUS.full }}>Owed a call</span>
}

// The one-word status for a call — matches StatusBadge, and drives the Status filter
// and free-text search in the table.
function statusLabel(c: InboundCall): string {
  if (c.outcome === 'completed') return 'Answered'
  if (c.returned) return 'Returned'
  if (c.queued) return 'Queued'
  if (c.abandoned) return 'Abandoned'
  return 'Owed a call'
}

// Compact "1m 04s" / "12s" from seconds.
function fmtWait(s: number | null): string {
  if (s == null) return '—'
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

const LEG_COLOR: Record<string, string> = {
  answered: GREEN, missed: RED, no_answer: AMBER, rejected: '#C00000', moved_on: 'var(--txt3)', cancelled: 'var(--txt3)',
}

function fmtDur(s: number): string {
  if (!s) return '0s'
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

// One step in the call-flow timeline: a coloured dot, a title, and optional detail.
function FlowStep({ color, title, detail, last }: { color: string; title: React.ReactNode; detail?: React.ReactNode; last?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', alignSelf: 'stretch' }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0, marginTop: 3 }} />
        {!last && <span style={{ flex: 1, width: 2, background: 'var(--bdr)', marginTop: 2 }} />}
      </div>
      <div style={{ paddingBottom: last ? 0 : 10, minWidth: 0 }}>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{title}</div>
        {detail && <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 1 }}>{detail}</div>}
      </div>
    </div>
  )
}

// The end-to-end flow of ONE inbound call: received -> rang across the queue -> answered
// / abandoned / missed -> who ended it -> what follow-up exists. Built from the neutral
// telephony fields, so it reads the same once O3 is off Zoho.
function CallFlow({ call, legs, loading }: { call: InboundCall; legs: RingLeg[] | undefined; loading: boolean }) {
  const answered = call.outcome === 'completed'
  const caller = call.matched_customer || call.customer_name || 'Unknown caller'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 4, maxWidth: 640 }}>
      {/* 1. Received */}
      <FlowStep
        color={NAVY}
        title={<>Call received{call.queue_name ? <> · via <b>{call.queue_name}</b> queue</> : ''}</>}
        detail={<span style={{ fontFamily: INTER }}>{caller} · {call.customer_phone || 'no number'} · {fmtDatetime(call.started_at)}</span>}
      />

      {/* 2. Ring sequence across the queue */}
      {loading ? (
        <FlowStep color="var(--txt3)" title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Spinner size={12} /> Loading ring detail…</span>} />
      ) : legs && legs.length > 0 ? (
        <FlowStep
          color={BLUE}
          title={<>Rang {legs.length} agent{legs.length === 1 ? '' : 's'} in the queue</>}
          detail={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 3 }}>
              {legs.map(leg => {
                const oc = (leg.outcome || '').toLowerCase()
                const col = LEG_COLOR[oc] ?? 'var(--txt3)'
                return (
                  <div key={leg.position} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ ...NUM, color: 'var(--txt3)', width: 16, textAlign: 'right' }}>{leg.position}.</span>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: col, flexShrink: 0 }} />
                    <span style={{ fontWeight: FW.semibold, color: 'var(--txt)', minWidth: 150 }}>{leg.agent_full_name || leg.agent_name || 'Agent'}</span>
                    <span style={{ color: col, fontWeight: FW.semibold, textTransform: 'capitalize' }}>{(leg.outcome || '—').replace(/_/g, ' ')}</span>
                    {leg.ring_sec != null && <span style={{ ...NUM, color: 'var(--txt3)' }}>rang {fmtWait(leg.ring_sec)}</span>}
                  </div>
                )
              })}
            </div>
          }
        />
      ) : call.wait_sec != null ? (
        <FlowStep color={BLUE} title={<>On the line for {fmtWait(call.wait_sec)}</>}
          detail={<span style={{ color: 'var(--txt3)' }}>Per-agent ring detail isn't available for this call.</span>} />
      ) : (
        <FlowStep color="var(--txt3)" title="No ring detail captured" />
      )}

      {/* 3. Outcome */}
      {answered ? (
        <FlowStep color={GREEN}
          title={<>Answered{call.agent_name ? <> by <b>{call.agent_name}</b></> : ''}</>}
          detail={<>{call.wait_sec != null ? `after ${fmtWait(call.wait_sec)} on the line · ` : ''}talked {fmtDur(call.duration_sec)}</>}
        />
      ) : call.abandoned ? (
        <FlowStep color={RED}
          title="Caller hung up before anyone answered"
          detail={call.wait_sec != null ? `waited ${fmtWait(call.wait_sec)}, then abandoned` : 'abandoned'}
        />
      ) : (
        <FlowStep color={RED}
          title="Missed — no agent answered"
          detail={call.wait_sec != null ? `rang ${fmtWait(call.wait_sec)}` : undefined}
        />
      )}

      {/* 4. Who ended it (only when known and it adds something) */}
      {call.disconnected_by && (
        <FlowStep color="var(--txt3)"
          title={<span style={{ textTransform: 'capitalize' }}>{call.disconnected_by} ended the call</span>} />
      )}

      {/* 5. Follow-up */}
      <FlowStep
        last
        color={call.returned || call.queued ? GREEN : answered ? GREEN : 'var(--txt3)'}
        title={
          call.returned ? 'Returned — an outbound call reached this number within 48h'
          : call.queued ? 'Call-back queued in the outbound list'
          : answered ? 'Handled on the call'
          : 'No follow-up yet'
        }
      />
    </div>
  )
}

export default function CallCenterInbound() {
  const navigate = useNavigate()
  const [calls, setCalls] = useState<InboundCall[]>([])
  const [summary, setSummary] = useState<InboundSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [dateFrom, setDateFrom] = useState(WEEK_AGO)
  const [dateTo, setDateTo] = useState(TODAY)
  const [queueing, setQueueing] = useState(false)
  const [ticketFor, setTicketFor] = useState<InboundCall | null>(null)
  const [logFor, setLogFor] = useState<InboundCall | null>(null)
  // Call-flow modal: the call whose flow is open, plus a per-call cache of its ring legs.
  const [flowFor, setFlowFor] = useState<InboundCall | null>(null)
  const [legsCache, setLegsCache] = useState<Record<number, RingLeg[]>>({})
  const [legsLoading, setLegsLoading] = useState<number | null>(null)

  async function openFlow(c: InboundCall) {
    setFlowFor(c)
    if (!legsCache[c.id]) {
      setLegsLoading(c.id)
      try {
        const r = await apiFetch<{ legs: RingLeg[] }>(`/api/call-center/inbound/${c.id}/ring-legs`)
        setLegsCache(m => ({ ...m, [c.id]: r.legs ?? [] }))
      } catch { setLegsCache(m => ({ ...m, [c.id]: [] })) }
      finally { setLegsLoading(null) }
    }
  }

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    const params = new URLSearchParams({ from: dateFrom, to: dateTo })
    try {
      const r = await apiFetch<{ data: InboundCall[]; summary: InboundSummary }>(`/api/call-center/inbound?${params}`)
      setCalls(r.data ?? [])
      setSummary(r.summary ?? null)
    } catch (e: any) { setErr(e.message ?? 'Failed to load inbound calls') }
    finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  async function queueCallbacks() {
    setQueueing(true)
    try {
      const r = await apiPost<{ queued: number }>(`/api/call-center/inbound/queue-callbacks?from=${dateFrom}&to=${dateTo}`, {})
      const n = r?.queued ?? 0
      toast.success(n === 0
        ? 'Nothing to queue: every missed call has been returned or is already queued'
        : `${fmtNum(n)} call-back${n === 1 ? '' : 's'} added to the outbound queue`)
      await load()
    } catch (e: any) { toast.error(e?.message || 'Could not queue call-backs') }
    finally { setQueueing(false) }
  }

  const outstanding = summary?.outstanding ?? 0

  // Augment each row with its one-word status so the table can search + filter on it.
  type Row = InboundCall & { _status: string }
  const rows: Row[] = useMemo(() => calls.map(c => ({ ...c, _status: statusLabel(c) })), [calls])

  const STATUS_CHIP: Record<string, { bg: string; txt: string }> = {
    Answered:      { bg: `${GREEN}18`, txt: GREEN },
    Returned:      { bg: `${BLUE}18`,  txt: BLUE },
    Queued:        { bg: `${AMBER}18`, txt: AMBER },
    Abandoned:     { bg: RED,          txt: '#fff' },
    'Owed a call': { bg: RED,          txt: '#fff' },
  }

  const cols: TableCol<Row>[] = useMemo(() => [
    {
      key: 'caller', label: 'Caller', sortable: false,
      render: (c) => (
        <div>
          <div style={{ fontWeight: FW.semibold, color: 'var(--txt)' }}>
            {c.matched_customer || c.customer_name || 'Unknown caller'}
          </div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>
            {c.customer_phone || '—'}
            {c.customer_cif && <span style={{ marginLeft: 6, color: BLUE }}>CIF {c.customer_cif}</span>}
          </div>
        </div>
      ),
    },
    {
      key: 'started_at', label: 'When', sortable: true,
      render: (c) => (
        <span style={{ color: 'var(--txt2)', fontFamily: INTER, fontSize: TEXT.xs, whiteSpace: 'nowrap' }}>
          {fmtDatetime(c.started_at)}
        </span>
      ),
    },
    {
      key: 'ring_legs', label: 'Ring / wait', sortable: true,
      render: (c) => (
        <div style={{ fontSize: TEXT.xs }}>
          {c.ring_legs > 0
            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: BLUE, fontWeight: FW.semibold }}>
                <span className="material-symbols-rounded" style={{ fontSize: 12 }}>graphic_eq</span>
                rang {c.ring_legs} agent{c.ring_legs === 1 ? '' : 's'}
              </span>
            : <span style={{ color: 'var(--txt3)' }}>—</span>}
          {c.wait_sec != null && (
            <div style={{ ...NUM, fontSize: TEXT['2xs'], color: c.abandoned ? RED : 'var(--txt3)' }}>
              waited {fmtWait(c.wait_sec)}
            </div>
          )}
        </div>
      ),
    },
    { key: '_status', label: 'Status', sortable: true, render: (c) => <StatusBadge call={c} /> },
    {
      key: 'agent_name', label: 'Handled by', sortable: true,
      render: (c) => (
        <span style={{ color: 'var(--txt2)', fontSize: TEXT.xs }}>
          {c.agent_name || <span style={{ color: 'var(--txt3)' }}>—</span>}
          {c.outcome === 'completed' && c.duration_sec > 0 && (
            <span style={{ ...NUM, color: 'var(--txt3)', marginLeft: 6 }}>
              {Math.floor(c.duration_sec / 60)}m {c.duration_sec % 60}s
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'actions', label: 'Actions', align: 'right', sortable: false,
      render: (c) => (
        <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button
            onClick={() => openFlow(c)}
            title="See the queue and full call flow"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '3px 9px',
              borderRadius: RADIUS.full, border: '1px solid var(--bdr)',
              background: 'transparent', color: 'var(--txt2)', cursor: 'pointer',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 13 }}>account_tree</span>
            Flow
          </button>
          <button
            onClick={() => dialNumber(c.customer_phone)}
            disabled={!c.customer_phone}
            title={c.customer_phone ? 'Call this number back now' : 'No number to dial'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '3px 9px',
              borderRadius: RADIUS.full, border: 'none',
              background: c.customer_phone ? NAVY : 'var(--chip-bg)',
              color: c.customer_phone ? '#fff' : 'var(--txt3)',
              cursor: c.customer_phone ? 'pointer' : 'not-allowed',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 13 }}>call</span>
            Call back
          </button>
          <button
            onClick={() => setLogFor(c)}
            title="Write up this call — disposition, notes, and link it to the customer"
            style={{
              fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '3px 9px',
              borderRadius: RADIUS.full, border: '1px solid var(--bdr)',
              background: 'transparent', color: 'var(--txt2)', cursor: 'pointer',
            }}
          >Log call</button>
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
                fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '3px 9px',
                borderRadius: RADIUS.full, border: '1px solid var(--bdr)',
                background: 'transparent', color: BLUE, cursor: 'pointer',
              }}
            >View 360</button>
          )}
        </div>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [])

  const tableFilters: FilterDef<Row>[] = [
    { key: '_status', label: 'Status', chipStyle: (v) => STATUS_CHIP[v] ?? { bg: 'var(--chip-bg)', txt: 'var(--txt2)' } },
    { key: 'agent_name', label: 'Handled by' },
  ]

  return (
    <Page
      title="Inbound Calls"
      subtitle="Who rang us, who we answered, and who is still owed a call back"
      loading={loading && !summary}
      skeletonKpis={6}
      actions={<DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />}
    >
      <ErrBanner error={err} onRetry={load} />

      {/* Health strip */}
      <div style={{ display: 'flex', gap: SP[2], marginBottom: SP[4], flexWrap: 'wrap' }}>
        <Stat label="Inbound calls" value={fmtNum(summary?.total ?? 0)} color={NAVY} hint="in the selected range" />
        <Stat label="Answered" value={fmtNum(summary?.answered ?? 0)} color={GREEN}
              hint={summary?.answer_rate_pct != null ? `${summary.answer_rate_pct}% answer rate` : undefined} />
        <Stat label="Missed" value={fmtNum(summary?.missed ?? 0)} color={AMBER} />
        <Stat label="Abandoned" value={fmtNum(summary?.abandoned ?? 0)} color={(summary?.abandoned ?? 0) > 0 ? RED : GREEN}
              hint="caller hung up before pickup" />
        <Stat label="Avg wait" value={fmtWait(summary?.avg_wait_sec ?? null)} color={NAVY}
              hint="time on the line before answer" />
        <Stat label="Owed a call back" value={fmtNum(outstanding)} color={outstanding > 0 ? RED : GREEN}
              hint="missed, not returned, not queued" />
      </div>

      {/* Controls — date range now lives in the page header (top-right); status & agent
          live in the table filter. This row is just the call-back action. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: SP[3], flexWrap: 'wrap' }}>
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
        title="Inbound calls"
        subtitle="A missed call counts as returned once an outbound call reaches the same number within 48 hours"
        badge={rows.length}
        padding={false}
      >
        <DataTable
          cols={cols}
          rows={rows}
          keyFn={r => r.id}
          loading={loading && calls.length === 0}
          skeletonRows={8}
          pageSize={25}
          searchKeys={['matched_customer', 'customer_name', 'customer_phone', 'customer_cif', 'agent_name', '_status']}
          searchPlaceholder="Search caller, number, CIF, agent…"
          filters={tableFilters}
          emptyText="No inbound calls in this range."
        />
      </SectionCard>

      {/* Call-flow modal — the queue + the full flow of one inbound call, opened by the
          small "Flow" button on each row. */}
      <Modal
        open={!!flowFor}
        onClose={() => setFlowFor(null)}
        title={flowFor ? `Call flow — ${flowFor.matched_customer || flowFor.customer_name || flowFor.customer_phone || 'inbound call'}` : 'Call flow'}
        width={620}
      >
        {flowFor && <CallFlow call={flowFor} legs={legsCache[flowFor.id]} loading={legsLoading === flowFor.id} />}
      </Modal>

      <RaiseTicketModal call={ticketFor} onClose={() => setTicketFor(null)} onDone={load} />

      {/* Log/annotate the inbound call. Seeded as Inbound + support so the disposition
          list fits, and pre-filled with the caller so the write-up links to the customer
          (by CIF if known, else the number). The shared form can merge onto the real
          call row and stamp customer_cif, which is what surfaces it on Customer 360. */}
      <LogCallModal
        open={!!logFor}
        initial={logFor ? {
          name: logFor.matched_customer || logFor.customer_name || '',
          phone: logFor.customer_phone || '',
          cif: logFor.customer_cif || '',
          direction: 'Inbound',
          purpose: '',
        } : undefined}
        onClose={() => setLogFor(null)}
        onSaved={() => { setLogFor(null); load() }}
      />
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
    color: 'var(--txt)', fontFamily: "var(--font-sans)", outline: 'none', boxSizing: 'border-box',
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
