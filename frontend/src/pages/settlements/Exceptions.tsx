import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Page, KpiCard, SectionCard, ErrBanner, Button, Modal, Field, Select,
  EmptyState, StatusBadge, Badge, Spinner, Tabs,
} from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, fmtDatetime } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

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
  { value: 'matched_manually',  label: 'Matched manually',   hint: 'Found the ledger entry by hand' },
  { value: 'timing_difference', label: 'Timing difference',  hint: 'Will match in a later period' },
  { value: 'fee_or_commission', label: 'Fee or commission',  hint: 'Difference is a charge, not missing money' },
  { value: 'duplicate_in_feed', label: 'Duplicate in feed',  hint: 'Source sent it twice' },
  { value: 'processor_error',   label: 'Processor error',    hint: 'Wrong on the processor side' },
  { value: 'ledger_error',      label: 'Ledger error',       hint: 'Wrong on our side — needs a posting' },
  { value: 'written_off',       label: 'Write off',          hint: 'Accepted as a loss; closes the item' },
]

const REASON_LABEL: Record<string, string> = {
  no_candidate:    'No ledger match',
  ambiguous:       'Ambiguous',
  amount_mismatch: 'Amount differs',
}

const REASON_COLOR: Record<string, string> = {
  no_candidate:    RED,
  ambiguous:       AMBER,
  amount_mismatch: '#2563EB',
}

const tdBase: React.CSSProperties = {
  padding: '10px 14px', fontSize: TEXT.base, color: 'var(--txt)',
  borderBottom: '1px solid var(--bdr)', verticalAlign: 'middle',
}
const thBase: React.CSSProperties = {
  padding: '10px 14px', fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)',
  textAlign: 'left', borderBottom: '1px solid var(--bdr)', whiteSpace: 'nowrap',
}

