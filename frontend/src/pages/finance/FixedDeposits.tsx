import { useSearchParams } from 'react-router-dom'
import { Page, Tabs } from '../../components/UI'
import DepositsOverview from '../deposits/Dashboard'
import FDRegister from './FixedDeposit'
import FDMaturity from './FDMaturity'
import FDAccrual from './FDAccrual'

// Fixed Deposits is a single page with four views. Each view is its own
// self-contained component (data-loads only while its tab is mounted); the tab
// key is mirrored to the ?tab= query param so views are deep-linkable and the
// retired /finance/fixed-deposit|fd-maturity|fd-accrual routes can redirect here.

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'register', label: 'Register' },
  { key: 'maturity', label: 'Maturity' },
  { key: 'accrual',  label: 'Accrual'  },
]

export default function FixedDeposits() {
  const [params, setParams] = useSearchParams()
  const requested = params.get('tab')
  const tab = TABS.some(t => t.key === requested) ? requested! : 'overview'

  function setTab(key: string) {
    setParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('tab', key)
      return next
    }, { replace: true })
  }

  return (
    <Page
      title="Fixed Deposits"
      subtitle="Deposit book, register, maturities & interest accrual — Udara core banking"
    >
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'overview' && <DepositsOverview />}
      {tab === 'register' && <FDRegister />}
      {tab === 'maturity' && <FDMaturity />}
      {tab === 'accrual'  && <FDAccrual />}
    </Page>
  )
}
