import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, KpiCard, SectionCard, ErrBanner, DataTable, EmptyState, Tabs,
  Button, Badge, SegmentedToggle,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, today } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, NUM, TEXT, FW, SP } from '../../lib/design'
import { humanLabel } from '../../lib/labels'

/*
  WORK & INCIDENTS, ACROSS THE WHOLE FLEET.

  The vehicle page answers "what has happened to this car". This answers the
  question a COO actually asks: "what is overdue, anywhere, and what did the
  workshop cost us this year" — which cannot be reached by opening vehicles one
  at a time.

  It is also what the two fleet-wide list endpoints were written for. They were
  mounted and guarded and had no caller, so the only view of maintenance was the
  per-vehicle one, and nothing surfaced an overdue renewal on a vehicle nobody
  happened to open.

  Overdue is computed against next_due_on only. A kilometre-based due point
  (next_due_km) cannot be judged here without each vehicle's latest reading, so
  it is shown as a figure and never silently treated as met or missed.
*/

interface MaintRow {
  id: number
  vehicle_id: number
  reg_no: string
  kind: string
  performed_on: string
  vendor: string | null
  cost_kobo: number
  odometer_km: number | null
  next_due_on: string | null
  next_due_km: number | null
  description: string | null
  invoice_ref: string | null
}

interface IncRow {
  id: number
  vehicle_id: number
  reg_no: string
  occurred_on: string
  kind: string
  description: string | null
  cost_kobo: number
  resolved_on: string | null
  reported_by_name: string
}

interface CoverRow {
  vehicle_id: number
  reg_no: string
  vehicle_status: string
  policy_id: number | null
  insurer: string | null
  policy_no: string | null
  cover_type: string | null
  sum_insured_kobo: number | null
  premium_kobo: number | null
  cover_from: string | null
  cover_to: string | null
  cover_state: string
  days_to_expiry: number | null
}

type Scope = 'all' | 'overdue' | 'due_soon'

/* 'unknown' is held apart from 'expired' throughout: the register not holding a
   policy is not evidence that a vehicle is uninsured, and saying so about a legal
   exposure would be a confident wrong answer. */
const COVER_TONE: Record<string, string> = {
  covered: GREEN, expiring: AMBER, expired: RED, unknown: 'var(--txt3)',
}
const COVER_LABEL: Record<string, string> = {
  covered: 'Covered', expiring: 'Expiring', expired: 'Expired', unknown: 'No Policy On Record',
}

