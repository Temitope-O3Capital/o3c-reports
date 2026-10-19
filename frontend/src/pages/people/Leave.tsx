import { useEffect, useMemo, useState } from 'react'
import {
  Page, KpiCard, SectionCard, DataTable, ErrBanner, StatusBadge, NameCell, Pill,
  EmptyState, Tabs, Modal, Button, Input, Select, Textarea, Divider,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, unwrapList } from '../../lib/api'
import { fmtDate, fmtNum } from '../../lib/fmt'
import { NAVY, BLUE, GREEN, AMBER, RED, SP, FW } from '../../lib/design'

// LEAVE — requesting time off, approving it, and the days somebody was available.
//
// ONE PAGE, THREE AUDIENCES. The tabs are drawn from what /api/leave/me returns about
// the signed-in person — direct_reports decides whether Approvals appears,
// can_administer whether Administration does — rather than from their role. That is
// the same decision the API makes: approving leave follows from being somebody's line
// manager (o3c_users.manager_user_id), not from holding a grant. The frontend only
// chooses which tabs to draw; the server decides what each one may load, so hiding a
// tab is a convenience and never the access control.
//
// WHAT THIS PAGE REFUSES TO GUESS. Three states are shown as themselves instead of as
// a zero, because each is a data gap somebody has to close rather than a fact about
// the person:
//
//   no line manager      you cannot submit at all, and the page says who to ask
//   no entitlement row   the balance is "not set", never "0 days left"
//   no hire date         pro-rata cannot be computed, so none is displayed
//
// A leave balance that reads 0 when nobody has set an entitlement is the kind of
// number people plan around and then discover was never true.

interface Balance {
  leave_type_id: number
  leave_type: string
  days_entitled: number
  days_carried_over: number
  days_taken: number
  days_pending: number
  days_remaining: number
}

interface LeaveType {
  id: number
  name: string
  days_per_year: number
  is_paid: boolean
  requires_docs: boolean
  min_notice_days: number
  carry_over_max: number
}

interface Request {
  id: number
  user_id?: number
  full_name?: string
  department?: string | null
  leave_type: string | null
  leave_type_id?: number
  start_date: string
  end_date: string
  working_days: number
  status: string
  reason: string | null
  document_ref: string | null
  cover_name: string | null
  manager_name?: string | null
  manager_note?: string | null
  hr_note?: string | null
  manager_decided_at?: string | null
  hr_decided_at?: string | null
  created_at?: string
  can_cancel?: boolean
  short_notice?: boolean
  documents_outstanding?: boolean
  entitlement_missing?: boolean
  days_remaining?: number | null
  manager_decided_by_name?: string | null
  hr_decided_by_name?: string | null
}

interface Me {
  year: number
  me?: {
    id: number; full_name: string; department: string | null
    hire_date: string | null
    manager_user_id: number | null; manager_name: string | null
  }
  balances?: Balance[]
  entitlement_gaps?: { leave_type_id: number; leave_type: string; suggested_days: number | null }[]
  requests?: Request[]
  availability?: {
    working_days_ytd: number; available_days_ytd: number; on_leave_today: boolean
  }
  as_manager?: { awaiting_my_decision: number; routed_to_me_ever: number }
  direct_reports?: number
  can_administer?: boolean
}

const PENDING = ['pending_manager', 'pending_hr']

