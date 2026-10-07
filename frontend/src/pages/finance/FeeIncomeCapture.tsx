import { useEffect, useState } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, Button, Input, Select, StatusBadge } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut, unwrapList } from '../../lib/api'
import { fmtKoboExact, fmtDate, today } from '../../lib/fmt'
import { TEXT, SP } from '../../lib/design'

// Manual fee capture — card joining/membership/reissue/maintenance fees and loan
// management/other fees have no reliable upstream source (migration 341's header: only
// 3 one-off GL corrections for card joining fees, ever; Udara's loan products have fees
// switched off entirely). This is the maker-checker screen Revenue Breakdown's "Card
// Joining Fee" / "Loan Fee" lines have been pointing at since that page shipped — reads
// entries recorded here as soon as they're approved.

interface CardFee {
  id: number; fee_date: string; fee_type: string; product_code: string | null
  account_number: string; cif: string | null; currency: string; amount_kobo: number
  ref: string | null; status: string; branch_name: string | null
  initiated_by: number | null; approved_by: number | null; approved_at: string | null
}
interface LoanFee {
  id: number; fee_date: string; fee_type: string; loan_account: string; amount_kobo: number
  currency: string; ref: string | null; status: string; branch_name: string | null
  loan_segment: string | null; initiated_by_name: string | null; approved_by_name: string | null; approved_at: string | null
}

const CARD_FEE_TYPES = ['membership', 'reissue', 'maintenance', 'joining', 'blink', 'other'] as const
const LOAN_FEE_TYPES = ['management', 'other'] as const

function ActionCell({ status, busy, onApprove, onReject }: { status: string; busy: boolean; onApprove: () => void; onReject: () => void }) {
  if (status !== 'pending') return null
  return (
    <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
      <Button size="xs" variant="ghost" loading={busy} onClick={onApprove}>Approve</Button>
      <Button size="xs" variant="danger" loading={busy} onClick={onReject}>Reject</Button>
    </div>
  )
}

