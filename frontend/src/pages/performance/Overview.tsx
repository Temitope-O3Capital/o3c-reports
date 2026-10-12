import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Page, KpiCard, SectionCard, ErrBanner, DataTable, EmptyState, Tabs, DateFilter,
  Badge, NameCell,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtDate, today } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

/*
  STAFF PERFORMANCE — how quickly work is attended to, where that can honestly be
  measured.

  THE PAGE LEADS WITH COVERAGE, NOT A LEAGUE TABLE, because the survey came back
  blunt. Of the tables carrying both an actor and a completion timestamp, only two
  hold enough to say anything about a person: helpdesk tickets and contact centre
  calls. Collections, credit, compliance, sales, internal control and manual postings
  read zero — not "low", zero. Ranking anyone on those would rank the absence of a
  writer, so the page says so.

  TWO CLOCKS, SHOWN TOGETHER. Every duration appears both ways: working hours, and
  the calendar hours the platform currently uses. The live SLA is set as
  created_at + N hours, so nights, weekends and public holidays count against
  whoever was on duty, and across the resolved tickets that inflates duration about
  fourfold. Neither clock is quietly preferred here — switching the definition
  restates how people are judged, so both are shown and the choice stays with the
  business.

  NO QUALITY COLUMN, AND THAT IS A DATA FACT. The agreed design pairs every speed
  figure with a quality one. It cannot be honoured yet: csat_score is NULL on all
  40,794 tickets, first_response_at on all of them, status only ever holds open or
  closed so there is no reopen signal, and escalation and flagging are entirely
  unpopulated. The page reports speed and names the gap rather than inventing a proxy.
*/

interface CoverageRow {
  department: string
  source: string
  attributed_by: string
  rows_total: number
  completed: number
  attributed: number
  people: number
}

interface PersonRow {
  user_id: number
  name: string
  department: string
  completed: number
  // Which instant the duration was taken from: a real resolution, or the closure
  // that stood in for one. Reported, never blended away.
  on_resolution: number
  on_closure: number
  avg_calendar_h: number | string | null
  avg_business_h: number | string | null
  median_calendar_h: number | string | null
  median_business_h: number | string | null
  breach_calendar: number
  breach_business: number
}

interface OpenRow {
  user_id: number
  name: string
  open_tickets: number
  open_overdue: number
  oldest_open: string | null
}

interface HelpdeskPayload {
  period: { from: string; to: string }
  by_person: PersonRow[]
  totals: {
    completed: number; on_resolution: number; on_closure: number; unattributed: number
    avg_calendar_h: number | string | null; avg_business_h: number | string | null
    median_calendar_h: number | string | null; median_business_h: number | string | null
    breach_calendar: number; breach_business: number
  } | null
  backlog: {
    open_tickets: number; open_overdue: number
    open_unassigned: number; open_overdue_unassigned: number
    oldest_open: string | null
  } | null
  open_by_person: OpenRow[]
  unmeasurable: {
    tickets: number; with_csat: number; with_first_response: number
    with_escalation: number; flagged: number; with_resolver: number
    closed_without_resolution: number
    last_resolution: string | null; last_closure: string | null
  } | null
}

interface AgentRow {
  user_id: number
  name: string
  calls: number
  outbound: number
  inbound: number
  completed: number
  missed: number
  voicemail: number
  connect_pct: number | string | null
  with_duration: number
  avg_talk_sec: number | string | null
}

interface CallsPayload {
  period: { from: string; to: string }
  by_agent: AgentRow[]
  totals: {
    calls: number; unattributed: number; completed: number; missed: number
    connect_pct: number | string | null; with_duration: number; with_wait: number
  } | null
}

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/* Hours, shown to one decimal, or an em dash. Never "0" for "unknown". */
function hrs(v: number | string | null | undefined): string {
  const n = num(v)
  return n === null ? '—' : `${n.toFixed(1)}h`
}

function ninetyDaysAgo(): string {
  const d = new Date()
  d.setDate(d.getDate() - 90)
  return d.toISOString().slice(0, 10)
}

/* The paired-clock cell: working hours lead, calendar sits underneath in the
   de-emphasised position, because the working figure is the one that describes the
   work. Both are present so neither is taken on trust. */
function ClockPair({ business, calendar }: {
  business: number | string | null
  calendar: number | string | null
}) {
  const b = num(business)
  const c = num(calendar)
  const ratio = b !== null && c !== null && b > 0 ? c / b : null
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
        {hrs(business)}
      </div>
      <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
        {hrs(calendar)} calendar
        {ratio !== null && ratio >= 1.5 ? ` · ${ratio.toFixed(1)}×` : ''}
      </div>
    </div>
  )
}