export default function Leave() {
  const [me, setMe] = useState<Me | null>(null)
  const [types, setTypes] = useState<LeaveType[]>([])
  const [tab, setTab] = useState('mine')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Tab payloads, loaded when their tab is first opened rather than up front: HR's
  // five lists are irrelevant to the 50 people who only ever request their own leave.
  const [approvals, setApprovals] = useState<Request[]>([])
  const [adminReqs, setAdminReqs] = useState<Request[]>([])
  const [gaps, setGaps] = useState<any[]>([])
  const [unmanaged, setUnmanaged] = useState<any[]>([])
  const [drift, setDrift] = useState<any[]>([])
  const [entitlements, setEntitlements] = useState<any[]>([])
  const [staff, setStaff] = useState<any[]>([])
  const [colleagues, setColleagues] = useState<{ id: number; full_name: string }[]>([])
  const [absences, setAbsences] = useState<any[]>([])

  const [showRequest, setShowRequest] = useState(false)
  const [decide, setDecide] = useState<{ req: Request; stage: 'manager' | 'hr' } | null>(null)
  const [showEntitlement, setShowEntitlement] = useState(false)

  async function loadMe() {
    setError(null)
    try {
      const [m, t, col, cal] = await Promise.all([
        apiFetch<{ data: Me }>('/api/leave/me'),
        apiFetch<any>('/api/leave/types'),
        apiFetch<any>('/api/leave/colleagues'),
        apiFetch<any>('/api/leave/calendar'),
      ])
      setMe(m?.data ?? null)
      setTypes(unwrapList<LeaveType>(t))
      setColleagues(unwrapList<{ id: number; full_name: string }>(col))
      setAbsences(cal?.data?.absences ?? [])
    } catch (e: any) {
      setError(e?.message ?? 'Could not load your leave record')
    } finally {
      setLoading(false)
    }
  }

  async function loadApprovals() {
    try {
      setApprovals(unwrapList<Request>(await apiFetch<any>('/api/leave/approvals')))
    } catch (e: any) { setError(e?.message ?? 'Could not load your approvals') }
  }

  async function loadAdmin() {
    try {
      const [reqs, ent, g, u, d, look] = await Promise.all([
        apiFetch<any>('/api/leave/admin/requests?status=outstanding'),
        apiFetch<any>('/api/leave/admin/entitlements'),
        apiFetch<any>('/api/leave/admin/gaps'),
        apiFetch<any>('/api/leave/admin/unmanaged'),
        apiFetch<any>('/api/leave/admin/drift'),
        apiFetch<any>('/api/leave/admin/lookups'),
      ])
      setAdminReqs(unwrapList<Request>(reqs))
      setEntitlements(unwrapList<any>(ent))
      setGaps(unwrapList<any>(g))
      setUnmanaged(unwrapList<any>(u))
      setDrift(unwrapList<any>(d))
      setStaff(look?.data?.staff ?? [])
    } catch (e: any) { setError(e?.message ?? 'Could not load leave administration') }
  }

  useEffect(() => { loadMe() }, [])
  useEffect(() => {
    if (tab === 'approvals') loadApprovals()
    if (tab === 'admin') loadAdmin()
  }, [tab])

  const noManager = !!me?.me && me.me.manager_user_id == null
  const av = me?.availability
  const annual = me?.balances?.find(b => /annual/i.test(b.leave_type))
  const myPending = (me?.requests ?? []).filter(r => PENDING.includes(r.status)).length

  const tabs = useMemo(() => {
    const t = [{ key: 'mine', label: 'My Leave' }]
    // Shown to anybody who manages somebody, even with an empty queue — a tab that
    // appears and vanishes with the queue is one people stop trusting.
    if ((me?.direct_reports ?? 0) > 0 || (me?.as_manager?.routed_to_me_ever ?? 0) > 0) {
      t.push({ key: 'approvals', label: 'Approvals', badge: me?.as_manager?.awaiting_my_decision || undefined } as any)
    }
    if (me?.can_administer) t.push({ key: 'admin', label: 'Administration' })
    return t
  }, [me])

  return (
    <Page
      title="Leave"
      subtitle="Request time off, approve your team's, and see the days people were actually available"
      loading={loading && !me}
      skeletonKpis={4}
    >
      <ErrBanner error={error} onRetry={() => { loadMe(); if (tab === 'approvals') loadApprovals(); if (tab === 'admin') loadAdmin() }} />

      <Tabs tabs={tabs as any} active={tab} onChange={setTab} />

      {tab === 'mine' && (
        <>
          {/* The blocking gap, stated before anything else: without a line manager
              there is nobody to approve a request, so the form would only fail. */}
          {noManager && (
            <SectionCard title="No Line Manager Recorded" style={{ marginBottom: SP[4] }}>
              <div style={{ display: 'flex', gap: SP[3], alignItems: 'flex-start' }}>
                <span className="material-symbols-rounded" style={{ color: AMBER, fontSize: 22 }}>info</span>
                <div style={{ color: 'var(--txt2)', lineHeight: 1.6 }}>
                  Leave is approved by your line manager and then confirmed by HR. Your account
                  has no line manager recorded, so there is nobody for a request to go to.
                  <strong style={{ color: 'var(--txt1)' }}> Ask HR to set your line manager</strong> and
                  this page will let you submit.
                </div>
              </div>
            </SectionCard>
          )}

          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
            gap: SP[3], marginBottom: SP[4],
          }}>
            <KpiCard
              label="Annual Leave Left"
              value={annual ? fmtNum(annual.days_remaining) : 'Not set'}
              sub={annual
                ? `${fmtNum(annual.days_entitled)} entitled${Number(annual.days_carried_over) > 0 ? ` + ${fmtNum(annual.days_carried_over)} carried` : ''} · ${fmtNum(annual.days_taken)} taken · ${fmtNum(annual.days_pending)} pending`
                : 'HR has not set your annual entitlement'}
              icon="beach_access"
              accent={annual ? NAVY : AMBER}
              loading={loading && !me}
            />
            <KpiCard
              label="Available Days This Year"
              value={fmtNum(av?.available_days_ytd)}
              sub={`Of ${fmtNum(av?.working_days_ytd)} working days so far — weekends and public holidays already excluded`}
              icon="event_available" accent={BLUE} loading={loading && !me}
            />
            <KpiCard
              label="Awaiting A Decision"
              value={fmtNum(myPending)}
              sub={myPending ? 'Your requests not yet approved' : 'Nothing of yours is pending'}
              icon="hourglass_top"
              accent={myPending ? AMBER : GREEN}
              loading={loading && !me}
            />
            <KpiCard
              label="On Leave Today"
              value={av?.on_leave_today ? 'Yes' : 'No'}
              sub={me?.me?.manager_name ? `Approved by ${me.me.manager_name}, confirmed by HR` : 'Your approval route'}
              icon="today"
              accent={av?.on_leave_today ? BLUE : GREEN}
              loading={loading && !me}
            />
          </div>

          <SectionCard
            title="My Balances"
            actions={
              <Button icon="add" onClick={() => setShowRequest(true)} disabled={noManager}>
                Request Leave
              </Button>
            }
            style={{ marginBottom: SP[4] }}
          >
            {(me?.balances ?? []).length === 0 ? (
              <EmptyState
                icon="rule"
                title="No entitlement has been set for you yet"
                description="HR sets how many days of each leave type you have each year. Until then this page cannot show a balance — and it will not show zero, because zero is not what it means."
              />
            ) : (
              <DataTable
                rows={me!.balances!}
                cols={balanceCols}
                keyFn={(r: Balance) => String(r.leave_type_id)}
              />
            )}
            {/* Types with no entitlement row. Listed so the gap is chased rather than
                read as "no days". */}
            {(me?.entitlement_gaps ?? []).length > 0 && (
              <>
                <Divider />
                <div style={{ color: 'var(--txt2)', fontSize: 13, lineHeight: 1.7 }}>
                  <strong style={{ color: 'var(--txt1)' }}>Not set for {me!.year}: </strong>
                  {me!.entitlement_gaps!.map(g => g.leave_type).join(', ')}.
                  {' '}These have no entitlement recorded, which is different from having none left.
                </div>
              </>
            )}
          </SectionCard>

          <SectionCard title="My Requests" style={{ marginBottom: SP[4] }}>
            {(me?.requests ?? []).length === 0 ? (
              <EmptyState icon="event_busy" title="You have not requested any leave" />
            ) : (
              <DataTable
                rows={me!.requests!}
                cols={myRequestCols(async (r) => {
                  await apiFetch(`/api/leave/requests/${r.id}/cancel`, { method: 'POST' })
                  loadMe()
                })}
                keyFn={(r: Request) => String(r.id)}
              />
            )}
          </SectionCard>

          {/* Who is out over the next two months. Open to everybody, because covering
              somebody's work means knowing they are away — but the API withholds the
              leave TYPE per row unless you are the person, their manager, or HR, so
              "on sick leave" is never broadcast to the floor. */}
          <SectionCard
            title="Who Is Off"
            subtitle="The next 60 days. The kind of leave is shown only where you are the person, their line manager, or HR."
          >
            {absences.length === 0 ? (
              <EmptyState icon="groups" title="Nobody has leave booked in the next 60 days" />
            ) : (
              <DataTable
                rows={absences}
                cols={absenceCols}
                keyFn={(r: any) => String(r.leave_request_id)}
              />
            )}
          </SectionCard>
        </>
      )}

      {tab === 'approvals' && (
        <SectionCard title="Waiting On You">
          {approvals.length === 0 ? (
            <EmptyState
              icon="task_alt"
              title="Nothing is waiting on your decision"
              description="Leave requested by the people who report to you appears here first, before HR confirms it."
            />
          ) : (
            <DataTable
              rows={approvals}
              cols={approvalCols(r => setDecide({ req: r, stage: 'manager' }))}
              keyFn={(r: Request) => String(r.id)}
            />
          )}
        </SectionCard>
      )}

      {tab === 'admin' && (
        <>
          <SectionCard title="Awaiting HR Confirmation" style={{ marginBottom: SP[4] }}>
            {adminReqs.length === 0 ? (
              <EmptyState icon="done_all" title="Nothing is awaiting confirmation" />
            ) : (
              <DataTable
                rows={adminReqs}
                cols={adminRequestCols(r => setDecide({ req: r, stage: 'hr' }))}
                keyFn={(r: Request) => String(r.id)}
              />
            )}
          </SectionCard>

          {/* The list that has to be empty before anybody can request leave at all. */}
          <SectionCard
            title="Staff With No Line Manager"
            subtitle="Nobody on this list can submit a leave request, because there is nobody to approve it"
            style={{ marginBottom: SP[4] }}
          >
            {unmanaged.length === 0 ? (
              <EmptyState icon="verified" title="Every active member of staff has a line manager" />
            ) : (
              <DataTable rows={unmanaged} cols={unmanagedCols} keyFn={(r: any) => String(r.user_id)} />
            )}
          </SectionCard>

          <SectionCard
            title="Entitlements"
            subtitle="What each person has this year. Days taken and remaining are derived from approved requests, never stored."
            actions={<Button icon="add" onClick={() => setShowEntitlement(true)}>Set Entitlement</Button>}
            style={{ marginBottom: SP[4] }}
          >
            {entitlements.length === 0 ? (
              <EmptyState icon="rule" title="No entitlements have been set yet" />
            ) : (
              <DataTable
                rows={entitlements}
                cols={entitlementCols}
                keyFn={(r: any) => `${r.user_id}-${r.leave_type_id}-${r.year}`}
              />
            )}
          </SectionCard>

          <SectionCard
            title="Missing Entitlements"
            subtitle="Active staff with no entitlement recorded for a leave type this year. Suggested days are pro-rata from the hire date, and blank where no hire date is recorded."
            style={{ marginBottom: SP[4] }}
          >
            {gaps.length === 0 ? (
              <EmptyState icon="verified" title="Every active member of staff has every entitlement set" />
            ) : (
              <DataTable rows={gaps} cols={gapCols} keyFn={(r: any) => `${r.user_id}-${r.leave_type_id}`} />
            )}
          </SectionCard>

          {/* Surfaced, never applied: a holiday declared after leave was agreed. */}
          <SectionCard
            title="Day-Count Drift"
            subtitle="Approved leave whose agreed day count no longer matches the calendar, because a public holiday was declared afterwards. Crediting a day back restates an agreed balance, so it is HR's decision and is not applied automatically."
          >
            {drift.length === 0 ? (
              <EmptyState icon="verified" title="Every approved period still matches the calendar" />
            ) : (
              <DataTable rows={drift} cols={driftCols} keyFn={(r: any) => String(r.leave_request_id)} />
            )}
          </SectionCard>
        </>
      )}

      <RequestModal
        open={showRequest}
        onClose={() => setShowRequest(false)}
        types={types}
        colleagues={colleagues}
        onDone={() => { setShowRequest(false); loadMe() }}
      />

      <DecisionModal
        decide={decide}
        onClose={() => setDecide(null)}
        onDone={() => {
          setDecide(null)
          loadMe()
          if (tab === 'approvals') loadApprovals()
          if (tab === 'admin') loadAdmin()
        }}
      />

      <EntitlementModal
        open={showEntitlement}
        onClose={() => setShowEntitlement(false)}
        staff={staff}
        types={types}
        onDone={() => { setShowEntitlement(false); loadAdmin() }}
      />
    </Page>
  )
}

