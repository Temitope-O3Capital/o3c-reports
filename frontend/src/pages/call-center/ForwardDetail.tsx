import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner, EmptyState } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { useLiveData } from '../../hooks/useRealtime'
import { fmtDatetime, fmtDate, fmtKobo } from '../../lib/fmt'
import { humanLabel } from '../../lib/labels'
import { outcomeLabel, useOutcomes } from '../../lib/outcomes'
import { leadStageLabel } from '../../lib/leadStages'
import { useIsMobile } from '../../hooks/useMediaQuery'
import { GREEN, AMBER, RED, BLUE, PURPLE, NAVY, INTER, NUM, FW, RADIUS, TEXT, SP } from '../../lib/design'
import { readableNote } from '../../lib/notes'

// ─────────────────────────────────────────────────────────────────────────────
// One hand-off, in full. The call centre's counterpart to the sales lead page.
//
// The tracker could say a lead went to Sales and which bucket it was in. It could not
// answer the only question anybody asks about a forward — "what is happening with this
// one" — because the answer lives in three places, two of which a call-centre role
// cannot open: the calls that qualified it, who in Sales holds it, and what they have
// done since.
//
// Those three used to be three side-by-side panels, each in its own time order. That is
// one story told three times: a head comparing "the customer agreed on Tuesday" against
// "Sales rang on Friday" had to read two lists and hold the dates in their head. They
// are now ONE thread, the way the sales lead page does it, with the hand-off itself
// marked in the middle of it.
//
// Read-only, deliberately. Everything here belongs to a sales officer the moment it is
// forwarded; a call-centre head needs to SEE it, and re-staging someone else's lead from
// a tracker is how two people end up working the same customer.
// ─────────────────────────────────────────────────────────────────────────────

const STATUS: Record<string, { label: string; color: string }> = {
  forwarded:  { label: 'Awaiting Pickup', color: BLUE },
  with_sales: { label: 'With Sales',      color: AMBER },
  assigned:   { label: 'Assigned',        color: PURPLE },
  converted:  { label: 'Converted',       color: GREEN },
  rejected:   { label: 'Rejected',        color: RED },
}

interface Forward {
  id: number
  lead_id: number | null
  contact_id: number | null
  forwarded_by_name: string | null
  customer_name: string | null
  customer_phone: string | null
  customer_cif: string | null
  product_interest: string | null
  notes: string | null
  forwarded_at: string
  resolved_at: string | null
  outcome: string | null
  status: string
  crm_stage: string | null
  converted_cif: string | null
  disqualify_reason: string | null
  sales_owner_name: string | null
  sales_owner_email: string | null
  sales_owner_phone: string | null
  sales_owner_office: string | null
  lead_agent_name: string | null
  campaign_name: string | null
  marketing_campaign_name: string | null
  city: string | null
  state: string | null
  address: string | null
  employer: string | null
  lead_email: string | null
  lead_status: string | null
  estimated_value_kobo: number | null
  last_activity_at: string | null
  sales_entered_at: string | null
  // Numeric in Postgres, so it arrives as a string — see age() below.
  open_hours: number | string | null
}

interface Call {
  id: number
  started_at: string
  duration_sec: number | null
  direction: string | null
  outcome: string | null
  disposition: string | null
  notes: string | null
  agent_name: string | null
  has_recording: boolean
}

interface Activity {
  id: number
  kind: string | null
  subject: string | null
  note: string | null
  disposition: string | null
  direction: string | null
  location: string | null
  occurred_at: string
  officer_name: string | null
}

interface Event {
  id: number
  event: string | null
  to_stage: string | null
  note: string | null
  created_at: string
  by_name: string | null
}

interface Dossier {
  forward: Forward
  calls: Call[]
  activities: Activity[]
  events: Event[]
}

/** Hours as something a person reads. 0.2 is "12 minutes", not "0.2 hours".
 *
 * Takes the raw value rather than a number, because open_hours is
 * ROUND(EXTRACT(EPOCH …) / 3600.0, 1) — a Postgres NUMERIC, and a numeric column
 * reaches the browser as a STRING: core.DB hands back []byte as text so a UUID is
 * never mangled into a float. The comparisons below coerced a string silently, so
 * only the band between 1 and 48 hours ever called .toFixed on one and threw. That
 * is why this page broke for some hand-offs and rendered perfectly for others.
 */
