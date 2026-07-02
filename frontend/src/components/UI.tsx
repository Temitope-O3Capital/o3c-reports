// Shared UI primitives used across all pages
import { useState, useRef, useEffect, useId, useMemo, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { STATUS_LABELS, snake } from '../lib/labels'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { fmt, fmtNum, fmtDate, n, today, monthStart, yearStart } from '../lib/fmt'

/* ── Design tokens ──────────────────────────────────────────────── */
export const NAVY  = '#0E2841'
export const RED   = '#C00000'
export const GREEN = '#166534'   // green-700, passes WCAG AAA (7.6:1)
export const AMBER = '#D97706'
export const BLUE  = '#2563EB'

/* ── Skeleton ───────────────────────────────────────────────────── */
export function Sk({ w = 'w-full', h = 'h-3' }: { w?: string; h?: string }) {
  return <div className={`skeleton ${w} ${h} rounded`} />
}

/* ── Spinner ────────────────────────────────────────────────────── */
export function Spinner({ size = 20 }: { size?: number }) {
  return (
    <div className="inline-block rounded-full border-2 animate-spin"
      style={{ width: size, height: size, borderColor: 'rgba(14,40,65,0.15)', borderTopColor: NAVY }} />
  )
}

/* ── Error banner ───────────────────────────────────────────────── */
export function ErrBanner({ msg }: { msg: string }) {
  if (!msg) return null
  return (
    <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl text-sm mb-5"
      style={{ background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.18)', color: '#B91C1C' }}>
      <span className="material-symbols-rounded text-[17px] flex-shrink-0">error</span>
      {msg}
    </div>
  )
}

/* ── Change badge ───────────────────────────────────────────────── */
export function ChangeBadge({ value, suffix = '%' }: { value: number | null | undefined; suffix?: string }) {
  if (value == null) return null
  const up = value >= 0
  return (
    <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold px-1.5 py-0.5 rounded"
      style={{ background: up ? 'rgba(5,150,105,0.08)' : 'rgba(220,38,38,0.07)', color: up ? GREEN : '#C00000' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 12 }}>{up ? 'arrow_upward' : 'arrow_downward'}</span>
      {up ? '+' : ''}{Math.abs(value).toFixed(1)}{suffix}
    </span>
  )
}

/* ── KPI card ───────────────────────────────────────────────────── */
interface KpiProps {
  label: string
  value: string
  sub?: string
  change?: number | null
  changePeriod?: string
  icon: string
  accent?: string
  loading?: boolean
}

export function KpiCard({ label, value, sub, change, changePeriod = 'MoM', icon, accent = NAVY, loading }: KpiProps) {
  if (loading) return (
    <div className="card p-5">
      <div className="flex justify-between mb-3"><Sk w="w-28" /><Sk w="w-8" h="h-8" /></div>
      <Sk w="w-32" h="h-7" />
      <div className="mt-3"><Sk w="w-24" /></div>
    </div>
  )
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.07em]" style={{ color: 'var(--txt2)' }}>{label}</p>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: `${accent}12` }}>
          <span className="material-symbols-rounded text-[16px]" style={{ color: accent }}>{icon}</span>
        </div>
      </div>
      <p className="kpi-number text-[26px] leading-none" style={{ color: 'var(--txt)' }}>{value}</p>
      <div className="flex items-center gap-2 mt-3">
        {change != null
          ? <><ChangeBadge value={change} /><span className="text-[11px]" style={{ color: 'var(--txt2)' }}>{changePeriod}</span></>
          : sub ? <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>{sub}</span>
          : null}
      </div>
    </div>
  )
}

