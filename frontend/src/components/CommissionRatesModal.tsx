import { useEffect, useState } from 'react'
import { Modal } from './UI'
import { apiFetch } from '../lib/api'
import { TEXT, FW, SP, RADIUS, NAVY } from '../lib/design'
import { toast } from 'sonner'

// Finance sets the sales commission rates here. Self-contained: fetches the current
// rates when opened and PUTs on save. The server (salesSetCommissionRates) enforces
// that only Finance/admin may actually change them, and returns can_edit so a viewer
// without rights sees the numbers read-only.
//
// Model: loans and fixed deposits pay a PERCENT of booked value; cards pay a fixed
// naira amount per card issued.

interface Rate { line: string; basis: string; rate_bps: number; amount_kobo: number }

export default function CommissionRatesModal({ open, onClose, onSaved }: {
  open: boolean; onClose: () => void; onSaved?: () => void
}) {
  const [canEdit, setCanEdit] = useState(false)
  const [rLoan, setRLoan] = useState('')
  const [rFd, setRFd] = useState('')
  const [rCard, setRCard] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    apiFetch<any>('/api/sales/commission-rates')
      .then(r => {
        const p = r?.data ?? r
        const rates: Rate[] = p?.rates ?? []
        setCanEdit(!!p?.can_edit)
        const of = (line: string) => rates.find(x => x.line === line)
        setRLoan(String((of('loans')?.rate_bps ?? 0) / 100 || ''))
        setRFd(String((of('fixed_deposit')?.rate_bps ?? 0) / 100 || ''))
        setRCard(String((of('cards')?.amount_kobo ?? 0) / 100 || ''))
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [open])

  async function save() {
    setSaving(true)
    try {
      await apiFetch('/api/sales/commission-rates', {
        method: 'PUT',
        body: JSON.stringify({
          loan_percent: parseFloat(rLoan) || 0,
          fd_percent: parseFloat(rFd) || 0,
          card_naira_each: parseFloat(rCard) || 0,
        }),
      })
      toast.success('Commission rates updated')
      onSaved?.(); onClose()
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  const inp: React.CSSProperties = { flex: 1, padding: `${SP[2]} 10px`, border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }

  return (
    <Modal open={open} onClose={onClose} title="Sales commission rates" width={420}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Close</button>
          {canEdit && (
            <button onClick={save} disabled={saving || loading} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: saving ? 'wait' : 'pointer', opacity: (saving || loading) ? 0.7 : 1 }}>{saving ? 'Saving…' : 'Save rates'}</button>
          )}
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', lineHeight: 1.5 }}>
          {canEdit
            ? 'These apply to every sales officer. Loans and Fixed Deposits pay a percentage of booked value; Cards pay a fixed amount per card issued.'
            : 'Read-only — only Finance can change these rates.'}
        </div>
        {[
          { label: 'Loans — % of disbursement', value: rLoan, set: setRLoan, suffix: '%' },
          { label: 'Fixed Deposit — % of principal', value: rFd, set: setRFd, suffix: '%' },
          { label: 'Cards — ₦ per card issued', value: rCard, set: setRCard, suffix: '₦' },
        ].map(({ label, value, set, suffix }) => (
          <div key={label}>
            <label style={lbl}>{label}</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="number" step="0.01" value={value} disabled={!canEdit} onChange={e => set(e.target.value)} placeholder="0" style={inp} />
              <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: 'var(--txt3)', width: 20 }}>{suffix}</span>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}
