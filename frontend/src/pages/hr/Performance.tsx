import { useState, useEffect, useCallback } from 'react'
import {
  Page, SectionCard, DataTable, FilterBar, filterInputStyle,
  Modal, ErrBanner, Spinner, StatusBadge, btnPrimary,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, NUM } from '../../lib/design'
import { toast } from 'sonner'
import type { AuthUser } from '../../hooks/useAuth'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Appraisal {
  id: number
  employee_name: string
  department?: string
  period: string
  score: number
  rating?: string
  reviewer_name?: string
  status: string
  created_at: string
  notes?: string
}

interface ReviewCycle {
  id: number
  name: string
  start_date: string
  end_date: string
  status: string
}

// ── Rating pill ────────────────────────────────────────────────────────────────

function ratingColor(score: number) {
  if (score >= 4.5) return GREEN
  if (score >= 3.5) return BLUE
  if (score >= 2.5) return AMBER
  return RED
}

function RatingPill({ score }: { score: number }) {
  const color = ratingColor(score)
  const label = score >= 4.5 ? 'Outstanding' : score >= 3.5 ? 'Good' : score >= 2.5 ? 'Satisfactory' : 'Needs Improvement'
  return (
    <span style={{ ...NUM, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: `${color}14`, color }}>
      ★ {score.toFixed(1)} · {label}
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

const BLANK = { employee_id: '', period: '', score: 3, notes: '' }

export default function Performance() {
  const storedUser = localStorage.getItem('auth_user')
  const userRole = storedUser ? (JSON.parse(storedUser) as AuthUser).role : ''
  const canCreate = ['hr_manager', 'head_hr', 'admin'].includes(userRole)

  const [appraisals, setAppraisals]     = useState<Appraisal[]>([])
  const [cycles, setCycles]             = useState<ReviewCycle[]>([])
  const [loading, setLoading]           = useState(true)
  const [err, setErr]                   = useState<string | null>(null)
  const [periodFilter, setPeriodFilter] = useState('')
  const [deptFilter, setDeptFilter]     = useState('')

  const [newOpen, setNewOpen] = useState(false)
  const [form, setForm]       = useState(BLANK)
  const [saving, setSaving]   = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const p = new URLSearchParams()
      if (periodFilter) p.set('period', periodFilter)
      if (deptFilter)   p.set('department', deptFilter)
      const [apps, cs] = await Promise.all([
        apiFetch<Appraisal[]>(`/api/hr/appraisals?${p}`),
        apiFetch<ReviewCycle[]>('/api/hr/review-cycles'),
      ])
      setAppraisals(Array.isArray(apps) ? apps : [])
      setCycles(Array.isArray(cs) ? cs : [])
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [periodFilter, deptFilter])

  useEffect(() => { load() }, [load])

  async function handleCreate() {
    if (!form.period || !form.employee_id) { toast.error('Employee and period are required'); return }
    setSaving(true)
    try {
      await apiPost('/api/hr/appraisals', form)
      toast.success('Appraisal recorded')
      setNewOpen(false); setForm(BLANK); load()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  // Build dept score chart data
  const deptScores = Object.entries(
    appraisals.reduce<Record<string, number[]>>((acc, a) => {
      const d = a.department ?? 'Unknown'
      acc[d] = [...(acc[d] ?? []), a.score]
      return acc
    }, {})
  ).map(([dept, scores]) => ({ dept, avg: +(scores.reduce((s, v) => s + v, 0) / scores.length).toFixed(2) }))

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: 7,
    fontSize: 13, background: 'var(--input-bg)', color: 'var(--txt)', outline: 'none', boxSizing: 'border-box',
  }

  const cols: TableCol<Appraisal>[] = [
    {
      key: 'employee_name', label: 'Employee',
      render: r => <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>{r.employee_name}</span>,
    },
    {
      key: 'department', label: 'Department',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.department ?? '—'}</span>,
    },
    {
      key: 'period', label: 'Period',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt)' }}>{r.period}</span>,
    },
    {
      key: 'score', label: 'Rating',
      render: r => <RatingPill score={r.score} />,
    },
    {
      key: 'reviewer_name', label: 'Reviewer',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{r.reviewer_name ?? '—'}</span>,
    },
    {
      key: 'status', label: 'Status',
      render: r => <StatusBadge status={r.status} size="sm" />,
    },
  ]

  const periods = [...new Set(appraisals.map(a => a.period))].filter(Boolean)

  return (
    <Page
      title="Performance"
      subtitle="Employee appraisals and review cycles"
      actions={
        canCreate ? (
          <button onClick={() => { setForm(BLANK); setNewOpen(true) }} style={btnPrimary}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
            New Review
          </button>
        ) : undefined
      }
    >
      <ErrBanner error={err} onRetry={load} />

      <FilterBar onReset={() => { setPeriodFilter(''); setDeptFilter('') }}>
        <select value={periodFilter} onChange={e => setPeriodFilter(e.target.value)} style={filterInputStyle}>
          <option value="">All Periods</option>
          {periods.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </FilterBar>

      {/* Score distribution chart */}
      {deptScores.length > 0 && (
        <SectionCard title="Avg Score by Department" subtitle="0–5 scale">
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={deptScores} margin={{ top: 4, right: 8, bottom: 30, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
              <XAxis dataKey="dept" tick={{ fontSize: 11, fill: 'var(--txt2)' }} angle={-30} textAnchor="end" interval={0} />
              <YAxis domain={[0, 5]} tick={{ fontSize: 11, fill: 'var(--txt2)' }} />
              <Tooltip contentStyle={{ fontSize: 12, background: 'var(--card)', border: '1px solid var(--bdr)' }} />
              <Bar dataKey="avg" fill={NAVY} radius={[4, 4, 0, 0]} name="Avg Score" />
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>
      )}

      <SectionCard title="Appraisals" badge={appraisals.length} padding={false}>
        <DataTable<Appraisal>
          cols={cols}
          rows={appraisals}
          keyFn={r => r.id}
          emptyText="No appraisals found."
          skeletonRows={loading ? 6 : 0}
        />
      </SectionCard>

      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="Record Appraisal" width={440}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setNewOpen(false)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
            <button onClick={handleCreate} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {saving && <Spinner size={14} color="#fff" />}
              Save
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Employee ID *</label>
            <input value={form.employee_id} onChange={e => setForm(f => ({ ...f, employee_id: e.target.value }))}
              placeholder="Enter employee ID" style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Period *</label>
            <input value={form.period} onChange={e => setForm(f => ({ ...f, period: e.target.value }))}
              placeholder="e.g. Q2 2025" style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>
              Score: {form.score} / 5
            </label>
            <input type="range" min={1} max={5} step={0.5} value={form.score}
              onChange={e => setForm(f => ({ ...f, score: Number(e.target.value) }))}
              style={{ width: '100%' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--txt3)', marginTop: 2 }}>
              <span>1 – Poor</span><span>3 – Average</span><span>5 – Excellent</span>
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Notes</label>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={3} placeholder="Review notes…" style={{ ...inputStyle, resize: 'vertical' }} />
          </div>
        </div>
      </Modal>
    </Page>
  )
}
