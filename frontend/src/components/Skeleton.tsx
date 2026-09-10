import type { CSSProperties } from 'react'
import { RADIUS } from '../lib/design'

// Reusable loading skeletons. A page renders a skeleton that reserves the final
// layout while its data loads, so content fills in place instead of the page
// popping in section-by-section ("half page then full"). The `.sk` class (index.css)
// supplies the pulse; these compose it into cards, stat rows, charts and tables.

export function Sk({ w = '100%', h = 12, r, style }: { w?: number | string; h?: number | string; r?: number | string; style?: CSSProperties }) {
  return <span className="sk" style={{ display: 'block', width: w, height: h, borderRadius: r ?? RADIUS.sm, ...style }} />
}

function Card({ children, style }: { children?: React.ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.xl, padding: 18, boxShadow: 'var(--card-shadow)', ...style }}>
      {children}
    </div>
  )
}

// A single stat/KPI tile skeleton.
export function SkStat() {
  return (
    <div style={{ padding: '20px 22px' }}>
      <Sk w={72} h={9} />
      <Sk w={120} h={26} style={{ marginTop: 14 }} />
      <Sk w={90} h={9} style={{ marginTop: 14 }} />
    </div>
  )
}

// A row of KPI tiles inside one bordered strip (matches the common dashboard header).
export function SkKpiRow({ count = 5 }: { count?: number }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', boxShadow: 'var(--card-shadow)', borderRadius: RADIUS.xl, display: 'grid', gridTemplateColumns: `repeat(${count}, 1fr)` }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{ borderRight: i < count - 1 ? '1px solid var(--bdr)' : undefined }}><SkStat /></div>
      ))}
    </div>
  )
}

// A titled card with a big body block (chart placeholder).
export function SkChartCard({ height = 260 }: { height?: number }) {
  return (
    <Card>
      <Sk w={180} h={13} />
      <Sk w={120} h={9} style={{ marginTop: 8 }} />
      <Sk h={height} r={RADIUS.lg} style={{ marginTop: 16 }} />
    </Card>
  )
}

// A titled card with N table rows.
export function SkTable({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: 16, borderBottom: '1px solid var(--bdr)' }}><Sk w={160} h={13} /></div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} style={{ display: 'grid', gridTemplateColumns: `1.6fr ${'1fr '.repeat(Math.max(1, cols - 1))}`, gap: 16, padding: '13px 16px', borderBottom: r < rows - 1 ? '1px solid var(--bdr)' : undefined, alignItems: 'center' }}>
            {Array.from({ length: cols }).map((_, c) => <Sk key={c} h={11} w={c === 0 ? '80%' : '55%'} />)}
          </div>
        ))}
      </div>
    </Card>
  )
}

// Generic analytics-page body skeleton: KPI strip + a wide chart + a two-up + a table.
// Reserves the layout most data pages settle into. Rendered inside a <Page>'s content
// area (the page header/title stays real), so only the body is skeletal.
export function PageSkeleton({ kpis = 5 }: { kpis?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SkKpiRow count={kpis} />
      <SkChartCard height={260} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 14 }}>
        <SkChartCard height={200} />
        <SkChartCard height={200} />
      </div>
      <SkTable rows={6} cols={4} />
    </div>
  )
}

// Full-page skeleton for the router's lazy-load fallback: a faux page header + body,
// so a cold route load shows a page-shaped placeholder instead of a lone spinner.
export function RouteSkeleton() {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '20px 24px', overflow: 'hidden' }}>
      <div style={{ marginBottom: 18 }}>
        <Sk w={220} h={22} r={RADIUS.md} />
        <Sk w={320} h={11} style={{ marginTop: 10 }} />
      </div>
      <PageSkeleton />
    </div>
  )
}
