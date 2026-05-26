import DataBanner from './DataBanner.jsx'

export default function PageShell({ title, subtitle, source, error, children, actions }) {
  return (
    <div className="p-6 lg:p-10 max-w-screen-2xl mx-auto">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-8">
        <div>
          <h1 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{subtitle}</p>}
          {source && <div className="mt-2"><DataBanner source={source} /></div>}
        </div>
        {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm rounded-lg px-4 py-3 mb-4">
          <span className="material-symbols-outlined text-[18px]">error</span>
          {error}
        </div>
      )}

      {children}
    </div>
  )
}
