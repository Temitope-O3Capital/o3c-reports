import DataBanner from './DataBanner.jsx'

export default function PageShell({ title, subtitle, source, error, children, actions }) {
  return (
    <div className="px-6 py-7 lg:px-8 lg:py-8 max-w-[1440px] mx-auto animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-7">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white tracking-tight">{title}</h1>
          {subtitle && (
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>
          )}
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {source && <DataBanner source={source} compact />}
          {actions}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2.5 bg-red-50 dark:bg-red-900/15 border border-red-100 dark:border-red-800/40 text-red-700 dark:text-red-400 text-sm rounded-xl px-4 py-3 mb-6">
          <span className="material-symbols-rounded text-[18px] flex-shrink-0">error</span>
          {error}
        </div>
      )}

      {children}
    </div>
  )
}