// Age is the signal that matters most in an exception queue: a 40-day-old unmatched
// item is a different problem to yesterday's.
function AgeCell({ days }: { days: number }) {
  const color = days >= 30 ? RED : days >= 7 ? AMBER : 'var(--txt2)'
  const weight = days >= 7 ? FW.semibold : FW.normal
  return <span style={{ ...NUM, fontSize: TEXT.sm, color, fontWeight: weight }}>{days}d</span>
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettlementExceptions() {
  const [tab, setTab] = useState<'recon' | 'failures'>('recon')

  const [rows, setRows] = useState<ReconException[]>([])
  const [summary, setSummary] = useState<ExceptionSummary | null>(null)
  const [failures, setFailures] = useState<Failure[]>([])
  const [failSummary, setFailSummary] = useState<FailureSummary | null>(null)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [reasonFilter, setReasonFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('open,investigating')
  const [failKind, setFailKind] = useState('')

  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [resolveOpen, setResolveOpen] = useState(false)
  const [resolveCode, setResolveCode] = useState('matched_manually')
  const [resolveNote, setResolveNote] = useState('')
  const [resolving, setResolving] = useState(false)

  // Deep link from the Workbench: ?run_id=N
  const runId = useMemo(() => new URLSearchParams(window.location.search).get('run_id') ?? '', [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (tab === 'recon') {
        const p = new URLSearchParams()
        if (runId) p.set('run_id', runId)
        if (reasonFilter) p.set('reason', reasonFilter)
        if (statusFilter) p.set('status', statusFilter)
        p.set('limit', '300')
        const [list, sum] = await Promise.all([
          apiFetch<{ data: ReconException[] }>(`/api/recon/exceptions?${p.toString()}`),
          apiFetch<ExceptionSummary>('/api/recon/exceptions/summary'),
        ])
        setRows(list.data ?? [])
        setSummary(sum)
      } else {
        const p = new URLSearchParams()
        if (failKind) p.set('kind', failKind)
        p.set('limit', '300')
        const res = await apiFetch<{ data: Failure[]; summary: FailureSummary }>(`/api/paystack/failures?${p.toString()}`)
        setFailures(res.data ?? [])
        setFailSummary(res.summary)
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [tab, reasonFilter, statusFilter, failKind, runId])

  useEffect(() => { load() }, [load])

  const toggle = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const resolveSelected = async () => {
    setResolving(true)
    try {
      await apiPost('/api/recon/exceptions/bulk-resolve', {
        ids: [...selected],
        resolution_code: resolveCode,
        note: resolveNote,
      })
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

  return (
    <Page
      title="Exceptions & Failures"
      subtitle="Everything that didn't reconcile, and every payment that moved wrong"
    >
      <ErrBanner error={error} onRetry={load} />

      <Tabs
        tabs={[
          { key: 'recon',    label: 'Reconciliation exceptions' },
          { key: 'failures', label: 'Payment failures' },
        ]}
        active={tab}
        onChange={k => { setTab(k as 'recon' | 'failures'); setSelected(new Set()) }}
      />

      {tab === 'recon' ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], margin: `${SP[4]} 0 ${SP[6]}` }}>
            <KpiCard label="Open exceptions" value={fmtNum(summary?.open_n)} sub={fmtKobo(summary?.open_value_kobo)} icon="report" accent={RED} loading={loading && !summary} />
            <KpiCard label="Aged over 30 days" value={fmtNum(summary?.aged_30d_n)} sub="Escalate these" icon="schedule" accent={AMBER} loading={loading && !summary} />
            <KpiCard label="No ledger match" value={fmtNum(summary?.no_candidate_n)} sub="Nothing to pair against" icon="search_off" accent={NAVY} loading={loading && !summary} />
            <KpiCard label="Resolved" value={fmtNum(summary?.resolved_n)} sub={`${fmtNum(summary?.written_off_n)} written off`} icon="check_circle" accent={GREEN} loading={loading && !summary} />
          </div>

          <SectionCard
            title={runId ? `Exceptions from run #${runId}` : 'Exception queue'}
            subtitle="Oldest first — age is the signal that matters"
            padding={false}
            actions={
              selected.size > 0
                ? <Button size="sm" icon="done_all" onClick={() => setResolveOpen(true)}>Resolve {selected.size} selected</Button>
                : (
                  <div style={{ display: 'flex', gap: SP[2] }}>
                    <select value={reasonFilter} onChange={e => setReasonFilter(e.target.value)}
                      style={{ padding: '6px 10px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm }}>
                      <option value="">All reasons</option>
                      <option value="no_candidate">No ledger match</option>
                      <option value="ambiguous">Ambiguous</option>
                      <option value="amount_mismatch">Amount differs</option>
                    </select>
                    <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                      style={{ padding: '6px 10px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm }}>
                      <option value="open,investigating">Open</option>
                      <option value="resolved">Resolved</option>
                      <option value="written_off">Written off</option>
                    </select>
                  </div>
                )
            }
          >
            {loading && !rows.length ? (
              <div style={{ padding: SP[5] }}><Spinner /></div>
            ) : rows.length === 0 ? (
              <EmptyState icon="check_circle" title="Queue is clear"
                description="No exceptions match these filters. Run a reconciliation to populate it." />
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'var(--th-bg)' }}>
                      <th style={{ ...thBase, width: 36 }}></th>
                      <th style={thBase}>Reference</th>
                      <th style={thBase}>Txn date</th>
                      <th style={{ ...thBase, textAlign: 'right' }}>Amount</th>
                      <th style={thBase}>Reason</th>
                      <th style={thBase}>Detail</th>
                      <th style={{ ...thBase, textAlign: 'right' }}>Age</th>
                      <th style={thBase}>Status</th>
                      <th style={thBase}>Assigned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(x => (
                      <tr key={x.id} style={{ background: selected.has(x.id) ? 'var(--th-bg)' : 'var(--card)' }}>
                        <td style={tdBase}>
                          <input type="checkbox" checked={selected.has(x.id)} onChange={() => toggle(x.id)}
                            disabled={x.status !== 'open' && x.status !== 'investigating'} />
                        </td>
                        <td style={tdBase}>
                          <span style={{ ...NUM, fontSize: TEXT.sm, color: NAVY, fontWeight: FW.semibold }}>
                            {x.source_ref || x.source_key}
                          </span>
                        </td>
                        <td style={tdBase}><span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(x.txn_date)}</span></td>
                        <td style={{ ...tdBase, textAlign: 'right' }}>
                          <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(x.amount_kobo)}</span>
                        </td>
                        <td style={tdBase}>
                          <span style={{
                            fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px',
                            borderRadius: 99, color: REASON_COLOR[x.reason] ?? NAVY,
                            background: `${REASON_COLOR[x.reason] ?? NAVY}14`,
                          }}>
                            {REASON_LABEL[x.reason] ?? x.reason}
                            {x.candidate_n > 1 ? ` · ${x.candidate_n}` : ''}
                          </span>
                        </td>
                        <td style={{ ...tdBase, maxWidth: 320 }}>
                          <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{x.detail}</span>
                        </td>
                        <td style={{ ...tdBase, textAlign: 'right' }}><AgeCell days={Number(x.age_days ?? 0)} /></td>
                        <td style={tdBase}>
                          <StatusBadge status={x.status} size="sm" />
                          {x.resolution_code && (
                            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>{x.resolution_code}</div>
                          )}
                        </td>
                        <td style={tdBase}>
                          <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{x.assigned_to_name || '—'}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], margin: `${SP[4]} 0 ${SP[6]}` }}>
            <KpiCard label="Failed transfers" value={fmtNum(failSummary?.failed_transfers)} sub={fmtKobo(failSummary?.failed_transfers_kobo)} icon="call_missed_outgoing" accent={RED} loading={loading && !failSummary} />
            <KpiCard label="Failed fundings" value={fmtNum(failSummary?.failed_fundings)} sub={fmtKobo(failSummary?.failed_fundings_kobo)} icon="credit_card_off" accent={AMBER} loading={loading && !failSummary} />
            <KpiCard label="Reversals" value={fmtNum(Number(failSummary?.reversed_transfers ?? 0) + Number(failSummary?.reversed_fundings ?? 0))} sub="Money returned" icon="undo" accent={NAVY} loading={loading && !failSummary} />
            <KpiCard label="Open disputes" value={fmtNum(failSummary?.open_disputes)} sub="Chargebacks awaiting response" icon="gavel" accent={failSummary?.open_disputes ? RED : GREEN} loading={loading && !failSummary} />
          </div>

          <SectionCard
            title="Payment failures"
            subtitle="Every one of these is a customer whose money moved wrong"
            padding={false}
            actions={
              <select value={failKind} onChange={e => setFailKind(e.target.value)}
                style={{ padding: '6px 10px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.sm }}>
                <option value="">All types</option>
                <option value="transfer">Transfers out</option>
                <option value="funding">Fundings in</option>
                <option value="dispute">Disputes</option>
              </select>
            }
          >
            {loading && !failures.length ? (
              <div style={{ padding: SP[5] }}><Spinner /></div>
            ) : failures.length === 0 ? (
              <EmptyState icon="check_circle" title="No failures" description="Nothing has failed in this window." />
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'var(--th-bg)' }}>
                      <th style={thBase}>Type</th>
                      <th style={thBase}>Reference</th>
                      <th style={{ ...thBase, textAlign: 'right' }}>Amount</th>
                      <th style={thBase}>Counterparty</th>
                      <th style={thBase}>Bank / card</th>
                      <th style={thBase}>Reason</th>
                      <th style={thBase}>Status</th>
                      <th style={thBase}>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failures.map(f => (
                      <tr key={`${f.kind}-${f.ref_id}`} style={{ background: 'var(--card)' }}>
                        <td style={tdBase}><Badge variant="default">{f.kind}</Badge></td>
                        <td style={tdBase}>
                          <span style={{ ...NUM, fontSize: TEXT.sm, color: NAVY }}>{f.reference || f.ref_id}</span>
                        </td>
                        <td style={{ ...tdBase, textAlign: 'right' }}>
                          <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(f.amount_kobo)}</span>
                        </td>
                        <td style={tdBase}>
                          <span style={{ fontSize: TEXT.sm }}>{f.counterparty || '—'}</span>
                          {f.account && <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>{f.account}</div>}
                        </td>
                        <td style={tdBase}><span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{f.bank || '—'}</span></td>
                        <td style={{ ...tdBase, maxWidth: 280 }}>
                          <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{f.detail || '—'}</span>
                        </td>
                        <td style={tdBase}><StatusBadge status={f.status} size="sm" /></td>
                        <td style={tdBase}><span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDatetime(f.occurred_at)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </>
      )}

      {/* Bulk resolve */}
      <Modal open={resolveOpen} onClose={() => setResolveOpen(false)} title={`Resolve ${selected.size} exception(s)`} width={480}
        footer={
          <>
            <Button variant="secondary" onClick={() => setResolveOpen(false)} disabled={resolving}>Cancel</Button>
            <Button icon="done_all" onClick={resolveSelected} loading={resolving}>Resolve</Button>
          </>
        }>
        <Field label="Resolution" hint={RESOLUTION_CODES.find(c => c.value === resolveCode)?.hint}>
          <Select value={resolveCode} onChange={e => setResolveCode(e.target.value)}>
            {RESOLUTION_CODES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
        </Field>
        <Field label="Note (optional)">
          <textarea value={resolveNote} onChange={e => setResolveNote(e.target.value)} rows={3}
            style={{ width: '100%', padding: '8px 10px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontFamily: 'inherit' }} />
        </Field>
      </Modal>
    </Page>
  )
}
