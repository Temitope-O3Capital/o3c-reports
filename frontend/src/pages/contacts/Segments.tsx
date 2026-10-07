import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner, Modal, ConfirmModal, EmptyState, Button, Input, Select, Textarea, btnPrimary, btnSecondary } from '../../components/UI'
import { apiFetch, apiPost, apiPut, apiDelete, unwrap } from '../../lib/api'
import { useLiveData } from '../../hooks/useRealtime'
import { fmtNum, fmtDatetime } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, RED, BLUE, MONO, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'
import { humanLabel } from '../../lib/labels'

// ── Criteria model (maps to backend segmentCriteria) ───────────────────────────

// "customers" = everyone holding a live product, which is the platform's own definition
// of an active customer (app.customer_lifecycle.open_products > 0) and the same one the
// servicing consent basis was seeded from. "applications" = the loan book, which is what
// this page could only ever offer before — and which currently holds 8 rows, none with a
// CIF, so it was structurally incapable of returning anybody.
type Audience = 'customers' | 'applications'

// How to treat customers whose last transaction date is unknown — 11,483 of the 17,890
// active ones. A NULL there means no transaction data reached us, NOT a customer proven
// to be quiet, so there is no default that is both convenient and honest: "not transacted
// in 90 days" is 5,268 people with the unknowns left out and 16,866 with them folded in.
type NeverTransacted = '' | 'include' | 'exclude' | 'only'

interface Criteria {
  audience: Audience
  require_email: boolean; require_phone: boolean
  // Customer-base filters
  buckets: string[]; value_tiers: string[]
  days_since_txn_min: string; days_since_txn_max: string
  never_transacted: NeverTransacted
  exclude_recovery: boolean
  // Loan-book filters
  product_type: string; stage: string; status: string; employer: string
  dpd_min: string; dpd_max: string; outstanding_min: string; outstanding_max: string
}
const EMPTY_CRITERIA: Criteria = {
  audience: 'customers', require_email: false, require_phone: false,
  buckets: [], value_tiers: [], days_since_txn_min: '', days_since_txn_max: '',
  never_transacted: '', exclude_recovery: false,
  product_type: '', stage: '', status: '', employer: '', dpd_min: '', dpd_max: '', outstanding_min: '', outstanding_max: '',
}

// Straight from app.customer_lifecycle, with the counts of ACTIVE customers in each as at
// 2026-10-06 so the picker says how big a choice is before it is made.
const LIFECYCLE_BUCKETS: { v: string; label: string }[] = [
  { v: 'active',   label: 'Active — transacted in the last 30 days (858)' },
  { v: 'cooling',  label: 'Cooling — 31-58 days (58)' },
  { v: 'at_risk',  label: 'At risk — 61-90 days (118)' },
  { v: 'dormant',  label: 'Dormant — 91-180 days (107)' },
  { v: 'lapsed',   label: 'Lapsed — 183-365 days (170)' },
  { v: 'churned',  label: 'Churned — over a year (5,096)' },
  { v: 'unknown',  label: 'Unknown — no transaction data (11,483)' },
]
const VALUE_TIERS = ['vip', 'gold', 'silver', 'mass', 'unclassified']

const PRODUCT_TYPES = ['Salary Loan', 'Individual Loan', 'Business Loan', 'Credit Card', 'Payday Loan']
const STAGES = ['submitted', 'pre-screening', 'underwriting', 'approval', 'disbursed', 'active', 'closed']
const STATUSES = ['pending', 'active', 'disbursed', 'rejected', 'cancelled', 'written_off']

interface SegmentCriteria {
  audience?: Audience; require_email?: boolean; require_phone?: boolean
  buckets?: string[]; value_tiers?: string[]
  min_days_since_txn?: number; max_days_since_txn?: number
  never_transacted?: NeverTransacted; exclude_recovery?: boolean
  products?: string[]; stages?: string[]; statuses?: string[]; employers?: string[]
  min_dpd?: number; max_dpd?: number; min_outstanding_kobo?: number; max_outstanding_kobo?: number
}
// What a build or preview actually did, rather than a bare count that hides what it dropped.
interface SegmentSizing {
  count: number; imported?: number; matched?: number; no_contact?: number; mailable?: number
  textable?: number; known_people?: number; truncated?: number; collided?: number
  audience?: Audience
}
interface SavedSegment {
  id: number; name: string; description?: string; criteria: any
  last_count?: number; last_list_id?: number; last_refreshed_at?: string
  list_name?: string; list_member_count?: number; created_by_name?: string; updated_at?: string
  auto_refresh?: boolean; refresh_interval_hours?: number
  last_auto_refresh_at?: string | null
  // Why the last automatic rebuild failed. Kept on the row because a segment that has
  // quietly stopped updating looks exactly like one that is up to date.
  last_refresh_error?: string | null
  list_consent_basis?: string | null
}

