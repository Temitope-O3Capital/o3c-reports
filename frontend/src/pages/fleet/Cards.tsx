import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, KpiCard, SectionCard, ErrBanner, DataTable, EmptyState,
  Button, Badge, Modal, Field, Select,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, BLUE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

/*
  FUEL CARDS — the link that makes every cost figure in this module mean something.

  O3's fuel cards are O3-issued, so their transactions are already in the card
  ledger. What was missing was ownership: nothing said which card belongs to which
  vehicle, so ₦13.5m of 2025 fuel spend sat in the data attributable to nobody.

  Mapping a card here attributes its WHOLE history at once — past and future. That
  is why the page leads with lifetime spend per card rather than with a form: the
  decision being made is "which vehicle incurred this money", and the money is the
  useful thing to see while making it.

  The candidate list is a SUGGESTION, not a filter. It matches on the card name
  (O3C FUEL CARD 2..11, ABUJA FUEL CARD 1..2, O3 CARD FUEL 5, CAR MAINTENANCE 1,
  ZONE PETROLEUM) because that is how these cards are actually distinguishable — but
  a name is a convention, and conventions get broken, so any CIF can be mapped.
*/

interface CardRow {
  cif: string
  name_on_card: string | null
  product_name: string | null
  opened_date: string | null
  lifetime_txns: number
  lifetime_spend_kobo: number
  last_txn: string | null
  vehicle_id: number | null
  mapped_to: string | null
}

interface VehicleOption { id: number; reg_no: string; make: string | null; model: string | null }

