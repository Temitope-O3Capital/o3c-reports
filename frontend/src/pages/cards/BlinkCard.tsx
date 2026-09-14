import { useEffect, useState, useCallback } from 'react'
import {
  Page, KpiCard, SectionCard, ErrBanner, DataTable, ExpandableFilterBar, Pagination,
} from '../../components/UI'
import type { TableCol, FilterGroupDef } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtDate, fmtCurrencyMinor } from '../../lib/fmt'
import { NUM, TEXT, FW, SP, RADIUS, PURPLE, GREEN, AMBER, TRANSITION } from '../../lib/design'
import {
  CARD_STATES, CARD_STATE_COLORS,
  CARD_ACTIVITY, CARD_ACTIVITY_COLORS, CARD_ACTIVITY_HINTS,
} from '../../lib/cardProducts'

// Blink — the temporary, FX-funded virtual card — on its own page.
//
// This replaces a stub that carried a "Feature in progress" notice and read a
// backend that identified Blink cards by `product_name ILIKE '%blink%'`. Blink
// is now its own funding family in the catalogue (app.card_products.category,
// migration 239) and every figure here keys on it.
//
// The card art below is deliberately unlike the other card faces in the app
// (ContactProfile's CARD_THEMES). That is not decoration — it reflects what the
// product actually is:
//   * virtual, so there is no EMV chip, because a chip is a physical contact plate
//   * temporary, so the remaining life is the headline, not the PAN
//   * FX-funded, so the funding currency sits on the face

// ── Types ─────────────────────────────────────────────────────────────────────

interface Totals {
  total_cards: number
  live_cards: number
  expired_cards: number
  active_30d: number
  never_used: number
  cardholders: number
  lifetime_txns: number
}

interface CountRow { count: number }
interface StatusRow extends CountRow { status: string }
interface ActivityRow extends CountRow { activity_class: string }

interface Summary {
  totals: Totals
  status_breakdown: StatusRow[]
  activity_breakdown: ActivityRow[]
}

interface TrendRow {
  month: string
  issued: number
  still_live: number
  used_recently: number
}

interface BlinkCardRow {
  account_no: string
  cif: string
  name_on_card: string
  card_pan: string
  card_state: string
  activity_class: string
  last_txn_date: string | null
  days_since_txn: number | null
  txn_count: number
  opened_date: string | null
  expiry_date: string | null
  is_expired: boolean
  balance_kobo: number
  currency: string
}

interface FXRow { currency: string; buy: string; sell: string; source: string; scraped_at: string }

const PAGE_SIZE = 25

// ── The Blink card face ───────────────────────────────────────────────────────

function BlinkFace({ totals }: { totals: Totals | null }) {
  const live = totals?.live_cards ?? 0
  const total = totals?.total_cards ?? 0
  // Blink cards are meant to expire, so the share still live is the product's
  // pulse — on a permanent card the same number would read as attrition.
  const livePct = total > 0 ? (live / total) * 100 : 0

  return (
    <div
      style={{
        position: 'relative', aspectRatio: '1.586', width: '100%', maxWidth: 400,
        borderRadius: 16, overflow: 'hidden', padding: '20px 22px',
        // Distinct from every physical-card theme in the app: a digital
        // violet→cyan rather than the metal/tier gradients.
        background: 'linear-gradient(135deg,#5B21B6 0%,#7C3AED 42%,#0E7490 100%)',
        color: '#FFFFFF', boxShadow: '0 10px 30px rgba(46,16,101,0.35)',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        transition: TRANSITION.base,
      }}
    >
      {/* Glass sheen */}
      <div style={{
        position: 'absolute', top: -80, right: -50, width: 240, height: 240, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(255,255,255,0.28) 0%, transparent 68%)', pointerEvents: 'none',
      }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', position: 'relative' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 20 }}>bolt</span>
            <span style={{ fontSize: TEXT.md, fontWeight: FW.bold, letterSpacing: 0.4 }}>Blink</span>
          </div>
          <div style={{ fontSize: TEXT['2xs'], color: 'rgba(255,255,255,0.76)', textTransform: 'uppercase', letterSpacing: 1.2, marginTop: 3 }}>
            PREP Temporary Virtual · 003
          </div>
        </div>
        <span style={{
          padding: '3px 9px', borderRadius: RADIUS.xl, fontSize: TEXT['2xs'], fontWeight: FW.bold,
          letterSpacing: 0.5, textTransform: 'uppercase',
          background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.34)',
        }}>Virtual</span>
      </div>

      {/* No EMV chip — a chip is a physical contact plate and this card has no
          plastic. The dashed panel stands in for the virtual credential. */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 44, height: 32, borderRadius: 6, flexShrink: 0,
          border: '1.5px dashed rgba(255,255,255,0.55)', background: 'rgba(255,255,255,0.10)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <span className="material-symbols-rounded" style={{ fontSize: 17, color: 'rgba(255,255,255,0.85)' }}>smartphone</span>
        </div>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 14, letterSpacing: 1.6,
          color: 'rgba(255,255,255,0.92)', textShadow: '0 1px 2px rgba(0,0,0,0.25)',
        }}>
          •••• •••• •••• ••••
        </span>
      </div>

      <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 10 }}>
        <div>
          <div style={{ fontSize: 7.5, color: 'rgba(255,255,255,0.72)', letterSpacing: 1, textTransform: 'uppercase' }}>Funded in</div>
          <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, letterSpacing: 0.4 }}>FX → NGN</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 7.5, color: 'rgba(255,255,255,0.72)', letterSpacing: 1, textTransform: 'uppercase' }}>Still live</div>
          <div style={{ ...NUM, fontSize: TEXT.md, fontWeight: FW.bold }}>
            {fmtNum(live)} <span style={{ fontSize: TEXT.xs, fontWeight: FW.normal, color: 'rgba(255,255,255,0.72)' }}>of {fmtNum(total)}</span>
          </div>
        </div>
      </div>

      {/* Life bar — how much of the issued stock is still in force */}
      <div style={{ position: 'relative', height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.22)', overflow: 'hidden' }}>
        <div style={{ width: `${livePct}%`, height: '100%', borderRadius: 2, background: '#67E8F9', transition: 'width .5s' }} />
      </div>
    </div>
  )
}

