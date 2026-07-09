import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, ErrBanner, Spinner, Modal, btnPrimary, btnSecondary } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDatetime } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, BLUE, INTER } from '../../lib/design'
import { toast } from 'sonner'

interface DPAEntry {
  id:                      number
  processing_name:         string
  purpose:                 string
  legal_basis:             string
  data_categories:         string[] | null
  data_subjects:           string | null
  recipients:              string | null
  third_country_transfers: boolean
  retention_period:        string | null
  security_measures:       string | null
  dpo_reviewed:            boolean
  status:                  'active' | 'under_review' | 'discontinued'
  created_by_name:         string | null
  created_at:              string
  updated_at:              string
}

const BASIS_LABELS: Record<string, string> = {
  consent: 'Consent', contract: 'Contract', legal_obligation: 'Legal Obligation',
  vital_interests: 'Vital Interests', public_task: 'Public Task',
  legitimate_interests: 'Legitimate Interests',
}

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  active:        { bg: `${GREEN}18`, color: GREEN },
  under_review:  { bg: `${AMBER}18`, color: AMBER },
  discontinued:  { bg: `${RED}15`,   color: RED   },
}

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.under_review
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 8, ...s }}>
      {status.replace('_', ' ')}
    </span>
  )
}

const inp: React.CSSProperties = {
  padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7,
  fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', fontFamily: INTER,
  width: '100%', boxSizing: 'border-box',
}

