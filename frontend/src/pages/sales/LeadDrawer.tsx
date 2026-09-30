import { useCallback, useEffect, useMemo, useState } from 'react'
import { Drawer } from '../../components/Drawer'
import { Button, Modal, Input, Spinner, Avatar, EmptyState } from '../../components/UI'
import { SelectMenu, SelectMenuField } from '../../components/SelectMenu'
import { apiFetch, apiPost } from '../../lib/api'
import { toast } from 'sonner'
import { NAVY, GREEN, RED, AMBER, PURPLE, BLUE, TEXT, FW, RADIUS, SP, NUM } from '../../lib/design'
import { fmtKobo, fmtDatetime, fmtDate } from '../../lib/fmt'
import { humanLabel } from '../../lib/labels'

// The lead record, opened from the Leads queue.
//
// The page it replaces showed a row and a stage, and every question an officer actually
// has about a lead — has anyone rung them, what did they say, who had this before me,
// what are they even interested in — needed a different screen or could not be answered
// at all. The drawer puts the facts, the actions and the full history in one place.
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
const teamLabel = (t: string) => TEAM_LABEL[t] ?? t.replace(/_/g, ' ')

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

export function LeadDrawer({ leadId, officers, meId, canManage, onClose, onChanged }: {
  leadId: number | null
  officers: Officer[]
  meId: number
  canManage: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const [lead, setLead] = useState<Lead | null>(null)
  const [timeline, setTimeline] = useState<TimelineRow[]>([])
  const [loading, setLoading] = useState(false)
  const [convertOpen, setConvertOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [followOpen, setFollowOpen] = useState(false)

  const load = useCallback(async () => {
    if (!leadId) return
    setLoading(true)
    try {
      const [l, t] = await Promise.all([
        apiFetch<{ data: Lead } | Lead>(`/api/sales/leads/${leadId}`),
        apiFetch<{ data: TimelineRow[] } | TimelineRow[]>(`/api/sales/leads/${leadId}/timeline`),
      ])
      setLead((l as any)?.data ?? (l as Lead))
      const rows = Array.isArray(t) ? t : (t?.data ?? [])
      setTimeline(rows)
    } catch (e: any) { toast.error(e.message) }
    finally { setLoading(false) }
  }, [leadId])
  useEffect(() => { if (leadId) load() }, [leadId, load])

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
    <Drawer open={!!leadId} onClose={onClose} title={name}>
      {loading && !lead ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}><Spinner size={26} /></div>
      ) : !lead ? (
        <EmptyState icon="person_off" title="Lead not found"
          description="It may have been converted, disqualified or transferred out of your queue." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>

          {/* Identity + ownership */}
          <div style={{ display: 'flex', alignItems: 'center', gap: SP[3], flexWrap: 'wrap' }}>
            <Avatar name={name} size={40} />
            <div style={{ flex: '1 1 180px', minWidth: 0 }}>
              <div style={{ fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)' }}>{name}</div>
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
                {lead.owner_name
                  ? <>Owned by <strong>{lead.owner_name}</strong>{isMine && ' (you)'}</>
                  : <span style={{ color: AMBER, fontWeight: FW.semibold }}>Unclaimed</span>}
              </div>
            </div>
            <StagePill stage={lead.lead_stage} />
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

          <Facts lead={lead} />

          {/* Labels. Editable here because this is where an officer is looking at the lead
              and forming the opinion the label records. Anyone who can see the lead can
              label it: a tag is a note, not a state change, and gating it behind ownership
              would leave a head unable to mark up the pool they are about to distribute. */}
          {/* Array.isArray rather than ?? []: tags is a Postgres text[] and a non-array
              would reach .map inside the editor. See pgTextArray in sales_leads.go. */}
          <TagEditor leadId={lead.id} tags={Array.isArray(lead.tags) ? lead.tags : []} onChanged={refresh} />

          {/* History */}
          <div>
            <div style={{
              display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: SP[2],
            }}>
              <h3 style={{ margin: 0, fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>History</h3>
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                {timeline.length} entr{timeline.length === 1 ? 'y' : 'ies'} · every team
              </span>
            </div>

            {timeline.length === 0 ? (
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', padding: `${SP[3]} 0` }}>
                Nothing recorded against this lead yet.
              </div>
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
          </div>
        </div>
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
    </Drawer>
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
      setDraft(''); setAdding(false); onChanged()
    } catch (e: any) { toast.error(e?.message ?? 'Could not add that label') }
    finally { setBusy(false) }
  }, [leadId, tags, onChanged])

  const remove = useCallback(async (tag: string) => {
    setBusy(true)
    try {
      await apiFetch(`/api/sales/leads/${leadId}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' })
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

function Facts({ lead }: { lead: Lead }) {
  const all: Array<[string, string | undefined]> = [
    ['Phone', lead.phone],
    ['Email', lead.email],
    ['Interested In', lead.product_interest ? humanise(lead.product_interest) : undefined],
    ['Estimated Value', lead.estimated_value_kobo ? fmtKobo(lead.estimated_value_kobo) : undefined],
    ['Employer', lead.employer],
    ['Occupation', lead.occupation],
    ['Location', [lead.city, lead.state].filter(Boolean).join(', ') || undefined],
    ['Reached Sales Via', lead.sales_source ? humanise(lead.sales_source) : undefined],
    ['Reached Sales On', lead.sales_entered_at ? fmtDate(lead.sales_entered_at) : undefined],
    // Not humanised: campaign names are data, and title-casing "CRC July Campaign (FCT
    // Individuals)" would mangle a name someone chose deliberately.
    ['Campaign', lead.campaign_name
      ? lead.campaign_name + (lead.campaign_source === 'dialler' ? ' (call-centre list)' : '')
      : undefined],
    ['Next Action', lead.next_action_at ? fmtDatetime(lead.next_action_at) : undefined],
  ]
  // Only the facts this lead actually has — an empty grid cell reads as missing data
  // rather than as "not recorded", and a half-filled grid looks broken.
  const rows = all.filter(([, v]) => !!v)

  if (rows.length === 0) return null
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: SP[3],
      padding: SP[3], background: 'var(--bg)', borderRadius: RADIUS.lg,
    }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ minWidth: 0 }}>
          <div style={{
            fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'var(--txt3)',
            textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2,
          }}>{k}</div>
          <div style={{
            fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium,
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{v}</div>
        </div>
      ))}
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

export default LeadDrawer
