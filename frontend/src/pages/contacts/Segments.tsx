import { useState } from 'react'
import { Page, SectionCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, RED, SORA, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Criteria {
  product_type:  string
  stage:         string
  status:        string
  employer:      string
  dpd_min:       string
  dpd_max:       string
  outstanding_min: string
  outstanding_max: string
}

const EMPTY_CRITERIA: Criteria = {
  product_type: '', stage: '', status: '', employer: '',
  dpd_min: '', dpd_max: '', outstanding_min: '', outstanding_max: '',
}

const PRODUCT_TYPES  = ['Salary Loan', 'Individual Loan', 'Business Loan', 'Credit Card', 'Payday Loan']
const STAGES         = ['submitted', 'pre-screening', 'underwriting', 'approval', 'disbursed', 'active', 'closed']
const STATUSES       = ['pending', 'active', 'disbursed', 'rejected', 'cancelled', 'written_off']

// ── Style helpers ──────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: '7px 10px', borderRadius: RADIUS.md, border: '1px solid var(--input-bdr)',
  background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, width: '100%', boxSizing: 'border-box',
}

const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }

const btnPrimary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px',
  borderRadius: RADIUS.md, background: NAVY, color: '#fff', fontSize: TEXT.sm,
  fontWeight: FW.semibold, border: 'none', cursor: 'pointer',
}

const btnSecondary: React.CSSProperties = {
  ...btnPrimary, background: 'var(--card)', color: 'var(--txt)',
  border: '1px solid var(--bdr)',
}

// ── Main ───────────────────────────────────────────────────────────────────────

