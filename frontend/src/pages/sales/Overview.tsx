import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { EBar } from '../../components/echarts'
import { Page, KpiCard, SectionCard, DataTable, Sk, DateFilter, Modal } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch, apiPost } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct, fmtDate, fmtDatetime, n } from '../../lib/fmt'
import { RED, GREEN, BLUE, AMBER, NAVY, PURPLE, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'
import { PRODUCT_LINES, lineColor } from '../../lib/products'
import { isSalesHead } from '../../hooks/useAuth'

// The Sales Team Lead's dashboard.
//
// This replaces a credit-origination page that read loan_applications — a table with
// zero rows — and said nothing about customer acquisition or the state of the team's
// book. It answers the four questions a lead actually opens a dashboard for: are we
// acquiring, how is each officer doing, what is in the pipeline, and what needs
// fixing today.
//
// A date window (top-right) drives every PERIOD panel — the KPI strip, the acquisition
// trend, lead sources and the officer league table. Book-STATE panels — the attention
// worklist, the book-health card and the unassigned worklist — ignore the window: "who
// has no officer right now" doesn't change because you picked last quarter.

// ── Types ─────────────────────────────────────────────────────────────────────
interface Summary {
  customers: number; mtd: number; ytd: number; prev_month: number
  unassigned: number; undated: number
  total_leads: number; open_leads: number; qualified: number; converted_mtd: number
  overdue_actions: number; pipeline_value_kobo: number
  submitted_mtd: number; active: number; approved_mtd_kobo: number
  officers: number; mom_change_pct: number | null
  period_customers: number; prev_period_customers: number; period_customers_change_pct: number | null
  period_leads: number; prev_period_leads: number; period_leads_change_pct: number | null
  period_converted: number; avg_book_per_officer: number | null
}
interface AcqPoint { month: string; customers: number }
interface TargetActual {
  user_id: number
  target_loans: number; actual_loans: number; target_kobo: number; actual_kobo: number
  target_fds: number; actual_fds: number; target_fd_kobo: number; actual_fd_kobo: number
  target_cards: number; actual_cards: number; commission_kobo: number
}
interface Officer {
  id: number; full_name: string; role: string; is_active: boolean; office_location: string
  book_size: number; acquired_period: number; acquired_mtd: number; acquired_ytd: number
  customers_in_arrears: number; open_leads: number; qualified_leads: number
  converted_period: number; converted_mtd: number; overdue_actions: number
  pipeline_value_kobo: number; conversion_rate_pct: number | null
}
interface SourceRow {
  source: string; label: string; leads: number
  converted: number; disqualified: number; conversion_rate_pct: number | null
}
interface UnassignedCustomer {
  cif: string; full_name: string; acquired_on: string; state: string; phone: string; account_count: number
  has_cards: boolean; has_loans: boolean; has_fds: boolean
}
interface Attention {
  unassigned_customers: UnassignedCustomer[]
  overdue_actions: { id: number; first_name: string; last_name: string; phone: string; lead_stage: string; next_action_at: string; owner_name: string }[]
  unowned_leads: { id: number; first_name: string; last_name: string; phone: string; lead_source: string; created_at: string }[]
  stalled_leads: { id: number; first_name: string; last_name: string; lead_stage: string; last_activity_at: string; owner_name: string }[]
  unassigned_customers_total?: number
  unassigned_book_total?: number
  overdue_actions_total?: number
  unowned_leads_total?: number
  stalled_leads_total?: number
  feed: { status: string; started_at: string; finished_at: string; customers_inserted: number; customers_updated: number; files_parsed: number; files_failed: number } | null
}
interface PickOfficer { id: number; full_name: string; email: string; role: string; book_size: number; already_officer: boolean }

// ── Date helpers ──────────────────────────────────────────────────────────────
const _pad = (x: number) => String(x).padStart(2, '0')
const _iso = (d: Date) => `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`
// Default lens: the last 12 months. Wide enough for a readable acquisition trend, recent
// enough that the lead panels (all created in the last year) are populated. "All time"
// is one click away in the picker for the full 12-year acquisition history.
function defaultWindow(): { from: string; to: string } {
  const today = new Date()
  return { from: _iso(new Date(today.getFullYear(), today.getMonth() - 11, 1)), to: _iso(today) }
}

// The feed delivers names in inconsistent casing (JOHN DOE, john doe, John doe). Present
// them in Proper Case so the worklist reads as one clean column. Small words in the
// middle of a name still capitalise — a name is not prose, and "of"/"and" are rare enough
// that over-lowercasing them reads worse than the occasional "Ade Of Lagos".
function titleCase(s?: string | null): string {
  if (!s) return ''
  return s.toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
}

function relTime(s?: string | null): string {
  if (!s) return '—'
  const then = new Date(s).getTime()
  if (isNaN(then)) return '—'
  const diff = Date.now() - then
  const m = Math.round(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hr${h > 1 ? 's' : ''} ago`
  const d = Math.round(h / 24)
  return `${d} day${d > 1 ? 's' : ''} ago`
}

// ── Small pieces ──────────────────────────────────────────────────────────────
function Caveat({ icon, tone, children }: { icon: string; tone: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: `${SP[3]} ${SP[4]}`, borderRadius: RADIUS.md,
      background: `${tone}0F`, border: `1px solid ${tone}33`,
      fontSize: TEXT.sm, color: 'var(--txt2)', lineHeight: 1.5,
    }}>
      <span className="material-symbols-rounded" style={{ fontSize: 18, color: tone, flexShrink: 0 }}>{icon}</span>
      <div>{children}</div>
    </div>
  )
}

// Compact book-state metric. Distinct from KpiCard (which is period + delta): these are
// small "right now" facts that let a lead scan book health in one row.
function StatTile({ label, value, icon, tone, sub, onClick }: {
  label: string; value: string; icon: string; tone: string; sub?: string; onClick?: () => void
}) {
  return (
    <button onClick={onClick} disabled={!onClick} style={{
      display: 'flex', alignItems: 'center', gap: 11, textAlign: 'left', width: '100%',
      background: 'var(--card)', border: '1px solid var(--card-bdr)', boxShadow: 'var(--card-shadow)',
      borderRadius: 12, padding: '12px 14px', cursor: onClick ? 'pointer' : 'default',
    }}
      onMouseEnter={e => { if (onClick) e.currentTarget.style.borderColor = tone }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--card-bdr)' }}>
      <div style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, background: `${tone}18`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span className="material-symbols-rounded" style={{ fontSize: 18, color: tone }}>{icon}</span>
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ ...NUM, fontSize: 19, fontWeight: FW.bold, color: 'var(--txt)', lineHeight: 1.1 }}>{value}</div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)', fontWeight: FW.medium, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
        {sub && <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)' }}>{sub}</div>}
      </div>
    </button>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function SalesOverview() {
  const navigate = useNavigate()
  const isHead = isSalesHead()
  const [win, setWin] = useState(defaultWindow)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [acq, setAcq] = useState<AcqPoint[]>([])
  const [officers, setOfficers] = useState<Officer[]>([])
  const [sources, setSources] = useState<SourceRow[]>([])
  const [attn, setAttn] = useState<Attention | null>(null)
  const [mix, setMix] = useState<Record<string, { count: number; value_kobo: number }>>({})
  const [actuals, setActuals] = useState<TargetActual[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string | number>>(new Set())
  const [assignFor, setAssignFor] = useState<{ cifs: string[]; label: string } | null>(null)

  const qs = win.from || win.to ? `?from=${win.from}&to=${win.to}` : ''
  const windowLabel = win.from || win.to ? `${fmtDate(win.from)} – ${fmtDate(win.to)}` : 'All time'

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      // allSettled, not all — seven independent panels; one broken query must not blank
      // the whole page. Each renders what it has; the banner names only what failed.
      const [s, a, o, src, at, fn, ac] = await Promise.allSettled([
        apiFetch<{ data: Summary }>(`/api/sales/overview/summary${qs}`),
        apiFetch<{ data: AcqPoint[] }>(`/api/sales/overview/acquisition${qs}${qs ? '&' : '?'}months=24`),
        apiFetch<{ data: Officer[] }>(`/api/sales/overview/officers${qs}`),
        apiFetch<{ data: SourceRow[] }>(`/api/sales/overview/sources${qs}`),
        apiFetch<{ data: Attention }>('/api/sales/overview/attention'),
        apiFetch<{ data: { product_mix?: Record<string, { count: number; value_kobo: number }> } }>('/api/sales/leads/funnel'),
        apiFetch<{ data: TargetActual[] }>('/api/sales/targets/actuals'),
      ])
      const val = <T,>(r: PromiseSettledResult<{ data: T }>): T | undefined =>
        r.status === 'fulfilled' ? r.value?.data : undefined

      if (val(s)) setSummary(val(s)!)
      setAcq(val(a) ?? []); setOfficers(val(o) ?? [])
      setSources(val(src) ?? [])
      if (val(at)) setAttn(val(at)!)
      setMix((val(fn) as any)?.product_mix ?? {})
      setActuals(val(ac) ?? [])

      const failed = [
        [s, 'summary'], [a, 'acquisition'], [o, 'officers'], [src, 'lead sources'],
        [at, 'attention'], [fn, 'pipeline'], [ac, 'targets'],
      ].filter(([r]) => (r as PromiseSettledResult<unknown>).status === 'rejected')
        .map(([, name]) => name as string)
      setErr(failed.length ? `Could not load: ${failed.join(', ')}` : null)
    } catch (e: any) {
      setErr(e?.message ?? 'Could not load the sales overview')
    } finally {
      setLoading(false)
    }
  }, [qs])

  useEffect(() => { load() }, [load])

  // ── Derived ───────────────────────────────────────────────────────────────
  const noTeam = !loading && officers.length === 0
  const num = (v: number | null | undefined) => (v == null ? undefined : Number(v))

  const team = actuals.reduce((a, r) => ({
    tLoans: a.tLoans + Number(r.target_loans || 0), aLoans: a.aLoans + Number(r.actual_loans || 0),
    tKobo: a.tKobo + Number(r.target_kobo || 0), aKobo: a.aKobo + Number(r.actual_kobo || 0),
    tFds: a.tFds + Number(r.target_fds || 0), aFds: a.aFds + Number(r.actual_fds || 0),
    tFdKobo: a.tFdKobo + Number(r.target_fd_kobo || 0), aFdKobo: a.aFdKobo + Number(r.actual_fd_kobo || 0),
    tCards: a.tCards + Number(r.target_cards || 0), aCards: a.aCards + Number(r.actual_cards || 0),
    commission: a.commission + Number(r.commission_kobo || 0),
  }), { tLoans: 0, aLoans: 0, tKobo: 0, aKobo: 0, tFds: 0, aFds: 0, tFdKobo: 0, aFdKobo: 0, tCards: 0, aCards: 0, commission: 0 })
  const pct = (act: number, tgt: number) => tgt > 0 ? Math.round((act / tgt) * 100) : 0
  const pctColor = (p: number) => p >= 100 ? GREEN : p >= 60 ? AMBER : RED

  // Acquisition by office: a customer's office follows their account officer, so we roll
  // the officer league table up by office_location. Empty until staff are given offices
  // in Admin → Users.
  const byOffice = useMemo(() => {
    const m = new Map<string, { office: string; book: number; acquired: number; officers: number }>()
    for (const o of officers) {
      const key = o.office_location?.trim() || ''
      if (!key) continue
      const cur = m.get(key) ?? { office: key, book: 0, acquired: 0, officers: 0 }
      cur.book += n(o.book_size); cur.acquired += n(o.acquired_period); cur.officers += 1
      m.set(key, cur)
    }
    return [...m.values()].sort((a, b) => b.acquired - a.acquired || b.book - a.book)
  }, [officers])
  const officersWithOffice = officers.filter(o => o.office_location?.trim()).length

  // ── Officer league table ────────────────────────────────────────────────────
  const officerCols: TableCol<Officer>[] = [
    {
      key: 'full_name', label: 'Officer', sortable: true,
      render: r => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div style={{
            width: 28, height: 28, borderRadius: RADIUS.full, flexShrink: 0, background: `${NAVY}14`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: TEXT['2xs'], fontWeight: FW.bold, color: NAVY,
          }}>
            {(r.full_name ?? '?').split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase()}
          </div>
          <div>
            <div style={{ fontSize: TEXT.base }}>{r.full_name}</div>
            <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', display: 'flex', gap: 6 }}>
              {r.office_location && <span>{r.office_location}</span>}
              {!r.is_active && <span>· inactive</span>}
            </div>
          </div>
        </div>
      ),
    },
    { key: 'book_size', label: 'Book', sortable: true, align: 'right',
      render: r => <span style={NUM}>{fmtNum(r.book_size)}</span> },
    { key: 'acquired_period', label: 'New (period)', sortable: true, align: 'right',
      render: r => <span style={{ ...NUM, color: n(r.acquired_period) > 0 ? GREEN : 'var(--txt3)' }}>{fmtNum(r.acquired_period)}</span> },
    { key: 'converted_period', label: 'Converted', sortable: true, align: 'right',
      render: r => <span style={{ ...NUM, color: n(r.converted_period) > 0 ? GREEN : 'var(--txt3)' }}>{fmtNum(r.converted_period)}</span> },
    { key: 'open_leads', label: 'Open leads', sortable: true, align: 'right',
      render: r => <span style={NUM}>{fmtNum(r.open_leads)}</span> },
    { key: 'conversion_rate_pct', label: 'Conv. rate', sortable: true, align: 'right',
      render: r => r.conversion_rate_pct == null
        ? <span style={{ color: 'var(--txt3)' }}>—</span>
        : <span style={NUM}>{fmtPct(r.conversion_rate_pct)}</span> },
    { key: 'pipeline_value_kobo', label: 'Pipeline', sortable: true, align: 'right',
      render: r => <span style={NUM}>{fmtKobo(r.pipeline_value_kobo)}</span> },
    { key: 'overdue_actions', label: 'Overdue', sortable: true, align: 'right',
      render: r => <span style={{ ...NUM, color: n(r.overdue_actions) > 0 ? RED : 'var(--txt3)' }}>{fmtNum(r.overdue_actions)}</span> },
    { key: 'customers_in_arrears', label: 'In arrears', sortable: true, align: 'right',
      render: r => <span style={{ ...NUM, color: n(r.customers_in_arrears) > 0 ? AMBER : 'var(--txt3)' }}>{fmtNum(r.customers_in_arrears)}</span> },
  ]

  // ── Recently-acquired worklist ──────────────────────────────────────────────
  const unassignedRows = attn?.unassigned_customers ?? []
  const unassignedTotal = attn?.unassigned_customers_total ?? unassignedRows.length
  const acqCols: TableCol<UnassignedCustomer>[] = [
    {
      key: 'full_name', label: 'Customer',
      render: r => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div style={{
            width: 28, height: 28, borderRadius: RADIUS.full, flexShrink: 0, background: `${AMBER}18`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: TEXT['2xs'], fontWeight: FW.bold, color: AMBER,
          }}>
            {(r.full_name ?? '?').split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase()}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: TEXT.base, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{titleCase(r.full_name) || '—'}</div>
            <div style={{ ...NUM, fontSize: TEXT.xs, color: 'var(--txt3)' }}>{r.cif}</div>
          </div>
        </div>
      ),
    },
    { key: 'phone', label: 'Phone', render: r => <span style={{ ...NUM, fontSize: TEXT.sm }}>{r.phone || '—'}</span> },
    { key: 'state', label: 'State', render: r => titleCase(r.state) || '—' },
    {
      key: 'products', label: 'Products',
      render: r => {
        const chips = [
          r.has_cards && { label: 'Cards', color: lineColor('cards') },
          r.has_loans && { label: 'Loans', color: lineColor('loans') },
          r.has_fds && { label: 'FD', color: lineColor('fixed_deposit') },
        ].filter(Boolean) as { label: string; color: string }[]
        if (chips.length === 0) return <span style={{ color: 'var(--txt3)' }}>—</span>
        return (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chips.map(c => (
              <span key={c.label} style={{ fontSize: TEXT['2xs'], fontWeight: FW.semibold, color: c.color, background: `${c.color}18`, padding: '2px 7px', borderRadius: 20 }}>{c.label}</span>
            ))}
          </div>
        )
      },
    },
    { key: 'account_count', label: 'Accounts', align: 'right', render: r => <span style={NUM}>{fmtNum(r.account_count)}</span> },
    { key: 'acquired_on', label: 'Acquired', align: 'right', render: r => <span style={{ fontSize: TEXT.sm }}>{fmtDate(r.acquired_on)}</span> },
    ...(isHead ? [{
      key: '_assign', label: '', align: 'right' as const,
      render: (r: UnassignedCustomer) => (
        <button
          onClick={e => { e.stopPropagation(); setAssignFor({ cifs: [r.cif], label: r.full_name || r.cif }) }}
          title="Assign to a sales rep"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: RADIUS.md,
            border: `1px solid ${NAVY}33`, background: `${NAVY}0d`, color: NAVY, cursor: 'pointer',
            fontSize: TEXT.xs, fontWeight: FW.semibold,
          }}>
          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>person_add</span>
          Assign
        </button>
      ),
    }] : []),
  ]

  const feed = attn?.feed
  const feedTone = !feed ? AMBER : feed.status === 'ok' ? GREEN : RED

  return (
    <Page
      loading={loading && !summary}
      skeletonKpis={4}
      title="Sales Overview"
      subtitle="Customer acquisition, team performance and book health"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <DateFilter from={win.from} to={win.to} onChange={(f, t) => setWin({ from: f, to: t })} align="right" />
          <button
            onClick={() => navigate('/sales/leads')}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px',
              borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold,
              border: 'none', background: RED, color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>person_add</span>
            New Lead
          </button>
        </div>
      }
    >
      {err && (
        <div style={{ marginBottom: SP[4] }}>
          <Caveat icon="error" tone={RED}>{err}</Caveat>
        </div>
      )}

      {(noTeam || n(summary?.unassigned) > 0) && !loading && (
        <div style={{ display: 'grid', gap: 10, marginBottom: SP[4] }}>
          {noTeam && (
            <Caveat icon="group_add" tone={BLUE}>
              <strong>Nobody holds a book yet.</strong> Officers appear here as soon as
              they are given customers. You can assign to any active user, so this does
              not wait on new accounts or role changes.{' '}
              <button
                onClick={() => navigate('/sales/book?officer_id=unassigned')}
                style={{ background: 'none', border: 'none', color: BLUE, cursor: 'pointer', padding: 0, font: 'inherit', fontWeight: FW.semibold }}
              >
                Assign the book
              </button>
            </Caveat>
          )}
          {n(summary?.unassigned) > 0 && (
            <Caveat icon="assignment_late" tone={AMBER}>
              <strong>{fmtNum(summary?.unassigned)} customers have no account officer.</strong>{' '}
              Ownership used to live in the retired card system and was never carried
              across, so the book starts unassigned.{' '}
              <button
                onClick={() => navigate('/sales/book?officer_id=unassigned')}
                style={{ background: 'none', border: 'none', color: RED, cursor: 'pointer', padding: 0, font: 'inherit', fontWeight: FW.semibold }}
              >
                Assign them
              </button>
            </Caveat>
          )}
        </div>
      )}

      {/* Period KPI strip — driven by the date window */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
          Performance · {windowLabel}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: SP[4] }}>
        <KpiCard label="New customers" value={summary ? fmtNum(summary.period_customers) : '—'}
          sub={summary && summary.prev_period_customers > 0 ? `${fmtNum(summary.prev_period_customers)} prior period` : 'in selected period'}
          change={num(summary?.period_customers_change_pct)}
          icon="person_add" accent={GREEN} loading={loading} />
        <KpiCard label="New leads" value={summary ? fmtNum(summary.period_leads) : '—'}
          sub={summary && summary.prev_period_leads > 0 ? `${fmtNum(summary.prev_period_leads)} prior period` : 'in selected period'}
          change={num(summary?.period_leads_change_pct)}
          icon="filter_alt" accent={BLUE} loading={loading} />
        <KpiCard label="Converted" value={summary ? fmtNum(summary.period_converted) : '—'}
          sub={summary ? `${fmtNum(summary.customers)} total in book` : undefined}
          icon="verified" accent={PURPLE} loading={loading} />
        <KpiCard label="Open pipeline" value={summary ? fmtKobo(summary.pipeline_value_kobo) : '—'}
          sub={summary ? `${fmtNum(summary.open_leads)} open leads` : undefined}
          icon="trending_up" accent={NAVY} loading={loading} />
      </div>

      {/* Book-state metric band — always current, ignores the window */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))', gap: 12, marginBottom: SP[4] }}>
        <StatTile label="Total book" value={summary ? fmtNum(summary.customers) : '—'} icon="groups" tone={NAVY}
          onClick={() => navigate('/sales/book')} />
        <StatTile label="Unassigned" value={summary ? fmtNum(summary.unassigned) : '—'} icon="assignment_late"
          tone={n(summary?.unassigned) > 0 ? AMBER : GREEN} onClick={() => navigate('/sales/book?officer_id=unassigned')} />
        <StatTile label="Open leads" value={summary ? fmtNum(summary.open_leads) : '—'} icon="hub" tone={BLUE}
          sub={summary ? `${fmtNum(summary.qualified)} qualified` : undefined} onClick={() => navigate('/sales/leads')} />
        <StatTile label="Overdue follow-ups" value={summary ? fmtNum(summary.overdue_actions) : '—'} icon="alarm"
          tone={n(summary?.overdue_actions) > 0 ? RED : GREEN} onClick={() => navigate('/sales/leads?due=1')} />
        <StatTile label="Active officers" value={summary ? fmtNum(summary.officers) : '—'} icon="badge" tone={PURPLE}
          sub={summary?.avg_book_per_officer != null ? `${fmtNum(summary.avg_book_per_officer)} avg book` : undefined}
          onClick={() => navigate('/sales/supervisor')} />
        <StatTile label="Total leads" value={summary ? fmtNum(summary.total_leads) : '—'} icon="contacts" tone={GREEN}
          onClick={() => navigate('/sales/leads')} />
      </div>

      {/* Acquisition trend (period-wired) + lead sources (period-wired) */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
        <SectionCard
          title="Customer acquisition"
          subtitle={`New customers registered per month · ${windowLabel}`}
        >
          {loading ? <Sk h={260} /> : acq.length === 0 ? (
            <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
              No customers acquired in this period
            </div>
          ) : (
            <EBar
              data={acq.map(p => ({ month: p.month, customers: Number(p.customers) }))}
              xKey="month"
              height={260}
              legend={false}
              valueFmt={fmtNum}
              axisFmt={fmtNum}
              series={[{ key: 'customers', name: 'New customers', color: NAVY }]}
            />
          )}
        </SectionCard>

        <SectionCard title="Lead sources" subtitle={`Where leads originate · ${windowLabel}`}>
          {loading ? <Sk h={260} /> : sources.length === 0 ? (
            <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm, padding: 12 }}>
              No leads created in this period
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {sources.slice(0, 7).map(s => {
                const rate = s.conversion_rate_pct == null ? null : Number(s.conversion_rate_pct)
                return (
                  <div key={s.source} onClick={() => navigate(`/sales/leads?source=${s.source}`)} style={{ cursor: 'pointer' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: TEXT.sm, marginBottom: 4 }}>
                      <span style={{ color: 'var(--txt)', fontWeight: FW.medium }}>{s.label}</span>
                      <span style={{ ...NUM, color: 'var(--txt2)' }}>{fmtNum(s.leads)}</span>
                    </div>
                    <div style={{ height: 7, background: 'var(--chip-bg)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: 4, background: BLUE,
                        width: `${Math.max(3, (n(s.leads) / Math.max(1, n(sources[0]?.leads))) * 100)}%`,
                      }} />
                    </div>
                    <div style={{ display: 'flex', gap: 10, marginTop: 3, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                      <span>{fmtNum(s.converted)} converted</span>
                      {rate != null && <span>· {fmtPct(rate)} rate</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </SectionCard>
      </div>

      {/* Pipeline by product + team targets (current state — not window-scoped) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: SP[4] }}>
        <SectionCard title="Open pipeline by product" subtitle="Leads in play, by line — click to filter">
          {!loading && PRODUCT_LINES.every(pl => (mix[pl.line]?.count ?? 0) === 0) && (mix.unclassified?.count ?? 0) > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 8, padding: `${SP[5]} ${SP[4]}`, minHeight: 150 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 30, color: 'var(--txt3)' }}>sell</span>
              <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                {fmtNum(mix.unclassified!.count)} open leads, none tagged to a product
              </div>
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', maxWidth: 340, lineHeight: 1.5 }}>
                Product interest was never captured for the imported book. It fills in as
                officers set a line on each lead; new leads created here carry one from the start.
              </div>
              <button onClick={() => navigate('/sales/leads')}
                style={{ marginTop: 4, fontSize: TEXT.sm, fontWeight: FW.semibold, color: RED, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px' }}>
                Open leads
              </button>
            </div>
          ) : (<>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
              {PRODUCT_LINES.map(pl => {
                const m = mix[pl.line] ?? { count: 0, value_kobo: 0 }
                return (
                  <div key={pl.line} onClick={() => navigate(`/sales/leads?line=${pl.line}`)}
                    style={{ cursor: 'pointer', border: '1px solid var(--bdr)', borderLeft: `3px solid ${lineColor(pl.line)}`, borderRadius: RADIUS.lg, padding: '12px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <span className="material-symbols-rounded" style={{ fontSize: 16, color: pl.color }}>{pl.icon}</span>
                      <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)' }}>{pl.label}</span>
                    </div>
                    <div style={{ ...NUM, fontSize: 22, fontWeight: FW.extrabold, color: 'var(--txt)', lineHeight: 1 }}>{fmtNum(m.count)}</div>
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 3 }}>{fmtKobo(m.value_kobo)} value</div>
                  </div>
                )
              })}
            </div>
            {(mix.unclassified?.count ?? 0) > 0 && (
              <div style={{ marginTop: 8, fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtNum(mix.unclassified!.count)} leads not yet tagged with a product.</div>
            )}
          </>)}
        </SectionCard>

        <SectionCard title="Team targets & commission" subtitle="This month, across all officers">
          {!loading && actuals.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 8, padding: `${SP[5]} ${SP[4]}`, minHeight: 150 }}>
              <span className="material-symbols-rounded" style={{ fontSize: 30, color: 'var(--txt3)' }}>flag</span>
              <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>No targets set this month</div>
              <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', maxWidth: 320, lineHeight: 1.5 }}>
                Attainment and commission appear once monthly targets are assigned to officers.
              </div>
              <button onClick={() => navigate('/sales/targets')}
                style={{ marginTop: 4, fontSize: TEXT.sm, fontWeight: FW.semibold, color: RED, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px' }}>
                Set targets
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { label: 'Loans', a: team.aLoans, t: team.tLoans, sub: `${fmtKobo(team.aKobo)} / ${fmtKobo(team.tKobo)}` },
                { label: 'Fixed Deposits', a: team.aFds, t: team.tFds, sub: `${fmtKobo(team.aFdKobo ?? 0)} / ${fmtKobo(team.tFdKobo ?? 0)}` },
                { label: 'Cards', a: team.aCards, t: team.tCards, sub: 'cards issued' },
              ].map(row => {
                const p = pct(row.a, row.t)
                return (
                  <div key={row.label}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
                      <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{row.label}</span>
                      <span style={{ fontSize: TEXT.xs, ...NUM, color: 'var(--txt2)' }}>{fmtNum(row.a)} / {fmtNum(row.t)} · <strong style={{ color: pctColor(p) }}>{p}%</strong></span>
                    </div>
                    <div style={{ height: 6, background: 'var(--th-bg)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${Math.min(100, p)}%`, height: '100%', background: pctColor(p), borderRadius: 3 }} />
                    </div>
                  </div>
                )
              })}
              <div style={{ marginTop: 4, paddingTop: 10, borderTop: '1px solid var(--bdr)', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)' }}>Commission earned (team)</span>
                <span style={{ fontSize: TEXT.xl, fontWeight: FW.extrabold, color: GREEN, ...NUM }}>{fmtKobo(team.commission)}</span>
              </div>
            </div>
          )}
        </SectionCard>
      </div>

      {/* Team league table (period-wired) */}
      <SectionCard
        title="Team performance"
        subtitle={`Book, acquisition and pipeline by officer · ${windowLabel}`}
        badge={officers.length || undefined}
        actions={
          <button onClick={() => navigate('/sales/book')}
            style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: RED, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
            Open the book <span className="material-symbols-rounded" style={{ fontSize: 14 }}>arrow_forward</span>
          </button>
        }
      >
        <DataTable<Officer>
          cols={officerCols}
          rows={officers}
          loading={loading}
          skeletonRows={4}
          emptyText="No sales officers are provisioned yet"
          keyFn={r => r.id}
          onRowClick={r => navigate(`/sales/book?officer_id=${r.id}`)}
        />
      </SectionCard>

      {/* Acquisition by office (Lagos / Abuja / …) — customer's office follows its officer */}
      <SectionCard title="By office" subtitle={`Book and acquisition by branch · ${windowLabel}`}
        badge={byOffice.length || undefined}
        style={{ marginTop: 14 }}>
        {loading ? <Sk h={120} /> : byOffice.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 8, padding: `${SP[5]} ${SP[4]}`, minHeight: 120 }}>
            <span className="material-symbols-rounded" style={{ fontSize: 30, color: 'var(--txt3)' }}>location_city</span>
            <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>No staff are mapped to an office yet</div>
            <div style={{ fontSize: TEXT.sm, color: 'var(--txt3)', maxWidth: 380, lineHeight: 1.5 }}>
              Set each staff member’s office (Lagos, Abuja, …) in Admin → Users. Once mapped,
              this splits the book and acquisition by branch — a customer belongs to the branch
              of their account officer.
            </div>
            <button onClick={() => navigate('/admin/users')}
              style={{ marginTop: 4, fontSize: TEXT.sm, fontWeight: FW.semibold, color: RED, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px' }}>
              Manage staff offices
            </button>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            {byOffice.map(o => {
              const maxBook = Math.max(1, ...byOffice.map(x => x.book))
              return (
                <div key={o.office} style={{ border: '1px solid var(--bdr)', borderLeft: `3px solid ${NAVY}`, borderRadius: RADIUS.lg, padding: '13px 15px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 16, color: NAVY }}>apartment</span>
                    <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)' }}>{o.office}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 16 }}>
                    <div>
                      <div style={{ ...NUM, fontSize: 20, fontWeight: FW.extrabold, color: 'var(--txt)', lineHeight: 1 }}>{fmtNum(o.book)}</div>
                      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: 0.3 }}>Book</div>
                    </div>
                    <div>
                      <div style={{ ...NUM, fontSize: 20, fontWeight: FW.extrabold, color: GREEN, lineHeight: 1 }}>{fmtNum(o.acquired)}</div>
                      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: 0.3 }}>New</div>
                    </div>
                    <div>
                      <div style={{ ...NUM, fontSize: 20, fontWeight: FW.extrabold, color: 'var(--txt2)', lineHeight: 1 }}>{fmtNum(o.officers)}</div>
                      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: 0.3 }}>Staff</div>
                    </div>
                  </div>
                  <div style={{ height: 5, background: 'var(--th-bg)', borderRadius: 3, overflow: 'hidden', marginTop: 10 }}>
                    <div style={{ width: `${(o.book / maxBook) * 100}%`, height: '100%', background: NAVY, borderRadius: 3 }} />
                  </div>
                </div>
              )
            })}
            {officersWithOffice < officers.length && (
              <div style={{ gridColumn: '1 / -1', fontSize: TEXT.xs, color: 'var(--txt3)' }}>
                {fmtNum(officers.length - officersWithOffice)} officer(s) have no office set — assign one in Admin → Users to include them.
              </div>
            )}
          </div>
        )}
      </SectionCard>

      {/* What needs attention + book health */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
        <SectionCard title="Needs attention" subtitle="Book gaps and leads that have stopped moving">
          {loading ? <Sk h={200} /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <AttnBlock
                label="Unassigned customers" tone={AMBER} icon="assignment_late"
                count={attn?.unassigned_book_total ?? 0}
                hint="Customers with no account officer"
                onClick={() => navigate('/sales/book?officer_id=unassigned')}
              />
              <AttnBlock
                label="Unowned leads" tone={RED} icon="person_off"
                count={attn?.unowned_leads_total ?? attn?.unowned_leads?.length ?? 0}
                hint="Nobody can work these until they are assigned"
                onClick={() => navigate('/sales/leads?owner_id=unassigned')}
              />
              <AttnBlock
                label="Overdue follow-ups" tone={RED} icon="alarm"
                count={attn?.overdue_actions_total ?? attn?.overdue_actions?.length ?? 0}
                hint="The next action date has passed"
                onClick={() => navigate('/sales/leads?due=1')}
              />
              <AttnBlock
                label="Stalled leads" tone={BLUE} icon="pause_circle"
                count={attn?.stalled_leads_total ?? attn?.stalled_leads?.length ?? 0}
                hint="Contacted or qualified, untouched for 14 days"
                onClick={() => navigate('/sales/leads?stalled=1')}
              />
            </div>
          )}
        </SectionCard>

        <SectionCard title="Book health"
          subtitle="Freshness of the customer feed behind these numbers"
          actions={
            <button onClick={() => navigate('/admin/workers')}
              style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: RED, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
              Sync hub <span className="material-symbols-rounded" style={{ fontSize: 14 }}>arrow_forward</span>
            </button>
          }>
          {loading ? <Sk h={200} /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Feed status hero */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: RADIUS.lg, background: `${feedTone}0d`, border: `1px solid ${feedTone}33` }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, flexShrink: 0, background: `${feedTone}1f`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 22, color: feedTone }}>{!feed ? 'cloud_off' : feed.status === 'ok' ? 'cloud_done' : 'error'}</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)' }}>
                    {!feed ? 'Feed has never run' : feed.status === 'ok' ? 'Feed healthy' : `Feed status: ${feed.status}`}
                  </div>
                  <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                    {feed ? `Last run ${relTime(feed.finished_at ?? feed.started_at)} · ${fmtDatetime(feed.finished_at ?? feed.started_at)}` : 'New customers arrive in the 15-minute cust_file drops'}
                  </div>
                </div>
              </div>

              {feed && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
                  <MiniStat label="Added" value={fmtNum(feed.customers_inserted)} tone={GREEN} />
                  <MiniStat label="Updated" value={fmtNum(feed.customers_updated)} tone={BLUE} />
                  <MiniStat label="Files failed" value={fmtNum(feed.files_failed)} tone={n(feed.files_failed) > 0 ? RED : 'var(--txt3)'} />
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
                <Row label="Total customers in book" value={fmtNum(summary?.customers)} />
                <Row label="New, awaiting an officer (since 1 Aug)" value={fmtNum(attn?.unassigned_customers_total)} tone={n(attn?.unassigned_customers_total) > 0 ? AMBER : GREEN} />
                <Row label="Missing an account officer (whole book)" value={fmtNum(summary?.unassigned)} tone={n(summary?.unassigned) > 0 ? AMBER : GREEN} />
                {n(summary?.undated) > 0 && (
                  <Row label="No registration date on record" value={fmtNum(summary?.undated)} tone={AMBER} />
                )}
              </div>
            </div>
          )}
        </SectionCard>
      </div>

      {/* Recently acquired, unassigned — the concrete worklist with assignment */}
      {!loading && unassignedRows.length > 0 && (
        <SectionCard
          title="Recently acquired, unassigned"
          subtitle={`${fmtNum(unassignedTotal)} customers waiting for an account officer${unassignedRows.length < unassignedTotal ? ` · showing the ${unassignedRows.length} newest` : ''}`}
          badge={unassignedTotal}
          style={{ marginTop: 14 }}
          actions={
            <button onClick={() => navigate('/sales/book?officer_id=unassigned')}
              style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: RED, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
              Full book <span className="material-symbols-rounded" style={{ fontSize: 14 }}>arrow_forward</span>
            </button>
          }
        >
          <DataTable<UnassignedCustomer>
            cols={acqCols}
            rows={unassignedRows}
            keyFn={r => r.cif}
            emptyText="None"
            selectable={isHead}
            selectedIds={selected}
            onSelect={setSelected}
            bulkBar={isHead && selected.size > 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, width: '100%' }}>
                <span style={{ fontSize: TEXT.sm, color: 'var(--txt2)' }}>{selected.size} selected</span>
                <button
                  onClick={() => setAssignFor({ cifs: [...selected].map(String), label: `${selected.size} customers` })}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold, cursor: 'pointer' }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 15 }}>person_add</span>
                  Assign {selected.size} to a rep
                </button>
              </div>
            ) : undefined}
            onRowClick={r => navigate(`/customers/${r.cif}`)}
          />
          {!isHead && (
            <div style={{ marginTop: 8, fontSize: TEXT.xs, color: 'var(--txt3)' }}>
              Only a sales head can assign account officers.
            </div>
          )}
        </SectionCard>
      )}

      {assignFor && (
        <AssignModal
          cifs={assignFor.cifs}
          label={assignFor.label}
          onClose={() => setAssignFor(null)}
          onDone={() => { setAssignFor(null); setSelected(new Set()); load() }}
        />
      )}
    </Page>
  )
}

