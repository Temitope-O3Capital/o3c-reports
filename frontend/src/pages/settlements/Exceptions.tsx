import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, KpiCard, SectionCard, ErrBanner, Button, Modal, Field, Select, Textarea,
  EmptyState, StatusBadge, Badge, Tabs, DataTable, SegmentedToggle, Input,
} from '../../components/UI'
import type { TableCol, FilterDef } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { toast } from 'sonner'
import { fmtKobo, fmtNum, fmtDate, fmtDatetime } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, BLUE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { humanLabel } from '../../lib/labels'

/*
  EXCEPTIONS — the queue.

  The design problem this page had was not cosmetic. It opened on every open item,
  and most of them could not be closed by anyone who would ever read it: the
  reconciler classified a day the counterparty ledger simply does not cover
  identically to a genuine settlement break, so 10,527 items accumulated, the
  queue became unworkable, and triage stopped altogether.

  So the queue now opens on WORK — items a person can actually resolve — with the
  feed gaps one click away and clearly owned by whoever owns the feed. The split is
  enforced at the API (scope=actionable) rather than by filtering a page of rows,
  because filtering client-side silently drops items past the fetch limit.
*/

// ── Types ─────────────────────────────────────────────────────────────────────

interface ReconException {
  id: number
  run_id: number
  source: string
  source_key: string
  source_ref: string
  txn_date: string
  amount_kobo: number
  reason: string
  candidate_n: number
  detail: string
  status: string
  assigned_to: number | null
  assigned_to_name: string
  resolution_code: string
  resolution_note: string
  resolved_by_name: string
  resolved_at: string | null
  created_at: string
  age_days: number
}

interface ExceptionSummary {
  open_n: number
  open_value_kobo: number
  resolved_n: number
  written_off_n: number
  aged_7d_n: number
  aged_30d_n: number
  ambiguous_n: number
  amount_mismatch_n: number
  no_candidate_n: number
  // Open items a person can act on — everything except the feed gaps. open_n still
  // counts every open row, so the two are reported side by side rather than one
  // silently standing in for the other.
  master_no_data_n: number
  actionable_n: number
  actionable_value_kobo: number
}

interface Failure {
  kind: string
  ref_id: string
  reference: string
  status: string
  amount_kobo: number
  occurred_at: string
  counterparty: string
  account: string
  bank: string
  detail: string
  session_id: string
}

interface FailureSummary {
  failed_transfers: number
  failed_transfers_kobo: number
  reversed_transfers: number
  failed_fundings: number
  failed_fundings_kobo: number
  reversed_fundings: number
  open_disputes: number
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Resolution codes are fixed, not free text — a queue resolved with prose can never
// answer "why do things go unmatched", which is the whole reason to keep the queue.
const RESOLUTION_CODES: { value: string; label: string; hint: string }[] = [
  { value: 'matched_manually',  label: 'Matched Manually',   hint: 'Found the ledger entry by hand' },
  { value: 'timing_difference', label: 'Timing Difference',  hint: 'Will match in a later period' },
  { value: 'fee_or_commission', label: 'Fee or Commission',  hint: 'Difference is a charge, not missing money' },
  { value: 'duplicate_in_feed', label: 'Duplicate in Feed',  hint: 'Source sent it twice' },
  { value: 'processor_error',   label: 'Processor Error',    hint: 'Wrong on the processor side' },
  { value: 'ledger_error',      label: 'Ledger Error',       hint: 'Wrong on our side: needs a posting' },
  { value: 'written_off',       label: 'Write Off',          hint: 'Accepted as a loss; closes the item' },
]

const REASON_LABEL: Record<string, string> = {
  // A day the counterparty ledger does not cover at all. Nothing was ever there to
  // pair against, so no amount of investigation closes it — it is a feed to chase.
  master_no_data:  'Counterparty Feed Gap',
  no_candidate:    'No Ledger Match',
  ambiguous:       'Ambiguous',
  amount_mismatch: 'Amount Differs',
}

const REASON_COLOR: Record<string, string> = {
  // Grey, not red: this one is not the desk's to answer for.
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
      background: `${tone}14`, color: tone,
      fontSize: TEXT.xs, fontWeight: FW.semibold,
    }}>
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: tone }} />
      {REASON_LABEL[reason] ?? humanLabel(reason)}
    </span>
  )
}

