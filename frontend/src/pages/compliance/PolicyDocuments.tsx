import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, ErrBanner, Spinner, btnPrimary, btnSecondary } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, GREEN, AMBER, RED, NAVY, BLUE, INTER } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ──────────────────────────────────────────────────────────────────────

interface PolicyDoc {
  id:               number
  name:             string
  category:         string
  status:           string
  owner_id:         number | null
  owner_name:       string | null
  approved_by:      number | null
  approved_by_name: string | null
  approved_at:      string | null
  next_review_date: string | null
  document_url:     string | null
  version:          string
  notes:            string | null
  sort_order:       number
  updated_at:       string
}

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_OPTS = [
  { value: 'not_drafted',  label: 'Not Drafted',  bg: '#6B728018', color: '#6B7280' },
  { value: 'in_progress',  label: 'In Progress',  bg: `${BLUE}15`, color: BLUE      },
  { value: 'under_review', label: 'Under Review', bg: `${AMBER}18`, color: AMBER    },
  { value: 'approved',     label: 'Approved',     bg: `${GREEN}18`, color: GREEN     },
  { value: 'waived',       label: 'Waived/N/A',   bg: '#6B728018',  color: '#6B7280' },
]

const CATEGORY_LABELS: Record<string, string> = {
  information_security: 'Information Security',
  incident_response:    'Incident Response',
  risk:                 'Risk Management',
  change_management:    'Change Management',
  privacy:              'Privacy & Data',
  availability:         'Availability & DR',
  third_party:          'Third Party',
  hr:                   'HR & People',
}

const inp: React.CSSProperties = {
  padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
  fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', fontFamily: INTER,
  width: '100%', boxSizing: 'border-box',
}

const sel: React.CSSProperties = { ...inp, cursor: 'pointer' }

// ── Status pill ────────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  const s = STATUS_OPTS.find(o => o.value === status) ?? STATUS_OPTS[0]
  return (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS.md,
      background: s.bg, color: s.color }}>
      {s.label}
    </span>
  )
}

// ── Review due badge ───────────────────────────────────────────────────────────

function ReviewDueBadge({ date }: { date: string | null }) {
  if (!date) return null
  const days = Math.ceil((new Date(date).getTime() - Date.now()) / 86400000)
  if (days > 60) return null
  const color = days < 0 ? RED : days <= 14 ? AMBER : GREEN
  return (
    <span style={{ fontSize: TEXT.xs, padding: '1px 6px', borderRadius: RADIUS.sm, background: `${color}18`, color, fontWeight: FW.bold, marginLeft: 6 }}>
      {days < 0 ? `Review overdue ${Math.abs(days)}d` : `Review in ${days}d`}
    </span>
  )
}

// ── Inline edit row ────────────────────────────────────────────────────────────

