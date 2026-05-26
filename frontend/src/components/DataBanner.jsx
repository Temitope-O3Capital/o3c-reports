export default function DataBanner({ source, lastSync }) {
  if (!source) return null

  const isLive = source === 'mssql_live'

  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold ${
      isLive
        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isLive ? 'bg-emerald-500 pulse-dot' : 'bg-amber-500'}`} />
      {isLive
        ? 'Live · MSSQL'
        : `Snapshot · ${lastSync
            ? new Date(lastSync).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })
            : 'unknown'}`
      }
    </span>
  )
}
