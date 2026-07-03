import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, Tabs, Modal, ConfirmModal, Spinner, Sk,
} from '../../components/UI'
import { apiFetch, apiPut, apiPost } from '../../lib/api'
import { fmtKobo, fmtDatetime, fmtDate } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, BLUE, NUM } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Application {
  id:                  number
  reference:           string
  applicant_name:      string
  applicant_email:     string
  applicant_phone:     string
  applicant_cif:       string
  product_type:        string
  amount_requested_kobo: number
  amount_approved_kobo:  number
  tenor_months:        number
  interest_rate_bps:   number
  purpose:             string
  employer:            string
  monthly_income_kobo: number
  monthly_obligation_kobo: number | null
  status:              string
  stage:               string
  decline_reason:      string | null
  sales_officer_id:    number | null
  assigned_to_user_id: number | null
  submitted_at:        string | null
  finance_approved_at: string | null
  booked_at:           string | null
  created_at:          string
  updated_at:          string
  eye_score:           number | null
  eye_rating:          string | null
  bureau_summary:      string | null
  dti_pct:             number | null
}

interface AppEvent {
  id:            number
  application_id:number
  event_type:    string
  from_stage:    string | null
  to_stage:      string | null
  actor_user_id: number | null
  actor_name:    string | null
  notes:         string | null
  created_at:    string
}

interface AppNote {
  id:          number
  author_id:   number
  body:        string
  is_internal: boolean
  created_at:  string
}

interface AppCondition {
  id:             number
  condition_text: string
  is_met:         boolean
  met_by:         number | null
  met_at:         string | null
  created_at:     string
}

interface DetailData {
  application: Application
  events:      AppEvent[]
  notes:       AppNote[]
  conditions:  AppCondition[]
}

// ── Stage helpers ─────────────────────────────────────────────────────────────

const STAGE_ORDER = [
  'draft', 'submitted', 'document_collection', 'risk_review',
  'risk_head_review', 'pending_conditions', 'finance_approval', 'booking', 'active',
]

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft:               ['submitted'],
  submitted:           ['document_collection'],
  document_collection: ['risk_review'],
  risk_review:         ['risk_head_review'],
  risk_head_review:    ['pending_conditions'],
  pending_conditions:  ['finance_approval'],
  finance_approval:    ['booking'],
  booking:             ['active'],
}

const STAGE_COLORS: Record<string, { bg: string; txt: string }> = {
  draft:               { bg: 'rgba(75,85,99,.1)',    txt: '#6B7280' },
  submitted:           { bg: 'rgba(37,99,235,.12)',  txt: BLUE },
  document_collection: { bg: 'rgba(37,99,235,.12)',  txt: BLUE },
  risk_review:         { bg: 'rgba(217,119,6,.12)',  txt: AMBER },
  risk_head_review:    { bg: 'rgba(217,119,6,.12)',  txt: AMBER },
  pending_conditions:  { bg: 'rgba(124,58,237,.12)', txt: '#7C3AED' },
  finance_approval:    { bg: 'rgba(124,58,237,.12)', txt: '#7C3AED' },
  booking:             { bg: 'rgba(14,40,65,.1)',    txt: NAVY },
  active:              { bg: 'rgba(22,163,74,.12)',  txt: GREEN },
  declined:            { bg: 'rgba(192,0,0,.1)',     txt: RED },
}

