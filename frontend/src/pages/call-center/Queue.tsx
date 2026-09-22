import { useLiveData } from "../../hooks/useRealtime"
import { useDebouncedValue } from '../../hooks/useDebounce'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Page, ErrBanner, Spinner, ConfirmModal, Modal, TblSearch, NameCell,
} from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDate, fmtDatetime } from '../../lib/fmt'
import { GREEN, AMBER, RED, DARKRED, BLUE, PURPLE, NAVY, NUM, INTER, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { toast } from 'sonner'
import CallLogEditModal, { type EditableCall } from '../../components/CallLogEditModal'
import { RecordingModal } from '../../components/RecordingPlayer'
import { CallLogForm } from '../../components/LogCallModal'
import { isCallCentreSupervisor } from '../../lib/roles'

// Dial through the in-app softphone (CallWidget listens for 'o3c:dial'), the same way
// the Inbound page calls back. A tel: link handed the number to the OS, so the call
// never reached the ledger and the queue stayed blind to it.
function dialNumber(phone: string) {
  const n = (phone || '').trim()
  if (!n) { toast.error('No number to call'); return }
  window.dispatchEvent(new CustomEvent('o3c:dial', { detail: { phoneNumber: n, autoStart: true } }))
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Purpose = 'marketing' | 'collections' | 'support'

interface CallCenterContact {
  id: number
  customer_name: string
  phone: string
  cif: string | null
  product_name: string | null
  state: string | null
  priority: 'High' | 'Medium' | 'Low'
  outstanding_kobo: number
  dpd: number
  last_disposition: string | null
  last_called_at: string | null
  is_existing_customer: boolean
  loan_product: string | null
  next_payment_date: string | null
  purpose: Purpose
  source: string | null
  ref: string | null
  // Call-derived (migration 144). These come from helpdesk_calls, the real call
  // ledger — the queue used to be blind to any call an agent placed via the carrier.
  attempts: number
  connects: number
  last_call_outcome: string | null
  is_cooling: boolean    // dialled inside the cooldown window; rest it
  is_exhausted: boolean  // many attempts, never once answered
  disposition_code: string | null
  callback_at: string | null
  callback_due: boolean  // the agreed callback time has passed — serve it first
}

interface CallEntry {
  id: number
  called_at: string
  duration_seconds: number
  disposition: string
  resolution?: string | null
  agent_name: string
  notes: string | null
  direction?: string | null
  purpose?: string | null
  recording_url?: string | null
  log_source?: string | null
}

interface QueueSummary {
  total: number; uncalled: number; contacted: number
  callbacks: number      // scheduled, any time
  callbacks_due: number  // the agreed time has passed
  ready: number; cooling: number; exhausted: number
  marketing?: number; collections?: number; support?: number
}

// The working buckets. "ready" is what an agent should dial now; the rest exist so a
// supervisor can see — and act on — the part of the backlog that should not be dialled.
type Bucket = '' | 'ready' | 'uncalled' | 'cooling' | 'exhausted'

// Purpose presentation — colors + labels for the segmentation tabs and row tags.
const PURPOSE_META: Record<Purpose, { label: string; color: string; icon: string }> = {
  marketing:   { label: 'Marketing',   color: BLUE,  icon: 'campaign' },
  collections: { label: 'Collections', color: RED,   icon: 'account_balance_wallet' },
  support:     { label: 'Support',     color: GREEN, icon: 'support_agent' },
}

// A contact carries collections context (outstanding / DPD) only when it's an
// existing customer with a live balance. Telemarketing leads have neither, so the
// UI must not render misleading "₦0.00 / DPD 0" for them.
function hasCollectionsContext(c: CallCenterContact): boolean {
  return c.is_existing_customer && c.outstanding_kobo > 0
}
function isGenericProduct(p: string | null): boolean {
  const v = (p || '').trim().toLowerCase()
  return v === '' || v === 'zoho lead'
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dpdBg(dpd: number): string {
  if (dpd === 0) return GREEN
  if (dpd <= 30) return AMBER
  if (dpd <= 90) return RED
  return DARKRED
}

// ── Atoms ─────────────────────────────────────────────────────────────────────

function DpdBadge({ dpd }: { dpd: number }) {
  const color = dpdBg(dpd)
  return (
    <span style={{
      ...NUM, display: 'inline-flex', alignItems: 'center',
      fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 7px', borderRadius: RADIUS['2xl'],
      background: `${color}18`, color, whiteSpace: 'nowrap',
    }}>DPD {dpd}</span>
  )
}

// Keyed by canonical code. It was keyed by display label, which meant any rewording of
// a label silently dropped the colour back to grey.
const DISP_COLORS: Record<string, { bg: string; txt: string }> = {
  answered_interested:     { bg: 'rgba(22,163,74,.12)',   txt: '#16A34A' },
  answered_not_interested: { bg: 'rgba(192,0,0,.1)',      txt: '#C00000' },
  ptp:                     { bg: 'rgba(37,99,235,.12)',   txt: '#2563EB' },
  callback:                { bg: 'rgba(217,119,6,.12)',   txt: '#D97706' },
  wrong_number:            { bg: 'rgba(124,58,237,.12)',  txt: '#7C3AED' },
  do_not_call:             { bg: 'rgba(192,0,0,.1)',      txt: '#C00000' },
}

// `disp` is what the user reads; `code` is what picks the colour. Call trails from the
// ledger carry only the raw outcome text, so code is optional and falls back to neutral.
function DispositionPill({ disp, code, size = 'md' }: { disp: string; code?: string | null; size?: 'sm' | 'md' }) {
  const s = DISP_COLORS[code ?? ''] ?? { bg: 'var(--chip-bg)', txt: 'var(--chip-txt)' }
  return (
    <span style={{
      ...NUM, display: 'inline-flex', alignItems: 'center',
      fontSize: size === 'sm' ? 10.5 : 11.5, fontWeight: FW.semibold,
      padding: size === 'sm' ? '1px 6px' : '2px 8px',
      borderRadius: RADIUS['2xl'], background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>{disp}</span>
  )
}

// A chip doubles as the bucket selector — the counts are the navigation, so a
// supervisor who sees "3,773 exhausted" can click straight into them. Styled to match
// the Leads page's mini-stat tiles (flat --th-bg tile, value over label) so the two
// pages read as one product; the active (selected) state tints it in the bucket colour.
function StatChip({ label, value, color, active, onClick, title }: {
  label: string; value: number; color: string
  active?: boolean; onClick?: () => void; title?: string
}) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      onClick={onClick}
      title={title}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        padding: '6px 2px', borderRadius: RADIUS.md, flex: 1,
        background: active ? `${color}18` : 'var(--th-bg)',
        border: `1px solid ${active ? color : 'transparent'}`,
        cursor: onClick ? 'pointer' : 'default',
        font: 'inherit', textAlign: 'center',
      }}
    >
      <span style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold, color, lineHeight: 1.2 }}>{value.toLocaleString()}</span>
      <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 1 }}>{label}</span>
    </Tag>
  )
}

function InfoField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt2)', marginBottom: 3, fontWeight: FW.medium }}>{label}</div>
      <div style={{ fontSize: TEXT.base, fontWeight: FW.medium, color: 'var(--txt)' }}>{value ?? '—'}</div>
    </div>
  )
}

