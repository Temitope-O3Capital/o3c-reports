import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { fmtDate } from '../../lib/fmt'
import { Page, SectionCard, KpiCard, ErrBanner, Spinner, StatusBadge, NAVY, GREEN, AMBER, RED } from '../../components/UI'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Campaign {
  id: number
  name: string
  type: string
  status: string
  total_contacts: number
  emails_sent: number
  emails_opened: number
  sms_sent: number
  sms_delivered: number
  created_at: string
  list_name?: string | null
}

interface CampaignListResponse {
  total: number
  campaigns: Campaign[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function TypePill({ type }: { type: string }) {
  const styles: Record<string, { bg: string; color: string; label: string }> = {
    sms:   { bg: 'rgba(37,99,235,0.1)',  color: '#2563EB', label: 'SMS' },
    email: { bg: 'rgba(22,101,52,0.1)',  color: '#166534', label: 'Email' },
    multi: { bg: 'rgba(14,40,65,0.1)',   color: '#0E2841', label: 'Multi' },
  }
  const s = styles[type?.toLowerCase()] ?? { bg: 'rgba(100,116,139,0.1)', color: '#64748B', label: type ?? '—' }
  return (
    <span
      className="inline-flex items-center text-[11px] font-semibold px-2.5 py-0.5 rounded-full"
      style={{ background: s.bg, color: s.color }}
    >
      {s.label}
    </span>
  )
}

function openRate(c: Campaign): string {
  if (!c.emails_sent || c.emails_sent === 0) return '—'
  return `${((c.emails_opened / c.emails_sent) * 100).toFixed(1)}%`
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function CampaignsOverview() {
  const navigate = useNavigate()
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    setLoading(true)
    setErr('')
    apiFetch<CampaignListResponse>('/api/campaigns?limit=100')
      .then(res => setCampaigns(res.campaigns ?? []))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [])

  // Derived KPIs
  const totalCampaigns = campaigns.length
  const activeCampaigns = campaigns.filter(c => c.status === 'active').length

  const completedThisMonth = (() => {
    const now = new Date()
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    return campaigns.filter(c => c.status === 'completed' && c.created_at?.startsWith(thisMonth)).length
  })()

  const avgOpenRate = (() => {
    const emailCampaigns = campaigns.filter(c => c.emails_sent > 0)
    if (emailCampaigns.length === 0) return null
    const totalSent   = emailCampaigns.reduce((s, c) => s + c.emails_sent,   0)
    const totalOpened = emailCampaigns.reduce((s, c) => s + c.emails_opened, 0)
    return totalSent > 0 ? ((totalOpened / totalSent) * 100).toFixed(1) : null
  })()

  const totalSent = campaigns.reduce((s, c) => s + (c.emails_sent ?? 0) + (c.sms_sent ?? 0), 0)

  // Recent 8 campaigns
  const recentCampaigns = [...campaigns]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 8)

  return (
    <Page
      dept="Campaigns"
      title="Campaigns"
      subtitle="Reach your customers at scale"
      actions={
        <button
          onClick={() => navigate('/campaigns/new')}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-semibold text-white"
          style={{ background: NAVY }}
        >
          <span className="material-symbols-rounded text-[16px]">add</span>
          New Campaign
        </button>
      }
    >
      <ErrBanner msg={err} />

      {/* ── KPI cards ── */}
      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 bg-white rounded-2xl border animate-pulse" style={{ borderColor: 'rgba(15,23,42,0.07)' }} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
          <KpiCard label="Total Campaigns"   value={String(totalCampaigns)}                                icon="campaign"      accent={NAVY}  />
          <KpiCard label="Active"             value={String(activeCampaigns)}                              icon="play_circle"   accent={GREEN} />
          <KpiCard label="Completed (Month)"  value={String(completedThisMonth)}                           icon="task_alt"      accent={AMBER} />
          <KpiCard label="Avg Open Rate"      value={avgOpenRate != null ? `${avgOpenRate}%` : '—'}       icon="mail_open"     accent={NAVY}  />
          <KpiCard label="Total Sent"         value={totalSent.toLocaleString()}                           icon="send"          accent={RED}   />
        </div>
      )}

