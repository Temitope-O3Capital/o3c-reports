import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { Page, KpiCard, SectionCard, DataTable, DateFilter } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct, fmtDate, monthStart, today } from '../../lib/fmt'
import { RED, AMBER, GREEN, BLUE, NAVY, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

interface PipelineStage { stage: string; count: number; total_value_kobo: number }
interface EmployerStats { active: number; mou_signed: number; mou_expiring: number }
interface BDStats { pipeline: PipelineStage[]; employers: EmployerStats }

interface Lead {
  id: number; title: string; company_name: string; stage: string
  potential_value_kobo: number; contact_name: string; assigned_name: string; updated_at: string
  lead_score?: number | null
}

const STAGE_COLORS: Record<string, string> = {
  prospect: '#6B7280', qualified: BLUE, proposal: AMBER,
  negotiation: '#7C3AED', won: GREEN, lost: RED,
}

function StagePill({ stage }: { stage: string }) {
  const c = STAGE_COLORS[stage] ?? '#6B7280'
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 10px', borderRadius: RADIUS['2xl'],
      background: `${c}18`, color: c, whiteSpace: 'nowrap', textTransform: 'capitalize',
    }}>{stage}</span>
  )
}

export default function BDOverview() {
  const navigate = useNavigate()
  const [stats,    setStats]   = useState<BDStats | null>(null)
  const [leads,    setLeads]   = useState<Lead[]>([])
  const [loading,  setLoading] = useState(true)
  const [dateFrom, setDateFrom] = useState(monthStart())
  const [dateTo,   setDateTo]   = useState(today())

  async function load(from: string, to: string) {
    setLoading(true)
    try {
      const [s, l] = await Promise.all([
        apiFetch<{ data: BDStats }>(`/api/bd/stats?from=${from}&to=${to}`),
        apiFetch<{ data: Lead[] }>(`/api/bd/leads?limit=20&from=${from}&to=${to}`),
      ])
      setStats(s.data ?? null)
      setLeads(l.data ?? [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(dateFrom, dateTo) }, [dateFrom, dateTo])

  const pipeline = stats?.pipeline ?? []
  const totalLeads     = pipeline.reduce((s, r) => s + Number(r.count ?? 0), 0)
  const hotLeads       = pipeline.find(r => r.stage === 'negotiation')?.count ?? 0
  const wonCount       = pipeline.find(r => r.stage === 'won')?.count ?? 0
  const lostCount      = pipeline.find(r => r.stage === 'lost')?.count ?? 0
  const conversionRate = (wonCount + lostCount) > 0 ? wonCount / (wonCount + lostCount) * 100 : 0

  const cols: TableCol<Lead>[] = [
    {
      key: 'company_name', label: 'Company', sortable: true,
      render: row => (
        <div>
          <div style={{ fontSize: TEXT.base, fontWeight: FW.medium, color: 'var(--txt)' }}>{row.company_name ?? row.title}</div>
          <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>{row.contact_name ?? '—'}</div>
        </div>
      ),
    },
    {
      key: 'stage', label: 'Stage', sortable: true,
      render: row => <StagePill stage={row.stage} />,
    },
    {
      key: 'lead_score', label: 'Score', sortable: true, align: 'right',
      render: row => row.lead_score != null
        ? <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: row.lead_score >= 70 ? GREEN : row.lead_score >= 40 ? AMBER : RED }}>{row.lead_score}</span>
        : <span style={{ color: 'var(--txt3)', fontSize: TEXT.sm }}>—</span>,
    },
    {
      key: 'potential_value_kobo', label: 'Est. Value', sortable: true, align: 'right',
      render: row => <span style={NUM}>{fmtKobo(row.potential_value_kobo)}</span>,
    },
    {
      key: 'assigned_name', label: 'Officer', sortable: true,
      render: row => <span style={{ color: 'var(--txt2)' }}>{row.assigned_name ?? '—'}</span>,
    },
    {
      key: 'updated_at', label: 'Last Updated', sortable: true,
      render: row => <span style={{ color: 'var(--txt2)', fontSize: TEXT.sm }}>{fmtDate(row.updated_at)}</span>,
    },
  ]

  return (
    <Page
      title="Business Development"
      subtitle="Pipeline and employer overview"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DateFilter from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t) }} align="right" />
          <button
            onClick={() => navigate('/bd/employers')}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', borderRadius: RADIUS.md, fontSize: TEXT.base, fontWeight: FW.medium,
              border: '1px solid var(--bdr)', background: 'var(--card)',
              color: 'var(--txt)', cursor: 'pointer',
            }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 15 }}>corporate_fare</span>
            Employers
          </button>
        </div>
      }
    >
      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: SP[4] }}>
        <KpiCard label="Total Leads"     value={fmtNum(totalLeads)}        icon="contacts"      accent={NAVY}  loading={loading} />
        <KpiCard label="Hot Leads"       value={fmtNum(hotLeads)}          icon="local_fire_department" accent={RED}   loading={loading} />
        <KpiCard label="Won Deals"       value={fmtNum(wonCount)}          icon="handshake"     accent={GREEN} loading={loading} />
        <KpiCard label="Conversion Rate" value={fmtPct(conversionRate)}    icon="trending_up"   accent={BLUE}  loading={loading} />
      </div>

      {/* Charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
        <SectionCard title="Pipeline by Stage" subtitle="Lead count per stage">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={pipeline} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
              <XAxis dataKey="stage" tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)' }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: TEXT.xs, fill: 'var(--chart-lbl)' }} tickLine={false} axisLine={false} />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null
                  const d = payload[0].payload as PipelineStage
                  return (
                    <div style={{
                      background: 'var(--card)', border: '1px solid var(--bdr)',
                      borderRadius: RADIUS.md, padding: `${SP[2]} ${SP[3]}`, fontSize: TEXT.sm,
                      boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                    }}>
                      <p style={{ fontWeight: FW.semibold, color: 'var(--txt)', textTransform: 'capitalize', marginBottom: 4 }}>{label}</p>
                      <p style={{ color: 'var(--txt2)', marginBottom: 2 }}>Leads: {d.count}</p>
                      <p style={{ color: 'var(--txt2)' }}>Value: {fmtKobo(d.total_value_kobo)}</p>
                    </div>
                  )
                }}
              />
              <Bar dataKey="count" name="Leads" fill={AMBER} radius={[4, 4, 0, 0]}
                label={({ x, y, width, value }) => (
                  <text x={Number(x) + Number(width) / 2} y={Number(y) - 4} textAnchor="middle"
                    style={{ fontSize: TEXT.xs, fill: '#6B7280' }}>{value > 0 ? value : ''}</text>
                )}
              />
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>

        {/* Employer stats */}
        <SectionCard title="Employer Partners" subtitle="MOU status">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '8px 0' }}>
            {[
              { label: 'Active Employers',  value: stats?.employers?.active ?? 0,       icon: 'corporate_fare', color: NAVY },
              { label: 'MOU Signed',        value: stats?.employers?.mou_signed ?? 0,   icon: 'handshake',      color: GREEN },
              { label: 'MOU Expiring',      value: stats?.employers?.mou_expiring ?? 0, icon: 'warning',        color: AMBER },
            ].map(item => (
              <div key={item.label} style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: `${SP[3]} 14px`, borderRadius: RADIUS.lg,
                background: `${item.color}08`,
                border: `1px solid ${item.color}18`,
              }}>
                <div style={{
                  width: 36, height: 36, borderRadius: RADIUS.md,
                  background: `${item.color}14`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <span className="material-symbols-rounded" style={{ fontSize: TEXT.xl, color: item.color }}>{item.icon}</span>
                </div>
                <div>
                  <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color: 'var(--txt)', lineHeight: 1 }}>{item.value}</div>
                  <div style={{ fontSize: TEXT.sm, color: 'var(--txt2)', marginTop: 2 }}>{item.label}</div>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      {/* Recent leads table */}
      <SectionCard
        title="Recent Leads"
        subtitle="Latest pipeline activity"
        actions={
          <button
            onClick={() => navigate('/bd/pipeline')}
            style={{
              fontSize: TEXT.sm, fontWeight: FW.medium, color: RED,
              background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px',
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            View all <span className="material-symbols-rounded" style={{ fontSize: TEXT.md }}>arrow_forward</span>
          </button>
        }
      >
        <DataTable<Lead>
          cols={cols}
          rows={leads}
          loading={loading}
          skeletonRows={5}
          emptyText="No leads yet — add your first lead"
          keyFn={r => r.id}
          onRowClick={() => navigate('/bd/pipeline')}
          searchKeys={['company_name', 'contact_name', 'stage']}
          searchPlaceholder="Search leads…"
        />
      </SectionCard>
    </Page>
  )
}
