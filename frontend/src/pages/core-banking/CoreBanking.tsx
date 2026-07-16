import { useEffect, useState } from 'react'
import { Page } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { NAVY, RED, GREEN, AMBER } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CBSStatus {
  configured: boolean
  connected?: boolean
  error?: string
  message?: string
}

interface Module {
  id: string
  label: string
  icon: string
  description: string
  endpoints: Endpoint[]
}

interface Endpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string          // O3C /api/cbs/... path
  label: string
  params?: string[]     // key query/body fields for display
}

// ── CBS Module Catalogue ────────────────────────────────────────────────────

const MODULES: Module[] = [
  {
    id: 'account',
    label: 'Account',
    icon: 'account_balance',
    description: 'Create individual / group / virtual accounts, search, balance enquiry, freeze/unfreeze, PND/PNC holds.',
    endpoints: [
      { method: 'POST', path: '/api/cbs/account/create-customer', label: 'Create Customer + Account', params: ['bvn', 'nin', 'firstName', 'lastName', 'productCode', 'branchCode'] },
      { method: 'POST', path: '/api/cbs/account/create',          label: 'Add Account (existing customer)', params: ['customerID', 'productCode', 'accountType'] },
      { method: 'POST', path: '/api/cbs/account/create-virtual',  label: 'Create Virtual Account', params: ['accountName', 'productCode', 'accountType', 'parentAccountNumber'] },
      { method: 'POST', path: '/api/cbs/account/create-group',    label: 'Create Group Customer', params: ['name', 'registrationNumber', 'tin'] },
      { method: 'GET',  path: '/api/cbs/account/search',          label: 'Search Accounts', params: ['AccountNumber', 'AccountName', 'BranchCode'] },
      { method: 'GET',  path: '/api/cbs/account/by-phone',        label: 'Get Accounts by Phone', params: ['PhoneNumber'] },
      { method: 'GET',  path: '/api/cbs/account/balance',         label: 'Balance Enquiry', params: ['AccountNumber'] },
      { method: 'GET',  path: '/api/cbs/account/balance-extended', label: 'Extended Balance', params: ['AccountNumber'] },
      { method: 'GET',  path: '/api/cbs/account/detail',          label: 'Account Detail', params: ['AccountNumber'] },
      { method: 'GET',  path: '/api/cbs/account/search-customers', label: 'Search Individual Customers', params: [] },
      { method: 'PUT',  path: '/api/cbs/account/update-customer', label: 'Update Account', params: ['customerID', 'accountName'] },
      { method: 'PUT',  path: '/api/cbs/account/update-customer-info', label: 'Update Customer Info', params: ['customerID'] },
      { method: 'PUT',  path: '/api/cbs/account/freeze',          label: 'Freeze Account', params: ['accountNumber'] },
      { method: 'PUT',  path: '/api/cbs/account/unfreeze',        label: 'Unfreeze Account', params: ['accountNumber'] },
      { method: 'PUT',  path: '/api/cbs/account/place-pnd',       label: 'Place PND', params: ['accountNumber'] },
      { method: 'PUT',  path: '/api/cbs/account/remove-pnd',      label: 'Remove PND', params: ['accountNumber'] },
      { method: 'PUT',  path: '/api/cbs/account/activate',        label: 'Activate Account', params: ['accountNumber'] },
      { method: 'PUT',  path: '/api/cbs/account/deactivate',      label: 'Deactivate Account', params: ['accountNumber'] },
    ],
  },
  {
    id: 'kyc',
    label: 'KYC Validation',
    icon: 'verified_user',
    description: 'Real-time identity verification: BVN, NIN, TIN, and CAC via the CBS KYC gateway.',
    endpoints: [
      { method: 'POST', path: '/api/cbs/kyc/validate-bvn', label: 'Validate BVN', params: ['bvn', 'includeData'] },
      { method: 'POST', path: '/api/cbs/kyc/validate-nin', label: 'Validate NIN', params: ['nin'] },
      { method: 'POST', path: '/api/cbs/kyc/validate-tin', label: 'Validate TIN', params: ['tin'] },
      { method: 'POST', path: '/api/cbs/kyc/validate-cac', label: 'Validate CAC', params: ['cac'] },
    ],
  },
  {
    id: 'loan',
    label: 'Loan Account',
    icon: 'payments',
    description: 'Book loans in the CBS, disburse funds, record repayments, view schedules, and early settlement.',
    endpoints: [
      { method: 'POST', path: '/api/cbs/loan/add',          label: 'Book Loan Account', params: ['customerID', 'productCode', 'loanAmount', 'tenure', 'startDate'] },
      { method: 'POST', path: '/api/cbs/loan/disburse',     label: 'Disburse Loan', params: ['loanAccountNumber'] },
      { method: 'POST', path: '/api/cbs/loan/repay',        label: 'Repay Loan', params: ['loanAccountNumber', 'amount', 'instrumentNumber'] },
      { method: 'POST', path: '/api/cbs/loan/early-repay',  label: 'Early Repayment', params: ['loanAccountNumber', 'paymentOption'] },
      { method: 'GET',  path: '/api/cbs/loan/search',       label: 'Search Loans', params: ['AccountNumber'] },
      { method: 'GET',  path: '/api/cbs/loan/schedule',     label: 'View Loan Schedule', params: ['AccountNumber'] },
      { method: 'PUT',  path: '/api/cbs/loan/update',       label: 'Update Loan', params: ['id'] },
    ],
  },
  {
    id: 'transfer',
    label: 'Transfers',
    icon: 'swap_horiz',
    description: 'Name enquiry (NIP), local fund transfers, outward (interbank) transfers, and TSQ.',
    endpoints: [
      { method: 'GET',  path: '/api/cbs/transfer/name-enquiry',       label: 'Name Enquiry', params: ['DestinationAccountNumber', 'DestinationInstitutionCode'] },
      { method: 'GET',  path: '/api/cbs/transfer/banks',              label: 'Get Banks List', params: [] },
      { method: 'POST', path: '/api/cbs/transfer/local',              label: 'Local Fund Transfer', params: ['amount', 'beneficiaryAccountNumber', 'originatorAccountNumber', 'paymentReference'] },
      { method: 'POST', path: '/api/cbs/transfer/outward',            label: 'Outward Transfer', params: ['amount', 'beneficiaryAccountNumber', 'destinationInstitutionCode'] },
      { method: 'GET',  path: '/api/cbs/transfer/tsq',               label: 'Transfer Status Query', params: ['transactionRef'] },
      { method: 'GET',  path: '/api/cbs/transfer/settlement-details', label: 'Settlement Account Details', params: ['accountNumber', 'gateway'] },
    ],
  },
  {
    id: 'fd',
    label: 'Fixed Deposit',
    icon: 'savings',
    description: 'Create CBS-backed fixed deposits, top-ups, full/part liquidation, and rollover configuration.',
    endpoints: [
      { method: 'POST', path: '/api/cbs/fd/add',       label: 'Create Fixed Deposit', params: ['liquidationAccount', 'productCode', 'principalAmount', 'tenure'] },
      { method: 'POST', path: '/api/cbs/fd/top-up',    label: 'Top-Up FD', params: ['accountNumber', 'topUpAmount'] },
      { method: 'POST', path: '/api/cbs/fd/liquidate', label: 'Liquidate FD', params: ['accountNumber', 'liquidationType', 'liquidationAmount'] },
      { method: 'GET',  path: '/api/cbs/fd/search',    label: 'Search Fixed Deposits', params: ['AccountStatus'] },
      { method: 'PUT',  path: '/api/cbs/fd/update',    label: 'Update FD Settings', params: ['id', 'applyRollover'] },
    ],
  },
  {
    id: 'savings',
    label: 'Savings',
    icon: 'account_balance_wallet',
    description: 'Frequent / target savings accounts: create, top-up, and liquidate.',
    endpoints: [
      { method: 'POST', path: '/api/cbs/savings/add',       label: 'Create Savings Plan', params: ['pocketName', 'productCode', 'amount', 'frequency', 'maturityDate'] },
      { method: 'POST', path: '/api/cbs/savings/top-up',    label: 'Top-Up Savings', params: ['accountNumber', 'topUpAmount'] },
      { method: 'POST', path: '/api/cbs/savings/liquidate', label: 'Liquidate Savings', params: ['accountNumber', 'liquidationType'] },
      { method: 'GET',  path: '/api/cbs/savings/search',    label: 'Search Savings Accounts', params: [] },
    ],
  },
  {
    id: 'cards-interswitch',
    label: 'Cards — Interswitch',
    icon: 'credit_card',
    description: 'Issue, link, and manage Interswitch cards: status updates, channel access, card search.',
    endpoints: [
      { method: 'POST', path: '/api/cbs/cards/interswitch/issue',          label: 'Issue Card', params: [] },
      { method: 'POST', path: '/api/cbs/cards/interswitch/link-instant',   label: 'Link Instant Card', params: [] },
      { method: 'PUT',  path: '/api/cbs/cards/interswitch/status',         label: 'Update Card Status', params: [] },
      { method: 'PUT',  path: '/api/cbs/cards/interswitch/channel-access', label: 'Update Channel Access', params: [] },
      { method: 'GET',  path: '/api/cbs/cards/interswitch/search',         label: 'Search Cards', params: ['MaskedPan', 'IssuanceStatus', 'CardType'] },
      { method: 'GET',  path: '/api/cbs/cards/interswitch/single',         label: 'Get Single Card', params: ['cardId'] },
      { method: 'GET',  path: '/api/cbs/cards/interswitch/by-customer',    label: 'Cards by Customer', params: ['customerId'] },
      { method: 'GET',  path: '/api/cbs/cards/interswitch/search-account', label: 'Search Card Accounts', params: ['AccountNumber'] },
    ],
  },
  {
    id: 'cards-providus',
    label: 'Cards — Providus',
    icon: 'credit_card',
    description: 'Request instant / virtual Providus cards, block/unblock, and PIN management.',
    endpoints: [
      { method: 'POST', path: '/api/cbs/cards/providus/instant',  label: 'Request Instant Card', params: ['cardProfile', 'defaultNameOnCard'] },
      { method: 'POST', path: '/api/cbs/cards/providus/virtual',  label: 'Request Virtual Card', params: ['firstName', 'lastName', 'accountNumber', 'cardProfile'] },
      { method: 'PUT',  path: '/api/cbs/cards/providus/block',    label: 'Block / Unblock Card', params: [] },
      { method: 'PUT',  path: '/api/cbs/cards/providus/pin',      label: 'Set Card PIN', params: [] },
      { method: 'GET',  path: '/api/cbs/cards/providus/search',   label: 'Search Cards', params: [] },
    ],
  },
  {
    id: 'overdraft',
    label: 'Overdraft',
    icon: 'trending_down',
    description: 'Grant, update, and manage overdraft facilities on customer accounts.',
    endpoints: [
      { method: 'POST', path: '/api/cbs/overdraft/add',        label: 'Add Overdraft', params: ['accountNumber', 'limit', 'tenure'] },
      { method: 'PUT',  path: '/api/cbs/overdraft/update',     label: 'Update Overdraft', params: ['accountNumber'] },
      { method: 'PUT',  path: '/api/cbs/overdraft/activate',   label: 'Activate Overdraft', params: ['id'] },
      { method: 'PUT',  path: '/api/cbs/overdraft/deactivate', label: 'Deactivate Overdraft', params: ['id'] },
      { method: 'GET',  path: '/api/cbs/overdraft/search',     label: 'Search Overdrafts', params: [] },
    ],
  },
  {
    id: 'lien',
    label: 'Lien',
    icon: 'lock',
    description: 'Place, update, and release liens on customer accounts for collateral or regulatory holds.',
    endpoints: [
      { method: 'POST', path: '/api/cbs/lien/place',  label: 'Place Lien', params: ['accountNumber', 'amount', 'formOfLien', 'ReferenceNumber'] },
      { method: 'POST', path: '/api/cbs/lien/update', label: 'Update Lien', params: ['id', 'accountNumber'] },
      { method: 'POST', path: '/api/cbs/lien/remove', label: 'Remove Lien', params: ['id'] },
    ],
  },
  {
    id: 'bills',
    label: 'Bills Payments',
    icon: 'receipt_long',
    description: 'Airtime, data, electricity, cable TV and other utility payments via the CBS biller network.',
    endpoints: [
      { method: 'GET',  path: '/api/cbs/bills/billers',       label: 'Get All Billers', params: [] },
      { method: 'GET',  path: '/api/cbs/bills/customer-info', label: 'Get Customer Info', params: ['CustomerId', 'GlobalBillerIdentifier'] },
      { method: 'POST', path: '/api/cbs/bills/vend',          label: 'Vend / Pay Bill', params: ['paymentReference', 'customerId', 'amount', 'accountNumber'] },
      { method: 'POST', path: '/api/cbs/bills/tsq',           label: 'Bill TSQ', params: ['transactionReference'] },
      { method: 'GET',  path: '/api/cbs/bills/search',        label: 'Search Payments', params: ['PaymentReference', 'StartDate', 'EndDate'] },
    ],
  },
  {
    id: 'postings',
    label: 'GL Postings',
    icon: 'book_2',
    description: 'Direct CBS general-ledger postings, reversals, and account closure.',
    endpoints: [
      { method: 'POST', path: '/api/cbs/postings/post-transaction', label: 'Post Transaction', params: ['debitAccount', 'creditAccount', 'amount', 'narration'] },
      { method: 'POST', path: '/api/cbs/postings/post',             label: 'Post (batch entries)', params: [] },
      { method: 'POST', path: '/api/cbs/postings/reverse',          label: 'Reverse Transaction', params: ['referenceNumber'] },
      { method: 'POST', path: '/api/cbs/postings/close-account',    label: 'Close Account', params: ['accountNumber', 'closureReason'] },
    ],
  },
  {
    id: 'reports',
    label: 'CBS Reports',
    icon: 'summarize',
    description: 'Account statements, transaction receipts, call-over, loan tracking, and savings accrual reports.',
    endpoints: [
      { method: 'GET', path: '/api/cbs/reports/statement',        label: 'Account Statement', params: ['AccountNumber', 'FinancialDateFrom', 'FinancialDateTo'] },
      { method: 'GET', path: '/api/cbs/reports/export-statement', label: 'Export Statement', params: ['AccountNumber', 'FinancialDateFrom', 'FinancialDateTo', 'FileExportFormat'] },
      { method: 'GET', path: '/api/cbs/reports/receipt',          label: 'Transaction Receipt', params: ['transactionID'] },
      { method: 'GET', path: '/api/cbs/reports/account-history',  label: 'Account History', params: ['PostingReferenceNumber'] },
      { method: 'GET', path: '/api/cbs/reports/call-over',        label: 'Call-Over Report', params: ['ReferenceNumber'] },
      { method: 'GET', path: '/api/cbs/reports/loan-tracking',    label: 'Loan Tracking Report', params: ['LoanAccountNumber'] },
      { method: 'GET', path: '/api/cbs/reports/savings-accrual',  label: 'Savings Accrual History', params: ['AccountNumber'] },
    ],
  },
  {
    id: 'limit',
    label: 'Limits',
    icon: 'speed',
    description: 'Configure account and card transaction limits (daily / single transaction).',
    endpoints: [
      { method: 'PUT', path: '/api/cbs/limit/account',       label: 'Set Account Limit', params: ['accountNumber', 'userDailyTransactionLimit', 'userSingleTransactionLimit'] },
      { method: 'GET', path: '/api/cbs/limit/account',       label: 'Get Account Limit', params: ['accountNumber'] },
      { method: 'POST', path: '/api/cbs/limit/card',         label: 'Add Card Limit', params: [] },
      { method: 'PUT', path: '/api/cbs/limit/card',          label: 'Update Card Limit', params: [] },
      { method: 'GET', path: '/api/cbs/limit/card-current',  label: 'Current Card Limit', params: ['cardId'] },
    ],
  },
  {
    id: 'products',
    label: 'Products',
    icon: 'inventory_2',
    description: 'Browse and search CBS product catalogue (loan products, account products, FD products).',
    endpoints: [
      { method: 'GET', path: '/api/cbs/products', label: 'Search Products', params: ['Code', 'Type', 'Category', 'Status'] },
    ],
  },
  {
    id: 'pos',
    label: 'POS Settlement',
    icon: 'point_of_sale',
    description: 'POS terminal management: create, update, instant settlement, and stock reports.',
    endpoints: [
      { method: 'POST', path: '/api/cbs/pos/create',             label: 'Create Terminal', params: ['terminalID', 'settlementAccountNumber'] },
      { method: 'POST', path: '/api/cbs/pos/create-bulk',        label: 'Bulk Create Terminals', params: [] },
      { method: 'POST', path: '/api/cbs/pos/settle',             label: 'Instant Settlement', params: [] },
      { method: 'PUT',  path: '/api/cbs/pos/update',             label: 'Update Terminal', params: ['id'] },
      { method: 'PUT',  path: '/api/cbs/pos/update-status',      label: 'Update Terminal Status', params: ['id', 'isActive'] },
      { method: 'GET',  path: '/api/cbs/pos/search',             label: 'Search Terminals', params: ['TerminalID', 'SerialNumber'] },
      { method: 'GET',  path: '/api/cbs/pos/stock-report',       label: 'Stock Report', params: [] },
    ],
  },
]

