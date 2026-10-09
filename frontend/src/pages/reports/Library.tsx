import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Page, SectionCard, DataTable, ErrBanner, KpiCard, Button, DateFilter,
  EmptyState, Input, Badge,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKoboExact, fmtNum, fmtDate, fmtDatetime, today, yearStart } from '../../lib/fmt'
import { NAVY, FW, SP } from '../../lib/design'
import { humanLabel } from '../../lib/labels'

/*
  Report Library.

  THE GAP THIS CLOSES. Fourteen reports existed as endpoints and nothing in the
  workspace called any of them. Measured 2026-10-07: zero frontend callers for
  /api/reports/income, /card-portfolio, /customer-acquisition, /sales-pipeline,
  /loan-portfolio, /npl-return, /monthly-business, /fd-book, /collections-performance,
  /agent-performance, /service-performance, /settlement-recon, /customer-statement and
  /audit-trail-export. The two that looked reachable were /api/cbs/reports/fd-book and
  /api/crm/reports/agent-performance — different modules entirely.

  That is also HOW they came to be wrong. Nobody could see the numbers, so nobody
  noticed that Settlement Reconciliation reported every loan as fully unpaid, that
  Monthly Business summed a table which exists in no schema, or that the NPL chart
  averaged daily ratios instead of dividing totals. A report with no reader is not a
  feature with a missing page; it is an unverified claim.

  WHY ONE PAGE AND NOT FOURTEEN. Each report returns its own shape — named blocks of
  rows plus some scalars — so the obvious build is a bespoke page per report, which is
  fourteen places for a money column to be rendered in the wrong unit. Instead the
  payloads describe themselves: a key ending _kobo is minor units, _pct is a percentage,
  _at is a timestamp. That convention is enforced on the server by
  TestReportPayloadsDescribeThemselves, and `kindOf` below is its only counterpart here.
  Adding a report needs no change to this file.

  The convention went in at the same time as this page on purpose. While nothing read
  these payloads, renaming an output column cost nothing; from today it costs a release.
*/

// ── The self-describing payload convention ────────────────────────────────────
//
// Mirrors reportKeyKind in handlers/report_payload_convention_test.go. Kept to one
// function on each side so there is one place to look when a column renders oddly.

type Kind = 'kobo' | 'money' | 'pct' | 'bps' | 'datetime' | 'date' | 'int' | 'text'

const INT_KEYS = new Set([
  'loan_count', 'loans_booked', 'payment_count', 'new_accounts', 'new_customers',
  'accounts', 'active_accounts', 'total_accounts', 'distinct_cifs', 'cards_held',
  'parties', 'deposits', 'customers', 'leads', 'converted', 'disqualified', 'owned',
  'open_leads', 'tickets', 'tickets_created', 'resolved', 'sla_breached', 'calls',
  'csat_responses', 'contact_attempts', 'promises_total', 'promises_broken',
  'contacts_total', 'active_days', 'assigned_count', 'count', 'total_loans',
  'active_loans', 'legs', 'payments', 'cases', 'active_cases', 'legal_cases', 'snaps',
  'npl_snapshots', 'txn_count', 'open_products', 'dpd', 'tenor_days', 'tenor_months',
  'total', 'targets_set',
])

function kindOf(key: string): Kind {
  if (key.endsWith('_kobo')) return 'kobo'
  if (key.endsWith('_ngn')) return 'money'
  if (key.endsWith('_pct')) return 'pct'
  if (key.endsWith('_bps')) return 'bps'
  if (key.endsWith('_at')) return 'datetime'
  if (key.endsWith('_date') || key.startsWith('date_') ||
      key.endsWith('_start') || key.endsWith('_end')) return 'date'
  if (INT_KEYS.has(key)) return 'int'
  return 'text'
}

/** Strip the type suffix before humanising, so a header reads "Outstanding", not
 *  "Outstanding Kobo" — the unit belongs in the header's own suffix, once. */
function labelFor(key: string): string {
  const k = kindOf(key)
  let base = key
  for (const s of ['_kobo', '_ngn', '_pct', '_bps']) {
    if (base.endsWith(s)) { base = base.slice(0, -s.length); break }
  }
  const text = humanLabel(base)
  if (k === 'kobo' || k === 'money') return `${text} (₦)`
  if (k === 'pct') return `${text} (%)`
  if (k === 'bps') return `${text} (bps)`
  return text
}

function fmtValue(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  switch (kindOf(key)) {
    case 'kobo': return fmtKoboExact(v)
    case 'money': return '₦' + Number(v).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    case 'pct': return `${Number(v).toFixed(2)}%`
    case 'bps': return `${fmtNum(v)} bps`
    case 'datetime': return fmtDatetime(String(v))
    case 'date': return fmtDate(String(v))
    case 'int': return Number(v).toLocaleString('en-NG')
    default:
      if (typeof v === 'boolean') return v ? 'Yes' : 'No'
      if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-NG') : String(v)
      return String(v)
  }
}

