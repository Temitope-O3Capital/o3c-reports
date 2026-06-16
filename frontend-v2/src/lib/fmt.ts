export function fmt(n: unknown): string {
  const x = Number(n ?? 0)
  const abs = Math.abs(x)
  const s = x < 0 ? '-' : ''
  if (abs >= 1_000_000_000) return s + '₦' + (abs / 1_000_000_000).toFixed(2) + 'B'
  if (abs >= 1_000_000)     return s + '₦' + (abs / 1_000_000).toFixed(2) + 'M'
  if (abs >= 1_000)         return s + '₦' + (abs / 1_000).toFixed(1) + 'K'
  return s + '₦' + abs.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function fmtExact(n: unknown): string {
  return '₦' + Number(n ?? 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function fmtNum(n: unknown): string {
  const x = Number(n ?? 0)
  if (x >= 1_000_000) return (x / 1_000_000).toFixed(1) + 'M'
  if (x >= 1_000)     return (x / 1_000).toFixed(1) + 'K'
  return x.toLocaleString()
}

export function fmtDate(s: string | null | undefined, opts?: Intl.DateTimeFormatOptions): string {
  if (!s) return '—'
  try {
    const d = new Date(s.includes('T') ? s : s + 'T00:00:00')
    return d.toLocaleDateString('en-GB', opts ?? { day: '2-digit', month: 'short', year: 'numeric' })
  } catch { return s }
}

export function fmtPct(n: unknown, dec = 1): string {
  return Number(n ?? 0).toFixed(dec) + '%'
}

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function monthStart(d = new Date()): string {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10)
}

export function yearStart(d = new Date()): string {
  return new Date(d.getFullYear(), 0, 1).toISOString().slice(0, 10)
}

export function n(v: unknown): number { return Number(v ?? 0) }