export default function FeeIncomeCapture() {
  const [error, setError] = useState<string | null>(null)

  // ── Card fees ──────────────────────────────────────────────────────────────
  const [cardFees, setCardFees] = useState<CardFee[]>([])
  const [cardLoading, setCardLoading] = useState(true)
  const [cardForm, setCardForm] = useState({
    fee_date: today(), fee_type: 'joining', account_number: '', cif: '', currency: 'NGN',
    amount_kobo: '', ref: '', branch_name: '',
  })
  const [cardBusy, setCardBusy] = useState(false)
  const [cardActingId, setCardActingId] = useState<number | null>(null)

  async function loadCardFees() {
    setCardLoading(true)
    try {
      const res = await apiFetch('/api/finance/fee-income')
      setCardFees(unwrapList<CardFee>(res))
    } catch {
      setCardFees([])
    } finally {
      setCardLoading(false)
    }
  }

  async function submitCardFee() {
    if (!cardForm.account_number || !cardForm.amount_kobo || Number(cardForm.amount_kobo) <= 0) return
    setCardBusy(true)
    setError(null)
    try {
      await apiPost('/api/finance/fee-income', {
        fee_date: cardForm.fee_date, fee_type: cardForm.fee_type, account_number: cardForm.account_number,
        cif: cardForm.cif || undefined, currency: cardForm.currency,
        amount_kobo: Math.round(Number(cardForm.amount_kobo) * 100), ref: cardForm.ref || undefined,
        branch_name: cardForm.branch_name || undefined,
      })
      setCardForm({ ...cardForm, account_number: '', cif: '', amount_kobo: '', ref: '' })
      loadCardFees()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to record the card fee')
    } finally {
      setCardBusy(false)
    }
  }

  async function actOnCardFee(id: number, action: 'approve' | 'reject') {
    setCardActingId(id)
    try {
      await apiPut(`/api/finance/fee-income/${id}/${action}`, {})
      loadCardFees()
    } catch (e: any) {
      setError(e?.message ?? `Failed to ${action} the entry`)
    } finally {
      setCardActingId(null)
    }
  }

  // ── Loan fees ──────────────────────────────────────────────────────────────
  const [loanFees, setLoanFees] = useState<LoanFee[]>([])
  const [loanLoading, setLoanLoading] = useState(true)
  const [loanForm, setLoanForm] = useState({ fee_date: today(), fee_type: 'management', loan_account: '', amount_kobo: '', currency: 'NGN', ref: '' })
  const [loanBusy, setLoanBusy] = useState(false)
  const [loanActingId, setLoanActingId] = useState<number | null>(null)

  async function loadLoanFees() {
    setLoanLoading(true)
    try {
      const res = await apiFetch('/api/finance/loan-fee-income')
      setLoanFees(unwrapList<LoanFee>(res))
    } catch {
      setLoanFees([])
    } finally {
      setLoanLoading(false)
    }
  }

  async function submitLoanFee() {
    if (!loanForm.loan_account || !loanForm.amount_kobo || Number(loanForm.amount_kobo) <= 0) return
    setLoanBusy(true)
    setError(null)
    try {
      await apiPost('/api/finance/loan-fee-income', {
        fee_date: loanForm.fee_date, fee_type: loanForm.fee_type, loan_account: loanForm.loan_account,
        amount_kobo: Math.round(Number(loanForm.amount_kobo) * 100), currency: loanForm.currency, ref: loanForm.ref || undefined,
      })
      setLoanForm({ ...loanForm, loan_account: '', amount_kobo: '', ref: '' })
      loadLoanFees()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to record the loan fee')
    } finally {
      setLoanBusy(false)
    }
  }

  async function actOnLoanFee(id: number, action: 'approve' | 'reject') {
    setLoanActingId(id)
    try {
      await apiPut(`/api/finance/loan-fee-income/${id}/${action}`, {})
      loadLoanFees()
    } catch (e: any) {
      setError(e?.message ?? `Failed to ${action} the entry`)
    } finally {
      setLoanActingId(null)
    }
  }

  useEffect(() => { loadCardFees(); loadLoanFees() }, [])

  const cardCols: TableCol<CardFee>[] = [
    { key: 'fee_date', label: 'Date', render: r => fmtDate(r.fee_date) },
    { key: 'fee_type', label: 'Type', render: r => <span style={{ textTransform: 'capitalize' }}>{r.fee_type}</span> },
    { key: 'account_number', label: 'Account' },
    { key: 'branch_name', label: 'Branch', render: r => r.branch_name === 'Head Office Branch' ? 'Lagos' : r.branch_name === 'Abuja Branch' ? 'Abuja' : '—' },
    { key: 'amount_kobo', label: 'Amount', align: 'right', render: r => fmtKoboExact(r.amount_kobo) },
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} /> },
    {
      key: 'id', label: '', align: 'right', sortable: false,
      render: r => <ActionCell status={r.status} busy={cardActingId === r.id}
        onApprove={() => actOnCardFee(r.id, 'approve')} onReject={() => actOnCardFee(r.id, 'reject')} />,
    },
  ]

  const loanCols: TableCol<LoanFee>[] = [
    { key: 'fee_date', label: 'Date', render: r => fmtDate(r.fee_date) },
    { key: 'fee_type', label: 'Type', render: r => <span style={{ textTransform: 'capitalize' }}>{r.fee_type}</span> },
    { key: 'loan_segment', label: 'Segment', render: r => r.loan_segment ?? '—' },
    { key: 'loan_account', label: 'Loan Account' },
    { key: 'branch_name', label: 'Branch', render: r => r.branch_name === 'Head Office Branch' ? 'Lagos' : r.branch_name === 'Abuja Branch' ? 'Abuja' : '—' },
    { key: 'amount_kobo', label: 'Amount', align: 'right', render: r => fmtKoboExact(r.amount_kobo) },
    { key: 'status', label: 'Status', render: r => <StatusBadge status={r.status} /> },
    {
      key: 'id', label: '', align: 'right', sortable: false,
      render: r => <ActionCell status={r.status} busy={loanActingId === r.id}
        onApprove={() => actOnLoanFee(r.id, 'approve')} onReject={() => actOnLoanFee(r.id, 'reject')} />,
    },
  ]

  return (
    <Page title="Fee Income Capture" subtitle="Card and loan fees with no reliable GL source — recorded here, maker-checker, counted in Revenue Breakdown once approved"
      back={{ label: 'Finance', to: '/finance' }}>
      <ErrBanner error={error} onRetry={() => { loadCardFees(); loadLoanFees() }} />

      <SectionCard title="Card Fees" subtitle="Joining, membership, reissue, maintenance, Blink, other">
        <div style={{ display: 'flex', gap: SP[4], alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: SP[4] }}>
          <Input label="Date" type="date" value={cardForm.fee_date} onChange={e => setCardForm({ ...cardForm, fee_date: e.target.value })} wrapStyle={{ width: 150 }} />
          <Select label="Fee Type" value={cardForm.fee_type} onChange={e => setCardForm({ ...cardForm, fee_type: e.target.value })} wrapStyle={{ width: 150 }}>
            {CARD_FEE_TYPES.map(t => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
          </Select>
          <Input label="Account Number" value={cardForm.account_number} onChange={e => setCardForm({ ...cardForm, account_number: e.target.value })} wrapStyle={{ width: 180 }} />
          <Input label="CIF (optional)" value={cardForm.cif} onChange={e => setCardForm({ ...cardForm, cif: e.target.value })} wrapStyle={{ width: 140 }} />
          <Input label="Amount (₦)" type="number" value={cardForm.amount_kobo} onChange={e => setCardForm({ ...cardForm, amount_kobo: e.target.value })} wrapStyle={{ width: 140 }} />
          <Select label="Branch" value={cardForm.branch_name} onChange={e => setCardForm({ ...cardForm, branch_name: e.target.value })} wrapStyle={{ width: 150 }}>
            <option value="">Unspecified</option>
            <option value="Head Office Branch">Lagos</option>
            <option value="Abuja Branch">Abuja</option>
          </Select>
          <Input label="Reference (optional)" value={cardForm.ref} onChange={e => setCardForm({ ...cardForm, ref: e.target.value })} wrapStyle={{ width: 180 }} />
          <Button onClick={submitCardFee} loading={cardBusy} style={{ marginTop: 22 }}>Record Fee</Button>
        </div>
        <DataTable cols={cardCols} rows={cardFees} keyFn={r => r.id} loading={cardLoading} emptyText="No card fees recorded yet" />
      </SectionCard>

      <div style={{ marginTop: SP[4] }}>
        <SectionCard title="Loan Fees" subtitle="Management vs other — SME/Individual is resolved from the loan account, not entered">
          <div style={{ display: 'flex', gap: SP[4], alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: SP[4] }}>
            <Input label="Date" type="date" value={loanForm.fee_date} onChange={e => setLoanForm({ ...loanForm, fee_date: e.target.value })} wrapStyle={{ width: 150 }} />
            <Select label="Fee Type" value={loanForm.fee_type} onChange={e => setLoanForm({ ...loanForm, fee_type: e.target.value })} wrapStyle={{ width: 150 }}>
              {LOAN_FEE_TYPES.map(t => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
            </Select>
            <Input label="Loan Account" value={loanForm.loan_account} onChange={e => setLoanForm({ ...loanForm, loan_account: e.target.value })} wrapStyle={{ width: 180 }} />
            <Input label="Amount (₦)" type="number" value={loanForm.amount_kobo} onChange={e => setLoanForm({ ...loanForm, amount_kobo: e.target.value })} wrapStyle={{ width: 140 }} />
            <Input label="Reference (optional)" value={loanForm.ref} onChange={e => setLoanForm({ ...loanForm, ref: e.target.value })} wrapStyle={{ width: 180 }} />
            <Button onClick={submitLoanFee} loading={loanBusy} style={{ marginTop: 22 }}>Record Fee</Button>
          </div>
          <DataTable cols={loanCols} rows={loanFees} keyFn={r => r.id} loading={loanLoading} emptyText="No loan fees recorded yet" />
        </SectionCard>
      </div>

      <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: SP[4] }}>
        Every entry here needs a second person's approval before it counts anywhere — a mistaken entry costs nothing until signed off.
      </p>
    </Page>
  )
}
