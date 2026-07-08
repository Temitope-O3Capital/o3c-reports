import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, ErrBanner, Sk, FilterBar, filterInputStyle } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtDate } from '../../lib/fmt'
import { RED, GREEN, AMBER, NAVY, NUM } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SummaryRow {
  cycle_date: string
  product_code: string
  product_name: string
  category: string
  card_type: string
  account_count: number
  overdue_accounts: number
  total_outstanding_kobo: number
  total_overdue_kobo: number
  total_interest_kobo: number
  total_fees_kobo: number
  total_penalty_kobo: number
  total_credit_limit_kobo: number
}

interface AccountRow {
  id: number
  account_number: string
  cif: string
  currency: string
  outstanding_balance_kobo: number
  overdue_amount_kobo: number
  interest_charged_kobo: number
  fees_kobo: number
  credit_limit_kobo: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function cycleStart(cycleDate: string) {
  return cycleDate.slice(0, 7) + '-01'
}

function cycleLabel(cycleDate: string) {
  return fmtDate(cycleDate)
}

function StatusPill({ date }: { date: string }) {
  const past = new Date(date) < new Date()
  const s = past
    ? { bg: 'rgba(107,114,128,.1)', color: 'var(--chart-lbl)', label: 'Closed' }
    : { bg: 'rgba(22,163,74,.1)',   color: GREEN,     label: 'Open' }
  return (
    <span style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 10px', borderRadius: 20, background: s.bg, color: s.color }}>
      {s.label}
    </span>
  )
}

function CatPill({ category }: { category: string }) {
  const s = category === 'prepaid'
    ? { bg: 'rgba(14,40,65,.08)',  color: NAVY }
    : { bg: 'rgba(192,0,0,.08)',   color: RED }
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 12, background: s.bg, color: s.color, textTransform: 'capitalize' as const }}>
      {category}
    </span>
  )
}

// ── Account expand panel ───────────────────────────────────────────────────────

