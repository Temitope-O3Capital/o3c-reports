import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'

export interface AppNotification {
  id: number
  type: 'assignment' | 'approval' | 'ticket_reply' | 'campaign_done' | 'system' | 'mention' | 'sla_breach' | 'info'
  title: string
  body?: string
  entity_type?: string
  entity_id?: string
  action_url?: string
  read_at?: string | null
  created_at: string
}

interface NotificationsResponse {
  notifications?: AppNotification[]
  unread_count?: number
  total?: number
}

export function useNotifications() {
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const navigate = useNavigate()
  const esRef = useRef<EventSource | null>(null)
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>()
  const delayRef = useRef(2000)
  const lastNotifAtRef = useRef<string | null>(null)
  const hasConnectedRef = useRef(false)

  // Load initial notifications
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await apiFetch<NotificationsResponse>('/api/notifications?per_page=30&page=1')
        if (!cancelled) {
          setNotifications(res.notifications ?? [])
          setUnreadCount(res.unread_count ?? 0)
          setHasMore((res.notifications?.length ?? 0) < (res.total ?? 0))
        }
      } catch { /* swallow — user may not be logged in */ }
      finally { if (!cancelled) setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // SSE connection
  useEffect(() => {
    let alive = true

    async function connect() {
      if (!alive) return
      try {
        const { ticket } = await apiFetch<{ ticket: string }>('/api/notifications/sse-ticket', { method: 'POST' })
        const base = (import.meta.env.VITE_API_URL as string) || ''
        const es = new EventSource(`${base}/api/notifications/sse?ticket=${encodeURIComponent(ticket)}`)
        esRef.current = es

        // On reconnect (not first connect), catch up on missed notifications
        if (hasConnectedRef.current && lastNotifAtRef.current) {
          apiFetch<NotificationsResponse>(`/api/notifications?per_page=30&page=1&since=${encodeURIComponent(lastNotifAtRef.current)}`)
            .then(res => {
              const missed = res.notifications ?? []
              if (missed.length > 0) {
                setNotifications(prev => {
                  const ids = new Set(prev.map(n => n.id))
                  const newOnes = missed.filter((n: AppNotification) => !ids.has(n.id))
                  if (newOnes.length === 0) return prev
                  setUnreadCount(c => c + newOnes.filter((n: AppNotification) => !n.read_at).length)
                  return [...newOnes, ...prev]
                })
              }
            })
            .catch(() => {})
        }
        hasConnectedRef.current = true

        es.addEventListener('notification', (e: MessageEvent) => {
          const notif: AppNotification = JSON.parse(e.data as string)
          lastNotifAtRef.current = notif.created_at
          setNotifications(prev => {
            if (prev.find(n => n.id === notif.id)) return prev
            return [notif, ...prev]
          })
          if (!notif.read_at) setUnreadCount(c => c + 1)
          toast(notif.title, {
            description: notif.body,
            ...(notif.action_url ? {
              action: { label: 'View', onClick: () => navigate(notif.action_url!) }
            } : {})
          })
          delayRef.current = 2000
        })

        es.addEventListener('ping', () => { delayRef.current = 2000 })

        es.onerror = () => {
          es.close()
          esRef.current = null
          if (alive) {
            reconnectRef.current = setTimeout(() => {
              delayRef.current = Math.min(delayRef.current * 2, 60000)
              connect()
            }, delayRef.current)
          }
        }
      } catch {
        if (alive) {
          reconnectRef.current = setTimeout(() => {
            delayRef.current = Math.min(delayRef.current * 2, 60000)
            connect()
          }, delayRef.current)
        }
      }
    }

    connect()
    return () => {
      alive = false
      esRef.current?.close()
      clearTimeout(reconnectRef.current)
    }
  }, [navigate])

  const markRead = useCallback(async (id: number) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read_at: new Date().toISOString() } : n))
    setUnreadCount(c => Math.max(0, c - 1))
    await apiFetch(`/api/notifications/${id}/read`, { method: 'PATCH' }).catch(() => {})
  }, [])

  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString()
    setNotifications(prev => prev.map(n => ({ ...n, read_at: n.read_at ?? now })))
    setUnreadCount(0)
    await apiFetch('/api/notifications/mark-all-read', { method: 'POST' }).catch(() => {})
  }, [])

  const deleteNotif = useCallback(async (id: number) => {
    setNotifications(prev => prev.filter(n => n.id !== id))
    await apiFetch(`/api/notifications/${id}`, { method: 'DELETE' }).catch(() => {})
  }, [])

  const loadMore = useCallback(async () => {
    const nextPage = page + 1
    const res = await apiFetch<NotificationsResponse>(`/api/notifications?per_page=30&page=${nextPage}`)
    const more = res.notifications ?? []
    setNotifications(prev => {
      const ids = new Set(prev.map(n => n.id))
      return [...prev, ...more.filter((n: AppNotification) => !ids.has(n.id))]
    })
    setHasMore(more.length === 30)
    setPage(nextPage)
  }, [page])

  return { notifications, unreadCount, loading, markRead, markAllRead, deleteNotif, loadMore, hasMore }
}
