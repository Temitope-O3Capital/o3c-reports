import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner, Modal, btnPrimary, btnSecondary } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDate, fmtDatetime } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, BLUE, INTER } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ──────────────────────────────────────────────────────────────────────

interface SOC2Control {
  id:                      number
  criteria_code:           string
  criteria_group:          string
  trust_criteria:          string
  title:                   string
  description:             string
  implementation_guidance: string | null
  evidence_summary:        string | null
  control_type:            string
  frequency:               string
  status:                  string
  owner_id:                number | null
  owner_name:              string | null
  target_date:             string | null
  completed_at:            string | null
  waiver_reason:           string | null
  updated_at:              string
}

interface Evidence {
  id:                number
  title:             string
  evidence_type:     string
  description:       string | null
  file_url:          string | null
  code_reference:    string | null
  collected_by_name: string | null
  collected_at:      string
  valid_from:        string | null
  valid_to:          string | null
}

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_OPTS = [
  { value: 'not_started', label: 'Not Started' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'complete',    label: 'Complete'    },
  { value: 'waived',      label: 'Waived'      },
]

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  complete:    { bg: `${GREEN}18`, color: GREEN },
  in_progress: { bg: `${BLUE}15`,  color: BLUE  },
  not_started: { bg: '#6B728020',  color: '#6B7280' },
  waived:      { bg: `${AMBER}18`, color: AMBER },
}

const EV_TYPE_LABELS: Record<string, string> = {
  note: 'Note', screenshot: 'Screenshot', log: 'Log',
  policy_doc: 'Policy Document', code_ref: 'Code Reference',
  audit_report: 'Audit Report', other: 'Other',
}

const inp: React.CSSProperties = {
  padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7,
  fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', fontFamily: INTER,
  width: '100%', boxSizing: 'border-box',
}

const sel: React.CSSProperties = { ...inp, cursor: 'pointer' }

// ── Evidence card ──────────────────────────────────────────────────────────────