function StagePill({ stage, size = 'md' }: { stage: string; size?: 'sm' | 'md' }) {
  const s = STAGE_COLORS[stage] ?? { bg: 'rgba(75,85,99,.1)', txt: '#6B7280' }
  const label = stage.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return (
    <span style={{
      ...NUM,
      display: 'inline-flex', alignItems: 'center',
      fontSize: size === 'sm' ? 10.5 : 12, fontWeight: 600,
      padding: size === 'sm' ? '1px 7px' : '3px 10px',
      borderRadius: 20, background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

function ProductPill({ product }: { product: string }) {
  const label = product.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return (
    <span style={{
      ...NUM, fontSize: 12, fontWeight: 600,
      padding: '3px 10px', borderRadius: 20,
      background: 'var(--chip-bg)', color: 'var(--chip-txt)',
      whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

// ── Info grid item ────────────────────────────────────────────────────────────

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 0', borderBottom: '1px solid var(--bdr)' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>
        {label}
      </div>
      <div style={{ fontSize: 13.5, color: 'var(--txt)', fontWeight: 500 }}>
        {value ?? <span style={{ color: 'var(--txt3)' }}>—</span>}
      </div>
    </div>
  )
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'summary',            label: 'Summary' },
  { key: 'verification',       label: 'Verification' },
  { key: 'credit_assessment',  label: 'Credit Assessment' },
  { key: 'bank_details',       label: 'Bank Details' },
  { key: 'documents',          label: 'Documents' },
  { key: 'approval_chain',     label: 'Approval Chain' },
  { key: 'timeline',           label: 'Timeline' },
]

// ── Verification tab ──────────────────────────────────────────────────────────

function VerificationTab({ app }: { app: Application }) {
  const items = [
    { label: 'Phone Number',          icon: 'phone',           verified: !!app.applicant_phone },
    { label: 'Email Address',         icon: 'email',           verified: !!app.applicant_email },
    { label: 'CIF / Account Number',  icon: 'fingerprint',     verified: !!app.applicant_cif },
    { label: 'Government-Issued ID',  icon: 'badge',           verified: false },
    { label: 'Employment Offer Letter', icon: 'description',   verified: false },
    { label: 'Latest Payslip',        icon: 'receipt_long',    verified: false },
    { label: 'Bank Statement (6m)',   icon: 'account_balance', verified: false },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {items.map(item => (
        <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 0', borderBottom: '1px solid var(--bdr)' }}>
          <div style={{
            width: 34, height: 34, borderRadius: 9, flexShrink: 0,
            background: item.verified ? 'rgba(22,163,74,.12)' : 'var(--chip-bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16, color: item.verified ? GREEN : 'var(--txt2)' }}>
              {item.icon}
            </span>
          </div>
          <div style={{ flex: 1, fontSize: 13.5, fontWeight: 500, color: 'var(--txt)' }}>{item.label}</div>
          <span style={{
            fontSize: 11.5, fontWeight: 600, padding: '2px 9px', borderRadius: 20,
            background: item.verified ? 'rgba(22,163,74,.12)' : 'rgba(217,119,6,.12)',
            color: item.verified ? GREEN : AMBER,
          }}>
            {item.verified ? 'Verified' : 'Pending'}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Credit Assessment tab ─────────────────────────────────────────────────────

const RATING_COLORS: Record<string, string> = {
  Excellent: GREEN, Good: GREEN, Fair: AMBER, Poor: RED, Bad: RED,
}

function CreditAssessmentTab({ app, onRefresh }: { app: Application; onRefresh: () => void }) {
  const userRole = (() => {
    try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}')?.role ?? '' } catch { return '' }
  })()
  const isRisk = userRole === 'Risk Officer' || userRole === 'Risk Head'

  const [form, setForm] = useState({ eye_score: '', eye_rating: '', bureau_summary: '', dti_pct: '' })
  const [saving, setSaving] = useState(false)

  const monthlyRepayment = (app.tenor_months && app.amount_requested_kobo)
    ? Math.round(app.amount_requested_kobo / app.tenor_months * (1 + (app.interest_rate_bps ?? 0) / 10000))
    : 0
  const dtiPct = app.dti_pct ?? ((app.monthly_income_kobo && monthlyRepayment)
    ? (monthlyRepayment / app.monthly_income_kobo) * 100
    : null)
  const dtiColor = dtiPct === null ? 'var(--txt2)' : dtiPct > 50 ? RED : dtiPct > 33 ? AMBER : GREEN
  const netAfter = (app.monthly_income_kobo && monthlyRepayment)
    ? app.monthly_income_kobo - monthlyRepayment
    : null

  const score = app.eye_score
  const scoreColor = score === null ? 'var(--txt2)' : score >= 650 ? GREEN : score >= 500 ? AMBER : RED

  async function saveAssessment() {
    setSaving(true)
    try {
      await apiPut(`/api/los/${app.id}/credit-assessment`, {
        eye_score:   form.eye_score   ? Number(form.eye_score)   : null,
        eye_rating:  form.eye_rating  || null,
        bureau_summary: form.bureau_summary || null,
        dti_pct:     form.dti_pct     ? Number(form.dti_pct)     : null,
      })
      toast.success('Credit assessment saved')
      onRefresh()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      <SectionCard title="Income Assessment">
        <InfoRow label="Monthly Income"            value={app.monthly_income_kobo ? fmtKobo(app.monthly_income_kobo) : null} />
        <InfoRow label="Monthly Obligations"       value={app.monthly_obligation_kobo ? fmtKobo(app.monthly_obligation_kobo) : null} />
        <InfoRow label="Est. Monthly Repayment"    value={monthlyRepayment ? fmtKobo(monthlyRepayment) : null} />
        <InfoRow label="DTI Ratio" value={
          dtiPct !== null
            ? <span style={{ color: dtiColor, fontWeight: 700 }}>{dtiPct.toFixed(1)}%</span>
            : null
        } />
        <InfoRow label="Net After Deduction"       value={netAfter !== null ? fmtKobo(netAfter) : null} />
      </SectionCard>

      <SectionCard title="Credit Score (Eye)">
        {score !== null ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <span style={{ fontSize: 52, fontWeight: 800, color: scoreColor, ...NUM, lineHeight: 1 }}>{score}</span>
              {app.eye_rating && (
                <span style={{
                  fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
                  background: `${RATING_COLORS[app.eye_rating] ?? 'var(--txt2)'}22`,
                  color: RATING_COLORS[app.eye_rating] ?? 'var(--txt2)',
                }}>{app.eye_rating}</span>
              )}
            </div>
            {app.bureau_summary && (
              <p style={{ fontSize: 13, color: 'var(--txt2)', lineHeight: 1.6, margin: 0 }}>{app.bureau_summary}</p>
            )}
          </div>
        ) : isRisk ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ fontSize: 12, color: 'var(--txt2)' }}>Eye Score (0–850)
              <input type="number" min={0} max={850} value={form.eye_score}
                onChange={e => setForm(f => ({ ...f, eye_score: e.target.value }))}
                style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 8px', border: '1px solid var(--bdr)', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' }} />
            </label>
            <label style={{ fontSize: 12, color: 'var(--txt2)' }}>Rating
              <select value={form.eye_rating}
                onChange={e => setForm(f => ({ ...f, eye_rating: e.target.value }))}
                style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 8px', border: '1px solid var(--bdr)', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' }}>
                <option value="">— select —</option>
                {['Excellent','Good','Fair','Poor','Bad'].map(r => <option key={r}>{r}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 12, color: 'var(--txt2)' }}>DTI % (override)
              <input type="number" step="0.01" value={form.dti_pct}
                onChange={e => setForm(f => ({ ...f, dti_pct: e.target.value }))}
                style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 8px', border: '1px solid var(--bdr)', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' }} />
            </label>
            <label style={{ fontSize: 12, color: 'var(--txt2)' }}>Bureau Summary
              <textarea rows={3} value={form.bureau_summary}
                onChange={e => setForm(f => ({ ...f, bureau_summary: e.target.value }))}
                style={{ display: 'block', width: '100%', marginTop: 4, padding: '6px 8px', border: '1px solid var(--bdr)', borderRadius: 6, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }} />
            </label>
            <button onClick={saveAssessment} disabled={saving || !form.eye_score}
              style={{ alignSelf: 'flex-start', padding: '6px 16px', borderRadius: 6, border: 'none', cursor: saving ? 'not-allowed' : 'pointer', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, opacity: (saving || !form.eye_score) ? 0.6 : 1 }}>
              {saving ? 'Saving…' : 'Save Assessment'}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '20px 0', gap: 10 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 36, color: 'var(--txt3)', opacity: 0.6 }}>analytics</span>
            <div style={{ fontSize: 13, color: 'var(--txt2)', textAlign: 'center' }}>Eye credit score is generated during risk review</div>
            <span style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 9px', borderRadius: 20, background: 'rgba(217,119,6,.12)', color: AMBER }}>Pending</span>
          </div>
        )}
      </SectionCard>
    </div>
  )
}

