import { createContext, useContext, useEffect, useRef, useCallback } from 'react'
import type { ReactNode } from 'react'
import { apiFetch, API } from '../lib/api'

// Topics emitted by the backend change-feed (/api/events/sse). Adding a topic
// here + in events.go is all it takes to make a new data area live.
const TOPICS = [
  'tickets', 'loans', 'repayments', 'settlements', 'settlement_exceptions',
  'manual_postings', 'collections', 'recovery', 'cards', 'fixed_deposits',
  'crm', 'deals', 'tasks', 'campaigns', 'compliance', 'finance', 'hr',
  'payroll', 'users',
  // Calls: the Call Log, the agent dashboard and the outbound queue all show call
  // activity and none of them were live — a call landing from Zoho Voice left every
  // one of them stale until the window regained focus.
  'calls',
] as const

type Listener = () => void

interface RealtimeCtx {
  subscribe: (topics: string[], cb: Listener) => () => void
  onFocus:   (cb: Listener) => () => void
}

const Ctx = createContext<RealtimeCtx | null>(null)

// RealtimeProvider holds ONE shared SSE connection to the change-feed and a
// window focus/visibility signal, and fans both out to subscribed pages. It
// auto-reconnects with a fresh ticket if the stream drops.
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const topicSubs = useRef(new Map<string, Set<Listener>>())
  const focusSubs = useRef(new Set<Listener>())

  // ── Change-feed SSE ─────────────────────────────────────────────────────────
  useEffect(() => {
    let es: EventSource | null = null
    let closed = false
    let retry: ReturnType<typeof setTimeout> | null = null

    async function connect() {
      if (closed) return
      try {
        const { ticket } = await apiFetch<{ ticket: string }>('/api/notifications/sse-ticket', { method: 'POST', silent: true })
        if (closed) return
        es = new EventSource(`${API}/api/events/sse?ticket=${encodeURIComponent(ticket)}`)
        TOPICS.forEach(topic => {
          es!.addEventListener(topic, () => {
            topicSubs.current.get(topic)?.forEach(cb => { try { cb() } catch { /* ignore */ } })
          })
        })
        es.onerror = () => {
          es?.close(); es = null
          if (!closed && !retry) retry = setTimeout(() => { retry = null; connect() }, 5000)
        }
      } catch {
        if (!closed && !retry) retry = setTimeout(() => { retry = null; connect() }, 5000)
      }
    }
    connect()
    return () => { closed = true; es?.close(); if (retry) clearTimeout(retry) }
  }, [])

  // ── Focus / visibility ──────────────────────────────────────────────────────
  useEffect(() => {
    const fire = () => {
      if (document.visibilityState === 'visible') {
        focusSubs.current.forEach(cb => { try { cb() } catch { /* ignore */ } })
      }
    }
    window.addEventListener('focus', fire)
    document.addEventListener('visibilitychange', fire)
    return () => {
      window.removeEventListener('focus', fire)
      document.removeEventListener('visibilitychange', fire)
    }
  }, [])

  const subscribe = useCallback((topics: string[], cb: Listener) => {
    topics.forEach(t => {
      let set = topicSubs.current.get(t)
      if (!set) { set = new Set(); topicSubs.current.set(t, set) }
      set.add(cb)
    })
    return () => topics.forEach(t => topicSubs.current.get(t)?.delete(cb))
  }, [])

  const onFocus = useCallback((cb: Listener) => {
    focusSubs.current.add(cb)
    return () => { focusSubs.current.delete(cb) }
  }, [])

  return <Ctx.Provider value={{ subscribe, onFocus }}>{children}</Ctx.Provider>
}

/**
 * useLiveData makes a page live. It re-runs `load` when a subscribed topic
 * changes on the server (~4s push) and when the browser tab regains focus.
 * It does NOT run `load` on mount — the page keeps its own initial fetch, so
 * adopting this is a one-line, non-disruptive addition.
 *
 *   useLiveData(load, { topics: ['tickets'] })
 */
export function useLiveData(load: () => void, opts?: { topics?: string[]; focus?: boolean }) {
  const ctx = useContext(Ctx)
  const loadRef = useRef(load)
  loadRef.current = load
  const topics = opts?.topics ?? []
  const focus = opts?.focus !== false
  const topicsKey = topics.join(',')

  useEffect(() => {
    if (!ctx) return
    const call = () => loadRef.current()
    const unsubs: Array<() => void> = []
    if (topics.length) unsubs.push(ctx.subscribe(topics, call))
    if (focus) unsubs.push(ctx.onFocus(call))
    return () => unsubs.forEach(u => u())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, topicsKey, focus])
}
