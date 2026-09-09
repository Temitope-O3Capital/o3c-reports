import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useRef, type CSSProperties } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import './salesDetail.css'
import CustomerJourney from './CustomerJourney'
import {
  Page, SectionCard, Modal, ConfirmModal, Spinner, Sk, ErrBanner, KpiCard,
} from '../../components/UI'
import { apiFetch, apiPut, apiPost, apiDelete } from '../../lib/api'
import { fmtKobo, fmtDatetime, fmtDate, fmtNum } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'
import { EBarH } from '../../components/echarts'
import { hasPage } from '../../hooks/useAuth'
import { canAdvance, canDecline, canRequestInfo, stageMeta, decisionMeta, syncStateMeta, isTerminalStage, STAGE_SEQUENCE } from '../../lib/losFlow'
import PhoenixEyeReport from './eye/PhoenixEyeReport'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Application {
  id:                      number
  reference:               string
  applicant_name:          string
  applicant_email:         string
  applicant_phone:         string
  applicant_cif:           string
  product_type:            string
  amount_requested_kobo:   number
  amount_approved_kobo:    number
  tenor_months:            number
  interest_rate_bps:       number
  purpose:                 string
  employer:                string
  monthly_income_kobo:     number
  monthly_obligation_kobo: number | null
  // Applicant identity and employment detail. Collected by NewApplication.tsx
  // from the start; storable only since migration 216 added the columns.
  bvn:                     string | null
  nin:                     string | null
  date_of_birth:           string | null
  residential_address:     string | null
  job_title:               string | null
  employment_type:         string | null
  employment_start_date:   string | null
  status:                  string
  stage:                   string
  decline_reason:          string | null
  sales_officer_id:        number | null
  assigned_to_user_id:     number | null
  submitted_at:            string | null
  finance_approved_at:     string | null
  booked_at:               string | null
  created_at:              string
  updated_at:              string
  eye_score:               number | null
  eye_rating:              string | null
  bureau_summary:          string | null
  dti_pct:                 number | null
  // Phoenix decisioning (populated by the webhook once Phoenix is live). Advisory —
  // the verdict informs the human approver, it does not advance the stage.
  decision:                string | null
  decision_reasons:        unknown
  decline_reason_phoenix?: string | null
  phoenix_sync_state:      string | null
  source_system:           string | null
  source_lead_id:          number | null
  lead_source:             string | null
  // Offer & acceptance capture (capture-only; Phoenix is the system of record).
  offer_status:            string | null
  offered_amount_kobo:     number | null
  offered_rate_bps:        number | null
  offered_tenor_months:    number | null
  offer_issued_at:         string | null
  offer_accepted_at:       string | null
  offer_expires_at:        string | null
  offer_source:            string | null
  offer_ref:               string | null
  offer_note:              string | null
}

interface AppEvent {
  id:             number
  application_id: number
  event_type:     string
  from_stage:     string | null
  to_stage:       string | null
  actor_user_id:  number | null
  actor_name:     string | null
  actor_source?:  string | null
  notes:          string | null
  created_at:     string
}

interface AppNote {
  id:          number
  author_id:   number
  author_name: string | null
  body:        string
  is_internal: boolean
  created_at:  string
}

interface AppCondition {
  id:             number
  condition_text: string
  is_met:         boolean
  met_by:         number | null
  met_by_name:    string | null
  met_at:         string | null
  created_at:     string
}

interface AppMessage {
  id:              number
  application_id:  number
  author_user_id:  number | null
  author_name:     string | null
  author_role:     string | null
  body:            string
  msg_type:        string
  created_at:      string
}

interface TeamUser {
  id:        number
  full_name: string
  role:      string
}

interface DetailData {
  application: Application
  events:      AppEvent[]
  notes:       AppNote[]
  conditions:  AppCondition[]
}

interface EyeReason {
  feature:        string
  direction:      'positive' | 'negative'
  magnitude:      number
  human_readable: string
}
interface EyeReport {
  application_id:            string
  customer_id:               string
  outcome:                   'approve' | 'refer' | 'decline'
  pd:                        number | null
  risk_band:                 string | null
  predicted_loc:             number | null
  assigned_limit:            number | null
  cap_applied:               boolean
  interest_rate:             number | null
  decline_reason:            string | null
  reasons:                   EyeReason[]
  lgd:                       number | null
  expected_loss_kobo:        number | null
  expected_loss_pct:         number | null
  dcafo:                     number | null
  residual_monthly_cash_ngn: number | null
  affordability:             'comfortable' | 'adequate' | 'stressed' | null
  fair_monthly_rate:         number | null
  enriched_bureau:           Record<string, any> | null
  enriched_open_banking:     Record<string, any> | null
  adverse_action_notice:     { reasons?: string[] } | null
  model_version:             string | null
  processing_ms:             number | null
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

const ROLE_COLORS: Record<string, string> = {
  sales_officer:   BLUE,
  sales_head:      BLUE,
  risk_officer:    AMBER,
  risk_head:       AMBER,
  finance_officer: '#7C3AED',
  finance_head:    '#7C3AED',
}

function StagePill({ stage, size = 'md' }: { stage: string; size?: 'sm' | 'md' }) {
  const s = STAGE_COLORS[stage] ?? { bg: 'rgba(75,85,99,.1)', txt: '#6B7280' }
  const label = stage.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return (
    <span style={{
      ...NUM, display: 'inline-flex', alignItems: 'center',
      fontSize: size === 'sm' ? 10.5 : 12, fontWeight: 600,
      padding: size === 'sm' ? '1px 7px' : '3px 10px',
      borderRadius: 20, background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

function ProductPill({ product }: { product: string }) {
  return (
    <span style={{
      ...NUM, fontSize: 12, fontWeight: 600,
      padding: '3px 10px', borderRadius: 20,
      background: 'var(--chip-bg)', color: 'var(--chip-txt)', whiteSpace: 'nowrap',
    }}>
      {product.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
    </span>
  )
}

// dti_pct is a Postgres numeric, and pgx hands those back as STRINGS, not
// floats — so app.dti_pct arrives as e.g. "22.40" despite being typed number.
// A bare `x !== null` guard therefore passes a string straight into
// x.toFixed(), which throws "toFixed is not a function" and blanks the page.
// This stayed hidden until Phoenix started returning decisions: before that
// dti_pct was always NULL, the guard was false, and the branch never ran.
function dtiOf(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '9px 0', borderBottom: '1px solid var(--bdr)' }}>
      <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{label}</div>
      <div style={{ fontSize: 13.5, color: 'var(--txt)', fontWeight: 500 }}>{value ?? <span style={{ color: 'var(--txt3)' }}>—</span>}</div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '0 12px', height: 38,
  border: '1px solid var(--input-bdr)', borderRadius: 8,
  fontSize: 13.5, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "var(--font-sans)", outline: 'none', boxSizing: 'border-box',
}
const textareaStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  border: '1px solid var(--input-bdr)', borderRadius: 8,
  fontSize: 13.5, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "var(--font-sans)", outline: 'none', resize: 'vertical',
  boxSizing: 'border-box', minHeight: 90,
}

// ── Pipeline progress stepper ──────────────────────────────────────────────────

// Full pipeline, driven by the shared sequence so no stage (risk_head_review, booking)
// is silently collapsed — otherwise an application sitting at a skipped stage shows no
// active node.
const STEPPER_STAGES = STAGE_SEQUENCE.map(s => ({ stage: s, label: stageMeta(s).short }))

function PipelineStepper({ stage }: { stage: string }) {
  const currentIdx = STAGE_ORDER.indexOf(stage)
  const declined = stage === 'declined'
  return (
    <div className="sd-steps">
      {STEPPER_STAGES.map((step, i) => {
        const stepIdx = STAGE_ORDER.indexOf(step.stage)
        const active = step.stage === stage
        const done = !declined && stepIdx < currentIdx
        const cls = declined ? 'is-declined' : active ? 'is-current' : done ? 'is-done' : ''
        return (
          <div key={step.stage} className={`sd-step ${cls}`.trim()}>
            <div className="sd-step-dot">
              {done
                ? <span className="material-symbols-rounded">check</span>
                : declined && active
                  ? <span className="material-symbols-rounded">close</span>
                  : i + 1}
            </div>
            <div className="sd-step-lbl">{step.label}</div>
          </div>
        )
      })}
    </div>
  )
}

// ── Credit File Drawer ────────────────────────────────────────────────────────

interface CreditFileData {
  eye_score:               number | null
  eye_rating:              string | null
  bureau_summary:          string | null
  dti_pct:                 number | null
  monthly_income_kobo:     number
  monthly_obligation_kobo: number | null
  amount_requested_kobo:   number
  amount_approved_kobo:    number
  tenor_months:            number
  outstanding_kobo:        number
  dpd:                     number
  employer:                string
}

function CreditFileDrawer({ cif, open, onClose }: { cif: string; open: boolean; onClose: () => void }) {
  const [cfData,    setCfData]    = useState<CreditFileData | null>(null)
  const [cfLoading, setCfLoading] = useState(false)
  const [cfError,   setCfError]   = useState<string | null>(null)

  useEffect(() => {
    if (!open || !cif) return
    setCfLoading(true); setCfError(null)
    apiFetch<{ data: CreditFileData }>(`/api/risk/credit-file/${cif}`)
      .then(r => setCfData((r as any).data ?? null))
      .catch(e => setCfError(e.message ?? 'Failed'))
      .finally(() => setCfLoading(false))
  }, [cif, open])

  const scoreColor = (s: number | null) => !s ? 'var(--txt3)' : s >= 700 ? GREEN : s >= 500 ? AMBER : RED

  return (
    <Modal open={open} onClose={onClose} title={`Credit File: ${cif}`} width={540}>
      {cfLoading && <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={24} /></div>}
      {cfError   && <div style={{ color: RED, fontSize: TEXT.sm, padding: SP[3] }}>{cfError}</div>}
      {cfData && !cfLoading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4] }}>
          <div style={{ display: 'flex', gap: SP[4], alignItems: 'center', padding: SP[3], borderRadius: RADIUS.md, background: 'var(--th-bg)', border: '1px solid var(--bdr)' }}>
            <div style={{ textAlign: 'center', flexShrink: 0 }}>
              <div style={{ ...NUM, fontSize: 48, fontWeight: FW.extrabold, color: scoreColor(cfData.eye_score), lineHeight: 1 }}>{cfData.eye_score ?? '—'}</div>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>Eye Score</div>
            </div>
            <div style={{ flex: 1 }}>
              {cfData.eye_rating    && <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 6 }}>Rating: {cfData.eye_rating}</div>}
              {cfData.bureau_summary && <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5 }}>{cfData.bureau_summary}</div>}
              {!cfData.eye_score && !cfData.bureau_summary && <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>No score on file</div>}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
            {[
              { label: 'Monthly Income',      value: fmtKobo(cfData.monthly_income_kobo) },
              { label: 'Monthly Obligations', value: cfData.monthly_obligation_kobo ? fmtKobo(cfData.monthly_obligation_kobo) : '—' },
              { label: 'DTI Ratio',           value: cfData.dti_pct !== null ? `${Number(cfData.dti_pct).toFixed(1)}%` : '—' },
              { label: 'Employer',            value: cfData.employer || '—' },
              { label: 'Amount Disbursed',    value: fmtKobo(cfData.amount_approved_kobo || cfData.amount_requested_kobo) },
              { label: 'Outstanding',         value: fmtKobo(cfData.outstanding_kobo) },
              { label: 'DPD',                 value: `${cfData.dpd ?? 0} days` },
            ].map(row => (
              <div key={row.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{row.label}</span>
                <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  )
}

// ── Conditions inline component ───────────────────────────────────────────────

function ConditionsInline({ appId, conditions, onRefresh, canManage }: {
  appId: number; conditions: AppCondition[]; onRefresh: () => void; canManage: boolean
}) {
  const [newText,   setNewText]   = useState('')
  const [addingNew, setAddingNew] = useState(false)
  const [saving,    setSaving]    = useState(false)
  const [marking,   setMarking]   = useState<Record<number, boolean>>({})
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (addingNew) inputRef.current?.focus() }, [addingNew])

  async function addCondition() {
    if (!newText.trim()) return
    setSaving(true)
    try {
      await apiPost(`/api/los/${appId}/conditions`, { condition_text: newText.trim() })
      toast.success('Condition added')
      setNewText(''); setAddingNew(false); onRefresh()
    } catch (e: any) { toast.error(e.message ?? 'Failed') }
    finally { setSaving(false) }
  }

  async function markMet(condId: number) {
    setMarking(m => ({ ...m, [condId]: true }))
    try {
      await apiPut(`/api/los/${appId}/conditions/${condId}`, { is_met: true })
      toast.success('Condition marked as met'); onRefresh()
    } catch (e: any) { toast.error(e.message ?? 'Failed') }
    finally { setMarking(m => ({ ...m, [condId]: false })) }
  }

  const unmet = conditions.filter(c => !c.is_met)
  const met   = conditions.filter(c => c.is_met)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Summary */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)' }}>
        <span className="material-symbols-rounded" style={{ fontSize: 16, color: unmet.length === 0 ? GREEN : AMBER }}>
          {unmet.length === 0 ? 'check_circle' : 'pending_actions'}
        </span>
        <span style={{ ...NUM, fontSize: 12.5, fontWeight: 700, color: unmet.length === 0 ? GREEN : AMBER, flex: 1 }}>
          {unmet.length === 0 ? 'All conditions satisfied' : `${unmet.length} outstanding of ${conditions.length}`}
        </span>
        {canManage && (
          <button onClick={() => setAddingNew(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', fontSize: 12, cursor: 'pointer' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 13 }}>add</span>Add
          </button>
        )}
      </div>

      {addingNew && (
        <div style={{ display: 'flex', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--bdr)' }}>
          <input ref={inputRef} type="text" value={newText} onChange={e => setNewText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addCondition(); if (e.key === 'Escape') { setAddingNew(false); setNewText('') } }}
            placeholder="Describe the condition…" style={{ ...inputStyle, height: 34 }} />
          <button onClick={addCondition} disabled={saving || !newText.trim()}
            style={{ padding: '0 14px', borderRadius: 6, border: 'none', background: NAVY, color: '#fff', fontSize: 13, cursor: 'pointer', opacity: (saving || !newText.trim()) ? 0.6 : 1, whiteSpace: 'nowrap' }}>
            {saving ? <Spinner size={12} color="#fff" /> : 'Add'}
          </button>
          <button onClick={() => { setAddingNew(false); setNewText('') }}
            style={{ padding: '0 12px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
        </div>
      )}

      {unmet.map(c => (
        <div key={c.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '11px 16px', borderBottom: '1px solid var(--bdr)' }}>
          <div style={{ width: 20, height: 20, borderRadius: '50%', border: `2px solid ${AMBER}`, flexShrink: 0, marginTop: 1 }} />
          <div style={{ flex: 1, fontSize: 13.5, color: 'var(--txt)', lineHeight: 1.5 }}>{c.condition_text}</div>
          {canManage && (
            <button onClick={() => markMet(c.id)} disabled={!!marking[c.id]}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 6, border: `1px solid ${GREEN}40`, background: `${GREEN}08`, color: GREEN, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              {marking[c.id] ? <Spinner size={11} color={GREEN} /> : <span className="material-symbols-rounded" style={{ fontSize: 12 }}>check</span>}
              Met
            </button>
          )}
        </div>
      ))}

      {met.map(c => (
        <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--bdr)', opacity: 0.65 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 17, color: GREEN, flexShrink: 0 }}>check_circle</span>
          <div style={{ flex: 1, fontSize: 13, color: 'var(--txt)', textDecoration: 'line-through' }}>{c.condition_text}</div>
          {c.met_by_name && <span style={{ fontSize: 11.5, color: 'var(--txt3)', whiteSpace: 'nowrap' }}>{c.met_by_name}</span>}
        </div>
      ))}

      {conditions.length === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '32px 0', gap: 8 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 34, color: 'var(--txt3)', opacity: 0.5 }}>fact_check</span>
          <div style={{ fontSize: 13, color: 'var(--txt2)' }}>No conditions set</div>
        </div>
      )}
    </div>
  )
}

// ── Document preview modal ────────────────────────────────────────────────────