export default function Segments() {
  const [criteria,  setCriteria]  = useState<Criteria>(EMPTY_CRITERIA)
  const [listName,  setListName]  = useState('')
  const [preview,   setPreview]   = useState<number | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [creating,  setCreating]  = useState(false)
  const [err,       setErr]       = useState<string | null>(null)

  function update(field: keyof Criteria, value: string) {
    setCriteria(prev => ({ ...prev, [field]: value }))
    setPreview(null)
  }

  function buildPayload() {
    const payload: Record<string, any> = {}
    if (criteria.product_type) payload.products  = [criteria.product_type]
    if (criteria.stage)        payload.stages    = [criteria.stage]
    if (criteria.status)       payload.statuses  = [criteria.status]
    if (criteria.employer)     payload.employers = [criteria.employer]
    if (criteria.dpd_min)      payload.min_dpd   = parseInt(criteria.dpd_min, 10)
    if (criteria.dpd_max)      payload.max_dpd   = parseInt(criteria.dpd_max, 10)
    if (criteria.outstanding_min) payload.min_outstanding_kobo = Math.round(parseFloat(criteria.outstanding_min) * 100)
    if (criteria.outstanding_max) payload.max_outstanding_kobo = Math.round(parseFloat(criteria.outstanding_max) * 100)
    return payload
  }

  async function handlePreview() {
    setErr(null); setPreviewing(true)
    try {
      const res = await apiFetch<{ data: { count: number } }>('/api/contact-lists/segment/preview', {
        method: 'POST',
        body: JSON.stringify(buildPayload()),
      })
      setPreview(res.data.count)
    } catch (e: any) {
      setErr(e.message ?? 'Preview failed')
    } finally {
      setPreviewing(false)
    }
  }

  async function handleCreate() {
    if (!listName.trim()) { toast.error('Enter a name for the contact list'); return }
    if (preview === null) { toast.error('Run a preview first'); return }
    if (preview === 0)    { toast.error('No matching contacts — adjust your filters'); return }
    setErr(null); setCreating(true)
    try {
      const res = await apiFetch<{ data: { list_id: number; imported: number } }>('/api/contact-lists/segment/create', {
        method: 'POST',
        body: JSON.stringify({ ...buildPayload(), name: listName.trim() }),
      })
      toast.success(`Contact list created — ${fmtNum(res.data.imported)} members added`)
      setCriteria(EMPTY_CRITERIA)
      setListName('')
      setPreview(null)
    } catch (e: any) {
      setErr(e.message ?? 'Create failed')
    } finally {
      setCreating(false)
    }
  }

  const hasAnyFilter = Object.values(criteria).some(v => v.trim() !== '')

  return (
    <Page title="Contact Segments" subtitle="Build dynamic contact lists by filtering the loan portfolio">
      <ErrBanner error={err} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: SP[4], alignItems: 'start' }}>
        {/* Filters panel */}
        <SectionCard title="Filter Criteria" subtitle="All filters are optional — combine them to narrow the audience">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>

            {/* Product type */}
            <div>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Product Type</label>
              <select value={criteria.product_type} onChange={e => update('product_type', e.target.value)} style={selectStyle}>
                <option value="">Any product</option>
                {PRODUCT_TYPES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>

            {/* Stage */}
            <div>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Stage</label>
              <select value={criteria.stage} onChange={e => update('stage', e.target.value)} style={selectStyle}>
                <option value="">Any stage</option>
                {STAGES.map(s => <option key={s} value={s}>{s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>)}
              </select>
            </div>

            {/* Status */}
            <div>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Status</label>
              <select value={criteria.status} onChange={e => update('status', e.target.value)} style={selectStyle}>
                <option value="">Any status</option>
                {STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>)}
              </select>
            </div>

            {/* Employer */}
            <div>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Employer (contains)</label>
              <input
                value={criteria.employer}
                onChange={e => update('employer', e.target.value)}
                placeholder="e.g. NNPC, Dangote…"
                style={inputStyle}
              />
            </div>

            {/* DPD range */}
            <div>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>DPD Min</label>
              <input
                type="number" min="0"
                value={criteria.dpd_min}
                onChange={e => update('dpd_min', e.target.value)}
                placeholder="e.g. 30"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>DPD Max</label>
              <input
                type="number" min="0"
                value={criteria.dpd_max}
                onChange={e => update('dpd_max', e.target.value)}
                placeholder="e.g. 90"
                style={inputStyle}
              />
            </div>

            {/* Outstanding range */}
            <div>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Outstanding Min (₦)</label>
              <input
                type="number" min="0"
                value={criteria.outstanding_min}
                onChange={e => update('outstanding_min', e.target.value)}
                placeholder="e.g. 50000"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>Outstanding Max (₦)</label>
              <input
                type="number" min="0"
                value={criteria.outstanding_max}
                onChange={e => update('outstanding_max', e.target.value)}
                placeholder="e.g. 5000000"
                style={inputStyle}
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: SP[2], marginTop: SP[3] }}>
            <button onClick={handlePreview} disabled={previewing || !hasAnyFilter} style={{ ...btnPrimary, opacity: !hasAnyFilter ? 0.5 : 1 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>
                {previewing ? 'refresh' : 'search'}
              </span>
              {previewing ? 'Counting…' : 'Preview Count'}
            </button>
            <button onClick={() => { setCriteria(EMPTY_CRITERIA); setPreview(null) }} style={btnSecondary}>
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>restart_alt</span>
              Reset
            </button>
          </div>
        </SectionCard>

        {/* Right panel: preview + save */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
          {/* Preview result */}
          <SectionCard title="Preview">
            {previewing ? (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '24px 0' }}>
                <Spinner size={28} />
              </div>
            ) : preview === null ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 0', gap: SP[2], color: 'var(--txt3)' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 36 }}>group</span>
                <span style={{ fontSize: TEXT.sm }}>Set filters and click Preview Count</span>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '24px 0' }}>
                <div style={{ fontSize: 44, fontWeight: FW.bold, color: preview === 0 ? RED : preview > 1000 ? AMBER : GREEN, fontFamily: SORA }}>
                  {fmtNum(preview)}
                </div>
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 6 }}>
                  {preview === 0 ? 'No matching contacts' : preview === 1 ? 'matching contact' : 'matching contacts'}
                </div>
                {preview > 5000 && (
                  <div style={{ marginTop: 8, fontSize: TEXT.xs, color: AMBER, display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'center' }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>warning</span>
                    Capped at 5,000 members on save
                  </div>
                )}
              </div>
            )}
          </SectionCard>

          {/* Save as list */}
          <SectionCard title="Save as Contact List">
            <div style={{ marginBottom: SP[2] }}>
              <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', display: 'block', marginBottom: 4 }}>List Name</label>
              <input
                value={listName}
                onChange={e => setListName(e.target.value)}
                placeholder="e.g. DPD 30-90 Salary Loans July"
                style={inputStyle}
              />
            </div>

            {/* Active filters summary */}
            {hasAnyFilter && (
              <div style={{ marginBottom: SP[2], display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {Object.entries(criteria).filter(([, v]) => v.trim()).map(([k, v]) => (
                  <span key={k} style={{
                    fontSize: TEXT.xs, padding: '2px 8px', borderRadius: RADIUS.full,
                    background: `${NAVY}12`, color: NAVY, fontWeight: FW.semibold,
                  }}>
                    {k.replace(/_/g, ' ')}: {v}
                  </span>
                ))}
              </div>
            )}

            <button
              onClick={handleCreate}
              disabled={creating || !listName.trim() || preview === null || preview === 0}
              style={{
                ...btnPrimary, width: '100%', justifyContent: 'center',
                opacity: (!listName.trim() || preview === null || preview === 0) ? 0.5 : 1,
              }}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>
                {creating ? 'refresh' : 'playlist_add'}
              </span>
              {creating ? 'Creating…' : 'Create Contact List'}
            </button>
          </SectionCard>
        </div>
      </div>
    </Page>
  )
}