export default function DPARegister() {
  const [items,   setItems]   = useState<DPAEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [selected, setSelected] = useState<DPAEntry | null>(null)
  const [saving,  setSaving]  = useState(false)

  const [fName,       setFName]       = useState('')
  const [fPurpose,    setFPurpose]    = useState('')
  const [fBasis,      setFBasis]      = useState('contract')
  const [fSubjects,   setFSubjects]   = useState('')
  const [fRecipients, setFRecipients] = useState('')
  const [fRetention,  setFRetention]  = useState('')
  const [fSecurity,   setFSecurity]   = useState('')
  const [fCategories, setFCategories] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await apiFetch<DPAEntry[]>('/api/compliance/dpa-register')
      setItems(res ?? [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const create = async () => {
    if (!fName || !fPurpose || !fBasis) { toast.error('Name, purpose and legal basis are required'); return }
    setSaving(true)
    try {
      await apiPost('/api/compliance/dpa-register', {
        processing_name: fName, purpose: fPurpose, legal_basis: fBasis,
        data_subjects: fSubjects, recipients: fRecipients,
        retention_period: fRetention, security_measures: fSecurity,
        data_categories: fCategories.split(',').map(s => s.trim()).filter(Boolean),
      })
      toast.success('Processing activity added')
      setShowNew(false)
      setFName(''); setFPurpose(''); setFBasis('contract')
      setFSubjects(''); setFRecipients(''); setFRetention(''); setFSecurity(''); setFCategories('')
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  const updateStatus = async (id: number, status: string, dpoReviewed: boolean) => {
    try {
      await apiFetch(`/api/compliance/dpa-register/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, dpo_reviewed: dpoReviewed }),
        headers: { 'Content-Type': 'application/json' },
      })
      toast.success('Updated')
      setSelected(null)
      load()
    } catch (e: any) { toast.error(e.message) }
  }

  const th: React.CSSProperties = {
    textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 700,
    textTransform: 'uppercase' as const, letterSpacing: '.4px',
    color: 'var(--txt2)', background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)',
  }
  const td: React.CSSProperties = { padding: '10px 12px', borderBottom: '1px solid var(--bdr)', verticalAlign: 'top' }

  return (
    <Page
      title="Data Processing Register"
      subtitle="NDPR Article 4.1 / FCCPC compliance — inventory of personal data processing activities"
      actions={<button onClick={() => setShowNew(true)} style={btnPrimary}>+ Add Activity</button>}
    >
      <ErrBanner error={error} onRetry={load} />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
      ) : (
        <SectionCard title="Processing Activities" badge={items.length} padding={false}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['Processing Activity', 'Purpose', 'Legal Basis', 'Data Categories', 'Retention', 'DPO', 'Status', ''].map(h => (
                    <th key={h} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map(row => (
                  <tr key={row.id} style={{ background: 'transparent' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td style={{ ...td, fontWeight: 600, color: NAVY, maxWidth: 200 }}>
                      <div>{row.processing_name}</div>
                      {row.third_country_transfers && (
                        <div style={{ fontSize: 10, color: AMBER, fontWeight: 700, marginTop: 2 }}>⚠ Third-country transfer</div>
                      )}
                    </td>
                    <td style={{ ...td, color: 'var(--txt2)', maxWidth: 200, fontSize: 12 }}>{row.purpose}</td>
                    <td style={{ ...td }}>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 8,
                        background: `${BLUE}18`, color: BLUE }}>
                        {BASIS_LABELS[row.legal_basis] ?? row.legal_basis}
                      </span>
                    </td>
                    <td style={{ ...td, fontSize: 11.5, color: 'var(--txt2)' }}>
                      {(row.data_categories ?? []).join(', ') || '—'}
                    </td>
                    <td style={{ ...td, fontSize: 12, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>
                      {row.retention_period || '—'}
                    </td>
                    <td style={{ ...td }}>
                      {row.dpo_reviewed
                        ? <span style={{ fontSize: 11, color: GREEN, fontWeight: 700 }}>✓ Reviewed</span>
                        : <span style={{ fontSize: 11, color: AMBER, fontWeight: 600 }}>Pending</span>}
                    </td>
                    <td style={td}><StatusPill status={row.status} /></td>
                    <td style={td}>
                      <button onClick={() => setSelected(row)}
                        style={{ padding: '3px 10px', fontSize: 12, fontWeight: 600, borderRadius: 6,
                          border: `1px solid ${NAVY}30`, background: 'none', color: NAVY, cursor: 'pointer', fontFamily: INTER }}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {/* Add new */}
      {showNew && (
        <Modal open title="Add Processing Activity" onClose={() => setShowNew(false)} width={580}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Processing Name *</label>
              <input value={fName} onChange={e => setFName(e.target.value)} placeholder="e.g. KYC Verification" style={inp} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Purpose *</label>
              <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={fPurpose} onChange={e => setFPurpose(e.target.value)} rows={2} style={{ ...inp, resize: 'vertical' }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Legal Basis *</label>
                <select value={fBasis} onChange={e => setFBasis(e.target.value)} style={inp}>
                  {Object.entries(BASIS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Retention Period</label>
                <input value={fRetention} onChange={e => setFRetention(e.target.value)} placeholder="e.g. 7 years" style={inp} />
              </div>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Data Categories (comma-separated)</label>
              <input value={fCategories} onChange={e => setFCategories(e.target.value)} placeholder="identity, financial, contact" style={inp} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Data Subjects</label>
                <input value={fSubjects} onChange={e => setFSubjects(e.target.value)} placeholder="Loan applicants" style={inp} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Recipients</label>
                <input value={fRecipients} onChange={e => setFRecipients(e.target.value)} placeholder="CBN, credit bureaux" style={inp} />
              </div>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Security Measures</label>
              <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" value={fSecurity} onChange={e => setFSecurity(e.target.value)} rows={2} style={{ ...inp, resize: 'vertical' }} placeholder="Encryption at rest, TLS in transit…" />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowNew(false)} style={btnSecondary}>Cancel</button>
              <button onClick={create} disabled={saving} style={btnPrimary}>{saving ? 'Adding…' : 'Add Activity'}</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Edit status */}
      {selected && (
        <Modal open title={`Edit: ${selected.processing_name}`} onClose={() => setSelected(null)} width={420}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 12.5, color: 'var(--txt2)', marginBottom: 6 }}>
              Legal basis: <strong>{BASIS_LABELS[selected.legal_basis]}</strong> · Last updated: {fmtDatetime(selected.updated_at)}
            </div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt2)', marginBottom: 4 }}>Change Status</div>
            {(['active', 'under_review', 'discontinued'] as const).map(s => (
              <button key={s} onClick={() => updateStatus(selected.id, s, selected.dpo_reviewed)}
                style={{ padding: '9px 14px', borderRadius: 8, border: `1px solid ${STATUS_STYLE[s].color}40`,
                  background: STATUS_STYLE[s].bg, color: STATUS_STYLE[s].color, fontSize: 13, fontWeight: 700,
                  cursor: 'pointer', fontFamily: INTER, textAlign: 'left' as const }}>
                {s.replace('_', ' ')}
              </button>
            ))}
            <button onClick={() => updateStatus(selected.id, selected.status, !selected.dpo_reviewed)}
              style={{ marginTop: 4, padding: '9px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                border: `1px solid ${NAVY}30`, background: `${NAVY}0a`, color: NAVY, cursor: 'pointer', fontFamily: INTER }}>
              {selected.dpo_reviewed ? 'Mark DPO Review Pending' : 'Mark DPO Reviewed ✓'}
            </button>
          </div>
        </Modal>
      )}
    </Page>
  )
}
