// Shared UI primitives used across all pages
import { useState, useRef, useEffect, useId, ReactNode } from 'react'
import { STATUS_LABELS, snake } from '../lib/labels'
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { fmt, fmtNum, fmtDate, n, today, monthStart, yearStart } from '../lib/fmt'

/* ── Design tokens ──────────────────────────────────────────────── */
export const NAVY  = '#0E2841'
export const RED   = '#C00000'
export const GREEN = '#059669'
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
      style={{ background: up ? 'rgba(5,150,105,0.08)' : 'rgba(220,38,38,0.07)', color: up ? GREEN : '#DC2626' }}>
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
  icon: string
  accent?: string
  loading?: boolean
}

export function KpiCard({ label, value, sub, change, icon, accent = NAVY, loading }: KpiProps) {
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
        <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-slate-400">{label}</p>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: `${accent}12` }}>
          <span className="material-symbols-rounded text-[16px]" style={{ color: accent }}>{icon}</span>
        </div>
      </div>
      <p className="kpi-number text-[26px] leading-none text-slate-900">{value}</p>
      <div className="flex items-center gap-2 mt-3">
        {change != null
          ? <><ChangeBadge value={change} /><span className="text-[11px] text-slate-400">WoW</span></>
          : sub ? <span className="text-[12px] text-slate-400">{sub}</span>
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
        style={{ borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
        <div>
          <p className="text-[14px] font-semibold text-slate-800">{title}</p>
          {subtitle && <p className="text-[12px] text-slate-400 mt-0.5">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {badge != null && (
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
              style={{ background: 'rgba(14,40,65,0.07)', color: '#475569' }}>
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
}: {
  cols: ColDef<T>[]
  rows: T[]
  loading?: boolean
  emptyIcon?: string
  emptyMsg?: string
}) {
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  let data = [...rows]
  if (sortKey) {
    data.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey]
      if (av == null) return 1; if (bv == null) return -1
      return sortDir === 'asc' ? (av < bv ? -1 : 1) : (av > bv ? -1 : 1)
    })
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c.key}
                onClick={() => c.sortable !== false && toggleSort(c.key)}
                className={`px-5 py-3 text-[10.5px] font-semibold uppercase tracking-[0.07em] whitespace-nowrap select-none ${c.sortable !== false ? 'cursor-pointer' : ''} ${c.right ? 'text-right' : 'text-left'}`}
                style={{ background: NAVY, color: sortKey === c.key ? '#fff' : 'rgba(255,255,255,0.6)' }}>
                <span className={`inline-flex items-center gap-1 ${c.right ? 'flex-row-reverse' : ''}`}>
                  {c.label}
                  {c.sortable !== false && (
                    <span className="material-symbols-rounded text-[13px]"
                      style={{ color: sortKey === c.key ? '#fff' : 'rgba(255,255,255,0.3)' }}>
                      {sortKey === c.key ? (sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}
                    </span>
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
                  {cols.map((_, j) => <td key={j} className="px-5 py-3.5"><Sk /></td>)}
                </tr>
              ))
            : data.length === 0
            ? (
                <tr>
                  <td colSpan={cols.length} className="px-5 py-14 text-center">
                    <span className="material-symbols-rounded text-[36px] text-slate-300 block mb-2">{emptyIcon}</span>
                    <p className="text-[13px] text-slate-400">{emptyMsg}</p>
                  </td>
                </tr>
              )
            : data.map((row, i) => (
                <tr key={i} className="transition-colors hover:bg-slate-50"
                  style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}>
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
    <div className="bg-white rounded-lg border px-3 py-2.5 shadow-lg"
      style={{ borderColor: 'rgba(15,23,42,0.1)', fontSize: 12 }}>
      <p className="text-slate-400 text-[10px] font-semibold uppercase tracking-wider mb-1.5">{label}</p>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: p.color ?? p.fill }} />
          <span className="font-semibold font-mono text-slate-800">
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
                <linearGradient id={`grad-${areaKey}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor={color} stopOpacity={0.13} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
              <XAxis dataKey={xKey} tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false}
                tickFormatter={v => currency ? fmt(v) : fmtNum(v)} width={currency ? 60 : 44}
                domain={[(dataMin: number) => dataMin < 0 ? Math.floor(dataMin * 1.12) : 0, (dataMax: number) => Math.ceil(dataMax * 1.15) || 10]} />
              <Tooltip content={<ChartTip currency={currency} />} />
              <Area type="monotone" dataKey={areaKey} stroke={color} strokeWidth={1.5}
                fill={`url(#grad-${areaKey})`} dot={false}
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
              <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
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
                    <span className="text-[12px] text-slate-500">{d[nameKey]}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] font-semibold font-mono text-slate-800">{fmt(d[valueKey])}</span>
                    {total > 0 && <span className="text-[11px] text-slate-400">({((n(d[valueKey]) / total) * 100).toFixed(0)}%)</span>}
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
                  <span className="text-[12px] text-slate-600 truncate max-w-[60%]">{d[nameKey]}</span>
                  <span className="text-[12px] font-semibold font-mono text-slate-800">
                    {currency ? fmt(d[valueKey]) : fmtNum(d[valueKey])}
                  </span>
                </div>
                <div className="h-1.5 rounded-full" style={{ background: 'rgba(14,40,65,0.07)' }}>
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
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[12px] font-medium transition-all bg-white"
        style={{ borderColor: open ? NAVY : 'rgba(15,23,42,0.15)', color: '#334155' }}>
        <span className="material-symbols-rounded text-[15px] text-slate-400">calendar_month</span>
        {label}
        <span className="material-symbols-rounded text-[15px] text-slate-400">{open ? 'expand_less' : 'expand_more'}</span>
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1.5 z-50 card p-4 shadow-xl"
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
                    background: active ? 'rgba(14,40,65,0.08)' : 'transparent',
                    color: active ? NAVY : '#64748B',
                  }}>
                  {p.label}
                </button>
              )
            })}
          </div>
          <div className="border-t pt-3" style={{ borderColor: 'rgba(15,23,42,0.08)' }}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Custom range</p>
            <div className="flex items-center gap-2">
              <input type="date" value={from}
                onChange={e => onChange(e.target.value, to)}
                className="flex-1 px-2 py-1.5 rounded border text-[12px] outline-none"
                style={{ borderColor: 'rgba(15,23,42,0.15)' }} />
              <span className="text-slate-300 text-sm">–</span>
              <input type="date" value={to}
                onChange={e => onChange(from, e.target.value)}
                className="flex-1 px-2 py-1.5 rounded border text-[12px] outline-none"
                style={{ borderColor: 'rgba(15,23,42,0.15)' }} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Page wrapper ───────────────────────────────────────────────── */
export function Page({
  dept, title, subtitle, actions, children,
}: {
  dept?: string; title: string; subtitle?: string; actions?: ReactNode; children: ReactNode
}) {
  return (
    <div className="px-8 py-7 max-w-[1440px] mx-auto">
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          {dept && (
            <p className="text-[13px] text-slate-400 mb-1">
              <span className="text-slate-600 font-medium">{dept}</span>
              <span className="mx-1.5 text-slate-300">›</span>
              <span className="text-slate-500">{title}</span>
            </p>
          )}
          <h1 className="text-[26px] font-bold tracking-tight text-slate-900 leading-tight">
            {title}
          </h1>
          {subtitle && <p className="text-[13px] text-slate-400 mt-0.5">{subtitle}</p>}
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
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[12px] font-medium transition-all bg-white disabled:opacity-60"
      style={{ borderColor: 'rgba(15,23,42,0.15)', color: '#475569' }}>
      {loading
        ? <><div className="w-3.5 h-3.5 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin" />Exporting…</>
        : <><span className="material-symbols-rounded text-[15px]">download</span>Export CSV</>}
    </button>
  )
}