function DocPreviewModal({ doc, onClose }: { doc: LosDoc | null; onClose: () => void }) {
  if (!doc) return null
  const ext = doc.file_name.split('.').pop()?.toLowerCase() ?? ''
  const isPdf   = ext === 'pdf'
  const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)
  const canRender = isPdf || isImage

  return (
    <Modal open={!!doc} onClose={onClose} title={doc.file_name} width={isPdf ? 820 : 640}>
      {isPdf && (
        <div style={{ height: 620, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--bdr)' }}>
          <iframe src={doc.file_url} style={{ width: '100%', height: '100%', border: 'none' }} title={doc.file_name} />
        </div>
      )}
      {isImage && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
          <img src={doc.file_url} alt={doc.file_name} style={{ maxWidth: '100%', maxHeight: 560, borderRadius: 8, objectFit: 'contain', border: '1px solid var(--bdr)' }} />
        </div>
      )}
      {!canRender && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '40px 0' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 44, color: 'var(--txt3)' }}>description</span>
          <div style={{ fontSize: 14, color: 'var(--txt2)' }}>This file type cannot be previewed in-browser.</div>
          <a href={doc.file_url} target="_blank" rel="noreferrer"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 18px', borderRadius: 8, background: NAVY, color: '#fff', fontWeight: 600, fontSize: 13, textDecoration: 'none' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>download</span>Download
          </a>
        </div>
      )}
      {canRender && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <a href={doc.file_url} target="_blank" rel="noreferrer"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 12.5, textDecoration: 'none' }}>
            <span className="material-symbols-rounded" style={{ fontSize: 14 }}>open_in_new</span>Open in new tab
          </a>
        </div>
      )}
    </Modal>
  )
}

// ── Documents inline component ────────────────────────────────────────────────

const DOC_SLOTS = [
  { key: 'government_id',  label: 'Government-Issued ID',      icon: 'badge' },
  { key: 'payslip',        label: 'Latest Payslip',            icon: 'receipt_long' },
  { key: 'bank_statement', label: 'Bank Statement (6 months)', icon: 'account_balance' },
  { key: 'offer_letter',   label: 'Employment Offer Letter',   icon: 'description' },
]

interface LosDoc {
  id: number; application_id: number; doc_type: string
  file_name: string; file_url: string; file_size_bytes: number
  created_at: string; uploaded_by_name: string | null
}

function DocumentsInline({ appId, readOnly = false }: { appId: number; readOnly?: boolean }) {
  const [docs,      setDocs]      = useState<LosDoc[]>([])
  const [uploading, setUploading] = useState<Record<string, boolean>>({})
  const [deleting,  setDeleting]  = useState<Record<number, boolean>>({})
  const [preview,   setPreview]   = useState<LosDoc | null>(null)
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({})

  const loadDocs = useCallback(async () => {
    try {
      const res = await apiFetch<{ data: LosDoc[] }>(`/api/los/applications/${appId}/documents`)
      setDocs(Array.isArray(res.data) ? res.data : [])
    } catch { /* silent */ }
  }, [appId])

  useEffect(() => { loadDocs() }, [loadDocs])

  async function handleUpload(docType: string, file: File) {
    setUploading(u => ({ ...u, [docType]: true }))
    try {
      const token = localStorage.getItem('o3c_token') ?? ''
      const form  = new FormData()
      form.append('file', file); form.append('doc_type', docType)
      const res = await fetch(`/api/los/applications/${appId}/documents`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
      })
      if (!res.ok) { const err = await res.json().catch(() => ({ error: 'Upload failed' })); throw new Error(err.error ?? 'Upload failed') }
      await loadDocs()
    } catch (e: any) { alert(e.message ?? 'Upload failed') }
    finally {
      setUploading(u => ({ ...u, [docType]: false }))
      const ref = fileRefs.current[docType]
      if (ref) ref.value = ''
    }
  }

  async function handleDelete(doc: LosDoc) {
    if (!confirm(`Delete "${doc.file_name}"?`)) return
    setDeleting(d => ({ ...d, [doc.id]: true }))
    try { await apiDelete(`/api/los/documents/${doc.id}`); setDocs(ds => ds.filter(d => d.id !== doc.id)) }
    catch (e: any) { alert(e.message ?? 'Delete failed') }
    finally { setDeleting(d => ({ ...d, [doc.id]: false })) }
  }

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {DOC_SLOTS.map(slot => {
          const uploaded    = docs.filter(d => d.doc_type === slot.key)
          const isUploading = uploading[slot.key]
          return (
            <div key={slot.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: '1px solid var(--bdr)' }}>
              <div style={{ width: 30, height: 30, borderRadius: 8, background: uploaded.length > 0 ? 'rgba(22,163,74,.1)' : 'var(--chip-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 15, color: uploaded.length > 0 ? GREEN : 'var(--txt2)' }}>{slot.icon}</span>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{slot.label}</div>
                {uploaded.length > 0 ? (
                  <div style={{ fontSize: 11.5, color: 'var(--txt2)', marginTop: 1 }}>
                    {uploaded.map(d => (
                      <span key={d.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 12 }}>
                        {readOnly ? (
                          <button onClick={() => setPreview(d)}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: NAVY, fontWeight: 600, fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <span className="material-symbols-rounded" style={{ fontSize: 13 }}>visibility</span>{d.file_name}
                          </button>
                        ) : (
                          <a href={d.file_url} target="_blank" rel="noreferrer" style={{ color: NAVY, fontWeight: 600, textDecoration: 'none' }}>{d.file_name}</a>
                        )}
                        {!readOnly && (
                          <button onClick={() => handleDelete(d)} disabled={deleting[d.id]} style={{ background: 'none', border: 'none', cursor: 'pointer', color: RED, padding: 0, lineHeight: 1 }}>
                            <span className="material-symbols-rounded" style={{ fontSize: 13 }}>close</span>
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                ) : readOnly ? (
                  <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 1, fontStyle: 'italic' }}>Not yet uploaded</div>
                ) : null}
              </div>
              <div style={{ flexShrink: 0 }}>
                {uploaded.length === 0
                  ? <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 12, background: 'rgba(217,119,6,.12)', color: AMBER }}>Pending</span>
                  : <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 12, background: 'rgba(22,163,74,.12)', color: GREEN }}>Uploaded</span>
                }
              </div>
              {readOnly && uploaded.length > 0 && (
                <button onClick={() => setPreview(uploaded[0])}
                  style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, border: `1px solid ${NAVY}25`, background: `${NAVY}08`, color: NAVY, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 13 }}>visibility</span>View
                </button>
              )}
              {!readOnly && (
                <label style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', fontSize: 12, cursor: 'pointer' }}>
                  {isUploading ? <Spinner size={12} /> : <><span className="material-symbols-rounded" style={{ fontSize: 13 }}>upload</span>Upload</>}
                  <input ref={el => { fileRefs.current[slot.key] = el }} type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                    style={{ display: 'none' }} disabled={isUploading}
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(slot.key, f) }} />
                </label>
              )}
            </div>
          )
        })}
      </div>
      <DocPreviewModal doc={preview} onClose={() => setPreview(null)} />
    </>
  )
}

// ── Approval chain compact ────────────────────────────────────────────────────

// The `role` shown per step is the owner from losFlow (who actually advances that stage),
// so it can never disagree with who the server lets act. active is terminal (owner '—').
const APPROVAL_CHAIN = [
  { stage: 'submitted',           label: 'Submission' },
  { stage: 'document_collection', label: 'Document Collection' },
  { stage: 'risk_review',         label: 'Risk Review' },
  { stage: 'risk_head_review',    label: 'Risk Head Review' },
  { stage: 'pending_conditions',  label: 'Conditions' },
  { stage: 'finance_approval',    label: 'Finance Approval' },
  { stage: 'booking',             label: 'Booking' },
  { stage: 'active',              label: 'Disbursed' },
]

