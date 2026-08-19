import { useEffect, useState } from 'react'
import { Modal, Button, Input, Select } from './UI'
import { apiFetch } from '../lib/api'
import { TEXT, FW, SP, RADIUS, NAVY } from '../lib/design'
import { PRODUCT_LINES, PRODUCT_SUBS, lineOfCode } from '../lib/products'
import { toast } from 'sonner'

// A single, product-aware application modal for Sales — replaces the full-page LOS
// wizard for the sales-side quick raise. It covers all three lines (Cards, Loans,
// Fixed Deposit), can park a draft to pick up later, and submits to the right desk
// (credit products → Risk; prepaid & FD → the relevant ops queue, decided server-side).

export interface DraftApp {
  id: number
  product_type: string
  applicant_cif: string
  applicant_name?: string | null
  amount_requested_kobo?: number | null
  tenor_months?: number | null
  purpose?: string | null
  employer?: string | null
  monthly_income_kobo?: number | null
}

interface Props {
  open: boolean
  onClose: () => void
  onSaved?: () => void
  /** Resume/submit an existing draft. */
  draft?: DraftApp | null
  /** Pre-fill the applicant when launched from a customer/lead context. */
  presetCif?: string
  presetName?: string
}

// Amount label reads naturally per product.
function amountLabel(code: string): string {
  switch (code) {
    case 'credit_card':   return 'Requested credit limit (₦)'
    case 'prepaid':       return 'Initial load (₦)'
    case 'fixed_deposit': return 'Principal (₦)'
    default:              return 'Amount requested (₦)'
  }
}

export default function NewApplicationModal({ open, onClose, onSaved, draft, presetCif, presetName }: Props) {
  const [product, setProduct] = useState('')
  const [cif, setCif]         = useState('')
  const [name, setName]       = useState('')
  const [amount, setAmount]   = useState('')
  const [tenor, setTenor]     = useState('')
  const [purpose, setPurpose] = useState('')
  const [employer, setEmployer] = useState('')
  const [income, setIncome]   = useState('')
  const [busy, setBusy]       = useState(false)

  // (Re)hydrate when opened — from a draft, a preset, or blank.
  useEffect(() => {
    if (!open) return
    if (draft) {
      setProduct(draft.product_type ?? '')
      setCif(draft.applicant_cif ?? '')
      setName(draft.applicant_name ?? '')
      setAmount(draft.amount_requested_kobo ? String(draft.amount_requested_kobo / 100) : '')
      setTenor(draft.tenor_months ? String(draft.tenor_months) : '')
      setPurpose(draft.purpose ?? '')
      setEmployer(draft.employer ?? '')
      setIncome(draft.monthly_income_kobo ? String(draft.monthly_income_kobo / 100) : '')
    } else {
      setProduct(''); setCif(presetCif ?? ''); setName(presetName ?? '')
      setAmount(''); setTenor(''); setPurpose(''); setEmployer(''); setIncome('')
    }
  }, [open, draft, presetCif, presetName])

  const line = lineOfCode(product)
  const showTenor    = line === 'loans' || line === 'fixed_deposit'
  const showEmployer = line === 'loans' || product === 'credit_card'

  function payload() {
    return {
      cif: cif.trim(),
      product_type: product,
      amount_requested_kobo: amount ? Math.round(Number(amount) * 100) : 0,
      tenor_months: tenor ? parseInt(tenor) : 0,
      purpose: purpose.trim(),
      employer: employer.trim(),
      monthly_income_kobo: income ? Math.round(Number(income) * 100) : 0,
    }
  }

  async function saveDraft() {
    if (!product) { toast.error('Choose a product'); return }
    if (!cif.trim()) { toast.error('Enter the customer CIF'); return }
    setBusy(true)
    try {
      if (draft) {
        await apiFetch(`/api/sales/applications/${draft.id}`, { method: 'PATCH', body: JSON.stringify(payload()) })
      } else {
        await apiFetch('/api/sales/applications', { method: 'POST', body: JSON.stringify({ ...payload(), draft: true }) })
      }
      toast.success('Draft saved')
      onSaved?.(); onClose()
    } catch (e: any) { toast.error(e.message) }
    finally { setBusy(false) }
  }

  async function submit() {
    if (!product) { toast.error('Choose a product'); return }
    if (!cif.trim()) { toast.error('Enter the customer CIF'); return }
    if (!amount || Number(amount) <= 0) { toast.error('Enter an amount before submitting'); return }
    setBusy(true)
    try {
      if (draft) {
        // Persist any edits, then push.
        await apiFetch(`/api/sales/applications/${draft.id}`, { method: 'PATCH', body: JSON.stringify(payload()) })
        await apiFetch(`/api/sales/applications/${draft.id}/submit`, { method: 'POST', body: JSON.stringify({}) })
      } else {
        await apiFetch('/api/sales/applications', { method: 'POST', body: JSON.stringify({ ...payload(), draft: false }) })
      }
      toast.success('Application submitted')
      onSaved?.(); onClose()
    } catch (e: any) { toast.error(e.message) }
    finally { setBusy(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title={draft ? 'Resume application' : 'New application'} width={560}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="secondary" loading={busy} onClick={saveDraft}>Save draft</Button>
          <Button variant="primary" loading={busy} onClick={submit}>Submit</Button>
        </div>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ gridColumn: '1 / -1' }}>
          <Select label="Product" value={product} onChange={e => setProduct(e.target.value)}>
            <option value="">Which product…</option>
            {PRODUCT_LINES.map(pl => (
              <optgroup key={pl.line} label={pl.label}>
                {PRODUCT_SUBS.filter(s => s.line === pl.line).map(s => (
                  <option key={s.code} value={s.code}>{s.label}</option>
                ))}
              </optgroup>
            ))}
          </Select>
        </div>
        <Input label="Customer CIF" value={cif} onChange={e => setCif(e.target.value)} placeholder="e.g. 21013" />
        <Input label="Customer name (optional)" value={name} onChange={e => setName(e.target.value)} />
        <Input label={amountLabel(product)} type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
        {showTenor && (
          <Input label={line === 'fixed_deposit' ? 'Term (months)' : 'Tenor (months)'} type="number" value={tenor} onChange={e => setTenor(e.target.value)} placeholder="0" />
        )}
        {showEmployer && <>
          <Input label="Employer" value={employer} onChange={e => setEmployer(e.target.value)} />
          <Input label="Monthly income (₦)" type="number" value={income} onChange={e => setIncome(e.target.value)} placeholder="0.00" />
        </>}
        <div style={{ gridColumn: '1 / -1' }}>
          <Input label="Purpose / note (optional)" value={purpose} onChange={e => setPurpose(e.target.value)} />
        </div>
      </div>
      <div style={{ marginTop: 12, padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md, background: `${NAVY}0A`, fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.5 }}>
        {line === 'loans' || product === 'credit_card'
          ? 'Submitting sends this to Risk for a credit decision.'
          : line === 'cards'
            ? 'Submitting sends this to Card Ops for issuance.'
            : line === 'fixed_deposit'
              ? 'Submitting sends this to Operations for booking.'
              : 'Save a draft now and submit once the details are complete.'}
        {' '}The customer must be on your book. <strong style={{ color: 'var(--txt2)', fontWeight: FW.semibold }}>Save draft</strong> keeps it private until you submit.
      </div>
    </Modal>
  )
}
