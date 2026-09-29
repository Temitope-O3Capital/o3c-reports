import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback } from 'react'
import { SectionCard, ErrBanner, Spinner, DataTable, DateFilter, KpiCard } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, BLUE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { EChart, baseTooltip, tipCard, axisCat, axisVal, CHART_FONT } from '../../components/echarts'
import type { ChartTokens } from '../../components/echarts'
import { rate, isOk, fmtM } from '../../lib/measure'

// Rates on this page are Measures (lib/measure.ts): a ratio that cannot be computed
// renders "—" with its reason on hover, never a 0 or a confident percentage off a
// denominator too small to carry one. See MobileAnalytics.tsx for the reference use.

// Minimum contacts before a campaign conversion rate means anything. Measured
// 2026-09-28: every campaign in this workspace has reached 3,334–4,064 contacts, so
// this never bites a live campaign. It exists to stop a freshly created one, whose
// contact load is still running, rendering a confident rate off a handful of rows.
const REACH_FLOOR = 30

// Minimum applications before a per-source approval rate is shown. A proportion from
// fewer than ~20 samples carries a confidence interval of roughly ±20 points, wider
// than any difference between sources anyone would act on. This deliberately blanks
// the only row the table holds today — 8 applications, none declined, which rendered
// as a green "100%" — because "—" is the honest reading of 8 applications.
const APPLICATION_FLOOR = 20

// ── Types ─────────────────────────────────────────────────────────────────────

interface CampaignAttr {
  campaign_id:                   number
  campaign_name:                 string
  campaign_type:                 string
  contacts_reached:              number
  conversions:                   number
  matched_cif:                   number
  matched_phone:                 number
  matched_email:                 number
  attributed_disbursement_kobo:  number
}
interface LeadSourceRow {
  lead_source:        string
  total_applications: number
  /** Reached an approved status. NOT "everything that wasn't declined" — see below. */
  approved:           number
  /** Declined or rejected — the backend counts BOTH spellings. */
  declined?:          number
  /** Submitted, under review, on hold: decided neither way yet. */
  in_progress?:       number
  disbursement_kobo:  number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = { email: BLUE, sms: GREEN, whatsapp: '#25D366', push: NAVY }

function TypeTag({ type }: { type: string }) {
  const c = TYPE_COLOR[type] ?? NAVY
  return <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS.md, background: `${c}15`, color: c }}>{type || '—'}</span>
}

function MatchBasis({ cif, phone, email }: { cif: number; phone: number; email: number }) {
  const chips = [
    { n: cif, label: 'CIF', color: GREEN },
    { n: phone, label: 'Phone', color: BLUE },
    { n: email, label: 'Email', color: AMBER },
  ].filter(c => c.n > 0)
  if (chips.length === 0) return <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>—</span>
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {chips.map(c => (
        <span key={c.label} style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '1px 7px', borderRadius: RADIUS.full, background: `${c.color}16`, color: c.color, ...NUM }}>
          {c.n} {c.label}
        </span>
      ))}
    </div>
  )
}

function ConvBar({ value, max }: { value: number; max: number }) {
  const m = rate(value, max, REACH_FLOOR, 'contacts reached')
  if (!isOk(m)) {
    return (
      <span title={m.reason} style={{ fontSize: TEXT.xs, color: 'var(--txt3)', cursor: 'help', ...NUM }}>
        — no rate
      </span>
    )
  }
  const pct = m.value
  const color = pct >= 30 ? GREEN : pct >= 10 ? AMBER : RED
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 72, height: 6, background: 'var(--bdr)', borderRadius: 3, overflow: 'hidden', flexShrink: 0 }}>
        <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color, ...NUM }}>{pct.toFixed(1)}%</span>
    </div>
  )
}

// ── Attribution tab body (mounted inside the Marketing Analytics hub) ────────────

