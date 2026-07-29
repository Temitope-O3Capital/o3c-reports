import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, Modal, ConfirmModal, Spinner, Sk,
} from '../../components/UI'
import { apiFetch, apiPut, apiPost, apiDelete } from '../../lib/api'
import { fmtKobo, fmtDatetime, fmtDate } from '../../lib/fmt'
import { NAVY, RED, AMBER, GREEN, BLUE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

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
}

interface AppEvent {
  id:             number
  application_id: number
  event_type:     string
  from_stage:     string | null
  to_stage:       string | null
  actor_user_id:  number | null
  actor_name:     string | null
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
  fontFamily: "'Sora', sans-serif", outline: 'none', boxSizing: 'border-box',
}
const textareaStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px',
  border: '1px solid var(--input-bdr)', borderRadius: 8,
  fontSize: 13.5, background: 'var(--input-bg)', color: 'var(--txt)',
  fontFamily: "'Sora', sans-serif", outline: 'none', resize: 'vertical',
  boxSizing: 'border-box', minHeight: 90,
}

// ── Pipeline progress stepper ──────────────────────────────────────────────────

const STEPPER_STAGES = [
  { stage: 'draft',               label: 'Draft' },
  { stage: 'submitted',           label: 'Submitted' },
  { stage: 'document_collection', label: 'Documents' },
  { stage: 'risk_review',         label: 'Risk Review' },
  { stage: 'pending_conditions',  label: 'Conditions' },
  { stage: 'finance_approval',    label: 'Finance' },
  { stage: 'active',              label: 'Disbursed' },
]

