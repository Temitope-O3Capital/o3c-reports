import { useState } from 'react'
import { Page } from '../../components/UI'
import SpendingBehaviour from '../../components/SpendingBehaviour'
import RepaymentBehaviour from '../../components/RepaymentBehaviour'
import { NAVY, INTER, TEXT, FW, RADIUS, SP } from '../../lib/design'

// BI view: portfolio-wide customer spending & behaviour. Same shared block as the
// Executive Growth and Growth-monitor pages, with a window selector for the analyst.
const WINDOWS = [3, 6, 12, 24, 36]

export default function BehaviourAnalytics() {
  const [months, setMonths] = useState(12)
  return (
    <Page
      title="Customer Behaviour"
      subtitle="Where the book spends, on what, how and where — windowed metrics count cards; the activity cohort is all-time"
      actions={
        <div style={{ display: 'flex', gap: 2, background: 'var(--chip-bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.lg, padding: 3 }}>
          {WINDOWS.map(m => (
            <button key={m} onClick={() => setMonths(m)} style={{
              padding: '5px 13px', borderRadius: RADIUS.md, border: 'none', cursor: 'pointer',
              fontSize: TEXT.sm, fontWeight: FW.semibold, fontFamily: INTER,
              background: months === m ? NAVY : 'transparent',
              color: months === m ? '#fff' : 'var(--txt2)',
            }}>{m}m</button>
          ))}
        </div>
      }
    >
      <SpendingBehaviour title="Spending & behaviour" subtitle={`Card & account activity · last ${months} months`} months={months} />
      <div style={{ marginTop: SP[5] }}>
        <RepaymentBehaviour />
      </div>
    </Page>
  )
}