function age(hours: number | string | null): string {
  const h = typeof hours === 'number' ? hours : Number(hours)
  if (hours == null || hours === '' || !Number.isFinite(h)) return '—'
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`
  if (h < 48) return `${h.toFixed(1)} hrs`
  return `${Math.round(h / 24)} days`
}

const dur = (s: number | null) =>
  s == null || s <= 0 ? '' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`

// ── The thread ────────────────────────────────────────────────────────────────

/** Which side of the hand-off an entry came from. Drives the colour and the filter. */
type Side = 'call_centre' | 'sales' | 'boundary'

interface ThreadRow {
  at: string
  side: Side
  icon: string
  /** What happened, in the user's words where we have them. */
  title: string
  note?: string | null
  actor?: string | null
  /** Duration, location, recording — the small print under the entry. */
  meta?: string | null
  /** The hand-off itself renders as a divider rather than an entry. */
  marker?: boolean
}

const SIDE_COLOR: Record<Side, string> = {
  call_centre: PURPLE,
  sales: NAVY,
  boundary: 'var(--txt3)',
}
const SIDE_LABEL: Record<Side, string> = {
  call_centre: 'Call Centre',
  sales: 'Sales',
  boundary: '',
}

const ACTIVITY_ICON: Record<string, string> = {
  call: 'call', visit: 'location_on', meeting: 'groups', email: 'mail',
  note: 'sticky_note_2', step: 'checklist', handoff: 'swap_horiz', task: 'task_alt',
  document: 'description', whatsapp: 'chat', sms: 'sms',
}

/**
 * Everything that has happened to this hand-off, newest first, as one list.
 *
 * The hand-off moment is inserted as a marker so the boundary is visible in the thread
 * rather than implied by whichever panel an entry happened to sit in — which is the
 * whole point of reading the call centre's work and Sales' work together.
 */
function buildThread(d: Dossier): ThreadRow[] {
  const rows: ThreadRow[] = []

  for (const c of d.calls) {
    const label = c.disposition ? outcomeLabel(c.disposition) : null
    rows.push({
      at: c.started_at,
      side: 'call_centre',
      icon: c.direction === 'inbound' ? 'call_received' : 'call_made',
      title: label || (c.outcome ? outcomeLabel(c.outcome) : 'Call'),
      note: c.notes,
      actor: c.agent_name,
      meta: [dur(c.duration_sec), c.has_recording ? 'recorded' : null].filter(Boolean).join(' · '),
    })
  }

  for (const a of d.activities) {
    const kind = (a.kind || '').toLowerCase()
    rows.push({
      at: a.occurred_at,
      side: 'sales',
      icon: ACTIVITY_ICON[kind] ?? 'bolt',
      title: a.subject || (a.kind ? humanLabel(a.kind) : 'Activity'),
      note: a.note,
      actor: a.officer_name,
      meta: [a.disposition ? outcomeLabel(a.disposition) : null, a.location].filter(Boolean).join(' · '),
    })
  }

  for (const e of d.events) {
    rows.push({
      at: e.created_at,
      side: 'sales',
      icon: e.to_stage === 'converted' ? 'verified'
        : e.to_stage === 'disqualified' ? 'cancel' : 'trending_up',
      title: e.to_stage ? leadStageLabel(e.to_stage) : humanLabel(e.event || 'Stage Change'),
      note: e.note,
      actor: e.by_name,
    })
  }

  rows.push({
    at: d.forward.forwarded_at,
    side: 'boundary',
    icon: 'forward_to_inbox',
    title: 'Forwarded to Sales',
    actor: d.forward.forwarded_by_name,
    marker: true,
  })

  return rows.sort((a, b) => +new Date(b.at) - +new Date(a.at))
}

function ThreadEntry({ row }: { row: ThreadRow }) {
  const c = SIDE_COLOR[row.side]
  const note = readableNote(row.note)

  if (row.marker) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], padding: '8px 0' }}>
        <span className="material-symbols-rounded" aria-hidden
          style={{ fontSize: 16, color: 'var(--txt3)', flexShrink: 0 }}>{row.icon}</span>
        <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)',
          textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap' }}>
          {row.title}
        </span>
        {row.actor && (
          <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', whiteSpace: 'nowrap' }}>by {row.actor}</span>
        )}
        <span style={{ flex: 1, height: 1, background: 'var(--bdr)' }} />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', gap: SP[2], padding: '6px 0', alignItems: 'flex-start' }}>
      <span className="material-symbols-rounded" aria-hidden
        style={{ fontSize: 16, color: c, marginTop: 2, flexShrink: 0 }}>{row.icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium }}>
          {row.title}
        </div>
        {note && (
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 2, lineHeight: 1.45 }}>
            {note}
          </div>
        )}
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 2 }}>
          {row.actor || 'Unknown'} · <span style={{ color: c }}>{SIDE_LABEL[row.side]}</span>
          {' · '}
          {new Date(row.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {row.meta ? ` · ${row.meta}` : ''}
        </div>
      </div>
    </div>
  )
}

