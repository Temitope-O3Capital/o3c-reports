import { useEffect, useState } from 'react'
import { Page, SectionCard, DataTable, ErrBanner, KpiCard, Button, Input, Select } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, unwrap } from '../../lib/api'
import { fmtKoboExact, fmtNum, fmtDate, fmtPct } from '../../lib/fmt'
import { GREEN, RED, AMBER, PURPLE, TEXT, FW, SP } from '../../lib/design'

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

export default function BlinkReport() {
  const [data, setData] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saleForm, setSaleForm] = useState({ currency: 'USD', fx_amount: '', rate: '' })
  const [saleBusy, setSaleBusy] = useState(false)
  const [saleResult, setSaleResult] = useState<any>(null)

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
  useEffect(() => { load() }, [])

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
      load()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to record sale')
    } finally {
      setSaleBusy(false)
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

  return (
    <Page title="Blink FX Report" subtitle="Funding, fee split, and the FX pipeline"
      back={{ label: 'Finance', to: '/finance' }} loading={loading && !data} skeletonKpis={4}>
      <ErrBanner error={error} onRetry={() => load()} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[4], marginBottom: SP[4] }}>
        <KpiCard label="Total Fee (BlueSalt)" value={fmtPct(data?.fee_split.total_fee_pct ?? 0)} icon="percent" accent={PURPLE} />
        <KpiCard label="BlueSalt Cut" value={fmtPct(data?.fee_split.bluesalt_cut_pct ?? 0)} icon="handshake" accent={AMBER} />
        <KpiCard label="VAT (on BlueSalt's cut)" value={fmtPct(data?.fee_split.vat_rate_pct ?? 0)} icon="receipt" accent={AMBER} />
        <KpiCard label="O3's Net Share" value={fmtPct(data?.fee_split.o3_share_pct ?? 0)} icon="trending_up" accent={GREEN} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: SP[4], marginBottom: SP[4] }}>
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
          <Input label="Realized Rate (optional)" type="number" value={saleForm.rate}
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

      <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: SP[4] }}>{data?.note}</p>
    </Page>
  )
}
