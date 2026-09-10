import { useEffect, useState, useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import { Page, SectionCard, ErrBanner, Sk, Modal, btnPrimary, btnSecondary } from '../../components/UI'
import { apiFetch, apiPut } from '../../lib/api'
import { fmtKobo, fmtNum, n } from '../../lib/fmt'
import { GREEN, AMBER, RED, BLUE, NAVY, INTER, NUM, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { hasPage } from '../../hooks/useAuth'
import { toast } from 'sonner'
import { ECombo } from '../../components/echarts'

const koboAxis = (v: number) => fmtKobo(v).replace(/\.00$/, '')

/*
  KPI Tracker.

  Rebuilt 2026-08-17. Six of the ten headline KPIs were structurally zero:
  "Active Loans" counted a table that does not exist in this database, "Revenue"
  read app.fee_income which has never had a row, and "New Customers" counted loan
  applications for a business whose customers arrive through cards. kpi_targets
  was empty and there was no way to populate it, so every RAG indicator compared
  against a target of zero — which the old code painted green, meaning a page of
  green dots meant "no targets set", not "on track".

  Three principles now hold:

   - A metric with no target shows NO indicator. Absent and zero are different
     things, and a target of zero is a legitimate goal ("no NPLs").
   - A month where the card feed did not deliver is marked as a gap, not plotted
     as ₦0. The CSV drops have real holes; a revenue chart that draws them as
     zero says "we earned nothing" when the truth is "we have no data".
   - Targets are editable here by anyone who can change settings, because a
     tracker nobody can configure is a tracker nobody trusts.
*/

// ── Types ─────────────────────────────────────────────────────────────────────

type KPIValues = Record<string, number>

interface HistoryRow {
  period_label: string
  period_start: string
  total_disbursed_kobo: number
  collection_rate_pct: number | null
  npl_ratio_pct: number
  revenue_kobo: number
  revenue_fee_kobo: number
  revenue_interest_kobo: number
  revenue_penalty_kobo: number
  new_customers: number
  tickets_created: number
  csat_score: number | null
  txn_count: number
  data_complete: boolean
}

type KPIFormat = 'kobo' | 'num' | 'pct'

interface KPIDef {
  key: string
  label: string
  format: KPIFormat
  /** The metric_name stored in kpi_targets. */
  metric: string
  lowerIsBetter?: boolean
  /** Shown when the value is zero for a structural reason rather than a real one. */
  emptyHint?: string
  /** A point-in-time figure (the live book), not a sum over the selected period —
   *  so it does not move when the period changes. Flagged on the card. */
  snapshot?: boolean
}

const KPI_DEFS: KPIDef[] = [
  { key: 'revenue_kobo',        label: 'Revenue',         format: 'kobo', metric: 'revenue_kobo' },
  { key: 'active_cards',        label: 'Active Cards',    format: 'num',  metric: 'active_cards', snapshot: true },
  { key: 'new_customers',       label: 'New Customers',   format: 'num',  metric: 'new_customers' },
  { key: 'active_loans',        label: 'Active Loans',    format: 'num',  metric: 'active_loans', snapshot: true },
  { key: 'total_disbursed_kobo', label: 'Total Disbursed', format: 'kobo', metric: 'disbursed_kobo',
    emptyHint: 'No loans disbursed through the workspace yet — the book is synced from Udara.' },
  { key: 'npl_ratio_pct',       label: 'NPL Ratio',       format: 'pct',  metric: 'npl_pct',        lowerIsBetter: true, snapshot: true },
  { key: 'par30_pct',           label: 'PAR30',           format: 'pct',  metric: 'par30_pct',      lowerIsBetter: true, snapshot: true },
  { key: 'collection_rate_pct', label: 'Collection Rate', format: 'pct',  metric: 'collection_pct',
    emptyHint: 'No collections activity has been logged yet.' },
  { key: 'recovery_rate_pct',   label: 'Recovery Rate',   format: 'pct',  metric: 'recovery_pct' },
  { key: 'csat_score',          label: 'CSAT',            format: 'num',  metric: 'csat',
    emptyHint: 'No CSAT responses recorded yet.' },
]

// Metric → display format, so the targets editor can collect naira for a kobo
// metric and store it in kobo (matching the value it is compared against).
const FMT_BY_METRIC: Record<string, KPIFormat> = Object.fromEntries(KPI_DEFS.map(d => [d.metric, d.format]))

const PERIOD_OPTIONS = [
  { value: 'this_month',   label: 'This Month' },
  { value: 'last_month',   label: 'Last Month' },
  { value: 'this_quarter', label: 'This Quarter' },
  { value: 'last_quarter', label: 'Last Quarter' },
  { value: 'this_year',    label: 'This Year' },
]

// ── Formatting ────────────────────────────────────────────────────────────────

function fmt(val: number, format: KPIFormat): string {
  if (format === 'kobo') return fmtKobo(val)
  if (format === 'pct')  return `${val.toFixed(1)}%`
  return fmtNum(val)
}

// ── RAG ───────────────────────────────────────────────────────────────────────

/**
 * A RAG dot is only shown when a target exists. `target` is undefined when the
 * metric has no row in kpi_targets — distinct from a target of 0, which is a
 * real goal and is evaluated normally.
 */
function RagDot({ value, target, lowerIsBetter }: {
  value: number; target: number | undefined; lowerIsBetter?: boolean
}) {
  if (target === undefined) {
    return (
      <span
        title="No target set for this metric"
        style={{
          width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
          border: '1.5px dashed var(--txt3)', display: 'inline-block',
        }}
      />
    )
  }
  let color: string
  if (lowerIsBetter) {
    // A zero target means "none at all"; anything above it is off-track.
    if (target === 0) color = value === 0 ? GREEN : RED
    else {
      const ratio = value / target
      color = ratio <= 1 ? GREEN : ratio <= 1.25 ? AMBER : RED
    }
  } else {
    if (target === 0) color = GREEN
    else {
      const pct = (value / target) * 100
      color = pct >= 100 ? GREEN : pct >= 80 ? AMBER : RED
    }
  }
  return (
    <span style={{
      width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0,
      boxShadow: `0 0 0 2px ${color}22`, display: 'inline-block',
    }} />
  )
}

// ── KPI card ──────────────────────────────────────────────────────────────────

function KPICard({ def, values, loading }: { def: KPIDef; values: KPIValues; loading: boolean }) {
  const val = n(values[def.key])
  const rawTarget = values[`target_${def.metric}`]
  const target = rawTarget === undefined || rawTarget === null ? undefined : Number(rawTarget)
  const showHint = !loading && val === 0 && def.emptyHint

  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--card-bdr)', boxShadow: 'var(--card-shadow)',
      borderRadius: RADIUS.xl, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)',
          letterSpacing: '0.3px', textTransform: 'uppercase', flex: 1,
        }}>{def.label}</span>
        {def.snapshot && (
          <span title="Point-in-time — the live book right now, not a sum over the selected period"
            style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>now</span>
        )}
        {!loading && <RagDot value={val} target={target} lowerIsBetter={def.lowerIsBetter} />}
      </div>

      {loading ? <Sk h={28} w="60%" /> : (
        <span style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color: 'var(--txt)' }}>
          {fmt(val, def.format)}
        </span>
      )}

      {!loading && (
        target !== undefined ? (
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontFamily: INTER }}>
            Target {fmt(target, def.format)}
          </span>
        ) : (
          <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: INTER }}>
            No target set
          </span>
        )
      )}

      {showHint && (
        <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', lineHeight: 1.5 }}>
          {def.emptyHint}
        </span>
      )}
    </div>
  )
}

