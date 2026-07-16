import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, ErrBanner, Spinner, DataTable, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, BLUE, NUM, INTER, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CampaignAttr {
  campaign_id:       number
  campaign_name:     string
  campaign_type:     string
  contacts_reached:  number
  applications:      number
  loans_disbursed:   number
  disbursement_kobo: number
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
        apiFetch<CampaignAttr[]>(`/api/sales/campaign-attribution${qs ? `?${qs}` : ''}`),
        apiFetch<LeadSourceRow[]>(`/api/sales/by-lead-source${qs ? `?${qs}` : ''}`),
      ])
      setCampaigns(Array.isArray(cam) ? cam : []); setLeadSources(Array.isArray(ls) ? ls : [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const maxApps    = Math.max(1, ...campaigns.map(c => c.contacts_reached))
  const totalDisb  = campaigns.reduce((s, c) => s + c.disbursement_kobo, 0)
  const totalApps  = campaigns.reduce((s, c) => s + c.applications, 0)
  const totalLoans = campaigns.reduce((s, c) => s + c.loans_disbursed, 0)

  const CAMP_COLS: TableCol<CampaignAttr>[] = [
    { key: 'campaign_name', label: 'Campaign', render: r => <span style={{ fontWeight: FW.semibold }}>{r.campaign_name}</span> },
    { key: 'campaign_type', label: 'Type', render: r => (
      <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '2px 8px', borderRadius: RADIUS.md, background: `${TYPE_COLOR[r.campaign_type] ?? NAVY}15`, color: TYPE_COLOR[r.campaign_type] ?? NAVY }}>
        {r.campaign_type}
      </span>
    )},
    { key: 'contacts_reached', label: 'Reached', render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.contacts_reached)}</span> },
    { key: 'applications', label: 'Applications', render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.applications)}</span> },
    { key: 'loans_disbursed', label: 'Loans → Conv.', render: r => (
      <div>
        <div style={{ ...NUM, fontWeight: FW.bold, fontSize: TEXT.base }}>{fmtNum(r.loans_disbursed)}</div>
        <ConvBar value={r.applications} max={r.contacts_reached} />
      </div>
    )},
    { key: 'disbursement_kobo', label: 'Disbursed', align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.bold, color: NAVY }}>{fmtKobo(r.disbursement_kobo)}</span> },
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
    <Page title="Campaign Attribution" subtitle="Track campaign impact on loan origination">
      <ErrBanner error={error} onRetry={load} />

      <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 20 }}>
        {[
          { label: 'Campaigns',       value: fmtNum(campaigns.length), color: NAVY  },
          { label: 'Applications',    value: fmtNum(totalApps),         color: BLUE  },
          { label: 'Loans Disbursed', value: fmtNum(totalLoans),        color: GREEN },
          { label: 'Total Value',     value: fmtKobo(totalDisb),        color: AMBER },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.xl, padding: '14px 16px' }}>
            <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 6 }}>{label}</div>
            <div style={{ fontSize: TEXT['2xl'], fontWeight: FW.extrabold, color, ...NUM }}>{value}</div>
          </div>
        ))}
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
