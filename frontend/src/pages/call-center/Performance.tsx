import { Page } from '../../components/UI'
import PerformancePanel from '../helpdesk/PerformancePanel'

// The call-center Performance page and the Supervisor → Performance tab render the
// same shared panel, so the metrics stay identical in both places.
export default function CallCenterPerformance() {
  return (
    <Page
      title="Call Center Performance"
      subtitle="Agent performance, call volumes, connect rates & QA: from live call activity"
    >
      <PerformancePanel />
    </Page>
  )
}