/* ── Columns ────────────────────────────────────────────────────────────────── */

const days = (v: any) => <span style={{ fontWeight: FW.semibold }}>{fmtNum(v)}</span>

const balanceCols: TableCol<Balance>[] = [
  { key: 'leave_type', label: 'Leave Type', sortable: true, width: 190 },
  { key: 'days_entitled', label: 'Entitled', sortable: true, width: 100, render: r => days(r.days_entitled) },
  { key: 'days_carried_over', label: 'Carried Over', sortable: true, width: 120, render: r => days(r.days_carried_over) },
  { key: 'days_taken', label: 'Taken', sortable: true, width: 90, render: r => days(r.days_taken) },
  { key: 'days_pending', label: 'Pending', sortable: true, width: 100, render: r => days(r.days_pending) },
  {
    key: 'days_remaining', label: 'Remaining', sortable: true, width: 110,
    render: r => (
      <span style={{
        fontWeight: FW.bold,
        color: Number(r.days_remaining) < 0 ? RED : Number(r.days_remaining) === 0 ? AMBER : GREEN,
      }}>{fmtNum(r.days_remaining)}</span>
    ),
  },
]

// The period column reads as one fact rather than two dates: "14 Dec – 18 Dec (5 days)"
// is how somebody thinks about leave, and the day count is the working-day count the
// calendar produced, not the span.
function periodCell(r: Request) {
  return (
    <div>
      <div style={{ fontWeight: FW.medium }}>{fmtDate(r.start_date)} – {fmtDate(r.end_date)}</div>
      <div style={{ color: 'var(--txt3)', fontSize: 12 }}>
        {fmtNum(r.working_days)} working {Number(r.working_days) === 1 ? 'day' : 'days'}
      </div>
    </div>
  )
}

