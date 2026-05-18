import {
  ResponsiveContainer,
  LineChart, Line,
  BarChart, Bar,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'

/* ── Formatters ──────────────────────────────────────────────────────────── */
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

const NAVY  = '#0E2841'
const RED   = '#C00000'
const PALETTE = [RED, NAVY, '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#14B8A6']

/* ── KPI Card ────────────────────────────────────────────────────────────── */
export function KpiCard({ label, value, sub, accent = 'navy' }) {
  return (
    <div className={`kpi-card ${accent}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}

/* ── Line Chart Card ─────────────────────────────────────────────────────── */
export function LineChartCard({ title, data = [], xKey, lines = [], height = 240 }) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E8ECF0" />
          <XAxis dataKey={xKey} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={v => fmtNum(v)} />
          <Tooltip formatter={(v, name) => [fmtNum(v), name]} />
          {lines.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {lines.map((l, i) => (
            <Line key={l.key} type="monotone" dataKey={l.key} name={l.label || l.key}
              stroke={l.color || PALETTE[i]} strokeWidth={2} dot={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

/* ── Currency Line Chart Card ────────────────────────────────────────────── */
export function CurrencyLineCard({ title, data = [], xKey, lines = [], height = 240 }) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E8ECF0" />
          <XAxis dataKey={xKey} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={v => fmt(v)} />
          <Tooltip formatter={(v, name) => [fmt(v), name]} />
          {lines.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {lines.map((l, i) => (
            <Line key={l.key} type="monotone" dataKey={l.key} name={l.label || l.key}
              stroke={l.color || PALETTE[i]} strokeWidth={2} dot={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

/* ── Bar Chart Card ──────────────────────────────────────────────────────── */
export function BarChartCard({ title, data = [], xKey, bars = [], height = 240, currency = false }) {
  const formatter = currency ? fmt : fmtNum
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E8ECF0" vertical={false} />
          <XAxis dataKey={xKey} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatter} />
          <Tooltip formatter={(v, name) => [formatter(v), name]} />
          {bars.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {bars.map((b, i) => (
            <Bar key={b.key} dataKey={b.key} name={b.label || b.key}
              fill={b.color || PALETTE[i]} radius={[4, 4, 0, 0]} maxBarSize={48} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/* ── Horizontal Bar Card ─────────────────────────────────────────────────── */
export function HBarCard({ title, data = [], nameKey, valueKey, currency = true, height }) {
  const formatter = currency ? fmt : fmtNum
  const h = height || Math.max(200, data.length * 36 + 40)
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <ResponsiveContainer width="100%" height={h}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E8ECF0" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatter} />
          <YAxis type="category" dataKey={nameKey} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={120} />
          <Tooltip formatter={(v) => [formatter(v)]} />
          <Bar dataKey={valueKey} fill={RED} radius={[0, 4, 4, 0]} maxBarSize={20} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/* ── Donut / Pie Card ────────────────────────────────────────────────────── */
export function DonutCard({ title, data = [], nameKey, valueKey, currency = false, height = 260 }) {
  const formatter = currency ? fmt : fmtNum
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie data={data} dataKey={valueKey} nameKey={nameKey}
            cx="50%" cy="50%" innerRadius={60} outerRadius={95}
            paddingAngle={2}>
            {data.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(v) => [formatter(v)]} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}
