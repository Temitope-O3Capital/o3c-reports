import { useLiveData } from "../../hooks/useRealtime"
import { useState, useEffect, useCallback } from 'react'
import { SectionCard, ErrBanner, Spinner, KpiCard } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtPct } from '../../lib/fmt'
import { GREEN, AMBER, NAVY, BLUE, PURPLE, TEXT, SP } from '../../lib/design'
import { FunnelChart, type FunnelStep } from './FunnelChart'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CampaignSummary {
  total_campaigns: number
  total_sent:      number
  total_delivered: number
  total_opened:    number
  total_clicked:   number
}
interface AttrRow { contacts_reached: number; conversions: number; attributed_disbursement_kobo: number }
interface LosStage { stage: string; count: number }
interface Lifecycle { registered?: number; card_issued?: number; card_active?: number; transacting?: number }

// ── Acquisition funnel tab body (inside the Marketing Analytics hub) ─────────────

export default function Funnel() {
  const [campaigns, setCampaigns] = useState<CampaignSummary | null>(null)
  const [attr,      setAttr]      = useState<AttrRow[]>([])
  const [losStages, setLosStages] = useState<LosStage[]>([])
  const [lifecycle, setLifecycle] = useState<Lifecycle | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [cam, at, los, lc] = await Promise.all([
        apiFetch<{ summary?: CampaignSummary }>('/api/campaigns/analytics').catch(() => null),
        apiFetch<any>('/api/sales/campaign-attribution').catch(() => null),
        apiFetch<{ by_stage?: LosStage[] }>('/api/los/overview').catch(() => null),
        apiFetch<Lifecycle>('/api/sales/funnel').catch(() => null),
      ])
      setCampaigns((cam as any)?.summary ?? (cam as any)?.data?.summary ?? null)
      setAttr(Array.isArray(at) ? at : (at?.data ?? []))
      setLosStages((los as any)?.data?.by_stage ?? los?.by_stage ?? [])
      setLifecycle((lc as any)?.data ?? lc)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['campaigns'] })

  const conversions = attr.reduce((s, a) => s + (a.conversions ?? 0), 0)
  const attributed  = attr.reduce((s, a) => s + (a.attributed_disbursement_kobo ?? 0), 0)

  // Hero: end-to-end acquisition — campaign send → engagement → booked loan.
  const c = campaigns
  const acquisition: FunnelStep[] = c ? [
    { label: 'Sent',      value: c.total_sent,      color: NAVY   },
    { label: 'Delivered', value: c.total_delivered, color: BLUE   },
    { label: 'Opened',    value: c.total_opened,    color: AMBER  },
    { label: 'Clicked',   value: c.total_clicked,   color: PURPLE },
    { label: 'Converted', value: conversions,       color: GREEN, hint: 'loans booked' },
  ] : []
  const overallConv = c && c.total_sent > 0 ? conversions / c.total_sent * 100 : 0
  const trackingGap = !!c && c.total_delivered > 0 && c.total_opened === 0

  // Supporting: loan origination pipeline (correctly labelled — LOS stages).
  const stageOrder = ['submitted','document_collection','risk_review','risk_head_review','pending_conditions','finance_approval','booking','active']
  const stageLabel: Record<string,string> = {
    submitted:'Submitted', document_collection:'Document Collection', risk_review:'Risk Review',
    risk_head_review:'Risk Head Review', pending_conditions:'Pending Conditions',
    finance_approval:'Finance Approval', booking:'Booking', active:'Active Loans',
  }
  const stageColor: Record<string,string> = {
    submitted: 'var(--chart-lbl)', document_collection: BLUE, risk_review: BLUE,
    risk_head_review: AMBER, pending_conditions: AMBER, finance_approval: GREEN,
    booking: NAVY, active: '#059669',
  }
  const losSteps: FunnelStep[] = stageOrder
    .map(s => { const row = losStages.find(r => r.stage === s); return { label: stageLabel[s] ?? s, value: row ? Number(row.count) : 0, color: stageColor[s] ?? NAVY } })
    .filter(s => s.value > 0)

  // Supporting: whole-book customer lifecycle (NOT campaign-attributed — labelled as such).
  const lc = lifecycle
  const lifecycleSteps: FunnelStep[] = lc ? [
    { label: 'Registered',     value: lc.registered  ?? 0, color: NAVY  },
    { label: 'Account Opened', value: lc.card_issued ?? 0, color: BLUE  },
    { label: 'Active Account', value: lc.card_active ?? 0, color: AMBER },
    { label: 'Transacting',    value: lc.transacting ?? 0, color: GREEN },
  ] : []

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={32} /></div>

  return (
    <>
      <ErrBanner error={error} onRetry={load} />

      {trackingGap && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '9px 12px', background: `${AMBER}0e`, border: `1px solid ${AMBER}40`, borderRadius: 8, marginBottom: SP[4], fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.5 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 16, color: AMBER }}>info</span>
          <span><strong>Opened &amp; Clicked read 0</strong> until email open-tracking (the SendGrid Event Webhook) is live. The Sent → Delivered → Converted stages are accurate.</span>
        </div>
      )}

      {/* Hero: end-to-end acquisition funnel */}
      <div style={{ display: 'grid', gridTemplateColumns: '2.2fr 1fr', gap: SP[4], marginBottom: SP[4] }}>
        <SectionCard title="Acquisition Funnel" subtitle="Campaign send → engagement → booked loan">
          {acquisition.some(s => s.value > 0)
            ? <FunnelChart steps={acquisition} showCumulative />
            : <div style={{ textAlign: 'center', padding: 40, color: 'var(--txt3)', fontSize: TEXT.base }}>No campaign data yet</div>}
        </SectionCard>

        <div style={{ display: 'flex', flexDirection: 'column', gap: SP[3] }}>
          <KpiCard label="Send → Convert" value={fmtPct(overallConv)} icon="conversion_path" accent={GREEN} sub="overall conversion" />
          <KpiCard label="Conversions"    value={conversions.toLocaleString()} icon="how_to_reg" accent={AMBER} sub="loans booked" />
          <KpiCard label="Attributed ₦"   value={fmtKobo(attributed)} icon="payments" accent={NAVY} sub="originated value" />
        </div>
      </div>

      {/* Supporting funnels */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4] }}>
        <SectionCard title="Loan Origination Pipeline" subtitle="Applications in flight — Submitted → Active">
          {losSteps.length > 0
            ? <FunnelChart steps={losSteps} />
            : <div style={{ textAlign: 'center', padding: 32, color: 'var(--txt3)', fontSize: TEXT.base }}>No pipeline data</div>}
        </SectionCard>

        <SectionCard title="Customer Lifecycle" subtitle="Whole book (not campaign-attributed) — Registered → Transacting">
          {lifecycleSteps.some(s => s.value > 0)
            ? <FunnelChart steps={lifecycleSteps} />
            : <div style={{ textAlign: 'center', padding: 32, color: 'var(--txt3)', fontSize: TEXT.base }}>No lifecycle data</div>}
        </SectionCard>
      </div>
    </>
  )
}
