import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import { BarChartCard, ProgressListCard, fmt, fmtNum, pct } from '../components/Charts.jsx'
import { DateRangePicker, FilterChip, DropItem, CHIP_OFF, CHIP_ON, toISO, presetRange } from '../components/FilterBar.jsx'
import { InfoTooltip } from '../components/Charts.jsx'
import PageShell from '../components/PageShell.jsx'

/* ── helpers ── */
function today() { return toISO(new Date()) }

function initRange() {
  const [f, t] = presetRange('month', today())
  return { dateFrom: f, dateTo: t, preset: 'month' }
}

/* ── Status badge colours ── */
const STATUS_COLORS = {
  open:     { bg: '#F0FDF4', fg: '#059669', border: '#BBF7D0', label: 'Active' },
  active:   { bg: '#F0FDF4', fg: '#059669', border: '#BBF7D0', label: 'Active' },
  inactive: { bg: '#FEF2F2', fg: '#C00000', border: '#FECACA', label: 'Inactive' },
  closed:   { bg: '#F1F5F9', fg: '#475569', border: '#CBD5E1', label: 'Closed' },
  default:  { bg: '#F8FAFC', fg: '#64748B', border: '#E2E8F0', label: '' },
}
function statusColor(s) {
  const k = (s || '').toLowerCase().replace(/\s+/g, '')
  return STATUS_COLORS[k] || STATUS_COLORS.default
}

function StatusBadge({ status }) {
  const c = statusColor(status)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, background: c.bg, color: c.fg, border: `1px solid ${c.border}` }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: c.fg, flexShrink: 0 }} />
      {c.label || status}
    </span>
  )
}

