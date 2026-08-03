import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, ExpandableFilterBar, filterInputStyle, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, API } from '../../lib/api'
import { fmtKobo, fmtDate, fmtDatetime, fmtNum, today, monthStart } from '../../lib/fmt'
import { GREEN, RED, NAVY, INTER, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { toast } from 'sonner'

interface TxnKPIs {
  total_count: number
  total_credits_kobo: number
  total_debits_kobo: number
  net_position_kobo: number
}

interface TxnRow {
  id: number
  txn_date: string
  account_no: string
  customer: string
  cif: string
  txn_category: string
  txn_code: string
  amount: number
  balance: number
  sign: string
  description: string
  branch_name: string
  product_name: string
  currency: string
  merchant_name: string
}

interface TxnResponse { data: TxnRow[]; total: number }

const COLS: TableCol<TxnRow>[] = [
  { key: 'txn_date', label: 'Date', width: 110,
    render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.txn_date)}</span> },
  { key: 'account_no', label: 'Ref', width: 130,
    render: r => <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontWeight: FW.medium }}>{r.account_no}</span> },
  { key: 'customer', label: 'Customer', render: r => (
    <div>
      <div style={{ fontSize: TEXT.base, fontWeight: FW.medium, color: 'var(--txt)' }}>{r.customer || '—'}</div>
      {r.cif && <div style={{ fontSize: 10.5, color: 'var(--txt2)' }}>{r.cif}</div>}
    </div>
  )},
  { key: 'txn_category', label: 'Type', render: r => (
    <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'],
      background: 'var(--chip-bg)', color: 'var(--chip-txt)', whiteSpace: 'nowrap' }}>
      {r.txn_category || r.description || '—'}
    </span>
  )},
  { key: 'amount', label: 'Amount NGN', align: 'right',
    render: r => <span style={{ ...NUM, fontWeight: FW.semibold, color: r.sign === 'CR' ? GREEN : RED }}>{fmtKobo(r.amount)}</span> },
  { key: 'balance', label: 'Balance ₦', align: 'right',
    render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{fmtKobo(r.balance)}</span> },
  { key: 'sign', label: 'Channel', render: r => (
    <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'],
      background: r.sign === 'CR' ? 'rgba(22,163,74,.1)' : 'rgba(192,0,0,.08)',
      color: r.sign === 'CR' ? GREEN : RED }}>
      {r.sign}
    </span>
  )},
  { key: 'branch_name', label: 'Branch',
    render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.branch_name || '—'}</span> },
  { key: 'txn_date', label: 'Time',
    render: r => <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtDatetime(r.txn_date)}</span> },
]


function PageBtn({ children, active, disabled, onClick, icon }: {
  children?: React.ReactNode; active?: boolean; disabled?: boolean
  onClick?: () => void; icon?: string
}) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      width: 28, height: 28, borderRadius: RADIUS.sm,
      border: active ? 'none' : '1.5px solid var(--input-bdr)',
      background: active ? RED : 'transparent',
      color: active ? '#fff' : disabled ? 'var(--txt3)' : 'var(--txt2)',
      fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: disabled ? 'default' : 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: INTER,
    }}>
      {icon ? <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>{icon}</span> : children}
    </button>
  )
}

const PAGE_SIZE = 50

