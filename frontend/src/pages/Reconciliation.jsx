import PageShell from '../components/PageShell.jsx'

export default function Reconciliation() {
  return (
    <PageShell
      title="Reconciliation"
      subtitle="Match card transactions against bank and processor settlement files"
    >
      <div className="flex flex-col items-center justify-center py-24 gap-4"
        style={{ color: 'rgb(var(--fg-3))' }}>
        <span className="material-symbols-rounded text-[48px] opacity-25">
          balance
        </span>
        <div className="text-center">
          <p className="text-sm font-semibold mb-1" style={{ color: 'rgb(var(--fg-2))' }}>
            Reconciliation coming soon
          </p>
          <p className="text-xs" style={{ color: 'rgb(var(--fg-3))' }}>
            Connect a settlement data source to activate this module.
          </p>
        </div>
      </div>
    </PageShell>
  )
}