// ── Sub-components ────────────────────────────────────────────────────────────

const METHOD_COLOR: Record<string, string> = {
  GET:    '#1D4ED8',
  POST:   '#15803D',
  PUT:    '#B45309',
  DELETE: '#B91C1C',
}

function MethodBadge({ method }: { method: string }) {
  return (
    <span style={{
      fontFamily: 'DM Mono, monospace',
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.06em',
      color: '#fff',
      background: METHOD_COLOR[method] ?? '#6B7280',
      borderRadius: 4,
      padding: '2px 6px',
      flexShrink: 0,
    }}>{method}</span>
  )
}

function EndpointRow({ ep }: { ep: Endpoint }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 0',
      borderBottom: '1px solid #F1F5F9',
    }}>
      <MethodBadge method={ep.method} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: '#1E293B' }}>{ep.label}</div>
        {ep.params && ep.params.length > 0 && (
          <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2, fontFamily: 'DM Mono, monospace' }}>
            {ep.params.join(' · ')}
          </div>
        )}
      </div>
      <span style={{ fontSize: 11, color: '#CBD5E1', fontFamily: 'DM Mono, monospace', flexShrink: 0, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {ep.path}
      </span>
    </div>
  )
}

function ModuleCard({ mod, defaultOpen = false }: { mod: Module; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #E2E8F0',
      borderRadius: 8,
      overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          width: '100%',
          padding: '14px 16px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 22, color: RED, flexShrink: 0 }}>
          {mod.icon}
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: NAVY }}>{mod.label}</div>
          <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>{mod.description}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{
            fontSize: 11,
            fontWeight: 600,
            color: '#475569',
            background: '#F1F5F9',
            borderRadius: 12,
            padding: '2px 8px',
          }}>
            {mod.endpoints.length} endpoints
          </span>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: '#94A3B8', transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none' }}>
            expand_more
          </span>
        </div>
      </button>
      {open && (
        <div style={{ padding: '0 16px 12px' }}>
          {mod.endpoints.map(ep => <EndpointRow key={ep.method + ep.path} ep={ep} />)}
        </div>
      )}
    </div>
  )
}

