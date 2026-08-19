import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, ErrBanner, Sk, btnPrimary } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, monthStart, today } from '../../lib/fmt'
import { INTER, NUM, FW, RADIUS, SP, TEXT, AMBER } from '../../lib/design'

/*
  Reports Library — the fixed operational reports.

  This page replaces a "cross-module report builder" that could not build a
  report. It offered eleven modules and forty metrics, none of which the backend
  recognised: the page posted {module, metrics, granularity} while the handler
  read report_type, so every run returned an empty result set with no error, and
  Save and Schedule both 422'd on fields the UI never sent.

  Meanwhile the backend had eight complete, working reports — monthly business,
  loan portfolio, collections performance, settlement reconciliation, agent
  performance, customer statement, the CBN NPL return and the audit trail — and
  no page in the entire workspace reached any of them.

  So this page is deliberately not a builder. Ad-hoc extraction lives in Data
  Export; saved and scheduled report definitions live in Report Builder. This is
  the shelf where the standing reports sit.

  The renderer is generic on purpose. Each report returns its own JSON shape, so
  rather than hand-coding eight layouts that drift from the handlers, scalars
  render as figures, arrays render as tables and nested objects recurse. A report
  that gains a field shows it immediately instead of silently dropping it.
*/

interface ReportMeta {
  key: string
  name: string
  description: string
  group?: string
}

// Reports needing an argument beyond the date range.
const NEEDS_CIF = new Set(['customer-statement'])

// Keys whose values are kobo. Everything in the workspace stores minor units, so
// rendering these as plain integers is how a ₦2.5m figure becomes "250000000".
const KOBO_RE = /_kobo$|^total_collections$|^total_recoveries$/

function isKobo(key: string) { return KOBO_RE.test(key) }
function isPct(key: string)  { return /_pct$|_ratio_pct$/.test(key) }

/** Humanise a snake_case key for display. */
function humanise(key: string): string {
  return key
    .replace(/_kobo$/, ' (NGN)')
    .replace(/_pct$/, ' %')
    .replace(/_bps$/, ' (bps)')
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function renderValue(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (typeof v === 'number') {
    if (isKobo(key)) return fmtKobo(v)
    if (isPct(key))  return `${v.toFixed(1)}%`
    return fmtNum(v)
  }
  const s = String(v)
  // ISO timestamps read badly at full precision in a report.
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.replace('T', ' ').slice(0, 16)
  return s
}

// ── Generic renderers ─────────────────────────────────────────────────────────

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.lg,
      background: 'var(--bg)', border: '1px solid var(--bdr)', minWidth: 160,
    }}>
      <div style={{
        fontSize: TEXT['2xs'], fontWeight: FW.bold, color: 'var(--txt2)',
        textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: INTER, marginBottom: 4,
      }}>{label}</div>
      <div style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.bold, color: 'var(--txt)' }}>{value}</div>
    </div>
  )
}

