import { useLiveData } from "../../hooks/useRealtime"
import { useEffect, useState, useCallback } from 'react'
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { Page, SectionCard, KpiCard, DataTable, ErrBanner, Spinner } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtNum, fmtDate } from '../../lib/fmt'
import { RED, AMBER, BLUE, GREEN, NAVY, NUM, TEXT, FW, RADIUS, SP } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface MyTicket {
  id: number; ticket_ref: string; subject: string
  customer_name: string; priority: string; status: string
  created_at: string; sla_breach_at: string | null
}

interface HelpdeskAgentDash {
  open_tickets: number; resolved_today: number
  avg_handle_time_mins: number; csat_score: number
  sla_compliance_pct: number; escalations: number
  my_tickets: MyTicket[]
  csat_trend: { date: string; score: number }[]
  handle_time_by_type: { type: string; avg_mins: number }[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatusPill({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px', borderRadius: RADIUS['2xl'], background: `${color}18`, color, whiteSpace: 'nowrap', textTransform: 'capitalize' }}>
      {label}
    </span>
  )
}

const PRIORITY_COLOR: Record<string, string> = {
  high: RED, medium: AMBER, low: BLUE, urgent: RED, normal: 'var(--chart-lbl)',
}

function csatColor(s: number) { return s >= 4.5 ? GREEN : s >= 3.5 ? AMBER : RED }

function SlaCell({ sla_breach_at }: { sla_breach_at: string | null }) {
  if (!sla_breach_at) return <span style={{ color: 'var(--txt3)' }}>—</span>
  const ms = new Date(sla_breach_at).getTime() - Date.now()
  if (ms < 0) return <StatusPill label="Breached" color={RED} />
  const hrs = ms / 3_600_000
  const color = hrs < 2 ? RED : hrs < 6 ? AMBER : GREEN
  const mins = Math.floor(ms / 60_000)
  const label = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`
  return <span style={{ color, fontWeight: FW.semibold, fontSize: TEXT.xs }}>{label}</span>
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, padding: `${SP[2]} ${SP[3]}`, fontSize: TEXT.sm }}>
      <p style={{ fontWeight: FW.semibold, color: 'var(--txt)', marginBottom: 4 }}>{label}</p>
      {payload.map((p: any, i: number) => (
        <p key={i} style={{ color: p.color, marginBottom: 2 }}>{p.name}: {p.value}</p>
      ))}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function HelpdeskMyDashboard() {
  const [data, setData] = useState<HelpdeskAgentDash | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await apiFetch<any>('/api/helpdesk/my-dashboard')
      const d = r?.data ?? r ?? {}
      // Default fields the backend may omit so the dashboard never crashes.
      setData({ ...d, my_tickets: d.my_tickets ?? [], csat_score: d.csat_score ?? 0 })
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])
  useLiveData(load, { topics: ['tickets'] })

  if (loading) return (
    <Page title="My Helpdesk Dashboard" back={{ label: 'Helpdesk', to: '/helpdesk/tickets' }}>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}><Spinner size={32} /></div>
    </Page>
  )
  if (error) return (
    <Page title="My Helpdesk Dashboard" back={{ label: 'Helpdesk', to: '/helpdesk/tickets' }}>
      <ErrBanner error={error} onRetry={load} />
    </Page>
  )
  if (!data) return null

  const csatC = csatColor(data.csat_score)

  const ticketCols: TableCol<MyTicket>[] = [
    { key: 'ticket_ref', label: 'Ref', render: r => <span style={{ fontFamily: 'var(--font-mono)', fontSize: TEXT.xs }}>{r.ticket_ref}</span> },
    { key: 'subject', label: 'Subject', render: r => (
      <div style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.subject}</div>
    )},
    { key: 'customer_name', label: 'Customer' },
    { key: 'priority', label: 'Priority', render: r => <StatusPill label={r.priority} color={PRIORITY_COLOR[r.priority?.toLowerCase()] ?? NAVY} /> },
    { key: 'status', label: 'Status', render: r => <StatusPill label={r.status} color={NAVY} /> },
    { key: 'sla_breach_at', label: 'SLA', render: r => <SlaCell sla_breach_at={r.sla_breach_at} /> },
  ]

  return (
    <Page title="My Helpdesk Dashboard" subtitle="Your ticket queue, CSAT and handle times" back={{ label: 'Helpdesk', to: '/helpdesk/tickets' }}>
      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: SP[3], marginBottom: 14 }}>
        <KpiCard label="Open Tickets" value={fmtNum(data.open_tickets)} icon="confirmation_number" />
        <KpiCard label="Resolved Today" value={fmtNum(data.resolved_today)} icon="check_circle" accent={GREEN} />
        <KpiCard label="Avg Handle Time" value={`${data.avg_handle_time_mins}m`} icon="timer" accent={AMBER} />
        <KpiCard label="My CSAT Score" value={data.csat_score.toFixed(1)} icon="star" accent={csatC} sub="/ 5.0" />
      </div>

      {/* Ticket queue */}
      <SectionCard title="My Ticket Queue" badge={data.my_tickets.length} style={{ marginBottom: 14 }}>
        <DataTable
          cols={ticketCols}
          rows={data.my_tickets}
          keyFn={r => r.id}
          searchKeys={['ticket_ref', 'subject', 'customer_name', 'priority', 'status']}
          searchPlaceholder="Search tickets…"
          pageSize={10}
          emptyText="No open tickets"
        />
      </SectionCard>

      {/* Charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3] }}>
        <SectionCard title="CSAT Trend (14 days)">
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={data.csat_trend} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="csatGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={GREEN} stopOpacity={0.2} />
                  <stop offset="95%" stopColor={GREEN} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
              <XAxis dataKey="date" tickFormatter={d => fmtDate(d)} tick={{ fontSize: 10, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 5]} tick={{ fontSize: 10, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="score" name="CSAT" stroke={GREEN} fill="url(#csatGrad)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </SectionCard>

        <SectionCard title="Avg Handle Time by Type">
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={data.handle_time_by_type} layout="vertical" margin={{ top: 4, right: 20, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} unit="m" />
              <YAxis dataKey="type" type="category" tick={{ fontSize: 10, fill: 'var(--chart-lbl)' }} axisLine={false} tickLine={false} width={90} />
              <Tooltip content={<ChartTooltip />} />
              <Bar dataKey="avg_mins" name="Avg mins" fill={NAVY} radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>
      </div>
    </Page>
  )
}
