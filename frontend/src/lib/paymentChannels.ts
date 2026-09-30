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
//
// THESE VALUES ARE ENFORCED, so do not edit this list alone. recoveryPaymentChannels in
// backend-go/handlers/recovery_vocab.go rejects anything else with a 422, and the CHECK
// constraint from migration 321 rejects it at the database. That is deliberate: until
// 2026-09-30 this list was the ONLY enforcement anywhere, and the 269 rows already in
// recovery_payments (NGN 921m) used eight values, not one of which appeared here — the six
// below were offered on three live screens while the data said TRANSFER, REMITA, NDD,
// 'loan repayment'. Adding an option here without adding it there now fails loudly instead.
//
// Remita and Direct Debit are on the list because real payments use them. 'Unspecified' is
// last because it is a real answer for the 90 imported rows whose source recorded no channel;
// it is not a placeholder to pick when you are unsure of a live payment.
export const RECOVERY_PAYMENT_CHANNELS: PaymentChannel[] = [
  { value: 'Bank Transfer',    label: 'Bank Transfer' },
  { value: 'Remita',           label: 'Remita' },
  { value: 'Direct Debit',     label: 'Direct Debit' },
  { value: 'Cash',             label: 'Cash' },
  { value: 'Cheque',           label: 'Cheque' },
  { value: 'TPA',              label: 'TPA' },
  { value: 'Legal Settlement', label: 'Legal Settlement' },
  { value: 'Self-Cure',        label: 'Self-Cure' },
  { value: 'Unspecified',      label: 'Unspecified' },
]

// The stage a recovery case has reached, written by the legal milestone form. ENFORCED the same
// way — isRecoveryLegalStage in recovery_vocab.go and the CHECK from migration 321.
//
// This replaced a six-option Title Case list ('Pre-Litigation Notice', 'Court Filing', …) that
// had NEVER been used: all 95 legal_proceedings rows came from one import, and the column has
// only ever held these four. The old list would have put a fifth and sixth value into the column
// that three dashboards read to decide what is "in legal".
//
// 'recovery' is PRE-legal — ordinary chasing, no lawyer involved. The label says so because the
// Recovery dashboard currently counts it as in-legal, which overstates that figure.
export const RECOVERY_LEGAL_STAGES: PaymentChannel[] = [
  { value: 'recovery', label: 'Recovery (pre-legal)' },
  { value: 'legal',    label: 'Legal' },
  { value: 'court',    label: 'In Court' },
  { value: 'judgment', label: 'Judgment' },
]
