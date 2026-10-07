import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Page, KpiCard, SectionCard, ErrBanner, Button, Modal, Field, Select, DataTable,
  EmptyState, StatusBadge, Badge, DateFilter, SegmentedToggle, Textarea,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, fmtDatetime, today, monthStart } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

/*
  RECONCILE — run the matching, read the result, sign it off.

  This page absorbs what used to be two: the Workbench (start a run, inspect one
  run) and Runs & Imports (the activity log, Paystack sync status). They were split
  for no reason a user could act on — you cannot judge a run without the log of what
  else arrived around it, and you cannot read the log without the run detail it
  points at. One surface, three bands: run it, read it, see everything that landed.
*/

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReconRun {
  id: number
  source: string
  counterparty: string
  period_from: string
  period_to: string
  status: string
  started_at: string
  finished_at: string | null
  error: string | null
  source_n: number
  matched_n: number
  ambiguous_n: number
  unmatched_n: number
  source_value_kobo: number
  matched_value_kobo: number
  unmatched_value_kobo: number
  match_rate_pct: number
  triggered_by_name: string
  signed_off_by_name: string
  signed_off_at: string | null
  signoff_note: string
}

interface TierRow   { tier: string; confidence: number; n: number; value_kobo: number }
interface ReasonRow { reason: string; status: string; n: number; value_kobo: number }
interface RunDetail { run: ReconRun; tiers: TierRow[]; exceptions: ReasonRow[] }

interface Activity {
  activity: string
  id: number | null
  started_at: string
  finished_at: string | null
  status: string
  detail: string
  records: number
  match_rate_pct: number | null
  exceptions: number
  actor: string
  error: string
  signed_off: boolean
}
interface ActivityResp { runs: Activity[]; syncs: Activity[]; imports: Activity[] }

interface SyncStatus {
  configured: boolean
  last_run: {
    id?: number; kind?: string; status?: string; started_at?: string; finished_at?: string
    watermark?: string; transactions?: number; transfers?: number; settlements?: number
    disputes?: number; error?: string
  }
  snapshot: { transactions: number; transfers: number; settlements: number; disputes: number }
}

// ── The reconcilable pairs ────────────────────────────────────────────────────

/*
  Two pairs, in the order the business reads them: the master against our own book,
  then the provider against the master.

  'Interswitch EOD → Sage Ledger' used to be the only entry, and it named neither
  side of what it ran. The engine staged its source from a view over
  ccs_transactions, so it compared the CCS master to the card account book while
  reporting a reconciliation of Interswitch against Sage — and the real Interswitch
  settlement feed had never been reconciled against anything. Both are now named
  for what they actually compare.
*/
const PAIRS = [
  {
    value: 'ccs', counterparty: 'card_ledger',
    label: 'CCS Master', cpLabel: 'Card Account Book', tone: NAVY,
    hint: 'Every CCS transaction against the account it posted to. Anchored on CIF, strengthened by trace.',
  },
  {
    value: 'interswitch', counterparty: 'ccs',
    label: 'Interswitch Settlement', cpLabel: 'CCS Master', tone: BLUE,
    hint: 'Uploaded settlement reports against the master ledger. Anchored on STAN and dated on the transaction time — Interswitch settles T+1.',
  },
]

function pairLabel(source: string, counterparty: string): string {
  const p = PAIRS.find(x => x.value === source && x.counterparty === counterparty)
  if (p) return `${p.label} → ${p.cpLabel}`
  // A run recorded under the deprecated name. Left readable rather than hidden.
  if (source === 'interswitch' && counterparty === 'sage_ledger') {
    return 'CCS Master → Card Account Book (legacy label)'
  }
  return `${source} → ${counterparty}`
}

const REASON_LABEL: Record<string, string> = {
  // Not a settlement break: the counterparty ledger holds nothing at all for those
  // days, so there was never anything to pair against. It belongs to whoever owns
  // the feed, not to the desk.
  master_no_data:  'Counterparty Feed Gap',
  no_candidate:    'No Ledger Match',
  ambiguous:       'Ambiguous',
  amount_mismatch: 'Amount Differs',
}
const REASON_COLOR: Record<string, string> = {
  master_no_data:  '#5B7A94',
  no_candidate:    RED,
  ambiguous:       AMBER,
  amount_mismatch: BLUE,
}

