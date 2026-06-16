import { Page, KpiCard, SectionCard, NAVY, RED } from '../../components/UI'

const FEATURES = [
  { icon: 'compare_arrows', label: 'Reconciliation',   desc: 'Match card transactions with processor settlements daily' },
  { icon: 'receipt_long',   label: 'Exception Tracking', desc: 'Flag mismatched or missing settlements for investigation' },
  { icon: 'account_balance',label: 'Net Position',     desc: 'See net settlement position by processor and card scheme' },
  { icon: 'schedule',       label: 'Settlement Cycles', desc: 'Track T+1 and T+2 settlement timelines by channel' },
]

export default function Settlement() {
  return (
    <Page dept="Operations" title="Settlement" subtitle="Card processor settlement management">

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        {['Gross Settlement', 'Fees Deducted', 'Net Received', 'Exceptions'].map((label, i) => (
          <KpiCard key={label} label={label} value="—"
            icon={['payments', 'remove_circle', 'check_circle', 'warning'][i]}
            accent={[NAVY, RED, '#059669', '#D97706'][i]}
            sub="Coming soon" />
        ))}
      </div>

      <SectionCard title="Settlement Module" subtitle="Under active development">
        <div className="px-5 py-10 text-center">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: 'rgba(14,40,65,0.06)' }}>
            <span className="material-symbols-rounded text-[28px]" style={{ color: NAVY }}>compare_arrows</span>
          </div>
          <h3 className="text-[15px] font-semibold text-slate-800 mb-2">Settlement Reporting Coming Soon</h3>
          <p className="text-[13px] text-slate-400 max-w-sm mx-auto mb-8 leading-relaxed">
            The settlement module will reconcile Paystack and Interswitch processor
            settlements against card transactions in real time.
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