/* ── Section card ───────────────────────────────────────────────── */
export function SectionCard({
  title, subtitle, badge, actions, children, className = '',
}: {
  title: string; subtitle?: string; badge?: string | number
  actions?: ReactNode; children: ReactNode; className?: string
}) {
  return (
    <div className={`card overflow-hidden ${className}`}>
      <div className="flex items-center justify-between px-5 py-3.5"
        style={{ borderBottom: '1px solid var(--bdr)' }}>
        <div>
          <p className="text-[14px] font-semibold" style={{ color: 'var(--txt)' }}>{title}</p>
          {subtitle && <p className="text-[12px] mt-0.5" style={{ color: 'var(--txt2)' }}>{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {badge != null && (
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
              style={{ background: 'rgba(14,40,65,0.07)', color: 'var(--txt2)' }}>
              {badge}
            </span>
          )}
          {actions}
        </div>
      </div>
      {children}
    </div>
  )
}

/* ── Data table ─────────────────────────────────────────────────── */
export interface ColDef<T> {
  key: string
  label: string
  right?: boolean
  render?: (row: T) => ReactNode
  sortable?: boolean
}

export function DataTable<T extends Record<string, any>>({
  cols, rows, loading, emptyIcon = 'table_rows', emptyMsg = 'No data',
  selectable, selectedIds, onSelectionChange, rowBg,
}: {
  cols: ColDef<T>[]
  rows: T[]
  loading?: boolean
  emptyIcon?: string
  emptyMsg?: string
  selectable?: boolean
  selectedIds?: Set<string | number>
  onSelectionChange?: (ids: Set<string | number>) => void
  rowBg?: (row: T) => string | undefined
}) {
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [hoveredId, setHoveredId] = useState<string | number | null>(null)

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const data = useMemo(() => {
    const d = [...rows]
    if (sortKey) {
      d.sort((a, b) => {
        const av = a[sortKey], bv = b[sortKey]
        if (av == null) return 1; if (bv == null) return -1
        return sortDir === 'asc' ? (av < bv ? -1 : 1) : (av > bv ? -1 : 1)
      })
    }
    return d
  }, [rows, sortKey, sortDir])

  function toggleRow(id: string | number) {
    if (!onSelectionChange || !selectedIds) return
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onSelectionChange(next)
  }

  function toggleAll() {
    if (!onSelectionChange) return
    const allIds = data.map(r => r.id)
    const allSelected = allIds.every(id => selectedIds?.has(id))
    onSelectionChange(allSelected ? new Set() : new Set(allIds))
  }

  const totalCols = cols.length + (selectable ? 1 : 0)

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr>
            {selectable && (
              <th className="px-5 py-3 w-10" style={{ background: 'var(--th-bg)' }}>
                <input type="checkbox"
                  checked={data.length > 0 && data.every(r => selectedIds?.has(r.id))}
                  onChange={toggleAll} />
              </th>
            )}
            {cols.map(c => {
              const isActive = sortKey === c.key
              return (
                <th key={c.key}
                  onClick={() => c.sortable !== false && toggleSort(c.key)}
                  className={`px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.07em] whitespace-nowrap select-none ${c.sortable !== false ? 'cursor-pointer' : ''} ${c.right ? 'text-right' : 'text-left'}`}
                  style={{ background: 'var(--th-bg)', color: isActive ? 'var(--txt)' : 'var(--txt2)', fontFamily: "'Inter', ui-sans-serif, sans-serif", transition: 'color .12s' }}>
                  <span className={`inline-flex items-center gap-1 ${c.right ? 'flex-row-reverse' : ''}`}>
                    {c.label}
                    {c.sortable !== false && (
                      <span style={{ fontSize: 11, color: '#C00000', lineHeight: 1, opacity: isActive ? 1 : 0.3, transition: 'opacity .12s' }}>
                        {isActive ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                      </span>
                    )}
                  </span>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--bdr)' }}>
                  {Array.from({ length: totalCols }).map((_, j) => <td key={j} className="px-5 py-3.5"><Sk /></td>)}
                </tr>
              ))
            : data.length === 0
            ? (
                <tr>
                  <td colSpan={totalCols} className="px-5 py-14 text-center">
                    <span className="material-symbols-rounded text-[36px] block mb-2" style={{ color: 'var(--bdr)' }}>{emptyIcon}</span>
                    <p className="text-[13px]" style={{ color: 'var(--txt2)' }}>{emptyMsg}</p>
                    <p className="text-[12px] mt-1" style={{ color: 'var(--txt2)' }}>Try adjusting your filters</p>
                  </td>
                </tr>
              )
            : data.map((row, i) => (
                <tr key={row.id ?? i}
                  onMouseEnter={() => setHoveredId(row.id ?? i)}
                  onMouseLeave={() => setHoveredId(null)}
                  style={{ borderTop: '1px solid var(--bdr)', background: hoveredId === (row.id ?? i) ? 'var(--row-hvr)' : (rowBg?.(row) || undefined), transition: 'background .1s' }}>
                  {selectable && (
                    <td className="px-5 py-3 w-10">
                      <input type="checkbox"
                        checked={!!selectedIds?.has(row.id)}
                        onChange={() => toggleRow(row.id)} />
                    </td>
                  )}
                  {cols.map(c => (
                    <td key={c.key} className={`px-5 py-3 ${c.right ? 'text-right' : ''}`}>
                      {c.render ? c.render(row) : row[c.key] ?? '—'}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  )
}

/* ── Chart tooltip ──────────────────────────────────────────────── */
function ChartTip({ active, payload, label, currency }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border px-3 py-2.5 shadow-lg"
      style={{ background: 'var(--card)', borderColor: 'var(--bdr)', fontSize: 12 }}>
      <p className="text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--txt2)' }}>{label}</p>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: p.color ?? p.fill }} />
          <span className="font-semibold font-mono" style={{ color: 'var(--txt)' }}>
            {currency ? fmt(p.value) : fmtNum(p.value)}
          </span>
        </div>
      ))}
    </div>
  )
}

/* ── Area chart card ────────────────────────────────────────────── */
export function AreaChartCard({
  title, subtitle, data, xKey, areaKey, color = NAVY, currency = false, height = 200, loading,
}: {
  title: string; subtitle?: string; data: any[]; xKey: string; areaKey: string
  color?: string; currency?: boolean; height?: number; loading?: boolean
}) {
  const uid = useId()
  const gradId = `grad-${uid.replace(/:/g, '')}`
  return (
    <SectionCard title={title} subtitle={subtitle}>
      <div className="px-5 py-4">
        {loading ? (
          <div className="flex items-end gap-1.5" style={{ height }}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="flex-1 skeleton rounded-t" style={{ height: `${30 + (i % 5) * 14}%` }} />
            ))}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={height}>
            <AreaChart data={data} margin={{ top: 20, right: 12, left: 0, bottom: 4 }}>
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor={color} stopOpacity={0.13} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.18)" vertical={false} />
              <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false}
                tickFormatter={v => currency ? fmt(v) : fmtNum(v)} width={currency ? 60 : 44}
                domain={[(dataMin: number) => dataMin < 0 ? Math.floor(dataMin * 1.12) : 0, (dataMax: number) => Math.ceil(dataMax * 1.15) || 10]} />
              <Tooltip content={<ChartTip currency={currency} />} />
              <Area type="monotone" dataKey={areaKey} stroke={color} strokeWidth={1.5}
                fill={`url(#${gradId})`} dot={false}
                activeDot={{ r: 3.5, fill: color, strokeWidth: 0 }} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </SectionCard>
  )
}

/* ── Bar chart card ─────────────────────────────────────────────── */
export function BarChartCard({
  title, subtitle, data, xKey, barKey, color = NAVY, currency = false, height = 200, loading,
}: {
  title: string; subtitle?: string; data: any[]; xKey: string; barKey: string
  color?: string; currency?: boolean; height?: number; loading?: boolean
}) {
  return (
    <SectionCard title={title} subtitle={subtitle}>
      <div className="px-5 py-4">
        {loading ? (
          <div className="flex items-end gap-3" style={{ height }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex-1 skeleton rounded-t" style={{ height: `${25 + i * 13}%` }} />
            ))}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={height}>
            <BarChart data={data} margin={{ top: 20, right: 12, left: 0, bottom: 4 }} barSize={20}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.18)" vertical={false} />
              <XAxis dataKey={xKey} tick={{ fontSize: 10, fill: '#94A3B8' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false}
                tickFormatter={v => currency ? fmt(v) : fmtNum(v)} width={currency ? 60 : 44}
                domain={[(dataMin: number) => dataMin < 0 ? Math.floor(dataMin * 1.12) : 0, (dataMax: number) => Math.ceil(dataMax * 1.15) || 10]} />
              <Tooltip content={<ChartTip currency={currency} />} />
              <Bar dataKey={barKey} fill={color} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </SectionCard>
  )
}

/* ── Donut card ─────────────────────────────────────────────────── */
export function DonutCard({
  title, subtitle, data, nameKey, valueKey, colors, loading,
}: {
  title: string; subtitle?: string
  data: any[]; nameKey: string; valueKey: string; colors?: string[]; loading?: boolean
}) {
  const COLORS = colors ?? [NAVY, RED, BLUE, GREEN, AMBER, '#8B5CF6', '#0891B2']
  const total = data.reduce((s, d) => s + n(d[valueKey]), 0)
  return (
    <SectionCard title={title} subtitle={subtitle}>
      <div className="px-5 py-4">
        {loading ? (
          <div className="flex flex-col items-center gap-3 pt-2">
            <div className="w-28 h-28 skeleton rounded-full" />
            <div className="w-full space-y-2 pt-2"><Sk /><Sk w="w-3/4" /><Sk w="w-1/2" /></div>
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={140}>
              <PieChart>
                <Pie data={data} cx="50%" cy="50%" innerRadius={44} outerRadius={64}
                  dataKey={valueKey} paddingAngle={2} startAngle={90} endAngle={-270}>
                  {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} stroke="none" />)}
                </Pie>
                <Tooltip content={<ChartTip currency />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="space-y-2 pt-1">
              {data.map((d, i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                    <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>{d[nameKey]}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] font-semibold font-mono" style={{ color: 'var(--txt)' }}>{fmt(d[valueKey])}</span>
                    {total > 0 && <span className="text-[11px]" style={{ color: 'var(--txt2)' }}>({((n(d[valueKey]) / total) * 100).toFixed(0)}%)</span>}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </SectionCard>
  )
}

/* ── Progress list ──────────────────────────────────────────────── */
export function ProgressList({
  title, subtitle, data, nameKey, valueKey, currency = false, loading,
}: {
  title: string; subtitle?: string
  data: any[]; nameKey: string; valueKey: string; currency?: boolean; loading?: boolean
}) {
  const maxVal = Math.max(...data.map(d => n(d[valueKey])), 1)
  return (
    <SectionCard title={title} subtitle={subtitle}>
      <div className="px-5 py-4 space-y-3">
        {loading
          ? Array.from({ length: 5 }).map((_, i) => <div key={i} className="space-y-1.5"><Sk w="w-32" /><Sk h="h-1.5" /></div>)
          : data.map((d, i) => (
              <div key={i}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[12px] truncate max-w-[60%]" style={{ color: 'var(--txt2)' }}>{d[nameKey]}</span>
                  <span className="text-[12px] font-semibold font-mono" style={{ color: 'var(--txt)' }}>
                    {currency ? fmt(d[valueKey]) : fmtNum(d[valueKey])}
                  </span>
                </div>
                <div className="h-1.5 rounded-full" style={{ background: 'var(--bdr)' }}>
                  <div className="h-full rounded-full transition-all"
                    style={{ width: `${(n(d[valueKey]) / maxVal) * 100}%`, background: NAVY }} />
                </div>
              </div>
            ))}
      </div>
    </SectionCard>
  )
}

/* ── Status badge ───────────────────────────────────────────────── */
const STATUS_STYLES: Record<string, { bg: string; color: string }> = {
  // positive
  paid:           { bg: 'rgba(5,150,105,0.09)',   color: GREEN },
  active:         { bg: 'rgba(5,150,105,0.09)',   color: GREEN },
  approved:       { bg: 'rgba(5,150,105,0.09)',   color: GREEN },
  success:        { bg: 'rgba(5,150,105,0.09)',   color: GREEN },
  successful:     { bg: 'rgba(5,150,105,0.09)',   color: GREEN },
  resolved:       { bg: 'rgba(5,150,105,0.09)',   color: GREEN },
  processed:      { bg: 'rgba(5,150,105,0.09)',   color: GREEN },
  settled:        { bg: 'rgba(5,150,105,0.09)',   color: GREEN },
  disbursed:      { bg: 'rgba(8,145,178,0.09)',   color: '#0891B2' },
  inflow:         { bg: 'rgba(5,150,105,0.09)',   color: GREEN },
  // neutral / warning
  pending:        { bg: 'rgba(217,119,6,0.09)',   color: AMBER },
  partial:        { bg: 'rgba(217,119,6,0.09)',   color: AMBER },
  abandoned:      { bg: 'rgba(217,119,6,0.09)',   color: AMBER },
  reversed:       { bg: 'rgba(217,119,6,0.09)',   color: AMBER },
  incomplete:     { bg: 'rgba(139,92,246,0.09)',  color: '#7C3AED' },
  // negative
  failed:         { bg: 'rgba(192,0,0,0.08)',     color: RED },
  overdue:        { bg: 'rgba(192,0,0,0.08)',     color: RED },
  declined:       { bg: 'rgba(192,0,0,0.08)',     color: RED },
  liquidation:    { bg: 'rgba(192,0,0,0.08)',     color: RED },
  // neutral
  written_off:    { bg: 'rgba(30,41,59,0.07)',    color: '#475569' },
  inactive:       { bg: 'rgba(100,116,139,0.08)', color: '#64748B' },
  returned:       { bg: 'rgba(100,116,139,0.08)', color: '#64748B' },
}

export function StatusBadge({ status }: { status: string }) {
  const key = (status || '').toLowerCase().replace(/[- ]/g, '_')
  const s = STATUS_STYLES[key] ?? { bg: 'rgba(14,40,65,0.06)', color: '#475569' }
  const label = STATUS_LABELS[key] ?? snake(status)
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: s.bg, color: s.color }}>
      <span style={{
        width: 5, height: 5, borderRadius: '50%',
        background: s.color, display: 'inline-block', flexShrink: 0,
      }} />
      {label}
    </span>
  )
}

/* ── Channel badge ───────────────────────────────────────────────── */
const CHANNEL_STYLES: Record<string, { label: string; bg: string; color: string; icon: string }> = {
  bank_transfer: { label: 'Bank Transfer', bg: 'rgba(8,145,178,0.09)',   color: '#0369A1', icon: 'account_balance' },
  card:          { label: 'Card',          bg: 'rgba(124,58,237,0.09)',  color: '#7C3AED', icon: 'credit_card' },
  ussd:          { label: 'USSD',          bg: 'rgba(217,119,6,0.09)',   color: AMBER,     icon: 'phone' },
  mobile_money:  { label: 'Mobile Money',  bg: 'rgba(5,150,105,0.09)',   color: GREEN,     icon: 'smartphone' },
  qr:            { label: 'QR Code',       bg: 'rgba(14,40,65,0.09)',    color: NAVY,      icon: 'qr_code' },
  eft:           { label: 'EFT',           bg: 'rgba(8,145,178,0.09)',   color: '#0369A1', icon: 'swap_horiz' },
}

export function ChannelBadge({ channel }: { channel: string | null | undefined }) {
  const key = (channel || '').toLowerCase().replace(/[- ]/g, '_')
  const s = CHANNEL_STYLES[key] ?? { label: channel || '—', bg: 'rgba(14,40,65,0.06)', color: '#64748B', icon: 'payments' }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: s.bg, color: s.color }}>
      <span className="material-symbols-rounded" style={{ fontSize: 12 }}>{s.icon}</span>
      {s.label}
    </span>
  )
}