function ApprovalChainCompact({ app, events }: { app: Application; events: AppEvent[] }) {
  const currentIdx = STAGE_ORDER.indexOf(app.stage)
  const declined   = app.stage === 'declined'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {APPROVAL_CHAIN.map((entry, i) => {
        const entryIdx = STAGE_ORDER.indexOf(entry.stage)
        const done     = entryIdx <= currentIdx && !declined
        const active   = entry.stage === app.stage
        const ev       = events.find(e => e.to_stage === entry.stage)
        return (
          <div key={entry.stage} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', borderBottom: i < APPROVAL_CHAIN.length - 1 ? '1px solid var(--bdr)' : undefined }}>
            <div style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: done ? (active ? `${NAVY}18` : 'rgba(22,163,74,.12)') : 'var(--chip-bg)', border: `1.5px solid ${done ? (active ? NAVY : GREEN) : 'var(--bdr)'}` }}>
              {done && !active ? <span className="material-symbols-rounded" style={{ fontSize: 12, color: GREEN }}>check</span>
                : active ? <div style={{ width: 7, height: 7, borderRadius: '50%', background: NAVY }} />
                : <span style={{ ...NUM, fontSize: 9, fontWeight: 700, color: 'var(--txt3)' }}>{i + 1}</span>}
            </div>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: active ? NAVY : done ? 'var(--txt)' : 'var(--txt2)' }}>{entry.label}</span>
              {ev && <span style={{ fontSize: 11.5, color: 'var(--txt3)', marginLeft: 8 }}>{ev.actor_name ? `· ${ev.actor_name}` : ''}</span>}
            </div>
            <span style={{ fontSize: 11, color: 'var(--txt2)', fontStyle: 'italic' }}>{stageMeta(entry.stage).owner}</span>
            <span style={{ ...NUM, fontSize: 11, fontWeight: 600, color: done ? GREEN : active ? AMBER : 'var(--txt3)' }}>
              {done && !active ? 'Done' : active ? 'In Progress' : '—'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Internal Thread (cross-team messages) ─────────────────────────────────────

function InternalThread({ appId }: { appId: number }) {
  const [messages,  setMessages]  = useState<AppMessage[]>([])
  const [users,     setUsers]     = useState<TeamUser[]>([])
  const [body,      setBody]      = useState('')
  const [saving,    setSaving]    = useState(false)
  const [showUsers, setShowUsers] = useState(false)
  const [tagFilter, setTagFilter] = useState('')
  const [loading,   setLoading]   = useState(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const me = (() => { try { const u = JSON.parse(localStorage.getItem('o3c_user') ?? '{}'); return { id: u.id, name: u.name } } catch { return { id: 0, name: '' } } })()

  const loadMessages = useCallback(async () => {
    try {
      const res = await apiFetch<{ data: AppMessage[] }>(`/api/los/${appId}/messages`)
      setMessages(Array.isArray(res.data) ? res.data : [])
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [appId])

  useEffect(() => { loadMessages() }, [loadMessages])

  useEffect(() => {
    apiFetch<{ data: TeamUser[] }>('/api/los/team-users')
      .then(res => setUsers(Array.isArray(res.data) ? res.data : []))
      .catch(() => {})
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowUsers(false); setTagFilter('')
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  function insertMention(user: TeamUser) {
    const mention = `@${user.full_name} `
    setBody(b => b + mention)
    setShowUsers(false); setTagFilter('')
    setTimeout(() => textareaRef.current?.focus(), 50)
  }

  async function send() {
    if (!body.trim()) return
    setSaving(true)
    try {
      // Parse @mentions from body text
      const mentionIds: number[] = []
      users.forEach(u => {
        if (body.includes(`@${u.full_name}`)) mentionIds.push(u.id)
      })
      await apiPost(`/api/los/${appId}/messages`, { body: body.trim(), mention_ids: mentionIds })
      setBody('')
      await loadMessages()
    } catch (e: any) { toast.error(e.message ?? 'Failed to send') }
    finally { setSaving(false) }
  }

  const filteredUsers = users.filter(u =>
    u.full_name.toLowerCase().includes(tagFilter.toLowerCase()) ||
    u.role.toLowerCase().includes(tagFilter.toLowerCase())
  )

  const roleColor = (role: string | null) => ROLE_COLORS[role ?? ''] ?? 'var(--txt2)'
  const roleLabel = (role: string | null) => role ? role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : ''

  return (
    <SectionCard title="Team Thread">
      {/* Messages */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 0 16px' }}><Sk h={60} /><Sk h={60} /></div>
      ) : messages.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '24px 0', color: 'var(--txt2)' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 34, opacity: 0.35 }}>forum</span>
          <div style={{ fontSize: 13 }}>No messages yet. Start the conversation.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
          {messages.map(msg => {
            const isMe = msg.author_user_id === me.id
            const col  = roleColor(msg.author_role)
            return (
              <div key={msg.id} style={{ display: 'flex', gap: 10, flexDirection: isMe ? 'row-reverse' : 'row' }}>
                {/* Avatar */}
                <div style={{ width: 34, height: 34, borderRadius: '50%', background: `${col}20`, border: `2px solid ${col}40`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 12, fontWeight: 700, color: col }}>
                  {(msg.author_name ?? '?')[0].toUpperCase()}
                </div>
                {/* Bubble */}
                <div style={{ maxWidth: '72%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexDirection: isMe ? 'row-reverse' : 'row' }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt)' }}>{msg.author_name ?? 'Unknown'}</span>
                    {msg.author_role && (
                      <span style={{ fontSize: 10.5, fontWeight: 600, padding: '1px 6px', borderRadius: 10, background: `${col}15`, color: col }}>{roleLabel(msg.author_role)}</span>
                    )}
                    <span style={{ fontSize: 11, color: 'var(--txt3)' }}>{fmtDatetime(msg.created_at)}</span>
                  </div>
                  <div style={{
                    padding: '10px 14px', borderRadius: isMe ? '12px 4px 12px 12px' : '4px 12px 12px 12px',
                    background: isMe ? `${NAVY}12` : 'var(--input-bg)',
                    border: `1px solid ${isMe ? `${NAVY}20` : 'var(--bdr)'}`,
                    fontSize: 13.5, color: 'var(--txt)', lineHeight: 1.6, whiteSpace: 'pre-wrap',
                  }}>
                    {msg.body}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Compose */}
      <div style={{ borderRadius: 10, border: '1px solid var(--bdr)', background: 'var(--card)', overflow: 'visible', position: 'relative' }}>
        <textarea ref={textareaRef}
          value={body} onChange={e => setBody(e.target.value)}
          rows={3} placeholder="Message the team…"
          spellCheck={false} data-gramm="false" data-gramm_editor="false"
          onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); send() } }}
          style={{ width: '100%', padding: '12px 14px', border: 'none', resize: 'none', fontSize: 13.5, lineHeight: 1.6, background: 'transparent', color: 'var(--txt)', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', minHeight: 80 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderTop: '1px solid var(--bdr)', background: 'var(--th-bg)' }}>
          {/* @Mention button + dropdown */}
          <div ref={dropdownRef} style={{ position: 'relative' }}>
            <button
              onClick={() => { setShowUsers(s => !s); setTagFilter('') }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', fontSize: 12, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 13 }}>alternate_email</span>Mention
            </button>
            {showUsers && (
              <div style={{ position: 'absolute', bottom: '110%', left: 0, zIndex: 200, width: 240, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,.15)', overflow: 'hidden' }}>
                <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--bdr)' }}>
                  <input autoFocus type="text" value={tagFilter} onChange={e => setTagFilter(e.target.value)}
                    placeholder="Search team members…"
                    style={{ width: '100%', border: 'none', background: 'transparent', fontSize: 12.5, color: 'var(--txt)', outline: 'none', fontFamily: 'inherit' }} />
                </div>
                <div style={{ maxHeight: 180, overflowY: 'auto' }}>
                  {filteredUsers.length === 0
                    ? <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--txt2)' }}>No results</div>
                    : filteredUsers.map(u => (
                      <button key={u.id} onClick={() => insertMention(u)}
                        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                        <div style={{ width: 26, height: 26, borderRadius: '50%', background: `${roleColor(u.role)}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: roleColor(u.role), flexShrink: 0 }}>
                          {u.full_name[0].toUpperCase()}
                        </div>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{u.full_name}</div>
                          <div style={{ fontSize: 11, color: 'var(--txt2)' }}>{roleLabel(u.role)}</div>
                        </div>
                      </button>
                    ))
                  }
                </div>
              </div>
            )}
          </div>
          <span style={{ fontSize: 11, color: 'var(--txt3)', flex: 1 }}>⌘↵ to send</span>
          <button onClick={send} disabled={saving || !body.trim()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 16px', borderRadius: 7, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: (saving || !body.trim()) ? 'not-allowed' : 'pointer', opacity: (saving || !body.trim()) ? 0.6 : 1 }}>
            {saving && <Spinner size={13} color="#fff" />}Send
          </button>
        </div>
      </div>
    </SectionCard>
  )
}

function PhoenixDecisionBanner({ app }: { app: Application }) {
  const decision = (app.decision ?? '').toLowerCase()
  const sync = syncStateMeta(app.phoenix_sync_state)
  const hasDecision = !!decision && decision !== 'pending'
  const fromPhoenix = app.source_system === 'phoenix'
  if (!hasDecision && !sync && !fromPhoenix) return null
  const d = decisionMeta(decision)

  // decision_reasons is jsonb — usually an array of factor objects, sometimes a string.
  let reasons: string[] = []
  const dr = app.decision_reasons
  if (Array.isArray(dr)) {
    reasons = dr.slice(0, 6).map((r: any) =>
      typeof r === 'string' ? r : (r?.factor ?? r?.reason ?? r?.name ?? r?.label ?? '')
    ).filter(Boolean)
  } else if (typeof dr === 'string' && dr.trim()) {
    reasons = [dr]
  }

  // With no decision yet this used to headline the SYNC STATE — rendering
  // "Phoenix decision: Phoenix-originated", with the same words repeated in a pill
  // beside it. It stated nothing, twice. A pending assessment should say it is
  // pending; where the application came from is provenance, not a verdict.
  const title = hasDecision ? `Credit decision: ${d.label}` : 'Awaiting credit decision'
  const body = hasDecision
    ? 'Advisory recommendation. A credit approver still decides — advancing or declining remains a human action.'
    : 'This has been sent for assessment. The recommendation appears here once the credit engine returns it.'

  return (
    <div className={`sd-panel${hasDecision ? '' : ' sd-decision-pending'}`}>
      <div className="sd-decision" style={hasDecision ? { background: d.bg } : undefined}>
        <div className="sd-decision-icn" style={{ background: hasDecision ? d.txt : 'var(--txt3)' }}>
          <span className="material-symbols-rounded">{hasDecision ? d.icon : 'hourglass_top'}</span>
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="sd-decision-title" style={hasDecision ? { color: d.txt } : undefined}>{title}</div>
          <div className="sd-decision-body">{body}</div>
          {reasons.length > 0 && (
            <div className="sd-chips">
              {reasons.map((r, i) => <span key={i} className="sd-chip">{r}</span>)}
            </div>
          )}
        </div>
        <div className="sd-decision-meta">
          {fromPhoenix && <span className="sd-tagline">Originated in Phoenix</span>}
          {sync && <span className="sd-tagline" style={{ color: sync.txt }}>{sync.label}</span>}
        </div>
      </div>
    </div>
  )
}

// OfferPanel — capture the offer/acceptance step in the workspace. Capture-only: Phoenix
// is the system of record, so this records terms + acceptance and never gates the stage.
// offer_source shows whether it came from Phoenix or was captured here.
const OFFER_META: Record<string, { label: string; txt: string; bg: string }> = {
  none:     { label: 'No offer captured', txt: '#6B7280', bg: 'rgba(75,85,99,.10)' },
  issued:   { label: 'Offer issued',      txt: '#2563EB', bg: 'rgba(37,99,235,.12)' },
  accepted: { label: 'Accepted',          txt: GREEN,     bg: 'rgba(22,163,74,.12)' },
  declined: { label: 'Declined',          txt: RED,       bg: 'rgba(192,0,0,.10)' },
  expired:  { label: 'Expired',           txt: AMBER,     bg: 'rgba(217,119,6,.12)' },
}

function OfferPanel({ app, onRefresh }: { app: Application; onRefresh: () => void }) {
  const status = app.offer_status || 'none'
  const m = OFFER_META[status] ?? OFFER_META.none
  const canCapture = ['los', 'los_all', 'los_risk_review', 'los_risk_head', 'los_finance', 'los_finance_approve', 'los_booking'].some(p => hasPage(p))
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const baseAmt = app.offered_amount_kobo || app.amount_approved_kobo || app.amount_requested_kobo || 0
  const [amount, setAmount] = useState(baseAmt ? String(baseAmt / 100) : '')
  const [rate, setRate]     = useState(app.offered_rate_bps ? String(app.offered_rate_bps / 100) : (app.interest_rate_bps ? String(app.interest_rate_bps / 100) : ''))
  const [tenor, setTenor]   = useState(app.offered_tenor_months ? String(app.offered_tenor_months) : (app.tenor_months ? String(app.tenor_months) : ''))
  const [expiry, setExpiry] = useState(app.offer_expires_at ? app.offer_expires_at.slice(0, 10) : '')

  const btn = (bg: string, fg = '#fff'): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', background: bg, color: fg, border: bg === 'var(--card)' ? '1px solid var(--bdr)' : 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1 })
  const lbl: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, color: 'var(--txt2)', fontWeight: 600 }

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true)
    try {
      await apiPut(`/api/los/${app.id}/offer`, { action, ...extra })
      toast.success(action === 'issue' ? 'Offer captured' : action === 'accept' ? 'Acceptance recorded' : action === 'decline' ? 'Marked declined' : 'Marked expired')
      setEditing(false); onRefresh()
    } catch (e: any) { toast.error(e.message ?? 'Failed') }
    finally { setBusy(false) }
  }
  function saveOffer() {
    if (!amount || Number(amount) <= 0) { toast.error('Enter an offer amount'); return }
    act('issue', {
      offered_amount_kobo: Math.round(Number(amount) * 100),
      offered_rate_bps: rate ? Math.round(Number(rate) * 100) : 0,
      offered_tenor_months: tenor ? parseInt(tenor) : 0,
      offer_expires_at: expiry,
    })
  }

  return (
    <div className="sd-panel">
      <div className="sd-panel-head">
        <h2>Offer and acceptance</h2>
        <span className="sd-panel-hint">Phoenix owns this step — recorded here for the file</span>
      </div>
      <div className="sd-panel-body">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: status !== "none" ? 12 : 10 }}>
        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '3px 10px', borderRadius: RADIUS.full, background: m.bg, color: m.txt }}>{m.label}</span>
        {app.offer_source && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>via {app.offer_source === 'phoenix' ? 'Phoenix' : 'workspace'}</span>}
        {app.offer_issued_at && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>issued {fmtDate(app.offer_issued_at)}</span>}
      </div>

      {status !== 'none' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 12 }}>
          {[
            { label: 'Offered amount', value: app.offered_amount_kobo ? fmtKobo(app.offered_amount_kobo) : '—' },
            { label: 'Rate', value: app.offered_rate_bps ? `${(app.offered_rate_bps / 100).toFixed(2)}%` : '—' },
            { label: 'Tenor', value: app.offered_tenor_months ? `${app.offered_tenor_months}m` : '—' },
            { label: status === 'accepted' ? 'Accepted' : 'Expires', value: status === 'accepted' ? (app.offer_accepted_at ? fmtDate(app.offer_accepted_at) : '—') : (app.offer_expires_at ? fmtDate(app.offer_expires_at) : '—') },
          ].map(x => (
            <div key={x.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{x.label}</span>
              <span style={{ ...NUM, fontSize: 14, fontWeight: 700, color: 'var(--txt)' }}>{x.value}</span>
            </div>
          ))}
        </div>
      )}
      {app.offer_note && <div style={{ fontSize: 12.5, color: 'var(--txt2)', marginBottom: 12, lineHeight: 1.5 }}>{app.offer_note}</div>}

      {canCapture && !editing && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(status === 'none' || status === 'expired' || status === 'declined') && (
            <button onClick={() => setEditing(true)} className="sd-btn is-primary">
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>description</span>Issue offer
            </button>
          )}
          {status === 'issued' && <>
            <button onClick={() => setEditing(true)} className="sd-btn">Update terms</button>
            <button disabled={busy} onClick={() => act('accept')} className="sd-btn" style={{ color: GREEN, borderColor: GREEN }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>check_circle</span>Record acceptance
            </button>
            <button disabled={busy} onClick={() => act('decline')} className="sd-btn is-danger">Mark declined</button>
          </>}
        </div>
      )}
      {canCapture && editing && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
            <label style={lbl}>Amount (₦)<input type="number" value={amount} onChange={e => setAmount(e.target.value)} style={inputStyle} /></label>
            <label style={lbl}>Rate (% p.a.)<input type="number" step="0.01" value={rate} onChange={e => setRate(e.target.value)} style={inputStyle} /></label>
            <label style={lbl}>Tenor (months)<input type="number" value={tenor} onChange={e => setTenor(e.target.value)} style={inputStyle} /></label>
            <label style={lbl}>Expires<input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} style={inputStyle} /></label>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button disabled={busy} onClick={saveOffer} className="sd-btn is-primary">Save offer</button>
            <button onClick={() => setEditing(false)} className="sd-btn">Cancel</button>
          </div>
        </div>
      )}
      </div>
    </div>
  )
}


// ── SALES VIEW ────────────────────────────────────────────────────────────────
//
// The origination-side view of an application. Sales owns the customer
// relationship — before hand-off and after — so this answers the three questions
// an officer actually has when they open a file: what did we capture, can this
// customer afford it, and what do I do next.
//
// It is not a cut-down Risk view. Risk decides; Sales collects, chases and
// explains. The credit verdict therefore appears as a read-only outcome, while
// everything Sales can act on — documents, outstanding conditions, the route back
// to the customer — is put first.
//
// Layout structure is borrowed from Phoenix (kicker over a large record name, a
// stat strip for the deciding numbers, panels with a real head, a quiet
// two-column field grid). The palette is not: this page lives in O3 chrome and
// uses workspace tokens throughout. See salesDetail.css.

// salesNextStep turns the stage into the one thing this officer should do now.
// A stage pill says where the file IS; it does not say whose move it is, and that
// was the gap — an officer could open a file parked on them and see nothing
// prompting action.
function salesNextStep(app: Application): { tone: 'act' | 'wait' | 'done' | 'stop'; icon: string; title: string; body: string } {
  const s = app.stage
  if (s === 'declined') {
    return { tone: 'stop', icon: 'cancel', title: 'Declined', body: app.decline_reason || 'This application was declined. Let the customer know, and record the conversation on the thread below.' }
  }
  if (s === 'active' || s === 'booked') {
    return { tone: 'done', icon: 'check_circle', title: 'Booked and live', body: 'The facility has been disbursed. Nothing further is needed from Sales on this application.' }
  }
  if (s === 'draft') {
    return { tone: 'act', icon: 'edit_note', title: 'Finish and submit', body: 'This has not been submitted yet. Complete the applicant record and the document checklist, then send it for review.' }
  }
  if (s === 'submitted' || s === 'document_collection') {
    return { tone: 'act', icon: 'folder_open', title: 'Collect the outstanding documents', body: 'Work the checklist below. Once every required document is in, move the application on to risk review.' }
  }
  if (s === 'pending_conditions') {
    return { tone: 'act', icon: 'rule', title: 'Conditions to clear', body: 'Credit has attached conditions to this approval. Chase the customer for what is outstanding, then hand it back.' }
  }
  return {
    tone: 'wait',
    icon: 'hourglass_top',
    title: `With ${stageMeta(app.stage).owner || 'the credit team'}`,
    body: 'This is under review and is not waiting on you. The outcome will appear here — the customer stays yours throughout, so pick up anything the reviewers ask for on the thread below.',
  }
}

// maskId shows only the last 4 digits of a BVN or NIN. The officer usually typed
// these in themselves, but heads and reviewers open the same file, and the rest of
// the estate already masks these in exports — a detail screen showing them in full
// would be the one place that does not.
function maskId(v: string | null | undefined): React.ReactNode {
  const s = (v ?? '').trim()
  if (!s) return null
  if (s.length <= 4) return s
  return '•'.repeat(Math.max(0, s.length - 4)) + s.slice(-4)
}

function fmtDateOnly(v: string | null | undefined): string | null {
  const s = (v ?? '').trim()
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function titleCaseCode(v: string | null | undefined): string | null {
  const s = (v ?? '').trim()
  if (!s) return null
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function SDField({ label, value, wide = false, mono = false }: {
  label: string; value: React.ReactNode; wide?: boolean; mono?: boolean
}) {
  const empty = value === null || value === undefined || value === ''
  return (
    <div className={`sd-field${wide ? ' is-wide' : ''}`}>
      <label>{label}</label>
      <div className={`sd-val${mono ? ' is-mono' : ''}${empty ? ' is-empty' : ''}`}>{empty ? 'Not captured' : value}</div>
    </div>
  )
}

function SDPanel({ title, hint, children, flush = false }: {
  title: string; hint?: React.ReactNode; children: React.ReactNode; flush?: boolean
}) {
  return (
    <div className="sd-panel">
      <div className="sd-panel-head">
        <h2>{title}</h2>
        {hint ? <span className="sd-panel-hint">{hint}</span> : null}
      </div>
      {flush ? children : <div className="sd-panel-body">{children}</div>}
    </div>
  )
}

function SDStat({ label, value, sub, tone }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string
}) {
  return (
    <div className={`sd-stat${tone ? ' is-flagged' : ''}`} style={tone ? { color: tone } : undefined}>
      <div className="sd-stat-lbl">{label}</div>
      <div className="sd-stat-num" style={tone ? { color: tone } : undefined}>{value}</div>
      {sub ? <div className="sd-stat-sub">{sub}</div> : null}
    </div>
  )
}

function SalesView({ app, events, conditions, onRefresh, onAdvance, onDecline, onReqInfo, onCreditFile }: {
  app: Application
  events: AppEvent[]
  conditions: AppCondition[]
  onRefresh: () => void
  onAdvance: (toStage: string) => void
  onDecline: () => void
  onReqInfo: () => void
  onCreditFile: () => void
}) {
  const navigate = useNavigate()
  const meta = stageMeta(app.stage)
  const next = salesNextStep(app)

  // Affordability from what the form captured. Shown even before Phoenix has
  // scored: it is the number an officer can sanity-check with the customer in the
  // room, and a file that fails it obviously is one not worth submitting.
  const income = app.monthly_income_kobo || 0
  const oblig = app.monthly_obligation_kobo || 0
  const disposable = income > 0 ? income - oblig : 0
  const obligPct = income > 0 ? (oblig / income) * 100 : null
  const dtiPct = dtiOf(app.dti_pct) ?? obligPct
  const dtiTone = dtiPct == null ? undefined : dtiPct > 40 ? RED : dtiPct > 30 ? AMBER : undefined

  const openConditions = conditions.filter(c => !c.is_met)

  // Whose move is it? The stage's owner, not the viewer's permissions — see the
  // action buttons below for why that distinction matters here.
  const salesOwnsStage = /sales/i.test(meta.owner || '')

  // The brand constants live in TS; the stylesheet reads them as variables so the
  // colour stays defined in one place rather than duplicated across both.
  const brand = { '--sd-navy': NAVY, '--sd-red': RED, '--sd-green': GREEN, '--sd-amber': AMBER } as React.CSSProperties

  return (
    <div className="sd" style={brand}>
      {/* Header */}
      <div className="sd-head">
        <div style={{ minWidth: 0 }}>
          <div className="sd-kicker">
            <ProductPill product={app.product_type || 'Unknown'} />
            <StagePill stage={app.stage} size="sm" />
          </div>
          <h1 className="sd-name">{app.applicant_name}</h1>
          <div className="sd-ref">
            {app.reference}
            {app.applicant_cif ? ` · CIF ${app.applicant_cif}` : ' · no CIF yet'}
            {app.submitted_at ? ` · submitted ${fmtDateOnly(app.submitted_at)}` : ''}
          </div>
        </div>

        <div className="sd-actions">
          {app.applicant_cif && (
            <button className="sd-btn" onClick={onCreditFile}>
              <span className="material-symbols-rounded">folder_shared</span>Credit file
            </button>
          )}
          {app.applicant_cif && (
            <button className="sd-btn" onClick={() => navigate(`/contacts/${app.applicant_cif}`)}>
              <span className="material-symbols-rounded">person</span>Customer 360
            </button>
          )}
          {/* Only Sales' OWN moves appear here.
              canAdvance() asks whether you hold the page for the stage's forward
              transition — and los_all (sales_head, admin, COO) holds every page, so
              on the Sales route this offered "Recommend to risk head" and "Decline"
              while the file was sitting with Risk. Those are Risk's decisions taken
              on Risk's screen. The stage's own `owner` is the honest test: Sales
              owns draft and submitted, and nothing after that. */}
          {salesOwnsStage && canAdvance(app.stage) && (
            <button className="sd-btn is-warn" onClick={onReqInfo}>
              <span className="material-symbols-rounded">help</span>Request info
            </button>
          )}
          {salesOwnsStage && canDecline(app.stage) && (
            <button className="sd-btn is-danger" onClick={onDecline}>
              <span className="material-symbols-rounded">cancel</span>Withdraw
            </button>
          )}
          {salesOwnsStage && canAdvance(app.stage) && meta.forward && (
            <button className="sd-btn is-primary" onClick={() => onAdvance(meta.forward!)}>
              <span className="material-symbols-rounded">send</span>{meta.action ?? 'Advance'}
            </button>
          )}
        </div>
      </div>

      {/* What this officer does next */}
      <div className={`sd-band sd-band-${next.tone}`}>
        <div className="sd-band-icn"><span className="material-symbols-rounded">{next.icon}</span></div>
        <div style={{ minWidth: 0 }}>
          <b>{next.title}</b>
          <span>{next.body}</span>
        </div>
      </div>

      {/* The credit outcome, then the offer built on it. These sit here — after
          "what do I do next", before the applicant record — because that is the
          order Sales works in: read the verdict, then act on the offer. */}
      <PhoenixDecisionBanner app={app} />
      <OfferPanel app={app} onRefresh={onRefresh} />

      {/* The customer's own steps — consent, the amount they accepted, the mandate.
          Phoenix owns all three, so these call Phoenix and show its answer. They sit
          under the offer because that is the order the customer moves through them,
          and above the applicant record because they are what the file is waiting
          on. */}
      <CustomerJourney
        appId={app.id}
        approvedKobo={app.amount_approved_kobo}
        requestedKobo={app.amount_requested_kobo}
        onRefresh={onRefresh}
      />

      {/* The numbers that decide the case */}
      <div className="sd-stats">
        <SDStat label="Amount requested" value={fmtKobo(app.amount_requested_kobo)}
          sub={app.tenor_months ? `over ${app.tenor_months} months` : 'revolving — no term'} />
        <SDStat label="Monthly income" value={income ? fmtKobo(income) : '—'}
          tone={income === 0 ? AMBER : undefined} sub={income === 0 ? 'not captured' : undefined} />
        <SDStat label="Existing obligations" value={app.monthly_obligation_kobo == null ? '—' : fmtKobo(oblig)} />
        <SDStat label="Disposable" value={income ? fmtKobo(disposable) : '—'}
          tone={income > 0 && disposable <= 0 ? RED : undefined}
          sub={income > 0 && disposable <= 0 ? 'obligations exceed income' : undefined} />
        <SDStat label="Debt-to-income" value={dtiPct == null ? '—' : `${dtiPct.toFixed(1)}%`} tone={dtiTone}
          sub={dtiPct == null ? 'awaiting assessment' : dtiPct > 40 ? 'above policy' : undefined} />
      </div>

      {income === 0 && (
        <div className="sd-note is-warn">
          <span className="material-symbols-rounded">warning</span>
          <span>No monthly income captured. Credit scoring reads a missing income as zero and declines on affordability, so capture it before submitting this application.</span>
        </div>
      )}

      {/* Progress */}
      <div className="sd-panel"><PipelineStepper stage={app.stage} /></div>

      {/* Conditions — credit sets them, Sales is who chases them */}
      {openConditions.length > 0 && (
        <SDPanel title="Conditions to clear" hint={`${openConditions.length} outstanding`} flush>
          <ConditionsInline appId={app.id} conditions={conditions} onRefresh={onRefresh} canManage={false} />
        </SDPanel>
      )}

      {/* Applicant + documents */}
      <div className="sd-grid2">
        <SDPanel title="Applicant">
          <div className="sd-fields">
            <SDField label="Phone" value={app.applicant_phone} mono />
            <SDField label="Email" value={app.applicant_email} />
            <SDField label="BVN" value={maskId(app.bvn)} mono />
            <SDField label="NIN" value={maskId(app.nin)} mono />
            <SDField label="Date of birth" value={fmtDateOnly(app.date_of_birth)} />
            <SDField label="CIF" value={app.applicant_cif} mono />
            <SDField label="Residential address" value={app.residential_address} wide />
          </div>
        </SDPanel>

        <SDPanel title="Documents" flush>
          <DocumentsInline appId={app.id} />
        </SDPanel>
      </div>

      {/* Employment + origin */}
      <div className="sd-grid2">
        <SDPanel title="Employment">
          <div className="sd-fields">
            <SDField label="Employer" value={app.employer} />
            <SDField label="Job title" value={app.job_title} />
            <SDField label="Employment type" value={titleCaseCode(app.employment_type)} />
            <SDField label="Employed since" value={fmtDateOnly(app.employment_start_date)} />
          </div>
        </SDPanel>

        <SDPanel title="Origin">
          <div className="sd-fields">
            <SDField label="Reference" value={app.reference} mono />
            <SDField label="Source" value={app.source_lead_id ? `Lead #${app.source_lead_id}` : (app.lead_source || titleCaseCode(app.source_system))} />
            <SDField label="Submitted" value={app.submitted_at ? fmtDatetime(app.submitted_at) : null} />
            <SDField label="Last updated" value={app.updated_at ? fmtDatetime(app.updated_at) : null} />
          </div>
        </SDPanel>
      </div>

      {/* Terms */}
      <SDPanel title="Terms">
        <div className="sd-fields">
          <SDField label="Product" value={titleCaseCode(app.product_type)} />
          <SDField label="Purpose" value={app.purpose} />
          <SDField label="Amount requested" value={fmtKobo(app.amount_requested_kobo)} mono />
          <SDField label="Amount approved" value={app.amount_approved_kobo ? fmtKobo(app.amount_approved_kobo) : null} mono />
          {/* A revolving product has no tenor. NULL says so — migration 217 removed
              the 0 sentinel that used to claim a zero-month term. */}
          <SDField label="Tenor" value={app.tenor_months ? `${app.tenor_months} months` : 'Revolving — no term'} />
          <SDField label="Interest rate" value={app.interest_rate_bps ? `${(app.interest_rate_bps / 100).toFixed(2)}% p.a.` : null} mono />
        </div>
      </SDPanel>

      {/* Where it is */}
      <SDPanel title="Where is this application?" flush>
        <ApprovalChainCompact app={app} events={events} />
      </SDPanel>

      {/* Team thread */}
      <InternalThread appId={app.id} />
    </div>
  )
}
// ── RISK VIEW ─────────────────────────────────────────────────────────────────

const RATING_COLORS: Record<string, string> = { Excellent: GREEN, Good: GREEN, Fair: AMBER, Poor: RED, Bad: RED }

function RiskView({ app, conditions, events, onRefresh, onAdvance, onDecline, onReqInfo, onCreditFile }: {
  app: Application
  conditions: AppCondition[]
  events: AppEvent[]
  onRefresh: () => void
  onAdvance: (toStage: string) => void
  onDecline: () => void
  onReqInfo: () => void
  onCreditFile: () => void
}) {
  const navigate  = useNavigate()
  const meta = stageMeta(app.stage)
  const isTerminal = app.stage === 'active' || app.stage === 'declined'
  // A manual assessment is a Risk-only override of the same columns Phoenix populates.
  const canAssess = hasPage('los_risk_review') || hasPage('los_risk_head') || hasPage('los_all')
  // Whether the current eye_* values came from the decisioning engine, so a manual edit
  // is flagged as an override rather than silently clobbering Phoenix's output.
  const phoenixScored = app.phoenix_sync_state === 'decided' || app.source_system === 'phoenix' || !!(app.decision && app.decision !== 'pending')

  const score  = app.eye_score
  const rating = app.eye_rating
  const scoreColor = score === null ? 'var(--txt3)' : score >= 650 ? GREEN : score >= 500 ? AMBER : RED

  const monthlyRepayment = (app.tenor_months && app.amount_requested_kobo)
    ? Math.round(app.amount_requested_kobo / app.tenor_months * (1 + (app.interest_rate_bps ?? 0) / 10000))
    : 0
  const dtiPct  = dtiOf(app.dti_pct) ?? ((app.monthly_income_kobo && monthlyRepayment)
    ? (monthlyRepayment / app.monthly_income_kobo) * 100 : null)
  const dtiColor  = dtiPct === null ? 'var(--txt2)' : dtiPct > 50 ? RED : dtiPct > 33 ? AMBER : GREEN
  const netAfter  = (app.monthly_income_kobo && monthlyRepayment) ? app.monthly_income_kobo - monthlyRepayment : null
  const unmetCount = conditions.filter(c => !c.is_met).length

  // Inline credit assessment editing
  const [form,    setForm]    = useState({ eye_score: score !== null ? String(score) : '', eye_rating: rating ?? '', bureau_summary: app.bureau_summary ?? '', dti_pct: app.dti_pct !== null ? String(app.dti_pct) : '' })
  const [editing, setEditing] = useState(false)
  const [saving,  setSaving]  = useState(false)

  async function saveAssessment() {
    setSaving(true)
    try {
      await apiPut(`/api/los/${app.id}/credit-assessment`, {
        eye_score:      form.eye_score      ? Number(form.eye_score)  : null,
        eye_rating:     form.eye_rating     || null,
        bureau_summary: form.bureau_summary || null,
        dti_pct:        form.dti_pct        ? Number(form.dti_pct)    : null,
      })
      toast.success('Assessment saved'); setEditing(false); onRefresh()
    } catch (e: any) { toast.error(e.message ?? 'Failed to save') }
    finally { setSaving(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '14px 18px', background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, boxShadow: 'var(--card-shadow)' }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 2 }}>Applicant</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--txt)' }}>{app.applicant_name}</div>
        </div>
        <div style={{ width: 1, height: 36, background: 'var(--bdr)' }} />
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 2 }}>Amount</div>
          <div style={{ ...NUM, fontSize: 15, fontWeight: 700, color: 'var(--txt)' }}>{fmtKobo(app.amount_requested_kobo)}</div>
        </div>
        <div style={{ width: 1, height: 36, background: 'var(--bdr)' }} />
        <StagePill stage={app.stage} />

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {app.applicant_cif && (
            <button onClick={onCreditFile} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 7, fontSize: 12, fontWeight: 600, color: 'var(--txt2)', cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>insert_drive_file</span>Credit File
            </button>
          )}
          {canRequestInfo(app.stage) && (
            <button onClick={onReqInfo} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: 'var(--card)', color: AMBER, border: `1px solid ${AMBER}`, borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>help</span>Request Info
            </button>
          )}
          {canDecline(app.stage) && (
            <button onClick={onDecline} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: 'var(--card)', color: RED, border: `1px solid ${RED}40`, borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>cancel</span>Decline
            </button>
          )}
          {canAdvance(app.stage) && meta.forward && (
            <button onClick={() => onAdvance(meta.forward!)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 18px', background: GREEN, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>check_circle</span>
              {meta.action ?? 'Advance'}
            </button>
          )}
          {isTerminal && app.stage === 'active' && (
            <span style={{ fontSize: 12, fontWeight: 600, padding: '4px 12px', borderRadius: 20, background: 'rgba(22,163,74,.12)', color: GREEN }}>Disbursed</span>
          )}
          {isTerminal && app.stage === 'declined' && (
            <span style={{ fontSize: 12, fontWeight: 600, padding: '4px 12px', borderRadius: 20, background: 'rgba(192,0,0,.1)', color: RED }}>Declined</span>
          )}
        </div>
      </div>

      {/* Declined banner */}
      {app.stage === 'declined' && app.decline_reason && (
        <div style={{ display: 'flex', gap: 10, padding: '12px 16px', borderRadius: 10, background: 'rgba(192,0,0,.06)', border: '1px solid rgba(192,0,0,.2)' }}>
          <span className="material-symbols-rounded" style={{ color: RED, fontSize: 18, flexShrink: 0 }}>cancel</span>
          <div><div style={{ fontSize: 13, fontWeight: 700, color: RED }}>Application Declined</div><div style={{ fontSize: 13, color: 'var(--txt)', marginTop: 2 }}>{app.decline_reason}</div></div>
        </div>
      )}

      {/* Score hero — always visible */}
      <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 16, padding: '20px 24px', borderRadius: 12, background: 'var(--card)', border: '1px solid var(--card-bdr)', boxShadow: 'var(--card-shadow)' }}>
        {/* Score circle */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '16px 0', borderRight: '1px solid var(--bdr)' }}>
          <div style={{ ...NUM, fontSize: 62, fontWeight: 800, color: scoreColor, lineHeight: 1 }}>{score ?? '—'}</div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Eye Score</div>
          {rating && (
            <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 12px', borderRadius: 20, background: `${RATING_COLORS[rating] ?? 'var(--txt2)'}18`, color: RATING_COLORS[rating] ?? 'var(--txt2)' }}>{rating}</span>
          )}
          {!score && (
            <span style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 9px', borderRadius: 20, background: 'rgba(217,119,6,.12)', color: AMBER }}>Pending</span>
          )}
          {phoenixScored && score !== null && (
            <span style={{ fontSize: 10.5, fontWeight: 600, color: '#7C3AED', display: 'inline-flex', alignItems: 'center', gap: 3, marginTop: 2 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 12 }}>verified</span>via Phoenix
            </span>
          )}
          {canAssess && !isTerminal && (
            <button onClick={() => setEditing(e => !e)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', fontSize: 11.5, cursor: 'pointer', marginTop: 4 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 13 }}>edit</span>{score !== null ? (phoenixScored ? 'Override' : 'Update') : 'Enter Score'}
            </button>
          )}
        </div>

        {/* Risk metrics */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16, padding: '0 0 16px', borderBottom: '1px solid var(--bdr)', marginBottom: 16 }}>
            {[
              { label: 'Monthly Income',        value: app.monthly_income_kobo ? fmtKobo(app.monthly_income_kobo) : '—', color: 'var(--txt)' },
              { label: 'Est. Monthly Repayment', value: monthlyRepayment ? fmtKobo(monthlyRepayment) : '—', color: 'var(--txt)' },
              { label: 'DTI Ratio',              value: dtiPct !== null ? `${dtiPct.toFixed(1)}%` : '—', color: dtiColor },
              { label: 'Net After Deduction',    value: netAfter !== null ? fmtKobo(netAfter) : '—', color: netAfter !== null ? (netAfter > 0 ? GREEN : RED) : 'var(--txt)' },
            ].map(m => (
              <div key={m.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{m.label}</span>
                <span style={{ ...NUM, fontSize: 15, fontWeight: 700, color: m.color }}>{m.value}</span>
              </div>
            ))}
          </div>
          {app.bureau_summary && (
            <div style={{ fontSize: 13, color: 'var(--txt2)', lineHeight: 1.6 }}>{app.bureau_summary}</div>
          )}
          {!app.bureau_summary && score === null && (
            <div style={{ fontSize: 13, color: 'var(--txt3)', fontStyle: 'italic' }}>Enter the Eye Score to populate risk metrics.</div>
          )}
        </div>
      </div>

      {/* Inline score edit form */}
      {editing && (
        <SectionCard title="Update Credit Assessment">
          {phoenixScored && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8, background: 'rgba(124,58,237,.06)', border: '1px solid rgba(124,58,237,.2)', marginBottom: 12 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 16, color: '#7C3AED', flexShrink: 0 }}>info</span>
              <span style={{ fontSize: 12, color: 'var(--txt2)', lineHeight: 1.5 }}>This score was set by Phoenix decisioning. Saving a manual assessment overrides the Phoenix values on record.</span>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, color: 'var(--txt2)', fontWeight: 600 }}>
              Eye Score (0–850)
              <input type="number" min={0} max={850} value={form.eye_score} onChange={e => setForm(f => ({ ...f, eye_score: e.target.value }))} style={{ ...inputStyle }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, color: 'var(--txt2)', fontWeight: 600 }}>
              Rating
              <select value={form.eye_rating} onChange={e => setForm(f => ({ ...f, eye_rating: e.target.value }))} style={{ ...inputStyle, cursor: 'pointer' }}>
                <option value="">— select —</option>
                {['Excellent','Good','Fair','Poor','Bad'].map(r => <option key={r}>{r}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, color: 'var(--txt2)', fontWeight: 600 }}>
              DTI % (override)
              <input type="number" step="0.01" value={form.dti_pct} onChange={e => setForm(f => ({ ...f, dti_pct: e.target.value }))} style={{ ...inputStyle }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, color: 'var(--txt2)', fontWeight: 600 }}>
              Bureau Summary
              <textarea rows={2} value={form.bureau_summary} spellCheck={false} data-gramm="false"
                onChange={e => setForm(f => ({ ...f, bureau_summary: e.target.value }))} style={{ ...textareaStyle, minHeight: 0 }} />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button onClick={saveAssessment} disabled={saving || !form.eye_score}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 18px', borderRadius: 7, border: 'none', background: NAVY, color: '#fff', fontSize: 13, fontWeight: 600, cursor: (saving || !form.eye_score) ? 'not-allowed' : 'pointer', opacity: (saving || !form.eye_score) ? 0.6 : 1 }}>
              {saving && <Spinner size={13} color="#fff" />}Save Assessment
            </button>
            <button onClick={() => setEditing(false)} style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          </div>
        </SectionCard>
      )}

      {/* Conditions + Summary side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SectionCard title="Conditions" padding={false}>
          <ConditionsInline appId={app.id} conditions={conditions} onRefresh={onRefresh} canManage={true} />
        </SectionCard>

        <SectionCard title="Application Summary">
          <InfoRow label="Applicant"       value={app.applicant_name} />
          <InfoRow label="Phone"           value={app.applicant_phone} />
          <InfoRow label="Employer"        value={app.employer} />
          <InfoRow label="Amount Requested"value={fmtKobo(app.amount_requested_kobo)} />
          <InfoRow label="Tenor"           value={app.tenor_months ? `${app.tenor_months} months` : null} />
          <InfoRow label="Interest Rate"   value={app.interest_rate_bps ? `${(app.interest_rate_bps / 100).toFixed(2)}% p.a.` : null} />
          <InfoRow label="Purpose"         value={app.purpose} />
          <InfoRow label="Submitted"       value={app.submitted_at ? fmtDatetime(app.submitted_at) : 'Not submitted'} />
        </SectionCard>
      </div>

      {/* Conditions warning */}
      {app.stage === 'pending_conditions' && unmetCount > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 8, background: 'rgba(124,58,237,.06)', border: '1px solid rgba(124,58,237,.2)' }}>
          <span className="material-symbols-rounded" style={{ color: '#7C3AED', fontSize: 16 }}>pending_actions</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#7C3AED' }}>{unmetCount} condition{unmetCount !== 1 ? 's' : ''} must be satisfied before advancing to Finance</span>
        </div>
      )}

      {/* Documents — read-only view for risk */}
      <SectionCard title="Supporting Documents" padding={false}>
        <DocumentsInline appId={app.id} readOnly />
      </SectionCard>

      {/* Team thread */}
      <InternalThread appId={app.id} />
    </div>
  )
}

