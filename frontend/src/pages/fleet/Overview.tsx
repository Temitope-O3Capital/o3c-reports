import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, KpiCard, SectionCard, ErrBanner, DataTable, EmptyState, DateFilter,
  Button, Badge, Modal, Field, Input, Select, Textarea,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, monthStart, today } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { humanLabel } from '../../lib/labels'

/*
  FLEET OVERVIEW — what the vehicles cost, how far they went, what is falling due.

  THE SPEND NEEDED NO CAPTURE. O3's fuel cards are O3-issued, so every purchase was
  already a row in ccs_transactions — dated, priced, merchant-verified. This module
  reads it. The only thing it had to add was the register: which card belongs to
  which vehicle. Map a card and ₦7.2m of history attributes itself.

  TWO THINGS THIS PAGE REFUSES TO FAKE.

  Cost per kilometre is shown only where distance was actually measured. A vehicle
  with no odometer readings has no span to divide by, and filling that in with an
  assumption would make the cheapest-looking car the one nobody bothers to log.

  Spend is always shown with the window it covers and how far the card feed reaches.
  ccs_transactions stops at 2025-12-31, so a quiet 2026 is a feed gap and not a
  frugal month — the same root cause as the settlement module's feed gaps.
*/

// ── Types ─────────────────────────────────────────────────────────────────────

interface VehicleCounts {
  vehicles: number; active: number; in_workshop: number; disposed: number
  fleet_cost_kobo: number
}
interface CardCoverage { with_card: number; without_card: number }
interface SpendTotals {
  txns: number; spend_kobo: number; vehicles_spending: number
  first_txn: string | null; last_txn: string | null
}
interface ByVehicle {
  vehicle_id: number; reg_no: string; make: string | null; model: string | null
  status: string; spend_kobo: number; txns: number; km: number; readings: number
  kobo_per_km: number | null
}
interface CodeRow { txn_code: string; code_label: string; txns: number; spend_kobo: number }
interface MerchantRow { merchant: string; txns: number; spend_kobo: number }
interface DueRow {
  id: number; vehicle_id: number; reg_no: string; kind: string
  next_due_on: string | null; next_due_km: number | null
  current_km: number | null; days_to_due: number | null; km_to_due: number | null
}

interface Overview {
  vehicles: VehicleCounts
  card_coverage: CardCoverage
  spend: SpendTotals
  by_vehicle: ByVehicle[]
  spend_by_code: CodeRow[]
  top_merchants: MerchantRow[]
  maintenance: { jobs: number; cost_kobo: number }
  incidents: { incidents: number; open_incidents: number; cost_kobo: number }
  due: DueRow[]
  cover: CoverCounts
  feed: { card_feed_last_day: string | null }
  period: { from: string; to: string }
}

const STATUS_TONE: Record<string, string> = {
  active: GREEN, workshop: AMBER, reserve: BLUE, stolen: RED, disposed: 'var(--txt3)',
}

/*
  Transaction codes that are not a purchase of anything.

  A fuel card showing a web transfer out has not bought fuel under any reading, and
  nothing in the business currently surfaces that. These codes are called out rather
  than quietly folded into a spend total — on the live cards they are a material
  share of it.
*/
const NON_PURCHASE_CODES = new Set(['423', '422', '473', '452', '402'])

// Mirrors fleet_vehicles_status_check. A value not in this list is rejected by the
// database, so the form offers exactly these rather than free text.
const VEHICLE_STATUSES = ['active', 'workshop', 'reserve', 'stolen', 'disposed']

interface Lookup { id: number; name: string }
interface Driver { id: number; full_name: string }

/* Cover counts, with 'unknown' deliberately apart from 'expired': the register not
   holding a policy is not evidence a vehicle is uninsured. */
