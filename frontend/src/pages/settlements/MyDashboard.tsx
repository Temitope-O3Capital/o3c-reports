import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, DataTable, ErrBanner, EmptyState, StatusBadge, Badge,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, fmtDatetime } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, NUM, TEXT, FW, SP } from '../../lib/design'
import {
  WorkspaceHero, MyDaySection, MyDayTile, HeroButton,
} from '../../components/MyWorkspace'
import { humanLabel } from '../../lib/labels'

/*
  MY WORK — a settlement officer's own queue.

  WHAT WAS REMOVED, and why. This page used to carry five tiles that could never
  show anything: failed transactions from app.settlement_exceptions, pending and
  my-pending postings from app.manual_postings, and today's net/pending position
  from app.settlement_batches. All three tables are empty, and settlement_exceptions
  has NO WRITER anywhere in the codebase — nothing can ever put a row in it. A tile
  structurally guaranteed to read zero is worse than an absent one: a zero reads as
  "nothing outstanding today", and it sat beside real figures looking identical.
  Those reads are gone from the handler too.

  What replaced them is true, and it says something uncomfortable: every actionable
  break in the queue is currently unassigned. So the page leads with that rather
  than showing an officer an empty personal queue and implying there is no work.
*/

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExceptionRow {
  id: number
  run_id: number
  source: string
  source_ref: string
  reason: string
  detail: string
  amount_kobo: number
  txn_date: string
  status: string
  created_at: string
  age_days: number
}

interface RunRow {
  id: number
  kind: string
  source: string
  counterparty: string
  status: string
  unmatched_n: number
  matched_n: number
  source_n: number
  started_at: string
  signed_off_at: string | null
  match_rate_pct: number
}

interface LastRun {
  status?: string
  kind?: string
  source?: string
  counterparty?: string
  unmatched_n?: number
  matched_n?: number
  finished_at?: string | null
  started_at?: string
  period_from?: string
  period_to?: string
  signed_off_at?: string | null
}

interface SettlementDash {
  my_exceptions?: number
  my_exceptions_value_kobo?: number
  my_exceptions_aging?: number
  team_exceptions_open?: number
  team_actionable?: number
  team_feed_gap?: number
  team_actionable_value_kobo?: number
  team_aged_30d?: number
  team_unassigned?: number
  last_run?: LastRun
  my_exception_list?: ExceptionRow[]
  recent_runs?: RunRow[]
}

// ── Chrome ────────────────────────────────────────────────────────────────────

const REASON_LABEL: Record<string, string> = {
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

/* Reason as a chip: colour plus the word, never colour alone. */
function ReasonChip({ reason }: { reason: string }) {
  const tone = REASON_COLOR[reason] ?? 'var(--txt3)'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
      background: `${tone}14`, color: tone, fontSize: TEXT.xs, fontWeight: FW.semibold,
    }}>
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: tone }} />
      {REASON_LABEL[reason] ?? humanLabel(reason)}
    </span>
  )
}

function AgePill({ days }: { days: number }) {
  const d = Number(days ?? 0)
  const tone = d >= 90 ? RED : d >= 30 ? AMBER : d >= 7 ? BLUE : GREEN
  const word = d >= 90 ? 'critical' : d >= 30 ? 'overdue' : d >= 7 ? 'ageing' : 'fresh'
  return (
    <span title={`${d} days old — ${word}`} style={{ ...NUM, color: tone, fontWeight: FW.semibold, fontSize: TEXT.sm }}>
      {d}d
    </span>
  )
}

/* Pairs are named for what they actually compare. 'interswitch → sage_ledger' is
   the deprecated label the first pair shipped under: the engine staged its source
   from a view over ccs_transactions, so it never touched Interswitch at all. */
function pairLabel(source: string, counterparty: string): string {
  if (source === 'ccs' && counterparty === 'card_ledger') return 'CCS Master → Card Account Book'
  if (source === 'interswitch' && counterparty === 'ccs') return 'Interswitch Settlement → CCS Master'
  if (source === 'interswitch' && counterparty === 'sage_ledger') return 'CCS Master → Card Account Book (legacy label)'
  return `${source} → ${counterparty}`
}