function StatusBanner({ status }: { status: CBSStatus | null }) {
  if (!status) return null

  if (!status.configured) {
    return (
      <div style={{
        background: '#FFFBEB',
        border: '1px solid #FDE68A',
        borderRadius: 8,
        padding: '14px 18px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        marginBottom: 24,
      }}>
        <span className="material-symbols-rounded" style={{ fontSize: 22, color: AMBER, flexShrink: 0 }}>warning</span>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#92400E' }}>CBS Not Configured</div>
          <div style={{ fontSize: 13, color: '#78350F', marginTop: 4 }}>
            Set three environment variables on Railway to activate all endpoints:
          </div>
          <div style={{ marginTop: 8, fontFamily: 'DM Mono, monospace', fontSize: 12, color: '#78350F', background: '#FEF3C7', borderRadius: 4, padding: '8px 12px', display: 'inline-block' }}>
            UDARA360_BASE_URL=https://openapi.udara360.io<br />
            UDARA360_CLIENT_ID=your-client-id<br />
            UDARA360_CLIENT_SECRET=your-client-secret
          </div>
          <div style={{ fontSize: 12, color: '#92400E', marginTop: 8 }}>
            Use <code style={{ background: '#FDE68A', borderRadius: 3, padding: '1px 4px' }}>https://openapi.test.udara360.io</code> for the test environment.
          </div>
        </div>
      </div>
    )
  }

  if (status.connected === false) {
    return (
      <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 22, color: '#EF4444', flexShrink: 0 }}>error</span>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#991B1B' }}>CBS Unreachable</div>
          <div style={{ fontSize: 13, color: '#7F1D1D', marginTop: 2 }}>Credentials are set but the Udara360 API could not be reached. {status.error}</div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
      <span className="material-symbols-rounded" style={{ fontSize: 22, color: GREEN, flexShrink: 0 }}>check_circle</span>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#14532D' }}>
        Udara360 CBS Connected — all {MODULES.reduce((s, m) => s + m.endpoints.length, 0)} endpoints active
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CoreBanking() {
  const [status, setStatus] = useState<CBSStatus | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    apiFetch('/api/cbs/status')
      .then(r => r.json())
      .then(setStatus)
      .catch(() => setStatus({ configured: false }))
  }, [])

  const q = filter.toLowerCase()
  const visible = q
    ? MODULES.map(m => ({
        ...m,
        endpoints: m.endpoints.filter(e =>
          e.label.toLowerCase().includes(q) ||
          e.path.toLowerCase().includes(q) ||
          m.label.toLowerCase().includes(q)
        ),
      })).filter(m => m.endpoints.length > 0)
    : MODULES

  const totalEndpoints = MODULES.reduce((s, m) => s + m.endpoints.length, 0)

  return (
    <Page title="Core Banking Integration" subtitle={`Udara360 CBS · ${totalEndpoints} endpoints across ${MODULES.length} modules`}>
      <StatusBanner status={status} />

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 20 }}>
        <span className="material-symbols-rounded" style={{
          position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
          fontSize: 18, color: '#94A3B8', pointerEvents: 'none',
        }}>search</span>
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Search endpoints, modules, or paths…"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '10px 14px 10px 38px',
            border: '1px solid #E2E8F0',
            borderRadius: 8,
            fontSize: 14,
            outline: 'none',
            background: '#fff',
            color: NAVY,
          }}
        />
        {filter && (
          <button
            onClick={() => setFilter('')}
            style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', cursor: 'pointer', color: '#94A3B8', fontSize: 18, display: 'flex' }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }}>close</span>
          </button>
        )}
      </div>

      {/* Summary row */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
        {[
          { label: 'Modules', value: MODULES.length },
          { label: 'Total Endpoints', value: totalEndpoints },
          { label: 'Read (GET)', value: MODULES.flatMap(m => m.endpoints).filter(e => e.method === 'GET').length },
          { label: 'Write (POST/PUT)', value: MODULES.flatMap(m => m.endpoints).filter(e => e.method !== 'GET').length },
        ].map(s => (
          <div key={s.label} style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 8, padding: '12px 20px', minWidth: 130 }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: NAVY, fontFamily: 'DM Mono, monospace' }}>{s.value}</div>
            <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Module list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {visible.length === 0 && (
          <div style={{ textAlign: 'center', padding: 48, color: '#94A3B8', fontSize: 14 }}>
            No endpoints match "{filter}"
          </div>
        )}
        {visible.map((mod, i) => (
          <ModuleCard key={mod.id} mod={mod} defaultOpen={i === 0 && !filter} />
        ))}
      </div>

      {/* Footer note */}
      <div style={{ marginTop: 32, padding: '14px 18px', background: '#F8FAFC', borderRadius: 8, border: '1px solid #E2E8F0', fontSize: 12, color: '#64748B' }}>
        <strong style={{ color: NAVY }}>Integration pattern:</strong> The O3C backend proxies all requests to{' '}
        <code style={{ background: '#E2E8F0', borderRadius: 3, padding: '1px 4px' }}>openapi.udara360.io</code>{' '}
        on behalf of authenticated staff — Udara360 credentials are never exposed to the browser.
        All monetary amounts are in kobo (÷100 for display). Each CBS write also posts a local GL
        journal entry so O3C's shadow ledger stays in sync.
      </div>
    </Page>
  )
}
