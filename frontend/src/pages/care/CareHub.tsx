import { useSearchParams, useNavigate } from 'react-router-dom'
import { Page, Tabs } from '../../components/UI'
import { currentUser } from '../../hooks/useAuth'
import { NAVY, RADIUS, TEXT, FW } from '../../lib/design'
import OverviewTab from './Dashboard'
import SupervisorTab from './Supervisor'
import AnalyticsTab from './Analytics'

// Care hub — one page with three views. The Inbox stays its own full-height page
// (/care/inbox); this hub carries the dashboards. Tab key is mirrored to ?tab= so
// views are deep-linkable and the retired /care/supervisor route can redirect here.
// The Supervisor view is head/admin-only, matching the old route guard.

export default function CareHub() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const user = currentUser()
  const isHead = user?.role === 'call_center_head' || user?.role === 'admin'

  const tabs = [
    { key: 'overview', label: 'Overview' },
    ...(isHead ? [{ key: 'supervisor', label: 'Supervisor' }] : []),
    { key: 'analytics', label: 'Analytics' },
  ]

  const requested = params.get('tab')
  const tab = tabs.some(t => t.key === requested) ? requested! : 'overview'

  function setTab(key: string) {
    setParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('tab', key)
      return next
    }, { replace: true })
  }

  return (
    <Page
      title="Care"
      subtitle="Customer mail — workload, team & analytics"
      actions={
        <button onClick={() => navigate('/care/inbox')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: NAVY, color: '#fff', border: 'none', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold, cursor: 'pointer' }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18 }}>mail</span>
          Open Inbox
        </button>
      }
    >
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      {tab === 'overview' && <OverviewTab />}
      {tab === 'supervisor' && isHead && <SupervisorTab />}
      {tab === 'analytics' && <AnalyticsTab />}
    </Page>
  )
}
