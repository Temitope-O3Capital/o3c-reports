import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner, Modal, btnPrimary, btnSecondary, DateFilter } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtDate, monthStart, today } from '../../lib/fmt'
import { TEXT, FW, SP, RADIUS, GREEN, AMBER, RED, NAVY, BLUE, INTER } from '../../lib/design'
import { toast } from 'sonner'

// ── Types ──────────────────────────────────────────────────────────────────────

interface SOC2Overview {
  by_criteria: CriteriaRow[]
  totals:      TotalsRow
  policies:    { total: number; approved: number; pending: number }
  findings:    { open_critical: number; open_high: number; overdue: number }
}

interface CriteriaRow {
  trust_criteria: string
  total:          number
  done:           number
  in_progress:    number
  not_started:    number
  waived:         number
}

interface TotalsRow {
  total:       number
  done:        number
  in_progress: number
  not_started: number
  waived:      number
}

interface SOC2Control {
  id:               number
  criteria_code:    string
  criteria_group:   string
  trust_criteria:   string
  title:            string
  description:      string
  status:           string
  control_type:     string
  frequency:        string
  owner_name:       string | null
  target_date:      string | null
  completed_at:     string | null
  evidence_count:   number
  evidence_summary: string | null
}

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  complete:    { bg: `${GREEN}18`,  color: GREEN, label: 'Complete'     },
  in_progress: { bg: `${BLUE}15`,   color: BLUE,  label: 'In Progress'  },
  not_started: { bg: '#6B728020',   color: '#6B7280', label: 'Not Started' },
  waived:      { bg: `${AMBER}18`,  color: AMBER, label: 'Waived'       },
}

const CRITERIA_LABELS: Record<string, string> = {
  security:        'Security (CC)',
  availability:    'Availability (A1)',
  confidentiality: 'Confidentiality (C1)',
}

const inp: React.CSSProperties = {
  padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
  fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', fontFamily: INTER,
  width: '100%', boxSizing: 'border-box',
}

const sel: React.CSSProperties = { ...inp, cursor: 'pointer' }

// ── Stat chip ──────────────────────────────────────────────────────────────────

function StatChip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 72 }}>
      <div style={{ fontSize: TEXT['3xl'], fontWeight: FW.extrabold, color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: TEXT.xs, color: 'var(--txt-muted)', marginTop: 2 }}>{label}</div>
    </div>
  )
}

// ── Readiness ring ─────────────────────────────────────────────────────────────

function ReadinessRing({ pct, size = 80 }: { pct: number; size?: number }) {
  const r = (size - 10) / 2
  const circ = 2 * Math.PI * r
  const dash = (pct / 100) * circ
  const color = pct >= 75 ? GREEN : pct >= 40 ? AMBER : RED
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--border)" strokeWidth={8} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={8}
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        style={{ transition: 'stroke-dasharray .5s ease' }} />
      <text x={size/2} y={size/2} textAnchor="middle" dominantBaseline="central"
        style={{ transform: 'rotate(90deg)', transformOrigin: `${size/2}px ${size/2}px`,
                 fontSize: TEXT.md, fontWeight: FW.extrabold, fill: color, fontFamily: INTER }}>
        {pct}%
      </text>
    </svg>
  )
}