// ── Targets editor ────────────────────────────────────────────────────────────

function TargetsModal({ open, onClose, values, onSaved }: {
  open: boolean
  onClose: () => void
  values: KPIValues
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    const d: Record<string, string> = {}
    for (const def of KPI_DEFS) {
      const t = values[`target_${def.metric}`]
      // Values for kobo metrics are stored in kobo; the editor works in naira, so
      // show the stored target ÷100 when it is a money metric.
      d[def.metric] = t === undefined || t === null ? '' : String(def.format === 'kobo' ? Number(t) / 100 : t)
    }
    setDraft(d)
  }, [open, values])

  async function save() {
    setSaving(true)
    try {
      // Only send what was actually filled in — a blank field means "no target",
      // and writing 0 for it would turn every metric permanently green.
      const entries = Object.entries(draft).filter(([, v]) => v.trim() !== '')
      if (entries.length === 0) { toast.error('Enter at least one target'); setSaving(false); return }
      for (const [metric, v] of entries) {
        const num = Number(v)
        if (!Number.isFinite(num)) { toast.error(`${metric}: not a number`); setSaving(false); return }
        // A money target is entered in naira but must be stored in kobo so it lines
        // up with the metric value it is compared against (which is in kobo).
        const stored = FMT_BY_METRIC[metric] === 'kobo' ? Math.round(num * 100) : num
        await apiPut('/api/kpi/targets', {
          role: 'all', metric_name: metric, period: 'monthly', target_value: stored,
        })
      }
      toast.success(`Saved ${entries.length} target${entries.length === 1 ? '' : 's'}`)
      onSaved()
      onClose()
    } catch (e: any) {
      toast.error(e.message ?? 'Could not save targets')
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  const inputStyle: React.CSSProperties = {
    height: 30, padding: '0 8px', border: '1px solid var(--input-bdr)', width: 150,
    borderRadius: RADIUS.md, fontSize: TEXT.sm, background: 'var(--input-bg)',
    color: 'var(--txt)', textAlign: 'right', ...NUM,
  }

  return (
    <Modal open={open} onClose={onClose} title="KPI Targets" width={520}>
      <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.6, marginBottom: SP[4] }}>
        Targets are stored per month. Leave a field blank to leave that metric
        untargeted — it will show a hollow indicator rather than a misleading
        green one. Amounts are in naira.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2], maxHeight: 380, overflowY: 'auto' }}>
        {KPI_DEFS.map(def => (
          <label key={def.metric} style={{
            display: 'flex', alignItems: 'center', gap: SP[3],
            padding: `${SP[2]} ${SP[3]}`, borderRadius: RADIUS.md, background: 'var(--bg)',
          }}>
            <span style={{ flex: 1, fontSize: TEXT.base, color: 'var(--txt)' }}>
              {def.label}
              <span style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginLeft: 6 }}>
                {def.format === 'kobo' ? '₦' : def.format === 'pct' ? '%' : ''}
              </span>
            </span>
            <input
              style={inputStyle}
              inputMode="decimal"
              placeholder="—"
              value={draft[def.metric] ?? ''}
              onChange={e => setDraft(p => ({ ...p, [def.metric]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: SP[2], marginTop: SP[4] }}>
        <button onClick={onClose} style={btnSecondary}>Cancel</button>
        <button onClick={save} disabled={saving} style={btnPrimary}>
          {saving ? 'Saving…' : 'Save Targets'}
        </button>
      </div>
    </Modal>
  )
}

// A month whose card feed did not fully deliver understates every figure, so the
// tooltip flags it rather than letting the chart imply a real dip.
function feedNote(row: HistoryRow | undefined): ReactNode {
  if (!row || row.data_complete) return null
  return `Card feed incomplete this month (${fmtNum(row.txn_count)} txns) — figures understate.`
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function KPITracker() {
  const [period, setPeriod] = useState('this_month')
  const [months, setMonths] = useState(12)
  const [values, setValues] = useState<KPIValues>({})
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [targetsOpen, setTargetsOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [k, h] = await Promise.all([
        apiFetch<any>(`/api/reports/kpis?period=${period}`),
        apiFetch<any>(`/api/reports/kpi-history?months=${months}`),
      ])
      setValues((k?.data ?? k ?? {}) as KPIValues)
      const rows = Array.isArray(h) ? h : (h?.data ?? [])
      setHistory(rows as HistoryRow[])
    } catch (e: any) {
      setError(e.message ?? 'Could not load KPIs')
    } finally {
      setLoading(false)
    }
  }, [period, months])

  useEffect(() => { load() }, [load])

  const targetsSet = n(values['targets_set'])
  const gapMonths = useMemo(() => history.filter(r => !r.data_complete), [history])

  // A month with an incomplete card feed is charted as a gap (null), not zero, so
  // the line breaks instead of diving to the floor. Both revenue (card income) and
  // new customers (card opens) come from that feed, so both are gapped; the loan,
  // NPL, ticket and CSAT series come from other sources and are left intact.
  const chartData = useMemo(() => history.map(r => ({
    ...r,
    revenue_plot: r.data_complete ? r.revenue_kobo : null,
    customers_plot: r.data_complete ? r.new_customers : null,
  })), [history])

  const canEditTargets = hasPage('settings') || hasPage('reports')

  return (
    <Page
      title="KPI Tracker"
      subtitle="Headline performance against target · cards marked “now” are point-in-time and do not move with the period"
      loading={loading && history.length === 0}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
          <select value={period} onChange={e => setPeriod(e.target.value)} style={{
            height: 32, padding: '0 10px', border: '1px solid var(--input-bdr)',
            borderRadius: RADIUS.md, fontSize: TEXT.sm, background: 'var(--input-bg)', color: 'var(--txt)',
          }}>
            {PERIOD_OPTIONS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          {canEditTargets && (
            <button onClick={() => setTargetsOpen(true)} style={btnSecondary}>
              <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>flag</span>
              Targets
            </button>
          )}
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* No targets is the single most misleading state this page can be in, so
          it is stated rather than implied by a row of identical dots. */}
      {!loading && targetsSet === 0 && (
        <div style={{
          display: 'flex', gap: SP[3], alignItems: 'flex-start', marginBottom: SP[4],
          padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.lg,
          background: 'rgba(217,119,6,.08)', border: `1px solid ${AMBER}40`,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg, color: AMBER, flexShrink: 0 }}>flag</span>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', lineHeight: 1.6 }}>
            <strong>No targets have been set.</strong> Every metric below shows its actual
            value, but nothing can be judged on-track or off-track until targets exist.
            {canEditTargets && ' Use the Targets button to add them.'}
          </div>
        </div>
      )}

      {/* Feed gaps, stated once at the top rather than left to be inferred from
          a chart that appears to show months of zero revenue. */}
      {!loading && gapMonths.length > 0 && (
        <div style={{
          display: 'flex', gap: SP[3], alignItems: 'flex-start', marginBottom: SP[4],
          padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.lg,
          background: 'rgba(37,99,235,.06)', border: `1px solid ${BLUE}33`,
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: TEXT.lg, color: BLUE, flexShrink: 0 }}>info</span>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt)', lineHeight: 1.6 }}>
            The card transaction feed is incomplete for{' '}
            <strong>{gapMonths.map(m => m.period_label).join(', ')}</strong>. Card
            figures for {gapMonths.length === 1 ? 'that month' : 'those months'} understate
            reality and are shown as gaps in the charts rather than as zero.
          </div>
        </div>
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
        gap: SP[3], marginBottom: SP[5],
      }}>
        {KPI_DEFS.map(def => (
          <KPICard key={def.key} def={def} values={values} loading={loading} />
        ))}
      </div>

      <SectionCard
        title="Revenue & Acquisition"
        subtitle={`Last ${months} months — fee, interest and penalty income against new customers`}
        actions={
          <select value={months} onChange={e => setMonths(Number(e.target.value))} style={{
            height: 28, padding: '0 8px', border: '1px solid var(--input-bdr)',
            borderRadius: RADIUS.sm, fontSize: TEXT.sm, background: 'var(--input-bg)', color: 'var(--txt)',
          }}>
            {[6, 12, 24].map(m => <option key={m} value={m}>{m} months</option>)}
          </select>
        }
      >
        {loading ? <Sk h={300} /> : history.length === 0 ? (
          <div style={{ padding: SP[6], textAlign: 'center', color: 'var(--txt2)', fontSize: TEXT.base }}>
            No history available.
          </div>
        ) : (
          <ECombo
            data={chartData} xKey="period_label" height={320} rightAxis
            valueFmt={fmtKobo} axisFmt={koboAxis} rightFmt={fmtNum}
            areas={[{ key: 'revenue_plot', name: 'Revenue', color: NAVY, fmt: fmtKobo }]}
            lines={[{ key: 'customers_plot', name: 'New Customers', color: BLUE, fmt: fmtNum }]}
          />
        )}
      </SectionCard>

      <SectionCard title="Portfolio Quality" subtitle="NPL ratio against disbursement, from the live loan book">
        {loading ? <Sk h={260} /> : (
          <ECombo
            data={history} xKey="period_label" height={280} rightAxis
            valueFmt={fmtKobo} axisFmt={koboAxis} rightFmt={(v) => `${v.toFixed(1)}%`}
            areas={[{ key: 'total_disbursed_kobo', name: 'Disbursed', color: NAVY, fmt: fmtKobo }]}
            lines={[{ key: 'npl_ratio_pct', name: 'NPL %', color: RED, fmt: (v) => `${v.toFixed(1)}%` }]}
          />
        )}
      </SectionCard>

      <SectionCard title="Service Volume" subtitle="Tickets raised and customer satisfaction">
        {loading ? <Sk h={240} /> : (
          <ECombo
            data={history} xKey="period_label" height={260} rightAxis
            valueFmt={fmtNum} axisFmt={fmtNum} rightFmt={(v) => v.toFixed(2)}
            areas={[{ key: 'tickets_created', name: 'Tickets', color: NAVY, fmt: fmtNum }]}
            lines={[{ key: 'csat_score', name: 'CSAT', color: GREEN, fmt: (v) => v.toFixed(2) }]}
          />
        )}
      </SectionCard>

      <TargetsModal
        open={targetsOpen}
        onClose={() => setTargetsOpen(false)}
        values={values}
        onSaved={load}
      />
    </Page>
  )
}
