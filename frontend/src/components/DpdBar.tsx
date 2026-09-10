import { fmtKobo } from '../lib/fmt'
import { DPD_BUCKETS } from '../lib/riskScale'
import { TEXT, FW, SP, RADIUS, INTER, NUM } from '../lib/design'

export interface DpdBucketDatum { bucket: string; count: number; kobo?: number }

const N = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

// One segmented bar of the whole book, split and coloured by DPD bucket (current /
// 1-30 / 31-60 / 61-90 / 90+), with a legend underneath. Shared by the Risk
// Overview, the risk agent's My Dashboard and the Supervisor view so the colours,
// buckets and NPL cut-off (>90) stay identical everywhere.
export function DpdBar({ buckets, height = 36 }: { buckets: DpdBucketDatum[]; height?: number }) {
  const cByKey = new Map(buckets.map(b => [b.bucket, N(b.count)]))
  const kByKey = new Map(buckets.map(b => [b.bucket, N(b.kobo)]))
  const total = DPD_BUCKETS.reduce((s, b) => s + (cByKey.get(b.key) ?? 0), 0) || 1
  return (
    <div>
      <div style={{ display: 'flex', height, borderRadius: RADIUS.md, overflow: 'hidden', border: '1px solid var(--bdr)' }}>
        {DPD_BUCKETS.map(b => {
          const c = cByKey.get(b.key) ?? 0
          if (c === 0) return null
          const kobo = kByKey.get(b.key) ?? 0
          return (
            <div key={b.key} title={`${b.label}: ${c}${kobo ? ' · ' + fmtKobo(kobo) : ''}`} style={{
              flex: c, background: b.color, display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 28,
            }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.bold, color: '#fff', ...NUM, textShadow: '0 1px 2px rgba(0,0,0,.3)' }}>{c}</span>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP[4], marginTop: 12 }}>
        {DPD_BUCKETS.map(b => {
          const c = cByKey.get(b.key) ?? 0
          return (
            <div key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: b.color, flexShrink: 0 }} />
              {b.label}
              <span style={{ ...NUM, fontWeight: FW.bold, color: 'var(--txt)' }}>{c}</span>
              <span style={{ color: 'var(--txt3)' }}>· {Math.round((c / total) * 100)}%</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