// ── Status pill ────────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.not_started
  return (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS.md, ...s }}>
      {s.label}
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function SOC2() {
  const navigate = useNavigate()
  const [overview,  setOverview]  = useState<SOC2Overview | null>(null)
  const [controls,  setControls]  = useState<SOC2Control[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [filterSt,  setFilterSt]  = useState('')
  const [filterCr,  setFilterCr]  = useState('')
  const [showNew,   setShowNew]   = useState(false)
  const [dateFrom,  setDateFrom]  = useState(monthStart())
  const [dateTo,    setDateTo]    = useState(today())
  const [saving,    setSaving]    = useState(false)
  const [newCode,   setNewCode]   = useState('')
  const [newGroup,  setNewGroup]  = useState('')
  const [newCrit,   setNewCrit]   = useState('security')
  const [newTitle,  setNewTitle]  = useState('')
  const [newDesc,   setNewDesc]   = useState('')
  const [newType,   setNewType]   = useState('preventive')
  const [newFreq,   setNewFreq]   = useState('continuous')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const p = new URLSearchParams()
      if (dateFrom) p.set('from', dateFrom)
      if (dateTo)   p.set('to', dateTo)
      const [ovRes, ctrlRes] = await Promise.all([
        apiFetch<{ data: SOC2Overview }>('/api/compliance/soc2/overview'),
        apiFetch<{ data: SOC2Control[] }>(`/api/compliance/soc2/controls?${p}`),
      ])
      setOverview(ovRes?.data ?? null)
      setControls(ctrlRes?.data ?? [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  const filtered = controls.filter(c =>
    (!filterSt || c.status === filterSt) &&
    (!filterCr || c.trust_criteria === filterCr)
  )

  const totals = overview?.totals
  const pctComplete = totals && totals.total > 0
    ? Math.round((totals.done / totals.total) * 100) : 0

  async function handleExport() {
    const token = localStorage.getItem('token')
    const url = '/api/compliance/soc2/export'
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const blob = await res.blob()
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `soc2-controls-${new Date().toISOString().slice(0,10)}.csv`
    a.click()
  }

  async function handleCreate() {
    if (!newCode.trim() || !newTitle.trim()) { toast.error('Code and title are required'); return }
    setSaving(true)
    try {
      await apiFetch('/api/compliance/soc2/controls', {
        method: 'POST',
        body: JSON.stringify({ criteria_code: newCode, criteria_group: newGroup,
          trust_criteria: newCrit, title: newTitle, description: newDesc,
          control_type: newType, frequency: newFreq }),
      })
      toast.success('Control added')
      setShowNew(false)
      setNewCode(''); setNewGroup(''); setNewTitle(''); setNewDesc('')
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  if (loading) return <Page title="SOC 2 Readiness"><Spinner /></Page>
  if (error)   return <Page title="SOC 2 Readiness"><ErrBanner error={error} onRetry={load} /></Page>

  return (
    <Page title="SOC 2 Type II Readiness">
      {/* ── Header bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: SP[5], flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color: 'var(--txt)', margin: 0, flex: 1 }}>
          SOC 2 Type II Readiness
        </h1>
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
        <button style={btnSecondary} onClick={handleExport}>Export CSV</button>
        <button style={btnPrimary}   onClick={() => setShowNew(true)}>+ Add Control</button>
      </div>

      {/* ── Overview stat cards ── */}
      {totals && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: SP[4], marginBottom: SP[6] }}>
          {/* Overall readiness */}
          <SectionCard>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[5] }}>
              <ReadinessRing pct={pctComplete} />
              <div>
                <div style={{ fontSize: TEXT.base, color: 'var(--txt-muted)', marginBottom: 6 }}>Overall Readiness</div>
                <div style={{ display: 'flex', gap: SP[5] }}>
                  <StatChip label="Complete"    value={totals.done}        color={GREEN} />
                  <StatChip label="In Progress" value={totals.in_progress} color={BLUE}  />
                  <StatChip label="Not Started" value={totals.not_started} color={'var(--txt-muted)'} />
                </div>
              </div>
            </div>
          </SectionCard>

          {/* Per-criteria rings */}
          {overview?.by_criteria.map(cr => {
            const pct = cr.total > 0 ? Math.round((cr.done / cr.total) * 100) : 0
            return (
              <SectionCard key={cr.trust_criteria}>
                <div style={{ display: 'flex', alignItems: 'center', gap: SP[4] }}>
                  <ReadinessRing pct={pct} size={64} />
                  <div>
                    <div style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt-muted)', marginBottom: SP[1] }}>
                      {CRITERIA_LABELS[cr.trust_criteria] ?? cr.trust_criteria}
                    </div>
                    <div style={{ fontSize: TEXT.base, color: 'var(--txt)' }}>
                      {cr.done}/{cr.total} controls complete
                    </div>
                    {cr.in_progress > 0 && (
                      <div style={{ fontSize: TEXT.sm, color: BLUE, marginTop: 2 }}>{cr.in_progress} in progress</div>
                    )}
                  </div>
                </div>
              </SectionCard>
            )
          })}

          {/* Policy docs */}
          <SectionCard>
            <div style={{ fontSize: TEXT.base, color: 'var(--txt-muted)', marginBottom: SP[2], fontWeight: FW.semibold }}>Policy Documents</div>
            <div style={{ display: 'flex', gap: SP[4] }}>
              <StatChip label="Approved" value={overview?.policies.approved ?? 0} color={GREEN} />
              <StatChip label="Pending"  value={overview?.policies.pending ?? 0}  color={AMBER}  />
              <StatChip label="Total"    value={overview?.policies.total ?? 0}    color={'var(--txt)'} />
            </div>
            <button onClick={() => navigate('/compliance/policies')}
              style={{ marginTop: SP[3], fontSize: TEXT.sm, color: BLUE, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              Manage Policies →
            </button>
          </SectionCard>

          {/* Open pentest findings */}
          <SectionCard>
            <div style={{ fontSize: TEXT.base, color: 'var(--txt-muted)', marginBottom: SP[2], fontWeight: FW.semibold }}>Open Pentest Findings</div>
            <div style={{ display: 'flex', gap: SP[4] }}>
              <StatChip label="Critical" value={overview?.findings.open_critical ?? 0} color={RED}   />
              <StatChip label="High"     value={overview?.findings.open_high ?? 0}     color={AMBER}  />
              <StatChip label="Overdue"  value={overview?.findings.overdue ?? 0}       color={RED}    />
            </div>
            <button onClick={() => navigate('/compliance/pentest')}
              style={{ marginTop: SP[3], fontSize: TEXT.sm, color: BLUE, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              View Pentest Tracker →
            </button>
          </SectionCard>
        </div>
      )}

      {/* ── Control register ── */}
      <SectionCard>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: SP[4], flexWrap: 'wrap' }}>
          <span style={{ fontWeight: FW.bold, fontSize: 15, color: 'var(--txt)', flex: 1 }}>Control Register</span>
          <select style={{ ...sel, width: 160 }} value={filterSt} onChange={e => setFilterSt(e.target.value)}>
            <option value="">All statuses</option>
            <option value="complete">Complete</option>
            <option value="in_progress">In Progress</option>
            <option value="not_started">Not Started</option>
            <option value="waived">Waived</option>
          </select>
          <select style={{ ...sel, width: 200 }} value={filterCr} onChange={e => setFilterCr(e.target.value)}>
            <option value="">All criteria</option>
            <option value="security">Security (CC)</option>
            <option value="availability">Availability (A1)</option>
            <option value="confidentiality">Confidentiality (C1)</option>
          </select>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.base }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                {['Code', 'Title', 'Criteria', 'Type', 'Status', 'Owner', 'Target', 'Evidence', ''].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: FW.semibold,
                    fontSize: TEXT.xs, color: 'var(--txt-muted)', whiteSpace: 'nowrap',
                    borderBottom: '1px solid var(--border)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
                  onMouseLeave={e => (e.currentTarget.style.background = '')}>
                  <td style={{ padding: '9px 12px', fontFamily: 'monospace', fontSize: TEXT.sm, color: NAVY, fontWeight: FW.bold, whiteSpace: 'nowrap' }}>{c.criteria_code}</td>
                  <td style={{ padding: '9px 12px', maxWidth: 280 }}>
                    <div style={{ fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 2 }}>{c.title}</div>
                    {c.evidence_summary && (
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt-muted)', lineHeight: 1.4,
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {c.evidence_summary}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', color: 'var(--txt-muted)', fontSize: TEXT.sm }}>
                    {CRITERIA_LABELS[c.trust_criteria] ?? c.trust_criteria}
                  </td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', color: 'var(--txt-muted)', fontSize: TEXT.sm, textTransform: 'capitalize' }}>{c.control_type}</td>
                  <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}><StatusPill status={c.status} /></td>
                  <td style={{ padding: '9px 12px', color: 'var(--txt-muted)', fontSize: TEXT.sm, whiteSpace: 'nowrap' }}>{c.owner_name ?? '—'}</td>
                  <td style={{ padding: '9px 12px', color: 'var(--txt-muted)', fontSize: TEXT.sm, whiteSpace: 'nowrap' }}>{c.target_date ? fmtDate(c.target_date) : '—'}</td>
                  <td style={{ padding: '9px 12px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ background: c.evidence_count > 0 ? `${GREEN}18` : 'var(--th-bg)',
                      color: c.evidence_count > 0 ? GREEN : 'var(--txt-muted)',
                      padding: '2px 8px', borderRadius: RADIUS.md, fontSize: TEXT.xs, fontWeight: FW.bold }}>
                      {c.evidence_count}
                    </span>
                  </td>
                  <td style={{ padding: '9px 12px' }}>
                    <button onClick={() => navigate(`/compliance/soc2/${c.id}`)}
                      style={{ fontSize: TEXT.sm, color: BLUE, background: 'none', border: 'none', cursor: 'pointer', padding: 0, whiteSpace: 'nowrap' }}>
                      View →
                    </button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={9} style={{ padding: 32, textAlign: 'center', color: 'var(--txt-muted)' }}>No controls match the filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {/* ── New control modal ── */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="Add Custom Control">
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt-muted)' }}>Criteria Code *</label>
              <input style={{ ...inp, marginTop: SP[1] }} value={newCode} onChange={e => setNewCode(e.target.value)} placeholder="e.g. CC6.9" />
            </div>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt-muted)' }}>Criteria Group</label>
              <input style={{ ...inp, marginTop: SP[1] }} value={newGroup} onChange={e => setNewGroup(e.target.value)} placeholder="e.g. CC6" />
            </div>
          </div>
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt-muted)' }}>Trust Criteria</label>
            <select style={{ ...sel, marginTop: SP[1] }} value={newCrit} onChange={e => setNewCrit(e.target.value)}>
              <option value="security">Security</option>
              <option value="availability">Availability</option>
              <option value="confidentiality">Confidentiality</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt-muted)' }}>Title *</label>
            <input style={{ ...inp, marginTop: SP[1] }} value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Control title" />
          </div>
          <div>
            <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt-muted)' }}>Description</label>
            <textarea spellCheck={false} data-gramm="false" data-gramm_editor="false" style={{ ...inp, marginTop: SP[1], resize: 'vertical', minHeight: 80 }} value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="What this control does…" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt-muted)' }}>Control Type</label>
              <select style={{ ...sel, marginTop: SP[1] }} value={newType} onChange={e => setNewType(e.target.value)}>
                <option value="preventive">Preventive</option>
                <option value="detective">Detective</option>
                <option value="corrective">Corrective</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt-muted)' }}>Frequency</label>
              <select style={{ ...sel, marginTop: SP[1] }} value={newFreq} onChange={e => setNewFreq(e.target.value)}>
                <option value="continuous">Continuous</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="annual">Annual</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: SP[2] }}>
            <button style={btnSecondary} onClick={() => setShowNew(false)} disabled={saving}>Cancel</button>
            <button style={btnPrimary}   onClick={handleCreate}             disabled={saving}>{saving ? 'Saving…' : 'Add Control'}</button>
          </div>
        </div>
      </Modal>
    </Page>
  )
}
