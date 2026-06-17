import { useState, useEffect, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { apiFetch, apiPut, API } from '../lib/api'
import { fmtDate } from '../lib/fmt'

interface Notification {
  id: string; type: string; title: string; body: string
  entity_type: string | null; entity_id: string | null
  is_read: boolean; created_at: string
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1)   return 'Just now'
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  return fmtDate(iso)
}

export default function NotificationBell() {
  const [unread, setUnread]     = useState(0)
  const [open, setOpen]         = useState(false)
  const [notifs, setNotifs]     = useState<Notification[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const dropRef                 = useRef<HTMLDivElement>(null)

  // Fetch unread count
  const fetchCount = useCallback(async () => {
    try {
      const res = await apiFetch<{ unread: number }>('/api/notifications/count')
      setUnread(res.unread ?? 0)
    } catch {}
  }, [])

  // Fetch notification list
  async function fetchList() {
    setLoadingList(true)
    try {
      const res = await apiFetch<Notification[]>('/api/notifications?limit=10')
      setNotifs(Array.isArray(res) ? res : (res as any).data ?? [])
    } catch {}
    finally { setLoadingList(false) }
  }

  // Mark single notification read
  async function markRead(id: string) {
    try {
      await apiPut(`/api/notifications/${id}/read`, {})
      setNotifs(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n))
      setUnread(prev => Math.max(0, prev - 1))
    } catch {}
  }

  // Mark all read
  async function markAllRead() {
    try {
      await apiPut('/api/notifications/read-all', {})
      setNotifs(prev => prev.map(n => ({ ...n, is_read: true })))
      setUnread(0)
    } catch {}
  }

  // Initial count + polling every 60s
  useEffect(() => {
    fetchCount()
    const interval = setInterval(fetchCount, 60_000)
    return () => clearInterval(interval)
  }, [fetchCount])

  // SSE for real-time push
  useEffect(() => {
    const token = localStorage.getItem('o3c_token')
    if (!token) return
    const url = `${API}/api/notifications/sse?token=${encodeURIComponent(token)}`
    const es = new EventSource(url, { withCredentials: true })

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data?.type === 'ping') return
        setUnread(prev => prev + 1)
        toast(data.title ?? 'New notification', {
          description: data.body ?? '',
          duration: 5000,
        })
      } catch {}
    }

    es.onerror = () => { es.close() }

    return () => es.close()
  }, [])

  // Open dropdown — fetch list
  function toggle() {
    if (!open) fetchList()
    setOpen(o => !o)
  }

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="relative" ref={dropRef}>
      <button
        onClick={toggle}
        className="relative w-9 h-9 flex items-center justify-center rounded-xl transition-colors hover:bg-black/[0.06]"
        aria-label="Notifications"
      >
        <span className="material-symbols-rounded text-[22px] text-slate-600">notifications</span>
        {unread > 0 && (
          <span className="absolute top-1 right-1 min-w-[16px] h-4 rounded-full flex items-center justify-center text-white text-[10px] font-bold px-1"
            style={{ background: '#C00000', lineHeight: 1 }}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-2xl shadow-xl z-50 overflow-hidden"
          style={{ border: '1px solid rgba(15,23,42,0.1)' }}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
            <span className="text-[13px] font-semibold text-slate-800">Notifications</span>
            <button
              onClick={markAllRead}
              className="text-[11px] font-semibold text-slate-400 hover:text-slate-700"
            >
              Mark all read
            </button>
          </div>

          {/* List */}
          <div className="max-h-[360px] overflow-y-auto divide-y divide-slate-100">
            {loadingList ? (
              <div className="flex items-center justify-center py-10">
                <div className="inline-block w-5 h-5 rounded-full border-2 animate-spin"
                  style={{ borderColor: 'rgba(14,40,65,0.15)', borderTopColor: '#0E2841' }} />
              </div>
            ) : notifs.length === 0 ? (
              <div className="flex flex-col items-center py-12 text-slate-400">
                <span className="material-symbols-rounded text-[36px] mb-2">notifications_none</span>
                <p className="text-[12px]">No notifications</p>
              </div>
            ) : notifs.map(n => (
              <div
                key={n.id}
                className="flex gap-3 px-4 py-3 transition-colors"
                style={{ background: n.is_read ? 'transparent' : 'rgba(14,40,65,0.03)' }}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-slate-800 truncate">{n.title}</p>
                  <p className="text-[12px] text-slate-500 line-clamp-2 mt-0.5">{n.body}</p>
                  <p className="text-[11px] text-slate-400 mt-1">{timeAgo(n.created_at)}</p>
                </div>
                {!n.is_read && (
                  <button
                    onClick={() => markRead(n.id)}
                    title="Mark as read"
                    className="flex-shrink-0 mt-1 w-2 h-2 rounded-full self-start mt-2 transition-opacity hover:opacity-60"
                    style={{ background: '#0E2841', minWidth: 8, minHeight: 8 }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