function toCriteriaObj(c: Criteria): SegmentCriteria {
  const o: SegmentCriteria = { audience: c.audience }
  if (c.require_email) o.require_email = true
  if (c.require_phone) o.require_phone = true
  // Never send a loan filter on a customer segment, or a customer filter on a loan one:
  // the backend refuses either combination outright rather than silently widening the
  // audience to everybody.
  if (c.audience === 'customers') {
    if (c.buckets.length) o.buckets = c.buckets
    if (c.value_tiers.length) o.value_tiers = c.value_tiers
    if (c.days_since_txn_min) o.min_days_since_txn = parseInt(c.days_since_txn_min, 10)
    if (c.days_since_txn_max) o.max_days_since_txn = parseInt(c.days_since_txn_max, 10)
    if (c.never_transacted) o.never_transacted = c.never_transacted
    if (c.exclude_recovery) o.exclude_recovery = true
    return o
  }
  if (c.product_type) o.products = [c.product_type]
  if (c.stage) o.stages = [c.stage]
  if (c.status) o.statuses = [c.status]
  if (c.employer) o.employers = [c.employer]
  if (c.dpd_min) o.min_dpd = parseInt(c.dpd_min, 10)
  if (c.dpd_max) o.max_dpd = parseInt(c.dpd_max, 10)
  if (c.outstanding_min) o.min_outstanding_kobo = Math.round(parseFloat(c.outstanding_min) * 100)
  if (c.outstanding_max) o.max_outstanding_kobo = Math.round(parseFloat(c.outstanding_max) * 100)
  return o
}
function fromCriteriaObj(raw: any): Criteria {
  let o: SegmentCriteria = {}
  try { o = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {}) } catch { o = {} }
  return {
    // Saved segments predate the audience field; they were all loan-book segments.
    audience: o.audience === 'customers' ? 'customers' : 'applications',
    require_email: !!o.require_email,
    require_phone: !!o.require_phone,
    buckets: o.buckets ?? [],
    value_tiers: o.value_tiers ?? [],
    days_since_txn_min: o.min_days_since_txn ? String(o.min_days_since_txn) : '',
    days_since_txn_max: o.max_days_since_txn ? String(o.max_days_since_txn) : '',
    never_transacted: o.never_transacted ?? '',
    exclude_recovery: !!o.exclude_recovery,
    product_type: o.products?.[0] ?? '',
    stage: o.stages?.[0] ?? '',
    status: o.statuses?.[0] ?? '',
    employer: o.employers?.[0] ?? '',
    dpd_min: o.min_dpd ? String(o.min_dpd) : '',
    dpd_max: o.max_dpd ? String(o.max_dpd) : '',
    outstanding_min: o.min_outstanding_kobo ? String(o.min_outstanding_kobo / 100) : '',
    outstanding_max: o.max_outstanding_kobo ? String(o.max_outstanding_kobo / 100) : '',
  }
}
function criteriaChips(raw: any): string[] {
  const c = fromCriteriaObj(raw)
  const chips: string[] = []
  chips.push(c.audience === 'customers' ? 'Active customers' : 'Loan book')
  if (c.require_email) chips.push('has email')
  if (c.require_phone) chips.push('has phone')
  if (c.audience === 'customers') {
    if (c.buckets.length) chips.push(c.buckets.join(' / '))
    if (c.value_tiers.length) chips.push(c.value_tiers.join(' / '))
    if (c.days_since_txn_min || c.days_since_txn_max) {
      chips.push(`quiet ${c.days_since_txn_min || '0'}–${c.days_since_txn_max || '∞'} days`)
    }
    if (c.never_transacted === 'only') chips.push('no transaction data only')
    if (c.never_transacted === 'include') chips.push('incl. no transaction data')
    if (c.never_transacted === 'exclude') chips.push('excl. no transaction data')
    if (c.exclude_recovery) chips.push('not with recovery')
    return chips
  }
  if (c.product_type) chips.push(c.product_type)
  if (c.stage) chips.push(`stage: ${c.stage}`)
  if (c.status) chips.push(`status: ${c.status}`)
  if (c.employer) chips.push(`employer ~ ${c.employer}`)
  if (c.dpd_min || c.dpd_max) chips.push(`DPD ${c.dpd_min || '0'}–${c.dpd_max || '∞'}`)
  if (c.outstanding_min || c.outstanding_max) chips.push(`₦${c.outstanding_min || '0'}–${c.outstanding_max || '∞'}`)
  return chips.length ? chips : ['All contacts']
}