function flagPills(r: Request) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {r.short_notice && <Pill label="Short notice" color={AMBER} bg="rgba(245,158,11,.12)" />}
      {r.documents_outstanding && <Pill label="No document" color={AMBER} bg="rgba(245,158,11,.12)" />}
      {r.entitlement_missing && <Pill label="No entitlement set" color={RED} bg="rgba(239,68,68,.10)" />}
      {typeof r.days_remaining === 'number' && r.days_remaining < 0 &&
        <Pill label="Over entitlement" color={RED} bg="rgba(239,68,68,.10)" />}
    </div>
  )
}

function myRequestCols(onCancel: (r: Request) => void): TableCol<Request>[] {
  return [
    { key: 'leave_type', label: 'Type', sortable: true, width: 160 },
    { key: 'start_date', label: 'Period', sortable: true, width: 200, render: periodCell },
    { key: 'status', label: 'Status', sortable: true, width: 150, render: r => <StatusBadge status={r.status} /> },
    { key: 'manager_name', label: 'Approver', sortable: true, width: 160, render: r => r.manager_name ?? '—' },
    { key: 'cover_name', label: 'Cover', sortable: true, width: 150, render: r => r.cover_name ?? '—' },
    {
      key: 'reason', label: 'Notes', width: 220,
      render: r => (
        <span style={{ color: 'var(--txt2)', fontSize: 12.5 }}>
          {r.hr_note || r.manager_note || r.reason || '—'}
        </span>
      ),
    },
    {
      key: 'id', label: '', width: 110,
      render: r => r.can_cancel
        ? <Button variant="secondary" size="xs" onClick={() => onCancel(r)}>Cancel</Button>
        : null,
    },
  ]
}

