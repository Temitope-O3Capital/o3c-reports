import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, ErrBanner, Spinner, DataTable, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, BLUE, NUM, INTER, TEXT, FW, SP, RADIUS } from '../../lib/design'

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
  lead_source:       string
  total_applications: number
  approved:          number
  disbursement_kobo: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = {
  email: BLUE, sms: GREEN, whatsapp: '#25D366', push: NAVY,
}

// Shows how conversions were matched to a customer (CIF / phone / email).
function MatchBasis({ cif, phone, email }: { cif: number; phone: number; email: number }) {
  const chips = [
    { n: cif, label: 'CIF', color: GREEN },
    { n: phone, label: 'phone', color: BLUE },
    { n: email, label: 'email', color: AMBER },
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
  const pct = max > 0 ? value / max * 100 : 0
  const color = pct >= 30 ? GREEN : pct >= 10 ? AMBER : RED
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 80, height: 6, background: 'var(--bdr)', borderRadius: 3, overflow: 'hidden', flexShrink: 0 }}>
        <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color, ...NUM }}>{pct.toFixed(1)}%</span>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function Attribution() {
  const [campaigns,   setCampaigns]   = useState<CampaignAttr[]>([])
  const [leadSources, setLeadSources] = useState<LeadSourceRow[]>([])
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState<string | null>(null)
  const [from,        setFrom]        = useState('')
  const [to,          setTo]          = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    const qs = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&')
    try {
      const [cam, ls] = await Promise.all([
        apiFetch<any>(`/api/sales/campaign-attribution${qs ? `?${qs}` : ''}`),
        apiFetch<any>(`/api/sales/by-lead-source${qs ? `?${qs}` : ''}`),
      ])
      setCampaigns(Array.isArray(cam) ? cam : ((cam as any)?.data ?? [])); setLeadSources(Array.isArray(ls) ? ls : ((ls as any)?.data ?? []))
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [from, to])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['campaigns'] })

  const totalDisb  = campaigns.reduce((s, c) => s + c.attributed_disbursement_kobo, 0)
  const totalConv  = campaigns.reduce((s, c) => s + c.conversions, 0)
  const totalReach = campaigns.reduce((s, c) => s + c.contacts_reached, 0)

  const CAMP_COLS: TableCol<CampaignAttr>[] = [
    { key: 'campaign_name', label: 'Campaign', render: r => <span style={{ fontWeight: FW.semibold }}>{r.campaign_name}</span> },
    { key: 'campaign_type', label: 'Type', render: r => (
      <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS.md, background: `${TYPE_COLOR[r.campaign_type] ?? NAVY}15`, color: TYPE_COLOR[r.campaign_type] ?? NAVY }}>
        {r.campaign_type}
      </span>
    )},
    { key: 'contacts_reached', label: 'Reached', render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.contacts_reached)}</span> },
    { key: 'conversions', label: 'Conversions', render: r => (
      <div>
        <div style={{ ...NUM, fontWeight: FW.bold, fontSize: TEXT.base }}>{fmtNum(r.conversions)}</div>
        <ConvBar value={r.conversions} max={r.contacts_reached} />
      </div>
    )},
    { key: 'matched_cif', label: 'Matched by', render: r => <MatchBasis cif={r.matched_cif} phone={r.matched_phone} email={r.matched_email} /> },
    { key: 'attributed_disbursement_kobo', label: 'Attributed ₦', align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: NAVY }}>{fmtKobo(r.attributed_disbursement_kobo)}</span> },
  ]

  const LS_COLS: TableCol<LeadSourceRow>[] = [
    { key: 'lead_source', label: 'Source', render: r => <span style={{ fontWeight: FW.semibold, textTransform: 'capitalize' }}>{r.lead_source.replace(/_/g,' ')}</span> },
    { key: 'total_applications', label: 'Applications', render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.total_applications)}</span> },
    { key: 'approved', label: 'Approved', render: r => (
      <div>
        <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.approved)}</span>
        <span style={{ marginLeft: 6, fontSize: TEXT.xs, color: r.approved/Math.max(r.total_applications,1) >= .5 ? GREEN : AMBER }}>
          ({fmtPct(r.approved / Math.max(r.total_applications, 1))})
        </span>
      </div>
    )},
    { key: 'disbursement_kobo', label: 'Disbursed', align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: NAVY }}>{fmtKobo(r.disbursement_kobo)}</span> },
  ]

  return (
    <Page title="Campaign Attribution" subtitle="Track campaign impact on product origination">
      <ErrBanner error={error} onRetry={load} />

      <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 12 }}>
        {[
          { label: 'Campaigns',      value: fmtNum(campaigns.length), color: NAVY  },
          { label: 'Contacts Reached', value: fmtNum(totalReach),     color: BLUE  },
          { label: 'Conversions',    value: fmtNum(totalConv),        color: GREEN },
          { label: 'Attributed ₦',   value: fmtKobo(totalDisb),       color: AMBER },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.xl, padding: '14px 16px' }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>{label}</div>
            <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color, ...NUM }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Method note */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '9px 12px', background: 'var(--bg)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, marginBottom: 20, fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.5 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 16, color: BLUE }}>info</span>
        <span><strong>Estimated attribution.</strong> A recipient counts as a conversion if they can be matched to a customer (by CIF, phone, or email) who took a loan within <strong>90 days after</strong> the campaign was sent. It's a correlation, not proven causation — figures populate once campaigns are sent to contacts.</span>
      </div>

      {loading ? <div style={{ display:'flex', justifyContent:'center', padding:60 }}><Spinner size={32} /></div> : (
        <>
          <SectionCard title="Campaign Attribution" badge={campaigns.length}>
            <DataTable cols={CAMP_COLS} rows={campaigns} keyFn={r => r.campaign_id} emptyText="No campaign data yet" />
          </SectionCard>
          <SectionCard title="By Lead Source" badge={leadSources.length}>
            <DataTable cols={LS_COLS} rows={leadSources} keyFn={r => r.lead_source} emptyText="No lead source data yet" />
          </SectionCard>
        </>
      )}
    </Page>
  )
}
