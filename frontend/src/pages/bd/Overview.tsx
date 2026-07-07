import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { Page, SectionCard, DataTable } from '../../components/UI'
import type { TableCol } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtPct, fmtDate } from '../../lib/fmt'
import { RED, AMBER, GREEN, BLUE, NAVY, MONO, SORA, NUM } from '../../lib/design'

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
      fontSize: 11.5, fontWeight: 600, padding: '2px 10px', borderRadius: 20,
      background: `${c}18`, color: c, whiteSpace: 'nowrap', textTransform: 'capitalize',
    }}>{stage}</span>
  )
}

export default function BDOverview() {
  const navigate = useNavigate()
  const [stats,   setStats]   = useState<BDStats | null>(null)
  const [leads,   setLeads]   = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    try {
      const [s, l] = await Promise.all([
        apiFetch<BDStats>('/api/bd/stats'),
        apiFetch<Lead[]>('/api/bd/leads?limit=20'),
      ])
      setStats(s)
      setLeads(l ?? [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

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
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{row.company_name ?? row.title}</div>
          <div style={{ fontSize: 11.5, color: 'var(--txt2)' }}>{row.contact_name ?? '—'}</div>
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
        ? <span style={{ ...NUM, fontSize: 12.5, fontWeight: 700, color: row.lead_score >= 70 ? GREEN : row.lead_score >= 40 ? AMBER : RED }}>{row.lead_score}</span>
        : <span style={{ color: 'var(--txt3)', fontSize: 12 }}>—</span>,
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
      render: row => <span style={{ color: 'var(--txt2)', fontSize: 12 }}>{fmtDate(row.updated_at)}</span>,
    },
  ]

  return (
    <Page
      title="Business Development"
      subtitle="Pipeline and employer overview"
      actions={
        <button
          onClick={() => navigate('/bd/employers')}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 500,
            border: '1px solid var(--bdr)', background: 'var(--card)',
            color: 'var(--txt)', cursor: 'pointer',
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 15 }}>corporate_fare</span>
          Employers
        </button>
      }
    >
      {/* Asymmetric hero */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 40, flexWrap: 'wrap', padding: '18px 0 16px', borderBottom: '1px solid var(--bdr)', marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--txt3)', marginBottom: 8, fontFamily: MONO }}>Won Deals</div>
          <div style={{ ...NUM, fontSize: 52, fontWeight: 700, color: GREEN, lineHeight: 1, marginBottom: 4 }}>
            {loading ? '—' : fmtNum(wonCount)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--txt3)', fontFamily: SORA }}>closed deals in the pipeline</div>
        </div>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', paddingLeft: 8, borderLeft: '1px solid var(--bdr)' }}>
          {[
            { label: 'Total Leads', value: loading ? '—' : fmtNum(totalLeads), color: 'var(--txt)' as string },
            { label: 'Hot Leads', value: loading ? '—' : fmtNum(hotLeads), color: RED },
            { label: 'Conversion Rate', value: loading ? '—' : fmtPct(conversionRate), color: BLUE },
          ].map(m => (
            <div key={m.label}>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--txt3)', letterSpacing: '.07em', textTransform: 'uppercase', marginBottom: 6, fontFamily: MONO }}>{m.label}</div>
              <div style={{ ...NUM, fontSize: 22, fontWeight: 700, color: m.color, lineHeight: 1 }}>{m.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
        <SectionCard title="Pipeline by Stage" subtitle="Lead count per stage">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={pipeline} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E8EBF2" vertical={false} />
              <XAxis dataKey="stage" tick={{ fontSize: 11, fill: '#9CA3AF' }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#9CA3AF' }} tickLine={false} axisLine={false} />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null
                  const d = payload[0].payload as PipelineStage
                  return (
                    <div style={{
                      background: 'var(--card)', border: '1px solid var(--bdr)',
                      borderRadius: 8, padding: '8px 12px', fontSize: 12,
                      boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                    }}>
                      <p style={{ fontWeight: 600, color: 'var(--txt)', textTransform: 'capitalize', marginBottom: 4 }}>{label}</p>
                      <p style={{ color: 'var(--txt2)', marginBottom: 2 }}>Leads: {d.count}</p>
                      <p style={{ color: 'var(--txt2)' }}>Value: {fmtKobo(d.total_value_kobo)}</p>
                    </div>
                  )
                }}
              />
              <Bar dataKey="count" name="Leads" fill={AMBER} radius={[4, 4, 0, 0]}
                label={({ x, y, width, value }) => (
                  <text x={Number(x) + Number(width) / 2} y={Number(y) - 4} textAnchor="middle"
                    style={{ fontSize: 11, fill: '#6B7280' }}>{value > 0 ? value : ''}</text>
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
                padding: '12px 14px', borderRadius: 10,
                background: `${item.color}08`,
                border: `1px solid ${item.color}18`,
              }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 9,
                  background: `${item.color}14`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <span className="material-symbols-rounded" style={{ fontSize: 18, color: item.color }}>{item.icon}</span>
                </div>
                <div>
                  <div style={{ ...NUM, fontSize: 20, fontWeight: 700, color: 'var(--txt)', lineHeight: 1 }}>{item.value}</div>
                  <div style={{ fontSize: 12, color: 'var(--txt2)', marginTop: 2 }}>{item.label}</div>
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
              fontSize: 12, fontWeight: 500, color: RED,
              background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px',
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            View all <span className="material-symbols-rounded" style={{ fontSize: 14 }}>arrow_forward</span>
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
        />
      </SectionCard>
    </Page>
  )
}