export default function Attribution() {
  const [campaigns,   setCampaigns]   = useState<CampaignAttr[]>([])
  const [leadSources, setLeadSources] = useState<LeadSourceRow[]>([])
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState<string | null>(null)
  const [from,        setFrom]        = useState('')
  const [to,          setTo]          = useState('')

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setError(null)
    const qs = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&')
    try {
      const [cam, ls] = await Promise.all([
        apiFetch<any>(`/api/sales/campaign-attribution${qs ? `?${qs}` : ''}`),
        apiFetch<any>(`/api/sales/by-lead-source${qs ? `?${qs}` : ''}`),
      ])
      setCampaigns(Array.isArray(cam) ? cam : (cam?.data ?? []))
      setLeadSources(Array.isArray(ls) ? ls : (ls?.data ?? []))
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [from, to])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['campaigns'] })

  const totalDisb  = campaigns.reduce((s, c) => s + c.attributed_disbursement_kobo, 0)
  const totalConv  = campaigns.reduce((s, c) => s + c.conversions, 0)
  const totalReach = campaigns.reduce((s, c) => s + c.contacts_reached, 0)
  const convRate   = rate(totalConv, totalReach, REACH_FLOOR, 'contacts reached')

  // Attributed value by campaign — top contributors.
  const disbChart = campaigns
    .filter(c => c.attributed_disbursement_kobo > 0)
    .sort((a, b) => b.attributed_disbursement_kobo - a.attributed_disbursement_kobo)
    .slice(0, 8)
    .map(c => ({ name: c.campaign_name, kobo: c.attributed_disbursement_kobo }))

  const CAMP_COLS: TableCol<CampaignAttr>[] = [
    { key: 'campaign_name', label: 'Campaign', render: r => <span style={{ fontWeight: FW.semibold }}>{r.campaign_name}</span> },
    { key: 'campaign_type', label: 'Type', render: r => <TypeTag type={r.campaign_type} /> },
    { key: 'contacts_reached', label: 'Reached', align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.contacts_reached)}</span> },
    { key: 'conversions', label: 'Conversions', render: r => (
      <div>
        <div style={{ ...NUM, fontWeight: FW.bold, fontSize: TEXT.base }}>{fmtNum(r.conversions)}</div>
        <ConvBar value={r.conversions} max={r.contacts_reached} />
      </div>
    )},
    { key: 'matched_cif', label: 'Matched By', render: r => <MatchBasis cif={r.matched_cif} phone={r.matched_phone} email={r.matched_email} /> },
    { key: 'attributed_disbursement_kobo', label: 'Attributed ₦', align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: NAVY }}>{fmtKobo(r.attributed_disbursement_kobo)}</span> },
  ]

  const LS_COLS: TableCol<LeadSourceRow>[] = [
    { key: 'lead_source', label: 'Source', render: r => <span style={{ fontWeight: FW.semibold, textTransform: 'capitalize' }}>{r.lead_source.replace(/_/g,' ')}</span> },
    { key: 'total_applications', label: 'Applications', align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.total_applications)}</span> },
    // Approved now means approved. This column briefly read "Not Declined" because the
    // backend counted `status NOT IN ('declined')` — which swept up pending applications
    // AND missed every rejection written as 'rejected'. Both are fixed in
    // salesByLeadSource; the honest denominator for an approval rate is DECIDED
    // applications, so undecided ones are shown separately rather than hidden in either
    // column. An older backend omits the new fields, and then the rate stays absent.
    { key: 'approved', label: 'Approved', align: 'right', render: r => {
      const decided = r.declined === undefined ? NaN : r.approved + r.declined
      const m = rate(r.approved, decided, APPLICATION_FLOOR, 'decided applications')
      return (
        <div title={m.reason ?? 'Share of applications that have actually been decided.'}
             style={{ cursor: 'help' }}>
          <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.approved)}</span>
          <span style={{ marginLeft: 6, fontSize: TEXT.xs, color: isOk(m) ? (m.value >= 50 ? GREEN : AMBER) : 'var(--txt3)' }}>
            ({fmtM(m, fmtPct)})
          </span>
        </div>
      )
    }},
    { key: 'in_progress', label: 'Awaiting Decision', align: 'right', render: r => (
      <span title="Submitted, under review or on hold — neither approved nor declined yet."
            style={{ ...NUM, color: 'var(--txt2)', cursor: 'help' }}>
        {r.in_progress === undefined ? '—' : fmtNum(r.in_progress)}
      </span>
    )},
    { key: 'disbursement_kobo', label: 'Disbursed', align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: NAVY }}>{fmtKobo(r.disbursement_kobo)}</span> },
  ]

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: SP[4] }}>
        <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} align="right" />
      </div>

      <ErrBanner error={error} onRetry={load} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Campaigns"        value={fmtNum(campaigns.length)} icon="campaign"        loading={loading} />
        <KpiCard label="Contacts Reached" value={fmtNum(totalReach)}       icon="group"           accent={BLUE}  loading={loading} />
        <KpiCard label="Conversions"      value={fmtNum(totalConv)}        icon="how_to_reg"      accent={GREEN} loading={loading} />
        <KpiCard label="Conversion Rate"  value={fmtM(convRate, fmtPct)}   icon="conversion_path" accent={AMBER} loading={loading} sub={convRate.reason} />
        <KpiCard label="Attributed ₦"     value={fmtKobo(totalDisb)}       icon="payments"       accent={NAVY}  loading={loading} />
      </div>

      {/* Method note */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '9px 12px', background: `${BLUE}0c`, border: `1px solid ${BLUE}33`, borderRadius: RADIUS.md, marginBottom: SP[4], fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.5 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 16, color: BLUE }}>info</span>
        <span><strong>Estimated attribution.</strong> A recipient counts as a conversion if they can be matched to a customer (by CIF, phone, or email) who took a loan within <strong>90 days after</strong> the campaign was sent. It's a correlation, not proven causation. Figures populate once campaigns are sent to contacts.</span>
      </div>

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={32} /></div> : (
        <>
          {disbChart.length > 0 && (
            <SectionCard title="Attributed Disbursement by Campaign" subtitle="Top campaigns by ₦ originated" style={{ marginBottom: 14 }}>
              <EChart
                height={Math.max(160, disbChart.length * 34)}
                option={(t: ChartTokens) => {
                  const axisFmt = (v: number) => v >= 1_000_000_00 ? `₦${(v / 1_000_000_00).toFixed(0)}m` : v >= 1_000_00 ? `₦${(v / 1_000_00).toFixed(0)}k` : `${v}`
                  return {
                    grid: { top: 4, right: 16, bottom: 4, left: 8, containLabel: true },
                    tooltip: {
                      trigger: 'axis',
                      axisPointer: { type: 'shadow', shadowStyle: { color: t.rowHvr, opacity: 0.5 } },
                      ...baseTooltip(t),
                      formatter: (ps: any[]) => tipCard(t, String(ps[0].axisValue), [{ color: ps[0].color, value: fmtKobo(Number(ps[0].value)) }]),
                    },
                    xAxis: axisVal(t, axisFmt),
                    yAxis: { ...axisCat(t, disbChart.map(d => d.name)), inverse: true, axisLabel: { color: t.txt2, fontSize: 11, fontFamily: CHART_FONT, interval: 0 } },
                    series: [{
                      type: 'bar', name: 'Attributed ₦', barMaxWidth: 26,
                      itemStyle: { color: NAVY, borderRadius: [0, 4, 4, 0] },
                      data: disbChart.map(d => Number(d.kobo)),
                    }],
                    animationDuration: 700,
                  }
                }}
              />
            </SectionCard>
          )}

          <SectionCard title="Campaign Attribution" subtitle="Conversions & originated value per campaign" badge={campaigns.length} padding={false} style={{ marginBottom: 14 }}>
            <DataTable cols={CAMP_COLS} rows={campaigns} keyFn={r => r.campaign_id} emptyText="No campaign data yet" />
          </SectionCard>

          <SectionCard title="By Lead Source" subtitle="Applications & disbursement by acquisition source" badge={leadSources.length} padding={false}>
            <DataTable cols={LS_COLS} rows={leadSources} keyFn={r => r.lead_source} emptyText="No lead source data yet" />
          </SectionCard>
        </>
      )}
    </>
  )
}