/*
  Age, coloured by how long it has sat. Aging is the whole point of an exception
  queue: an unmatched item nobody has touched for 30 days is a different problem to
  a fresh one, and it is the only signal that tells a supervisor the queue is
  being worked rather than just being long.
*/
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

type Scope = 'actionable' | 'feed_gap' | 'all'
type StatusScope = 'open' | 'resolved' | 'all'

const STATUS_PARAM: Record<StatusScope, string> = {
  open: 'open,investigating',
  resolved: 'resolved,written_off',
  all: '',
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettlementExceptions() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'recon' | 'failures'>('recon')

  const [rows, setRows]               = useState<ReconException[]>([])
  const [summary, setSummary]         = useState<ExceptionSummary | null>(null)
  const [failures, setFailures]       = useState<Failure[]>([])
  const [failSummary, setFailSummary] = useState<FailureSummary | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  // Opens on work, not on everything. See the note at the top of the file.
  const [scope, setScope]             = useState<Scope>('actionable')
  const [statusScope, setStatusScope] = useState<StatusScope>('open')

  const [selected, setSelected]     = useState<Set<string | number>>(new Set())
  const [resolveOpen, setResolveOpen] = useState(false)
  const [resolveCode, setResolveCode] = useState('matched_manually')
  const [resolveNote, setResolveNote] = useState('')
  const [resolving, setResolving]     = useState(false)

  // Raising a correcting entry from a break — see the _actions column.
  const [postingFor, setPostingFor]         = useState<ReconException | null>(null)
  const [postingType, setPostingType]       = useState<'Debit' | 'Credit'>('Debit')
  const [postingAccount, setPostingAccount] = useState('')
  const [postingNote, setPostingNote]       = useState('')
  const [postingSaving, setPostingSaving]   = useState(false)
  const [postingDone, setPostingDone]       = useState<string | null>(null)

  // Deep links: ?run_id=N from Reconcile, ?assigned_to=N from the Supervisor view.
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const runId = useMemo(() => params.get('run_id') ?? '', [params])
  const assignedTo = useMemo(() => params.get('assigned_to') ?? '', [params])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (tab === 'recon') {
        const p = new URLSearchParams()
        if (runId) p.set('run_id', runId)
        if (assignedTo) p.set('assigned_to', assignedTo)
        if (scope !== 'all') p.set('scope', scope)
        const st = STATUS_PARAM[statusScope]
        if (st) p.set('status', st)
        else p.set('status', 'open,investigating,resolved,written_off')
        p.set('limit', '500')
        const [list, sum] = await Promise.all([
          apiFetch<{ data: ReconException[] }>(`/api/recon/exceptions?${p.toString()}`),
          apiFetch<ExceptionSummary>('/api/recon/exceptions/summary'),
        ])
        setRows(list.data ?? [])
        setSummary(sum)
      } else {
        const res = await apiFetch<{ data: Failure[]; summary: FailureSummary }>(
          '/api/paystack/failures?limit=500')
        setFailures(res.data ?? [])
        setFailSummary(res.summary)
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load the exception queue')
    } finally {
      setLoading(false)
    }
  }, [tab, scope, statusScope, runId, assignedTo])

  useEffect(() => { load() }, [load])
  // A selection made under one filter must not survive into another — the ids would
  // no longer be on screen, and a bulk resolve would hit rows the user cannot see.
  useEffect(() => { setSelected(new Set()) }, [scope, statusScope, tab])

  /*
    Raise the correcting entry for one break.

    The amount and the cause come from the exception, not from retyping: the entry
    carries recon_exception_id, so the posting says which break it answers and the
    break can show the posting that corrects it. It lands as 'pending' and needs a
    different person to approve it — the approve endpoint refuses the initiator.
  */
  const raisePosting = async () => {
    if (!postingFor || !postingAccount.trim()) return
    setPostingSaving(true)
    setError(null)
    try {
      const res = await apiPost<{ ref?: string }>('/api/settlements/manual-postings', {
        type: postingType,
        amount_kobo: Math.abs(Number(postingFor.amount_kobo)),
        account: postingAccount.trim(),
        description: postingNote.trim()
          || `Correcting entry for break ${postingFor.source_ref || postingFor.source_key}`
             + ` (${REASON_LABEL[postingFor.reason] ?? postingFor.reason},`
             + ` ${fmtDate(postingFor.txn_date)})`,
        recon_exception_id: postingFor.id,
      })
      setPostingDone(`${res.ref ?? 'Entry'} raised for ${postingFor.source_ref || `#${postingFor.id}`}`
        + ' — it needs a second person to approve it.')
      // No success toast: postingDone above renders a role="status" panel carrying the
      // entry reference and an "Open Postings" action — strictly more than a toast.
      setPostingFor(null)
      setPostingNote('')
      await load()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not raise the correcting entry')
    } finally {
      setPostingSaving(false)
    }
  }

  const resolveSelected = async () => {
    setResolving(true)
    try {
      await apiPost('/api/recon/exceptions/bulk-resolve', {
        ids: [...selected],
        resolution_code: resolveCode,
        note: resolveNote,
      })
      toast.success(`${selected.size} exception${selected.size === 1 ? '' : 's'} resolved`)
      setResolveOpen(false)
      setSelected(new Set())
      setResolveNote('')
      await load()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Resolve failed')
    } finally {
      setResolving(false)
    }
  }

  // ── Columns ─────────────────────────────────────────────────────────────────
  const excCols: TableCol<ReconException>[] = [
    { key: 'source_ref', label: 'Reference', sortable: true, width: 150,
      render: e => (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.sm }}>
          {e.source_ref || '—'}
        </span>
      ) },
    { key: 'txn_date', label: 'Txn Date', sortable: true, width: 110,
      render: e => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtDate(e.txn_date)}</span> },
    { key: 'amount_kobo', label: 'Amount', align: 'right', sortable: true, width: 130,
      render: e => <span style={{ ...NUM, fontWeight: FW.medium }}>{fmtKobo(e.amount_kobo)}</span> },
    { key: 'reason', label: 'Reason', sortable: true, width: 180,
      render: e => <ReasonChip reason={e.reason} /> },
    { key: 'candidate_n', label: 'Cands', align: 'right', sortable: true, width: 75,
      render: e => Number(e.candidate_n) > 0
        ? <span style={NUM}>{fmtNum(e.candidate_n)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span> },
    { key: 'detail', label: 'What the matcher found', render: e => (
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{e.detail || '—'}</span>
    ) },
    { key: 'age_days', label: 'Age', align: 'right', sortable: true, width: 70,
      render: e => <AgePill days={e.age_days} /> },
    { key: 'status', label: 'Status', width: 120, render: e => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: SP[2] }}>
        <StatusBadge status={e.status} size="sm" />
        {e.assigned_to_name && (
          <span title={`Assigned to ${e.assigned_to_name}`} style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
            {e.assigned_to_name.split(' ')[0]}
          </span>
        )}
      </span>
    ) },
    { key: 'run_id', label: 'Run', align: 'right', width: 70, render: e => (
      <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt3)' }}>#{e.run_id}</span>
    ) },
    {
      // THE LOOP THAT WAS OPEN. A break on our side needs a correcting entry, and
      // app.manual_postings is exactly the workflow for one — initiate, approve,
      // post, with maker-checker. There was no path from here to there, so raising
      // one meant retyping the amount and a narrative on another screen with no
      // record of which break it answered, and the postings table has never held a
      // single row. Now the entry carries recon_exception_id and this queue can
      // show what is being done about an item.
      //
      // Not offered on a feed gap: there is no entry to make when the counterparty
      // simply has not sent the day.
      key: '_actions', label: '', width: 120, sortable: false,
      render: e => e.reason === 'master_no_data'
        ? null
        : (
          <Button size="sm" variant="secondary" icon="post_add"
            onClick={() => { setPostingFor(e); setPostingAccount(''); setPostingType('Debit') }}>
            Entry
          </Button>
        ),
    },
  ]

  const excFilters: FilterDef<ReconException>[] = [
    { key: 'reason', label: 'Reason',
      getLabel: v => REASON_LABEL[v] ?? humanLabel(v),
      chipStyle: v => {
        const t = REASON_COLOR[v] ?? '#64748B'
        return { bg: `${t}14`, txt: t }
      } },
    { key: 'source', label: 'Source', getLabel: v => humanLabel(v) },
    { key: 'status', label: 'Status' },
  ]

  const failCols: TableCol<Failure>[] = [
    { key: 'kind', label: 'Kind', sortable: true, width: 120,
      render: f => <Badge variant="default">{humanLabel(f.kind)}</Badge> },
    { key: 'reference', label: 'Reference', sortable: true, width: 170,
      render: f => (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.sm }}>{f.reference || '—'}</span>
      ) },
    { key: 'amount_kobo', label: 'Amount', align: 'right', sortable: true, width: 130,
      render: f => <span style={{ ...NUM, fontWeight: FW.medium }}>{fmtKobo(f.amount_kobo)}</span> },
    { key: 'counterparty', label: 'Counterparty', render: f => (
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{f.counterparty || '—'}</div>
        {(f.bank || f.account) && (
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
            {[f.bank, f.account].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
    ) },
    { key: 'detail', label: 'Reason Given', render: f => (
      <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{f.detail || '—'}</span>
    ) },
    { key: 'occurred_at', label: 'When', sortable: true, width: 150,
      render: f => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtDatetime(f.occurred_at)}</span> },
    { key: 'status', label: 'Status', width: 110,
      render: f => <StatusBadge status={f.status} size="sm" /> },
  ]

  const failFilters: FilterDef<Failure>[] = [
    { key: 'kind', label: 'Kind', getLabel: v => humanLabel(v) },
    { key: 'status', label: 'Status' },
  ]

  const gapN = Number(summary?.master_no_data_n ?? 0)

  return (
    <Page
      title="Exceptions"
      subtitle="Everything that did not tie out, oldest first — age is the signal that matters"
      loading={loading && !rows.length && !failures.length}
      skeletonKpis={4}
      actions={
        <Button variant="secondary" size="sm" icon="play_arrow"
          onClick={() => navigate('/settlements/workbench')}>Reconcile</Button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {postingDone && (
        <div role="status" style={{
          display: 'flex', alignItems: 'center', gap: SP[3],
          padding: SP[4], marginBottom: SP[4], borderRadius: RADIUS.lg,
          background: 'var(--card)', border: '1px solid var(--card-bdr)',
          borderLeft: `4px solid ${GREEN}`,
        }}>
          <span className="material-symbols-rounded" aria-hidden="true"
            style={{ fontSize: 20, color: GREEN }}>post_add</span>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{postingDone}</div>
          <Button size="sm" variant="secondary" style={{ marginLeft: 'auto' }}
            onClick={() => navigate('/settlements/manual-postings')}>Open Postings</Button>
          <Button size="sm" variant="secondary" onClick={() => setPostingDone(null)}>Dismiss</Button>
        </div>
      )}

      <Tabs
        tabs={[
          { key: 'recon',    label: 'Reconciliation Breaks' },
          { key: 'failures', label: 'Payment Failures' },
        ]}
        active={tab}
        onChange={k => setTab(k as 'recon' | 'failures')}
      />

      {tab === 'recon' ? (
        <>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
            gap: SP[3], margin: `${SP[4]} 0 ${SP[5]}`,
          }}>
            {/* The headline is what the desk can actually work. 'Open Exceptions' led
                with every open row, feed gaps included, so the queue read as ten
                thousand unexplained breaks worth most of a billion naira — and
                because none of it could be closed, none of it was triaged. */}
            <KpiCard label="Breaks to Work" value={fmtNum(summary?.actionable_n)}
              sub={fmtKobo(summary?.actionable_value_kobo)} icon="rule"
              accent={Number(summary?.actionable_n ?? 0) > 0 ? RED : GREEN} loading={loading && !summary} />
            <KpiCard label="Counterparty Feed Gap" value={fmtNum(gapN)}
              sub="No ledger data for those days" icon="cloud_off" accent={NAVY} loading={loading && !summary} />
            <KpiCard label="Aged Over 30 Days" value={fmtNum(summary?.aged_30d_n)}
              sub="Escalate these" icon="schedule" accent={AMBER} loading={loading && !summary} />
            <KpiCard label="Resolved" value={fmtNum(summary?.resolved_n)}
              sub={`${fmtNum(summary?.written_off_n)} written off`} icon="check_circle"
              accent={GREEN} loading={loading && !summary} />
          </div>

          {/* Standing explanation of the split, shown while the feed gaps are in
              view so nobody tries to work an item that cannot be closed. */}
          {scope === 'feed_gap' && (
            <div role="note" style={{
              display: 'flex', alignItems: 'flex-start', gap: SP[3],
              padding: SP[4], marginBottom: SP[4], borderRadius: RADIUS.lg,
              background: 'var(--card)', border: '1px solid var(--card-bdr)',
              borderLeft: '4px solid #5B7A94',
            }}>
              <span className="material-symbols-rounded" aria-hidden="true"
                style={{ fontSize: 20, color: '#5B7A94', flexShrink: 0 }}>cloud_off</span>
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 'var(--lh-relaxed)' }}>
                <strong style={{ color: 'var(--txt)' }}>These are not settlement breaks.</strong>{' '}
                Each one falls on a date the counterparty ledger holds no rows for at all, so there was
                never anything to pair against. They close when the missing feed arrives and the period
                is reconciled again — not by investigation here.
              </div>
            </div>
          )}

          <SectionCard
            title={runId ? `Breaks from Run #${runId}` : 'Queue'}
            padding={false}
            actions={
              <div style={{ display: 'flex', gap: SP[2], flexWrap: 'wrap' }}>
                <SegmentedToggle<Scope>
                  value={scope} onChange={setScope}
                  options={[
                    { value: 'actionable', label: 'To Work' },
                    { value: 'feed_gap',   label: `Feed Gaps${gapN ? ` (${fmtNum(gapN)})` : ''}` },
                    { value: 'all',        label: 'All' },
                  ]}
                />
                <SegmentedToggle<StatusScope>
                  value={statusScope} onChange={setStatusScope}
                  options={[
                    { value: 'open',     label: 'Open' },
                    { value: 'resolved', label: 'Closed' },
                    { value: 'all',      label: 'Any' },
                  ]}
                />
              </div>
            }
          >
            <DataTable
              cols={excCols} rows={rows} keyFn={e => e.id}
              selectable selectedIds={selected} onSelect={setSelected}
              filters={excFilters}
              searchKeys={['source_ref', 'detail', 'source_key']}
              searchPlaceholder="Search reference or detail…"
              pageSize={25}
              loading={loading && !rows.length} skeletonRows={8}
              bulkBar={
                <Button size="sm" icon="done_all" onClick={() => setResolveOpen(true)}>
                  Resolve {selected.size} Selected
                </Button>
              }
              emptyText={
                <EmptyState
                  icon={scope === 'actionable' ? 'task_alt' : 'inbox'}
                  title={scope === 'actionable'
                    ? 'Nothing to work'
                    : statusScope === 'resolved' ? 'Nothing closed yet' : 'No items here'}
                  description={scope === 'actionable'
                    ? 'Every open break has been resolved. Feed gaps, if any, are under the next tab.'
                    : 'No exceptions match this filter.'}
                />
              }
            />
          </SectionCard>
        </>
      ) : (
        <>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
            gap: SP[3], margin: `${SP[4]} 0 ${SP[5]}`,
          }}>
            <KpiCard label="Failed Transfers" value={fmtNum(failSummary?.failed_transfers)}
              sub={fmtKobo(failSummary?.failed_transfers_kobo)} icon="call_missed_outgoing"
              accent={RED} loading={loading && !failSummary} />
            <KpiCard label="Failed Fundings" value={fmtNum(failSummary?.failed_fundings)}
              sub={fmtKobo(failSummary?.failed_fundings_kobo)} icon="call_missed"
              accent={AMBER} loading={loading && !failSummary} />
            <KpiCard label="Reversed" value={fmtNum(Number(failSummary?.reversed_transfers ?? 0) + Number(failSummary?.reversed_fundings ?? 0))}
              sub="Money returned" icon="undo" accent={BLUE} loading={loading && !failSummary} />
            <KpiCard label="Open Disputes" value={fmtNum(failSummary?.open_disputes)}
              sub="Awaiting resolution" icon="gavel"
              accent={Number(failSummary?.open_disputes ?? 0) > 0 ? RED : GREEN} loading={loading && !failSummary} />
          </div>

          <SectionCard title="Payment Failures" padding={false}
            subtitle="Attempts Paystack rejected or reversed — money that never moved, as distinct from money that moved and did not tie out">
            <DataTable
              cols={failCols} rows={failures}
              keyFn={(f, i) => `${f.kind}-${f.ref_id || f.reference || i}`}
              filters={failFilters}
              searchKeys={['reference', 'counterparty', 'detail', 'account']}
              searchPlaceholder="Search reference or counterparty…"
              pageSize={25}
              loading={loading && !failures.length} skeletonRows={8}
              emptyText={<EmptyState icon="task_alt" title="No failures"
                description="Every Paystack attempt in range succeeded." />}
            />
          </SectionCard>
        </>
      )}

      {/* ── Raise a correcting entry from a break ── */}
      <Modal open={postingFor !== null} onClose={() => setPostingFor(null)}
        title={postingFor
          ? `Correcting Entry for ${postingFor.source_ref || `#${postingFor.id}`}`
          : 'Correcting Entry'}
        width={540}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPostingFor(null)} disabled={postingSaving}>
              Cancel
            </Button>
            <Button icon="post_add" onClick={raisePosting} loading={postingSaving}
              disabled={!postingAccount.trim()}>Raise Entry</Button>
          </>
        }>
        {postingFor && (
          <>
            <div style={{
              display: 'flex', gap: SP[5], flexWrap: 'wrap', padding: SP[3], marginBottom: SP[4],
              borderRadius: RADIUS.md, background: 'var(--th-bg)',
            }}>
              <div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Amount</div>
                <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold }}>
                  {fmtKobo(postingFor.amount_kobo)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Transaction date</div>
                <div style={{ ...NUM, fontSize: TEXT.md }}>{fmtDate(postingFor.txn_date)}</div>
              </div>
              <div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Break</div>
                <div style={{ fontSize: TEXT.sm, marginTop: 2 }}>
                  <ReasonChip reason={postingFor.reason} />
                </div>
              </div>
            </div>

            <Field label="Direction"
              hint={postingType === 'Debit'
                ? 'Debits the account below and credits SUSPENSE.'
                : 'Credits the account below and debits SUSPENSE.'}>
              <SegmentedToggle<'Debit' | 'Credit'> value={postingType} onChange={setPostingType}
                options={[{ value: 'Debit', label: 'Debit' }, { value: 'Credit', label: 'Credit' }]} />
            </Field>

            <Field label="Account" hint="The account the correction lands on. The other leg is SUSPENSE.">
              <Input value={postingAccount} onChange={e => setPostingAccount(e.target.value)}
                placeholder="e.g. CARD-RECEIVABLE" />
            </Field>

            <Field label="Narrative"
              hint="Left empty, the break reference, reason and date are used.">
              <Textarea value={postingNote} onChange={e => setPostingNote(e.target.value)} rows={2}
                placeholder={`Correcting entry for break ${postingFor.source_ref || postingFor.source_key}`} />
            </Field>

            <p style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: SP[3], lineHeight: 'var(--lh-relaxed)' }}>
              The entry is raised as <strong style={{ color: 'var(--txt)' }}>pending</strong> and carries
              a link back to this break. It needs a different person to approve it — you cannot approve
              your own.
            </p>
          </>
        )}
      </Modal>

      {/* ── Bulk resolve ── */}
      <Modal open={resolveOpen} onClose={() => setResolveOpen(false)}
        title={`Resolve ${selected.size} Exception${selected.size === 1 ? '' : 's'}`} width={520}
        footer={
          <>
            <Button variant="secondary" onClick={() => setResolveOpen(false)} disabled={resolving}>Cancel</Button>
            <Button icon="done_all" onClick={resolveSelected} loading={resolving}>Resolve</Button>
          </>
        }>
        <Field label="Resolution"
          hint={RESOLUTION_CODES.find(c => c.value === resolveCode)?.hint}>
          <Select value={resolveCode} onChange={e => setResolveCode(e.target.value)}>
            {RESOLUTION_CODES.map(c => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </Select>
        </Field>
        <Field label="Note (Optional)">
          <Textarea value={resolveNote} onChange={e => setResolveNote(e.target.value)} rows={3}
            placeholder="What was found, for whoever reads this queue next" />
        </Field>
        <p style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: SP[3], lineHeight: 'var(--lh-relaxed)' }}>
          The resolution code is recorded against every selected item. It is a fixed
          vocabulary on purpose: it is the only thing that can later answer
          <em> why</em> things go unmatched.
        </p>
      </Modal>
    </Page>
  )
}
