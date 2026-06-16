import { Page, KpiCard, SectionCard, NAVY, RED, GREEN, AMBER } from '../../components/UI'

const FEATURES = [
  { icon: 'credit_card',     label: 'Card Issuance',       desc: 'Track Blink prepaid card issuance and activations' },
  { icon: 'attach_money',    label: 'Spend Analytics',     desc: 'Monitor spend patterns, top merchants, and categories' },
  { icon: 'account_balance', label: 'Wallet Balances',     desc: 'Aggregate wallet balance and top-up activity' },
  { icon: 'lock',            label: 'Card Blocks & Limits', desc: 'Track block events and limit change requests' },
]

const METRICS = [
  { label: 'Cards Issued',     icon: 'add_card',           accent: NAVY  },
  { label: 'Active Cards',     icon: 'credit_card',        accent: GREEN },
  { label: 'Cards Activated',  icon: 'verified',           accent: '#2563EB' },
  { label: 'Total Spend',      icon: 'payments',           accent: AMBER },
  { label: 'Wallet Balance',   icon: 'account_balance_wallet', accent: '#8B5CF6' },
  { label: 'Blocked Cards',    icon: 'credit_card_off',    accent: RED   },
]

export default function BlinkCard() {
  return (
    <Page dept="Operations" title="Blink Card" subtitle="Blink prepaid card programme management">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-5">
        {METRICS.map(m => (
          <KpiCard key={m.label} label={m.label} value="—" icon={m.icon} accent={m.accent} sub="Coming soon" />
        ))}
      </div>

      <SectionCard title="Blink Card Dashboard" subtitle="Under active development">
        <div className="px-5 py-10 text-center">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: 'rgba(192,0,0,0.07)' }}>
            <span className="material-symbols-rounded text-[28px]" style={{ color: RED }}>credit_card</span>
          </div>
          <h3 className="text-[15px] font-semibold text-slate-800 mb-2">Blink Card Analytics Coming Soon</h3>
          <p className="text-[13px] text-slate-400 max-w-sm mx-auto mb-8 leading-relaxed">
            Full visibility into the Blink prepaid card programme — issuance, activation,
            spend patterns, and wallet management.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-xl mx-auto text-left">
            {FEATURES.map(f => (
              <div key={f.label} className="flex items-start gap-3 p-3.5 rounded-xl"
                style={{ background: 'rgba(192,0,0,0.04)', border: '1px solid rgba(192,0,0,0.08)' }}>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background: 'rgba(192,0,0,0.08)' }}>
                  <span className="material-symbols-rounded text-[16px]" style={{ color: RED }}>{f.icon}</span>
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