function EvidenceCard({ ev, onDelete }: { ev: Evidence; onDelete: (id: number) => void }) {
  const [deleting, setDeleting] = useState(false)
  async function handleDelete() {
    if (!confirm(`Delete evidence "${ev.title}"?`)) return
    setDeleting(true)
    try {
      await apiFetch(`/api/compliance/soc2/evidence/${ev.id}`, { method: 'DELETE' })
      toast.success('Evidence deleted')
      onDelete(ev.id)
    } catch (e: any) { toast.error(e.message) }
    finally { setDeleting(false) }
  }
  return (
    <div style={{ padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 8,
      background: 'var(--card-bg)', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--txt)' }}>{ev.title}</span>
          <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 6, background: 'var(--th-bg)',
            color: 'var(--txt-muted)', fontWeight: 600 }}>
            {EV_TYPE_LABELS[ev.evidence_type] ?? ev.evidence_type}
          </span>
        </div>
        {ev.description && <p style={{ fontSize: 12, color: 'var(--txt-muted)', margin: '4px 0', lineHeight: 1.5 }}>{ev.description}</p>}
        {ev.code_reference && (
          <div style={{ fontSize: 11, fontFamily: 'monospace', color: BLUE, marginTop: 4 }}>📎 {ev.code_reference}</div>
        )}
        {ev.file_url && (
          <a href={ev.file_url} target="_blank" rel="noreferrer"
            style={{ fontSize: 11, color: BLUE, marginTop: 4, display: 'block' }}>
            🔗 Open file
          </a>
        )}
        <div style={{ fontSize: 11, color: 'var(--txt-muted)', marginTop: 6 }}>
          Collected by {ev.collected_by_name ?? 'unknown'} · {fmtDatetime(ev.collected_at)}
          {ev.valid_from && <> · Valid {fmtDate(ev.valid_from)}{ev.valid_to ? ` – ${fmtDate(ev.valid_to)}` : '+'}</>}
        </div>
      </div>
      <button onClick={handleDelete} disabled={deleting}
        style={{ color: RED, background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, padding: 0, flexShrink: 0 }}>
        🗑
      </button>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function SOC2ControlDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [control,  setControl]  = useState<SOC2Control | null>(null)
  const [evidence, setEvidence] = useState<Evidence[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)

  // Status/owner/date editing
  const [editStatus,  setEditStatus]  = useState('')
  const [editTarget,  setEditTarget]  = useState('')
  const [editSummary, setEditSummary] = useState('')
  const [editWaiver,  setEditWaiver]  = useState('')
  const [saving,      setSaving]      = useState(false)

  // Add evidence modal
  const [showAddEv,  setShowAddEv]  = useState(false)
  const [evTitle,    setEvTitle]    = useState('')
  const [evType,     setEvType]     = useState('note')
  const [evDesc,     setEvDesc]     = useState('')
  const [evFileURL,  setEvFileURL]  = useState('')
  const [evCodeRef,  setEvCodeRef]  = useState('')
  const [evValidFr,  setEvValidFr]  = useState('')
  const [evValidTo,  setEvValidTo]  = useState('')
  const [savingEv,   setSavingEv]   = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await apiFetch<{ control: SOC2Control; evidence: Evidence[] }>(`/api/compliance/soc2/controls/${id}`)
      setControl(res.control)
      setEvidence(res.evidence ?? [])
      setEditStatus(res.control.status)
      setEditTarget(res.control.target_date ?? '')
      setEditSummary(res.control.evidence_summary ?? '')
      setEditWaiver(res.control.waiver_reason ?? '')
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [id])

  useEffect(() => { load() }, [load])

  async function handleSave() {
    setSaving(true)
    try {
      const body: Record<string, any> = { status: editStatus }
      if (editTarget)  body.target_date      = editTarget
      if (editSummary) body.evidence_summary = editSummary
      if (editWaiver)  body.waiver_reason    = editWaiver
      const updated = await apiFetch<SOC2Control>(`/api/compliance/soc2/controls/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      })
      setControl(updated)
      toast.success('Control updated')
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  async function handleAddEvidence() {
    if (!evTitle.trim()) { toast.error('Title is required'); return }
    setSavingEv(true)
    try {
      const body: Record<string, any> = { title: evTitle, evidence_type: evType }
      if (evDesc)    body.description    = evDesc
      if (evFileURL) body.file_url       = evFileURL
      if (evCodeRef) body.code_reference = evCodeRef
      if (evValidFr) body.valid_from     = evValidFr
      if (evValidTo) body.valid_to       = evValidTo
      const newEv = await apiFetch<Evidence>(`/api/compliance/soc2/controls/${id}/evidence`, {
        method: 'POST', body: JSON.stringify(body),
      })
      setEvidence(prev => [newEv, ...prev])
      setShowAddEv(false)
      setEvTitle(''); setEvType('note'); setEvDesc(''); setEvFileURL(''); setEvCodeRef('')
      setEvValidFr(''); setEvValidTo('')
      toast.success('Evidence added')
    } catch (e: any) { toast.error(e.message) }
    finally { setSavingEv(false) }
  }

  if (loading) return <Page title="SOC 2 Control"><Spinner /></Page>
  if (error)   return <Page title="SOC 2 Control"><ErrBanner error={error} onRetry={load} /></Page>
  if (!control) return null

  const ss = STATUS_STYLE[control.status] ?? STATUS_STYLE.not_started

  return (
    <Page title={control.criteria_code}>
      {/* breadcrumb */}
      <button onClick={() => navigate('/compliance/soc2')}
        style={{ fontSize: 12, color: BLUE, background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 16, display: 'block' }}>
        ← SOC 2 Readiness
      </button>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20, alignItems: 'start' }}>
        {/* Left — control details + evidence */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SectionCard>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
              <span style={{ fontSize: 22, fontWeight: 900, color: NAVY, fontFamily: 'monospace', flexShrink: 0 }}>
                {control.criteria_code}
              </span>
              <div>
                <h2 style={{ fontSize: 17, fontWeight: 700, color: 'var(--txt)', margin: 0 }}>{control.title}</h2>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 8, ...ss, marginTop: 6, display: 'inline-block' }}>
                  {STATUS_OPTS.find(s => s.value === control.status)?.label ?? control.status}
                </span>
              </div>
            </div>
            {control.description && (
              <p style={{ fontSize: 13, color: 'var(--txt-muted)', lineHeight: 1.6, margin: '0 0 12px' }}>{control.description}</p>
            )}
            {control.implementation_guidance && (
              <div style={{ background: 'var(--th-bg)', borderRadius: 8, padding: '12px 14px', fontSize: 13, color: 'var(--txt)', lineHeight: 1.6 }}>
                <strong style={{ display: 'block', marginBottom: 6, fontSize: 12, color: 'var(--txt-muted)' }}>IMPLEMENTATION GUIDANCE</strong>
                {control.implementation_guidance}
              </div>
            )}
            <div style={{ display: 'flex', gap: 16, marginTop: 14, flexWrap: 'wrap', fontSize: 12, color: 'var(--txt-muted)' }}>
              <span>Type: <strong>{control.control_type}</strong></span>
              <span>Frequency: <strong>{control.frequency}</strong></span>
              <span>Last updated: <strong>{fmtDatetime(control.updated_at)}</strong></span>
              {control.completed_at && <span>Completed: <strong>{fmtDate(control.completed_at)}</strong></span>}
            </div>
          </SectionCard>

          {/* Evidence */}
          <SectionCard>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--txt)', flex: 1 }}>
                Evidence ({evidence.length})
              </span>
              <button style={btnPrimary} onClick={() => setShowAddEv(true)}>+ Add Evidence</button>
            </div>
            {evidence.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--txt-muted)', fontSize: 13 }}>
                No evidence attached. Add evidence to move this control forward.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {evidence.map(ev => (
                  <EvidenceCard key={ev.id} ev={ev}
                    onDelete={evId => setEvidence(prev => prev.filter(e => e.id !== evId))} />
                ))}
              </div>
            )}
          </SectionCard>
        </div>

        {/* Right — status + notes editing */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SectionCard>
            <h3 style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt-muted)', margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: .5 }}>Manage</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt-muted)' }}>Status</label>
                <select style={{ ...sel, marginTop: 4 }} value={editStatus} onChange={e => setEditStatus(e.target.value)}>
                  {STATUS_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt-muted)' }}>Target Date</label>
                <input type="date" style={{ ...inp, marginTop: 4 }} value={editTarget} onChange={e => setEditTarget(e.target.value)} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt-muted)' }}>Evidence Summary</label>
                <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" style={{ ...inp, marginTop: 4, resize: 'vertical', minHeight: 80 }}
                  value={editSummary} onChange={e => setEditSummary(e.target.value)}
                  placeholder="What evidence exists for this control?" />
              </div>
              {editStatus === 'waived' && (
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: AMBER }}>Waiver Reason</label>
                  <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" style={{ ...inp, marginTop: 4, resize: 'vertical', minHeight: 60 }}
                    value={editWaiver} onChange={e => setEditWaiver(e.target.value)}
                    placeholder="Why is this control waived?" />
                </div>
              )}
              <button style={btnPrimary} onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </SectionCard>

          <SectionCard>
            <h3 style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt-muted)', margin: '0 0 10px', textTransform: 'uppercase', letterSpacing: .5 }}>Owner</h3>
            <div style={{ fontSize: 13, color: 'var(--txt)' }}>{control.owner_name ?? 'Unassigned'}</div>
          </SectionCard>
        </div>
      </div>

      {/* ── Add Evidence Modal ── */}
      <Modal open={showAddEv} onClose={() => setShowAddEv(false)} title="Add Evidence">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt-muted)' }}>Title *</label>
            <input style={{ ...inp, marginTop: 4 }} value={evTitle} onChange={e => setEvTitle(e.target.value)} placeholder="Evidence title" />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt-muted)' }}>Type</label>
            <select style={{ ...sel, marginTop: 4 }} value={evType} onChange={e => setEvType(e.target.value)}>
              {Object.entries(EV_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt-muted)' }}>Description</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" style={{ ...inp, marginTop: 4, resize: 'vertical', minHeight: 80 }}
              value={evDesc} onChange={e => setEvDesc(e.target.value)}
              placeholder="What does this evidence demonstrate?" />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt-muted)' }}>Code Reference</label>
            <input style={{ ...inp, marginTop: 4 }} value={evCodeRef} onChange={e => setEvCodeRef(e.target.value)}
              placeholder="e.g. backend-go/handlers/auth.go:42" />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt-muted)' }}>File / Document URL</label>
            <input style={{ ...inp, marginTop: 4 }} value={evFileURL} onChange={e => setEvFileURL(e.target.value)}
              placeholder="https://…" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt-muted)' }}>Valid From</label>
              <input type="date" style={{ ...inp, marginTop: 4 }} value={evValidFr} onChange={e => setEvValidFr(e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt-muted)' }}>Valid To</label>
              <input type="date" style={{ ...inp, marginTop: 4 }} value={evValidTo} onChange={e => setEvValidTo(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
            <button style={btnSecondary} onClick={() => setShowAddEv(false)} disabled={savingEv}>Cancel</button>
            <button style={btnPrimary}   onClick={handleAddEvidence}          disabled={savingEv}>{savingEv ? 'Saving…' : 'Add Evidence'}</button>
          </div>
        </div>
      </Modal>
    </Page>
  )
}