function approvalCols(onDecide: (r: Request) => void): TableCol<Request>[] {
  return [
    {
      key: 'full_name', label: 'Who', sortable: true, width: 200,
      render: r => <NameCell name={r.full_name ?? ''} sub={r.department ?? undefined} />,
    },
    { key: 'leave_type', label: 'Type', sortable: true, width: 150, render: r => r.leave_type ?? '—' },
    { key: 'start_date', label: 'Period', sortable: true, width: 200, render: periodCell },
    { key: 'cover_name', label: 'Cover', sortable: true, width: 140, render: r => r.cover_name ?? '—' },
    { key: 'reason', label: 'Reason', width: 200, render: r => r.reason ?? '—' },
    { key: 'short_notice', label: 'Flags', width: 190, render: flagPills },
    {
      key: 'id', label: '', width: 110,
      render: r => r.status === 'pending_manager'
        ? <Button size="xs" onClick={() => onDecide(r)}>Decide</Button>
        : <StatusBadge status={r.status} />,
    },
  ]
}

function adminRequestCols(onDecide: (r: Request) => void): TableCol<Request>[] {
  return [
    {
      key: 'full_name', label: 'Who', sortable: true, width: 190,
      render: r => <NameCell name={r.full_name ?? ''} sub={r.department ?? undefined} />,
    },
    { key: 'leave_type', label: 'Type', sortable: true, width: 140, render: r => r.leave_type ?? '—' },
    { key: 'start_date', label: 'Period', sortable: true, width: 190, render: periodCell },
    { key: 'status', label: 'Status', sortable: true, width: 150, render: r => <StatusBadge status={r.status} /> },
    {
      key: 'manager_decided_by_name', label: 'Manager Approved', sortable: true, width: 180,
      render: r => r.manager_decided_at
        ? <div><div>{r.manager_decided_by_name ?? '—'}</div>
            <div style={{ color: 'var(--txt3)', fontSize: 12 }}>{fmtDate(r.manager_decided_at)}</div></div>
        : <span style={{ color: 'var(--txt3)' }}>Not yet</span>,
    },
    { key: 'documents_outstanding', label: 'Flags', width: 170, render: flagPills },
    {
      key: 'id', label: '', width: 120,
      render: r => r.status === 'pending_hr'
        ? <Button size="xs" onClick={() => onDecide(r)}>Confirm</Button>
        : <span style={{ color: 'var(--txt3)', fontSize: 12 }}>With manager</span>,
    },
  ]
}