// ── Assign-to-rep modal ─────────────────────────────────────────────────────────
// Reused for a single row and for a bulk selection. Posts to the same head-only
// /api/sales/book/assign the Book page uses, so ownership + history stay consistent.
function AssignModal({ cifs, label, onClose, onDone }: {
  cifs: string[]; label: string; onClose: () => void; onDone: () => void
}) {
  const [officers, setOfficers] = useState<PickOfficer[]>([])
  const [officer, setOfficer] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    (async () => {
      try {
        const r = await apiFetch<{ data: PickOfficer[] }>('/api/sales/officers')
        setOfficers(r.data ?? [])
      } catch (e: any) { toast.error(e.message ?? 'Could not load officers') }
    })()
  }, [])

  async function save() {
    if (!officer) { toast.error('Pick a sales rep'); return }
    setBusy(true)
    try {
      const r = await apiPost<{ data: { assigned: number; skipped: number } }>('/api/sales/book/assign', {
        cifs, officer_id: parseInt(officer, 10), reason: reason.trim() || undefined,
      })
      const a = r.data?.assigned ?? 0
      toast.success(`Assigned ${fmtNum(a)} customer${a === 1 ? '' : 's'}`)
      onDone()
    } catch (e: any) { toast.error(e.message ?? 'Assignment failed') }
    finally { setBusy(false) }
  }

  const inp: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', boxSizing: 'border-box' }
  const lbl: React.CSSProperties = { display: 'block', fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt2)', marginBottom: 5 }

  return (
    <Modal open onClose={onClose} title="Assign to a sales rep" width={460}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: RADIUS.md, border: '1px solid var(--bdr)', background: 'var(--card)', color: 'var(--txt)', fontSize: TEXT.base, cursor: 'pointer' }}>Cancel</button>
          <button onClick={save} disabled={busy || !officer} style={{ padding: '8px 18px', borderRadius: RADIUS.md, border: 'none', background: NAVY, color: '#fff', fontSize: TEXT.base, fontWeight: FW.bold, cursor: busy ? 'wait' : 'pointer', opacity: busy || !officer ? 0.6 : 1 }}>{busy ? 'Assigning…' : 'Assign'}</button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', background: 'var(--th-bg)', borderRadius: RADIUS.md, padding: '10px 12px' }}>
          Assigning <strong style={{ color: 'var(--txt)' }}>{label}</strong>
          {cifs.length > 1 && <span> ({fmtNum(cifs.length)} customers)</span>} to the selected rep. This sets them as the account officer for the customer’s whole book.
        </div>
        <div>
          <label style={lbl}>Sales rep</label>
          <select value={officer} onChange={e => setOfficer(e.target.value)} style={inp}>
            <option value="">— Select rep —</option>
            {officers.map(o => (
              <option key={o.id} value={o.id}>
                {o.full_name}{o.book_size > 0 ? ` · ${fmtNum(o.book_size)} on book` : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={lbl}>Reason <span style={{ color: 'var(--txt3)', fontWeight: FW.normal }}>(optional)</span></label>
          <input value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. territory reassignment" style={inp} />
        </div>
      </div>
    </Modal>
  )
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div style={{ border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: '9px 11px' }}>
      <div style={{ ...NUM, fontSize: 17, fontWeight: FW.bold, color: tone }}>{value}</div>
      <div style={{ fontSize: TEXT['2xs'], color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
    </div>
  )
}

function AttnBlock({ label, count, hint, tone, icon, onClick }: {
  label: string; count: number; hint: string; tone: string; icon: string; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
        padding: `${SP[3]} ${SP[3]}`, borderRadius: RADIUS.md, cursor: 'pointer',
        background: 'transparent', border: '1px solid var(--bdr)',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--row-hvr)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 20, color: count > 0 ? tone : 'var(--txt3)' }}>{icon}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: TEXT.base, color: 'var(--txt)', fontWeight: FW.medium }}>{label}</div>
        <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{hint}</div>
      </div>
      <span style={{ ...NUM, fontSize: TEXT.lg, fontWeight: FW.bold, color: count > 0 ? tone : 'var(--txt3)' }}>
        {fmtNum(count)}
      </span>
    </button>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: TEXT.sm }}>
      <span style={{ color: 'var(--txt2)' }}>{label}</span>
      <span style={{ ...NUM, color: tone ?? 'var(--txt)', fontWeight: FW.medium }}>{value}</span>
    </div>
  )
}
