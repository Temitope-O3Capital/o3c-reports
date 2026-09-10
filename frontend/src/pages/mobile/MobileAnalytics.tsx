import { useLiveData } from '../../hooks/useRealtime'
import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, ErrBanner, Spinner, DataTable, DateFilter, KpiCard, Tabs } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { EChart, baseTooltip, tipCard, axisCat, axisVal, CHART_FONT } from '../../components/echarts'
import type { ChartTokens } from '../../components/echarts'

// Mobile Analytics — action-driving install / source / funnel / campaign analytics
// for O3's mobile apps, mirrored from AppsFlyer. One page, parameterised by product
// ("blink" carries the live feed; "app"/o3cards isn't on AppsFlyer yet → empty state).
//
// Beyond descriptive charts this surfaces: a source/campaign efficiency & QUALITY
// scorecard (CPI, CTR, CVR, sessions/install, loyal-user rate), funnel step-to-step
// conversion with the sharpest drop called out, period-over-period KPI deltas, and
// plain-language insight callouts that each point to a decision.
//
// Quality north-star = LOYAL-USER RATE (AppsFlyer counts a user "loyal" after ≥3
// sessions — Blink's own trigger). True "transacting" isn't in the aggregate feed
// (no per-user id to join to our transaction data), so loyal users is the honest
// in-app-usage proxy; it's labelled as such throughout.

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlatformRow { platform: string; installs: number; sessions: number; loyal_users: number; cost_usd: number; revenue_usd: number }
interface Totals { installs: number; sessions: number; loyal_users: number; cost_usd: number; revenue_usd: number; paid_sources: number }
interface PrevTotals { installs: number; sessions: number; loyal_users: number; cost_usd: number }
interface SeriesRow { date: string; installs: number; sessions: number; loyal_users: number }
interface FunnelRow { event_name: string; unique_users: number; event_count: number }
interface ScoreRaw { key: string; media_source: string; impressions: number; clicks: number; installs: number; sessions: number; loyal_users: number; cost_usd: number }
interface Scored extends ScoreRaw { ctr: number | null; cvr: number | null; cpi: number | null; usage: number; spi: number }
interface CountryRow { country: string; installs: number; sessions: number; loyal_users: number; cost_usd: number }

export interface MobileAnalyticsProps {
  product: 'blink' | 'app'
  appName: string
}

const TABS = [
  { key: 'overview',  label: 'Overview' },
  { key: 'sources',   label: 'Sources' },
  { key: 'geography', label: 'Geography' },
  { key: 'funnel',    label: 'Funnel' },
  { key: 'campaigns', label: 'Campaigns' },
]