export default function FinanceTransactions() {
  const [rows,       setRows]       = useState<TxnRow[]>([])
  const [kpis,       setKpis]       = useState<TxnKPIs | null>(null)
  const [total,      setTotal]      = useState(0)
  const [offset,     setOffset]     = useState(0)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState<string | null>(null)
  const [exporting,  setExporting]  = useState(false)

  const [search,     setSearch]     = useState('')
  const [fSign,      setFSign]      = useState<Set<string>>(new Set())
  const [dateFrom,   setDateFrom]   = useState(monthStart())
  const [dateTo,     setDateTo]     = useState(today())

  const abortRef = useRef<AbortController | null>(null)

  const buildQS = useCallback((off = 0) => {
    const p = new URLSearchParams()
    p.set('limit', String(PAGE_SIZE))
    p.set('offset', String(off))
    p.set('date_from', dateFrom)
    p.set('date_to', dateTo)
    if (search)       p.set('q', search)
    if (fSign.size)   p.set('sign', [...fSign].join(','))
    return p.toString()
  }, [dateFrom, dateTo, search, fSign])

  const load = useCallback(async (off = 0) => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setLoading(true); setError(null)
    try {
      const [res, kpiRes] = await Promise.all([
        apiFetch<any>(`/api/eod/transactions?${buildQS(off)}`, { signal: abortRef.current.signal }),
        apiFetch<{ data: TxnKPIs }>('/api/finance/transaction-kpis'),
      ])
      setRows(Array.isArray(res) ? res : (res?.data?.data ?? res?.data ?? []))
      setTotal(res?.total ?? res?.data?.total ?? 0)
      setOffset(off)
      setKpis(kpiRes.data)
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [buildQS])

  useEffect(() => { load(0) }, [load])

  function handleReset() {
    setSearch(''); setFSign(new Set())
    setDateFrom(monthStart()); setDateTo(today())
  }

  async function handleExport() {
    setExporting(true)
    try {
      const res = await fetch(`${API}/api/eod/transactions/export?${buildQS(0)}`, {
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `transactions_${dateFrom}_${dateTo}.csv`
      a.click(); URL.revokeObjectURL(url)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setExporting(false)
    }
  }

  const totalPages   = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const currentPage  = Math.floor(offset / PAGE_SIZE) + 1
  const showStart    = total === 0 ? 0 : offset + 1
  const showEnd      = Math.min(offset + PAGE_SIZE, total)

  const kpiLoading = loading && !kpis

  return (
    <Page
      title="Transactions"
      subtitle={total > 0 ? `${total.toLocaleString()} transactions` : undefined}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <button onClick={handleExport} disabled={exporting} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)',
            background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm, fontWeight: FW.semibold,
            cursor: exporting ? 'not-allowed' : 'pointer', opacity: exporting ? 0.6 : 1,
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>download</span>
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      }
    >
      <ErrBanner error={error} onRetry={() => load(0)} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Total Transactions" value={kpis ? fmtNum(kpis.total_count) : '—'} icon="receipt_long" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="Total Credits NGN" value={kpis ? fmtKobo(kpis.total_credits_kobo) : '—'} icon="south_east" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="Total Debits NGN" value={kpis ? fmtKobo(kpis.total_debits_kobo) : '—'} icon="north_west" accent={RED} loading={kpiLoading} />
        <KpiCard label="Net Position ₦" value={kpis ? fmtKobo(kpis.net_position_kobo) : '—'} icon="account_balance_wallet" accent={GREEN} loading={kpiLoading} />
      </div>

      <SectionCard title="Transactions" badge={total} padding={false}>

        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={[{
            key: 'sign', label: 'Channel',
            options: [
              { value: 'CR', label: 'Credit (CR)', color: '#16A34A' },
              { value: 'DR', label: 'Debit (DR)',  color: '#C00000' },
            ],
            selected: fSign,
            onChange: setFSign,
          }]}
          onReset={handleReset}
          onApply={() => load(0)}
          resultCount={total}
          totalCount={total}
          placeholder="Search transactions…"
        />

        <DataTable cols={COLS} rows={rows} keyFn={(r, i) => r.id ?? i} loading={loading} emptyText="No transactions found" />

        {/* Pagination footer */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: `${SP[3]} 18px`, borderTop: '1px solid var(--bdr)',
        }}>
          <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
            {total === 0
              ? 'No transactions'
              : `Showing ${showStart.toLocaleString()}–${showEnd.toLocaleString()} of ${total.toLocaleString()}`}
          </span>
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[1] }}>
              <PageBtn icon="chevron_left" disabled={offset === 0} onClick={() => load(Math.max(0, offset - PAGE_SIZE))} />
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                let pg: number
                if (totalPages <= 7) pg = i + 1
                else if (currentPage <= 4) pg = i + 1
                else if (currentPage >= totalPages - 3) pg = totalPages - 6 + i
                else pg = currentPage - 3 + i
                return (
                  <PageBtn key={pg} active={pg === currentPage} onClick={() => load((pg - 1) * PAGE_SIZE)}>{pg}</PageBtn>
                )
              })}
              <PageBtn icon="chevron_right" disabled={currentPage >= totalPages} onClick={() => load(offset + PAGE_SIZE)} />
            </div>
          )}
        </div>

      </SectionCard>
    </Page>
  )
}