const inputStyle: React.CSSProperties = { padding: '7px 10px', borderRadius: RADIUS.md, border: '1px solid var(--input-bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, width: '100%', boxSizing: 'border-box' }
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }
const lbl: React.CSSProperties = { fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Segments() {
  const navigate = useNavigate()
  const [segments, setSegments] = useState<SavedSegment[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SavedSegment | null>(null)
  const [builder, setBuilder] = useState<{ open: boolean; editing: SavedSegment | null }>({ open: false, editing: null })
  const [consentFor, setConsentFor] = useState<SavedSegment | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setErr(null)
    try {
      const res = await apiFetch<SavedSegment[]>('/api/contact-lists/segments')
      setSegments(Array.isArray(res) ? res : [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true))

  async function refreshSegment(s: SavedSegment) {
    setRefreshing(s.id)
    try {
      const res = await apiPost<any>(`/api/contact-lists/segments/${s.id}/materialize`, {})
      const o = unwrap<SegmentSizing>(res)
      const imported = o?.imported ?? o?.count ?? 0
      // Say what was dropped, not just what landed. A refresh that silently skipped
      // people with no address, or stopped at the cap, reads as a success otherwise.
      const notes: string[] = []
      if (o?.mailable != null) notes.push(`${fmtNum(o.mailable)} mailable`)
      if (o?.no_contact) notes.push(`${fmtNum(o.no_contact)} skipped with no usable address`)
      if (o?.collided) notes.push(`${fmtNum(o.collided)} sharing a phone already in the list`)
      if (o?.truncated) notes.push(`${fmtNum(o.truncated)} over the cap`)
      toast.success(`Refreshed: ${fmtNum(imported)} contacts`
        + (notes.length ? ` — ${notes.join(', ')}` : ''))
      load(true)
    } catch (e: any) { toast.error(e.message ?? 'Refresh failed') }
    finally { setRefreshing(null) }
  }

  async function doDelete() {
    if (!deleteTarget) return
    try { await apiDelete(`/api/contact-lists/segments/${deleteTarget.id}`); setDeleteTarget(null); load() }
    catch (e: any) { setErr(e.message) }
  }

  return (
    <Page
      title="Contact Segments"
      subtitle="Saved audiences you refresh on demand — a snapshot each time, not a live view"
      loading={loading && segments.length === 0}
      actions={
        <button onClick={() => setBuilder({ open: true, editing: null })} style={btnPrimary}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Segment
        </button>
      }
    >
      <ErrBanner error={err} onRetry={() => load()} />

      <ContactQualityCard />

      <SectionCard
        title="Saved Segments" badge={segments.length}
        subtitle="A segment stores its filters so you can refresh its contact list any time"
      >
        {loading ? (
          <div style={{ padding: 30, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : segments.length === 0 ? (
          <EmptyState icon="groups" title="No Segments Yet"
            description="Create a segment to define a reusable audience you can refresh into a contact list."
            action={{ label: 'New Segment', onClick: () => setBuilder({ open: true, editing: null }), icon: 'add' }} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {segments.map(s => (
              <div key={s.id} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                    {s.description && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 1 }}>{s.description}</div>}
                  </div>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, margin: '10px 0' }}>
                  {criteriaChips(s.criteria).map((c, i) => (
                    <span key={i} style={{ fontSize: TEXT.xs, padding: '2px 8px', borderRadius: RADIUS.full, background: `${NAVY}12`, color: NAVY, fontWeight: FW.semibold }}>{c}</span>
                  ))}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: TEXT.xs, color: 'var(--txt2)', marginBottom: 10 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 15, color: BLUE }}>group</span>
                    <span style={{ fontFamily: MONO, fontWeight: FW.semibold, color: 'var(--txt)' }}>{fmtNum(s.list_member_count ?? s.last_count ?? 0)}</span> contacts
                  </span>
                  <span style={{ color: 'var(--txt3)' }}>
                    {s.last_refreshed_at ? `Refreshed ${fmtDatetime(s.last_refreshed_at)}` : 'Not yet built'}
                  </span>
                  {/* Whether it keeps itself current, said on the card: a segment that
                      stopped updating is otherwise indistinguishable from a fresh one. */}
                  {s.auto_refresh ? (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: GREEN, fontWeight: FW.semibold }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 14 }}>autorenew</span>
                      every {s.refresh_interval_hours === 1 ? 'hour'
                        : s.refresh_interval_hours === 168 ? 'week'
                        : `${s.refresh_interval_hours ?? 24}h`}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--txt3)' }}>manual only</span>
                  )}
                </div>

                {/* Whether a marketing campaign could actually send to this segment. A
                    prospect list with no recorded basis is refused at dispatch, so saying
                    so here is cheaper than finding out from a campaign that sent nothing. */}
                {s.last_list_id && (
                  <div style={{ fontSize: TEXT.xs, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14, color: s.list_consent_basis ? GREEN : AMBER }}>
                      {s.list_consent_basis ? 'verified_user' : 'gpp_maybe'}
                    </span>
                    <span style={{ color: 'var(--txt2)' }}>
                      {s.list_consent_basis
                        ? <>Marketing basis: <strong style={{ color: 'var(--txt1)' }}>{humanLabel(s.list_consent_basis)}</strong></>
                        : <>No marketing basis recorded — servicing only</>}
                    </span>
                  </div>
                )}

                {/* A failed automatic rebuild, on the card rather than only in the log. */}
                {s.last_refresh_error && (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 10,
                                padding: '6px 9px', borderRadius: RADIUS.md,
                                background: `${RED}0E`, border: `1px solid ${RED}33`,
                                fontSize: TEXT.xs, color: 'var(--txt1)', lineHeight: 1.5 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 15, color: RED }}>error</span>
                    <span><strong>Last automatic rebuild failed.</strong> {s.last_refresh_error}</span>
                  </div>
                )}

                <div style={{ display: 'flex', gap: 6, marginTop: 'auto', paddingTop: 10, borderTop: '1px solid var(--bdr)' }}>
                  <button onClick={() => refreshSegment(s)} disabled={refreshing === s.id}
                    style={{ ...miniBtn, background: NAVY, color: '#fff', border: 'none', opacity: refreshing === s.id ? 0.6 : 1 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{refreshing === s.id ? 'progress_activity' : 'refresh'}</span>
                    {refreshing === s.id ? 'Refreshing…' : (s.last_list_id ? 'Refresh' : 'Build List')}
                  </button>
                  {s.last_list_id && (
                    <button onClick={() => navigate('/campaigns/lists')} style={{ ...miniBtn, background: 'var(--card)', color: 'var(--txt2)', border: '1px solid var(--bdr)' }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 15 }}>list</span>List
                    </button>
                  )}
                  {s.last_list_id && (
                    <button onClick={() => setConsentFor(s)} style={{ ...miniBtn, background: 'var(--card)', color: 'var(--txt2)', border: '1px solid var(--bdr)' }}
                      title="Who in this segment may be marketed to">
                      <span className="material-symbols-rounded" style={{ fontSize: 15 }}>verified_user</span>Consent
                    </button>
                  )}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
                    <IconBtn icon="edit" title="Edit" onClick={() => setBuilder({ open: true, editing: s })} />
                    <IconBtn icon="delete" title="Delete" danger onClick={() => setDeleteTarget(s)} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {builder.open && (
        <SegmentBuilder
          editing={builder.editing}
          onClose={() => setBuilder({ open: false, editing: null })}
          onSaved={() => { setBuilder({ open: false, editing: null }); load() }}
        />
      )}

      {consentFor && (
        <SegmentConsent
          segment={consentFor}
          onClose={() => setConsentFor(null)}
          onSaved={() => load(true)}
        />
      )}

      <ConfirmModal open={!!deleteTarget} title="Delete Segment"
        body={`Delete "${deleteTarget?.name}"? The generated contact list is kept.`}
        onConfirm={doDelete} onClose={() => setDeleteTarget(null)} />
    </Page>
  )
}

