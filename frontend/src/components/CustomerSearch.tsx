import { useState, useEffect, useRef } from 'react'
import { Spinner } from './UI'
import { apiFetch } from '../lib/api'
import { NAVY, FW, RADIUS, TEXT } from '../lib/design'

export interface CustSuggest {
  cif: string
  name: string
  phone?: string
  email?: string
  state?: string
}

// Some source names carry a stray leading title/punctuation (e.g. ". Sunday Essien").
export function cleanName(n?: string) {
  return (n ?? '').replace(/^[.\s]+/, '').trim()
}

export function initialsOf(name: string) {
  return (cleanName(name) || '?').split(' ').filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

const inputStyle: React.CSSProperties = {
  width: '100%', height: 36, padding: '0 12px',
  border: '1px solid var(--input-bdr)', borderRadius: RADIUS.md,
  fontSize: TEXT.base, background: 'var(--input-bg)', color: 'var(--txt)',
  outline: 'none', boxSizing: 'border-box',
}

// ── Customer typeahead ────────────────────────────────────────────────────────
// Searches by name / CIF / phone against /api/customer360/search and returns a
// full record, so picking one suggestion auto-fills name, CIF, phone and email
// together. Shared by the New Ticket form and the Log Call modal.
export function CustomerSearch({
  onPick, onManual, placeholder = 'Search customer by name, CIF or phone…', autoFocus = true,
}: {
  onPick: (c: CustSuggest) => void
  onManual?: () => void
  placeholder?: string
  autoFocus?: boolean
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<CustSuggest[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(-1)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setResults([]); setOpen(false); setLoading(false); return }
    let alive = true
    setLoading(true)
    const t = setTimeout(() => {
      apiFetch<any>(`/api/customer360/search?q=${encodeURIComponent(term)}&limit=8`)
        .then(r => {
          if (!alive) return
          const list = (r?.data ?? r) as CustSuggest[]
          setResults(Array.isArray(list) ? list : [])
          setOpen(true); setActive(-1)
        })
        .catch(() => { if (alive) { setResults([]); setOpen(true) } })
        .finally(() => { if (alive) setLoading(false) })
    }, 250)
    return () => { alive = false; clearTimeout(t) }
  }, [q])

  useEffect(() => {
    function onDoc(e: MouseEvent) { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  function choose(c: CustSuggest) { onPick(c); setQ(''); setOpen(false); setResults([]) }

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <div style={{ position: 'relative' }}>
        <span className="material-symbols-rounded" style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', fontSize: 18, color: 'var(--txt3)', pointerEvents: 'none' }}>search</span>
        <input
          type="text"
          value={q}
          autoFocus={autoFocus}
          onChange={e => setQ(e.target.value)}
          onFocus={() => { if (results.length) setOpen(true) }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, results.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)) }
            else if (e.key === 'Enter' && open && active >= 0 && results[active]) { e.preventDefault(); choose(results[active]) }
            else if (e.key === 'Escape') setOpen(false)
          }}
          placeholder={placeholder}
          style={{ ...inputStyle, paddingLeft: 36 }}
        />
        {loading && <div style={{ position: 'absolute', right: 11, top: '50%', transform: 'translateY(-50%)' }}><Spinner size={14} /></div>}
      </div>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 50, background: 'var(--card)', border: '1px solid var(--bdr)', borderRadius: RADIUS.md, boxShadow: '0 12px 30px rgba(0,0,0,0.16)', maxHeight: 264, overflowY: 'auto' }}>
          {results.length === 0 ? (
            <div style={{ padding: '12px 14px', fontSize: TEXT.sm, color: 'var(--txt3)' }}>{loading ? 'Searching…' : 'No matches found.'}</div>
          ) : results.map((c, i) => (
            <button
              key={c.cif + i}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(c)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none', cursor: 'pointer', background: i === active ? 'var(--row-hvr)' : 'transparent', borderBottom: i < results.length - 1 ? '1px solid var(--bdr)' : 'none' }}
            >
              <div style={{ width: 30, height: 30, borderRadius: RADIUS.full, background: `${NAVY}12`, color: NAVY, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TEXT.xs, fontWeight: FW.bold, flexShrink: 0 }}>{initialsOf(c.name)}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: TEXT.sm, fontWeight: FW.semibold, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cleanName(c.name) || 'Unnamed'}</div>
                <div style={{ fontSize: TEXT.xs, color: 'var(--txt2)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{c.cif}</span>{c.phone ? ` · ${c.phone}` : ''}{c.state ? ` · ${c.state}` : ''}
                </div>
              </div>
            </button>
          ))}
          {onManual && (
            <button type="button" onClick={onManual} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none', borderTop: '1px solid var(--bdr)', cursor: 'pointer', background: 'var(--th-bg)', fontSize: TEXT.sm, color: 'var(--txt2)', fontWeight: FW.semibold }}>
              <span className="material-symbols-rounded" style={{ fontSize: 16 }}>edit</span>Enter manually (walk-in / no CIF)
            </button>
          )}
        </div>
      )}
    </div>
  )
}
