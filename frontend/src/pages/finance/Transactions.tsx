import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, filterInputStyle, SearchInput, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, API } from '../../lib/api'
import { fmtKobo, fmtDate, fmtDatetime, fmtNum, today, monthStart } from '../../lib/fmt'
import { GREEN, RED, NAVY, INTER, SORA, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
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
  { key: 'amount', label: 'Amount ₦', align: 'right',
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
  const [filterOpen, setFilterOpen] = useState(false)

  const [search,     setSearch]     = useState('')
  const [sign,       setSign]       = useState('')
  const [branch,     setBranch]     = useState('')
  const [dateFrom,   setDateFrom]   = useState(monthStart())
  const [dateTo,     setDateTo]     = useState(today())
  const [amountMin,  setAmountMin]  = useState('')
  const [amountMax,  setAmountMax]  = useState('')

  const abortRef = useRef<AbortController | null>(null)

  const buildQS = useCallback((off = 0) => {
    const p = new URLSearchParams()
    p.set('limit', String(PAGE_SIZE))
    p.set('offset', String(off))
    p.set('date_from', dateFrom)
    p.set('date_to', dateTo)
    if (search)    p.set('q', search)
    if (sign)      p.set('sign', sign)
    if (branch)    p.set('branch', branch)
    if (amountMin) p.set('amount_min', String(Math.round(parseFloat(amountMin) * 100)))
    if (amountMax) p.set('amount_max', String(Math.round(parseFloat(amountMax) * 100)))
    return p.toString()
  }, [dateFrom, dateTo, search, sign, branch, amountMin, amountMax])

  const load = useCallback(async (off = 0) => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setLoading(true); setError(null)
    try {
      const [res, kpiRes] = await Promise.all([
        apiFetch<{ data: TxnResponse }>(`/api/eod/transactions?${buildQS(off)}`, { signal: abortRef.current.signal }),
        apiFetch<{ data: TxnKPIs }>('/api/finance/transaction-kpis'),
      ])
      setRows(res.data?.data ?? [])
      setTotal(res.data?.total ?? 0)
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
    setSearch(''); setSign(''); setBranch('')
    setDateFrom(monthStart()); setDateTo(today())
    setAmountMin(''); setAmountMax('')
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

  const activeFilterCount = useMemo(
    () => (sign ? 1 : 0) + (branch ? 1 : 0) + (amountMin ? 1 : 0) + (amountMax ? 1 : 0),
    [sign, branch, amountMin, amountMax]
  )

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
        <KpiCard label="Total Credits ₦" value={kpis ? fmtKobo(kpis.total_credits_kobo) : '—'} icon="south_east" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="Total Debits ₦" value={kpis ? fmtKobo(kpis.total_debits_kobo) : '—'} icon="north_west" accent={RED} loading={kpiLoading} />
        <KpiCard label="Net Position ₦" value={kpis ? fmtKobo(kpis.net_position_kobo) : '—'} icon="account_balance_wallet" accent={GREEN} loading={kpiLoading} />
      </div>

      <SectionCard title="Transactions" badge={total} padding={false}>

        {/* Filter bar */}
        <div style={{
          padding: `${SP[3]} 18px`,
          borderBottom: filterOpen ? 'none' : '1px solid var(--bdr)',
          display: 'flex', alignItems: 'center', gap: SP[2], flexWrap: 'wrap' as const,
        }}>
          <SearchInput
            value={search}
            onChange={setSearch}
            onSearch={() => load(0)}
            onClear={() => { setSearch(''); }}
            style={{ maxWidth: 280 }}
          />

          <button
            onClick={() => setFilterOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', borderRadius: RADIUS.md, fontSize: TEXT.sm, fontWeight: FW.semibold,
              border: `1.5px solid ${activeFilterCount > 0 ? RED : 'var(--input-bdr)'}`,
              background: 'transparent',
              color: activeFilterCount > 0 ? RED : 'var(--txt2)',
              cursor: 'pointer', fontFamily: SORA, position: 'relative' as const,
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>tune</span>
            Filters
            {activeFilterCount > 0 && (
              <span style={{
                position: 'absolute', top: -6, right: -6,
                width: 16, height: 16, borderRadius: '50%',
                background: RED, color: '#fff',
                fontSize: 9, fontWeight: FW.bold, fontFamily: INTER,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{activeFilterCount}</span>
            )}
          </button>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
              {total.toLocaleString()} records
            </span>
          </div>
        </div>

        {/* Expandable filter panel */}
        {filterOpen && (
          <div style={{ borderBottom: '1px solid var(--bdr)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', padding: '20px 20px 0' }}>

              {/* Channel (sign) */}
              <div style={{ paddingRight: 20, borderRight: '1px solid var(--bdr)' }}>
                <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, textTransform: 'uppercase' as const, letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: SP[3], fontFamily: INTER }}>CHANNEL</div>
                {[
                  { value: '',   label: 'All channels' },
                  { value: 'CR', label: 'Credit (CR)' },
                  { value: 'DR', label: 'Debit (DR)' },
                ].map(opt => (
                  <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, cursor: 'pointer' }}>
                    <input type="radio" name="sign" value={opt.value} checked={sign === opt.value} onChange={() => setSign(opt.value)}
                      style={{ accentColor: opt.value === 'CR' ? '#16A34A' : opt.value === 'DR' ? RED : NAVY, width: 14, height: 14, cursor: 'pointer' }} />
                    <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontFamily: SORA }}>{opt.label}</span>
                  </label>
                ))}
              </div>

              {/* Branch */}
              <div style={{ padding: '0 20px', borderRight: '1px solid var(--bdr)' }}>
                <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, textTransform: 'uppercase' as const, letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: SP[3], fontFamily: INTER }}>BRANCH</div>
                <input
                  type="text"
                  value={branch}
                  onChange={e => setBranch(e.target.value)}
                  placeholder="Filter by branch name…"
                  style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' as const }}
                />
              </div>

              {/* Amount range */}
              <div style={{ paddingLeft: 20 }}>
                <div style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, textTransform: 'uppercase' as const, letterSpacing: '0.06em', color: 'var(--txt3)', marginBottom: SP[3], fontFamily: INTER }}>AMOUNT (₦)</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
                  <div>
                    <label style={{ fontSize: TEXT.xs, color: 'var(--txt2)', display: 'block', marginBottom: 4, fontFamily: INTER }}>Min</label>
                    <input type="number" min="0" placeholder="e.g. 10000" value={amountMin} onChange={e => setAmountMin(e.target.value)}
                      style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' as const }} />
                  </div>
                  <div>
                    <label style={{ fontSize: TEXT.xs, color: 'var(--txt2)', display: 'block', marginBottom: 4, fontFamily: INTER }}>Max</label>
                    <input type="number" min="0" placeholder="e.g. 500000" value={amountMax} onChange={e => setAmountMax(e.target.value)}
                      style={{ ...filterInputStyle, width: '100%', boxSizing: 'border-box' as const }} />
                  </div>
                </div>
              </div>

            </div>

            <div style={{
              padding: '14px 20px', borderTop: '1px solid var(--bdr)', marginTop: 16,
              display: 'flex', alignItems: 'center', gap: SP[3],
            }}>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)', fontFamily: SORA }}>
                {activeFilterCount === 0
                  ? 'No filters active — showing all results'
                  : `${activeFilterCount} filter${activeFilterCount !== 1 ? 's' : ''} active`}
              </span>
              <button onClick={handleReset} style={{
                padding: '5px 12px', borderRadius: 7, fontSize: TEXT.sm, fontWeight: FW.semibold,
                border: '1.5px solid var(--input-bdr)', background: 'transparent',
                color: 'var(--txt2)', cursor: 'pointer', fontFamily: SORA,
              }}>Reset</button>
              <button onClick={() => { load(0); setFilterOpen(false) }} style={{
                marginLeft: 'auto', padding: '5px 16px', borderRadius: 7,
                fontSize: TEXT.sm, fontWeight: FW.semibold, border: 'none', background: RED, color: '#fff',
                cursor: 'pointer', fontFamily: SORA,
              }}>Apply</button>
            </div>
          </div>
        )}

        {/* Active chips */}
        {!filterOpen && activeFilterCount > 0 && (
          <div style={{
            padding: '8px 18px', borderBottom: '1px solid var(--bdr)',
            display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' as const,
          }}>
            {sign && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: RADIUS['2xl'], fontSize: TEXT.xs, fontWeight: FW.semibold, background: sign === 'CR' ? 'rgba(22,163,74,.12)' : 'rgba(192,0,0,.08)', color: sign === 'CR' ? '#16A34A' : RED }}>
                {sign === 'CR' ? 'Credit only' : 'Debit only'}
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm, cursor: 'pointer' }} onClick={() => { setSign(''); load(0) }}>close</span>
              </span>
            )}
            {branch && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: RADIUS['2xl'], fontSize: TEXT.xs, fontWeight: FW.semibold, background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>
                Branch: {branch}
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm, cursor: 'pointer' }} onClick={() => { setBranch(''); load(0) }}>close</span>
              </span>
            )}
            {(amountMin || amountMax) && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: RADIUS['2xl'], fontSize: TEXT.xs, fontWeight: FW.semibold, background: 'var(--chip-bg)', color: 'var(--chip-txt)' }}>
                ₦{amountMin || '0'} – ₦{amountMax || '∞'}
                <span className="material-symbols-rounded" style={{ fontSize: TEXT.sm, cursor: 'pointer' }} onClick={() => { setAmountMin(''); setAmountMax(''); load(0) }}>close</span>
              </span>
            )}
            <button onClick={() => { handleReset(); load(0) }} style={{ marginLeft: 4, border: 'none', background: 'none', cursor: 'pointer', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', padding: 0, fontFamily: SORA }}>Clear all</button>
          </div>
        )}

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