/* ── Date filter ────────────────────────────────────────────────── */
const PRESETS = [
  { label: 'Today',    get: () => { const t = today(); return [t, t] as const } },
  { label: 'This week', get: () => {
    const d = new Date(), day = d.getDay()
    const mon = new Date(d); mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
    const p = (n: number) => String(n).padStart(2, '0')
    const start = `${mon.getFullYear()}-${p(mon.getMonth() + 1)}-${p(mon.getDate())}`
    return [start, today()] as const
  }},
  { label: 'This month', get: () => [monthStart(), today()] as const },
  { label: 'Last month', get: () => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const prevM = d.getMonth() === 0 ? 12 : d.getMonth()
    const prevY = d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear()
    const lastDay = new Date(d.getFullYear(), d.getMonth(), 0).getDate()
    return [`${prevY}-${p(prevM)}-01`, `${prevY}-${p(prevM)}-${p(lastDay)}`] as const
  }},
  { label: 'This year', get: () => [yearStart(), today()] as const },
]

export function DateFilter({
  from, to, onChange,
}: {
  from: string; to: string; onChange: (f: string, t: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const label = from === to
    ? fmtDate(from)
    : `${fmtDate(from, { day: '2-digit', month: 'short' })} – ${fmtDate(to, { day: '2-digit', month: 'short', year: 'numeric' })}`

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[12px] font-medium transition-all"
        style={{ background: 'var(--card)', borderColor: open ? NAVY : 'var(--bdr)', color: 'var(--txt)' }}>
        <span className="material-symbols-rounded text-[15px]" style={{ color: 'var(--txt2)' }}>calendar_month</span>
        {label}
        <span className="material-symbols-rounded text-[15px]" style={{ color: 'var(--txt2)' }}>{open ? 'expand_less' : 'expand_more'}</span>
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1.5 z-[300] card p-4 shadow-xl"
          style={{ minWidth: 260 }}>
          <div className="space-y-1 mb-3">
            {PRESETS.map(p => {
              const [f, t] = p.get()
              const active = f === from && t === to
              return (
                <button key={p.label}
                  onClick={() => { onChange(f, t); setOpen(false) }}
                  className="w-full text-left px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors"
                  style={{
                    background: active ? 'var(--chip-bg)' : 'transparent',
                    color: active ? 'var(--txt)' : 'var(--txt2)',
                  }}>
                  {p.label}
                </button>
              )
            })}
          </div>
          <div className="border-t pt-3" style={{ borderColor: 'var(--bdr)' }}>
            <p className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--txt2)' }}>Custom range</p>
            <div className="flex items-center gap-2">
              <input type="date" value={from}
                onChange={e => onChange(e.target.value, to)}
                className="flex-1 px-2 py-1.5 rounded border text-[12px] outline-none"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }} />
              <span style={{ color: 'var(--txt2)' }}>–</span>
              <input type="date" value={to}
                onChange={e => onChange(from, e.target.value)}
                className="flex-1 px-2 py-1.5 rounded border text-[12px] outline-none"
                style={{ background: 'var(--input-bg)', borderColor: 'var(--input-bdr)', color: 'var(--txt)' }} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Page wrapper ───────────────────────────────────────────────── */
