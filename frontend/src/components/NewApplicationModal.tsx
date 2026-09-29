import { useEffect, useState, type ReactNode } from 'react'
import { Modal, Button, Input, Select } from './UI'
import { SelectMenuField } from './SelectMenu'
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
  // Carried on a resumed draft so the credit fields survive being parked and picked up.
  bvn?: string | null
  applicant_phone?: string | null
  applicant_email?: string | null
  employment_type?: string | null
  monthly_obligation_kobo?: number | null
}

/** Employment types Phoenix recognises for affordability. */
const EMPLOYMENT_TYPES = [
  { value: 'salaried', label: 'Salaried', hint: 'On a payroll' },
  { value: 'self_employed', label: 'Self-Employed', hint: 'Business owner or trader' },
  { value: 'contract', label: 'Contract', hint: 'Fixed-term engagement' },
  { value: 'retired', label: 'Retired' },
  { value: 'unemployed', label: 'Unemployed' },
]

interface Props {
  open: boolean
  onClose: () => void
  onSaved?: () => void
  /** Resume/submit an existing draft. */
  draft?: DraftApp | null
  /** Pre-fill the applicant when launched from a customer/lead context. */
  presetCif?: string
  presetName?: string
  /** Raise from a CRM lead: posts to the lead on-ramp and makes the CIF optional
   *  (a prospect may not have one yet — it lands provisional and reconciles later). */
  leadId?: number
  /** Overrides the heading — e.g. "Resubmit LOS-…" when the draft is a resubmission. */
  title?: string
  /** A line above the form saying what the officer is looking at. */
  intro?: ReactNode
}

// Amount label reads naturally per product.
function amountLabel(code: string): string {
  switch (code) {
    case 'credit_card':   return 'Requested Credit Limit (₦)'
    case 'prepaid':       return 'Initial Load (₦)'
    case 'fixed_deposit': return 'Principal (₦)'
    default:              return 'Amount Requested (₦)'
  }
}

