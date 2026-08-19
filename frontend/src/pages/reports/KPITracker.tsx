import { useEffect, useState, useCallback, useMemo } from 'react'
import { Page, SectionCard, ErrBanner, Sk, Modal, btnPrimary, btnSecondary } from '../../components/UI'
import { apiFetch, apiPut } from '../../lib/api'
import { fmtKobo, fmtNum, n } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, BLUE, INTER, NUM, FW, RADIUS, SP, TEXT } from '../../lib/design'
import { hasPage } from '../../hooks/useAuth'
import { toast } from 'sonner'
import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from 'recharts'

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
}

const KPI_DEFS: KPIDef[] = [
  { key: 'revenue_kobo',        label: 'Revenue',         format: 'kobo', metric: 'revenue_kobo' },
  { key: 'active_cards',        label: 'Active Cards',    format: 'num',  metric: 'active_cards' },
  { key: 'new_customers',       label: 'New Customers',   format: 'num',  metric: 'new_customers' },
  { key: 'active_loans',        label: 'Active Loans',    format: 'num',  metric: 'active_loans' },
  { key: 'total_disbursed_kobo', label: 'Total Disbursed', format: 'kobo', metric: 'disbursed_kobo',
    emptyHint: 'No loans disbursed through the workspace yet — the book is synced from Udara.' },
  { key: 'npl_ratio_pct',       label: 'NPL Ratio',       format: 'pct',  metric: 'npl_pct',        lowerIsBetter: true },
  { key: 'par30_pct',           label: 'PAR30',           format: 'pct',  metric: 'par30_pct',      lowerIsBetter: true },
  { key: 'collection_rate_pct', label: 'Collection Rate', format: 'pct',  metric: 'collection_pct',
    emptyHint: 'No collections activity has been logged yet.' },
  { key: 'recovery_rate_pct',   label: 'Recovery Rate',   format: 'pct',  metric: 'recovery_pct' },
  { key: 'csat_score',          label: 'CSAT',            format: 'num',  metric: 'csat',
    emptyHint: 'No CSAT responses recorded yet.' },
]

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
      d[def.metric] = t === undefined || t === null ? '' : String(t)
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
        await apiPut('/api/kpi/targets', {
          role: 'all', metric_name: metric, period: 'monthly', target_value: num,
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

// ── Chart tooltip ─────────────────────────────────────────────────────────────

function Tip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const row: HistoryRow | undefined = payload[0]?.payload
  return (
    <div style={{
      background: NAVY, borderRadius: RADIUS.lg, padding: '10px 14px',
      boxShadow: '0 8px 28px rgba(0,0,0,.4)', border: '1px solid rgba(255,255,255,.08)',
    }}>
      <div style={{
        fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: 'rgba(255,255,255,.45)',
        fontFamily: INTER, marginBottom: 7, letterSpacing: 0.5, textTransform: 'uppercase',
      }}>{label}</div>
      {row && !row.data_complete && (
        <div style={{ fontSize: TEXT.xs, color: AMBER, marginBottom: 6, maxWidth: 220, lineHeight: 1.4 }}>
          Card feed incomplete for this month ({fmtNum(row.txn_count)} transactions) — figures understate.
        </div>
      )}
      {payload.map((p: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginTop: i > 0 ? 4 : 0 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
          <span style={{ fontSize: TEXT.base, fontWeight: FW.bold, color: '#fff', fontFamily: INTER }}>
            {p.name.includes('₦') ? fmtKobo(p.value) : fmtNum(p.value)}
          </span>
          <span style={{ fontSize: TEXT['2xs'], color: 'rgba(255,255,255,.45)', fontFamily: INTER }}>{p.name}</span>
        </div>
      ))}
    </div>
  )
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

  // A month with an incomplete feed is charted as a gap (null), not as zero, so
  // the line breaks instead of diving to the floor.
  const chartData = useMemo(() => history.map(r => ({
    ...r,
    revenue_plot: r.data_complete ? r.revenue_kobo : null,
    customers_plot: r.new_customers,
  })), [history])

  const canEditTargets = hasPage('settings') || hasPage('reports')

  return (
    <Page
      title="KPI Tracker"
      subtitle="Headline performance against target"
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
          <div style={{ height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
                <XAxis dataKey="period_label" tick={{ fontSize: 11, fill: 'var(--txt2)' }}
                  axisLine={false} tickLine={false} />
                <YAxis yAxisId="left" tick={{ fontSize: 11, fill: 'var(--txt2)' }}
                  axisLine={false} tickLine={false}
                  tickFormatter={(v: number) => fmtKobo(v).replace(/\.00$/, '')} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: 'var(--txt2)' }}
                  axisLine={false} tickLine={false} />
                <Tooltip content={<Tip />} />
                <Legend wrapperStyle={{ fontSize: 11, fontFamily: INTER }} />
                <Bar yAxisId="left" dataKey="revenue_plot" name="Revenue ₦" fill={NAVY}
                  radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Line yAxisId="right" dataKey="customers_plot" name="New Customers"
                  stroke={BLUE} strokeWidth={2} dot={{ r: 3 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Portfolio Quality" subtitle="NPL ratio against disbursement, from the live loan book">
        {loading ? <Sk h={260} /> : (
          <div style={{ height: 280 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={history} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
                <XAxis dataKey="period_label" tick={{ fontSize: 11, fill: 'var(--txt2)' }}
                  axisLine={false} tickLine={false} />
                <YAxis yAxisId="left" tick={{ fontSize: 11, fill: 'var(--txt2)' }}
                  axisLine={false} tickLine={false}
                  tickFormatter={(v: number) => fmtKobo(v).replace(/\.00$/, '')} />
                <YAxis yAxisId="right" orientation="right" unit="%"
                  tick={{ fontSize: 11, fill: 'var(--txt2)' }} axisLine={false} tickLine={false} />
                <Tooltip content={<Tip />} />
                <Legend wrapperStyle={{ fontSize: 11, fontFamily: INTER }} />
                <Bar yAxisId="left" dataKey="total_disbursed_kobo" name="Disbursed ₦"
                  fill={BLUE} radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Line yAxisId="right" dataKey="npl_ratio_pct" name="NPL %"
                  stroke={RED} strokeWidth={2} dot={{ r: 3 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Service Volume" subtitle="Tickets raised and customer satisfaction">
        {loading ? <Sk h={240} /> : (
          <div style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={history} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--bdr)" vertical={false} />
                <XAxis dataKey="period_label" tick={{ fontSize: 11, fill: 'var(--txt2)' }}
                  axisLine={false} tickLine={false} />
                <YAxis yAxisId="left" tick={{ fontSize: 11, fill: 'var(--txt2)' }}
                  axisLine={false} tickLine={false} />
                <YAxis yAxisId="right" orientation="right" domain={[0, 5]}
                  tick={{ fontSize: 11, fill: 'var(--txt2)' }} axisLine={false} tickLine={false} />
                <Tooltip content={<Tip />} />
                <Legend wrapperStyle={{ fontSize: 11, fontFamily: INTER }} />
                <Bar yAxisId="left" dataKey="tickets_created" name="Tickets"
                  fill={GREEN} radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Line yAxisId="right" dataKey="csat_score" name="CSAT"
                  stroke={AMBER} strokeWidth={2} dot={{ r: 3 }} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
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