// ── Breakdown bars ────────────────────────────────────────────────────────────

function BreakdownBars({
  rows, colors, hints, emptyText,
}: {
  rows: { label: string; count: number }[]
  colors: Record<string, string>
  hints?: Record<string, string>
  emptyText: string
}) {
  const total = rows.reduce((s, r) => s + Number(r.count ?? 0), 0)
  if (rows.length === 0) {
    return <div style={{ textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base, padding: '24px 0' }}>{emptyText}</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map(r => {
        const pct = total > 0 ? (Number(r.count) / total) * 100 : 0
        return (
          <div key={r.label} title={hints?.[r.label]}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: TEXT.sm }}>
              <span style={{ color: 'var(--txt)', fontWeight: FW.medium }}>{r.label}</span>
              <span style={{ ...NUM, color: 'var(--txt2)' }}>{fmtNum(r.count)} ({pct.toFixed(1)}%)</span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--bdr)' }}>
              <div style={{ height: '100%', borderRadius: 3, background: colors[r.label] ?? 'var(--chart-lbl)', width: `${pct}%`, transition: 'width .4s' }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Table columns ─────────────────────────────────────────────────────────────

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: RADIUS.xl,
      fontSize: TEXT.xs, fontWeight: FW.semibold, color, background: 'var(--chip-bg)',
    }}>{label}</span>
  )
}

const COLS: TableCol<BlinkCardRow>[] = [
  { key: 'cif', label: 'CIF',
    render: r => <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.sm, color: 'var(--txt)' }}>{r.cif}</span> },
  { key: 'name_on_card', label: 'Name on card',
    render: r => <span style={{ fontSize: TEXT.sm, color: 'var(--txt)', fontWeight: FW.medium }}>{r.name_on_card || '—'}</span> },
  { key: 'card_state', label: 'Status',
    render: r => <Pill label={r.card_state} color={CARD_STATE_COLORS[r.card_state] ?? 'var(--chart-lbl)'} /> },
  { key: 'activity_class', label: 'Activity',
    render: r => <Pill label={r.activity_class} color={CARD_ACTIVITY_COLORS[r.activity_class] ?? 'var(--chart-lbl)'} /> },
  { key: 'last_txn_date', label: 'Last used', sortable: true,
    render: r => r.last_txn_date
      ? <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{fmtDate(r.last_txn_date)}</span>
      : <span style={{ fontSize: TEXT.sm, color: 'var(--txt3)' }}>never</span> },
  { key: 'txn_count', label: 'Txns', align: 'right',
    render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{fmtNum(r.txn_count)}</span> },
  { key: 'balance_kobo', label: 'Balance', align: 'right',
    render: r => {
      // A prepaid/Blink balance is the customer's own float, and the book stores
      // it as a negative (a credit). Rendering "-₦500" would read as debt.
      const v = Number(r.balance_kobo ?? 0)
      const inCredit = v < 0
      return (
        <span style={{ ...NUM, fontSize: TEXT.sm, color: inCredit ? GREEN : 'var(--txt)' }}>
          {fmtCurrencyMinor(Math.abs(v), r.currency)}{inCredit ? ' CR' : ''}
        </span>
      )
    } },
  { key: 'expiry_date', label: 'Expires',
    render: r => (
      <span style={{ fontSize: TEXT.sm, color: r.is_expired ? AMBER : 'var(--txt2)' }}>
        {r.expiry_date ? fmtDate(r.expiry_date) : '—'}
      </span>
    ) },
]

