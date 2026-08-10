import { fmtNum, fmtPct } from '../../lib/fmt'
import { GREEN, AMBER, RED, NUM, TEXT, FW, RADIUS } from '../../lib/design'

// Shared horizontal funnel used by the Performance (engagement) and Funnel tabs.
// Each bar is sized against the funnel's top value, and annotated with the
// step-over-step conversion (% of the previous stage) and, optionally, the
// cumulative conversion from the first stage.

export interface FunnelStep {
  label: string
  value: number
  color: string
  hint?: string
}

function convColor(pct: number): string {
  return pct >= 0.5 ? GREEN : pct >= 0.2 ? AMBER : RED
}

export function FunnelChart({ steps, showCumulative = false }: { steps: FunnelStep[]; showCumulative?: boolean }) {
  const top = steps.length ? Math.max(1, steps[0].value) : 1
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {steps.map((step, i) => {
        const prev   = i > 0 ? steps[i - 1].value : step.value
        const ofPrev = prev > 0 ? step.value / prev : 1
        const ofTop  = top > 0 ? step.value / top : 0
        const barW   = Math.max(ofTop * 100, step.value > 0 ? 3 : 0)
        return (
          <div key={step.label}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                {step.label}
                {step.hint && <span style={{ marginLeft: 6, fontSize: TEXT.xs, fontWeight: FW.medium, color: 'var(--txt3)' }}>{step.hint}</span>}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {i > 0 && (
                  <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: convColor(ofPrev) }}>
                    {fmtPct(ofPrev * 100)} <span style={{ color: 'var(--txt3)', fontWeight: FW.medium }}>of prev</span>
                  </span>
                )}
                <span style={{ fontSize: TEXT.md, fontWeight: FW.extrabold, color: step.color, ...NUM, minWidth: 54, textAlign: 'right' }}>
                  {fmtNum(step.value)}
                </span>
              </div>
            </div>
            <div style={{ height: 26, background: 'var(--bdr)', borderRadius: RADIUS.sm, overflow: 'hidden', position: 'relative' }}>
              <div style={{
                width: `${barW}%`, height: '100%', background: step.color, borderRadius: RADIUS.sm,
                transition: 'width .4s ease', opacity: 0.9,
                display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 8,
              }}>
                {showCumulative && i > 0 && ofTop >= 0.08 && (
                  <span style={{ fontSize: TEXT['2xs'], fontWeight: FW.bold, color: '#fff', ...NUM }}>{fmtPct(ofTop * 100)}</span>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
