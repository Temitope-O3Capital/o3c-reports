import { useEffect, useState } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, KpiCard, Button, Input, Select } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost, apiPut, unwrap, unwrapList } from '../../lib/api'
import { fmtKoboExact, fmtNum, fmtDate, fmtDatetime, fmtPct, today } from '../../lib/fmt'
import { GREEN, RED, AMBER, PURPLE, TEXT, FW, SP } from '../../lib/design'
import { toast } from 'sonner'

// Blink's finance report — funding, the BlueSalt fee split, and the FX pipeline
// (accumulated foreign currency awaiting sale). Separate from BlinkCard.tsx, which
// is the card-population/usage view and is untouched by this.
//
// Funding/fee figures are parsed best-effort from GL narration where BlueSalt's
// posting happens to embed a rate (~26% of wallet postings do); everything else
// needs a manual entry. This page says so rather than implying full coverage.

interface CurrencyRow { currency: string; fx_total: number; ngn_total: number; events: number }
interface PipelineRow { currency: string; funded_fx: number; sold_fx: number; unsold_fx: number; booking_wac: number | null }
interface SaleRow {
  id: number; currency: string; fx_amount: number; rate: number; rate_source: string
  occurred_at: string; notes: string; gain_loss_ngn_kobo?: number; booking_wac?: number
}
interface FeeSplit { total_fee_pct: number; bluesalt_cut_pct: number; vat_rate_pct: number; o3_share_pct: number }
interface Report {
  funding_by_currency: CurrencyRow[]
  pipeline_by_currency: PipelineRow[]
  realized_sales: SaleRow[]
  fee_split: FeeSplit
  note: string
}
interface FXEvent {
  id: number; event_type: 'funding' | 'fee' | 'sale'; currency: string; fx_amount: number
  ngn_amount_kobo: number; rate: number; rate_source: string; branch_name: string | null
  occurred_at: string; notes: string | null; status: string
  initiated_by_name: string | null; approved_by_name: string | null
}

const EVENT_TYPES = [
  { value: 'funding', label: 'Funding' },
  { value: 'fee', label: 'Fee' },
] as const