function PipelineStepper({ stage }: { stage: string }) {
  const currentIdx = STAGE_ORDER.indexOf(stage)
  const declined   = stage === 'declined'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '16px 20px', overflowX: 'auto' }}>
      {STEPPER_STAGES.map((step, i) => {
        const stepIdx = STAGE_ORDER.indexOf(step.stage)
        const done    = !declined && stepIdx <= currentIdx
        const active  = step.stage === stage
        const last    = i === STEPPER_STAGES.length - 1
        return (
          <div key={step.stage} style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                background: declined ? 'rgba(192,0,0,.1)' : done ? (active ? NAVY : GREEN) : 'var(--chip-bg)',
                border: `2px solid ${declined ? RED : done ? (active ? NAVY : GREEN) : 'var(--bdr)'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {!declined && done && !active
                  ? <span className="material-symbols-rounded" style={{ fontSize: 13, color: '#fff' }}>check</span>
                  : active && !declined
                  ? <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#fff', display: 'block' }} />
                  : <span style={{ ...NUM, fontSize: 10, fontWeight: 700, color: 'var(--txt3)' }}>{i + 1}</span>
                }
              </div>
              <span style={{ fontSize: 10.5, fontWeight: active ? 700 : 500, color: active ? NAVY : 'var(--txt2)', whiteSpace: 'nowrap' }}>
                {step.label}
              </span>
            </div>
            {!last && (
              <div style={{ width: 40, height: 2, background: done && !active ? GREEN : 'var(--bdr)', marginBottom: 16, flexShrink: 0 }} />
            )}
          </div>
        )
      })}
      {declined && (
        <div style={{ marginLeft: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: RED }}>cancel</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: RED }}>Declined</span>
        </div>
      )}
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
    <Modal open={open} onClose={onClose} title={`Credit File — ${cif}`} width={540}>
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

const APPROVAL_CHAIN = [
  { stage: 'submitted',           label: 'Submission',          role: 'Sales Officer' },
  { stage: 'document_collection', label: 'Document Collection', role: 'Sales Officer' },
  { stage: 'risk_review',         label: 'Risk Review',         role: 'Risk Officer' },
  { stage: 'risk_head_review',    label: 'Risk Head Review',    role: 'Risk Head' },
  { stage: 'pending_conditions',  label: 'Conditions',          role: 'Risk Head' },
  { stage: 'finance_approval',    label: 'Finance Approval',    role: 'Finance Officer' },
  { stage: 'booking',             label: 'Booking',             role: 'Finance Head' },
  { stage: 'active',              label: 'Disbursed',           role: 'Finance Head' },
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
            <span style={{ fontSize: 11, color: 'var(--txt2)', fontStyle: 'italic' }}>{entry.role}</span>
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

// ── SALES VIEW ────────────────────────────────────────────────────────────────

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
  const navigate   = useNavigate()
  const nextStages = ALLOWED_TRANSITIONS[app.stage] ?? []
  const isTerminal = app.stage === 'active' || app.stage === 'declined'
  const isSalesStage = ['draft', 'submitted', 'document_collection'].includes(app.stage)
  const docsUploaded = 0 // from DocumentsInline, approx (no state here)

  const stageAction: Record<string, string> = {
    draft:               'Submit Application',
    submitted:           'Send to Document Collection',
    document_collection: 'Submit to Risk Review',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '14px 18px', background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: 12, boxShadow: 'var(--card-shadow)' }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 2 }}>Product</div>
          <ProductPill product={app.product_type || 'Unknown'} />
        </div>
        <div style={{ width: 1, height: 36, background: 'var(--bdr)' }} />
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 2 }}>Amount</div>
          <div style={{ ...NUM, fontSize: 15, fontWeight: 700, color: 'var(--txt)' }}>{fmtKobo(app.amount_requested_kobo)}</div>
        </div>
        {app.tenor_months > 0 && <>
          <div style={{ width: 1, height: 36, background: 'var(--bdr)' }} />
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: 2 }}>Tenor</div>
            <div style={{ ...NUM, fontSize: 14, fontWeight: 600, color: 'var(--txt)' }}>{app.tenor_months}m</div>
          </div>
        </>}
        <div style={{ width: 1, height: 36, background: 'var(--bdr)' }} />
        <StagePill stage={app.stage} />

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {app.applicant_cif && (
            <button onClick={() => navigate(`/contacts/${app.applicant_cif}`)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', background: 'var(--card)', border: `1px solid ${NAVY}30`, borderRadius: 7, fontSize: 12, fontWeight: 600, color: NAVY, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>person</span>C360
            </button>
          )}
          {!isTerminal && isSalesStage && nextStages.length > 0 && (
            <button onClick={() => onAdvance(nextStages[0])} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', background: NAVY, color: '#fff', border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 15 }}>send</span>
              {stageAction[app.stage] ?? 'Advance'}
            </button>
          )}
          {!isTerminal && (
            <button onClick={onDecline} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: 'var(--card)', color: RED, border: `1px solid ${RED}40`, borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>cancel</span>Decline
            </button>
          )}
        </div>
      </div>

      {/* Declined banner */}
      {app.stage === 'declined' && app.decline_reason && (
        <div style={{ display: 'flex', gap: 10, padding: '12px 16px', borderRadius: 10, background: 'rgba(192,0,0,.06)', border: '1px solid rgba(192,0,0,.2)' }}>
          <span className="material-symbols-rounded" style={{ color: RED, fontSize: 18, flexShrink: 0 }}>cancel</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: RED }}>Application Declined</div>
            <div style={{ fontSize: 13, color: 'var(--txt)', marginTop: 2 }}>{app.decline_reason}</div>
          </div>
        </div>
      )}

      {/* Pipeline progress */}
      <SectionCard padding={false}>
        <PipelineStepper stage={app.stage} />
      </SectionCard>

      {/* Customer info + Document checklist */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <SectionCard title="Customer Information">
          <InfoRow label="Full Name"   value={app.applicant_name} />
          <InfoRow label="Phone"       value={app.applicant_phone} />
          <InfoRow label="Email"       value={app.applicant_email} />
          <InfoRow label="CIF"         value={app.applicant_cif} />
          <InfoRow label="Employer"    value={app.employer} />
          <InfoRow label="Submitted"   value={app.submitted_at ? fmtDatetime(app.submitted_at) : 'Not yet submitted'} />
        </SectionCard>

        <SectionCard title="Document Checklist" padding={false}>
          <DocumentsInline appId={app.id} />
        </SectionCard>
      </div>

      {/* Loan terms */}
      <SectionCard title="Loan Terms">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
          {[
            { label: 'Product',         value: <ProductPill product={app.product_type || '—'} /> },
            { label: 'Amount Requested',value: fmtKobo(app.amount_requested_kobo) },
            { label: 'Tenor',           value: app.tenor_months ? `${app.tenor_months} months` : '—' },
            { label: 'Interest Rate',   value: app.interest_rate_bps ? `${(app.interest_rate_bps / 100).toFixed(2)}% p.a.` : '—' },
            { label: 'Monthly Income',  value: app.monthly_income_kobo ? fmtKobo(app.monthly_income_kobo) : '—' },
            { label: 'Purpose',         value: app.purpose || '—' },
          ].map(row => (
            <div key={row.label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>{row.label}</span>
              <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--txt)' }}>{row.value}</span>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Approval chain status (read-only for sales) */}
      <SectionCard title="Where Is This Application?" padding={false}>
        <ApprovalChainCompact app={app} events={events} />
      </SectionCard>

      {/* Team thread */}
      <InternalThread appId={app.id} />
    </div>
  )
}

// ── RISK VIEW ─────────────────────────────────────────────────────────────────

const RATING_COLORS: Record<string, string> = { Excellent: GREEN, Good: GREEN, Fair: AMBER, Poor: RED, Bad: RED }

function RiskView({ app, conditions, events, onRefresh, onAdvance, onDecline, onReqInfo, onCreditFile, onCommittee }: {
  app: Application
  conditions: AppCondition[]
  events: AppEvent[]
  onRefresh: () => void
  onAdvance: (toStage: string) => void
  onDecline: () => void
  onReqInfo: () => void
  onCreditFile: () => void
  onCommittee: () => void
}) {
  const navigate  = useNavigate()
  const nextStages = ALLOWED_TRANSITIONS[app.stage] ?? []
  const isTerminal = app.stage === 'active' || app.stage === 'declined'
  const isRiskStage = ['risk_review', 'risk_head_review', 'pending_conditions'].includes(app.stage)

  const score  = app.eye_score
  const rating = app.eye_rating
  const scoreColor = score === null ? 'var(--txt3)' : score >= 650 ? GREEN : score >= 500 ? AMBER : RED

  const monthlyRepayment = (app.tenor_months && app.amount_requested_kobo)
    ? Math.round(app.amount_requested_kobo / app.tenor_months * (1 + (app.interest_rate_bps ?? 0) / 10000))
    : 0
  const dtiPct  = app.dti_pct ?? ((app.monthly_income_kobo && monthlyRepayment)
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
          {isRiskStage && !isTerminal && (
            <>
              <button onClick={onReqInfo} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: 'var(--card)', color: AMBER, border: `1px solid ${AMBER}`, borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>help</span>Request Info
              </button>
              <button onClick={onCommittee} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: 'var(--card)', color: '#7C3AED', border: `1px solid #7C3AED40`, borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>groups</span>Committee
              </button>
              <button onClick={onDecline} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', background: 'var(--card)', color: RED, border: `1px solid ${RED}40`, borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>cancel</span>Decline
              </button>
              <button onClick={() => onAdvance(nextStages[0])} disabled={nextStages.length === 0} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 18px', background: nextStages.length === 0 ? 'var(--chip-bg)' : GREEN, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: nextStages.length === 0 ? 'not-allowed' : 'pointer' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>check_circle</span>
                {app.stage === 'risk_head_review' ? 'Send to Finance' : app.stage === 'pending_conditions' ? 'Approve to Finance' : 'Advance'}
              </button>
            </>
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
          {isRiskStage && (
            <button onClick={() => setEditing(e => !e)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', fontSize: 11.5, cursor: 'pointer', marginTop: 4 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 13 }}>edit</span>{score !== null ? 'Update' : 'Enter Score'}
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
          <span style={{ fontSize: 11.5, fontWeight: 600, padding: '4px 12px', borderRadius: 20, background: 'rgba(124,58,237,.08)', color: '#7C3AED' }}>Compliance View — Read Only</span>
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
  const nextStages = ALLOWED_TRANSITIONS[app.stage] ?? []
  const isTerminal = app.stage === 'active' || app.stage === 'declined'
  const isFinanceStage = ['finance_approval', 'booking'].includes(app.stage)

  const score  = app.eye_score
  const rating = app.eye_rating
  const scoreColor = score === null ? 'var(--txt3)' : score >= 650 ? GREEN : score >= 500 ? AMBER : RED

  const monthlyRepayment = (app.tenor_months && app.amount_requested_kobo)
    ? Math.round(app.amount_requested_kobo / app.tenor_months * (1 + (app.interest_rate_bps ?? 0) / 10000))
    : 0
  const dtiPct    = app.dti_pct
  const dtiColor  = dtiPct === null ? 'var(--txt2)' : dtiPct > 50 ? RED : dtiPct > 33 ? AMBER : GREEN
  const unmetCount = conditions.filter(c => !c.is_met).length
  const allConditionsMet = conditions.length > 0 && unmetCount === 0

  const disbursedLabel = app.stage === 'booking' ? 'Disburse' : 'Final Approval'

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
          {isFinanceStage && !isTerminal && (
            <>
              <button onClick={onReqInfo} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 13px', background: 'var(--card)', color: AMBER, border: `1px solid ${AMBER}`, borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>pause_circle</span>Hold
              </button>
              <button onClick={onDecline} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 13px', background: 'var(--card)', color: RED, border: `1px solid ${RED}40`, borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>cancel</span>Decline
              </button>
              <button onClick={() => onAdvance(nextStages[0])} disabled={nextStages.length === 0 || (conditions.length > 0 && unmetCount > 0)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 18px', background: NAVY, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: (conditions.length > 0 && unmetCount > 0) ? 0.5 : 1 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 15 }}>payments</span>{disbursedLabel}
              </button>
            </>
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
              {allConditionsMet ? 'All conditions satisfied — disbursement cleared' : `${unmetCount} condition${unmetCount !== 1 ? 's' : ''} not yet satisfied`}
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

// ── Main ApplicationDetail ────────────────────────────────────────────────────

export default function ApplicationDetail() {
  const { id }   = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [data,    setData]    = useState<DetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const userObj      = (() => { try { return JSON.parse(localStorage.getItem('o3c_user') ?? '{}') } catch { return {} } })()
  const userRole     = userObj?.role ?? ''
  const roleKey      = userRole.toLowerCase()
  const isRisk       = roleKey.includes('risk')
  const isFinance    = roleKey.includes('finance')
  const isCompliance = roleKey.includes('compliance')

  const [advanceOpen,   setAdvanceOpen]   = useState(false)
  const [declineOpen,   setDeclineOpen]   = useState(false)
  const [reqInfoOpen,   setReqInfoOpen]   = useState(false)
  const [committeeOpen, setCommitteeOpen] = useState(false)
  const [showCreditFile,setShowCreditFile]= useState(false)

  const [toStage,       setToStage]       = useState('')
  const [advanceNotes,  setAdvanceNotes]  = useState('')
  const [declineReason, setDeclineReason] = useState('')
  const [reqInfoNotes,  setReqInfoNotes]  = useState('')
  const [committeeNote, setCommitteeNote] = useState('')
  const [actionLoading, setActionLoading] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    setLoading(true); setError(null)
    try {
      const res = await apiFetch<{ data: DetailData }>(`/api/los/${id}`)
      setData(res.data)
    } catch (e: any) { setError(e.message ?? 'Failed to load') }
    finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])

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

  async function doCommittee() {
    if (!committeeNote.trim()) { toast.error('Reason is required'); return }
    setActionLoading(true)
    try {
      await apiPost(`/api/los/${id}/notes`, { body: `[COMMITTEE REFERRAL] ${committeeNote}`, is_internal: true })
      toast.success('Referred to committee')
      setCommitteeOpen(false); setCommitteeNote('')
      load()
    } catch (e: any) { toast.error(e.message ?? 'Failed') }
    finally { setActionLoading(false) }
  }

  function openAdvance(stage: string) { setToStage(stage); setAdvanceOpen(true) }

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
          {error} — <button onClick={load} style={{ textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 'inherit' }}>Retry</button>
        </div>
      </Page>
    )
  }

  if (!data) return null

  const app        = data.application
  const events     = data.events     ?? []
  const conditions = data.conditions ?? []

  const nextStages = ALLOWED_TRANSITIONS[app.stage] ?? []

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
      {/* Render role-specific view */}
      {isRisk ? (
        <RiskView
          app={app} conditions={conditions} events={events}
          onRefresh={load}
          onAdvance={openAdvance}
          onDecline={() => setDeclineOpen(true)}
          onReqInfo={() => setReqInfoOpen(true)}
          onCreditFile={() => setShowCreditFile(true)}
          onCommittee={() => setCommitteeOpen(true)}
        />
      ) : isFinance ? (
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

      <Modal open={committeeOpen} title="Refer to Credit Committee"
        onClose={() => { setCommitteeOpen(false); setCommitteeNote('') }}
        footer={
          <>
            <button onClick={() => { setCommitteeOpen(false); setCommitteeNote('') }} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Cancel</button>
            <button onClick={doCommittee} disabled={actionLoading} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 18px', borderRadius: 8, border: 'none', background: '#7C3AED', color: '#fff', fontSize: 13, fontWeight: 600, cursor: actionLoading ? 'wait' : 'pointer', opacity: actionLoading ? 0.7 : 1 }}>
              {actionLoading && <Spinner size={14} color="#fff" />}Refer
            </button>
          </>
        }>
        <div>
          <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--txt2)', lineHeight: 1.55 }}>This will post an internal note flagging the application for committee review.</p>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.3px' }}>Reason <span style={{ color: RED }}>*</span></div>
          <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false"
            value={committeeNote} onChange={e => setCommitteeNote(e.target.value)}
            style={textareaStyle} placeholder="State why this application needs committee review…" />
        </div>
      </Modal>

      <CreditFileDrawer cif={app.applicant_cif} open={showCreditFile} onClose={() => setShowCreditFile(false)} />
    </Page>
  )
}