// ── COMPLIANCE VIEW ───────────────────────────────────────────────────────────

function ComplianceView({ app, events, conditions, onRefresh }: {
  app: Application
  events: AppEvent[]
  conditions: AppCondition[]
  onRefresh: () => void
}) {
  const navigate = useNavigate()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '14px 18px', background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, boxShadow: 'var(--card-shadow)' }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 2 }}>Applicant</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--txt)' }}>{app.applicant_name}</div>
        </div>
        <div style={{ width: 1, height: 36, background: 'var(--bdr)' }} />
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 2 }}>Product</div>
          <ProductPill product={app.product_type || '—'} />
        </div>
        <div style={{ width: 1, height: 36, background: 'var(--bdr)' }} />
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 2 }}>Amount</div>
          <div style={{ ...NUM, fontSize: 15, fontWeight: 700, color: 'var(--txt)' }}>{fmtKobo(app.amount_requested_kobo)}</div>
        </div>
        <div style={{ width: 1, height: 36, background: 'var(--bdr)' }} />
        <StagePill stage={app.stage} />
        <div style={{ marginLeft: 'auto' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, padding: '4px 12px', borderRadius: 20, background: 'rgba(124,58,237,.08)', color: '#7C3AED' }}>Compliance View, Read Only</span>
        </div>
      </div>

      {/* Declined banner */}
      {app.stage === 'declined' && app.decline_reason && (
        <div style={{ display: 'flex', gap: 10, padding: '12px 16px', borderRadius: 10, background: 'rgba(192,0,0,.06)', border: '1px solid rgba(192,0,0,.2)' }}>
          <span className="material-symbols-rounded" style={{ color: RED, fontSize: 18, flexShrink: 0 }}>cancel</span>
          <div><div style={{ fontSize: 13, fontWeight: 700, color: RED }}>Application Declined</div><div style={{ fontSize: 13, color: 'var(--txt)', marginTop: 2 }}>{app.decline_reason}</div></div>
        </div>
      )}

      {/* Customer info + Documents side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SectionCard title="Applicant Information">
          <InfoRow label="Full Name"    value={app.applicant_name} />
          <InfoRow label="Phone"        value={app.applicant_phone} />
          <InfoRow label="Email"        value={app.applicant_email} />
          <InfoRow label="CIF"          value={app.applicant_cif} />
          <InfoRow label="Employer"     value={app.employer} />
          <InfoRow label="Purpose"      value={app.purpose} />
          <InfoRow label="Submitted"    value={app.submitted_at ? fmtDatetime(app.submitted_at) : '—'} />
        </SectionCard>

        <SectionCard title="Submitted Documents" padding={false}>
          <DocumentsInline appId={app.id} readOnly />
        </SectionCard>
      </div>

      {/* Loan terms */}
      <SectionCard title="Loan Details">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
          {[
            { label: 'Product',          value: <ProductPill product={app.product_type || '—'} /> },
            { label: 'Amount Requested', value: fmtKobo(app.amount_requested_kobo) },
            { label: 'Tenor',            value: app.tenor_months ? `${app.tenor_months} months` : '—' },
            { label: 'Interest Rate',    value: app.interest_rate_bps ? `${(app.interest_rate_bps / 100).toFixed(2)}% p.a.` : '—' },
            { label: 'Monthly Income',   value: app.monthly_income_kobo ? fmtKobo(app.monthly_income_kobo) : '—' },
            { label: 'Current Stage',    value: <StagePill stage={app.stage} /> },
          ].map(row => (
            <div key={row.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{row.label}</span>
              <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--txt)' }}>{row.value}</span>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Conditions (read-only) + Approval chain */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SectionCard title="Conditions" padding={false}>
          <ConditionsInline appId={app.id} conditions={conditions} onRefresh={onRefresh} canManage={false} />
        </SectionCard>

        <SectionCard title="Approval Chain" padding={false}>
          <ApprovalChainCompact app={app} events={events} />
        </SectionCard>
      </div>

      {/* Team thread */}
      <InternalThread appId={app.id} />
    </div>
  )
}

// ── FINANCE VIEW ──────────────────────────────────────────────────────────────

function FinanceView({ app, events, conditions, onRefresh, onAdvance, onDecline, onReqInfo }: {
  app: Application
  events: AppEvent[]
  conditions: AppCondition[]
  onRefresh: () => void
  onAdvance: (toStage: string) => void
  onDecline: () => void
  onReqInfo: () => void
}) {
  const meta = stageMeta(app.stage)
  const isFinanceStage = ['finance_approval', 'booking'].includes(app.stage)

  const score  = app.eye_score
  const rating = app.eye_rating
  const scoreColor = score === null ? 'var(--txt3)' : score >= 650 ? GREEN : score >= 500 ? AMBER : RED

  const monthlyRepayment = (app.tenor_months && app.amount_requested_kobo)
    ? Math.round(app.amount_requested_kobo / app.tenor_months * (1 + (app.interest_rate_bps ?? 0) / 10000))
    : 0
  const dtiPct    = dtiOf(app.dti_pct)
  const dtiColor  = dtiPct === null ? 'var(--txt2)' : dtiPct > 50 ? RED : dtiPct > 33 ? AMBER : GREEN
  const unmetCount = conditions.filter(c => !c.is_met).length
  const allConditionsMet = conditions.length > 0 && unmetCount === 0
  const conditionsBlock = conditions.length > 0 && unmetCount > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '14px 18px', background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, boxShadow: 'var(--card-shadow)' }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 2 }}>Applicant</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--txt)' }}>{app.applicant_name}</div>
        </div>
        <div style={{ width: 1, height: 36, background: 'var(--bdr)' }} />
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 2 }}>Amount</div>
          <div style={{ ...NUM, fontSize: 15, fontWeight: 700, color: 'var(--txt)' }}>
            {app.amount_approved_kobo ? fmtKobo(app.amount_approved_kobo) : fmtKobo(app.amount_requested_kobo)}
          </div>
        </div>
        <div style={{ width: 1, height: 36, background: 'var(--bdr)' }} />
        <StagePill stage={app.stage} />
        {score !== null && (
          <>
            <div style={{ width: 1, height: 36, background: 'var(--bdr)' }} />
            <div>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 2 }}>Eye Score</div>
              <div style={{ ...NUM, fontSize: 14, fontWeight: 800, color: scoreColor }}>{score} {rating ? `· ${rating}` : ''}</div>
            </div>
          </>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {canRequestInfo(app.stage) && (
            <button onClick={onReqInfo} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 13px', background: 'var(--card)', color: AMBER, border: `1px solid ${AMBER}`, borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>pause_circle</span>Hold
            </button>
          )}
          {canDecline(app.stage) && (
            <button onClick={onDecline} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 13px', background: 'var(--card)', color: RED, border: `1px solid ${RED}40`, borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>cancel</span>Decline
            </button>
          )}
          {canAdvance(app.stage) && meta.forward && (
            <button onClick={() => onAdvance(meta.forward!)} disabled={conditionsBlock}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 18px', background: NAVY, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: conditionsBlock ? 'not-allowed' : 'pointer', opacity: conditionsBlock ? 0.5 : 1 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>payments</span>{meta.action ?? 'Advance'}
            </button>
          )}
          {app.stage === 'active' && (
            <span style={{ fontSize: 12, fontWeight: 600, padding: '4px 14px', borderRadius: 20, background: 'rgba(22,163,74,.12)', color: GREEN }}>✓ Disbursed</span>
          )}
          {app.stage === 'declined' && (
            <span style={{ fontSize: 12, fontWeight: 600, padding: '4px 14px', borderRadius: 20, background: 'rgba(192,0,0,.1)', color: RED }}>Declined</span>
          )}
        </div>
      </div>

      {/* Conditions gate banner */}
      {isFinanceStage && conditions.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderRadius: 10, background: allConditionsMet ? 'rgba(22,163,74,.06)' : 'rgba(192,0,0,.05)', border: `1px solid ${allConditionsMet ? 'rgba(22,163,74,.2)' : 'rgba(192,0,0,.18)'}` }}>
          <span className="material-symbols-rounded" style={{ fontSize: 20, color: allConditionsMet ? GREEN : RED }}>
            {allConditionsMet ? 'check_circle' : 'block'}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: allConditionsMet ? GREEN : RED }}>
              {allConditionsMet ? 'All conditions satisfied: disbursement cleared' : `${unmetCount} condition${unmetCount !== 1 ? 's' : ''} not yet satisfied`}
            </div>
            {!allConditionsMet && <div style={{ fontSize: 12, color: 'var(--txt2)', marginTop: 2 }}>Pending conditions must be met before this application can be disbursed</div>}
          </div>
          <span style={{ ...NUM, fontSize: 13, fontWeight: 700, color: allConditionsMet ? GREEN : RED }}>
            {conditions.length - unmetCount}/{conditions.length} met
          </span>
        </div>
      )}

      {/* Declined banner */}
      {app.stage === 'declined' && app.decline_reason && (
        <div style={{ display: 'flex', gap: 10, padding: '12px 16px', borderRadius: 10, background: 'rgba(192,0,0,.06)', border: '1px solid rgba(192,0,0,.2)' }}>
          <span className="material-symbols-rounded" style={{ color: RED, fontSize: 18, flexShrink: 0 }}>cancel</span>
          <div><div style={{ fontSize: 13, fontWeight: 700, color: RED }}>Application Declined</div><div style={{ fontSize: 13, color: 'var(--txt)', marginTop: 2 }}>{app.decline_reason}</div></div>
        </div>
      )}

      {/* Loan terms + Risk summary side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SectionCard title="Loan Terms">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {[
              { label: 'Product',          value: <ProductPill product={app.product_type || '—'} /> },
              { label: 'Amount Approved',  value: app.amount_approved_kobo ? fmtKobo(app.amount_approved_kobo) : <span style={{ color: AMBER }}>Pending</span> },
              { label: 'Amount Requested', value: fmtKobo(app.amount_requested_kobo) },
              { label: 'Tenor',            value: app.tenor_months ? `${app.tenor_months} months` : '—' },
              { label: 'Interest Rate',    value: app.interest_rate_bps ? `${(app.interest_rate_bps / 100).toFixed(2)}% p.a.` : '—' },
              { label: 'Est. Monthly Repayment', value: monthlyRepayment ? fmtKobo(monthlyRepayment) : '—' },
              { label: 'Purpose',          value: app.purpose || '—' },
              { label: 'Employer',         value: app.employer || '—' },
              // Collected on the origination form since it was written, but
              // discarded on save until migration 216 gave them columns: the
              // request struct never named these fields, so encoding/json dropped
              // them without error. Shown here so the two steps staff fill in are
              // part of the record rather than write-only.
              { label: 'BVN',              value: app.bvn || '—' },
              { label: 'NIN',              value: app.nin || '—' },
              { label: 'Date of Birth',    value: app.date_of_birth ? fmtDate(app.date_of_birth) : '—' },
              { label: 'Address',          value: app.residential_address || '—' },
              { label: 'Job Title',        value: app.job_title || '—' },
              { label: 'Employment Type',  value: app.employment_type || '—' },
              { label: 'Employed Since',   value: app.employment_start_date ? fmtDate(app.employment_start_date) : '—' },
              { label: 'Monthly Obligations', value: app.monthly_obligation_kobo ? fmtKobo(app.monthly_obligation_kobo) : '—' },
            ].map(row => (
              <InfoRow key={row.label} label={row.label} value={row.value} />
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Risk Decision Summary">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Score display */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 18px', borderRadius: 10, background: 'var(--th-bg)', border: '1px solid var(--bdr)' }}>
              <div style={{ textAlign: 'center', flexShrink: 0 }}>
                <div style={{ ...NUM, fontSize: 42, fontWeight: 800, color: scoreColor, lineHeight: 1 }}>{score ?? '—'}</div>
                <div style={{ fontSize: 10.5, color: 'var(--txt3)', marginTop: 2 }}>Eye Score</div>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {rating && <span style={{ fontSize: 12, fontWeight: 700, padding: '2px 10px', borderRadius: 12, background: `${RATING_COLORS[rating] ?? 'var(--txt2)'}18`, color: RATING_COLORS[rating] ?? 'var(--txt2)', alignSelf: 'flex-start' }}>{rating}</span>}
                {dtiPct !== null && (
                  <div style={{ fontSize: 13, color: 'var(--txt2)' }}>DTI: <span style={{ ...NUM, fontWeight: 700, color: dtiColor }}>{dtiPct.toFixed(1)}%</span></div>
                )}
                {app.bureau_summary && <div style={{ fontSize: 12, color: 'var(--txt2)', lineHeight: 1.5 }}>{app.bureau_summary}</div>}
                {!score && !app.bureau_summary && <div style={{ fontSize: 12, color: 'var(--txt3)' }}>No credit assessment on file</div>}
              </div>
            </div>

            {/* Key metrics */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[
                { label: 'Monthly Income',     value: app.monthly_income_kobo ? fmtKobo(app.monthly_income_kobo) : '—', color: 'var(--txt)' },
                { label: 'Monthly Obligations',value: app.monthly_obligation_kobo ? fmtKobo(app.monthly_obligation_kobo) : '—', color: 'var(--txt)' },
              ].map(m => (
                <div key={m.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{m.label}</span>
                  <span style={{ ...NUM, fontSize: 14, fontWeight: 700, color: m.color }}>{m.value}</span>
                </div>
              ))}
            </div>
          </div>
        </SectionCard>
      </div>

      {/* Approval chain + Conditions side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SectionCard title="Approval Chain" padding={false}>
          <ApprovalChainCompact app={app} events={events} />
        </SectionCard>

        <SectionCard title="Conditions" padding={false}>
          <ConditionsInline appId={app.id} conditions={conditions} onRefresh={onRefresh} canManage={true} />
        </SectionCard>
      </div>

      {/* Finance-specific dates */}
      {(app.finance_approved_at || app.booked_at) && (
        <SectionCard title="Key Dates">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <InfoRow label="Submitted"        value={app.submitted_at ? fmtDatetime(app.submitted_at) : '—'} />
            <InfoRow label="Finance Approved" value={app.finance_approved_at ? fmtDatetime(app.finance_approved_at) : 'Pending'} />
            <InfoRow label="Booked / Disbursed" value={app.booked_at ? fmtDatetime(app.booked_at) : 'Pending'} />
            <InfoRow label="Created"          value={fmtDate(app.created_at)} />
          </div>
        </SectionCard>
      )}

      {/* Team thread */}
      <InternalThread appId={app.id} />
    </div>
  )
}