// ── Consent for a whole segment ───────────────────────────────────────────────

interface ConsentChannel {
  channel: string; members: number; known_customers: number
  marketing_granted: number; withdrawn: number; never_asked: number
}
interface ConsentStatus { built?: boolean; list_id?: number; channels?: ConsentChannel[] }

const CONSENT_BASES: { v: string; label: string; note: string }[] = [
  { v: 'opt_in_collected', label: 'They Opted In', note: 'they asked us to contact them, and we hold the record' },
  { v: 'legitimate_interest', label: 'Legitimate Interest', note: 'an existing relationship, on a related subject' },
  { v: 'third_party_asserted', label: 'Third Party Asserted It', note: 'the source claims consent — we did not collect it' },
  { v: 'not_for_marketing', label: 'Not For Marketing', note: 'explicitly never to be marketed to' },
]

// Two different questions live in this one modal, because they are two different populations
// in the same segment and nobody should have to know that to use it.
//
// A KNOWN CUSTOMER has a party_id, so consent is a per-person record in
// app.party_contact_consent — the same row the Consent Register shows, written here for a
// population somebody has already defined instead of by pasting 10,896 ids into a textarea.
// A PROSPECT has no party_id and never will until they become a customer, so there is no
// per-person row to write; what governs them is the basis recorded on the list itself.
// Marketing to a prospect list with no basis is refused at dispatch, which is why the
// list-level question is answerable here rather than only in the API.
function SegmentConsent({ segment, onClose, onSaved }: {
  segment: SavedSegment; onClose: () => void; onSaved: () => void
}) {
  const [status, setStatus] = useState<ConsentStatus | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const [channels, setChannels] = useState<string[]>(['email'])
  const [purpose, setPurpose] = useState('marketing')
  const [state, setState] = useState('granted')
  const [basis, setBasis] = useState('')
  const [evidence, setEvidence] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  const [listBasis, setListBasis] = useState(segment.list_consent_basis ?? '')
  const [listNote, setListNote] = useState('')
  const [savingBasis, setSavingBasis] = useState(false)

  const loadStatus = useCallback(() => {
    apiFetch<ConsentStatus>(`/api/contact-lists/segments/${segment.id}/consent`)
      .then(r => setStatus(unwrap<ConsentStatus>(r) ?? null))
      .catch(e => setErr(e.message))
  }, [segment.id])
  useEffect(() => { loadStatus() }, [loadStatus])

  const known = status?.channels?.[0]?.known_customers ?? 0
  const members = status?.channels?.[0]?.members ?? 0
  const prospects = Math.max(0, members - known)

  const needsConfirm = purpose === 'marketing' && state === 'granted'
  const ready = channels.length > 0 && known > 0
    && (!needsConfirm || (confirm === 'I HAVE THE EVIDENCE' && basis.trim() !== '' && evidence.trim().length >= 8))

  async function submit() {
    setBusy(true)
    try {
      const r = unwrap<any>(await apiPost(`/api/contact-lists/segments/${segment.id}/consent`, {
        channels, purpose, state, basis, evidence, confirm,
      }))
      toast.success(`${purpose} consent recorded as ${state} for ${fmtNum(r?.customers ?? 0)} customers`)
      setConfirm('')
      loadStatus()
      onSaved()
    } catch (e: any) { toast.error(e?.message ?? 'Could not record the decision') }
    finally { setBusy(false) }
  }

  async function saveBasis() {
    setSavingBasis(true)
    try {
      await apiPut(`/api/contact-lists/${segment.last_list_id}/consent-basis`,
        { basis: listBasis, note: listNote })
      toast.success(listBasis ? 'Marketing basis recorded for this list' : 'Marketing basis cleared')
      onSaved()
    } catch (e: any) { toast.error(e?.message ?? 'Could not record the basis') }
    finally { setSavingBasis(false) }
  }

  return (
    <Modal open onClose={onClose} title={`Consent — ${segment.name}`} width={700}
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <ErrBanner error={err} onRetry={loadStatus} />

      {!status ? (
        <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      ) : !status.built ? (
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
          Build this segment's list first — there is nobody to record a decision about yet.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: SP[4] }}>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: TEXT.xs }}>
            <QFact label="In the list" value={fmtNum(members)} />
            <QFact label="Known customers" value={fmtNum(known)} tone={known ? GREEN : undefined}
              note="consent is a per-person record" />
            <QFact label="Prospects" value={fmtNum(prospects)} tone={prospects ? AMBER : undefined}
              note="governed by the list basis below" />
          </div>

          {/* Where marketing consent actually stands, per channel, before anybody decides. */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.xs }}>
              <thead>
                <tr style={{ color: 'var(--txt3)', textAlign: 'left' }}>
                  <th style={cth}>Channel</th><th style={cthNum}>Granted</th>
                  <th style={cthNum}>Withdrawn</th><th style={cthNum}>Never Asked</th>
                </tr>
              </thead>
              <tbody>
                {(status.channels ?? []).map(c => (
                  <tr key={c.channel} style={{ borderTop: '1px solid var(--bdr)' }}>
                    <td style={ctd}>{humanLabel(c.channel)}</td>
                    <td style={{ ...ctdNum, color: c.marketing_granted ? GREEN : 'var(--txt3)', fontWeight: FW.semibold }}>{fmtNum(c.marketing_granted)}</td>
                    <td style={{ ...ctdNum, color: c.withdrawn ? RED : 'var(--txt3)' }}>{fmtNum(c.withdrawn)}</td>
                    <td style={ctdNum}>{fmtNum(c.never_asked)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.6,
                        padding: '8px 10px', borderRadius: RADIUS.md, background: `${BLUE}0C`, border: `1px solid ${BLUE}30` }}>
            A <strong>servicing</strong> message — about a product someone already holds — needs no
            consent at all and is never blocked here. Everything below is about <strong>marketing</strong>.
          </div>

          {/* ── Known customers ── */}
          {known > 0 && (
            <div style={{ display: 'grid', gap: SP[3] }}>
              <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                Record A Decision For The {fmtNum(known)} Known Customers
              </div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                One basis and one piece of evidence covers everybody in this segment. If these
                people did not all agree in the same way, they belong in separate segments.
              </div>
              <div>
                <label style={lbl}>Channels This Covers</label>
                <MultiPick options={['email', 'sms', 'whatsapp'].map(v => ({ v, label: humanLabel(v) }))}
                  selected={channels} onChange={setChannels} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[2] }}>
                <Select label="Purpose" value={purpose} onChange={e => setPurpose(e.target.value)}>
                  <option value="marketing">Marketing</option>
                  <option value="servicing">Servicing</option>
                </Select>
                <Select label="Answer" value={state} onChange={e => setState(e.target.value)}>
                  <option value="granted">Granted</option>
                  <option value="withdrawn">Withdrawn</option>
                  <option value="pending">Pending</option>
                </Select>
              </div>
              <Input label="Basis" placeholder="signup_form, call_confirmation, contract_clause_8"
                value={basis} onChange={e => setBasis(e.target.value)}
                hint={needsConfirm ? 'Required for a marketing yes: how did they give it?' : undefined} />
              <Input label="Evidence" placeholder="Onboarding form batch 2026-09, scanned to DMS/consent/2026-09"
                value={evidence} onChange={e => setEvidence(e.target.value)}
                hint={needsConfirm ? 'Required. Name the form, call or document — not the answer.' : undefined} />
              {needsConfirm && (
                <div style={{ border: `1px solid ${AMBER}55`, background: `${AMBER}0d`, borderRadius: RADIUS.md, padding: SP[3] }}>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt1)', marginBottom: SP[2], lineHeight: 1.6 }}>
                    You are recording that {fmtNum(known)} people agreed to marketing contact. This is
                    the document that makes those messages lawful. Type <strong>I HAVE THE EVIDENCE</strong> to continue.
                  </div>
                  <Input value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="I HAVE THE EVIDENCE" />
                </div>
              )}
              <div>
                <Button onClick={submit} disabled={!ready || busy}>
                  {busy ? 'Recording…' : `Record For ${fmtNum(known)} Customers`}
                </Button>
              </div>
            </div>
          )}

          {/* ── Prospects ── */}
          {prospects > 0 && (
            <div style={{ display: 'grid', gap: SP[3], paddingTop: SP[3], borderTop: '1px solid var(--bdr)' }}>
              <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                Marketing Basis For The {fmtNum(prospects)} Prospects
              </div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.6 }}>
                These people are not customers yet, so there is no per-person consent record to
                write. What makes marketing to them defensible is where the list came from —
                recorded once, on the list. <strong>With nothing recorded, a marketing campaign
                to this list is refused.</strong>
              </div>
              <Select label="Basis" value={listBasis} onChange={e => setListBasis(e.target.value)}>
                <option value="">Nothing recorded — marketing refused</option>
                {CONSENT_BASES.map(b => <option key={b.v} value={b.v}>{b.label} — {b.note}</option>)}
              </Select>
              <Textarea label="Where This List Came From" rows={3} value={listNote}
                onChange={e => setListNote(e.target.value)}
                placeholder="CRC bureau extract, supplied 2026-09-28, supplier asserts opt-in at point of capture"
                hint={listBasis === 'third_party_asserted'
                  ? 'Required: name the supplier and what they asserted. A third-party claim with no note cannot be defended later.'
                  : 'Optional, but it is what somebody reads in a year when asked why we mailed these people.'} />
              <div>
                <Button onClick={saveBasis}
                  disabled={savingBasis || (listBasis === 'third_party_asserted' && !listNote.trim())}>
                  {savingBasis ? 'Saving…' : 'Record Basis'}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

const cth: React.CSSProperties = { padding: '6px 8px', fontWeight: FW.medium, whiteSpace: 'nowrap' }
const cthNum: React.CSSProperties = { ...cth, textAlign: 'right' }
const ctd: React.CSSProperties = { padding: '6px 8px', color: 'var(--txt1)' }
const ctdNum: React.CSSProperties = { ...ctd, textAlign: 'right', fontFamily: MONO }

// ── Contact data checker ──────────────────────────────────────────────────────

interface QualityTotals {
  people: number; emailable: number; dialable: number
  email_unusable: number; phone_unusable: number
  email_missing: number; phone_missing: number; unreachable: number
}
interface Offender { value: string; people: number }
interface Quality {
  totals?: QualityTotals
  phone_offenders?: Offender[]
  email_offenders?: Offender[]
}

// Why this is here and not a KPI somewhere: a reachability percentage is not actionable,
// a list of the actual broken values is. 4,073 active customers share the phone number
// 08012345678 — that is one bad default in whatever form or import produced them, not
// 4,073 separate mistakes, and it is fixable in one go once somebody can see it.
function ContactQualityCard() {
  const [q, setQ] = useState<Quality | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    apiFetch<Quality>('/api/contact-lists/contact-quality')
      .then(r => setQ(unwrap<Quality>(r) ?? null))
      .catch(e => setErr(e.message))
  }, [])

  if (err) return null
  if (!q?.totals) return null
  const t = q.totals
  const broken = t.phone_unusable + t.email_unusable

  return (
    <SectionCard title="Contact Data Check"
      subtitle="Whether the email and phone we hold for active customers could actually be used"
      style={{ marginBottom: SP[4] }}
      actions={broken > 0 ? (
        <button onClick={() => setOpen(o => !o)} style={{ ...miniBtn, background: 'var(--card)', color: 'var(--txt2)', border: '1px solid var(--bdr)' }}>
          {open ? 'Hide' : 'Show'} the worst values
        </button>
      ) : undefined}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: SP[3] }}>
        <QFact label="Active Customers" value={fmtNum(t.people)} />
        <QFact label="Can Be Emailed" value={fmtNum(t.emailable)} tone={GREEN} />
        <QFact label="Can Be Called" value={fmtNum(t.dialable)} tone={GREEN} />
        <QFact label="Phone Unusable" value={fmtNum(t.phone_unusable)}
          tone={t.phone_unusable > 0 ? RED : undefined}
          note="a number is stored but cannot be dialled" />
        <QFact label="Email Unusable" value={fmtNum(t.email_unusable)}
          tone={t.email_unusable > 0 ? AMBER : undefined}
          note="an address is stored but is not an address" />
        <QFact label="No Contact At All" value={fmtNum(t.unreachable)}
          tone={t.unreachable > 0 ? AMBER : undefined}
          note={`${fmtNum(t.phone_missing)} no phone, ${fmtNum(t.email_missing)} no email`} />
      </div>

      {broken > 0 && (
        <div style={{ marginTop: SP[3], fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.6 }}>
          These are counted as unreachable everywhere a segment or a campaign asks who can
          be contacted, so fixing them widens every audience at once. A stored number is
          judged on whether it is a real Nigerian mobile, not merely on being present.
        </div>
      )}

      {open && (
        <div style={{ marginTop: SP[3], display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: SP[3] }}>
          <OffenderList title="Phone numbers that cannot be dialled" rows={q.phone_offenders ?? []} />
          <OffenderList title="Email addresses that are not addresses" rows={q.email_offenders ?? []} />
        </div>
      )}
    </SectionCard>
  )
}

