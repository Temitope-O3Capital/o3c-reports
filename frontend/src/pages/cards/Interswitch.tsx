import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, KpiCard, ErrBanner, DataTable, EmptyState, DateFilter,
  Button, Badge, StatusBadge, SegmentedToggle,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtKoboExact, fmtNum, fmtDate, fmtDatetime, monthStart, today } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { EBar } from '../../components/echarts'
import { humanLabel } from '../../lib/labels'

/*
  INTERSWITCH SETTLEMENT — the real feed.

  Interswitch has no API. Its settlement data is a CSV pulled from their portal
  once a day and uploaded here, so the page is built around that workflow: what
  arrived, what it settled, and — the question that actually matters for a daily
  feed — WHICH DAYS NOBODY HAS UPLOADED.

  WHAT THIS REPLACES. This route read /api/cards/interswitch/summary, which serves
  app.interswitch_txns: a back-compat VIEW that migration 126 pointed at
  ccs_transactions precisely because that table "never held Interswitch data". So
  the Interswitch page showed CCS card-ledger figures under Interswitch headings,
  while the real settlement feed — every leg of interswitch_legs — had no page at
  all, and /api/interswitch/summary had no caller anywhere in the frontend.

  The figures here now agree with the Interswitch panel on Providers and with the
  reconciliation engine, because all three finally read the same table. The CCS
  card analytics this page used to carry (products, merchants, USD cards) remain on
  Cards → Overview, where they belong.
*/

// ── Types ─────────────────────────────────────────────────────────────────────

interface FamilyRow {
  report_family: string
  session: string
  txns: number
  gross_kobo: number
  fees_kobo: number
  legs: number
}

interface DailyRow {
  day: string
  report_family: string
  txns: number
  gross_kobo: number
}

interface Totals {
  txns: number; gross_kobo: number; fees_kobo: number; legs: number; days_present: number
}

interface Coverage {
  days_in_period?: number
  days_present?: number
  days_missing?: number
  missing_days?: string[]
}

interface LastImport {
  id?: number
  started_at?: string
  finished_at?: string
  status?: string
  files_n?: number
  inserted_n?: number
  skipped_n?: number
  errors?: string
  actor?: string
}

interface Summary {
  by_family: FamilyRow[]
  daily: DailyRow[]
  totals: Totals
  coverage: Coverage
  last_import: LastImport
  feed_last_day: string | null
}

interface ImportRow {
  id: number
  started_at: string
  finished_at: string | null
  status: string
  files_n: number
  legs_n: number
  inserted_n: number
  skipped_n: number
  errors: string
  actor: string
}

interface ImportResult {
  import_id?: number
  files?: number
  legs?: number
  inserted?: number
  skipped?: number
  errors?: string[]
}

// Fixed hues, so a channel keeps its colour whatever this period's mix looks like.
const FAMILY_COLOR: Record<string, string> = {
  AGENCY_BANKING: NAVY, POS: BLUE, ATM_WITHDRAWAL: AMBER, WEB: GREEN,
  QT_TRANSFERS: PURPLE, IPG: '#0891B2', ATM_TRANSFERS: '#DB2777',
  TRANSFER_SERVICE_CORE: '#65A30D', BILLPAYMENT: '#EA580C',
  PREPAID_CARD_LOAD: '#7C3AED', OTHER: '#94A3B8',
}

function nairaAxis(v: number) {
  if (v >= 1e11) return `₦${(v / 1e11).toFixed(1)}B`
  if (v >= 1e8)  return `₦${(v / 1e8).toFixed(0)}M`
  if (v >= 1e5)  return `₦${(v / 1e5).toFixed(0)}K`
  return v === 0 ? '0' : ''
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.floor((Date.now() - t) / 86_400_000)
}

/* The dates nobody uploaded, spelled out. This is the page's most actionable
   output, so it is a list of days to go and fetch, not a count. */