// ── Timeline Tab ─────────────────────────────────────────────────────────────

type FeedItem =
  | { kind: 'event'; ts: string; item: AppEvent }
  | { kind: 'note';  ts: string; item: AppNote  }

function TimelineTab({ events, notes }: { events: AppEvent[]; notes: AppNote[] }) {
  const feed: FeedItem[] = [
    ...events.map(e => ({ kind: 'event' as const, ts: e.created_at, item: e })),
    ...notes.map(n  => ({ kind: 'note'  as const, ts: n.created_at, item: n  })),
  ].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())

  const eventColor: Record<string, string> = {
    stage_changed:     NAVY,
    declined:          RED,
    request_info:      AMBER,
    credit_assessment: '#7C3AED',
    condition_added:   BLUE,
    condition_met:     GREEN,
    document_uploaded: GREEN,
    note_added:        'var(--txt2)',
  }

  const eventIcon: Record<string, string> = {
    stage_changed:     'swap_horiz',
    declined:          'cancel',
    request_info:      'help',
    credit_assessment: 'query_stats',
    condition_added:   'add_task',
    condition_met:     'check_circle',
    document_uploaded: 'upload_file',
    note_added:        'sticky_note_2',
  }

  if (feed.length === 0) {
    return (
      <SectionCard title="Activity Timeline">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '40px 0', color: 'var(--txt2)' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 38, opacity: 0.3 }}>history</span>
          <div style={{ fontSize: 13 }}>No activity recorded yet.</div>
        </div>
      </SectionCard>
    )
  }

  return (
    <SectionCard title="Activity Timeline" badge={feed.length}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0, position: 'relative' }}>
        {/* Vertical line */}
        <div style={{ position: 'absolute', left: 19, top: 0, bottom: 0, width: 2, background: 'var(--bdr)', zIndex: 0 }} />

        {feed.map((f, i) => {
          if (f.kind === 'event') {
            const ev  = f.item as AppEvent
            const col = eventColor[ev.event_type] ?? 'var(--txt2)'
            const ico = eventIcon[ev.event_type]  ?? 'radio_button_checked'
            const isStage = ev.event_type === 'stage_changed'
            return (
              <div key={`e-${ev.id}`} style={{ display: 'flex', gap: 14, padding: '14px 0', alignItems: 'flex-start', position: 'relative', zIndex: 1 }}>
                <div style={{ width: 38, height: 38, borderRadius: '50%', flexShrink: 0, background: `${col}15`, border: `2px solid ${col}40`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 17, color: col }}>{ico}</span>
                </div>
                <div style={{ flex: 1, paddingTop: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 2 }}>
                    {isStage && ev.from_stage && ev.to_stage ? (
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)' }}>
                        Stage moved: <StagePill stage={ev.from_stage} size="sm" /> to <StagePill stage={ev.to_stage} size="sm" />
                      </span>
                    ) : (
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)', textTransform: 'capitalize' }}>
                        {ev.event_type.replace(/_/g, ' ')}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    {ev.actor_name && <span style={{ fontSize: 12, color: 'var(--txt2)', fontWeight: 500 }}>{ev.actor_name}</span>}
                    <span style={{ fontSize: 11.5, color: 'var(--txt3)' }}>{fmtDatetime(ev.created_at)}</span>
                  </div>
                  {ev.notes && (
                    <div style={{ marginTop: 6, padding: '8px 12px', borderRadius: 7, background: 'var(--th-bg)', border: '1px solid var(--bdr)', fontSize: 12.5, color: 'var(--txt2)', lineHeight: 1.55 }}>
                      {ev.notes}
                    </div>
                  )}
                </div>
              </div>
            )
          }

          const note = f.item as AppNote
          return (
            <div key={`n-${note.id}`} style={{ display: 'flex', gap: 14, padding: '14px 0', alignItems: 'flex-start', position: 'relative', zIndex: 1 }}>
              <div style={{ width: 38, height: 38, borderRadius: '50%', flexShrink: 0, background: 'var(--th-bg)', border: '2px solid var(--bdr)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 16, color: note.is_internal ? AMBER : 'var(--txt2)' }}>
                  {note.is_internal ? 'lock' : 'sticky_note_2'}
                </span>
              </div>
              <div style={{ flex: 1, paddingTop: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt)' }}>Note</span>
                  {note.is_internal && (
                    <span style={{ fontSize: 10.5, fontWeight: 600, padding: '1px 7px', borderRadius: 10, background: 'rgba(217,119,6,.12)', color: AMBER }}>Internal</span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 6 }}>
                  {note.author_name && <span style={{ fontSize: 12, color: 'var(--txt2)', fontWeight: 500 }}>{note.author_name}</span>}
                  <span style={{ fontSize: 11.5, color: 'var(--txt3)' }}>{fmtDatetime(note.created_at)}</span>
                </div>
                <div style={{ padding: '8px 12px', borderRadius: 7, background: 'var(--th-bg)', border: '1px solid var(--bdr)', fontSize: 12.5, color: 'var(--txt)', lineHeight: 1.55 }}>
                  {note.body}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </SectionCard>
  )
}

// ── Approval Chain Tab ────────────────────────────────────────────────────────

function ApprovalChainTab({ app, events }: { app: Application; events: AppEvent[] }) {
  const currentIdx = STAGE_ORDER.indexOf(app.stage)
  const declined   = app.stage === 'declined'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {declined && app.decline_reason && (
        <div style={{ display: 'flex', gap: 10, padding: '12px 16px', borderRadius: 10, background: 'rgba(192,0,0,.06)', border: '1px solid rgba(192,0,0,.2)' }}>
          <span className="material-symbols-rounded" style={{ color: RED, fontSize: 18, flexShrink: 0 }}>cancel</span>
          <div><div style={{ fontSize: 13, fontWeight: 700, color: RED }}>Application Declined</div><div style={{ fontSize: 13, color: 'var(--txt)', marginTop: 2 }}>{app.decline_reason}</div></div>
        </div>
      )}

      <SectionCard padding={false}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {APPROVAL_CHAIN.map((entry, i) => {
            const entryIdx  = STAGE_ORDER.indexOf(entry.stage)
            const done      = entryIdx <= currentIdx && !declined
            const active    = entry.stage === app.stage
            const ev        = events.find(e => e.to_stage === entry.stage)
            const prevEv    = events.find(e => e.from_stage === entry.stage)
            const duration  = ev && prevEv
              ? Math.round((new Date(prevEv.created_at).getTime() - new Date(ev.created_at).getTime()) / 60000)
              : null

            return (
              <div key={entry.stage} style={{ display: 'grid', gridTemplateColumns: '44px 1fr auto', gap: 14, padding: '16px 20px', borderBottom: i < APPROVAL_CHAIN.length - 1 ? '1px solid var(--bdr)' : undefined, alignItems: 'flex-start' }}>
                {/* Status icon */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <div style={{ width: 36, height: 36, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: declined ? 'rgba(192,0,0,.08)' : done ? (active ? `${NAVY}12` : 'rgba(22,163,74,.1)') : 'var(--chip-bg)', border: `2px solid ${declined ? RED : done ? (active ? NAVY : GREEN) : 'var(--bdr)'}` }}>
                    {done && !active && !declined
                      ? <span className="material-symbols-rounded" style={{ fontSize: 17, color: GREEN }}>check</span>
                      : active && !declined
                      ? <span style={{ width: 10, height: 10, borderRadius: '50%', background: NAVY, display: 'block' }} />
                      : declined && entryIdx <= currentIdx
                      ? <span className="material-symbols-rounded" style={{ fontSize: 17, color: RED }}>close</span>
                      : <span style={{ ...NUM, fontSize: 11, fontWeight: 700, color: 'var(--txt3)' }}>{i + 1}</span>
                    }
                  </div>
                  {i < APPROVAL_CHAIN.length - 1 && (
                    <div style={{ width: 2, height: 20, background: done && !active ? GREEN : 'var(--bdr)' }} />
                  )}
                </div>

                {/* Content */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: active ? NAVY : done ? 'var(--txt)' : 'var(--txt2)' }}>{entry.label}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--txt3)', fontStyle: 'italic' }}>{stageMeta(entry.stage).owner}</span>
                  </div>
                  {ev && (
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      {/* Who acted, and from where. A trail that says "offer
                          accepted" without saying whether the CUSTOMER accepted it
                          or an operator recorded it on their behalf is not an audit
                          trail. The icon separates the sources at a glance. */}
                      {ev.actor_name && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--txt2)', fontWeight: 500 }}>
                          <span className="material-symbols-rounded" style={{ fontSize: 13 }}>
                            {ev.actor_source === 'customer' ? 'account_circle'
                              : ev.actor_source === 'system' ? 'schedule'
                                : ev.actor_source === 'phoenix' ? 'hub'
                                  : 'person'}
                          </span>
                          {ev.actor_name}
                        </span>
                      )}
                      {ev.actor_source && ev.actor_source !== 'workspace' && (
                        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', padding: '2px 7px', borderRadius: 5, background: 'var(--chip-bg)', color: 'var(--txt3)' }}>
                          {ev.actor_source === 'system' ? 'automated' : ev.actor_source}
                        </span>
                      )}
                      <span style={{ fontSize: 12, color: 'var(--txt3)' }}>{fmtDatetime(ev.created_at)}</span>
                      {duration !== null && duration > 0 && (
                        <span style={{ fontSize: 11.5, color: 'var(--txt3)' }}>· {duration < 60 ? `${duration}m` : `${Math.round(duration / 60)}h`} at this stage</span>
                      )}
                    </div>
                  )}
                  {ev?.notes && (
                    <div style={{ marginTop: 6, padding: '7px 11px', borderRadius: 6, background: 'var(--th-bg)', border: '1px solid var(--bdr)', fontSize: 12, color: 'var(--txt2)', lineHeight: 1.5 }}>
                      {ev.notes}
                    </div>
                  )}
                </div>

                {/* Status badge */}
                <div style={{ paddingTop: 8 }}>
                  {declined && entryIdx >= currentIdx
                    ? <span style={{ ...NUM, fontSize: 11, fontWeight: 700, color: RED }}>—</span>
                    : done && !active
                    ? <span style={{ ...NUM, fontSize: 11, fontWeight: 700, color: GREEN }}>Done</span>
                    : active
                    ? <span style={{ ...NUM, fontSize: 11, fontWeight: 700, color: NAVY }}>In Progress</span>
                    : <span style={{ ...NUM, fontSize: 11, fontWeight: 700, color: 'var(--txt3)' }}>Pending</span>
                  }
                </div>
              </div>
            )
          })}
        </div>
      </SectionCard>
    </div>
  )
}

// ── Eye Report Tab ────────────────────────────────────────────────────────────

const OUTCOME_META = {
  approve: { label: 'Application Approved',  color: GREEN,  icon: 'check_circle'   },
  refer:   { label: 'Referred for Review',   color: AMBER,  icon: 'warning'         },
  decline: { label: 'Application Declined',  color: RED,    icon: 'cancel'          },
} as const

const EYE_BAND_COLORS: Record<string, string> = {
  low:       GREEN,
  medium:    AMBER,
  high:      RED,
  very_high: '#9B1C1C',
}

const AFFORD_META: Record<string, { label: string; color: string }> = {
  comfortable: { label: 'Comfortable', color: GREEN },
  adequate:    { label: 'Adequate',    color: AMBER },
  stressed:    { label: 'Stressed',    color: RED   },
}

function MetricCell({ label, value, color = 'var(--txt)' }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{label}</span>
      <span style={{ ...NUM, fontSize: 14, fontWeight: 700, color }}>{value}</span>
    </div>
  )
}