const unmanagedCols: TableCol<any>[] = [
  { key: 'full_name', label: 'Name', sortable: true, width: 220, render: r => <NameCell name={r.full_name} sub={r.department ?? undefined} /> },
  { key: 'department', label: 'Department', sortable: true, width: 170, render: r => r.department ?? '—' },
  {
    key: 'hire_date_missing', label: 'Hire Date', sortable: true, width: 160,
    render: r => r.hire_date
      ? fmtDate(r.hire_date)
      : <Pill label="Not recorded" color={AMBER} bg="rgba(245,158,11,.12)" />,
  },
]

const entitlementCols: TableCol<any>[] = [
  { key: 'full_name', label: 'Name', sortable: true, width: 200, render: r => <NameCell name={r.full_name} /> },
  { key: 'leave_type', label: 'Type', sortable: true, width: 160 },
  { key: 'year', label: 'Year', sortable: true, width: 80 },
  { key: 'days_entitled', label: 'Entitled', sortable: true, width: 100, render: r => days(r.days_entitled) },
  { key: 'days_carried_over', label: 'Carried', sortable: true, width: 100, render: r => days(r.days_carried_over) },
  { key: 'days_taken', label: 'Taken', sortable: true, width: 90, render: r => days(r.days_taken) },
  { key: 'days_remaining', label: 'Remaining', sortable: true, width: 110, render: r => days(r.days_remaining) },
]

const gapCols: TableCol<any>[] = [
  { key: 'full_name', label: 'Name', sortable: true, width: 200, render: r => <NameCell name={r.full_name} sub={r.department ?? undefined} /> },
  { key: 'leave_type', label: 'Type', sortable: true, width: 170 },
  {
    key: 'suggested_days', label: 'Suggested (Pro-Rata)', sortable: true, width: 190,
    render: r => r.suggested_days == null
      ? <Pill label="No hire date" color={AMBER} bg="rgba(245,158,11,.12)" />
      : days(r.suggested_days),
  },
  { key: 'hire_date', label: 'Hire Date', sortable: true, width: 140, render: r => r.hire_date ? fmtDate(r.hire_date) : '—' },
]

const absenceCols: TableCol<any>[] = [
  { key: 'full_name', label: 'Who', sortable: true, width: 200, render: r => <NameCell name={r.full_name} sub={r.department ?? undefined} /> },
  { key: 'start_date', label: 'Period', sortable: true, width: 200, render: periodCell },
  {
    // Null is the privacy rule doing its job, not missing data, so it is labelled.
    key: 'leave_type', label: 'Type', sortable: true, width: 150,
    render: r => r.leave_type ?? <span style={{ color: 'var(--txt3)' }}>Not shown</span>,
  },
  { key: 'status', label: 'Status', sortable: true, width: 150, render: r => <StatusBadge status={r.status} /> },
  { key: 'cover_name', label: 'Cover', sortable: true, width: 160, render: r => r.cover_name ?? '—' },
]

const driftCols: TableCol<any>[] = [
  { key: 'full_name', label: 'Name', sortable: true, width: 190, render: r => <NameCell name={r.full_name} /> },
  { key: 'start_date', label: 'Period', sortable: true, width: 190, render: r => `${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}` },
  { key: 'days_agreed', label: 'Agreed', sortable: true, width: 100, render: r => days(r.days_agreed) },
  { key: 'days_by_calendar_now', label: 'Calendar Now', sortable: true, width: 130, render: r => days(r.days_by_calendar_now) },
  {
    key: 'difference', label: 'Difference', sortable: true, width: 120,
    render: r => (
      <span style={{ fontWeight: FW.bold, color: Number(r.difference) < 0 ? GREEN : AMBER }}>
        {Number(r.difference) > 0 ? '+' : ''}{fmtNum(r.difference)}
      </span>
    ),
  },
]

/* ── Request form ───────────────────────────────────────────────────────────── */