export default function BlinkReport() {
  const [data, setData] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saleForm, setSaleForm] = useState({ currency: 'USD', fx_amount: '', rate: '' })
  const [saleBusy, setSaleBusy] = useState(false)
  const [saleResult, setSaleResult] = useState<any>(null)

  const [pending, setPending] = useState<FXEvent[]>([])
  const [pendingLoading, setPendingLoading] = useState(true)
  const [eventForm, setEventForm] = useState({ event_type: 'funding', currency: 'USD', fx_amount: '', rate: '', branch_name: '', occurred_at: today(), notes: '' })
  const [eventBusy, setEventBusy] = useState(false)
  const [actingId, setActingId] = useState<number | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch('/api/finance/blink-report')
      setData(unwrap<Report>(res))
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load Blink report')
    } finally {
      setLoading(false)
    }
  }
  async function loadPending() {
    setPendingLoading(true)
    try {
      const res = await apiFetch('/api/finance/blink-fx-events?status=pending')
      setPending(unwrapList<FXEvent>(res))
    } catch (e: any) {
      setPending([])
      setError(e?.message ?? 'Failed to load pending events')
    } finally {
      setPendingLoading(false)
    }
  }
  useEffect(() => { load(); loadPending() }, [])

  async function recordSale() {
    if (!saleForm.fx_amount || Number(saleForm.fx_amount) <= 0) return
    setSaleBusy(true)
    setSaleResult(null)
    try {
      const body: any = { currency: saleForm.currency, fx_amount: Number(saleForm.fx_amount) }
      if (saleForm.rate) body.rate = Number(saleForm.rate)
      const res = await apiFetch('/api/finance/blink-fx-events/sale', { method: 'POST', body: JSON.stringify(body) })
      setSaleResult(unwrap(res))
      setSaleForm({ currency: saleForm.currency, fx_amount: '', rate: '' })
      toast.success('Sale recorded')
      load()
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to record sale')
    } finally {
      setSaleBusy(false)
    }
  }

  async function recordEvent() {
    if (!eventForm.fx_amount || Number(eventForm.fx_amount) <= 0) return
    if (!eventForm.rate || Number(eventForm.rate) <= 0) return
    setEventBusy(true)
    try {
      await apiPost('/api/finance/blink-fx-events', {
        event_type: eventForm.event_type,
        currency: eventForm.currency,
        fx_amount: Number(eventForm.fx_amount),
        rate: Number(eventForm.rate),
        branch_name: eventForm.branch_name || undefined,
        occurred_at: new Date(eventForm.occurred_at).toISOString(),
        notes: eventForm.notes || undefined,
      })
      setEventForm({ ...eventForm, fx_amount: '', rate: '', notes: '' })
      toast.success('Event recorded')
      loadPending()
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to record the event')
    } finally {
      setEventBusy(false)
    }
  }

  async function approveEvent(id: number) {
    setActingId(id)
    try {
      await apiPut(`/api/finance/blink-fx-events/${id}/approve`, {})
      toast.success('Event approved')
      loadPending()
      load()
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to approve')
    } finally {
      setActingId(null)
    }
  }
  async function rejectEvent(id: number) {
    setActingId(id)
    try {
      await apiPut(`/api/finance/blink-fx-events/${id}/reject`, {})
      toast.success('Event rejected')
      loadPending()
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to reject')
    } finally {
      setActingId(null)
    }
  }

  const pipelineCols: TableCol<PipelineRow>[] = [
    { key: 'currency', label: 'Currency' },
    { key: 'funded_fx', label: 'Funded', align: 'right', render: r => fmtNum(r.funded_fx) },
    { key: 'sold_fx', label: 'Sold', align: 'right', render: r => fmtNum(r.sold_fx) },
    { key: 'unsold_fx', label: 'Unsold (Pipeline)', align: 'right', render: r => fmtNum(r.unsold_fx) },
    { key: 'booking_wac', label: 'Booking WAC', align: 'right', render: r => r.booking_wac ? fmtNum(r.booking_wac) : '—' },
  ]

  const saleCols: TableCol<SaleRow>[] = [
    { key: 'occurred_at', label: 'Date', render: r => fmtDate(r.occurred_at) },
    { key: 'currency', label: 'Currency' },
    { key: 'fx_amount', label: 'Amount Sold', align: 'right', render: r => fmtNum(r.fx_amount) },
    { key: 'rate', label: 'Realized Rate', align: 'right', render: r => fmtNum(r.rate) },
    { key: 'booking_wac', label: 'Booking WAC', align: 'right', render: r => r.booking_wac ? fmtNum(r.booking_wac) : '—' },
    {
      key: 'gain_loss_ngn_kobo', label: 'Gain/Loss', align: 'right',
      render: r => {
        const v = r.gain_loss_ngn_kobo ?? 0
        return <span style={{ color: v >= 0 ? GREEN : RED, fontWeight: FW.semibold }}>{fmtKoboExact(v)}</span>
      },
    },
    { key: 'rate_source', label: 'Rate Source' },
  ]

  const fundingCols: TableCol<CurrencyRow>[] = [
    { key: 'currency', label: 'Currency' },
    { key: 'fx_total', label: 'FX Funded', align: 'right', render: r => fmtNum(r.fx_total) },
    { key: 'ngn_total', label: 'NGN Credited', align: 'right', render: r => fmtKoboExact(r.ngn_total) },
    { key: 'events', label: 'Events', align: 'right', render: r => fmtNum(r.events) },
  ]

  const pendingCols: TableCol<FXEvent>[] = [
    { key: 'occurred_at', label: 'Date', render: r => fmtDatetime(r.occurred_at) },
    { key: 'event_type', label: 'Type', render: r => <span style={{ textTransform: 'capitalize' }}>{r.event_type}</span> },
    { key: 'currency', label: 'Currency' },
    { key: 'fx_amount', label: 'FX Amount', align: 'right', render: r => fmtNum(r.fx_amount) },
    { key: 'rate', label: 'Rate', align: 'right', render: r => fmtNum(r.rate) },
    { key: 'ngn_amount_kobo', label: 'NGN', align: 'right', render: r => fmtKoboExact(r.ngn_amount_kobo) },
    { key: 'branch_name', label: 'Branch', render: r => r.branch_name === 'Head Office Branch' ? 'Lagos' : r.branch_name === 'Abuja Branch' ? 'Abuja' : '—' },
    { key: 'initiated_by_name', label: 'By', render: r => r.initiated_by_name ?? '—' },
    {
      key: 'id', label: '', align: 'right', sortable: false,
      render: r => (
        <div style={{ display: 'flex', gap: SP[2], justifyContent: 'flex-end' }}>
          <Button size="xs" variant="ghost" loading={actingId === r.id} onClick={() => approveEvent(r.id)}>Approve</Button>
          <Button size="xs" variant="danger" loading={actingId === r.id} onClick={() => rejectEvent(r.id)}>Reject</Button>
        </div>
      ),
    },
  ]

  return (
    <Page title="Blink FX Report" subtitle="Funding, fee split, and the FX pipeline"
      back={{ label: 'Finance', to: '/finance' }} loading={loading && !data} skeletonKpis={4}>
      <ErrBanner error={error} onRetry={() => load()} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: SP[4], marginBottom: SP[4] }}>
        <KpiCard label="Total Fee (BlueSalt)" value={fmtPct(data?.fee_split.total_fee_pct ?? 0)} icon="percent" accent={PURPLE} />
        <KpiCard label="BlueSalt Cut" value={fmtPct(data?.fee_split.bluesalt_cut_pct ?? 0)} icon="handshake" accent={AMBER} />
        <KpiCard label="VAT (on BlueSalt's cut)" value={fmtPct(data?.fee_split.vat_rate_pct ?? 0)} icon="receipt" accent={AMBER} />
        <KpiCard label="O3's Net Share" value={fmtPct(data?.fee_split.o3_share_pct ?? 0)} icon="trending_up" accent={GREEN} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: SP[4], marginBottom: SP[4] }}>
        <SectionCard title="Funding by Currency" subtitle="Approved events only">
          <DataTable cols={fundingCols} rows={data?.funding_by_currency ?? []} keyFn={r => r.currency} />
        </SectionCard>

        <SectionCard title="FX Pipeline" subtitle="Accumulated foreign currency awaiting sale">
          <DataTable cols={pipelineCols} rows={data?.pipeline_by_currency ?? []} keyFn={r => r.currency} />
        </SectionCard>
      </div>

      <SectionCard title="Record a Sale" subtitle="Leave rate blank to use the latest parallel-market reference rate">
        <div style={{ display: 'flex', gap: SP[4], alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <Select label="Currency" value={saleForm.currency} onChange={e => setSaleForm({ ...saleForm, currency: e.target.value })}
            wrapStyle={{ width: 120 }}>
            <option value="USD">USD</option>
            <option value="GBP">GBP</option>
            <option value="EUR">EUR</option>
          </Select>
          <Input label="Amount Sold" type="number" value={saleForm.fx_amount}
            onChange={e => setSaleForm({ ...saleForm, fx_amount: e.target.value })}
            wrapStyle={{ width: 160 }} />
          <Input label="Realized Rate (Optional)" type="number" value={saleForm.rate}
            onChange={e => setSaleForm({ ...saleForm, rate: e.target.value })}
            placeholder="auto from parallel market" wrapStyle={{ width: 220 }} />
          <Button onClick={recordSale} loading={saleBusy} style={{ marginTop: 22 }}>Record Sale</Button>
        </div>
        {saleResult && (
          <div style={{ marginTop: SP[4], padding: SP[3], borderRadius: 8, background: 'var(--th-bg)', fontSize: TEXT.sm }}>
            Realized at {fmtNum(saleResult.realized_rate)} ({saleResult.rate_source}) against a booking WAC of{' '}
            {fmtNum(saleResult.booking_wac)} — gain/loss:{' '}
            <span style={{ color: (saleResult.gain_loss_ngn_kobo ?? 0) >= 0 ? GREEN : RED, fontWeight: FW.semibold }}>
              {fmtKoboExact(saleResult.gain_loss_ngn_kobo ?? 0)}
            </span>
          </div>
        )}
      </SectionCard>

      <div style={{ marginTop: SP[4] }}>
        <SectionCard title="Realized Sales" subtitle="Gain/loss vs. the booking WAC at the time of each sale">
          <DataTable cols={saleCols} rows={data?.realized_sales ?? []} keyFn={r => r.id} />
        </SectionCard>
      </div>

      {/* Funding/fee events the narration parser missed (~74% of BlueSalt wallet
          postings have no embedded rate — see the note below) have no other way in. */}
      <div style={{ marginTop: SP[4] }}>
        <SectionCard title="Record a Funding or Fee Event" subtitle="For a BlueSalt posting the narration parser couldn't read a rate from">
          <div style={{ display: 'flex', gap: SP[4], alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <Select label="Type" value={eventForm.event_type} onChange={e => setEventForm({ ...eventForm, event_type: e.target.value })} wrapStyle={{ width: 140 }}>
              {EVENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
            <Select label="Currency" value={eventForm.currency} onChange={e => setEventForm({ ...eventForm, currency: e.target.value })} wrapStyle={{ width: 120 }}>
              <option value="USD">USD</option>
              <option value="GBP">GBP</option>
              <option value="EUR">EUR</option>
            </Select>
            <Input label="FX Amount" type="number" value={eventForm.fx_amount}
              onChange={e => setEventForm({ ...eventForm, fx_amount: e.target.value })} wrapStyle={{ width: 140 }} />
            <Input label="Rate (NGN per Unit)" type="number" value={eventForm.rate}
              onChange={e => setEventForm({ ...eventForm, rate: e.target.value })} wrapStyle={{ width: 160 }} />
            <Input label="Occurred" type="date" value={eventForm.occurred_at}
              onChange={e => setEventForm({ ...eventForm, occurred_at: e.target.value })} wrapStyle={{ width: 160 }} />
            <Select label="Branch" value={eventForm.branch_name} onChange={e => setEventForm({ ...eventForm, branch_name: e.target.value })} wrapStyle={{ width: 160 }}>
              <option value="">Unspecified</option>
              <option value="Head Office Branch">Lagos</option>
              <option value="Abuja Branch">Abuja</option>
            </Select>
            <Input label="Notes (Optional)" value={eventForm.notes}
              onChange={e => setEventForm({ ...eventForm, notes: e.target.value })} wrapStyle={{ width: 220 }} />
            <Button onClick={recordEvent} loading={eventBusy} style={{ marginTop: 22 }}>Submit for Approval</Button>
          </div>
          <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: SP[3], marginBottom: 0 }}>
            Goes in as pending — it only counts toward Funding by Currency and the FX Pipeline once approved below.
          </p>
        </SectionCard>
      </div>

      <div style={{ marginTop: SP[4] }}>
        <SectionCard title="Pending Events" subtitle="Not yet counted in any figure above until approved" badge={pending.length || undefined}>
          <DataTable cols={pendingCols} rows={pending} keyFn={r => r.id} loading={pendingLoading} emptyText="Nothing pending" />
        </SectionCard>
      </div>

      <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: SP[4] }}>{data?.note}</p>
    </Page>
  )
}