// ── Call History ──────────────────────────────────────────────────────────────

// Presentational call-history list, rendered in the SAME style as the Leads page's
// call history (flat rows, a green/red call-direction icon, disposition, duration,
// timestamp, an in-app recording player and a correct/withdraw control) so the two
// pages read as one product. The contact's calls are fetched by DetailPanel (which also
// needs the count, to decide whether the log form opens), then handed here.
function CallHistoryList({ calls, contact, onEdit, onPlay }: {
  calls: CallEntry[]; contact: CallCenterContact
  onEdit: (c: EditableCall) => void; onPlay: (id: number) => void
}) {
  if (!calls.length) return (
    <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', padding: '8px 0' }}>No calls logged yet.</div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {calls.map(c => {
        const inbound = (c.direction || '').toLowerCase() === 'inbound'
        // A dial that never connected is not a green tick — no duration and no recording
        // means nothing was said.
        const connected = (c.duration_seconds ?? 0) > 0 || !!c.recording_url
        const col = connected ? GREEN : RED
        const dur = c.duration_seconds ? `${Math.floor(c.duration_seconds / 60)}m ${c.duration_seconds % 60}s` : null
        return (
          <div key={c.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid var(--bdr)' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 18, color: col, flexShrink: 0, marginTop: 1 }}>{inbound ? 'call_received' : 'call_made'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{c.disposition || (connected ? 'Connected' : 'No Answer')}</span>
                {dur && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', ...NUM }}>{dur}</span>}
                {c.purpose && <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', textTransform: 'capitalize' }}>{c.purpose}</span>}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
                  <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtDatetime(c.called_at)}</span>
                  {c.recording_url && (
                    <button
                      title="Play the call recording"
                      onClick={() => onPlay(c.id)}
                      style={{ display: 'inline-flex', alignItems: 'center', border: 'none', background: 'none', cursor: 'pointer', color: GREEN, padding: 2, borderRadius: RADIUS.sm }}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>play_circle</span>
                    </button>
                  )}
                  {canCorrectCall(c.agent_name) && (
                    <button
                      title="Correct or withdraw this call log"
                      onClick={() => onEdit({
                        id: c.id,
                        customer_name: contact.customer_name,
                        phone: contact.phone,
                        direction: c.direction || 'outbound',
                        duration_seconds: c.duration_seconds,
                        disposition: c.disposition,
                        resolution: c.resolution,
                        purpose: c.purpose || contact.purpose,
                        notes: c.notes,
                      })}
                      style={{ display: 'inline-flex', alignItems: 'center', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt3)', padding: 2, borderRadius: RADIUS.sm }}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 14 }}>edit</span>
                    </button>
                  )}
                </span>
              </div>
              {c.notes && <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 2, lineHeight: 1.4 }}>{c.notes}</div>}
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 2 }}>
                {c.agent_name || 'Agent'}{c.recording_url ? ' · recorded' : ''}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Log Call Form ─────────────────────────────────────────────────────────────

// Served by GET /api/call-center/dispositions — the Go side owns the vocabulary and
// what each outcome does to the contact, so there is one list, not three.
interface DispositionOption {
  code: string
  label: string
  status: string
  needs_callback: boolean
  add_to_dnc: boolean
  connected: boolean
  // Purposes this disposition is valid for; empty/absent = every purpose. The log form
  // shows only the ones that fit the contact being called (a telesales call never offers
  // "Promise to Pay"; a collections call never offers "Not Eligible").
  purposes?: string[]
  hint: string
}

const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
  fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "var(--font-sans)", outline: 'none', boxSizing: 'border-box',
}

// The Outbound Queue's bespoke log form used to live here. It has been replaced by the
// shared CallLogForm (components/LogCallModal) — the exact form the Leads page uses — so
// the call-outcome UI is identical across the call centre. The queue side-effects it used
// to run (status, callback, DNC) now happen server-side via the call's contact_id.

// ── Detail Panel ──────────────────────────────────────────────────────────────

function DetailPanel({ contact, onAction, onRefresh }: { contact: CallCenterContact; onAction: () => void; onRefresh: () => void }) {
  const navigate = useNavigate()
  const [editCall, setEditCall] = useState<EditableCall | null>(null)
  const [playCallId, setPlayCallId] = useState<number | null>(null)

  // This contact's call history — fetched here (not in a child) so the log form can
  // open by default only when there's nothing to read yet, exactly like the Leads page.
  const [calls, setCalls] = useState<CallEntry[]>([])
  const [callKey, setCallKey] = useState(0)
  const [logOpen, setLogOpen] = useState(false)
  useEffect(() => {
    let cancelled = false
    apiFetch<{ data: CallEntry[] }>(`/api/call-center/contacts/${contact.id}/calls`)
      .then(r => {
        if (cancelled) return
        const list = r.data ?? []
        setCalls(list)
        setLogOpen(list.length === 0)
      })
      .catch(() => { if (!cancelled) setCalls([]) })
    return () => { cancelled = true }
  }, [contact.id, callKey])

  // A worked call advances the dialer to the next contact (onAction); the panel
  // remounts on that contact, so the reload is its concern.
  function afterLog() { setCallKey(k => k + 1); onAction() }
  // A correction/withdrawal refreshes this contact's history + queue counts in place.
  function afterEdit() { setCallKey(k => k + 1); onRefresh() }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>

      {/* ── Contact header ──────────────────────────────────────────────── */}
      <div style={{ padding: '18px 24px', borderBottom: '1px solid var(--bdr)', background: 'var(--th-bg)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          {/* Initials avatar */}
          <div style={{
            width: 46, height: 46, borderRadius: '50%', flexShrink: 0,
            background: `${NAVY}14`, color: NAVY,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: TEXT.lg, fontWeight: FW.extrabold, letterSpacing: '-0.5px',
          }}>
            {(contact.customer_name || 'Unknown Lead').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], flexWrap: 'wrap', marginBottom: 5 }}>
              <span style={{ fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)' }}>
                {contact.customer_name || 'Unknown Lead'}
              </span>
              {hasCollectionsContext(contact) && <DpdBadge dpd={contact.dpd} />}
              {contact.last_disposition ? (
                <DispositionPill disp={contact.last_disposition} code={contact.disposition_code} size="sm" />
              ) : (
                <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: BLUE, background: `${BLUE}14`, padding: '1px 8px', borderRadius: RADIUS.full }}>
                  Not Yet Called
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[3] }}>
              <span style={{ fontSize: TEXT.md, color: NAVY, fontFamily: INTER, fontWeight: FW.semibold, letterSpacing: '0.3px' }}>
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.md, verticalAlign: 'middle', marginRight: 4 }}>call</span>
                {contact.phone}
              </span>
              {contact.cif && (
                <button
                  onClick={() => navigate(`/contacts/${contact.cif}`)}
                  style={{ fontSize: TEXT.xs, color: NAVY, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                >
                  CIF: {contact.cif}
                </button>
              )}
            </div>
          </div>

          {/* Call button */}
          <button
            onClick={() => dialNumber(contact.phone)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '9px 16px', background: GREEN, color: '#fff',
              borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.bold,
              border: 'none', cursor: 'pointer', fontFamily: INTER, flexShrink: 0,
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 17 }}>call</span>
            Call
          </button>
        </div>
      </div>

      {/* ── Contact info (one scroll, like the Leads page — no tabs) ─────── */}
      <div style={{ padding: '14px 24px', borderBottom: '1px solid var(--bdr)' }}>
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 }}>Contact Info</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px' }}>
          <InfoField label="CIF" value={contact.cif} />
          <InfoField label="State" value={contact.state} />
          {contact.purpose === 'marketing'
            ? <InfoField label="Campaign List" value={contact.ref || 'Unlisted'} />
            : <InfoField label="Product" value={isGenericProduct(contact.product_name) ? null : contact.product_name} />}
          <InfoField label="Last Called" value={contact.last_called_at ? fmtDatetime(contact.last_called_at) : null} />
          <InfoField label="Attempts" value={
            contact.attempts > 0
              ? <span style={{ ...NUM, color: contact.is_exhausted ? RED : 'var(--txt)' }}>{contact.attempts} · {contact.connects} answered</span>
              : 'Never Called'
          } />
          <InfoField label="Dial Status" value={
            contact.is_exhausted ? <span style={{ color: RED, fontWeight: FW.bold }}>Exhausted: 6+ Tries, No Answer</span>
            : contact.is_cooling ? <span style={{ color: AMBER, fontWeight: FW.bold }}>Cooling: Called in Last 7 Days</span>
            : <span style={{ color: GREEN, fontWeight: FW.bold }}>Ready to Call</span>
          } />
          {contact.is_existing_customer && <InfoField label="Outstanding" value={<span style={NUM}>{fmtKobo(contact.outstanding_kobo)}</span>} />}
          {contact.is_existing_customer && <InfoField label="Next Payment" value={fmtDate(contact.next_payment_date)} />}
        </div>
      </div>

      {/* ── Log a call (collapsible, like Leads) ────────────────────────── */}
      <div style={{ padding: `${SP[4]} ${SP[5]}` }}>
        {logOpen ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: SP[3] }}>
              <div style={{ flex: 1, fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Log Call</div>
              {calls.length > 0 && (
                <button onClick={() => setLogOpen(false)}
                  style={{ border: 'none', background: 'none', color: 'var(--txt2)', fontSize: TEXT.xs, cursor: 'pointer', fontFamily: INTER }}>
                  Cancel
                </button>
              )}
            </div>
            {/* The SAME shared call form as the Leads page — one outcome/disposition UI
                across the call centre. contactId routes the disposition's queue
                consequences (status, callback, DNC) to this contact; the dispositions are
                already scoped to the contact's purpose. */}
            <CallLogForm
              open
              variant="inline"
              onClose={() => setLogOpen(false)}
              onSaved={afterLog}
              initial={{
                name:      contact.customer_name || undefined,
                phone:     contact.phone,
                cif:       contact.cif ?? undefined,
                direction: 'Outbound',
                purpose:   contact.purpose === 'support' ? '' : contact.purpose,
                contactId: contact.id,
              }}
            />
          </>
        ) : (
          <button onClick={() => setLogOpen(true)}
            style={{ width: '100%', padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.md, border: `1px solid ${NAVY}`, background: 'var(--card)', color: NAVY, fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: INTER }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg }}>add_call</span>
            Log Another Call
          </button>
        )}
      </div>

      {/* ── Call history — every log, record and recording, like Leads ──── */}
      <div style={{ padding: `0 ${SP[5]} ${SP[5]}` }}>
        <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: SP[2] }}>
          Call History{calls.length ? ` (${calls.length})` : ''}
        </div>
        <CallHistoryList calls={calls} contact={contact} onEdit={setEditCall} onPlay={setPlayCallId} />
      </div>

      {editCall && (
        <CallLogEditModal
          call={editCall}
          onClose={() => setEditCall(null)}
          onSaved={afterEdit}
        />
      )}

      <RecordingModal
        callId={playCallId}
        title="Call Recording"
        subtitle={contact.customer_name || contact.phone}
        onClose={() => setPlayCallId(null)}
      />
    </div>
  )
}

