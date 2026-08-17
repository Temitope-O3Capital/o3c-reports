// ScriptsDrawer — a global, always-reachable Call Scripts launcher for the Call Centre.
// Mounted once in the app shell; shows a floating button that opens a slide-in reader
// so an agent can pull up a talk-track from ANY screen while on a live call, without
// navigating away from the customer, ticket, or call they're working.
//
// Read-only: authoring/editing lives on the dedicated Call Scripts page. This is the
// consumption surface. Reuses scriptKit so the markup and reader render identically.

import { useState, useEffect, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { apiFetch, apiPost } from '../lib/api'
import { allRoles, currentUser } from '../hooks/useAuth'
import { NAVY, GREEN, FW, RADIUS, TEXT } from '../lib/design'
import { type CallScript, CAT_ICON, CATEGORY_NAMES, parseScript, toPlainText, previewLine, ScriptReader } from './scriptKit'
import { toast } from 'sonner'

export default function ScriptsDrawer() {
  // Only front-line Call Centre staff (agents and their heads) get the launcher —
  // not management or other modules. Backend still enforces the API; this just keeps
  // the button off screens where it isn't relevant.
  const eligible = useMemo(() => {
    const u = currentUser()
    return !!u && allRoles(u).some(r => r === 'call_center_agent' || r === 'call_center_head')
  }, [])

  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [rows, setRows] = useState<CallScript[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [activeCat, setActiveCat] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch<CallScript[]>(`/api/helpdesk/canned-responses?channel=call`)
      setRows(Array.isArray(data) ? data : [])
      setLoaded(true)
    } catch {
      toast.error('Could not load scripts')
    } finally {
      setLoading(false)
    }
  }, [])

  // Lazy-load on first open so the button costs nothing until used.
  useEffect(() => { if (open && !loaded) load() }, [open, loaded, load])

  // Esc closes; back to list first if a script is open.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { if (selectedId != null) setSelectedId(null); else setOpen(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, selectedId])

  useEffect(() => { setCopied(false) }, [selectedId])

  const categories = useMemo(() => {
    const present = new Set(rows.map(r => r.category).filter(Boolean))
    const extras = [...present].filter(c => !CATEGORY_NAMES.includes(c)).sort()
    return [...CATEGORY_NAMES, ...extras].filter(c => present.has(c))
  }, [rows])

  const filtered = useMemo(() => rows.filter(r => {
    if (activeCat && r.category !== activeCat) return false
    if (search) {
      const q = search.toLowerCase()
      return r.title.toLowerCase().includes(q) || (r.category ?? '').toLowerCase().includes(q) || (r.body ?? '').toLowerCase().includes(q)
    }
    return true
  }), [rows, activeCat, search])

  const selected = useMemo(() => rows.find(r => r.id === selectedId) ?? null, [rows, selectedId])
  const blocks = useMemo(() => selected ? parseScript(selected.body) : [], [selected])

  async function copyScript() {
    if (!selected) return
    try {
      await navigator.clipboard.writeText(toPlainText(selected.body))
      setCopied(true)
      toast.success('Script copied')
      apiPost(`/api/helpdesk/canned-responses/${selected.id}/use`, {}).catch(() => {})
      setTimeout(() => setCopied(false), 2000)
    } catch { toast.error('Could not copy') }
  }

  if (!eligible) return null

  const chip = (active: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: RADIUS.full,
    cursor: 'pointer', fontSize: TEXT.xs, fontWeight: FW.medium, whiteSpace: 'nowrap',
    border: `1px solid ${active ? NAVY : 'var(--bdr)'}`, background: active ? NAVY : 'var(--card)',
    color: active ? '#fff' : 'var(--txt2)',
  })

  return (
    <>
      {/* Floating launcher */}
      <button
        onClick={() => setOpen(true)}
        title="Call scripts"
        aria-label="Open call scripts"
        style={{
          position: 'fixed', right: 22, bottom: 22, zIndex: 1400,
          display: open ? 'none' : 'inline-flex', alignItems: 'center', gap: 8,
          padding: '11px 16px', borderRadius: RADIUS.full, border: 'none',
          background: NAVY, color: '#fff', cursor: 'pointer',
          fontSize: TEXT.sm, fontWeight: FW.semibold, fontFamily: 'inherit',
          boxShadow: '0 6px 20px rgba(14,40,65,0.35)',
        }}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 20 }}>menu_book</span>
        Scripts
      </button>

      {open && createPortal(
        <div
          onClick={() => setOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1500, background: 'rgba(6,12,20,0.55)', display: 'flex', justifyContent: 'flex-end' }}
        >
          <div
            role="dialog" aria-label="Call scripts" onClick={e => e.stopPropagation()}
            style={{
              width: 'min(440px, 100vw)', height: '100%', background: 'var(--card)',
              borderLeft: '2px solid var(--bdr)', display: 'flex', flexDirection: 'column',
              boxShadow: '-18px 0 52px rgba(0,0,0,0.45)', animation: 'scriptsIn .18s ease-out',
            }}
          >
            {/* Slide only — no opacity fade, so the panel is never see-through mid-animation. */}
            <style>{`@keyframes scriptsIn { from { transform: translateX(28px) } to { transform: none } }`}</style>

            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px', borderBottom: '1px solid var(--bdr)' }}>
              {selected ? (
                <button onClick={() => setSelectedId(null)} title="Back to list" style={iconBtn}>
                  <span className="material-symbols-rounded" style={{ fontSize: 20 }}>arrow_back</span>
                </button>
              ) : (
                <span className="material-symbols-rounded" style={{ fontSize: 20, color: NAVY }}>menu_book</span>
              )}
              <span style={{ flex: 1, fontSize: TEXT.md, fontWeight: FW.bold, color: 'var(--txt)' }}>
                {selected ? selected.title : 'Call Scripts'}
              </span>
              <button onClick={() => setOpen(false)} title="Close" style={iconBtn}>
                <span className="material-symbols-rounded" style={{ fontSize: 20 }}>close</span>
              </button>
            </div>

            {/* List view */}
            {!selected ? (
              <>
                <div style={{ padding: '12px 16px 8px', display: 'flex', flexDirection: 'column', gap: 10, borderBottom: '1px solid var(--bdr)' }}>
                  <div style={{ position: 'relative' }}>
                    <span className="material-symbols-rounded" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 18, color: 'var(--txt3)' }}>search</span>
                    <input
                      autoFocus value={search} onChange={e => setSearch(e.target.value)}
                      placeholder="Search scripts…"
                      style={{ width: '100%', padding: '8px 12px 8px 34px', border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md, fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
                    <button onClick={() => setActiveCat('')} style={chip(activeCat === '')}>All</button>
                    {categories.map(c => (
                      <button key={c} onClick={() => setActiveCat(activeCat === c ? '' : c)} style={chip(activeCat === c)}>
                        <span className="material-symbols-rounded" style={{ fontSize: 14 }}>{CAT_ICON(c)}</span>{c}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ overflowY: 'auto', flex: 1 }}>
                  {loading ? (
                    <div style={{ padding: '30px 16px', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>Loading…</div>
                  ) : filtered.length === 0 ? (
                    <div style={{ padding: '30px 16px', textAlign: 'center', color: 'var(--txt3)', fontSize: TEXT.sm }}>No scripts match.</div>
                  ) : filtered.map(r => (
                    <button key={r.id} onClick={() => setSelectedId(r.id)} style={{
                      display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                      padding: '11px 16px', border: 'none', borderBottom: '1px solid var(--bdr)',
                      background: 'transparent', fontFamily: 'inherit',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                        <span className="material-symbols-rounded" style={{ fontSize: 15, color: 'var(--txt3)', flexShrink: 0 }}>{CAT_ICON(r.category)}</span>
                        <span style={{ fontSize: TEXT.base, fontWeight: FW.semibold, color: 'var(--txt)', lineHeight: 1.3 }}>{r.title}</span>
                      </div>
                      <div style={{ fontSize: TEXT.xs, color: 'var(--txt3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: 22 }}>
                        {previewLine(r.body)}
                      </div>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              /* Reader view */
              <>
                <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: TEXT.xs, fontWeight: FW.semibold, color: 'var(--txt2)', background: 'var(--chip-bg)', borderRadius: RADIUS.full, padding: '2px 9px' }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 13 }}>{CAT_ICON(selected.category)}</span>{selected.category}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button onClick={copyScript} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: RADIUS.md,
                    border: 'none', background: copied ? GREEN : NAVY, color: '#fff', fontSize: TEXT.sm, fontWeight: FW.semibold,
                    cursor: 'pointer', fontFamily: 'inherit', transition: 'background .15s',
                  }}>
                    <span className="material-symbols-rounded" style={{ fontSize: 16 }}>{copied ? 'check' : 'content_copy'}</span>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div style={{ overflowY: 'auto', flex: 1, padding: '14px 18px' }}>
                  <ScriptReader blocks={blocks} />
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

const iconBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 32, height: 32, borderRadius: RADIUS.md, border: 'none',
  background: 'transparent', color: 'var(--txt2)', cursor: 'pointer', flexShrink: 0,
}
