import { useState } from 'react'
import { Modal, Spinner } from './UI'
import { apiPost } from '../lib/api'
import { NAVY, GREEN, TEXT, FW, RADIUS, SP } from '../lib/design'
import { toast } from 'sonner'

const CHANNELS = [
  { value: 'cash',          label: 'Cash' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'pos',           label: 'POS' },
  { value: 'mobile_money',  label: 'Mobile Money' },
  { value: 'cheque',        label: 'Cheque' },
]

interface Props {
  open:      boolean
  onClose:   () => void
  title:     string
  endpoint:  string
  onSuccess: () => void
}

export function LogPaymentModal({ open, onClose, title, endpoint, onSuccess }: Props) {
  const [amountNaira, setAmountNaira] = useState('')
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10))
  const [channel,     setChannel]     = useState('bank_transfer')
  const [reference,   setReference]   = useState('')
  const [saving,      setSaving]      = useState(false)

  function reset() {
    setAmountNaira('')
    setPaymentDate(new Date().toISOString().slice(0, 10))
    setChannel('bank_transfer')
    setReference('')
  }

  function handleClose() {
    reset()
    onClose()
  }

  async function handleSave() {
    const naira = parseFloat(amountNaira.replace(/,/g, ''))
    if (!naira || naira <= 0) { toast.error('Enter a valid amount'); return }
    if (!paymentDate)          { toast.error('Payment date is required'); return }

    setSaving(true)
    try {
      await apiPost(endpoint, {
        amount_kobo:  Math.round(naira * 100),
        payment_date: paymentDate,
        channel,
        reference: reference.trim() || null,
      })
      toast.success('Payment submitted — pending collections approval')
      reset()
      onSuccess()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to log payment')
    } finally {
      setSaving(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px',
    border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
    fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
    boxSizing: 'border-box',
  }

  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold,
    color: 'var(--txt2)', marginBottom: 6,
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={title}
      width={460}
      footer={
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: `${SP[2]} ${SP[5]}`, borderRadius: RADIUS.md,
              border: 'none', background: GREEN, color: '#fff',
              fontSize: TEXT.base, fontWeight: FW.semibold,
              cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.7 : 1,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            {saving && <Spinner size={13} color="#fff" />}
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>payments</span>
            Log Payment
          </button>
          <button
            onClick={handleClose}
            style={{
              padding: `${SP[2]} ${SP[4]}`, borderRadius: RADIUS.md,
              border: '1px solid var(--bdr)', background: 'var(--card)',
              color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Amount */}
        <div>
          <label style={labelStyle}>Amount (₦)</label>
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="0.00"
            value={amountNaira}
            onChange={e => setAmountNaira(e.target.value)}
            style={{ ...inputStyle, fontSize: TEXT.lg, fontWeight: FW.bold }}
            autoFocus
          />
        </div>

        {/* Payment date */}
        <div>
          <label style={labelStyle}>Payment Date</label>
          <input
            type="date"
            value={paymentDate}
            max={new Date().toISOString().slice(0, 10)}
            onChange={e => setPaymentDate(e.target.value)}
            style={inputStyle}
          />
        </div>

        {/* Channel */}
        <div>
          <label style={labelStyle}>Payment Channel</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {CHANNELS.map(c => (
              <button
                key={c.value}
                onClick={() => setChannel(c.value)}
                style={{
                  padding: '5px 13px', borderRadius: RADIUS.md,
                  fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer',
                  border: `1.5px solid ${channel === c.value ? NAVY : 'var(--bdr)'}`,
                  background: channel === c.value ? NAVY : 'var(--card)',
                  color: channel === c.value ? '#fff' : 'var(--txt)',
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {/* Reference */}
        <div>
          <label style={labelStyle}>Reference / Receipt No. <span style={{ fontWeight: FW.normal, color: 'var(--txt3)' }}>(optional)</span></label>
          <input
            type="text"
            placeholder="e.g. TRF-2025-00123"
            value={reference}
            onChange={e => setReference(e.target.value)}
            style={inputStyle}
          />
        </div>
      </div>
    </Modal>
  )
}
