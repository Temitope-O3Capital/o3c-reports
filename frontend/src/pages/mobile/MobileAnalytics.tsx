import { useLiveData } from '../../hooks/useRealtime'
import { useState, useEffect, useCallback } from 'react'
import { Page, SectionCard, ErrBanner, Spinner, DataTable, DateFilter, KpiCard, Tabs } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtPct } from '../../lib/fmt'
import { GREEN, AMBER, RED, NAVY, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { EChart, baseTooltip, tipCard, axisCat, axisVal, CHART_FONT } from '../../components/echarts'
import type { ChartTokens } from '../../components/echarts'
import { rate, per, na, isOk, fmtM, cmpM } from '../../lib/measure'
import type { Measure } from '../../lib/measure'
import { rankFindings, findingFrom, checkSequence } from '../../lib/insights'
import type { Finding, SeqStep } from '../../lib/insights'

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
//
// EVERY DERIVED NUMBER ON THIS PAGE IS A Measure (lib/measure.ts), not a float.
//
// The first build of this page divided aggregates without checking they were
// comparable, and shipped five false statements: a "Sess./Install 0.0" beside a green
// "55.7% loyal · High" badge on the same row (AppsFlyer reports sessions for paid
// partners only, so the 0 was absence rendered as measurement); a "100% · High" quality
// badge on two Danish installs; CTR/CPI computed from a feed carrying no impressions
// and no spend; and a "Sharpest funnel drop: Card Blocked Kyc Required → Card Issuance
// Failed loses 94%. Best place to fix onboarding" — 17 blocked users against 1 issuance
// failure, two unrelated events the sort had appended alphabetically.
//
// The rules that keep that from recurring, and that are worth copying to any other
// insight surface:
//   1. A ratio returns a Measure that refuses to exist when its denominator is absent
//      or below a floor. "—" with a reason in the tooltip, never a 0 that reads as data.
//   2. A finding may only be built from `ok` Measures — findingFrom() enforces it.
//   3. A declared funnel order is validated against its own counts before any
//      step-to-step conversion is read off it (checkSequence).
//   4. Findings are ranked bad → good → neutral, then by impact. A card called
//      "What to Act On" must not open with a neutral observation.

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlatformRow { platform: string; installs: number; sessions: number; loyal_users: number; cost_usd: number; revenue_usd: number }
interface Totals { installs: number; sessions: number; loyal_users: number; cost_usd: number; revenue_usd: number; paid_sources: number }
interface PrevTotals { installs: number; sessions: number; loyal_users: number; cost_usd: number }
interface SeriesRow { date: string; installs: number; sessions: number; loyal_users: number }
// `ordered` is false for an app event the backend's afFunnelOrder never placed in the
// journey; the sort appends those alphabetically, so their position carries no meaning.
// `same_as` names an EARLIER event this one duplicates exactly, day for day — two
// names Blink emits for one moment, which is not a step (see afAliasedSteps).
interface FunnelRow { event_name: string; unique_users: number; event_count: number; ordered: boolean; rank: number; same_as?: string; same_as_prev?: boolean }
interface ScoreRaw { key: string; media_source: string; impressions: number; clicks: number; installs: number; sessions: number; loyal_users: number; cost_usd: number }
interface Scored extends ScoreRaw { ctr: Measure; cvr: Measure; cpi: Measure; usage: Measure; spi: Measure }
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
  { key: '',        label: 'All Platforms' },
  { key: 'ios',     label: 'iOS' },
  { key: 'android', label: 'Android' },
]
const SOURCE_LABEL: Record<string, string> = {
  Organic: 'Organic', None: 'Direct / None',
  googleadwords_int: 'Google Ads', restricted: 'Restricted (SKAN)',
}
const prettySource   = (s: string) => SOURCE_LABEL[s] ?? s.replace(/_int$/, '').replace(/_/g, ' ')
const prettyCampaign = (c: string) => (!c || c === 'None') ? 'Direct / No Campaign' : c
const prettyEvent    = (e: string) => e.replace(/^af_/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
const usd  = (n: number | null) => (n === null || !isFinite(n)) ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const isPaid = (s: string) => s !== 'Organic' && s !== 'None' && s !== ''
const pctChange = (cur: number, prev: number): number | undefined => prev > 0 ? (cur - prev) / prev * 100 : undefined
const SLATE = '#94A3B8'   // "no data" badge — deliberately not RED, absence isn't failure

// AppsFlyer sends organic and direct rows with "Sessions": "0" alongside a non-zero
// "Loyal Users" (confirmed in the raw payload). Sessions are attributed to paid partners
// only in this account, so that 0 is absence of measurement and must not be divided.
const SESSIONS_NOT_REPORTED =
  'AppsFlyer attributes sessions to paid partners only in this account, so organic and direct rows carry no session count. Absence of data, not zero sessions.'

// Minimum installs before a loyal-user rate may exist. Below it the rate is noise that
// still renders as a confident badge: 2 installs and 2 loyal users is not a 100% "High"
// quality source, it is two people.
const RATE_FLOOR = 5

// Loyal-user rate divides this window's loyal users by this window's installs, so a user
// who installed before the window and turned loyal inside it inflates the rate. The
// aggregate feed carries no cohort, so this cannot be fixed here — it is disclosed on the
// scorecard instead of being quietly presented as a cohort conversion.
const LOYAL_RATE_CAVEAT =
  'Loyal users and installs are both counted within the selected window, so this is not a cohort rate: someone who installed earlier and reached 3 sessions inside the window still counts. The AppsFlyer aggregate feed carries no per-user id to cohort on.'

function derive(r: ScoreRaw): Scored {
  return {
    ...r,
    ctr: rate(r.clicks, r.impressions, 1, 'impressions'),
    cvr: rate(r.installs, r.clicks, 1, 'clicks'),
    cpi: r.cost_usd > 0
      ? per(r.cost_usd, r.installs, 1, 'installs')
      : na('not_reported', 'No ad spend recorded against this source in this window.'),
    usage: rate(r.loyal_users, r.installs, RATE_FLOOR, 'installs'),
    spi: isPaid(r.media_source)
      ? per(r.sessions, r.installs, 1, 'installs')
      : na('not_reported', SESSIONS_NOT_REPORTED),
  }
}

function qualityTone(m: Measure): { label: string; color: string } {
  if (!isOk(m)) return { label: 'No data', color: SLATE }
  if (m.value >= 40) return { label: 'High', color: GREEN }
  if (m.value >= 20) return { label: 'Medium', color: AMBER }
  return { label: 'Low', color: RED }
}

/** Right-aligned scorecard cell: the figure, or "—" carrying its reason as a tooltip. */
function MCell({ m, f, color }: { m: Measure; f: (n: number) => string; color?: string }) {
  return (
    <span title={m.reason} style={{ ...NUM, color: isOk(m) ? (color ?? 'var(--txt2)') : 'var(--txt3)', cursor: m.reason ? 'help' : undefined }}>
      {fmtM(m, f)}
    </span>
  )
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
  // Window-wide loyal rate for the KPI sub-label. Same Measure discipline as every
  // per-row rate on this page, so an empty window reads "vs prev period" rather than
  // a confident "0.0% of installs".
  const overallLoyalRate = rate(totals?.loyal_users ?? 0, totals?.installs ?? 0, RATE_FLOOR, 'installs')

  // Funnel. The backend's afFunnelOrder is a DECLARATION of the journey, not a
  // measurement of it, so validate it against its own counts before reading any
  // conversion off it. checkSequence trusts only the monotonic leading run and hands
  // back the steps that contradict the declared order.
  //
  // `ordered` defaults to true when the field is absent, i.e. when this bundle is
  // served ahead of a backend restart. That is deliberately the weaker of the two
  // safeguards, never the only one: the monotonicity check below still confines every
  // conversion to the corroborated run, so an old backend degrades to "validated but
  // without the Unplaced badge" rather than back to the phantom drop.
  const seqSteps: SeqStep[] = funnel
    .filter(f => f.unique_users > 0)
    .map(f => ({
      name: prettyEvent(f.event_name), users: f.unique_users, ordered: f.ordered !== false,
      sameAs: f.same_as ? prettyEvent(f.same_as) : undefined,
    }))
  const seq = checkSequence(seqSteps)
  // Event names are distinct and prettyEvent is deterministic, so names identify steps.
  const verified = new Set(seq.verified.map(s => s.name))
  const funnelBase = funnel.find(f => f.event_name === 'first_open')?.unique_users ?? (seqSteps[0]?.users ?? 0)

  const funnelSteps = seqSteps.map((s, i) => {
    const prev = i > 0 ? seqSteps[i - 1] : null
    const comparable = !!prev && verified.has(s.name) && verified.has(prev.name)
    return {
      ...s,
      verified: verified.has(s.name),
      // Step-to-step conversion exists only where the declared order is corroborated.
      // Everywhere else this is "—": the old code printed 2,522% here.
      fromPrev: !prev
        ? na('not_reported', 'First step in the journey — nothing precedes it.')
        // Checked BEFORE the conversion is computed: two names for one moment would
        // otherwise render a confident ~100%, which reads as "nobody drops out here"
        // when the truth is that there is no "here" to drop out of.
        : s.sameAs === prev.name
          ? na('not_reported', `Blink reports this with exactly the same daily user count as ${prev.name}, every day both occur — one event under two names, not two steps. A conversion between them would be 100% by construction.`)
        : comparable
          ? rate(s.users, prev.users, 1, 'users at the previous step')
          : na('not_reported', s.ordered
            ? 'The declared funnel order stops matching the data before this step, so step-to-step conversion here would be meaningless.'
            : 'This event is not part of the declared journey — it is listed alphabetically, so its position carries no meaning.'),
      // Share of first opens is a ratio to a base, not a sequence claim, so it stands
      // for every event including the unordered ones.
      fromOpen: rate(s.users, funnelBase, 1, 'first opens'),
    }
  })
  const biggestDrop = seq.drop

  // 7-day moving average over installs, for the trend.
  const ma = series.map((_, i) => {
    const win = series.slice(Math.max(0, i - 6), i + 1)
    return win.reduce((s2, r) => s2 + r.installs, 0) / win.length
  })

  // Conversion milestones — share of first opens reaching each key event.
  //
  // Labels name the EVENT, not an outcome the feed can't see. "KYC Passed" was wrong:
  // kyc_result fires on pass or fail and the aggregate API does not expose the outcome
  // parameter, so the page was reporting a failure as a pass.
  const fval = (name: string) => funnel.find(f => f.event_name === name)?.unique_users ?? 0
  const foBase = fval('first_open') || (totals?.installs ?? 0)
  const milestones = [
    { label: 'Registration', icon: 'app_registration', event: 'registration_start', accent: BLUE,
      note: 'Users who began registration.' },
    { label: 'Onboarded', icon: 'task_alt', event: 'onboarding_complete', accent: GREEN,
      note: 'Blink fires onboarding at app-open, not after signup — this is not a post-registration step.' },
    { label: 'KYC Result', icon: 'verified_user', event: 'kyc_result', accent: AMBER,
      note: 'kyc_result fires on PASS OR FAIL. The aggregate feed does not carry the outcome, so this is not a pass rate.' },
    { label: 'Card CTA', icon: 'credit_card', event: 'card_cta_tapped', accent: PURPLE,
      note: 'Users who tapped the card call-to-action.' },
  ].map(m => ({ ...m, n: fval(m.event), share: rate(fval(m.event), foBase, 1, 'first opens') }))

  // ── Insight engine ──────────────────────────────────────────────────────────
  //
  // Each rule returns a Finding or null. A rule that cites a derived figure builds
  // through findingFrom(), which refuses to produce the finding unless every Measure it
  // names actually exists — that is what stops a claim being made about an empty
  // denominator. rankFindings() then orders them bad → good → neutral, by impact within
  // each tone, so the card leads with what is wrong rather than with whoever typed
  // their `if` block first.
  const rules: (Finding | null)[] = []
  if (!noData && totals) {
    const totInstalls = totals.installs

    if (previous && previous.installs > 0) {
      const d = (totInstalls - previous.installs) / previous.installs * 100
      rules.push({
        id: 'installs-delta',
        tone: d >= 0 ? 'good' : 'bad',
        icon: d >= 0 ? 'trending_up' : 'trending_down',
        impact: Math.abs(totInstalls - previous.installs),
        text: `Installs ${d >= 0 ? 'up' : 'down'} ${Math.abs(d).toFixed(0)}% vs the previous period (${fmtNum(previous.installs)} → ${fmtNum(totInstalls)}).`,
      })
    }

    // Quality ranking covers PAID sources only. Organic and Direct win this on almost
    // any feed — people who sought the app out convert better than people who were
    // shown it — and "lean into Organic" is not a decision anyone can act on.
    const ranked = srcRows.filter(s => isPaid(s.key) && isOk(s.usage)).sort((a, b) => cmpM(a.usage, b.usage))
    if (ranked.length > 0) {
      const best = ranked[0]
      rules.push(findingFrom([best.usage], () => ({
        id: 'best-source', tone: 'good', icon: 'workspace_premium', impact: best.installs,
        text: `Best paid source on quality: ${prettySource(best.key)}, ${fmtM(best.usage, v => v.toFixed(0))}% become loyal users (${fmtNum(best.loyal_users)}/${fmtNum(best.installs)} installs). Lean into it.`,
      })))
      const worst = ranked[ranked.length - 1]
      if (ranked.length > 1 && isOk(worst.usage) && worst.usage.value < 20) {
        rules.push({
          id: 'worst-source', tone: 'bad', icon: 'warning', impact: worst.installs,
          text: `${prettySource(worst.key)} brings volume but low quality. Only ${worst.usage.value.toFixed(0)}% loyal on ${fmtNum(worst.installs)} installs. Review targeting or creative before spending more.`,
        })
      }
    }

    // Only ever the sharpest drop inside the CORROBORATED run of the funnel.
    if (biggestDrop && biggestDrop.lostPct >= 15) {
      rules.push({
        id: 'funnel-drop', tone: 'bad', icon: 'filter_alt', impact: biggestDrop.a - biggestDrop.b,
        text: `Sharpest verified funnel drop: ${biggestDrop.from} → ${biggestDrop.to} loses ${biggestDrop.lostPct.toFixed(0)}% (${fmtNum(biggestDrop.a)} → ${fmtNum(biggestDrop.b)}). Highest-leverage step to fix.`,
      })
    }

    // The declared order failing its own monotonicity test is a finding in itself: it
    // tells whoever owns afFunnelOrder that the app has moved on. impact 0 keeps it at
    // the foot of the card — it is a note about the data, not about the business.
    if (seq.violations.length > 0) {
      const worstV = [...seq.violations].sort((a, b) => b.gained - a.gained)[0]
      const lastGood = seq.verified[seq.verified.length - 1]?.name ?? 'the first step'
      rules.push({
        id: 'funnel-order-unverified', tone: 'neutral', icon: 'rule', impact: 0,
        text: `Funnel order unverified past ${lastGood}: ${seq.violations.length} step${seq.violations.length === 1 ? '' : 's'} report more users than the step before (largest: ${worstV.to} at ${fmtNum(worstV.b)} after ${worstV.from} at ${fmtNum(worstV.a)}). Conversion beyond that point is hidden rather than guessed.`,
      })
    }

    const topSrc = [...srcRows].sort((a, b) => b.installs - a.installs)[0]
    if (topSrc && totInstalls > 0) {
      rules.push({
        id: 'top-source', tone: 'neutral', icon: 'hub', impact: topSrc.installs,
        text: `${prettySource(topSrc.key)} drives ${(topSrc.installs / totInstalls * 100).toFixed(0)}% of installs (${fmtNum(topSrc.installs)}).`,
      })
    }

    // No hasSpend gate needed: a CPI Measure only exists where spend was recorded.
    const withCpi = srcRows.filter(s => isOk(s.cpi)).sort((a, b) => cmpM(a.cpi, b.cpi, 'asc'))
    if (withCpi.length > 0) {
      rules.push({
        id: 'cheapest-cpi', tone: 'good', icon: 'savings', impact: withCpi[0].installs,
        text: `Cheapest paid installs: ${prettySource(withCpi[0].key)} at ${fmtM(withCpi[0].cpi, usd)} CPI.`,
      })
    }

    const topGeo = [...geo].sort((a, b) => b.installs - a.installs)[0]
    if (topGeo) {
      const geoRate = rate(topGeo.loyal_users, topGeo.installs, RATE_FLOOR, 'installs')
      rules.push(findingFrom([geoRate], () => ({
        id: 'top-geo', tone: 'neutral', icon: 'public', impact: topGeo.installs,
        text: `Top market: ${prettyCountry(topGeo.country)}, ${fmtNum(topGeo.installs)} installs at ${fmtM(geoRate, v => v.toFixed(0))}% loyal.`,
      })))
    }
  }
  const insights = rankFindings(rules)

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
    // Every derived column is a Measure: it renders "—" with its reason on hover rather
    // than a 0 that reads as a measurement. Organic's Sess./Install was the worst of
    // these — a confident 0.0 sitting beside a green "High" loyalty badge.
    { key: 'ctr', label: 'CTR', align: 'right', render: r => <MCell m={r.ctr} f={fmtPct} /> },
    { key: 'cvr', label: 'Click→Install', align: 'right', render: r => <MCell m={r.cvr} f={fmtPct} /> },
    { key: 'cpi', label: 'CPI', align: 'right', render: r => <MCell m={r.cpi} f={usd} color={NAVY} /> },
    { key: 'spi', label: 'Sess./Install', align: 'right', render: r => <MCell m={r.spi} f={v => v.toFixed(1)} /> },
    { key: 'usage', label: 'Loyal-User Rate', align: 'right', render: r => {
      const q = qualityTone(r.usage)
      return (
        <span title={r.usage.reason ?? LOYAL_RATE_CAVEAT} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end', cursor: 'help' }}>
          <span style={{ ...NUM, fontWeight: FW.bold, color: isOk(r.usage) ? undefined : 'var(--txt3)' }}>{fmtM(r.usage, fmtPct)}</span>
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
        <SectionCard title="What to Act On" subtitle="Generated from this window's data. Problems first, then by users affected" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {insights.map(ins => {
              const c = ins.tone === 'good' ? GREEN : ins.tone === 'bad' ? RED : BLUE
              return (
                <div key={ins.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 12px', borderLeft: `3px solid ${c}`, background: `${c}0c`, borderRadius: RADIUS.sm }}>
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
          sub={isOk(overallLoyalRate) ? `${fmtM(overallLoyalRate, fmtPct)} of installs` : 'vs prev period'} />
        <KpiCard label="Paid Sources" value={fmtNum(totals?.paid_sources ?? 0)} icon="hub" accent={PURPLE} loading={loading} />
        <KpiCard label="Ad Spend (USD)" value={hasSpend ? usd(totalCost) : '—'} icon="payments" accent={AMBER} loading={loading}
          sub={hasSpend ? 'vs prev period' : undefined} />
      </div>

      {/* Conversion milestones — share of first opens that reach each key step */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: SP[4] }}>
        {milestones.map(m => (
          <div key={m.label} title={m.note}>
            <KpiCard label={m.label} value={fmtM(m.share, fmtPct)} icon={m.icon} accent={m.accent} loading={loading}
              sub={`${fmtNum(m.n)} of ${fmtNum(foBase)} opens`} />
          </div>
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
              legend: { data: ['Daily Installs', '7-Day Average'], right: 8, top: 0, textStyle: { color: t.txt2, fontFamily: CHART_FONT, fontSize: 11 }, icon: 'roundRect', itemWidth: 12, itemHeight: 4 },
              xAxis: { ...axisCat(t, series.map(s => s.date.slice(5))), boundaryGap: false, axisLabel: { color: t.txt3, fontSize: 10, fontFamily: CHART_FONT, hideOverlap: true } },
              yAxis: { ...axisVal(t), minInterval: 1 },
              series: [
                { type: 'line', name: 'Daily Installs', smooth: true, symbol: 'circle', symbolSize: 5, showSymbol: false,
                  lineStyle: { width: 1.5, color: `${NAVY}80` }, itemStyle: { color: NAVY },
                  areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: `${NAVY}33` }, { offset: 1, color: `${NAVY}03` }] } },
                  data: series.map(s => s.installs), z: 1 },
                { type: 'line', name: '7-Day Average', smooth: true, symbol: 'none', lineStyle: { width: 3, color: NAVY }, data: ma.map(v => Math.round(v * 10) / 10), z: 2 },
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
        <SectionCard title="Quality by Source" subtitle={`Loyal-user rate: the usage signal. Sources under ${RATE_FLOOR} installs are omitted`}>
          {srcRows.length === 0 ? <EmptyNote text="No source data yet." /> : (
            <EChart
              height={Math.max(160, Math.min(srcRows.length, 8) * 38)}
              option={(t: ChartTokens) => {
                // Only sources whose rate is allowed to exist. The old filter was
                // installs >= 3 with no floor in the Measure, so two installs and two
                // loyal users charted as a green 100% bar.
                const rows = [...srcRows].filter(s => isOk(s.usage)).sort((a, b) => cmpM(a.usage, b.usage)).slice(0, 8)
                return {
                  grid: { top: 4, right: 44, bottom: 4, left: 8, containLabel: true },
                  tooltip: { trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.rowHvr, opacity: 0.5 } }, ...baseTooltip(t),
                    formatter: (ps: any[]) => tipCard(t, String(ps[0].axisValue), [{ color: ps[0].color, value: fmtPct(Number(ps[0].value)) + ' loyal' }]) },
                  xAxis: { ...axisVal(t, (v: number) => v + '%'), max: 100 },
                  yAxis: { ...axisCat(t, rows.map(s => prettySource(s.key))), inverse: true, axisLabel: { color: t.txt2, fontSize: 11, fontFamily: CHART_FONT, interval: 0 } },
                  series: [{ type: 'bar', name: 'Loyal Rate', barMaxWidth: 24,
                    label: { show: true, position: 'right', color: t.txt3, fontFamily: CHART_FONT, fontSize: 10, formatter: (p: any) => Number(p.value).toFixed(0) + '%' },
                    data: rows.map(s => ({ value: Math.round((s.usage.value ?? 0) * 10) / 10, itemStyle: { color: qualityTone(s.usage).color, borderRadius: [0, 4, 4, 0] } })) }],
                  animationDuration: 700,
                }
              }}
            />
          )}
        </SectionCard>
      </div>
      <SectionCard title="Source Scorecard" subtitle="Efficiency & quality by media source, ranked by installs. “—” means the figure cannot be computed — hover it for the reason" badge={srcRows.length} padding={false}>
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
    // Same floor as the scorecard: Denmark's "100% · High" on 2 installs is now "—".
    { key: 'usage', label: 'Loyal-User Rate', align: 'right', render: r => {
      const m = rate(r.loyal_users, r.installs, RATE_FLOOR, 'installs')
      const q = qualityTone(m)
      return (
        <span title={m.reason ?? LOYAL_RATE_CAVEAT} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end', cursor: 'help' }}>
          <span style={{ ...NUM, fontWeight: FW.bold, color: isOk(m) ? undefined : 'var(--txt3)' }}>{fmtM(m, fmtPct)}</span>
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
      <SectionCard title="Country Detail" subtitle="Installs, engagement & quality by country. No state/region in the AppsFlyer feed" badge={geo.length} padding={false}>
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
          <span><strong>Biggest verified drop-off: {biggestDrop.from} → {biggestDrop.to}.</strong> {biggestDrop.lostPct.toFixed(0)}% of users are lost here ({fmtNum(biggestDrop.a)} → {fmtNum(biggestDrop.b)}). This is the highest-leverage step to fix.</span>
        </div>
      )}

      {/* The declared journey failed its own monotonicity test. Say so plainly rather
          than reporting conversions computed across an order the data contradicts. */}
      {seq.violations.length > 0 && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '11px 14px', background: `${AMBER}0f`, border: `1px solid ${AMBER}44`, borderRadius: RADIUS.md, marginBottom: 14, fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5 }}>
          <span className="material-symbols-rounded" style={{ fontSize: 18, color: AMBER }}>rule</span>
          <span>
            <strong>Step order unverified past {seq.verified[seq.verified.length - 1]?.name ?? 'the first step'}.</strong>{' '}
            Users cannot increase as they move down a funnel, but {seq.violations.length} step{seq.violations.length === 1 ? '' : 's'} here report more users than the step before —{' '}
            {seq.violations.slice(0, 3).map(v => `${v.to} (${fmtNum(v.b)}) after ${v.from} (${fmtNum(v.a)})`).join('; ')}
            {seq.violations.length > 3 ? `; and ${seq.violations.length - 3} more` : ''}.{' '}
            The declared journey in <code>afFunnelOrder</code> no longer matches how the app fires its events, so conversion past that point is shown as “—” instead of being guessed.
          </span>
        </div>
      )}

      <SectionCard title="Acquisition Funnel" subtitle="Unique users at each step. Conversion shown only where the declared order holds" style={{ marginBottom: 14 }}>
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
                    { color: t.txt3, value: isOk(st.fromPrev) ? `${st.fromPrev.value.toFixed(0)}% from previous step` : 'step-to-step conversion not available' },
                    { color: t.txt3, value: `${fmtM(st.fromOpen, v => v.toFixed(0))}% of first open` },
                  ])
                } },
              xAxis: axisVal(t),
              yAxis: { ...axisCat(t, funnelSteps.map(f => f.name)), axisLabel: { color: t.txt2, fontSize: 11, fontFamily: CHART_FONT, interval: 0 } },
              // Bars outside the verified run are muted: they are real counts, but their
              // position in this list is not a claim about sequence.
              series: [{ type: 'bar', name: 'Unique Users', barMaxWidth: 22,
                label: { show: true, position: 'right', color: t.txt3, fontFamily: CHART_FONT, fontSize: 10,
                  formatter: (p: any) => fmtM(funnelSteps[p.dataIndex].fromPrev, v => `${v.toFixed(0)}%`) },
                data: funnelSteps.map(f => ({ value: f.users, itemStyle: { color: f.verified ? BLUE : `${BLUE}55`, borderRadius: [0, 4, 4, 0] } })) }],
              animationDuration: 700,
            })}
          />
        )}
      </SectionCard>
      <SectionCard title="Funnel Detail" subtitle="Unique users per step. “Declared only” marks an event the journey never placed" padding={false}>
        <DataTable
          cols={[
            { key: 'name', label: 'Step', render: (r: typeof funnelSteps[number]) => (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontWeight: FW.semibold, color: r.verified ? undefined : 'var(--txt2)' }}>{r.name}</span>
                {!r.ordered && (
                  <span title="Present in the data but absent from the declared journey — listed alphabetically, so its position means nothing."
                        style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '1px 6px', borderRadius: RADIUS.full, background: `${SLATE}22`, color: SLATE, cursor: 'help' }}>Unplaced</span>
                )}
                {r.sameAs && (
                  <span title={`Identical daily user count to ${r.sameAs} on every day both occur — Blink emits two names for one moment, so this is not a separate stage of the journey.`}
                        style={{ fontSize: TEXT.xs, fontWeight: FW.bold, padding: '1px 6px', borderRadius: RADIUS.full, background: `${AMBER}22`, color: AMBER, cursor: 'help' }}>Same As {r.sameAs}</span>
                )}
              </span>
            )},
            { key: 'users', label: 'Unique Users', align: 'right', render: (r: typeof funnelSteps[number]) => <span style={{ ...NUM, fontWeight: FW.bold }}>{fmtNum(r.users)}</span> },
            { key: 'fromPrev', label: 'From Prev Step', align: 'right', render: (r: typeof funnelSteps[number]) => (
              <MCell m={r.fromPrev} f={fmtPct}
                color={isOk(r.fromPrev) ? (r.fromPrev.value >= 80 ? GREEN : r.fromPrev.value >= 50 ? AMBER : RED) : undefined} />
            )},
            { key: 'fromOpen', label: 'From First Open', align: 'right', render: (r: typeof funnelSteps[number]) => <MCell m={r.fromOpen} f={fmtPct} /> },
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
        {campaignChart.length === 0 ? <EmptyNote text="No campaign data yet: installs are direct/organic in this window." /> : installsBar(campaignChart)}
      </SectionCard>
      <SectionCard title="Campaign Scorecard" subtitle="Efficiency & quality per campaign. Ranked by installs" badge={campRows.length} padding={false}>
        <DataTable cols={scoreCols('campaign')} rows={campRows} keyFn={r => `${r.key}|${r.media_source}`} emptyText="No campaign data yet" />
      </SectionCard>
    </>
  )

  return (
    <Page title="Mobile Analytics" subtitle={`${appName}: installs, media source & the signup→onboarding funnel`} loading={loading && !totals} skeletonKpis={5}>
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
