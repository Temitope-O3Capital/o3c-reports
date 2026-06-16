import { useState } from 'react'
import { Page, SectionCard, NAVY } from '../components/UI'

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button onClick={onChange} role="switch" aria-checked={checked}
      className="relative flex-shrink-0 w-10 h-5 rounded-full transition-colors focus:outline-none"
      style={{ background: checked ? NAVY : '#CBD5E1' }}>
      <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform"
        style={{ transform: checked ? 'translateX(20px)' : 'none' }} />
    </button>
  )
}

export default function Settings() {
  const user = JSON.parse(localStorage.getItem('o3c_user') || '{}')

  const [notif, setNotif] = useState({
    dailyReport:  true,
    collections:  true,
    reconciliation: false,
    overdue:      true,
    campaigns:    false,
  })

  function toggle(key: keyof typeof notif) {
    setNotif(n => ({ ...n, [key]: !n[key] }))
  }

  return (
    <Page title="Settings" subtitle="Account and notification preferences">

      {/* Profile */}
      <SectionCard title="Profile" subtitle="Your account information" className="mb-4">
        <div className="px-5 py-4 space-y-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full flex items-center justify-center text-lg font-bold text-white flex-shrink-0"
              style={{ background: NAVY }}>
              {(user.name || 'U').split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()}
            </div>
            <div>
              <p className="text-[15px] font-semibold text-slate-800">{user.name || '—'}</p>
              <p className="text-[13px] text-slate-500">{user.email || '—'}</p>
              <span className="inline-block mt-1 text-[11px] font-semibold px-2 py-0.5 rounded capitalize"
                style={{ background: 'rgba(14,40,65,0.07)', color: '#475569' }}>
                {(user.role || '').replace(/_/g, ' ')}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t" style={{ borderColor: 'rgba(15,23,42,0.07)' }}>
            {[
              { label: 'Full Name',  value: user.name,  icon: 'person' },
              { label: 'Email',      value: user.email, icon: 'mail' },
              { label: 'Role',       value: (user.role || '').replace(/_/g, ' '), icon: 'badge' },
              { label: 'Account ID', value: `#${user.id || '—'}`, icon: 'tag' },
            ].map(f => (
              <div key={f.label} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: 'rgba(14,40,65,0.05)' }}>
                  <span className="material-symbols-rounded text-[15px]" style={{ color: '#64748B' }}>{f.icon}</span>
                </div>
                <div>
                  <p className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">{f.label}</p>
                  <p className="text-[13px] font-medium text-slate-700 capitalize">{f.value || '—'}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </SectionCard>

      {/* Notifications */}
      <SectionCard title="Notifications" subtitle="Email alert preferences" className="mb-4">
        <div className="px-5 py-2">
          {[
            { key: 'dailyReport' as const,     label: 'Daily Summary Report',          desc: 'Receive a daily KPI summary every morning' },
            { key: 'collections' as const,     label: 'Collections Alerts',            desc: 'Notify when collections agent logs a payment' },
            { key: 'overdue' as const,         label: 'New Overdue Accounts',          desc: 'Alert when accounts become overdue (DPD > 0)' },
            { key: 'reconciliation' as const,  label: 'Reconciliation Exceptions',     desc: 'Alert on unmatched Paystack/Interswitch settlements' },
            { key: 'campaigns' as const,       label: 'Campaign Performance',          desc: 'Receive weekly campaign delivery summaries' },
          ].map(n => (
            <div key={n.key} className="flex items-center justify-between py-3.5"
              style={{ borderBottom: '1px solid rgba(15,23,42,0.06)' }}>
              <div className="flex-1 min-w-0 pr-4">
                <p className="text-[13px] font-medium text-slate-700">{n.label}</p>
                <p className="text-[12px] text-slate-400 mt-0.5">{n.desc}</p>
              </div>
              <Toggle checked={notif[n.key]} onChange={() => toggle(n.key)} />
            </div>
          ))}
        </div>
      </SectionCard>

      {/* Data Source */}
      <SectionCard title="Data Source" subtitle="Current data connection status" className="mb-4">
        <div className="px-5 py-4">
          <div className="flex items-start gap-3 p-4 rounded-xl mb-3"
            style={{ background: 'rgba(5,150,105,0.06)', border: '1px solid rgba(5,150,105,0.14)' }}>
            <span className="material-symbols-rounded text-[18px] mt-0.5" style={{ color: '#059669' }}>wifi</span>
            <div>
              <p className="text-[13px] font-semibold" style={{ color: '#059669' }}>MSSQL Live — Cloudflare Tunnel</p>
              <p className="text-[12px] text-slate-500 mt-0.5">Connected via office tunnel. Data refreshes in real time.</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-4 rounded-xl"
            style={{ background: 'rgba(14,40,65,0.04)', border: '1px solid rgba(14,40,65,0.08)' }}>
            <span className="material-symbols-rounded text-[18px] mt-0.5" style={{ color: '#64748B' }}>cloud</span>
            <div>
              <p className="text-[13px] font-semibold text-slate-600">Supabase Fallback</p>
              <p className="text-[12px] text-slate-500 mt-0.5">Snapshot backup syncs daily at 18:00 WAT. Used when tunnel is offline.</p>
            </div>
          </div>
        </div>
      </SectionCard>

      {/* Help */}
      <SectionCard title="Help & Support">
        <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { icon: 'help', label: 'Documentation', desc: 'Platform usage guides' },
            { icon: 'bug_report', label: 'Report a Bug', desc: 'Let the IT team know' },
            { icon: 'support_agent', label: 'IT Support', desc: 'Contact head_it@o3cards.com' },
          ].map(h => (
            <div key={h.label} className="flex items-center gap-3 p-3.5 rounded-xl cursor-pointer transition-colors hover:bg-slate-50"
              style={{ border: '1px solid rgba(15,23,42,0.08)' }}>
              <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(14,40,65,0.06)' }}>
                <span className="material-symbols-rounded text-[17px]" style={{ color: NAVY }}>{h.icon}</span>
              </div>
              <div>
                <p className="text-[13px] font-semibold text-slate-700">{h.label}</p>
                <p className="text-[11.5px] text-slate-400">{h.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>
    </Page>
  )
}
