import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Page, KpiCard, SectionCard, DataTable, ErrBanner, Tabs,
  NameCell, StatusBadge, Modal,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct, fmtDate } from '../../lib/fmt'
import { NAVY, RED, GREEN, AMBER, NUM, TEXT, FW, SP, RADIUS, INTER } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CreditApp {
  id: number
  date_received: string | null
  customer_name: string
  company: string | null
  type: string
  requested_amount: number | null
  status: string
  approved_amount: number | null
  disbursed_amount: number | null
  disbursed_date: string | null
  maturity_date: string | null
  account_officer: string | null
  location: string | null
  loan_id: string | null
  tenor: number | null
  rate: number | null
  repayment_amount: number | null
  application_type: string | null
  notes: string | null
  created_at: string
  updated_at: string
  repayments?: RepaymentRow[]
  collateral?: CollateralRow[]
}

interface RepaymentRow {
  id: number
  payment_month: string
  expected_amount: number | null
  paid_amount: number | null
  payment_date: string | null
  dpd: number | null
  payment_status: string
  comment: string | null
  action_taken: string | null
}

interface CollateralRow {
  id: number
  security_type: string | null
  vehicle_info: string | null
  guarantor_name: string | null
  guarantor_phone: string | null
}

interface OverdueRow {
  id: number
  customer_name: string
  company: string | null
  type: string
  disbursed_amount: number | null
  account_officer: string | null
  payment_month: string
  expected_amount: number | null
  paid_amount: number | null
  dpd: number | null
  payment_status: string
}

interface Summary {
  total_applications: number
  approved: number
  declined: number
  pending: number
  disbursed: number
  total_requested: number
  total_approved: number
  total_disbursed: number
  approval_rate: number
  overdue_loans: number
}

// ── Status pill ────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; txt: string }> = {
  pending:    { bg: 'rgba(217,119,6,.12)',  txt: AMBER },
  incomplete: { bg: 'rgba(75,85,99,.1)',    txt: '#6B7280' },
  approved:   { bg: 'rgba(22,163,74,.12)',  txt: GREEN },
  disbursed:  { bg: 'rgba(37,99,235,.12)',  txt: '#2563EB' },
  declined:   { bg: 'rgba(192,0,0,.1)',     txt: RED },
}

function StatusPill({ status }: { status: string }) {
  const s = STATUS_COLORS[status] ?? { bg: 'rgba(75,85,99,.1)', txt: '#6B7280' }
  const label = status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px',
      borderRadius: RADIUS['2xl'], background: s.bg, color: s.txt, whiteSpace: 'nowrap',
    }}>{label}</span>
  )
}

// ── DPD badge ─────────────────────────────────────────────────────────────────

function DpdBadge({ dpd }: { dpd: number | null }) {
  if (!dpd || dpd === 0) return <span style={{ color: 'var(--txt3)' }}>0</span>
  const color = dpd > 90 ? RED : dpd > 30 ? AMBER : '#D97706'
  return <span style={{ ...NUM, fontWeight: FW.semibold, color }}>{dpd}</span>
}

// ── Application detail modal ───────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: SP[2], padding: '8px 0', borderBottom: '1px solid var(--bdr)' }}>
      <span style={{ width: 160, flexShrink: 0, fontSize: TEXT.sm, color: 'var(--txt3)', fontFamily: INTER }}>{label}</span>
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: INTER }}>{value ?? '—'}</span>
    </div>
  )
}

