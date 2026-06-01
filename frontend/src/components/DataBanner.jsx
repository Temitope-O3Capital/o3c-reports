export default function DataBanner({ source, compact = false }) {
  if (!source) return null
  const live = source === 'mssql_live'

  const base = compact
    ? 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold'
    : 'inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium border'

  const theme = live
    ? 'bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-900/15 dark:text-emerald-400 dark:border-emerald-800/30'
    : 'bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-900/15 dark:text-amber-400 dark:border-amber-800/30'

  return (
    <div className={`${base} ${theme}`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${live ? 'bg-emerald-500 pulse-dot' : 'bg-amber-400'}`} />
      {compact
        ? (live ? 'Live' : 'Snapshot')
        : (live ? 'Live · MSSQL' : 'Snapshot · Supabase')}
    </div>
  )
}
