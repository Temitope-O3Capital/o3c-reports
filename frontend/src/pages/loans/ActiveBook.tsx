import { useLiveData } from "../../hooks/useRealtime"
import { useDebouncedValue } from '../../hooks/useDebounce'
import { useEffect, useState, useCallback } from 'react'
import type { CSSProperties } from 'react'
import {
  Page, KpiCard, SectionCard, DataTable, ErrBanner,
  FilterBar, filterInputStyle, SearchInput,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtKobo, fmtDate } from '../../lib/fmt'
import { RED, GREEN, AMBER, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ──────────────────────────────────────────────────────────────────────

interface LoanSummary {
  total_loans:            number
  total_outstanding_kobo: number
  total_disbursed_kobo:   number
  current_count:          number
  dpd_1_30:               number
  dpd_31_60:              number
  dpd_61_90:              number
  dpd_90plus:             number
  npl_outstanding_kobo:   number
}

interface LoanRow {
  id:                     string | number
  reference:              string
  applicant_cif:          string
  applicant_name:         string
  applicant_phone:        string
  product_type:           string
  loan_product:           string
  amount_approved_kobo:   number
  disbursed_amount_kobo:  number
  outstanding_kobo:       number
  dpd:                    number | null
  next_due_date:          string | null
  monthly_repayment_kobo: number
  maturity_date:          string | null
  disbursed_at:           string
  created_at:             string
  date_booked:            string | null
  first_installment_date: string | null
  collateral_type:        string | null
  collateral_description: string | null
  collateral_valuation_kobo: number | null
  ledger_balance_kobo:    number | null
  interest_frequency:     string | null
  lending_model:          string | null
  officer_name:           string
}

// ── DPD stage ─────────────────────────────────────────────────────────────────

function dpdStage(dpd: number | null): { label: string; color: string } {
  if (!dpd || dpd <= 0) return { label: 'Current',   color: GREEN         }
  if (dpd <= 30)        return { label: '1–30 DPD',  color: AMBER         }
  if (dpd <= 60)        return { label: '31–60 DPD', color: '#D97706'     }
  if (dpd <= 90)        return { label: '61–90 DPD', color: '#B45309'     }
  return                       { label: 'NPL (90+)', color: RED           }
}

// ── Table columns ──────────────────────────────────────────────────────────────

const LOAN_COLS: TableCol<LoanRow>[] = [
  {
    key: 'applicant_cif', label: 'CIF',
    render: r => <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.applicant_cif ?? '—'}</span>,
  },
  {
    key: 'applicant_name', label: 'Customer',
    render: r => <span style={{ fontWeight: FW.medium, color: 'var(--txt)' }}>{r.applicant_name ?? '—'}</span>,
  },
  {
    key: 'product_type', label: 'Product',
    render: r => (
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {r.product_type ?? r.loan_product ?? '—'}
        {r.collateral_type && (
          <span
            title={`Secured: ${r.collateral_type}${r.collateral_description ? ' — ' + r.collateral_description : ''}`}
            style={{
              fontSize: 10, fontWeight: FW.semibold, letterSpacing: 0.3,
              padding: '1px 6px', borderRadius: RADIUS.full,
              background: `${GREEN}1a`, color: GREEN, whiteSpace: 'nowrap',
            }}
          >
            SECURED
          </span>
        )}
      </span>
    ),
  },
  {
    key: 'disbursed_amount_kobo', label: 'Disbursed', align: 'right',
    render: r => <span style={{ ...NUM }}>{fmtKobo(r.disbursed_amount_kobo)}</span>,
  },
  {
    key: 'outstanding_kobo', label: 'Outstanding', align: 'right',
    render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(r.outstanding_kobo)}</span>,
  },
  {
    key: 'dpd', label: 'DPD', align: 'right',
    render: r => {
      const s = dpdStage(r.dpd)
      return <span style={{ ...NUM, color: s.color, fontWeight: FW.semibold }}>{r.dpd ?? 0}</span>
    },
  },
  {
    key: 'stage', label: 'Stage',
    render: r => {
      const s = dpdStage(r.dpd)
      return (
        <span style={{
          display: 'inline-block', padding: '2px 8px', borderRadius: RADIUS.full,
          fontSize: TEXT.sm, fontWeight: FW.medium,
          background: `${s.color}22`, color: s.color,
        }}>
          {s.label}
        </span>
      )
    },
  },
  {
    key: 'officer_name', label: 'Officer',
    render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.officer_name ?? '—'}</span>,
  },
  {
    key: 'date_booked', label: 'Booked', align: 'right',
    render: r => <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt3)' }}>{fmtDate(r.date_booked ?? r.disbursed_at)}</span>,
  },
  {
    key: 'disbursed_at', label: 'Disbursed', align: 'right',
    render: r => <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt3)' }}>{fmtDate(r.disbursed_at)}</span>,
  },
]