function plusDays(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

export default function FleetWork() {
  const navigate = useNavigate()
  const [maint, setMaint] = useState<MaintRow[]>([])
  const [incidents, setIncidents] = useState<IncRow[]>([])
  const [cover, setCover] = useState<CoverRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState('work')
  const [scope, setScope] = useState<Scope>('all')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [m, i, c] = await Promise.all([
        apiFetch<{ data: MaintRow[] }>('/api/fleet/maintenance'),
        apiFetch<{ data: IncRow[] }>('/api/fleet/incidents'),
        apiFetch<{ data: CoverRow[] }>('/api/fleet/cover'),
      ])
      setMaint(m.data ?? [])
      setIncidents(i.data ?? [])
      setCover(c.data ?? [])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load the fleet work register')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const t = today()
  const in30 = plusDays(30)

  const overdue  = useMemo(() => maint.filter(m => m.next_due_on && m.next_due_on < t), [maint, t])
  const dueSoon  = useMemo(
    () => maint.filter(m => m.next_due_on && m.next_due_on >= t && m.next_due_on <= in30),
    [maint, t, in30])

  const shown = useMemo(() => {
    if (scope === 'overdue')  return overdue
    if (scope === 'due_soon') return dueSoon
    return maint
  }, [scope, maint, overdue, dueSoon])

  const workCost = useMemo(() => maint.reduce((s, m) => s + Number(m.cost_kobo), 0), [maint])
  const incCost  = useMemo(() => incidents.reduce((s, x) => s + Number(x.cost_kobo), 0), [incidents])
  const openInc  = useMemo(() => incidents.filter(x => !x.resolved_on), [incidents])
  const vehiclesWithWork = useMemo(
    () => new Set(maint.map(m => m.vehicle_id)).size, [maint])

  const coverExpired  = useMemo(() => cover.filter(c => c.cover_state === 'expired'), [cover])
  const coverExpiring = useMemo(() => cover.filter(c => c.cover_state === 'expiring'), [cover])
  const coverUnknown  = useMemo(() => cover.filter(c => c.cover_state === 'unknown'), [cover])

  const regCell = (reg: string, vehicleID: number) => (
    <button type="button" onClick={() => navigate(`/fleet/vehicles/${vehicleID}`)}
      style={{
        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        fontFamily: 'var(--font-mono)', fontSize: TEXT.sm, fontWeight: FW.semibold,
        color: NAVY, textDecoration: 'underline', textUnderlineOffset: 2,
      }}>{reg}</button>
  )

  const workCols: TableCol<MaintRow>[] = [
    { key: 'reg_no', label: 'Vehicle', sortable: true, width: 120,
      render: r => regCell(r.reg_no, r.vehicle_id) },
    { key: 'performed_on', label: 'Done On', sortable: true, width: 115,
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtDate(r.performed_on)}</span> },
    { key: 'kind', label: 'Work', sortable: true, width: 130,
      render: r => <Badge variant="default">{humanLabel(r.kind)}</Badge> },
    { key: 'vendor', label: 'Vendor', sortable: true,
      render: r => (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.vendor || '—'}</div>
          {r.description && (
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.description}</div>
          )}
        </div>
      ) },
    { key: 'cost_kobo', label: 'Cost', align: 'right', sortable: true, width: 130,
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(r.cost_kobo)}</span> },
    { key: 'next_due_on', label: 'Next Due', sortable: true, width: 160,
      render: r => {
        if (!r.next_due_on && !r.next_due_km) return <span style={{ color: 'var(--txt3)' }}>—</span>
        const isOverdue = r.next_due_on != null && r.next_due_on < t
        const isSoon = r.next_due_on != null && !isOverdue && r.next_due_on <= in30
        return (
          <div style={{ minWidth: 0 }}>
            {r.next_due_on && (
              <div style={{
                ...NUM, fontSize: TEXT.sm,
                color: isOverdue ? RED : isSoon ? AMBER : 'var(--txt2)',
                fontWeight: isOverdue || isSoon ? FW.semibold : FW.normal,
              }}>
                {fmtDate(r.next_due_on)}{isOverdue ? ' · overdue' : isSoon ? ' · soon' : ''}
              </div>
            )}
            {r.next_due_km && (
              <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                or at {fmtNum(r.next_due_km)} km
              </div>
            )}
          </div>
        )
      } },
    { key: 'invoice_ref', label: 'Invoice', width: 110,
      render: r => r.invoice_ref
        ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs, color: 'var(--txt2)' }}>{r.invoice_ref}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span> },
  ]

  const incCols: TableCol<IncRow>[] = [
    { key: 'reg_no', label: 'Vehicle', sortable: true, width: 120,
      render: r => regCell(r.reg_no, r.vehicle_id) },
    { key: 'occurred_on', label: 'Occurred', sortable: true, width: 115,
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtDate(r.occurred_on)}</span> },
    { key: 'kind', label: 'Kind', sortable: true, width: 120,
      render: r => <Badge variant={r.kind === 'accident' || r.kind === 'theft' ? 'danger' : 'warning'}>
        {humanLabel(r.kind)}</Badge> },
    { key: 'description', label: 'What Happened',
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.description || '—'}</span> },
    { key: 'cost_kobo', label: 'Cost', align: 'right', sortable: true, width: 130,
      render: r => Number(r.cost_kobo) > 0
        ? <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(r.cost_kobo)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span> },
    { key: 'resolved_on', label: 'Status', width: 130,
      render: r => r.resolved_on
        ? <span style={{ fontSize: TEXT.sm, color: GREEN }}>closed {fmtDate(r.resolved_on)}</span>
        : <Badge variant="warning">open</Badge> },
    { key: 'reported_by_name', label: 'Reported By', width: 140,
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.reported_by_name || '—'}</span> },
  ]

  const coverCols: TableCol<CoverRow>[] = [
    { key: 'reg_no', label: 'Vehicle', sortable: true, width: 120,
      render: r => regCell(r.reg_no, r.vehicle_id) },
    { key: 'cover_state', label: 'Cover', sortable: true, width: 170, render: r => (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: TEXT.sm, fontWeight: FW.semibold,
        color: COVER_TONE[r.cover_state] ?? 'var(--txt3)',
      }}>
        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 16 }}>
          {r.cover_state === 'covered' ? 'verified_user'
            : r.cover_state === 'unknown' ? 'help' : 'gpp_maybe'}
        </span>
        {COVER_LABEL[r.cover_state] ?? humanLabel(r.cover_state)}
      </span>
    ) },
    { key: 'insurer', label: 'Insurer', sortable: true, render: r => r.insurer
      ? (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.insurer}</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs, color: 'var(--txt3)' }}>
            {r.policy_no || 'no policy number'}
            {r.cover_type ? ` · ${humanLabel(r.cover_type)}` : ''}
          </div>
        </div>
      )
      : <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>nothing recorded</span> },
    { key: 'cover_to', label: 'Expires', sortable: true, width: 160, render: r => {
      if (!r.cover_to) return <span style={{ color: 'var(--txt3)' }}>—</span>
      const d = r.days_to_expiry
      return (
        <div style={{ minWidth: 0 }}>
          <div style={{ ...NUM, fontSize: TEXT.sm }}>{fmtDate(r.cover_to)}</div>
          <div style={{
            fontSize: TEXT.xs,
            color: d != null && d < 0 ? RED : d != null && d <= 30 ? AMBER : 'var(--txt3)',
          }}>
            {d == null ? '' : d < 0 ? `lapsed ${fmtNum(Math.abs(d))} day(s) ago` : `${fmtNum(d)} day(s) left`}
          </div>
        </div>
      )
    } },
    { key: 'sum_insured_kobo', label: 'Sum Insured', align: 'right', sortable: true, width: 140,
      render: r => Number(r.sum_insured_kobo ?? 0) > 0
        ? <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(Number(r.sum_insured_kobo))}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span> },
    { key: 'premium_kobo', label: 'Premium', align: 'right', sortable: true, width: 130,
      render: r => Number(r.premium_kobo ?? 0) > 0
        ? <span style={NUM}>{fmtKobo(Number(r.premium_kobo))}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span> },
  ]

  const nothingYet = !loading && maint.length === 0 && incidents.length === 0 && cover.length === 0

  return (
    <Page
      title="Work & Incidents"
      subtitle="Every job and every incident across the fleet, and what is falling due"
      loading={loading && !maint.length && !incidents.length}
      skeletonKpis={4}
      back={{ label: 'Fleet', to: '/fleet' }}
      actions={
        <Button size="sm" variant="secondary" icon="directions_car"
          onClick={() => navigate('/fleet')}>Fleet Overview</Button>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* Overdue outranks cost: a lapsed insurance or roadworthiness certificate is a
          legal exposure, not an expense line, so it is said before the totals. */}
      {overdue.length > 0 && (
        <div role="alert" style={{
          display: 'flex', alignItems: 'flex-start', gap: SP[3],
          padding: SP[4], marginBottom: SP[5], borderRadius: 10,
          background: 'var(--card)', border: '1px solid var(--card-bdr)',
          borderLeft: `4px solid ${RED}`, boxShadow: 'var(--card-shadow)',
        }}>
          <span className="material-symbols-rounded" aria-hidden="true"
            style={{ fontSize: 22, color: RED, flexShrink: 0, marginTop: 1 }}>error</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>
              {fmtNum(overdue.length)} job(s) are past their due date
            </div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 3, lineHeight: 'var(--lh-relaxed)' }}>
              Across {fmtNum(new Set(overdue.map(m => m.vehicle_id)).size)} vehicle(s). Licences,
              insurance and roadworthiness are recorded here too, so an overdue row can be a legal
              exposure rather than a service that can wait.
            </div>
            <Button size="sm" style={{ marginTop: SP[3] }}
              onClick={() => { setTab('work'); setScope('overdue') }}>Show Only Overdue</Button>
          </div>
        </div>
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: SP[3], marginBottom: SP[5],
      }}>
        <KpiCard label="Overdue" value={fmtNum(overdue.length)}
          sub={overdue.length ? 'past the due date' : 'nothing overdue'}
          icon="error" accent={overdue.length ? RED : GREEN} loading={loading} />
        <KpiCard label="Due Within 30 Days" value={fmtNum(dueSoon.length)}
          sub={dueSoon.length ? 'book these in' : 'nothing falling due'}
          icon="event" accent={dueSoon.length ? AMBER : GREEN} loading={loading} />
        <KpiCard label="Workshop Spend" value={fmtKobo(workCost)}
          sub={`${fmtNum(maint.length)} job(s) on ${fmtNum(vehiclesWithWork)} vehicle(s)`}
          icon="build" accent={NAVY} loading={loading} />
        <KpiCard label="Incidents" value={fmtKobo(incCost)}
          sub={openInc.length ? `${fmtNum(openInc.length)} still open` : `${fmtNum(incidents.length)} record(s)`}
          icon="report" accent={openInc.length ? RED : NAVY} loading={loading} />
        <KpiCard label="Insurance"
          value={coverExpired.length
            ? `${fmtNum(coverExpired.length)} expired`
            : coverExpiring.length
              ? `${fmtNum(coverExpiring.length)} expiring`
              : coverUnknown.length ? `${fmtNum(coverUnknown.length)} unknown` : 'All covered'}
          sub={coverUnknown.length
            ? `${fmtNum(coverUnknown.length)} vehicle(s) with no policy on record`
            : `${fmtNum(cover.length)} vehicle(s) checked`}
          icon="shield"
          accent={coverExpired.length ? RED : coverExpiring.length ? AMBER : coverUnknown.length ? 'var(--txt3)' : GREEN}
          loading={loading} />
      </div>

      {nothingYet ? (
        <SectionCard>
          <EmptyState icon="build" title="Nothing Recorded Yet"
            description="Work and incidents are logged against a vehicle. Open a vehicle from the register and use Log Work or Log Incident: they appear here across the whole fleet."
            action={{ label: 'Fleet Register', icon: 'directions_car', onClick: () => navigate('/fleet') }} />
        </SectionCard>
      ) : (
        <>
          <Tabs
            active={tab} onChange={setTab}
            tabs={[
              { key: 'work',      label: 'Work',      badge: maint.length },
              { key: 'incidents', label: 'Incidents', badge: incidents.length },
              { key: 'cover',     label: 'Insurance', badge: coverExpired.length + coverExpiring.length },
            ]}
          />

          {tab === 'work' && (
            <SectionCard title="Work Done" padding={false}
              subtitle="Servicing, repairs, tyres, insurance, licences and roadworthiness"
              actions={
                <SegmentedToggle<Scope>
                  value={scope} onChange={setScope}
                  options={[
                    { value: 'all',      label: `All (${maint.length})` },
                    { value: 'overdue',  label: `Overdue (${overdue.length})` },
                    { value: 'due_soon', label: `Due Soon (${dueSoon.length})` },
                  ]}
                />
              }>
              <DataTable
                cols={workCols} rows={shown} keyFn={r => String(r.id)}
                searchKeys={['reg_no', 'vendor', 'description', 'invoice_ref', 'kind']}
                searchPlaceholder="Search vehicle, vendor or work…"
                loading={loading && !maint.length} skeletonRows={8} pageSize={25}
                emptyText={
                  <EmptyState icon="event_available"
                    title={scope === 'overdue' ? 'Nothing Overdue' : scope === 'due_soon' ? 'Nothing Due Soon' : 'No Work Recorded'}
                    description={scope === 'all'
                      ? 'Log work from a vehicle page and it appears here.'
                      : 'Every job with a due date is inside its window.'} />
                }
              />
            </SectionCard>
          )}

          {tab === 'cover' && (
            <SectionCard title="Insurance Cover" padding={false}
              subtitle="One row per vehicle, worst first. A vehicle with no policy reads “no policy on record”: which is not the same as uninsured">
              <DataTable
                cols={coverCols} rows={cover} keyFn={r => String(r.vehicle_id)}
                searchKeys={['reg_no', 'insurer', 'policy_no', 'cover_state']}
                searchPlaceholder="Search vehicle or insurer…"
                loading={loading && !cover.length} skeletonRows={5} pageSize={25}
                emptyText={
                  <EmptyState icon="shield" title="No Vehicles To Check"
                    description="Cover is reported per vehicle on the register. Add a vehicle and record its policy from the vehicle page." />
                }
              />
            </SectionCard>
          )}

          {tab === 'incidents' && (
            <SectionCard title="Incidents" padding={false}
              subtitle="Accidents, fines, breakdowns, theft and vandalism">
              <DataTable
                cols={incCols} rows={incidents} keyFn={r => String(r.id)}
                searchKeys={['reg_no', 'description', 'kind', 'reported_by_name']}
                searchPlaceholder="Search vehicle or incident…"
                loading={loading && !incidents.length} skeletonRows={6} pageSize={25}
                emptyText={
                  <EmptyState icon="verified" title="No Incidents Recorded"
                    description="Nothing has been logged against any vehicle." />
                }
              />
            </SectionCard>
          )}
        </>
      )}
    </Page>
  )
}
