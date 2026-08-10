import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { Page, KpiCard, SectionCard, DataTable, Sk } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct, fmtDate, fmtDatetime, n } from '../../lib/fmt'
import { RED, GREEN, BLUE, AMBER, NAVY, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// The Sales Team Lead's dashboard.
//
// This replaces a credit-origination page that read loan_applications — a table with
// zero rows — and said nothing about customer acquisition or the state of the team's
// book. It answers the four questions a lead actually opens a dashboard for: are we
// acquiring, how is each officer doing, what is in the pipeline, and what needs
// fixing today.

interface Summary {
  customers: number; mtd: number; ytd: number; prev_month: number
  unassigned: number; undated: number
  open_leads: number; qualified: number; converted_mtd: number
  overdue_actions: number; pipeline_value_kobo: number
  submitted_mtd: number; active: number; approved_mtd_kobo: number
  officers: number; mom_change_pct: number | null
}
interface AcqPoint { month: string; customers: number; confirmed: number; derived: number }
interface Officer {
  id: number; full_name: string; role: string; is_active: boolean
  book_size: number; acquired_mtd: number; acquired_ytd: number
  customers_in_arrears: number; open_leads: number; qualified_leads: number
  converted_mtd: number; overdue_actions: number
  pipeline_value_kobo: number; conversion_rate_pct: number | null
}
interface SourceRow {
  source: string; label: string; leads: number
  converted: number; disqualified: number; conversion_rate_pct: number | null
}
interface Attention {
  unassigned_customers: { cif: string; full_name: string; acquired_on: string; state: string }[]
  overdue_actions: { id: number; first_name: string; last_name: string; phone: string; lead_stage: string; next_action_at: string; owner_name: string }[]
  unowned_leads: { id: number; first_name: string; last_name: string; phone: string; lead_source: string; created_at: string }[]
  stalled_leads: { id: number; first_name: string; last_name: string; lead_stage: string; last_activity_at: string; owner_name: string }[]
  feed: { status: string; started_at: string; finished_at: string; customers_inserted: number; customers_updated: number; files_failed: number } | null
}

// ── A banner for what the numbers cannot tell you ─────────────────────────────
//
// Acquisition dates for 1,210 customers could not be established from any source, and
// no officer owns a customer until someone assigns them. Reporting those silently as
// zero is how the previous dashboard came to understate 2024 by a factor of eleven.

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

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: any[]; label?: string }) {
  if (!active || !payload?.length) return null
  const total = payload.reduce((s, p) => s + Number(p.value ?? 0), 0)
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md,
      padding: `${SP[2]} ${SP[3]}`, fontSize: TEXT.sm, boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
    }}>
      <p style={{ fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 4 }}>{label}</p>
      {payload.map((p: any, i: number) => (
        <p key={i} style={{ color: 'var(--txt2)', marginBottom: 2, display: 'flex', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color, marginTop: 5 }} />
          {p.name}: <strong style={{ color: 'var(--txt)' }}>{fmtNum(p.value)}</strong>
        </p>
      ))}
      <p style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid var(--bdr)', color: 'var(--txt)', fontWeight: FW.semibold }}>
        Total: {fmtNum(total)}
      </p>
    </div>
  )
}

