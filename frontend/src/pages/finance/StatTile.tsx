import { NUM, TEXT, FW } from '../../lib/design'

// One small labelled figure inside a SectionCard — the unit the Finance pages
// build their Position / Income Earned / Maturities panels out of.
//
// This existed three times over: `Tile` in Overview.tsx and `MiniStat` in both
// Treasury.tsx and Eod.tsx, byte-for-byte the same component under two names.
// Three copies meant a spacing or colour change landed on whichever page the
// author happened to have open. One definition now; import it.
export default function StatTile({
  label,
  value,
  color = 'var(--txt)',
  sub,
}: {
  label: string
  value: string
  color?: string
  sub?: string
}) {
  return (
    <div style={{ padding: '12px 16px', border: '1px solid var(--bdr)', borderRadius: 10, background: 'var(--card)' }}>
      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: FW.semibold }}>{label}</div>
      <div style={{ ...NUM, fontSize: 20, fontWeight: FW.bold, color, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}
