// The card catalogue, in one place.
//
// Six files each carried their own copy of
//   ['PREP', 'Amex Naira', 'Amex USD', 'Classic Accounts']
// as a filter list, a dropdown, or a colour map key. Two of those four are
// is_active=false legacy names (Amex Naira 001, Amex USD 002 — renamed to O3
// Green years ago) and six live products were missing, so every one of those
// pickers offered the wrong set. This module replaces them: families are fixed
// and live here, products come from the API.
//
// Backend counterparts: app.card_products (migration 239), GET /api/cards/products.

import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from './api'
import { NAVY, RED, PURPLE } from './design'

// ── Funding families ──────────────────────────────────────────────────────────
// Fixed set, mirroring the category CHECK on app.card_products.

export type CardFamily = 'credit' | 'prepaid' | 'blink'

export interface CardFamilyMeta {
  key: CardFamily
  label: string
  color: string
  icon: string
  /** One line on what actually distinguishes this family — used as pill/tooltip copy. */
  blurb: string
}

export const CARD_FAMILIES: CardFamilyMeta[] = [
  { key: 'credit',  label: 'Credit',  color: RED,    icon: 'credit_card',
    blurb: 'Revolving line with a credit limit, billed on a cycle and charging interest.' },
  { key: 'prepaid', label: 'Prepaid', color: NAVY,   icon: 'account_balance_wallet',
    blurb: "Stored value: the balance is the customer's own float, so it carries no limit and no interest." },
  { key: 'blink',   label: 'Blink',   color: PURPLE, icon: 'bolt',
    blurb: 'Temporary virtual card funded in foreign currency and credited in naira.' },
]

const FAMILY_BY_KEY = new Map(CARD_FAMILIES.map(f => [f.key, f]))

export function familyMeta(key: string | null | undefined): CardFamilyMeta | undefined {
  return key ? FAMILY_BY_KEY.get(key as CardFamily) : undefined
}

export function familyLabel(key: string | null | undefined): string {
  return familyMeta(key)?.label ?? 'Unmatched'
}

/** Unmatched rows get a muted colour rather than being folded into a real family. */
export function familyColor(key: string | null | undefined): string {
  return familyMeta(key)?.color ?? 'var(--chart-lbl)'
}

// ── Card lifecycle state ──────────────────────────────────────────────────────
// The vocabulary of app.card_book.card_state (migration 177). NOT the raw
// app.accounts.status column, which does not track expiry — 16,215 cards were
// past their expiry date while still marked Open or Active.

export const CARD_STATES = [
  'Live', 'Expired', 'Terminated', 'Legal action', 'Suspended', 'Hot listed', 'Inactive', 'Unknown',
] as const

export const CARD_STATE_COLORS: Record<string, string> = {
  'Live':         '#16A34A',
  'Expired':      '#D97706',
  'Terminated':   '#C00000',
  'Legal action': '#7C3AED',
  'Suspended':    '#D97706',
  'Hot listed':   '#C00000',
  'Inactive':     'var(--chart-lbl)',
  'Unknown':      'var(--chart-lbl)',
}

// ── Card activity ─────────────────────────────────────────────────────────────
// app.card_activity.activity_class (migration 240) — usage recency, orthogonal
// to lifecycle state. 579 Expired cards transacted in the last 90 days and
// 1,796 Live cards did not, so neither column substitutes for the other.

export const CARD_ACTIVITY = ['Active', 'Light', 'Dormant', 'Inactive', 'Never used'] as const

export const CARD_ACTIVITY_COLORS: Record<string, string> = {
  'Active':     '#16A34A',
  'Light':      '#2563EB',
  'Dormant':    '#D97706',
  'Inactive':   '#C00000',
  'Never used': 'var(--chart-lbl)',
}

export const CARD_ACTIVITY_HINTS: Record<string, string> = {
  'Active':     'Spent in the last 30 days',
  'Light':      'Last spent 31–90 days ago',
  'Dormant':    'Last spent 91–365 days ago',
  'Inactive':   'No spend in over a year',
  'Never used': 'No transaction has ever been recorded for this card',
}

// ── Products, from the API ────────────────────────────────────────────────────

export interface CardProduct {
  product_code: string | null
  product_name: string
  system_name: string | null
  category: CardFamily
  card_type: 'physical' | 'virtual'
  is_active: boolean
  is_cooperative?: boolean
  is_temporary?: boolean
  fx_funded?: boolean
  contactless?: boolean
  pinless?: boolean
  pre_issued?: boolean
  currency?: string | null
  scheme?: string | null
  notes?: string | null
}

/**
 * The live product catalogue, for pickers and filters.
 *
 * Every card page used to carry its own literal list. Use this instead: it is
 * the same catalogue the backend groups and reports by, so a product added by
 * migration appears in the UI without a code change, and a product retired
 * stops being offered.
 *
 * activeOnly defaults to true — an operator raising a dispute or an issuance
 * request should not be offered a product that was retired years ago.
 */
export function useCardProducts(opts?: { activeOnly?: boolean }): {
  products: CardProduct[]
  loading: boolean
  error: string | null
} {
  const activeOnly = opts?.activeOnly ?? true
  const [products, setProducts] = useState<CardProduct[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const q = activeOnly ? '?is_active=true' : ''
      const res = await apiFetch<any>(`/api/cards/products${q}`)
      const rows = Array.isArray(res) ? res : (res?.data ?? [])
      setProducts(rows as CardProduct[])
      setError(null)
    } catch (e: any) {
      // A failed catalogue fetch must not blank a page's filters silently.
      setError(e?.message ?? 'Failed to load card products')
      setProducts([])
    } finally {
      setLoading(false)
    }
  }, [activeOnly])

  useEffect(() => { load() }, [load])
  return { products, loading, error }
}

/** Product names for a picker, canonical name first. */
export function productNames(products: CardProduct[]): string[] {
  return products.map(p => p.product_name).filter(Boolean)
}