/* ── KPI card ── */
function KPI({ label, value, icon, accent = '#0E2841', sub, tooltip }) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))' }}>{label}</p>
          {tooltip && <InfoTooltip text={tooltip} />}
        </div>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${accent}14` }}>
          <span className="material-symbols-rounded text-[17px]" style={{ color: accent }}>{icon}</span>
        </div>
      </div>
      <p style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1, fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)', fontFeatureSettings: '"tnum"', color: 'rgb(var(--fg-1))' }}>
        {value ?? '—'}
      </p>
      {sub && <p style={{ fontSize: 11, color: 'rgb(var(--fg-3))', marginTop: 8 }}>{sub}</p>}
    </div>
  )
}

const CARD_TYPES = ['PREP', 'Amex Naira', 'Amex USD', 'Classic Accounts']

export default function Cards() {
  const init = initRange()
  const [dateFrom,  setDateFrom]  = useState(init.dateFrom)
  const [dateTo,    setDateTo]    = useState(init.dateTo)
  const [preset,    setPreset]    = useState(init.preset)
  const [cardType,  setCardType]  = useState('')

  const [kpis,     setKpis]     = useState(null)
  const [byStatus, setByStatus] = useState([])
  const [byProd,   setByProd]   = useState([])
  const [volByType, setVolByType] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')
  const [dataSource, setDataSource] = useState(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const p = new URLSearchParams()
      if (dateFrom)  p.set('date_from', dateFrom)
      if (dateTo)    p.set('date_to',   dateTo)
      if (cardType)  p.set('card_type', cardType)
      const qs = p.toString() ? `?${p}` : ''

      const [k, bs, bp, vt] = await Promise.all([
        apiFetch(`/api/cards/kpis${qs}`),
        apiFetch('/api/cards/by-status'),
        apiFetch('/api/cards/by-product'),
        apiFetch(`/api/cards/volume-by-type${qs}`),
      ])
      setKpis(k.data || {}); setDataSource(k.data_source)
      setByStatus(bs.data || [])
      setByProd(bp.data || [])
      setVolByType(vt.data || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo, cardType])

  useEffect(() => { load() }, [load])

  function handleDateChange(f, t, p) {
    setDateFrom(f); setDateTo(t); setPreset(p)
  }

  const d = kpis || {}
  const prodTotal = byProd.reduce((s, r) => s + Number(r.count || 0), 0)

  // Build by-status data with display labels
  const byStatusDisplay = byStatus.map(r => ({
    ...r,
    _label: statusColor(r['Account Status']).label || r['Account Status'],
    _color: statusColor(r['Account Status']).fg,
  }))

  return (
    <PageShell
      title="Cards"
      subtitle="Issuance pipeline, product mix, and cardholder activity"
      source={dataSource}
      error={error}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <DateRangePicker
            dateFrom={dateFrom}
            dateTo={dateTo}
            preset={preset}
            onChange={handleDateChange}
          />
          <FilterChip
            label={cardType || 'Card Type'}
            active={!!cardType}
            onClear={() => setCardType('')}
          >
            <DropItem label="All Types" selected={!cardType} onClick={() => setCardType('')} />
            {CARD_TYPES.map(t => (
              <DropItem key={t} label={t} selected={cardType === t} onClick={() => setCardType(t)} />
            ))}
          </FilterChip>
        </div>
      }
    >

      {/* ── KPIs row 1 ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPI label="Total Issued"    value={fmtNum(d.total_issued)}   icon="credit_card"  accent="#0E2841" tooltip="Total cards issued across all products" />
        <KPI label="Active"          value={fmtNum(d.active)}         icon="check_circle" accent="#059669" sub={`${pct(d.activation_rate)} activation rate`} tooltip="Cards with Open account status" />
        <KPI label="Inactive"        value={fmtNum(d.inactive)}       icon="cancel"       accent="#C00000" tooltip="Cards not currently in Open/Active status" />
        <KPI label="Unique Merchants" value={fmtNum(d.unique_merchants)} icon="storefront" accent="#D97706" tooltip="Distinct merchants where O3 Capital cards were used in the selected period" />
      </div>

      {/* ── KPIs row 2 ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
        <KPI label="PREP"          value={fmtNum(d.prep)}           icon="wallet"    accent="#0E2841" tooltip="Naira prepaid card accounts (PREP product)" />
        <KPI label="Amex Naira"    value={fmtNum(d.amex_naira)}     icon="payments"  accent="#C00000" tooltip="Naira-denominated Amex cards" />
        <KPI label="Amex USD"      value={fmtNum(d.amex_usd)}       icon="language"  accent="#D97706" tooltip="USD-denominated Amex cards for international use" />
        <KPI label="Classic"       value={fmtNum(d.classic_accounts)} icon="credit_card" accent="#6366F1" tooltip="Classic account cards" />
      </div>

      {/* ── Charts row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">

        {/* Cards by Status */}
        <div className="card p-5">
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))', marginBottom: 16 }}>
            Cards by Account Status
          </p>
          {loading ? (
            <div className="flex items-center justify-center py-8"><div className="spinner" /></div>
          ) : byStatusDisplay.length === 0 ? (
            <p className="text-sm text-slate-400 py-8 text-center">No data</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {byStatusDisplay.map((row, i) => {
                const total = byStatusDisplay.reduce((s, r) => s + Number(r.count || 0), 0)
                const share = total > 0 ? (Number(row.count) / total) * 100 : 0
                return (
                  <div key={i}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                      <StatusBadge status={row['Account Status']} />
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 11, color: 'rgb(var(--fg-3))' }}>{share.toFixed(1)}%</span>
                        <span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', color: 'rgb(var(--fg-1))' }}>
                          {Number(row.count).toLocaleString()}
                        </span>
                      </div>
                    </div>
                    <div style={{ height: 6, borderRadius: 3, background: 'rgb(var(--bg-subtle))', overflow: 'hidden' }}>
                      <div style={{ width: `${share}%`, height: '100%', borderRadius: 3, background: row._color, transition: 'width 0.7s ease' }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Volume by Card Type */}
        <BarChartCard
          title="Transaction Volume by Card Type"
          subtitle={dateFrom && dateTo ? `${dateFrom} – ${dateTo}` : 'All time'}
          data={volByType}
          xKey="Product Name"
          bars={[{ key: 'volume', label: 'Volume', color: '#0E2841' }]}
          height={240}
          currency
        />
      </div>

      {/* ── Volume by type table ── */}
      {volByType.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-6 py-4" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              Spend by Card Type
              {dateFrom && dateTo && <span className="ml-2 text-xs font-normal text-slate-400">{dateFrom} – {dateTo}</span>}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Card Type</th>
                  <th className="text-right">Transactions</th>
                  <th className="text-right">Volume</th>
                  <th className="text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const total = volByType.reduce((s, r) => s + Number(r.volume || 0), 0)
                  return volByType.map((row, i) => {
                    const share = total > 0 ? (Number(row.volume) / total * 100).toFixed(1) : '0.0'
                    return (
                      <tr key={i}>
                        <td className="font-medium text-slate-800 dark:text-slate-200">{row['Product Name']}</td>
                        <td className="text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">{Number(row.txn_count).toLocaleString()}</td>
                        <td className="text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">{fmt(row.volume)}</td>
                        <td className="text-right"><span className="badge badge-grey">{share}%</span></td>
                      </tr>
                    )
                  })
                })()}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Product breakdown ── */}
      {byProd.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <div className="px-6 py-4" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)' }}>
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Product Breakdown (All Time)</p>
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="text-right">Cards Issued</th>
                  <th className="text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {byProd.map((row, i) => {
                  const share = prodTotal > 0 ? (row.count / prodTotal * 100).toFixed(1) : '0.0'
                  return (
                    <tr key={i}>
                      <td className="font-medium text-slate-800 dark:text-slate-200">{row['Product Name']}</td>
                      <td className="text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">{fmtNum(row.count)}</td>
                      <td className="text-right"><span className="badge badge-grey">{share}%</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </PageShell>
  )
}
