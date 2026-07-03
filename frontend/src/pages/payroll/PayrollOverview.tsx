import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, KpiCard, SectionCard, DataTable, FilterBar, filterInputStyle,
  Modal, ConfirmModal, ErrBanner, Spinner, StatusBadge, btnPrimary,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, BLUE, NUM } from '../../lib/design'
import { toast } from 'sonner'
import type { AuthUser } from '../../hooks/useAuth'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PayrollRun {
  id: number
  period_year: number
  period_month: number
  status: string
  headcount: number
  total_gross_kobo: number
  total_net_kobo: number
  total_paye_kobo: number
  total_pension_kobo: number
  created_at: string
  approved_at?: string
  paid_at?: string
  created_by_name?: string
}

interface SummaryData {
  runs: PayrollRun[]
  active_employees: number
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

const STATUS_STYLE: Record<string, { color: string; bg: string; label: string }> = {
  draft:    { color: '#6B7280', bg: 'rgba(75,85,99,.1)',     label: 'Draft' },
  review:   { color: AMBER,    bg: `${AMBER}18`,             label: 'In Review' },
  approved: { color: BLUE,     bg: `${BLUE}12`,              label: 'Approved' },
  paid:     { color: GREEN,    bg: 'rgba(22,163,74,.12)',     label: 'Paid' },
}

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.draft
  return (
    <span style={{
      ...NUM, display: 'inline-flex', alignItems: 'center', fontSize: 11, fontWeight: 700,
      padding: '2px 8px', borderRadius: 20, background: s.bg, color: s.color, whiteSpace: 'nowrap',
    }}>
      {s.label}
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function PayrollOverview() {
  const navigate = useNavigate()
  const storedUser = localStorage.getItem('auth_user')
  const userRole = storedUser ? (JSON.parse(storedUser) as AuthUser).role : ''
  const canCreate = ['payroll_officer', 'payroll_manager', 'hr_manager', 'admin', 'cfo'].includes(userRole)

  const [data, setData] = useState<SummaryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const [newOpen, setNewOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [year, setYear] = useState(new Date().getFullYear())
  const [month, setMonth] = useState(new Date().getMonth() + 1)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const d = await apiFetch<SummaryData>('/api/payroll/summary')
      setData(d)
    } catch (e: any) { setErr(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleCreate() {
    setCreating(true)
    try {
      const res = await apiPost<{ id: number; headcount: number }>('/api/payroll/runs', {
        period_year: year, period_month: month,
      })
      toast.success(`Payroll run created — ${res.headcount} employees included`)
      setNewOpen(false)
      navigate(`/payroll/runs/${res.id}`)
    } catch (e: any) {
      toast.error(e.message)
    } finally { setCreating(false) }
  }

  const runs = data?.runs ?? []
  const latest = runs[0]

  function exportRunsCsv(rows: PayrollRun[]) {
    const header = ['Period', 'Status', 'Headcount', 'Gross', 'Net Pay', 'PAYE', 'Pension', 'Created', 'Paid']
    const lines = rows.map(r => [
      `${MONTHS[r.period_month]} ${r.period_year}`,
      r.status ?? '',
      r.headcount ?? 0,
      r.total_gross_kobo / 100,
      r.total_net_kobo / 100,
      r.total_paye_kobo / 100,
      r.total_pension_kobo / 100,
      r.created_at ?? '',
      r.paid_at ?? '',
    ].join(','))
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `payroll-runs-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  }

  const thisYear = new Date().getFullYear()
  const yearOptions = [thisYear - 1, thisYear, thisYear + 1]

  // ── Table columns ─────────────────────────────────────────────────────────

  const cols: TableCol<PayrollRun>[] = [
    {
      key: 'period_year', label: 'Period',
      render: r => (
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt)' }}>
          {MONTHS[r.period_month]} {r.period_year}
        </span>
      ),
    },
    {
      key: 'status', label: 'Status',
      render: r => <StatusPill status={r.status} />,
    },
    {
      key: 'headcount', label: 'Headcount', align: 'right',
      render: r => <span style={NUM}>{r.headcount}</span>,
    },
    {
      key: 'total_gross_kobo', label: 'Gross', align: 'right',
      render: r => <span style={NUM}>{fmtKobo(r.total_gross_kobo)}</span>,
    },
    {
      key: 'total_net_kobo', label: 'Net Pay', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600, color: GREEN }}>{fmtKobo(r.total_net_kobo)}</span>,
    },
    {
      key: 'total_paye_kobo', label: 'PAYE', align: 'right',
      render: r => <span style={NUM}>{fmtKobo(r.total_paye_kobo)}</span>,
    },
    {
      key: 'created_at', label: 'Created',
      render: r => <span style={{ fontSize: 12.5, color: 'var(--txt2)' }}>{fmtDate(r.created_at)}</span>,
    },
    {
      key: 'paid_at', label: 'Paid',
      render: r => r.paid_at
        ? <span style={{ fontSize: 12, color: GREEN, fontWeight: 600 }}>{fmtDate(r.paid_at)}</span>
        : <span style={{ fontSize: 12, color: 'var(--txt3)' }}>—</span>,
    },
  ]

  return (
    <Page
      title="Payroll"
      subtitle="Monthly payroll runs and processing"
      actions={
        canCreate ? (
          <button onClick={() => setNewOpen(true)} style={btnPrimary}>
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
            New Payroll Run
          </button>
        ) : undefined
      }
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 20 }}>
        <KpiCard label="Active Employees" value={data?.active_employees ?? 0}               icon="group"          accent={NAVY} loading={loading} />
        <KpiCard label="Gross Payroll (Latest)" value={latest ? fmtKobo(latest.total_gross_kobo) : '—'}  icon="payments"       accent={NAVY} loading={loading} />
        <KpiCard label="Net Pay (Latest)"    value={latest ? fmtKobo(latest.total_net_kobo) : '—'}    icon="account_balance_wallet" accent={GREEN} loading={loading} />
        <KpiCard label="PAYE Deducted (Latest)" value={latest ? fmtKobo(latest.total_paye_kobo) : '—'} icon="receipt_long"   accent={AMBER} loading={loading} />
      </div>

      <SectionCard title="Payroll Run History" badge={runs.length} padding={false}>
        <DataTable<PayrollRun>
          cols={cols}
          rows={runs}
          keyFn={r => r.id}
          onRowClick={r => navigate(`/payroll/runs/${r.id}`)}
          emptyText="No payroll runs yet. Create the first run to get started."
          skeletonRows={loading ? 6 : 0}
        />
      </SectionCard>

      {/* New Run modal */}
      <Modal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="New Payroll Run"
        width={420}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setNewOpen(false)}
              style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: 13, cursor: 'pointer' }}>
              Cancel
            </button>
            <button onClick={handleCreate} disabled={creating}
              style={{ ...btnPrimary, opacity: creating ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {creating && <Spinner size={14} color="#fff" />}
              Create Run
            </button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--txt2)', lineHeight: 1.5 }}>
            A new payroll run will snapshot all active employees and compute gross, deductions, and net pay.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Year</label>
              <select value={year} onChange={e => setYear(Number(e.target.value))} style={{ ...filterInputStyle, width: '100%', height: 36, padding: '0 10px' }}>
                {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--txt2)', display: 'block', marginBottom: 5 }}>Month</label>
              <select value={month} onChange={e => setMonth(Number(e.target.value))} style={{ ...filterInputStyle, width: '100%', height: 36, padding: '0 10px' }}>
                {MONTHS.slice(1).map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
              </select>
            </div>
          </div>
        </div>
      </Modal>
    </Page>
  )
}