// ── Page ──────────────────────────────────────────────────────────────────────

export default function BlinkCard() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [trend, setTrend]     = useState<TrendRow[]>([])
  const [fx, setFx]           = useState<FXRow[]>([])
  const [fxNote, setFxNote]   = useState('')

  const [rows, setRows]   = useState<BlinkCardRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage]   = useState(1)

  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const [search, setSearch]       = useState('')
  const [fStates, setFStates]     = useState(new Set<string>())
  const [fActivity, setFActivity] = useState(new Set<string>())

  const loadSummary = useCallback(async () => {
    setError(null)
    try {
      const [s, t, f] = await Promise.all([
        apiFetch<any>('/api/blink-card/summary'),
        apiFetch<any>('/api/blink-card/issuance-trend'),
        apiFetch<any>('/api/blink-card/fx'),
      ])
      setSummary((s?.data ?? s) as Summary)
      setTrend(Array.isArray(t) ? t : (t?.data ?? []))
      const fxBody = f?.data ?? f
      setFx(fxBody?.rates ?? [])
      setFxNote(fxBody?.note ?? '')
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  const loadCards = useCallback(async (pg = 1) => {
    setLoading(true)
    try {
      const p = new URLSearchParams()
      p.set('limit', String(PAGE_SIZE))
      p.set('offset', String((pg - 1) * PAGE_SIZE))
      if (fStates.size)   p.set('status',   [...fStates][0])
      if (fActivity.size) p.set('activity', [...fActivity][0])
      if (search.trim())  p.set('q', search.trim())
      const res = await apiFetch<any>(`/api/blink-card/cards?${p}`)
      setRows(res?.data ?? [])
      setTotal(Number(res?.total ?? 0))
      setPage(pg)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [fStates, fActivity, search])

  useEffect(() => { loadSummary() }, [loadSummary])
  useEffect(() => { loadCards(1) }, [loadCards])

  const t = summary?.totals ?? null
  const statusRows = (summary?.status_breakdown ?? []).map(r => ({ label: r.status, count: r.count }))
  const activityRows = (summary?.activity_breakdown ?? []).map(r => ({ label: r.activity_class, count: r.count }))
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <Page
      title="Blink"
      subtitle="Temporary virtual cards, funded in foreign currency and credited in naira"
      loading={loading && !summary}
      skeletonKpis={4}
    >
      <ErrBanner error={error} onRetry={() => { loadSummary(); loadCards(page) }} />

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[4], marginBottom: SP[5] }}>
        <KpiCard label="Blink Cards Issued" value={fmtNum(t?.total_cards ?? 0)} icon="bolt" accent={PURPLE} />
        <KpiCard label="Still Live" value={fmtNum(t?.live_cards ?? 0)} icon="check_circle" accent={GREEN}
          sub={t && t.total_cards > 0 ? `${((t.live_cards / t.total_cards) * 100).toFixed(1)}% of issued` : undefined} />
        <KpiCard label="Used in 30 Days" value={fmtNum(t?.active_30d ?? 0)} icon="trending_up" accent={GREEN} />
        <KpiCard label="Never Used" value={fmtNum(t?.never_used ?? 0)} icon="do_not_disturb_on" accent={AMBER}
          sub={t && t.total_cards > 0 ? `${((t.never_used / t.total_cards) * 100).toFixed(1)}% of issued` : undefined} />
      </div>

      {/* Card face + funding */}
      <div style={{ display: 'grid', gridTemplateColumns: '400px 1fr', gap: SP[4], marginBottom: SP[5], alignItems: 'start' }}>
        <BlinkFace totals={t} />

        <SectionCard title="Funding" subtitle="Blink is loaded in foreign currency and credited in naira">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: SP[3], marginBottom: SP[3] }}>
            {fx.map(r => (
              <div key={r.currency} style={{
                padding: SP[3], borderRadius: RADIUS.md, background: 'var(--chip-bg)', border: '1px solid var(--bdr)',
              }}>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontWeight: FW.semibold, letterSpacing: 0.4 }}>
                  {r.currency} → NGN
                </div>
                <div style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.bold, color: 'var(--txt)', marginTop: 2 }}>
                  {Number(r.sell).toLocaleString('en-NG')}
                </div>
                <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', marginTop: 2 }}>
                  buy {Number(r.buy).toLocaleString('en-NG')} · {r.scraped_at}
                </div>
              </div>
            ))}
            {fx.length === 0 && (
              <div style={{ gridColumn: '1 / -1', color: 'var(--txt3)', fontSize: TEXT.sm, padding: SP[3] }}>
                No FX rates available.
              </div>
            )}
          </div>
          {fxNote && (
            <div style={{
              fontSize: TEXT.xs, color: 'var(--txt2)', lineHeight: 1.6,
              padding: SP[3], borderRadius: RADIUS.md, background: 'var(--fp-bg)', border: '1px dashed var(--bdr)',
            }}>
              <span className="material-symbols-rounded" style={{ fontSize: 14, verticalAlign: '-2px', marginRight: 4 }}>info</span>
              {fxNote}
            </div>
          )}
        </SectionCard>
      </div>

      {/* The two axes */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[4], marginBottom: SP[5] }}>
        <SectionCard title="Status" subtitle="Lifecycle — where the card is in its life">
          <BreakdownBars rows={statusRows} colors={CARD_STATE_COLORS} emptyText="No status data" />
        </SectionCard>
        <SectionCard title="Activity" subtitle="Usage — how recently the card was spent on">
          <BreakdownBars rows={activityRows} colors={CARD_ACTIVITY_COLORS} hints={CARD_ACTIVITY_HINTS} emptyText="No activity data" />
        </SectionCard>
      </div>

      {/* Issuance vs survival */}
      <SectionCard
        title="Issuance"
        subtitle="Blink cards are temporary by design, so what matters is how many of each month's cards are still live"
        badge={trend.length}
        style={{ marginBottom: SP[5] }}
      >
        {trend.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.base, padding: '24px 0' }}>No issuance history</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Month', 'Issued', 'Still live', 'Used recently'].map((h, i) => (
                  <th key={h} style={{
                    padding: '10px 14px', textAlign: i === 0 ? 'left' : 'right',
                    fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase',
                    color: 'var(--txt2)', background: 'var(--th-bg)', borderBottom: '1px solid var(--bdr)',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trend.map(r => (
                <tr key={r.month} className="tbl-row" style={{ borderBottom: '1px solid var(--bdr)' }}>
                  <td style={{ padding: '10px 14px', color: 'var(--txt)', fontWeight: FW.semibold }}>{r.month}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM }}>{fmtNum(r.issued)}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM, color: r.still_live > 0 ? GREEN : 'var(--txt3)' }}>
                    {fmtNum(r.still_live)}
                  </td>
                  <td style={{ padding: '10px 14px', textAlign: 'right', ...NUM, color: 'var(--txt2)' }}>{fmtNum(r.used_recently)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      {/* The cards */}
      <SectionCard title="Blink Cards" badge={total} padding={false}>
        <ExpandableFilterBar
          search={search}
          onSearch={setSearch}
          groups={[
            {
              key: 'status',
              label: 'Status',
              options: CARD_STATES.map(s => ({ value: s, label: s, color: CARD_STATE_COLORS[s] })),
              selected: fStates,
              onChange: setFStates,
            },
            {
              key: 'activity',
              label: 'Activity',
              options: CARD_ACTIVITY.map(a => ({ value: a, label: a, color: CARD_ACTIVITY_COLORS[a] })),
              selected: fActivity,
              onChange: setFActivity,
            },
          ] as FilterGroupDef[]}
          onReset={() => { setSearch(''); setFStates(new Set()); setFActivity(new Set()) }}
          onApply={() => loadCards(1)}
          resultCount={total}
          totalCount={total}
          placeholder="Search CIF, name or account…"
        />

        <DataTable
          cols={COLS}
          rows={rows}
          keyFn={r => r.account_no}
          loading={loading}
          emptyText="No Blink cards match these filters"
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 18px', borderTop: '1px solid var(--bdr)' }}>
          <Pagination
            page={page}
            pages={totalPages}
            total={total}
            pageSize={PAGE_SIZE}
            onPage={p => loadCards(p)}
          />
        </div>
      </SectionCard>
    </Page>
  )
}