export default function FleetCards() {
  const navigate = useNavigate()
  const [cards, setCards]       = useState<CardRow[]>([])
  const [vehicles, setVehicles] = useState<VehicleOption[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)

  const [mapFor, setMapFor]     = useState<CardRow | null>(null)
  const [vehicleId, setVehicleId] = useState('')
  const [saving, setSaving]     = useState(false)
  const [notice, setNotice]     = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [c, v] = await Promise.all([
        apiFetch<{ data: CardRow[] }>('/api/fleet/cards/available'),
        apiFetch<{ data: VehicleOption[] }>('/api/fleet/vehicles?status=active'),
      ])
      setCards(c.data ?? [])
      setVehicles(v.data ?? [])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load the fuel cards')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const mapCard = async () => {
    if (!mapFor || !vehicleId) return
    setSaving(true)
    setError(null)
    try {
      await apiPost(`/api/fleet/vehicles/${vehicleId}/cards`, {
        cif: mapFor.cif,
        card_label: mapFor.name_on_card ?? '',
      })
      const reg = vehicles.find(x => String(x.id) === vehicleId)?.reg_no ?? 'the vehicle'
      setNotice(`${mapFor.name_on_card ?? mapFor.cif} mapped to ${reg}. `
        + `${fmtKobo(mapFor.lifetime_spend_kobo)} of history is now attributed to it.`)
      setMapFor(null)
      setVehicleId('')
      await load()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not map the card')
    } finally {
      setSaving(false)
    }
  }

  const unmap = async (row: CardRow) => {
    setError(null)
    try {
      // The mapping's window is closed rather than deleted, so the vehicle keeps the
      // spend it actually incurred. The API enforces that; this only asks for it.
      const detail = await apiFetch<{ cards: { id: number; cif: string; valid_to: string | null }[] }>(
        `/api/fleet/vehicles/${row.vehicle_id}`)
      const live = (detail.cards ?? []).find(c => c.cif === row.cif && !c.valid_to)
      if (!live) { setError('That mapping is no longer open'); return }
      await apiPost(`/api/fleet/cards/${live.id}/close`, {})
      setNotice(`${row.name_on_card ?? row.cif} released. Its past spend stays with ${row.mapped_to}.`)
      await load()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not release the card')
    }
  }

  const mapped   = useMemo(() => cards.filter(c => c.vehicle_id != null), [cards])
  const unmapped = useMemo(() => cards.filter(c => c.vehicle_id == null), [cards])
  const liveUnmapped = useMemo(
    () => unmapped.filter(c => Number(c.lifetime_txns) > 0), [unmapped])
  const unattributed = useMemo(
    () => liveUnmapped.reduce((s, c) => s + Number(c.lifetime_spend_kobo), 0), [liveUnmapped])

  const cols: TableCol<CardRow>[] = [
    { key: 'name_on_card', label: 'Card', sortable: true, render: r => (
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>
          {r.name_on_card || '(unnamed)'}
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs, color: 'var(--txt3)' }}>
          CIF {r.cif}{r.product_name ? ` · ${r.product_name}` : ''}
        </div>
      </div>
    ) },
    { key: 'lifetime_spend_kobo', label: 'Lifetime Spend', align: 'right', sortable: true, width: 150,
      render: r => Number(r.lifetime_txns) > 0
        ? <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(r.lifetime_spend_kobo)}</span>
        : <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>never used</span> },
    { key: 'lifetime_txns', label: 'Txns', align: 'right', sortable: true, width: 80,
      render: r => Number(r.lifetime_txns) > 0
        ? <span style={NUM}>{fmtNum(r.lifetime_txns)}</span>
        : <span style={{ color: 'var(--txt3)' }}>—</span> },
    { key: 'last_txn', label: 'Last Used', width: 120, render: r => r.last_txn
      ? <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtDate(r.last_txn)}</span>
      : <span style={{ color: 'var(--txt3)' }}>—</span> },
    { key: 'mapped_to', label: 'Vehicle', width: 150, render: r => r.mapped_to
      ? (
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: TEXT.sm, fontWeight: FW.semibold,
          color: GREEN,
        }}>{r.mapped_to}</span>
      )
      : <Badge variant="warning">unmapped</Badge> },
    { key: '_actions', label: '', width: 130, sortable: false, render: r => r.vehicle_id
      ? (
        <Button size="sm" variant="secondary" onClick={() => unmap(r)}>Release</Button>
      )
      : (
        <Button size="sm" icon="link" onClick={() => { setMapFor(r); setVehicleId('') }}
          disabled={vehicles.length === 0}>Map</Button>
      ) },
  ]

  return (
    <Page
      title="Fuel Cards"
      subtitle="Map a card to a vehicle and its whole transaction history attributes itself"
      loading={loading && !cards.length}
      skeletonKpis={3}
      back={{ label: 'Fleet', to: '/fleet' }}
      actions={
        <Button size="sm" variant="secondary" icon="directions_car"
          onClick={() => navigate('/fleet')}>Fleet Overview</Button>
      }
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
            style={{ fontSize: 20, color: GREEN }}>link</span>
          <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{notice}</div>
          <Button size="sm" variant="secondary" style={{ marginLeft: 'auto' }}
            onClick={() => setNotice(null)}>Dismiss</Button>
        </div>
      )}

      {/* The number that makes the case for doing the mapping at all. */}
      {unattributed > 0 && (
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
              {fmtKobo(unattributed)} of card spend belongs to no vehicle
            </div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 3, lineHeight: 'var(--lh-relaxed)' }}>
              Across {fmtNum(liveUnmapped.length)} card(s) that have been used but are not mapped. The money
              was spent and is already recorded — it simply has no owner, so it appears in no vehicle&apos;s
              cost. Mapping each card to its vehicle fixes that retrospectively.
            </div>
          </div>
        </div>
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: SP[3], marginBottom: SP[6],
      }}>
        <KpiCard label="Cards Mapped" value={`${fmtNum(mapped.length)} / ${fmtNum(cards.length)}`}
          sub={mapped.length === cards.length ? 'every card has a vehicle' : `${fmtNum(unmapped.length)} still to map`}
          icon="link" accent={mapped.length === cards.length ? GREEN : AMBER}
          loading={loading && !cards.length} />
        <KpiCard label="Unattributed Spend" value={fmtKobo(unattributed)}
          sub={`${fmtNum(liveUnmapped.length)} used but unmapped card(s)`}
          icon="help" accent={unattributed > 0 ? AMBER : GREEN} loading={loading && !cards.length} />
        <KpiCard label="Vehicles to Map To" value={fmtNum(vehicles.length)}
          sub={vehicles.length === 0 ? 'add a vehicle first' : 'active on the register'}
          icon="directions_car" accent={vehicles.length === 0 ? RED : NAVY}
          loading={loading && !cards.length} />
      </div>

      {vehicles.length === 0 && !loading && (
        <SectionCard style={{ marginBottom: SP[4] }}>
          <EmptyState icon="directions_car" title="No vehicles to map these cards to"
            description="A card is mapped to a vehicle, so the register needs at least one vehicle first."
            action={{ label: 'Add a Vehicle', icon: 'add', onClick: () => navigate('/fleet') }} />
        </SectionCard>
      )}

      <SectionCard title="Candidate Fuel Cards" padding={false}
        subtitle="Matched on the card name, which is how these are distinguishable — a suggestion, not a restriction">
        <DataTable
          cols={cols} rows={cards} keyFn={r => r.cif}
          searchKeys={['name_on_card', 'cif', 'product_name']}
          searchPlaceholder="Search card name or CIF…"
          loading={loading && !cards.length} skeletonRows={6} pageSize={25}
          emptyText={
            <EmptyState icon="credit_card_off" title="No Candidate Cards Found"
              description="No card in the book is named like a fuel or vehicle card. Cards can still be mapped by CIF." />
          }
        />
      </SectionCard>

      {/* ── Map a card ── */}
      <Modal open={mapFor !== null} onClose={() => setMapFor(null)}
        title={mapFor ? `Map ${mapFor.name_on_card ?? mapFor.cif}` : 'Map Card'} width={520}
        footer={
          <>
            <Button variant="secondary" onClick={() => setMapFor(null)} disabled={saving}>Cancel</Button>
            <Button icon="link" onClick={mapCard} loading={saving} disabled={!vehicleId}>Map Card</Button>
          </>
        }>
        {mapFor && (
          <>
            <div style={{
              display: 'flex', gap: SP[5], flexWrap: 'wrap', padding: SP[3], marginBottom: SP[4],
              borderRadius: RADIUS.md, background: 'var(--th-bg)',
            }}>
              <div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Lifetime spend</div>
                <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold }}>
                  {fmtKobo(mapFor.lifetime_spend_kobo)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Transactions</div>
                <div style={{ ...NUM, fontSize: TEXT.md }}>{fmtNum(mapFor.lifetime_txns)}</div>
              </div>
              <div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>Last used</div>
                <div style={{ ...NUM, fontSize: TEXT.md }}>
                  {mapFor.last_txn ? fmtDate(mapFor.last_txn) : '—'}
                </div>
              </div>
            </div>

            <Field label="Vehicle" hint="The card's whole history attributes to this vehicle, past and future.">
              <Select value={vehicleId} onChange={e => setVehicleId(e.target.value)}>
                <option value="">Choose a vehicle…</option>
                {vehicles.map(v => (
                  <option key={v.id} value={String(v.id)}>
                    {v.reg_no}{[v.make, v.model].filter(Boolean).length
                      ? ` — ${[v.make, v.model].filter(Boolean).join(' ')}` : ''}
                  </option>
                ))}
              </Select>
            </Field>

            <p style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: SP[3], lineHeight: 'var(--lh-relaxed)' }}>
              If this card is later moved to a different vehicle, <strong>release</strong> it rather than
              re-mapping: releasing closes the period so the first vehicle keeps the spend it actually
              incurred, instead of the history following the card.
            </p>
          </>
        )}
      </Modal>
    </Page>
  )
}
