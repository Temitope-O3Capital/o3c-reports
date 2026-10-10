import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, SectionCard, KpiCard, ErrBanner, DataTable, EmptyState, Button, Modal,
  Field, Select, Badge, Avatar, NameCell,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, fmtDatetime } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, PURPLE, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'
import { EBar } from '../../components/echarts'
import { humanLabel } from '../../lib/labels'

/*
  SETTLEMENT SUPERVISOR — who owns what, is the queue moving, what is waiting on me.

  This page exists because the answer to the first question was "nobody". Every
  actionable break in the queue is unassigned — 11,069 of them, ₦819m, the oldest
  63 days old — and no surface in the module could say so, let alone do anything
  about it. An exception queue without ownership is a list, not a workflow: nothing
  ages against a person, nothing is anyone's to close, and the backlog grows
  without ever being refused.

  So the page leads with the unclaimed pool and a control that actually drains it.
  Handing 11,069 items over one at a time is not a workflow anybody finishes, so
  Share Out distributes the OLDEST first, round-robin, across the officers chosen.

  Feed gaps are never assigned and never counted here. Nobody on this desk can
  close a day the counterparty never sent, and putting one in a person's queue
  makes their numbers a lie.
*/

// ── Types ─────────────────────────────────────────────────────────────────────

interface Officer {
  user_id: number
  full_name: string
  role: string
  assigned_n: number
  assigned_value_kobo: number
  oldest_days: number
  aged_30d_n: number
  resolved_30d: number
}

interface Unassigned { n: number; value_kobo: number; oldest_days: number }
interface AgingRow   { bucket: string; n: number; value_kobo: number }
interface ReasonRow  { reason: string; n: number; value_kobo: number }
interface ThroughRow { day: string; resolved_n: number; resolved_value_kobo: number }

interface UnsignedRun {
  id: number
  source: string
  counterparty: string
  period_from: string
  period_to: string
  source_n: number
  matched_n: number
  unmatched_n: number
  started_at: string
  match_rate_pct: number
  triggered_by_name: string
}

interface SupervisorData {
  officers: Officer[]
  unassigned: Unassigned
  aging: AgingRow[]
  by_reason: ReasonRow[]
  runs_unsigned: UnsignedRun[]
  throughput: ThroughRow[]
  feed_gap: { n: number; value_kobo: number }
}

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

// Ageing runs fresh → stale, so colour runs calm → alarming in the same direction.
const AGE_COLOR: Record<string, string> = {
  '0-7d': GREEN, '8-30d': BLUE, '31-90d': AMBER, '90d+': RED,
}
const AGE_ORDER = ['0-7d', '8-30d', '31-90d', '90d+']

function pairLabel(source: string, counterparty: string): string {
  if (source === 'ccs' && counterparty === 'card_ledger') return 'CCS Master → Card Account Book'
  if (source === 'interswitch' && counterparty === 'ccs') return 'Interswitch Settlement → CCS Master'
  if (source === 'interswitch' && counterparty === 'sage_ledger') return 'CCS Master → Card Account Book (legacy label)'
  return `${source} → ${counterparty}`
}

