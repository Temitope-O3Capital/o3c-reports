import {
  ResponsiveContainer,
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

const NAVY    = '#0E2841'
const RED     = '#C00000'
const PALETTE = [RED, NAVY, '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316', '#06B6D4']

const ACCENT_CLASSES = {
  navy:   'border-l-primary  bg-primary-50  dark:bg-primary/10',
  accent: 'border-l-accent   bg-accent-50   dark:bg-accent/10',
  green:  'border-l-emerald-600 bg-emerald-50 dark:bg-emerald-900/20',
  amber:  'border-l-amber-500  bg-amber-50   dark:bg-amber-900/20',
}

const ICON_BG = {
  navy:   'bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary-50',
  accent: 'bg-accent/10 text-accent dark:bg-accent/20',
  green:  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  amber:  'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
}

/* ── KPI Card ──────────────────────────────────────────────────────────────── */
export function KpiCard({ label, value, sub, accent = 'navy', icon, trend, trendLabel = 'vs last month' }) {
  const iconBg = ICON_BG[accent] || ICON_BG.navy
  const trendUp = trend != null && trend >= 0
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider leading-tight truncate">
            {label}
          </p>
          <p className="text-2xl font-bold text-slate-900 dark:text-white mt-2 font-mono">
            {value ?? '—'}
          </p>
          {trend != null ? (
            <div className="flex items-center gap-1 mt-1.5">
              <span className={`inline-flex items-center gap-0.5 text-[11px] font-bold px-1.5 py-0.5 rounded-full ${
                trendUp ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                        : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'
              }`}>
                <span className="material-symbols-outlined text-[11px]">{trendUp ? 'arrow_upward' : 'arrow_downward'}</span>
                {Math.abs(trend).toFixed(1)}%
              </span>
              <span className="text-[10px] text-slate-400">{trendLabel}</span>
            </div>
          ) : sub ? (
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">{sub}</p>
          ) : null}
        </div>
        {icon && (
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${iconBg}`}>
            <span className="material-symbols-outlined text-[20px]">{icon}</span>
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Shared chart card wrapper ──────────────────────────────────────────────── */
function ChartCard({ title, children }) {
  return (
    <div className="card p-5">
      <p className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-4">{title}</p>
      {children}
    </div>
  )
}

const AXIS_STYLE = { fontSize: 11, fill: '#94a3b8' }
const GRID_COLOR = '#e2e8f0'

/* ── Line Chart Card ───────────────────────────────────────────────────────── */
export function LineChartCard({ title, data = [], xKey, lines = [], height = 240 }) {
  return (
    <ChartCard title={title}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />
          <XAxis dataKey={xKey} tick={AXIS_STYLE} tickLine={false} axisLine={false} />
          <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} tickFormatter={fmtNum} />
          <Tooltip formatter={(v, name) => [fmtNum(v), name]} />
          {lines.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {lines.map((l, i) => (
            <Line key={l.key} type="monotone" dataKey={l.key} name={l.label || l.key}
              stroke={l.color || PALETTE[i]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/* ── Currency Line Chart Card ──────────────────────────────────────────────── */
export function CurrencyLineCard({ title, data = [], xKey, lines = [], height = 240 }) {
  return (
    <ChartCard title={title}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />
          <XAxis dataKey={xKey} tick={AXIS_STYLE} tickLine={false} axisLine={false} />
          <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} tickFormatter={fmt} />
          <Tooltip formatter={(v, name) => [fmt(v), name]} />
          {lines.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {lines.map((l, i) => (
            <Line key={l.key} type="monotone" dataKey={l.key} name={l.label || l.key}
              stroke={l.color || PALETTE[i]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/* ── Bar Chart Card ────────────────────────────────────────────────────────── */
export function BarChartCard({ title, data = [], xKey, bars = [], height = 240, currency = false }) {
  const formatter = currency ? fmt : fmtNum
  return (
    <ChartCard title={title}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
          <XAxis dataKey={xKey} tick={AXIS_STYLE} tickLine={false} axisLine={false} />
          <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} tickFormatter={formatter} />
          <Tooltip formatter={(v, name) => [formatter(v), name]} />
          {bars.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {bars.map((b, i) => (
            <Bar key={b.key} dataKey={b.key} name={b.label || b.key}
              fill={b.color || PALETTE[i]} radius={[4, 4, 0, 0]} maxBarSize={48} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/* ── Horizontal Bar Card ───────────────────────────────────────────────────── */
export function HBarCard({ title, data = [], nameKey, valueKey, currency = true, height }) {
  const formatter = currency ? fmt : fmtNum
  const h = height || Math.max(200, data.length * 36 + 40)
  return (
    <ChartCard title={title}>
      <ResponsiveContainer width="100%" height={h}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} horizontal={false} />
          <XAxis type="number" tick={AXIS_STYLE} tickLine={false} axisLine={false} tickFormatter={formatter} />
          <YAxis type="category" dataKey={nameKey} tick={AXIS_STYLE} tickLine={false} axisLine={false} width={120} />
          <Tooltip formatter={(v) => [formatter(v)]} />
          <Bar dataKey={valueKey} fill={RED} radius={[0, 4, 4, 0]} maxBarSize={20} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/* ── Donut / Pie Card ──────────────────────────────────────────────────────── */
export function DonutCard({ title, data = [], nameKey, valueKey, currency = false, height = 260 }) {
  const formatter = currency ? fmt : fmtNum
  return (
    <ChartCard title={title}>
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie data={data} dataKey={valueKey} nameKey={nameKey}
            cx="50%" cy="50%" innerRadius={65} outerRadius={95} paddingAngle={2}>
            {data.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(v) => [formatter(v)]} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/* ── Progress List Card ────────────────────────────────────────────────────── */
export function ProgressListCard({ title, data = [], nameKey, valueKey, currency = false, maxItems = 8, actions }) {
  const formatter = currency ? fmt : fmtNum
  const items = data.slice(0, maxItems)
  const max = Math.max(...items.map(d => Number(d[valueKey] || 0)), 1)
  const total = items.reduce((s, d) => s + Number(d[valueKey] || 0), 0)
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm font-bold text-slate-700 dark:text-slate-200">{title}</p>
        {actions}
      </div>
      <div className="space-y-3">
        {items.map((item, i) => {
          const val = Number(item[valueKey] || 0)
          const barPct = (val / max) * 100
          const sharePct = total > 0 ? (val / total) * 100 : 0
          return (
            <div key={i}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="text-[10px] font-bold text-slate-400 w-4 text-right flex-shrink-0">{i + 1}</span>
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">{item[nameKey]}</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                  <span className="text-[10px] text-slate-400">{sharePct.toFixed(0)}%</span>
                  <span className="text-xs font-bold text-slate-800 dark:text-slate-200 font-mono">{formatter(val)}</span>
                </div>
              </div>
              <div className="h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden ml-6">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${barPct}%`, background: PALETTE[i % PALETTE.length] }}
                />
              </div>
            </div>
          )
        })}
        {items.length === 0 && (
          <p className="text-xs text-slate-400 text-center py-4">No data available</p>
        )}
      </div>
    </div>
  )
}

/* ── Stat Summary Card ─────────────────────────────────────────────────────── */
export function StatSummaryCard({ title, icon, items = [], accent = 'navy' }) {
  const iconBg = ICON_BG[accent] || ICON_BG.navy
  return (
    <div className="card p-5">
      <div className="flex items-center gap-3 mb-4">
        {icon && (
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${iconBg}`}>
            <span className="material-symbols-outlined text-[18px]">{icon}</span>
          </div>
        )}
        <p className="text-sm font-bold text-slate-700 dark:text-slate-200">{title}</p>
      </div>
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-slate-700 last:border-0">
            <span className="text-xs text-slate-500 dark:text-slate-400">{item.label}</span>
            <span className={`text-sm font-bold font-mono ${item.color || 'text-slate-800 dark:text-slate-200'}`}>{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