function QFact({ label, value, tone, note }: { label: string; value: string; tone?: string; note?: string }) {
  return (
    <div>
      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontWeight: FW.semibold, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: TEXT.lg, fontWeight: FW.bold, marginTop: 2, color: tone ?? 'var(--txt)' }}>{value}</div>
      {note && <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 2, lineHeight: 1.4 }}>{note}</div>}
    </div>
  )
}

function OffenderList({ title, rows }: { title: string; rows: Offender[] }) {
  return (
    <div>
      <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }}>{title}</div>
      {rows.length === 0 ? (
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>Nothing to fix.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {rows.map(r => (
            <div key={r.value} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: TEXT.sm }}>
              <span style={{ fontFamily: MONO, wordBreak: 'break-all' }}>{r.value}</span>
              <span style={{ fontFamily: MONO, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>{fmtNum(r.people)} customers</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Builder modal ─────────────────────────────────────────────────────────────

function SegmentBuilder({ editing, onClose, onSaved }: { editing: SavedSegment | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(editing?.name ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [criteria, setCriteria] = useState<Criteria>(editing ? fromCriteriaObj(editing.criteria) : EMPTY_CRITERIA)
  const [autoRefresh, setAutoRefresh] = useState(!!editing?.auto_refresh)
  const [intervalHours, setIntervalHours] = useState(editing?.refresh_interval_hours ?? 24)
  const [preview, setPreview] = useState<SegmentSizing | null>(
    editing?.last_count != null ? { count: editing.last_count } : null)
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Values are no longer all strings — audience is a union and the two require_* flags
  // are booleans, so the old `Object.values(...).some(v => v.trim())` would have thrown
  // on a boolean the moment either was touched.
  function update<K extends keyof Criteria>(field: K, value: Criteria[K]) {
    setCriteria(prev => ({ ...prev, [field]: value }))
    setPreview(null)
  }
  const isCustomers = criteria.audience === 'customers'

  async function handlePreview() {
    setErr(null); setPreviewing(true)
    try {
      const res = await apiFetch<any>('/api/contact-lists/segment/preview', { method: 'POST', body: JSON.stringify(toCriteriaObj(criteria)) })
      setPreview(unwrap<SegmentSizing>(res) ?? { count: 0 })
    } catch (e: any) { setErr(e.message ?? 'Preview failed') }
    finally { setPreviewing(false) }
  }

  async function save() {
    if (!name.trim()) { toast.error('Enter a segment name'); return }
    setSaving(true); setErr(null)
    try {
      const body = {
        name: name.trim(), description, criteria: toCriteriaObj(criteria),
        auto_refresh: autoRefresh, refresh_interval_hours: intervalHours,
      }
      if (editing) await apiPut(`/api/contact-lists/segments/${editing.id}`, body)
      else await apiPost('/api/contact-lists/segments', body)
      toast.success(editing ? 'Segment updated' : 'Segment created')
      onSaved()
    } catch (e: any) { setErr(e.message ?? 'Save failed') }
    finally { setSaving(false) }
  }

  return (
    <Modal open onClose={onClose} title={editing ? 'Edit Segment' : 'New Segment'} width={620}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
          <button onClick={handlePreview} disabled={previewing} style={btnSecondary}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{previewing ? 'progress_activity' : 'search'}</span>
            {previewing ? 'Counting…' : 'Preview Count'}
          </button>
          {preview !== null && (
            <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, lineHeight: 1.4,
                           color: preview.count === 0 ? RED : GREEN }}>
              {fmtNum(preview.count)} contacts
              {/* The parts that used to be invisible: who was matched but has no address,
                  and how many can actually be emailed as opposed to merely reached. */}
              {preview.mailable != null && (
                <span style={{ fontWeight: FW.normal, color: 'var(--txt2)' }}>
                  {' · '}{fmtNum(preview.mailable)} mailable
                  {preview.textable != null && `, ${fmtNum(preview.textable)} textable`}
                </span>
              )}
              {/* "No usable address", not "no address": a placeholder like 08012345678
                  counts as nothing here, and 4,073 active customers carry exactly that. */}
              {!!preview.no_contact && (
                <span style={{ fontWeight: FW.normal, color: AMBER }}>
                  {' · '}{fmtNum(preview.no_contact)} with no usable address, skipped
                </span>
              )}
              {!!preview.truncated && (
                <span style={{ fontWeight: FW.normal, color: RED }}>
                  {' · '}{fmtNum(preview.truncated)} over the cap, not included
                </span>
              )}
            </span>
          )}
          <button onClick={save} disabled={saving || !name.trim()} style={{ ...btnPrimary, marginLeft: 'auto', opacity: saving || !name.trim() ? 0.6 : 1 }}>
            {saving ? 'Saving…' : editing ? 'Save Changes' : 'Create Segment'}
          </button>
        </div>
      }>
      {err && <ErrBanner error={err} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
          <div><label style={lbl}>Segment Name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. DPD 30–90 Salary Loans" style={inputStyle} /></div>
          <div><label style={lbl}>Description (Optional)</label><input value={description} onChange={e => setDescription(e.target.value)} placeholder="What this audience is for" style={inputStyle} /></div>
        </div>

        {/* Keeping itself current. Opt-in per segment, and the reason is stated: a
            refresh refills the linked list in place, which is what makes a live
            campaign's audience change underneath it. */}
        <div style={{ background: 'var(--bg)', padding: SP[3], borderRadius: RADIUS.md,
                      border: '1px solid var(--bdr)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: TEXT.sm,
                          fontWeight: FW.semibold, cursor: 'pointer' }}>
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
            Keep this segment up to date automatically
          </label>
          {autoRefresh ? (
            <div style={{ marginTop: SP[2], display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>Rebuild every</span>
              <select value={String(intervalHours)} style={{ ...selectStyle, width: 'auto' }}
                onChange={e => setIntervalHours(parseInt(e.target.value, 10))}>
                <option value="1">hour</option>
                <option value="6">6 hours</option>
                <option value="24">day</option>
                <option value="168">week</option>
              </select>
              <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                The customer base itself is recomputed once a night at 03:30, so anything
                faster than that cannot make the answer fresher.
              </span>
            </div>
          ) : (
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 4, lineHeight: 1.5 }}>
              Off means the list only changes when somebody presses Refresh. A rebuild
              replaces the list's members in place, so a campaign already pointed at it
              would see its audience change — which is why this is a choice.
            </div>
          )}
        </div>

        <div style={{ height: 1, background: 'var(--bdr)' }} />

        {/* Who this segment is drawn from. The two are different populations, not two
            filters on one — which is why the loan-book fields disappear below rather
            than sitting there inert. */}
        <div>
          <label style={lbl}>Draw From</label>
          <select value={criteria.audience} onChange={e => update('audience', e.target.value as Audience)} style={selectStyle}>
            <option value="customers">Active customers — everyone holding a live product</option>
            <option value="applications">Loan book — applications matching the filters below</option>
          </select>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 5, lineHeight: 1.5 }}>
            {isCustomers
              ? 'Rebuilt from the customer base each time you refresh. The list is a snapshot of that moment, not a live view — nothing refreshes it on a schedule.'
              : 'Filtered on loan applications. This table is nearly empty today, so expect a small count.'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: SP[4], flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: TEXT.sm, cursor: 'pointer' }}>
            <input type="checkbox" checked={criteria.require_email}
              onChange={e => update('require_email', e.target.checked)} />
            Only people with an email address
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: TEXT.sm, cursor: 'pointer' }}>
            <input type="checkbox" checked={criteria.require_phone}
              onChange={e => update('require_phone', e.target.checked)} />
            Only people with a phone number
          </label>
        </div>

        {isCustomers ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
              <div>
                <label style={lbl}>Lifecycle Bucket</label>
                <MultiPick options={LIFECYCLE_BUCKETS} selected={criteria.buckets}
                  onChange={v => update('buckets', v)} />
              </div>
              <div>
                <label style={lbl}>Value Tier</label>
                <MultiPick options={VALUE_TIERS.map(v => ({ v, label: humanLabel(v) }))}
                  selected={criteria.value_tiers} onChange={v => update('value_tiers', v)} />
              </div>
            </div>

            {/* "Customers not transacting" — the audience this page is most wanted for. */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
              <div><label style={lbl}>Quiet For At Least (Days)</label>
                <input type="number" min="0" value={criteria.days_since_txn_min}
                  onChange={e => update('days_since_txn_min', e.target.value)}
                  placeholder="e.g. 90" style={inputStyle} /></div>
              <div><label style={lbl}>And At Most (Days)</label>
                <input type="number" min="0" value={criteria.days_since_txn_max}
                  onChange={e => update('days_since_txn_max', e.target.value)}
                  placeholder="leave blank for no upper bound" style={inputStyle} /></div>
            </div>

            <div>
              <label style={lbl}>Customers With No Transaction Date</label>
              <select value={criteria.never_transacted} style={selectStyle}
                onChange={e => update('never_transacted', e.target.value as NeverTransacted)}>
                <option value="">Leave them out of a quiet-for filter (default)</option>
                <option value="exclude">Exclude them entirely</option>
                <option value="include">Count them as quiet too</option>
                <option value="only">Only these customers</option>
              </select>
              {/* The honest part. This is not a tidy-up detail: it is the difference
                  between a 5,268-person dormancy campaign and a 16,866-person one. */}
              <div style={{ fontSize: TEXT.xs, color: AMBER, marginTop: 5, lineHeight: 1.5 }}>
                11,483 of 17,890 active customers have no last-transaction date. That means
                no transaction data reached us — not that they are quiet. "Quiet for 90+
                days" is 5,268 people with them left out, and 16,866 with them counted as
                quiet, so this choice decides most of your audience.
              </div>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: TEXT.sm, cursor: 'pointer' }}>
              <input type="checkbox" checked={criteria.exclude_recovery}
                onChange={e => update('exclude_recovery', e.target.checked)} />
              Leave out anyone a recovery officer is already working
            </label>

            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.5 }}>
              Arrears band, application stage and employer are not offered here: they
              describe a loan application rather than a person, and asking for one would
              widen this audience to everybody instead of narrowing it.
            </div>
          </div>
        ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
          <div><label style={lbl}>Product Type</label>
            <select value={criteria.product_type} onChange={e => update('product_type', e.target.value)} style={selectStyle}>
              <option value="">Any Product</option>{PRODUCT_TYPES.map(p => <option key={p} value={p}>{p}</option>)}
            </select></div>
          <div><label style={lbl}>Stage</label>
            <select value={criteria.stage} onChange={e => update('stage', e.target.value)} style={selectStyle}>
              <option value="">Any Stage</option>{STAGES.map(s => <option key={s} value={s}>{s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>)}
            </select></div>
          <div><label style={lbl}>Status</label>
            <select value={criteria.status} onChange={e => update('status', e.target.value)} style={selectStyle}>
              <option value="">Any Status</option>{STATUSES.map(s => <option key={s} value={s}>{humanLabel(s)}</option>)}
            </select></div>
          <div><label style={lbl}>Employer (Contains)</label><input value={criteria.employer} onChange={e => update('employer', e.target.value)} placeholder="e.g. NNPC, Dangote…" style={inputStyle} /></div>
          <div><label style={lbl}>DPD Min</label><input type="number" min="0" value={criteria.dpd_min} onChange={e => update('dpd_min', e.target.value)} placeholder="e.g. 30" style={inputStyle} /></div>
          <div><label style={lbl}>DPD Max</label><input type="number" min="0" value={criteria.dpd_max} onChange={e => update('dpd_max', e.target.value)} placeholder="e.g. 90" style={inputStyle} /></div>
          <div><label style={lbl}>Outstanding Min (₦)</label><input type="number" min="0" value={criteria.outstanding_min} onChange={e => update('outstanding_min', e.target.value)} placeholder="e.g. 50000" style={inputStyle} /></div>
          <div><label style={lbl}>Outstanding Max (₦)</label><input type="number" min="0" value={criteria.outstanding_max} onChange={e => update('outstanding_max', e.target.value)} placeholder="e.g. 5000000" style={inputStyle} /></div>
        </div>
        )}
      </div>
    </Modal>
  )
}