// ── Filter constants ──────────────────────────────────────────────────────────

// One fetch of the server vocabulary, shared by the log form and the queue filter.
// A failed fetch is reported, not swallowed: an empty outcome dropdown reads as "this
// queue has no outcomes to filter by", which is a different — and wrong — story.
function useDispositions(): { options: DispositionOption[]; error: string | null } {
  const [options, setOptions] = useState<DispositionOption[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    apiFetch<{ data: DispositionOption[] }>('/api/call-center/dispositions')
      .then(res => { setOptions(res.data ?? []); setError(null) })
      .catch(e => { setOptions([]); setError(e.message ?? 'Failed to load the outcome list') })
  }, [])
  return { options, error }
}

// ── Import modal ──────────────────────────────────────────────────────────────

// A header row is optional in a pasted list — drop it so it isn't imported as a contact.
// Same rule as the Leads page's uploader, so the two behave identically.
function isHeaderLine(line: string): boolean {
  return /(^|,)\s*"?phone"?\s*(,|$)/i.test(line) || (/name/i.test(line) && /phone/i.test(line))
}

// Split one CSV line, honouring double quotes so a product or address containing a
// comma survives. Splitting on every comma turned "Loan follow-up, second notice" into
// two columns and shifted state into nothing.
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

function ImportContactsModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [purpose, setPurpose] = useState<Purpose>('marketing')
  const [raw, setRaw] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // One contact per line: "name, phone, cif?, product?, state?" — phone is required.
  const parsed = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    .filter(l => !isHeaderLine(l))
    .map(line => {
      const [name = '', phone = '', cif = '', product = '', state = ''] = splitCSVLine(line)
      return { name, phone, cif, product, state }
    }).filter(c => c.phone)

  async function submit() {
    if (parsed.length === 0) { setErr('Add at least one row with a phone number'); return }
    setSaving(true); setErr(null)
    try {
      const res = await apiPost<{ inserted: number; skipped: number }>('/api/call-center/queue/import', { purpose, contacts: parsed })
      toast.success(`${res.inserted ?? 0} added${res.skipped ? ` · ${res.skipped} skipped` : ''}`)
      setRaw(''); onDone(); onClose()
    } catch (e: any) { setErr(e.message ?? 'Import failed') }
    finally { setSaving(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Import Contacts" width={480}
      footer={
        <>
          <button onClick={onClose} style={{ padding: '8px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving || parsed.length === 0} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: (saving || !parsed.length) ? 'not-allowed' : 'pointer', opacity: (saving || !parsed.length) ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 6 }}>
            {saving && <Spinner size={13} color="#fff" />}Import{parsed.length ? ` ${parsed.length}` : ''}
          </button>
        </>
      }
    >
      <ErrBanner error={err} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Add To</label>
          <select value={purpose} onChange={e => setPurpose(e.target.value as Purpose)} style={{ ...fieldStyle, height: 38 }}>
            <option value="marketing">Marketing</option>
            <option value="collections">Collections</option>
            <option value="support">Support</option>
          </select>
        </div>
        <div>
          <label style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
            Contacts, One Per Line: Name, Phone, CIF, Product, State
          </label>
          <textarea
            spellCheck={false}
            value={raw}
            onChange={e => setRaw(e.target.value)}
            rows={8}
            placeholder={'Jane Doe, 08012345678\nJohn Smith, 08087654321, 00012345, Loan follow-up, Lagos'}
            style={{ ...fieldStyle, resize: 'vertical', fontFamily: INTER }}
          />
        </div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{parsed.length} valid row(s) detected</div>
      </div>
    </Modal>
  )
}

// ── Team Live (supervisor) ────────────────────────────────────────────────────
// The dialer counterpart to the Leads page's Team panel: a live per-agent wallboard
// over the outbound queue. Agents only — supervisors don't work a dial book. Shown as
// the supervisor's right-pane home when no contact is selected.

interface QueueTeamAgent {
  id: number; full_name: string; status: string; online: boolean
  assigned: number; pending: number; callbacks_due: number; closed: number
  called_today: number; dials_today: number
}
interface QueueTeamTotals { total: number; unassigned: number; pending: number; callbacks_due: number; closed: number }

function qPresence(a: QueueTeamAgent): { dot: string; label: string } {
  if (a.online && a.status === 'available') return { dot: GREEN, label: 'Online' }
  if (a.status === 'break') return { dot: AMBER, label: 'On Break' }
  return { dot: 'var(--txt3)', label: 'Offline' }
}

function QueueTeamPanel({ purpose }: { purpose: '' | Purpose }) {
  const [agents, setAgents] = useState<QueueTeamAgent[]>([])
  const [totals, setTotals] = useState<QueueTeamTotals | null>(null)
  const [loading, setLoading] = useState(true)
  // A failed fetch must not read "No agents on the team yet" — that is a claim about
  // the floor, not about the request.
  const [teamErr, setTeamErr] = useState<string | null>(null)

  const load = useCallback(() => {
    const p = purpose ? `?purpose=${purpose}` : ''
    apiFetch<{ agents: QueueTeamAgent[]; totals: QueueTeamTotals }>(`/api/call-center/queue/team${p}`)
      .then(r => { setAgents(Array.isArray(r?.agents) ? r.agents : []); setTotals(r?.totals ?? null); setTeamErr(null) })
      .catch(e => setTeamErr(e.message ?? 'Failed to load the team'))
      .finally(() => setLoading(false))
  }, [purpose])

  useEffect(() => { setLoading(true); load() }, [load])
  useEffect(() => { const t = setInterval(load, 15_000); return () => clearInterval(t) }, [load])
  useLiveData(load, { topics: ['calls', 'crm', 'cc_contacts'] })

  const col: React.CSSProperties = { padding: '8px 10px', textAlign: 'right', ...NUM, fontSize: TEXT.sm, color: 'var(--txt)' }
  const head: React.CSSProperties = { padding: '8px 10px', textAlign: 'right', fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.03em', position: 'sticky', top: 0, background: 'var(--card)' }

  const totalCards: { label: string; value: number; color: string }[] = totals ? [
    { label: 'In Queue',      value: totals.total,         color: 'var(--txt)' },
    { label: 'Unassigned',    value: totals.unassigned,    color: RED },
    { label: 'Pending',       value: totals.pending,       color: '#6B7280' },
    { label: 'Callbacks Due',  value: totals.callbacks_due, color: AMBER },
    { label: 'Closed',        value: totals.closed,        color: GREEN },
  ] : []

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 20, color: NAVY }}>groups</span>
          <span style={{ fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)' }}>Team</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: TEXT['2xs'], fontWeight: FW.bold, color: GREEN, background: `${GREEN}14`, padding: '2px 8px', borderRadius: RADIUS.full }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: GREEN }} /> Live
          </span>
          {purpose && <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', textTransform: 'capitalize' }}>· {purpose}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {totalCards.map(c => (
            <div key={c.label} style={{ flex: '1 1 90px', textAlign: 'center', background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: '8px 4px' }}>
              <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.extrabold, color: c.color }}>{c.value.toLocaleString()}</div>
              <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{c.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {teamErr && <div style={{ padding: '12px 20px 0' }}><ErrBanner error={teamErr} onRetry={load} /></div>}
        {loading && agents.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, gap: 10, color: 'var(--txt2)', fontSize: TEXT.base }}>
            <Spinner size={16} color={NAVY} /> Loading team…
          </div>
        ) : teamErr && agents.length === 0 ? null : agents.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--txt3)', fontSize: TEXT.base }}>No agents on the team yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...head, textAlign: 'left' }}>Agent</th>
                <th style={head}>Assigned</th>
                <th style={head}>Pending</th>
                <th style={head}>Called Today</th>
                <th style={head}>Closed</th>
              </tr>
            </thead>
            <tbody>
              {agents.map(a => {
                const p = qPresence(a)
                return (
                  <tr key={a.id} style={{ borderTop: '1px solid var(--bdr)' }}>
                    <td style={{ padding: '8px 10px', textAlign: 'left' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <span title={p.label} style={{ width: 8, height: 8, borderRadius: '50%', background: p.dot, flexShrink: 0 }} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.full_name}</div>
                          <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{p.label}{a.callbacks_due ? ` · ${a.callbacks_due} callback${a.callbacks_due === 1 ? '' : 's'} due` : ''}</div>
                        </div>
                      </div>
                    </td>
                    <td style={col}>{a.assigned.toLocaleString()}</td>
                    <td style={{ ...col, color: a.pending ? 'var(--txt)' : 'var(--txt3)' }}>{a.pending.toLocaleString()}</td>
                    <td style={col}>
                      <div style={{ ...NUM, fontSize: TEXT.sm, fontWeight: a.called_today ? FW.bold : FW.medium, color: a.called_today ? NAVY : 'var(--txt3)' }}>{a.called_today.toLocaleString()}</div>
                      {a.dials_today > 0 && <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{a.dials_today.toLocaleString()} dial{a.dials_today === 1 ? '' : 's'}</div>}
                    </td>
                    <td style={{ ...col, color: a.closed ? GREEN : 'var(--txt3)' }}>{a.closed.toLocaleString()}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

const PAGE_SIZE = 200

// Seeking a deep-linked contact that isn't on the page in view. A call-back deep link
// points at a contact the queue's ordering floats to the top, so a few pages is plenty;
// walking all 14,951 rows to prove the point is not.
const SEEK_PAGE = 500
const SEEK_PAGES = 4

export default function CallCenterQueue() {
  const [items, setItems] = useState<CallCenterContact[]>([])
  const [summary, setSummary] = useState<QueueSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<CallCenterContact | null>(null)
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set())

  const { options: dispositionOptions, error: dispositionErr } = useDispositions()
  const [purposeF, setPurposeF] = useState<'' | Purpose>('')
  const [bucket, setBucket] = useState<Bucket>('ready')
  const [disposition, setDisposition] = useState('All')
  const [search, setSearch] = useState('')
  const dq = useDebouncedValue(search, 300) // one request per pause, not per keystroke
  // Server-side paging over the whole bucket — one 200-row page left the other 14,751
  // pending contacts unreachable.
  const [offset, setOffset] = useState(0)

  const [skipConfirm, setSkipConfirm] = useState(false)
  const [skipLoading, setSkipLoading] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [distributing, setDistributing] = useState(false)
  const [distributeConfirm, setDistributeConfirm] = useState(false)
  const isHead = isHeadRole()

  // Overlapping loads are routine here — live events on top of a 15s poll — so a slower
  // earlier response must never land last and paint another bucket's rows under the
  // current chip. Only the newest request may write to the view.
  const loadSeq = useRef(0)
  const load = useCallback(async (silent = false): Promise<CallCenterContact[]> => {
    const seq = ++loadSeq.current
    if (!silent) setLoading(true)
    setErr(null)
    // A work queue is a live list, not a date-bounded report — no date filter.
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
    if (purposeF) params.set('purpose', purposeF)
    if (bucket) params.set('bucket', bucket)
    if (disposition !== 'All') params.set('disposition', disposition)
    if (dq) params.set('search', dq)
    try {
      const res = await apiFetch<{ data: CallCenterContact[]; summary?: QueueSummary }>(`/api/call-center/queue?${params}`)
      const fresh = res.data ?? []
      if (seq !== loadSeq.current) return fresh // superseded — a newer load owns the view
      setItems(fresh)
      setSummary(res.summary ?? null)
      return fresh
    } catch (e: any) {
      if (seq !== loadSeq.current) return []
      setErr(e.message ?? 'Failed to load queue')
      return []
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [purposeF, bucket, disposition, dq, offset])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['calls', 'crm', 'cc_contacts'] })

  // Any filter change is a different list — start it at the first page rather than on
  // page 5 of a bucket that may not have one.
  useEffect(() => { setOffset(0) }, [purposeF, bucket, disposition, dq])

  // Deep-link from the call-back popup: ?open=<contactId> selects that contact so the
  // agent lands straight on the call to make (its detail + log-call form).
  const [sp] = useSearchParams()
  const openId = sp.get('open')
  const [openMiss, setOpenMiss] = useState<string | null>(null)
  const sought = useRef<string | null>(null)
  useEffect(() => {
    if (!openId) return
    const m = items.find(i => String(i.id) === openId)
    if (m) { setSelected(m); setOpenMiss(null); sought.current = openId; return }
    // Not on the page in view — the filters or the page the agent is on can hide it.
    // Seek it over the first few pages of the unfiltered queue instead of silently
    // doing nothing, and if it genuinely isn't in the queue any more, say so rather
    // than dropping the agent on an ordinary list with no explanation.
    if (sought.current === openId) return
    sought.current = openId
    let cancelled = false
    ;(async () => {
      for (let page = 0; page < SEEK_PAGES; page++) {
        try {
          const res = await apiFetch<{ data: CallCenterContact[] }>(
            `/api/call-center/queue?limit=${SEEK_PAGE}&offset=${page * SEEK_PAGE}`)
          if (cancelled) return
          const rows = res.data ?? []
          const hit = rows.find(c => String(c.id) === openId)
          if (hit) { setSelected(hit); setOpenMiss(null); return }
          if (rows.length < SEEK_PAGE) break
        } catch { break }
      }
      if (!cancelled) setOpenMiss(`That call-back's contact (#${openId}) is no longer in the queue — it may have been called, skipped or reassigned.`)
    })()
    return () => { cancelled = true }
  }, [openId, items])

  // The bucket in view, not the whole backlog: the list is bucket-filtered, so the
  // pager and the count chip are both bounded by the number its chip reports.
  const bucketTotal = (bucket ? summary?.[bucket] : summary?.total) ?? items.length

  // The bucket and purpose tabs are filters too. Leaving them out meant that after
  // clicking Exhausted no reset ever appeared, so there was no way back.
  const anyFilter = disposition !== 'All' || search !== '' || bucket !== 'ready' || purposeF !== ''

  function toggleCheck(id: number, e: React.MouseEvent) {
    e.stopPropagation()
    setCheckedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function clearChecked() { setCheckedIds(new Set()) }

  // Keyboard access to the list. The rows were <div onClick> only, so an agent working
  // without a mouse could not reach a contact — and therefore could not log a call at
  // all. Up/Down walk the rows, Enter opens one. Arrowing deliberately doesn't open:
  // every open refetches that contact's call history.
  const rowRefs = useRef<(HTMLDivElement | null)[]>([])
  function onRowKey(e: React.KeyboardEvent, idx: number) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      rowRefs.current[idx + (e.key === 'ArrowDown' ? 1 : -1)]?.focus()
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setSelected(items[idx])
    }
  }
  // Roving tabIndex — one tab stop for the whole list, landing on the open contact.
  const rovingIdx = Math.max(0, items.findIndex(i => i.id === selected?.id))

  // Auto-advance: after a call is logged, drop the just-worked contact and jump the
  // agent straight to the next number, so the queue plays like a dialer instead of
  // making them hunt for who to call next. When nothing is left, `queueDone` lights up
  // the "all caught up" panel so they know they're finished.
  const [queueDone, setQueueDone] = useState(false)

  async function handleAdvance() {
    const prev = selected
    const prevItems = items
    const fresh = await load(true) // the just-logged contact has usually dropped out already
    // Advance in reading order: the first contact that sat below the one we just
    // worked and still survives in the refreshed list; otherwise the top of what's
    // left. Either way never the contact we just logged.
    let next: CallCenterContact | null = null
    if (prev) {
      const oldIdx = prevItems.findIndex(c => c.id === prev.id)
      const below = oldIdx >= 0 ? prevItems.slice(oldIdx + 1) : []
      for (const c of below) {
        const stillThere = fresh.find(x => x.id === c.id && x.id !== prev.id)
        if (stillThere) { next = stillThere; break }
      }
    }
    if (!next) next = fresh.find(c => c.id !== prev?.id) ?? null
    if (!next) {
      // Nothing left on THIS page is not nothing left: step to the next page rather
      // than telling an agent the queue is clear while thousands wait behind it.
      if (offset + PAGE_SIZE < bucketTotal) { setSelected(null); setOffset(offset + PAGE_SIZE); return }
      setSelected(null)
      setQueueDone(true)
      toast.success('Queue cleared — nothing left to call right now')
      return
    }
    setSelected(next)
  }

  // New work arriving (a distribution, a filter change, a fresh load) clears the
  // "all caught up" banner so it never lingers over a queue that has calls in it.
  useEffect(() => { if (items.length > 0) setQueueDone(false) }, [items.length])

  async function handleSkip() {
    setSkipLoading(true)
    try {
      await apiPost('/api/call-center/queue/bulk-skip', { ids: [...checkedIds] })
      toast.success(`${checkedIds.size} contact(s) skipped`)
      clearChecked()
      setSelected(null)
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to skip')
    } finally {
      setSkipLoading(false)
      setSkipConfirm(false)
    }
  }

  async function handleDistribute() {
    setDistributing(true)
    setDistributeConfirm(false)
    try {
      const res = await apiPost<any>(
        '/api/call-center/queue/distribute',
        purposeF ? { purpose: purposeF } : {},
      )
      const d: any = (res as any)?.data ?? res
      if (!d.assigned) {
        toast.info('No unassigned contacts to distribute')
      } else {
        toast.success(`${d.assigned} contact(s) distributed${d.online_only ? ' to online agents' : ': nobody online, spread across all agents'}`)
        load()
      }
    } catch (e: any) {
      toast.error(e.message ?? 'Distribute failed')
    } finally {
      setDistributing(false)
    }
  }

  return (
    <Page title="Outbound Queue" subtitle={isHead ? 'Marketing, collections and support calls drawn from the CRM, our own accounts and uploaded lists' : 'Your assigned calls to make: dial through your list'} noPad
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
          {(() => {
            const feedBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: 'var(--card)', color: 'var(--txt2)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }
            // Feeding and assigning the queue are supervisor actions; agents just work
            // the list they were given.
            if (!isHead) return null
            return (
              <>
                {/* Feed the queue (Sync CRM / Pull Collections) now lives in Admin → Sync & Workers. */}
                <button onClick={() => setImportOpen(true)} title="Upload a manual list" style={feedBtn}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>upload_file</span>
                  Import
                </button>
                <button onClick={() => setDistributeConfirm(true)} disabled={distributing} title="Round-robin the unassigned queue across online agents"
                  style={{ ...feedBtn, cursor: distributing ? 'wait' : 'pointer', opacity: distributing ? 0.7 : 1 }}>
                  {distributing ? <Spinner size={13} color={NAVY} /> : <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>shuffle</span>}
                  Distribute
                </button>
                <button onClick={() => setAssignOpen(true)} title="Assign a batch of the queue to one agent"
                  style={{ ...feedBtn, background: NAVY, color: '#fff', border: `1px solid ${NAVY}` }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>assignment_ind</span>
                  Assign to Agent
                </button>
              </>
            )
          })()}
        </div>
      }
    >
      <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

        {/* ── Left panel ─────────────────────────────────────────────────── */}
        <div style={{
          width: 380, minWidth: 320, maxWidth: 400,
          borderRight: '1px solid var(--bdr)',
          display: 'flex', flexDirection: 'column',
          background: 'var(--card)', flexShrink: 0,
        }}>
          {/* Header — title + count chip, matching the Leads page's left-panel header. */}
          <div style={{ padding: '14px 14px 12px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: 10 }}>
              <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)', flex: 1 }}>Call Queue</span>
              {/* The bucket in view, not the whole backlog — and it counts exactly what
                  the pager below walks, so the chip and the rows can't contradict. */}
              <span title={items.length
                ? `Showing ${(offset + 1).toLocaleString()}–${(offset + items.length).toLocaleString()} of ${bucketTotal.toLocaleString()}`
                : `${bucketTotal.toLocaleString()} in this view`}
                style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, background: 'var(--chip-bg)', color: 'var(--chip-txt)', padding: '1px 7px', borderRadius: RADIUS['2xl'] }}>
                {bucketTotal.toLocaleString()}
              </span>
            </div>

            {/* Purpose segmentation — Marketing / Collections / Support */}
            <div style={{ display: 'flex', gap: 3, marginBottom: 10, background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: 3 }}>
              {([['', 'All'], ['marketing', 'Marketing'], ['collections', 'Collections'], ['support', 'Support']] as const).map(([val, label]) => {
                const on = purposeF === val
                const count = val === '' ? (summary?.total ?? 0) : (summary?.[val] ?? 0)
                const color = val === '' ? NAVY : PURPOSE_META[val].color
                return (
                  <button key={label || 'all'} onClick={() => setPurposeF(val)} style={{
                    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
                    padding: '5px 2px', borderRadius: RADIUS.sm, border: 'none', cursor: 'pointer',
                    background: on ? 'var(--card)' : 'transparent',
                    boxShadow: on ? '0 1px 2px rgba(0,0,0,.10)' : 'none',
                  }}>
                    <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: on ? color : 'var(--txt2)' }}>{label}</span>
                    <span style={{ ...NUM, fontSize: TEXT['2xs'], color: on ? color : 'var(--txt3)' }}>{count.toLocaleString()}</span>
                  </button>
                )
              })}
            </div>

            {/* Buckets — counted from real call history, and clickable. These read
                "Contacted 0 / Not Yet Called 14,708" before the queue was joined to the
                call ledger; every contact claimed to be untouched while 13,669 of them
                had been dialled 97,938 times. */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <StatChip
                label="Ready" value={summary?.ready ?? 0} color={GREEN}
                active={bucket === 'ready'} onClick={() => setBucket(bucket === 'ready' ? '' : 'ready')}
                title="Ready to call — cold dials: never called, or rested past the 7-day cooldown, and not exhausted"
              />
              <StatChip
                label="Uncalled" value={summary?.uncalled ?? 0} color={BLUE}
                active={bucket === 'uncalled'} onClick={() => setBucket(bucket === 'uncalled' ? '' : 'uncalled')}
                title="Never called — no call to this number exists in the call ledger"
              />
              <StatChip
                label="Cooling" value={summary?.cooling ?? 0} color={AMBER}
                active={bucket === 'cooling'} onClick={() => setBucket(bucket === 'cooling' ? '' : 'cooling')}
                title="Called within the last 7 days, resting before the next attempt"
              />
              <StatChip
                label="Exhausted" value={summary?.exhausted ?? 0} color={RED}
                active={bucket === 'exhausted'} onClick={() => setBucket(bucket === 'exhausted' ? '' : 'exhausted')}
                title="6+ attempts and never once answered. Consider skipping these"
              />
            </div>

            {/* Search */}
            <TblSearch
              value={search}
              onChange={v => setSearch(v)}
              placeholder="Search name or phone…"
              width={0}
              style={{ marginBottom: SP[2] }}
            />

            {/* Filter by what happened on the last call — the Leads page filters by
                status the same way. Priority was removed: a telesales queue is worked by
                readiness (the buckets above) and recency, not a High/Med/Low label. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Last outcome — a dropdown, not a chip stack: ten dispositions as
                  chips was a wall of buttons taller than the result list it filters. */}
              <div>
                <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>Last Outcome</div>
                {/* An outcome list that failed to load says so — an empty dropdown reads
                    as "this queue has no outcomes", which is a different story. */}
                <ErrBanner error={dispositionErr} />
                <select value={disposition} onChange={e => setDisposition(e.target.value)} style={{
                  width: '100%', height: 32, padding: '0 8px',
                  fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: 'pointer',
                  border: `1px solid ${disposition !== 'All' ? NAVY : 'var(--bdr)'}`, borderRadius: RADIUS.md,
                  background: disposition !== 'All' ? `${NAVY}0c` : 'var(--card)',
                  color: disposition !== 'All' ? NAVY : 'var(--txt2)',
                }}>
                  <option value="All">All Outcomes</option>
                  {dispositionOptions.map(o => <option key={o.code} value={o.code}>{o.label}</option>)}
                </select>
              </div>

              {anyFilter && (
                <button
                  onClick={() => { setDisposition('All'); setSearch(''); setBucket('ready'); setPurposeF('') }}
                  style={{
                    alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontSize: TEXT.xs, fontWeight: FW.medium, padding: '3px 10px', borderRadius: RADIUS.full,
                    border: '1px solid var(--bdr)', background: 'none',
                    color: 'var(--txt3)', cursor: 'pointer',
                  }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span>
                  Clear Filters
                </button>
              )}
            </div>
          </div>

          {/* Batch bar */}
          {checkedIds.size > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: SP[2],
              padding: '7px 14px', background: '#F0F4FF',
              borderBottom: '1px solid var(--bdr)', flexShrink: 0,
            }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY }}>{checkedIds.size} selected</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button onClick={() => setSkipConfirm(true)} style={{ fontSize: TEXT.xs, fontWeight: FW.medium, color: NAVY, background: 'none', border: `1px solid ${NAVY}30`, borderRadius: RADIUS.sm, padding: '3px 9px', cursor: 'pointer' }}>Skip</button>
                <button onClick={clearChecked} style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt2)', borderRadius: '50%' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>close</span>
                </button>
              </div>
            </div>
          )}

          {/* Error. onRetry is called with no argument on purpose: passing it straight to
              load() handed the click event in as `silent`, so Retry looked inert. */}
          {err && <div style={{ padding: '10px 14px' }}><ErrBanner error={err} onRetry={() => load()} /></div>}
          {/* A deep link that could not be honoured explains itself. */}
          {openMiss && <div style={{ padding: '10px 14px' }}><ErrBanner error={openMiss} /></div>}

          {/* Contact list — a listbox, so it can be worked from the keyboard */}
          <div role="listbox" aria-label="Call queue" style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 120, gap: 10, color: 'var(--txt2)', fontSize: TEXT.base }}>
                <Spinner size={16} color={NAVY} /> Loading…
              </div>
            ) : err ? null : items.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--txt2)', fontSize: TEXT.base }}>
                No contacts match the current filters.
              </div>
            ) : (
              items.map((item, idx) => {
                const isSelected = selected?.id === item.id
                const isChecked = checkedIds.has(item.id)
                return (
                  <div
                    key={item.id}
                    ref={el => { rowRefs.current[idx] = el }}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={idx === rovingIdx ? 0 : -1}
                    onClick={() => setSelected(item)}
                    onKeyDown={e => onRowKey(e, idx)}
                    style={{
                      display: 'flex', alignItems: 'stretch',
                      borderBottom: '1px solid var(--bdr)',
                      cursor: 'pointer',
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
                        onClick={e => toggleCheck(item.id, e)}
                        onChange={() => {}}
                        style={{ marginTop: 2, cursor: 'pointer', accentColor: NAVY, flexShrink: 0 }}
                      />
                    </div>

                    {/* Content */}
                    <div style={{ flex: 1, minWidth: 0, padding: '10px 12px 10px 2px' }}>
                      {/* Row 1+2: name + phone via NameCell, with disposition badge */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: SP[1] }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <NameCell
                            name={item.customer_name || 'Unknown Lead'}
                            sub={`${item.phone}${item.cif ? ` · ${item.cif}` : ''}`}
                            avatar={false}
                          />
                        </div>
                        {item.last_disposition && (
                          <DispositionPill disp={item.last_disposition} code={item.disposition_code} size="sm" />
                        )}
                      </div>
                      {/* Row 3: collections context when real, else product + call-status */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {purposeF === '' && PURPOSE_META[item.purpose] && (
                          <span title={PURPOSE_META[item.purpose].label} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: TEXT['2xs'], fontWeight: FW.bold, color: PURPOSE_META[item.purpose].color }}>
                            <span className="material-symbols-rounded" style={{ fontSize: 12 }}>{PURPOSE_META[item.purpose].icon}</span>
                          </span>
                        )}
                        {hasCollectionsContext(item) ? (
                          <>
                            <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                              {fmtKobo(item.outstanding_kobo)}
                            </span>
                            <DpdBadge dpd={item.dpd} />
                          </>
                        ) : item.purpose === 'marketing' ? (
                          <span title="Campaign list" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '1px 7px', borderRadius: RADIUS.full, background: item.ref ? `${BLUE}14` : 'var(--chip-bg)', color: item.ref ? BLUE : 'var(--txt3)' }}>
                            <span className="material-symbols-rounded" style={{ fontSize: 12 }}>format_list_bulleted</span>
                            {item.ref || 'Unlisted'}
                          </span>
                        ) : (
                          !isGenericProduct(item.product_name) && (
                            <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, padding: '1px 7px', borderRadius: RADIUS.full, background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>
                              {item.product_name}
                            </span>
                          )
                        )}
                        {/* Call history at a glance. An agent needs to know a number has
                            already swallowed 14 attempts BEFORE dialling it again. */}
                        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          {item.attempts > 0 && (
                            <span
                              title={`${item.attempts} attempt${item.attempts === 1 ? '' : 's'}, ${item.connects} answered`}
                              style={{
                                ...NUM, fontSize: TEXT['2xs'], fontWeight: FW.bold,
                                padding: '1px 6px', borderRadius: RADIUS.full,
                                background: item.is_exhausted ? `${RED}14` : 'var(--chip-bg)',
                                color: item.is_exhausted ? RED : 'var(--txt2)',
                              }}
                            >
                              {item.attempts}× · {item.connects} answered
                            </span>
                          )}
                          {item.callback_due ? (
                            <span title={`Callback agreed for ${fmtDatetime(item.callback_at!)}`} style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: '#fff', background: AMBER, padding: '1px 7px', borderRadius: RADIUS.full }}>
                              Callback Due
                            </span>
                          ) : item.is_exhausted ? (
                            <span title="6+ attempts, never answered" style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: RED, background: `${RED}14`, padding: '1px 7px', borderRadius: RADIUS.full }}>
                              Exhausted
                            </span>
                          ) : item.is_cooling ? (
                            <span title={`Called ${fmtDate(item.last_called_at!)}, resting`} style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: AMBER, background: `${AMBER}14`, padding: '1px 7px', borderRadius: RADIUS.full }}>
                              Cooling
                            </span>
                          ) : item.last_called_at ? (
                            <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontFamily: INTER }}>
                              {fmtDate(item.last_called_at)}
                            </span>
                          ) : (
                            <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: BLUE, background: `${BLUE}14`, padding: '1px 7px', borderRadius: RADIUS.full }}>
                              New
                            </span>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>

          {/* Pagination — the queue holds 14,951 pending contacts, so a single page of
              200 left 14,751 of them unreachable. Same pager as the Leads page. */}
          {bucketTotal > PAGE_SIZE && (
            <div style={{ flexShrink: 0, borderTop: '1px solid var(--bdr)', padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', ...NUM }}>
                {(offset + 1).toLocaleString()}–{Math.min(offset + PAGE_SIZE, bucketTotal).toLocaleString()} of {bucketTotal.toLocaleString()}
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  style={{ padding: '4px 10px', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: offset === 0 ? 'default' : 'pointer', border: '1px solid var(--bdr)', background: 'var(--card)', color: offset === 0 ? 'var(--txt3)' : 'var(--txt)', opacity: offset === 0 ? 0.5 : 1 }}>Prev</button>
                <button disabled={offset + PAGE_SIZE >= bucketTotal} onClick={() => setOffset(offset + PAGE_SIZE)}
                  style={{ padding: '4px 10px', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.semibold, cursor: offset + PAGE_SIZE >= bucketTotal ? 'default' : 'pointer', border: '1px solid var(--bdr)', background: 'var(--card)', color: offset + PAGE_SIZE >= bucketTotal ? 'var(--txt3)' : 'var(--txt)', opacity: offset + PAGE_SIZE >= bucketTotal ? 0.5 : 1 }}>Next</button>
              </div>
            </div>
          )}
        </div>

        {/* ── Right panel ────────────────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0, background: 'var(--bg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {selected ? (
            <DetailPanel key={selected.id} contact={selected} onAction={handleAdvance} onRefresh={() => load(true)} />
          ) : isHead ? (
            // Supervisors don't dial — their home is the live team wallboard, scoped to
            // the purpose tab they're on. Clicking a contact still opens its detail.
            <QueueTeamPanel purpose={purposeF} />
          ) : queueDone ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, color: 'var(--txt2)', padding: 24, textAlign: 'center' }}>
              <div style={{ width: 72, height: 72, borderRadius: '50%', background: `${GREEN}18`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 42, color: GREEN }}>task_alt</span>
              </div>
              <span style={{ fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)' }}>You're All Caught Up</span>
              <span style={{ fontSize: TEXT.md, maxWidth: 320 }}>
                Every contact in this list has been worked. New calls will appear here as they're assigned or become due.
              </span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 10, color: 'var(--txt2)' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 52, color: 'var(--txt3)' }}>phone_in_talk</span>
              <span style={{ fontSize: TEXT.md }}>Select a contact to begin calling</span>
            </div>
          )}
        </div>

      </div>

      <ConfirmModal
        open={skipConfirm}
        title="Skip Selected Contacts"
        body={`Skip ${checkedIds.size} selected contact(s) from the queue?`}
        confirmLabel="Skip"
        loading={skipLoading}
        onConfirm={handleSkip}
        onClose={() => setSkipConfirm(false)}
      />

      <ImportContactsModal open={importOpen} onClose={() => setImportOpen(false)} onDone={load} />
      <AssignBatchModal open={assignOpen} defaultPurpose={purposeF || 'all'} available={summary}
        onClose={() => setAssignOpen(false)} onDone={load} />

      <ConfirmModal
        open={distributeConfirm}
        title="Distribute Queue Round-Robin"
        body={`Spread the unassigned pending contacts${purposeF ? ` in ${purposeF}` : ''} evenly across the agents who are online now? (If nobody is online, they go to all agents.)`}
        confirmLabel="Distribute"
        loading={distributing}
        onConfirm={handleDistribute}
        onClose={() => setDistributeConfirm(false)}
      />
    </Page>
  )
}

// ── Assign-a-batch modal (supervisor) ─────────────────────────────────────────
// Hand a chunk of the queue to one agent by count — 20/50/100 or a custom number,
// optionally scoped to a purpose. Assigns the still-pending, unassigned contacts.

// Supervisors see the whole floor and feed the queue; agents work the book they were
// given. Answered once for the whole module in lib/roles — the regex this replaced
// matched on the word "head", so md/coo/cfo/cmo fell through it and the COO was shown
// an agent's view.
function isHeadRole(): boolean {
  return isCallCentreSupervisor()
}

// My display name, used to decide which logged calls I may correct: my own, or —
// if I supervise — anyone's. The backend is the real gate (owner-or-supervisor);
// this just keeps the control off calls it would refuse.
function myFullName(): string {
  try { const u = JSON.parse(localStorage.getItem('o3c_user') || '{}'); return String(u.full_name || u.name || '') } catch { return '' }
}
function canCorrectCall(agentName: string | null | undefined): boolean {
  return isHeadRole() || (!!agentName && agentName.trim() === myFullName().trim())
}

const ASSIGN_PRESETS = [20, 50, 100, 200]

function AssignBatchModal({ open, onClose, onDone, defaultPurpose, available }: {
  open: boolean; onClose: () => void; onDone: () => void
  defaultPurpose: string; available: QueueSummary | null
}) {
  const [agents, setAgents] = useState<{ id: number; full_name: string }[]>([])
  const [agentId, setAgentId] = useState('')
  const [count, setCount] = useState(50)
  const [purpose, setPurpose] = useState(defaultPurpose)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setPurpose(defaultPurpose)
    apiFetch<any>('/api/call-center/agents')
      .then(r => setAgents(Array.isArray(r) ? r : (r?.data ?? [])))
      .catch(() => setAgents([]))
  }, [open, defaultPurpose])

  // What is actually assignable, read from what the summary really returns: the whole
  // pending pool, or one purpose's slice of it. This used to read summary.by_purpose /
  // summary.pending — the endpoint sends neither, so the hint vanished for any purpose.
  const availText = (() => {
    if (!available) return ''
    const n = purpose === 'all' ? available.total : available[purpose as Purpose]
    return n != null ? `${Number(n).toLocaleString()} pending available` : ''
  })()

  async function submit() {
    if (!agentId) { toast.error('Pick an agent'); return }
    if (!count || count < 1) { toast.error('Enter a count'); return }
    setSaving(true)
    try {
      const res = await apiPost<any>('/api/call-center/queue/assign-batch', {
        agent_id: Number(agentId), count, purpose: purpose === 'all' ? '' : purpose,
      })
      const d: any = (res as any)?.data ?? res
      const name = agents.find(a => a.id === Number(agentId))?.full_name ?? 'agent'
      toast.success(`Assigned ${d.assigned ?? 0} contact(s) to ${name}`)
      onClose(); onDone()
    } catch (e: any) { toast.error(e?.message || 'Assign failed') }
    finally { setSaving(false) }
  }

  const fld: React.CSSProperties = { width: '100%', height: 38, padding: '0 11px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { display: 'block', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.03em' }

  return (
    <Modal open={open} onClose={onClose} title="Assign Queue to an Agent" width={460}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.medium, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: saving ? 'wait' : 'pointer' }}>
            {saving && <Spinner size={13} color="#fff" />}Assign {count}
          </button>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        <div>
          <label style={lbl}>Agent</label>
          <select value={agentId} onChange={e => setAgentId(e.target.value)} style={fld}>
            <option value="">Select an Agent…</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>How Many</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {ASSIGN_PRESETS.map(p => (
              <button key={p} onClick={() => setCount(p)} style={{
                padding: '7px 13px', borderRadius: RADIUS.md, cursor: 'pointer', fontSize: TEXT.sm, fontWeight: FW.semibold,
                border: `1px solid ${count === p ? NAVY : 'var(--bdr)'}`, background: count === p ? `${NAVY}0e` : 'var(--card)', color: count === p ? NAVY : 'var(--txt2)',
              }}>{p}</button>
            ))}
            <input type="number" min={1} max={1000} value={count} onChange={e => setCount(Math.max(1, Math.min(1000, Number(e.target.value) || 0)))}
              style={{ ...fld, width: 90, height: 34 }} title="Custom count" />
          </div>
        </div>
        <div>
          <label style={lbl}>Purpose</label>
          <select value={purpose} onChange={e => setPurpose(e.target.value)} style={fld}>
            <option value="all">All Purposes</option>
            <option value="marketing">Marketing</option>
            <option value="collections">Collections</option>
            <option value="support">Support</option>
          </select>
          {availText && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 5 }}>{availText}</div>}
        </div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
          Assigns the highest-priority, oldest-queued pending contacts that aren’t already assigned.
        </div>
      </div>
    </Modal>
  )
}
