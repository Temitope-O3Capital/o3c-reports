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

export function fmtNum(n: unknown): string {
  if (n === null || n === undefined) return '—'
  const x = Number(n)
  if (x >= 1_000_000) return (x / 1_000_000).toFixed(1) + 'M'
  if (x >= 1_000)     return (x / 1_000).toFixed(1) + 'K'
  return x.toLocaleString()
}

export function fmtDate(s: string | null | undefined, opts?: Intl.DateTimeFormatOptions): string {
  if (!s) return '—'
  try {
    const d = new Date(s.includes('T') ? s : s + 'T00:00:00Z')
    return d.toLocaleDateString('en-GB', opts ?? { day: '2-digit', month: 'short', year: 'numeric' })
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

export function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function monthStart(d = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`
}

export function yearStart(d = new Date()): string {
  return `${d.getFullYear()}-01-01`
}

export function n(v: unknown): number { return Number(v ?? 0) }