// ── Small bits ────────────────────────────────────────────────────────────────

// A tick-list rather than a <select multiple>: multi-select boxes are close to unusable
// with a mouse, and these choices carry population counts worth reading before clicking.
function MultiPick({ options, selected, onChange }: {
  options: { v: string; label: string }[]
  selected: string[]
  onChange: (v: string[]) => void
}) {
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter(x => x !== v) : [...selected, v])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 150,
                  overflowY: 'auto', border: '1px solid var(--input-bdr)',
                  borderRadius: RADIUS.md, padding: '6px 8px', background: 'var(--card)' }}>
      {options.map(o => (
        <label key={o.v} style={{ display: 'flex', alignItems: 'center', gap: 6,
                                  fontSize: TEXT.sm, cursor: 'pointer' }}>
          <input type="checkbox" checked={selected.includes(o.v)} onChange={() => toggle(o.v)} />
          {o.label}
        </label>
      ))}
      {selected.length === 0 && (
        <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>none ticked = any</div>
      )}
    </div>
  )
}

const miniBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }
function IconBtn({ icon, title, onClick, danger }: { icon: string; title: string; onClick: () => void; danger?: boolean }) {
  return (
    <button title={title} onClick={onClick}
      style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, border: 'none', background: 'transparent', color: danger ? '#C00000' : 'var(--txt2)', cursor: 'pointer' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      <span className="material-symbols-rounded" style={{ fontSize: 17 }}>{icon}</span>
    </button>
  )
}
