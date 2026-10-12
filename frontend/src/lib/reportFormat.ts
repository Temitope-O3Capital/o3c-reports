import { fmtKoboExact, fmtNum, fmtDate, fmtDatetime } from './fmt'
import { humanLabel } from './labels'

/*
  THE SELF-DESCRIBING COLUMN CONVENTION, ON THE FRONTEND SIDE.

  Two screens render arbitrary result sets whose shape is not known until the data
  arrives: the Report Library (14 fixed reports, each with its own blocks) and the BI SQL
  Console (whatever an analyst typed). Neither can carry a per-column type declaration,
  so the payload has to describe itself — and it does, by the name of each key. A key
  ending _kobo is minor units, _pct is a percentage, _at is a timestamp.

  WHY THIS LIVES IN ONE FILE. It was written twice, once in each screen, which is the
  exact failure that produced the defect the convention exists to prevent: a money value
  rendered by two pieces of code that disagreed about its unit. The retention export
  printed NGN 593,711,192,789 for a true NGN 5,937,111,927.89 because colMoney and
  colKobo were applied to the same column in different places. Having beaten that, it
  would be careless to reintroduce it in the renderer.

  The server half is reportKeyKind in handlers/report_payload_convention_test.go, and
  TestReportPayloadsDescribeThemselves fails the build if a report emits a key that
  carries no type. So there are two implementations by necessity — one per language — and
  exactly two, each named so the other is findable.
*/

export type ColKind =
  | 'kobo' | 'money' | 'pct' | 'bps' | 'datetime' | 'date' | 'int' | 'text'

/** Keys that are counts, not money and not labels. Rendered as grouped integers. */
const INT_KEYS = new Set([
  'loan_count', 'loans_booked', 'payment_count', 'new_accounts', 'new_customers',
  'accounts', 'active_accounts', 'total_accounts', 'distinct_cifs', 'cards_held',
  'parties', 'deposits', 'customers', 'leads', 'converted', 'disqualified', 'owned',
  'open_leads', 'tickets', 'tickets_created', 'resolved', 'sla_breached', 'calls',
  'csat_responses', 'contact_attempts', 'promises_total', 'promises_broken',
  'contacts_total', 'active_days', 'assigned_count', 'count', 'total_loans',
  'active_loans', 'legs', 'payments', 'cases', 'active_cases', 'legal_cases', 'snaps',
  'npl_snapshots', 'txn_count', 'open_products', 'dpd', 'tenor_days', 'tenor_months',
  'total', 'targets_set', 'row_count', 'rows', 'n',
])

export function kindOf(key: string): ColKind {
  const k = key.toLowerCase()
  if (k.endsWith('_kobo')) return 'kobo'
  if (k.endsWith('_ngn')) return 'money'
  if (k.endsWith('_pct')) return 'pct'
  if (k.endsWith('_bps')) return 'bps'
  if (k.endsWith('_at')) return 'datetime'
  if (k.endsWith('_date') || k.startsWith('date_') ||
      k.endsWith('_start') || k.endsWith('_end')) return 'date'
  if (INT_KEYS.has(k)) return 'int'
  return 'text'
}

/**
 * A header for a key, with the type suffix stripped and the unit stated once.
 * "outstanding_kobo" becomes "Outstanding (₦)", not "Outstanding Kobo".
 */
export function labelFor(key: string): string {
  const k = kindOf(key)
  let base = key
  for (const s of ['_kobo', '_ngn', '_pct', '_bps']) {
    if (base.toLowerCase().endsWith(s)) { base = base.slice(0, -s.length); break }
  }
  const text = humanLabel(base)
  if (k === 'kobo' || k === 'money') return `${text} (₦)`
  if (k === 'pct') return `${text} (%)`
  if (k === 'bps') return `${text} (bps)`
  return text
}

export function fmtValue(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  switch (kindOf(key)) {
    case 'kobo':
      return fmtKoboExact(v)
    case 'money':
      return '₦' + Number(v).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    case 'pct':
      return `${Number(v).toFixed(2)}%`
    case 'bps':
      return `${fmtNum(v)} bps`
    case 'datetime':
      return fmtDatetime(String(v))
    case 'date':
      return fmtDate(String(v))
    case 'int':
      return Number(v).toLocaleString('en-NG')
    default:
      if (typeof v === 'boolean') return v ? 'Yes' : 'No'
      if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-NG') : String(v)
      if (typeof v === 'object') return JSON.stringify(v)
      return String(v)
  }
}

/** Digits right-align so a column of them reads down the page; labels do not. */
export function alignFor(key: string): 'left' | 'right' {
  const k = kindOf(key)
  return k === 'kobo' || k === 'money' || k === 'pct' || k === 'bps' || k === 'int'
    ? 'right' : 'left'
}

/**
 * CSV of exactly what is on screen, formatted the same way.
 *
 * Leading =, +, - and @ are neutralised with a leading apostrophe: a spreadsheet treats
 * those as formulas, and this file is opened in Excel by definition. The server-side
 * export writer does the same thing for the same reason — see exportwriter.go.
 */
export function downloadRowsCSV(name: string, rows: Record<string, unknown>[], cols?: string[]) {
  if (!rows.length) return
  const keys = cols && cols.length ? cols : Object.keys(rows[0])
  const esc = (s: string) => {
    const t = /^[=+\-@]/.test(s) ? `'${s}` : s
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
  }
  const lines = [
    keys.map(k => esc(labelFor(k))).join(','),
    ...rows.map(r => keys.map(k => esc(fmtValue(k, r[k]))).join(',')),
  ]
  // A BOM, so Excel on Windows reads the naira sign instead of mojibake.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${name}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}
