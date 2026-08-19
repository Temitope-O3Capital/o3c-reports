import { useLiveData } from "../../hooks/useRealtime"
import { useDebouncedValue } from '../../hooks/useDebounce'
import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from 'react' 
import {
  Page, ErrBanner, Spinner, TblSearch, filterInputStyle, ConfirmModal, Modal, NameCell,
} from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime, fmtNum } from '../../lib/fmt'
import { GREEN, AMBER, RED, BLUE, PURPLE, NAVY, NUM, INTER, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'
import { CallLogForm, callOutcomeLabel, groupCallConversations } from '../../components/LogCallModal'

// Heads/supervisors distribute and (re)assign leads; agents only work their own book.
function isHeadRole(): boolean {
  try { return /head|admin|super|manager|lead|supervisor/i.test(String(JSON.parse(localStorage.getItem('o3c_user') || '{}').role || '')) } catch { return false }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Lead {
  id:              number
  campaign_id:     number | null
  campaign_name:   string | null
  customer_cif:    string | null
  customer_name:   string
  customer_phone:  string | null
  employer:        string | null
  email:           string | null
  address:         string | null
  lead_score:      number
  status:          string
  assigned_to:     number | null
  agent_name:      string | null
  last_called_at:  string | null
  callback_at:     string | null
  notes:           string | null
  created_at:      string
  // last_outcome is the RAW telephony value ('completed', 'missed'). It is never
  // rendered directly — leadOutcomeLabel below turns it into something an agent
  // can read, using the duration and recording to tell a conversation from a dial.
  last_outcome:            string | null
  last_disposition:        string | null
  last_call_direction:     string | null
  last_call_duration_sec:  number | null
  last_call_recorded:      boolean | null
}

// The agent's own disposition is the truth when there is one; otherwise label the
// raw outcome the same way the call history does, so the two never disagree.
function leadOutcomeLabel(lead: Lead): string {
  const d = lead.last_disposition?.trim()
  if (d) return d
  if (!lead.last_outcome?.trim()) return ''
  return callOutcomeLabel(
    lead.last_outcome, lead.last_call_direction,
    lead.last_call_duration_sec, lead.last_call_recorded,
  )
}

interface CCCampaign { id: number; name: string }
interface CCAgent    { id: number; full_name: string }

// ── Helpers ────────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  pending:   '#6B7280',
  called:    BLUE,
  callback:  AMBER,
  no_answer: 'var(--chart-lbl)',
  converted: GREEN,
  dnc:       RED,
  // Distinct from 'not interested': a decline on our side (closed) and a timing
  // objection worth calling back are different states of the same lead.
  closed:    '#6B7280',
  invalid:   '#9CA3AF',
}

function StatusPill({ status }: { status: string }) {
  const c = STATUS_COLOR[status] ?? '#6B7280'
  const label = status.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())
  return (
    <span style={{ ...NUM, fontSize: TEXT['2xs'], fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: `${c}14`, color: c }}>
      {label}
    </span>
  )
}

// The private four-outcome vocabulary that used to live here is gone: lead calls
// now use the shared disposition list from LogCallModal, narrowed to the
// marketing book. OUTCOME_COLOR below still maps the historic values stored on
// existing leads.

const OUTCOME_COLOR: Record<string, string> = {
  interested:     GREEN,
  converted:      GREEN,
  not_interested: RED,
  callback:       AMBER,
  no_answer:      'var(--chart-lbl)',
  voicemail:      'var(--chart-lbl)',
  dnc:            RED,
}
 
// ── Lead call panel ───────────────────────────────────────────────────────────
// The Leads page used to carry its own four-field "Log Call" form (outcome,
// callback, duration, notes) posting to /api/call-center/leads/{id}/disposition,
// while every other screen used the shared Log-a-Call flow. A lead call therefore
// never captured a CIF, a disposition, a purpose or a follow-up ticket, and the
// two could drift apart indefinitely.
//
// It is still inline — that is the right shape for a detail pane, and it is one
// fewer click than a dialog — but it is now literally the same component the
// modal renders, tailored to leads: no customer picker (the pane above shows the
// lead), no direction (working a lead list is outbound), no purpose (marketing).
function LeadCallPanel({ lead, onDone }: { lead: Lead; onDone: () => void }) {
  return (
    <CallLogForm
      open
      variant="inline"
      onClose={() => { /* inline: nothing to dismiss */ }}
      onSaved={onDone}
      initial={{
        name:      lead.customer_name,
        phone:     lead.customer_phone ?? undefined,
        cif:       lead.customer_cif ?? undefined,
        direction: 'Outbound',
        purpose:   'marketing',
        leadId:    lead.id,
      }}
    />
  )
}

// ── Detail panel ──────────────────────────────────────────────────────────────

