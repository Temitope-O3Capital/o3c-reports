// Canonical Sales product taxonomy — the single source of truth for the three
// product lines Sales works: Cards, Loans, Fixed Deposit.
//
// This deliberately REUSES the codes already in the data rather than inventing a
// third vocabulary: the sub-codes match app.accounts.product_line ('prepaid',
// 'credit_card') and loan_applications.product_type ('salary_loan','business_loan').
// The backend mirror lives in backend-go/handlers/products.go — keep them in step.

import { NAVY, AMBER, PURPLE } from './design'

export type ProductLine = 'cards' | 'loans' | 'fixed_deposit'

export interface ProductLineMeta {
  line: ProductLine
  label: string
  icon: string
  color: string
}

export interface ProductSub {
  code: string        // canonical sub-product code (matches the data)
  label: string       // human label
  line: ProductLine
}

// The three lines, in display order.
export const PRODUCT_LINES: ProductLineMeta[] = [
  { line: 'cards',         label: 'Cards',         icon: 'credit_card',            color: PURPLE },
  { line: 'loans',         label: 'Loans',         icon: 'account_balance_wallet', color: NAVY },
  { line: 'fixed_deposit', label: 'Fixed Deposit', icon: 'savings',                color: AMBER },
]

// The sub-products under each line.
export const PRODUCT_SUBS: ProductSub[] = [
  { code: 'prepaid',       label: 'Prepaid Card', line: 'cards' },
  { code: 'credit_card',   label: 'Credit Card',  line: 'cards' },
  { code: 'salary_loan',   label: 'Salary Loan',  line: 'loans' },
  { code: 'business_loan', label: 'Business Loan', line: 'loans' },
  { code: 'fixed_deposit', label: 'Fixed Deposit', line: 'fixed_deposit' },
]

const SUB_BY_CODE = new Map(PRODUCT_SUBS.map(s => [s.code, s]))
const LINE_BY_KEY = new Map(PRODUCT_LINES.map(l => [l.line, l]))

// Legacy / alternate codes seen in the data, mapped to a canonical sub-code so
// old rows still classify correctly. Anything unknown returns '' (unclassified).
const LEGACY_ALIASES: Record<string, string> = {
  personal_loan:      'business_loan',
  individual_loan:    'business_loan',
  card_limit_increase:'credit_card',
  cc:                 'credit_card',
  creditcard:         'credit_card',
  prepaid_card:       'prepaid',
  fd:                 'fixed_deposit',
  'fixed deposit':    'fixed_deposit',
}

// normalizeProductCode maps any raw product string (free-text deal.product,
// loan_applications.product_type, app.accounts.product_line) to a canonical
// sub-code, or '' if it can't be classified.
export function normalizeProductCode(raw: string | null | undefined): string {
  if (!raw) return ''
  const k = raw.trim().toLowerCase().replace(/\s+/g, '_')
  if (SUB_BY_CODE.has(k)) return k
  if (LEGACY_ALIASES[k]) return LEGACY_ALIASES[k]
  if (LEGACY_ALIASES[raw.trim().toLowerCase()]) return LEGACY_ALIASES[raw.trim().toLowerCase()]
  // Loose contains-matching for free-text like "Business Loan application".
  if (/prepaid/.test(k))                 return 'prepaid'
  if (/credit.?card|\bcc\b/.test(k))     return 'credit_card'
  if (/salary/.test(k))                  return 'salary_loan'
  if (/business/.test(k))                return 'business_loan'
  if (/fixed.?deposit|\bfd\b|term.?dep/.test(k)) return 'fixed_deposit'
  if (/loan/.test(k))                    return 'business_loan'
  if (/card/.test(k))                    return 'credit_card'
  return ''
}

// lineOfCode returns the product LINE for a raw/canonical product code.
export function lineOfCode(raw: string | null | undefined): ProductLine | '' {
  const code = normalizeProductCode(raw)
  return code ? (SUB_BY_CODE.get(code)!.line) : ''
}

// productLabel returns the human label for a raw/canonical sub-code.
export function productLabel(raw: string | null | undefined): string {
  const code = normalizeProductCode(raw)
  if (code) return SUB_BY_CODE.get(code)!.label
  return (raw ?? '').trim() || '—'
}

// lineLabel / lineColor / lineIcon for a ProductLine key.
export function lineLabel(line: ProductLine | '' | null | undefined): string {
  return line ? (LINE_BY_KEY.get(line)?.label ?? '—') : '—'
}
export function lineColor(line: ProductLine | '' | null | undefined): string {
  return (line && LINE_BY_KEY.get(line)?.color) || 'var(--txt3)'
}
export function lineIcon(line: ProductLine | '' | null | undefined): string {
  return (line && LINE_BY_KEY.get(line)?.icon) || 'sell'
}

// subsForLine returns the sub-products under a line, for building pickers.
export function subsForLine(line: ProductLine): ProductSub[] {
  return PRODUCT_SUBS.filter(s => s.line === line)
}
