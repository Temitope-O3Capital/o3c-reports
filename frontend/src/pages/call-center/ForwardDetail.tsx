import { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner, EmptyState } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { useLiveData } from '../../hooks/useRealtime'
import { fmtDatetime, fmtKobo } from '../../lib/fmt'
import { humanLabel } from '../../lib/labels'
import { outcomeLabel, useOutcomes } from '../../lib/outcomes'
import { leadStageLabel } from '../../lib/leadStages'
import { GREEN, AMBER, RED, BLUE, PURPLE, NAVY, INTER, NUM, FW, RADIUS, TEXT, SP } from '../../lib/design'

// ─────────────────────────────────────────────────────────────────────────────
// One hand-off, in full. The call centre's counterpart to the sales lead page.
//
// The tracker could tell a head that a lead went to Sales and which bucket it was in.
// It could not answer the only question anybody actually asks about a forward — "what is
// happening with this one" — because the three things that answer it live in three
// places, two of which a call-centre role cannot open: the calls that qualified it, who
// in Sales holds it now, and what they have done since.
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
  open_hours: number | null
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

/** Hours as something a person reads. 0.2 is "12 minutes", not "0.2 hours". */
function age(hours: number | null): string {
  if (hours == null) return '—'
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`
  if (hours < 48) return `${hours.toFixed(1)} hrs`
  return `${Math.round(hours / 24)} days`
}

const dur = (s: number | null) =>
  s == null || s <= 0 ? '—' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`

// Call outcome, as a pill. completed/missed/failed are the three the dialler writes.
function OutcomePill({ outcome }: { outcome: string | null }) {
  const o = (outcome || '').toLowerCase()
  const color = o === 'completed' ? GREEN : o === 'missed' ? AMBER : o ? RED : 'var(--txt3)'
  return (
    <span style={{ display: 'inline-flex', padding: '1px 8px', borderRadius: RADIUS.full,
      border: `1px solid ${color}55`, background: `${color}14`, color,
      fontSize: TEXT['2xs'], fontWeight: FW.bold, fontFamily: INTER }}>
      {outcome ? humanLabel(outcome) : 'Unknown'}
    </span>
  )
}

export default function CallCenterForwardDetail() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const [d, setD] = useState<Dossier | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
  useLiveData(load, { topics: ['crm', 'activities', 'calls', 'cc_leads'] })
  // One outcome vocabulary across both panels: the calls store a label and the sales
  // activity stores a code, and this page is the one screen that shows them side by side.
  useOutcomes()

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

  return (
    <Page
      title={f.customer_name || 'Hand-off'}
      subtitle={`Forwarded to Sales ${fmtDatetime(f.forwarded_at)}`}
      back={{ label: 'Forwarded to Sales', to: '/call-center/forwards' }}
    >
      {error && <ErrBanner error={error} onRetry={load} />}

      {/* Where it stands. The three things a head is actually checking, across the top. */}
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
      {(f.converted_cif || f.customer_cif) && (
        <Link to={`/customers/${encodeURIComponent(f.converted_cif || f.customer_cif || '')}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: SP[4],
            padding: '7px 14px', borderRadius: RADIUS.full, textDecoration: 'none',
            border: `1px solid ${GREEN}55`, background: `${GREEN}12`, color: GREEN,
            fontSize: TEXT.xs, fontWeight: FW.bold, fontFamily: INTER }}>
          <span className="material-symbols-rounded" style={{ fontSize: 17 }}>account_circle</span>
          Open Customer 360 · CIF {f.converted_cif || f.customer_cif}
        </Link>
      )}

      {f.disqualify_reason && (
        <div style={{ marginBottom: SP[4], padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md,
          border: `1px solid ${RED}44`, background: `${RED}0D`, fontSize: TEXT.sm, color: 'var(--txt)' }}>
          <b style={{ color: RED }}>Rejected by Sales:</b> {f.disqualify_reason}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: SP[3] }}>
        <SectionCard title="The Customer">
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(80px, auto) 1fr', gap: `${SP[2]} ${SP[3]}`, fontSize: TEXT.sm }}>
            {facts.map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <div style={{ color: 'var(--txt3)', fontSize: TEXT.xs, fontWeight: FW.semibold }}>{k}</div>
                <div style={{ color: 'var(--txt)', minWidth: 0, overflowWrap: 'anywhere' }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: SP[3], paddingTop: SP[3], borderTop: '1px solid var(--bdr)', fontSize: TEXT.xs, color: 'var(--txt3)' }}>
            Worked by <b style={{ color: 'var(--txt2)' }}>{f.lead_agent_name || 'an agent no longer on the lead'}</b>
            {f.forwarded_by_name && <> · forwarded by <b style={{ color: 'var(--txt2)' }}>{f.forwarded_by_name}</b></>}
            {f.lead_id && (
              <> · <Link to={`/call-center/leads?open=${f.lead_id}`} style={{ color: NAVY, fontWeight: FW.semibold }}>Open in the lead book</Link></>
            )}
          </div>
          {f.notes && (
            <div style={{ marginTop: SP[3], padding: SP[2], borderRadius: RADIUS.md, background: 'var(--th-bg)', fontSize: TEXT.sm, color: 'var(--txt2)' }}>
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontWeight: FW.bold, marginBottom: 3 }}>HAND-OFF NOTE</div>
              {f.notes}
            </div>
          )}
        </SectionCard>

        {/* The calls. This is the evidence: the tracker says a lead was forwarded, these
            say what the customer actually agreed to. */}
        <SectionCard title={`Calls Before the Hand-off (${d.calls.length})`}>
          {d.calls.length === 0 ? (
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>
              No calls on record against this lead.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
              {d.calls.map(c => (
                <div key={c.id} style={{ padding: SP[2], borderRadius: RADIUS.md, background: 'var(--th-bg)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 2 }}>
                    <OutcomePill outcome={c.outcome} />
                    {c.disposition && (
                      <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: NAVY }}>{outcomeLabel(c.disposition)}</span>
                    )}
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', ...NUM }}>
                      {fmtDatetime(c.started_at)} · {dur(c.duration_sec)}
                    </span>
                  </div>
                  {c.notes && <div style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{c.notes}</div>}
                  <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 2 }}>
                    {c.agent_name || 'Unknown agent'}{c.has_recording && ' · recorded'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* What Sales has done since. The answer to "has anybody touched this". */}
        <SectionCard title={`What Sales Has Done (${d.activities.length})`}>
          {d.activities.length === 0 ? (
            <div style={{ fontSize: TEXT.sm, color: open ? AMBER : 'var(--txt3)' }}>
              {open
                ? 'Nothing logged against this lead since it was forwarded.'
                : 'Nothing was logged against this lead.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
              {d.activities.map(a => (
                <div key={a.id} style={{ padding: SP[2], borderRadius: RADIUS.md, background: 'var(--th-bg)' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: NAVY }}>
                      {a.kind ? humanLabel(a.kind) : 'Activity'}
                    </span>
                    <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{a.subject || ''}</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', ...NUM }}>{fmtDatetime(a.occurred_at)}</span>
                  </div>
                  {a.note && <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 2 }}>{a.note}</div>}
                  <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 2 }}>
                    {a.officer_name || 'Unknown'}
                    {a.disposition && ` · ${outcomeLabel(a.disposition)}`}
                    {a.location && ` · ${a.location}`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* The stage history, which is the only thing that answers "is this moving". */}
        <SectionCard title={`Stage History (${d.events.length})`}>
          {d.events.length === 0 ? (
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>No stage changes recorded.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
              {d.events.map(e => (
                <div key={e.id} style={{ display: 'flex', gap: SP[2], alignItems: 'baseline' }}>
                  <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', ...NUM, flexShrink: 0, minWidth: 108 }}>
                    {fmtDatetime(e.created_at)}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                      {e.to_stage ? leadStageLabel(e.to_stage) : humanLabel(e.event || 'Event')}
                    </span>
                    {e.note && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}> — {e.note}</span>}
                    {e.by_name && <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}> · {e.by_name}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: SP[4], fontFamily: INTER }}>
        Read-only. This lead belongs to Sales now — everything here updates as they work it.
        {' '}
        <button onClick={() => nav('/call-center/forwards')}
          style={{ border: 'none', background: 'none', padding: 0, color: NAVY, fontWeight: FW.semibold, cursor: 'pointer', fontSize: TEXT.xs, fontFamily: INTER }}>
          Back to the tracker
        </button>
      </div>
    </Page>
  )
}