// ── Bank Details tab ──────────────────────────────────────────────────────────

function BankDetailsTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 0', gap: 12 }}>
      <span className="material-symbols-rounded" style={{ fontSize: 44, color: 'var(--txt3)', opacity: 0.4 }}>account_balance</span>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)' }}>Bank Details Not Yet Collected</div>
      <div style={{ fontSize: 13, color: 'var(--txt2)', textAlign: 'center', maxWidth: 360, lineHeight: 1.6 }}>
        Bank account details (account number, bank name, BVN match) will be captured during the document collection stage.
      </div>
    </div>
  )
}

// ── Summary tab ───────────────────────────────────────────────────────────────

function SummaryTab({ app }: { app: Application }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      {/* Left: personal */}
      <SectionCard title="Personal Information">
        <InfoRow label="Full Name"      value={app.applicant_name} />
        <InfoRow label="Phone"          value={app.applicant_phone} />
        <InfoRow label="Email"          value={app.applicant_email} />
        <InfoRow label="CIF"            value={app.applicant_cif} />
        <InfoRow label="Submitted"      value={fmtDatetime(app.submitted_at)} />
        <InfoRow label="Created"        value={fmtDate(app.created_at)} />
      </SectionCard>

      {/* Right: employment + loan terms */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <SectionCard title="Employment">
          <InfoRow label="Employer"          value={app.employer} />
          <InfoRow label="Monthly Income"    value={app.monthly_income_kobo ? fmtKobo(app.monthly_income_kobo) : null} />
        </SectionCard>
        <SectionCard title="Loan Terms">
          <InfoRow label="Product"           value={<ProductPill product={app.product_type || '—'} />} />
          <InfoRow label="Amount Requested"  value={fmtKobo(app.amount_requested_kobo)} />
          <InfoRow label="Amount Approved"   value={app.amount_approved_kobo ? fmtKobo(app.amount_approved_kobo) : 'Pending'} />
          <InfoRow label="Tenor"             value={app.tenor_months ? `${app.tenor_months} months` : null} />
          <InfoRow label="Interest Rate"     value={app.interest_rate_bps ? `${(app.interest_rate_bps / 100).toFixed(2)}% p.a.` : null} />
          <InfoRow label="Purpose"           value={app.purpose} />
          {app.decline_reason && (
            <InfoRow label="Decline Reason"  value={<span style={{ color: RED }}>{app.decline_reason}</span>} />
          )}
        </SectionCard>
      </div>
    </div>
  )
}