interface CoverCounts { covered: number; expiring: number; expired: number; unknown: number }

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.floor((Date.now() - t) / 86_400_000)
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FleetOverview() {
  const navigate = useNavigate()
  const [from, setFrom] = useState(monthStart())
  const [to, setTo]     = useState(today())
  const [d, setD]       = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const [addOpen, setAddOpen] = useState(false)
  const [saving, setSaving]   = useState(false)
  const [regNo, setRegNo]     = useState('')
  const [make, setMake]       = useState('')
  const [model, setModel]     = useState('')
  const [modelYear, setModelYear] = useState('')
  const [colour, setColour]   = useState('')
  const [status, setStatus]   = useState('active')
  const [deptId, setDeptId]   = useState('')
  const [driverId, setDriverId] = useState('')
  const [driverName, setDriverName] = useState('')
  const [acquiredOn, setAcquiredOn] = useState('')
  const [acqCost, setAcqCost] = useState('')
  const [vin, setVin]         = useState('')
  const [engineNo, setEngineNo] = useState('')
  const [notes, setNotes]     = useState('')

  const [departments, setDepartments] = useState<Lookup[]>([])
  const [drivers, setDrivers]         = useState<Driver[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setD(await apiFetch<Overview>(`/api/fleet/overview?date_from=${from}&date_to=${to}`))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load the fleet position')
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => { load() }, [load])

  /* The reference lists the form offers. Loaded once, and a failure here is not
     surfaced as a page error: an empty dropdown degrades the form, it does not
     break the page, and the register's own figures do not depend on it. */
  useEffect(() => {
    let live = true
    apiFetch<{ departments: Lookup[]; drivers: Driver[] }>('/api/fleet/lookups')
      .then(r => { if (live) { setDepartments(r.departments ?? []); setDrivers(r.drivers ?? []) } })
      .catch(() => { /* dropdowns stay empty; free-text driver name still works */ })
    return () => { live = false }
  }, [])

  const addVehicle = async () => {
    if (!regNo.trim()) return
    setSaving(true)
    setError(null)
    try {
      await apiPost('/api/fleet/vehicles', {
        reg_no: regNo.trim(), make: make.trim(), model: model.trim(),
        model_year: modelYear ? Number(modelYear) : null,
        vin: vin.trim(), engine_no: engineNo.trim(), colour: colour.trim(),
        acquired_on: acquiredOn || null,
        acquisition_cost_kobo: acqCost.trim()
          ? Math.round(Number(acqCost.replace(/,/g, '')) * 100) : 0,
        status,
        department_id: deptId ? Number(deptId) : null,
        assigned_to: driverId ? Number(driverId) : null,
        assigned_driver_name: driverName.trim(),
        notes: notes.trim(),
      })
      setAddOpen(false)
      setRegNo(''); setMake(''); setModel(''); setModelYear(''); setColour('')
      setStatus('active'); setDeptId(''); setDriverId(''); setDriverName('')
      setAcquiredOn(''); setAcqCost(''); setVin(''); setEngineNo(''); setNotes('')
      await load()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not add the vehicle')
    } finally {
      setSaving(false)
    }
  }

  const v        = d?.vehicles
  const coverage = d?.card_coverage
  const spend    = d?.spend
  const byVeh    = d?.by_vehicle ?? []
  const codes    = d?.spend_by_code ?? []
  const due      = d?.due ?? []
  const cover    = d?.cover

  const feedLast  = d?.feed?.card_feed_last_day ?? null
  const feedStale = daysSince(feedLast)

  // Spend on codes that are not a purchase. Reported, never netted off silently.
  const nonPurchase = useMemo(() => codes
    .filter(c => NON_PURCHASE_CODES.has(String(c.txn_code)))
    .reduce((s, c) => s + Number(c.spend_kobo), 0), [codes])

  const measured = useMemo(() => byVeh.filter(x => Number(x.km) > 0), [byVeh])

  /*
    What to say first. Register gaps outrank cost: a fleet where half the vehicles
    have no card mapped cannot be costed at all, and leading with a total would
    present a fraction as the whole.
  */
  const verdict = useMemo(() => {
    if (!d) return null
    if (Number(v?.vehicles ?? 0) === 0) {
      return {
        tone: NAVY, icon: 'directions_car', title: 'No vehicles on the register yet',
        body: 'Add a vehicle, then map its fuel card. The card’s whole history attributes itself — '
            + 'O3’s fuel cards are O3-issued, so the spend is already captured and simply needs an owner.',
      }
    }
    if (Number(coverage?.without_card ?? 0) > 0) {
      return {
        tone: AMBER, icon: 'credit_card_off',
        title: `${fmtNum(coverage!.without_card)} vehicle(s) have no fuel card mapped`,
        body: 'Their spend reads as zero because nothing links them to a card, not because they cost nothing. '
            + 'Map the card and the history appears at once.',
      }
    }
    if (measured.length === 0) {
      return {
        tone: AMBER, icon: 'speed', title: 'No distance recorded, so cost per kilometre cannot be stated',
        body: 'Spend is known; distance is not. One odometer reading per refuel is all it takes, '
            + 'and it is the difference between knowing what a vehicle costs and what it costs to run.',
      }
    }
    if (nonPurchase > 0) {
      return {
        tone: RED, icon: 'policy',
        title: `${fmtKobo(nonPurchase)} on these cards is not a purchase`,
        body: 'Transfers out, cash payments and reversals are not a vehicle expense under any reading. '
            + 'See the breakdown by transaction code below.',
      }
    }
    return {
      tone: GREEN, icon: 'verified', title: 'Register complete and costed',
      body: `${fmtNum(measured.length)} vehicle(s) with measured distance and attributed spend.`,
    }
  }, [d, v, coverage, measured, nonPurchase])

  // ── Tables ──────────────────────────────────────────────────────────────────

  const vehCols: TableCol<ByVehicle>[] = [
    { key: 'reg_no', label: 'Vehicle', sortable: true, render: r => (
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.sm, fontWeight: FW.semibold }}>
          {r.reg_no}
        </div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
          {[r.make, r.model].filter(Boolean).join(' ') || '—'}
        </div>
      </div>
    ) },
    { key: 'status', label: 'Status', width: 110, render: r => (
      <span style={{
        fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px', borderRadius: 999,
        background: `${STATUS_TONE[r.status] ?? 'var(--txt3)'}14`,
        color: STATUS_TONE[r.status] ?? 'var(--txt3)',
      }}>{humanLabel(r.status)}</span>
    ) },
    { key: 'spend_kobo', label: 'Spend', align: 'right', sortable: true, width: 140,
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(r.spend_kobo)}</span> },
    { key: 'txns', label: 'Txns', align: 'right', sortable: true, width: 80,
      render: r => Number(r.txns) > 0
        ? <span style={NUM}>{fmtNum(r.txns)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span> },
    { key: 'km', label: 'Distance', align: 'right', sortable: true, width: 110,
      render: r => Number(r.km) > 0
        ? <span style={NUM}>{fmtNum(r.km)} km</span>
        : <span style={{ fontSize: TEXT.xs, color: AMBER }}>not measured</span> },
    { key: 'kobo_per_km', label: 'Cost / km', align: 'right', sortable: true, width: 120,
      render: r => {
        // Withheld, not estimated. See the note at the top of the file.
        if (r.kobo_per_km == null) {
          return <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}
            title={`${fmtNum(r.readings)} odometer reading(s) — at least two are needed to measure a span`}>
            —</span>
        }
        return <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtKobo(r.kobo_per_km)}</span>
      } },
  ]

  const codeMax = useMemo(
    () => Math.max(0, ...codes.map(c => Number(c.spend_kobo))), [codes])

  const codeCols: TableCol<CodeRow>[] = [
    { key: 'code_label', label: 'What the Card Paid For', render: r => {
      const odd = NON_PURCHASE_CODES.has(String(r.txn_code))
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: SP[2] }}>
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs, color: 'var(--txt3)' }}>
            {r.txn_code}
          </code>
          <span style={{ fontWeight: odd ? FW.semibold : FW.normal, color: odd ? RED : 'var(--txt)' }}>
            {r.code_label}
          </span>
          {odd && <Badge variant="warning">not a purchase</Badge>}
        </span>
      )
    } },
    { key: 'txns', label: 'Txns', align: 'right', sortable: true, width: 80,
      render: r => <span style={NUM}>{fmtNum(r.txns)}</span> },
    { key: 'spend_kobo', label: 'Amount', align: 'right', sortable: true, width: 140,
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(r.spend_kobo)}</span> },
    { key: 'share', label: 'Share', width: 90, render: r => {
      const pct = codeMax > 0 ? (Number(r.spend_kobo) / codeMax) * 100 : 0
      const odd = NON_PURCHASE_CODES.has(String(r.txn_code))
      return (
        <div aria-hidden="true" style={{ height: 4, borderRadius: 2, background: 'var(--bdr)', overflow: 'hidden', minWidth: 48 }}>
          <div style={{ height: '100%', width: `${pct}%`, borderRadius: 2, background: odd ? RED : NAVY }} />
        </div>
      )
    } },
  ]

  const dueCols: TableCol<DueRow>[] = [
    { key: 'reg_no', label: 'Vehicle', width: 130, render: r => (
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.sm, fontWeight: FW.semibold }}>
        {r.reg_no}
      </span>
    ) },
    { key: 'kind', label: 'Work', render: r => humanLabel(r.kind) },
    { key: 'next_due_on', label: 'Due', width: 130, render: r => {
      if (r.days_to_due == null) return <span style={{ color: 'var(--txt3)' }}>—</span>
      const dd = Number(r.days_to_due)
      const tone = dd < 0 ? RED : dd <= 14 ? AMBER : 'var(--txt2)'
      return (
        <span style={{ fontSize: TEXT.sm, color: tone, fontWeight: dd <= 14 ? FW.semibold : FW.normal }}>
          {dd < 0 ? `${Math.abs(dd)}d overdue` : `in ${dd}d`}
        </span>
      )
    } },
    { key: 'km_to_due', label: 'Or at', align: 'right', width: 150, render: r => {
      if (r.next_due_km == null) return <span style={{ color: 'var(--txt3)' }}>—</span>
      const kd = r.km_to_due == null ? null : Number(r.km_to_due)
      return (
        <span style={{ ...NUM, fontSize: TEXT.sm, color: kd != null && kd < 0 ? RED : 'var(--txt2)' }}>
          {fmtNum(r.next_due_km)} km
          {kd != null && <span style={{ color: 'var(--txt3)' }}> ({kd < 0 ? `${fmtNum(Math.abs(kd))} over` : `${fmtNum(kd)} to go`})</span>}
        </span>
      )
    } },
  ]

  return (
    <Page
      title="Fleet"
      subtitle="Company vehicles — spend read straight from the fuel cards, distance from the odometer"
      loading={loading && !d}
      skeletonKpis={4}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], flexWrap: 'wrap' }}>
          <Button size="sm" variant="secondary" icon="add" onClick={() => setAddOpen(true)}>
            Add Vehicle
          </Button>
          <Button size="sm" variant="secondary" icon="credit_card"
            onClick={() => navigate('/fleet/cards')}>Fuel Cards</Button>
          <Button size="sm" variant="secondary" icon="build"
            onClick={() => navigate('/fleet/work')}>Work &amp; Incidents</Button>
          <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} align="right" />
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {verdict && (
        <div role="status" style={{
          display: 'flex', alignItems: 'flex-start', gap: SP[3],
          padding: SP[4], marginBottom: SP[5], borderRadius: RADIUS.lg,
          background: 'var(--card)', border: '1px solid var(--card-bdr)',
          borderLeft: `4px solid ${verdict.tone}`, boxShadow: 'var(--card-shadow)',
        }}>
          <span className="material-symbols-rounded" aria-hidden="true"
            style={{ fontSize: 22, color: verdict.tone, flexShrink: 0, marginTop: 1 }}>
            {verdict.icon}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>{verdict.title}</div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 3, lineHeight: 'var(--lh-relaxed)' }}>
              {verdict.body}
            </div>
          </div>
        </div>
      )}

      {/* The card feed's reach. Same cause as the settlement feed gaps, so it is
          stated rather than left to be inferred from a thin month. */}
      {feedLast && feedStale !== null && feedStale > 40 && (
        <div role="note" style={{
          display: 'flex', alignItems: 'center', gap: SP[3], flexWrap: 'wrap',
          padding: SP[4], marginBottom: SP[5], borderRadius: RADIUS.lg,
          background: 'var(--card)', border: '1px solid var(--card-bdr)',
          borderLeft: `4px solid ${AMBER}`,
        }}>
          <span className="material-symbols-rounded" aria-hidden="true"
            style={{ fontSize: 20, color: AMBER }}>cloud_off</span>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 'var(--lh-relaxed)' }}>
            The card transaction feed reaches only to{' '}
            <strong style={{ color: 'var(--txt)' }}>{fmtDate(feedLast)}</strong> — {fmtNum(feedStale)} days ago.
            Spend after that date is <strong style={{ color: 'var(--txt)' }}>not missing, it is unreported</strong>;
            a quiet month here is a feed gap, not a frugal one.
          </div>
        </div>
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: SP[3], marginBottom: SP[6],
      }}>
        <KpiCard label="Vehicles" value={fmtNum(v?.active)}
          sub={`${fmtNum(v?.in_workshop)} in workshop · ${fmtNum(v?.disposed)} disposed`}
          icon="directions_car" accent={NAVY} loading={loading && !d} />
        <KpiCard label="Card Spend" value={fmtKobo(spend?.spend_kobo)}
          sub={`${fmtNum(spend?.txns)} txns · ${fmtDate(from)} – ${fmtDate(to)}`}
          icon="local_gas_station" accent={BLUE} loading={loading && !d} />
        <KpiCard label="Not a Purchase" value={fmtKobo(nonPurchase)}
          sub={nonPurchase > 0 ? 'transfers, cash, reversals' : 'all spend is a purchase'}
          icon="policy" accent={nonPurchase > 0 ? RED : GREEN} loading={loading && !d} />
        <KpiCard label="Maintenance" value={fmtKobo(d?.maintenance?.cost_kobo)}
          sub={`${fmtNum(d?.maintenance?.jobs)} jobs · ${fmtNum(d?.incidents?.open_incidents)} open incident(s)`}
          icon="build" accent={PURPLE} loading={loading && !d} />
        {/* Cover leads with the worst state present, because an expired certificate is
            a legal exposure and a count of healthy ones hides it. */}
        <KpiCard label="Insurance"
          value={Number(cover?.expired ?? 0) > 0
            ? `${fmtNum(cover?.expired)} expired`
            : Number(cover?.expiring ?? 0) > 0
              ? `${fmtNum(cover?.expiring)} expiring`
              : Number(cover?.unknown ?? 0) > 0
                ? `${fmtNum(cover?.unknown)} unknown`
                : Number(cover?.covered ?? 0) > 0 ? 'All covered' : '—'}
          sub={Number(cover?.unknown ?? 0) > 0
            ? `${fmtNum(cover?.unknown)} with no policy on record`
            : `${fmtNum(cover?.covered)} covered`}
          icon="shield"
          accent={Number(cover?.expired ?? 0) > 0 ? RED
            : Number(cover?.expiring ?? 0) > 0 ? AMBER
              : Number(cover?.unknown ?? 0) > 0 ? 'var(--txt3)' : GREEN}
          loading={loading && !d} />
      </div>

      <SectionCard title="Cost per Vehicle" padding={false} style={{ marginBottom: SP[4] }}
        subtitle="Cost per kilometre appears only where distance was measured — it is withheld, never estimated"
        actions={Number(coverage?.without_card ?? 0) > 0
          ? <Badge variant="warning">{fmtNum(coverage?.without_card)} without a card</Badge>
          : undefined}>
        <DataTable
          cols={vehCols} rows={byVeh} keyFn={r => r.vehicle_id}
          onRowClick={r => navigate(`/fleet/vehicles/${r.vehicle_id}`)}
          loading={loading && !d} skeletonRows={5}
          emptyText={
            <EmptyState icon="directions_car" title="No Vehicles on the Register"
              description="Add a vehicle, then map its fuel card — the spend is already captured and only needs an owner."
              action={{ label: 'Add Vehicle', icon: 'add', onClick: () => setAddOpen(true) }} />
          }
        />
      </SectionCard>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: SP[4], marginBottom: SP[4] }}>
        <SectionCard title="What the Cards Actually Paid For" padding={false}
          subtitle="By transaction code. A fuel card showing a transfer out has not bought fuel">
          <DataTable
            cols={codeCols} rows={codes} keyFn={r => r.txn_code}
            loading={loading && !d} skeletonRows={4}
            emptyText={<EmptyState icon="receipt_long" title="No Card Activity in This Period" />}
          />
        </SectionCard>

        <SectionCard title="Work Falling Due" padding={false}
          subtitle="By date and by distance, because an idle vehicle comes due by one and a busy one by the other"
          actions={
            <Button size="sm" variant="secondary" icon="open_in_new"
              onClick={() => navigate('/fleet/work')}>All Work</Button>
          }>
          <DataTable
            cols={dueCols} rows={due} keyFn={r => r.id}
            loading={loading && !d} skeletonRows={4}
            emptyText={<EmptyState icon="event_available" title="Nothing Due"
              description="No service, insurance or licence renewal is scheduled in the next 60 days." />}
          />
        </SectionCard>
      </div>

      {(d?.top_merchants?.length ?? 0) > 0 && (
        <SectionCard title="Where the Money Went" padding={false}
          subtitle="Merchant as the card feed reports it — often the payment processor rather than the filling station, which is why scope is set by card and not by this name">
          <DataTable
            cols={[
              { key: 'merchant', label: 'Merchant', render: (r: MerchantRow) => (
                <span style={{ fontSize: TEXT.sm }}>{r.merchant}</span>) },
              { key: 'txns', label: 'Txns', align: 'right', width: 80, sortable: true,
                render: (r: MerchantRow) => <span style={NUM}>{fmtNum(r.txns)}</span> },
              { key: 'spend_kobo', label: 'Amount', align: 'right', width: 140, sortable: true,
                render: (r: MerchantRow) => (
                  <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(r.spend_kobo)}</span>) },
            ]}
            rows={d!.top_merchants} keyFn={r => r.merchant}
            loading={loading && !d} skeletonRows={5} pageSize={10}
            emptyText={<EmptyState icon="storefront" title="No Merchants" />}
          />
        </SectionCard>
      )}

      {/* ── Add a vehicle ──
          Everything the register holds is capturable here. The earlier version took
          four fields, which left ten columns with no way in: a vehicle could never
          be given a driver, a department, or what it cost to buy. */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add a Vehicle" width={660}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)} disabled={saving}>Cancel</Button>
            <Button icon="add" onClick={addVehicle} loading={saving} disabled={!regNo.trim()}>
              Add Vehicle
            </Button>
          </>
        }>
        <Field label="Registration Number" required
          hint="The business key — what appears on a mechanic's invoice and on a fine.">
          <Input value={regNo} onChange={e => setRegNo(e.target.value)} placeholder="e.g. LAG-123-XY" />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: SP[3] }}>
          <Field label="Make"><Input value={make} onChange={e => setMake(e.target.value)} placeholder="Toyota" /></Field>
          <Field label="Model"><Input value={model} onChange={e => setModel(e.target.value)} placeholder="Hilux" /></Field>
          <Field label="Year">
            <Input value={modelYear} onChange={e => setModelYear(e.target.value)}
              inputMode="numeric" placeholder="2021" />
          </Field>
          <Field label="Colour"><Input value={colour} onChange={e => setColour(e.target.value)} placeholder="White" /></Field>
          <Field label="Status">
            <Select value={status} onChange={e => setStatus(e.target.value)}>
              {VEHICLE_STATUSES.map(s => <option key={s} value={s}>{humanLabel(s)}</option>)}
            </Select>
          </Field>
          <Field label="Department" hint="Whose cost centre carries it.">
            <Select value={deptId} onChange={e => setDeptId(e.target.value)}>
              <option value="">Not Assigned</option>
              {departments.map(x => <option key={x.id} value={String(x.id)}>{x.name}</option>)}
            </Select>
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: SP[3] }}>
          <Field label="Driver (Staff)" hint="Leave blank for a contract driver.">
            <Select value={driverId} onChange={e => setDriverId(e.target.value)}>
              <option value="">Not Assigned</option>
              {drivers.map(x => <option key={x.id} value={String(x.id)}>{x.full_name}</option>)}
            </Select>
          </Field>
          <Field label="Driver Name" hint="For a driver who has no staff account.">
            <Input value={driverName} onChange={e => setDriverName(e.target.value)} />
          </Field>
          <Field label="Acquired on">
            <Input type="date" value={acquiredOn} max={today()} onChange={e => setAcquiredOn(e.target.value)} />
          </Field>
          <Field label="Purchase Cost (₦)" hint="Capital, reported separately from running cost.">
            <Input inputMode="decimal" value={acqCost} onChange={e => setAcqCost(e.target.value)} />
          </Field>
          <Field label="VIN"><Input value={vin} onChange={e => setVin(e.target.value)} /></Field>
          <Field label="Engine Number"><Input value={engineNo} onChange={e => setEngineNo(e.target.value)} /></Field>
        </div>

        <Field label="Notes">
          <Textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
        </Field>

        <p style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: SP[3], lineHeight: 'var(--lh-relaxed)' }}>
          Next, map the vehicle&apos;s fuel card from <strong>Fuel Cards</strong>. Its whole transaction
          history attributes itself — nothing needs re-entering.
        </p>
      </Modal>
    </Page>
  )
}