export default function NewApplicationModal({ open, onClose, onSaved, draft, presetCif, presetName, leadId, title, intro }: Props) {
  const [product, setProduct] = useState('')
  const [cif, setCif]         = useState('')
  const [name, setName]       = useState('')
  const [amount, setAmount]   = useState('')
  const [tenor, setTenor]     = useState('')
  const [purpose, setPurpose] = useState('')
  const [employer, setEmployer] = useState('')
  const [income, setIncome]   = useState('')
  const [busy, setBusy]       = useState(false)
  // What Phoenix needs and the form never asked for.
  const [bvn, setBvn]                       = useState('')
  const [phone, setPhone]                   = useState('')
  const [email, setEmail]                   = useState('')
  const [employmentType, setEmploymentType] = useState('')
  const [obligation, setObligation]         = useState('')
  const [lookedUp, setLookedUp]             = useState(false)

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
      setBvn(draft.bvn ?? '')
      setPhone(draft.applicant_phone ?? '')
      setEmail(draft.applicant_email ?? '')
      setEmploymentType(draft.employment_type ?? '')
      setObligation(draft.monthly_obligation_kobo ? String(draft.monthly_obligation_kobo / 100) : '')
    } else {
      setProduct(''); setCif(presetCif ?? ''); setName(presetName ?? '')
      setAmount(''); setTenor(''); setPurpose(''); setEmployer(''); setIncome('')
      // Cleared on every fresh open. Leaving them would carry one customer's BVN and
      // phone number onto the next customer's application, which is the worst possible
      // version of this bug.
      setBvn(''); setPhone(''); setEmail(''); setEmploymentType(''); setObligation('')
      setLookedUp(false)
    }
  }, [open, draft, presetCif, presetName])

  const line = lineOfCode(product)
  const showTenor    = line === 'loans' || line === 'fixed_deposit'
  const showEmployer = line === 'loans' || product === 'credit_card'
  // Only the products that actually go to Phoenix for a credit decision — the same test
  // the submit footer already uses to say "this goes to Risk".
  const needsCreditData = line === 'loans' || product === 'credit_card'

  // Prefill the credit fields from the customer's own record once a full CIF is entered.
  // The officer at a branch does not know a customer's BVN from memory, and a required
  // field they cannot fill becomes a field they put anything in — a wrong BVN is worse
  // than a missing one, because it pulls a bureau report for a different person.
  //
  // Only ever fills a BLANK box: an officer who has corrected a stale phone number must
  // not have the correction overwritten when the lookup resolves a moment later.
  useEffect(() => {
    const c = cif.trim()
    if (!open || !needsCreditData || c.length < 5) { return }
    let cancelled = false
    apiFetch<{ full_name?: string; phone?: string; email?: string; bvn?: string; employer?: string }>(
      `/api/sales/applications/applicant?cif=${encodeURIComponent(c)}`)
      .then(r => {
        if (cancelled || !r) return
        setLookedUp(true)
        setBvn(v => v || r.bvn || '')
        setPhone(v => v || r.phone || '')
        setEmail(v => v || r.email || '')
        setName(v => v || r.full_name || '')
        setEmployer(v => v || r.employer || '')
      })
      // A CIF with no customer behind it is an ordinary state while typing, not an error
      // worth a toast — the officer is mid-keystroke.
      .catch(() => { if (!cancelled) setLookedUp(false) })
    return () => { cancelled = true }
  }, [open, cif, needsCreditData])

  function payload() {
    return {
      cif: cif.trim(),
      product_type: product,
      amount_requested_kobo: amount ? Math.round(Number(amount) * 100) : 0,
      tenor_months: tenor ? parseInt(tenor) : 0,
      purpose: purpose.trim(),
      employer: employer.trim(),
      monthly_income_kobo: income ? Math.round(Number(income) * 100) : 0,
      // The credit-decision fields. Sent as empty rather than omitted for the products
      // that do not need them, so the backend stores NULL rather than a stale value.
      bvn: bvn.trim(),
      applicant_phone: phone.trim(),
      applicant_email: email.trim(),
      employment_type: employmentType,
      monthly_obligation_kobo: obligation ? Math.round(Number(obligation) * 100) : 0,
    }
  }

  async function saveDraft() {
    if (!product) { toast.error('Choose a product'); return }
    // An existing draft already carries its CIF — or deliberately has none yet, like
    // one copied from an application that began in Phoenix. The draft update never
    // changes the CIF, so demanding one here only blocked the submit.
    if (!leadId && !draft && !cif.trim()) { toast.error('Enter the customer CIF'); return }
    setBusy(true)
    try {
      if (leadId) {
        await apiFetch(`/api/sales/leads/${leadId}/application`, { method: 'POST', body: JSON.stringify({ ...payload(), draft: true }) })
      } else if (draft) {
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
    // An existing draft already carries its CIF — or deliberately has none yet, like
    // one copied from an application that began in Phoenix. The draft update never
    // changes the CIF, so demanding one here only blocked the submit.
    if (!leadId && !draft && !cif.trim()) { toast.error('Enter the customer CIF'); return }
    if (!amount || Number(amount) <= 0) { toast.error('Enter an amount before submitting'); return }
    setBusy(true)
    try {
      if (leadId) {
        await apiFetch(`/api/sales/leads/${leadId}/application`, { method: 'POST', body: JSON.stringify({ ...payload(), draft: false }) })
      } else if (draft) {
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
    <Modal open={open} onClose={onClose} title={title ?? (leadId ? 'Raise Application from Lead' : draft ? 'Resume Application' : 'New Application')} width={560}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="secondary" loading={busy} onClick={saveDraft}>Save Draft</Button>
          <Button variant="primary" loading={busy} onClick={submit}>Submit</Button>
        </div>
      }
    >
      {intro && (
        <div style={{ marginBottom: 14, padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md, background: `${NAVY}0A`, border: `1px solid ${NAVY}1F`, fontSize: TEXT.sm, color: 'var(--txt)', lineHeight: 1.55 }}>
          {intro}
        </div>
      )}
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
        {/* Fixed once the application exists: the draft update does not change it, so
            an editable box here would promise something the save never does. */}
        <Input label={draft ? 'Customer CIF (Fixed on This Application)' : leadId ? 'Customer CIF (Optional)' : 'Customer CIF'}
          value={draft && !cif ? 'none yet: links once the customer exists' : cif}
          onChange={e => setCif(e.target.value)} disabled={!!draft}
          placeholder={leadId ? 'blank = prospect, links later' : 'e.g. 21013'} />
        <Input label="Customer Name (Optional)" value={name} onChange={e => setName(e.target.value)} />
        <Input label={amountLabel(product)} type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
        {showTenor && (
          <Input label={line === 'fixed_deposit' ? 'Term (Months)' : 'Tenor (Months)'} type="number" value={tenor} onChange={e => setTenor(e.target.value)} placeholder="0" />
        )}
        {showEmployer && <>
          <Input label="Employer" value={employer} onChange={e => setEmployer(e.target.value)} />
          <Input label="Monthly Income (₦)" type="number" value={income} onChange={e => setIncome(e.target.value)} placeholder="0.00" />
        </>}

        {/* ── What the credit decision needs ────────────────────────────────────
            These five go to Phoenix, which reads them off the application to derive
            the customer's KYC tier, pull the credit bureau report and compute DTI.
            The form never collected them, so of the 8 applications raised so far
            1 carried a BVN and 2 carried obligations — every other decision was made
            against a customer with no bureau history and, apparently, no debts.

            Shown only where a credit decision actually happens. A prepaid card does
            not go to Phoenix, and asking for a BVN to issue one is a field somebody
            fills in with anything to get past it. */}
        {needsCreditData && <>
          <div style={{ gridColumn: '1 / -1', marginTop: 4 }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
              For The Credit Decision
            </div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>
              {lookedUp
                ? 'Filled in from the customer’s record — check it before submitting.'
                : 'Enter a CIF above and these fill in from the customer’s record.'}
            </div>
          </div>
          <Input label="BVN" value={bvn} onChange={e => setBvn(e.target.value)}
            placeholder="11 digits"
            hint="Phoenix uses this for the KYC tier and the bureau report." />
          <SelectMenuField label="Employment Type" value={employmentType} onChange={setEmploymentType}
            options={EMPLOYMENT_TYPES} clearLabel="Not stated" searchable={false} />
          <Input label="Phone" value={phone} onChange={e => setPhone(e.target.value)} placeholder="08012345678" />
          <Input label="Email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" />
          <div style={{ gridColumn: '1 / -1' }}>
            <Input label="Existing Monthly Repayments (₦)" type="number" value={obligation}
              onChange={e => setObligation(e.target.value)} placeholder="0.00"
              hint="What they already pay out each month on other loans. Left blank this is submitted as zero, which the affordability check reads as “owes nothing” rather than “unknown”." />
          </div>
        </>}

        <div style={{ gridColumn: '1 / -1' }}>
          <Input label="Purpose / Note (Optional)" value={purpose} onChange={e => setPurpose(e.target.value)} />
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
        {' '}{leadId
          ? 'Raised from this lead: no CIF yet is fine, it lands provisional and links to the customer once they exist.'
          : 'The customer must be on your book.'}
        {' '}<strong style={{ color: 'var(--txt2)', fontWeight: FW.semibold }}>Save Draft</strong> keeps it private until you submit.
      </div>
    </Modal>
  )
}
