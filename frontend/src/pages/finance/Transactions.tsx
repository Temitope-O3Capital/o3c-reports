import { useEffect, useState, useCallback, useRef } from 'react'
import { Page, KpiCard, SectionCard, DataTable, ErrBanner, ExpandableFilterBar, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, unwrap } from '../../lib/api'
import { fmt, fmtDate, fmtNum, today, monthStart } from '../../lib/fmt'
import { GREEN, RED, NAVY, INTER, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// The finance movement ledger reads the live transaction feed
// (app.transactions). Amounts are NAIRA — formatted with fmt(), never fmtKobo.

interface TxnKPIs {
  total_count: number
  total_credits_ngn: number
  total_debits_ngn: number
  net_position_ngn: number
}

interface TxnRow {
  txn_date: string
  description: string
  channel: string
  product_name: string
  account_no: string
  txn_code: string
  merchant_name: string
  money_in: boolean
  amount_debit: number
  amount_credit: number
  account_balance: number
}

const COLS: TableCol<TxnRow>[] = [
  { key: 'txn_date', label: 'Date', width: 110,
    render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.txn_date)}</span> },
  { key: 'account_no', label: 'Account', width: 130,
    render: r => <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', fontWeight: FW.medium }}>{r.account_no || '—'}</span> },
  { key: 'description', label: 'Description', render: r => (
    <div>
      <div style={{ fontSize: TEXT.base, fontWeight: FW.medium, color: 'var(--txt)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description || r.merchant_name || '—'}</div>
      {r.product_name && <div style={{ fontSize: 10.5, color: 'var(--txt3)' }}>{r.product_name}</div>}
    </div>
  )},
  { key: 'channel', label: 'Channel', render: r => (
    <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'],
      background: 'var(--chip-bg)', color: 'var(--chip-txt)', whiteSpace: 'nowrap', textTransform: 'capitalize' }}>
      {r.channel || '—'}
    </span>
  )},
  { key: 'amount_credit', label: 'Amount NGN', align: 'right',
    render: r => <span style={{ ...NUM, fontWeight: FW.semibold, color: r.money_in ? GREEN : RED }}>
      {r.money_in ? fmt(r.amount_credit) : fmt(r.amount_debit)}
    </span> },
  { key: 'money_in', label: 'Dir', render: r => (
    <span style={{ ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: RADIUS['2xl'],
      background: r.money_in ? 'rgba(22,163,74,.1)' : 'rgba(192,0,0,.08)',
      color: r.money_in ? GREEN : RED }}>
      {r.money_in ? 'CR' : 'DR'}
    </span>
  )},
  { key: 'account_balance', label: 'Balance ₦', align: 'right',
    render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{r.account_balance != null ? fmt(r.account_balance) : '—'}</span> },
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
  const [rows, setRows] = useState<TxnRow[]>([])
  const [kpis, setKpis] = useState<TxnKPIs | null>(null)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [fDir, setFDir] = useState<Set<string>>(new Set())
  const [fChannel, setFChannel] = useState<Set<string>>(new Set())
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo, setDateTo] = useState(today())

  const abortRef = useRef<AbortController | null>(null)

  const buildQS = useCallback((off = 0) => {
    const p = new URLSearchParams()
    p.set('limit', String(PAGE_SIZE))
    p.set('offset', String(off))
    p.set('date_from', dateFrom)
    p.set('date_to', dateTo)
    if (search) p.set('q', search)
    if (fDir.size) p.set('direction', [...fDir][0])
    if (fChannel.size) p.set('channel', [...fChannel][0])
    return p.toString()
  }, [dateFrom, dateTo, search, fDir, fChannel])

  const load = useCallback(async (off = 0) => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setLoading(true); setError(null)
    try {
      const [res, kpiRes] = await Promise.all([
        apiFetch<any>(`/api/finance/transactions?${buildQS(off)}`, { signal: abortRef.current.signal }),
        apiFetch<any>('/api/finance/transaction-kpis'),
      ])
      setRows(Array.isArray(res?.data) ? res.data : [])
      setTotal(res?.total ?? 0)
      setOffset(off)
      setKpis(unwrap<TxnKPIs>(kpiRes))
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [buildQS])

  useEffect(() => { load(0) }, [load])

  function handleReset() {
    setSearch(''); setFDir(new Set()); setFChannel(new Set())
    setDateFrom(monthStart()); setDateTo(today())
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1
  const showStart = total === 0 ? 0 : offset + 1
  const showEnd = Math.min(offset + PAGE_SIZE, total)
  const kpiLoading = loading && !kpis

  return (
    <Page
      title="Transactions"
      loading={loading && rows.length === 0}
      skeletonKpis={4}
      subtitle={total > 0 ? `${total.toLocaleString()} movements · live feed` : 'Movement ledger'}
      actions={
        <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
      }
    >
      <ErrBanner error={error} onRetry={() => load(0)} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Transactions (MTD)" value={kpis ? fmtNum(kpis.total_count) : '—'} icon="receipt_long" accent={NAVY} loading={kpiLoading} />
        <KpiCard label="Credits (MTD)" value={kpis ? fmt(kpis.total_credits_ngn) : '—'} icon="south_east" accent={GREEN} loading={kpiLoading} />
        <KpiCard label="Debits (MTD)" value={kpis ? fmt(kpis.total_debits_ngn) : '—'} icon="north_west" accent={RED} loading={kpiLoading} />
        <KpiCard label="Net Position (MTD)" value={kpis ? fmt(kpis.net_position_ngn) : '—'} icon="account_balance_wallet" accent={(kpis?.net_position_ngn ?? 0) >= 0 ? GREEN : RED} loading={kpiLoading} />
      </div>

      <SectionCard title="Movement ledger" badge={total} padding={false}>
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={[
            {
              key: 'direction', label: 'Direction',
              options: [
                { value: 'credit', label: 'Credit (in)', color: '#16A34A' },
                { value: 'debit', label: 'Debit (out)', color: '#C00000' },
              ],
              selected: fDir,
              onChange: setFDir,
            },
            {
              key: 'channel', label: 'Channel',
              options: [
                { value: 'interswitch', label: 'Interswitch', color: '#2563EB' },
                { value: 'collection', label: 'Collection', color: '#D97706' },
                { value: 'internal', label: 'Internal', color: '#7C3AED' },
              ],
              selected: fChannel,
              onChange: setFChannel,
            },
          ]}
          onReset={handleReset}
          onApply={() => load(0)}
          resultCount={total}
          totalCount={total}
          placeholder="Search description, account, merchant…"
        />

        <DataTable cols={COLS} rows={rows} keyFn={(r, i) => i} loading={loading} emptyText="No transactions found" />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${SP[3]} 18px`, borderTop: '1px solid var(--bdr)' }}>
          <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)', fontFamily: INTER }}>
            {total === 0 ? 'No transactions' : `Showing ${showStart.toLocaleString()}–${showEnd.toLocaleString()} of ${total.toLocaleString()}`}
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
                return <PageBtn key={pg} active={pg === currentPage} onClick={() => load((pg - 1) * PAGE_SIZE)}>{pg}</PageBtn>
              })}
              <PageBtn icon="chevron_right" disabled={currentPage >= totalPages} onClick={() => load(offset + PAGE_SIZE)} />
            </div>
          )}
        </div>
      </SectionCard>
    </Page>
  )
}
