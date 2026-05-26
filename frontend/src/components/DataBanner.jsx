export default function DataBanner({ source, compact = false }) {
  if (!source) return null
  const live = source === 'mssql_live'

  if (compact) {
    return (
      <div className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded-full ${
        live
          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400'
          : 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400'
      }`}>
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${live ? 'bg-emerald-500 pulse-dot' : 'bg-amber-500'}`} />
        {live ? 'Live' : 'Snapshot'}
      </div>
    )
  }

  return (
    <div className={`inline-flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-lg ${
      live
        ? 'bg-emerald-50 text-emerald-700 border border-emerald-100 dark:bg-emerald-900/15 dark:text-emerald-400 dark:border-emerald-800/40'
        : 'bg-amber-50 text-amber-700 border border-amber-100 dark:bg-amber-900/15 dark:text-amber-400 dark:border-amber-800/40'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${live ? 'bg-emerald-500 pulse-dot' : 'bg-amber-400'}`} />
      {live ? 'Live data · MSSQL' : 'Snapshot · Supabase'}
    </div>
  )
}
