// ISO-4217 numeric currency codes, as they arrive from acct_file field 7.
//
// Only two values occur in the book: 566 (NGN, ~99.5%) and 840 (USD — the Amex
// USD product, 214 accounts and 4,882 transactions). 'unknown' is what the API
// reports for rows whose owning account has no currency recorded, which is every
// row that predates migration 233 until the backfill runs.
//
// CCS posts USD-card amounts in US dollars (confirmed 2026-09-14), so an amount
// field on a USD row holds cents, not kobo. Amounts are never converted anywhere
// in the app: they are reported per currency, labelled, and kept out of naira
// totals.
export const CURRENCY_NAMES: Record<string, string> = {
  '566': 'NGN',
  '840': 'USD',
  unknown: 'Not Recorded',
}

export const currencyName = (c: string) => CURRENCY_NAMES[c] ?? c

// fmtUsdCents formats a USD amount held in cents — the unit the API uses for
// dollar-card figures — e.g. 123456 → "$1,234.56".
export const fmtUsdCents = (cents: number) =>
  '$' + (Number(cents ?? 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
