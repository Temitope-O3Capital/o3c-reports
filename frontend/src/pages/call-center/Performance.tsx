import { Page } from '../../components/UI'
import PerformancePanel from '../helpdesk/PerformancePanel'
import OtherReviewPanel from './OtherReviewPanel'

// The call-center Performance page and the Supervisor → Performance tab render the
// same shared panel, so the metrics stay identical in both places.
export default function CallCenterPerformance() {
  return (
    <Page
      title="Call Center Performance"
      subtitle="Agent performance, call volumes, connect rates & QA: from live call activity"
    >
      <PerformancePanel />
      {/* Below the shared panel rather than inside it: PerformancePanel is also rendered by the
          helpdesk, while this is gated on ccIsSupervisor and asks a call-centre question. It
          lives on the page a supervisor already opens to read the floor — a review loop nobody
          walks past does not get walked. */}
      <OtherReviewPanel />
    </Page>
  )
}