export default function PerformanceOverview() {
  const [from, setFrom] = useState(ninetyDaysAgo())
  const [to, setTo] = useState(today())
  const [tab, setTab] = useState('helpdesk')

  const [coverage, setCoverage] = useState<CoverageRow[]>([])
  const [hd, setHd] = useState<HelpdeskPayload | null>(null)
  const [calls, setCalls] = useState<CallsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [c, h, k] = await Promise.all([
        apiFetch<{ data: CoverageRow[] }>('/api/performance/coverage'),
        apiFetch<HelpdeskPayload>(`/api/performance/helpdesk?date_from=${from}&date_to=${to}`),
        apiFetch<CallsPayload>(`/api/performance/calls?date_from=${from}&date_to=${to}`),
      ])
      setCoverage(c.data ?? [])
      setHd(h)
      setCalls(k)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load staff performance')
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const measurable = useMemo(() => coverage.filter(c => Number(c.attributed) > 0), [coverage])
  const unmeasured = useMemo(() => coverage.filter(c => Number(c.attributed) === 0), [coverage])

  const t = hd?.totals
  const bl = hd?.backlog
  const um = hd?.unmeasurable
  const ct = calls?.totals

  // ── columns ────────────────────────────────────────────────────────────────

  const personCols: TableCol<PersonRow>[] = [
    {
      key: 'name', label: 'Person', sortable: true, render: r => (
        <NameCell name={r.name} sub={r.department || 'No Department Recorded'} />
      ),
    },
    {
      key: 'completed', label: 'Completed', align: 'right', sortable: true, width: 120,
      render: r => (
        <div style={{ minWidth: 0 }}>
          <div style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold }}>
            {fmtNum(r.completed)}
          </div>
          {Number(r.on_closure) > 0 && (
            <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              {fmtNum(r.on_closure)} timed on closure
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'median_business_h', label: 'Median Time', align: 'right', sortable: true, width: 140,
      render: r => <ClockPair business={r.median_business_h} calendar={r.median_calendar_h} />,
    },
    {
      key: 'avg_business_h', label: 'Average Time', align: 'right', sortable: true, width: 140,
      render: r => <ClockPair business={r.avg_business_h} calendar={r.avg_calendar_h} />,
    },
    {
      key: 'breach_business', label: 'Past Allowance', align: 'right', sortable: true, width: 150,
      render: r => {
        const b = Number(r.breach_business)
        const c = Number(r.breach_calendar)
        const pct = Number(r.completed) > 0 ? (100 * b) / Number(r.completed) : 0
        return (
          <div style={{ minWidth: 0 }}>
            <div style={{
              ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold,
              color: pct >= 5 ? RED : pct > 0 ? AMBER : GREEN,
            }}>
              {fmtNum(b)} ({pct.toFixed(1)}%)
            </div>
            <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              {fmtNum(c)} on the calendar clock
            </div>
          </div>
        )
      },
    },
  ]

  const openCols: TableCol<OpenRow>[] = [
    { key: 'name', label: 'Person', sortable: true, render: r => <NameCell name={r.name} /> },
    {
      key: 'open_tickets', label: 'Still Open', align: 'right', sortable: true, width: 110,
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtNum(r.open_tickets)}</span>,
    },
    {
      key: 'open_overdue', label: 'Past Due', align: 'right', sortable: true, width: 110,
      render: r => Number(r.open_overdue) > 0
        ? <span style={{ ...NUM, fontWeight: FW.semibold, color: RED }}>{fmtNum(r.open_overdue)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
    {
      key: 'oldest_open', label: 'Oldest Open', sortable: true, width: 140,
      render: r => r.oldest_open
        ? <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtDate(r.oldest_open)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span>,
    },
  ]

  const agentCols: TableCol<AgentRow>[] = [
    { key: 'name', label: 'Agent', sortable: true, render: r => <NameCell name={r.name} /> },
    {
      key: 'calls', label: 'Calls', align: 'right', sortable: true, width: 110,
      render: r => (
        <div style={{ minWidth: 0 }}>
          <div style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold }}>{fmtNum(r.calls)}</div>
          <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
            {fmtNum(r.outbound)} out · {fmtNum(r.inbound)} in
          </div>
        </div>
      ),
    },
    {
      key: 'connect_pct', label: 'Connected', align: 'right', sortable: true, width: 130,
      render: r => {
        const p = num(r.connect_pct)
        return (
          <div style={{ minWidth: 0 }}>
            <div style={{
              ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold,
              color: p === null ? 'var(--txt3)' : p >= 40 ? GREEN : p >= 30 ? AMBER : RED,
            }}>
              {p === null ? '—' : `${p.toFixed(1)}%`}
            </div>
            <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              {fmtNum(r.completed)} of {fmtNum(r.calls)}
            </div>
          </div>
        )
      },
    },
    {
      key: 'missed', label: 'Missed', align: 'right', sortable: true, width: 110,
      render: r => <span style={NUM}>{fmtNum(r.missed)}</span>,
    },
    {
      // Talk time with its own denominator attached, because duration_sec is
      // populated on a sixth of calls and an unqualified average would read as all.
      key: 'avg_talk_sec', label: 'Talk Time', align: 'right', sortable: true, width: 150,
      render: r => {
        const s = num(r.avg_talk_sec)
        return (
          <div style={{ minWidth: 0 }}>
            <div style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold }}>
              {s === null ? '—' : `${Math.round(s)}s`}
            </div>
            <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              from {fmtNum(r.with_duration)} timed call(s)
            </div>
          </div>
        )
      },
    },
  ]

  const coverageCols: TableCol<CoverageRow>[] = [
    {
      key: 'department', label: 'Department', sortable: true, render: r => (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
            {r.department}
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs, color: 'var(--txt3)' }}>
            {r.source}
          </div>
        </div>
      ),
    },
    {
      key: 'attributed_by', label: 'Attributed By', width: 210,
      render: r => (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs, color: 'var(--txt2)' }}>
          {r.attributed_by}
        </span>
      ),
    },
    {
      key: 'rows_total', label: 'Records', align: 'right', sortable: true, width: 110,
      render: r => <span style={NUM}>{fmtNum(r.rows_total)}</span>,
    },
    {
      key: 'attributed', label: 'Attributed to a Person', align: 'right', sortable: true, width: 190,
      render: r => {
        const a = Number(r.attributed)
        const pct = Number(r.rows_total) > 0 ? (100 * a) / Number(r.rows_total) : 0
        return (
          <div style={{ minWidth: 0 }}>
            <div style={{
              ...NUM, fontSize: TEXT.sm, fontWeight: FW.semibold,
              color: a === 0 ? 'var(--txt3)' : GREEN,
            }}>
              {fmtNum(a)}{a > 0 ? ` (${pct.toFixed(0)}%)` : ''}
            </div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              {Number(r.completed) === 0
                ? 'nothing completed'
                : `${fmtNum(r.completed)} completed`}
            </div>
          </div>
        )
      },
    },
    {
      key: 'people', label: 'People', align: 'right', sortable: true, width: 100,
      render: r => Number(r.people) > 0
        ? <span style={NUM}>{fmtNum(r.people)}</span>
        : <Badge variant="default">none</Badge>,
    },
    {
      key: '_verdict', label: 'Measurable', width: 150, sortable: false,
      render: r => Number(r.attributed) === 0
        ? <Badge variant="warning">no</Badge>
        : Number(r.people) < 2
          ? <Badge variant="default">one person only</Badge>
          : <Badge variant="success">yes</Badge>,
    },
  ]

  return (
    <Page
      title="Staff Performance"
      subtitle="How quickly work is attended to, measured on working hours as well as the calendar"
      loading={loading && !hd}
      skeletonKpis={4}
      actions={
        // load() re-runs from the [from, to] dependency, so there is no Apply step.
        <DateFilter from={from} to={to}
          onChange={(f, t) => { setFrom(f); setTo(t) }} align="right" />
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* The finding, before any figure. A reader who sees a league table first will
          assume the departments missing from it are simply quiet. */}
      {!loading && coverage.length > 0 && (
        <div role="note" style={{
          display: 'flex', alignItems: 'flex-start', gap: SP[3],
          padding: SP[4], marginBottom: SP[5], borderRadius: RADIUS.lg,
          background: 'var(--card)', border: '1px solid var(--card-bdr)',
          borderLeft: `4px solid ${NAVY}`, boxShadow: 'var(--card-shadow)',
        }}>
          <span className="material-symbols-rounded" aria-hidden="true"
            style={{ fontSize: 22, color: NAVY, flexShrink: 0, marginTop: 1 }}>fact_check</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>
              {fmtNum(measurable.length)} of {fmtNum(coverage.length)} work sources can carry a
              per-person measure
            </div>
            <div style={{
              fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 3,
              lineHeight: 'var(--lh-relaxed)',
            }}>
              The other {fmtNum(unmeasured.length)} record no actor against completed work, so a
              figure for them would be zero because nothing was written down — not because nobody
              did anything. Helpdesk and the contact centre are reported below; the full survey is
              on the <strong>Coverage</strong> tab.
            </div>
          </div>
        </div>
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(215px, 1fr))',
        gap: SP[3], marginBottom: SP[5],
      }}>
        <KpiCard label="Tickets Completed" value={fmtNum(t?.completed)}
          sub={Number(t?.on_closure ?? 0) > 0
            ? `${fmtNum(t?.on_closure)} timed on closure, not resolution`
            : Number(t?.unattributed ?? 0) > 0
              ? `${fmtNum(t?.unattributed)} with no assignee`
              : 'all attributed'}
          icon="task_alt" accent={NAVY} loading={loading && !hd} />
        <KpiCard label="Median Time to Resolve" value={hrs(t?.median_business_h)}
          sub={`${hrs(t?.median_calendar_h)} on the calendar clock`}
          icon="schedule" accent={BLUE} loading={loading && !hd} />
        <KpiCard label="Past Their Allowance" value={fmtNum(t?.breach_business)}
          sub={`${fmtNum(t?.breach_calendar)} on the calendar clock`}
          icon="running_with_errors"
          accent={Number(t?.breach_business ?? 0) > 0 ? AMBER : GREEN} loading={loading && !hd} />
        <KpiCard label="Calls Handled" value={fmtNum(ct?.calls)}
          sub={ct?.connect_pct != null ? `${num(ct.connect_pct)?.toFixed(1)}% connected` : 'no calls in range'}
          icon="call" accent={PURPLE} loading={loading && !calls} />
      </div>

      {/* The backlog is a position, not a period figure, so it sits apart from the
          date-filtered tiles above rather than appearing to move with them. */}
      {bl && Number(bl.open_tickets) > 0 && (
        <SectionCard title="Open Right Now" style={{ marginBottom: SP[5] }}
          subtitle="A position rather than a period figure — the date filter above does not apply to it">
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
            gap: SP[4],
          }}>
            {([
              ['Still Open', fmtNum(bl.open_tickets), 'var(--txt)'],
              ['Past Due', fmtNum(bl.open_overdue), Number(bl.open_overdue) > 0 ? RED : GREEN],
              ['Unassigned', fmtNum(bl.open_unassigned),
                Number(bl.open_unassigned) > 0 ? AMBER : GREEN],
              ['Oldest Open', bl.oldest_open ? fmtDate(bl.oldest_open) : '—', 'var(--txt)'],
            ] as [string, string, string][]).map(([label, value, tone]) => (
              <div key={label}>
                <div style={{
                  fontSize: TEXT.xs, color: 'var(--txt3)', textTransform: 'uppercase',
                  letterSpacing: '0.04em', marginBottom: 2,
                }}>{label}</div>
                <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.bold, color: tone }}>
                  {value}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      <Tabs
        active={tab} onChange={setTab}
        tabs={[
          { key: 'helpdesk', label: 'Helpdesk', badge: hd?.by_person?.length ?? 0 },
          { key: 'calls', label: 'Contact Centre', badge: calls?.by_agent?.length ?? 0 },
          { key: 'coverage', label: 'Coverage', badge: unmeasured.length },
        ]}
      />

      {tab === 'helpdesk' && (
        <>
          <SectionCard title="Time to Resolve, by Person" padding={false}
            subtitle="Working hours lead; the calendar figure sits beneath each, with its multiple where it differs by half again or more"
            style={{ marginBottom: SP[4] }}>
            <DataTable
              cols={personCols} rows={hd?.by_person ?? []} keyFn={r => String(r.user_id)}
              searchKeys={['name', 'department']}
              searchPlaceholder="Search person or department…"
              loading={loading && !hd} skeletonRows={6} pageSize={25}
              emptyText={
                <EmptyState icon="schedule" title="Nothing Resolved in This Period"
                  description={um?.last_resolution
                    ? `The most recent resolution on record is ${fmtDate(um.last_resolution)}. Widen the date range, or check whether the helpdesk feed has stopped.`
                    : 'No resolved tickets fall inside the selected dates.'} />
              }
            />
          </SectionCard>

          {(hd?.open_by_person?.length ?? 0) > 0 && (
            <SectionCard title="What Each Person Still Holds" padding={false}
              subtitle="Resolution speed alone flatters whoever is sitting on an old queue, so the queue is shown beside it"
              style={{ marginBottom: SP[4] }}>
              <DataTable
                cols={openCols} rows={hd?.open_by_person ?? []} keyFn={r => String(r.user_id)}
                loading={loading && !hd} skeletonRows={4} pageSize={25}
                emptyText={<EmptyState icon="inbox" title="Nothing Open" />}
              />
            </SectionCard>
          )}

          {/* Said on the page, not just in the code: an absent quality column would
              otherwise read as a clean bill of health. */}
          {um && (
            <SectionCard title="What Cannot Be Measured Yet"
              subtitle="Named rather than left blank, because an absent figure reads as a good one">
              <div style={{
                fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 'var(--lh-relaxed)',
              }}>
                Across {fmtNum(um.tickets)} tickets:
                <ul style={{ margin: `${SP[2]}px 0 0`, paddingLeft: 20 }}>
                  <li>
                    <strong>Customer satisfaction</strong> — recorded on {fmtNum(um.with_csat)} of
                    them, so there is no quality figure to set against speed.
                  </li>
                  <li>
                    <strong>Time to first response</strong> — recorded on{' '}
                    {fmtNum(um.with_first_response)}, so only end-to-end resolution can be timed.
                  </li>
                  <li>
                    <strong>Reopened work</strong> — the status field only ever holds open or
                    closed, so a ticket that came back is indistinguishable from one that did not.
                  </li>
                  <li>
                    <strong>Who resolved it</strong> — recorded on {fmtNum(um.with_resolver)}. Every
                    figure above is therefore credited to the <em>assignee</em>, which is not
                    always the same person.
                  </li>
                  <li>
                    <strong>{fmtNum(um.closed_without_resolution)} closed tickets carry no
                    resolution time</strong>, so their duration is taken to the moment they were
                    closed instead. Closure is at or after resolution, so those figures are an
                    upper bound — never flattering.
                    {um.last_resolution && um.last_closure
                      && um.last_resolution < um.last_closure && (
                      <> The feed stopped supplying resolution times on{' '}
                        <strong>{fmtDate(um.last_resolution)}</strong> while closures continued to{' '}
                        {fmtDate(um.last_closure)}, which is why that count matters: without the
                        fallback this page would be blank for everything since.
                      </>
                    )}
                  </li>
                </ul>
              </div>
            </SectionCard>
          )}
        </>
      )}

      {tab === 'calls' && (
        <SectionCard title="Calls, by Agent" padding={false}
          subtitle="Volume and connection rate. Talk time is shown with the number of calls it was computed from, because most calls carry no duration">
          <DataTable
            cols={agentCols} rows={calls?.by_agent ?? []} keyFn={r => String(r.user_id)}
            searchKeys={['name']} searchPlaceholder="Search agent…"
            loading={loading && !calls} skeletonRows={6} pageSize={25}
            emptyText={
              <EmptyState icon="call" title="No Calls in This Period"
                description="No call in the selected dates carries an agent." />
            }
          />
          {ct && (
            <div style={{
              padding: SP[4], borderTop: '1px solid var(--card-bdr)',
              fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 'var(--lh-relaxed)',
            }}>
              {fmtNum(ct.calls)} calls, of which {fmtNum(ct.with_duration)} carry a duration and{' '}
              {fmtNum(ct.with_wait)} a wait time. Average talk time is therefore computed from a
              subset and is shown per agent with its own denominator; no fleet-wide average
              handling time is published from it.
              {Number(ct.unattributed) > 0
                && ` ${fmtNum(ct.unattributed)} call(s) carry no agent and appear in no row above.`}
            </div>
          )}
        </SectionCard>
      )}

      {tab === 'coverage' && (
        <SectionCard title="Where Performance Can Be Measured" padding={false}
          subtitle="Each row names the pair of columns that would constitute “done, by someone” for that source, and how much of it is actually filled in">
          <DataTable
            cols={coverageCols} rows={coverage} keyFn={r => r.source}
            searchKeys={['department', 'source']}
            searchPlaceholder="Search department or table…"
            loading={loading && !coverage.length} skeletonRows={8} pageSize={25}
            emptyText={<EmptyState icon="fact_check" title="Survey Unavailable" />}
          />
          <div style={{
            padding: SP[4], borderTop: '1px solid var(--card-bdr)',
            fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 'var(--lh-relaxed)',
          }}>
            A source marked <strong>no</strong> is not under-performing — nothing records who
            completed the work, so no per-person figure exists to report. Making one measurable is
            a change to the capture in that module, not to this page. A source marked{' '}
            <strong>one person only</strong> has attribution but too few people to compare.
          </div>
        </SectionCard>
      )}
    </Page>
  )
}
