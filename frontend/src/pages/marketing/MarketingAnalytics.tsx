import { useSearchParams } from 'react-router-dom'
import { Page, Tabs } from '../../components/UI'
import PerformanceTab from '../campaigns/Analytics'
import AttributionTab from './Attribution'
import FunnelTab from './Funnel'

// Marketing Analytics is one page with three views. Each view is a self-contained
// component that loads its own data only while its tab is mounted; the tab key is
// mirrored to ?tab= so views are deep-linkable and the retired standalone routes
// (/campaigns/analytics, /marketing/attribution, /marketing/funnel) can redirect here.

const TABS = [
  { key: 'performance', label: 'Performance' },
  { key: 'attribution', label: 'Attribution' },
  { key: 'funnel',      label: 'Funnel'      },
]

export default function MarketingAnalytics() {
  const [params, setParams] = useSearchParams()
  const requested = params.get('tab')
  const tab = TABS.some(t => t.key === requested) ? requested! : 'performance'

  function setTab(key: string) {
    setParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('tab', key)
      return next
    }, { replace: true })
  }

  return (
    <Page
      title="Marketing Analytics"
      subtitle="Campaign performance, origination attribution & the acquisition funnel"
    >
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'performance' && <PerformanceTab />}
      {tab === 'attribution' && <AttributionTab />}
      {tab === 'funnel'      && <FunnelTab />}
    </Page>
  )
}
