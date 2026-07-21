import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Page, SectionCard, ErrBanner, Spinner } from '../../components/UI'
import { apiFetch } from '../../lib/api'
import { fmtKobo, fmtNum, fmtDatetime } from '../../lib/fmt'
import { NAVY, GREEN, AMBER, RED, BLUE, SORA, NUM, TEXT, FW, SP, RADIUS } from '../../lib/design'

// ── Types ─────────────────────────────────────────────────────────────────────

interface KPI {
  open_tickets:    number
  my_applications: number
  my_leads:        number
  my_queue:        number
}

interface Ticket {
  id: number; ref: string; subject: string; status: string; priority: string; created_at: string
}
interface Application {
  id: number; reference: string; applicant_name: string; stage: string; status: string; amount_requested_kobo: number; created_at: string
}
interface Lead {
  id: number; title: string; stage: string; potential_value_kobo: number; created_at: string
}
interface CollRow {
  id: number; account_cif: string; customer_name: string; dpd: number; status: string
}
interface ActivityRow {
  page: string; action: string; detail: string; ts: string
}
interface DashboardData {
  user_id: number
  full_name: string
  role: string
  kpi: KPI
  tickets: Ticket[]
  applications: Application[]
  leads: Lead[]
  collections: CollRow[]
  activity: ActivityRow[]
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function priorityColor(p: string) {
  if (p === 'urgent') return RED
  if (p === 'high') return AMBER
  return NAVY
}

function stageChip(stage: string) {
  const s = stage.toLowerCase().replace(/_/g, ' ')
  const done = ['won', 'closed', 'active', 'disbursed']
  const bad  = ['lost', 'rejected', 'cancelled']
  const color = done.some(d => s.includes(d)) ? GREEN : bad.some(b => s.includes(b)) ? RED : NAVY
  return (
    <span style={{
      fontSize: TEXT.xs, fontWeight: FW.semibold, padding: '2px 8px',
      borderRadius: RADIUS.full, background: `${color}18`, color,
    }}>
      {s.replace(/\b\w/g, c => c.toUpperCase())}
    </span>
  )
}

// ── KPI Card ───────────────────────────────────────────────────────────────────

function KpiCard({ label, value, icon, accent, onClick }: {
  label: string; value: number; icon: string; accent: string; onClick?: () => void
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--card)', borderRadius: RADIUS.xl, padding: '16px 18px',
        border: '1px solid var(--bdr)', borderTop: `3px solid ${accent}`,
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span className="material-symbols-rounded" style={{ fontSize: 20, color: accent }}>{icon}</span>
        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>{label}</span>
      </div>
      <div style={{ ...NUM, fontSize: TEXT['2xl'], fontWeight: FW.bold, color: 'var(--txt)' }}>{fmtNum(value)}</div>
    </div>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────────

export default function MeDashboard() {
  const navigate = useNavigate()

  const [data,    setData]    = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState<string | null>(null)

  useEffect(() => {
    setLoading(true); setErr(null)
    apiFetch<{ data: DashboardData }>('/api/me/dashboard')
      .then(r => setData(r.data))
      .catch((e: any) => setErr(e.message ?? 'Failed to load dashboard'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <Page title="My Dashboard" subtitle="Your personal workspace">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: 10, color: 'var(--txt2)' }}>
          <Spinner size={18} color={NAVY} /> Loading your dashboard…
        </div>
      </Page>
    )
  }

  return (
    <Page
      title={data ? `Good work, ${data.full_name.split(' ')[0]}` : 'My Dashboard'}
      subtitle={data ? `${data.role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} — your personal workspace` : 'Your personal workspace'}
    >
      <ErrBanner error={err} />

      {data && (
        <>
          {/* KPI strip */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: SP[3], marginBottom: SP[4] }}>
            <KpiCard label="Open Tickets"    value={data.kpi.open_tickets}    icon="confirmation_number" accent={AMBER} onClick={() => navigate('/helpdesk')} />
            <KpiCard label="My Applications" value={data.kpi.my_applications} icon="description"         accent={BLUE}  onClick={() => navigate('/sales/applications')} />
            <KpiCard label="My BD Leads"     value={data.kpi.my_leads}        icon="pipeline"            accent={GREEN} onClick={() => navigate('/bd/pipeline')} />
            <KpiCard label="Collections Queue" value={data.kpi.my_queue}      icon="account_balance"     accent={RED}   onClick={() => navigate('/collections-ops/agent')} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3], marginBottom: SP[3] }}>
            {/* My tickets */}
            <SectionCard title="My Open Tickets" badge={data.tickets.length}>
              {data.tickets.length === 0 ? (
                <EmptyState icon="check_circle" text="No open tickets assigned to you" />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {data.tickets.map(t => (
                    <div
                      key={t.id}
                      onClick={() => navigate(`/helpdesk/${t.id}`)}
                      style={{ padding: '8px 10px', borderRadius: RADIUS.lg, border: '1px solid var(--bdr)', cursor: 'pointer', background: 'var(--card)' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <span style={{ fontSize: TEXT.xs, fontFamily: 'monospace', color: 'var(--txt3)' }}>{t.ref}</span>
                        <span style={{ fontSize: TEXT.xs, fontWeight: FW.bold, color: priorityColor(t.priority) }}>{t.priority}</span>
                      </div>
                      <div style={{ fontSize: TEXT.sm, fontWeight: FW.medium, color: 'var(--txt)', marginTop: 2, fontFamily: SORA }}>{t.subject}</div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center' }}>
                        {stageChip(t.status)}
                        <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)' }}>{fmtDatetime(t.created_at)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>

            {/* My applications */}
            <SectionCard title="My Applications" badge={data.applications.length}>
              {data.applications.length === 0 ? (
                <EmptyState icon="description" text="No applications assigned to you" />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {data.applications.map(a => (
                    <div
                      key={a.id}
                      onClick={() => navigate(`/sales/applications/${a.id}`)}
                      style={{ padding: '8px 10px', borderRadius: RADIUS.lg, border: '1px solid var(--bdr)', cursor: 'pointer', background: 'var(--card)' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: SORA }}>{a.applicant_name}</span>
                        <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: NAVY }}>{fmtKobo(a.amount_requested_kobo)}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center' }}>
                        {stageChip(a.stage)}
                        <span style={{ fontSize: TEXT.xs, color: 'var(--txt3)', fontFamily: 'monospace' }}>{a.reference}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP[3], marginBottom: SP[3] }}>
            {/* My BD leads */}
            <SectionCard title="My Active Leads" badge={data.leads.length}>
              {data.leads.length === 0 ? (
                <EmptyState icon="pipeline" text="No active BD leads assigned to you" />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {data.leads.map(l => (
                    <div
                      key={l.id}
                      onClick={() => navigate('/bd/pipeline')}
                      style={{ padding: '8px 10px', borderRadius: RADIUS.lg, border: '1px solid var(--bdr)', cursor: 'pointer', background: 'var(--card)' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: SORA }}>{l.title}</span>
                        <span style={{ ...NUM, fontSize: TEXT.sm, fontWeight: FW.bold, color: GREEN }}>{fmtKobo(l.potential_value_kobo)}</span>
                      </div>
                      <div style={{ marginTop: 4 }}>{stageChip(l.stage)}</div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>

            {/* Collections queue */}
            <SectionCard title="My Collections Queue" badge={data.collections.length}>
              {data.collections.length === 0 ? (
                <EmptyState icon="account_balance" text="Your collections queue is empty" />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {data.collections.map(c => (
                    <div
                      key={c.id}
                      onClick={() => navigate('/collections-ops/agent')}
                      style={{ padding: '8px 10px', borderRadius: RADIUS.lg, border: '1px solid var(--bdr)', cursor: 'pointer', background: 'var(--card)' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', fontFamily: SORA }}>{c.customer_name}</span>
                        <span style={{ ...NUM, fontWeight: FW.bold, fontSize: TEXT.sm, color: c.dpd > 30 ? RED : c.dpd > 0 ? AMBER : GREEN }}>
                          {c.dpd} DPD
                        </span>
                      </div>
                      <div style={{ fontSize: TEXT.xs, fontFamily: 'monospace', color: 'var(--txt3)', marginTop: 2 }}>{c.account_cif}</div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>

          {/* Activity feed */}
          <SectionCard title="My Recent Activity" badge={data.activity.length}>
            {data.activity.length === 0 ? (
              <EmptyState icon="history" text="No recent activity recorded" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {data.activity.map((a, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex', gap: 12, padding: '10px 0',
                      borderBottom: i < data.activity.length - 1 ? '1px solid var(--bdr)' : 'none',
                    }}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 18, color: NAVY, flexShrink: 0, marginTop: 1 }}>
                      {a.action === 'view' ? 'visibility' : a.action === 'create' ? 'add_circle' : a.action === 'update' ? 'edit' : 'history'}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', textTransform: 'capitalize' }}>{a.action}</span>
                        <span style={{ fontSize: TEXT.xs, fontWeight: FW.semibold, color: NAVY, background: `${NAVY}12`, padding: '1px 6px', borderRadius: 4 }}>{a.page}</span>
                        {a.detail && <span style={{ fontSize: TEXT.xs, color: 'var(--txt2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 280 }}>{a.detail}</span>}
                      </div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', marginTop: 2 }}>{fmtDatetime(a.ts)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </>
      )}
    </Page>
  )
}

function EmptyState({ icon, text }: { icon: string; text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 0', color: 'var(--txt3)' }}>
      <span className="material-symbols-rounded" style={{ fontSize: 20 }}>{icon}</span>
      <span style={{ fontSize: TEXT.sm }}>{text}</span>
    </div>
  )
}