function MissingDays({ days, onUpload }: { days: string[]; onUpload: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? days : days.slice(0, 12)
  return (
    <div style={{ marginTop: SP[3] }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: SP[3] }}>
        {shown.map(d => (
          <span key={d} style={{
            ...NUM, fontSize: TEXT.xs, fontWeight: FW.semibold,
            padding: '3px 9px', borderRadius: 999,
            background: `${AMBER}18`, color: AMBER, whiteSpace: 'nowrap',
          }}>{fmtDate(d)}</span>
        ))}
        {days.length > shown.length && (
          <button type="button" onClick={() => setExpanded(true)} style={{
            fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '3px 9px',
            borderRadius: 999, border: '1px dashed var(--bdr)', background: 'transparent',
            color: 'var(--txt2)', cursor: 'pointer',
          }}>+{days.length - shown.length} more</button>
        )}
      </div>
      <Button size="sm" icon="upload_file" onClick={onUpload}>Upload the Missing Days</Button>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function InterswitchSettlement() {
  const navigate = useNavigate()
  const [from, setFrom] = useState(monthStart())
  const [to, setTo]     = useState(today())
  const [d, setD]       = useState<Summary | null>(null)
  const [history, setHistory] = useState<ImportRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [grain, setGrain]     = useState<'family' | 'session'>('family')

  // Upload, inline. The feed is a daily file; sending it should not require
  // navigating to a different module.
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [files, setFiles]   = useState<File[]>([])
  const [busy, setBusy]     = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [dragging, setDragging] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [sum, hist] = await Promise.all([
        apiFetch<Summary>(`/api/interswitch/summary?date_from=${from}&date_to=${to}`),
        apiFetch<{ data: ImportRow[] }>('/api/interswitch/imports').catch(() => null),
      ])
      setD(sum)
      setHistory(hist?.data ?? [])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load Interswitch settlement')
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const focusUpload = useCallback(() => { fileRef.current?.click() }, [])

  const doImport = useCallback(async () => {
    if (!files.length) return
    setBusy(true); setError(null); setResult(null)
    try {
      const form = new FormData()
      files.forEach(f => form.append('files', f))
      const r = await apiFetch<ImportResult>('/api/interswitch/import', { method: 'POST', body: form })
      setResult(r)
      setFiles([])
      await load()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Import failed')
    } finally { setBusy(false) }
  }, [files, load])

  const totals    = d?.totals
  const coverage  = d?.coverage ?? {}
  const lastImp   = d?.last_import ?? {}
  const missing   = coverage.missing_days ?? []
  const staleDays = daysSince(d?.feed_last_day)

  // ── Channel table ───────────────────────────────────────────────────────────
  const famRows = useMemo(() => {
    const src = d?.by_family ?? []
    if (grain === 'session') return src
    // Collapse the DR/PR settlement sessions into one row per channel.
    const m = new Map<string, FamilyRow>()
    for (const r of src) {
      const cur = m.get(r.report_family)
      if (!cur) {
        m.set(r.report_family, { ...r, session: 'all' })
      } else {
        cur.txns = Number(cur.txns) + Number(r.txns)
        cur.gross_kobo = Number(cur.gross_kobo) + Number(r.gross_kobo)
        cur.fees_kobo = Number(cur.fees_kobo) + Number(r.fees_kobo)
        cur.legs = Number(cur.legs) + Number(r.legs)
      }
    }
    return [...m.values()].sort((a, b) => Number(b.gross_kobo) - Number(a.gross_kobo))
  }, [d, grain])

  const famMax = useMemo(
    () => Math.max(0, ...famRows.map(r => Number(r.gross_kobo))), [famRows])

  const famCols: TableCol<FamilyRow>[] = [
    { key: 'report_family', label: 'Channel', sortable: true, render: r => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: SP[2] }}>
        <span aria-hidden="true" style={{
          width: 9, height: 9, borderRadius: 2,
          background: FAMILY_COLOR[r.report_family] ?? 'var(--txt3)',
        }} />
        <span style={{ fontWeight: FW.medium }}>{humanLabel(r.report_family)}</span>
      </span>
    ) },
    ...(grain === 'session'
      ? [{
          key: 'session', label: 'Session', width: 100, sortable: true,
          render: (r: FamilyRow) => <Badge variant="default">{r.session || '—'}</Badge>,
        } as TableCol<FamilyRow>]
      : []),
    { key: 'txns', label: 'Transactions', align: 'right', sortable: true,
      render: r => <span style={NUM}>{fmtNum(r.txns)}</span> },
    { key: 'gross_kobo', label: 'Gross Settled', align: 'right', sortable: true,
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(r.gross_kobo)}</span> },
    { key: 'share', label: 'Share', width: 90, render: r => {
      const pct = famMax > 0 ? (Number(r.gross_kobo) / famMax) * 100 : 0
      return (
        <div aria-hidden="true" style={{
          height: 4, borderRadius: 2, background: 'var(--bdr)', overflow: 'hidden', minWidth: 48,
        }}>
          <div style={{
            height: '100%', width: `${pct}%`, borderRadius: 2,
            background: FAMILY_COLOR[r.report_family] ?? 'var(--txt3)',
          }} />
        </div>
      )
    } },
    { key: 'fees_kobo', label: 'Fees', align: 'right', sortable: true,
      render: r => (
        <span style={{ ...NUM, color: Number(r.fees_kobo) < 0 ? RED : 'var(--txt2)' }}>
          {fmtKobo(Math.abs(Number(r.fees_kobo)))}
        </span>
      ) },
    // Legs are shown because the collapse is why these figures can be trusted:
    // interswitch_legs holds one row per settlement leg, so summing it raw
    // double- and triple-counts a single transaction.
    { key: 'legs', label: 'Legs', align: 'right', sortable: true, width: 80,
      render: r => <span style={{ ...NUM, color: 'var(--txt3)' }}>{fmtNum(r.legs)}</span> },
  ]

  // ── Daily chart: one stacked bar per settlement date ────────────────────────
  const chartData = useMemo(() => {
    const byDay = new Map<string, Record<string, number | string>>()
    for (const r of d?.daily ?? []) {
      const key = String(r.day).slice(0, 10)
      const row = byDay.get(key) ?? { day: fmtDate(key) }
      row[r.report_family] = Number(row[r.report_family] ?? 0) + Number(r.gross_kobo)
      byDay.set(key, row)
    }
    return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v)
  }, [d])

  const chartSeries = useMemo(() => {
    const fams = new Set<string>()
    for (const r of d?.daily ?? []) fams.add(r.report_family)
    return [...fams].map(f => ({
      key: f, name: humanLabel(f), color: FAMILY_COLOR[f] ?? '#94A3B8',
    }))
  }, [d])

  const histCols: TableCol<ImportRow>[] = [
    { key: 'started_at', label: 'Uploaded', width: 160, sortable: true,
      render: h => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtDatetime(h.started_at)}</span> },
    { key: 'actor', label: 'By', width: 150,
      render: h => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{h.actor}</span> },
    { key: 'files_n', label: 'Files', align: 'right', width: 70,
      render: h => <span style={NUM}>{fmtNum(h.files_n)}</span> },
    { key: 'legs_n', label: 'Legs Read', align: 'right', width: 100,
      render: h => <span style={NUM}>{fmtNum(h.legs_n)}</span> },
    { key: 'inserted_n', label: 'Inserted', align: 'right', width: 100,
      render: h => <span style={{ ...NUM, color: GREEN, fontWeight: FW.semibold }}>{fmtNum(h.inserted_n)}</span> },
    // Skipped is normal, not an error: the parser drops Interswitch's aggregate
    // rollups and anything already loaded, so an operator can drag a whole day's
    // folder in without curating it first.
    { key: 'skipped_n', label: 'Skipped', align: 'right', width: 90,
      render: h => <span style={{ ...NUM, color: 'var(--txt3)' }}>{fmtNum(h.skipped_n)}</span> },
    { key: 'status', label: 'Status', width: 125, render: h => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: SP[2] }}>
        <StatusBadge status={h.status} size="sm" />
        {h.errors && (
          <span className="material-symbols-rounded" title={h.errors} aria-label={h.errors}
            style={{ fontSize: 15, color: AMBER }}>warning</span>
        )}
      </span>
    ) },
  ]

  return (
    <Page
      title="Interswitch Settlement"
      subtitle="Uploaded daily from the Interswitch portal — POS, ATM, web, bill payment and agency banking"
      loading={loading && !d}
      skeletonKpis={4}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], flexWrap: 'wrap' }}>
          <Button size="sm" variant="secondary" icon="upload_file" onClick={focusUpload}>
            Upload CSV
          </Button>
          <Button size="sm" variant="secondary" icon="play_arrow"
            onClick={() => navigate('/settlements/workbench')}>Reconcile</Button>
          <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} align="right" />
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* One hidden input, driven by every Upload control on the page. */}
      <input
        ref={fileRef} type="file" multiple accept=".csv,.txt,.xls,.xlsx"
        style={{ display: 'none' }}
        onChange={e => {
          if (e.target.files) { setFiles(Array.from(e.target.files)); setResult(null) }
        }}
      />

      {/* ── What is missing: the page's first answer ── */}
      {d && Number(coverage.days_missing ?? 0) > 0 && (
        <div role="alert" style={{
          display: 'flex', alignItems: 'flex-start', gap: SP[3],
          padding: SP[4], marginBottom: SP[5], borderRadius: RADIUS.lg,
          background: 'var(--card)', border: '1px solid var(--card-bdr)',
          borderLeft: `4px solid ${AMBER}`, boxShadow: 'var(--card-shadow)',
        }}>
          <span className="material-symbols-rounded" aria-hidden="true"
            style={{ fontSize: 22, color: AMBER, flexShrink: 0, marginTop: 1 }}>event_busy</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>
              {fmtNum(coverage.days_missing)} day{Number(coverage.days_missing) === 1 ? '' : 's'} in
              this period have no settlement file
            </div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 3, lineHeight: 'var(--lh-relaxed)' }}>
              The feed arrives every calendar day, weekends included, so each of these is a file still
              to be pulled from the Interswitch portal. Nothing on those dates can be reconciled until
              it is uploaded.
            </div>
            {missing.length > 0 && <MissingDays days={missing} onUpload={focusUpload} />}
          </div>
        </div>
      )}

      {d && staleDays !== null && staleDays > 2 && Number(coverage.days_missing ?? 0) === 0 && (
        <div role="status" style={{
          display: 'flex', alignItems: 'center', gap: SP[3], flexWrap: 'wrap',
          padding: SP[4], marginBottom: SP[5], borderRadius: RADIUS.lg,
          background: 'var(--card)', border: '1px solid var(--card-bdr)',
          borderLeft: `4px solid ${AMBER}`,
        }}>
          <span className="material-symbols-rounded" aria-hidden="true"
            style={{ fontSize: 20, color: AMBER }}>schedule</span>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
            The newest settlement file held is{' '}
            <strong style={{ color: 'var(--txt)' }}>{fmtDate(d.feed_last_day!)}</strong> —{' '}
            {fmtNum(staleDays)} days ago.
          </div>
          <Button size="sm" variant="secondary" icon="upload_file"
            onClick={focusUpload} style={{ marginLeft: 'auto' }}>Upload</Button>
        </div>
      )}

      {/* ── Staged files / import result ── */}
      {(files.length > 0 || result) && (
        <SectionCard style={{ marginBottom: SP[4] }}
          title={files.length > 0 ? `${files.length} file(s) ready to import` : 'Import complete'}
          actions={files.length > 0
            ? (
              <div style={{ display: 'flex', gap: SP[2] }}>
                <Button size="sm" variant="secondary" onClick={() => setFiles([])} disabled={busy}>
                  Clear
                </Button>
                <Button size="sm" icon="upload" onClick={doImport} loading={busy}>Import</Button>
              </div>
            )
            : <Button size="sm" variant="secondary" onClick={() => setResult(null)}>Dismiss</Button>}
        >
          {files.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {files.map(f => (
                <span key={f.name} style={{
                  fontSize: TEXT.xs, padding: '3px 9px', borderRadius: 999,
                  background: 'var(--th-bg)', color: 'var(--txt2)',
                }}>{f.name}</span>
              ))}
            </div>
          ) : result && (
            <div style={{ display: 'flex', gap: SP[6], flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Files</div>
                <div style={{ ...NUM, fontWeight: FW.semibold }}>{fmtNum(result.files)}</div>
              </div>
              <div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Legs read</div>
                <div style={{ ...NUM, fontWeight: FW.semibold }}>{fmtNum(result.legs)}</div>
              </div>
              <div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Inserted</div>
                <div style={{ ...NUM, fontWeight: FW.semibold, color: GREEN }}>{fmtNum(result.inserted)}</div>
              </div>
              <div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Skipped</div>
                <div style={{ ...NUM, fontWeight: FW.semibold, color: 'var(--txt3)' }}>{fmtNum(result.skipped)}</div>
              </div>
              {result.errors && result.errors.length > 0 && (
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Notes</div>
                  <div style={{ fontSize: TEXT.xs, color: AMBER }}>{result.errors.join(' · ')}</div>
                </div>
              )}
            </div>
          )}
        </SectionCard>
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: SP[3], marginBottom: SP[5],
      }}>
        <KpiCard label="Gross Settled" value={fmtKobo(totals?.gross_kobo)}
          sub={`${fmtNum(totals?.txns)} transactions · ${fmtNum(totals?.legs)} legs`}
          icon="credit_card" accent={BLUE} loading={loading && !d} />
        <KpiCard label="Fees & Charges" value={fmtKobo(Math.abs(Number(totals?.fees_kobo ?? 0)))}
          sub={Number(totals?.fees_kobo ?? 0) < 0 ? 'deducted from gross' : 'added to gross'}
          icon="price_change" accent={AMBER} loading={loading && !d} />
        <KpiCard label="Days Uploaded"
          value={`${fmtNum(coverage.days_present)} / ${fmtNum(coverage.days_in_period)}`}
          sub={Number(coverage.days_missing ?? 0) > 0
            ? `${fmtNum(coverage.days_missing)} still to upload`
            : 'period complete'}
          icon="event_available"
          accent={Number(coverage.days_missing ?? 0) > 0 ? AMBER : GREEN} loading={loading && !d} />
        <KpiCard label="Last Upload"
          value={lastImp.started_at ? fmtDate(lastImp.started_at) : 'never'}
          sub={lastImp.started_at
            ? `${lastImp.actor} · ${fmtNum(lastImp.inserted_n)} legs inserted`
            : 'no settlement file has been uploaded'}
          icon="upload_file"
          accent={lastImp.status === 'ok' ? GREEN : lastImp.status ? AMBER : NAVY}
          loading={loading && !d} />
      </div>

      {/* ── Drop zone ── */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => {
          e.preventDefault(); setDragging(false)
          if (e.dataTransfer.files?.length) {
            setFiles(Array.from(e.dataTransfer.files)); setResult(null)
          }
        }}
        onClick={focusUpload}
        role="button" tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusUpload() } }}
        aria-label="Upload Interswitch settlement files"
        style={{
          padding: SP[5], marginBottom: SP[4], cursor: 'pointer',
          border: `1.5px dashed ${dragging ? BLUE : 'var(--bdr)'}`,
          borderRadius: RADIUS.lg, textAlign: 'center',
          background: dragging ? `${BLUE}0A` : 'var(--card)',
          transition: 'border-color 120ms, background 120ms',
        }}
      >
        <span className="material-symbols-rounded" aria-hidden="true"
          style={{ fontSize: 28, color: dragging ? BLUE : 'var(--txt3)' }}>cloud_upload</span>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', marginTop: 4 }}>
          Drop today&apos;s Interswitch settlement files here
        </div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>
          A whole day&apos;s folder is fine — aggregate rollups and rows already loaded are skipped
        </div>
      </div>

      <SectionCard title="Settlement by Channel" padding={false} style={{ marginBottom: SP[4] }}
        subtitle="Transactions, not legs — one transaction carries an Amount_Payable leg plus a fee leg per party"
        actions={
          <SegmentedToggle<'family' | 'session'> value={grain} onChange={setGrain}
            options={[{ value: 'family', label: 'By Channel' }, { value: 'session', label: 'By Session' }]} />
        }>
        <DataTable
          cols={famCols} rows={famRows}
          keyFn={r => `${r.report_family}-${r.session}`}
          loading={loading && !d} skeletonRows={6}
          emptyText={
            <EmptyState icon="upload_file" title="No settlement loaded for this period"
              description="Interswitch has no API — pull the CSV from their portal and upload it."
              action={{ label: 'Upload CSV', icon: 'upload_file', onClick: focusUpload }} />
          }
        />
      </SectionCard>

      {chartData.length > 0 && (
        <SectionCard title="Daily Settlement" style={{ marginBottom: SP[4] }}
          subtitle="Stacked by channel — a gap in the bars is a day nobody uploaded">
          <EBar
            data={chartData} xKey="day" stack height={280}
            valueFmt={fmtKoboExact} axisFmt={nairaAxis}
            series={chartSeries as any}
          />
        </SectionCard>
      )}

      <SectionCard title="Upload History" padding={false}
        subtitle="Every settlement file loaded, newest first">
        <DataTable
          cols={histCols} rows={history} keyFn={h => h.id}
          loading={loading && !history.length} skeletonRows={5} pageSize={10}
          emptyText={
            <EmptyState icon="history" title="Nothing uploaded yet"
              description="No Interswitch settlement file has been loaded through this page."
              action={{ label: 'Upload CSV', icon: 'upload_file', onClick: focusUpload }} />
          }
        />
      </SectionCard>
    </Page>
  )
}
