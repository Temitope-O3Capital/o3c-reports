import { useEffect, useState } from 'react'
import { Modal, Tabs, Spinner } from './UI'
import { TimelineTab, ContactsTab, PromisesTab, PaymentsTab } from '../pages/collections/AccountDetail'
import { apiFetch, apiPost } from '../lib/api'
import { fmtKobo } from '../lib/fmt'
import { RED, AMBER, GREEN, NAVY, NUM, TEXT, FW, SP, RADIUS } from '../lib/design'
import { COLLECTIONS_PAYMENT_CHANNELS } from '../lib/paymentChannels'
import { toast } from 'sonner'

// A complete account workspace in a modal — opened from the Collections Queue's
// "Full Detail" so an agent/supervisor never loses their place. It reuses the very
// tab components the full Account Detail page renders (Timeline, Contacts, Promises,
// Payments) AND carries the day-to-day actions inline (log a contact, record a PTP,
// log a payment) so it is sufficient on its own — no page hop needed.

interface Snap {
  applicant_cif:    string
  applicant_name:   string
  product_type:     string | null
  dpd_bucket:       string | null
  dpd_lower:        number
  outstanding_kobo: number
  principal_kobo:   number
  current_stage:    string | null
  assignment_id:    number | null
  total_contacts:   number
  ptps_created:     number
  ptps_kept:        number
  total_paid_kobo:  number
}

function dpdColor(dpd: number) {
  if (dpd > 90) return RED
  if (dpd > 60) return '#EA580C'
  if (dpd > 30) return AMBER
  return GREEN
}

const TABS = [
  { key: 'timeline', label: 'Timeline' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'promises', label: 'Promises' },
  { key: 'payments', label: 'Payments' },
]

const CONTACT_TYPES = [
  { value: 'phone', label: 'Phone Call' }, { value: 'sms', label: 'SMS' },
  { value: 'whatsapp', label: 'WhatsApp' }, { value: 'email', label: 'Email' },
  { value: 'field_visit', label: 'Field Visit' },
]
const OUTCOMES = [
  { value: 'answered', label: 'Answered' }, { value: 'no_answer', label: 'No Answer' },
  { value: 'not_reachable', label: 'Not Reachable' }, { value: 'promised_to_pay', label: 'Promised to Pay' },
  { value: 'refused_to_pay', label: 'Refused to Pay' },
]
const CHANNELS = COLLECTIONS_PAYMENT_CHANNELS

const todayStr = () => new Date().toISOString().slice(0, 10)

const inp: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 6 }