export function Page({
  dept, deptPath, title, subtitle, actions, children,
}: {
  dept?: string; deptPath?: string; title: string; subtitle?: string; actions?: ReactNode; children: ReactNode
}) {
  useEffect(() => {
    document.title = `${title} — O3 Capital Workspace`
    return () => { document.title = 'O3 Capital Workspace' }
  }, [title])

  return (
    <div className="px-8 py-7 max-w-[1440px] mx-auto">
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          {dept && deptPath && (
            <p className="text-[13px] mb-1" style={{ color: 'var(--txt2)' }}>
              <Link to={deptPath} className="font-medium hover:underline" style={{ color: 'var(--txt)' }}>{dept}</Link>
              <span className="mx-1.5" style={{ color: 'var(--bdr)' }}>›</span>
              <span style={{ color: 'var(--txt2)' }}>{title}</span>
            </p>
          )}
          <h1 className="text-[26px] font-bold tracking-tight leading-tight" style={{ color: 'var(--txt)' }}>
            {title}
          </h1>
          {subtitle && <p className="text-[13px] mt-0.5" style={{ color: 'var(--txt2)' }}>{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
      </div>
      {children}
    </div>
  )
}

/* ── Export button ──────────────────────────────────────────────── */
export function ExportBtn({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return (
    <button onClick={onClick} disabled={loading}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[12px] font-medium transition-all disabled:opacity-60"
      style={{ background: 'var(--card)', borderColor: 'var(--bdr)', color: 'var(--txt2)' }}>
      {loading
        ? <><div className="w-3.5 h-3.5 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" />Exporting…</>
        : <><span className="material-symbols-rounded text-[15px]">download</span>Export CSV</>}
    </button>
  )
}

interface ConfirmModalProps {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmModal({ title, message, confirmLabel = 'Confirm', danger = false, onConfirm, onCancel }: ConfirmModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="rounded-2xl shadow-xl p-6 w-full max-w-sm" style={{ background: 'var(--card)' }}>
        <div className="flex items-start gap-3 mb-4">
          <span className="material-symbols-rounded text-[22px] mt-0.5" style={{ color: danger ? RED : NAVY }}>
            {danger ? 'warning' : 'help'}
          </span>
          <div>
            <h2 className="text-[15px] font-bold" style={{ color: 'var(--txt)' }}>{title}</h2>
            <p className="text-[13px] mt-1" style={{ color: 'var(--txt2)' }}>{message}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            className="px-4 py-2 rounded-lg text-[13px] font-semibold"
            style={{ color: 'var(--txt)', background: 'var(--chip-bg)' }}
            onClick={onCancel}>
            Cancel
          </button>
          <button
            className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white"
            style={{ background: danger ? RED : NAVY }}
            onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── Empty state ─────────────────────────────────────────────────── */
export function EmptyState({ icon = 'inbox', message = 'No data', hint = 'Try adjusting your filters' }: {
  icon?: string; message?: string; hint?: string
}) {
  return (
    <div className="px-5 py-14 text-center">
      <span className="material-symbols-rounded text-[36px] block mb-2" style={{ color: 'var(--txt3)' }}>{icon}</span>
      <p className="text-[13px]" style={{ color: 'var(--txt2)' }}>{message}</p>
      {hint && <p className="text-[12px] mt-1" style={{ color: 'var(--txt2)' }}>{hint}</p>}
    </div>
  )
}

/* ── Tabs ────────────────────────────────────────────────────────── */
export function Tabs<T extends string>({
  tabs, active, onChange,
}: { tabs: readonly T[]; active: T; onChange: (t: T) => void }) {
  return (
    <div className="flex gap-0 border-b" style={{ borderColor: 'var(--bdr)' }}>
      {tabs.map(t => (
        <button key={t} onClick={() => onChange(t)}
          className="px-4 py-2.5 text-[13px] font-semibold border-b-2 whitespace-nowrap"
          style={{
            borderColor: t === active ? '#C00000' : 'transparent',
            color: t === active ? 'var(--txt)' : 'var(--txt2)',
            transition: 'color .15s, border-color .15s',
          }}>
          {t}
        </button>
      ))}
    </div>
  )
}

/* ── Stepper ─────────────────────────────────────────────────────── */
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="flex items-center gap-0 mb-8">
      {steps.map((label, i) => (
        <div key={label} className="flex items-center flex-1">
          <div className="flex flex-col items-center gap-1">
            <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold transition-all"
              style={{
                background: i < current ? GREEN : i === current ? NAVY : 'rgba(15,23,42,0.08)',
                color: i <= current ? '#fff' : '#94A3B8',
              }}>
              {i < current
                ? <span className="material-symbols-rounded text-[14px]">check</span>
                : i + 1}
            </div>
            <span className="text-[11px] font-semibold whitespace-nowrap"
              style={{ color: i === current ? 'var(--txt)' : 'var(--txt2)' }}>
              {label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div className="flex-1 h-0.5 mx-1 mt-[-12px]"
              style={{ background: i < current ? GREEN : 'rgba(15,23,42,0.1)' }} />
          )}
        </div>
      ))}
    </div>
  )
}

/* ── Toggle ──────────────────────────────────────────────────────── */
export function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} role="switch" aria-checked={checked}
      className="relative flex-shrink-0 w-10 h-5 rounded-full transition-colors focus:outline-none"
      style={{ background: checked ? NAVY : 'var(--bdr)' }}>
      <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform"
        style={{ transform: checked ? 'translateX(20px)' : 'none' }} />
    </button>
  )
}