function Table({ rows }: { rows: Record<string, unknown>[] }) {
  // Union the keys so a row missing a field does not silently drop the column.
  const cols = useMemo(() => {
    const seen: string[] = []
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k)
    return seen
  }, [rows])

  if (rows.length === 0) {
    return <div style={{ fontSize: TEXT.base, color: 'var(--txt2)', padding: '6px 0' }}>No rows.</div>
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: TEXT.sm, minWidth: '100%' }}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c} style={{
                textAlign: 'left', padding: '6px 12px', whiteSpace: 'nowrap',
                borderBottom: '1px solid var(--bdr)', color: 'var(--txt2)',
                fontFamily: INTER, fontWeight: FW.semibold, fontSize: TEXT.xs,
                textTransform: 'uppercase', letterSpacing: 0.4,
              }}>{humanise(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map(c => {
                const numeric = typeof r[c] === 'number'
                return (
                  <td key={c} style={{
                    padding: '6px 12px', whiteSpace: 'nowrap',
                    borderBottom: '1px solid var(--bdr)', color: 'var(--txt)',
                    textAlign: numeric ? 'right' : 'left',
                    ...(numeric ? NUM : {}),
                  }}>{renderValue(c, r[c])}</td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Render one section of the report payload according to its shape. */
function Section({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null

  if (Array.isArray(value)) {
    const rows = value.filter(v => v && typeof v === 'object') as Record<string, unknown>[]
    if (rows.length !== value.length) return null // array of scalars: not meaningful here
    return (
      <SectionCard title={humanise(label)} subtitle={`${rows.length} row${rows.length === 1 ? '' : 's'}`}>
        <Table rows={rows} />
      </SectionCard>
    )
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    const scalars = entries.filter(([, v]) => v === null || typeof v !== 'object')
    const nested  = entries.filter(([, v]) => v !== null && typeof v === 'object')
    return (
      <>
        {scalars.length > 0 && (
          <SectionCard title={humanise(label)}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: SP[3] }}>
              {scalars.map(([k, v]) => (
                <Figure key={k} label={humanise(k)} value={renderValue(k, v)} />
              ))}
            </div>
          </SectionCard>
        )}
        {nested.map(([k, v]) => <Section key={k} label={k} value={v} />)}
      </>
    )
  }

  return null
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ReportsLibrary() {
  const [reports, setReports] = useState<ReportMeta[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [selected, setSelected] = useState('')
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo, setDateTo] = useState(today())
  const [cif, setCif] = useState('')

  const [result, setResult] = useState<Record<string, unknown> | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ranAt, setRanAt] = useState<string | null>(null)

  const meta = useMemo(() => reports.find(r => r.key === selected) ?? null, [reports, selected])

  // Grouped by product line, preserving the backend's ordering so the library
  // reads the way the business is organised.
  const grouped = useMemo(() => {
    const m = new Map<string, ReportMeta[]>()
    for (const r of reports) {
      const g = r.group ?? 'Reports'
      if (!m.has(g)) m.set(g, [])
      m.get(g)!.push(r)
    }
    return Array.from(m.entries())
  }, [reports])

  useEffect(() => {
    let alive = true
    apiFetch<any>('/api/reports/list')
      .then(res => {
        if (!alive) return
        const list: ReportMeta[] = Array.isArray(res) ? res : (res?.data ?? [])
        setReports(list)
        if (list.length > 0) setSelected(list[0].key)
      })
      .catch(e => alive && setError(e.message ?? 'Could not load the report list'))
      .finally(() => alive && setLoadingList(false))
    return () => { alive = false }
  }, [])

  useEffect(() => { setResult(null); setError(null); setRanAt(null) }, [selected])

  const run = useCallback(async () => {
    if (!meta) return
    if (NEEDS_CIF.has(meta.key) && !cif.trim()) {
      setError('This report needs a CIF')
      return
    }
    setRunning(true); setError(null)
    try {
      const p = new URLSearchParams()
      if (dateFrom) p.set('date_from', dateFrom)
      if (dateTo)   p.set('date_to', dateTo)
      if (NEEDS_CIF.has(meta.key)) p.set('cif', cif.trim())
      const res = await apiFetch<any>(`/api/reports/${meta.key}?${p}`)
      // respond() wraps as {data,…}; a few handlers return the payload bare.
      const payload = res && typeof res === 'object' && 'data' in res ? res.data : res
      setResult(Array.isArray(payload) ? { rows: payload } : payload)
      setRanAt(new Date().toLocaleString())
    } catch (e: any) {
      setError(e.message ?? 'Report failed')
      setResult(null)
    } finally {
      setRunning(false)
    }
  }, [meta, dateFrom, dateTo, cif])

  const inputStyle: React.CSSProperties = {
    height: 32, padding: '0 10px', border: '1px solid var(--input-bdr)',
    borderRadius: RADIUS.md, fontSize: TEXT.sm, background: 'var(--input-bg)',
    color: 'var(--txt)', fontFamily: "'Sora', sans-serif", outline: 'none', width: '100%',
    boxSizing: 'border-box',
  }
  const labelStyle: React.CSSProperties = {
    fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt2)', textTransform: 'uppercase',
    letterSpacing: 0.5, fontFamily: INTER, display: 'block', marginBottom: 6,
  }

  // Keep the run metadata out of the rendered body — it is chrome, not content.
  const bodySections = useMemo(() => {
    if (!result) return []
    const skip = new Set(['date_from', 'date_to', 'report_date', 'data_source', 'data_as_of'])
    return Object.entries(result).filter(([k]) => !skip.has(k))
  }, [result])

  return (
    <Page
      title="Reports Library"
      subtitle="Standing operational and regulatory reports"
    >
      <ErrBanner error={error} />

      <div style={{ display: 'flex', gap: 0, minHeight: 520 }}>

        {/* ── Report picker ── */}
        <div style={{
          width: 300, flexShrink: 0, borderRight: '1px solid var(--bdr)',
          background: 'var(--card)', padding: SP[5],
          display: 'flex', flexDirection: 'column', gap: SP[5],
        }}>
          <div>
            <label style={labelStyle} htmlFor="report">Report</label>
            {loadingList ? <Sk h={32} /> : (
              <select id="report" value={selected} onChange={e => setSelected(e.target.value)} style={inputStyle}>
                {grouped.map(([group, items]) => (
                  <optgroup key={group} label={group}>
                    {items.map(r => <option key={r.key} value={r.key}>{r.name}</option>)}
                  </optgroup>
                ))}
              </select>
            )}
            {meta && (
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', marginTop: 6, lineHeight: 1.5 }}>
                {meta.description}
              </div>
            )}
          </div>

          <div>
            <label style={labelStyle}>Period</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input type="date" aria-label="From" value={dateFrom}
                onChange={e => setDateFrom(e.target.value)} style={inputStyle} />
              <input type="date" aria-label="To" value={dateTo}
                onChange={e => setDateTo(e.target.value)} style={inputStyle} />
            </div>
          </div>

          {meta && NEEDS_CIF.has(meta.key) && (
            <div>
              <label style={labelStyle} htmlFor="cif">CIF</label>
              <input id="cif" value={cif} onChange={e => setCif(e.target.value)}
                placeholder="e.g. 00000420" style={inputStyle} />
            </div>
          )}

          <button type="button" onClick={run} disabled={running || !meta}
            style={{ ...btnPrimary, width: '100%', justifyContent: 'center' }}>
            <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>play_arrow</span>
            {running ? 'Running…' : 'Run Report'}
          </button>

          <div style={{
            fontSize: TEXT['2xs'], color: 'var(--txt3)', lineHeight: 1.6,
            paddingTop: SP[3], borderTop: '1px solid var(--bdr)',
          }}>
            To pull these as a file, use <strong>Data Export</strong>. Every extract is
            produced there and recorded against your name.
          </div>
        </div>

        {/* ── Output ── */}
        <div style={{ flex: 1, padding: SP[5], overflow: 'auto', display: 'flex', flexDirection: 'column', gap: SP[4] }}>
          {running && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {Array.from({ length: 5 }).map((_, i) => <Sk key={i} h={i === 0 ? 80 : 40} />)}
            </div>
          )}

          {!running && !result && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: SP[3] }}>
              <div style={{
                width: 56, height: 56, borderRadius: RADIUS['2xl'], background: 'rgba(14,40,65,.06)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <span className="material-symbols-rounded" style={{ fontSize: TEXT['3xl'], color: 'var(--txt3)' }}>lab_profile</span>
              </div>
              <div style={{ textAlign: 'center', maxWidth: 400 }}>
                <div style={{ fontSize: TEXT.md, fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: SP[1] }}>
                  {meta?.name ?? 'Choose a report'}
                </div>
                <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.6 }}>
                  {meta?.description ?? 'Pick a report and a period, then run it.'}
                </div>
              </div>
            </div>
          )}

          {!running && result && (
            <>
              <div style={{
                display: 'flex', alignItems: 'center', gap: SP[3], flexWrap: 'wrap',
                fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER,
              }}>
                <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)', fontFamily: 'inherit' }}>
                  {meta?.name}
                </span>
                {typeof result['date_from'] === 'string' && (
                  <span>{result['date_from']} to {String(result['date_to'] ?? '')}</span>
                )}
                {ranAt && <span style={{ marginLeft: 'auto' }}>Run {ranAt}</span>}
              </div>

              {selected === 'npl-return' && (
                // The provisioning basis is stated on the report itself: a
                // regulatory figure whose rates are not visible is not checkable.
                <div style={{
                  display: 'flex', gap: SP[2], alignItems: 'flex-start',
                  padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.lg,
                  background: 'rgba(217,119,6,.08)', border: `1px solid ${AMBER}40`,
                  fontSize: TEXT.sm, color: 'var(--txt)', lineHeight: 1.6,
                }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg, color: AMBER, flexShrink: 0 }}>info</span>
                  <span>
                    Provisions use the CBN prudential classification: 1% up to 90 days,
                    10% at 91–180, 50% at 181–360, 100% beyond 360. Confirm this matches
                    the facility class O3 reports under before filing.
                  </span>
                </div>
              )}

              {bodySections.length === 0 ? (
                <SectionCard title="No data">
                  <div style={{ fontSize: TEXT.base, color: 'var(--txt2)' }}>
                    This report returned nothing for the selected period.
                  </div>
                </SectionCard>
              ) : (
                bodySections.map(([k, v]) => <Section key={k} label={k} value={v} />)
              )}
            </>
          )}
        </div>
      </div>
    </Page>
  )
}