/** Money and counts right-align so columns of digits line up; labels do not. */
function alignFor(key: string): 'left' | 'right' {
  const k = kindOf(key)
  return k === 'kobo' || k === 'money' || k === 'pct' || k === 'bps' || k === 'int'
    ? 'right' : 'left'
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface CatalogueEntry {
  key: string
  group: string
  name: string
  description: string
  /** Parameters the report cannot run without. Only the customer statement has one. */
  needs?: string[]
}

type Row = Record<string, unknown>
type Payload = Record<string, unknown>

// ── Block rendering ───────────────────────────────────────────────────────────

/** The envelope's own fields, and anything a block renderer should not treat as data. */
const ENVELOPE = new Set(['date_from', 'date_to', 'limit', 'offset'])

function isRowArray(v: unknown): v is Row[] {
  return Array.isArray(v) && (v.length === 0 || (typeof v[0] === 'object' && v[0] !== null))
}

function blockCols(rows: Row[]): TableCol<Row>[] {
  // Column order follows the first row's key order, which is the SELECT's order, so a
  // report reads the way its author wrote it rather than alphabetically.
  const keys = rows.length ? Object.keys(rows[0]) : []
  return keys.map(k => ({
    key: k,
    label: labelFor(k),
    sortable: true,
    align: alignFor(k),
    render: (r: Row) => fmtValue(k, r[k]),
  }))
}

/** CSV of exactly what is on screen, formatted the same way. A number a reader can see
 *  but not take away is half a report. */
function downloadBlockCSV(name: string, rows: Row[]) {
  if (!rows.length) return
  const keys = Object.keys(rows[0])
  const esc = (s: string) => {
    // Leading =, +, - and @ are neutralised: a spreadsheet treats them as formulas, and
    // this file is opened in Excel by definition. The export engine does the same.
    const t = /^[=+\-@]/.test(s) ? `'${s}` : s
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
  }
  const lines = [
    keys.map(k => esc(labelFor(k))).join(','),
    ...rows.map(r => keys.map(k => esc(fmtValue(k, r[k]))).join(',')),
  ]
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${name}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

function ScalarStrip({ entries }: { entries: [string, unknown][] }) {
  if (!entries.length) return null
  return (
    <div style={{
      display: 'grid', gap: SP[4], marginBottom: SP[6],
      gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
    }}>
      {entries.map(([k, v]) => (
        <KpiCard key={k} label={labelFor(k)} value={fmtValue(k, v)} accent={NAVY} />
      ))}
    </div>
  )
}

function Block({ name, value }: { name: string; value: unknown }) {
  const title = humanLabel(name)

  if (isRowArray(value)) {
    const rows = value
    return (
      <SectionCard
        title={title}
        subtitle={rows.length ? `${rows.length.toLocaleString('en-NG')} row${rows.length === 1 ? '' : 's'}` : undefined}
        actions={rows.length ? (
          <Button variant="secondary" size="sm" icon="download"
            onClick={() => downloadBlockCSV(name, rows)}>CSV</Button>
        ) : undefined}
      >
        <DataTable
          cols={blockCols(rows)}
          rows={rows}
          pageSize={rows.length > 25 ? 25 : undefined}
          searchKeys={rows.length > 10 ? Object.keys(rows[0] ?? {}) : undefined}
          emptyText={<EmptyState icon="inbox" title="Nothing in this section"
            description="The report ran and this section matched no rows." />}
        />
      </SectionCard>
    )
  }

  // A nested object is a summary block: render its scalars as a tile strip.
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Payload).filter(([k]) => !ENVELOPE.has(k))
    return (
      <SectionCard title={title}>
        <ScalarStrip entries={entries} />
      </SectionCard>
    )
  }
  return null
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ReportLibrary() {
  const [catalogue, setCatalogue] = useState<CatalogueEntry[] | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [from, setFrom] = useState(yearStart())
  const [to, setTo] = useState(today())
  const [cif, setCif] = useState('')
  const [payload, setPayload] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<CatalogueEntry[]>('/api/reports/list')
      .then(setCatalogue)
      .catch(e => setErr(e?.message || 'Could not load the report catalogue'))
  }, [])

  const entry = useMemo(
    () => catalogue?.find(c => c.key === active) ?? null,
    [catalogue, active],
  )
  const needsCif = !!entry?.needs?.includes('cif')

  const run = useCallback(async () => {
    if (!entry) return
    if (needsCif && !cif.trim()) {
      setErr('This report is for one customer, so it needs a CIF.')
      return
    }
    setLoading(true); setErr(null)
    try {
      const q = new URLSearchParams({ date_from: from, date_to: to })
      if (needsCif) q.set('cif', cif.trim())
      setPayload(await apiFetch<Payload>(`/api/reports/${entry.key}?${q}`))
    } catch (e: any) {
      setPayload(null)
      setErr(e?.message || 'The report could not be run')
    } finally {
      setLoading(false)
    }
  }, [entry, from, to, cif, needsCif])

  // Running on selection, and on a date change, is what makes this feel like a report
  // library rather than a form. The CIF report is the exception: it waits, because
  // firing without a CIF can only produce an error.
  useEffect(() => {
    if (!entry) return
    if (entry.needs?.includes('cif')) { setPayload(null); return }
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.key, from, to])

  const groups = useMemo(() => {
    const m = new Map<string, CatalogueEntry[]>()
    for (const c of catalogue ?? []) {
      if (!m.has(c.group)) m.set(c.group, [])
      m.get(c.group)!.push(c)
    }
    return [...m.entries()]
  }, [catalogue])

  // Scalars sit above the blocks, as the report's headline figures.
  const scalars = useMemo(
    () => Object.entries(payload ?? {})
      .filter(([k, v]) => !ENVELOPE.has(k) && (v === null || typeof v !== 'object')),
    [payload],
  )
  const blocks = useMemo(
    () => Object.entries(payload ?? {})
      .filter(([k, v]) => !ENVELOPE.has(k) && v !== null && typeof v === 'object'),
    [payload],
  )

  return (
    <Page
      title="Report Library"
      subtitle="The standing reports, run on demand. Each one is grouped the way the business is, and every table can be taken away as CSV."
      loading={!catalogue && !err}
      actions={entry && !entry.needs?.includes('cif')
        ? <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} align="right" />
        : undefined}
    >
      <ErrBanner error={err} onRetry={entry ? run : undefined} />

      <div style={{ display: 'grid', gap: SP[6], gridTemplateColumns: 'minmax(0, 280px) minmax(0, 1fr)' }}
        className="rl-grid">
        {/* ── Catalogue ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[4], minWidth: 0 }}>
          {groups.map(([group, items]) => (
            <SectionCard key={group} title={group} padding={false}>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {items.map(c => {
                  const on = c.key === active
                  return (
                    <button key={c.key} onClick={() => setActive(c.key)}
                      style={{
                        textAlign: 'left', border: 'none', cursor: 'pointer',
                        padding: `${SP[2]} ${SP[4]}`,
                        background: on ? 'var(--row-sel)' : 'transparent',
                        borderLeft: `3px solid ${on ? NAVY : 'transparent'}`,
                        display: 'flex', flexDirection: 'column', gap: 2,
                      }}>
                      <span style={{ fontSize: 13, fontWeight: on ? FW.semibold : FW.medium, color: "var(--txt)" }}>
                        {c.name}
                      </span>
                      <span style={{ fontSize: 11.5, color: "var(--txt3)", lineHeight: 1.35 }}>
                        {c.description}
                      </span>
                    </button>
                  )
                })}
              </div>
            </SectionCard>
          ))}
          {catalogue && !catalogue.length && (
            <SectionCard title="Nothing available">
              <EmptyState icon="lock" title="No reports for your role"
                description="The library only lists reports you can actually run." />
            </SectionCard>
          )}
        </div>

        {/* ── The report ── */}
        <div style={{ minWidth: 0 }}>
          {!entry && (
            <SectionCard title="Pick a report">
              <EmptyState icon="analytics" title="Nothing selected yet"
                description="Choose a report on the left. It runs straight away for the dates in the header." />
            </SectionCard>
          )}

          {entry && (
            <>
              <div style={{ marginBottom: SP[6], display: 'flex', alignItems: 'baseline',
                gap: SP[2], flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: 19, fontWeight: FW.semibold, color: "var(--txt)" }}>
                  {entry.name}
                </h2>
                <Badge variant="default">{entry.group}</Badge>
              </div>

              {needsCif && (
                <SectionCard title="Which customer?"
                  subtitle="This report covers one customer, so it needs a CIF before it can run.">
                  <div style={{ display: 'flex', gap: SP[2], alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <Input label="CIF" value={cif} onChange={e => setCif(e.target.value)}
                      placeholder="00041214" wrapStyle={{ maxWidth: 220 }}
                      onKeyDown={e => { if (e.key === 'Enter') void run() }} />
                    <Button onClick={run} loading={loading} icon="play_arrow">Run</Button>
                  </div>
                </SectionCard>
              )}

              {loading && !payload && (
                <SectionCard title="Running"><EmptyState icon="hourglass_top" title="Running the report"
                  description="Reading the book now." /></SectionCard>
              )}

              {payload && (
                <>
                  <ScalarStrip entries={scalars} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: SP[6] }}>
                    {blocks.map(([name, value]) => <Block key={name} name={name} value={value} />)}
                  </div>
                  {!blocks.length && !scalars.length && (
                    <SectionCard title="Nothing to show">
                      <EmptyState icon="inbox" title="The report ran and returned nothing"
                        description="That is an answer, not a fault — try a wider date range." />
                    </SectionCard>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* The catalogue column stacks above the report on a narrow screen rather than
          squeezing both into 400px. */}
      <style>{`
        @media (max-width: 900px) {
          .rl-grid { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `}</style>
    </Page>
  )
}