function RequestModal({ open, onClose, types, colleagues, onDone }: {
  open: boolean; onClose: () => void; types: LeaveType[]
  colleagues: { id: number; full_name: string }[]; onDone: () => void
}) {
  const [typeID, setTypeID] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [reason, setReason] = useState('')
  const [doc, setDoc] = useState('')
  const [cover, setCover] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const t = types.find(x => String(x.id) === typeID)

  async function submit() {
    setBusy(true); setErr(null)
    try {
      await apiFetch('/api/leave/requests', {
        method: 'POST',
        body: JSON.stringify({
          leave_type_id: Number(typeID),
          start_date: start,
          end_date: end,
          reason,
          document_ref: doc,
          // Omitted rather than sent as 0 when nobody is named: the column is a
          // nullable foreign key, and 0 is not a user.
          cover_user_id: cover ? Number(cover) : null,
        }),
      })
      setTypeID(''); setStart(''); setEnd(''); setReason(''); setDoc(''); setCover('')
      onDone()
    } catch (e: any) {
      setErr(e?.message ?? 'Could not submit the request')
    } finally { setBusy(false) }
  }

  const ready = typeID && start && end

  return (
    <Modal open={open} onClose={onClose} title="Request Leave" width={560}
      footer={
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={busy} disabled={!ready}>Submit</Button>
        </div>
      }>
      {err && <div style={{ color: RED, marginBottom: SP[3], fontSize: 13 }}>{err}</div>}

      <Select label="Leave Type" required value={typeID} onChange={e => setTypeID(e.target.value)}>
        <option value="">Choose a leave type…</option>
        {types.map(x => (
          <option key={x.id} value={x.id}>
            {x.name} — {fmtNum(x.days_per_year)} days a year{x.is_paid ? '' : ' (unpaid)'}
          </option>
        ))}
      </Select>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
        <Input label="First Day" type="date" required value={start} onChange={e => setStart(e.target.value)} />
        <Input label="Last Day" type="date" required value={end} onChange={e => setEnd(e.target.value)} />
      </div>

      {/* The working-day count is deliberately NOT computed here. The browser does not
          know the public-holiday calendar, and a figure that disagreed with the one the
          database stamps would be worse than no figure. */}
      <div style={{ color: 'var(--txt3)', fontSize: 12.5, marginTop: -SP[1], marginBottom: SP[3], lineHeight: 1.6 }}>
        Weekends and public holidays are not counted. The exact number of leave days is
        worked out from the company calendar when you submit.
      </div>

      {t && t.min_notice_days > 0 && (
        <div style={{ color: 'var(--txt2)', fontSize: 12.5, marginBottom: SP[3] }}>
          {t.name} normally needs {t.min_notice_days} days' notice. A shorter request is still
          submitted — your manager simply sees that it was short notice.
        </div>
      )}

      <Select label="Cover" value={cover} onChange={e => setCover(e.target.value)}
        hint="Who picks up your work while you are away. Optional, and your own department only.">
        <option value="">Nobody named</option>
        {colleagues.map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}
      </Select>

      <Textarea label="Reason" rows={3} value={reason} onChange={e => setReason(e.target.value)}
        hint="Seen by your line manager and HR" />

      {t?.requires_docs && (
        <Input label="Supporting Document" value={doc} onChange={e => setDoc(e.target.value)}
          hint={`${t.name} normally needs supporting documentation. You can submit without it and provide it later.`} />
      )}
    </Modal>
  )
}

/* ── Decision ───────────────────────────────────────────────────────────────── */