function PolicyRow({ doc, onSaved }: { doc: PolicyDoc; onSaved: (updated: PolicyDoc) => void }) {
  const [editing,    setEditing]    = useState(false)
  const [status,     setStatus]     = useState(doc.status)
  const [docURL,     setDocURL]     = useState(doc.document_url ?? '')
  const [reviewDate, setReviewDate] = useState(doc.next_review_date ?? '')
  const [version,    setVersion]    = useState(doc.version)
  const [notes,      setNotes]      = useState(doc.notes ?? '')
  const [saving,     setSaving]     = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      const body: Record<string, any> = { status, version }
      if (docURL)     body.document_url     = docURL
      if (reviewDate) body.next_review_date  = reviewDate
      if (notes)      body.notes            = notes
      const updated = await apiFetch<PolicyDoc>(`/api/compliance/soc2/policies/${doc.id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      })
      onSaved(updated)
      setEditing(false)
      toast.success('Policy updated')
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  function handleCancel() {
    setStatus(doc.status); setDocURL(doc.document_url ?? '')
    setReviewDate(doc.next_review_date ?? ''); setVersion(doc.version)
    setNotes(doc.notes ?? ''); setEditing(false)
  }

  const isOverdue = doc.next_review_date
    ? new Date(doc.next_review_date) < new Date() : false

  return (
    <>
      <tr style={{ borderBottom: '1px solid var(--border)',
        background: isOverdue && doc.status === 'approved' ? `${RED}06` : '' }}
        onMouseEnter={e => { if (!editing) e.currentTarget.style.background = 'var(--row-hvr)' }}
        onMouseLeave={e => { if (!editing) e.currentTarget.style.background = isOverdue && doc.status === 'approved' ? `${RED}06` : '' }}>
        <td style={{ padding: '10px 12px', fontWeight: FW.semibold, color: 'var(--txt)', maxWidth: 240 }}>
          {doc.name}
          {isOverdue && doc.status === 'approved' && (
            <span style={{ display: 'block', fontSize: TEXT.xs, color: RED, marginTop: 2 }}>⚠ Review overdue</span>
          )}
        </td>
        <td style={{ padding: '10px 12px', fontSize: TEXT.sm, color: 'var(--txt-muted)', whiteSpace: 'nowrap' }}>
          {CATEGORY_LABELS[doc.category] ?? doc.category}
        </td>
        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
          <StatusPill status={doc.status} />
        </td>
        <td style={{ padding: '10px 12px', fontSize: TEXT.sm, color: 'var(--txt-muted)', whiteSpace: 'nowrap' }}>
          {doc.owner_name ?? '—'}
        </td>
        <td style={{ padding: '10px 12px', fontSize: TEXT.sm, color: 'var(--txt-muted)', whiteSpace: 'nowrap' }}>
          {doc.approved_at ? (
            <span>{fmtDate(doc.approved_at)}</span>
          ) : '—'}
        </td>
        <td style={{ padding: '10px 12px', fontSize: TEXT.sm, color: 'var(--txt-muted)', whiteSpace: 'nowrap' }}>
          {doc.next_review_date ? (
            <>
              {fmtDate(doc.next_review_date)}
              <ReviewDueBadge date={doc.next_review_date} />
            </>
          ) : '—'}
        </td>
        <td style={{ padding: '10px 12px', fontSize: TEXT.sm, color: 'var(--txt-muted)', whiteSpace: 'nowrap' }}>v{doc.version}</td>
        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
          {doc.document_url ? (
            <a href={doc.document_url} target="_blank" rel="noreferrer" style={{ color: BLUE, fontSize: TEXT.sm }}>📄 Open</a>
          ) : (
            <span style={{ color: 'var(--txt-muted)', fontSize: TEXT.sm }}>—</span>
          )}
        </td>
        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
          <button onClick={() => setEditing(e => !e)}
            style={{ fontSize: TEXT.sm, color: BLUE, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            {editing ? 'Cancel' : 'Edit'}
          </button>
        </td>
      </tr>
      {editing && (
        <tr style={{ background: 'var(--th-bg)' }}>
          <td colSpan={9} style={{ padding: '12px 14px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: SP[3], marginBottom: SP[3] }}>
              <div>
                <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt-muted)' }}>Status</label>
                <select style={{ ...sel, marginTop: 3 }} value={status} onChange={e => setStatus(e.target.value)}>
                  {STATUS_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt-muted)' }}>Version</label>
                <input style={{ ...inp, marginTop: 3 }} value={version} onChange={e => setVersion(e.target.value)} placeholder="1.0" />
              </div>
              <div>
                <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt-muted)' }}>Next Review Date</label>
                <input type="date" style={{ ...inp, marginTop: 3 }} value={reviewDate} onChange={e => setReviewDate(e.target.value)} />
              </div>
              <div style={{ gridColumn: 'span 2' }}>
                <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt-muted)' }}>Document URL</label>
                <input style={{ ...inp, marginTop: 3 }} value={docURL} onChange={e => setDocURL(e.target.value)} placeholder="https://…" />
              </div>
              <div style={{ gridColumn: 'span 2' }}>
                <label style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt-muted)' }}>Notes</label>
                <input style={{ ...inp, marginTop: 3 }} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional notes" />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button style={btnPrimary}    onClick={handleSave}   disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
              <button style={btnSecondary}  onClick={handleCancel} disabled={saving}>Cancel</button>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Stats bar ──────────────────────────────────────────────────────────────────

function StatsBar({ docs }: { docs: PolicyDoc[] }) {
  const counts = STATUS_OPTS.reduce((acc, o) => {
    acc[o.value] = docs.filter(d => d.status === o.value).length
    return acc
  }, {} as Record<string, number>)
  const overdueCount = docs.filter(d =>
    d.status === 'approved' && d.next_review_date && new Date(d.next_review_date) < new Date()
  ).length

  return (
    <div style={{ display: 'flex', gap: SP[4], flexWrap: 'wrap', marginBottom: SP[5] }}>
      {STATUS_OPTS.map(o => (
        <div key={o.value} style={{ padding: '10px 18px', borderRadius: RADIUS.lg, background: o.bg, border: `1px solid ${o.color}30`, textAlign: 'center', minWidth: 100 }}>
          <div style={{ fontSize: TEXT['3xl'], fontWeight: FW.extrabold, color: o.color, fontVariantNumeric: 'tabular-nums' }}>{counts[o.value]}</div>
          <div style={{ fontSize: TEXT.xs, color: o.color, marginTop: 2 }}>{o.label}</div>
        </div>
      ))}
      {overdueCount > 0 && (
        <div style={{ padding: '10px 18px', borderRadius: RADIUS.lg, background: `${RED}12`, border: `1px solid ${RED}30`, textAlign: 'center', minWidth: 100 }}>
          <div style={{ fontSize: TEXT['3xl'], fontWeight: FW.extrabold, color: RED, fontVariantNumeric: 'tabular-nums' }}>{overdueCount}</div>
          <div style={{ fontSize: TEXT.xs, color: RED, marginTop: 2 }}>Review Overdue</div>
        </div>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function PolicyDocuments() {
  const [docs,     setDocs]     = useState<PolicyDoc[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [filterSt, setFilterSt] = useState('')
  const [filterCat, setFilterCat] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await apiFetch<{ data: PolicyDoc[] }>('/api/compliance/soc2/policies')
      setDocs(res?.data ?? [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  function handleSaved(updated: PolicyDoc) {
    setDocs(prev => prev.map(d => d.id === updated.id ? updated : d))
  }

  const filtered = docs.filter(d =>
    (!filterSt  || d.status === filterSt) &&
    (!filterCat || d.category === filterCat)
  )

  const categories = [...new Set(docs.map(d => d.category))].sort()

  if (loading) return <Page title="Policy Documents"><Spinner /></Page>
  if (error)   return <Page title="Policy Documents"><ErrBanner error={error} onRetry={load} /></Page>

  return (
    <Page title="Policy Documents">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: SP[5] }}>
        <h1 style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: 'var(--txt)', margin: 0, flex: 1 }}>
          Policy Documents
        </h1>
      </div>

      <StatsBar docs={docs} />

      <SectionCard>
        <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
          <select style={{ ...sel, width: 200 }} value={filterSt} onChange={e => setFilterSt(e.target.value)}>
            <option value="">All statuses</option>
            {STATUS_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select style={{ ...sel, width: 200 }} value={filterCat} onChange={e => setFilterCat(e.target.value)}>
            <option value="">All categories</option>
            {categories.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c] ?? c}</option>)}
          </select>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.base }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                {['Policy', 'Category', 'Status', 'Owner', 'Approved', 'Next Review', 'Version', 'Document', ''].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: FW.semibold,
                    fontSize: TEXT.xs, color: 'var(--txt-muted)', whiteSpace: 'nowrap',
                    borderBottom: '1px solid var(--border)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(doc => (
                <PolicyRow key={doc.id} doc={doc} onSaved={handleSaved} />
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={9} style={{ padding: 32, textAlign: 'center', color: 'var(--txt-muted)' }}>No policies match the filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/* SOC 2 Guidance */}
      <SectionCard>
        <h3 style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)', margin: '0 0 10px' }}>SOC 2 Policy Guidance</h3>
        <p style={{ fontSize: TEXT.base, color: 'var(--txt-muted)', lineHeight: 1.6, margin: 0 }}>
          SOC 2 Type II requires all listed policies to be formally approved before the observation period begins.
          Policies should be reviewed at least annually. Once approved, set a review date 12 months out.
          Upload the signed policy document URL so auditors can verify the artefact during evidence collection.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginTop: 14 }}>
          {[
            { label: 'Priority 1 — Before Obs. Period', items: ['Information Security Policy', 'Incident Response Plan', 'Password and Access Control Policy'] },
            { label: 'Priority 2 — Before Audit', items: ['Data Classification Policy', 'Change Management Policy', 'Risk Management Policy'] },
            { label: 'Priority 3 — Year 1', items: ['Business Continuity and DR Plan', 'Vendor Management Policy', 'Data Retention and Disposal Policy'] },
          ].map(group => (
            <div key={group.label} style={{ background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: '12px 14px' }}>
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: NAVY, marginBottom: SP[2] }}>{group.label}</div>
              {group.items.map(item => {
                const d = docs.find(d => d.name === item)
                return (
                  <div key={item} style={{ fontSize: TEXT.sm, color: 'var(--txt)', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: d?.status === 'approved' ? GREEN : AMBER, fontSize: TEXT.md }}>
                      {d?.status === 'approved' ? '✓' : '○'}
                    </span>
                    {item}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </SectionCard>
    </Page>
  )
}