/* ── Avatar ──────────────────────────────────────────────────────── */
export function Avatar({ name, size = 'md', color = NAVY }: {
  name: string; size?: 'sm' | 'md' | 'lg'; color?: string
}) {
  const dim = size === 'sm' ? 28 : size === 'lg' ? 56 : 40
  const fontSize = size === 'sm' ? 11 : size === 'lg' ? 20 : 15
  const initials = name.split(' ').slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase()
  return (
    <div className="rounded-full flex items-center justify-center flex-shrink-0 font-bold text-white"
      style={{ width: dim, height: dim, fontSize, background: color }}>
      {initials}
    </div>
  )
}

/* ── Detail field ────────────────────────────────────────────────── */
export function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-[11px] flex-shrink-0" style={{ color: 'var(--txt2)' }}>{label}</span>
      <span className="text-[12px] text-right" style={{ color: 'var(--txt)' }}>{value ?? '—'}</span>
    </div>
  )
}

/* ── Info callout ────────────────────────────────────────────────── */
const CALLOUT_STYLES = {
  info:    { bg: 'rgba(37,99,235,0.06)',  border: 'rgba(37,99,235,0.18)',  color: '#1D4ED8', icon: 'info' },
  success: { bg: 'rgba(5,150,105,0.06)',  border: 'rgba(5,150,105,0.18)',  color: '#065F46', icon: 'check_circle' },
  warning: { bg: 'rgba(217,119,6,0.07)',  border: 'rgba(217,119,6,0.20)',  color: '#92400E', icon: 'warning' },
  error:   { bg: 'rgba(192,0,0,0.06)',    border: 'rgba(192,0,0,0.18)',    color: '#7F1D1D', icon: 'error' },
}