function nairaAxis(v: number) {
  if (v >= 1e11) return `₦${(v / 1e11).toFixed(1)}B`
  if (v >= 1e8)  return `₦${(v / 1e8).toFixed(0)}M`
  if (v >= 1e5)  return `₦${(v / 1e5).toFixed(0)}K`
  return v === 0 ? '0' : ''
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettlementSupervisor() {
  const navigate = useNavigate()
  const [d, setD] = useState<SupervisorData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [shareOpen, setShareOpen]   = useState(false)
  const [sharing, setSharing]       = useState(false)
  const [shareCount, setShareCount] = useState('200')
  const [picked, setPicked]         = useState<Set<number>>(new Set())
  const [shareResult, setShareResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setD(await apiFetch<SupervisorData>('/api/recon/supervisor'))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load the supervisor view')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const officers   = d?.officers ?? []
  const unassigned = d?.unassigned
  const feedGap    = d?.feed_gap
  const unsigned   = d?.runs_unsigned ?? []

  // Default the share-out to every officer on the desk — a supervisor opening this
  // control almost always means "everyone", and heads are included only if picked.
  useEffect(() => {
    if (!shareOpen) return
    const defaults = officers.filter(o => o.role === 'settlement_officer').map(o => o.user_id)
    setPicked(new Set(defaults.length ? defaults : officers.map(o => o.user_id)))
    setShareResult(null)
  }, [shareOpen, officers])

  const togglePick = (id: number) => {
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const shareOut = async () => {
    if (picked.size === 0) return
    setSharing(true)
    setError(null)
    try {
      const res = await apiPost<{ assigned: number; per_officer: Record<string, number> }>(
        '/api/recon/exceptions/bulk-assign',
        { user_ids: [...picked], limit: Number(shareCount) || 100 })
      const names = officers.reduce<Record<string, string>>((m, o) => {
        m[String(o.user_id)] = o.full_name.split(' ')[0]; return m
      }, {})
      const per = Object.entries(res.per_officer ?? {})
        .map(([id, n]) => `${names[id] ?? id}: ${n}`).join(' · ')
      setShareResult(`${res.assigned} item(s) shared out${per ? ` — ${per}` : ''}`)
      await load()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Share out failed')
    } finally {
      setSharing(false)
    }
  }

  const totalAssigned = useMemo(
    () => officers.reduce((s, o) => s + Number(o.assigned_n), 0), [officers])

  const agingSorted = useMemo(() => {
    const src = d?.aging ?? []
    return [...src].sort((a, b) => AGE_ORDER.indexOf(a.bucket) - AGE_ORDER.indexOf(b.bucket))
  }, [d])

  const throughputTotal = useMemo(
    () => (d?.throughput ?? []).reduce((s, t) => s + Number(t.resolved_n), 0), [d])

  const officerCols: TableCol<Officer>[] = [
    { key: 'full_name', label: 'Officer', render: o => (
      <NameCell name={o.full_name} sub={humanLabel(o.role)} />
    ) },
    { key: 'assigned_n', label: 'Assigned', align: 'right', sortable: true, width: 100,
      render: o => (
        <span style={{ ...NUM, fontWeight: FW.semibold, color: Number(o.assigned_n) > 0 ? 'var(--txt)' : 'var(--txt3)' }}>
          {fmtNum(o.assigned_n)}
        </span>
      ) },
    { key: 'assigned_value_kobo', label: 'Value Held', align: 'right', sortable: true,
      render: o => <span style={NUM}>{fmtKobo(o.assigned_value_kobo)}</span> },
    { key: 'oldest_days', label: 'Oldest', align: 'right', sortable: true, width: 90,
      render: o => {
        const n = Number(o.oldest_days)
        if (!n) return <span style={{ color: 'var(--txt3)' }}>—</span>
        const tone = n >= 90 ? RED : n >= 30 ? AMBER : n >= 7 ? BLUE : GREEN
        return <span style={{ ...NUM, color: tone, fontWeight: FW.semibold }}>{n}d</span>
      } },
    { key: 'aged_30d_n', label: 'Over 30d', align: 'right', sortable: true, width: 100,
      render: o => (
        <span style={{ ...NUM, color: Number(o.aged_30d_n) > 0 ? RED : 'var(--txt3)' }}>
          {fmtNum(o.aged_30d_n)}
        </span>
      ) },
    // Throughput per person, not just backlog — the only number that says whether
    // someone is working their queue or merely holding it.
    { key: 'resolved_30d', label: 'Closed (30d)', align: 'right', sortable: true, width: 120,
      render: o => (
        <span style={{ ...NUM, color: Number(o.resolved_30d) > 0 ? GREEN : 'var(--txt3)', fontWeight: FW.semibold }}>
          {fmtNum(o.resolved_30d)}
        </span>
      ) },
    { key: 'actions', label: '', width: 110, render: o => (
      <Button size="sm" variant="secondary"
        onClick={() => navigate(`/settlements/exceptions?assigned_to=${o.user_id}`)}>
        View
      </Button>
    ) },
  ]

  const runCols: TableCol<UnsignedRun>[] = [
    { key: 'id', label: 'Run', width: 70,
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>#{r.id}</span> },
    { key: 'pair', label: 'Pair', render: r => (
      <span style={{ fontSize: TEXT.sm }}>{pairLabel(r.source, r.counterparty)}</span>
    ) },
    { key: 'period_from', label: 'Period', width: 180, render: r => (
      <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>
        {fmtDate(r.period_from)} – {fmtDate(r.period_to)}
      </span>
    ) },
    { key: 'match_rate_pct', label: 'Matched', align: 'right', width: 100, render: r => {
      const p = Number(r.match_rate_pct ?? 0)
      return <span style={{ ...NUM, fontWeight: FW.semibold, color: p >= 95 ? GREEN : p >= 80 ? AMBER : RED }}>
        {p.toFixed(1)}%</span>
    } },
    { key: 'unmatched_n', label: 'Unmatched', align: 'right', width: 110,
      render: r => <span style={NUM}>{fmtNum(r.unmatched_n)}</span> },
    { key: 'started_at', label: 'Ran', width: 155,
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtDatetime(r.started_at)}</span> },
    { key: 'actions', label: '', width: 120, render: () => (
      <Button size="sm" variant="secondary" icon="task_alt"
        onClick={() => navigate('/settlements/workbench')}>Sign Off</Button>
    ) },
  ]

  return (
    <Page
      title="Settlement Supervisor"
      subtitle="Who owns what, whether the queue is moving, and what is waiting on a sign-off"
      loading={loading && !d}
      skeletonKpis={4}
      actions={
        <div style={{ display: 'flex', gap: SP[2], flexWrap: 'wrap' }}>
          <Button size="sm" variant="secondary" icon="rule"
            onClick={() => navigate('/settlements/exceptions')}>Queue</Button>
          <Button size="sm" icon="group_add" onClick={() => setShareOpen(true)}
            disabled={!unassigned || Number(unassigned.n) === 0}>Share Out Work</Button>
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* ── The one thing a supervisor is here to fix ── */}
      {d && Number(unassigned?.n ?? 0) > 0 && (
        <div role="alert" style={{
          display: 'flex', alignItems: 'flex-start', gap: SP[3],
          padding: SP[4], marginBottom: SP[5], borderRadius: RADIUS.lg,
          background: 'var(--card)', border: '1px solid var(--card-bdr)',
          borderLeft: `4px solid ${totalAssigned === 0 ? RED : AMBER}`,
          boxShadow: 'var(--card-shadow)',
        }}>
          <span className="material-symbols-rounded" aria-hidden="true"
            style={{ fontSize: 22, color: totalAssigned === 0 ? RED : AMBER, flexShrink: 0, marginTop: 1 }}>
            person_off
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>
              {totalAssigned === 0
                ? `Nothing in the queue is assigned to anyone`
                : `${fmtNum(unassigned!.n)} break(s) have no owner`}
            </div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 3, lineHeight: 'var(--lh-relaxed)' }}>
              {fmtKobo(unassigned!.value_kobo)} unclaimed, the oldest{' '}
              <strong style={{ color: 'var(--txt)' }}>{fmtNum(unassigned!.oldest_days)} days</strong> old.
              An unowned item ages against nobody and is never refused, which is how this queue grew.
              Share it out and each item starts ageing against a person.
            </div>
          </div>
          <Button size="sm" icon="group_add" onClick={() => setShareOpen(true)}>Share Out</Button>
        </div>
      )}

      {shareResult && (
        <div role="status" style={{
          display: 'flex', alignItems: 'center', gap: SP[3],
          padding: SP[4], marginBottom: SP[5], borderRadius: RADIUS.lg,
          background: 'var(--card)', border: '1px solid var(--card-bdr)',
          borderLeft: `4px solid ${GREEN}`,
        }}>
          <span className="material-symbols-rounded" aria-hidden="true"
            style={{ fontSize: 20, color: GREEN }}>check_circle</span>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{shareResult}</div>
          <Button size="sm" variant="secondary" onClick={() => setShareResult(null)}
            style={{ marginLeft: 'auto' }}>Dismiss</Button>
        </div>
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: SP[3], marginBottom: SP[6],
      }}>
        <KpiCard label="Unclaimed" value={fmtNum(unassigned?.n)}
          sub={fmtKobo(unassigned?.value_kobo)} icon="inbox"
          accent={Number(unassigned?.n ?? 0) > 0 ? RED : GREEN} loading={loading && !d} />
        <KpiCard label="Owned by the Desk" value={fmtNum(totalAssigned)}
          sub={`across ${fmtNum(officers.length)} officer(s)`} icon="assignment_ind"
          accent={totalAssigned > 0 ? BLUE : 'var(--txt3)'} loading={loading && !d} />
        <KpiCard label="Closed in 14 Days" value={fmtNum(throughputTotal)}
          sub={throughputTotal > 0 ? 'queue is moving' : 'nothing closed recently'}
          icon="trending_up" accent={throughputTotal > 0 ? GREEN : AMBER} loading={loading && !d} />
        <KpiCard label="Awaiting Sign-Off" value={fmtNum(unsigned.length)}
          sub={unsigned.length > 0 ? 'positions nobody has accepted' : 'all runs signed'}
          icon="pending_actions" accent={unsigned.length > 0 ? AMBER : GREEN} loading={loading && !d} />
      </div>

      {/* ── Who owns what ── */}
      <SectionCard title="The Desk" padding={false} style={{ marginBottom: SP[4] }}
        subtitle="Load, age and throughput per officer — backlog alone cannot tell you who is working theirs"
        actions={feedGap && Number(feedGap.n) > 0
          ? <Badge variant="default">{fmtNum(feedGap.n)} feed gaps excluded</Badge>
          : undefined}>
        <DataTable
          cols={officerCols} rows={officers} keyFn={o => o.user_id}
          loading={loading && !d} skeletonRows={3}
          emptyText={
            <EmptyState icon="group_off" title="No settlement officers"
              description="Nobody holds the settlement_officer or settlement_head role, so there is nobody to assign work to." />
          }
        />
      </SectionCard>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: SP[4], marginBottom: SP[4] }}>
        {/* ── Ageing ── */}
        <SectionCard title="How Old the Queue Is"
          subtitle="Actionable breaks only — a feed gap that is 90 days old is not a desk 90 days behind">
          {agingSorted.length === 0 ? (
            <EmptyState icon="schedule" title="Nothing outstanding" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
              {(() => {
                const max = Math.max(...agingSorted.map(a => Number(a.n)))
                return agingSorted.map(a => (
                  <div key={a.bucket}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4, gap: SP[2] }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: SP[2], fontSize: TEXT.sm, fontWeight: FW.medium }}>
                        <span aria-hidden="true" style={{
                          width: 9, height: 9, borderRadius: 2,
                          background: AGE_COLOR[a.bucket] ?? 'var(--txt3)',
                        }} />
                        {a.bucket}
                      </span>
                      <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', whiteSpace: 'nowrap' }}>
                        {fmtNum(a.n)} · {fmtKobo(a.value_kobo)}
                      </span>
                    </div>
                    <div role="img" aria-label={`${a.bucket}: ${fmtNum(a.n)} items`}
                      style={{ height: 6, borderRadius: 3, background: 'var(--bdr)', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: 3,
                        width: `${max > 0 ? (Number(a.n) / max) * 100 : 0}%`,
                        background: AGE_COLOR[a.bucket] ?? 'var(--txt3)',
                      }} />
                    </div>
                  </div>
                ))
              })()}
            </div>
          )}
        </SectionCard>

        {/* ── Reason mix ── */}
        <SectionCard title="Why Things Are Open"
          subtitle="The feed gap is listed, and kept out of every desk figure above">
          {(d?.by_reason ?? []).length === 0 ? (
            <EmptyState icon="rule" title="Nothing open" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: SP[2] }}>
              {(d?.by_reason ?? []).map(rr => (
                <div key={rr.reason} style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
                  <span aria-hidden="true" style={{
                    width: 9, height: 9, borderRadius: 2, flexShrink: 0,
                    background: REASON_COLOR[rr.reason] ?? 'var(--txt3)',
                  }} />
                  <span style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>
                    {REASON_LABEL[rr.reason] ?? humanLabel(rr.reason)}
                  </span>
                  {rr.reason === 'master_no_data' && <Badge variant="default">not the desk&apos;s</Badge>}
                  <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                    {fmtNum(rr.n)} · {fmtKobo(rr.value_kobo)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      {/* ── Throughput ── */}
      <SectionCard title="Closures per Day" style={{ marginBottom: SP[4] }}
        subtitle="The last fortnight. Backlog says how much there is; this says whether it is shrinking">
        {(d?.throughput ?? []).length === 0 ? (
          <EmptyState icon="show_chart" title="No closure history" />
        ) : (
          <EBar
            data={(d?.throughput ?? []).map(t => ({ ...t, label: fmtDate(t.day) }))}
            xKey="label" height={220}
            valueFmt={(v: number) => fmtNum(v)}
            axisFmt={(v: number) => (v === 0 ? '0' : String(v))}
            series={[{ key: 'resolved_n', name: 'Closed', color: GREEN }] as any}
          />
        )}
      </SectionCard>

      {/* ── Waiting on a head ── */}
      <SectionCard title="Positions Awaiting Sign-Off" padding={false}
        subtitle="Sign-off is the record that a human accepted the position — an unsigned run means nobody has">
        <DataTable
          cols={runCols} rows={unsigned} keyFn={r => r.id}
          loading={loading && !d} skeletonRows={3}
          emptyText={
            <EmptyState icon="task_alt" title="Every run is signed off"
              description="No reconciliation is waiting on a head." />
          }
        />
      </SectionCard>

      {/* ── Share out ── */}
      <Modal open={shareOpen} onClose={() => setShareOpen(false)} title="Share Out Unclaimed Work" width={540}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShareOpen(false)} disabled={sharing}>Cancel</Button>
            <Button icon="group_add" onClick={shareOut} loading={sharing} disabled={picked.size === 0}>
              Share Out
            </Button>
          </>
        }>
        <p style={{ fontSize: TEXT.base, color: 'var(--txt2)', marginBottom: SP[4], lineHeight: 'var(--lh-relaxed)' }}>
          The <strong style={{ color: 'var(--txt)' }}>oldest</strong> unclaimed items are shared out
          round-robin, so the backlog drains from the end that has waited longest and everyone gets a
          comparable slice. Counterparty feed gaps are never included — nobody here can close a day
          the counterparty never sent.
        </p>

        <Field label="Officers">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {officers.map(o => {
              const on = picked.has(o.user_id)
              return (
                <button
                  key={o.user_id} type="button" onClick={() => togglePick(o.user_id)}
                  aria-pressed={on}
                  style={{
                    display: 'flex', alignItems: 'center', gap: SP[3], textAlign: 'left',
                    padding: '8px 10px', borderRadius: RADIUS.md, cursor: 'pointer',
                    border: `1.5px solid ${on ? NAVY : 'var(--bdr)'}`,
                    background: on ? 'rgba(14,40,65,0.04)' : 'var(--card)',
                  }}>
                  <span className="material-symbols-rounded" aria-hidden="true"
                    style={{ fontSize: 18, color: on ? NAVY : 'var(--txt3)' }}>
                    {on ? 'check_box' : 'check_box_outline_blank'}
                  </span>
                  <Avatar name={o.full_name} size={26} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                      {o.full_name}
                    </span>
                    <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                      {humanLabel(o.role)} · holds {fmtNum(o.assigned_n)}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </Field>

        <Field label="How Many Items"
          hint={`${fmtNum(unassigned?.n)} are unclaimed. Each officer gets about ${
            picked.size > 0 ? fmtNum(Math.ceil((Number(shareCount) || 0) / picked.size)) : '—'} items.`}>
          <Select value={shareCount} onChange={e => setShareCount(e.target.value)}>
            <option value="50">50 oldest</option>
            <option value="200">200 oldest</option>
            <option value="500">500 oldest</option>
            <option value="1000">1,000 oldest</option>
            <option value="5000">5,000 oldest</option>
          </Select>
        </Field>
      </Modal>
    </Page>
  )
}
