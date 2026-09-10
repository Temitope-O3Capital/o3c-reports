// Collections payment channels — the banks/routes O3 actually receives repayments
// through. Kept in one place so the Queue, account modal and the shared LogPaymentModal
// all present the same set, and it stays in sync with the backend whitelist in
// handlers/collections_ops.go (collectionsPaymentChannels).
export interface PaymentChannel { value: string; label: string }

export const COLLECTIONS_PAYMENT_CHANNELS: PaymentChannel[] = [
  { value: 'GTB',      label: 'GTB' },
  { value: 'POLARIS',  label: 'Polaris' },
  { value: 'FIDELITY', label: 'Fidelity' },
  { value: 'APP',      label: 'App' },
  { value: 'ZENITH',   label: 'Zenith' },
  { value: 'FCMB',     label: 'FCMB' },
]

// Recovery keeps its own settlement routes (agencies/legal), distinct from the
// collections repayment banks.
export const RECOVERY_PAYMENT_CHANNELS: PaymentChannel[] = [
  { value: 'Bank Transfer',    label: 'Bank Transfer' },
  { value: 'Cash',             label: 'Cash' },
  { value: 'Cheque',           label: 'Cheque' },
  { value: 'TPA',              label: 'TPA' },
  { value: 'Legal Settlement', label: 'Legal Settlement' },
  { value: 'Self-Cure',        label: 'Self-Cure' },
]
