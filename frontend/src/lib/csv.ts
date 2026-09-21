// Client-side CSV export.
//
// The workspace had no export affordance anywhere on these pages: no helper, no
// shared component, and no endpoint the frontend called. Pages that the build guide
// says should offer Export simply had no button.
//
// This exports the rows already on screen. That is what "export this view" means to
// the person clicking it — the same filters, the same ordering, the same numbers they
// are looking at — and it cannot disagree with the table above it the way a second
// round trip to the server can.

export interface CsvCol<T> {
  header: string
  value: (row: T) => string | number | null | undefined
}

// RFC 4180 quoting: wrap in quotes when the value carries a delimiter, a quote or a
// newline, and double any embedded quote. Without this a single applicant name with a
// comma in it silently shifts every later column on that row.
function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function downloadCsv<T>(filename: string, cols: CsvCol<T>[], rows: T[]): void {
  const lines = [cols.map(c => cell(c.header)).join(',')]
  for (const r of rows) lines.push(cols.map(c => cell(c.value(r))).join(','))

  // Excel reads a CSV as the system codepage unless there is a BOM, which mangles
  // names like "Adaeze Nwankwo" and any ₦ sign.
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// stamp returns a YYYY-MM-DD suffix for an export filename.
export function stamp(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}
