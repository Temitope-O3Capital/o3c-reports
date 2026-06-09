import { useState } from 'react'
import {
  ResponsiveContainer,
  AreaChart, Area,
  LineChart, Line,
  BarChart, Bar,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'

/* ═══════════════════════════════════════════════════════════════
   FORMATTERS
   ═══════════════════════════════════════════════════════════════ */

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

/* ═══════════════════════════════════════════════════════════════
   DESIGN CONSTANTS
   Hex values are intentional here — Recharts renders inside SVG
   where CSS custom properties cannot be resolved. These match
   the corresponding tokens in index.css :root.
   ═══════════════════════════════════════════════════════════════ */

const NAVY    = '#0E2841'
const RED     = '#C00000'
const PALETTE = [RED, '#3B82F6', '#10B981', NAVY, '#F59E0B', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316', '#06B6D4']

/* Chart axis + grid — matches --bg-subtle / dark --bg-subtle */
const FONT   = 'var(--font-sans)'
const AXIS   = { fontSize: 11, fill: '#94A3B8', fontFamily: FONT }
const GRID_L = '#F1F5F9'   /* light: --bg-subtle */
const GRID_D = '#1E293B'   /* dark:  --bg-subtle */

function useGrid() {
  if (typeof document === 'undefined') return GRID_L
  return document.documentElement.classList.contains('dark') ? GRID_D : GRID_L
}


/* ═══════════════════════════════════════════════════════════════
   CHART TOOLTIP
   ═══════════════════════════════════════════════════════════════ */

function ChartTooltip({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null
  return (
    <div className="card px-3.5 py-3 min-w-[140px]" style={{ boxShadow: 'var(--shadow-lg)' }}>
      <p style={{ fontSize: 10, fontWeight: 600, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
        {label}
      </p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
            <span className="text-xs text-slate-500 dark:text-slate-400">{p.name}</span>
          </div>
          <span className="text-xs font-semibold text-slate-900 dark:text-white tabular-nums">
            {formatter ? formatter(p.value) : p.value}
          </span>
        </div>
      ))}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   INFO TOOLTIP
   Small ⓘ icon next to KPI label; shows a popover on hover.
   ═══════════════════════════════════════════════════════════════ */

export function InfoTooltip({ text }) {
  const [visible, setVisible] = useState(false)
  return (
    <div
      className="relative inline-flex items-center flex-shrink-0"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      <span
        className="material-symbols-rounded select-none"
        style={{ fontSize: 13, color: 'rgb(var(--fg-3))', opacity: 0.55, cursor: 'help', lineHeight: 1 }}
      >
        info
      </span>
      {visible && (
        <div
          className="absolute bottom-full left-1/2 z-50 pointer-events-none"
          style={{ transform: 'translateX(-50%)', marginBottom: 8, minWidth: 180, maxWidth: 260 }}
        >
          <div
            className="card px-3 py-2.5"
            style={{
              fontSize: 12, lineHeight: 1.55, color: 'rgb(var(--fg-2))',
              boxShadow: 'var(--shadow-lg)',
            }}
          >
            {text}
          </div>
          {/* caret */}
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <div style={{
              width: 8, height: 8,
              background: 'rgb(var(--bg-surface))',
              transform: 'rotate(45deg)',
              marginTop: -5,
              borderRight: '1px solid rgb(var(--border) / 0.1)',
              borderBottom: '1px solid rgb(var(--border) / 0.1)',
            }} />
          </div>
        </div>
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   KPI CARD
   Stripe-style: accent left-border, large mono value, trend pill
   ═══════════════════════════════════════════════════════════════ */

const ICON_BG = {
  navy:   { bg: 'rgb(14 40 65 / 0.07)',   fg: '#0E2841' },
  accent: { bg: 'rgb(192 0 0 / 0.07)',    fg: '#C00000' },
  green:  { bg: 'rgb(5 150 105 / 0.08)',  fg: '#059669' },
  amber:  { bg: 'rgb(217 119 6 / 0.08)',  fg: '#D97706' },
  blue:   { bg: 'rgb(37 99 235 / 0.08)',  fg: '#2563EB' },
}

export function KpiCard({ label, value, sub, accent = 'navy', icon, trend, trendLabel = 'vs last month', tooltip }) {
  const ib = ICON_BG[accent] || ICON_BG.navy
  const up = trend != null && trend >= 0

  return (
    <div className="card p-5 flex flex-col">
      {/* Label + icon */}
      <div className="flex items-start justify-between gap-2 mb-4">
        <div className="flex items-center gap-1.5 min-w-0">
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'rgb(var(--fg-3))' }}>
            {label}
          </p>
          {tooltip && <InfoTooltip text={tooltip} />}
        </div>
        {icon && (
          <div style={{ width: 34, height: 34, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: ib.bg }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17, color: ib.fg }}>{icon}</span>
          </div>
        )}
      </div>

      {/* Value — large, bold, proportional (not mono) */}
      <p style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1, marginBottom: 12, color: 'rgb(var(--fg-1))', fontVariantNumeric: 'tabular-nums' }}>
        {value ?? '—'}
      </p>

      {/* Trend / sub */}
      <div style={{ minHeight: 18 }}>
        {trend != null ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 2,
              fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 20,
              background: up ? 'rgb(5 150 105 / 0.08)' : 'rgb(220 38 38 / 0.07)',
              color: up ? '#059669' : '#DC2626',
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 11, lineHeight: 1 }}>
                {up ? 'trending_up' : 'trending_down'}
              </span>
              {up ? '+' : ''}{Math.abs(trend).toFixed(1)}%
            </span>
            <span style={{ fontSize: 11, color: 'rgb(var(--fg-3))' }}>{trendLabel}</span>
          </div>
        ) : sub ? (
          <p style={{ fontSize: 12, color: 'rgb(var(--fg-3))' }}>{sub}</p>
        ) : null}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   KPI HERO — dark primary metric card (top of Overview / Collections)
   ═══════════════════════════════════════════════════════════════ */

export function KpiHero({ label, value, sub, subUp, icon = 'monitoring', children, tooltip }) {
  return (
    <div className="card p-6 md:p-8"
      style={{ background: `linear-gradient(140deg, ${NAVY} 0%, #091A2D 100%)`, border: 'none' }}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5" style={{ marginBottom: 14 }}>
            <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.45)' }}>
              {label}
            </p>
            {tooltip && (
              <span title={tooltip} style={{ fontSize: 13, color: 'rgba(255,255,255,0.35)', cursor: 'help', lineHeight: 1 }}
                className="material-symbols-rounded select-none">info</span>
            )}
          </div>
          <p style={{ fontSize: 40, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1, color: 'white', fontVariantNumeric: 'tabular-nums' }}>
            {value ?? '—'}
          </p>
          {sub && (
            <p style={{ fontSize: 13, marginTop: 10, color: subUp ? '#34D399' : 'rgba(255,255,255,0.5)' }}>
              {sub}
            </p>
          )}
        </div>
        <div style={{ width: 44, height: 44, borderRadius: 10, background: 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 22, color: 'white' }}>{icon}</span>
        </div>
      </div>
      {children && <div style={{ marginTop: 20 }}>{children}</div>}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   CHART CARD WRAPPER
   ═══════════════════════════════════════════════════════════════ */

export function ChartCard({ title, subtitle, children, actions }) {
  return (
    <div className="card p-6">
      <div className="flex items-start justify-between mb-5 gap-4">
        <div>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 leading-tight">{title}</p>
          {subtitle && (
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{subtitle}</p>
          )}
        </div>
        {actions && <div className="flex-shrink-0">{actions}</div>}
      </div>
      {children}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   AREA CHART CARD
   ═══════════════════════════════════════════════════════════════ */

export function AreaChartCard({ title, subtitle, data = [], xKey, areas = [], height = 240, currency = false }) {
  const formatter = currency ? fmt : fmtNum
  const grid = useGrid()
  return (
    <ChartCard title={title} subtitle={subtitle}>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <defs>
            {areas.map(a => (
              <linearGradient key={a.key} id={`grad-${a.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor={a.color} stopOpacity={0.14} />
                <stop offset="100%" stopColor={a.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="0" stroke={grid} vertical={false} />
          <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={false} dy={8} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={formatter} dx={-4} width={60} />
          <Tooltip content={<ChartTooltip formatter={formatter} />} cursor={{ stroke: grid, strokeWidth: 1 }} />
          {areas.length > 1 && <Legend wrapperStyle={{ fontSize: 11, fontFamily: FONT }} />}
          {areas.map(a => (
            <Area key={a.key} type="monotone" dataKey={a.key} name={a.label || a.key}
              stroke={a.color} strokeWidth={2} fill={`url(#grad-${a.key})`}
              dot={false} activeDot={{ r: 4, strokeWidth: 0, fill: a.color }} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/* ═══════════════════════════════════════════════════════════════
   LINE CHART CARD
   ═══════════════════════════════════════════════════════════════ */

export function LineChartCard({ title, subtitle, data = [], xKey, lines = [], height = 240, currency = false }) {
  const formatter = currency ? fmt : fmtNum
  const grid = useGrid()
  return (
    <ChartCard title={title} subtitle={subtitle}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="0" stroke={grid} vertical={false} />
          <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={false} dy={8} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={formatter} dx={-4} width={60} />
          <Tooltip content={<ChartTooltip formatter={formatter} />} cursor={{ stroke: grid, strokeWidth: 1 }} />
          {lines.length > 1 && <Legend wrapperStyle={{ fontSize: 11, fontFamily: FONT }} />}
          {lines.map(l => (
            <Line key={l.key} type="monotone" dataKey={l.key} name={l.label || l.key}
              stroke={l.color} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/* ═══════════════════════════════════════════════════════════════
   BAR CHART CARD
   ═══════════════════════════════════════════════════════════════ */

export function BarChartCard({ title, subtitle, data = [], xKey, bars = [], height = 240, currency = false }) {
  const formatter = currency ? fmt : fmtNum
  const grid = useGrid()
  return (
    <ChartCard title={title} subtitle={subtitle}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barGap={4}>
          <CartesianGrid strokeDasharray="0" stroke={grid} vertical={false} />
          <XAxis dataKey={xKey} tick={AXIS} tickLine={false} axisLine={false} dy={8} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={formatter} dx={-4} width={60} />
          <Tooltip content={<ChartTooltip formatter={formatter} />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
          {bars.length > 1 && <Legend wrapperStyle={{ fontSize: 11, fontFamily: FONT }} />}
          {bars.map((b, i) => (
            <Bar key={b.key} dataKey={b.key} name={b.label || b.key}
              fill={b.color || PALETTE[i]} radius={[4, 4, 0, 0]} maxBarSize={40} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/* ═══════════════════════════════════════════════════════════════
   HORIZONTAL BAR CARD
   ═══════════════════════════════════════════════════════════════ */

export function HBarCard({ title, subtitle, data = [], nameKey, valueKey, currency = true, height }) {
  const formatter = currency ? fmt : fmtNum
  const grid = useGrid()
  const h = height || Math.max(200, data.length * 36 + 56)
  return (
    <ChartCard title={title} subtitle={subtitle}>
      <ResponsiveContainer width="100%" height={h}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="0" stroke={grid} horizontal={false} />
          <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={formatter} />
          <YAxis type="category" dataKey={nameKey} tick={AXIS} tickLine={false} axisLine={false} width={130} />
          <Tooltip content={<ChartTooltip formatter={formatter} />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
          <Bar dataKey={valueKey} fill={RED} radius={[0, 4, 4, 0]} maxBarSize={18} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/* ═══════════════════════════════════════════════════════════════
   DONUT / PIE CARD
   ═══════════════════════════════════════════════════════════════ */

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
          <Legend wrapperStyle={{ fontSize: 11, fontFamily: FONT }} />
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/* ═══════════════════════════════════════════════════════════════
   PROGRESS LIST CARD
   Ranked list with proportional fill bars
   ═══════════════════════════════════════════════════════════════ */

export function ProgressListCard({ title, subtitle, data = [], nameKey, valueKey, currency = false, maxItems = 8, actions }) {
  const formatter = currency ? fmt : fmtNum
  const items = data.slice(0, maxItems)
  const max   = Math.max(...items.map(d => Number(d[valueKey] || 0)), 1)
  const total = items.reduce((s, d) => s + Number(d[valueKey] || 0), 0)

  return (
    <ChartCard title={title} subtitle={subtitle} actions={actions}>
      <div className="space-y-3.5">
        {items.map((item, i) => {
          const val      = Number(item[valueKey] || 0)
          const barWidth = (val / max) * 100
          const share    = total > 0 ? (val / total) * 100 : 0
          return (
            <div key={i}>
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  <span className="text-[10px] font-semibold w-4 text-right flex-shrink-0 tabular-nums"
                    style={{ color: 'rgb(var(--fg-4))' }}>
                    {i + 1}
                  </span>
                  <span className="text-[13px] font-medium truncate text-slate-700 dark:text-slate-300">
                    {item[nameKey]}
                  </span>
                </div>
                <div className="flex items-center gap-2.5 flex-shrink-0 ml-3">
                  <span className="text-[11px] tabular-nums" style={{ color: 'rgb(var(--fg-3))' }}>
                    {share.toFixed(0)}%
                  </span>
                  <span className="text-[13px] font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                    {formatter(val)}
                  </span>
                </div>
              </div>
              <div className="h-1 rounded-full overflow-hidden ml-[26px]"
                style={{ backgroundColor: 'rgb(var(--bg-muted))' }}>
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${barWidth}%`,
                    background: PALETTE[i % PALETTE.length],
                    transition: 'width 0.7s ease',
                  }}
                />
              </div>
            </div>
          )
        })}

        {items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8" style={{ color: 'rgb(var(--fg-3))' }}>
            <span className="material-symbols-rounded text-[32px] mb-2 opacity-40">bar_chart</span>
            <p className="text-xs">No data available</p>
          </div>
        )}
      </div>
    </ChartCard>
  )
}

/* ═══════════════════════════════════════════════════════════════
   STAT SUMMARY CARD
   Key-value list with optional icon header
   ═══════════════════════════════════════════════════════════════ */

export function StatSummaryCard({ title, icon, items = [], accent = 'navy' }) {
  const ib = ICON_BG[accent] || ICON_BG.navy
  return (
    <div className="card p-6">
      <div className="flex items-center gap-3 mb-5">
        {icon && (
          <div style={{ width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, background: ib.bg }}>
            <span className="material-symbols-rounded" style={{ fontSize: 17, color: ib.fg }}>{icon}</span>
          </div>
        )}
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</p>
      </div>
      <div className="divide-y" style={{ borderColor: 'rgb(var(--border) / 0.06)' }}>
        {items.map((item, i) => (
          <div key={i} className="flex items-center justify-between py-2.5">
            <span className="text-[13px]" style={{ color: 'rgb(var(--fg-2))' }}>{item.label}</span>
            <span className={`text-[13px] font-semibold tabular-nums ${item.color || 'text-slate-800 dark:text-slate-100'}`}>
              {item.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   SKELETON LOADERS
   ═══════════════════════════════════════════════════════════════ */

export function KpiSkeleton() {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="skeleton h-2.5 w-20 rounded" />
        <div className="skeleton w-8 h-8 rounded-lg" />
      </div>
      <div className="skeleton h-7 w-28 rounded mt-2" />
      <div className="skeleton h-2.5 w-16 rounded mt-3" />
    </div>
  )
}

export function ChartSkeleton({ height = 240 }) {
  return (
    <div className="card p-6">
      <div className="skeleton h-4 w-32 rounded mb-5" />
      <div className="skeleton rounded-lg" style={{ height }} />
    </div>
  )
}
