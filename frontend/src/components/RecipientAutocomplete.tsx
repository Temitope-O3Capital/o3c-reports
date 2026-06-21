import { useEffect, useRef, useState } from 'react'

interface Suggestion {
  name:   string
  email:  string
  source: 'staff' | 'contact'
}

const SOURCE_ICON: Record<string, string> = {
  staff:   'badge',
  contact: 'person',
}
const SOURCE_COLOR: Record<string, string> = {
  staff:   '#0E2841',
  contact: '#166534',
}

interface Props {
  value:       string
  onChange:    (email: string) => void
  onSelect?:   (s: Suggestion) => void
  placeholder?: string
  label?:       string
  required?:    boolean
}

export default function RecipientAutocomplete({
  value, onChange, onSelect, placeholder = 'Email address', label, required,
}: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [open,        setOpen]        = useState(false)
  const [focused,     setFocused]     = useState(-1)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapRef  = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current)
    if (value.length < 2) { setSuggestions([]); setOpen(false); return }
    debounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/suggest/recipients?q=${encodeURIComponent(value)}`,
          { credentials: 'include' })
        const data: Suggestion[] = await res.json()
        setSuggestions(data)
        setOpen(data.length > 0)
        setFocused(-1)
      } catch { /* ignore */ }
    }, 220)
  }, [value])

  // Close on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  function pick(s: Suggestion) {
    onChange(s.email)
    onSelect?.(s)
    setOpen(false)
    setSuggestions([])
  }

  function handleKey(e: React.KeyboardEvent) {
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocused(f => Math.min(f + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocused(f => Math.max(f - 1, 0))
    } else if (e.key === 'Enter' && focused >= 0) {
      e.preventDefault()
      pick(suggestions[focused])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      {label && (
        <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1.5">
          {label}{required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
      )}
      <input
        type="email"
        value={value}
        required={required}
        placeholder={placeholder}
        autoComplete="off"
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKey}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        className="w-full rounded-lg border px-3 py-2.5 text-[13px] outline-none"
        style={{ borderColor: 'rgba(15,23,42,0.15)' }}
      />
      {open && suggestions.length > 0 && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 50,
          background: '#fff', borderRadius: 8, border: '1px solid #e2e8f0',
          boxShadow: '0 8px 24px rgba(0,0,0,0.1)', overflow: 'hidden',
        }}>
          {suggestions.map((s, i) => (
            <div key={s.email}
              onMouseDown={() => pick(s)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '9px 14px', cursor: 'pointer',
                background: focused === i ? 'rgba(14,40,65,0.05)' : '#fff',
                borderBottom: i < suggestions.length - 1 ? '1px solid #f1f5f9' : 'none',
              }}>
              <span className="material-symbols-rounded text-[16px]"
                style={{ color: SOURCE_COLOR[s.source] ?? '#64748b', flexShrink: 0 }}>
                {SOURCE_ICON[s.source] ?? 'person'}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: '#1e293b' }}>{s.name}</div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>{s.email}</div>
              </div>
              <span style={{
                fontSize: 10, fontWeight: 600, color: SOURCE_COLOR[s.source] ?? '#64748b',
                background: `${SOURCE_COLOR[s.source]}14`, padding: '2px 6px', borderRadius: 4,
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                {s.source}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