export function InfoCallout({ type = 'info', children }: { type?: keyof typeof CALLOUT_STYLES; children: ReactNode }) {
  const s = CALLOUT_STYLES[type]
  return (
    <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl text-[13px]"
      style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color }}>
      <span className="material-symbols-rounded text-[16px] flex-shrink-0 mt-0.5">{s.icon}</span>
      <div>{children}</div>
    </div>
  )
}

/* ── Search input ────────────────────────────────────────────────── */
export function SearchInput({ value, onChange, placeholder = 'Search…', className = '' }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string
}) {
  return (
    <div className={`flex items-center gap-2 rounded-lg px-3 py-2 ${className}`}
      style={{ background: 'var(--input-bg)', border: '1.5px solid var(--input-bdr)' }}>
      <span className="material-symbols-rounded text-[15px] flex-shrink-0 pointer-events-none" style={{ color: 'var(--txt3)' }}>search</span>
      <input
        type="search"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-transparent text-[13px] focus:outline-none w-full"
        style={{ color: 'var(--txt)' }}
      />
      {value && (
        <button onClick={() => onChange('')} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt3)', padding: 0, display: 'flex' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span>
        </button>
      )}
    </div>
  )
}

/* ── Filter bar (approved DesignDemo spec) ───────────────────────── */
export interface FilterGroup {
  key: string
  label: string
  options: { value: string; label?: string; count?: number }[]
}