type Filter = 'all' | 'call_centre' | 'sales'

export default function CallCenterForwardDetail() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const [d, setD] = useState<Dossier | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  // The reference column folds under the thread on a narrow screen rather than
  // squeezing both into unreadable widths.
  const isNarrow = useIsMobile()

  const load = useCallback(async () => {
    if (!id) return
    try {
      const res = await apiFetch<Dossier | { data: Dossier }>(`/api/call-center/forwards/${id}`)
      const body: any = res
      setD(body?.forward ? body : body?.data ?? null)
      setError(null)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])
  // Live: the whole point of the page is watching a hand-off move while Sales works it.
  useLiveData(load, { topics: ['crm', 'activities', 'calls', 'cc_leads', 'cc_forwards'] })
  // One outcome vocabulary across the thread: the calls store a label and the sales
  // activity stores a code, and this page shows them in the same list.
  useOutcomes()

  const thread = useMemo(() => (d ? buildThread(d) : []), [d])
  const shown = useMemo(
    () => thread.filter(r => r.marker || filter === 'all' || r.side === filter),
    [thread, filter])

  // Grouped by day, so a fortnight of work reads as a fortnight rather than a flat list.
  const byDay = useMemo(() => {
    const m = new Map<string, ThreadRow[]>()
    for (const r of shown) {
      const day = r.at.slice(0, 10)
      const arr = m.get(day)
      if (arr) arr.push(r)
      else m.set(day, [r])
    }
    return [...m.entries()]
  }, [shown])

  if (loading && !d) {
    return <Page title="Hand-off"><div style={{ padding: 48, textAlign: 'center' }}><Spinner /></div></Page>
  }
  if (error && !d) {
    return (
      <Page title="Hand-off" back={{ label: 'Forwarded to Sales', to: '/call-center/forwards' }}>
        <ErrBanner error={error} onRetry={load} />
      </Page>
    )
  }
  if (!d) {
    return (
      <Page title="Hand-off" back={{ label: 'Forwarded to Sales', to: '/call-center/forwards' }}>
        <EmptyState icon="forward_to_inbox" title="Nothing Here"
          description="That hand-off either does not exist or is not one you can open." />
      </Page>
    )
  }

  const f = d.forward
  const st = STATUS[f.status] ?? { label: humanLabel(f.status), color: 'var(--txt2)' }
  const where = [f.city, f.state].filter(Boolean).join(', ')
  const open = !f.resolved_at
  const cif = f.converted_cif || f.customer_cif

  // Facts, as pairs. A grid rather than prose because a head scanning five hand-offs is
  // comparing the same six things each time, and prose makes that a reading exercise.
  const facts: [string, React.ReactNode][] = [
    ['Phone', f.customer_phone
      ? <a href={`tel:${f.customer_phone}`} style={{ color: NAVY, fontFamily: 'var(--font-mono)' }}>{f.customer_phone}</a>
      : '—'],
    ['Where', where || <span style={{ color: AMBER }}>Not captured — Sales cannot plan a visit</span>],
    ['Address', f.address || '—'],
    ['Employer', f.employer || '—'],
    ['Email', f.lead_email || '—'],
    ['Product', f.product_interest ? humanLabel(f.product_interest) : '—'],
    ['Est. Value', f.estimated_value_kobo ? fmtKobo(f.estimated_value_kobo) : '—'],
    ['Campaign', f.campaign_name || f.marketing_campaign_name || '—'],
  ]

  const tile: React.CSSProperties = {
    padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md,
    background: 'var(--th-bg)', minWidth: 0,
  }

  const counts = {
    all: thread.filter(r => !r.marker).length,
    call_centre: thread.filter(r => r.side === 'call_centre').length,
    sales: thread.filter(r => r.side === 'sales').length,
  }
  const FILTERS: { v: Filter; label: string; color: string }[] = [
    { v: 'all',         label: 'All',         color: NAVY },
    { v: 'call_centre', label: 'Call Centre', color: PURPLE },
    { v: 'sales',       label: 'Sales',       color: NAVY },
  ]

  return (
    <Page
      title={f.customer_name || 'Hand-off'}
      subtitle={`Forwarded ${fmtDatetime(f.forwarded_at)}`}
      back={{ label: 'Forwarded to Sales', to: '/call-center/forwards' }}
    >
      {error && <ErrBanner error={error} onRetry={load} />}

      {/* Where it stands. The things a head is actually checking, across the top. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP[2], marginBottom: SP[4] }}>
        <div style={{ ...tile, border: `1px solid ${st.color}44`, background: `${st.color}10` }}>
          <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Status</div>
          <div style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: st.color }}>{st.label}</div>
        </div>
        <div style={tile}>
          <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
            {open ? 'Open For' : 'Closed After'}
          </div>
          <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>{age(f.open_hours)}</div>
        </div>
        <div style={{ ...tile, flex: 1 }}>
          <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Who Has It</div>
          {f.sales_owner_name ? (
            <div style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>
              {f.sales_owner_name}
              {f.sales_owner_office && (
                <span style={{ fontSize: TEXT.xs, fontWeight: FW.normal, color: 'var(--txt3)' }}>
                  {' · '}{f.sales_owner_office}
                </span>
              )}
            </div>
          ) : (
            // Not a fault. An unclaimed lead is in the pool waiting on a distribution,
            // and saying so is more use than the bare word "Unassigned".
            <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: AMBER }}>
              In the pool — nobody has claimed it yet
            </div>
          )}
          {f.sales_owner_name && (f.sales_owner_email || f.sales_owner_phone) && (
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>
              {f.sales_owner_phone && (
                <a href={`tel:${f.sales_owner_phone}`} style={{ color: NAVY, fontFamily: 'var(--font-mono)' }}>{f.sales_owner_phone}</a>
              )}
              {f.sales_owner_phone && f.sales_owner_email && ' · '}
              {f.sales_owner_email && (
                <a href={`mailto:${f.sales_owner_email}`} style={{ color: NAVY }}>{f.sales_owner_email}</a>
              )}
            </div>
          )}
        </div>
        <div style={tile}>
          <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Sales Stage</div>
          <div style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>
            {f.crm_stage ? leadStageLabel(f.crm_stage) : '—'}
          </div>
        </div>
      </div>

      {/* A converted hand-off has a customer at the end of it, and that is the one place
          worth leaving this page for. */}
      {cif && (
        <Link to={`/customers/${encodeURIComponent(cif)}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: SP[4],
            padding: '7px 14px', borderRadius: RADIUS.full, textDecoration: 'none',
            border: `1px solid ${GREEN}55`, background: `${GREEN}12`, color: GREEN,
            fontSize: TEXT.xs, fontWeight: FW.bold, fontFamily: INTER }}>
          <span className="material-symbols-rounded" style={{ fontSize: 17 }}>account_circle</span>
          Open Customer 360 · CIF {cif}
        </Link>
      )}

      {f.disqualify_reason && (
        <div style={{ marginBottom: SP[4], padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md,
          border: `1px solid ${RED}44`, background: `${RED}0D`, fontSize: TEXT.sm, color: 'var(--txt)' }}>
          <b style={{ color: RED }}>Rejected by Sales:</b> {readableNote(f.disqualify_reason)}
        </div>
      )}

      {/* Two columns. The thread is the long thing and gets the width; the facts are a
          reference and get a column you can read without scrolling past them. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: isNarrow ? '1fr' : 'minmax(0, 1.65fr) minmax(300px, 1fr)',
        gap: SP[4], alignItems: 'start',
      }}>
        <SectionCard
          title="What Has Happened"
          subtitle="The calls that qualified it, and everything Sales has done since"
          badge={counts.all || undefined}
          actions={
            <div style={{ display: 'flex', gap: SP[1] }}>
              {FILTERS.map(({ v, label, color }) => {
                const on = filter === v
                const n = v === 'all' ? counts.all : counts[v]
                const dead = n === 0 && v !== 'all'
                return (
                  <button key={v} onClick={() => setFilter(v)} disabled={dead}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '2px 8px',
                      borderRadius: RADIUS.full, fontFamily: INTER,
                      border: `1px solid ${on ? color : 'var(--bdr)'}`,
                      background: on ? `${color}14` : 'transparent',
                      color: on ? color : 'var(--txt3)',
                      cursor: dead ? 'not-allowed' : 'pointer',
                      opacity: dead ? 0.5 : 1,
                    }}>
                    {label}
                    <span style={{ ...NUM, fontWeight: FW.bold }}>{n}</span>
                  </button>
                )
              })}
            </div>
          }
        >
          {byDay.length === 0 ? (
            <EmptyState icon="history" title="Nothing Recorded Yet"
              description="Calls and sales activity appear here as they happen." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
              {byDay.map(([day, rows]) => (
                <div key={day}>
                  <div style={{
                    fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'var(--txt3)',
                    textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6,
                  }}>{fmtDate(day)}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {rows.map((r, i) => <ThreadEntry key={`${day}-${i}`} row={r} />)}
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* Said once, at the foot of the thread, rather than as a standing notice. */}
          <div style={{ marginTop: SP[3], paddingTop: SP[3], borderTop: '1px solid var(--bdr)',
            fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: INTER }}>
            This lead belongs to Sales. The thread updates as they work it.
          </div>
        </SectionCard>

        {/* ── The reference column ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
          <SectionCard title="The Customer">
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(80px, auto) 1fr', gap: `${SP[2]} ${SP[3]}`, fontSize: TEXT.sm }}>
              {facts.map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <div style={{ color: 'var(--txt3)', fontSize: TEXT.xs, fontWeight: FW.semibold }}>{k}</div>
                  <div style={{ color: 'var(--txt)', minWidth: 0, overflowWrap: 'anywhere' }}>{v}</div>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard title="The Hand-off">
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.6 }}>
              Worked by <b style={{ color: 'var(--txt2)' }}>{f.lead_agent_name || 'an agent no longer on the lead'}</b>
              {f.forwarded_by_name && <> · forwarded by <b style={{ color: 'var(--txt2)' }}>{f.forwarded_by_name}</b></>}
            </div>
            {f.lead_id && (
              <div style={{ marginTop: SP[2] }}>
                <Link to={`/call-center/leads?open=${f.lead_id}`}
                  style={{ fontSize: TEXT.xs, color: NAVY, fontWeight: FW.semibold }}>
                  Open in the lead book
                </Link>
              </div>
            )}
            {readableNote(f.notes) && (
              <div style={{ marginTop: SP[3], padding: SP[2], borderRadius: RADIUS.md, background: 'var(--th-bg)' }}>
                <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontWeight: FW.bold, marginBottom: 3,
                  textTransform: 'uppercase', letterSpacing: '.05em' }}>Hand-off Note</div>
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5 }}>{readableNote(f.notes)}</div>
              </div>
            )}
          </SectionCard>

          <button onClick={() => nav('/call-center/forwards')}
            style={{ alignSelf: 'start', border: 'none', background: 'none', padding: 0,
              color: NAVY, fontWeight: FW.semibold, cursor: 'pointer', fontSize: TEXT.xs, fontFamily: INTER }}>
            Back to the tracker
          </button>
        </div>
      </div>
    </Page>
  )
}
