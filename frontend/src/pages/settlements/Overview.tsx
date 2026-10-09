import { useEffect, useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Page, KpiCard, SectionCard, ErrBanner, DateFilter, Badge, Button, DataTable, EmptyState,
} from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDate, monthStart, today } from '../../lib/fmt'
import { GREEN, RED, AMBER, NAVY, BLUE, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { humanLabel } from '../../lib/labels'

/*
  SETTLEMENT POSITION — the module's front door.

  It answers three questions in the order a settlement officer actually asks them:

    1. Is everything here yet?   (feed coverage)
    2. Does it tie out?          (master vs providers)
    3. What is in the way?       (actionable breaks)

  That order is the whole design. The page this replaces led with a single tie-out
  percentage computed across every source at once, which was unreadable for a very
  specific reason: the three feeds have three different horizons. The CCS master's
  real book ends 2025-12-31, the Interswitch uploads stop 2026-07-01, and only
  Paystack reaches today. A period spanning those produces breaks that look like
  missing money and are really a feed nobody has sent — so coverage is reported
  FIRST, and the tie-out rate below it is measured only over what could tie out.
*/

// ── Types ─────────────────────────────────────────────────────────────────────

interface CcsRoute { route: string; txns: number; value_kobo: number; debits: number; credits: number }
interface CcsTotals { txns: number; debit_kobo: number; credit_kobo: number; days_with_data: number; first_day: string | null; last_day: string | null }
interface IswChannel { channel: string; txns: number; value_kobo: number; fees_kobo: number; legs: number }
interface IswTotals { txns: number; value_kobo: number; fees_kobo: number; legs: number; days_with_data: number }
interface PsTotals {
  funding_n: number; funding_kobo: number; funding_lost_n: number
  transfer_n: number; transfer_kobo: number; transfer_failed_n: number
  settled_kobo: number; open_disputes: number
}
interface PsChannel { channel: string; attempts: number; success: number; value_kobo: number; completion_pct: number }

interface Feed {
  src: string; label: string; role: string
  rows_in_period: number; days_in_period: number; last_day: string | null
}

interface LinkInfo {
  isw_txns: number; matched_to_ccs: number
  // Interswitch transactions on days the CCS master does not cover at all — a feed
  // gap, not a break. Excluded from the tie-out denominator.
  no_master_data: number
  paystack_linkable: boolean; paystack_note: string
}

/*
  The four channels as Card Operations reports them — ATM, POS, WEB, TRANSFER.

  This is the shape of the published Half-Year Transaction Report. The blocks
  further down this page are organised by SOURCE, which is right for reconciling
  but is not the language the business reads its own numbers in, so the front door
  carries both. TRANSFER cannot come from the card ledger at all: it is mobile app
  transfers from Paystack, and it was 71.37% of the H1 2026 report.
*/
interface ChannelTotals {
  atm: number; pos: number; web: number; transfer: number
  total: number; months: number
  // Which sides were present, so a genuine zero can be told from a missing feed.
  ccs_rows: number; ps_rows: number
}

interface Overview3 {
  period: { from: string; to: string }
  ccs: { routes: CcsRoute[]; totals: CcsTotals }
  interswitch: { channels: IswChannel[]; totals: IswTotals }
  paystack: { totals: PsTotals; channels: PsChannel[] }
  channels: ChannelTotals
  feeds: Feed[]
  link: LinkInfo
}

interface ExcSummary {
  open_n: number; open_value_kobo: number
  actionable_n: number; actionable_value_kobo: number
  master_no_data_n: number; aged_30d_n: number
}

// ── Chrome ────────────────────────────────────────────────────────────────────

const ROUTE_LABEL: Record<string, string> = {
  ATM: 'ATM: Cash Advance',
  POS: 'POS: Purchases',
  WEB: 'WEB: Utility Payment',
  TRANSFER_OUT: 'Transfer: Web Out',
  TRANSFER_IN: 'Transfer: Web In',
  CASH_PAYMENT: 'Cash Payment (Bank)',
  OTHER: 'Other Codes',
}

const FEED_ICON: Record<string, string> = {
  ccs: 'account_balance_wallet', interswitch: 'credit_card', paystack: 'smartphone',
}

/** Inclusive day count between two ISO dates. */
function daysBetween(from: string, to: string): number {
  if (!from || !to) return 0
  const a = Date.parse(from + 'T00:00:00Z')
  const b = Date.parse(to + 'T00:00:00Z')
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0
  return Math.round((b - a) / 86_400_000) + 1
}

/*
  A feed's health, as a label AND an icon AND a colour.

  Never colour alone: a red dot and an amber dot are the same dot to a reader who
  cannot separate them, and this strip is the page's most important signal. Every
  state carries its own word and its own glyph.
*/
type Health = { tone: string; icon: string; word: string }

function feedHealth(f: Feed, periodDays: number): Health {
  if (periodDays <= 0) return { tone: 'var(--txt3)', icon: 'remove', word: 'No period' }
  if (f.days_in_period === 0) return { tone: RED, icon: 'cloud_off', word: 'Nothing received' }
  const pct = (f.days_in_period / periodDays) * 100
  if (pct >= 95) return { tone: GREEN, icon: 'check_circle', word: 'Complete' }
  if (pct >= 60) return { tone: AMBER, icon: 'error', word: 'Partial' }
  return { tone: RED, icon: 'warning', word: 'Sparse' }
}

/*
  The feed-coverage strip. One tile per source: how many of the period's days it
  covers, how many rows that is, and when it last sent anything at all.

  last_day is deliberately drawn from the whole table rather than the period, so a
  feed that stopped before the period began reports the date it stopped instead of
  a bare zero — "nothing received, last sent 1 Jul 2026" is actionable where
  "0 days" is not.
*/
function FeedTile({ feed, periodDays }: { feed: Feed; periodDays: number }) {
  const h = feedHealth(feed, periodDays)
  const covered = Math.min(feed.days_in_period, periodDays)
  const pct = periodDays > 0 ? (covered / periodDays) * 100 : 0

  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--card-bdr)',
      boxShadow: 'var(--card-shadow)', borderRadius: RADIUS.lg, padding: `${SP[4]} ${SP[4]}`,
      display: 'flex', flexDirection: 'column', gap: SP[2],
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
        <span className="material-symbols-rounded" aria-hidden="true"
          style={{ fontSize: 17, color: 'var(--txt3)' }}>{FEED_ICON[feed.src] ?? 'database'}</span>
        <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{feed.label}</span>
        <Badge variant="default" style={{ marginLeft: 'auto' }}>
          {feed.role === 'master' ? 'Master' : 'Provider'}
        </Badge>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: SP[2] }}>
        <span style={{ ...NUM, fontSize: TEXT.xl, fontWeight: FW.bold, color: 'var(--txt)' }}>
          {fmtNum(covered)}
        </span>
        <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>
          of {fmtNum(periodDays)} days
        </span>
      </div>

      {/* Coverage bar. role=img with a text label so the meter is announced rather
          than being a decorative div a screen reader skips. */}
      <div role="img" aria-label={`${feed.label}: ${h.word}, ${covered} of ${periodDays} days covered`}
        style={{ height: 5, borderRadius: 3, background: 'var(--bdr)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.max(pct, pct > 0 ? 2 : 0)}%`, background: h.tone, borderRadius: 3 }} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: SP[1], flexWrap: 'wrap' }}>
        <span className="material-symbols-rounded" aria-hidden="true"
          style={{ fontSize: 14, color: h.tone }}>{h.icon}</span>
        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: h.tone }}>{h.word}</span>
        <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
          · {fmtNum(feed.rows_in_period)} rows
          {feed.last_day ? ` · last ${fmtDate(feed.last_day)}` : ' · never'}
        </span>
      </div>
    </div>
  )
}