// Edit a lead's identity — the way a number-only import gets a name and details.
function EditLeadModal({ open, lead, onClose, onSaved }: {
  open: boolean; lead: Lead; onClose: () => void; onSaved: () => void
}) {
  const [name, setName]         = useState('')
  const [employer, setEmployer] = useState('')
  const [email, setEmail]       = useState('')
  const [cif, setCif]           = useState('')
  const [address, setAddress]   = useState('')
  const [saving, setSaving]     = useState(false)

  useEffect(() => {
    if (!open) return
    setName(lead.customer_name === lead.customer_phone ? '' : (lead.customer_name ?? ''))
    setEmployer(lead.employer ?? '')
    setEmail(lead.email ?? '')
    setCif(lead.customer_cif ?? '')
    setAddress(lead.address ?? '')
  }, [open, lead])

  async function save() {
    setSaving(true)
    try {
      await apiFetch(`/api/call-center/leads/${lead.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          customer_name: name.trim() || lead.customer_phone || '',
          employer, email, customer_cif: cif, address,
        }),
      })
      toast.success('Lead updated')
      onSaved()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  const inp: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: RADIUS.md, fontSize: TEXT.base, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 4 }

  return (
    <Modal open={open} onClose={onClose} title="Edit lead" width={460}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {lead.customer_phone && <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>Phone <strong style={{ color: 'var(--txt)', fontFamily: 'var(--font-mono)' }}>{lead.customer_phone}</strong></div>}
        <div><label style={lbl}>Name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="Full name" style={inp} autoFocus /></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label style={lbl}>Employer</label><input value={employer} onChange={e => setEmployer(e.target.value)} style={inp} /></div>
          <div><label style={lbl}>Email</label><input value={email} onChange={e => setEmail(e.target.value)} style={inp} /></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label style={lbl}>CIF (if a customer)</label><input value={cif} onChange={e => setCif(e.target.value)} style={inp} /></div>
          <div><label style={lbl}>Address</label><input value={address} onChange={e => setAddress(e.target.value)} style={inp} /></div>
        </div>
      </div>
    </Modal>
  )
}

interface LeadCall {
  id: number; started_at: string | null; direction: string | null; outcome: string | null
  duration_sec: number | null; agent_name: string; notes: string; disposition: string
  recording_filename: string | null
}

function DetailPanel({ lead, onRefresh }: { lead: Lead; onRefresh: () => void }) {
  const [editOpen, setEditOpen] = useState(false)
  // The log form is open by default only for a lead with no history — otherwise
  // reopening a lead lands you on what happened, not on a blank form.
  const [logOpen, setLogOpen] = useState(false)
  // A lead imported as a bare number shows its phone as the "name" — flag that so the
  // Edit control is obvious for exactly the rows that need a real name.
  const nameless = !lead.customer_name || lead.customer_name === lead.customer_phone

  // This lead's call history — refetched (via callKey) after a call is logged so the
  // agent sees the call they just logged, right here.
  const [calls, setCalls] = useState<LeadCall[]>([])
  const [callKey, setCallKey] = useState(0)
  useEffect(() => {
    let cancelled = false
    apiFetch<LeadCall[]>(`/api/call-center/leads/${lead.id}/calls`)
      .then(r => {
        if (cancelled) return
        const list = Array.isArray(r) ? r : []
        setCalls(list)
        // A lead nobody has called yet opens straight into the form; one with
        // history opens into the history.
        setLogOpen(list.length === 0)
      })
      .catch(() => { if (!cancelled) setCalls([]) })
    return () => { cancelled = true }
  }, [lead.id, callKey])

  // Zoho emits a row per activity, not per conversation, so one attempt on a lead
  // arrived here as four rows with three contradictory outcomes. Group the legs of
  // a dialling episode into the conversation they actually were.
  const conversations = useMemo(() => groupCallConversations(calls), [calls])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      {/* Contact header */}
      <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--bdr)', background: 'var(--th-bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <div style={{ fontSize: TEXT.lg, fontWeight: FW.bold, color: nameless ? 'var(--txt3)' : 'var(--txt)' }}>{nameless ? 'Unnamed lead' : lead.customer_name}</div>
          <button onClick={() => setEditOpen(true)} title="Edit lead details"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: RADIUS.md, border: `1px solid ${nameless ? AMBER : 'var(--bdr)'}`, background: nameless ? `${AMBER}12` : 'var(--card)', color: nameless ? AMBER : 'var(--txt2)', fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>edit</span>{nameless ? 'Add name' : 'Edit'}
          </button>
        </div>
        <EditLeadModal open={editOpen} lead={lead} onClose={() => setEditOpen(false)} onSaved={() => { setEditOpen(false); onRefresh() }} />
        {lead.customer_phone && (
          <div style={{ fontSize: TEXT.md, color: NAVY, fontWeight: FW.semibold, marginBottom: SP[1] }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md, verticalAlign: 'middle', marginRight: 4 }}>call</span>
            {lead.customer_phone}
          </div>
        )}
        <div style={{ display: 'flex', gap: SP[2], flexWrap: 'wrap', marginTop: 6 }}>
          <StatusPill status={lead.status} />
          {lead.campaign_name && (
            <span style={{ fontSize: TEXT.xs, background: `${PURPLE}14`, color: PURPLE, padding: '2px 8px', borderRadius: RADIUS['2xl'], fontWeight: FW.semibold }}>
              {lead.campaign_name}
            </span>
          )}
          {lead.agent_name && (
            <span style={{ fontSize: TEXT.xs, background: `${NAVY}10`, color: NAVY, padding: '2px 8px', borderRadius: RADIUS['2xl'], fontWeight: FW.semibold }}>
              {lead.agent_name}
            </span>
          )}
        </div>
      </div>

      {/* Lead info */}
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>Lead Info</div>
        {[
          ['CIF',          lead.customer_cif],
          ['Employer',     lead.employer],
          ['Lead Score',   String(lead.lead_score ?? 0)],
          ['Assigned To',  lead.agent_name],
          ['Last Called',  lead.last_called_at ? fmtDatetime(lead.last_called_at) : null],
          ['Callback At',  lead.callback_at ? fmtDatetime(lead.callback_at) : null],
          ['Last Outcome', leadOutcomeLabel(lead)],
          ['Notes',        lead.notes],
        ].map(([label, value]) =>
          value ? (
            <div key={label as string} style={{ display: 'flex', gap: SP[2], marginBottom: 7 }}>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)', minWidth: 90, flexShrink: 0 }}>{label}</span>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium }}>{value}</span>
            </div>
          ) : null
        )}
      </div>

      {/* Log a call.
          Collapsed by default once this lead has history: the common case on
          reopening a lead is READING what happened, not writing a new call, and a
          form sitting open invites a duplicate log. "Log another call" opens it. */}
      <div style={{ padding: `${SP[4]} ${SP[5]}` }}>
        {logOpen ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: SP[3] }}>
              <div style={{ flex: 1, fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Log Call
              </div>
              {calls.length > 0 && (
                <button onClick={() => setLogOpen(false)}
                  style={{ border: 'none', background: 'none', color: 'var(--txt2)', fontSize: TEXT.xs, cursor: 'pointer', fontFamily: INTER }}>
                  Cancel
                </button>
              )}
            </div>
            <LeadCallPanel
              lead={lead}
              onDone={() => {
                onRefresh()
                setCallKey(k => k + 1)
                setLogOpen(false)   // back to reading; the new call appears below
              }}
            />
          </>
        ) : (
          <button onClick={() => setLogOpen(true)}
            style={{ width: '100%', padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.md, border: `1px solid ${NAVY}`, background: 'var(--card)', color: NAVY, fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: INTER }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>add_call</span>
            Log another call
          </button>
        )}
      </div>

      {/* Call history — shows the call the agent just logged, in the same place */}
      <div style={{ padding: `0 ${SP[5]} ${SP[5]}` }}>
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: SP[2] }}>
          Call history{conversations.length ? ` (${conversations.length})` : ''}
        </div>
        {conversations.length === 0 ? (
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', padding: '8px 0' }}>No calls logged yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {conversations.map(({ call: c, attempts, firstAt, notes, disposition }) => {
              const inbound = (c.direction || '').toLowerCase() === 'inbound'
              // A dial that never connected is not a green tick. Empty means no
              // duration and no recording — nothing was said.
              const connected = (c.duration_sec ?? 0) > 0 || !!c.recording_filename
              const col = connected ? GREEN : RED
              const dur = c.duration_sec ? `${Math.floor(c.duration_sec / 60)}m ${c.duration_sec % 60}s` : null
              return (
                <div key={c.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid var(--bdr)' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 18, color: col, flexShrink: 0, marginTop: 1 }}>{inbound ? 'call_received' : 'call_made'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{disposition || callOutcomeLabel(c.outcome, c.direction, c.duration_sec, !!c.recording_filename)}</span>
                      {dur && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', ...NUM }}>{dur}</span>}
                      {/* The legs that reached nothing are still counted, so an
                          episode that took four dials to connect still says so. */}
                      {attempts > 1 && (
                        <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>
                          {attempts} attempts{connected ? ', last connected' : ''}
                        </span>
                      )}
                      <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginLeft: 'auto' }}>{firstAt ? fmtDatetime(firstAt) : ''}</span>
                    </div>
                    {notes && <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 2, lineHeight: 1.4 }}>{notes}</div>}
                    <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 2 }}>
                      {c.agent_name || 'Agent'}{c.recording_filename ? ' · recorded' : ''}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Import leads modal (heads/supervisors) ─────────────────────────────────────

// A lead is not a customer: no CIF (that is the card book's identity key, issued on
// conversion) and no employer. Phone is the only required column — everything else
// helps the agent, but a lead with no number cannot be called at all.
const LEAD_TEMPLATE = 'phone,name,email,address\n08012345678,Jane Doe,jane@example.com,"12 Adeola Odeku Victoria Island"\n08087654321,John Smith,,\n'

const NEW_CAMPAIGN = '__new__'

// A header row is optional in an uploaded file — drop it so it isn't imported as a lead.
function isHeaderLine(line: string): boolean {
  return /(^|,)\s*"?phone"?\s*(,|$)/i.test(line) || (/name/i.test(line) && /phone/i.test(line))
}

// Canonical Nigerian phone: 0 + the last 10 digits. The Go importer and
// app.normalise_ng_phone do exactly the same thing; this runs client-side purely so
// the uploader can see what will happen before committing to it.
function normaliseNGPhone(raw: string): string {
  const digits = (raw || '').replace(/\D/g, '')
  if (digits.length < 10) return ''
  return '0' + digits.slice(-10)
}

// Split one CSV line, honouring double quotes so an address containing a comma
// survives. The previous parser split on every comma, so "12 Adeola Odeku, VI"
// silently became two columns and shifted email into address.
function splitCSVLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      out.push(cur.trim()); cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur.trim())
  return out
}

interface ParsedLead { phone: string; name: string; email: string; address: string; rawPhone: string }

function ImportLeadsModal({ open, onClose, onDone, campaigns, onCampaignCreated }: {
  open: boolean; onClose: () => void; onDone: () => void; campaigns: CCCampaign[]
  onCampaignCreated: () => void
}) {
  const [campaignId, setCampaignId] = useState('')
  const [newCampaign, setNewCampaign] = useState('')
  const [raw, setRaw] = useState('')
  const [fileName, setFileName] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const creatingCampaign = campaignId === NEW_CAMPAIGN

  // Column order follows the template: phone, name, email, address. Only phone is
  // required — a lead with no number cannot be called, which is the whole point of
  // the outbound queue, so those rows are counted out loudly rather than imported
  // as unreachable dead weight.
  const allRows = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    .filter(l => !isHeaderLine(l))
    .map(line => {
      const [phone = '', name = '', email = '', address = ''] = splitCSVLine(line)
      return { phone: normaliseNGPhone(phone), name, email, address, rawPhone: phone } as ParsedLead
    })
  const parsed  = allRows.filter(l => l.phone !== '')
  const rejected = allRows.filter(l => l.phone === '')

  function reset() {
    setRaw(''); setFileName(''); setCampaignId(''); setNewCampaign(''); setErr(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  function downloadTemplate() {
    const blob = new Blob([LEAD_TEMPLATE], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'lead-list-template.csv'
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    // Replaces rather than appends. Appending was reasonable next to a paste box
    // the agent could see; with that box gone, picking a second file would
    // silently merge two lists with nothing on screen to show it had happened.
    reader.onload = () => {
      setRaw(String(reader.result ?? '').trim())
      setFileName(file.name)
    }
    reader.onerror = () => setErr('Could not read that file')
    reader.readAsText(file)
  }

  async function submit() {
    if (parsed.length === 0) { setErr('Add at least one row with a name or phone'); return }
    if (creatingCampaign && !newCampaign.trim()) { setErr('Name the new campaign'); return }
    setSaving(true); setErr(null)
    try {
      // Create the campaign first (marketing lead lists), then import into it.
      let targetCampaignId: number | undefined
      if (creatingCampaign) {
        const c = await apiPost<{ id: number }>('/api/call-center/campaigns', { name: newCampaign.trim(), purpose: 'marketing' })
        targetCampaignId = c?.id
        onCampaignCreated()
      } else if (campaignId) {
        targetCampaignId = Number(campaignId)
      }
      // Send only the four lead fields; rawPhone is a client-side display aid.
      const body: Record<string, any> = {
        leads: parsed.map(l => ({ phone: l.phone, name: l.name, email: l.email, address: l.address })),
      }
      if (targetCampaignId) body.campaign_id = targetCampaignId
      const res = await apiPost<{ inserted: number; attached: number; skipped: number; no_phone: number }>('/api/call-center/leads/import', body)
      // Name what happened. "12 skipped" alone leaves the uploader guessing whether
      // they were duplicates or bad rows; "attached" covers existing leads a re-upload
      // pulls into the chosen campaign.
      const bits = [`${res.inserted ?? 0} lead(s) uploaded`]
      if (res.attached) bits.push(`${res.attached} existing added to this campaign`)
      const dupes = (res.skipped ?? 0) - (res.no_phone ?? 0)
      if (dupes > 0) bits.push(`${dupes} already on the list`)
      if (res.no_phone) bits.push(`${res.no_phone} with no valid phone`)
      toast.success(bits.join(' · '))
      reset(); onDone(); onClose()
    } catch (e: any) { setErr(e.message ?? 'Upload failed') }
    finally { setSaving(false) }
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose() }} title="Upload Lead List" width={480}
      footer={
        <>
          <button onClick={() => { reset(); onClose() }} style={{ padding: '8px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving || parsed.length === 0}
            style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: (saving || !parsed.length) ? 'not-allowed' : 'pointer', opacity: (saving || !parsed.length) ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
            {saving && <Spinner size={13} color="#fff" />}Upload{parsed.length ? ` ${parsed.length}` : ''}
          </button>
        </>
      }
    >
      <ErrBanner error={err} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Campaign — pick an existing one or create a new one inline */}
        <div>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Campaign</label>
          <select value={campaignId} onChange={e => setCampaignId(e.target.value)}
            style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' }}>
            <option value="">No campaign</option>
            {campaigns.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
            <option value={NEW_CAMPAIGN}>+ New campaign…</option>
          </select>
          {creatingCampaign && (
            <input value={newCampaign} onChange={e => setNewCampaign(e.target.value)} autoFocus
              placeholder="New campaign name" spellCheck={false}
              style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box', marginTop: 6 }} />
          )}
        </div>

        {/* Template + file upload */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={downloadTemplate}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>download</span>
            Download template
          </button>
          <button type="button" onClick={() => fileRef.current?.click()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>upload_file</span>
            Upload CSV file
          </button>
          <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" onChange={onPickFile} style={{ display: 'none' }} />
        </div>

        {fileName && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: TEXT.sm, color: 'var(--txt)' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md, color: GREEN }}>description</span>
            <span style={{ fontWeight: FW.semibold }}>{fileName}</span>
            <button type="button" onClick={() => { setRaw(''); setFileName(''); if (fileRef.current) fileRef.current.value = '' }}
              style={{ marginLeft: 'auto', border: 'none', background: 'none', color: 'var(--txt2)', cursor: 'pointer', fontSize: TEXT.xs }}>Remove</button>
          </div>
        )}
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
          {parsed.length} valid row(s) detected · duplicates by phone are skipped
        </div>
      </div>
    </Modal>
  )
}

// ── Assign-to-agent modal (heads) ──────────────────────────────────────────────
// Count-based hand-off of unassigned pending leads to one agent — the same "Assign to
// agent" action the Outbound Queue offers, for parity.

const ASSIGN_PRESETS = [20, 50, 100, 200]

function AssignLeadsModal({ open, onClose, onDone, agents, campaigns, defaultCampaignId }: {
  open: boolean; onClose: () => void; onDone: () => void
  agents: CCAgent[]; campaigns: CCCampaign[]; defaultCampaignId: string
}) {
  const [agentId, setAgentId] = useState('')
  const [count, setCount] = useState(50)
  const [campaignId, setCampaignId] = useState(defaultCampaignId)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { if (open) { setCampaignId(defaultCampaignId); setAgentId(''); setErr(null) } }, [open, defaultCampaignId])

  async function submit() {
    if (!agentId) { setErr('Pick an agent'); return }
    if (!count || count < 1) { setErr('Enter a count'); return }
    setSaving(true); setErr(null)
    try {
      const body: Record<string, any> = { agent_id: Number(agentId), count }
      if (campaignId) body.campaign_id = Number(campaignId)
      const res = await apiPost<{ assigned: number }>('/api/call-center/leads/assign-batch', body)
      const name = agents.find(a => a.id === Number(agentId))?.full_name ?? 'agent'
      toast.success(`Assigned ${res.assigned ?? 0} lead(s) to ${name}`)
      onClose(); onDone()
    } catch (e: any) { setErr(e.message ?? 'Assign failed') }
    finally { setSaving(false) }
  }

  const fld: React.CSSProperties = { width: '100%', height: 38, padding: '0 11px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.03em' }

  return (
    <Modal open={open} onClose={onClose} title="Assign leads to an agent" width={460}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.medium, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: saving ? 'wait' : 'pointer' }}>
            {saving && <Spinner size={13} color="#fff" />}Assign {count}
          </button>
        </div>
      }>
      <ErrBanner error={err} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        <div>
          <label style={lbl}>Agent</label>
          <select value={agentId} onChange={e => setAgentId(e.target.value)} style={fld}>
            <option value="">Select an agent…</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>How many</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {ASSIGN_PRESETS.map(p => (
              <button key={p} onClick={() => setCount(p)} style={{
                padding: '7px 13px', borderRadius: RADIUS.md, cursor: 'pointer', fontSize: TEXT.sm, fontWeight: FW.semibold,
                border: `1px solid ${count === p ? NAVY : 'var(--bdr)'}`, background: count === p ? `${NAVY}0e` : 'var(--card)', color: count === p ? NAVY : 'var(--txt2)',
              }}>{p}</button>
            ))}
            <input type="number" min={1} max={5000} value={count} onChange={e => setCount(Math.max(1, Math.min(5000, Number(e.target.value) || 0)))}
              style={{ ...fld, width: 90, height: 34 }} title="Custom count" />
          </div>
        </div>
        {campaigns.length > 0 && (
          <div>
            <label style={lbl}>Campaign</label>
            <select value={campaignId} onChange={e => setCampaignId(e.target.value)} style={fld}>
              <option value="">All campaigns</option>
              {campaigns.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
          Assigns the highest-scored, oldest unassigned pending leads that aren’t already assigned.
        </div>
      </div>
    </Modal>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 100

export default function CallCenterLeads() {
  const [leads, setLeads]         = useState<Lead[]>([])
  const [campaigns, setCampaigns] = useState<CCCampaign[]>([])
  const [agents, setAgents]       = useState<CCAgent[]>([])
  const [loading, setLoading]     = useState(true)
  const [err, setErr]             = useState<string | null>(null)
  const [selected, setSelected]   = useState<Lead | null>(null)

  // Filters
  const [campaignId, setCampaignId] = useState('')
  const [status, setStatus]         = useState('')
  const [search, setSearch]         = useState('')

  // Pagination — real server-side paging, so a campaign of any size loads fully.
  const [offset, setOffset] = useState(0)
  const [total, setTotal]   = useState(0)

  const isHead = isHeadRole()

  // Selection
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set())
  const [assignAgentId, setAssignAgentId] = useState('')

  // Assign actions
  const [assigning, setAssigning]       = useState(false)
  const [distributing, setDistributing] = useState(false)
  const [distributeConfirm, setDistributeConfirm] = useState(false)
  const [importOpen, setImportOpen]     = useState(false)
  const [assignOpen, setAssignOpen]     = useState(false)

  const dq = useDebouncedValue(search, 300) // one request per pause, not per keystroke
  // silent: a background refresh must not blank the list underneath the agent —
  // and must not remount the log form they are typing into.
  const load = useCallback(async (refreshSelected?: number, silent = false) => {
    if (!silent) setLoading(true)
    setErr(null)
    const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
    if (campaignId) p.set('campaign_id', campaignId)
    if (status)     p.set('status', status)
    if (dq)         p.set('search', dq)
    try {
      // The endpoint returns a paginated envelope {data,total}; tolerate a bare array
      // for safety in case of a stale build.
      const res = await apiFetch<{ data: Lead[]; total: number } | Lead[]>(`/api/call-center/leads?${p}`)
      const fresh = Array.isArray(res) ? res : (res?.data ?? [])
      setLeads(fresh)
      setTotal(Array.isArray(res) ? fresh.length : (res?.total ?? fresh.length))
      if (refreshSelected !== undefined) {
        const updated = fresh.find(l => l.id === refreshSelected)
        setSelected(prev => updated ?? prev)
      }
    } catch (ex: any) { setErr(ex.message) }
    finally { setLoading(false) }
  }, [campaignId, status, dq, offset])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(undefined, true), { topics: ['calls', 'crm'] })
  // Filters change → back to the first page.
  useEffect(() => { setOffset(0) }, [campaignId, status, dq])

  const loadCampaigns = useCallback(() => {
    apiFetch<CCCampaign[]>('/api/call-center/campaigns')
      .then(r => setCampaigns(Array.isArray(r) ? r : [])).catch(() => {})
  }, [])

  useEffect(() => {
    loadCampaigns()
    apiFetch<CCAgent[]>('/api/call-center/agents')
      .then(r => setAgents(Array.isArray(r) ? r : [])).catch(() => {})
  }, [loadCampaigns])

  function handleRefresh() {
    load(selected?.id)
  }

  function toggleCheck(id: number, e: React.MouseEvent) {
    e.stopPropagation()
    setCheckedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function clearChecked() {
    setCheckedIds(new Set())
    setAssignAgentId('')
  }

  async function handleAssign() {
    if (!assignAgentId || checkedIds.size === 0) return
    setAssigning(true)
    try {
      const res = await apiPost<{ assigned: number }>('/api/call-center/leads/bulk-assign', {
        lead_ids: [...checkedIds],
        agent_id: Number(assignAgentId),
      })
      const agentName = agents.find(a => a.id === Number(assignAgentId))?.full_name ?? 'agent'
      toast.success(`${res.assigned} lead(s) assigned to ${agentName}`)
      clearChecked()
      load()
    } catch (ex: any) {
      toast.error(ex.message ?? 'Assign failed')
    } finally {
      setAssigning(false)
    }
  }

  async function handleDistribute() {
    setDistributing(true)
    setDistributeConfirm(false)
    try {
      const body: Record<string, any> = {}
      if (campaignId) body.campaign_id = Number(campaignId)
      const res = await apiPost<{ distributed: number; online_only?: boolean; breakdown: { agent_name: string; count: number }[] }>(
        '/api/call-center/leads/distribute', body
      )
      if (res.distributed === 0) {
        toast.info('No unassigned pending leads to distribute')
      } else {
        const summary = res.breakdown.map(b => `${b.agent_name}: ${b.count}`).join(', ')
        toast.success(`${res.distributed} leads distributed ${res.online_only ? 'to online agents' : '(nobody online, spread across all)'}: ${summary}`)
        load()
      }
    } catch (ex: any) {
      toast.error(ex.message ?? 'Distribute failed')
    } finally {
      setDistributing(false)
    }
  }

  const pending   = leads.filter(l => l.status === 'pending').length
  const callbacks = leads.filter(l => l.status === 'callback').length
  const converted = leads.filter(l => l.status === 'converted').length
  const unassigned = leads.filter(l => !l.assigned_to).length

  const selectedCampaignName = campaigns.find(c => String(c.id) === campaignId)?.name ?? 'All Campaigns'

  return (
    <Page title="Leads" subtitle="Contacts pushed from email & SMS campaigns, or uploaded here" noPad
      actions={
        isHead ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
            <button onClick={() => setImportOpen(true)} title="Upload a lead list"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: 'var(--card)', color: 'var(--txt2)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>upload_file</span>
              Upload leads
            </button>
            <button onClick={() => setAssignOpen(true)} title="Assign a batch of leads to one agent"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: NAVY, color: '#fff', border: `1px solid ${NAVY}`, borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>assignment_ind</span>
              Assign to agent
            </button>
          </div>
        ) : undefined
      }
    >
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

        {/* ── Left panel ──────────────────────────────────────────────────── */}
        <div style={{ width: 380, minWidth: 320, maxWidth: 420, borderRight: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', background: 'var(--card)', flexShrink: 0 }}>
          {/* Header */}
          <div style={{ padding: '14px 14px 10px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
            {/* Title row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: 10 }}>
              <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)', flex: 1 }}>Marketing Leads</span>
              <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, background: 'var(--chip-bg)', color: 'var(--chip-txt)', padding: '1px 7px', borderRadius: RADIUS['2xl'] }}>
                {fmtNum(total)}
              </span>
              {/* Distribute button — heads/supervisors only. */}
              {isHead && (
              <button
                onClick={() => setDistributeConfirm(true)}
                disabled={distributing || unassigned === 0}
                title={unassigned === 0 ? 'No unassigned leads' : `Distribute ${unassigned} unassigned lead(s) round-robin`}
                style={{
                  display: 'flex', alignItems: 'center', gap: SP[1],
                  padding: '4px 9px', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold,
                  border: `1px solid ${NAVY}30`, background: 'none',
                  color: unassigned === 0 ? 'var(--txt3)' : NAVY,
                  cursor: unassigned === 0 ? 'not-allowed' : 'pointer',
                }}
              >
                {distributing ? <Spinner size={12} color={NAVY} /> : (
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.base }}>shuffle</span>
                )}
                Distribute
              </button>
              )}
            </div>

            {/* Mini stats */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              {[
                { label: 'Pending',    value: pending,    color: '#6B7280' },
                { label: 'Callbacks',  value: callbacks,  color: AMBER },
                { label: 'Converted',  value: converted,  color: GREEN },
                { label: 'Unassigned', value: unassigned, color: RED },
              ].map(s => (
                <div key={s.label} style={{ flex: 1, textAlign: 'center', background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: '6px 2px' }}>
                  <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold, color: s.color }}>{s.value}</div>
                  <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Search */}
            <TblSearch value={search} onChange={setSearch}
              placeholder="Search name, phone…" width={0} style={{ marginBottom: SP[2] }} />

            {/* Campaign dropdown */}
            {campaigns.length > 0 && (
              <select value={campaignId} onChange={e => setCampaignId(e.target.value)}
                style={{ width: '100%', marginBottom: 6, padding: '6px 10px', borderRadius: RADIUS.md, border: '1px solid var(--input-bdr)', background: 'var(--input-bg)', fontSize: TEXT.sm, color: 'var(--txt)', outline: 'none' }}>
                <option value="">All Campaigns</option>
                {campaigns.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
              </select>
            )}

            {/* Status chips */}
            <div style={{ display: 'flex', gap: SP[1], flexWrap: 'wrap' }}>
              {[
                { value: 'pending',   label: 'Pending',   color: '#6B7280' },
                { value: 'called',    label: 'Called',    color: BLUE },
                { value: 'callback',  label: 'Callback',  color: AMBER },
                { value: 'no_answer', label: 'No Answer', color: RED },
                { value: 'converted', label: 'Converted', color: GREEN },
                { value: 'dnc',       label: 'DNC',       color: PURPLE },
              ].map(({ value, label, color }) => {
                const on = status === value
                return (
                  <button key={value} onClick={() => setStatus(on ? '' : value)} style={{
                    fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS.full,
                    border: `1px solid ${on ? color : 'var(--bdr)'}`,
                    background: on ? `${color}18` : 'transparent',
                    color: on ? color : 'var(--txt3)', cursor: 'pointer',
                  }}>{label}</button>
                )
              })}
              {(status || search || campaignId) && (
                <button onClick={() => { setStatus(''); setSearch(''); setCampaignId('') }} style={{
                  fontSize: TEXT['2xs'], fontWeight: FW.medium, padding: '2px 8px', borderRadius: RADIUS.full,
                  border: '1px solid var(--bdr)', background: 'none', color: 'var(--txt3)', cursor: 'pointer',
                }}>Clear</button>
              )}
            </div>
          </div>

          {/* Batch (re)assign bar — heads/supervisors only. */}
          {isHead && checkedIds.size > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 10px', background: '#F0F4FF',
              borderBottom: '1px solid var(--bdr)', flexShrink: 0,
            }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY, whiteSpace: 'nowrap' }}>
                {checkedIds.size} selected
              </span>
              <select
                value={assignAgentId}
                onChange={e => setAssignAgentId(e.target.value)}
                style={{ flex: 1, padding: `${SP[1]} ${SP[2]}`, borderRadius: RADIUS.sm, border: `1px solid ${NAVY}30`, background: 'var(--input-bg)', fontSize: TEXT.sm, color: 'var(--txt)', outline: 'none', minWidth: 0 }}
              >
                <option value="">Assign to…</option>
                {agents.map(a => <option key={a.id} value={String(a.id)}>{a.full_name}</option>)}
              </select>
              <button
                onClick={handleAssign}
                disabled={!assignAgentId || assigning}
                style={{
                  padding: '4px 10px', borderRadius: RADIUS.sm, border: 'none',
                  background: !assignAgentId || assigning ? `${NAVY}40` : NAVY,
                  color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold,
                  cursor: !assignAgentId || assigning ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5,
                }}
              >
                {assigning && <Spinner size={11} color="#fff" />}
                Assign
              </button>
              <button
                onClick={clearChecked}
                style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)', borderRadius: '50%', flexShrink: 0 }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>close</span>
              </button>
            </div>
          )}

          {err && <div style={{ padding: '8px 14px' }}><ErrBanner error={err} onRetry={load} /></div>}

          {/* Lead list */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, gap: 10, color: 'var(--txt2)', fontSize: TEXT.base }}>
                <Spinner size={16} color={NAVY} /> Loading…
              </div>
            ) : leads.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--txt2)', fontSize: TEXT.base }}>
                No leads yet. Push contacts from a campaign report.
              </div>
            ) : leads.map(lead => {
              const isSelected = selected?.id === lead.id
              const isChecked  = checkedIds.has(lead.id)
              const oc = OUTCOME_COLOR[lead.last_outcome ?? ''] ?? '#6B7280'
              return (
                <div
                  key={lead.id}
                  onClick={() => setSelected(lead)}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 0,
                    borderBottom: '1px solid var(--bdr)', cursor: 'pointer',
                    background: isSelected ? `${NAVY}08` : undefined,
                  }}
                  onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                  onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = '' }}
                >
                  {/* Checkbox */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', padding: '12px 8px', flexShrink: 0 }}>
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onClick={e => toggleCheck(lead.id, e)}
                      onChange={() => {}}
                      style={{ marginTop: 1, cursor: 'pointer', accentColor: NAVY }}
                    />
                  </div>

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0, padding: '10px 12px 10px 2px' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 3 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <NameCell name={lead.customer_name} sub={lead.customer_phone ?? undefined} avatar={false} />
                      </div>
                      <StatusPill status={lead.status} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {lead.campaign_name && (
                        <span style={{ fontSize: TEXT['2xs'], color: PURPLE }}>{lead.campaign_name}</span>
                      )}
                      {lead.agent_name ? (
                        <span style={{ fontSize: TEXT['2xs'], color: NAVY, fontWeight: FW.semibold }}>
                          <span className="material-symbols-rounded" style={{ fontSize: TEXT.xs, verticalAlign: 'middle' }}>person</span>
                          {' '}{lead.agent_name}
                        </span>
                      ) : (
                        <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontStyle: 'italic' }}>unassigned</span>
                      )}
                    </div>
                    {(lead.last_outcome || lead.last_called_at) && (
                      <div style={{ display: 'flex', gap: SP[2], alignItems: 'center', marginTop: 3 }}>
                        {lead.last_outcome && (
                          <span style={{ fontSize: TEXT['2xs'], color: oc, fontWeight: FW.semibold }}>{leadOutcomeLabel(lead)}</span>
                        )}
                        {lead.last_called_at && (
                          <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{fmtDatetime(lead.last_called_at)}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Pagination — real server-side paging over the whole campaign */}
          {total > PAGE_SIZE && (
            <div style={{ flexShrink: 0, borderTop: '1px solid var(--bdr)', padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', ...NUM }}>
                {fmtNum(offset + 1)}–{fmtNum(Math.min(offset + PAGE_SIZE, total))} of {fmtNum(total)}
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  style={{ padding: '4px 10px', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: offset === 0 ? 'default' : 'pointer', border: '1px solid var(--bdr)', background: 'var(--card)', color: offset === 0 ? 'var(--txt3)' : 'var(--txt)', opacity: offset === 0 ? 0.5 : 1 }}>Prev</button>
                <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}
                  style={{ padding: '4px 10px', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: offset + PAGE_SIZE >= total ? 'default' : 'pointer', border: '1px solid var(--bdr)', background: 'var(--card)', color: offset + PAGE_SIZE >= total ? 'var(--txt3)' : 'var(--txt)', opacity: offset + PAGE_SIZE >= total ? 0.5 : 1 }}>Next</button>
              </div>
            </div>
          )}
        </div>

        {/* ── Right panel ─────────────────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0, background: 'var(--bg)', overflow: 'auto' }}>
          {selected ? (
            <DetailPanel key={selected.id} lead={selected} onRefresh={handleRefresh} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: SP[3], color: 'var(--txt2)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 48, color: 'var(--txt3)' }}>contacts</span>
              <span style={{ fontSize: TEXT.md }}>Select a lead to log a call</span>
            </div>
          )}
        </div>
      </div>

      {/* Upload lead list — heads/supervisors */}
      <ImportLeadsModal open={importOpen} onClose={() => setImportOpen(false)} onDone={load} campaigns={campaigns} onCampaignCreated={loadCampaigns} />

      {/* Assign a batch of leads to one agent (heads) */}
      <AssignLeadsModal open={assignOpen} onClose={() => setAssignOpen(false)} onDone={load}
        agents={agents} campaigns={campaigns} defaultCampaignId={campaignId} />

      {/* Distribute confirm modal */}
      <ConfirmModal
        open={distributeConfirm}
        title="Distribute Leads Round-Robin"
        body={`Assign all ${unassigned} unassigned pending lead(s) from "${selectedCampaignName}" evenly across your call center agents?`}
        confirmLabel="Distribute"
        loading={distributing}
        onConfirm={handleDistribute}
        onClose={() => setDistributeConfirm(false)}
      />
    </Page>
  )
}
