import PageShell from '../components/PageShell.jsx'

export default function CallCenter() {
  return (
    <PageShell
      title="Call Center"
      subtitle="Call volumes, ticket resolution, and agent activity"
    >
      <div className="flex flex-col items-center justify-center py-24 gap-4"
        style={{ color: 'rgb(var(--fg-3))' }}>
        <span className="material-symbols-rounded text-[48px] opacity-25">
          headset_mic
        </span>
        <div className="text-center">
          <p className="text-sm font-semibold mb-1" style={{ color: 'rgb(var(--fg-2))' }}>
            Call Center reporting coming soon
          </p>
          <p className="text-xs" style={{ color: 'rgb(var(--fg-3))' }}>
            Connect a ticketing or telephony data source to activate this module.
          </p>
        </div>
      </div>
    </PageShell>
  )
}
