export function fmt(n: unknown): string {
  if (n === null || n === undefined) return '—'
  const x = Number(n)
  const abs = Math.abs(x)
  const s = x < 0 ? '-' : ''
  if (abs >= 1_000_000_000) return s + '₦' + (abs / 1_000_000_000).toFixed(2) + 'B'
  if (abs >= 1_000_000)     return s + '₦' + (abs / 1_000_000).toFixed(2) + 'M'
  if (abs >= 1_000)         return s + '₦' + (abs / 1_000).toFixed(1) + 'K'
  return s + '₦' + abs.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function fmtExact(n: unknown): string {
  if (n === null || n === undefined) return '—'
  return '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function fmtKobo(n: unknown): string {
  const raw = Number(n)
  if (!isFinite(raw)) return '—'
  return fmt(raw / 100)
}

export function fmtKoboExact(n: unknown): string {
  const raw = Number(n)
  if (!isFinite(raw)) return '—'
  return fmtExact(raw / 100)
}

// The full figure, to the naira, with no kobo tail: ₦19,612,628,344.
// Headline balances were split between an abbreviated form (₦19.61B, which hides the
// precision) and an exact one (₦19,612,628,343.83, where the trailing 83 kobo is noise
// on a number that size). This is the middle: nothing hidden, nothing spurious.
export function fmtWhole(n: unknown): string {
  if (n === null || n === undefined) return '—'
  const x = Number(n)
  if (!isFinite(x)) return '—'
  // Sign outside the naira sign — "-₦1,447,246", not "₦-1,447,246" — matching fmt().
  const sign = x < 0 ? '-' : ''
  return sign + '₦' + Math.round(Math.abs(x)).toLocaleString('en-NG', { maximumFractionDigits: 0 })
}

export function fmtKoboWhole(n: unknown): string {
  const raw = Number(n)
  if (!isFinite(raw)) return '—'
  return fmtWhole(raw / 100)
}

// Formats a minor-unit value (kobo for NGN, cents for USD) with exact precision.
// Always shows 2 decimal places; never abbreviates.
export function fmtCurrencyMinor(n: unknown, currency: string): string {
  const raw = Number(n)
  if (!isFinite(raw)) return '—'
  const amount = raw / 100
  if (currency === 'USD') {
    return '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  return '₦' + amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function fmtNum(n: unknown): string {
  if (n === null || n === undefined) return '—'
  const x = Number(n)
  if (x >= 1_000_000) return (x / 1_000_000).toFixed(1) + 'M'
  if (x >= 1_000)     return (x / 1_000).toFixed(1) + 'K'
  return x.toLocaleString('en-NG')
}

// Exact count — grouped, never abbreviated. Use this for work-item counts someone has
// to reconcile against a list: KPI cards sitting above a table, queue/lead/forward
// counters, the number in a confirmation.
//
// fmtNum above abbreviates anything over 999, so 1,234 and 1,151 both render "1.2K" on
// a card while the table below shows the real figures. That is right for chart axes and
// headline volumes, and wrong for a number a supervisor has to tally — hence two
// functions rather than a change to fmtNum, which other screens depend on.
export function fmtCount(n: unknown): string {
  if (n === null || n === undefined) return '—'
  const x = Number(n)
  if (!isFinite(x)) return '—'
  return x.toLocaleString('en-NG')
}

export function fmtDate(s: string | null | undefined, opts?: Intl.DateTimeFormatOptions): string {
  if (!s) return '—'
  try {
    // Date-only strings (YYYY-MM-DD) are parsed as local midnight to avoid
    // UTC-to-local conversion shifting the date backward in west-of-UTC zones.
    const d = s.includes('T') ? new Date(s) : new Date(s.replace(/-/g, '/'))
    // L6: use 'en-NG' locale explicitly for all date displays
    return d.toLocaleDateString('en-NG', opts ?? { day: '2-digit', month: 'short', year: 'numeric' })
  } catch { return s }
}

export function fmtDatetime(s: string | null | undefined): string {
  if (!s) return '—'
  try {
    return new Date(s).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    })
  } catch { return s }
}

export function fmtPct(n: unknown, dec = 1): string {
  return Number(n ?? 0).toFixed(dec) + '%'
}

function pad2(n: number): string { return String(n).padStart(2, '0') }

// ── "Today" is a Lagos date, everywhere ───────────────────────────────────────
//
// There were two disagreeing definitions of today. resolveWindow() in
// pages/reports/builder/model.ts anchors the Report Builder's named windows to Lagos,
// because the backend resolves a scheduled send there and a preview has to match what
// the schedule will actually send. today() below was pure browser-local. On any machine
// not set to UTC+1 the two resolved to different calendar days — and on the Report
// Builder they sit side by side: the window select next to the house DateFilter, whose
// presets call today().
//
// Fixed here, in today() itself, rather than behind a second Lagos-only helper used
// only by the picker presets. A second "today" is exactly how this bug arrived; a third
// would be the same mistake again. Every one of today()'s ~95 call sites wants the
// Lagos day: they are date-range defaults, `max=` caps on date inputs, and capture-form
// defaults, for a business that operates in one timezone against a server that stamps
// in that timezone. On a machine already set to Lagos, nothing changes at all.
//
// Africa/Lagos through Intl is the approach already used for WAT in
// pages/reports/management/shared.tsx, not a third one. Lagos is UTC+1 all year with no
// daylight saving, so there is no offset arithmetic here to get wrong. The constant
// belongs in this lib rather than in a page module; management/shared.tsx still carries
// its own identical copy and should import this one.
export const WAT = 'Africa/Lagos'

// en-CA renders as YYYY-MM-DD, which is the wire format these dates are sent in.
const watDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: WAT })

export function today(): string { return watDayFmt.format(new Date()) }

// The Lagos calendar day, held as a LOCAL midnight so that ordinary local date
// arithmetic — setDate(), getDay(), month lengths — operates on the right day. Use this
// instead of `new Date()` anywhere a date is being derived from "now".
export function todayLocal(): Date {
  const [y, m, d] = today().split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function monthStart(d = todayLocal()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`
}

export function yearStart(d = todayLocal()): string {
  return `${d.getFullYear()}-01-01`
}

export function n(v: unknown): number { return Number(v ?? 0) }