      {/* ── Recent Campaigns table ── */}
      <SectionCard
        title="Recent Campaigns"
        badge={recentCampaigns.length}
        className="mb-6"
        actions={
          <button
            onClick={() => navigate('/campaigns')}
            className="text-[12px] font-semibold hover:underline"
            style={{ color: NAVY }}
          >
            View all
          </button>
        }
      >
        {loading ? (
          <div className="flex items-center justify-center py-16"><Spinner size={28} /></div>
        ) : recentCampaigns.length === 0 ? (
          <div className="py-16 text-center">
            <span className="material-symbols-rounded text-[40px] text-slate-300 block mb-2">campaign</span>
            <p className="text-[13px] text-slate-400">No campaigns yet</p>
            <button
              onClick={() => navigate('/campaigns/new')}
              className="mt-3 px-4 py-2 rounded-lg text-[12px] font-semibold text-white"
              style={{ background: NAVY }}
            >
              Create your first campaign
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ background: '#F8FAFC', borderBottom: '1px solid rgba(15,23,42,0.07)' }}>
                  {['Name', 'Type', 'Status', 'Recipients', 'Sent', 'Open Rate', 'Created', 'Actions'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-[10.5px] font-semibold uppercase tracking-[0.07em] text-slate-400 whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentCampaigns.map(c => (
                  <tr
                    key={c.id}
                    className="transition-colors hover:bg-slate-50 cursor-pointer"
                    style={{ borderTop: '1px solid rgba(15,23,42,0.05)' }}
                    onClick={() => navigate(`/campaigns/${c.id}/report`)}
                  >
                    <td className="px-5 py-3">
                      <p className="font-semibold text-slate-800 truncate max-w-[180px]">{c.name}</p>
                      {c.list_name && (
                        <p className="text-[11px] text-slate-400 mt-0.5">{c.list_name}</p>
                      )}
                    </td>
                    <td className="px-5 py-3"><TypePill type={c.type} /></td>
                    <td className="px-5 py-3"><StatusBadge status={c.status} /></td>
                    <td className="px-5 py-3 font-mono text-slate-600">{(c.total_contacts ?? 0).toLocaleString()}</td>
                    <td className="px-5 py-3 font-mono text-slate-600">
                      {((c.emails_sent ?? 0) + (c.sms_sent ?? 0)).toLocaleString()}
                    </td>
                    <td className="px-5 py-3 font-mono text-slate-600">{openRate(c)}</td>
                    <td className="px-5 py-3 text-slate-500 whitespace-nowrap">{fmtDate(c.created_at)}</td>
                    <td className="px-5 py-3">
                      <button
                        onClick={e => { e.stopPropagation(); navigate(`/campaigns/${c.id}/report`) }}
                        className="text-[11px] font-semibold hover:underline"
                        style={{ color: NAVY }}
                      >
                        View Report
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* ── Quick links ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          {
            icon: 'article',
            title: 'Browse Templates',
            desc: 'Ready-made email and SMS templates',
            to: '/campaigns/templates',
            accent: NAVY,
          },
          {
            icon: 'list_alt',
            title: 'Manage Lists',
            desc: 'Organise your contact lists',
            to: '/campaigns/lists',
            accent: GREEN,
          },
          {
            icon: 'insights',
            title: 'Analytics',
            desc: 'Deep-dive into campaign performance',
            to: '/campaigns/analytics',
            accent: AMBER,
          },
        ].map(item => (
          <button
            key={item.to}
            onClick={() => navigate(item.to)}
            className="text-left p-5 bg-white rounded-2xl border hover:shadow-md transition-all group"
            style={{ borderColor: 'rgba(15,23,42,0.07)' }}
          >
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center mb-3"
              style={{ background: `${item.accent}15` }}
            >
              <span className="material-symbols-rounded text-[20px]" style={{ color: item.accent }}>
                {item.icon}
              </span>
            </div>
            <p className="text-[14px] font-semibold text-slate-800 mb-0.5 group-hover:underline">{item.title}</p>
            <p className="text-[12px] text-slate-400">{item.desc}</p>
          </button>
        ))}
      </div>
    </Page>
  )
}