const ACTIVITY_META: Record<string, { label: string; icon: string; color: string }> = {
  reconciliation:     { label: 'Reconciliation', icon: 'rule',        color: NAVY },
  paystack_sync:      { label: 'Paystack Sync',  icon: 'sync',        color: BLUE },
  interswitch_import: { label: 'EOD Import',     icon: 'upload_file', color: PURPLE },
}

function rateColor(pct: number) {
  return pct >= 95 ? GREEN : pct >= 80 ? AMBER : RED
}

function duration(a: string, b: string | null): string {
  if (!b) return '—'
  const ms = new Date(b).getTime() - new Date(a).getTime()
  if (!isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

/*
  Tier bars. Confidence is shown because a match at 0.70 is a different claim to one
  at 0.99, and an officer signing off the day is entitled to know which they are
  accepting. The tier that produced each match is the audit trail for that claim.
*/
function TierBars({ tiers, total }: { tiers: TierRow[]; total: number }) {
  if (!tiers.length) {
    return (
      <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>
        No tier produced a match in this run.
      </div>
    )
  }
  return (
    <div>
      {tiers.map(t => {
        const share = total > 0 ? (Number(t.n) / total) * 100 : 0
        const conf  = Number(t.confidence)
        const color = conf >= 0.95 ? GREEN : conf >= 0.85 ? BLUE : AMBER
        return (
          <div key={t.tier} style={{ marginBottom: SP[3] }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: SP[2], marginBottom: 4 }}>
              <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium }}>
                <code style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs }}>{t.tier}</code>
                <Badge variant="default" style={{ marginLeft: SP[2] }}>conf {conf.toFixed(2)}</Badge>
              </span>
              <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>
                {fmtNum(t.n)} · {fmtKobo(t.value_kobo)}
              </span>
            </div>
            <div role="img" aria-label={`${t.tier}: ${fmtNum(t.n)} matches at confidence ${conf.toFixed(2)}`}
              style={{ height: 6, borderRadius: 3, background: 'var(--bdr)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${share}%`, background: color, borderRadius: 3 }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* Exception mix for one run, split so the feed gap never sits in the same total as
   a real break. */
function ExceptionMix({ rows }: { rows: ReasonRow[] }) {
  const grouped = useMemo(() => {
    const m = new Map<string, { n: number; value: number }>()
    for (const r of rows) {
      const cur = m.get(r.reason) ?? { n: 0, value: 0 }
      m.set(r.reason, { n: cur.n + Number(r.n), value: cur.value + Number(r.value_kobo) })
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n)
  }, [rows])

  if (!grouped.length) {
    return <EmptyState icon="check_circle" title="Nothing unmatched"
      description="Every source row in this run found exactly one counterpart." />
  }

  const total = grouped.reduce((s, [, v]) => s + v.n, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
      {/* Stacked proportion bar — one glance at the shape of the queue. */}
      <div aria-hidden="true" style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--bdr)' }}>
        {grouped.map(([reason, v]) => (
          <div key={reason} style={{
            width: `${total > 0 ? (v.n / total) * 100 : 0}%`,
            background: REASON_COLOR[reason] ?? 'var(--txt3)',
          }} />
        ))}
      </div>
      {grouped.map(([reason, v]) => (
        <div key={reason} style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
          <span aria-hidden="true" style={{
            width: 9, height: 9, borderRadius: 2, flexShrink: 0,
            background: REASON_COLOR[reason] ?? 'var(--txt3)',
          }} />
          <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>
            {REASON_LABEL[reason] ?? reason}
          </span>
          {reason === 'master_no_data' && (
            <Badge variant="default">not the desk&apos;s</Badge>
          )}
          <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
            {fmtNum(v.n)} · {fmtKobo(v.value)}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

type LogFilter = 'all' | 'reconciliation' | 'interswitch_import' | 'paystack_sync'

export default function Reconcile() {
  const [runs, setRuns]             = useState<ReconRun[]>([])
  const [detail, setDetail]         = useState<RunDetail | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [activity, setActivity]     = useState<ActivityResp | null>(null)
  const [sync, setSync]             = useState<SyncStatus | null>(null)
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState<string | null>(null)

  const [runOpen, setRunOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [pair, setPair]       = useState(PAIRS[1].value)   // the new pair leads: it is the one with work to do
  // Month to date, like every other dated screen in the module. These defaults were
  // frozen at 2025-01-01 → 2025-12-31, so every run opened on a year that had
  // already closed and nobody reconciling the current month would notice.
  const [periodFrom, setPeriodFrom] = useState(monthStart())
  const [periodTo, setPeriodTo]     = useState(today())

  const [signOpen, setSignOpen] = useState(false)
  const [signNote, setSignNote] = useState('')
  const [signing, setSigning]   = useState(false)

  const [logFilter, setLogFilter] = useState<LogFilter>('all')
  const [syncing, setSyncing]     = useState(false)
  // An overlapping-period refusal, held separately from `error`: it is a decision
  // to make, not a failure to report.
  const [overlap, setOverlap] = useState<string | null>(null)
  const [notice, setNotice]   = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // The run list is the only hard requirement; the log and sync panels are
      // supporting detail and must not blank the page if either is unavailable.
      const [rs, act, st] = await Promise.all([
        apiFetch<{ data: ReconRun[] }>('/api/recon/runs?limit=50'),
        apiFetch<ActivityResp>('/api/recon/activity').catch(() => null),
        apiFetch<SyncStatus>('/api/paystack/sync/status').catch(() => null),
      ])
      const list = rs.data ?? []
      setRuns(list)
      setActivity(act)
      setSync(st)
      setSelectedId(prev => (prev === null && list.length ? list[0].id : prev))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load reconciliation runs')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (selectedId === null) { setDetail(null); return }
    let cancelled = false
    apiFetch<RunDetail>(`/api/recon/runs/${selectedId}`)
      .then(d => { if (!cancelled) setDetail(d) })
      .catch(() => { if (!cancelled) setDetail(null) })
    return () => { cancelled = true }
  }, [selectedId])

  /*
    Start a run.

    RE-RUNNING A PERIOD USED TO DOUBLE THE QUEUE. Every unmatched source row
    becomes a new exception on every run, so reconciling a period that had already
    been reconciled produced a second complete copy of its breaks — same
    transactions, new ids, all open, all ageing from today. Nothing warned anyone;
    the button simply worked. The API now refuses an overlapping run with 409 and
    names the earlier one, and this is where that refusal is turned into a choice
    rather than an error message.
  */
  const startRun = async (supersede = false) => {
    setRunning(true)
    setError(null)
    try {
      const p = PAIRS.find(x => x.value === pair) ?? PAIRS[0]
      const res = await apiPost<{ run_id: number; superseded_n?: number }>('/api/recon/runs', {
        source: p.value,
        counterparty: p.counterparty,
        period_from: periodFrom,
        period_to: periodTo,
        supersede,
      })
      setRunOpen(false)
      setOverlap(null)
      setSelectedId(res.run_id)
      if (supersede && Number(res.superseded_n ?? 0) > 0) {
        setNotice(`${fmtNum(res.superseded_n)} exception(s) from the earlier run were closed as superseded. `
          + 'Anything already resolved was left untouched.')
      }
      await load()
    } catch (e: unknown) {
      // The 409 carries the prior runs. apiPost surfaces the server's message; the
      // marker in it is what distinguishes "already reconciled" from a real failure.
      const msg = e instanceof Error ? e.message : 'Reconciliation failed'
      if (/already been reconciled/i.test(msg)) {
        setOverlap(msg)
      } else {
        setError(msg)
      }
    } finally {
      setRunning(false)
    }
  }

  const signOff = async () => {
    if (selectedId === null) return
    setSigning(true)
    try {
      await apiPost(`/api/recon/runs/${selectedId}/signoff`, { note: signNote })
      setSignOpen(false)
      setSignNote('')
      await load()
      setDetail(await apiFetch<RunDetail>(`/api/recon/runs/${selectedId}`))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Sign-off failed')
    } finally {
      setSigning(false)
    }
  }

  const triggerSync = async () => {
    setSyncing(true)
    try {
      await apiPost('/api/paystack/sync', {})
      await load()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Sync failed to start')
    } finally {
      setSyncing(false)
    }
  }

  const run  = detail?.run
  const rate = Number(run?.match_rate_pct ?? 0)

  // Feed gaps are reported apart from the run's break count, for the same reason
  // they are everywhere else: an officer cannot close a day the counterparty never
  // sent, and counting it as an outstanding break is what let the queue grow to
  // ten thousand items nobody could action.
  const gapN = useMemo(() =>
    (detail?.exceptions ?? [])
      .filter(e => e.reason === 'master_no_data')
      .reduce((s, e) => s + Number(e.n), 0), [detail])
  const breakN = Number(run?.unmatched_n ?? 0) - gapN

  // ── Activity log ────────────────────────────────────────────────────────────
  const logRows = useMemo(() => {
    const all = [
      ...(activity?.runs ?? []),
      ...(activity?.imports ?? []),
      ...(activity?.syncs ?? []),
    ]
    const filtered = logFilter === 'all' ? all : all.filter(a => a.activity === logFilter)
    return filtered.sort((a, b) =>
      new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
  }, [activity, logFilter])

  const logCols: TableCol<Activity>[] = [
    {
      key: 'activity', label: 'Activity', sortable: true, width: 190,
      render: a => {
        const m = ACTIVITY_META[a.activity] ?? { label: a.activity, icon: 'help', color: 'var(--txt3)' }
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: SP[2] }}>
            <span className="material-symbols-rounded" aria-hidden="true"
              style={{ fontSize: 16, color: m.color }}>{m.icon}</span>
            <span style={{ fontWeight: FW.medium }}>{m.label}</span>
          </span>
        )
      },
    },
    { key: 'detail', label: 'Detail', render: a => (
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{a.detail || '—'}</span>
    ) },
    { key: 'started_at', label: 'Started', sortable: true, width: 150,
      render: a => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtDatetime(a.started_at)}</span> },
    { key: 'took', label: 'Took', align: 'right', width: 80,
      render: a => <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>
        {duration(a.started_at, a.finished_at)}</span> },
    { key: 'records', label: 'Records', align: 'right', sortable: true, width: 90,
      render: a => <span style={NUM}>{fmtNum(a.records)}</span> },
    { key: 'match_rate_pct', label: 'Matched', align: 'right', sortable: true, width: 90,
      render: a => a.match_rate_pct === null
        ? <span style={{ color: 'var(--txt3)' }}>—</span>
        : <span style={{ ...NUM, color: rateColor(Number(a.match_rate_pct)), fontWeight: FW.semibold }}>
            {Number(a.match_rate_pct).toFixed(1)}%</span> },
    { key: 'status', label: 'Status', width: 120, render: a => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: SP[2] }}>
        <StatusBadge status={a.status} size="sm" />
        {a.signed_off && (
          <span className="material-symbols-rounded" title="Signed off" aria-label="Signed off"
            style={{ fontSize: 15, color: GREEN }}>task_alt</span>
        )}
      </span>
    ) },
    { key: 'actor', label: 'By', width: 130, render: a => (
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{a.actor || 'System'}</span>
    ) },
  ]

  const runCols: TableCol<ReconRun>[] = [
    { key: 'id', label: 'Run', width: 70, sortable: true,
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>#{r.id}</span> },
    { key: 'pair', label: 'Pair', render: r => (
      <span style={{ fontSize: TEXT.sm }}>{pairLabel(r.source, r.counterparty)}</span>
    ) },
    { key: 'period_from', label: 'Period', width: 180, sortable: true, render: r => (
      <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>
        {fmtDate(r.period_from)} – {fmtDate(r.period_to)}
      </span>
    ) },
    { key: 'source_n', label: 'Source', align: 'right', sortable: true, width: 90,
      render: r => <span style={NUM}>{fmtNum(r.source_n)}</span> },
    { key: 'match_rate_pct', label: 'Matched', align: 'right', sortable: true, width: 100,
      render: r => (
        <span style={{ ...NUM, color: rateColor(Number(r.match_rate_pct)), fontWeight: FW.semibold }}>
          {Number(r.match_rate_pct).toFixed(1)}%
        </span>
      ) },
    { key: 'unmatched_n', label: 'Unmatched', align: 'right', sortable: true, width: 100,
      render: r => <span style={NUM}>{fmtNum(r.unmatched_n)}</span> },
    { key: 'status', label: 'Status', width: 130, render: r => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: SP[2] }}>
        <StatusBadge status={r.status} size="sm" />
        {r.signed_off_at && (
          <span className="material-symbols-rounded" title={`Signed off by ${r.signed_off_by_name}`}
            aria-label={`Signed off by ${r.signed_off_by_name}`}
            style={{ fontSize: 15, color: GREEN }}>task_alt</span>
        )}
      </span>
    ) },
  ]

  const activePair = PAIRS.find(p => p.value === pair)

  return (
    <Page
      title="Reconcile"
      subtitle="Match a provider against the master, read the result, sign it off"
      loading={loading && !runs.length}
      skeletonKpis={4}
      actions={<Button icon="play_arrow" onClick={() => setRunOpen(true)}>Run Reconciliation</Button>}
    >
      <ErrBanner error={error} onRetry={load} />

      {/* ── Already reconciled: a decision, not an error ── */}
      {overlap && (
        <div role="alert" style={{
          display: 'flex', alignItems: 'flex-start', gap: SP[3],
          padding: SP[4], marginBottom: SP[5], borderRadius: RADIUS.lg,
          background: 'var(--card)', border: '1px solid var(--card-bdr)',
          borderLeft: `4px solid ${AMBER}`, boxShadow: 'var(--card-shadow)',
        }}>
          <span className="material-symbols-rounded" aria-hidden="true"
            style={{ fontSize: 22, color: AMBER, flexShrink: 0, marginTop: 1 }}>history</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>
              This period has already been reconciled
            </div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 3, lineHeight: 'var(--lh-relaxed)' }}>
              Running it again would raise a second copy of every break the earlier run found — the
              same transactions, new items, all ageing from today. Superseding runs it and closes the
              earlier run&apos;s still-open items instead. Anything already resolved is left untouched.
            </div>
          </div>
          <div style={{ display: 'flex', gap: SP[2], flexShrink: 0 }}>
            <Button size="sm" variant="secondary" onClick={() => setOverlap(null)}>Cancel</Button>
            <Button size="sm" icon="history_toggle_off" loading={running}
              onClick={() => startRun(true)}>Supersede</Button>
          </div>
        </div>
      )}

      {notice && (
        <div role="status" style={{
          display: 'flex', alignItems: 'center', gap: SP[3],
          padding: SP[4], marginBottom: SP[5], borderRadius: RADIUS.lg,
          background: 'var(--card)', border: '1px solid var(--card-bdr)',
          borderLeft: `4px solid ${GREEN}`,
        }}>
          <span className="material-symbols-rounded" aria-hidden="true"
            style={{ fontSize: 20, color: GREEN }}>check_circle</span>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{notice}</div>
          <Button size="sm" variant="secondary" style={{ marginLeft: 'auto' }}
            onClick={() => setNotice(null)}>Dismiss</Button>
        </div>
      )}

      {/* ── The selected run ── */}
      {run ? (
        <>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
            gap: SP[3], margin: `${SP[4]} 0 ${SP[5]}`,
          }}>
            <KpiCard label="Match Rate" value={`${rate.toFixed(1)}%`}
              sub={`${fmtNum(run.matched_n)} of ${fmtNum(run.source_n)} source rows`}
              icon="join_inner" accent={rateColor(rate)} />
            <KpiCard label="Matched Value" value={fmtKobo(run.matched_value_kobo)}
              sub={`of ${fmtKobo(run.source_value_kobo)} presented`}
              icon="price_check" accent={GREEN} />
            <KpiCard label="Breaks to Work" value={fmtNum(Math.max(breakN, 0))}
              sub={gapN > 0 ? `${fmtNum(gapN)} more are feed gaps` : 'nothing excluded'}
              icon="rule" accent={breakN > 0 ? RED : GREEN} />
            <KpiCard label="Sign-Off"
              value={run.signed_off_at ? 'Signed' : 'Pending'}
              sub={run.signed_off_at
                ? `${run.signed_off_by_name} · ${fmtDate(run.signed_off_at)}`
                : 'No one has accepted this position'}
              icon={run.signed_off_at ? 'task_alt' : 'pending'}
              accent={run.signed_off_at ? GREEN : AMBER} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: SP[4], marginBottom: SP[4] }}>
            <SectionCard
              title={`Run #${run.id} — ${pairLabel(run.source, run.counterparty)}`}
              subtitle={`${fmtDate(run.period_from)} – ${fmtDate(run.period_to)} · started ${fmtDatetime(run.started_at)} · took ${duration(run.started_at, run.finished_at)}`}
              actions={!run.signed_off_at && run.status === 'ok'
                ? <Button size="sm" variant="secondary" icon="task_alt"
                    onClick={() => setSignOpen(true)}>Sign Off</Button>
                : undefined}
            >
              <div style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)',
                textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: SP[3] }}>
                How each match was made
              </div>
              <TierBars tiers={detail?.tiers ?? []} total={Number(run.matched_n)} />
              {run.error && (
                <div style={{
                  marginTop: SP[3], padding: SP[3], borderRadius: RADIUS.md,
                  background: 'rgba(192,0,0,0.06)', border: `1px solid ${RED}33`,
                  fontSize: TEXT.sm, color: RED,
                }}>{run.error}</div>
              )}
              {run.signoff_note && (
                <div style={{
                  marginTop: SP[3], padding: SP[3], borderRadius: RADIUS.md,
                  background: 'var(--th-bg)', fontSize: TEXT.sm, color: 'var(--txt2)',
                }}>
                  <strong style={{ color: 'var(--txt)' }}>Sign-off note:</strong> {run.signoff_note}
                </div>
              )}
            </SectionCard>

            <SectionCard title="What did not match"
              subtitle="Split so a feed gap never sits in the same total as a real break">
              <ExceptionMix rows={detail?.exceptions ?? []} />
            </SectionCard>
          </div>
        </>
      ) : !loading && (
        <SectionCard style={{ marginBottom: SP[4] }}>
          <EmptyState icon="rule" title="No reconciliation has been run"
            description="Pick a pair and a period to produce the first position."
            action={{ label: 'Run Reconciliation', icon: 'play_arrow', onClick: () => setRunOpen(true) }} />
        </SectionCard>
      )}

      {/* ── Run history ── */}
      <SectionCard title="Runs" subtitle="Select a run to inspect it" padding={false}
        style={{ marginBottom: SP[4] }}>
        <DataTable
          cols={runCols} rows={runs} keyFn={r => r.id}
          onRowClick={r => setSelectedId(r.id)}
          rowStyle={r => r.id === selectedId ? { background: 'var(--row-sel)' } : undefined}
          loading={loading && !runs.length} skeletonRows={4} pageSize={10}
          emptyText={<EmptyState icon="history" title="No runs yet"
            description="Reconciliation runs will appear here once one has been started." />}
        />
      </SectionCard>

      {/* ── Everything that landed ── */}
      <SectionCard
        title="Activity" padding={false} style={{ marginBottom: SP[4] }}
        subtitle="Reconciliations, uploaded settlement reports and provider syncs, newest first"
        actions={
          <SegmentedToggle<LogFilter>
            value={logFilter} onChange={setLogFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'reconciliation', label: 'Runs' },
              { value: 'interswitch_import', label: 'Imports' },
              { value: 'paystack_sync', label: 'Syncs' },
            ]}
          />
        }
      >
        <DataTable
          cols={logCols} rows={logRows}
          keyFn={(a, i) => `${a.activity}-${a.id ?? i}-${a.started_at}`}
          loading={loading && !activity} skeletonRows={6} pageSize={15}
          emptyText={<EmptyState icon="history" title="Nothing recorded"
            description="No activity of this kind has been logged." />}
        />
      </SectionCard>

      {/* ── Paystack sync ── */}
      <SectionCard
        title="Paystack Sync"
        subtitle="Paystack is pulled from its API rather than uploaded, so its freshness is this module's responsibility"
        actions={
          <Button size="sm" variant="secondary" icon="sync" loading={syncing}
            disabled={!sync?.configured} onClick={triggerSync}>Sync Now</Button>
        }
      >
        {sync && !sync.configured ? (
          <EmptyState icon="key_off" title="Paystack is not configured"
            description="No API credentials are set, so nothing can be pulled." />
        ) : (
          <div style={{ display: 'flex', gap: SP[6], flexWrap: 'wrap' }}>
            {([
              ['Transactions', sync?.snapshot?.transactions],
              ['Transfers',    sync?.snapshot?.transfers],
              ['Settlements',  sync?.snapshot?.settlements],
              ['Disputes',     sync?.snapshot?.disputes],
            ] as const).map(([label, v]) => (
              <div key={label}>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 2 }}>{label}</div>
                <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                  {fmtNum(v)}
                </div>
              </div>
            ))}
            <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 2 }}>Last sync</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], justifyContent: 'flex-end' }}>
                {sync?.last_run?.status && <StatusBadge status={sync.last_run.status} size="sm" />}
                <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>
                  {sync?.last_run?.finished_at ? fmtDatetime(sync.last_run.finished_at) : 'never'}
                </span>
              </div>
              {sync?.last_run?.error && (
                <div style={{ fontSize: TEXT.xs, color: RED, marginTop: 3 }}>{sync.last_run.error}</div>
              )}
            </div>
          </div>
        )}
      </SectionCard>

      {/* ── Run modal ── */}
      <Modal open={runOpen} onClose={() => setRunOpen(false)} title="Run Reconciliation" width={520}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRunOpen(false)} disabled={running}>Cancel</Button>
            <Button icon="play_arrow" onClick={() => startRun(false)} loading={running}>Run</Button>
          </>
        }>
        <Field label="Pair" hint={activePair?.hint}>
          <Select value={pair} onChange={e => setPair(e.target.value)}>
            {PAIRS.map(p => (
              <option key={p.value} value={p.value}>{p.label} → {p.cpLabel}</option>
            ))}
          </Select>
        </Field>
        <Field label="Period">
          <DateFilter from={periodFrom} to={periodTo}
            onChange={(f, t) => { setPeriodFrom(f); setPeriodTo(t) }} />
        </Field>
        <p style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: SP[3], lineHeight: 'var(--lh-relaxed)' }}>
          Matching is strictly one-to-one. Where a row has several possible ledger
          entries it is raised as an exception rather than paired on a guess — a
          plausible wrong pairing understates the queue and can never be found again.
        </p>
      </Modal>

      {/* ── Sign-off modal ── */}
      <Modal open={signOpen} onClose={() => setSignOpen(false)} title="Sign Off This Reconciliation" width={520}
        footer={
          <>
            <Button variant="secondary" onClick={() => setSignOpen(false)} disabled={signing}>Cancel</Button>
            <Button icon="task_alt" onClick={signOff} loading={signing}>Sign Off</Button>
          </>
        }>
        <p style={{ fontSize: TEXT.base, color: 'var(--txt2)', marginBottom: SP[3], lineHeight: 'var(--lh-relaxed)' }}>
          You are recording that you have reviewed this position.
          {' '}<strong style={{ color: 'var(--txt)' }}>{fmtNum(Math.max(breakN, 0))}</strong> break(s)
          worth <strong style={{ color: 'var(--txt)' }}>{fmtKobo(run?.unmatched_value_kobo)}</strong> remain outstanding
          {gapN > 0 && <>, and a further <strong style={{ color: 'var(--txt)' }}>{fmtNum(gapN)}</strong> item(s)
            are waiting on a counterparty feed rather than on anyone here</>}.
        </p>
        <Field label="Note (Optional)">
          <Textarea value={signNote} onChange={e => setSignNote(e.target.value)} rows={3}
            placeholder="Anything a reviewer should know about accepting this position" />
        </Field>
      </Modal>
    </Page>
  )
}