export default function SalesOverview() {
  const navigate = useNavigate()
  const [summary, setSummary] = useState<Summary | null>(null)
  const [acq, setAcq] = useState<AcqPoint[]>([])
  const [officers, setOfficers] = useState<Officer[]>([])
  const [sources, setSources] = useState<SourceRow[]>([])
  const [attn, setAttn] = useState<Attention | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true); setErr(null)
      try {
        const [s, a, o, src, at] = await Promise.all([
          apiFetch<{ data: Summary }>('/api/sales/overview/summary'),
          apiFetch<{ data: AcqPoint[] }>('/api/sales/overview/acquisition?months=24'),
          apiFetch<{ data: Officer[] }>('/api/sales/overview/officers'),
          apiFetch<{ data: SourceRow[] }>('/api/sales/overview/sources'),
          apiFetch<{ data: Attention }>('/api/sales/overview/attention'),
        ])
        if (cancelled) return
        setSummary(s.data); setAcq(a.data ?? []); setOfficers(o.data ?? [])
        setSources(src.data ?? []); setAttn(at.data)
      } catch (e: any) {
        if (!cancelled) setErr(e?.message ?? 'Could not load the sales overview')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

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
            {!r.is_active && <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>inactive</div>}
          </div>
        </div>
      ),
    },
    { key: 'book_size', label: 'Book', sortable: true, align: 'right',
      render: r => <span style={NUM}>{fmtNum(r.book_size)}</span> },
    { key: 'acquired_mtd', label: 'New MTD', sortable: true, align: 'right',
      render: r => <span style={{ ...NUM, color: r.acquired_mtd > 0 ? GREEN : 'var(--txt3)' }}>{fmtNum(r.acquired_mtd)}</span> },
    { key: 'acquired_ytd', label: 'New YTD', sortable: true, align: 'right',
      render: r => <span style={NUM}>{fmtNum(r.acquired_ytd)}</span> },
    { key: 'open_leads', label: 'Open leads', sortable: true, align: 'right',
      render: r => <span style={NUM}>{fmtNum(r.open_leads)}</span> },
    { key: 'conversion_rate_pct', label: 'Conversion', sortable: true, align: 'right',
      render: r => r.conversion_rate_pct == null
        ? <span style={{ color: 'var(--txt3)' }}>—</span>
        : <span style={NUM}>{fmtPct(r.conversion_rate_pct)}</span> },
    { key: 'overdue_actions', label: 'Overdue', sortable: true, align: 'right',
      render: r => <span style={{ ...NUM, color: r.overdue_actions > 0 ? RED : 'var(--txt3)' }}>{fmtNum(r.overdue_actions)}</span> },
    { key: 'customers_in_arrears', label: 'In arrears', sortable: true, align: 'right',
      render: r => <span style={{ ...NUM, color: r.customers_in_arrears > 0 ? AMBER : 'var(--txt3)' }}>{fmtNum(r.customers_in_arrears)}</span> },
  ]

  const derivedTotal = acq.reduce((s, p) => s + n(p.derived), 0)
  const noTeam = !loading && officers.length === 0

  return (
    <Page
      title="Sales Overview"
      subtitle="Customer acquisition, team performance and book health"
      actions={
        <button
          onClick={() => navigate('/sales/leads')}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '7px 16px',
            borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.semibold,
            border: 'none', background: RED, color: '#fff', cursor: 'pointer',
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }}>person_add</span>
          New Lead
        </button>
      }
    >
      {err && (
        <div style={{ marginBottom: SP[4] }}>
          <Caveat icon="error" tone={RED}>{err}</Caveat>
        </div>
      )}

      {/* A team table with nobody in it reads as "the team sold nothing", which is a
          different and much worse claim than "nobody has been given a book yet". The
          note says which of the two it is. It is a setup step, not a fault — hence the
          neutral tone rather than the red one it used to carry. */}
      {(noTeam || n(summary?.unassigned) > 0) && !loading && (
        <div style={{ display: 'grid', gap: 10, marginBottom: SP[4] }}>
          {noTeam && (
            <Caveat icon="group_add" tone={BLUE}>
              <strong>Nobody holds a book yet.</strong> Officers appear here as soon as
              they are given customers — you can assign to any active user, so this does
              not wait on new accounts or role changes.{' '}
              <button
                onClick={() => navigate('/sales/book?officer_id=unassigned')}
                style={{ background: 'none', border: 'none', color: BLUE, cursor: 'pointer', padding: 0, font: 'inherit', fontWeight: FW.semibold }}
              >
                Assign the book →
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
                Assign them →
              </button>
            </Caveat>
          )}
        </div>
      )}

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: SP[4] }}>
        <KpiCard label="New customers MTD" value={summary ? fmtNum(summary.mtd) : '—'}
          sub={summary ? `${fmtNum(summary.prev_month)} last month` : undefined}
          change={summary?.mom_change_pct ?? undefined}
          icon="person_add" accent={GREEN} loading={loading} />
        <KpiCard label="New customers YTD" value={summary ? fmtNum(summary.ytd) : '—'}
          sub={summary ? `${fmtNum(summary.customers)} total in book` : undefined}
          icon="groups" accent={NAVY} loading={loading} />
        <KpiCard label="Open leads" value={summary ? fmtNum(summary.open_leads) : '—'}
          sub={summary ? `${fmtNum(summary.qualified)} qualified` : undefined}
          icon="filter_alt" accent={BLUE} loading={loading} />
        <KpiCard label="Overdue actions" value={summary ? fmtNum(summary.overdue_actions) : '—'}
          sub={summary ? `${fmtNum(summary.converted_mtd)} converted MTD` : undefined}
          icon="schedule" accent={summary && summary.overdue_actions > 0 ? RED : NAVY} loading={loading} />
      </div>

      {/* Acquisition trend */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
        <SectionCard
          title="Customer acquisition"
          subtitle="New customers per month, last 24 months"
          badge={derivedTotal > 0 ? `${fmtNum(derivedTotal)} derived` : undefined}
        >
          {loading ? <Sk h={240} /> : acq.length === 0 ? (
            <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
              No acquisition data
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={240}>
                {/* Stacked, not two lines: confirmed and derived are parts of one
                    monthly total, and stacking keeps the total readable while showing
                    how much of it rests on an inferred date. */}
                <BarChart data={acq} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)' }} tickLine={false} axisLine={false} width={44} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--row-hvr)' }} />
                  <Legend wrapperStyle={{ fontSize: TEXT.xs, paddingTop: 8 }} />
                  <Bar dataKey="confirmed" name="Confirmed date" stackId="a" fill={NAVY} />
                  <Bar dataKey="derived" name="Derived date" stackId="a" fill={AMBER} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 8, lineHeight: 1.5 }}>
                “Derived” means the customer record carried no creation date, so the date
                their first account opened is used instead. 18% of the book is in this
                position; without it these months would read as near-zero.
              </p>
            </>
          )}
        </SectionCard>

        <SectionCard title="Lead sources" subtitle="Where leads originate">
          {loading ? <Sk h={240} /> : sources.length === 0 ? (
            <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--txt3)', fontSize: TEXT.base }}>
              No leads yet
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {sources.slice(0, 7).map(s => (
                <div key={s.source}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: TEXT.sm, marginBottom: 3 }}>
                    <span style={{ color: 'var(--txt)' }}>{s.label}</span>
                    <span style={{ ...NUM, color: 'var(--txt2)' }}>{fmtNum(s.leads)}</span>
                  </div>
                  <div style={{ height: 6, background: 'var(--chip-bg)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: 3, background: BLUE,
                      width: `${Math.max(2, (n(s.leads) / Math.max(1, n(sources[0]?.leads))) * 100)}%`,
                    }} />
                  </div>
                  {s.conversion_rate_pct != null && (
                    <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>
                      {fmtPct(s.conversion_rate_pct)} converted
                    </div>
                  )}
                </div>
              ))}
              {sources.length === 1 && sources[0].source === 'unrecorded' && (
                <p style={{ fontSize: TEXT.xs, color: 'var(--txt3)', lineHeight: 1.5, marginTop: 4 }}>
                  Every contact predates lead-source tracking — they arrived in one Zoho
                  import. Leads created from now on carry a source, so this fills in.
                </p>
              )}
            </div>
          )}
        </SectionCard>
      </div>

      {/* Team league table */}
      <SectionCard
        title="Team performance"
        subtitle="Book size, acquisition and pipeline by officer"
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

      {/* What needs attention */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
        <SectionCard title="Needs attention" subtitle="Leads that have stopped moving">
          {loading ? <Sk h={160} /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <AttnBlock
                label="Unowned leads" tone={RED} icon="person_off"
                count={attn?.unowned_leads?.length ?? 0}
                hint="Nobody can work these until they are assigned"
                onClick={() => navigate('/sales/leads?owner_id=unassigned')}
              />
              <AttnBlock
                label="Overdue follow-ups" tone={AMBER} icon="alarm"
                count={attn?.overdue_actions?.length ?? 0}
                hint="The next action date has passed"
                onClick={() => navigate('/sales/leads?due=1')}
              />
              <AttnBlock
                label="Stalled leads" tone={BLUE} icon="pause_circle"
                count={attn?.stalled_leads?.length ?? 0}
                hint="Contacted or qualified, untouched for 14 days"
                onClick={() => navigate('/sales/leads?stage=qualified')}
              />
            </div>
          )}
        </SectionCard>

        <SectionCard title="Customer feed" subtitle="Where new customers come from">
          {loading ? <Sk h={160} /> : !attn?.feed ? (
            <div style={{ padding: SP[4] }}>
              <Caveat icon="cloud_off" tone={AMBER}>
                The customer feed has never run. New customers arrive in the 15-minute
                <code> cust_file</code> drops; until the ingest runs, the book cannot grow.
              </Caveat>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Row label="Last run" value={fmtDatetime(attn.feed.finished_at ?? attn.feed.started_at)} />
              <Row label="Status" value={attn.feed.status} tone={attn.feed.status === 'ok' ? GREEN : RED} />
              <Row label="Customers added" value={fmtNum(attn.feed.customers_inserted)} />
              <Row label="Customers updated" value={fmtNum(attn.feed.customers_updated)} />
              {n(attn.feed.files_failed) > 0 && (
                <Row label="Files failed" value={fmtNum(attn.feed.files_failed)} tone={RED} />
              )}
              {n(summary?.undated) > 0 && (
                <div style={{ marginTop: 4 }}>
                  <Caveat icon="help" tone={AMBER}>
                    {fmtNum(summary?.undated)} customers have no acquisition date from any
                    source and are excluded from the trend above.
                  </Caveat>
                </div>
              )}
            </div>
          )}
        </SectionCard>
      </div>

      {/* Recently acquired, unassigned — the concrete worklist */}
      {!loading && (attn?.unassigned_customers?.length ?? 0) > 0 && (
        <SectionCard
          title="Recently acquired, unassigned"
          subtitle="New customers waiting for an account officer"
          style={{ marginTop: 14 }}
          actions={
            <button onClick={() => navigate('/sales/book?officer_id=unassigned')}
              style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: RED, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px' }}>
              Assign →
            </button>
          }
        >
          <DataTable
            cols={[
              { key: 'cif', label: 'CIF', render: (r: any) => <span style={{ ...NUM, fontSize: TEXT.sm }}>{r.cif}</span> },
              { key: 'full_name', label: 'Customer' },
              { key: 'state', label: 'State', render: (r: any) => r.state || '—' },
              { key: 'acquired_on', label: 'Acquired', render: (r: any) => fmtDate(r.acquired_on) },
            ] as TableCol<any>[]}
            rows={attn!.unassigned_customers.slice(0, 10)}
            keyFn={(r: any) => r.cif}
            emptyText="None"
            onRowClick={(r: any) => navigate(`/customers/${r.cif}`)}
          />
        </SectionCard>
      )}
    </Page>
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
      <span style={{ color: tone ?? 'var(--txt)', fontWeight: FW.medium }}>{value}</span>
    </div>
  )
}
