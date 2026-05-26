import {
  ResponsiveContainer,
  AreaChart, Area,
  LineChart, Line,
  BarChart, Bar,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'

/* ── Formatters ────────────────────────────────────────────────────────────── */
export function fmt(n) {
  if (n == null) return '—'
  const v = Number(n)
  if (isNaN(v)) return '—'
  if (Math.abs(v) >= 1_000_000_000) return '₦' + (v / 1_000_000_000).toFixed(1) + 'B'
  if (Math.abs(v) >= 1_000_000)     return '₦' + (v / 1_000_000).toFixed(1) + 'M'
  if (Math.abs(v) >= 1_000)         return '₦' + (v / 1_000).toFixed(1) + 'K'
  return '₦' + v.toLocaleString('en-NG', { maximumFractionDigits: 0 })
}

export function fmtNum(n) {
  if (n == null) return '—'
  const v = Number(n)
  if (isNaN(v)) return '—'
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M'
  if (Math.abs(v) >= 1_000)     return (v / 1_000).toFixed(1) + 'K'
  return v.toLocaleString()
}

export function pct(n, decimals = 1) {
  if (n == null) return '—'
  return Number(n).toFixed(decimals) + '%'
}

/* ── Color tokens ──────────────────────────────────────────────────────────── */
const NAVY    = '#0E2841'
const RED     = '#C00000'
const PALETTE = [RED, '#3B82F6', '#10B981', NAVY, '#F59E0B', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316', '#06B6D4']

const ICON_CLS = {
  navy:   'bg-primary-50 text-primary dark:bg-primary/20 dark:text-primary-100',
  accent: 'bg-accent-50 text-accent dark:bg-accent/15 dark:text-red-400',
  green:  'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400',
  amber:  'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
  blue:   'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400',
}

/* ── Axis / grid styles ────────────────────────────────────────────────────── */
const AXIS   = { fontSize: 11, fill: '#94A3B8', fontFamily: 'Inter' }
const GRID   = '#F1F5F9'
const DGRID  = '#1E293B'

/* ── Custom Tooltip ────────────────────────────────────────────────────────── */
function ChartTooltip({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-card-lg px-3.5 py-3 min-w-[140px]">
      <p className="text-[11px] font-semibold text-slate-400 mb-2 uppercase tracking-wider">{label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
            <span className="text-xs text-slate-500">{p.name}</span>
          </div>
          <span className="text-xs font-semibold text-slate-900 dark:text-white font-mono">
            {formatter ? formatter(p.value) : p.value}
          </span>
        </div>
      ))}
    </div>
  )
}

/* ── KPI Card ──────────────────────────────────────────────────────────────── */
export function KpiCard({ label, value, sub, accent = 'navy', icon, trend, trendLabel = 'vs last month' }) {
  const iconCls = ICON_CLS[accent] || ICON_CLS.navy
  const up = trend != null && trend >= 0
  return (
    <div className="card card-hover p-6">
      <div className="flex items-start justify-between gap-2 mb-4">
        <p className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-widest leading-tight">
          {label}
        </p>
        {icon && (
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${iconCls}`}>
            <span className="material-symbols-rounded text-[20px]">{icon}</span>
          </div>
        )}
      </div>
      <p className="text-[28px] font-semibold text-slate-900 dark:text-white tracking-tight leading-none font-mono">
        {value ?? '—'}
      </p>
      <div className="mt-3 min-h-[20px]">
        {trend != null ? (
          <div className="flex items-center gap-1.5">
            <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold px-1.5 py-0.5 rounded-full ${
              up
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400'
                : 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400'
            }`}>
              <span className="material-symbols-rounded text-[11px] leading-none" style={{ fontSize: 12 }}>
                {up ? 'arrow_upward' : 'arrow_downward'}
              </span>
              {Math.abs(trend).toFixed(1)}%
            </span>
            <span className="text-[11px] text-slate-400">{trendLabel}</span>
          </div>
        ) : sub ? (
          <p className="text-xs text-slate-400 dark:text-slate-500">{sub}</p>
        ) : null}
      </div>
    </div>
  )
}