function Chips<T extends string>({ options, value, onChange, accent = NAVY }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; accent?: string }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
      {options.map(o => (
        <button key={o.value} onClick={() => onChange(o.value)}
          style={{ padding: '5px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', border: `1.5px solid ${value === o.value ? accent : 'var(--bdr)'}`, background: value === o.value ? accent : 'var(--card)', color: value === o.value ? '#fff' : 'var(--txt)' }}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function CollectionsAccountModal({ cif, onClose }: { cif: string | null; onClose: () => void }) {
  const [snap, setSnap]       = useState<Snap | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab]         = useState('timeline')
  const [version, setVersion] = useState(0) // bumped after an action so the tabs refetch

  // Record panel
  const [act, setAct]       = useState<'contact' | 'ptp' | 'payment'>('contact')
  const [saving, setSaving] = useState(false)
  const [ctType, setCtType]       = useState('phone')
  const [ctOutcome, setCtOutcome] = useState('answered')
  const [ctNotes, setCtNotes]     = useState('')
  const [ptpAmount, setPtpAmount] = useState('')
  const [ptpDate, setPtpDate]     = useState('')
  const [payAmount, setPayAmount] = useState('')
  const [payDate, setPayDate]     = useState(todayStr())
  const [payChannel, setPayChannel] = useState('bank_transfer')
  const [payRef, setPayRef]       = useState('')

  function loadSnap() {
    if (!cif) return
    setLoading(true)
    apiFetch<{ data: Snap }>(`/api/collections/accounts/${cif}`)
      .then(r => setSnap(r.data ?? null))
      .catch(() => setSnap(null))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!cif) { setSnap(null); return }
    setTab('timeline'); setAct('contact')
    setCtType('phone'); setCtOutcome('answered'); setCtNotes('')
    setPtpAmount(''); setPtpDate('')
    setPayAmount(''); setPayDate(todayStr()); setPayChannel('bank_transfer'); setPayRef('')
    loadSnap()
  }, [cif]) // eslint-disable-line react-hooks/exhaustive-deps

  const d = snap
  const aid = snap?.assignment_id ?? null
  const title = d && d.applicant_name && d.applicant_name !== d.applicant_cif ? d.applicant_name : cif ? `Account ${cif}` : 'Account'

  function afterAction(msg: string) { toast.success(msg); setVersion(v => v + 1); loadSnap() }

  async function logContact() {
    if (!aid) return
    setSaving(true)
    try {
      await apiPost(`/api/collections-ops/${aid}/contact`, { contact_type: ctType, outcome: ctOutcome, notes: ctNotes || null })
      setCtNotes(''); afterAction('Contact logged')
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }
  async function recordPTP() {
    if (!aid) return
    const naira = parseFloat(ptpAmount.replace(/,/g, ''))
    if (!naira || naira <= 0) { toast.error('Enter a valid amount'); return }
    if (!ptpDate) { toast.error('Select a promise date'); return }
    setSaving(true)
    try {
      await apiPost(`/api/collections-ops/${aid}/promise`, { amount_kobo: Math.round(naira * 100), promise_date: ptpDate })
      setPtpAmount(''); setPtpDate(''); afterAction('PTP recorded')
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }
  async function logPayment() {
    if (!aid) return
    const naira = parseFloat(payAmount.replace(/,/g, ''))
    if (!naira || naira <= 0) { toast.error('Enter a valid amount'); return }
    if (!payDate) { toast.error('Payment date is required'); return }
    setSaving(true)
    try {
      await apiPost(`/api/collections-ops/${aid}/payment`, { amount_kobo: Math.round(naira * 100), payment_date: payDate, channel: payChannel, reference: payRef.trim() || null })
      setPayAmount(''); setPayRef(''); afterAction('Payment submitted, pending approval')
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }

  const saveBtn = (onClick: () => void, label: string, color: string) => (
    <button onClick={onClick} disabled={saving || !aid}
      style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: 'none', background: color, color: '#fff', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: saving || !aid ? 'not-allowed' : 'pointer', opacity: saving || !aid ? 0.6 : 1, display: 'inline-flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }}>
      {saving && <Spinner size={13} color="#fff" />}{label}
    </button>
  )

  return (
    <Modal open={cif !== null} onClose={onClose} title={title} width={680} maxHeight="86vh"
      footer={<div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
        <button onClick={onClose} style={{ padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}>Close</button>
      </div>}
    >
      {loading && !d ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}><Spinner size={26} /></div>
      ) : !d ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>Account not found.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Header strip */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, padding: '3px 10px', borderRadius: RADIUS['2xl'], background: `${dpdColor(d.dpd_lower)}18`, color: dpdColor(d.dpd_lower) }}>{d.dpd_bucket ?? '0d'}</span>
              <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, letterSpacing: '0.05em', padding: '2px 7px', borderRadius: RADIUS.full, textTransform: 'uppercase', background: d.dpd_lower > 90 ? `${RED}12` : `${NAVY}10`, color: d.dpd_lower > 90 ? RED : NAVY }}>{d.dpd_lower > 90 ? 'Recovery' : 'Collections'}</span>
              <span style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>CIF {d.applicant_cif}</span>
              {d.current_stage && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontStyle: 'italic' }}>{d.current_stage.replace(/_/g, ' ')}</span>}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.extrabold, lineHeight: 1, color: d.dpd_lower > 90 ? RED : d.dpd_lower > 30 ? AMBER : GREEN }}>{fmtKobo(d.outstanding_kobo)}</div>
              <div style={{ ...NUM, fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 3 }}>Principal {fmtKobo(d.principal_kobo)}</div>
            </div>
          </div>

          {/* Stat strip */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {[
              { label: 'Contacts', value: String(d.total_contacts), color: NAVY },
              { label: 'PTPs', value: String(d.ptps_created), color: GREEN },
              { label: 'PTPs Kept', value: String(d.ptps_kept), color: GREEN },
              { label: 'Total Paid', value: fmtKobo(d.total_paid_kobo), color: GREEN },
            ].map(s => (
              <div key={s.label} style={{ background: 'var(--th-bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: '8px 10px' }}>
                <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', fontWeight: FW.semibold }}>{s.label}</div>
                <div style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.extrabold, color: s.color, lineHeight: 1.2 }}>{s.value}</div>
              </div>
            ))}
          </div>

          {/* Record panel — inline actions, no page hop */}
          <div style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: 12, background: 'var(--th-bg)' }}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              {([['contact', 'Log Contact'], ['ptp', 'Record PTP'], ['payment', 'Log Payment']] as const).map(([k, label]) => (
                <button key={k} onClick={() => setAct(k)}
                  style={{ padding: '5px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', border: `1.5px solid ${act === k ? NAVY : 'var(--bdr)'}`, background: act === k ? NAVY : 'var(--card)', color: act === k ? '#fff' : 'var(--txt)' }}>
                  {label}
                </button>
              ))}
            </div>

            {!aid ? (
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>No active assignment on this account, so actions aren’t available.</div>
            ) : act === 'contact' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div><label style={lbl}>Contact Method</label><Chips options={CONTACT_TYPES} value={ctType} onChange={setCtType} /></div>
                <div><label style={lbl}>Outcome</label><Chips options={OUTCOMES} value={ctOutcome} onChange={setCtOutcome} /></div>
                <div><label style={lbl}>Notes <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span></label>
                  <textarea value={ctNotes} onChange={e => setCtNotes(e.target.value)} rows={2} placeholder="Notes from the contact…" style={{ ...inp, resize: 'vertical' }} /></div>
                {saveBtn(logContact, 'Log Contact', NAVY)}
              </div>
            ) : act === 'ptp' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div><label style={lbl}>Amount (₦)</label><input type="number" min="0" step="0.01" placeholder="0.00" value={ptpAmount} onChange={e => setPtpAmount(e.target.value)} style={{ ...inp, fontWeight: FW.bold }} /></div>
                  <div><label style={lbl}>Promise Date</label><input type="date" min={todayStr()} value={ptpDate} onChange={e => setPtpDate(e.target.value)} style={inp} /></div>
                </div>
                {saveBtn(recordPTP, 'Record PTP', GREEN)}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div><label style={lbl}>Amount (₦)</label><input type="number" min="0" step="0.01" placeholder="0.00" value={payAmount} onChange={e => setPayAmount(e.target.value)} style={{ ...inp, fontWeight: FW.bold }} /></div>
                  <div><label style={lbl}>Payment Date</label><input type="date" max={todayStr()} value={payDate} onChange={e => setPayDate(e.target.value)} style={inp} /></div>
                </div>
                <div><label style={lbl}>Channel</label><Chips options={CHANNELS} value={payChannel} onChange={setPayChannel} /></div>
                <div><label style={lbl}>Reference <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span></label><input type="text" placeholder="e.g. TRF-2025-00123" value={payRef} onChange={e => setPayRef(e.target.value)} style={inp} /></div>
                {saveBtn(logPayment, 'Log Payment', GREEN)}
              </div>
            )}
          </div>

          {/* Tabs — the same components the full page renders; refetch after an action via `version` */}
          <div>
            <Tabs tabs={TABS} active={tab} onChange={setTab} />
            <div style={{ marginTop: 4, border: '1px solid var(--bdr)', borderRadius: RADIUS.md, overflow: 'hidden' }}>
              {tab === 'timeline' && <TimelineTab cif={d.applicant_cif}    version={version} />}
              {tab === 'contacts' && <ContactsTab assignmentId={d.assignment_id} version={version} />}
              {tab === 'promises' && <PromisesTab cif={d.applicant_cif}    version={version} />}
              {tab === 'payments' && <PaymentsTab cif={d.applicant_cif} assignmentId={d.assignment_id} version={version} />}
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