/* A labelled figure in a row of figures. Used inside the provider cards. */
function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginBottom: 2 }}>{label}</div>
      <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.semibold, color: tone ?? 'var(--txt)' }}>{value}</div>
      {sub && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 1 }}>{sub}</div>}
    </div>
  )
}

/* Section heading that names the ROLE each system plays, because the module was
   mislabelled for most of its life: the table called "interswitch" held CCS data,
   and the engine reconciled CCS while reporting Interswitch. */
function SourceHeader({ title, role, sub, tone, feed }: {
  title: string; role: string; sub: string; tone: string; feed?: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: SP[3], marginBottom: SP[4] }}>
      <div aria-hidden="true" style={{ width: 4, alignSelf: 'stretch', borderRadius: 2, background: tone }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], flexWrap: 'wrap' }}>
          <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>{title}</span>
          <Badge variant="default">{role}</Badge>
          {feed && <span style={{ marginLeft: 'auto', fontSize: TEXT.xs, color: 'var(--txt3)' }}>{feed}</span>}
        </div>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 2 }}>{sub}</div>
      </div>
    </div>
  )
}

/* Share-of-total bar, drawn inline in a table cell. Cheaper and calmer than a
   chart for a handful of rows, and it sorts with the column it sits in. */
function ShareBar({ value, max, tone }: { value: number; max: number; tone: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0
  return (
    <div aria-hidden="true" style={{ height: 4, borderRadius: 2, background: 'var(--bdr)', overflow: 'hidden', minWidth: 48 }}>
      <div style={{ height: '100%', width: `${pct}%`, background: tone, borderRadius: 2 }} />
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SettlementPosition() {
  const navigate = useNavigate()
  const [from, setFrom] = useState(monthStart())
  const [to, setTo]     = useState(today())
  const [d, setD]       = useState<Overview3 | null>(null)
  const [exc, setExc]   = useState<ExcSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // The queue summary is period-independent (it is a backlog, not a flow), so a
      // failure there must not blank the position report. Fetched alongside and
      // allowed to fail on its own.
      const [ov, es] = await Promise.all([
        apiFetch<Overview3>(`/api/settlements/overview3?date_from=${from}&date_to=${to}`),
        apiFetch<ExcSummary>('/api/recon/exceptions/summary').catch(() => null),
      ])
      setD(ov)
      setExc(es)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load the settlement position')
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => { load() }, [load])

  const ccs  = d?.ccs
  const isw  = d?.interswitch
  const ps   = d?.paystack
  const link = d?.link
  const psT  = ps?.totals

  const periodDays = daysBetween(from, to)
  const feeds = d?.feeds ?? []

  // Tie-out over what COULD tie out. See LinkInfo.no_master_data.
  const iswComparable = link ? Number(link.isw_txns) - Number(link.no_master_data ?? 0) : 0
  const tieRate = iswComparable > 0 ? (Number(link!.matched_to_ccs) / iswComparable) * 100 : 0

  const providerValue =
    Number(isw?.totals?.value_kobo ?? 0) +
    Number(psT?.transfer_kobo ?? 0) +
    Number(psT?.funding_kobo ?? 0)

  /*
    The verdict. A settlement page that opens with numbers and no sentence makes
    every reader derive the same conclusion by hand, and they will not all derive
    the same one. Coverage outranks tie-out here on purpose: an incomplete period
    cannot be pronounced settled or broken, and saying so is more honest than
    printing a percentage of a partial book.
  */
  const verdict = useMemo(() => {
    if (!d) return null
    const missing = feeds.filter(f => f.days_in_period === 0)
    const partial = feeds.filter(f => f.days_in_period > 0 && periodDays > 0
      && (f.days_in_period / periodDays) < 0.95)

    if (missing.length > 0) {
      return {
        tone: RED, icon: 'cloud_off', title: 'This period cannot be reconciled yet',
        body: `${missing.map(f => f.label).join(' and ')} sent nothing for these dates. `
            + 'Until the feed arrives, any break reported here is a missing file, not missing money.',
      }
    }
    if (partial.length > 0) {
      return {
        tone: AMBER, icon: 'error', title: 'Partial period — read the tie-out with care',
        body: `${partial.map(f => `${f.label} covers ${f.days_in_period} of ${periodDays} days`).join('; ')}. `
            + 'The rate below is measured only over days both sides sent.',
      }
    }
    const actionable = Number(exc?.actionable_n ?? 0)
    if (actionable > 0) {
      return {
        tone: tieRate >= 90 ? AMBER : RED, icon: 'rule',
        title: `${fmtNum(actionable)} break${actionable === 1 ? '' : 's'} to work`,
        body: `${fmtKobo(exc?.actionable_value_kobo)} across the queue, `
            + `tying out at ${tieRate.toFixed(1)}% on the Interswitch feed.`
            + (Number(exc?.master_no_data_n ?? 0) > 0
              ? ` A further ${fmtNum(exc?.master_no_data_n)} items are feed gaps, excluded from that figure.`
              : ''),
      }
    }
    return {
      tone: GREEN, icon: 'verified', title: 'Position is clean',
      body: `Both feeds complete for the period and nothing outstanding in the queue.`,
    }
  }, [d, feeds, periodDays, exc, tieRate])

  // ── CCS route table ─────────────────────────────────────────────────────────
  const routeRows = useMemo(() => (ccs?.routes ?? [])
    .map(r => ({ ...r, label: ROUTE_LABEL[r.route] ?? humanLabel(r.route) })), [ccs])
  const routeMax = useMemo(() =>
    Math.max(0, ...routeRows.map(r => Number(r.value_kobo))), [routeRows])

  const routeCols: TableCol<typeof routeRows[number]>[] = [
    { key: 'label', label: 'Route', sortable: true },
    { key: 'txns', label: 'Transactions', align: 'right', sortable: true,
      render: r => <span style={NUM}>{fmtNum(r.txns)}</span> },
    { key: 'value_kobo', label: 'Value', align: 'right', sortable: true,
      render: r => <span style={NUM}>{fmtKobo(r.value_kobo)}</span> },
    { key: 'share', label: 'Share', width: 90,
      render: r => <ShareBar value={Number(r.value_kobo)} max={routeMax} tone={NAVY} /> },
    { key: 'debits', label: 'DR / CR', align: 'right',
      render: r => (
        <span style={{ ...NUM, fontSize: TEXT.sm, color: 'var(--txt2)' }}>
          {fmtNum(r.debits)} / {fmtNum(r.credits)}
        </span>
      ) },
  ]

  // ── Interswitch channel table ───────────────────────────────────────────────
  const iswRows = useMemo(() => (isw?.channels ?? [])
    .map(c => ({ ...c, label: humanLabel(c.channel) })), [isw])
  const iswMax = useMemo(() =>
    Math.max(0, ...iswRows.map(r => Number(r.value_kobo))), [iswRows])

  const iswCols: TableCol<typeof iswRows[number]>[] = [
    { key: 'label', label: 'Channel', sortable: true },
    { key: 'txns', label: 'Txns', align: 'right', sortable: true,
      render: r => <span style={NUM}>{fmtNum(r.txns)}</span> },
    { key: 'value_kobo', label: 'Gross', align: 'right', sortable: true,
      render: r => <span style={NUM}>{fmtKobo(r.value_kobo)}</span> },
    { key: 'share', label: 'Share', width: 80,
      render: r => <ShareBar value={Number(r.value_kobo)} max={iswMax} tone={BLUE} /> },
    { key: 'fees_kobo', label: 'Fees', align: 'right', sortable: true,
      render: r => <span style={{ ...NUM, color: 'var(--txt2)' }}>{fmtKobo(r.fees_kobo)}</span> },
    // Legs are shown because the collapse is the whole reason these figures are
    // trustworthy: interswitch_legs holds one row per settlement leg, so summing it
    // raw double- and triple-counts a single transaction.
    { key: 'legs', label: 'Legs', align: 'right', sortable: true,
      render: r => <span style={{ ...NUM, color: 'var(--txt3)' }}>{fmtNum(r.legs)}</span> },
  ]

  // ── Paystack channel table ──────────────────────────────────────────────────
  const psRows = useMemo(() => (ps?.channels ?? [])
    .map(c => ({ ...c, label: humanLabel(c.channel) })), [ps])

  const psCols: TableCol<typeof psRows[number]>[] = [
    { key: 'label', label: 'Channel', sortable: true },
    { key: 'attempts', label: 'Attempts', align: 'right', sortable: true,
      render: r => <span style={NUM}>{fmtNum(r.attempts)}</span> },
    { key: 'success', label: 'Successful', align: 'right', sortable: true,
      render: r => <span style={NUM}>{fmtNum(r.success)}</span> },
    { key: 'value_kobo', label: 'Value', align: 'right', sortable: true,
      render: r => <span style={NUM}>{fmtKobo(r.value_kobo)}</span> },
    { key: 'completion_pct', label: 'Completion', align: 'right', sortable: true,
      render: r => {
        const p = Number(r.completion_pct ?? 0)
        const tone = p >= 90 ? GREEN : p >= 70 ? AMBER : RED
        return (
          <span style={{ ...NUM, color: tone, fontWeight: FW.semibold }}>
            {p.toFixed(1)}%
          </span>
        )
      } },
  ]

  return (
    <Page
      title="Settlement Overview"
      subtitle="CCS is the master ledger; Interswitch and Paystack are the payment providers"
      loading={loading && !d}
      skeletonKpis={4}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: SP[2] }}>
          <Button variant="secondary" size="sm" icon="rule"
            onClick={() => navigate('/settlements/exceptions')}>Exceptions</Button>
          <Button variant="secondary" size="sm" icon="play_arrow"
            onClick={() => navigate('/settlements/workbench')}>Reconcile</Button>
          <DateFilter from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} align="right" />
        </div>
      }
    >
      <ErrBanner error={error} onRetry={load} />

      {/* ── 1. The verdict ── */}
      {verdict && (
        <div role="status" style={{
          display: 'flex', alignItems: 'flex-start', gap: SP[3],
          padding: `${SP[4]} ${SP[4]}`, marginBottom: SP[5],
          background: 'var(--card)', border: '1px solid var(--card-bdr)',
          borderLeft: `4px solid ${verdict.tone}`,
          boxShadow: 'var(--card-shadow)', borderRadius: RADIUS.lg,
        }}>
          <span className="material-symbols-rounded" aria-hidden="true"
            style={{ fontSize: 22, color: verdict.tone, flexShrink: 0, marginTop: 1 }}>
            {verdict.icon}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>
              {verdict.title}
            </div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 3, lineHeight: 'var(--lh-relaxed)' }}>
              {verdict.body}
            </div>
          </div>
        </div>
      )}

      {/* ── 2. Is everything here yet? ── */}
      <h2 style={{
        fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)',
        textTransform: 'uppercase', letterSpacing: '0.06em', margin: `0 0 ${SP[3]}`,
      }}>
        Feed Coverage · {fmtDate(from)} – {fmtDate(to)}
      </h2>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
        gap: SP[3], marginBottom: SP[6],
      }}>
        {feeds.length === 0 && !loading
          ? <EmptyState icon="database" title="No feed information"
              description="The period returned no coverage data for any source." />
          : feeds.map(f => <FeedTile key={f.src} feed={f} periodDays={periodDays} />)}
      </div>

      {/* ── 3. Does it tie out? ── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: SP[3], marginBottom: SP[6],
      }}>
        <KpiCard label="Master Volume" value={fmtKobo(ccs?.totals?.debit_kobo)}
          sub={`${fmtNum(ccs?.totals?.txns)} txns · credits ${fmtKobo(ccs?.totals?.credit_kobo)}`}
          icon="account_balance_wallet" accent={NAVY} loading={loading && !d} />
        <KpiCard label="Provider Volume" value={fmtKobo(providerValue)}
          sub={`Interswitch ${fmtNum(isw?.totals?.txns)} · Paystack ${fmtNum(Number(psT?.transfer_n ?? 0) + Number(psT?.funding_n ?? 0))}`}
          icon="hub" accent={BLUE} loading={loading && !d} />
        <KpiCard label="Tied to Master"
          value={iswComparable > 0 ? `${tieRate.toFixed(1)}%` : '—'}
          sub={Number(link?.no_master_data ?? 0) > 0
            ? `${fmtNum(link?.matched_to_ccs)} of ${fmtNum(iswComparable)} · ${fmtNum(link?.no_master_data)} awaiting CCS`
            : `${fmtNum(link?.matched_to_ccs)} of ${fmtNum(iswComparable)} Interswitch txns by STAN`}
          icon="link" accent={tieRate >= 90 ? GREEN : tieRate >= 60 ? AMBER : RED} loading={loading && !d} />
        <KpiCard label="Breaks to Work" value={fmtNum(exc?.actionable_n)}
          sub={`${fmtKobo(exc?.actionable_value_kobo)}${Number(exc?.aged_30d_n ?? 0) > 0 ? ` · ${fmtNum(exc?.aged_30d_n)} over 30 days` : ''}`}
          icon="rule" accent={Number(exc?.actionable_n ?? 0) > 0 ? RED : GREEN} loading={loading && !d} />
      </div>

      {/* ── The four channels, in the shape the business reports them ── */}
      {(() => {
        const ch = d?.channels
        if (!ch) return null
        const total = Number(ch.total ?? 0)
        const months = Math.max(1, Number(ch.months ?? 1))
        const rows = [
          { key: 'atm',      label: 'ATM',      value: Number(ch.atm),      source: 'ccs' },
          { key: 'pos',      label: 'POS',      value: Number(ch.pos),      source: 'ccs' },
          { key: 'web',      label: 'WEB',      value: Number(ch.web),      source: 'ccs' },
          { key: 'transfer', label: 'TRANSFER', value: Number(ch.transfer), source: 'paystack' },
        ].sort((a, b) => b.value - a.value)
        const tone: Record<string, string> = { atm: NAVY, pos: BLUE, web: AMBER, transfer: GREEN }
        const ccsMissing = Number(ch.ccs_rows ?? 0) === 0

        const chCols: TableCol<typeof rows[number]>[] = [
          { key: 'label', label: 'Transaction Type', render: r => (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: SP[2] }}>
              <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: 2, background: tone[r.key] }} />
              <span style={{ fontWeight: FW.semibold }}>{r.label}</span>
              {r.source === 'ccs' && ccsMissing && <Badge variant="warning">no source</Badge>}
            </span>
          ) },
          { key: 'value', label: 'Total Amount', align: 'right', sortable: true,
            render: r => <span style={{ ...NUM, fontWeight: FW.semibold }}>{fmtKobo(r.value)}</span> },
          { key: 'pct', label: 'Percentage (%)', align: 'right', width: 150, render: r => {
            const p = total > 0 ? (r.value / total) * 100 : 0
            return (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: SP[2], justifyContent: 'flex-end' }}>
                <span aria-hidden="true" style={{ width: 44, height: 4, borderRadius: 2, background: 'var(--bdr)', overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: `${Math.min(p, 100)}%`, background: tone[r.key] }} />
                </span>
                <span style={{ ...NUM, fontWeight: FW.semibold, minWidth: 48, textAlign: 'right' }}>
                  {p.toFixed(2)}
                </span>
              </span>
            )
          } },
          { key: 'avg', label: 'Average (Monthly)', align: 'right',
            render: r => <span style={NUM}>{fmtKobo(Math.round(r.value / months))}</span> },
          { key: 'source', label: 'Source', width: 170, render: r => (
            <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              {r.source === 'ccs' ? 'CCS card system' : 'Paystack (mobile app)'}
            </span>
          ) },
        ]

        return (
          <SectionCard title="Transactions by Channel" padding={false} style={{ marginBottom: SP[4] }}
            subtitle="The four channels as Card Operations reports them, with share and monthly average"
            actions={
              <Button size="sm" variant="secondary" icon="description"
                onClick={() => navigate('/settlements/interswitch/half-year')}>
                Full Report
              </Button>
            }>
            <DataTable cols={chCols} rows={rows} keyFn={r => r.key}
              loading={loading && !d} skeletonRows={4}
              emptyText={<EmptyState icon="category" title="No channel activity" />} />
            <div style={{
              display: 'flex', alignItems: 'center', gap: SP[4], flexWrap: 'wrap',
              padding: '12px 18px', borderTop: '2px solid var(--bdr)',
              background: 'var(--th-bg)', fontWeight: FW.bold,
            }}>
              <span style={{ fontSize: TEXT.sm }}>TOTAL</span>
              <span style={{ ...NUM, fontSize: TEXT.sm, marginLeft: 'auto' }}>{fmtKobo(total)}</span>
              <span style={{ ...NUM, fontSize: TEXT.sm }}>100.00</span>
              <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtKobo(Math.round(total / months))}</span>
            </div>
            {ccsMissing && (
              <div style={{
                padding: '10px 18px', borderTop: '1px solid var(--bdr)',
                fontSize: TEXT.xs, color: AMBER, lineHeight: 'var(--lh-relaxed)',
              }}>
                ATM, POS and WEB read the CCS card system, which holds nothing for this period — only
                TRANSFER is real here. A total that silently omits three of four channels is not a
                smaller total, it is a wrong one.
              </div>
            )}
          </SectionCard>
        )
      })()}

      {/* ── The master ledger ── */}
      <SectionCard style={{ marginBottom: SP[4] }}>
        <SourceHeader
          title="CCS: O3 Card Management System" role="Master" tone={NAVY}
          sub="Report 620 EODTXN — the book every provider must roll up to."
          feed={ccs?.totals?.last_day ? `through ${fmtDate(ccs.totals.last_day)}` : undefined}
        />
        <DataTable
          cols={routeCols} rows={routeRows} keyFn={r => r.route}
          loading={loading && !d} skeletonRows={5}
          emptyText={<EmptyState icon="inbox" title="No CCS activity in this period"
            description="The master ledger has no transactions for these dates." />}
        />
      </SectionCard>

      {/* ── The providers ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: SP[4], marginBottom: SP[4] }}>
        <SectionCard>
          <SourceHeader
            title="Interswitch" role="Provider" tone={BLUE}
            sub="Card rails: POS, ATM, web, bill payment and agency banking. Loaded from uploaded settlement reports."
          />
          <div style={{ display: 'flex', gap: SP[5], flexWrap: 'wrap', marginBottom: SP[4] }}>
            <Stat label="Gross" value={fmtKobo(isw?.totals?.value_kobo)} />
            <Stat label="Fees" value={fmtKobo(isw?.totals?.fees_kobo)} tone={AMBER} />
            <Stat label="Transactions" value={fmtNum(isw?.totals?.txns)}
              sub={`${fmtNum(isw?.totals?.legs)} settlement legs`} />
            <Stat label="Tied to Master"
              value={iswComparable > 0 ? `${tieRate.toFixed(1)}%` : '—'}
              tone={tieRate >= 90 ? GREEN : AMBER} />
          </div>
          <DataTable
            cols={iswCols} rows={iswRows} keyFn={r => r.channel}
            loading={loading && !d} skeletonRows={4}
            emptyText={<EmptyState icon="credit_card" title="No Interswitch settlement loaded"
              description="No uploaded report covers these dates." />}
          />
        </SectionCard>

        <SectionCard>
          <SourceHeader
            title="Paystack" role="Provider" tone={PURPLE}
            sub="Mobile app rails: wallet funding in, transfers out. Pulled live from the Paystack API."
          />
          <div style={{ display: 'flex', gap: SP[5], flexWrap: 'wrap', marginBottom: SP[4] }}>
            <Stat label="Funding In" value={fmtKobo(psT?.funding_kobo)}
              sub={`${fmtNum(psT?.funding_n)} ok · ${fmtNum(psT?.funding_lost_n)} failed`} tone={GREEN} />
            <Stat label="Transfers Out" value={fmtKobo(psT?.transfer_kobo)}
              sub={`${fmtNum(psT?.transfer_n)} ok · ${fmtNum(psT?.transfer_failed_n)} failed`} tone={RED} />
            <Stat label="Settled to Bank" value={fmtKobo(psT?.settled_kobo)} />
            <Stat label="Open Disputes" value={fmtNum(psT?.open_disputes)}
              tone={Number(psT?.open_disputes ?? 0) > 0 ? AMBER : undefined} />
          </div>
          <DataTable
            cols={psCols} rows={psRows} keyFn={r => r.channel}
            loading={loading && !d} skeletonRows={4}
            emptyText={<EmptyState icon="smartphone" title="No Paystack activity"
              description="No funding attempts fall in these dates." />}
          />
        </SectionCard>
      </div>

      {/* ── How the providers tie back ── */}
      <SectionCard title="Link to the Master"
        subtitle="A provider transaction only counts once it can be tied to a CCS record">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: SP[4] }}>
          <div style={{ padding: SP[4], borderRadius: RADIUS.lg, border: '1px solid var(--bdr)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: SP[2] }}>
              <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold }}>Interswitch → CCS</span>
              <Badge variant="success" dot>Linked</Badge>
            </div>
            <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color: tieRate >= 90 ? GREEN : AMBER }}>
              {iswComparable > 0 ? `${tieRate.toFixed(1)}%` : '—'}
            </div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 4, lineHeight: 'var(--lh-relaxed)' }}>
              Joined on <strong>STAN</strong> — the last 6 digits of the Interswitch RRN, zero-padded to
              match the CCS trace — and dated on the transaction time rather than the settlement date,
              because Interswitch settles T+1. {fmtNum(link?.matched_to_ccs)} of {fmtNum(iswComparable)} matched.
              {Number(link?.no_master_data ?? 0) > 0 && (
                <> A further <strong>{fmtNum(link?.no_master_data)}</strong> fall on days the CCS feed
                does not cover at all, so they are excluded here rather than counted as breaks.</>
              )}
            </div>
          </div>

          <div style={{
            padding: SP[4], borderRadius: RADIUS.lg, border: '1px solid var(--bdr)',
            background: 'rgba(217,119,6,0.05)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: SP[2], marginBottom: SP[2] }}>
              <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold }}>Paystack → CCS</span>
              <Badge variant="warning" dot>No Shared Key</Badge>
            </div>
            <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color: AMBER }}>—</div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 4, lineHeight: 'var(--lh-relaxed)' }}>
              {link?.paystack_note ?? 'No shared reference between Paystack and the CCS report.'}
            </div>
          </div>
        </div>
      </SectionCard>
    </Page>
  )
}
