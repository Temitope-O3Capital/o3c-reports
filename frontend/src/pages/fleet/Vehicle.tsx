import { useEffect, useState, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Page, KpiCard, SectionCard, ErrBanner, DataTable, EmptyState, Tabs,
  Button, Badge, Modal, Field, Input, Select, Textarea,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, today } from '../../lib/fmt'
import { hasPage } from '../../hooks/useAuth'
import { GREEN, RED, AMBER, NAVY, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { humanLabel } from '../../lib/labels'

/*
  ONE VEHICLE — what it cost, how far it went, what was done to it.

  This is the page the Cost per Vehicle table on the Overview points at, and the
  only place three of this module's records can be WRITTEN: an odometer reading,
  a piece of work, an incident. Without it the register could be populated and
  costed but never measured — fleet_distance would stay permanently empty,
  because nothing could put a reading into it.

  Two honesty rules are enforced in the presentation, not just the schema:

  Cost per km is quoted over the MEASURED window, not over all time. Spend runs
  from the day the card was mapped; readings start whenever somebody first wrote
  one down. Dividing lifetime spend by recently-measured distance would invent a
  cost per km far higher than the truth, so the denominator and the numerator are
  taken from the same months and the window is named underneath.

  Consumption is blank unless both fills were to full. A part-fill measures an
  unknown starting level, so the view returns NULL and this page shows an em dash
  rather than a plausible-looking wrong number.
*/

interface Vehicle {
  id: number
  reg_no: string
  make: string | null
  model: string | null
  model_year: number | null
  vin: string | null
  engine_no: string | null
  colour: string | null
  acquired_on: string | null
  acquisition_cost_kobo: number
  disposed_on: string | null
  disposal_proceeds_kobo: number
  status: string
  department: string | null
  department_id: number | null
  assigned_to: number | null
  assigned_driver_name: string | null
  driver: string
  notes: string | null
}

interface Lookup { id: number; name: string }
interface Driver { id: number; full_name: string }

interface CardWindow {
  id: number
  cif: string
  card_label: string | null
  valid_from: string
  valid_to: string | null
  txns: number
}

interface SpendRow {
  txn_date: string
  amount_kobo: number
  txn_code: string | null
  merchant_name: string | null
  description: string | null
  card_label: string | null
}

interface MonthRow { month: string; txns: number; spend_kobo: number }

interface OdoRow {
  id: number
  read_on: string
  reading_km: number
  km_since: number | null
  days_since: number | null
  litres: number | string | null
  filled_to_full: boolean
  litres_per_100km: number | string | null
  source: string
}

interface MaintRow {
  id: number
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
  occurred_on: string
  kind: string
  description: string | null
  cost_kobo: number
  resolved_on: string | null
  reported_by_name: string
}

interface Detail {
  vehicle: Vehicle
  cards: CardWindow[]
  spend: SpendRow[]
  monthly: MonthRow[]
  odometer: OdoRow[]
  maintenance: MaintRow[]
  incidents: IncRow[]
}

const STATUS_TONE: Record<string, string> = {
  active: GREEN, workshop: AMBER, reserve: BLUE, stolen: RED, disposed: 'var(--txt3)',
}

const MAINT_KINDS = ['service', 'repair', 'tyres', 'battery', 'insurance',
  'licence', 'roadworthiness', 'papers', 'towing', 'other']
const INCIDENT_KINDS = ['accident', 'fine', 'theft', 'breakdown', 'vandalism', 'other']
const ODO_SOURCES = ['refuel', 'service', 'manual', 'audit', 'handover']
// Mirrors fleet_vehicles_status_check — anything else the database rejects.
const VEHICLE_STATUSES = ['active', 'workshop', 'reserve', 'stolen', 'disposed']

/* The register stores kobo. A person types naira. */
function toKobo(naira: string): number {
  const n = Number(String(naira).replace(/,/g, '').trim())
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export default function FleetVehicle() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const canWrite = hasPage('fleet_admin')

  const [d, setD] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [notice, setNotice]   = useState<string | null>(null)
  const [tab, setTab]         = useState('distance')
  const [saving, setSaving]   = useState(false)

  // Record a reading
  const [odoOpen, setOdoOpen]   = useState(false)
  const [readOn, setReadOn]     = useState(today())
  const [readingKm, setReadingKm] = useState('')
  const [litres, setLitres]     = useState('')
  const [toFull, setToFull]     = useState('yes')
  const [odoSource, setOdoSource] = useState('refuel')
  const [odoNote, setOdoNote]   = useState('')

  // Log work
  const [mOpen, setMOpen]       = useState(false)
  const [mKind, setMKind]       = useState('service')
  const [mOn, setMOn]           = useState(today())
  const [mVendor, setMVendor]   = useState('')
  const [mCost, setMCost]       = useState('')
  const [mOdo, setMOdo]         = useState('')
  const [mDueOn, setMDueOn]     = useState('')
  const [mDueKm, setMDueKm]     = useState('')
  const [mDesc, setMDesc]       = useState('')
  const [mInvoice, setMInvoice] = useState('')

  // Edit the register entry. Sent as a PATCH-style partial: only the keys below go
  // up, and an empty one clears the field rather than being ignored.
  const [eOpen, setEOpen]       = useState(false)
  const [eMake, setEMake]       = useState('')
  const [eModel, setEModel]     = useState('')
  const [eYear, setEYear]       = useState('')
  const [eColour, setEColour]   = useState('')
  const [eVin, setEVin]         = useState('')
  const [eEngine, setEEngine]   = useState('')
  const [eStatus, setEStatus]   = useState('active')
  const [eDept, setEDept]       = useState('')
  const [eDriverId, setEDriverId] = useState('')
  const [eDriverName, setEDriverName] = useState('')
  const [eAcquired, setEAcquired] = useState('')
  const [eAcqCost, setEAcqCost] = useState('')
  const [eDisposed, setEDisposed] = useState('')
  const [eProceeds, setEProceeds] = useState('')
  const [eNotes, setENotes]     = useState('')

  const [departments, setDepartments] = useState<Lookup[]>([])
  const [drivers, setDrivers]         = useState<Driver[]>([])

  /* The detail payload caps the odometer series at 100 rows so one page load stays
     one page load. Rather than truncate silently, the Distance tab says so and
     fetches the fuller series on request. */
  const [fullOdo, setFullOdo] = useState<OdoRow[] | null>(null)
  const [loadingOdo, setLoadingOdo] = useState(false)

  // Log incident
  const [iOpen, setIOpen]       = useState(false)
  const [iKind, setIKind]       = useState('accident')
  const [iOn, setIOn]           = useState(today())
  const [iCost, setICost]       = useState('')
  const [iDesc, setIDesc]       = useState('')
  const [iResolved, setIResolved] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setD(await apiFetch<Detail>(`/api/fleet/vehicles/${id}`))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load the vehicle')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  /* Reference lists for the edit form. A failure is not a page error — an empty
     dropdown degrades one form, and none of the figures depend on it. */
  useEffect(() => {
    let live = true
    apiFetch<{ departments: Lookup[]; drivers: Driver[] }>('/api/fleet/lookups')
      .then(r => { if (live) { setDepartments(r.departments ?? []); setDrivers(r.drivers ?? []) } })
      .catch(() => { /* free-text driver name still works */ })
    return () => { live = false }
  }, [])

  const loadFullOdo = async () => {
    setLoadingOdo(true)
    try {
      const r = await apiFetch<{ data: OdoRow[] }>(`/api/fleet/vehicles/${id}/odometer`)
      setFullOdo(r.data ?? [])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not load the full reading history')
    } finally {
      setLoadingOdo(false)
    }
  }

  const v        = d?.vehicle
  const cards    = d?.cards ?? []
  const spend    = d?.spend ?? []
  const monthly  = d?.monthly ?? []
  const odo      = fullOdo ?? d?.odometer ?? []
  const maint    = d?.maintenance ?? []
  const incidents = d?.incidents ?? []

  const liveCard = useMemo(() => cards.find(c => !c.valid_to) ?? null, [cards])

  /* Lifetime card spend. Taken from the monthly aggregate, which is complete —
     the transaction list below it is capped at 300 rows for the page's sake. */
  const lifetimeSpend = useMemo(
    () => monthly.reduce((s, m) => s + Number(m.spend_kobo), 0), [monthly])

  const maintCost = useMemo(
    () => maint.reduce((s, m) => s + Number(m.cost_kobo), 0), [maint])
  const incidentCost = useMemo(
    () => incidents.reduce((s, x) => s + Number(x.cost_kobo), 0), [incidents])

  /* Distance, and the window it was actually measured over. */
  const measured = useMemo(() => {
    const rows = odo.filter(r => num(r.km_since) !== null && Number(r.km_since) > 0)
    const km = rows.reduce((s, r) => s + Number(r.km_since), 0)
    const dates = rows.map(r => r.read_on).sort()
    return {
      km,
      rows: rows.length,
      from: dates[0] ?? null,
      to: dates[dates.length - 1] ?? null,
    }
  }, [odo])

  /* Spend over the same months the distance was measured in, so cost per km
     divides like by like. Month granularity, which is stated rather than hidden. */
  const windowSpend = useMemo(() => {
    if (!measured.from || !measured.to) return null
    const a = measured.from.slice(0, 7)
    const b = measured.to.slice(0, 7)
    const months = monthly.filter(m => m.month >= a && m.month <= b)
    return { kobo: months.reduce((s, m) => s + Number(m.spend_kobo), 0), months: months.length }
  }, [measured, monthly])

  const costPerKm = useMemo(() => {
    if (!windowSpend || measured.km <= 0) return null
    return windowSpend.kobo / measured.km
  }, [windowSpend, measured])

  /* Consumption, weighted properly: total litres over total distance for the
     pairs that qualify, not the mean of per-pair rates. */
  const consumption = useMemo(() => {
    const rows = odo.filter(r => num(r.litres_per_100km) !== null)
    if (!rows.length) return null
    const l = rows.reduce((s, r) => s + (num(r.litres) ?? 0), 0)
    const km = rows.reduce((s, r) => s + (num(r.km_since) ?? 0), 0)
    if (km <= 0) return null
    return { per100: (l / km) * 100, pairs: rows.length, litres: l, km }
  }, [odo])

  const partFills = useMemo(() => odo.filter(r => !r.filled_to_full).length, [odo])
  const openIncidents = useMemo(() => incidents.filter(x => !x.resolved_on), [incidents])

  const dueSoon = useMemo(() => {
    const horizon = new Date(); horizon.setDate(horizon.getDate() + 30)
    const h = horizon.toISOString().slice(0, 10)
    return maint.filter(m => m.next_due_on && m.next_due_on <= h)
  }, [maint])

  const lastReading = odo.length
    ? odo.map(r => r.read_on).sort()[odo.length - 1]
    : null

  // ── writes ──────────────────────────────────────────────────────────────────

  const openEdit = () => {
    if (!v) return
    setEMake(v.make ?? '')
    setEModel(v.model ?? '')
    setEYear(v.model_year != null ? String(v.model_year) : '')
    setEColour(v.colour ?? '')
    setEVin(v.vin ?? '')
    setEEngine(v.engine_no ?? '')
    setEStatus(v.status || 'active')
    setEDept(v.department_id != null ? String(v.department_id) : '')
    setEDriverId(v.assigned_to != null ? String(v.assigned_to) : '')
    setEDriverName(v.assigned_driver_name ?? '')
    setEAcquired(v.acquired_on ? v.acquired_on.slice(0, 10) : '')
    setEAcqCost(Number(v.acquisition_cost_kobo) > 0
      ? String(Number(v.acquisition_cost_kobo) / 100) : '')
    setEDisposed(v.disposed_on ? v.disposed_on.slice(0, 10) : '')
    setEProceeds(Number(v.disposal_proceeds_kobo) > 0
      ? String(Number(v.disposal_proceeds_kobo) / 100) : '')
    setENotes(v.notes ?? '')
    setEOpen(true)
  }

  const saveEdit = async () => {
    setSaving(true); setError(null)
    try {
      await apiPut(`/api/fleet/vehicles/${id}`, {
        make: eMake.trim(),
        model: eModel.trim(),
        model_year: eYear.trim() ? Number(eYear) : null,
        colour: eColour.trim(),
        vin: eVin.trim(),
        engine_no: eEngine.trim(),
        status: eStatus,
        department_id: eDept ? Number(eDept) : null,
        assigned_to: eDriverId ? Number(eDriverId) : null,
        assigned_driver_name: eDriverName.trim(),
        acquired_on: eAcquired || null,
        acquisition_cost_kobo: eAcqCost.trim() ? toKobo(eAcqCost) : 0,
        disposed_on: eDisposed || null,
        disposal_proceeds_kobo: eProceeds.trim() ? toKobo(eProceeds) : 0,
        notes: eNotes.trim(),
      })
      setEOpen(false)
      setNotice('Register updated.')
      await load()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not update the vehicle')
    } finally {
      setSaving(false)
    }
  }

  const addReading = async () => {
    if (!readingKm.trim() || !readOn) return
    setSaving(true); setError(null)
    try {
      await apiPost(`/api/fleet/vehicles/${id}/odometer`, {
        reading_km: Number(readingKm.replace(/,/g, '')),
        read_on: readOn,
        litres: litres.trim() ? Number(litres) : null,
        filled_to_full: toFull === 'yes',
        source: odoSource,
        note: odoNote.trim(),
      })
      setOdoOpen(false)
      setReadingKm(''); setLitres(''); setOdoNote(''); setToFull('yes'); setReadOn(today())
      setNotice('Reading recorded. Distance and consumption recalculate from it automatically.')
      await load()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not record the reading')
    } finally {
      setSaving(false)
    }
  }

  const addWork = async () => {
    if (!mOn || !mKind) return
    setSaving(true); setError(null)
    try {
      await apiPost('/api/fleet/maintenance', {
        vehicle_id: Number(id),
        kind: mKind,
        performed_on: mOn,
        vendor: mVendor.trim(),
        cost_kobo: toKobo(mCost),
        odometer_km: mOdo.trim() ? Number(mOdo.replace(/,/g, '')) : null,
        next_due_on: mDueOn || null,
        next_due_km: mDueKm.trim() ? Number(mDueKm.replace(/,/g, '')) : null,
        description: mDesc.trim(),
        invoice_ref: mInvoice.trim(),
      })
      setMOpen(false)
      setMVendor(''); setMCost(''); setMOdo(''); setMDueOn(''); setMDueKm('')
      setMDesc(''); setMInvoice(''); setMOn(today()); setMKind('service')
      setNotice(mOdo.trim()
        ? 'Work recorded, and its odometer reading was added to the distance series too.'
        : 'Work recorded.')
      await load()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not record the work')
    } finally {
      setSaving(false)
    }
  }

  const addIncident = async () => {
    if (!iOn || !iKind) return
    setSaving(true); setError(null)
    try {
      await apiPost('/api/fleet/incidents', {
        vehicle_id: Number(id),
        occurred_on: iOn,
        kind: iKind,
        description: iDesc.trim(),
        cost_kobo: toKobo(iCost),
        resolved_on: iResolved || null,
      })
      setIOpen(false)
      setICost(''); setIDesc(''); setIResolved(''); setIOn(today()); setIKind('accident')
      setNotice('Incident recorded.')
      await load()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not record the incident')
    } finally {
      setSaving(false)
    }
  }

  // ── columns ─────────────────────────────────────────────────────────────────

  const odoCols: TableCol<OdoRow>[] = [
    { key: 'read_on', label: 'Read On', sortable: true, width: 115,
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtDate(r.read_on)}</span> },
    { key: 'reading_km', label: 'Odometer', align: 'right', sortable: true, width: 120,
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtNum(r.reading_km)} km</span> },
    { key: 'km_since', label: 'Distance', align: 'right', sortable: true, width: 110,
      render: r => num(r.km_since) !== null
        ? <span style={NUM}>{fmtNum(Number(r.km_since))} km</span>
        : <span style={{ color: 'var(--txt3)' }}>first</span> },
    { key: 'days_since', label: 'Days', align: 'right', sortable: true, width: 75,
      render: r => num(r.days_since) !== null
        ? <span style={NUM}>{fmtNum(Number(r.days_since))}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span> },
    { key: 'litres', label: 'Litres', align: 'right', sortable: true, width: 90,
      render: r => num(r.litres) !== null
        ? <span style={NUM}>{Number(r.litres).toFixed(2)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span> },
    { key: 'filled_to_full', label: 'Fill', width: 90,
      render: r => r.filled_to_full
        ? <Badge variant="success">to full</Badge>
        : <Badge variant="warning">part</Badge> },
    { key: 'litres_per_100km', label: 'L / 100km', align: 'right', sortable: true, width: 110,
      render: r => num(r.litres_per_100km) !== null
        ? <span style={{ ...NUM, fontWeight: FW.semibold }}>{Number(r.litres_per_100km).toFixed(1)}</span>
        : <span style={{ color: 'var(--txt3)' }} title="Only computed between two fills that were both to full">—</span> },
    { key: 'source', label: 'Source', width: 110,
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{humanLabel(r.source)}</span> },
  ]

  const maintCols: TableCol<MaintRow>[] = [
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
    { key: 'odometer_km', label: 'At', align: 'right', sortable: true, width: 110,
      render: r => r.odometer_km
        ? <span style={NUM}>{fmtNum(r.odometer_km)} km</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span> },
    { key: 'next_due_on', label: 'Next Due', sortable: true, width: 150,
      render: r => {
        if (!r.next_due_on && !r.next_due_km) return <span style={{ color: 'var(--txt3)' }}>—</span>
        const overdue = r.next_due_on != null && r.next_due_on < today()
        return (
          <span style={{
            ...NUM, fontSize: TEXT.sm,
            color: overdue ? RED : 'var(--txt2)', fontWeight: overdue ? FW.semibold : FW.normal,
          }}>
            {r.next_due_on ? fmtDate(r.next_due_on) : ''}
            {r.next_due_km ? `${r.next_due_on ? ' · ' : ''}${fmtNum(r.next_due_km)} km` : ''}
          </span>
        )
      } },
    { key: 'invoice_ref', label: 'Invoice', width: 120,
      render: r => r.invoice_ref
        ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs, color: 'var(--txt2)' }}>{r.invoice_ref}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span> },
  ]

  const incCols: TableCol<IncRow>[] = [
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
    { key: 'reported_by_name', label: 'Reported By', width: 150,
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.reported_by_name || '—'}</span> },
  ]

  const spendCols: TableCol<SpendRow>[] = [
    { key: 'txn_date', label: 'Date', sortable: true, width: 115,
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtDate(r.txn_date)}</span> },
    { key: 'amount_kobo', label: 'Amount', align: 'right', sortable: true, width: 130,
      render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(r.amount_kobo)}</span> },
    { key: 'merchant_name', label: 'Merchant', sortable: true,
      render: r => (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.merchant_name || '(not given)'}</div>
          {r.description && (
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.description}</div>
          )}
        </div>
      ) },
    { key: 'txn_code', label: 'Code', width: 90,
      render: r => <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs, color: 'var(--txt2)' }}>
        {r.txn_code || '—'}</span> },
    { key: 'card_label', label: 'Card', width: 160,
      render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{r.card_label || '—'}</span> },
  ]

  const cardCols: TableCol<CardWindow>[] = [
    { key: 'card_label', label: 'Card', render: r => (
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
          {r.card_label || '(unnamed)'}
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs, color: 'var(--txt3)' }}>
          CIF {r.cif}
        </div>
      </div>
    ) },
    { key: 'valid_from', label: 'Held From', sortable: true, width: 130,
      render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtDate(r.valid_from)}</span> },
    { key: 'valid_to', label: 'Until', sortable: true, width: 130,
      render: r => r.valid_to
        ? <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtDate(r.valid_to)}</span>
        : <Badge variant="success">still held</Badge> },
    { key: 'txns', label: 'Txns in Window', align: 'right', sortable: true, width: 140,
      render: r => <span style={NUM}>{fmtNum(r.txns)}</span> },
  ]

  const title = v ? v.reg_no : 'Vehicle'
  const descr = v
    ? [v.make, v.model, v.model_year ? String(v.model_year) : null].filter(Boolean).join(' ')
    : ''

  return (
    <Page
      title={title}
      subtitle={[descr, v?.driver ? `driver ${v.driver}` : null, v?.department]
        .filter(Boolean).join(' · ') || 'One vehicle: what it cost, how far it went, what was done to it'}
      loading={loading && !d}
      skeletonKpis={4}
      back={{ label: 'Fleet', to: '/fleet' }}
      actions={canWrite ? (
        <>
          <Button size="sm" icon="speed" onClick={() => setOdoOpen(true)}>Record Reading</Button>
          <Button size="sm" variant="secondary" icon="build" onClick={() => setMOpen(true)}>Log Work</Button>
          <Button size="sm" variant="secondary" icon="report" onClick={() => setIOpen(true)}>Log Incident</Button>
          <Button size="sm" variant="secondary" icon="edit" onClick={openEdit}>Edit</Button>
        </>
      ) : undefined}
    >
      <ErrBanner error={error} onRetry={load} />

      {notice && (
        <div role="status" style={{
          display: 'flex', alignItems: 'center', gap: SP[3],
          padding: SP[4], marginBottom: SP[4], borderRadius: RADIUS.lg,
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

      {/* What to say first. A vehicle with no card cannot be costed at all, and a
          vehicle with no readings cannot be measured — either gap makes the figures
          below a fraction rather than the whole, so it is said before them. */}
      {!loading && v && (!liveCard || odo.length === 0) && (
        <div role="note" style={{
          display: 'flex', alignItems: 'flex-start', gap: SP[3],
          padding: SP[4], marginBottom: SP[5], borderRadius: RADIUS.lg,
          background: 'var(--card)', border: '1px solid var(--card-bdr)',
          borderLeft: `4px solid ${AMBER}`, boxShadow: 'var(--card-shadow)',
        }}>
          <span className="material-symbols-rounded" aria-hidden="true"
            style={{ fontSize: 22, color: AMBER, flexShrink: 0, marginTop: 1 }}>help</span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>
              {!liveCard && odo.length === 0
                ? 'This vehicle has no fuel card and no odometer readings'
                : !liveCard
                  ? 'This vehicle holds no fuel card'
                  : 'No odometer readings yet'}
            </div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 3, lineHeight: 'var(--lh-relaxed)' }}>
              {!liveCard && (
                <>Fuel spend is read from the O3-issued card that pays for it, so until a card is
                mapped to this vehicle its cost reads zero — the money exists in the card ledger
                but belongs to nobody. </>
              )}
              {odo.length === 0 && (
                <>Distance and consumption come from odometer readings, which only a person can
                supply; nothing in the ledger knows how far a car went. Record a reading at each
                fill and the series builds itself.</>
              )}
            </div>
            <div style={{ display: 'flex', gap: SP[2], marginTop: SP[3], flexWrap: 'wrap' }}>
              {!liveCard && (
                <Button size="sm" icon="link" onClick={() => navigate('/fleet/cards')}>Map a Card</Button>
              )}
              {odo.length === 0 && canWrite && (
                <Button size="sm" variant="secondary" icon="speed"
                  onClick={() => setOdoOpen(true)}>Record a Reading</Button>
              )}
            </div>
          </div>
        </div>
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: SP[3], marginBottom: SP[5],
      }}>
        <KpiCard label="Card Spend (Lifetime)" value={fmtKobo(lifetimeSpend)}
          sub={liveCard ? `card ${liveCard.card_label || liveCard.cif}` : 'no card mapped'}
          icon="local_gas_station" accent={lifetimeSpend > 0 ? NAVY : 'var(--txt3)'}
          loading={loading && !d} />
        <KpiCard label="Distance Measured" value={measured.km > 0 ? `${fmtNum(measured.km)} km` : '—'}
          sub={measured.rows > 0
            ? `${fmtNum(measured.rows)} interval(s), ${fmtDate(measured.from!)} to ${fmtDate(measured.to!)}`
            : 'needs two readings'}
          icon="route" accent={measured.km > 0 ? BLUE : 'var(--txt3)'} loading={loading && !d} />
        <KpiCard label="Cost per km"
          value={costPerKm !== null ? fmtKobo(Math.round(costPerKm)) : '—'}
          sub={costPerKm !== null
            ? `over the ${fmtNum(windowSpend!.months)} measured month(s)`
            : 'needs spend and distance in the same period'}
          icon="payments" accent={costPerKm !== null ? PURPLE : 'var(--txt3)'} loading={loading && !d} />
        <KpiCard label="Consumption"
          value={consumption ? `${consumption.per100.toFixed(1)} L/100km` : '—'}
          sub={consumption
            ? `${fmtNum(consumption.pairs)} full-to-full interval(s)`
            : partFills > 0 ? `${fmtNum(partFills)} part fill(s) cannot be measured` : 'needs two full fills'}
          icon="local_gas_station" accent={consumption ? GREEN : 'var(--txt3)'} loading={loading && !d} />
      </div>

      {/* Total cost of ownership, which is not the fuel figure above on its own. */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
        gap: SP[3], marginBottom: SP[5],
      }}>
        <KpiCard label="Maintenance" value={fmtKobo(maintCost)}
          sub={`${fmtNum(maint.length)} record(s)`} icon="build"
          accent={maintCost > 0 ? AMBER : 'var(--txt3)'} loading={loading && !d} />
        <KpiCard label="Incidents" value={fmtKobo(incidentCost)}
          sub={openIncidents.length ? `${fmtNum(openIncidents.length)} still open` : `${fmtNum(incidents.length)} record(s)`}
          icon="report" accent={openIncidents.length ? RED : incidentCost > 0 ? AMBER : 'var(--txt3)'}
          loading={loading && !d} />
        <KpiCard label="All In" value={fmtKobo(lifetimeSpend + maintCost + incidentCost)}
          sub="fuel, work and incidents" icon="functions" accent={NAVY} loading={loading && !d} />
        <KpiCard label="Last Reading" value={lastReading ? fmtDate(lastReading) : '—'}
          sub={dueSoon.length ? `${fmtNum(dueSoon.length)} job(s) due within 30 days` : 'nothing due in 30 days'}
          icon="event" accent={dueSoon.length ? AMBER : 'var(--txt3)'} loading={loading && !d} />
      </div>

      {v?.status && v.status !== 'active' && (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: SP[2], marginBottom: SP[4],
          padding: `${SP[2]}px ${SP[3]}px`, borderRadius: RADIUS.md,
          background: 'var(--th-bg)', border: '1px solid var(--card-bdr)',
        }}>
          <span className="material-symbols-rounded" aria-hidden="true"
            style={{ fontSize: 18, color: STATUS_TONE[v.status] ?? 'var(--txt3)' }}>info</span>
          <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>
            This vehicle is marked <strong style={{ color: STATUS_TONE[v.status] ?? 'var(--txt)' }}>
              {humanLabel(v.status)}</strong>.
          </span>
        </div>
      )}

      <Tabs
        active={tab} onChange={setTab}
        tabs={[
          { key: 'distance',    label: 'Distance & Fuel', badge: odo.length },
          { key: 'maintenance', label: 'Maintenance',     badge: maint.length },
          { key: 'incidents',   label: 'Incidents',       badge: incidents.length },
          { key: 'spend',       label: 'Card Spend',      badge: spend.length },
          { key: 'cards',       label: 'Cards Held',      badge: cards.length },
          { key: 'details',     label: 'Details' },
        ]}
      />

      {tab === 'distance' && (
        <SectionCard title="Odometer & Consumption" padding={false}
          subtitle={fullOdo
            ? `Showing ${fmtNum(odo.length)} reading(s). Consumption appears only between two fills that were both to full`
            : odo.length >= 100
              ? 'Showing the 100 most recent readings — load the full series to see the rest'
              : 'Consumption appears only between two fills that were both to full — any other pair measures an unknown starting level'}
          actions={
            <div style={{ display: 'flex', gap: SP[2], flexWrap: 'wrap' }}>
              {!fullOdo && odo.length >= 100 && (
                <Button size="sm" variant="secondary" icon="history"
                  onClick={loadFullOdo} loading={loadingOdo}>Load Full History</Button>
              )}
              {canWrite && (
                <Button size="sm" icon="add" onClick={() => setOdoOpen(true)}>Record Reading</Button>
              )}
            </div>
          }>
          <DataTable
            cols={odoCols} rows={odo} keyFn={r => String(r.id)}
            loading={loading && !d} skeletonRows={6} pageSize={25}
            emptyText={
              <EmptyState icon="speed" title="No Readings Yet"
                description="Distance and fuel efficiency are the one part of this module the ledger cannot supply. Record the odometer at each fill and the series builds itself."
                action={canWrite ? { label: 'Record a Reading', icon: 'add', onClick: () => setOdoOpen(true) } : undefined} />
            }
          />
        </SectionCard>
      )}

      {tab === 'maintenance' && (
        <SectionCard title="Work Done" padding={false}
          subtitle="Servicing, repairs, papers and licences. A reading entered here also joins the distance series"
          actions={canWrite
            ? <Button size="sm" icon="add" onClick={() => setMOpen(true)}>Log Work</Button>
            : undefined}>
          <DataTable
            cols={maintCols} rows={maint} keyFn={r => String(r.id)}
            searchKeys={['vendor', 'description', 'invoice_ref', 'kind']}
            searchPlaceholder="Search vendor, work or invoice…"
            loading={loading && !d} skeletonRows={5} pageSize={25}
            emptyText={
              <EmptyState icon="build" title="No Work Recorded"
                description="Servicing, repairs and renewals recorded here feed the Work Falling Due list on the Fleet Overview."
                action={canWrite ? { label: 'Log Work', icon: 'add', onClick: () => setMOpen(true) } : undefined} />
            }
          />
        </SectionCard>
      )}

      {tab === 'incidents' && (
        <SectionCard title="Incidents" padding={false}
          subtitle="Accidents, fines, breakdowns and theft"
          actions={canWrite
            ? <Button size="sm" icon="add" onClick={() => setIOpen(true)}>Log Incident</Button>
            : undefined}>
          <DataTable
            cols={incCols} rows={incidents} keyFn={r => String(r.id)}
            searchKeys={['description', 'kind', 'reported_by_name']}
            searchPlaceholder="Search incidents…"
            loading={loading && !d} skeletonRows={4} pageSize={25}
            emptyText={
              <EmptyState icon="verified" title="No Incidents Recorded"
                description="Nothing has been logged against this vehicle."
                action={canWrite ? { label: 'Log Incident', icon: 'add', onClick: () => setIOpen(true) } : undefined} />
            }
          />
        </SectionCard>
      )}

      {tab === 'spend' && (
        <SectionCard title="What the Card Paid For" padding={false}
          subtitle={spend.length >= 300
            ? 'The 300 most recent transactions. The lifetime total above is complete'
            : 'Every debit on the cards this vehicle has held, within the window it held them'}>
          <DataTable
            cols={spendCols} rows={spend} keyFn={(r, i) => `${r.txn_date}-${i}`}
            searchKeys={['merchant_name', 'description', 'txn_code', 'card_label']}
            searchPlaceholder="Search merchant or description…"
            loading={loading && !d} skeletonRows={8} pageSize={25}
            emptyText={
              <EmptyState icon="receipt_long" title="No Card Spend"
                description={liveCard
                  ? 'The mapped card has no debits in its holding window yet.'
                  : 'No card is mapped to this vehicle, so no spend can be attributed to it.'}
                action={!liveCard ? { label: 'Map a Card', icon: 'link', onClick: () => navigate('/fleet/cards') } : undefined} />
            }
          />
        </SectionCard>
      )}

      {tab === 'cards' && (
        <SectionCard title="Cards Held" padding={false}
          subtitle="A card is held for a period, not forever — closing a window leaves past spend with the vehicle that incurred it">
          <DataTable
            cols={cardCols} rows={cards} keyFn={r => String(r.id)}
            loading={loading && !d} skeletonRows={3} pageSize={25}
            emptyText={
              <EmptyState icon="credit_card_off" title="No Card Ever Mapped"
                description="Fuel spend is attributed through the card that pays for it, so this vehicle currently has no cost."
                action={{ label: 'Map a Card', icon: 'link', onClick: () => navigate('/fleet/cards') }} />
            }
          />
        </SectionCard>
      )}

      {tab === 'details' && (
        <SectionCard title="Register Entry"
          subtitle="What the register holds about this vehicle, beyond what it costs to run"
          actions={canWrite
            ? <Button size="sm" variant="secondary" icon="edit" onClick={openEdit}>Edit</Button>
            : undefined}>
          <dl style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
            gap: `${SP[4]}px ${SP[5]}px`, margin: 0,
          }}>
            {([
              ['Registration', v?.reg_no],
              ['Make & model', [v?.make, v?.model].filter(Boolean).join(' ') || null],
              ['Year', v?.model_year != null ? String(v.model_year) : null],
              ['Colour', v?.colour],
              ['Status', v?.status ? humanLabel(v.status) : null],
              ['Department', v?.department],
              ['Driver', v?.driver || v?.assigned_driver_name],
              ['VIN', v?.vin],
              ['Engine number', v?.engine_no],
              ['Acquired on', v?.acquired_on ? fmtDate(v.acquired_on) : null],
              ['Purchase cost', Number(v?.acquisition_cost_kobo ?? 0) > 0
                ? fmtKobo(Number(v!.acquisition_cost_kobo)) : null],
              ['Disposed on', v?.disposed_on ? fmtDate(v.disposed_on) : null],
              ['Disposal proceeds', Number(v?.disposal_proceeds_kobo ?? 0) > 0
                ? fmtKobo(Number(v!.disposal_proceeds_kobo)) : null],
              ['Fuel card', liveCard ? (liveCard.card_label || `CIF ${liveCard.cif}`) : null],
            ] as [string, string | null | undefined][]).map(([label, value]) => (
              <div key={label} style={{ minWidth: 0 }}>
                <dt style={{
                  fontSize: TEXT.xs, color: 'var(--txt3)', textTransform: 'uppercase',
                  letterSpacing: '0.04em', marginBottom: 2,
                }}>{label}</dt>
                <dd style={{
                  margin: 0, fontSize: TEXT.sm,
                  color: value ? 'var(--txt)' : 'var(--txt3)',
                  fontWeight: value ? FW.medium : FW.normal,
                  overflowWrap: 'anywhere',
                }}>{value || 'not recorded'}</dd>
              </div>
            ))}
          </dl>
          {v?.notes && (
            <div style={{
              marginTop: SP[4], padding: SP[3], borderRadius: RADIUS.md,
              background: 'var(--th-bg)', fontSize: TEXT.sm, color: 'var(--txt2)',
              lineHeight: 'var(--lh-relaxed)',
            }}>
              <strong style={{ color: 'var(--txt)' }}>Notes. </strong>{v.notes}
            </div>
          )}
        </SectionCard>
      )}

      {/* ── Edit the register entry ──
          A partial send: an emptied field clears, which is why the driver and
          department can be unassigned here and not only reassigned. */}
      <Modal open={eOpen} onClose={() => setEOpen(false)}
        title={v ? `Edit ${v.reg_no}` : 'Edit Vehicle'} width={660}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEOpen(false)} disabled={saving}>Cancel</Button>
            <Button icon="save" onClick={saveEdit} loading={saving}>Save Changes</Button>
          </>
        }>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: SP[3] }}>
          <Field label="Make"><Input value={eMake} onChange={e => setEMake(e.target.value)} /></Field>
          <Field label="Model"><Input value={eModel} onChange={e => setEModel(e.target.value)} /></Field>
          <Field label="Year"><Input inputMode="numeric" value={eYear} onChange={e => setEYear(e.target.value)} /></Field>
          <Field label="Colour"><Input value={eColour} onChange={e => setEColour(e.target.value)} /></Field>
          <Field label="Status" hint="Workshop, reserve, stolen or disposed.">
            <Select value={eStatus} onChange={e => setEStatus(e.target.value)}>
              {VEHICLE_STATUSES.map(s => <option key={s} value={s}>{humanLabel(s)}</option>)}
            </Select>
          </Field>
          <Field label="Department" hint="Blank unassigns it.">
            <Select value={eDept} onChange={e => setEDept(e.target.value)}>
              <option value="">Not assigned</option>
              {departments.map(x => <option key={x.id} value={String(x.id)}>{x.name}</option>)}
            </Select>
          </Field>
          <Field label="Driver (staff)" hint="Blank unassigns it.">
            <Select value={eDriverId} onChange={e => setEDriverId(e.target.value)}>
              <option value="">Not assigned</option>
              {drivers.map(x => <option key={x.id} value={String(x.id)}>{x.full_name}</option>)}
            </Select>
          </Field>
          <Field label="Driver name" hint="A driver with no staff account.">
            <Input value={eDriverName} onChange={e => setEDriverName(e.target.value)} />
          </Field>
          <Field label="VIN"><Input value={eVin} onChange={e => setEVin(e.target.value)} /></Field>
          <Field label="Engine number"><Input value={eEngine} onChange={e => setEEngine(e.target.value)} /></Field>
          <Field label="Acquired on">
            <Input type="date" value={eAcquired} max={today()} onChange={e => setEAcquired(e.target.value)} />
          </Field>
          <Field label="Purchase cost (₦)">
            <Input inputMode="decimal" value={eAcqCost} onChange={e => setEAcqCost(e.target.value)} />
          </Field>
          <Field label="Disposed on" hint="Set this and the status together.">
            <Input type="date" value={eDisposed} max={today()} onChange={e => setEDisposed(e.target.value)} />
          </Field>
          <Field label="Disposal proceeds (₦)">
            <Input inputMode="decimal" value={eProceeds} onChange={e => setEProceeds(e.target.value)} />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea rows={2} value={eNotes} onChange={e => setENotes(e.target.value)} />
        </Field>
        <p style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: SP[2], lineHeight: 'var(--lh-relaxed)' }}>
          The registration number cannot be changed here. It is the key this vehicle is known by on
          invoices and fines, so renaming it would silently re-identify everything already filed
          against it — retire the entry and add a new one instead.
        </p>
      </Modal>

      {/* ── Record a reading ── */}
      <Modal open={odoOpen} onClose={() => setOdoOpen(false)} title="Record an Odometer Reading" width={560}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOdoOpen(false)} disabled={saving}>Cancel</Button>
            <Button icon="speed" onClick={addReading} loading={saving}
              disabled={!readingKm.trim() || !readOn}>Record Reading</Button>
          </>
        }>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: SP[3] }}>
          <Field label="Date read" required>
            <Input type="date" value={readOn} max={today()} onChange={e => setReadOn(e.target.value)} />
          </Field>
          <Field label="Odometer (km)" required hint="The total on the dial, not the distance since.">
            <Input inputMode="numeric" value={readingKm} placeholder="e.g. 84500"
              onChange={e => setReadingKm(e.target.value)} />
          </Field>
          <Field label="Litres added" hint="Optional. Needed for a consumption figure.">
            <Input inputMode="decimal" value={litres} placeholder="e.g. 45.5"
              onChange={e => setLitres(e.target.value)} />
          </Field>
          <Field label="Filled to full?"
            hint="Consumption can only be worked out between two full fills.">
            <Select value={toFull} onChange={e => setToFull(e.target.value)}>
              <option value="yes">Yes — filled to full</option>
              <option value="no">No — part fill</option>
            </Select>
          </Field>
          <Field label="Taken at">
            <Select value={odoSource} onChange={e => setOdoSource(e.target.value)}>
              {ODO_SOURCES.map(s => <option key={s} value={s}>{humanLabel(s)}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Note" hint="Use this if the instrument cluster was replaced, or the figure needs explaining.">
          <Textarea rows={2} value={odoNote} onChange={e => setOdoNote(e.target.value)} />
        </Field>
        <p style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: SP[2], lineHeight: 'var(--lh-relaxed)' }}>
          A reading below the last one on or before this date is refused: an odometer only counts up,
          and a lower figure is a typo, a replaced cluster or the wrong vehicle. Record it as a
          <strong> manual</strong> correction with a note if the cluster really was changed.
        </p>
      </Modal>

      {/* ── Log work ── */}
      <Modal open={mOpen} onClose={() => setMOpen(false)} title="Log Work on This Vehicle" width={620}
        footer={
          <>
            <Button variant="secondary" onClick={() => setMOpen(false)} disabled={saving}>Cancel</Button>
            <Button icon="build" onClick={addWork} loading={saving} disabled={!mOn}>Record Work</Button>
          </>
        }>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: SP[3] }}>
          <Field label="Kind of work" required>
            <Select value={mKind} onChange={e => setMKind(e.target.value)}>
              {MAINT_KINDS.map(k => <option key={k} value={k}>{humanLabel(k)}</option>)}
            </Select>
          </Field>
          <Field label="Date done" required>
            <Input type="date" value={mOn} max={today()} onChange={e => setMOn(e.target.value)} />
          </Field>
          <Field label="Vendor">
            <Input value={mVendor} placeholder="Who did the work"
              onChange={e => setMVendor(e.target.value)} />
          </Field>
          <Field label="Cost (₦)" hint="In naira. Stored to the kobo.">
            <Input inputMode="decimal" value={mCost} placeholder="e.g. 85000"
              onChange={e => setMCost(e.target.value)} />
          </Field>
          <Field label="Odometer at the time (km)"
            hint="Captured once, used twice — it joins the distance series too.">
            <Input inputMode="numeric" value={mOdo} placeholder="e.g. 84500"
              onChange={e => setMOdo(e.target.value)} />
          </Field>
          <Field label="Invoice reference">
            <Input value={mInvoice} onChange={e => setMInvoice(e.target.value)} />
          </Field>
          <Field label="Next due on" hint="Drives the Work Falling Due list.">
            <Input type="date" value={mDueOn} onChange={e => setMDueOn(e.target.value)} />
          </Field>
          <Field label="Next due at (km)">
            <Input inputMode="numeric" value={mDueKm} placeholder="e.g. 89500"
              onChange={e => setMDueKm(e.target.value)} />
          </Field>
        </div>
        <Field label="What was done">
          <Textarea rows={2} value={mDesc} onChange={e => setMDesc(e.target.value)} />
        </Field>
      </Modal>

      {/* ── Log incident ── */}
      <Modal open={iOpen} onClose={() => setIOpen(false)} title="Log an Incident" width={560}
        footer={
          <>
            <Button variant="secondary" onClick={() => setIOpen(false)} disabled={saving}>Cancel</Button>
            <Button icon="report" onClick={addIncident} loading={saving} disabled={!iOn}>Record Incident</Button>
          </>
        }>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: SP[3] }}>
          <Field label="Kind" required>
            <Select value={iKind} onChange={e => setIKind(e.target.value)}>
              {INCIDENT_KINDS.map(k => <option key={k} value={k}>{humanLabel(k)}</option>)}
            </Select>
          </Field>
          <Field label="Date it happened" required>
            <Input type="date" value={iOn} max={today()} onChange={e => setIOn(e.target.value)} />
          </Field>
          <Field label="Cost (₦)" hint="Leave blank if not yet known.">
            <Input inputMode="decimal" value={iCost} onChange={e => setICost(e.target.value)} />
          </Field>
          <Field label="Resolved on" hint="Leave blank while it is still open.">
            <Input type="date" value={iResolved} onChange={e => setIResolved(e.target.value)} />
          </Field>
        </div>
        <Field label="What happened">
          <Textarea rows={3} value={iDesc} onChange={e => setIDesc(e.target.value)} />
        </Field>
      </Modal>
    </Page>
  )
}
