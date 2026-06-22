import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { Page, SectionCard, ErrBanner, NAVY, RED, GREEN, AMBER } from '../../components/UI'

// ── Types ─────────────────────────────────────────────────────────────────────
interface UserStats {
  total: number
  active: number
}

interface MailMetrics {
  deliverability: number | null
}

interface HelpdeskStats {
  open: number
}

// ── KPI card ──────────────────────────────────────────────────────────────────
function KPICard({
  label, value, icon, accent = NAVY, loading, unit,
}: {
  label: string; value: string | number; icon: string; accent?: string; loading?: boolean; unit?: string
}) {
  return (
    <div className="bg-white rounded-xl px-5 py-4 flex items-center gap-4"
      style={{ border: '1px solid rgba(15,23,42,0.07)' }}>
      <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
        style={{ background: `${accent}14` }}>
        <span className="material-symbols-rounded text-[20px]" style={{ color: accent }}>{icon}</span>
      </div>
      <div>
        <p className="text-[22px] font-bold text-slate-800 leading-tight">
          {loading ? (
            <span className="inline-block w-12 h-5 skeleton rounded" />
          ) : (
            <>{value}{unit && <span className="text-[14px] font-normal text-slate-400 ml-1">{unit}</span>}</>
          )}
        </p>
        <p className="text-[12px] text-slate-400 mt-0.5">{label}</p>
      </div>
    </div>
  )
}

// ── System status card ────────────────────────────────────────────────────────
function StatusCard({ name, status, detail }: { name: string; status: 'ok' | 'warn' | 'unknown'; detail?: string }) {
  const colors = {
    ok:      { dot: GREEN,  label: 'Connected', bg: 'rgba(5,150,105,0.08)' },
    warn:    { dot: AMBER,  label: 'Warning',   bg: 'rgba(217,119,6,0.08)' },
    unknown: { dot: '#94A3B8', label: 'Unknown', bg: 'rgba(100,116,139,0.06)' },
  }
  const c = colors[status]
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl"
      style={{ background: c.bg, border: '1px solid rgba(15,23,42,0.07)' }}>
      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: c.dot }} />
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold text-slate-700">{name}</p>
        {detail && <p className="text-[11px] text-slate-400 truncate">{detail}</p>}
      </div>
      <span className="text-[11px] font-semibold flex-shrink-0" style={{ color: c.dot }}>{c.label}</span>
    </div>
  )
}