function AppDetailModal({ app, onClose }: { app: CreditApp; onClose: () => void }) {
  return (
    <Modal open title={`Application #${app.id}`} onClose={onClose} width={640}>
      <div>
        <DetailRow label="Customer"         value={app.customer_name} />
        <DetailRow label="Company"          value={app.company} />
        <DetailRow label="Type"             value={app.type} />
        <DetailRow label="Loan ID"          value={app.loan_id} />
        <DetailRow label="Status"           value={<StatusPill status={app.status} />} />
        <DetailRow label="Date Received"    value={fmtDate(app.date_received)} />
        <DetailRow label="Requested Amount" value={<span style={NUM}>{fmtKobo(app.requested_amount)}</span>} />
        <DetailRow label="Approved Amount"  value={<span style={NUM}>{fmtKobo(app.approved_amount)}</span>} />
        <DetailRow label="Disbursed Amount" value={<span style={NUM}>{fmtKobo(app.disbursed_amount)}</span>} />
        <DetailRow label="Disbursed Date"   value={fmtDate(app.disbursed_date)} />
        <DetailRow label="Tenor (months)"   value={app.tenor != null ? String(app.tenor) : null} />
        <DetailRow label="Rate"             value={app.rate != null ? fmtPct(app.rate) : null} />
        <DetailRow label="Repayment Amount" value={<span style={NUM}>{fmtKobo(app.repayment_amount)}</span>} />
        <DetailRow label="Maturity Date"    value={fmtDate(app.maturity_date)} />
        <DetailRow label="Account Officer"  value={app.account_officer} />
        <DetailRow label="Location"         value={app.location} />
        <DetailRow label="Notes"            value={app.notes} />

        {app.repayments && app.repayments.length > 0 && (
          <div style={{ marginTop: SP[4] }}>
            <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: SP[2] }}>
              Repayments ({app.repayments.length})
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: TEXT.xs }}>
                <thead>
                  <tr style={{ background: 'var(--th-bg)', textAlign: 'left' }}>
                    {['Month', 'Expected', 'Paid', 'DPD', 'Status'].map(h => (
                      <th key={h} style={{ padding: '6px 8px', color: 'var(--txt2)', fontWeight: FW.semibold }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {app.repayments.map(r => (
                    <tr key={r.id} style={{ borderTop: '1px solid var(--bdr)' }}>
                      <td style={{ padding: '6px 8px' }}>{r.payment_month}</td>
                      <td style={{ padding: '6px 8px', ...NUM }}>{fmtKobo(r.expected_amount)}</td>
                      <td style={{ padding: '6px 8px', ...NUM }}>{fmtKobo(r.paid_amount)}</td>
                      <td style={{ padding: '6px 8px' }}><DpdBadge dpd={r.dpd} /></td>
                      <td style={{ padding: '6px 8px' }}><StatusPill status={r.payment_status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

const STATUSES = ['pending', 'incomplete', 'approved', 'disbursed', 'declined']

export default function CreditPortfolio() {
  const [summary,   setSummary]   = useState<Summary | null>(null)
  const [apps,      setApps]      = useState<CreditApp[]>([])
  const [overdue,   setOverdue]   = useState<OverdueRow[]>([])
  const [loading,   setLoading]   = useState(true)
  const [err,       setErr]       = useState<string | null>(null)
  const [tab,       setTab]       = useState<'pipeline' | 'overdue'>('pipeline')
  const [search,    setSearch]    = useState('')
  const [fStatus,   setFStatus]   = useState('')
  const [detail,    setDetail]    = useState<CreditApp | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [total,     setTotal]     = useState(0)
  const [page,      setPage]      = useState(1)
  const PER_PAGE = 50

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setErr(null)
    try {
      const [sumRes, appsRes, overdueRes] = await Promise.all([
        apiFetch<Summary>('/api/credit-portfolio/summary'),
        apiFetch<{ data: CreditApp[]; total: number }>('/api/credit-portfolio/applications?limit=200&offset=0'),
        apiFetch<OverdueRow[]>('/api/credit-portfolio/overdue'),
      ])
      setSummary(sumRes)
      setApps(Array.isArray(appsRes) ? appsRes : (appsRes.data ?? []))
      setTotal(Array.isArray(appsRes) ? (appsRes as CreditApp[]).length : (appsRes.total ?? 0))
      setOverdue(Array.isArray(overdueRes) ? overdueRes : [])
    } catch (e: any) {
      setErr(e.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true))

  async function openDetail(id: number) {
    setDetailLoading(true)
    try {
      const res = await apiFetch<CreditApp>(`/api/credit-portfolio/applications/${id}`)
      setDetail(res)
    } catch { /* ignore */ }
    finally { setDetailLoading(false) }
  }

  // Pipeline filtering
  const filtered = useMemo(() => apps.filter(r => {
    if (fStatus && r.status !== fStatus) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        r.customer_name.toLowerCase().includes(q) ||
        (r.company ?? '').toLowerCase().includes(q) ||
        (r.loan_id ?? '').toLowerCase().includes(q)
      )
    }
    return true
  }), [apps, fStatus, search])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
  const safePage   = Math.min(page, totalPages)
  const pageRows   = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE)

  useEffect(() => { setPage(1) }, [search, fStatus])

  // Pipeline columns
  const appCols: TableCol<CreditApp>[] = [
    {
      key: 'id', label: '#', width: 70,
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY }}>#{r.id}</span>,
    },
    {
      key: 'customer_name', label: 'Applicant',
      render: r => <NameCell name={r.customer_name} sub={r.company ?? r.loan_id ?? null} />,
    },
    {
      key: 'type', label: 'Type', width: 80,
      render: r => (
        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'], background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>
          {r.type}
        </span>
      ),
    },
    {
      key: 'requested_amount', label: 'Requested', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.requested_amount)}</span>,
    },
    {
      key: 'status', label: 'Status',
      render: r => <StatusPill status={r.status} />,
    },
    {
      key: 'account_officer', label: 'Officer',
      render: r => r.account_officer
        ? <span style={{ fontSize: TEXT.sm }}>{r.account_officer}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'date_received', label: 'Received',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.date_received)}</span>,
    },
  ]

  // Overdue columns
  const overdueCols: TableCol<OverdueRow>[] = [
    {
      key: 'id', label: '#', width: 70,
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: NAVY }}>#{r.id}</span>,
    },
    {
      key: 'customer_name', label: 'Applicant',
      render: r => <NameCell name={r.customer_name} sub={r.company ?? null} />,
    },
    {
      key: 'disbursed_amount', label: 'Disbursed', align: 'right',
      render: r => <span style={{ ...NUM, fontWeight: 600 }}>{fmtKobo(r.disbursed_amount)}</span>,
    },
    {
      key: 'expected_amount', label: 'Expected', align: 'right',
      render: r => <span style={{ ...NUM }}>{fmtKobo(r.expected_amount)}</span>,
    },
    {
      key: 'paid_amount', label: 'Paid', align: 'right',
      render: r => <span style={{ ...NUM }}>{fmtKobo(r.paid_amount)}</span>,
    },
    {
      key: 'dpd', label: 'DPD', align: 'right',
      render: r => <DpdBadge dpd={r.dpd} />,
    },
    {
      key: 'payment_month', label: 'Month',
      render: r => <span style={{ fontSize: TEXT.sm }}>{r.payment_month}</span>,
    },
    {
      key: 'account_officer', label: 'Officer',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.account_officer ?? '—'}</span>,
    },
  ]

  return (
    <Page
      title="Credit Portfolio"
      subtitle="Full loan origination pipeline and performance"
    >
      <ErrBanner error={err} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Total Applications" value={fmtNum(summary?.total_applications)} icon="description"     loading={loading} />
        <KpiCard label="Total Disbursed"    value={fmtKobo(summary?.total_disbursed)}  icon="payments"        loading={loading} accent="#2563EB" />
        <KpiCard label="Overdue Loans"      value={fmtNum(summary?.overdue_loans)}     icon="warning"         loading={loading} accent={RED} />
        <KpiCard label="Approval Rate"      value={fmtPct(summary?.approval_rate)}     icon="check_circle"    loading={loading} accent={GREEN} />
      </div>

      {/* Tabs */}
      <Tabs
        tabs={[
          { key: 'pipeline', label: 'Pipeline' },
          { key: 'overdue',  label: `Overdue (${overdue.length})` },
        ]}
        active={tab}
        onChange={k => setTab(k as 'pipeline' | 'overdue')}
      />

      {tab === 'pipeline' && (
        <SectionCard
          title="Applications"
          badge={filtered.length}
          padding={false}
          style={{ marginTop: SP[3] }}
        >
          {/* Filter bar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: SP[2],
            padding: '10px 16px', borderBottom: '1px solid var(--bdr)',
            flexWrap: 'wrap',
          }}>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search applicant, company, loan ID…"
              style={{
                flex: '1 1 200px', padding: '6px 10px', borderRadius: RADIUS.sm,
                border: '1px solid var(--input-bdr)', background: 'var(--input-bg)',
                color: 'var(--txt)', fontSize: TEXT.sm, fontFamily: INTER, outline: 'none',
              }}
            />
            <select
              value={fStatus}
              onChange={e => setFStatus(e.target.value)}
              style={{
                padding: '6px 10px', borderRadius: RADIUS.sm,
                border: '1px solid var(--input-bdr)', background: 'var(--input-bg)',
                color: fStatus ? 'var(--txt)' : 'var(--txt3)',
                fontSize: TEXT.sm, fontFamily: INTER, outline: 'none',
              }}
            >
              <option value="">All Statuses</option>
              {STATUSES.map(s => (
                <option key={s} value={s}>{s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>
              ))}
            </select>
            {(search || fStatus) && (
              <button
                onClick={() => { setSearch(''); setFStatus('') }}
                style={{
                  padding: '6px 12px', borderRadius: RADIUS.sm,
                  border: '1px solid var(--bdr)', background: 'transparent',
                  color: 'var(--txt2)', fontSize: TEXT.sm, cursor: 'pointer', fontFamily: INTER,
                }}
              >
                Clear
              </button>
            )}
          </div>

          <DataTable
            cols={appCols}
            rows={pageRows}
            keyFn={r => r.id}
            loading={loading || detailLoading}
            skeletonRows={8}
            onRowClick={r => openDetail(r.id)}
            emptyText="No applications found"
          />

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 16px', borderTop: '1px solid var(--bdr)',
            }}>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
                {filtered.length === 0 ? 'No results' : `Showing ${(safePage - 1) * PER_PAGE + 1}–${Math.min(safePage * PER_PAGE, filtered.length)} of ${filtered.length}`}
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  disabled={safePage === 1}
                  onClick={() => setPage(p => p - 1)}
                  style={{ padding: '4px 10px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', cursor: safePage === 1 ? 'default' : 'pointer', fontSize: TEXT.sm }}
                >
                  Prev
                </button>
                <button
                  disabled={safePage === totalPages}
                  onClick={() => setPage(p => p + 1)}
                  style={{ padding: '4px 10px', borderRadius: RADIUS.sm, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt2)', cursor: safePage === totalPages ? 'default' : 'pointer', fontSize: TEXT.sm }}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </SectionCard>
      )}

      {tab === 'overdue' && (
        <SectionCard
          title="Overdue Loans"
          badge={overdue.length}
          padding={false}
          style={{ marginTop: SP[3] }}
        >
          <DataTable
            cols={overdueCols}
            rows={overdue}
            keyFn={(r, i) => `${r.id}-${i}`}
            loading={loading}
            skeletonRows={6}
            emptyText="No overdue loans"
          />
        </SectionCard>
      )}

      {/* Application detail modal */}
      {detail && (
        <AppDetailModal app={detail} onClose={() => setDetail(null)} />
      )}
    </Page>
  )
}
