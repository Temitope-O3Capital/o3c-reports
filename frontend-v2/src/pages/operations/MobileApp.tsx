import { Page, KpiCard, SectionCard, NAVY, RED, GREEN, AMBER } from '../../components/UI'

const FEATURES = [
  { icon: 'download',        label: 'Downloads & Installs',  desc: 'Track daily app installs from App Store and Google Play' },
  { icon: 'person',          label: 'Active Users (DAU/MAU)', desc: 'Monitor daily and monthly active user trends' },
  { icon: 'bar_chart',       label: 'Feature Usage',         desc: 'See which in-app features customers use most' },
  { icon: 'star',            label: 'Store Ratings',         desc: 'App Store and Google Play ratings over time' },
]

const METRICS = [
  { label: 'App Downloads',   icon: 'download',   accent: NAVY },
  { label: 'DAU',             icon: 'person',     accent: GREEN },
  { label: 'MAU',             icon: 'group',      accent: '#2563EB' },
  { label: 'Avg Session (min)', icon: 'timer',    accent: AMBER },
  { label: 'Crash Rate',      icon: 'bug_report', accent: RED },
  { label: 'App Rating',      icon: 'star',       accent: '#D97706' },
]

export default function MobileApp() {
  return (
    <Page dept="Operations" title="Mobile App" subtitle="Customer mobile application analytics">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-5">
        {METRICS.map(m => (
          <KpiCard key={m.label} label={m.label} value="—" icon={m.icon} accent={m.accent} sub="Coming soon" />
        ))}
      </div>

      <SectionCard title="Mobile App Dashboard" subtitle="Under active development">
        <div className="px-5 py-10 text-center">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: 'rgba(14,40,65,0.06)' }}>
            <span className="material-symbols-rounded text-[28px]" style={{ color: NAVY }}>smartphone</span>
          </div>
          <h3 className="text-[15px] font-semibold text-slate-800 mb-2">Mobile App Analytics Coming Soon</h3>
          <p className="text-[13px] text-slate-400 max-w-sm mx-auto mb-8 leading-relaxed">
            Real-time visibility into the O3C customer mobile app — from download funnels
            to in-app transaction behaviour.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-xl mx-auto text-left">
            {FEATURES.map(f => (
              <div key={f.label} className="flex items-start gap-3 p-3.5 rounded-xl"
                style={{ background: 'rgba(14,40,65,0.04)', border: '1px solid rgba(14,40,65,0.07)' }}>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: 'rgba(14,40,65,0.08)' }}>
                  <span className="material-symbols-rounded text-[16px]" style={{ color: NAVY }}>{f.icon}</span>
                </div>
                <div>
                  <p className="text-[12.5px] font-semibold text-slate-700">{f.label}</p>
                  <p className="text-[11.5px] text-slate-400 mt-0.5 leading-relaxed">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </SectionCard>
    </Page>
  )
}
