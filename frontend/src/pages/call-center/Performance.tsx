import { useState } from 'react'
import { Page, DateFilter } from '../../components/UI'
import { today } from '../../lib/fmt'
import PerformancePanel from '../helpdesk/PerformancePanel'
import OtherReviewPanel from './OtherReviewPanel'

// The call-center Performance page and the Supervisor → Performance tab render the
// same shared panel, so the metrics stay identical in both places.
export default function CallCenterPerformance() {
  // One range for the page, not one per panel.
  //
  // This page stacks two panels that both read the call log over a date range, and each
  // used to carry its own control: the house DateFilter inside PerformancePanel and a
  // bespoke pair of <input type="date"> inside OtherReviewPanel, with their own defaults
  // (90 days and 30 days). A supervisor who changed one and read the other was comparing
  // two different periods with nothing on screen saying so. The dates live here now and
  // drive both panels, so there is one picker and one answer to "which period is this".
  //
  // 90 days is kept as the default: the window PerformancePanel already used, and the
  // one its trend charts are drawn for. It widens the Other review's default from 30
  // days, which reads more of that backlog rather than less.
  const [from, setFrom] = useState(() => new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10))
  const [to, setTo] = useState(today())
  const onChange = (f: string, t: string) => { setFrom(f); setTo(t) }

  return (
    <Page
      title="Call Center Performance"
      subtitle="Agent performance, call volumes, connect rates & QA: from live call activity"
      actions={<DateFilter from={from} to={to} onChange={onChange} align="right" />}
    >
      <PerformancePanel range={{ from, to, onChange }} />
      {/* Below the shared panel rather than inside it: PerformancePanel is also rendered by the
          helpdesk, while this is gated on ccIsSupervisor and asks a call-centre question. It
          lives on the page a supervisor already opens to read the floor — a review loop nobody
          walks past does not get walked. */}
      <OtherReviewPanel from={from} to={to} />
    </Page>
  )
}