/* ── Shared chart card wrapper ──────────────────────────────────────────────── */
export function ChartCard({ title, subtitle, children, actions }) {
  return (
    <div className="card p-6">
      <div className="flex items-start justify-between mb-5">
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</p>
          {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
        </div>
        {actions && <div className="flex-shrink-0">{actions}</div>}
      </div>
      {children}
    </div>
  )
}

/* ── Area Chart Card (primary trend chart) ─────────────────────────────────── */
export function AreaChartCard({ title, subtitle, data = [], xKey, areas = [], height = 240, currency = false }) {
  const formatter = currency ? fmt : fmtNum
  return (
    <ChartCard title={title} subtitle={subtitle}>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <defs>
            {areas.map(a => (
              <linearGradient key={a.key} id={`g-${a.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor={a.color} stopOpacity={0.15} />
                <stop offset="100%" stopColor={a.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="0" stroke={GRID} vertical={false} />
          <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={false} dy={8} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={formatter} dx={-4} width={60} />
          <Tooltip content={<ChartTooltip formatter={formatter} />} cursor={{ stroke: '#E2E8F0', strokeWidth: 1 }} />
          {areas.length > 1 && <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'Inter' }} />}
          {areas.map(a => (
            <Area key={a.key} type="monotone" dataKey={a.key} name={a.label || a.key}
              stroke={a.color} strokeWidth={2} fill={`url(#g-${a.key})`}
              dot={false} activeDot={{ r: 4, strokeWidth: 0, fill: a.color }} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/* ── Line Chart Card ───────────────────────────────────────────────────────── */
export function LineChartCard({ title, subtitle, data = [], xKey, lines = [], height = 240, currency = false }) {
  const formatter = currency ? fmt : fmtNum
  return (
    <ChartCard title={title} subtitle={subtitle}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="0" stroke={GRID} vertical={false} />
          <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={false} dy={8} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={formatter} dx={-4} width={60} />
          <Tooltip content={<ChartTooltip formatter={formatter} />} cursor={{ stroke: '#E2E8F0', strokeWidth: 1 }} />
          {lines.length > 1 && <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'Inter' }} />}
          {lines.map(l => (
            <Line key={l.key} type="monotone" dataKey={l.key} name={l.label || l.key}
              stroke={l.color} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/* ── Bar Chart Card ────────────────────────────────────────────────────────── */
export function BarChartCard({ title, subtitle, data = [], xKey, bars = [], height = 240, currency = false }) {
  const formatter = currency ? fmt : fmtNum
  return (
    <ChartCard title={title} subtitle={subtitle}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barGap={4}>
          <CartesianGrid strokeDasharray="0" stroke={GRID} vertical={false} />
          <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={false} dy={8} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={formatter} dx={-4} width={60} />
          <Tooltip content={<ChartTooltip formatter={formatter} />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
          {bars.length > 1 && <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'Inter' }} />}
          {bars.map((b, i) => (
            <Bar key={b.key} dataKey={b.key} name={b.label || b.key}
              fill={b.color || PALETTE[i]} radius={[4, 4, 0, 0]} maxBarSize={40} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/* ── Horizontal Bar Card ───────────────────────────────────────────────────── */
export function HBarCard({ title, subtitle, data = [], nameKey, valueKey, currency = true, height }) {
  const formatter = currency ? fmt : fmtNum
  const h = height || Math.max(200, data.length * 36 + 56)
  return (
    <ChartCard title={title} subtitle={subtitle}>
      <ResponsiveContainer width="100%" height={h}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="0" stroke={GRID} horizontal={false} />
          <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={formatter} />
          <YAxis type="category" dataKey={nameKey} tick={AXIS} tickLine={false} axisLine={false} width={130} />
          <Tooltip content={<ChartTooltip formatter={formatter} />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
          <Bar dataKey={valueKey} fill={RED} radius={[0, 4, 4, 0]} maxBarSize={18} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/* ── Donut / Pie Card ──────────────────────────────────────────────────────── */
export function DonutCard({ title, subtitle, data = [], nameKey, valueKey, currency = false, height = 260 }) {
  const formatter = currency ? fmt : fmtNum
  return (
    <ChartCard title={title} subtitle={subtitle}>
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie data={data} dataKey={valueKey} nameKey={nameKey}
            cx="50%" cy="46%" innerRadius={68} outerRadius={98} paddingAngle={2}>
            {data.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
          <Tooltip formatter={v => [formatter(v)]} />
          <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'Inter' }} />
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/* ── Progress List Card ────────────────────────────────────────────────────── */
export function ProgressListCard({ title, subtitle, data = [], nameKey, valueKey, currency = false, maxItems = 8, actions }) {
  const formatter = currency ? fmt : fmtNum
  const items = data.slice(0, maxItems)
  const max   = Math.max(...items.map(d => Number(d[valueKey] || 0)), 1)
  const total = items.reduce((s, d) => s + Number(d[valueKey] || 0), 0)
  return (
    <ChartCard title={title} subtitle={subtitle} actions={actions}>
      <div className="space-y-3">
        {items.map((item, i) => {
          const val      = Number(item[valueKey] || 0)
          const barWidth = (val / max) * 100
          const share    = total > 0 ? (val / total) * 100 : 0
          return (
            <div key={i} className="group">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <span className="text-[10px] font-semibold text-slate-300 dark:text-slate-600 w-4 text-right flex-shrink-0 tabular-nums">{i + 1}</span>
                  <span className="text-[13px] font-medium text-slate-700 dark:text-slate-300 truncate">{item[nameKey]}</span>
                </div>
                <div className="flex items-center gap-2.5 flex-shrink-0 ml-3">
                  <span className="text-[11px] text-slate-400 tabular-nums">{share.toFixed(0)}%</span>
                  <span className="text-[13px] font-semibold text-slate-800 dark:text-slate-100 font-mono tabular-nums">{formatter(val)}</span>
                </div>
              </div>
              <div className="h-1 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden ml-[26px]">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${barWidth}%`, background: PALETTE[i % PALETTE.length] }}
                />
              </div>
            </div>
          )
        })}
        {items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-slate-400">
            <span className="material-symbols-rounded text-[32px] mb-2 opacity-40">bar_chart</span>
            <p className="text-xs">No data available</p>
          </div>
        )}
      </div>
    </ChartCard>
  )
}

/* ── Stat Summary Card ─────────────────────────────────────────────────────── */
export function StatSummaryCard({ title, icon, items = [], accent = 'navy' }) {
  const iconCls = ICON_CLS[accent] || ICON_CLS.navy
  return (
    <div className="card p-6">
      <div className="flex items-center gap-3 mb-5">
        {icon && (
          <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${iconCls}`}>
            <span className="material-symbols-rounded text-[20px]">{icon}</span>
          </div>
        )}
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</p>
      </div>
      <div>
        {items.map((item, i) => (
          <div key={i} className="flex items-center justify-between py-2.5 border-b border-slate-100 dark:border-slate-700/60 last:border-0">
            <span className="text-[13px] text-slate-500 dark:text-slate-400">{item.label}</span>
            <span className={`text-[13px] font-semibold font-mono tabular-nums ${item.color || 'text-slate-800 dark:text-slate-100'}`}>
              {item.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── Skeleton loaders ──────────────────────────────────────────────────────── */
export function KpiSkeleton() {
  return (
    <div className="card p-6">
      <div className="flex items-start justify-between mb-4">
        <div className="skeleton h-3 w-24 rounded" />
        <div className="skeleton w-9 h-9 rounded-xl" />
      </div>
      <div className="skeleton h-8 w-28 rounded mt-1" />
      <div className="skeleton h-3 w-20 rounded mt-3" />
    </div>
  )
}

export function ChartSkeleton({ height = 240 }) {
  return (
    <div className="card p-6">
      <div className="skeleton h-4 w-36 rounded mb-5" />
      <div className="skeleton rounded-lg" style={{ height }} />
    </div>
  )
}
