import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '../lib/api'

// One customer-search hook every typeahead shares, so the C360 bar, statements picker,
// new-ticket lookup and anything else behave identically: the same debounce, the same
// minimum length, and — crucially — the same race guard. A monotonic sequence number
// ignores any response that a newer keystroke has already superseded, so a slow earlier
// request can never overwrite fresher results (the bug that made fast typing flicker
// stale rows). It calls the shared /api/customer360/search endpoint, which matches on
// name, full name, CIF, email and normalized phone, deduped to the person.

export interface CustomerHit {
  cif:         string
  name:        string
  phone:       string
  email:       string
  state?:      string
  card_count?: number
}

interface Options {
  limit?:      number  // max rows (default 8)
  minLen?:     number  // chars before searching (default 2)
  debounceMs?: number  // keystroke settle delay (default 200)
}

export function useCustomerSearch(opts: Options = {}) {
  const { limit = 8, minLen = 2, debounceMs = 200 } = opts

  const [query, setQuery]     = useState('')
  const [results, setResults] = useState<CustomerHit[]>([])
  const [loading, setLoading] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq   = useRef(0)

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    const q = query.trim()
    if (q.length < minLen) { setResults([]); setLoading(false); return }
    setLoading(true)
    const mySeq = ++seq.current
    timer.current = setTimeout(async () => {
      try {
        const data = await apiFetch<{ data: CustomerHit[] }>(
          `/api/customer360/search?q=${encodeURIComponent(q)}&limit=${limit}`)
        if (mySeq !== seq.current) return          // superseded by a newer query
        setResults(Array.isArray(data?.data) ? data.data : [])
      } catch {
        if (mySeq === seq.current) setResults([])
      } finally {
        if (mySeq === seq.current) setLoading(false)
      }
    }, debounceMs)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [query, limit, minLen, debounceMs])

  // reset clears the box AND bumps the sequence so any in-flight response is dropped.
  function reset() { seq.current++; setQuery(''); setResults([]); setLoading(false) }

  return { query, setQuery, results, loading, reset }
}