// ── Documents tab ─────────────────────────────────────────────────────────────

const DOC_SLOTS = [
  { label: 'Government-Issued ID',      icon: 'badge' },
  { label: 'Latest Payslip',            icon: 'receipt_long' },
  { label: 'Bank Statement (6 months)', icon: 'account_balance' },
  { label: 'Employment Offer Letter',   icon: 'description' },
]

function DocumentsTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {DOC_SLOTS.map(slot => (
        <div key={slot.label} style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '14px 16px', borderRadius: 10,
          border: '1px solid var(--bdr)', background: 'var(--card)',
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: 9,
            background: 'var(--chip-bg)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 18, color: 'var(--txt2)' }}>
              {slot.icon}
            </span>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--txt)' }}>{slot.label}</div>
            <div style={{ fontSize: 12, color: 'var(--txt2)', marginTop: 2 }}>No file uploaded</div>
          </div>
          <span style={{
            fontSize: 11.5, fontWeight: 600,
            padding: '2px 8px', borderRadius: 20,
            background: 'rgba(217,119,6,.12)', color: AMBER,
          }}>
            Pending
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Approval chain tab ────────────────────────────────────────────────────────

interface ApprovalEntry {
  stage:    string
  label:    string
  role:     string
}

const APPROVAL_CHAIN: ApprovalEntry[] = [
  { stage: 'submitted',           label: 'Submission',          role: 'Sales Officer' },
  { stage: 'document_collection', label: 'Document Collection', role: 'Sales Officer' },
  { stage: 'risk_review',         label: 'Risk Review',         role: 'Risk Officer' },
  { stage: 'risk_head_review',    label: 'Risk Head Review',    role: 'Risk Head' },
  { stage: 'pending_conditions',  label: 'Conditions',          role: 'Risk Head' },
  { stage: 'finance_approval',    label: 'Finance Approval',    role: 'Finance Officer' },
  { stage: 'booking',             label: 'Booking',             role: 'Finance Head' },
  { stage: 'active',              label: 'Disbursed',           role: 'Finance Head' },
]

function ApprovalChainTab({ app, events }: { app: Application; events: AppEvent[] }) {
  const currentIdx = STAGE_ORDER.indexOf(app.stage)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {APPROVAL_CHAIN.map((entry, i) => {
        const entryIdx = STAGE_ORDER.indexOf(entry.stage)
        const done     = entryIdx <= currentIdx && app.stage !== 'declined'
        const declined = app.stage === 'declined'

        // Find event for this stage transition
        const ev = events.find(e => e.to_stage === entry.stage)

        let decision: string
        let decisionColor: string
        if (declined && entryIdx > currentIdx) {
          decision = 'N/A'; decisionColor = 'var(--txt3)'
        } else if (done) {
          decision = 'Approved'; decisionColor = GREEN
        } else {
          decision = 'Pending'; decisionColor = AMBER
        }

        return (
          <div key={entry.stage} style={{
            display: 'flex', alignItems: 'flex-start', gap: 14,
            padding: '14px 0',
            borderBottom: i < APPROVAL_CHAIN.length - 1 ? '1px solid var(--bdr)' : undefined,
          }}>
            {/* Step circle */}
            <div style={{
              width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: done ? 'rgba(22,163,74,.12)' : 'var(--chip-bg)',
              border: `2px solid ${done ? GREEN : 'var(--bdr)'}`,
            }}>
              {done
                ? <span className="material-symbols-rounded" style={{ fontSize: 15, color: GREEN }}>check</span>
                : <span style={{ ...NUM, fontSize: 11, fontWeight: 700, color: 'var(--txt3)' }}>{i + 1}</span>
              }
            </div>
            {/* Content */}
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--txt)' }}>{entry.label}</span>
                <span style={{ fontSize: 11.5, color: 'var(--txt2)', background: 'var(--chip-bg)', padding: '1px 7px', borderRadius: 12 }}>
                  {entry.role}
                </span>
                <span style={{ ...NUM, fontSize: 11.5, fontWeight: 600, color: decisionColor }}>
                  {decision}
                </span>
              </div>
              {ev && (
                <div style={{ fontSize: 12, color: 'var(--txt2)', marginTop: 4 }}>
                  {fmtDatetime(ev.created_at)}
                  {ev.actor_name && ` · ${ev.actor_name}`}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Timeline tab ──────────────────────────────────────────────────────────────

const EVENT_ICONS: Record<string, string> = {
  stage_advance: 'arrow_circle_right',
  declined:      'cancel',
  request_info:  'info',
  assigned:      'person',
  note:          'note',
  created:       'add_circle',
}

function TimelineTab({ events }: { events: AppEvent[] }) {
  if (events.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--txt2)', fontSize: 13 }}>
        No timeline events yet.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {events.map((ev, i) => {
        const icon = EVENT_ICONS[ev.event_type] ?? 'history'
        const isLast = i === events.length - 1

        let description = ev.event_type.replace(/_/g, ' ')
        if (ev.event_type === 'stage_advance' && ev.from_stage && ev.to_stage) {
          const from = ev.from_stage.replace(/_/g, ' ')
          const to   = ev.to_stage.replace(/_/g, ' ')
          description = `Moved from ${from} → ${to}`
        } else if (ev.event_type === 'declined') {
          description = 'Application declined'
        } else if (ev.event_type === 'request_info') {
          description = 'Sent back for more information'
        }

        return (
          <div key={ev.id} style={{ display: 'flex', gap: 14, paddingBottom: isLast ? 0 : 20, position: 'relative' }}>
            {/* Line */}
            {!isLast && (
              <div style={{
                position: 'absolute', left: 15, top: 32, bottom: 0,
                width: 1, background: 'var(--bdr)',
              }} />
            )}
            {/* Icon */}
            <div style={{
              width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--chip-bg)', border: '1px solid var(--bdr)',
              zIndex: 1,
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt2)' }}>
                {icon}
              </span>
            </div>
            {/* Content */}
            <div style={{ flex: 1, paddingTop: 6 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--txt)', textTransform: 'capitalize' }}>
                {description}
              </div>
              <div style={{ fontSize: 12, color: 'var(--txt2)', marginTop: 2 }}>
                {fmtDatetime(ev.created_at)}
                {ev.actor_name && ` · ${ev.actor_name}`}
              </div>
              {ev.notes && (
                <div style={{
                  marginTop: 6, fontSize: 13, color: 'var(--txt)',
                  background: 'var(--input-bg)', border: '1px solid var(--bdr)',
                  borderRadius: 8, padding: '8px 12px', lineHeight: 1.5,
                }}>
                  {ev.notes}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Action modals ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '0 12px', height: 38,
  border: '1px solid var(--input-bdr)', borderRadius: 8,
  fontSize: 13.5, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box',
}

const textareaStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  border: '1px solid var(--input-bdr)', borderRadius: 8,
  fontSize: 13.5, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "'Sora', sans-serif", outline: 'none', resize: 'vertical',
  boxSizing: 'border-box', minHeight: 90,
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ApplicationDetail() {
  const { id }     = useParams<{ id: string }>()
  const navigate   = useNavigate()

  const [data,     setData]     = useState<DetailData | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState('summary')

  // modals
  const [advanceOpen,    setAdvanceOpen]    = useState(false)
  const [declineOpen,    setDeclineOpen]    = useState(false)
  const [reqInfoOpen,    setReqInfoOpen]    = useState(false)
  const [addNoteOpen,    setAddNoteOpen]    = useState(false)
  const [committeeOpen,  setCommitteeOpen]  = useState(false)

  // action state
  const [toStage,        setToStage]        = useState('')
  const [advanceNotes,   setAdvanceNotes]   = useState('')
  const [declineReason,  setDeclineReason]  = useState('')
  const [reqInfoNotes,   setReqInfoNotes]   = useState('')
  const [noteBody,       setNoteBody]       = useState('')
  const [committeeNote,  setCommitteeNote]  = useState('')
  const [actionLoading,  setActionLoading]  = useState(false)

  // role detection
  const userRole = (() => {
    try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}')?.role ?? '' } catch { return '' }
  })()

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch<{ data: DetailData }>(`/api/los/${id}`)
      setData(res.data)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  // ── Actions ─────────────────────────────────────────────────────────────

  async function doAdvance() {
    if (!toStage) { toast.error('Select a target stage'); return }
    setActionLoading(true)
    try {
      await apiPut(`/api/los/${id}/advance`, { to_stage: toStage, notes: advanceNotes })
      toast.success('Stage advanced')
      setAdvanceOpen(false)
      setToStage('')
      setAdvanceNotes('')
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Advance failed')
    } finally {
      setActionLoading(false)
    }
  }

  async function doDecline() {
    if (!declineReason.trim()) { toast.error('Reason is required'); return }
    setActionLoading(true)
    try {
      await apiPut(`/api/los/${id}/decline`, { reason: declineReason })
      toast.success('Application declined')
      setDeclineOpen(false)
      setDeclineReason('')
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Decline failed')
    } finally {
      setActionLoading(false)
    }
  }

  async function doReqInfo() {
    setActionLoading(true)
    try {
      await apiPut(`/api/los/${id}/request-info`, { notes: reqInfoNotes })
      toast.success('Sent back for more information')
      setReqInfoOpen(false)
      setReqInfoNotes('')
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Request info failed')
    } finally {
      setActionLoading(false)
    }
  }

  async function doAddNote() {
    if (!noteBody.trim()) { toast.error('Note body is required'); return }
    setActionLoading(true)
    try {
      await apiPost(`/api/los/${id}/notes`, { body: noteBody, is_internal: true })
      toast.success('Note added')
      setAddNoteOpen(false)
      setNoteBody('')
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Add note failed')
    } finally {
      setActionLoading(false)
    }
  }

  async function doReferToCommittee() {
    if (!committeeNote.trim()) { toast.error('Reason is required'); return }
    setActionLoading(true)
    try {
      await apiPost(`/api/los/${id}/notes`, {
        body: `[COMMITTEE REFERRAL] ${committeeNote}`,
        is_internal: true,
      })
      toast.success('Referred to committee')
      setCommitteeOpen(false)
      setCommitteeNote('')
      load()
    } catch (e: any) {
      toast.error(e.message ?? 'Referral failed')
    } finally {
      setActionLoading(false)
    }
  }

  // ── Loading state ─────────────────────────────────────────────────────────

  if (loading && !data) {
    return (
      <Page title="Application" subtitle="Loading...">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Sk h={44} />
          <Sk h={200} />
          <Sk h={300} />
        </div>
      </Page>
    )
  }

  if (error) {
    return (
      <Page title="Application" subtitle="Error">
        <div style={{
          padding: '14px 18px', borderRadius: 10,
          background: 'rgba(192,0,0,0.08)', border: '1px solid rgba(192,0,0,0.2)',
          fontSize: 13, color: RED,
        }}>
          {error} —{' '}
          <button onClick={load} style={{ textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 'inherit' }}>
            Retry
          </button>
        </div>
      </Page>
    )
  }

  if (!data) return null

  const app        = data.application
  const events     = data.events ?? []
  const notes      = data.notes ?? []
  const nextStages  = ALLOWED_TRANSITIONS[app.stage] ?? []
  const isTerminal  = app.stage === 'active' || app.stage === 'declined'

  const isRiskRole    = ['risk_officer', 'risk_head'].includes(userRole)
  const isFinanceRole = ['finance_officer', 'finance_head'].includes(userRole)
  const isRiskStage   = ['risk_review', 'risk_head_review'].includes(app.stage)
  const isFinanceStage = ['finance_approval', 'booking'].includes(app.stage)
  const showRiskActions    = isRiskRole && isRiskStage && !isTerminal
  const showFinanceActions = isFinanceRole && isFinanceStage && !isTerminal

  return (
    <Page
      title={`APP-${app.id}`}
      subtitle={`Applications / APP-${app.id}`}
      actions={
        <button
          onClick={() => navigate('/sales/applications')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 13px', background: 'var(--card)', color: 'var(--txt)',
            border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>arrow_back</span>
          Back to Applications
        </button>
      }
    >
      {/* Header strip */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '14px 18px', marginBottom: 16,
        background: 'var(--card)', border: '1px solid var(--card-bdr)',
        borderRadius: 12, boxShadow: 'var(--card-shadow)',
      }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 3 }}>
            Reference
          </div>
          <div style={{ ...NUM, fontSize: 15, fontWeight: 700, color: NAVY }}>{app.reference}</div>
        </div>

        <div style={{ width: 1, height: 36, background: 'var(--bdr)' }} />

        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 3 }}>
            Applicant
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--txt)' }}>{app.applicant_name}</div>
        </div>

        <div style={{ width: 1, height: 36, background: 'var(--bdr)' }} />

        <ProductPill product={app.product_type || 'unknown'} />

        <div style={{ width: 1, height: 36, background: 'var(--bdr)' }} />

        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 3 }}>
            Amount
          </div>
          <div style={{ ...NUM, fontSize: 14, fontWeight: 700, color: 'var(--txt)' }}>
            {fmtKobo(app.amount_requested_kobo)}
          </div>
        </div>

        <div style={{ width: 1, height: 36, background: 'var(--bdr)' }} />

        <StagePill stage={app.stage} />

        {/* Action buttons — pushed right */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>

          {/* Risk role actions */}
          {showRiskActions && (
            <>
              <button
                onClick={() => { setToStage(nextStages[0]); setAdvanceOpen(true) }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: GREEN, color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>check_circle</span>
                Approve Application
              </button>
              <button
                onClick={() => setCommitteeOpen(true)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: 'var(--card)', color: AMBER, border: `1px solid ${AMBER}`, borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>groups</span>
                Refer to Committee
              </button>
            </>
          )}

          {/* Finance role actions */}
          {showFinanceActions && (
            <>
              <button
                onClick={() => { setToStage(nextStages[0]); setAdvanceOpen(true) }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: NAVY, color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>payments</span>
                {app.stage === 'booking' ? 'Disburse' : 'Approve Finance'}
              </button>
              <button
                onClick={() => setReqInfoOpen(true)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: 'var(--card)', color: AMBER, border: `1px solid ${AMBER}`, borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>pause_circle</span>
                Hold
              </button>
            </>
          )}

          {/* Generic actions — shown when not in a role-gated stage */}
          {!showRiskActions && !showFinanceActions && !isTerminal && (
            <>
              {nextStages.length > 0 && (
                <button
                  onClick={() => { setToStage(nextStages[0]); setAdvanceOpen(true) }}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: NAVY, color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 15 }}>arrow_circle_right</span>
                  Advance Stage
                </button>
              )}
              <button
                onClick={() => setReqInfoOpen(true)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: 'var(--card)', color: AMBER, border: `1px solid ${AMBER}`, borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>info</span>
                Request Info
              </button>
              <button
                onClick={() => setDeclineOpen(true)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: 'var(--card)', color: RED, border: `1px solid ${RED}`, borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
              >
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>cancel</span>
                Decline
              </button>
            </>
          )}

          <button
            onClick={() => setAddNoteOpen(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: 'var(--card)', color: 'var(--txt)', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>note_add</span>
            Add Note
          </button>
        </div>
      </div>

      {/* Tabs */}
      <SectionCard padding={false}>
        <div style={{ padding: '0 18px' }}>
          <Tabs
            tabs={TABS.map(t => t.key === 'timeline' ? { ...t, badge: events.length } : t)}
            active={activeTab}
            onChange={setActiveTab}
          />
        </div>
        <div style={{ padding: '0 18px 20px' }}>
          {activeTab === 'summary'           && <SummaryTab app={app} />}
          {activeTab === 'verification'      && <VerificationTab app={app} />}
          {activeTab === 'credit_assessment' && <CreditAssessmentTab app={app} onRefresh={load} />}
          {activeTab === 'bank_details'      && <BankDetailsTab />}
          {activeTab === 'documents'         && <DocumentsTab />}
          {activeTab === 'approval_chain'    && <ApprovalChainTab app={app} events={events} />}
          {activeTab === 'timeline'          && <TimelineTab events={events} />}
        </div>

        {/* Notes section always shown below tabs when on summary */}
        {activeTab === 'summary' && notes.length > 0 && (
          <div style={{ padding: '0 18px 20px' }}>
            <div style={{ borderTop: '1px solid var(--bdr)', paddingTop: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 10 }}>
                Notes ({notes.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {notes.map(note => (
                  <div key={note.id} style={{
                    padding: '10px 14px', borderRadius: 8,
                    background: 'var(--input-bg)', border: '1px solid var(--bdr)',
                  }}>
                    <div style={{ fontSize: 13, color: 'var(--txt)', lineHeight: 1.55 }}>{note.body}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--txt2)', marginTop: 4 }}>
                      {fmtDatetime(note.created_at)}
                      {note.is_internal && (
                        <span style={{ marginLeft: 8, fontSize: 10.5, fontWeight: 600, color: AMBER }}>Internal</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </SectionCard>

      {/* ── Advance Stage modal ── */}
      <ConfirmModal
        open={advanceOpen}
        title="Advance Stage"
        confirmLabel="Advance"
        loading={actionLoading}
        onConfirm={doAdvance}
        onClose={() => { setAdvanceOpen(false); setToStage(''); setAdvanceNotes('') }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.3px' }}>
              Move to stage
            </div>
            <select
              value={toStage}
              onChange={e => setToStage(e.target.value)}
              style={{ ...inputStyle }}
            >
              <option value="">Select next stage</option>
              {nextStages.map(s => (
                <option key={s} value={s}>
                  {s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.3px' }}>
              Notes (optional)
            </div>
            <textarea
              value={advanceNotes}
              onChange={e => setAdvanceNotes(e.target.value)}
              style={{ ...textareaStyle }}
              placeholder="Add any notes about this stage transition…"
            />
          </div>
        </div>
      </ConfirmModal>

      {/* ── Decline modal ── */}
      <ConfirmModal
        open={declineOpen}
        title="Decline Application"
        confirmLabel="Decline Application"
        danger
        loading={actionLoading}
        onConfirm={doDecline}
        onClose={() => { setDeclineOpen(false); setDeclineReason('') }}
      >
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.3px' }}>
            Reason <span style={{ color: RED }}>*</span>
          </div>
          <textarea
            value={declineReason}
            onChange={e => setDeclineReason(e.target.value)}
            style={{ ...textareaStyle }}
            placeholder="State the reason for declining this application…"
          />
        </div>
      </ConfirmModal>

      {/* ── Request Info modal ── */}
      <Modal
        open={reqInfoOpen}
        title="Request More Information"
        onClose={() => { setReqInfoOpen(false); setReqInfoNotes('') }}
        footer={
          <>
            <button
              onClick={() => { setReqInfoOpen(false); setReqInfoNotes('') }}
              style={{
                padding: '8px 16px', borderRadius: 8,
                border: '1px solid var(--bdr)', background: 'var(--card)',
                color: 'var(--txt)', fontSize: 13, fontWeight: 500, cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={doReqInfo}
              disabled={actionLoading}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '8px 18px', borderRadius: 8, border: 'none',
                background: AMBER, color: '#fff',
                fontSize: 13, fontWeight: 600,
                cursor: actionLoading ? 'wait' : 'pointer',
                opacity: actionLoading ? 0.7 : 1,
              }}
            >
              {actionLoading && <Spinner size={14} color="#fff" />}
              Send Request
            </button>
          </>
        }
      >
        <div>
          <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--txt2)', lineHeight: 1.55 }}>
            The application will be sent back to the previous stage for more information. The applicant/officer will be notified.
          </p>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.3px' }}>
            Notes
          </div>
          <textarea
            value={reqInfoNotes}
            onChange={e => setReqInfoNotes(e.target.value)}
            style={{ ...textareaStyle }}
            placeholder="Describe what additional information is needed…"
          />
        </div>
      </Modal>

      {/* ── Refer to Committee modal ── */}
      <Modal
        open={committeeOpen}
        title="Refer to Credit Committee"
        onClose={() => { setCommitteeOpen(false); setCommitteeNote('') }}
        footer={
          <>
            <button
              onClick={() => { setCommitteeOpen(false); setCommitteeNote('') }}
              style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              onClick={doReferToCommittee}
              disabled={actionLoading}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 18px', borderRadius: 8, border: 'none', background: AMBER, color: '#fff', fontSize: 13, fontWeight: 600, cursor: actionLoading ? 'wait' : 'pointer', opacity: actionLoading ? 0.7 : 1 }}
            >
              {actionLoading && <Spinner size={14} color="#fff" />}
              Refer
            </button>
          </>
        }
      >
        <div>
          <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--txt2)', lineHeight: 1.55 }}>
            This will post an internal note and flag the application for committee review.
          </p>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.3px' }}>
            Reason <span style={{ color: RED }}>*</span>
          </div>
          <textarea
            value={committeeNote}
            onChange={e => setCommitteeNote(e.target.value)}
            style={{ ...textareaStyle }}
            placeholder="State why this application needs committee review…"
          />
        </div>
      </Modal>

      {/* ── Add Note modal ── */}
      <Modal
        open={addNoteOpen}
        title="Add Note"
        onClose={() => { setAddNoteOpen(false); setNoteBody('') }}
        footer={
          <>
            <button
              onClick={() => { setAddNoteOpen(false); setNoteBody('') }}
              style={{
                padding: '8px 16px', borderRadius: 8,
                border: '1px solid var(--bdr)', background: 'var(--card)',
                color: 'var(--txt)', fontSize: 13, fontWeight: 500, cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={doAddNote}
              disabled={actionLoading}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '8px 18px', borderRadius: 8, border: 'none',
                background: NAVY, color: '#fff',
                fontSize: 13, fontWeight: 600,
                cursor: actionLoading ? 'wait' : 'pointer',
                opacity: actionLoading ? 0.7 : 1,
              }}
            >
              {actionLoading && <Spinner size={14} color="#fff" />}
              Save Note
            </button>
          </>
        }
      >
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.3px' }}>
            Note <span style={{ color: RED }}>*</span>
          </div>
          <textarea
            value={noteBody}
            onChange={e => setNoteBody(e.target.value)}
            style={{ ...textareaStyle, minHeight: 120 }}
            placeholder="Write your note here…"
          />
        </div>
      </Modal>
    </Page>
  )
}