function rateColor(p: number) {
  return p >= 95 ? GREEN : p >= 80 ? AMBER : RED
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettlementMyDashboard() {
  const navigate = useNavigate()
  const [d, setD] = useState<SettlementDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      setD(await apiFetch<SettlementDash>('/api/settlements/my-dashboard'))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load your work')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: [] })

  const mine       = Number(d?.my_exceptions ?? 0)
  const mineAging  = Number(d?.my_exceptions_aging ?? 0)
  const teamAction = Number(d?.team_actionable ?? 0)
  const unassigned = Number(d?.team_unassigned ?? 0)
  const aged30     = Number(d?.team_aged_30d ?? 0)
  const feedGap    = Number(d?.team_feed_gap ?? 0)
  const lastRun    = d?.last_run ?? null

  const lastRate = lastRun && Number(lastRun.matched_n ?? 0) + Number(lastRun.unmatched_n ?? 0) > 0
    ? (Number(lastRun.matched_n) / (Number(lastRun.matched_n) + Number(lastRun.unmatched_n))) * 100
    : 0

  /*
    One sentence on what to do next, decided in priority order: my overdue work,
    then my work, then claiming unowned work, then running a reconciliation.
    Without this the page is a wall of counts and every reader has to derive the
    same conclusion by hand — and they will not all derive the same one.
  */
  const subline = (() => {
    if (!d) return 'Loading your queue…'
    if (mine > 0) {
      return mineAging > 0
        ? `${fmtNum(mineAging)} of your ${fmtNum(mine)} items are more than three days old — start at the top.`
        : `${fmtNum(mine)} item${mine === 1 ? '' : 's'} assigned to you, worth ${fmtKobo(d.my_exceptions_value_kobo)}.`
    }
    if (unassigned > 0) {
      return `Nothing is assigned to you, but ${fmtNum(unassigned)} break${unassigned === 1 ? ' is' : 's are'} unclaimed`
        + (aged30 > 0 ? ` — ${fmtNum(aged30)} open more than 30 days.` : '.')
    }
    if (teamAction === 0) return 'No actionable break is outstanding anywhere in the module.'
    return `${fmtNum(teamAction)} break(s) are being worked by the rest of the team.`
  })()

  // ── Columns ─────────────────────────────────────────────────────────────────

  const excCols: TableCol<ExceptionRow>[] = [
    { key: 'source_ref', label: 'Reference', width: 150, render: e => (
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.sm }}>{e.source_ref || '—'}</span>
    ) },
    { key: 'txn_date', label: 'Txn Date', width: 110, sortable: true,
      render: e => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtDate(e.txn_date)}</span> },
    { key: 'amount_kobo', label: 'Amount', align: 'right', width: 130, sortable: true,
      render: e => <span style={{ ...NUM, fontWeight: FW.medium }}>{fmtKobo(e.amount_kobo)}</span> },
    { key: 'reason', label: 'Reason', width: 175, render: e => <ReasonChip reason={e.reason} /> },
    { key: 'detail', label: 'What the matcher found', render: e => (
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{e.detail || '—'}</span>
    ) },
    { key: 'age_days', label: 'Age', align: 'right', width: 70, sortable: true,
      render: e => <AgePill days={e.age_days} /> },
  ]

  const runCols: TableCol<RunRow>[] = [
    { key: 'id', label: 'Run', width: 70,
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>#{r.id}</span> },
    { key: 'pair', label: 'Pair', render: r => (
      <span style={{ fontSize: TEXT.sm }}>{pairLabel(r.source, r.counterparty)}</span>
    ) },
    { key: 'match_rate_pct', label: 'Matched', align: 'right', width: 100, render: r => {
      const p = Number(r.match_rate_pct ?? 0)
      return <span style={{ ...NUM, fontWeight: FW.semibold, color: rateColor(p) }}>{p.toFixed(1)}%</span>
    } },
    { key: 'unmatched_n', label: 'Unmatched', align: 'right', width: 100,
      render: r => <span style={NUM}>{fmtNum(r.unmatched_n)}</span> },
    { key: 'started_at', label: 'Started', width: 155,
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtDatetime(r.started_at)}</span> },
    { key: 'status', label: 'Status', width: 130, render: r => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: SP[2] }}>
        <StatusBadge status={r.status} size="sm" />
        {r.signed_off_at && (
          <span className="material-symbols-rounded" title="Signed off" aria-label="Signed off"
            style={{ fontSize: 15, color: GREEN }}>task_alt</span>
        )}
      </span>
    ) },
  ]

  return (
    <Page title="My Work" subtitle="Your settlement queue, and where the module stands right now"
      loading={loading && !d} skeletonKpis={4}>
      <ErrBanner error={error} onRetry={load} />

      <WorkspaceHero
        subline={subline}
        ring={{ value: mine > 0 ? Math.max(mine - mineAging, 0) : 0, max: Math.max(mine, 1), unit: 'on time' }}
        stats={[
          { label: 'Assigned to me', value: fmtNum(mine) },
          { label: 'My value at risk', value: mine > 0 ? fmtKobo(d?.my_exceptions_value_kobo) : '—' },
          { label: 'Unclaimed', value: fmtNum(unassigned), color: unassigned > 0 ? '#FCD34D' : undefined },
          { label: 'Last run matched', value: lastRun ? `${lastRate.toFixed(1)}%` : '—' },
        ]}
        actions={
          <>
            <HeroButton icon="rule" label="Exceptions" primary
              onClick={() => navigate('/settlements/exceptions')} />
            <HeroButton icon="play_arrow" label="Reconcile"
              onClick={() => navigate('/settlements/workbench')} />
            <HeroButton icon="insights" label="Overview"
              onClick={() => navigate('/settlements')} />
          </>
        }
      />

      <MyDaySection title="My Day" hint="what needs your attention now">
        <MyDayTile icon="assignment_ind" count={fmtNum(mine)} label="Assigned to Me"
          sub={mine > 0 ? fmtKobo(d?.my_exceptions_value_kobo) : 'nothing claimed yet'}
          color={mine > 0 ? BLUE : NAVY} urgent={mineAging > 0}
          onClick={() => navigate('/settlements/exceptions')} />
        <MyDayTile icon="priority_high" count={fmtNum(mineAging)} label="Mine, Over 3 Days"
          sub="work these first" color={RED} urgent={mineAging > 0}
          onClick={() => navigate('/settlements/exceptions')} />
        <MyDayTile icon="inbox" count={fmtNum(unassigned)} label="Unclaimed Breaks"
          sub={fmtKobo(d?.team_actionable_value_kobo)} color={AMBER} urgent={unassigned > 0}
          onClick={() => navigate('/settlements/exceptions')} />
        <MyDayTile icon="schedule" count={fmtNum(aged30)} label="Team, Over 30 Days"
          sub="escalate these" color={aged30 > 0 ? RED : GREEN} urgent={aged30 > 0}
          onClick={() => navigate('/settlements/exceptions')} />
        <MyDayTile icon="cloud_off" count={fmtNum(feedGap)} label="Counterparty Feed Gaps"
          sub="not the desk's to close" color="#5B7A94"
          onClick={() => navigate('/settlements/exceptions')} />
        <MyDayTile icon={lastRun?.signed_off_at ? 'task_alt' : 'pending'}
          count={lastRun?.started_at ? fmtDate(lastRun.started_at) : '—'}
          label="Last Reconciliation"
          sub={lastRun
            ? (lastRun.signed_off_at ? 'signed off' : 'not signed off')
            : 'never run'}
          color={lastRun?.signed_off_at ? GREEN : AMBER} urgent={!!lastRun && !lastRun.signed_off_at}
          onClick={() => navigate('/settlements/workbench')} />
      </MyDaySection>

      <SectionCard title="My Queue" padding={false} style={{ marginBottom: SP[4] }}
        subtitle="Oldest first — the order it should be worked in"
        actions={feedGap > 0
          ? <Badge variant="default">{fmtNum(feedGap)} feed gaps excluded</Badge>
          : undefined}>
        <DataTable
          cols={excCols} rows={d?.my_exception_list ?? []} keyFn={e => e.id}
          onRowClick={e => navigate(`/settlements/exceptions?run_id=${e.run_id}`)}
          loading={loading && !d} skeletonRows={5}
          emptyText={
            <EmptyState icon="assignment_turned_in" title="Nothing assigned to you"
              description={unassigned > 0
                ? `${fmtNum(unassigned)} break(s) in the team queue have no owner. Claim some to get started.`
                : 'Your queue is clear.'}
              action={unassigned > 0
                ? { label: 'Pick Up Work', icon: 'inbox', onClick: () => navigate('/settlements/exceptions') }
                : undefined} />
          }
        />
      </SectionCard>

      <SectionCard title="Recent Reconciliations" padding={false}
        subtitle="Open one on Reconcile to inspect its tiers and sign it off">
        <DataTable
          cols={runCols} rows={d?.recent_runs ?? []} keyFn={r => r.id}
          onRowClick={() => navigate('/settlements/workbench')}
          loading={loading && !d} skeletonRows={4}
          emptyText={
            <EmptyState icon="history" title="No reconciliation has been run"
              description="The position is produced by a run. Nothing has been matched yet."
              action={{ label: 'Run Reconciliation', icon: 'play_arrow',
                onClick: () => navigate('/settlements/workbench') }} />
          }
        />
      </SectionCard>
    </Page>
  )
}
