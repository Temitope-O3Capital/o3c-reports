import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Modal, Input, Spinner, Avatar, EmptyState, SectionCard } from '../../components/UI'
import { SelectMenu, SelectMenuField } from '../../components/SelectMenu'
import { apiFetch, apiPost } from '../../lib/api'
import { toast } from 'sonner'
import { NAVY, GREEN, RED, AMBER, PURPLE, BLUE, TEXT, FW, RADIUS, SP, NUM } from '../../lib/design'
import { fmtKobo, fmtDatetime, fmtDate } from '../../lib/fmt'
import { humanLabel } from '../../lib/labels'
import { LEAD_STAGES } from '../../lib/leadStages'
import { useIsMobile } from '../../hooks/useMediaQuery'
import SalesActivityModal from '../../components/SalesActivityModal'
import { useLiveData } from '../../hooks/useRealtime'

// The lead record, opened from the Leads queue.
//
// What it replaced showed a row and a stage, and every question an officer actually has
// about a lead — has anyone rung them, what did they say, who had this before me, what
// are they even interested in — needed a different screen or could not be answered at
// all. This puts the facts, the actions and the full history in one place.
//
// The history is the point. /leads/{id}/timeline merges Sales' own stage events with the
// activity stream every team writes to (14,818 recorded calls among them) and the
// call-centre hand-off ledger. Before it, a lead forwarded after four conversations
// arrived in Sales looking brand new.

interface Lead {
  id: number
  first_name?: string; last_name?: string; phone?: string; email?: string
  state?: string; city?: string; employer?: string; occupation?: string
  lead_stage: string; lead_source?: string; source?: string
  sales_source?: string; sales_entered_at?: string
  product_interest?: string
  sales_owner_id?: number | null; owner_name?: string
  estimated_value_kobo?: number
  next_action_at?: string; last_activity_at?: string
  qualified_at?: string; created_at?: string
  already_customer?: boolean; matched_customer_cif?: string
  converted_cif?: string; converted_line?: string; converted_ref?: string
  open_cif?: string
  source_campaign_id?: number | null
  campaign_name?: string | null
  campaign_source?: 'marketing' | 'dialler' | null
  tags?: string[] | null
}

interface TimelineRow {
  at: string; kind: string; type: string
  detail?: string; note?: string; actor: string; team: string; outcome?: string
}

// role is optional: the Leads queue loads a lighter officer list than the Teams page,
// and the drawer only uses the role as a subtitle in the transfer picker.
interface Officer { id: number; full_name: string; role?: string; is_active: boolean }

const TEAM_COLOR: Record<string, string> = {
  sales: NAVY, call_center: PURPLE, bd: BLUE, care: GREEN, risk: AMBER,
}
const teamColor = (t: string) => TEAM_COLOR[t] ?? 'var(--txt3)'

const TEAM_LABEL: Record<string, string> = {
  sales: 'Sales', call_center: 'Call Centre', bd: 'Business Development',
  care: 'Care', risk: 'Risk', admin: 'Admin', unknown: '—',
}
const teamLabel = (t: string) => TEAM_LABEL[t] ?? humanLabel(t)

/** Timeline icons by what happened, not by which table it came from. */
const TYPE_ICON: Record<string, string> = {
  call: 'call', note: 'sticky_note_2', email: 'mail', visit: 'location_on',
  handoff: 'swap_horiz', forwarded_to_sales: 'swap_horiz', handoff_update: 'swap_horiz',
  stage_change: 'trending_up', stage_regraded: 'trending_up',
  claimed: 'how_to_reg', transferred: 'swap_horiz', assigned: 'person_add',
  converted: 'verified', disqualified: 'cancel', created: 'add_circle',
  step: 'checklist', decision: 'gavel',
}
const typeIcon = (t: string) => TYPE_ICON[t] ?? 'circle'

/** Underscored database vocabulary, rendered as words. Was a local copy that title-cased every
 *  word, so acronyms read as "Kyc" and "Sms"; humanLabel is the one implementation now. */
const humanise = (s: string) => humanLabel(s)