// ── Loan detail panel ──────────────────────────────────────────────────────────

function DetailRow({ label, value, mono, accent }: {
  label: string; value?: string | null; mono?: boolean; accent?: boolean
}) {
  const numStyles: CSSProperties = mono ? { ...NUM } : {}
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: `${SP[2]} 0`, fontSize: TEXT.sm }}>
      <span style={{ color: 'var(--txt2)', flexShrink: 0, marginRight: 16 }}>{label}</span>
      <span style={{ ...numStyles, color: accent ? RED : 'var(--txt)', fontWeight: FW.medium, textAlign: 'right' }}>
        {value ?? '—'}
      </span>
    </div>
  )
}

function PanelDivider() {
  return <div style={{ height: 1, background: 'var(--bdr)', margin: `${SP[2]} 0` }} />
}

function LoanDetailPanel({ loan, onClose }: { loan: LoanRow; onClose: () => void }) {
  const stage = dpdStage(loan.dpd)
  return (
    <>
      {/* Scrim */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.18)', zIndex: 1999 }}
      />
      {/* Panel */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 440,
        background: 'var(--card)', borderLeft: '1px solid var(--bdr)',
        boxShadow: '-6px 0 32px rgba(0,0,0,0.14)',
        zIndex: 2000, display: 'flex', flexDirection: 'column', overflowY: 'auto',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          padding: `${SP[4]} ${SP[5]}`, borderBottom: '1px solid var(--bdr)',
          position: 'sticky', top: 0, background: 'var(--card)', zIndex: 1,
        }}>
          <div>
            <div style={{ fontWeight: FW.semibold, fontSize: TEXT.md, color: 'var(--txt)' }}>
              {loan.applicant_name}
            </div>
            <div style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 2 }}>
              {loan.reference}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt3)', display: 'flex', padding: 4 }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 20 }}>close</span>
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: `${SP[4]} ${SP[5]}`, flex: 1 }}>
          <span style={{
            display: 'inline-block', padding: '4px 12px', borderRadius: RADIUS.full,
            fontSize: TEXT.sm, fontWeight: FW.semibold,
            background: `${stage.color}22`, color: stage.color, marginBottom: SP[4],
          }}>
            {stage.label}
          </span>

          <DetailRow label="CIF"           value={loan.applicant_cif} />
          <DetailRow label="Phone"         value={loan.applicant_phone} />
          <DetailRow label="Product"       value={loan.product_type} />
          <DetailRow label="Loan Product"  value={loan.loan_product} />
          <DetailRow label="Officer"       value={loan.officer_name} />

          <PanelDivider />

          <DetailRow label="Approved"      value={fmtKobo(loan.amount_approved_kobo)}  mono />
          <DetailRow label="Disbursed"     value={fmtKobo(loan.disbursed_amount_kobo)} mono />
          <DetailRow label="Outstanding"   value={fmtKobo(loan.outstanding_kobo)}       mono accent />
          <DetailRow label="Monthly Repay" value={fmtKobo(loan.monthly_repayment_kobo)} mono />

          <PanelDivider />

          <DetailRow
            label="DPD"
            value={String(loan.dpd ?? 0)}
            mono
            accent={typeof loan.dpd === 'number' && loan.dpd > 90}
          />
          <DetailRow label="Next Due"    value={fmtDate(loan.next_due_date)} />
          <DetailRow label="Maturity"    value={fmtDate(loan.maturity_date)} />
          <DetailRow label="Booked"      value={fmtDate(loan.date_booked ?? loan.disbursed_at)} />
          <DetailRow label="Disbursed"   value={fmtDate(loan.disbursed_at)} />
          <DetailRow label="1st Instalment" value={fmtDate(loan.first_installment_date)} />

          <PanelDivider />

          <DetailRow label="Lending Model"    value={loan.lending_model} />
          <DetailRow label="Interest Freq."   value={loan.interest_frequency} />
          <DetailRow label="Ledger Balance"   value={loan.ledger_balance_kobo != null ? fmtKobo(loan.ledger_balance_kobo) : '—'} mono />
          <DetailRow label="Collateral"       value={loan.collateral_type ? `${loan.collateral_type} — ${loan.collateral_description ?? ''}`.trim().replace(/—\s*$/, '') : 'Unsecured'} />
          {loan.collateral_valuation_kobo != null && loan.collateral_valuation_kobo > 0 && (
            <DetailRow label="Collateral Value" value={fmtKobo(loan.collateral_valuation_kobo)} mono />
          )}
        </div>
      </div>
    </>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function ActiveLoanBook() {
  const [summary,   setSummary]   = useState<LoanSummary | null>(null)
  const [loans,     setLoans]     = useState<LoanRow[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [search,    setSearch]    = useState('')
  const [dpdBucket, setDpdBucket] = useState('')
  const [selected,  setSelected]  = useState<LoanRow | null>(null)
  const dq = useDebouncedValue(search, 300) // one request per pause, not per keystroke

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, string> = { limit: '200' }
      if (dq)        params.search     = dq
      if (dpdBucket) params.dpd_bucket = dpdBucket
      const qs = new URLSearchParams(params).toString()

      const [statsData, listData] = await Promise.all([
        apiFetch<{ summary: LoanSummary; by_product: Record<string, unknown>[] }>('/api/active-loans/stats'),
        apiFetch<LoanRow[]>(`/api/active-loans/?${qs}`),
      ])
      setSummary(statsData?.summary ?? null)
      setLoans(Array.isArray(listData) ? listData : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dq, dpdBucket])

  useEffect(() => { load() }, [load])
  useLiveData(load)

  // Compute avg DPD from loaded rows (only over current visible set)
  const avgDpd = loans.length > 0
    ? Math.round(loans.reduce((s, l) => s + (l.dpd ?? 0), 0) / loans.length)
    : 0

  return (
    <Page title="Active Loan Book" subtitle="Live loan portfolio">
      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[4], marginBottom: SP[5] }}>
        <KpiCard
          label="Total Loans"
          value={fmtNum(summary?.total_loans ?? 0)}
          loading={loading}
        />
        <KpiCard
          label="Total Outstanding"
          value={fmtKobo(summary?.total_outstanding_kobo ?? 0)}
          loading={loading}
        />
        <KpiCard
          label="Avg DPD"
          value={`${avgDpd} days`}
          loading={loading}
          sub={summary ? `${fmtNum(summary.current_count)} current` : undefined}
        />
        <KpiCard
          label="NPL Accounts (90+)"
          value={fmtNum(summary?.dpd_90plus ?? 0)}
          loading={loading}
          sub={summary ? `${fmtKobo(summary.npl_outstanding_kobo)} outstanding` : undefined}
        />
      </div>

      {/* Filter bar */}
      <FilterBar onReset={() => { setSearch(''); setDpdBucket('') }}>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search CIF, name, reference…"
          minWidth={280}
        />
        <select
          value={dpdBucket}
          onChange={e => setDpdBucket(e.target.value)}
          style={{ ...filterInputStyle, width: 148 }}
        >
          <option value="">All DPD</option>
          <option value="current">Current (0)</option>
          <option value="1-30">1–30 DPD</option>
          <option value="31-60">31–60 DPD</option>
          <option value="61-90">61–90 DPD</option>
          <option value="90plus">NPL (90+)</option>
        </select>
      </FilterBar>

      {/* Loan table */}
      <SectionCard title="Active Loans" badge={loans.length} padding={false}>
        <DataTable
          cols={LOAN_COLS}
          rows={loans}
          keyFn={r => r.id}
          loading={loading}
          emptyText="No active loans found"
          onRowClick={r => setSelected(r)}
        />
      </SectionCard>

      {/* Slide-in detail panel */}
      {selected && (
        <LoanDetailPanel loan={selected} onClose={() => setSelected(null)} />
      )}
    </Page>
  )
}