function EyeTab({ app }: { app: Application }) {
  const [cfData,    setCfData]    = useState<CreditFileData | null>(null)
  const [cfLoading, setCfLoading] = useState(false)
  const [report,    setReport]    = useState<EyeReport | null>(null)
  const [eyeLoading,setEyeLoading]= useState(true)
  const [eyeError,  setEyeError]  = useState<string | null>(null)

  useEffect(() => {
    if (!app.applicant_cif) return
    apiFetch<{ data: CreditFileData }>(`/api/risk/credit-file/${app.applicant_cif}`)
      .then(r => setCfData((r as any).data ?? null))
      .catch(() => {})
  }, [app.applicant_cif])

  useEffect(() => {
    setEyeLoading(true); setEyeError(null)
    apiFetch<EyeReport>(`/api/los/${app.id}/eye-report`)
      .then(r => setReport(r))
      .catch(e => setEyeError(e.message ?? 'Failed to load Eye report'))
      .finally(() => setEyeLoading(false))
  }, [app.id])

  const score      = app.eye_score
  const rating     = app.eye_rating
  const scoreColor = score === null ? 'var(--txt3)' : score >= 700 ? GREEN : score >= 500 ? AMBER : RED

  const monthlyRepayment = (app.tenor_months && app.amount_requested_kobo)
    ? Math.round(app.amount_requested_kobo / app.tenor_months * (1 + (app.interest_rate_bps ?? 0) / 10000))
    : 0
  const dtiPct   = dtiOf(app.dti_pct)
  const dtiColor = dtiPct === null ? 'var(--txt2)' : dtiPct > 50 ? RED : dtiPct > 33 ? AMBER : GREEN
  const netAfter = (app.monthly_income_kobo && monthlyRepayment) ? app.monthly_income_kobo - monthlyRepayment : null

  const shapData = (report?.reasons ?? []).map(r => ({
    name:  r.human_readable,
    value: r.magnitude,
    fill:  r.direction === 'positive' ? GREEN : RED,
    dir:   r.direction,
  }))

  const outcomeMeta  = report?.outcome ? OUTCOME_META[report.outcome] : null
  const affordMeta   = report?.affordability ? AFFORD_META[report.affordability] : null
  const bandColor    = report?.risk_band ? (EYE_BAND_COLORS[report.risk_band] ?? 'var(--txt2)') : 'var(--txt2)'
  const dcafo        = report?.dcafo ?? null
  const dcafoColor   = dcafo === null ? 'var(--txt2)' : dcafo >= 1.5 ? GREEN : dcafo >= 1.0 ? AMBER : RED

  const bureau  = report?.enriched_bureau   ?? null
  const openBk  = report?.enriched_open_banking ?? null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── Score Hero (O3C stored data) ───────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', borderRadius: 12, background: 'var(--card)', border: '1px solid var(--card-bdr)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '28px 20px', borderRight: '1px solid var(--bdr)', background: score !== null ? `${scoreColor}06` : 'var(--th-bg)' }}>
          <div style={{ ...NUM, fontSize: 68, fontWeight: 900, color: scoreColor, lineHeight: 1 }}>{score ?? '—'}</div>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Eye Score</div>
          {rating && (
            <span style={{ fontSize: 13, fontWeight: 700, padding: '4px 14px', borderRadius: 20, background: `${RATING_COLORS[rating] ?? 'var(--txt2)'}18`, color: RATING_COLORS[rating] ?? 'var(--txt2)' }}>
              {rating}
            </span>
          )}
          {score === null && (
            <span style={{ fontSize: 11.5, fontWeight: 600, padding: '3px 10px', borderRadius: 20, background: 'rgba(217,119,6,.12)', color: AMBER }}>Not assessed</span>
          )}
          {score !== null && (
            <div style={{ width: '80%', marginTop: 8 }}>
              <div style={{ position: 'relative', height: 8, borderRadius: 4, background: 'var(--bdr)', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${(score / 850) * 100}%`, borderRadius: 4, background: `linear-gradient(90deg, ${RED}, ${AMBER}, ${GREEN})` }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
                <span style={{ fontSize: 9, color: 'var(--txt3)' }}>0</span>
                <span style={{ fontSize: 9, color: 'var(--txt3)' }}>850</span>
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16 }}>
            <MetricCell label="Monthly Income"         value={app.monthly_income_kobo ? fmtKobo(app.monthly_income_kobo) : '—'} />
            <MetricCell label="Monthly Obligations"    value={app.monthly_obligation_kobo ? fmtKobo(app.monthly_obligation_kobo) : '—'} />
            <MetricCell label="Est. Monthly Repayment" value={monthlyRepayment ? fmtKobo(monthlyRepayment) : '—'} />
            <MetricCell label="Net After Deduction"    value={netAfter !== null ? fmtKobo(netAfter) : '—'} color={netAfter !== null ? (netAfter > 0 ? GREEN : RED) : 'var(--txt)'} />
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>Debt-to-Income Ratio</span>
              <span style={{ ...NUM, fontSize: 16, fontWeight: 800, color: dtiColor }}>{dtiPct !== null ? `${dtiPct.toFixed(1)}%` : '—'}</span>
            </div>
            <div style={{ position: 'relative', height: 10, borderRadius: 5, background: 'var(--bdr)', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: dtiPct !== null ? `${Math.min(dtiPct, 100)}%` : '0%', borderRadius: 5, background: dtiColor, transition: 'width 0.6s ease' }} />
              <div style={{ position: 'absolute', left: '33%', top: 0, bottom: 0, width: 2, background: 'rgba(255,255,255,.6)' }} />
              <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 2, background: 'rgba(255,255,255,.6)' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-around', marginTop: 4 }}>
              {[['0–33%', GREEN, 'Good'], ['33–50%', AMBER, 'Caution'], ['50%+', RED, 'High Risk']].map(([r, c, l]) => (
                <span key={r} style={{ fontSize: 10, color: c as string, fontWeight: 600 }}>{r} {l}</span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Full Eye / Veyonra Report ──────────────────────────────────── */}
      {eyeLoading && (
        <SectionCard title="Eye / Veyonra Report"><Sk h={200} /></SectionCard>
      )}

      {eyeError && !eyeLoading && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 18px', borderRadius: 10, background: `${RED}08`, border: `1px solid ${RED}20` }}>
          <span className="material-symbols-rounded" style={{ fontSize: 20, color: RED, flexShrink: 0, marginTop: 1 }}>error</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: RED }}>Eye Service Unavailable</div>
            <div style={{ fontSize: 12, color: 'var(--txt2)', marginTop: 2 }}>{eyeError}</div>
          </div>
        </div>
      )}

      {report && !eyeLoading && (
        <>
          {/* Outcome Banner */}
          {outcomeMeta && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px', borderRadius: 12, background: `${outcomeMeta.color}10`, border: `1px solid ${outcomeMeta.color}30` }}>
              <span className="material-symbols-rounded" style={{ fontSize: 28, color: outcomeMeta.color, flexShrink: 0 }}>{outcomeMeta.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: outcomeMeta.color }}>{outcomeMeta.label}</div>
                {report.decline_reason && (
                  <div style={{ fontSize: 12, color: 'var(--txt2)', marginTop: 2 }}>{report.decline_reason}</div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 20, flexShrink: 0 }}>
                {report.pd !== null && (
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ ...NUM, fontSize: 18, fontWeight: 800, color: outcomeMeta.color }}>{(report.pd * 100).toFixed(2)}%</div>
                    <div style={{ fontSize: 10, color: 'var(--txt3)', fontWeight: 600 }}>PD</div>
                  </div>
                )}
                {report.risk_band && (
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: bandColor, textTransform: 'capitalize' }}>{report.risk_band.replace('_', ' ')}</div>
                    <div style={{ fontSize: 10, color: 'var(--txt3)', fontWeight: 600 }}>Risk Band</div>
                  </div>
                )}
                {report.model_version && (
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--txt2)', fontFamily: 'monospace' }}>{report.model_version}</div>
                    <div style={{ fontSize: 10, color: 'var(--txt3)', fontWeight: 600 }}>Model</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* SHAP Decision Factors */}
          {shapData.length > 0 && (
            <SectionCard title="Decision Factors">
              <div style={{ paddingTop: 8 }}>
                <div style={{ display: 'flex', gap: 20, marginBottom: 10, fontSize: 11, color: 'var(--txt2)' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: GREEN, display: 'inline-block' }} />Positive influence
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: RED, display: 'inline-block' }} />Negative influence
                  </span>
                </div>
                <EBarH
                  data={shapData}
                  catKey="name"
                  height={shapData.length * 56 + 24}
                  legend={false}
                  valueFmt={(v) => Number(v).toFixed(4)}
                  series={[{ key: 'value', name: 'Impact', colorFn: (d) => d.fill }]}
                />
              </div>
            </SectionCard>
          )}

          {/* Affordability + LGD/EL side by side */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

            {/* Affordability */}
            <div style={{ borderRadius: 10, background: 'var(--card)', border: '1px solid var(--card-bdr)', padding: '18px 20px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 14 }}>Affordability</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
                <span style={{ ...NUM, fontSize: 36, fontWeight: 900, color: dcafoColor, lineHeight: 1 }}>
                  {dcafo !== null ? `${dcafo.toFixed(2)}×` : '—'}
                </span>
                <span style={{ fontSize: 11, color: 'var(--txt3)', fontWeight: 600 }}>DCAFO ratio</span>
              </div>
              {/* DCAFO bar — 1.0 is breakeven */}
              {dcafo !== null && (
                <div style={{ marginTop: 8, marginBottom: 10 }}>
                  <div style={{ position: 'relative', height: 8, borderRadius: 4, background: 'var(--bdr)', overflow: 'hidden' }}>
                    <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${Math.min((dcafo / 2) * 100, 100)}%`, borderRadius: 4, background: dcafoColor, transition: 'width .5s ease' }} />
                    {/* 1.0 line */}
                    <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 2, background: 'rgba(255,255,255,.7)' }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
                    <span style={{ fontSize: 9, color: 'var(--txt3)' }}>0</span>
                    <span style={{ fontSize: 9, color: 'var(--txt2)', fontWeight: 600 }}>1.0 breakeven</span>
                    <span style={{ fontSize: 9, color: 'var(--txt3)' }}>2+</span>
                  </div>
                </div>
              )}
              {affordMeta && (
                <span style={{ fontSize: 12.5, fontWeight: 700, padding: '3px 12px', borderRadius: 20, background: `${affordMeta.color}15`, color: affordMeta.color }}>
                  {affordMeta.label}
                </span>
              )}
              {report.residual_monthly_cash_ngn !== null && (
                <div style={{ marginTop: 10 }}>
                  <MetricCell label="Residual Monthly Cash" value={`₦${(report.residual_monthly_cash_ngn / 100).toLocaleString('en-NG', { minimumFractionDigits: 0 })}`} color={report.residual_monthly_cash_ngn > 0 ? GREEN : RED} />
                </div>
              )}
            </div>

            {/* LGD / Expected Loss */}
            <div style={{ borderRadius: 10, background: 'var(--card)', border: '1px solid var(--card-bdr)', padding: '18px 20px' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 14 }}>Loss Estimation</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {report.lgd !== null && (
                  <MetricCell label="Loss Given Default (LGD)" value={`${(report.lgd * 100).toFixed(1)}%`} color={report.lgd > 0.6 ? RED : report.lgd > 0.4 ? AMBER : GREEN} />
                )}
                {report.expected_loss_kobo !== null && (
                  <MetricCell label="Expected Loss" value={fmtKobo(report.expected_loss_kobo)} color={RED} />
                )}
                {report.expected_loss_pct !== null && (
                  <MetricCell label="EL as % of Loan" value={`${(report.expected_loss_pct * 100).toFixed(2)}%`} color={RED} />
                )}
                {report.fair_monthly_rate !== null && (
                  <MetricCell label="Fair Monthly Rate" value={`${(report.fair_monthly_rate * 100).toFixed(2)}%`} />
                )}
              </div>
            </div>
          </div>

          {/* Limit Comparison */}
          {(report.predicted_loc || report.assigned_limit) && (
            <SectionCard title="Credit Limit">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
                {report.predicted_loc !== null && (
                  <MetricCell label="Predicted LOC" value={fmtKobo(report.predicted_loc)} color={BLUE} />
                )}
                {report.assigned_limit !== null && (
                  <MetricCell label="Assigned Limit" value={fmtKobo(report.assigned_limit)} color={GREEN} />
                )}
                {report.cap_applied && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, justifyContent: 'center' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20, background: `${AMBER}15`, color: AMBER, width: 'fit-content' }}>Cap Applied</span>
                    <span style={{ fontSize: 11, color: 'var(--txt2)' }}>Limit was capped below predicted LOC by policy</span>
                  </div>
                )}
              </div>
              {report.predicted_loc !== null && report.assigned_limit !== null && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ position: 'relative', height: 10, borderRadius: 5, background: 'var(--bdr)', overflow: 'hidden' }}>
                    <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${Math.min((report.assigned_limit / report.predicted_loc) * 100, 100)}%`, borderRadius: 5, background: GREEN }} />
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--txt3)', marginTop: 3 }}>
                    Assigned is {((report.assigned_limit / report.predicted_loc) * 100).toFixed(0)}% of predicted
                  </div>
                </div>
              )}
            </SectionCard>
          )}

          {/* Enriched Bureau */}
          {bureau && Object.keys(bureau).length > 0 && (
            <SectionCard title="Enriched Bureau Data">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
                {bureau.total_accounts    != null && <MetricCell label="Total Accounts"       value={String(bureau.total_accounts)} />}
                {bureau.active_loans      != null && <MetricCell label="Active Loans"         value={String(bureau.active_loans)} />}
                {bureau.delinquent_accounts != null && <MetricCell label="Delinquent Accounts" value={String(bureau.delinquent_accounts)} color={bureau.delinquent_accounts > 0 ? RED : GREEN} />}
                {bureau.payment_history_rate != null && <MetricCell label="Payment History" value={`${(bureau.payment_history_rate * 100).toFixed(0)}%`} color={bureau.payment_history_rate >= 0.9 ? GREEN : bureau.payment_history_rate >= 0.7 ? AMBER : RED} />}
                {bureau.max_overdue_days  != null && <MetricCell label="Max Overdue Days"     value={`${bureau.max_overdue_days}d`} color={bureau.max_overdue_days > 90 ? RED : bureau.max_overdue_days > 30 ? AMBER : GREEN} />}
                {bureau.total_outstanding != null && <MetricCell label="Total Outstanding"    value={fmtKobo(bureau.total_outstanding)} />}
              </div>
            </SectionCard>
          )}

          {/* Enriched Open Banking */}
          {openBk && Object.keys(openBk).length > 0 && (
            <SectionCard title="Open Banking Signals">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
                {openBk.avg_monthly_inflow  != null && <MetricCell label="Avg Monthly Inflow"  value={fmtKobo(openBk.avg_monthly_inflow)}  color={GREEN} />}
                {openBk.avg_monthly_outflow != null && <MetricCell label="Avg Monthly Outflow" value={fmtKobo(openBk.avg_monthly_outflow)} />}
                {openBk.salary_detected     != null && <MetricCell label="Salary Detected"     value={openBk.salary_detected ? 'Yes' : 'No'} color={openBk.salary_detected ? GREEN : AMBER} />}
                {openBk.bounce_count        != null && <MetricCell label="Bounce Count"        value={String(openBk.bounce_count)} color={openBk.bounce_count > 3 ? RED : openBk.bounce_count > 0 ? AMBER : GREEN} />}
                {openBk.income_stability    != null && <MetricCell label="Income Stability"    value={String(openBk.income_stability)} />}
              </div>
            </SectionCard>
          )}

          {/* Adverse Action Notice */}
          {report.outcome === 'decline' && report.adverse_action_notice?.reasons && report.adverse_action_notice.reasons.length > 0 && (
            <div style={{ padding: '16px 18px', borderRadius: 10, background: `${RED}07`, border: `1px solid ${RED}25` }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: RED, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.4px' }}>Adverse Action Notice</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {report.adverse_action_notice.reasons.map((r: string, i: number) => (
                  <li key={i} style={{ fontSize: 13, color: 'var(--txt)', marginBottom: 4, lineHeight: 1.5 }}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {/* ── Bureau Summary (O3C stored) ────────────────────────────────── */}
      {app.bureau_summary && (
        <SectionCard title="Bureau Summary">
          <div style={{ fontSize: 13.5, color: 'var(--txt)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{app.bureau_summary}</div>
        </SectionCard>
      )}

      {/* ── Credit History (from risk endpoint) ───────────────────────── */}
      {cfLoading && <SectionCard title="Credit History"><Sk h={80} /></SectionCard>}
      {cfData && !cfLoading && (
        <SectionCard title="Credit History">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
            <MetricCell label="Outstanding Balance" value={fmtKobo(cfData.outstanding_kobo)} color={cfData.outstanding_kobo > 0 ? AMBER : 'var(--txt)'} />
            <MetricCell label="Days Past Due (DPD)" value={`${cfData.dpd ?? 0} days`}        color={cfData.dpd > 0 ? (cfData.dpd >= 90 ? RED : AMBER) : GREEN} />
            <MetricCell label="Amount Disbursed"    value={fmtKobo(cfData.amount_approved_kobo || cfData.amount_requested_kobo)} />
            <MetricCell label="Loan Tenor"          value={cfData.tenor_months ? `${cfData.tenor_months} months` : '—'} />
            <MetricCell label="Interest Rate"       value={cfData.tenor_months ? `${((app.interest_rate_bps ?? 0) / 100).toFixed(2)}% p.a.` : '—'} />
            <MetricCell label="Employer"            value={cfData.employer || '—'} />
          </div>
        </SectionCard>
      )}
    </div>
  )
}

// ── Main ApplicationDetail ────────────────────────────────────────────────────

// ── Customer credit portfolio (running credit booked on the CBS, no LOS application) ──

interface PortfolioLoan {
  account_number: string; reference_number: string | null; product_name: string; status: string
  loan_amount_kobo: number; outstanding_principal_kobo: number; total_outstanding_kobo: number
  interest_rate: number | null; tenor_days: number | null; installment_amount_kobo: number | null
  start_date: string | null; approved_date: string | null; maturity_date: string | null
  officer_name: string | null; branch_name: string | null; economic_sector: string | null; dpd: number
}
interface PortfolioData {
  cif: string
  customer: { name?: string; phone?: string; email?: string; state?: string; city?: string; full_address?: string | null }
  loans: PortfolioLoan[]
  summary: { loan_count: number; open_count: number; total_outstanding_kobo: number; total_disbursed_kobo: number; worst_dpd: number }
}

const LOAN_STATUS_COLOR: Record<string, string> = {
  active: GREEN, performing: GREEN, defaulting: RED, expired: AMBER, closed: '#6B7280', revoked: '#6B7280',
}

function PLV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium }}>{value ?? '—'}</div>
    </div>
  )
}

function CustomerCreditPortfolio({ cif }: { cif: string }) {
  const navigate = useNavigate()
  const [data, setData]       = useState<PortfolioData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    setLoading(true); setError(null)
    apiFetch<{ data: PortfolioData }>(`/api/los/portfolio/${encodeURIComponent(cif)}`)
      .then(r => setData(r.data))
      .catch(e => setError(e.message ?? 'Failed to load portfolio'))
      .finally(() => setLoading(false))
  }, [cif])

  const backBtn = (
    <button onClick={() => navigate('/operations/risk/portfolio')} style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: RADIUS.md,
      border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', fontSize: TEXT.sm, cursor: 'pointer',
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: 16 }}>arrow_back</span>
      Loan Portfolio
    </button>
  )

  if (loading) return <Page title="Credit Portfolio" actions={backBtn}><div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div></Page>
  if (error || !data) return <Page title="Credit Portfolio" actions={backBtn}><ErrBanner error={error ?? 'Not found'} /></Page>

  const c = data.customer ?? {}
  const s = data.summary
  const name = c.name || cif

  return (
    <Page title={name} subtitle={`Running credit portfolio · CIF ${cif}`} actions={backBtn}>
      {/* Customer header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: SP[4], marginBottom: SP[3],
        padding: SP[4], borderRadius: RADIUS.lg,
        background: 'linear-gradient(135deg, var(--card) 0%, var(--th-bg) 100%)', border: '1px solid var(--bdr)',
      }}>
        <div style={{
          width: 54, height: 54, borderRadius: '50%', flexShrink: 0, background: `${NAVY}14`, color: NAVY,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: FW.bold,
        }}>{name.charAt(0).toUpperCase()}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
            <span style={{ fontSize: 20, fontWeight: FW.bold, color: 'var(--txt)' }}>{name}</span>
            <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: PURPLE, background: `${PURPLE}18`, padding: '2px 9px', borderRadius: RADIUS['2xl'] }}>RUNNING CREDIT</span>
          </div>
          <div style={{ display: 'flex', gap: SP[4], flexWrap: 'wrap', alignItems: 'center', fontSize: TEXT.sm, color: 'var(--txt2)' }}>
            <span>CIF <strong style={{ ...NUM, color: 'var(--txt)' }}>{cif}</strong></span>
            {c.phone && <a href={`tel:${c.phone}`} style={{ color: NAVY, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: FW.medium }}><span className="material-symbols-rounded" style={{ fontSize: 15 }}>call</span>{c.phone}</a>}
            {c.email && <a href={`mailto:${c.email}`} style={{ color: NAVY, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: FW.medium }}><span className="material-symbols-rounded" style={{ fontSize: 15 }}>mail</span>{c.email}</a>}
            {(c.city || c.state) && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span className="material-symbols-rounded" style={{ fontSize: 15 }}>location_on</span>{[c.city, c.state].filter(Boolean).join(', ')}</span>}
          </div>
        </div>
        <button onClick={() => navigate(`/customers/${encodeURIComponent(cif)}`)} style={{
          padding: '6px 14px', borderRadius: RADIUS.md, border: `1px solid ${NAVY}30`, background: `${NAVY}08`,
          color: NAVY, fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
        }}>Customer 360</button>
      </div>

      {/* Summary KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: SP[3], marginBottom: SP[5] }}>
        <KpiCard label="Total Outstanding" value={fmtKobo(s.total_outstanding_kobo)} icon="account_balance_wallet" accent={s.total_outstanding_kobo > 0 ? RED : GREEN} />
        <KpiCard label="Open Loans" value={`${fmtNum(s.open_count)} / ${fmtNum(s.loan_count)}`} sub="open / total" icon="account_balance" accent={NAVY} />
        <KpiCard label="Worst DPD" value={s.worst_dpd > 0 ? `${fmtNum(s.worst_dpd)} days` : 'Current'} icon="event_busy" accent={s.worst_dpd > 90 ? RED : s.worst_dpd > 0 ? AMBER : GREEN} />
        <KpiCard label="Total Disbursed" value={fmtKobo(s.total_disbursed_kobo)} icon="payments" accent={BLUE} />
      </div>

      {/* Loans */}
      <SectionCard title="Facilities" subtitle="Running and closed credit on the core banking book" badge={data.loans.length} padding={false}>
        {data.loans.length === 0 ? (
          <div style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>
            No credit facilities on the core banking book for this customer.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {data.loans.map((l, i) => {
              const sc = LOAN_STATUS_COLOR[String(l.status).toLowerCase()] ?? NAVY
              return (
                <div key={l.reference_number || l.account_number || i} style={{ padding: '16px 20px', borderTop: i === 0 ? 'none' : '1px solid var(--bdr)' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                        <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>{l.product_name || 'Loan'}</span>
                        <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: sc, background: `${sc}18`, padding: '2px 8px', borderRadius: RADIUS['2xl'] }}>{l.status}</span>
                        {l.dpd > 0 && <span style={{ ...NUM, fontSize: TEXT['2xs'], fontWeight: FW.bold, color: RED, background: `${RED}12`, padding: '2px 8px', borderRadius: RADIUS['2xl'] }}>{fmtNum(l.dpd)} DPD</span>}
                      </div>
                      <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>{l.reference_number || l.account_number}{l.branch_name ? ` · ${l.branch_name}` : ''}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.extrabold, color: sc, letterSpacing: '-0.4px' }}>{fmtKobo(l.total_outstanding_kobo)}</div>
                      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>outstanding</div>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
                    <PLV label="Disbursed" value={<span style={NUM}>{fmtKobo(l.loan_amount_kobo)}</span>} />
                    <PLV label="Principal Out." value={<span style={NUM}>{fmtKobo(l.outstanding_principal_kobo)}</span>} />
                    <PLV label="Installment" value={l.installment_amount_kobo != null ? <span style={NUM}>{fmtKobo(l.installment_amount_kobo)}</span> : '—'} />
                    <PLV label="Interest Rate" value={l.interest_rate != null ? `${l.interest_rate}%` : '—'} />
                    <PLV label="Disbursed On" value={l.start_date ? fmtDate(l.start_date) : '—'} />
                    <PLV label="Maturity" value={l.maturity_date ? fmtDate(l.maturity_date) : '—'} />
                    <PLV label="Officer" value={l.officer_name || '—'} />
                    <PLV label="Sector" value={l.economic_sector || '—'} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SectionCard>
    </Page>
  )
}

export default function ApplicationDetail() {
  const { id, cif } = useParams<{ id?: string; cif?: string }>()
  const navigate = useNavigate()

  const [data,    setData]    = useState<DetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [subTab,  setSubTab]  = useState<'overview' | 'timeline' | 'approval' | 'eye' | 'report'>('overview')

  const userObj      = (() => { try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}') } catch { return {} } })()
  const userRole     = userObj?.role ?? ''
  const roleKey      = userRole.toLowerCase()
  // Compliance is a read-only oversight overlay regardless of stage. Every other view
  // is chosen by the application's stage group (below), not the viewer's job title —
  // the action bar is gated separately by page, so a viewer only ever sees the moves
  // they can actually make.
  const isCompliance = roleKey.includes('compliance')

  const [advanceOpen,   setAdvanceOpen]   = useState(false)
  const [declineOpen,   setDeclineOpen]   = useState(false)
  const [reqInfoOpen,   setReqInfoOpen]   = useState(false)
  const [showCreditFile,setShowCreditFile]= useState(false)

  const [toStage,       setToStage]       = useState('')
  const [advanceNotes,  setAdvanceNotes]  = useState('')
  const [declineReason, setDeclineReason] = useState('')
  const [reqInfoNotes,  setReqInfoNotes]  = useState('')
  const [actionLoading, setActionLoading] = useState(false)

  const load = useCallback(async (silent = false) => {
    if (!id) return
    if (!silent) setLoading(true); setError(null)
    try {
      const res = await apiFetch<{ data: DetailData }>(`/api/los/${id}`)
      setData(res.data)
    } catch (e: any) { setError(e.message ?? 'Failed to load') }
    finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['loans'] })

  async function doAdvance() {
    if (!toStage) { toast.error('Select a target stage'); return }
    setActionLoading(true)
    try {
      await apiPut(`/api/los/${id}/advance`, { to_stage: toStage, notes: advanceNotes })
      toast.success('Stage advanced')
      setAdvanceOpen(false); setToStage(''); setAdvanceNotes('')
      load()
    } catch (e: any) { toast.error(e.message ?? 'Advance failed') }
    finally { setActionLoading(false) }
  }

  async function doDecline() {
    if (!declineReason.trim()) { toast.error('Reason is required'); return }
    setActionLoading(true)
    try {
      await apiPut(`/api/los/${id}/decline`, { reason: declineReason })
      toast.success('Application declined')
      setDeclineOpen(false); setDeclineReason('')
      load()
    } catch (e: any) { toast.error(e.message ?? 'Decline failed') }
    finally { setActionLoading(false) }
  }

  async function doReqInfo() {
    setActionLoading(true)
    try {
      await apiPut(`/api/los/${id}/request-info`, { notes: reqInfoNotes })
      toast.success('Sent back for more information')
      setReqInfoOpen(false); setReqInfoNotes('')
      load()
    } catch (e: any) { toast.error(e.message ?? 'Failed') }
    finally { setActionLoading(false) }
  }

  function openAdvance(stage: string) { setToStage(stage); setAdvanceOpen(true) }

  // Portfolio mode: reached by CIF from the Loan Portfolio for a customer whose credit is
  // booked directly on the CBS (no workspace application). Show their running-credit
  // portfolio instead of the application workflow (and instead of a "not found" error).
  if (cif) return <CustomerCreditPortfolio cif={cif} />

  if (loading && !data) {
    return (
      <Page title="Application" subtitle="Loading…">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Sk h={64} /><Sk h={200} /><Sk h={300} />
        </div>
      </Page>
    )
  }

  if (error) {
    return (
      <Page title="Application" subtitle="Error">
        <div style={{ padding: '14px 18px', borderRadius: 10, background: 'rgba(192,0,0,0.08)', border: '1px solid rgba(192,0,0,0.2)', fontSize: 13, color: RED }}>
          {error}. <button onClick={() => load()} style={{ textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 'inherit' }}>Retry</button>
        </div>
      </Page>
    )
  }

  if (!data) return null

  const app        = data.application
  const events     = data.events     ?? []
  const conditions = data.conditions ?? []

  const nextStages = ALLOWED_TRANSITIONS[app.stage] ?? []

  // View = f(audience), falling back to f(stage group).
  //
  // It used to be stage alone, and that quietly made the Sales view unreachable for
  // most of an application's life: the moment a file left document collection its
  // group became 'risk', so a sales officer opening THEIR OWN application from
  // Sales → Applications was shown the credit assessment instead of the
  // origination record. Sales still owns the customer relationship after hand-off
  // — they chase the documents and conditions and explain the outcome — so the
  // desk you opened the file from decides the layout, not the desk that currently
  // holds it.
  //
  // Routes that belong to one audience say so. Anywhere else (/applications/:id,
  // My Approvals) keeps the original stage-driven behaviour, which is right for a
  // shared queue where the stage IS the context.
  const { pathname } = useLocation()
  const audience: 'sales' | 'risk' | null =
    pathname.startsWith('/sales/') ? 'sales'
      : pathname.startsWith('/operations/risk/') ? 'risk'
        : null

  const grp = stageMeta(app.stage).group
  const showRisk = !isCompliance && (audience === 'risk' || (audience === null && grp === 'risk'))
  const showFinance = !isCompliance && audience === null &&
    (grp === 'finance' || grp === 'ops' || (grp === 'terminal' && app.stage === 'active'))

  return (
    <Page
      title={app.reference || `APP-${app.id}`}
      subtitle={app.applicant_name}
      actions={
        <button onClick={() => navigate(-1)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', background: 'var(--card)', color: 'var(--txt)', border: '1px solid var(--bdr)', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>arrow_back</span>Back
        </button>
      }
    >
        {/* Sub-page tabs.
            Tailored to the desk you opened the file from. "Approval Queue" is the
            chain view, which Sales already reads in the "Where is this application?"
            panel on the overview — carrying it as a tab too gave Sales five tabs
            where two said the same thing. */}
        {(() => {
          const ALL: { key: typeof subTab; label: string; icon: string }[] = [
            { key: 'overview', label: 'Overview',       icon: 'dashboard' },
            { key: 'timeline', label: 'Activity',       icon: 'history' },
            { key: 'approval', label: 'Approval Queue', icon: 'approval' },
            { key: 'eye',      label: 'Eye Report',     icon: 'query_stats' },
          ]
          const tabs = audience === 'sales' ? ALL.filter(t => t.key !== 'approval') : ALL
          return (
            <div className="sd sd-tabwrap" style={{ '--sd-navy': NAVY } as CSSProperties}>
              <div className="sd-tabs" role="tablist">
                {tabs.map(t => (
                  <button key={t.key} role="tab" aria-selected={subTab === t.key}
                    className={`sd-tab${subTab === t.key ? ' is-active' : ''}`}
                    onClick={() => setSubTab(t.key)}>
                    <span className="material-symbols-rounded">{t.icon}</span>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          )
        })()}

      {/* Phoenix decision (advisory) — shown to every role on the overview tab */}
      {/* Sales renders both of these INSIDE its own view, in sequence with the rest
          of the page. Floating them above the layout left the offer — the one thing
          on this screen Sales actually acts on — detached from everything around
          it, above even the applicant's name. */}
      {subTab === 'overview' && audience !== 'sales' && <PhoenixDecisionBanner app={app} />}
      {subTab === 'overview' && audience !== 'sales' && <div style={{ marginBottom: 16 }}><OfferPanel app={app} onRefresh={load} /></div>}

      {/* Render the stage-appropriate view; actions inside are page-gated */}
      {subTab === 'timeline' ? (
        <TimelineTab events={events} notes={data.notes ?? []} />
      ) : subTab === 'approval' ? (
        <ApprovalChainTab app={app} events={events} />
      ) : subTab === 'eye' ? (
        <PhoenixEyeReport appId={app.id} />
      ) : showRisk ? (
        <RiskView
          app={app} conditions={conditions} events={events}
          onRefresh={load}
          onAdvance={openAdvance}
          onDecline={() => setDeclineOpen(true)}
          onReqInfo={() => setReqInfoOpen(true)}
          onCreditFile={() => setShowCreditFile(true)}
        />
      ) : showFinance ? (
        <FinanceView
          app={app} conditions={conditions} events={events}
          onRefresh={load}
          onAdvance={openAdvance}
          onDecline={() => setDeclineOpen(true)}
          onReqInfo={() => setReqInfoOpen(true)}
        />
      ) : isCompliance ? (
        <ComplianceView
          app={app} conditions={conditions} events={events}
          onRefresh={load}
        />
      ) : (
        <SalesView
          app={app} conditions={conditions} events={events}
          onRefresh={load}
          onAdvance={openAdvance}
          onDecline={() => setDeclineOpen(true)}
          onReqInfo={() => setReqInfoOpen(true)}
          onCreditFile={() => setShowCreditFile(true)}
        />
      )}

      {/* ── Shared modals ────────────────────────────────────────────────── */}

      <ConfirmModal open={advanceOpen} title="Advance Stage" confirmLabel="Advance" loading={actionLoading}
        onConfirm={doAdvance} onClose={() => { setAdvanceOpen(false); setToStage(''); setAdvanceNotes('') }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.3px' }}>Move to stage</div>
            <select value={toStage} onChange={e => setToStage(e.target.value)} style={inputStyle}>
              <option value="">Select next stage</option>
              {nextStages.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.3px' }}>Notes (optional)</div>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
              value={advanceNotes} onChange={e => setAdvanceNotes(e.target.value)}
              style={textareaStyle} placeholder="Add notes about this stage transition…" />
          </div>
        </div>
      </ConfirmModal>

      <ConfirmModal open={declineOpen} title="Decline Application" confirmLabel="Decline Application" danger loading={actionLoading}
        onConfirm={doDecline} onClose={() => { setDeclineOpen(false); setDeclineReason('') }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.3px' }}>Reason <span style={{ color: RED }}>*</span></div>
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
            value={declineReason} onChange={e => setDeclineReason(e.target.value)}
            style={textareaStyle} placeholder="State the reason for declining…" />
        </div>
      </ConfirmModal>

      <Modal open={reqInfoOpen} title="Request More Information"
        onClose={() => { setReqInfoOpen(false); setReqInfoNotes('') }}
        footer={
          <>
            <button onClick={() => { setReqInfoOpen(false); setReqInfoNotes('') }} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Cancel</button>
            <button onClick={doReqInfo} disabled={actionLoading} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 18px', borderRadius: 8, border: 'none', background: AMBER, color: '#fff', fontSize: 13, fontWeight: 600, cursor: actionLoading ? 'wait' : 'pointer', opacity: actionLoading ? 0.7 : 1 }}>
              {actionLoading && <Spinner size={14} color="#fff" />}Send Request
            </button>
          </>
        }>
        <div>
          <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--txt2)', lineHeight: 1.55 }}>The application will be sent back for more information. The assigned officer will be notified.</p>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.3px' }}>Notes</div>
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
            value={reqInfoNotes} onChange={e => setReqInfoNotes(e.target.value)}
            style={textareaStyle} placeholder="Describe what additional information is needed…" />
        </div>
      </Modal>

      <CreditFileDrawer cif={app.applicant_cif} open={showCreditFile} onClose={() => setShowCreditFile(false)} />
    </Page>
  )
}
