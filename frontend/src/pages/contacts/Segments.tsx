import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner, Modal, ConfirmModal, EmptyState, btnPrimary, btnSecondary } from '../../components/UI'
import { apiFetch, apiPost, apiPut, apiDelete, unwrap } from '../../lib/api'
import { useLiveData } from '../../hooks/useRealtime'
import { fmtNum, fmtDatetime } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, RED, BLUE, MONO, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

// ── Criteria model (maps to backend segmentCriteria) ───────────────────────────

interface Criteria {
  product_type: string; stage: string; status: string; employer: string
  dpd_min: string; dpd_max: string; outstanding_min: string; outstanding_max: string
}
const EMPTY_CRITERIA: Criteria = { product_type: '', stage: '', status: '', employer: '', dpd_min: '', dpd_max: '', outstanding_min: '', outstanding_max: '' }

const PRODUCT_TYPES = ['Salary Loan', 'Individual Loan', 'Business Loan', 'Credit Card', 'Payday Loan']
const STAGES = ['submitted', 'pre-screening', 'underwriting', 'approval', 'disbursed', 'active', 'closed']
const STATUSES = ['pending', 'active', 'disbursed', 'rejected', 'cancelled', 'written_off']

interface SegmentCriteria {
  products?: string[]; stages?: string[]; statuses?: string[]; employers?: string[]
  min_dpd?: number; max_dpd?: number; min_outstanding_kobo?: number; max_outstanding_kobo?: number
}
interface SavedSegment {
  id: number; name: string; description?: string; criteria: any
  last_count?: number; last_list_id?: number; last_refreshed_at?: string
  list_name?: string; list_member_count?: number; created_by_name?: string; updated_at?: string
}