function AccountPanel({ cycleDate, productCode }: { cycleDate: string; productCode: string }) {
  const [rows, setRows] = useState<AccountRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [offset, setOffset] = useState(0)
  const PAGE = 100

  const load = useCallback(async (off = 0) => {
    setLoading(true)
    try {
      const res = await apiFetch<{ data: AccountRow[]; total: number }>(
        `/api/cards/cycle-data?cycle_date=${cycleDate}&product_code=${productCode}&limit=${PAGE}&offset=${off}`
      )
      setRows(res?.data ?? [])
      setTotal(res?.total ?? 0)
      setOffset(off)
    } finally {
      setLoading(false)
    }
  }, [cycleDate, productCode])

  useEffect(() => { load(0) }, [load])

  if (loading) return <div style={{ padding: 16, color: 'var(--txt2)', fontSize: 13 }}>Loading accounts…</div>
  if (!rows.length) return <div style={{ padding: 16, color: 'var(--txt2)', fontSize: 13 }}>No accounts</div>

  return (
    <div style={{ padding: '12px 16px', background: 'var(--bg)' }}>
      <div style={{ fontSize: 12, color: 'var(--txt2)', marginBottom: 10 }}>
        {total.toLocaleString()} accounts · showing {offset + 1}–{Math.min(offset + PAGE, total)}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: 'var(--th-bg)' }}>
            {['Account', 'CIF', 'CCY', 'Outstanding', 'Overdue', 'Interest', 'Fees', 'Limit'].map(h => (
              <th key={h} style={{ padding: '8px 10px', textAlign: h === 'Account' || h === 'CIF' ? 'left' : 'right', color: 'var(--txt2)', fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(a => (
            <tr key={a.id} style={{ borderBottom: '1px solid var(--bdr)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
              onMouseLeave={e => (e.currentTarget.style.background = '')}
            >
              <td style={{ padding: '8px 10px', ...NUM, fontSize: 11.5, color: 'var(--txt2)' }}>{a.account_number}</td>
              <td style={{ padding: '8px 10px', ...NUM, fontSize: 11.5, color: 'var(--txt2)' }}>{a.cif}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', ...NUM, fontWeight: 600 }}>{a.currency}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', ...NUM }}>{fmtKobo(a.outstanding_balance_kobo)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', ...NUM, color: a.overdue_amount_kobo > 0 ? RED : 'var(--txt2)' }}>{fmtKobo(a.overdue_amount_kobo)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', ...NUM, color: GREEN }}>{fmtKobo(a.interest_charged_kobo)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', ...NUM, color: AMBER }}>{fmtKobo(a.fees_kobo)}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', ...NUM, color: 'var(--txt2)' }}>{fmtKobo(a.credit_limit_kobo)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {total > PAGE && (
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <button disabled={offset === 0} onClick={() => load(offset - PAGE)}
            style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: offset === 0 ? 'not-allowed' : 'pointer', opacity: offset === 0 ? 0.4 : 1 }}>← Prev</button>
          <button disabled={offset + PAGE >= total} onClick={() => load(offset + PAGE)}
            style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid var(--bdr)', background: 'var(--card)', cursor: offset + PAGE >= total ? 'not-allowed' : 'pointer', opacity: offset + PAGE >= total ? 0.4 : 1 }}>Next →</button>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CardsBilling() {
  const [allRows, setAllRows]   = useState<SummaryRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState('')
  const [expandedKey, setExpandedKey]   = useState<string | null>(null)

  useEffect(() => {
    apiFetch<SummaryRow[]>('/api/cards/cycle-summary')
      .then(data => {
        setAllRows(data ?? [])
        if (data?.length) setSelectedDate(data[0].cycle_date)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const cycleDates = useMemo(() =>
    [...new Set(allRows.map(r => r.cycle_date))].sort((a, b) => b.localeCompare(a)),
    [allRows]
  )

  const cycleRows = useMemo(() =>
    allRows.filter(r => r.cycle_date === selectedDate)
      .sort((a, b) => b.total_outstanding_kobo - a.total_outstanding_kobo),
    [allRows, selectedDate]
  )

  const totals = useMemo(() => ({
    accounts:    cycleRows.reduce((s, r) => s + Number(r.account_count), 0),
    outstanding: cycleRows.reduce((s, r) => s + r.total_outstanding_kobo, 0),
    overdue:     cycleRows.reduce((s, r) => s + r.total_overdue_kobo, 0),
  }), [cycleRows])

  function toggleExpand(key: string) {
    setExpandedKey(prev => prev === key ? null : key)
  }

  return (
    <Page
      title="Billing Cycles"
      subtitle="Card statement cycles from the processing system"
      actions={
        <select
          value={selectedDate}
          onChange={e => { setSelectedDate(e.target.value); setExpandedKey(null) }}
          style={{ ...filterInputStyle, minWidth: 180 }}
        >
          {cycleDates.map(d => (
            <option key={d} value={d}>Cycle ending {fmtDate(d)}</option>
          ))}
        </select>
      }
    >
      <ErrBanner error={error} onRetry={() => setError(null)} />

      {/* Cycle summary strip */}
      {selectedDate && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16, marginBottom: 20 }}>
          {[
            { label: 'Total Accounts',  value: totals.accounts.toLocaleString(), icon: 'credit_card',    color: NAVY },
            { label: 'Outstanding',     value: fmtKobo(totals.outstanding),     icon: 'account_balance', color: '#0EA5E9' },
            { label: 'Overdue',         value: fmtKobo(totals.overdue),         icon: 'warning',         color: RED },
          ].map(k => (
            <div key={k.label} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 28, color: k.color, opacity: 0.85 }}>{k.icon}</span>
              <div>
                <div style={{ fontSize: 11, color: 'var(--txt2)', marginBottom: 2 }}>{k.label}</div>
                <div style={{ ...NUM, fontSize: 18, fontWeight: 700, color: 'var(--txt)' }}>{k.value}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Products table */}
      <SectionCard padding={false} title={selectedDate ? `Products · cycle ending ${fmtDate(selectedDate)}` : 'Products'}>
        {loading ? <Sk h={300} /> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                {['Product', 'Category', 'Cycle Start', 'Cycle End', 'Accounts', 'Total Outstanding', 'Overdue Accounts', 'Status', ''].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: ['Accounts','Overdue Accounts'].includes(h) ? 'right' : h === 'Total Outstanding' ? 'right' : 'left', color: 'var(--txt2)', fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cycleRows.map(row => {
                const key = `${row.cycle_date}-${row.product_code}`
                const expanded = expandedKey === key
                return [
                  <tr key={key}
                    style={{ borderBottom: expanded ? 'none' : '1px solid var(--bdr)', cursor: 'pointer', background: expanded ? 'var(--row-hvr)' : '' }}
                    onMouseEnter={e => { if (!expanded) e.currentTarget.style.background = 'var(--row-hvr)' }}
                    onMouseLeave={e => { if (!expanded) e.currentTarget.style.background = '' }}
                    onClick={() => toggleExpand(key)}
                  >
                    <td style={{ padding: '10px 14px', fontWeight: 500, color: 'var(--txt)' }}>{row.product_name}</td>
                    <td style={{ padding: '10px 14px' }}><CatPill category={row.category} /></td>
                    <td style={{ padding: '10px 14px', ...NUM, fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(cycleStart(row.cycle_date))}</td>
                    <td style={{ padding: '10px 14px', ...NUM, fontSize: 12, color: 'var(--txt2)' }}>{fmtDate(row.cycle_date)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM }}>{Number(row.account_count).toLocaleString()}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM, fontWeight: 600 }}>{fmtKobo(row.total_outstanding_kobo)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM, color: Number(row.overdue_accounts) > 0 ? RED : 'var(--txt2)' }}>{Number(row.overdue_accounts).toLocaleString()}</td>
                    <td style={{ padding: '10px 14px' }}><StatusPill date={row.cycle_date} /></td>
                    <td style={{ padding: '10px 14px', textAlign: 'center', color: 'var(--txt2)' }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 18, verticalAlign: 'middle' }}>
                        {expanded ? 'expand_less' : 'expand_more'}
                      </span>
                    </td>
                  </tr>,
                  expanded && (
                    <tr key={`${key}-expand`} style={{ borderBottom: '1px solid var(--bdr)' }}>
                      <td colSpan={9} style={{ padding: 0 }}>
                        <AccountPanel cycleDate={row.cycle_date} productCode={row.product_code} />
                      </td>
                    </tr>
                  ),
                ]
              })}
            </tbody>
          </table>
        )}
      </SectionCard>
    </Page>
  )
}
