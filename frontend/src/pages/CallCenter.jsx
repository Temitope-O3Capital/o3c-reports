import { useState, useRef } from 'react'
import { apiFetch } from '../hooks/useApi.js'
import { fmt, fmtNum } from '../components/Charts.jsx'
import PageShell from '../components/PageShell.jsx'

const API = import.meta.env.VITE_API_URL || 'http://localhost:8000'

function ContactCard({ contact, onSelect }) {
  return (
    <div
      onClick={() => onSelect(contact)}
      className="card p-4 cursor-pointer hover:shadow-md transition-shadow"
      style={{ borderLeft: '3px solid #0E2841' }}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="font-semibold text-slate-800 dark:text-slate-100">
            {contact.first_name} {contact.last_name}
          </p>
          <p className="text-xs text-slate-400 mt-0.5 font-mono">{contact.phone}</p>
          <p className="text-xs text-slate-400">{contact.email}</p>
        </div>
        <span className={`badge ${contact.status === 'lead' ? 'badge-amber' : 'badge-green'} capitalize`}>
          {contact.status}
        </span>
      </div>
      {contact.cif_number && (
        <p className="text-xs text-slate-400 mt-2 font-mono">CIF: {contact.cif_number}</p>
      )}
    </div>
  )
}

function ActivityRow({ item }) {
  const type = (item.type || '').toLowerCase()
  const icon = type === 'call' ? 'phone' : type === 'email' ? 'email' : type === 'note' ? 'note' : 'chat'
  return (
    <div className="flex gap-3 py-3 border-b border-slate-100 dark:border-slate-700/50 last:border-0">
      <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{ background: 'rgb(var(--navy) / 0.07)' }}>
        <span className="material-symbols-rounded text-[15px]" style={{ color: '#0E2841' }}>{icon}</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{item.subject || item.type}</p>
        {item.body && <p className="text-xs text-slate-400 mt-0.5 line-clamp-2">{item.body}</p>}
        <p className="text-xs text-slate-300 dark:text-slate-600 mt-1">
          {item.created_at ? new Date(item.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
        </p>
      </div>
    </div>
  )
}

export default function CallCenter() {
  const [query,     setQuery]     = useState('')
  const [results,   setResults]   = useState([])
  const [selected,  setSelected]  = useState(null)
  const [activities,setActivities]= useState([])
  const [searching, setSearching] = useState(false)
  const [loadingAct,setLoadingAct]= useState(false)
  const searchRef = useRef()

  async function search() {
    if (!query.trim()) return
    setSearching(true); setResults([]); setSelected(null)
    try {
      const token = localStorage.getItem('o3c_token')
      const res = await fetch(
        `${API}/api/crm/contacts?q=${encodeURIComponent(query.trim())}&limit=10`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const data = await res.json()
      setResults(Array.isArray(data) ? data : (data.data || []))
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }

  async function selectContact(contact) {
    setSelected(contact)
    setLoadingAct(true)
    try {
      const token = localStorage.getItem('o3c_token')
      const res = await fetch(
        `${API}/api/crm/contacts/${contact.id}/activities?limit=20`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const data = await res.json()
      setActivities(Array.isArray(data) ? data : (data.data || []))
    } catch {
      setActivities([])
    } finally {
      setLoadingAct(false)
    }
  }

  return (
    <PageShell
      title="Call Center"
      subtitle="Look up customers, view history and recent interactions"
    >
      {/* ── Search ── */}
      <div className="card p-5 mb-4">
        <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'rgb(var(--fg-3))' }}>
          Customer Lookup
        </p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <span className="material-symbols-rounded text-[17px] pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: 'rgb(var(--fg-3))' }}>search</span>
            <input
              ref={searchRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && search()}
              placeholder="Search by name, phone, email or CIF number…"
              className="form-input pl-9 w-full"
            />
          </div>
          <button onClick={search} disabled={searching || !query.trim()}
            className="btn btn-primary gap-2 disabled:opacity-60">
            {searching
              ? <><div className="spinner" style={{ width: 14, height: 14, borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.25)' }} />Searching…</>
              : <><span className="material-symbols-rounded text-[17px]">search</span>Search</>}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Results */}
        <div>
          {results.length > 0 ? (
            <>
              <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'rgb(var(--fg-3))' }}>
                {results.length} result{results.length !== 1 ? 's' : ''}
              </p>
              <div className="flex flex-col gap-2">
                {results.map(c => (
                  <ContactCard key={c.id} contact={c} onSelect={selectContact} />
                ))}
              </div>
            </>
          ) : !searching && query && (
            <div className="card p-8 text-center text-slate-400">
              <span className="material-symbols-rounded text-[36px] opacity-25 block mb-2">person_search</span>
              <p className="text-sm">No customers found for "{query}"</p>
            </div>
          )}
          {!query && !searching && results.length === 0 && (
            <div className="card p-8 text-center text-slate-400">
              <span className="material-symbols-rounded text-[36px] opacity-25 block mb-2">contacts</span>
              <p className="text-sm">Enter a name, phone, email or CIF to look up a customer</p>
            </div>
          )}
        </div>

        {/* Detail panel */}
        <div className="lg:col-span-2">
          {selected ? (
            <div className="card overflow-hidden">
              <div className="px-5 py-4" style={{ borderBottom: '1px solid rgb(var(--border) / 0.08)', background: 'rgb(var(--navy) / 0.03)' }}>
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                      {selected.first_name} {selected.last_name}
                    </h2>
                    <div className="flex items-center gap-3 mt-1 flex-wrap">
                      {selected.phone  && <span className="text-xs text-slate-500">{selected.phone}</span>}
                      {selected.email  && <span className="text-xs text-slate-500">{selected.email}</span>}
                      {selected.cif_number && <span className="text-xs font-mono text-slate-400">CIF: {selected.cif_number}</span>}
                    </div>
                  </div>
                  <a href={`/crm/contacts/${selected.id}`}
                    className="btn btn-ghost btn-sm gap-1.5 text-xs">
                    <span className="material-symbols-rounded text-[14px]">open_in_new</span>Full Profile
                  </a>
                </div>
                <div className="grid grid-cols-3 gap-4 mt-4">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider mb-0.5" style={{ color: 'rgb(var(--fg-3))' }}>Status</p>
                    <span className={`badge capitalize ${selected.status === 'lead' ? 'badge-amber' : 'badge-green'}`}>{selected.status}</span>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider mb-0.5" style={{ color: 'rgb(var(--fg-3))' }}>Location</p>
                    <p className="text-sm text-slate-600 dark:text-slate-300">{[selected.city, selected.state].filter(Boolean).join(', ') || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider mb-0.5" style={{ color: 'rgb(var(--fg-3))' }}>Source</p>
                    <p className="text-sm text-slate-600 dark:text-slate-300 capitalize">{selected.source || '—'}</p>
                  </div>
                </div>
              </div>

              <div className="px-5 py-4">
                <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'rgb(var(--fg-3))' }}>
                  Recent Interactions
                </p>
                {loadingAct ? (
                  <div className="flex items-center gap-2 py-4 text-slate-400">
                    <div className="spinner" style={{ width: 18, height: 18 }} />
                    <span className="text-sm">Loading…</span>
                  </div>
                ) : activities.length === 0 ? (
                  <p className="text-sm text-slate-400 py-4">No interactions recorded yet</p>
                ) : (
                  activities.map((a, i) => <ActivityRow key={i} item={a} />)
                )}
              </div>
            </div>
          ) : (
            <div className="card p-8 flex flex-col items-center justify-center text-slate-400 h-full min-h-[200px]">
              <span className="material-symbols-rounded text-[40px] opacity-25 mb-2">person</span>
              <p className="text-sm">Select a customer to see their profile and history</p>
            </div>
          )}
        </div>
      </div>
    </PageShell>
  )
}