const PRODUCT_LINES = [
  { value: 'cards', label: 'Card', hint: 'Reference is the card CIF' },
  { value: 'loans', label: 'Loan', hint: 'Reference is the Udara loan account number' },
  { value: 'fixed_deposit', label: 'Fixed Deposit', hint: 'Reference is the Udara FD account number' },
]

// The lead record. Rendered as a PAGE, not a drawer.
//
// It began as a drawer because the queue was the only way in, and a sheet over the list
// kept the officer's place. That stopped being the right shape as the record grew: it
// now carries identity, ownership, the actions, the location Sales plans visits from, a
// convert flow, a transfer picker, a follow-up scheduler and a timeline merged from four
// teams. A half-width sheet with its own scrollbar is a poor container for that, it
// could not be linked, printed or opened in a second tab, and on a phone it covered the
// very list it was meant to be an aside to.
//
// This renders the body only; LeadPage.tsx supplies the page shell and the route, so the
// lead is addressable as /sales/leads/<id>.
export function LeadDetail({ leadId, officers, meId, canManage, onChanged, onLoaded }: {
  leadId: number | null
  officers: Officer[]
  meId: number
  canManage: boolean
  onChanged: () => void
  /** Reports the loaded lead upwards so the page shell can title itself without
   *  fetching the same record a second time. */
  onLoaded?: (lead: { name: string; stage: string; city?: string; state?: string }) => void
}) {
  const [lead, setLead] = useState<Lead | null>(null)
  const [timeline, setTimeline] = useState<TimelineRow[]>([])
  const [loading, setLoading] = useState(false)
  const [convertOpen, setConvertOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [followOpen, setFollowOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  // The reference column folds under the history on a narrow screen rather than
  // squeezing both into unreadable widths.
  const isNarrow = useIsMobile()

  // Held in a ref so a parent that re-creates the callback each render does not
  // re-trigger load() and put the page in a fetch loop.
  const onLoadedRef = useRef(onLoaded)
  useEffect(() => { onLoadedRef.current = onLoaded }, [onLoaded])

  const load = useCallback(async () => {
    if (!leadId) return
    setLoading(true)
    try {
      const [l, t] = await Promise.all([
        apiFetch<{ data: Lead } | Lead>(`/api/sales/leads/${leadId}`),
        apiFetch<{ data: TimelineRow[] } | TimelineRow[]>(`/api/sales/leads/${leadId}/timeline`),
      ])
      const got: Lead = (l as any)?.data ?? (l as Lead)
      setLead(got)
      onLoadedRef.current?.({
        name: [got?.first_name, got?.last_name].filter(Boolean).join(' ') || 'Unnamed lead',
        stage: got?.lead_stage ?? '',
        city: got?.city, state: got?.state,
      })
      const rows = Array.isArray(t) ? t : (t?.data ?? [])
      setTimeline(rows)
    } catch (e: any) { toast.error(e.message) }
    finally { setLoading(false) }
  }, [leadId])
  useEffect(() => { if (leadId) load() }, [leadId, load])
  // Live: everything this record shows is one of these five.
  useLiveData(load, { topics: ['crm', 'activities', 'tasks', 'deals', 'sales_visits'] })

  const refresh = () => { load(); onChanged() }

  const name = [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || 'Unnamed lead'
  const isMine = !!lead && lead.sales_owner_id === meId
  const isOpen = !!lead && !['converted', 'disqualified'].includes(lead.lead_stage)
  const unowned = !!lead && !lead.sales_owner_id

  async function act(path: string, body: any, ok: string) {
    try { await apiPost(`/api/sales/leads/${leadId}/${path}`, body); toast.success(ok); refresh() }
    catch (e: any) { toast.error(e.message) }
  }

  // Days, newest first, so a long history reads as "this week / last month" rather than
  // as 40 undifferentiated rows.
  const byDay = useMemo(() => {
    const m = new Map<string, TimelineRow[]>()
    timeline.forEach(r => {
      const d = (r.at || '').slice(0, 10)
      if (!m.has(d)) m.set(d, [])
      m.get(d)!.push(r)
    })
    return [...m.entries()]
  }, [timeline])

  return (
    <>
      {loading && !lead ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}><Spinner size={26} /></div>
      ) : !lead ? (
        <EmptyState icon="person_off" title="Lead Not Found"
          description="It may have been converted, disqualified or transferred out of your queue." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>

          {/* Where the lead has got to, and who has it.
              The name is NOT repeated here — the page header above already carries it
              with the location. What this band adds is the two things a header cannot:
              how far along the pipeline the lead is, and whose it is. */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: SP[3], flexWrap: 'wrap',
            padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.lg,
            background: 'var(--card)', border: '1px solid var(--bdr)',
          }}>
            <Avatar name={name} size={34} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                Owner
              </div>
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.semibold }}>
                {lead.owner_name
                  ? <>{lead.owner_name}{isMine && ' (you)'}</>
                  : <span style={{ color: AMBER }}>Unclaimed</span>}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 200 }}><StageRail stage={lead.lead_stage} /></div>
          </div>

          {/* Already a customer — the one caveat worth interrupting for */}
          {lead.already_customer && (
            <div style={{
              padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.lg,
              background: `${AMBER}12`, border: `1px solid ${AMBER}3A`,
              fontSize: TEXT.sm, color: 'var(--txt)',
            }}>
              <strong>Already a customer.</strong> This phone number matches an existing
              customer{lead.matched_customer_cif ? ` (CIF ${lead.matched_customer_cif})` : ''} —
              it is a cross-sell, not a new acquisition.
            </div>
          )}

          {/* Actions */}
          {isOpen && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {unowned && (
                <Button size="sm" variant="primary" icon="how_to_reg"
                  onClick={() => act('claim', {}, 'Lead claimed')}>Claim</Button>
              )}
              {(isMine || canManage) && !unowned && (
                <Button size="sm" variant="secondary" icon="swap_horiz"
                  onClick={() => setTransferOpen(true)}>Transfer</Button>
              )}
              {/* A follow-up is raised HERE, on the lead, because this is where the
                  officer decides there needs to be one. crm_tasks had never held a single
                  row in production: the only way to create one was to leave your work,
                  open a separate Tasks page and type a to-do from memory, which nobody
                  ever did. A task that arises from the work is the only kind that gets
                  created. */}
              <Button size="sm" variant="secondary" icon="alarm_add"
                onClick={() => setFollowOpen(true)}>Follow Up</Button>
              {/* Logging what happened was possible from the QUEUE and not from the
                  lead itself, which is the one screen an officer has open while they
                  are on the phone to the person. */}
              <Button size="sm" variant="secondary" icon="add_comment"
                onClick={() => setActivityOpen(true)}>Log Activity</Button>
              {lead.phone && (
                <Button size="sm" variant="ghost" icon="call"
                  onClick={() => { window.location.href = `tel:${lead.phone}` }}>Call</Button>
              )}
              {(isMine || canManage) && (
                <>
                  <Button size="sm" variant="primary" icon="verified"
                    onClick={() => setConvertOpen(true)}>Convert</Button>
                  <Button size="sm" variant="secondary" icon="cancel"
                    onClick={() => act('disqualify', { reason: 'Not interested' }, 'Lead disqualified')}>
                    Disqualify
                  </Button>
                </>
              )}
            </div>
          )}

          {/* Converted outcome */}
          {lead.lead_stage === 'converted' && (
            <div style={{
              padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.lg,
              background: `${GREEN}12`, border: `1px solid ${GREEN}3A`, fontSize: TEXT.sm,
            }}>
              <strong>Converted</strong>
              {lead.converted_line
                ? <> on {humanise(lead.converted_line)} · <span style={NUM}>{lead.converted_ref}</span></>
                : lead.converted_cif ? <> · CIF <span style={NUM}>{lead.converted_cif}</span></> : null}
            </div>
          )}

          {/* Two columns, because the page had one and it did not fit the content: the
              facts ran as a thin strip across the full width and the history left the
              right-hand half of the screen empty from the fold down. The history is the
              long thing and gets the width; the facts are a reference and get a column
              you can read without scrolling past them. */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: isNarrow ? '1fr' : 'minmax(0, 1.65fr) minmax(300px, 1fr)',
            gap: SP[4], alignItems: 'start',
          }}>
            {/* ── The history, which is what this page is mostly for ── */}
            <SectionCard
              title="History"
              subtitle="Every team that has touched this lead, newest first"
              badge={timeline.length || undefined}
            >
              {timeline.length === 0 ? (
                <EmptyState icon="history" title="Nothing Recorded Yet"
                  description="Calls, visits and stage changes will appear here as they happen." />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
                  {byDay.map(([day, rows]) => (
                    <div key={day}>
                      <div style={{
                        fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'var(--txt3)',
                        textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6,
                      }}>{fmtDate(day)}</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {rows.map((r, i) => <TimelineEntry key={`${day}-${i}`} row={r} />)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>

            {/* ── The reference column ── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
              <SectionCard title="What Happens Next" subtitle="The only dates that matter today">
                <NextStep lead={lead} />
              </SectionCard>

              <SectionCard title="Contact">
                <Facts lead={lead} group="contact" />
              </SectionCard>

              <SectionCard title="The Opportunity">
                <Facts lead={lead} group="deal" />
              </SectionCard>

              {/* Labels. Editable here because this is where an officer is looking at the
                  lead and forming the opinion the label records. Anyone who can see the
                  lead can label it: a tag is a note, not a state change, and gating it
                  behind ownership would leave a head unable to mark up the pool they are
                  about to distribute. */}
              {/* Array.isArray rather than ?? []: tags is a Postgres text[] and a
                  non-array would reach .map inside the editor. See pgTextArray. */}
              <SectionCard title="Labels">
                <TagEditor leadId={lead.id} tags={Array.isArray(lead.tags) ? lead.tags : []} onChanged={refresh} />
              </SectionCard>
            </div>
          </div>
        </div>
      )}

      {/* Logging an activity from the record itself, which is where the officer is
          standing when the call ends. The same dialog the queue uses. */}
      {lead && (
        <SalesActivityModal
          open={activityOpen}
          lead={{ id: lead.id, name, stage: lead.lead_stage }}
          onClose={() => setActivityOpen(false)}
          onSaved={() => { setActivityOpen(false); refresh() }}
        />
      )}

      {convertOpen && lead && (
        <ConvertModal leadId={lead.id} name={name}
          onClose={() => setConvertOpen(false)}
          onDone={() => { setConvertOpen(false); refresh() }} />
      )}
      {transferOpen && lead && (
        <TransferModal leadId={lead.id} name={name} officers={officers} currentOwner={lead.sales_owner_id ?? null}
          onClose={() => setTransferOpen(false)}
          onDone={() => { setTransferOpen(false); refresh() }} />
      )}
      {followOpen && lead && (
        <FollowUpModal leadId={lead.id} name={name}
          onClose={() => setFollowOpen(false)}
          onDone={() => { setFollowOpen(false); refresh() }} />
      )}
    </>
  )
}

// ── Labels ───────────────────────────────────────────────────────────────────
//
// Free-form, but canonical: the server stores lowercase and trimmed (migration 314), and
// refuses anything else. Normalising here as well means the officer sees what will actually
// be stored as they type, rather than having "Corporate" quietly become "corporate" after
// the save — and it stops the same label existing three ways, which is the failure that
// makes a tag filter useless within a month.
//
// Suggestions come from the labels already in use in this caller's scope, so the second
// person to need "price objection" picks the existing one instead of inventing
// "price-objection" beside it.

/** Same rule as canonicalTag in backend-go/handlers/sales_leads.go. */
function canonicalTag(s: string): string {
  return s.toLowerCase().trim().split(/\s+/).join(' ')
}
const TAG_OK = /^[a-z0-9][a-z0-9 _-]*$/

function TagEditor({ leadId, tags, onChanged }: {
  leadId: number
  tags: string[]
  onChanged: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [suggest, setSuggest] = useState<string[]>([])

  useEffect(() => {
    if (!adding || suggest.length > 0) return
    apiFetch<{ data: { tag: string }[] }>('/api/sales/lead-tags')
      .then(r => setSuggest((r?.data ?? []).map(t => t.tag)))
      .catch(() => { /* typing still works without suggestions */ })
  }, [adding, suggest.length])

  const add = useCallback(async (raw: string) => {
    const tag = canonicalTag(raw)
    if (!tag) return
    if (tag.length < 2 || tag.length > 32 || !TAG_OK.test(tag)) {
      toast.error('A label is 2–32 characters: letters, numbers, spaces, - or _, not starting with a space.')
      return
    }
    if (tags.includes(tag)) { setDraft(''); setAdding(false); return }
    setBusy(true)
    try {
      await apiPost(`/api/sales/leads/${leadId}/tags`, { tag })
      toast.success('Label added')
      setDraft(''); setAdding(false); onChanged()
    } catch (e: any) { toast.error(e?.message ?? 'Could not add that label') }
    finally { setBusy(false) }
  }, [leadId, tags, onChanged])

  const remove = useCallback(async (tag: string) => {
    setBusy(true)
    try {
      await apiFetch(`/api/sales/leads/${leadId}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' })
      toast.success('Label removed')
      onChanged()
    } catch (e: any) { toast.error(e?.message ?? 'Could not remove that label') }
    finally { setBusy(false) }
  }, [leadId, onChanged])

  const unused = suggest.filter(s => !tags.includes(s))

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: SP[2],
      }}>
        <h3 style={{ margin: 0, fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>Labels</h3>
        {busy && <Spinner size={13} />}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {tags.map(t => (
          <span key={t} style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 5px 3px 10px',
            borderRadius: RADIUS.full, background: `${PURPLE}16`, color: PURPLE,
            fontSize: TEXT.xs, fontWeight: FW.semibold,
          }}>
            {t}
            <button type="button" onClick={() => remove(t)} disabled={busy}
              aria-label={`Remove ${t}`} title={`Remove ${t}`}
              style={{
                border: 'none', background: 'none', padding: 0, cursor: busy ? 'wait' : 'pointer',
                color: PURPLE, display: 'inline-flex', alignItems: 'center', opacity: .75,
              }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>close</span>
            </button>
          </span>
        ))}

        {!adding && (
          <button type="button" onClick={() => setAdding(true)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px',
              borderRadius: RADIUS.full, border: '1px dashed var(--bdr)', background: 'none',
              color: 'var(--txt3)', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer',
            }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>add</span>
            {tags.length ? 'Add' : 'Add a label'}
          </button>
        )}
      </div>

      {adding && (
        <div style={{ marginTop: SP[2] }}>
          <Input
            label="New Label" autoFocus value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); add(draft) }
              if (e.key === 'Escape') { setDraft(''); setAdding(false) }
            }}
            placeholder="e.g. corporate, price objection, callback dec"
            hint="Stored lowercase so the same label cannot exist twice. Enter to add, Escape to cancel." />
          {unused.length > 0 && (
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: SP[2], alignItems: 'center' }}>
              <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>Already in use:</span>
              {unused.slice(0, 10).map(s => (
                <button key={s} type="button" onClick={() => add(s)} disabled={busy}
                  style={{
                    padding: '2px 9px', borderRadius: RADIUS.full, border: '1px solid var(--bdr)',
                    background: 'var(--card)', color: 'var(--txt2)', fontSize: TEXT['2xs'],
                    fontWeight: FW.semibold, cursor: 'pointer',
                  }}>{s}</button>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: SP[2] }}>
            <Button size="sm" variant="primary" loading={busy} onClick={() => add(draft)}>Add</Button>
            <Button size="sm" variant="secondary" onClick={() => { setDraft(''); setAdding(false) }}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Pieces ────────────────────────────────────────────────────────────────────

const STAGE_COLOR: Record<string, string> = {
  new: '#6B7280', contacted: BLUE, qualified: PURPLE, handed_to_sales: PURPLE,
  documents_requested: AMBER, application_submitted: AMBER, approved: GREEN,
  converted: GREEN, disqualified: RED,
}

function StagePill({ stage }: { stage: string }) {
  const c = STAGE_COLOR[stage] ?? '#6B7280'
  return (
    <span style={{
      padding: '4px 10px', borderRadius: RADIUS['2xl'], background: `${c}14`,
      color: c, fontSize: TEXT.xs, fontWeight: FW.bold, whiteSpace: 'nowrap',
    }}>{humanise(stage)}</span>
  )
}

// The lead's facts, split into the two questions an officer actually asks: how do I
// reach this person, and what is the deal. They used to run as one wide strip of up to
// eleven cells across the full page, which read as a spreadsheet row and left no room
// for anything beside it. In two columns they are a reference you can keep in view.
function Facts({ lead, group }: { lead: Lead; group: 'contact' | 'deal' }) {
  const contact: Array<[string, string | undefined]> = [
    ['Phone', lead.phone],
    ['Email', lead.email],
    ['Location', [lead.city, lead.state].filter(Boolean).join(', ') || undefined],
    ['Employer', lead.employer],
    ['Occupation', lead.occupation],
  ]
  const deal: Array<[string, string | undefined]> = [
    ['Interested In', lead.product_interest ? humanise(lead.product_interest) : undefined],
    ['Estimated Value', lead.estimated_value_kobo ? fmtKobo(lead.estimated_value_kobo) : undefined],
    ['Reached Sales Via', lead.sales_source ? humanise(lead.sales_source) : undefined],
    ['Reached Sales On', lead.sales_entered_at ? fmtDate(lead.sales_entered_at) : undefined],
    // Not humanised: campaign names are data, and title-casing "CRC July Campaign (FCT
    // Individuals)" would mangle a name someone chose deliberately.
    ['Campaign', lead.campaign_name
      ? lead.campaign_name + (lead.campaign_source === 'dialler' ? ' (call-centre list)' : '')
      : undefined],
    ['First Seen', lead.created_at ? fmtDate(lead.created_at) : undefined],
  ]
  // Only the facts this lead actually has — an empty cell reads as missing data rather
  // than as "not recorded", and a half-filled grid looks broken.
  const rows = (group === 'contact' ? contact : deal).filter(([, v]) => !!v)

  if (rows.length === 0) {
    return (
      <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>
        {group === 'contact'
          ? 'No contact details recorded. The call centre captures these when it qualifies a lead.'
          : 'Nothing recorded about the opportunity yet.'}
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.map(([k, v], i) => (
        <div key={k} style={{
          display: 'flex', alignItems: 'baseline', gap: SP[3], minWidth: 0,
          padding: `${SP[2]} 0`,
          borderTop: i === 0 ? 'none' : '1px solid var(--bdr)',
        }}>
          <div style={{
            fontSize: TEXT.xs, color: 'var(--txt3)', flex: '0 0 116px',
          }}>{k}</div>
          <div style={{
            fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', flex: 1,
          }}>{v}</div>
        </div>
      ))}
    </div>
  )
}

// StageRail — how far along the pipeline this lead has got.
//
// A single pill said "Interested" and nothing else: it could not say whether that was
// progress or a lead that had been stuck there for a month, and an officer had to know
// the stage order by heart to tell. The rail shows the whole journey with the passed
// steps filled, which is the same thing the activity dialog already does.
function StageRail({ stage }: { stage: string }) {
  const order = LEAD_STAGES.map(s => s.key)
  const closed = stage === 'converted' || stage === 'disqualified'
  const idx = order.indexOf(stage)
  const current = LEAD_STAGES.find(s => s.key === stage)

  if (closed) {
    const c = stage === 'converted' ? GREEN : RED
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], justifyContent: 'flex-end' }}>
        <span className="material-symbols-rounded" style={{ fontSize: 17, color: c }}>
          {stage === 'converted' ? 'verified' : 'cancel'}
        </span>
        <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: c }}>
          {current?.label ?? humanise(stage)}
        </span>
      </div>
    )
  }
  // Only the open stages are drawn; converted/disqualified are outcomes, not steps.
  const steps = LEAD_STAGES.filter(s => s.key !== 'converted' && s.key !== 'disqualified')
  return (
    <div>
      <div style={{ display: 'flex', gap: 3, marginBottom: 5 }}>
        {steps.map((s, i) => {
          const done = idx >= 0 && order.indexOf(s.key) <= idx
          return (
            <div key={s.key} title={s.label} style={{
              flex: 1, height: 4, borderRadius: 2,
              background: done ? (current?.color ?? NAVY) : 'var(--bdr)',
              opacity: done ? (order.indexOf(s.key) === idx ? 1 : 0.55) : 1,
            }} />
          )
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: SP[2] }}>
        <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: current?.color ?? 'var(--txt)' }}>
          {current?.label ?? humanise(stage)}
        </span>
        <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
          step {Math.max(1, idx + 1)} of {steps.length}
        </span>
      </div>
    </div>
  )
}

// NextStep — the dates, said in words rather than printed as timestamps.
//
// next_action_at and last_activity_at were two cells in the fact strip, formatted as
// datetimes and indistinguishable from the employer. They are the two things that decide
// whether this lead needs attention today, so they get their own card and read as
// "overdue by 3 days" rather than "12/10/2026, 09:00".
function NextStep({ lead }: { lead: Lead }) {
  const now = Date.now()
  const next = lead.next_action_at ? new Date(lead.next_action_at) : null
  const last = lead.last_activity_at ? new Date(lead.last_activity_at) : null
  const dayMs = 864e5
  const daysSince = last ? Math.floor((now - last.getTime()) / dayMs) : null
  const overdueDays = next ? Math.floor((now - next.getTime()) / dayMs) : null

  const nextTone = !next ? 'var(--txt3)'
    : overdueDays! > 0 ? RED
    : overdueDays === 0 ? AMBER
    : GREEN

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
      <div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 3 }}>Next action</div>
        <div style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: nextTone }}>
          {!next ? 'None scheduled'
            : overdueDays! > 0 ? `Overdue by ${overdueDays} day${overdueDays === 1 ? '' : 's'}`
            : overdueDays === 0 ? 'Due today'
            : fmtDate(lead.next_action_at!)}
        </div>
        {next && (
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>
            {fmtDatetime(lead.next_action_at!)}
          </div>
        )}
      </div>
      <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: SP[3] }}>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 3 }}>Last touched</div>
        <div style={{
          fontSize: TEXT.base, fontWeight: FW.semibold,
          color: daysSince != null && daysSince > 14 ? AMBER : 'var(--txt)',
        }}>
          {daysSince == null ? 'Never'
            : daysSince === 0 ? 'Today'
            : daysSince === 1 ? 'Yesterday'
            : `${daysSince} days ago`}
        </div>
        {daysSince != null && daysSince > 14 && (
          <div style={{ fontSize: TEXT.xs, color: AMBER, marginTop: 2 }}>
            Going cold — nothing logged in a fortnight.
          </div>
        )}
      </div>
    </div>
  )
}

function TimelineEntry({ row }: { row: TimelineRow }) {
  const c = teamColor(row.team)
  return (
    <div style={{ display: 'flex', gap: SP[2], padding: '6px 0', alignItems: 'flex-start' }}>
      <span className="material-symbols-rounded" aria-hidden style={{
        fontSize: 16, color: c, marginTop: 2, flexShrink: 0,
      }}>{typeIcon(row.type)}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium }}>
          {row.detail || humanise(row.type)}
          {row.outcome && (
            <span style={{ color: 'var(--txt3)', fontWeight: FW.normal }}> · {humanise(row.outcome)}</span>
          )}
        </div>
        {row.note && (
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 2, whiteSpace: 'pre-wrap' }}>{row.note}</div>
        )}
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 2 }}>
          {row.actor} · <span style={{ color: c }}>{teamLabel(row.team)}</span> ·{' '}
          {new Date(row.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  )
}

// ── Convert ───────────────────────────────────────────────────────────────────
//
// The product line is chosen first and decides what the reference means. Conversion used
// to demand a card CIF, which made a won loan or fixed deposit impossible to close —
// see migration 304.

function ConvertModal({ leadId, name, onClose, onDone }: {
  leadId: number; name: string; onClose: () => void; onDone: () => void
}) {
  const [line, setLine] = useState('cards')
  const [ref, setRef]   = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const refLabel = line === 'cards' ? 'Card CIF' : 'Udara Account Number'
  const refHint = line === 'cards'
    ? 'The customer must already exist in the card system.'
    : `The ${line === 'loans' ? 'loan' : 'deposit'} must already be booked in Udara.`

  async function save() {
    if (!ref.trim()) { toast.error(`${refLabel} is required`); return }
    setSaving(true)
    try {
      await apiPost(`/api/sales/leads/${leadId}/convert`, { line, ref: ref.trim(), note: note.trim() })
      toast.success('Lead converted'); onDone()
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }

  return (
    <Modal open onClose={onClose} title={`Convert ${name}`} width={460}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={save}>Convert</Button>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SelectMenuField label="What did they take?" value={line}
          onChange={v => { setLine(v); setRef('') }} options={PRODUCT_LINES} searchable={false} />
        <Input label={refLabel} value={ref} onChange={e => setRef(e.target.value)}
          hint={refHint} placeholder={line === 'cards' ? 'e.g. 00012345' : 'e.g. 1200045401000005670'} autoFocus />
        <Input label="Note (Optional)" value={note} onChange={e => setNote(e.target.value)}
          placeholder="Anything worth recording about the sale" />
      </div>
    </Modal>
  )
}

// ── Follow-up ─────────────────────────────────────────────────────────────────
//
// Posts to /api/activities with type='task' rather than to /api/crm/tasks, because that
// path creates the real crm_task AND the shadow activity that puts it on this lead's
// timeline — so a follow-up shows up in the lead's history, in the owner's Follow-Ups
// list and in the due-soon reminder, from one write. POST /api/crm/tasks is also gated on
// CRM page access, which a call-centre agent working a lead does not have.
//
// contact_id and lead_id are both sent with the same crm_contacts id: contact_id is what
// crm_tasks and the activity counters key on, lead_id is what stamps linked_type='lead'
// so the task knows what it is about.

const FOLLOW_PRIORITIES = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
]

/** Tomorrow, as YYYY-MM-DD — the default a follow-up almost always wants. */
function tomorrow(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function FollowUpModal({ leadId, name, onClose, onDone }: {
  leadId: number; name: string; onClose: () => void; onDone: () => void
}) {
  const [title, setTitle] = useState('')
  const [due, setDue] = useState(tomorrow())
  const [priority, setPriority] = useState('medium')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!title.trim()) { toast.error('Say what the follow-up is'); return }
    setSaving(true)
    try {
      await apiPost('/api/activities', {
        type: 'task',
        contact_id: leadId,
        lead_id: leadId,
        subject: title.trim(),
        body: note.trim(),
        due_at: due || undefined,
        priority,
      })
      toast.success('Follow-up raised'); onDone()
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }

  return (
    <Modal open onClose={onClose} title={`Follow Up — ${name}`} width={460}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={save}>Raise Follow-Up</Button>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input label="What needs doing?" value={title} onChange={e => setTitle(e.target.value)}
          placeholder="e.g. Call back with the card limit" autoFocus />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input label="Due" type="date" value={due} onChange={e => setDue(e.target.value)} />
          <SelectMenuField label="Priority" value={priority} onChange={setPriority}
            options={FOLLOW_PRIORITIES} searchable={false} />
        </div>
        <Input label="Note (Optional)" value={note} onChange={e => setNote(e.target.value)}
          placeholder="Context worth having when this comes back up" />
      </div>
    </Modal>
  )
}

// ── Transfer ──────────────────────────────────────────────────────────────────

function TransferModal({ leadId, name, officers, currentOwner, onClose, onDone }: {
  leadId: number; name: string; officers: Officer[]; currentOwner: number | null
  onClose: () => void; onDone: () => void
}) {
  const [to, setTo] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const options = officers
    .filter(o => o.is_active && o.id !== currentOwner)
    .map(o => ({ value: String(o.id), label: o.full_name, hint: o.role ? humanise(o.role) : undefined }))

  async function save() {
    if (!to) { toast.error('Choose an officer'); return }
    setSaving(true)
    try {
      const r = await apiPost<{ to_name?: string }>(`/api/sales/leads/${leadId}/transfer`,
        { to_user_id: Number(to), note: note.trim() })
      toast.success(`Transferred to ${r?.to_name ?? 'the officer'}`); onDone()
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }

  return (
    <Modal open onClose={onClose} title={`Transfer ${name}`} width={440}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={save}>Transfer</Button>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SelectMenuField label="Transfer To" value={to} onChange={setTo} options={options}
          placeholder="Choose an officer…" required />
        <Input label="Why (Optional)" value={note} onChange={e => setNote(e.target.value)}
          placeholder="e.g. Customer is already on Ada's book"
          hint="Recorded on the lead's history with both officers' names." />
      </div>
    </Modal>
  )
}

export default LeadDetail