export function FilterBar({
  search, onSearch, placeholder = 'Search…',
  groups = [], active = {}, onToggle, onClear,
  total, count,
  children,
}: {
  search?: string
  onSearch?: (v: string) => void
  placeholder?: string
  groups?: FilterGroup[]
  active?: Record<string, Set<string>>
  onToggle?: (group: string, value: string) => void
  onClear?: () => void
  total?: number
  count?: number
  children?: ReactNode
}) {
  const [panelOpen, setPanelOpen] = useState(false)

  const totalActive = Object.values(active).reduce((s, set) => s + set.size, 0)

  const chips: [string, string, string][] = Object.entries(active).flatMap(([gk, vals]) => {
    const group = groups.find(g => g.key === gk)
    return [...vals].map(v => {
      const opt = group?.options.find(o => o.value === v)
      return [gk, v, opt?.label ?? v] as [string, string, string]
    })
  })

  const hasSearchActive = search && search.trim() !== ''
  const hasActive = chips.length > 0 || !!hasSearchActive

  const INTER = "'Inter', ui-sans-serif, sans-serif"

  return (
    <>
      {/* ── Controls row ── */}
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 8 }}>

        {/* Search */}
        {onSearch !== undefined && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'var(--input-bg)', border: '1.5px solid var(--input-bdr)', borderRadius: 9, padding: '8px 11px', minWidth: 220, maxWidth: 300 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 16, color: 'var(--txt3)', flexShrink: 0 }}>search</span>
            <input value={search ?? ''} onChange={e => onSearch(e.target.value)} placeholder={placeholder}
              style={{ border: 'none', background: 'transparent', fontSize: 12.5, color: 'var(--txt)', outline: 'none', width: '100%' }} />
            {search && (
              <button onClick={() => onSearch('')} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--txt3)', padding: 0, display: 'flex' }}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }}>close</span>
              </button>
            )}
          </div>
        )}

        {/* Filters toggle */}
        {groups.length > 0 && (
          <button onClick={() => setPanelOpen(o => !o)} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '8px 13px', borderRadius: 9, cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
            background: panelOpen || totalActive > 0 ? 'rgba(192,0,0,0.06)' : 'var(--input-bg)',
            border: `1.5px solid ${panelOpen || totalActive > 0 ? '#C00000' : 'var(--input-bdr)'}`,
            color: panelOpen || totalActive > 0 ? '#C00000' : 'var(--txt2)',
            transition: 'all .14s',
          }}>
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>tune</span>
            Filters
            {totalActive > 0 && (
              <span style={{ minWidth: 17, height: 17, borderRadius: 99, background: '#C00000', color: '#fff', fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: INTER }}>
                {totalActive}
              </span>
            )}
          </button>
        )}

        {/* Right side: count + clear + extra actions */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {total !== undefined && count !== undefined && (
            <span style={{ fontSize: 11.5, color: 'var(--txt2)', fontFamily: INTER, fontVariantNumeric: 'tabular-nums' }}>
              {count} of {total}
            </span>
          )}
          {hasActive && onClear && (
            <button onClick={() => { onClear(); setPanelOpen(false) }} style={{ display: 'flex', alignItems: 'center', gap: 4, border: '1.5px solid var(--input-bdr)', background: 'transparent', borderRadius: 8, padding: '6px 11px', fontSize: 12, fontWeight: 600, color: 'var(--txt2)', cursor: 'pointer' }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14 }}>filter_alt_off</span>
              Clear all
            </button>
          )}
          {children}
        </div>
      </div>

      {/* ── Expandable filter panel ── */}
      {panelOpen && groups.length > 0 && (
        <div style={{ borderBottom: '1px solid var(--bdr)', background: 'var(--fp-bg)', padding: '18px 20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(groups.length, 4)}, 1fr)`, gap: 24 }}>
            {groups.map(group => {
              const groupActive = active[group.key] ?? new Set<string>()
              return (
                <div key={group.key}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase', color: 'var(--txt2)', fontFamily: INTER, marginBottom: 10 }}>
                    {group.label}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {group.options.map(opt => {
                      const checked = groupActive.has(opt.value)
                      return (
                        <label key={opt.value} onClick={() => onToggle?.(group.key, opt.value)} style={{
                          display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
                          padding: '5px 8px', borderRadius: 7,
                          background: checked ? 'rgba(192,0,0,0.05)' : 'transparent',
                          transition: 'background .12s',
                        }}>
                          <div style={{
                            width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                            border: `1.5px solid ${checked ? '#C00000' : 'var(--input-bdr)'}`,
                            background: checked ? '#C00000' : 'transparent',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            transition: 'all .12s',
                          }}>
                            {checked && <span className="material-symbols-rounded" style={{ fontSize: 12, color: '#fff', lineHeight: 1 }}>check</span>}
                          </div>
                          <span style={{ flex: 1, fontSize: 13, fontWeight: checked ? 600 : 400, color: checked ? '#C00000' : 'var(--txt)' }}>
                            {opt.label ?? opt.value}
                          </span>
                          {opt.count !== undefined && (
                            <span style={{ fontSize: 11, color: 'var(--txt2)', fontFamily: INTER, fontVariantNumeric: 'tabular-nums' }}>{opt.count}</span>
                          )}
                        </label>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Panel footer: active chips + reset/apply */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--bdr)' }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {chips.length > 0 ? chips.map(([gk, val, lbl], i) => (
                <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--chip-bg)', color: 'var(--chip-txt)', padding: '4px 10px', borderRadius: 99, fontSize: 11.5, fontWeight: 600, fontFamily: INTER }}>
                  {lbl}
                  <button onClick={e => { e.stopPropagation(); onToggle?.(gk, val) }} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'inherit', padding: 0, display: 'flex', lineHeight: 1 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 13 }}>close</span>
                  </button>
                </div>
              )) : (
                <span style={{ fontSize: 12, color: 'var(--txt2)' }}>No filters applied</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              {onClear && (
                <button onClick={onClear} style={{ padding: '7px 14px', borderRadius: 8, border: '1.5px solid var(--input-bdr)', background: 'transparent', color: 'var(--txt2)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                  Reset
                </button>
              )}
              <button onClick={() => setPanelOpen(false)} style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: '#0E2841', color: '#fff', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                {count !== undefined ? `Apply · ${count}` : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Active chips row (panel closed, filters still active) ── */}
      {!panelOpen && chips.length > 0 && (
        <div style={{ padding: '8px 18px 0', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {chips.map(([gk, val, lbl], i) => (
            <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--chip-bg)', color: 'var(--chip-txt)', padding: '4px 10px', borderRadius: 99, fontSize: 11.5, fontWeight: 600, fontFamily: INTER }}>
              {lbl}
              <button onClick={() => onToggle?.(gk, val)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'inherit', padding: 0, display: 'flex', lineHeight: 1 }}>
                <span className="material-symbols-rounded" style={{ fontSize: 13 }}>close</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/* ── Section label ───────────────────────────────────────────────── */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--txt2)' }}>
      {children}
    </p>
  )
}

/* ── Pagination ──────────────────────────────────────────────────── */
export function Pagination({ page, hasMore, onPrev, onNext }: {
  page: number; hasMore: boolean; onPrev: () => void; onNext: () => void
}) {
  return (
    <div className="flex items-center justify-between px-5 py-3" style={{ borderTop: '1px solid var(--bdr)' }}>
      <span className="text-[12px]" style={{ color: 'var(--txt2)' }}>Page {page + 1}</span>
      <div className="flex gap-2">
        <button disabled={page === 0} onClick={onPrev}
          className="px-3 py-1.5 rounded-lg text-[12px] font-semibold disabled:opacity-40"
          style={{ color: 'var(--txt)', background: 'var(--chip-bg)' }}>
          Previous
        </button>
        <button disabled={!hasMore} onClick={onNext}
          className="px-3 py-1.5 rounded-lg text-[12px] font-semibold disabled:opacity-40"
          style={{ color: 'var(--txt)', background: 'var(--chip-bg)' }}>
          Next
        </button>
      </div>
    </div>
  )
}