function toCriteriaObj(c: Criteria): SegmentCriteria {
  const o: SegmentCriteria = {}
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
      const imported = unwrap<{ imported: number }>(res)?.imported ?? 0
      toast.success(`Refreshed — ${fmtNum(imported)} contacts in the list`)
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
      subtitle="Saved, refreshable audiences built from the loan portfolio"
      actions={
        <button onClick={() => setBuilder({ open: true, editing: null })} style={btnPrimary}>
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
          New Segment
        </button>
      }
    >
      <ErrBanner error={err} onRetry={() => load()} />

      <SectionCard
        title="Saved segments" badge={segments.length}
        subtitle="A segment stores its filters so you can refresh its contact list any time"
      >
        {loading ? (
          <div style={{ padding: 30, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : segments.length === 0 ? (
          <EmptyState icon="groups" title="No segments yet"
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
                </div>

                <div style={{ display: 'flex', gap: 6, marginTop: 'auto', paddingTop: 10, borderTop: '1px solid var(--bdr)' }}>
                  <button onClick={() => refreshSegment(s)} disabled={refreshing === s.id}
                    style={{ ...miniBtn, background: NAVY, color: '#fff', border: 'none', opacity: refreshing === s.id ? 0.6 : 1 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 15 }}>{refreshing === s.id ? 'progress_activity' : 'refresh'}</span>
                    {refreshing === s.id ? 'Refreshing…' : (s.last_list_id ? 'Refresh' : 'Build list')}
                  </button>
                  {s.last_list_id && (
                    <button onClick={() => navigate('/campaigns/lists')} style={{ ...miniBtn, background: 'var(--card)', color: 'var(--txt2)', border: '1px solid var(--bdr)' }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 15 }}>list</span>List
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

      <ConfirmModal open={!!deleteTarget} title="Delete segment"
        body={`Delete "${deleteTarget?.name}"? The generated contact list is kept.`}
        onConfirm={doDelete} onClose={() => setDeleteTarget(null)} />
    </Page>
  )
}

// ── Builder modal ─────────────────────────────────────────────────────────────

function SegmentBuilder({ editing, onClose, onSaved }: { editing: SavedSegment | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(editing?.name ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [criteria, setCriteria] = useState<Criteria>(editing ? fromCriteriaObj(editing.criteria) : EMPTY_CRITERIA)
  const [preview, setPreview] = useState<number | null>(editing?.last_count ?? null)
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  function update(field: keyof Criteria, value: string) {
    setCriteria(prev => ({ ...prev, [field]: value }))
    setPreview(null)
  }
  const hasAnyFilter = Object.values(criteria).some(v => v.trim() !== '')

  async function handlePreview() {
    setErr(null); setPreviewing(true)
    try {
      const res = await apiFetch<any>('/api/contact-lists/segment/preview', { method: 'POST', body: JSON.stringify(toCriteriaObj(criteria)) })
      setPreview(unwrap<{ count: number }>(res)?.count ?? 0)
    } catch (e: any) { setErr(e.message ?? 'Preview failed') }
    finally { setPreviewing(false) }
  }

  async function save() {
    if (!name.trim()) { toast.error('Enter a segment name'); return }
    setSaving(true); setErr(null)
    try {
      const body = { name: name.trim(), description, criteria: toCriteriaObj(criteria) }
      if (editing) await apiPut(`/api/contact-lists/segments/${editing.id}`, body)
      else await apiPost('/api/contact-lists/segments', body)
      toast.success(editing ? 'Segment updated' : 'Segment created')
      onSaved()
    } catch (e: any) { setErr(e.message ?? 'Save failed') }
    finally { setSaving(false) }
  }

  return (
    <Modal open onClose={onClose} title={editing ? 'Edit segment' : 'New segment'} width={620}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
          <button onClick={handlePreview} disabled={previewing || !hasAnyFilter} style={{ ...btnSecondary, opacity: !hasAnyFilter ? 0.5 : 1 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{previewing ? 'progress_activity' : 'search'}</span>
            {previewing ? 'Counting…' : 'Preview count'}
          </button>
          {preview !== null && (
            <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: preview === 0 ? RED : preview > 5000 ? AMBER : GREEN }}>
              {fmtNum(preview)} contacts{preview > 5000 ? ' (capped at 5,000)' : ''}
            </span>
          )}
          <button onClick={save} disabled={saving || !name.trim()} style={{ ...btnPrimary, marginLeft: 'auto', opacity: saving || !name.trim() ? 0.6 : 1 }}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create segment'}
          </button>
        </div>
      }>
      {err && <ErrBanner error={err} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
          <div><label style={lbl}>Segment name</label><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. DPD 30–90 Salary Loans" style={inputStyle} /></div>
          <div><label style={lbl}>Description (optional)</label><input value={description} onChange={e => setDescription(e.target.value)} placeholder="What this audience is for" style={inputStyle} /></div>
        </div>

        <div style={{ height: 1, background: 'var(--bdr)' }} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
          <div><label style={lbl}>Product Type</label>
            <select value={criteria.product_type} onChange={e => update('product_type', e.target.value)} style={selectStyle}>
              <option value="">Any product</option>{PRODUCT_TYPES.map(p => <option key={p} value={p}>{p}</option>)}
            </select></div>
          <div><label style={lbl}>Stage</label>
            <select value={criteria.stage} onChange={e => update('stage', e.target.value)} style={selectStyle}>
              <option value="">Any stage</option>{STAGES.map(s => <option key={s} value={s}>{s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>)}
            </select></div>
          <div><label style={lbl}>Status</label>
            <select value={criteria.status} onChange={e => update('status', e.target.value)} style={selectStyle}>
              <option value="">Any status</option>{STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>)}
            </select></div>
          <div><label style={lbl}>Employer (contains)</label><input value={criteria.employer} onChange={e => update('employer', e.target.value)} placeholder="e.g. NNPC, Dangote…" style={inputStyle} /></div>
          <div><label style={lbl}>DPD Min</label><input type="number" min="0" value={criteria.dpd_min} onChange={e => update('dpd_min', e.target.value)} placeholder="e.g. 30" style={inputStyle} /></div>
          <div><label style={lbl}>DPD Max</label><input type="number" min="0" value={criteria.dpd_max} onChange={e => update('dpd_max', e.target.value)} placeholder="e.g. 90" style={inputStyle} /></div>
          <div><label style={lbl}>Outstanding Min (₦)</label><input type="number" min="0" value={criteria.outstanding_min} onChange={e => update('outstanding_min', e.target.value)} placeholder="e.g. 50000" style={inputStyle} /></div>
          <div><label style={lbl}>Outstanding Max (₦)</label><input type="number" min="0" value={criteria.outstanding_max} onChange={e => update('outstanding_max', e.target.value)} placeholder="e.g. 5000000" style={inputStyle} /></div>
        </div>
      </div>
    </Modal>
  )
}

// ── Small bits ────────────────────────────────────────────────────────────────

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
