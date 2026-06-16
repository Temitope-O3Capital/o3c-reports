export default function Settlement() {
  return (
    <div className="px-6 py-7 lg:px-8 lg:py-8 max-w-[1440px] mx-auto animate-fade-in">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Settlement Report</h1>
        <p className="text-sm text-slate-500 mt-0.5">Daily and monthly settlement reconciliation</p>
      </div>
      <div className="card p-12 flex flex-col items-center justify-center gap-4 text-center">
        <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: '#EFF6FF' }}>
          <span className="material-symbols-rounded text-[32px]" style={{ color: '#2563EB' }}>account_balance</span>
        </div>
        <div>
          <p className="text-base font-semibold text-slate-800 dark:text-slate-100">Settlement Report</p>
          <p className="text-sm text-slate-400 mt-1 max-w-sm">
            Coming soon — settlement data integration and daily reconciliation reporting is under development.
          </p>
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, padding: '4px 12px', borderRadius: 20, background: '#FFF7ED', color: '#C2410C' }}>
          <span className="material-symbols-rounded text-[14px]">construction</span>
          In Development
        </span>
      </div>
    </div>
  )
}