// AppsFlyer reports country as an ISO alpha-2 code (with "UK" for the United
// Kingdom). Map the ones we see; fall back to the raw code.
const COUNTRY_NAME: Record<string, string> = {
  NG: 'Nigeria', UK: 'United Kingdom', GB: 'United Kingdom', US: 'United States',
  CA: 'Canada', GH: 'Ghana', ZA: 'South Africa', KE: 'Kenya', EG: 'Egypt',
  DZ: 'Algeria', CM: 'Cameroon', AO: 'Angola', IT: 'Italy', JP: 'Japan',
  CL: 'Chile', FR: 'France', DE: 'Germany', AE: 'UAE', SA: 'Saudi Arabia',
  IN: 'India', CI: "Côte d'Ivoire", SN: 'Senegal', TZ: 'Tanzania', UG: 'Uganda',
}
const prettyCountry = (c: string) => c ? (COUNTRY_NAME[c] ?? c) : 'Unknown'
const PLATFORMS = [
  { key: '',        label: 'All platforms' },
  { key: 'ios',     label: 'iOS' },
  { key: 'android', label: 'Android' },
]
const SOURCE_LABEL: Record<string, string> = {
  Organic: 'Organic', None: 'Direct / None',
  googleadwords_int: 'Google Ads', restricted: 'Restricted (SKAN)',
}
const prettySource   = (s: string) => SOURCE_LABEL[s] ?? s.replace(/_int$/, '').replace(/_/g, ' ')
const prettyCampaign = (c: string) => (!c || c === 'None') ? 'Direct / no campaign' : c
const prettyEvent    = (e: string) => e.replace(/^af_/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
const usd  = (n: number | null) => (n === null || !isFinite(n)) ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const isPaid = (s: string) => s !== 'Organic' && s !== 'None' && s !== ''
const pctChange = (cur: number, prev: number): number | undefined => prev > 0 ? (cur - prev) / prev * 100 : undefined

function derive(r: ScoreRaw): Scored {
  return {
    ...r,
    ctr: r.impressions > 0 ? r.clicks / r.impressions * 100 : null,
    cvr: r.clicks > 0 ? r.installs / r.clicks * 100 : null,
    cpi: r.cost_usd > 0 && r.installs > 0 ? r.cost_usd / r.installs : null,
    usage: r.installs > 0 ? r.loyal_users / r.installs * 100 : 0,
    spi: r.installs > 0 ? r.sessions / r.installs : 0,
  }
}
function qualityTone(usage: number): { label: string; color: string } {
  if (usage >= 40) return { label: 'High', color: GREEN }
  if (usage >= 20) return { label: 'Medium', color: AMBER }
  return { label: 'Low', color: RED }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MobileAnalytics({ product, appName }: MobileAnalyticsProps) {
  const [view,      setView]      = useState('overview')
  const [totals,    setTotals]    = useState<Totals | null>(null)
  const [previous,  setPrevious]  = useState<PrevTotals | null>(null)
  const [byPlat,    setByPlat]    = useState<PlatformRow[]>([])
  const [series,    setSeries]    = useState<SeriesRow[]>([])
  const [funnel,    setFunnel]    = useState<FunnelRow[]>([])
  const [srcRows,   setSrcRows]   = useState<Scored[]>([])
  const [campRows,  setCampRows]  = useState<Scored[]>([])
  const [geo,       setGeo]       = useState<CountryRow[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [from,      setFrom]      = useState('')
  const [to,        setTo]        = useState('')
  const [platform,  setPlatform]  = useState('')

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setError(null)
    const qs = [`product=${product}`, from && `from=${from}`, to && `to=${to}`, platform && `platform=${platform}`].filter(Boolean).join('&')
    const s = `?${qs}`
    try {
      const [sum, ts, fun, src, cam, g] = await Promise.all([
        apiFetch<any>(`/api/appsflyer/summary${s}`),
        apiFetch<any>(`/api/appsflyer/timeseries${s}`),
        apiFetch<any>(`/api/appsflyer/funnel${s}`),
        apiFetch<any>(`/api/appsflyer/scorecard${s}&dimension=source`),
        apiFetch<any>(`/api/appsflyer/scorecard${s}&dimension=campaign`),
        apiFetch<any>(`/api/appsflyer/geo${s}`),
      ])
      setTotals(sum?.data?.totals ?? null)
      setPrevious(sum?.data?.previous ?? null)
      setByPlat(sum?.data?.by_platform ?? [])
      setSeries(ts?.data?.series ?? [])
      setFunnel(fun?.data?.funnel ?? [])
      setSrcRows((src?.data?.rows ?? []).map(derive))
      setCampRows((cam?.data?.rows ?? []).map(derive))
      setGeo(g?.data?.countries ?? [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [product, from, to, platform])

  useEffect(() => { load() }, [load])
  useLiveData(() => load(true), { topics: ['appsflyer'] })

  const totalCost = totals?.cost_usd ?? 0
  const hasSpend  = totalCost > 0
  const noData    = !loading && (totals?.installs ?? 0) === 0 && series.length === 0 && srcRows.length === 0

  // Funnel: baseline + step-to-step conversion, and the sharpest consecutive drop.
  const funnelBase = funnel.find(f => f.event_name === 'first_open')?.unique_users ?? (funnel[0]?.unique_users ?? 0)
  const funnelSteps = funnel.filter(f => f.unique_users > 0).map((f, i, arr) => {
    const prev = i > 0 ? arr[i - 1].unique_users : f.unique_users
    return {
      name: prettyEvent(f.event_name), users: f.unique_users,
      fromPrev: prev > 0 ? f.unique_users / prev * 100 : 100,
      fromOpen: funnelBase > 0 ? f.unique_users / funnelBase * 100 : 0,
    }
  })
  let biggestDrop: { from: string; to: string; lostPct: number; a: number; b: number } | null = null
  for (let i = 1; i < funnelSteps.length; i++) {
    const lost = 100 - funnelSteps[i].fromPrev
    if (lost > 0 && (!biggestDrop || lost > biggestDrop.lostPct)) {
      biggestDrop = { from: funnelSteps[i - 1].name, to: funnelSteps[i].name, lostPct: lost, a: funnelSteps[i - 1].users, b: funnelSteps[i].users }
    }
  }

  // 7-day moving average over installs, for the trend.
  const ma = series.map((_, i) => {
    const win = series.slice(Math.max(0, i - 6), i + 1)
    return win.reduce((s2, r) => s2 + r.installs, 0) / win.length
  })

  // Conversion milestones — real, populated rates off the funnel (share of first opens).
  const fval = (name: string) => funnel.find(f => f.event_name === name)?.unique_users ?? 0
  const foBase = fval('first_open') || (totals?.installs ?? 0)
  const milestones = [
    { label: 'Registration', icon: 'app_registration', event: 'registration_start', accent: BLUE },
    { label: 'Onboarded',    icon: 'task_alt',         event: 'onboarding_complete', accent: GREEN },
    { label: 'KYC Passed',   icon: 'verified_user',    event: 'kyc_result',          accent: AMBER },
    { label: 'Card CTA',     icon: 'credit_card',      event: 'card_cta_tapped',     accent: PURPLE },
  ].map(m => ({ ...m, n: fval(m.event), rate: foBase > 0 ? fval(m.event) / foBase * 100 : 0 }))

  // ── Insight engine — plain-language callouts, each pointing to an action ────
  const insights: { tone: 'good' | 'bad' | 'neutral'; icon: string; text: string }[] = []
  if (!noData && totals) {
    const totInstalls = totals.installs
    if (previous && previous.installs > 0) {
      const d = (totInstalls - previous.installs) / previous.installs * 100
      insights.push({
        tone: d >= 0 ? 'good' : 'bad', icon: d >= 0 ? 'trending_up' : 'trending_down',
        text: `Installs ${d >= 0 ? 'up' : 'down'} ${Math.abs(d).toFixed(0)}% vs the previous period (${fmtNum(previous.installs)} → ${fmtNum(totInstalls)}).`,
      })
    }
    const ranked = srcRows.filter(s => s.installs >= 5).sort((a, b) => b.usage - a.usage)
    if (ranked.length > 0) {
      const best = ranked[0]
      insights.push({ tone: 'good', icon: 'workspace_premium',
        text: `Highest-quality source: ${prettySource(best.key)} — ${best.usage.toFixed(0)}% become loyal users (${fmtNum(best.loyal_users)}/${fmtNum(best.installs)} installs). Lean into it.` })
      const worst = ranked[ranked.length - 1]
      if (ranked.length > 1 && worst.usage < 20 && isPaid(worst.key)) {
        insights.push({ tone: 'bad', icon: 'warning',
          text: `${prettySource(worst.key)} brings volume but low quality — only ${worst.usage.toFixed(0)}% loyal on ${fmtNum(worst.installs)} installs. Review targeting or creative before spending more.` })
      }
    }
    if (biggestDrop && biggestDrop.lostPct >= 15) {
      insights.push({ tone: 'bad', icon: 'filter_alt',
        text: `Sharpest funnel drop: ${biggestDrop.from} → ${biggestDrop.to} loses ${biggestDrop.lostPct.toFixed(0)}% (${fmtNum(biggestDrop.a)} → ${fmtNum(biggestDrop.b)}). Best place to fix onboarding.` })
    }
    const topSrc = [...srcRows].sort((a, b) => b.installs - a.installs)[0]
    if (topSrc && totInstalls > 0) {
      insights.push({ tone: 'neutral', icon: 'hub',
        text: `${prettySource(topSrc.key)} drives ${(topSrc.installs / totInstalls * 100).toFixed(0)}% of installs (${fmtNum(topSrc.installs)}).` })
    }
    if (hasSpend) {
      const withCpi = srcRows.filter(s => s.cpi !== null).sort((a, b) => (a.cpi ?? 0) - (b.cpi ?? 0))
      if (withCpi.length > 0) insights.push({ tone: 'good', icon: 'savings', text: `Cheapest paid installs: ${prettySource(withCpi[0].key)} at ${usd(withCpi[0].cpi)} CPI.` })
    }
    // Top country by volume, with a quality read.
    const topGeo = [...geo].sort((a, b) => b.installs - a.installs)[0]
    if (topGeo) {
      const rate = topGeo.installs > 0 ? topGeo.loyal_users / topGeo.installs * 100 : 0
      insights.push({ tone: 'neutral', icon: 'public', text: `Top market: ${prettyCountry(topGeo.country)} — ${fmtNum(topGeo.installs)} installs at ${rate.toFixed(0)}% loyal.` })
    }
  }

  // ── Scorecard columns (shared, with an optional campaign→source column) ─────
  const scoreCols = (dim: 'source' | 'campaign'): TableCol<Scored>[] => [
    dim === 'source'
      ? { key: 'key', label: 'Media Source', render: r => (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: FW.semibold }}>{prettySource(r.key)}</span>
            {isPaid(r.key) && <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '1px 6px', borderRadius: RADIUS.full, background: `${PURPLE}16`, color: PURPLE }}>Paid</span>}
          </span>
        )}
      : { key: 'key', label: 'Campaign', render: r => (
          <div>
            <div style={{ fontWeight: FW.semibold, color: (!r.key || r.key === 'None') ? 'var(--txt3)' : undefined }}>{prettyCampaign(r.key)}</div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{prettySource(r.media_source)}</div>
          </div>
        )},
    { key: 'installs', label: 'Installs', align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.installs)}</span> },
    { key: 'ctr', label: 'CTR', align: 'right', render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{r.ctr === null ? '—' : fmtPct(r.ctr)}</span> },
    { key: 'cvr', label: 'Click→Install', align: 'right', render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{r.cvr === null ? '—' : fmtPct(r.cvr)}</span> },
    { key: 'cpi', label: 'CPI', align: 'right', render: r => <span style={{ ...NUM, color: r.cpi === null ? 'var(--txt3)' : NAVY }}>{usd(r.cpi)}</span> },
    { key: 'spi', label: 'Sess./Install', align: 'right', render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{r.spi.toFixed(1)}</span> },
    { key: 'usage', label: 'Loyal-user rate', align: 'right', render: r => {
      const q = qualityTone(r.usage)
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
          <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtPct(r.usage)}</span>
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '1px 6px', borderRadius: RADIUS.full, background: `${q.color}16`, color: q.color }}>{q.label}</span>
        </span>
      )
    }},
  ]

  const installsBar = (rows: { name: string; installs: number; paid: boolean }[]) => (
    <EChart
      height={Math.max(160, rows.length * 38)}
      option={(t: ChartTokens) => ({
        grid: { top: 4, right: 20, bottom: 4, left: 8, containLabel: true },
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.rowHvr, opacity: 0.5 } }, ...baseTooltip(t),
          formatter: (ps: any[]) => tipCard(t, String(ps[0].axisValue), [{ color: ps[0].color, value: fmtNum(Number(ps[0].value)) + ' installs' }]) },
        xAxis: axisVal(t),
        yAxis: { ...axisCat(t, rows.map(d => d.name)), inverse: true, axisLabel: { color: t.txt2, fontSize: 11, fontFamily: CHART_FONT, interval: 0 } },
        series: [{ type: 'bar', name: 'Installs', barMaxWidth: 26, data: rows.map(d => ({ value: d.installs, itemStyle: { color: d.paid ? PURPLE : GREEN, borderRadius: [0, 4, 4, 0] } })) }],
        animationDuration: 700,
      })}
    />
  )

  // ── Tab: Overview ───────────────────────────────────────────────────────────
  const overviewTab = (
    <>
      {insights.length > 0 && (
        <SectionCard title="What to act on" subtitle="Generated from this window's data" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {insights.map((ins, i) => {
              const c = ins.tone === 'good' ? GREEN : ins.tone === 'bad' ? RED : BLUE
              return (
                <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 12px', borderLeft: `3px solid ${c}`, background: `${c}0c`, borderRadius: RADIUS.sm }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 18, color: c }}>{ins.icon}</span>
                  <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', lineHeight: 1.5 }}>{ins.text}</span>
                </div>
              )
            })}
          </div>
        </SectionCard>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        <KpiCard label="Installs" value={fmtNum(totals?.installs ?? 0)} icon="download" accent={NAVY} loading={loading}
          change={previous ? pctChange(totals?.installs ?? 0, previous.installs) : undefined} sub="vs prev period" />
        <KpiCard label="Sessions" value={fmtNum(totals?.sessions ?? 0)} icon="ads_click" accent={BLUE} loading={loading}
          change={previous ? pctChange(totals?.sessions ?? 0, previous.sessions) : undefined} sub="vs prev period" />
        <KpiCard label="Loyal Users" value={fmtNum(totals?.loyal_users ?? 0)} icon="loyalty" accent={GREEN} loading={loading}
          change={previous ? pctChange(totals?.loyal_users ?? 0, previous.loyal_users) : undefined}
          sub={totals && totals.installs > 0 ? `${fmtPct(totals.loyal_users / totals.installs * 100)} of installs` : 'vs prev period'} />
        <KpiCard label="Paid Sources" value={fmtNum(totals?.paid_sources ?? 0)} icon="hub" accent={PURPLE} loading={loading} />
        <KpiCard label="Ad Spend (USD)" value={hasSpend ? usd(totalCost) : '—'} icon="payments" accent={AMBER} loading={loading}
          sub={hasSpend ? 'vs prev period' : undefined} />
      </div>

      {/* Conversion milestones — share of first opens that reach each key step */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        {milestones.map(m => (
          <KpiCard key={m.label} label={m.label} value={fmtPct(m.rate)} icon={m.icon} accent={m.accent} loading={loading}
            sub={`${fmtNum(m.n)} of ${fmtNum(foBase)} opens`} />
        ))}
      </div>

      <SectionCard title="Installs Over Time" subtitle="Daily installs with 7-day average" style={{ marginBottom: 14 }}>
        {series.length === 0 ? <EmptyNote text="No installs in this window." /> : (
          <EChart
            height={280}
            option={(t: ChartTokens) => ({
              grid: { top: 16, right: 18, bottom: 26, left: 10, containLabel: true },
              tooltip: { trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: t.bdr, width: 1, type: 'dashed' } }, ...baseTooltip(t),
                formatter: (ps: any[]) => tipCard(t, String(ps[0].axisValue), ps.map(p => ({ color: p.color, name: p.seriesName, value: fmtNum(Number(p.value)) }))) },
              legend: { data: ['Daily installs', '7-day average'], right: 8, top: 0, textStyle: { color: t.txt2, fontFamily: CHART_FONT, fontSize: 11 }, icon: 'roundRect', itemWidth: 12, itemHeight: 4 },
              xAxis: { ...axisCat(t, series.map(s => s.date.slice(5))), boundaryGap: false, axisLabel: { color: t.txt3, fontSize: 10, fontFamily: CHART_FONT, hideOverlap: true } },
              yAxis: { ...axisVal(t), minInterval: 1 },
              series: [
                { type: 'line', name: 'Daily installs', smooth: true, symbol: 'circle', symbolSize: 5, showSymbol: false,
                  lineStyle: { width: 1.5, color: `${NAVY}80` }, itemStyle: { color: NAVY },
                  areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: `${NAVY}33` }, { offset: 1, color: `${NAVY}03` }] } },
                  data: series.map(s => s.installs), z: 1 },
                { type: 'line', name: '7-day average', smooth: true, symbol: 'none', lineStyle: { width: 3, color: NAVY }, data: ma.map(v => Math.round(v * 10) / 10), z: 2 },
              ],
              animationDuration: 700,
            })}
          />
        )}
      </SectionCard>

      <SectionCard title="By Platform" subtitle="iOS vs Android split" padding={false}>
        <DataTable
          cols={[
            { key: 'platform', label: 'Platform', render: (r: PlatformRow) => <span style={{ fontWeight: FW.semibold, textTransform: 'uppercase', fontSize: TEXT.xs, letterSpacing: 0.5 }}>{r.platform}</span> },
            { key: 'installs', label: 'Installs', align: 'right', render: (r: PlatformRow) => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.installs)}</span> },
            { key: 'sessions', label: 'Sessions', align: 'right', render: (r: PlatformRow) => <span style={{ ...NUM }}>{fmtNum(r.sessions)}</span> },
            { key: 'loyal_users', label: 'Loyal Users', align: 'right', render: (r: PlatformRow) => {
              const rate = r.installs > 0 ? r.loyal_users / r.installs * 100 : 0
              return <span style={{ ...NUM }}>{fmtNum(r.loyal_users)} <span style={{ fontSize: TEXT.xs, color: rate >= 40 ? GREEN : AMBER }}>({fmtPct(rate)})</span></span>
            }},
          ] as TableCol<PlatformRow>[]}
          rows={byPlat} keyFn={r => r.platform} emptyText="No platform data yet"
        />
      </SectionCard>
    </>
  )

  // ── Tab: Sources ──────────────────────────────────────────────────────────
  const sourceChart = srcRows.filter(s => s.installs > 0).slice(0, 8).map(s => ({ name: prettySource(s.key), installs: s.installs, paid: isPaid(s.key) }))
  const sourcesTab = (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14, alignItems: 'start' }}>
        <SectionCard title="Installs by Media Source" subtitle="Paid in purple, organic/direct in green">
          {sourceChart.length === 0 ? <EmptyNote text="No source data yet." /> : installsBar(sourceChart)}
        </SectionCard>
        <SectionCard title="Quality by Source" subtitle="Loyal-user rate — the usage signal">
          {srcRows.length === 0 ? <EmptyNote text="No source data yet." /> : (
            <EChart
              height={Math.max(160, Math.min(srcRows.length, 8) * 38)}
              option={(t: ChartTokens) => {
                const rows = [...srcRows].filter(s => s.installs >= 3).sort((a, b) => b.usage - a.usage).slice(0, 8)
                return {
                  grid: { top: 4, right: 44, bottom: 4, left: 8, containLabel: true },
                  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.rowHvr, opacity: 0.5 } }, ...baseTooltip(t),
                    formatter: (ps: any[]) => tipCard(t, String(ps[0].axisValue), [{ color: ps[0].color, value: fmtPct(Number(ps[0].value)) + ' loyal' }]) },
                  xAxis: { ...axisVal(t, (v: number) => v + '%'), max: 100 },
                  yAxis: { ...axisCat(t, rows.map(s => prettySource(s.key))), inverse: true, axisLabel: { color: t.txt2, fontSize: 11, fontFamily: CHART_FONT, interval: 0 } },
                  series: [{ type: 'bar', name: 'Loyal rate', barMaxWidth: 24,
                    label: { show: true, position: 'right', color: t.txt3, fontFamily: CHART_FONT, fontSize: 10, formatter: (p: any) => Number(p.value).toFixed(0) + '%' },
                    data: rows.map(s => ({ value: Math.round(s.usage * 10) / 10, itemStyle: { color: qualityTone(s.usage).color, borderRadius: [0, 4, 4, 0] } })) }],
                  animationDuration: 700,
                }
              }}
            />
          )}
        </SectionCard>
      </div>
      <SectionCard title="Source Scorecard" subtitle="Efficiency & quality by media source — ranked by installs" badge={srcRows.length} padding={false}>
        <DataTable cols={scoreCols('source')} rows={srcRows} keyFn={r => r.key} emptyText="No source data yet" />
      </SectionCard>
    </>
  )

  // ── Tab: Geography ──────────────────────────────────────────────────────────
  const geoChart = geo.filter(c => c.installs > 0).slice(0, 10).map(c => ({ name: prettyCountry(c.country), installs: c.installs, paid: false }))
  const GEO_COLS: TableCol<CountryRow>[] = [
    { key: 'country', label: 'Country', render: r => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
        <span style={{ fontFamily: 'monospace', fontSize: TEXT.xs, fontWeight: FW.bold, color: 'var(--txt3)', minWidth: 22 }}>{r.country}</span>
        <span style={{ fontWeight: FW.semibold }}>{prettyCountry(r.country)}</span>
      </span>
    )},
    { key: 'installs', label: 'Installs', align: 'right', render: r => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.installs)}</span> },
    { key: 'sessions', label: 'Sessions', align: 'right', render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{fmtNum(r.sessions)}</span> },
    { key: 'loyal_users', label: 'Loyal Users', align: 'right', render: r => <span style={{ ...NUM }}>{fmtNum(r.loyal_users)}</span> },
    { key: 'usage', label: 'Loyal-user rate', align: 'right', render: r => {
      const rate = r.installs > 0 ? r.loyal_users / r.installs * 100 : 0
      const q = qualityTone(rate)
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
          <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtPct(rate)}</span>
          <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '1px 6px', borderRadius: RADIUS.full, background: `${q.color}16`, color: q.color }}>{q.label}</span>
        </span>
      )
    }},
  ]
  const geographyTab = (
    <>
      <SectionCard title="Installs by Country" subtitle="Top markets by install volume" style={{ marginBottom: 14 }}>
        {geoChart.length === 0 ? <EmptyNote text="No country data yet." /> : (
          <EChart
            height={Math.max(160, geoChart.length * 34)}
            option={(t: ChartTokens) => ({
              grid: { top: 4, right: 24, bottom: 4, left: 8, containLabel: true },
              tooltip: { trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.rowHvr, opacity: 0.5 } }, ...baseTooltip(t),
                formatter: (ps: any[]) => tipCard(t, String(ps[0].axisValue), [{ color: ps[0].color, value: fmtNum(Number(ps[0].value)) + ' installs' }]) },
              xAxis: axisVal(t),
              yAxis: { ...axisCat(t, geoChart.map(d => d.name)), inverse: true, axisLabel: { color: t.txt2, fontSize: 11, fontFamily: CHART_FONT, interval: 0 } },
              series: [{ type: 'bar', name: 'Installs', barMaxWidth: 24, itemStyle: { color: BLUE, borderRadius: [0, 4, 4, 0] }, data: geoChart.map(d => d.installs) }],
              animationDuration: 700,
            })}
          />
        )}
      </SectionCard>
      <SectionCard title="Country Detail" subtitle="Installs, engagement & quality by country — no state/region in the AppsFlyer feed" badge={geo.length} padding={false}>
        <DataTable cols={GEO_COLS} rows={geo} keyFn={r => r.country} emptyText="No country data yet" />
      </SectionCard>
    </>
  )

  // ── Tab: Funnel ───────────────────────────────────────────────────────────
  const funnelTab = (
    <>
      {biggestDrop && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '11px 14px', background: `${RED}0d`, border: `1px solid ${RED}33`, borderRadius: RADIUS.md, marginBottom: 14, fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: RED }}>priority_high</span>
          <span><strong>Biggest drop-off: {biggestDrop.from} → {biggestDrop.to}.</strong> {biggestDrop.lostPct.toFixed(0)}% of users are lost here ({fmtNum(biggestDrop.a)} → {fmtNum(biggestDrop.b)}). This is the highest-leverage step to fix.</span>
        </div>
      )}
      <SectionCard title="Acquisition Funnel" subtitle="Unique users at each step, with step-to-step conversion" style={{ marginBottom: 14 }}>
        {funnelSteps.length === 0 ? <EmptyNote text="No funnel events in this window." /> : (
          <EChart
            height={Math.max(220, funnelSteps.length * 32)}
            option={(t: ChartTokens) => ({
              grid: { top: 4, right: 70, bottom: 4, left: 8, containLabel: true },
              tooltip: { trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.rowHvr, opacity: 0.5 } }, ...baseTooltip(t),
                formatter: (ps: any[]) => {
                  const i = ps[0].dataIndex; const st = funnelSteps[i]
                  return tipCard(t, st.name, [
                    { color: ps[0].color, value: `${fmtNum(st.users)} users` },
                    { color: t.txt3, value: `${st.fromPrev.toFixed(0)}% from previous step` },
                    { color: t.txt3, value: `${st.fromOpen.toFixed(0)}% of first open` },
                  ])
                } },
              xAxis: axisVal(t),
              yAxis: { ...axisCat(t, funnelSteps.map(f => f.name)), axisLabel: { color: t.txt2, fontSize: 11, fontFamily: CHART_FONT, interval: 0 } },
              series: [{ type: 'bar', name: 'Unique Users', barMaxWidth: 22, itemStyle: { color: BLUE, borderRadius: [0, 4, 4, 0] },
                label: { show: true, position: 'right', color: t.txt3, fontFamily: CHART_FONT, fontSize: 10, formatter: (p: any) => `${funnelSteps[p.dataIndex].fromPrev.toFixed(0)}%` },
                data: funnelSteps.map(f => f.users) }],
              animationDuration: 700,
            })}
          />
        )}
      </SectionCard>
      <SectionCard title="Funnel Detail" subtitle="Step-to-step and cumulative conversion" padding={false}>
        <DataTable
          cols={[
            { key: 'name', label: 'Step', render: (r: typeof funnelSteps[number]) => <span style={{ fontWeight: FW.semibold }}>{r.name}</span> },
            { key: 'users', label: 'Unique Users', align: 'right', render: (r: typeof funnelSteps[number]) => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.users)}</span> },
            { key: 'fromPrev', label: 'From prev step', align: 'right', render: (r: typeof funnelSteps[number]) => <span style={{ ...NUM, color: r.fromPrev >= 80 ? GREEN : r.fromPrev >= 50 ? AMBER : RED }}>{fmtPct(r.fromPrev)}</span> },
            { key: 'fromOpen', label: 'From first open', align: 'right', render: (r: typeof funnelSteps[number]) => <span style={{ ...NUM, color: 'var(--txt2)' }}>{fmtPct(r.fromOpen)}</span> },
          ] as TableCol<typeof funnelSteps[number]>[]}
          rows={funnelSteps} keyFn={r => r.name} emptyText="No funnel data yet"
        />
      </SectionCard>
    </>
  )

  // ── Tab: Campaigns ──────────────────────────────────────────────────────────
  const campaignChart = campRows.filter(c => c.installs > 0).slice(0, 8).map(c => ({ name: prettyCampaign(c.key), installs: c.installs, paid: isPaid(c.media_source) }))
  const campaignsTab = (
    <>
      <SectionCard title="Top Campaigns by Installs" subtitle="Paid in purple, organic/direct in green" style={{ marginBottom: 14 }}>
        {campaignChart.length === 0 ? <EmptyNote text="No campaign data yet — installs are direct/organic in this window." /> : installsBar(campaignChart)}
      </SectionCard>
      <SectionCard title="Campaign Scorecard" subtitle="Efficiency & quality per campaign — ranked by installs" badge={campRows.length} padding={false}>
        <DataTable cols={scoreCols('campaign')} rows={campRows} keyFn={r => `${r.key}|${r.media_source}`} emptyText="No campaign data yet" />
      </SectionCard>
    </>
  )

  return (
    <Page title="Mobile Analytics" subtitle={`${appName} — installs, media source & the signup→onboarding funnel`} loading={loading && !totals} skeletonKpis={5}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: SP[3], marginBottom: SP[4], flexWrap: 'wrap' }}>
        <div style={{ display: 'inline-flex', gap: 4, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: 3 }}>
          {PLATFORMS.map(p => (
            <button key={p.key} onClick={() => setPlatform(p.key)}
              style={{ border: 'none', cursor: 'pointer', padding: '5px 12px', borderRadius: RADIUS.sm, fontSize: TEXT.sm, fontWeight: FW.semibold,
                background: platform === p.key ? NAVY : 'transparent', color: platform === p.key ? '#fff' : 'var(--txt2)' }}>
              {p.label}
            </button>
          ))}
        </div>
        <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} align="right" />
      </div>

      <ErrBanner error={error} onRetry={load} />

      {noData && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '11px 14px', background: `${AMBER}0f`, border: `1px solid ${AMBER}44`, borderRadius: RADIUS.md, marginBottom: SP[4], fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: AMBER }}>info</span>
          <span><strong>{appName} isn't connected to AppsFlyer yet.</strong> There's no acquisition data to show for this app. Once {appName} is added to AppsFlyer and the SDK reports installs, this dashboard fills in automatically.</span>
        </div>
      )}

      <Tabs tabs={TABS} active={view} onChange={setView} />

      {loading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={32} /></div> : (
        <div style={{ marginTop: SP[4] }}>
          {view === 'overview'  && overviewTab}
          {view === 'sources'   && sourcesTab}
          {view === 'geography' && geographyTab}
          {view === 'funnel'    && funnelTab}
          {view === 'campaigns' && campaignsTab}
        </div>
      )}
    </Page>
  )
}

function EmptyNote({ text }: { text: string }) {
  return <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--txt3)', fontSize: TEXT.sm }}>{text}</div>
}
