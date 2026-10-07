import { useState } from 'react'
import { NAVY, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { fmtNum } from '../../lib/fmt'
import { Sk } from '../UI'

// A real ledger: sections (Assets/Liabilities, Income/Expense, Operating/Investing/
// Financing...) expand to lines, lines expand to accounts, every level shows its own
// subtotal whether expanded or not, and the whole statement ends in one grand total.
// Shared by Balance Sheet, Income Statement and Cash Flow Statement — the three pages
// the user calls "the ledger" — so the expand/collapse chrome, indentation, and totals
// styling stay identical across all three rather than three hand-rolled versions.
//
// Deliberately NOT the generic drag/drop pivot (Report Builder's SummaryView) — rows are
// fixed accounting structure here, not user-chosen dimensions. Clicking an account row
// (onClick, if given) is the existing drill-down-to-entries behavior each page already
// wires up; this component only owns the tree chrome and the arithmetic of totals.

export interface LedgerAccount {
  key: string
  label: string
  amount: number
  postings?: number
  onClick?: () => void
  /** Rendered after the label, e.g. a GL code. */
  meta?: string
}
export interface LedgerLine {
  key: string
  label: string
  accounts: LedgerAccount[]
  /** Only when the line itself is directly drillable (no per-account breakdown available). */
  onClick?: () => void
  meta?: string
}
export interface LedgerSection {
  key: string
  label: string
  lines: LedgerLine[]
  /** Accent bar colour for this section (Assets vs Liabilities, Income vs Expense...). */
  accent?: string
}

function lineTotal(line: LedgerLine): { amount: number; postings: number } {
  if (line.accounts.length === 0) return { amount: 0, postings: 0 }
  return line.accounts.reduce(
    (s, a) => ({ amount: s.amount + a.amount, postings: s.postings + (a.postings ?? 0) }),
    { amount: 0, postings: 0 },
  )
}
function sectionTotal(section: LedgerSection): number {
  return section.lines.reduce((s, l) => s + lineTotal(l).amount, 0)
}

const ROW_H = 40

function Chevron({ open }: { open: boolean }) {
  return (
    <span className="material-symbols-rounded" style={{
      fontSize: 18, color: 'var(--txt3)', transition: 'transform .15s',
      transform: open ? 'rotate(90deg)' : 'rotate(0deg)', flexShrink: 0,
    }}>chevron_right</span>
  )
}

export function LedgerTree({
  sections, grandTotalLabel = 'Grand Total', grandTotal: grandTotalOverride, fmtAmount, loading,
  emptyText = 'Nothing to show for this period', unitLabel = 'postings',
}: {
  sections: LedgerSection[]
  grandTotalLabel?: string
  /**
   * Summing every section's own total is only correct when sections are meant to ADD
   * (e.g. Cash Flow's Operating+Investing+Financing). Income Statement's Net is Income
   * MINUS Expense, Balance Sheet's Net Position is Assets MINUS Liabilities — those
   * callers must supply the real figure here rather than let the sections sum blindly.
   */
  grandTotal?: number
  fmtAmount: (kobo: number) => string
  loading?: boolean
  emptyText?: string
  /** Plural noun for the count badge, e.g. "postings" (default) or "items". */
  unitLabel?: string
}) {
  const unit = (n: number) => `${fmtNum(n)} ${n === 1 ? unitLabel.replace(/s$/, '') : unitLabel}`
  // Both maps default-open: a ledger that hides its own breakdown on first paint reads as
  // empty, not summarized. Collapsing is the user's choice to make, not the default.
  const [closedSections, setClosedSections] = useState<Set<string>>(new Set())
  const [closedLines, setClosedLines] = useState<Set<string>>(new Set())

  const toggleSection = (k: string) => setClosedSections(s => {
    const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n
  })
  const toggleLine = (k: string) => setClosedLines(s => {
    const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n
  })

  const grandTotal = grandTotalOverride ?? sections.reduce((s, sec) => s + sectionTotal(sec), 0)
  const hasAny = sections.some(sec => sec.lines.length > 0)

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
        {[0, 1, 2].map(i => <Sk key={i} h={ROW_H} />)}
      </div>
    )
  }

  if (!hasAny) {
    return (
      <div style={{ padding: `${SP[6]} ${SP[4]}`, textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>
        {emptyText}
      </div>
    )
  }

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--card-bdr)', borderRadius: RADIUS.lg, overflow: 'hidden' }}>
      {sections.map(section => {
        const sOpen = !closedSections.has(section.key)
        const sTotal = sectionTotal(section)
        return (
          <div key={section.key}>
            {/* Section row */}
            <div
              role="button" tabIndex={0} onClick={() => toggleSection(section.key)}
              onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleSection(section.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: SP[2], height: ROW_H + 4, padding: `0 ${SP[4]}`,
                background: 'var(--th-bg)', borderTop: '1px solid var(--bdr)', cursor: 'pointer', userSelect: 'none',
                borderLeft: section.accent ? `3px solid ${section.accent}` : undefined,
              }}
            >
              <Chevron open={sOpen} />
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: 'var(--txt)', letterSpacing: '0.01em', flex: 1 }}>
                {section.label}
              </span>
              <span style={{ ...NUM, fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt)' }}>{fmtAmount(sTotal)}</span>
            </div>

            {sOpen && section.lines.map(line => {
              const lOpen = !closedLines.has(line.key)
              const { amount: lTotal, postings: lPostings } = lineTotal(line)
              const expandable = line.accounts.length > 1 || (line.accounts.length === 1 && line.accounts[0].label !== line.label)
              const rowClickable = expandable ? () => toggleLine(line.key) : line.onClick
              return (
                <div key={line.key}>
                  <div
                    role={rowClickable ? 'button' : undefined} tabIndex={rowClickable ? 0 : undefined}
                    onClick={rowClickable}
                    onKeyDown={rowClickable ? (e => (e.key === 'Enter' || e.key === ' ') && rowClickable()) : undefined}
                    style={{
                      display: 'flex', alignItems: 'center', gap: SP[2], height: ROW_H, padding: `0 ${SP[4]} 0 ${SP[6]}`,
                      borderTop: '1px solid var(--bdr)', cursor: rowClickable ? 'pointer' : 'default',
                      transition: 'background .1s',
                    }}
                    onMouseEnter={e => { if (rowClickable) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '' }}
                  >
                    {expandable ? <Chevron open={lOpen} /> : <span style={{ width: 18, flexShrink: 0 }} />}
                    <span style={{
                      fontSize: TEXT.sm, fontWeight: FW.semibold, color: line.onClick && !expandable ? NAVY : 'var(--txt)', flex: 1,
                      textDecoration: line.onClick && !expandable ? 'underline' : undefined, textDecorationStyle: 'dotted', textUnderlineOffset: 3,
                    }}>
                      {line.label}
                      {line.meta && <span style={{ color: 'var(--txt3)', fontWeight: FW.normal, marginLeft: 6, fontSize: TEXT.xs }}>{line.meta}</span>}
                    </span>
                    {lPostings > 0 && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginRight: SP[2] }}>{unit(lPostings)}</span>}
                    <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{fmtAmount(lTotal)}</span>
                  </div>

                  {expandable && lOpen && line.accounts.map(acc => (
                    <div
                      key={acc.key}
                      role={acc.onClick ? 'button' : undefined} tabIndex={acc.onClick ? 0 : undefined}
                      onClick={acc.onClick}
                      onKeyDown={acc.onClick ? (e => (e.key === 'Enter' || e.key === ' ') && acc.onClick!()) : undefined}
                      style={{
                        display: 'flex', alignItems: 'center', gap: SP[2], height: ROW_H - 4, padding: `0 ${SP[4]} 0 76px`,
                        borderTop: '1px solid var(--bdr)', cursor: acc.onClick ? 'pointer' : 'default',
                      }}
                      onMouseEnter={e => { if (acc.onClick) (e.currentTarget as HTMLElement).style.background = 'var(--row-hvr)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '' }}
                    >
                      <span style={{
                        fontSize: TEXT.sm, color: acc.onClick ? NAVY : 'var(--txt2)', flex: 1,
                        textDecoration: acc.onClick ? 'underline' : undefined, textDecorationStyle: 'dotted', textUnderlineOffset: 3,
                      }}>
                        {acc.label}
                        {acc.meta && <span style={{ color: 'var(--txt3)', marginLeft: 6, fontSize: TEXT.xs }}>· {acc.meta}</span>}
                      </span>
                      {!!acc.postings && <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginRight: SP[2] }}>{unit(acc.postings)}</span>}
                      <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtAmount(acc.amount)}</span>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )
      })}

      {/* Grand total */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: SP[2], height: ROW_H + 8, padding: `0 ${SP[4]}`,
        background: 'var(--accent-soft)', borderTop: `2px solid var(--accent)`,
      }}>
        <span style={{ fontSize: TEXT.base, fontWeight: FW.extrabold, color: 'var(--accent)', flex: 1 }}>{grandTotalLabel}</span>
        <span style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.extrabold, color: 'var(--accent)' }}>{fmtAmount(grandTotal)}</span>
      </div>
    </div>
  )
}

