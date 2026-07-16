import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, BLUE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SalesFunnel {
  contacts?:        number
  accounts?:        number
  active_accounts?: number
  transacting?:     number
}

interface LosPipeline {
  stage: string
  count: number
}

interface CampaignSummary {
  total_campaigns: number
  total_sent:      number
  total_delivered: number
  total_opened:    number
  total_clicked:   number
}

// ── Funnel bar ────────────────────────────────────────────────────────────────

interface FunnelStep {
  label:    string
  value:    number
  color:    string
  icon?:    string
}

function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const maxVal = Math.max(1, ...steps.map(s => s.value))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {steps.map((step, i) => {
        const prev  = i > 0 ? steps[i - 1].value : step.value
        const pctOf = prev > 0 ? step.value / prev : 1
        const barW  = step.value / maxVal * 100
        return (
          <div key={step.label}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{step.label}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {i > 0 && (
                  <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: pctOf >= .5 ? GREEN : pctOf >= .2 ? AMBER : RED }}>
                    {fmtPct(pctOf)} of prev
                  </span>
                )}
                <span style={{ fontSize: TEXT.md, fontWeight: FW.extrabold, color: step.color, ...NUM }}>{fmtNum(step.value)}</span>
              </div>
            </div>
            <div style={{ height: 28, background: 'var(--bdr)', borderRadius: RADIUS.sm, overflow: 'hidden', position: 'relative' }}>
              <div style={{ width: `${barW}%`, height: '100%', background: step.color, borderRadius: 6, transition: 'width .4s', opacity: .85 }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function Funnel() {
  const [salesFunnel,  setSalesFunnel]  = useState<SalesFunnel | null>(null)
  const [losStages,    setLosStages]    = useState<LosPipeline[]>([])
  const [campaigns,    setCampaigns]    = useState<CampaignSummary | null>(null)
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [sf, los, cam] = await Promise.all([
        apiFetch<SalesFunnel>('/api/sales/funnel').catch(() => null),
        apiFetch<{ by_stage?: LosPipeline[] }>('/api/los/overview').catch(() => null),
        apiFetch<{ summary?: CampaignSummary }>('/api/campaigns/analytics').catch(() => null),
      ])
      setSalesFunnel(sf)
      setLosStages(los?.by_stage ?? [])
      setCampaigns((cam as any)?.summary ?? null)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const customerSteps: FunnelStep[] = [
    { label: 'Total Contacts (CIF)', value: salesFunnel?.contacts        ?? 0, color: NAVY  },
    { label: 'Accounts Opened',      value: salesFunnel?.accounts        ?? 0, color: BLUE  },
    { label: 'Active Accounts',      value: salesFunnel?.active_accounts ?? 0, color: AMBER },
    { label: 'Transacting',          value: salesFunnel?.transacting     ?? 0, color: GREEN },
  ]

  // Map LOS stages in logical order
  const stageOrder = ['submitted','risk_review','credit_committee','approved','booking','active']
  const stageLabel: Record<string,string> = {
    submitted:'Submitted', risk_review:'Risk Review', credit_committee:'Credit Committee',
    approved:'Approved', booking:'Booking', active:'Active Loans',
  }
  const stageColor: Record<string,string> = {
    submitted: 'var(--chart-lbl)', risk_review: BLUE, credit_committee: AMBER,
    approved: GREEN, booking: NAVY, active: '#059669',
  }
  const losSteps: FunnelStep[] = stageOrder
    .map(s => {
      const row = losStages.find(r => r.stage === s)
      return { label: stageLabel[s] ?? s, value: row ? Number(row.count) : 0, color: stageColor[s] ?? NAVY }
    })
    .filter(s => s.value > 0)

  const campaignSteps: FunnelStep[] = campaigns ? [
    { label: 'Sent',      value: campaigns.total_sent,      color: NAVY  },
    { label: 'Delivered', value: campaigns.total_delivered, color: BLUE  },
    { label: 'Opened',    value: campaigns.total_opened,    color: AMBER },
    { label: 'Clicked',   value: campaigns.total_clicked,   color: GREEN },
  ] : []

  return (
    <Page title="Acquisition Funnel" subtitle="End-to-end conversion from campaign to active loan">
      <ErrBanner error={error} onRetry={load} />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: SP[4] }}>
          <SectionCard title="Customer Journey" subtitle="Contact → Active">
            <FunnelChart steps={customerSteps} />
          </SectionCard>

          <SectionCard title="LOS Pipeline" subtitle="Submitted → Active">
            {losSteps.length > 0
              ? <FunnelChart steps={losSteps} />
              : <div style={{ textAlign: 'center', padding: 32, color: 'var(--txt3)', fontSize: TEXT.base }}>No pipeline data</div>
            }
          </SectionCard>

          <SectionCard title="Campaign Email Funnel" subtitle="Sent → Clicked">
            {campaignSteps.length > 0
              ? <FunnelChart steps={campaignSteps} />
              : <div style={{ textAlign: 'center', padding: 32, color: 'var(--txt3)', fontSize: TEXT.base }}>No campaign data</div>
            }

            {campaigns && (
              <div style={{ marginTop: SP[4], display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[2] }}>
                {[
                  { label: 'Open Rate',    value: fmtPct(campaigns.total_opened  / Math.max(campaigns.total_delivered, 1)), color: AMBER },
                  { label: 'Click Rate',   value: fmtPct(campaigns.total_clicked / Math.max(campaigns.total_delivered, 1)), color: GREEN },
                  { label: 'Campaigns',    value: fmtNum(campaigns.total_campaigns), color: NAVY },
                  { label: 'Total Sent',   value: fmtNum(campaigns.total_sent),      color: BLUE },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ background: 'var(--row-hvr)', borderRadius: RADIUS.md, padding: '10px 12px' }}>
                    <div style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</div>
                    <div style={{ fontSize: 17, fontWeight: FW.extrabold, color, marginTop: 3, ...NUM }}>{value}</div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      )}
    </Page>
  )
}