function DecisionModal({ decide, onClose, onDone }: {
  decide: { req: Request; stage: 'manager' | 'hr' } | null
  onClose: () => void; onDone: () => void
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { setNote(''); setErr(null) }, [decide?.req?.id])

  if (!decide) return null
  const { req, stage } = decide
  const path = stage === 'manager' ? 'manager-decision' : 'hr-decision'

  async function send(decision: 'approve' | 'reject') {
    if (decision === 'reject' && !note.trim()) {
      setErr('Please give a reason when rejecting a request')
      return
    }
    setBusy(decision); setErr(null)
    try {
      await apiFetch(`/api/leave/requests/${req.id}/${path}`, {
        method: 'POST',
        body: JSON.stringify({ decision, note }),
      })
      onDone()
    } catch (e: any) {
      setErr(e?.message ?? 'Could not record the decision')
    } finally { setBusy(null) }
  }

  return (
    <Modal open onClose={onClose}
      title={stage === 'manager' ? 'Approve Or Reject' : 'Confirm Leave'}
      width={520}
      footer={
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button variant="danger" onClick={() => send('reject')} loading={busy === 'reject'}>Reject</Button>
          <Button onClick={() => send('approve')} loading={busy === 'approve'}>
            {stage === 'manager' ? 'Approve' : 'Confirm'}
          </Button>
        </div>
      }>
      {err && <div style={{ color: RED, marginBottom: SP[3], fontSize: 13 }}>{err}</div>}

      <div style={{ marginBottom: SP[3], lineHeight: 1.8 }}>
        <div style={{ fontWeight: FW.semibold, fontSize: 15 }}>{req.full_name}</div>
        <div style={{ color: 'var(--txt2)' }}>
          {req.leave_type ?? 'Leave'} · {fmtDate(req.start_date)} – {fmtDate(req.end_date)} ·{' '}
          {fmtNum(req.working_days)} working {Number(req.working_days) === 1 ? 'day' : 'days'}
        </div>
        {req.cover_name && <div style={{ color: 'var(--txt2)' }}>Cover: {req.cover_name}</div>}
        {req.reason && <div style={{ color: 'var(--txt2)' }}>Reason: {req.reason}</div>}
      </div>

      {flagPills(req)}

      {stage === 'manager' && (
        <div style={{ color: 'var(--txt3)', fontSize: 12.5, margin: `${SP[3]} 0`, lineHeight: 1.6 }}>
          Approving passes this to HR to confirm. It is not booked until HR confirms it.
        </div>
      )}

      <Textarea label="Note" rows={3} value={note} onChange={e => setNote(e.target.value)}
        hint="Required when rejecting. Visible to the person who asked." />
    </Modal>
  )
}

/* ── Entitlement ────────────────────────────────────────────────────────────── */

function EntitlementModal({ open, onClose, staff, types, onDone }: {
  open: boolean; onClose: () => void; staff: any[]; types: LeaveType[]; onDone: () => void
}) {
  const [userID, setUserID] = useState('')
  const [typeID, setTypeID] = useState('')
  const [year, setYear] = useState(String(new Date().getFullYear()))
  const [entitled, setEntitled] = useState('')
  const [carried, setCarried] = useState('0')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const t = types.find(x => String(x.id) === typeID)

  // The standard is offered as the default the moment a type is chosen, so the common
  // case is one click rather than a typed number — but it stays editable, because an
  // individual variation from the standard is exactly what this table exists to hold.
  useEffect(() => { if (t) setEntitled(String(t.days_per_year)) }, [typeID])

  async function save() {
    setBusy(true); setErr(null)
    try {
      await apiFetch('/api/leave/admin/entitlements', {
        method: 'POST',
        body: JSON.stringify({
          user_id: Number(userID),
          leave_type_id: Number(typeID),
          year: Number(year),
          days_entitled: Number(entitled),
          days_carried_over: Number(carried || 0),
          notes,
        }),
      })
      setUserID(''); setTypeID(''); setEntitled(''); setCarried('0'); setNotes('')
      onDone()
    } catch (e: any) {
      setErr(e?.message ?? 'Could not save the entitlement')
    } finally { setBusy(false) }
  }

  const ready = userID && typeID && year && entitled !== ''

  return (
    <Modal open={open} onClose={onClose} title="Set Entitlement" width={560}
      footer={
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={busy} disabled={!ready}>Save</Button>
        </div>
      }>
      {err && <div style={{ color: RED, marginBottom: SP[3], fontSize: 13 }}>{err}</div>}

      <Select label="Member Of Staff" required value={userID} onChange={e => setUserID(e.target.value)}>
        <option value="">Choose somebody…</option>
        {staff.map(s => (
          <option key={s.id} value={s.id}>
            {s.full_name}{s.department ? ` — ${s.department}` : ''}
          </option>
        ))}
      </Select>

      <Select label="Leave Type" required value={typeID} onChange={e => setTypeID(e.target.value)}>
        <option value="">Choose a leave type…</option>
        {types.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
      </Select>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: SP[3] }}>
        <Input label="Year" type="number" required value={year} onChange={e => setYear(e.target.value)} />
        <Input label="Days Entitled" type="number" step="0.5" required value={entitled}
          onChange={e => setEntitled(e.target.value)}
          hint={t ? `Standard is ${fmtNum(t.days_per_year)}` : undefined} />
        <Input label="Carried Over" type="number" step="0.5" value={carried}
          onChange={e => setCarried(e.target.value)}
          hint={t ? `Policy max ${fmtNum(t.carry_over_max)}` : undefined} />
      </div>

      <Textarea label="Notes" rows={2} value={notes} onChange={e => setNotes(e.target.value)}
        hint="Why this differs from the standard, if it does" />
    </Modal>
  )
}