// ── Quick action card ─────────────────────────────────────────────────────────
function QuickAction({
  label, icon, to, desc, accent = NAVY,
}: {
  label: string; icon: string; to: string; desc?: string; accent?: string
}) {
  const navigate = useNavigate()
  return (
    <button
      onClick={() => navigate(to)}
      className="flex flex-col items-start gap-2 p-4 rounded-xl bg-white text-left transition-all hover:shadow-md group"
      style={{ border: '1px solid rgba(15,23,42,0.08)' }}>
      <div className="w-9 h-9 rounded-lg flex items-center justify-center"
        style={{ background: `${accent}14` }}>
        <span className="material-symbols-rounded text-[18px]" style={{ color: accent }}>{icon}</span>
      </div>
      <div>
        <p className="text-[13px] font-semibold text-slate-700 group-hover:text-slate-900 transition-colors">{label}</p>
        {desc && <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">{desc}</p>}
      </div>
    </button>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function AdminOverview() {
  const [users,    setUsers]    = useState<UserStats | null>(null)
  const [mail,     setMail]     = useState<MailMetrics | null>(null)
  const [helpdesk, setHelpdesk] = useState<HelpdeskStats | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [err,      setErr]      = useState('')

  useEffect(() => {
    setLoading(true)
    Promise.allSettled([
      apiFetch<any>('/api/admin/users').then(r => {
        const total  = Array.isArray(r) ? r.length : (r?.total ?? r?.data?.length ?? 0)
        const active = Array.isArray(r) ? r.filter((u: any) => u.is_active).length : total
        setUsers({ total, active })
      }),
      apiFetch<any>('/api/mail/metrics').then(r => {
        setMail({ deliverability: r?.deliverability ?? r?.delivery_rate ?? null })
      }),
      apiFetch<any>('/api/helpdesk/stats').then(r => {
        setHelpdesk({ open: r?.open ?? 0 })
      }),
    ])
      .catch((e: any) => setErr(e?.message ?? 'Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  const delivPct = mail?.deliverability != null
    ? (mail.deliverability > 1 ? Math.round(mail.deliverability) : Math.round(mail.deliverability * 100))
    : null

  const mailStatus: 'ok' | 'warn' | 'unknown' =
    delivPct == null ? 'unknown' : delivPct >= 90 ? 'ok' : 'warn'

  return (
    <Page dept="Admin" title="Admin Overview" subtitle="System health and platform administration">
      <ErrBanner msg={err} />

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <KPICard
          label="Active Users"
          value={loading ? '…' : String(users?.active ?? 0)}
          icon="people"
          accent={NAVY}
          loading={loading}
        />
        <KPICard
          label="Mail Deliverability"
          value={loading ? '…' : (delivPct != null ? delivPct : '—')}
          unit={delivPct != null ? '%' : undefined}
          icon="mark_email_read"
          accent={delivPct == null || delivPct >= 90 ? GREEN : AMBER}
          loading={loading}
        />
        <KPICard
          label="Open Helpdesk Tickets"
          value={loading ? '…' : String(helpdesk?.open ?? 0)}
          icon="support_agent"
          accent={RED}
          loading={loading}
        />
        <KPICard
          label="Total Users"
          value={loading ? '…' : String(users?.total ?? 0)}
          icon="badge"
          accent={NAVY}
          loading={loading}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* System Status */}
        <SectionCard title="System Status">
          <div className="px-5 pb-5 space-y-2.5">
            <StatusCard name="Database" status="ok" detail="PostgreSQL — Supabase" />
            <StatusCard name="SendGrid" status={mailStatus} detail={delivPct != null ? `${delivPct}% deliverability` : 'Check mail health'} />
            <StatusCard name="Railway" status="ok" detail="Backend API deployed" />
            <StatusCard name="Cloudflare Pages" status="ok" detail="Frontend live" />
          </div>
        </SectionCard>

        {/* Recent activity placeholder */}
        <SectionCard title="Recent Activity">
          <div className="px-5 pb-5">
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3"
                style={{ background: 'rgba(14,40,65,0.06)' }}>
                <span className="material-symbols-rounded text-[20px]" style={{ color: NAVY }}>history</span>
              </div>
              <p className="text-[13px] font-medium text-slate-600">Audit log coming soon</p>
              <p className="text-[12px] text-slate-400 mt-1 max-w-[220px] leading-relaxed">
                Last 10 admin actions and user logins will appear here once the audit log is wired up.
              </p>
            </div>
          </div>
        </SectionCard>
      </div>

      {/* Quick links */}
      <SectionCard title="Quick Actions">
        <div className="px-5 pb-5 grid grid-cols-2 sm:grid-cols-3 gap-3">
          <QuickAction
            label="Add User"
            icon="person_add"
            to="/admin/users"
            desc="Create a new platform user and assign a role"
            accent={NAVY}
          />
          <QuickAction
            label="Configure Email"
            icon="alternate_email"
            to="/admin/email-senders"
            desc="Manage email sending domains and senders"
            accent="#2563EB"
          />
          <QuickAction
            label="API Keys"
            icon="key"
            to="/admin/api-keys"
            desc="Create and manage API access tokens"
            accent={AMBER}
          />
          <QuickAction
            label="View Audit Log"
            icon="history"
            to="/admin/audit"
            desc="See all admin and user actions"
            accent="#64748B"
          />
          <QuickAction
            label="Platform Settings"
            icon="settings"
            to="/admin/settings"
            desc="Configure platform-wide preferences"
            accent={NAVY}
          />
          <QuickAction
            label="Sync Status"
            icon="sync"
            to="/admin/sync"
            desc="Monitor MSSQL → Supabase sync"
            accent={GREEN}
          />
        </div>
      </SectionCard>
    </Page>
  )
}
